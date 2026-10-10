#include "macos_virtual_display_authority_link_posix.h"

#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>

#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <memory>
#include <string>

#include "macos_virtual_display_control_protocol.h"

namespace imcodes::remote_desktop::macos {
namespace {

/** Read in chunks rather than byte at a time; still bounded by the above. */
constexpr std::size_t kReadChunkBytes = 256;

std::uint64_t MonotonicMs() noexcept {
  // CLOCK_MONOTONIC, not the wall clock: a bounded wait must not become
  // unbounded (or instantly expire) because someone corrected the time.
  struct timespec now = {};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return static_cast<std::uint64_t>(now.tv_sec) * 1000ULL +
         static_cast<std::uint64_t>(now.tv_nsec) / 1'000'000ULL;
}

/**
 * Waits for `events`, honouring the ORIGINAL deadline across EINTR.
 *
 * Restarting the full timeout on every signal is the usual mistake and it turns
 * a bounded wait into an unbounded one under any steady stream of signals.
 */
bool WaitUntil(int descriptor, short events, std::uint64_t deadline_ms) {
  for (;;) {
    const std::uint64_t now = MonotonicMs();
    if (now >= deadline_ms) return false;
    const std::uint64_t remaining = deadline_ms - now;
    struct pollfd entry = {};
    entry.fd = descriptor;
    entry.events = events;
    const int ready = ::poll(&entry, 1, static_cast<int>(remaining));
    if (ready > 0) {
      // POLLHUP and POLLERR are reported regardless of what was requested, and
      // both mean the daemon is gone. Returning true lets the caller's read see
      // EOF and classify it, rather than reporting a timeout for a peer that
      // has actually disconnected.
      return (entry.revents & (events | POLLHUP | POLLERR | POLLNVAL)) != 0;
    }
    if (ready == 0) return false;
    if (errno != EINTR) return false;
  }
}

bool LstatFacts(const std::string& path, PathNodeFacts* out) {
  struct stat info = {};
  if (::lstat(path.c_str(), &info) != 0) {
    *out = PathNodeFacts();
    return false;
  }
  out->exists = true;
  out->is_symlink = S_ISLNK(info.st_mode);
  out->is_directory = S_ISDIR(info.st_mode);
  out->is_socket = S_ISSOCK(info.st_mode);
  out->uid = static_cast<std::uint32_t>(info.st_uid);
  out->gid = static_cast<std::uint32_t>(info.st_gid);
  out->mode = static_cast<std::uint32_t>(info.st_mode) & 07777U;
  out->device = static_cast<std::uint64_t>(info.st_dev);
  out->inode = static_cast<std::uint64_t>(info.st_ino);
  return true;
}

int DialUnixSocket(const std::string& path) {
  sockaddr_un address = {};
  address.sun_family = AF_UNIX;
  // Refused, never truncated: a truncated sun_path names a DIFFERENT socket,
  // and connecting to it would succeed against the wrong object.
  if (path.empty() || path.size() >= sizeof(address.sun_path)) return -1;
  std::memcpy(address.sun_path, path.c_str(), path.size());

  const int descriptor = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0) return -1;
  // Close-on-exec: this descriptor is display authority, and the agent spawns
  // a helper. An inherited authority link is authority handed to a child that
  // was never granted it.
  if (::fcntl(descriptor, F_SETFD, FD_CLOEXEC) != 0) {
    ::close(descriptor);
    return -1;
  }
  if (::connect(descriptor, reinterpret_cast<const sockaddr*>(&address),
                sizeof(address)) != 0) {
    ::close(descriptor);
    return -1;
  }
  return descriptor;
}

/**
 * Kernel peer euid, from getpeereid.
 *
 * The kernel's answer about the process on the other end, never anything the
 * peer said about itself. UINT32_MAX on failure, which is not a uid and so can
 * never accidentally compare equal to root.
 */
std::uint32_t PeerEuid(int descriptor) {
  uid_t euid = 0;
  gid_t egid = 0;
  if (::getpeereid(descriptor, &euid, &egid) != 0) return UINT32_MAX;
  return static_cast<std::uint32_t>(euid);
}

/**
 * Read state, owned by ONE seam instance.
 *
 * It used to be a function-local static keyed on the descriptor NUMBER, which
 * is not an identity: descriptor numbers are reused, so a link that closed fd 7
 * with half a frame buffered and a new link that was then handed fd 7 would
 * have that stale prefix spliced onto the new connection's first frame. Owning
 * the buffer per seam removes the sharing entirely rather than trying to
 * invalidate it correctly.
 */
struct ReadState {
  std::string buffer;
};

bool ReadLine(const std::shared_ptr<ReadState>& state,
              int descriptor,
              std::string* line) {
  if (state == nullptr || descriptor < 0 || line == nullptr) return false;
  std::string& buffer = state->buffer;
  const std::uint64_t deadline = MonotonicMs() + kAuthorityLinkReadTimeoutMs;
  for (;;) {
    const std::size_t newline = buffer.find('\n');
    if (newline != std::string::npos) {
      // The BOUND IS CHECKED ON THE PAYLOAD, BEFORE RETURNING IT.
      //
      // Checking buffer length only when no newline was found let an oversize
      // frame through whenever its terminator arrived in the same read: the
      // find succeeded, the length test was never reached, and a caller got a
      // line longer than the grammar admits.
      if (newline > kVirtualDisplayControlMaxBytes) {
        buffer.clear();
        return false;
      }
      *line = buffer.substr(0, newline);
      buffer.erase(0, newline + 1);
      return true;
    }
    // No terminator yet, and already past what any legal frame could be. Refused
    // rather than truncated: truncating would leave the remainder to be read as
    // the next frame.
    if (buffer.size() > kVirtualDisplayControlMaxBytes) {
      buffer.clear();
      return false;
    }
    if (!WaitUntil(descriptor, POLLIN, deadline)) return false;
    char chunk[kReadChunkBytes];
    const ssize_t count = ::read(descriptor, chunk, sizeof(chunk));
    if (count == 0) return false;  // EOF: the daemon is gone
    if (count < 0) {
      if (errno == EINTR || errno == EAGAIN) continue;
      return false;
    }
    buffer.append(chunk, static_cast<std::size_t>(count));
  }
}

}  // namespace

