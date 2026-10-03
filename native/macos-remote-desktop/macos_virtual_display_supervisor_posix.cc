// Real OS seam for helper supervision. The decision logic lives in
// macos_virtual_display_supervisor.cc and is tested with no OS at all; this
// file is only the syscalls, kept deliberately thin so there is little here
// that can be wrong without being obviously wrong.
#include "macos_virtual_display_supervisor_posix.h"

#include <errno.h>
#include <fcntl.h>
#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecCode.h>
#include <Security/SecRequirement.h>
#include <Security/SecStaticCode.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "macos_virtual_display_helper_protocol.h"

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kHelperFileName[] = "imcodes-virtual-display-helper";
/** The child receives its binding here. Never argv, never the environment. */
constexpr int kBindingChildFd = 3;

std::uint64_t NowMs() {
  struct timeval now {};
  ::gettimeofday(&now, nullptr);
  return static_cast<std::uint64_t>(now.tv_sec) * 1000ULL +
         static_cast<std::uint64_t>(now.tv_usec) / 1000ULL;
}

bool ExecutableDirectory(std::string* directory) {
  std::uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || size == 0 ||
      size > 64 * 1024) {
    return false;
  }
  std::vector<char> buffer(size);
  if (_NSGetExecutablePath(buffer.data(), &size) != 0)
    return false;
  const std::string current(buffer.data());
  const std::string::size_type slash = current.find_last_of('/');
  if (slash == std::string::npos)
    return false;
  *directory = current.substr(0, slash + 1);
  return true;
}

}  // namespace

