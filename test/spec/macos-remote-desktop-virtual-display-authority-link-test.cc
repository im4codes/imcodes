// Counterexamples for the agent's half of the asymmetric mutual authentication.
//
// The agent proves the daemon by two facts that reinforce each other:
//
//   * the object it dialled could only have been PLACED by root, and
//   * root is what ANSWERED.
//
// Neither alone is enough. A root-owned socket proves nothing if a non-root
// process is somehow serving it; a root peer proves nothing if the agent was
// tricked into dialling a different object. So both are tested, and so is the
// window between them.
//
// Everything here is provable with no filesystem, no socket and no daemon.

#include "macos_virtual_display_authority_link.h"

#include <cassert>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;

namespace {

constexpr char kPath[] =
    "/private/var/db/imcodes-node/runtime/virtual-display-authority.sock";
/** The console user the agent runs as, and its primary group. */
constexpr std::uint32_t kAgentUid = 501;
constexpr std::uint32_t kAgentGid = 20;  // staff

/** A fake filesystem: path -> facts, walked exactly as the kernel would. */
struct FakeFs {
  std::map<std::string, rd::PathNodeFacts> nodes;

  static rd::PathNodeFacts Directory(std::uint32_t uid, std::uint32_t mode,
                                     std::uint64_t inode) {
    rd::PathNodeFacts facts;
    facts.exists = true;
    facts.is_directory = true;
    facts.uid = uid;
    facts.gid = 0;  // wheel
    facts.mode = mode;
    facts.device = 1;
    facts.inode = inode;
    return facts;
  }

  static rd::PathNodeFacts Socket(std::uint32_t uid, std::uint32_t mode,
                                  std::uint64_t inode) {
    rd::PathNodeFacts facts;
    facts.exists = true;
    facts.is_socket = true;
    facts.uid = uid;
    facts.gid = 0;  // wheel
    facts.mode = mode;
    facts.device = 1;
    facts.inode = inode;
    return facts;
  }

  /** The real chain: stock root:wheel 0755, then the daemon's own 0711/0622. */
  static FakeFs Healthy() {
    FakeFs fs;
    std::uint64_t inode = 100;
    for (const char* directory : {"/", "/private", "/private/var",
                                  "/private/var/db",
                                  "/private/var/db/imcodes-node"}) {
      fs.nodes[directory] = Directory(0, 0755, inode++);
    }
    // The runtime directory the daemon creates: traversable by a known path,
    // never writable, so the socket inside it cannot be replaced.
    fs.nodes["/private/var/db/imcodes-node/runtime"] =
        Directory(0, rd::kVirtualDisplayAuthorityDirectoryMode, inode++);
    // 0622: root reads and writes, everyone else may only CONNECT. Write on a
    // socket is not an anti-substitution control -- that is the directory's
    // job -- but it IS what makes the socket reachable at all.
    fs.nodes[kPath] =
        Socket(0, rd::kVirtualDisplayAuthoritySocketMode, inode);
    return fs;
  }

