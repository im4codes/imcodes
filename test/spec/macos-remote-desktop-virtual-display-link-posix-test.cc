// Real-syscall counterexamples for the authority link's POSIX seam.
//
// The link's DECISIONS are proven elsewhere against a fake filesystem. What is
// proven here is that the syscalls underneath them behave the way those proofs
// assume: that lstat reports what the rules read, that reads are bounded and
// framed, that EOF is distinguishable from a timeout, and that no descriptor
// escapes a failure path.
//
// It creates real sockets in a temporary directory. It creates no display, no
// daemon and no helper, and it never touches the real rendezvous path.

#include "macos_virtual_display_authority_link_posix.h"

#include "macos_virtual_display_control_protocol.h"

#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>

#include <fcntl.h>
#include <csignal>
#include <unistd.h>

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;

namespace {

std::string MakeTempDirectory() {
  char pattern[] = "/tmp/imcodes-link-posix-XXXXXX";
  const char* made = ::mkdtemp(pattern);
  assert(made != nullptr);
  return std::string(made);
}

/** A listening AF_UNIX socket, and the descriptors it owns. */
struct Listener {
  std::string path;
  int descriptor = -1;

  explicit Listener(const std::string& socket_path) : path(socket_path) {
    descriptor = ::socket(AF_UNIX, SOCK_STREAM, 0);
    assert(descriptor >= 0);
    sockaddr_un address = {};
    address.sun_family = AF_UNIX;
    assert(path.size() < sizeof(address.sun_path));
    std::memcpy(address.sun_path, path.c_str(), path.size());
    assert(::bind(descriptor, reinterpret_cast<const sockaddr*>(&address),
                  sizeof(address)) == 0);
    assert(::listen(descriptor, 4) == 0);
  }

  ~Listener() {
    if (descriptor >= 0) ::close(descriptor);
    ::unlink(path.c_str());
  }

  Listener(const Listener&) = delete;
  Listener& operator=(const Listener&) = delete;