// Streaming SHA-256 over an ALREADY-OPEN descriptor.
//
// Hashing by path would re-open the file, which is a second lookup and
// therefore a second chance for the name to point somewhere else. The caller
// opens once, fstats, hashes THAT descriptor, and fstats again; the bytes that
// were hashed are provably the bytes of the object that was checked.
bool DescriptorSha256Hex(int fd, std::string* hex) {
  if (hex == nullptr || fd < 0)
    return false;
  if (::lseek(fd, 0, SEEK_SET) != 0)
    return false;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  std::vector<unsigned char> buffer(64 * 1024);
  for (;;) {
    const ssize_t got = ::read(fd, buffer.data(), buffer.size());
    if (got < 0) {
      if (errno == EINTR)
        continue;
      ::close(fd);
      return false;
    }
    if (got == 0)
      break;
    CC_SHA256_Update(&context, buffer.data(), static_cast<CC_LONG>(got));
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  static const char kHex[] = "0123456789abcdef";
  hex->clear();
  hex->reserve(sizeof(digest) * 2);
  for (unsigned char byte : digest) {
    hex->push_back(kHex[byte >> 4]);
    hex->push_back(kHex[byte & 0x0F]);
  }
  return true;
}

std::string SelectedReleaseIdentity() {
  // The release identity IS the directory this executable was selected from.
  // The artifact adapter publishes each verified set under `sha256-<digest>`
  // and points the selector at it, so the directory name is the identity that
  // was code-signature-verified -- not a version string we could drift from.
  std::string directory;
  if (!ExecutableDirectory(&directory))
    return std::string();
  // Strip the trailing slash, then take the final path component.
  if (!directory.empty() && directory.back() == '/')
    directory.pop_back();
  const std::string::size_type slash = directory.find_last_of('/');
  const std::string name =
      slash == std::string::npos ? directory : directory.substr(slash + 1);
  // Bounded and character-restricted so it can be carried in the binding frame
  // without escaping. An unexpected shape yields an empty identity, which the
  // supervisor refuses -- better than binding to something unparseable.
  // 96: `sha256-` + 64 hex = 71 characters.
  if (name.empty() || name.size() > 96)
    return std::string();
  for (const char character : name) {
    const bool allowed = (character >= 'a' && character <= 'z') ||
                         (character >= 'A' && character <= 'Z') ||
                         (character >= '0' && character <= '9') ||
                         character == '.' || character == '-' || character == '_';
    if (!allowed)
      return std::string();
  }
  return name;
}

SupervisorSeam CreatePosixSupervisorSeam() {
  SupervisorSeam seam;

  seam.effective_uid = [] { return static_cast<std::uint32_t>(::geteuid()); };
  seam.now_ms = [] { return NowMs(); };

  seam.random_u64 = [] {
    std::uint64_t value = 0;
    // The system CSPRNG, not a counter or a clock: every later frame is
    // authenticated by echoing this, so a predictable value is a forgeable one.
    ::arc4random_buf(&value, sizeof(value));
    return value;
  };

  seam.resolve_verified_helper = [](const std::string& release_identity,
                                    const std::string& expected_sha256,
                                    const std::string& expected_designated_requirement,
                                    std::string* path, std::string* error) {
    const auto fail = [&](const char* message) {
      if (error != nullptr) *error = message;
      return false;
    };
    // Both are REQUIRED and both are actually compared below. An earlier
    // version took release_identity, checked only that it was non-empty, and
    // then never used it -- while calling itself "verified". lstat and a mode
    // check prove the path is not a symlink; they prove nothing about which
    // release the bytes came from.
    if (release_identity.empty())
      return fail("no release identity to verify the helper against");
    if (expected_sha256.size() != 64)
      return fail("no expected helper digest to verify against");
    std::string directory;
    if (!ExecutableDirectory(&directory))
      return fail("could not resolve this executable's directory");
    const std::string candidate = directory + kHelperFileName;

    // Same release: the helper must sit in the directory the selector
    // published, whose name IS the verified release identity.
    std::string enclosing = directory;
    if (!enclosing.empty() && enclosing.back() == '/')
      enclosing.pop_back();
    const std::string::size_type slash = enclosing.find_last_of('/');
    const std::string enclosing_name =
        slash == std::string::npos ? enclosing : enclosing.substr(slash + 1);
    if (enclosing_name != release_identity)
      return fail("virtual-display helper is not from the selected release");

    // PARENT DIRECTORY FIRST, and by descriptor.
    //
    // Every check below is worthless if the directory holding the helper is
    // writable by anyone else: they can replace the file between any two of
    // them. Opening the directory once and resolving the child RELATIVE to that
    // descriptor also removes the repeated path walk, so no component of the
    // path can be swapped underneath us mid-verification.
    const int directory_fd =
        ::open(enclosing.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory_fd < 0)
      return fail("release directory could not be opened");
    struct stat directory_info {};
    if (::fstat(directory_fd, &directory_info) != 0 ||
        !S_ISDIR(directory_info.st_mode)) {
      ::close(directory_fd);
      return fail("release directory is not a directory");
    }
    if (directory_info.st_uid != ::geteuid() && directory_info.st_uid != 0) {
      ::close(directory_fd);
      return fail("release directory is owned by an unexpected user");
    }
    if ((directory_info.st_mode & (S_IWGRP | S_IWOTH)) != 0) {
      ::close(directory_fd);
      return fail("release directory is writable by group or other");
    }

    // O_NOFOLLOW on the openat: a symlink here would escape the directory the
    // artifact adapter actually code-signature-verified.
    const int helper_fd =
        ::openat(directory_fd, kHelperFileName, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    ::close(directory_fd);
    if (helper_fd < 0) {
      return fail(errno == ELOOP
                      ? "virtual-display helper path is a symlink; refusing to follow it"
                      : "virtual-display helper is missing from the release");
    }
    struct stat before {};
    if (::fstat(helper_fd, &before) != 0) {
      ::close(helper_fd);
      return fail("virtual-display helper could not be inspected");
    }
    if (!S_ISREG(before.st_mode)) {
      ::close(helper_fd);
      return fail("virtual-display helper is not a regular file");
    }
    if (before.st_uid != ::geteuid() && before.st_uid != 0) {
      ::close(helper_fd);
      return fail("virtual-display helper is owned by an unexpected user");
    }
    if ((before.st_mode & (S_IWGRP | S_IWOTH)) != 0) {
      ::close(helper_fd);
      return fail("virtual-display helper is writable by group or other");
    }
    if ((before.st_mode & S_IXUSR) == 0) {
      ::close(helper_fd);
      return fail("virtual-display helper is not executable");
    }

    // Digest the DESCRIPTOR, not the path.
    std::string digest;
    if (!DescriptorSha256Hex(helper_fd, &digest)) {
      ::close(helper_fd);
      return fail("could not digest the virtual-display helper");
    }
    if (digest != expected_sha256) {
      ::close(helper_fd);
      return fail("virtual-display helper digest does not match the release manifest");
    }

    // fstat AGAIN and pin dev+ino+size+mtime. If the object we hashed is not
    // the object we started with, something replaced it mid-verification and
    // the digest we just accepted describes a file that is no longer there.
    struct stat after {};
    if (::fstat(helper_fd, &after) != 0 ||
        after.st_dev != before.st_dev || after.st_ino != before.st_ino ||
        after.st_size != before.st_size ||
        after.st_mtimespec.tv_sec != before.st_mtimespec.tv_sec ||
        after.st_mtimespec.tv_nsec != before.st_mtimespec.tv_nsec) {
      ::close(helper_fd);
      return fail("virtual-display helper changed while it was being verified");
    }
    ::close(helper_fd);

    // The code signature must satisfy the EXACT designated requirement the
    // verified release recorded.
    //
    // A digest proves the bytes are the ones the manifest named. It does not
    // prove they are signed, that the signature validates, or that the signer
    // is us -- an attacker who can write the release directory can put a
    // correctly-digested unsigned binary there only if they also control the
    // manifest, but defence that depends on "they cannot have both" is not
    // defence. SecStaticCodeCheckValidity is what makes the signer part of the
    // decision.
    if (!expected_designated_requirement.empty()) {
      CFStringRef path_string = CFStringCreateWithCString(
          kCFAllocatorDefault, candidate.c_str(), kCFStringEncodingUTF8);
      CFStringRef requirement_string = CFStringCreateWithCString(
          kCFAllocatorDefault, expected_designated_requirement.c_str(),
          kCFStringEncodingUTF8);
      if (path_string == nullptr || requirement_string == nullptr) {
        if (path_string != nullptr) CFRelease(path_string);
        if (requirement_string != nullptr) CFRelease(requirement_string);
        return fail("could not build the code-signature query");
      }
      CFURLRef url = CFURLCreateWithFileSystemPath(
          kCFAllocatorDefault, path_string, kCFURLPOSIXPathStyle, false);
      CFRelease(path_string);
      SecStaticCodeRef code = nullptr;
      SecRequirementRef requirement = nullptr;
      OSStatus status = url == nullptr
          ? errSecParam
          : SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
      if (url != nullptr) CFRelease(url);
      if (status == errSecSuccess) {
        status = SecRequirementCreateWithString(
            requirement_string, kSecCSDefaultFlags, &requirement);
      }
      CFRelease(requirement_string);
      if (status == errSecSuccess) {
        // kSecCSStrictValidate: a nested or detached-resource trick must not
        // pass where a plain validity check would.
        // Cast through the flags type: the two constants live in different
        // anonymous enums, and clang treats the mixed bitwise op as deprecated.
        const SecCSFlags flags =
            static_cast<SecCSFlags>(kSecCSDefaultFlags) |
            static_cast<SecCSFlags>(kSecCSStrictValidate);
        status = SecStaticCodeCheckValidity(code, flags, requirement);
      }
      if (code != nullptr) CFRelease(code);
      if (requirement != nullptr) CFRelease(requirement);
      if (status != errSecSuccess) {
        return fail("virtual-display helper does not satisfy the release "
                    "designated requirement");
      }
    }

    *path = candidate;
    return true;
  };

  seam.spawn_helper = [](const std::string& path,
                         const VirtualDisplayHelperBinding& binding,
                         SupervisedHelper* helper, std::string* error) {
    const auto fail = [&](const char* message) {
      if (error != nullptr) *error = message;
      return false;
    };
    if (helper == nullptr)
      return fail("no helper slot to populate");
    const std::string binding_line = SerializeVirtualDisplayHelperBinding(binding);
    if (binding_line.empty())
      return fail("could not serialize the helper binding");

    // Binding pipe: parent writes, child reads on fd 3.
    int binding_fds[2] = {-1, -1};
    if (::pipe(binding_fds) != 0)
      return fail("could not create the binding pipe");
    // Control channel: the child's stdin and stdout.
    int control_fds[2] = {-1, -1};
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, control_fds) != 0) {
      ::close(binding_fds[0]);
      ::close(binding_fds[1]);
      return fail("could not create the helper control socket");
    }
    // CLOEXEC on the PARENT ends only. The child ends are handed over
    // explicitly through file actions; marking those close-on-exec would close
    // them out from under the helper. Marking the parent ends stops them
    // leaking into any other process we spawn later.
    ::fcntl(binding_fds[1], F_SETFD, FD_CLOEXEC);
    ::fcntl(control_fds[0], F_SETFD, FD_CLOEXEC);

    // Relocate both child-side descriptors ABOVE the targets before building
    // the file actions.
    //
    // This is not tidiness. With stdin/stdout/stderr occupying 0/1/2, the first
    // descriptor pipe() returns is typically 3 -- which is exactly
    // kBindingChildFd. In that case adddup2(3, 3) is a no-op and the
    // unconditional addclose(3) that followed would close the child's binding
    // descriptor, so the helper would find fd 3 shut and refuse its own launch
    // binding. Every source is moved to >= kRelocatedFdBase first, which makes
    // source and target provably disjoint and the closes unconditionally safe.
    constexpr int kRelocatedFdBase = 16;
    const int child_control = ::fcntl(control_fds[1], F_DUPFD, kRelocatedFdBase);
    const int child_binding = ::fcntl(binding_fds[0], F_DUPFD, kRelocatedFdBase);
    ::close(control_fds[1]);
    ::close(binding_fds[0]);
    control_fds[1] = child_control;
    binding_fds[0] = child_binding;
    if (child_control < 0 || child_binding < 0) {
      if (child_control >= 0) ::close(child_control);
      if (child_binding >= 0) ::close(child_binding);
      ::close(binding_fds[1]);
      ::close(control_fds[0]);
      return fail("could not relocate the helper descriptors");
    }

    posix_spawn_file_actions_t actions;
    if (posix_spawn_file_actions_init(&actions) != 0) {
      ::close(binding_fds[0]); ::close(binding_fds[1]);
      ::close(control_fds[0]); ::close(control_fds[1]);
      return fail("could not initialise spawn file actions");
    }
    posix_spawn_file_actions_adddup2(&actions, control_fds[1], STDIN_FILENO);
    posix_spawn_file_actions_adddup2(&actions, control_fds[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, binding_fds[0], kBindingChildFd);
    // Safe unconditionally now: every source is >= kRelocatedFdBase, so none of
    // them can alias a dup2 target.
    static_assert(kRelocatedFdBase > kBindingChildFd,
                  "relocated sources must not alias the binding target");
    posix_spawn_file_actions_addclose(&actions, binding_fds[0]);
    posix_spawn_file_actions_addclose(&actions, binding_fds[1]);
    posix_spawn_file_actions_addclose(&actions, control_fds[0]);
    posix_spawn_file_actions_addclose(&actions, control_fds[1]);

    const std::string fd_text = std::to_string(kBindingChildFd);
    char* const argv[] = {
        const_cast<char*>(path.c_str()),
        const_cast<char*>("--imcodes-bind-fd"),
        const_cast<char*>(fd_text.c_str()),
        nullptr,
    };
    // EMPTY environment.
    //
    // Passing `environ` handed the helper every variable this worker holds --
    // launch challenge, control socket path, generation, tokens. That directly
    // contradicts the isolation this design depends on: the binding is
    // deliberately delivered on fd 3 precisely so credentials never appear
    // anywhere a child or `ps` can read them, and then the environment leaked
    // them anyway. The helper needs nothing from the environment; it receives
    // everything it may act on over fd 3.
    char* const empty_environment[] = {nullptr};
    pid_t child = 0;
    const int spawned = ::posix_spawn(&child, path.c_str(), &actions, nullptr,
                                      argv, empty_environment);
    posix_spawn_file_actions_destroy(&actions);
    ::close(binding_fds[0]);
    ::close(control_fds[1]);
    if (spawned != 0) {
      ::close(binding_fds[1]);
      ::close(control_fds[0]);
      return fail("posix_spawn of the virtual-display helper failed");
    }

    // Write the binding, then close the write end so the child sees EOF and
    // cannot block waiting for more.
    const ssize_t written =
        ::write(binding_fds[1], binding_line.data(), binding_line.size());
    ::close(binding_fds[1]);
    if (written < 0 || static_cast<std::size_t>(written) != binding_line.size()) {
      ::kill(child, SIGKILL);
      int status = 0;
      ::waitpid(child, &status, 0);
      ::close(control_fds[0]);
      return fail("could not deliver the helper binding");
    }

    helper->pid = static_cast<std::int32_t>(child);
    // The write end is already closed; -1 keeps the supervisor's descriptor
    // accounting truthful rather than tracking a closed number.
    helper->binding_write_fd = -1;
    helper->control_fd = control_fds[0];
    helper->epoch = binding.epoch;
    return true;
  };

  seam.await_ready = [](const SupervisedHelper& helper,
                        std::uint32_t timeout_ms) {
    if (helper.control_fd < 0)
      return false;
    // Bounded: a helper that never reports ready is a dead helper, and waiting
    // longer only delays failing closed.
    struct timeval deadline {};
    deadline.tv_sec = static_cast<time_t>(timeout_ms / 1000U);
    deadline.tv_usec = static_cast<suseconds_t>((timeout_ms % 1000U) * 1000U);
    ::setsockopt(helper.control_fd, SOL_SOCKET, SO_RCVTIMEO, &deadline,
                 sizeof(deadline));
    std::string line;
    char byte = 0;
    while (line.size() <= kVirtualDisplayHelperMaxFrameBytes) {
      const ssize_t got = ::recv(helper.control_fd, &byte, 1, 0);
      if (got <= 0)
        return false;  // timeout, EOF or error
      if (byte == '\n')
        return line == "ready";
      line.push_back(byte);
    }
    return false;
  };

  seam.still_running = [](std::int32_t pid) {
    if (pid <= 0)
      return false;
    int status = 0;
    // Non-blocking reap: a zero return means it is still alive, anything else
    // means it has exited and has now been collected rather than left a zombie.
    const pid_t observed = ::waitpid(static_cast<pid_t>(pid), &status, WNOHANG);
    return observed == 0;
  };

  seam.terminate_and_reap = [](std::int32_t pid, std::uint32_t timeout_ms) {
    if (pid <= 0)
      return;
    ::kill(static_cast<pid_t>(pid), SIGTERM);
    const std::uint64_t deadline = NowMs() + timeout_ms;
    for (;;) {
      int status = 0;
      const pid_t observed = ::waitpid(static_cast<pid_t>(pid), &status, WNOHANG);
      if (observed != 0)
        return;  // reaped
      if (NowMs() >= deadline)
        break;
      ::usleep(50 * 1000);
    }
    // Bounded: a helper that ignores SIGTERM still has to go, because it is
    // holding a display nobody owns any more.
    ::kill(static_cast<pid_t>(pid), SIGKILL);
    int status = 0;
    ::waitpid(static_cast<pid_t>(pid), &status, 0);
  };

  seam.close_fd = [](int fd) {
    if (fd >= 0)
      ::close(fd);
  };

  return seam;
}

VirtualDisplayHelperExchange MacosVirtualDisplaySupervisor::MakeBoundExchange() {
  if (state_ != SupervisorState::kReady || helper_.control_fd < 0)
    return nullptr;
  const int fd = helper_.control_fd;
  const std::uint64_t bound_epoch = helper_.epoch;
  // Captured by value and re-checked on every call: an exchange handed out for
  // one helper must not keep working against its replacement.
  const MacosVirtualDisplaySupervisor* self = this;
  return [fd, bound_epoch, self](const std::string& request,
                                 std::string* reply,
                                 std::uint32_t timeout_ms) -> bool {
    if (reply == nullptr)
      return false;
    // The helper this exchange was built for is gone or was replaced.
    if (self->state() != SupervisorState::kReady || self->epoch() != bound_epoch)
      return false;
    struct timeval deadline {};
    deadline.tv_sec = static_cast<time_t>(timeout_ms / 1000U);
    deadline.tv_usec = static_cast<suseconds_t>((timeout_ms % 1000U) * 1000U);
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &deadline, sizeof(deadline));
    const std::string framed = request + "\n";
    if (::send(fd, framed.data(), framed.size(), 0) !=
        static_cast<ssize_t>(framed.size())) {
      return false;
    }
    std::string line;
    char byte = 0;
    while (line.size() <= kVirtualDisplayHelperMaxFrameBytes) {
      const ssize_t got = ::recv(fd, &byte, 1, 0);
      if (got <= 0)
        return false;  // timeout, EOF or error: never an assumed success
      if (byte == '\n') {
        *reply = line;
        return true;
      }
      line.push_back(byte);
    }
    return false;
  };
}

}  // namespace imcodes::remote_desktop::macos