  std::function<bool(const std::string&, rd::PathNodeFacts*)> Inspect() {
    return [this](const std::string& path, rd::PathNodeFacts* out) {
      const auto found = nodes.find(path);
      if (found == nodes.end()) return false;
      *out = found->second;
      return true;
    };
  }
};

rd::VirtualDisplayAuthorityChallenge Challenge() {
  rd::VirtualDisplayAuthorityChallenge challenge;
  challenge.challenge = std::string(43, 'A');
  challenge.service_generation = 7;
  challenge.audit_session_id = 100003;
  challenge.ttl_ms = 60'000;
  // Formed the way the link forms it: receipt instant on the local
  // monotonic clock, plus the TTL. Fixtures clock at 1'000'000.
  challenge.deadline_ms = 1'000'000 + challenge.ttl_ms;
  return challenge;
}

rd::VirtualDisplayGrant Grant() {
  rd::VirtualDisplayGrant grant;
  grant.uid = 501;
  grant.audit_session_id = 100003;
  grant.session_type = "Aqua";
  grant.service_generation = 7;
  grant.challenge = std::string(43, 'A');
  grant.ttl_ms = 60'000;
  grant.set_sha256 = std::string(64, 'd');
  grant.release_identity = "sha256-" + grant.set_sha256;
  grant.helper_file_name = "imcodes-virtual-display-helper";
  grant.helper_sha256 = std::string(64, 'e');
  grant.helper_size = 4096;
  grant.helper_designated_requirement = rd::CanonicalDesignatedRequirement(
      "cc.imcodes.node.virtual-display-helper", "ABCDE12345");
  grant.helper_bundle_identifier = "cc.imcodes.node.virtual-display-helper";
  grant.team_id = "ABCDE12345";
  grant.arch = "arm64";
  return grant;
}

/** The daemon end, as the agent experiences it. */
struct FakeDaemon {
  FakeFs fs = FakeFs::Healthy();
  std::uint32_t answering_euid = 0;
  std::vector<std::string> lines;
  std::size_t next_line = 0;
  std::uint64_t clock_ms = 1'000'000;
  int open_descriptors = 0;
  /** Set to swap the object at the path the instant the dial happens. */
  bool replace_on_dial = false;
  bool dial_ok = true;

  FakeDaemon() {
    lines.push_back(
        rd::SerializeVirtualDisplayAuthorityChallenge(Challenge()));
  }

  rd::AuthorityLinkSeam Seam() {
    rd::AuthorityLinkSeam seam;
    seam.inspect = fs.Inspect();
    seam.dialling_uid = [] { return kAgentUid; };
    seam.dialling_gid = [] { return kAgentGid; };
    seam.dial = [this](const std::string&) {
      if (!dial_ok) return -1;
      // The window the ABA check exists to close: unlink and recreate under the
      // same name, at the exact moment the agent is dialling.
      if (replace_on_dial) fs.nodes[kPath].inode += 1;
      ++open_descriptors;
      return 7;
    };
    seam.peer_euid = [this](int) { return answering_euid; };
    seam.read_line = [this](int, std::string* line) {
      if (next_line >= lines.size()) return false;  // EOF
      *line = lines[next_line++];
      return true;
    };
    seam.close_fd = [this](int) { --open_descriptors; };
    seam.now_ms = [this] { return clock_ms; };
    return seam;
  }
};

// ---------------------------------------------------------------------------

// The healthy chain must be accepted, or every refusal below proves nothing.
void TheRealChainIsTrusted() {
  FakeFs fs = FakeFs::Healthy();
  assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
         rd::RendezvousVerdict::kTrusted);
}

// The ownership rule, at every position in the chain.
void ANonRootComponentAnywhereIsRefused() {
  for (const char* component : {"/", "/private", "/private/var",
                                "/private/var/db",
                                "/private/var/db/imcodes-node",
                                "/private/var/db/imcodes-node/runtime", kPath}) {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes[component].uid = 501;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kNotRootOwned);
  }
}

