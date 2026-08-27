// Lifetime counterexamples for the resident agent's run loop.
//
// This is the code that would otherwise live inside main(), where nothing can
// reach it. Every rule here is about WHEN authority ends, and each one has a
// failure mode that leaves either a display nobody is authorised to control or
// a display nobody is watching.

#include "macos_virtual_display_resident_loop.h"

#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;

namespace {

constexpr char kPath[] =
    "/private/var/db/imcodes-node/runtime/virtual-display-authority.sock";

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

/** The whole outside world: filesystem, daemon, worker and helper. */
struct World {
  // --- rendezvous, as the link sees it ---
  std::vector<std::string> daemon_lines;
  std::size_t next_line = 0;
  std::uint64_t clock_ms = 1'000'000;
  bool daemon_reads = true;

  // --- worker ---
  bool worker_running = true;
  std::uint32_t worker_stops = 0;

  // --- signals ---
  bool stop_signalled = false;

  // --- agent session / helper ---
  rd::ControlPeerIdentity daemon{0, 4242, true};
  rd::AgentSessionContext session{501, 100003, "Aqua", 7};
  rd::SocketIdentity socket{16, 900};
  bool helper_running = false;
  bool active_display = false;
  std::uint32_t spawns = 0;
  std::uint32_t open_descriptors = 0;

  /** Everything the daemon was told. */
  std::vector<std::string> replies;

  World() {
    daemon_lines.push_back(
        rd::SerializeVirtualDisplayAuthorityChallenge(Challenge()));
  }

  rd::AuthorityLinkSeam LinkSeam() {
    rd::AuthorityLinkSeam seam;
    seam.inspect = [](const std::string& path, rd::PathNodeFacts* out) {
      // A clean chain: root-owned 0711 directories down to a root-owned 0622
      // socket. The rendezvous RULES have their own suite; this one is about
      // what happens after the link is up, so the chain here is simply healthy.
      *out = rd::PathNodeFacts();
      out->exists = true;
      out->uid = 0;
      out->gid = 0;
      out->device = 1;
      out->inode = 42;
      if (path == kPath) {
        out->is_socket = true;
        out->mode = rd::kVirtualDisplayAuthoritySocketMode;
      } else {
        out->is_directory = true;
        out->mode = rd::kVirtualDisplayAuthorityDirectoryMode;
      }
      return true;
    };
    seam.dialling_uid = [] { return 501U; };
    seam.dialling_gid = [] { return 20U; };
    seam.dial = [](const std::string&) { return 7; };
    seam.peer_euid = [](int) { return 0U; };
    seam.read_line = [this](int, std::string* line) {
      if (next_line >= daemon_lines.size()) return false;  // EOF
      *line = daemon_lines[next_line++];
      return true;
    };
    seam.close_fd = [](int) {};
    seam.now_ms = [this] { return clock_ms; };
    return seam;
  }

  rd::ResidentOwnerSeam OwnerSeam() {
    rd::ResidentOwnerSeam seam;
    seam.daemon_identity = [this] { return daemon; };
    seam.authority_challenge = [] { return Challenge(); };
    seam.observe_session = [this] { return session; };
    seam.socket_identity = [this] { return socket; };
    seam.now_ms = [this] { return clock_ms; };
    // No seam for this: the owner asks the supervised helper directly, so a
    // caller cannot substitute a constant for it.
    return seam;
  }

  rd::SupervisorSeam Supervisor() {
    rd::SupervisorSeam seam;
    seam.effective_uid = [] { return 501U; };
    seam.resolve_verified_helper = [](const std::string&, const std::string&,
                                      const std::string&, std::string* path,
                                      std::string*) {
      *path = "/verified/imcodes-virtual-display-helper";
      return true;
    };
    seam.random_u64 = [this] {
      clock_ms += 1;  // any monotonic source; values need only be unpredictable
      return 0x9E3779B97F4A7C15ULL ^ (clock_ms * 0xBF58476D1CE4E5B9ULL);
    };
    seam.spawn_helper = [this](const std::string&,
                               const rd::VirtualDisplayHelperBinding&,
                               rd::SupervisedHelper* helper, std::string*) {
      ++spawns;
      helper->pid = 4321;
      helper->binding_write_fd = 30;
      helper->control_fd = 31;
      open_descriptors += 2;
      helper_running = true;
      return true;
    };
    seam.await_ready = [](const rd::SupervisedHelper&, std::uint32_t) {
      return true;
    };
    seam.still_running = [this](std::int32_t) { return helper_running; };
    seam.terminate_and_reap = [this](std::int32_t, std::uint32_t) {
      helper_running = false;
    };
    seam.close_fd = [this](int) { --open_descriptors; };
    seam.now_ms = [this] { return clock_ms; };
    return seam;
  }