bool WriteAuthorityLinkLine(int descriptor,
                            const std::string& line,
                            std::uint32_t timeout_ms) {
  if (descriptor < 0 || line.empty() ||
      line.size() > kVirtualDisplayControlMaxBytes) {
    return false;
  }
  const std::string framed = line + "\n";
  const std::uint64_t deadline = MonotonicMs() + timeout_ms;
  std::size_t written = 0;
  while (written < framed.size()) {
    if (!WaitUntil(descriptor, POLLOUT, deadline)) return false;
    const ssize_t count =
        ::write(descriptor, framed.data() + written, framed.size() - written);
    if (count > 0) {
      written += static_cast<std::size_t>(count);
      continue;
    }
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    // A partial write is a failure, not something to resume from the top.
    return false;
  }
  return true;
}

AuthorityLinkSeam CreatePosixAuthorityLinkSeam() {
  AuthorityLinkSeam seam;
  seam.inspect = [](const std::string& path, PathNodeFacts* out) {
    return LstatFacts(path, out);
  };
  // The agent's REAL uid and gid, from the kernel. The reachability rules must
  // be evaluated for the identity that will actually issue connect(2), not for
  // an effective identity it might be able to assume.
  seam.dialling_uid = [] { return static_cast<std::uint32_t>(::getuid()); };
  seam.dialling_gid = [] { return static_cast<std::uint32_t>(::getgid()); };
  seam.dial = [](const std::string& path) { return DialUnixSocket(path); };
  seam.peer_euid = [](int descriptor) { return PeerEuid(descriptor); };
  // One buffer per seam, captured by the two callables that share it. A second
  // CreatePosixAuthorityLinkSeam() gets its own, so two links can never see
  // each other's partial frames however the kernel numbers their descriptors.
  const auto state = std::make_shared<ReadState>();
  seam.read_line = [state](int descriptor, std::string* line) {
    return ReadLine(state, descriptor, line);
  };
  seam.close_fd = [state](int descriptor) {
    // Cleared on close as well as owned per seam. Belt and braces: a seam that
    // is reused across a reconnect must not carry a half-frame across it.
    state->buffer.clear();
    if (descriptor >= 0) ::close(descriptor);
  };
  seam.now_ms = [] { return MonotonicMs(); };
  return seam;
}

}  // namespace imcodes::remote_desktop::macos