// A directory a non-root principal can write is a directory in which the socket
// can be REPLACED, which defeats the whole scheme.
void AWritableDirectoryAnywhereIsRefused() {
  for (const char* directory : {"/", "/private", "/private/var",
                                "/private/var/db",
                                "/private/var/db/imcodes-node",
                                "/private/var/db/imcodes-node/runtime"}) {
    for (const std::uint32_t bit : {0020U, 0002U}) {
      FakeFs fs = FakeFs::Healthy();
      fs.nodes[directory].mode |= bit;
      assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
             rd::RendezvousVerdict::kDirectoryWritable);
    }
  }

  // 0700 is the mode the design brief first specified, and it cannot work:
  // connect(2) needs search on every component, so a console-uid agent gets
  // EACCES -- indistinguishable from "the daemon is not running". It is named
  // rather than silently unreachable. This is NOT a weakening of the rule:
  // replacing the socket needs WRITE on the directory, which 0711 still denies.
  for (const char* directory : {"/private/var/db/imcodes-node",
                                "/private/var/db/imcodes-node/runtime"}) {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes[directory].mode = 0700;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kDirectoryNotTraversable);
    // 0711 is accepted, and carries the identical anti-substitution property.
    fs.nodes[directory].mode = 0711;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kTrusted);
    // ...while 0713 (adds group write) is still refused, proving the accepted
    // mode is not simply "anything with an x bit".
    fs.nodes[directory].mode = 0731;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kDirectoryWritable);
  }

  // This is exactly why the rendezvous is NOT under /private/var/run, which on
  // a stock machine is `drwxrwxr-x root:daemon`. Encoded as a test so the
  // reason survives the next person who thinks /var/run is the obvious home.
  FakeFs run;
  run.nodes["/"] = FakeFs::Directory(0, 0755, 1);
  run.nodes["/private"] = FakeFs::Directory(0, 0755, 2);
  run.nodes["/private/var"] = FakeFs::Directory(0, 0755, 3);
  run.nodes["/private/var/run"] = FakeFs::Directory(0, 0775, 4);  // group-writable
  run.nodes["/private/var/run/x.sock"] = FakeFs::Socket(0, 0666, 5);
  assert(rd::VerifyAuthorityRendezvous("/private/var/run/x.sock", kAgentUid,
                                       kAgentGid, run.Inspect()) ==
         rd::RendezvousVerdict::kDirectoryWritable);
}

// The socket's write bits are NOT an anti-substitution control -- that is the
// directory's job -- but they ARE a reachability fact. A socket the agent
// cannot connect to must be NAMED, because the alternative is a bare EACCES
// that reads exactly like "the daemon is not running": a silent, permanent
// outage nobody can diagnose from the outside.
void SocketReachabilityIsNamedNotSilent() {
  // Anything granting write to `other` is reachable by the console agent.
  for (const std::uint32_t mode : {0622U, 0666U, 0722U, 0777U}) {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes[kPath].mode = mode;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid,
                                         fs.Inspect()) ==
           rd::RendezvousVerdict::kTrusted);
  }
  // 0600 is root-only. It is not a security defect, it is an outage, and it
  // gets its own verdict rather than failing later at connect().
  for (const std::uint32_t mode : {0600U, 0644U, 0620U, 0000U}) {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes[kPath].mode = mode;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid,
                                         fs.Inspect()) ==
           rd::RendezvousVerdict::kSocketNotConnectable);
  }
  // The POSIX class rule, where it actually bites: the FIRST matching class
  // wins even when a later one is more permissive. A root-owned 0026 socket
  // grants write to group and other but NOT to root -- and a 0602 socket
  // grants it to other but not to a member of the owning group.
  {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes[kPath].gid = kAgentGid;
    fs.nodes[kPath].mode = 0602;  // owner rw, group ---, other -w-
    // The agent matches the GROUP class, which has no write bit, so the
    // permissive `other` bits do not apply to it.
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid,
                                         fs.Inspect()) ==
           rd::RendezvousVerdict::kSocketNotConnectable);
    fs.nodes[kPath].mode = 0620;  // group -w-
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid,
                                         fs.Inspect()) ==
           rd::RendezvousVerdict::kTrusted);
  }
  // root is not subject to the triples at all, so a root caller is never told
  // the socket is unreachable.
  {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes[kPath].mode = 0600;
    assert(rd::VerifyAuthorityRendezvous(kPath, 0, 0, fs.Inspect()) ==
           rd::RendezvousVerdict::kTrusted);
  }
}

// A symlink anywhere means the object the kernel resolves is not the object we
// checked, so the check proves nothing about what will actually be dialled.
void ASymlinkAnywhereIsRefused() {
  for (const char* component : {"/private", "/private/var/db",
                                "/private/var/db/imcodes-node",
                                "/private/var/db/imcodes-node/runtime", kPath}) {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes[component].is_symlink = true;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kSymlinkInPath);
  }
}