  rd::ResidentLoopSeam LoopSeam() {
    rd::ResidentLoopSeam seam;
    seam.wait_readable = [](int, std::uint32_t) {
      // Faithful to poll(2). A socket whose peer has CLOSED is readable --
      // POLLHUP -- and the read that follows returns 0. Modelling exhaustion
      // as "never readable" would make a closed daemon indistinguishable from
      // a quiet one, and the loop would wait forever for a peer that is
      // already gone.
      //
      // This fake exhausts its script and then behaves as closed, which is what
      // the daemon does at the end of its lease.
      return true;
    };
    seam.worker_alive = [this] { return worker_running; };
    seam.write_line = [this](int, const std::string& line) {
      if (!daemon_reads) return false;
      replies.push_back(line);
      return true;
    };
    seam.stop_worker = [this] {
      ++worker_stops;
      worker_running = false;
    };
    seam.stop_requested = [this] { return stop_signalled; };
    return seam;
  }
};

/** Establishes the link and runs the loop, returning the outcome. */
rd::ResidentLoopOutcome Run(World& world, std::uint64_t max_frames = 64) {
  rd::MacosVirtualDisplayAuthorityLink link(world.LinkSeam());
  std::string error;
  assert(link.Establish(kPath, &error));
  rd::MacosVirtualDisplayResidentOwner owner(
      rd::SupervisorPolicy{}, world.Supervisor(), world.OwnerSeam());
  rd::ResidentLoopOptions options;
  options.max_frames = max_frames;
  return rd::RunResidentLoop(&owner, &link, options, world.LoopSeam());
}

// ---------------------------------------------------------------------------

// The authority's lifetime IS the daemon connection's lifetime.
void DaemonEofEndsTheLoopAndTearsEverythingDown() {
  World world;
  world.daemon_lines.push_back(rd::SerializeVirtualDisplayGrant(Grant()));

  const rd::ResidentLoopOutcome outcome = Run(world);
  assert(outcome == rd::ResidentLoopOutcome::kDaemonGone);
  // The grant was served before the link closed...
  assert(world.spawns == 1);
  assert(world.replies.size() == 1);
  // ...and nothing survives the close.
  assert(!world.helper_running);
  assert(world.open_descriptors == 0);
  assert(world.worker_stops == 1);
  assert(!world.worker_running);
}

// A daemon that stops READING is the same event as one that closed: authority
// is over either way, and continuing would mean holding a display for a peer
// that can no longer be told anything.
void ADaemonThatStopsReadingIsTreatedAsGone() {
  World world;
  world.daemon_lines.push_back(rd::SerializeVirtualDisplayGrant(Grant()));
  world.daemon_reads = false;

  const rd::ResidentLoopOutcome outcome = Run(world);
  assert(outcome == rd::ResidentLoopOutcome::kDaemonGone);
  assert(!world.helper_running);
  assert(world.open_descriptors == 0);
}

// The agent exists to serve a console session. When that session's worker is
// gone there is nothing left to own a display for.
void AWorkerExitEndsTheLoop() {
  World world;
  world.worker_running = false;
  const rd::ResidentLoopOutcome outcome = Run(world);
  assert(outcome == rd::ResidentLoopOutcome::kWorkerExited);
  // Checked BEFORE serving: no frame is answered on behalf of a session that
  // has already ended.
  assert(world.replies.empty());
  assert(world.spawns == 0);
  assert(world.open_descriptors == 0);
}

void AStopSignalEndsTheLoopCleanly() {
  World world;
  world.stop_signalled = true;
  const rd::ResidentLoopOutcome outcome = Run(world);
  assert(outcome == rd::ResidentLoopOutcome::kStopRequested);
  assert(world.replies.empty());
  assert(world.worker_stops == 1);
  assert(world.open_descriptors == 0);
}

// NOTHING ELSE ends it. A refused frame, a malformed request, an unknown
// prefix: each is answered and survived. One bad frame must not become a lost
// display.
void BadFramesAreAnsweredAndSurvived() {
  World world;
  world.daemon_lines.push_back("total nonsense");
  world.daemon_lines.push_back("ctl1 verb=relay rgen=1");
  world.daemon_lines.push_back("");
  world.daemon_lines.push_back(rd::SerializeVirtualDisplayGrant(Grant()));
  // A readiness question, proxied by the daemon on behalf of a worker.
  rd::VirtualDisplayControlRequest ready;
  ready.verb = rd::VirtualDisplayControlVerb::kReady;
  ready.nonce = 99;
  world.daemon_lines.push_back(
      rd::SerializeVirtualDisplayControlRequest(ready));

  const rd::ResidentLoopOutcome outcome = Run(world);
  assert(outcome == rd::ResidentLoopOutcome::kDaemonGone);

  // Every frame got an answer, including the three bad ones.
  assert(world.replies.size() == 5);
  for (const std::string& reply : world.replies) {
    rd::VirtualDisplayControlReply parsed;
    std::string error;
    assert(rd::ParseVirtualDisplayControlReply(reply, &parsed, &error));
  }
  // The grant still took effect despite arriving after three bad frames.
  assert(world.spawns == 1);
  // And the readiness answer echoed its nonce, so it cannot be replayed as a
  // fresh one.
  rd::VirtualDisplayControlReply last;
  std::string error;
  assert(rd::ParseVirtualDisplayControlReply(world.replies.back(), &last, &error));
  assert(last.ok && last.nonce == 99);
}

// The loop must re-poll even when the link is quiet, or it would keep
// advertising a display long after the thing holding it died.
void AQuietLinkStillNoticesALostHelper() {
  World world;
  world.daemon_lines.push_back(rd::SerializeVirtualDisplayGrant(Grant()));

  rd::MacosVirtualDisplayAuthorityLink link(world.LinkSeam());
  std::string error;
  assert(link.Establish(kPath, &error));
  rd::MacosVirtualDisplayResidentOwner owner(
      rd::SupervisorPolicy{}, world.Supervisor(), world.OwnerSeam());

  rd::ResidentLoopOptions options;
  options.max_frames = 1;  // stop right after the grant is served
  assert(rd::RunResidentLoop(&owner, &link, options, world.LoopSeam()) ==
         rd::ResidentLoopOutcome::kStopRequested);
  assert(world.spawns == 1);
  // Even on the bounded run, teardown happened on the way out.
  assert(!world.helper_running);
  assert(world.open_descriptors == 0);
}

// A loop that is not fully wired must serve nothing at all, rather than serving
// the parts it happens to have.
void AnIncompleteLoopServesNothing() {
  World world;
  rd::MacosVirtualDisplayAuthorityLink link(world.LinkSeam());
  std::string error;
  assert(link.Establish(kPath, &error));
  rd::MacosVirtualDisplayResidentOwner owner(
      rd::SupervisorPolicy{}, world.Supervisor(), world.OwnerSeam());

  rd::ResidentLoopSeam partial = world.LoopSeam();
  partial.worker_alive = nullptr;
  assert(rd::RunResidentLoop(&owner, &link, rd::ResidentLoopOptions{}, partial) ==
         rd::ResidentLoopOutcome::kNotWired);
  assert(world.replies.empty());
  assert(world.spawns == 0);

  assert(rd::RunResidentLoop(nullptr, &link, rd::ResidentLoopOptions{},
                             world.LoopSeam()) ==
         rd::ResidentLoopOutcome::kNotWired);
  assert(rd::RunResidentLoop(&owner, nullptr, rd::ResidentLoopOptions{},
                             world.LoopSeam()) ==
         rd::ResidentLoopOutcome::kNotWired);
}

}  // namespace

int main() {
  DaemonEofEndsTheLoopAndTearsEverythingDown();
  ADaemonThatStopsReadingIsTreatedAsGone();
  AWorkerExitEndsTheLoop();
  AStopSignalEndsTheLoopCleanly();
  BadFramesAreAnsweredAndSurvived();
  AQuietLinkStillNoticesALostHelper();
  AnIncompleteLoopServesNothing();
  std::printf("macos virtual display loop counterfactual ok\n");
  return 0;
}