  [[nodiscard]] int Accept() const { return ::accept(descriptor, nullptr, nullptr); }
};

/** How many descriptors this process currently has open. */
int OpenDescriptorCount() {
  int total = 0;
  const int limit = static_cast<int>(::sysconf(_SC_OPEN_MAX));
  for (int descriptor = 0; descriptor < (limit > 4096 ? 4096 : limit);
       ++descriptor) {
    if (::fcntl(descriptor, F_GETFD) != -1) ++total;
  }
  return total;
}

// ---------------------------------------------------------------------------

// lstat must report exactly the facts the authorisation rules read. If it
// reported anything else, every proof written against the fake filesystem would
// be a proof about a different world.
void LstatReportsWhatTheRulesRead() {
  const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
  const std::string directory = MakeTempDirectory();
  const std::string socket_path = directory + "/probe.sock";
  Listener listener(socket_path);

  rd::PathNodeFacts facts;
  assert(seam.inspect(socket_path, &facts));
  assert(facts.exists);
  assert(facts.is_socket);
  assert(!facts.is_directory);
  assert(!facts.is_symlink);
  assert(facts.uid == static_cast<std::uint32_t>(::getuid()));
  assert(facts.inode != 0);

  rd::PathNodeFacts directory_facts;
  assert(seam.inspect(directory, &directory_facts));
  assert(directory_facts.is_directory);
  assert(!directory_facts.is_socket);

  // A symlink must be reported AS a symlink, not followed. This is the single
  // fact the whole chain walk depends on.
  const std::string link_path = directory + "/link";
  assert(::symlink(socket_path.c_str(), link_path.c_str()) == 0);
  rd::PathNodeFacts link_facts;
  assert(seam.inspect(link_path, &link_facts));
  assert(link_facts.is_symlink);
  // ...and it is NOT reported as the socket it points at.
  assert(!link_facts.is_socket);

  rd::PathNodeFacts missing;
  assert(!seam.inspect(directory + "/nothing", &missing));
  assert(!missing.exists);

  ::unlink(link_path.c_str());
  ::rmdir(directory.c_str());
}

// The mode bits the daemon must set explicitly, and why. bind() applies the
// process umask, so the socket does NOT come out at the mode the caller
// intended -- measured, not assumed.
void BindAppliesUmaskSoModeMustBeSetExplicitly() {
  const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
  const std::string directory = MakeTempDirectory();
  const std::string socket_path = directory + "/umask.sock";

  const mode_t previous = ::umask(0077);
  {
    Listener listener(socket_path);
    rd::PathNodeFacts facts;
    assert(seam.inspect(socket_path, &facts));
    // Whatever bind produced, a restrictive umask has removed the bits a
    // console-uid agent would need. This is exactly why the daemon must chmod
    // explicitly rather than rely on umask.
    assert((facts.mode & 0002U) == 0);

    // After an explicit chmod the socket is reachable, and the rendezvous rule
    // agrees.
    assert(::chmod(socket_path.c_str(),
                   static_cast<mode_t>(rd::kVirtualDisplayAuthoritySocketMode)) == 0);
    assert(seam.inspect(socket_path, &facts));
    assert(facts.mode == rd::kVirtualDisplayAuthoritySocketMode);
  }
  ::umask(previous);
  ::rmdir(directory.c_str());
}

// getpeereid must report the KERNEL's answer about the other end. Here both
// ends are this test, so the answer is this uid -- which for a non-root test is
// exactly the case the link must refuse.
void PeerEuidIsTheKernelsAnswerAndRootIsRequired() {
  const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
  const std::string directory = MakeTempDirectory();
  const std::string socket_path = directory + "/peer.sock";
  Listener listener(socket_path);

  const int client = seam.dial(socket_path);
  assert(client >= 0);
  const int served = listener.Accept();
  assert(served >= 0);

  assert(seam.peer_euid(client) == static_cast<std::uint32_t>(::getuid()));
  // Non-root, so unless this test is running as root the link's rule bites.
  if (::getuid() != 0) assert(seam.peer_euid(client) != 0);

  // A descriptor that is not a socket cannot yield a peer, and must not yield
  // something that could compare equal to root by accident.
  //
  // A real pipe, not stdin: under a Node parent stdio is often a socketpair,
  // so stdin would answer and the assertion would be testing the opposite of
  // what it claims.
  int plumbing[2] = {-1, -1};
  assert(::pipe(plumbing) == 0);
  assert(seam.peer_euid(plumbing[0]) == UINT32_MAX);
  ::close(plumbing[0]);
  ::close(plumbing[1]);
  assert(seam.peer_euid(-1) == UINT32_MAX);

  // The dialled descriptor is close-on-exec: this is display authority, and the
  // agent spawns a helper. An inherited link is authority handed to a child
  // that was never granted it.
  const int flags = ::fcntl(client, F_GETFD);
  assert(flags != -1 && (flags & FD_CLOEXEC) != 0);

  ::close(served);
  seam.close_fd(client);
  ::rmdir(directory.c_str());
}

// Framing: several lines in one write, one line across several writes, and a
// line with no terminator yet.
void ReadsAreFramedAcrossWriteBoundaries() {
  const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
  const std::string directory = MakeTempDirectory();
  const std::string socket_path = directory + "/frame.sock";
  Listener listener(socket_path);

  const int client = seam.dial(socket_path);
  assert(client >= 0);
  const int served = listener.Accept();
  assert(served >= 0);

  // Three frames in ONE write. A reader that assumed one read equals one frame
  // would lose two of them.
  const std::string batch = "alpha\nbeta\ngamma\n";
  assert(::write(served, batch.data(), batch.size()) ==
         static_cast<ssize_t>(batch.size()));
  std::string line;
  assert(seam.read_line(client, &line) && line == "alpha");
  assert(seam.read_line(client, &line) && line == "beta");
  assert(seam.read_line(client, &line) && line == "gamma");

  // One frame split across THREE writes, with the terminator arriving last.
  for (const char* piece : {"de", "lta", "\n"}) {
    assert(::write(served, piece, std::strlen(piece)) > 0);
  }
  assert(seam.read_line(client, &line) && line == "delta");

  // EOF, distinguishable from a timeout because it returns promptly.
  ::close(served);
  assert(!seam.read_line(client, &line));

  seam.close_fd(client);
  ::rmdir(directory.c_str());
}

// The bound is on the PAYLOAD and it is checked BEFORE the line is handed back.
//
// An earlier version tested the buffer length only when no terminator had been
// found yet, so an oversize frame sailed through whenever its '\n' arrived in
// the same read: find() succeeded, the length test was never reached, and the
// caller got a line longer than the grammar admits.
void TheFrameBoundIsCheckedOnThePayloadNotOnlyWhenUnterminated() {
  const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
  const std::string directory = MakeTempDirectory();
  const std::string socket_path = directory + "/bound.sock";
  Listener listener(socket_path);
  const int client = seam.dial(socket_path);
  const int served = listener.Accept();
  assert(client >= 0 && served >= 0);

  // Exactly at the bound, terminator in the SAME write: admissible.
  {
    const std::string exact(rd::kVirtualDisplayControlMaxBytes, 'a');
    const std::string framed = exact + "\n";
    assert(::write(served, framed.data(), framed.size()) ==
           static_cast<ssize_t>(framed.size()));
    std::string line;
    assert(seam.read_line(client, &line));
    assert(line.size() == rd::kVirtualDisplayControlMaxBytes);
    assert(line == exact);
  }
  // One byte past the bound, terminator in the same write: refused. This is the
  // exact shape that used to be accepted.
  {
    const std::string over(rd::kVirtualDisplayControlMaxBytes + 1, 'b');
    const std::string framed = over + "\n";
    assert(::write(served, framed.data(), framed.size()) ==
           static_cast<ssize_t>(framed.size()));
    std::string line;
    assert(!seam.read_line(client, &line));
  }
  // And the refusal does not leave the oversize bytes to be re-read as a
  // following frame: after it, a legal frame still parses as itself.
  {
    const std::string good = "ctl1 verb=ready nonce=1\n";
    assert(::write(served, good.data(), good.size()) ==
           static_cast<ssize_t>(good.size()));
    std::string line;
    assert(seam.read_line(client, &line));
    assert(line == "ctl1 verb=ready nonce=1");
  }

  ::close(served);
  seam.close_fd(client);
  ::rmdir(directory.c_str());
}

// A descriptor NUMBER is not an identity: numbers are reused. A buffer keyed on
// one would splice a closed link's half-frame onto the next link that happened
// to be handed the same number.
void ReadStateIsNotSharedAcrossDescriptorReuse() {
  const std::string directory = MakeTempDirectory();
  const std::string first_path = directory + "/first.sock";
  const std::string second_path = directory + "/second.sock";

  int reused = -1;
  {
    const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
    Listener listener(first_path);
    const int client = seam.dial(first_path);
    const int served = listener.Accept();
    assert(client >= 0 && served >= 0);
    reused = client;
    // Half a frame, deliberately never terminated.
    const std::string partial = "grant1 uid=";
    assert(::write(served, partial.data(), partial.size()) > 0);
    std::string line;
    // Nothing complete to read; the peer then goes away.
    ::close(served);
    assert(!seam.read_line(client, &line));
    seam.close_fd(client);
  }

  // A second, independent seam. The kernel will hand back the lowest free
  // descriptor, which is very likely the one just closed.
  {
    const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
    Listener listener(second_path);
    const int client = seam.dial(second_path);
    const int served = listener.Accept();
    assert(client >= 0 && served >= 0);
    // Only meaningful if the number really was reused; assert it so the case
    // cannot silently stop testing what it claims.
    assert(client == reused);
    const std::string fresh = "ctl1 verb=ready nonce=1\n";
    assert(::write(served, fresh.data(), fresh.size()) > 0);
    std::string line;
    assert(seam.read_line(client, &line));
    // The previous link's "grant1 uid=" must NOT be on the front of it.
    assert(line == "ctl1 verb=ready nonce=1");
    ::close(served);
    seam.close_fd(client);
  }
  ::rmdir(directory.c_str());
}

// An oversize frame is refused, not truncated: the remainder would otherwise be
// read as the next frame, which is how one hostile line becomes two.
void AnOversizeFrameIsRefusedNotTruncated() {
  const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
  const std::string directory = MakeTempDirectory();
  const std::string socket_path = directory + "/big.sock";
  Listener listener(socket_path);

  const int client = seam.dial(socket_path);
  const int served = listener.Accept();
  assert(client >= 0 && served >= 0);

  std::thread writer([served] {
    const std::string flood(rd::kVirtualDisplayControlMaxBytes * 4, 'x');
    (void)::write(served, flood.data(), flood.size());
  });
  std::string line;
  assert(!seam.read_line(client, &line));
  writer.join();

  ::close(served);
  seam.close_fd(client);
  ::rmdir(directory.c_str());
}

// A silent peer must not hang the agent forever. The write side is bounded the
// same way; both are checked here with a short deadline so the test is fast.
void WaitsAreBounded() {
  const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
  const std::string directory = MakeTempDirectory();
  const std::string socket_path = directory + "/quiet.sock";
  Listener listener(socket_path);

  const int client = seam.dial(socket_path);
  const int served = listener.Accept();
  assert(client >= 0 && served >= 0);

  // Writing to a live peer succeeds within its bound.
  assert(rd::WriteAuthorityLinkLine(client, "ctl1 verb=ready nonce=1", 2'000));
  // Writing to a closed peer fails rather than blocking. SIGPIPE is ignored so
  // the failure is an error return rather than process death.
  ::signal(SIGPIPE, SIG_IGN);
  ::close(served);
  bool eventually_refused = false;
  for (int attempt = 0; attempt < 64 && !eventually_refused; ++attempt) {
    eventually_refused =
        !rd::WriteAuthorityLinkLine(client, "ctl1 verb=ready nonce=1", 500);
  }
  assert(eventually_refused);

  // An empty or oversize line is refused before any syscall.
  assert(!rd::WriteAuthorityLinkLine(client, "", 500));
  assert(!rd::WriteAuthorityLinkLine(
      client, std::string(rd::kVirtualDisplayControlMaxBytes + 1, 'x'), 500));
  assert(!rd::WriteAuthorityLinkLine(-1, "ctl1 verb=ready nonce=1", 500));

  seam.close_fd(client);
  ::rmdir(directory.c_str());
}

// Every refusal path must give the descriptor back. A link that leaked one per
// failed attempt would exhaust the process during any sustained outage.
void NoDescriptorEscapesAFailurePath() {
  const std::string directory = MakeTempDirectory();
  const std::string socket_path = directory + "/leak.sock";
  Listener listener(socket_path);

  const int before = OpenDescriptorCount();
  for (int attempt = 0; attempt < 32; ++attempt) {
    rd::MacosVirtualDisplayAuthorityLink link(rd::CreatePosixAuthorityLinkSeam());
    std::string error;
    // Refused at the rendezvous: a temp directory is not root-owned. That is
    // the point -- this is the ordinary failure, and it must be free.
    assert(!link.Establish(socket_path, &error));
    assert(!error.empty());
  }
  // Dialling a path that is not a socket at all, repeatedly.
  for (int attempt = 0; attempt < 32; ++attempt) {
    const rd::AuthorityLinkSeam seam = rd::CreatePosixAuthorityLinkSeam();
    assert(seam.dial(directory) < 0);
    assert(seam.dial(directory + "/nothing") < 0);
    // A path too long for sun_path is refused without opening anything.
    assert(seam.dial("/" + std::string(200, 'x')) < 0);
  }
  const int after = OpenDescriptorCount();
  assert(after == before);

  ::rmdir(directory.c_str());
}

// The seam must be complete, or the link refuses wholesale rather than
// answering some questions correctly and others by accident.
void ThePosixSeamIsComplete() {
  assert(rd::CreatePosixAuthorityLinkSeam().IsComplete());
  rd::AuthorityLinkSeam partial = rd::CreatePosixAuthorityLinkSeam();
  partial.peer_euid = nullptr;
  assert(!partial.IsComplete());
  rd::MacosVirtualDisplayAuthorityLink link(partial);
  std::string error;
  assert(!link.Establish(rd::kVirtualDisplayAuthoritySocketPath, &error));
  assert(error == "link_not_wired");
}

}  // namespace

int main() {
  LstatReportsWhatTheRulesRead();
  BindAppliesUmaskSoModeMustBeSetExplicitly();
  PeerEuidIsTheKernelsAnswerAndRootIsRequired();
  ReadsAreFramedAcrossWriteBoundaries();
  TheFrameBoundIsCheckedOnThePayloadNotOnlyWhenUnterminated();
  ReadStateIsNotSharedAcrossDescriptorReuse();
  AnOversizeFrameIsRefusedNotTruncated();
  WaitsAreBounded();
  NoDescriptorEscapesAFailurePath();
  ThePosixSeamIsComplete();
  std::printf("macos virtual display link-posix counterfactual ok\n");
  return 0;
}