void ShapeFailuresAreDistinct() {
  {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes.erase("/private/var/db");
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kAbsent);
  }
  {
    FakeFs fs = FakeFs::Healthy();
    fs.nodes["/private/var/db"].is_directory = false;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kNotADirectory);
  }
  {
    // A regular file where the socket should be: something else is publishing
    // at our rendezvous.
    FakeFs fs = FakeFs::Healthy();
    fs.nodes[kPath].is_socket = false;
    assert(rd::VerifyAuthorityRendezvous(kPath, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kNotASocket);
  }
  // Paths that would make the walked chain differ from the resolved one.
  FakeFs fs = FakeFs::Healthy();
  for (const char* path : {"", "relative/path", "/trailing/", "//double",
                           "/private/./var", "/private/../var"}) {
    assert(rd::VerifyAuthorityRendezvous(path, kAgentUid, kAgentGid, fs.Inspect()) ==
           rd::RendezvousVerdict::kPathUnusable);
  }
}

// A root-owned rendezvous proves who PLACED it. It does not prove who is
// ANSWERING, so the peer's kernel euid is checked separately.
void ANonRootPeerIsRefusedEvenOnAPerfectPath() {
  for (const std::uint32_t euid : {501U, 1U, UINT32_MAX}) {
    FakeDaemon daemon;
    daemon.answering_euid = euid;
    rd::MacosVirtualDisplayAuthorityLink link(daemon.Seam());
    std::string error;
    assert(!link.Establish(kPath, &error));
    assert(link.state() == rd::AuthorityLinkState::kPeerNotRoot);
    assert(error == "peer_not_root");
    // The descriptor is reclaimed on the refusal path, not leaked.
    assert(daemon.open_descriptors == 0);
    assert(!link.challenge().IsValid());
  }
}

// The window between the check and the connect is real: the object can be
// unlinked and recreated under the same name.
void ASocketReplacedBetweenCheckAndConnectIsRefused() {
  FakeDaemon daemon;
  daemon.replace_on_dial = true;
  rd::MacosVirtualDisplayAuthorityLink link(daemon.Seam());
  std::string error;
  assert(!link.Establish(kPath, &error));
  assert(link.state() == rd::AuthorityLinkState::kSocketReplaced);
  assert(error == "socket_replaced");
  assert(daemon.open_descriptors == 0);
  // No challenge was adopted, so nothing can be admitted against this link.
  std::string frame;
  assert(!link.NextFrame(&frame, &error));
}

void TheHappyPathEstablishesAndBinds() {
  FakeDaemon daemon;
  rd::MacosVirtualDisplayAuthorityLink link(daemon.Seam());
  std::string error;
  assert(link.Establish(kPath, &error));
  assert(link.state() == rd::AuthorityLinkState::kEstablished);
  assert(link.challenge().challenge == Challenge().challenge);
  assert(link.challenge().service_generation == 7);
  assert(daemon.open_descriptors == 1);

  link.Close();
  assert(daemon.open_descriptors == 0);
  // Closing clears the challenge: a challenge outliving its connection would
  // let a grant be admitted against an authority that is no longer there.
  assert(!link.challenge().IsValid());
}

// The daemon's connection lifetime IS the authority's lifetime.
void DaemonEofIsTerminal() {
  FakeDaemon daemon;
  rd::MacosVirtualDisplayAuthorityLink link(daemon.Seam());
  std::string error;
  assert(link.Establish(kPath, &error));

  std::string frame;
  assert(!link.NextFrame(&frame, &error));  // no more lines: EOF
  assert(link.state() == rd::AuthorityLinkState::kDaemonGone);
  assert(error == "daemon_gone");
  assert(daemon.open_descriptors == 0);
  assert(!link.challenge().IsValid());

  // Terminal: it does not silently recover. A link that reconnected on its own
  // would let a restarted daemon inherit an authority it never granted.
  assert(!link.NextFrame(&frame, &error));
  assert(link.state() == rd::AuthorityLinkState::kDaemonGone);
}

// The link is a TRANSPORT: it hands up every frame unclassified, in order, and
// does not decide what any of them mean.
//
// An earlier version returned only `grant1` frames and silently dropped the
// rest -- which, once control requests started arriving on this same channel,
// meant consuming a worker's request from the socket and answering nobody.
void TheLinkHandsUpEveryFrameUnclassified() {
  FakeDaemon daemon;
  daemon.lines.push_back("ctl1 verb=ready nonce=1");
  daemon.lines.push_back(rd::SerializeVirtualDisplayGrant(Grant()));
  daemon.lines.push_back("total nonsense");
  rd::MacosVirtualDisplayAuthorityLink link(daemon.Seam());
  std::string error;
  assert(link.Establish(kPath, &error));

  std::string frame;
  // The control frame arrives, is NOT swallowed, and the link stays up.
  assert(link.NextFrame(&frame, &error));
  assert(frame == "ctl1 verb=ready nonce=1");
  assert(link.state() == rd::AuthorityLinkState::kEstablished);

  // So does the grant, in order.
  assert(link.NextFrame(&frame, &error));
  assert(frame.rfind("grant1 ", 0) == 0);

  // And so does something neither side understands: judging it is the owner's
  // job, and closing the link here would turn one bad frame into a lost
  // display.
  assert(link.NextFrame(&frame, &error));
  assert(frame == "total nonsense");
  assert(link.state() == rd::AuthorityLinkState::kEstablished);

  // Only EOF ends it.
  assert(!link.NextFrame(&frame, &error));
  assert(link.state() == rd::AuthorityLinkState::kDaemonGone);
}

// The challenge must arrive well-formed, in date, and through this connection.
void ARefusedChallengeLeavesNothingEstablished() {
  for (const char* line : {"", "chal1", "chal1 challenge=short svcgen=1 asid=1 ttl=2",
                           "grant1 uid=501",
                           "chal1 svcgen=7 asid=100003 ttl=60000"}) {
    FakeDaemon daemon;
    daemon.lines[0] = line;
    rd::MacosVirtualDisplayAuthorityLink link(daemon.Seam());
    std::string error;
    assert(!link.Establish(kPath, &error));
    assert(link.state() == rd::AuthorityLinkState::kChallengeRefused);
    assert(daemon.open_descriptors == 0);
  }
  // A challenge whose promise is not expressible at all.
  //
  // This used to advance a monotonic clock past a daemon-stamped EPOCH
  // deadline and assert "challenge_expired". The two values were never in the
  // same clock domain -- the daemon's instant is astronomically larger than
  // time-since-boot -- so the comparison was false on every real machine and
  // this case passed only because the fixture chose both numbers. The wire now
  // carries a duration, and a zero TTL is a promise with no life in it.
  {
    FakeDaemon daemon;
    daemon.lines[0] = std::string("chal1 challenge=") + std::string(43, 'A')
                    + " svcgen=7 asid=100003 ttl=0";
    rd::MacosVirtualDisplayAuthorityLink link(daemon.Seam());
    std::string error;
    assert(!link.Establish(kPath, &error));
    assert(error == "challenge_refused");
    assert(daemon.open_descriptors == 0);
  }
}

// The challenge binds a grant to THIS connection. Every field is load-bearing.
void AGrantMustMatchTheChallengeItWasPromisedUnder() {
  const rd::VirtualDisplayAuthorityChallenge challenge = Challenge();
  std::string error;
  assert(rd::GrantMatchesAuthorityChallenge(Grant(), challenge, &error));

  {  // Replayed from another connection: a different challenge entirely.
    rd::VirtualDisplayGrant grant = Grant();
    grant.challenge = std::string(43, 'B');
    assert(!rd::GrantMatchesAuthorityChallenge(grant, challenge, &error));
    assert(error == "grant_challenge_mismatch");
  }
  {  // A previous incarnation of the daemon's service.
    rd::VirtualDisplayGrant grant = Grant();
    grant.service_generation = 6;
    assert(!rd::GrantMatchesAuthorityChallenge(grant, challenge, &error));
    assert(error == "grant_service_generation_mismatch");
  }
  {  // The neighbouring login window.
    rd::VirtualDisplayGrant grant = Grant();
    grant.audit_session_id = 100004;
    assert(!rd::GrantMatchesAuthorityChallenge(grant, challenge, &error));
    assert(error == "grant_audit_session_mismatch");
  }
  {  // A grant that would outlive the promise it was made under.
    rd::VirtualDisplayGrant grant = Grant();
    grant.ttl_ms = challenge.ttl_ms + 1;
    assert(!rd::GrantMatchesAuthorityChallenge(grant, challenge, &error));
    assert(error == "grant_outlives_challenge");
  }
  {  // Expiring EARLIER is fine: a shorter authority is not a wider one.
    rd::VirtualDisplayGrant grant = Grant();
    grant.ttl_ms = challenge.ttl_ms - 1;
    assert(rd::GrantMatchesAuthorityChallenge(grant, challenge, &error));
  }
  {  // No link, no admission.
    assert(!rd::GrantMatchesAuthorityChallenge(
        Grant(), rd::VirtualDisplayAuthorityChallenge(), &error));
    assert(error == "link_not_established");
  }
}

void TheChallengeWireIsCanonicalAndClosed() {
  const std::string line =
      rd::SerializeVirtualDisplayAuthorityChallenge(Challenge());
  assert(!line.empty());
  rd::VirtualDisplayAuthorityChallenge parsed;
  std::string error;
  assert(rd::ParseVirtualDisplayAuthorityChallenge(line, &parsed, &error));
  assert(rd::SerializeVirtualDisplayAuthorityChallenge(parsed) == line);

  // Reordered keys are a second line naming one challenge.
  assert(!rd::ParseVirtualDisplayAuthorityChallenge(
      "chal1 svcgen=7 challenge=" + std::string(43, 'A') +
          " asid=100003 ttl=60000",
      &parsed, &error));
  assert(error == "challenge_not_canonical");

  assert(!rd::ParseVirtualDisplayAuthorityChallenge(line + " future=1", &parsed,
                                                    &error));
  assert(error == "challenge_unknown_key");
  assert(!rd::ParseVirtualDisplayAuthorityChallenge(line + " stray", &parsed,
                                                    &error));
  assert(error == "challenge_token_unstructured");
  // At most one terminator, as everywhere else on these wires.
  for (const char* suffix : {"", "\n", "\r", "\r\n"}) {
    assert(rd::ParseVirtualDisplayAuthorityChallenge(line + suffix, &parsed,
                                                     &error));
  }
  assert(!rd::ParseVirtualDisplayAuthorityChallenge(line + "\n\n", &parsed,
                                                    &error));
}

// A link that cannot dial must not read as "no daemon right now" in a way that
// leaves a descriptor behind.
void AnUnreachableRendezvousLeaksNothing() {
  FakeDaemon daemon;
  daemon.dial_ok = false;
  rd::MacosVirtualDisplayAuthorityLink link(daemon.Seam());
  std::string error;
  assert(!link.Establish(kPath, &error));
  assert(error == "rendezvous_unreachable");
  assert(daemon.open_descriptors == 0);
}

}  // namespace

int main() {
  TheRealChainIsTrusted();
  ANonRootComponentAnywhereIsRefused();
  AWritableDirectoryAnywhereIsRefused();
  SocketReachabilityIsNamedNotSilent();
  ASymlinkAnywhereIsRefused();
  ShapeFailuresAreDistinct();
  ANonRootPeerIsRefusedEvenOnAPerfectPath();
  ASocketReplacedBetweenCheckAndConnectIsRefused();
  TheHappyPathEstablishesAndBinds();
  DaemonEofIsTerminal();
  TheLinkHandsUpEveryFrameUnclassified();
  ARefusedChallengeLeavesNothingEstablished();
  AGrantMustMatchTheChallengeItWasPromisedUnder();
  TheChallengeWireIsCanonicalAndClosed();
  AnUnreachableRendezvousLeaksNothing();
  std::printf("macos virtual display authority-link counterfactual ok\n");
  return 0;
}
