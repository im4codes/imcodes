// End-to-end composition: the whole chain, with only the OS faked.
//
//   session  ->  MacosVirtualDisplayBackend (route proxy)
//             ->  control wire
//             ->  MacosVirtualDisplayControlServer
//             ->  MacosVirtualDisplayAgent  +  helper backend
//             ->  helper wire
//
// Every layer here is the production type. The two fakes are the OS seams
// (peer credentials, clock) and the helper process itself, because those are
// the only things a test cannot have. In particular the CONTROL WIRE is real:
// the proxy serialises, the server parses, and if the two grammars disagreed
// about anything this file would stop compiling into a working chain.
//
// What this exists to prove is the property no single layer can prove alone:
// that a route drives a display it never owns, using a credential it cannot
// forge, and that finishing a route leaves the display alive for the next one.

#include "macos_virtual_display_route_backend.h"

#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

#include "macos_virtual_display_control_server.h"
#include "macos_virtual_display_helper_binding.h"

namespace rd = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

const std::string kRequirement = rd::CanonicalDesignatedRequirement(
    "cc.imcodes.node.virtual-display-helper", "ABCDE12345");

constexpr std::uint64_t kHelperEpoch = 0xA11CE0DEBEEFF00DULL;
constexpr std::uint64_t kHelperSeed = 0x5EED5EED5EED5EEDULL;
constexpr std::uint64_t kHelperGeneration = 99;

/** The challenge the authenticated link minted, as the agent holds it. */
rd::VirtualDisplayAuthorityChallenge LinkChallenge(
    const std::string& secret = std::string(43, 'A')) {
  rd::VirtualDisplayAuthorityChallenge challenge;
  challenge.challenge = secret;
  challenge.service_generation = 7;
  challenge.audit_session_id = 100003;
  challenge.ttl_ms = 60'000;
  // Formed the way the link forms it: receipt instant on the local
  // monotonic clock, plus the TTL. Fixtures clock at 1'000'000.
  challenge.deadline_ms = 1'000'000 + challenge.ttl_ms;
  return challenge;
}

rd::VirtualDisplayGrant Grant(const std::string& challenge = std::string(43, 'A')) {
  rd::VirtualDisplayGrant grant;
  grant.uid = 501;
  grant.audit_session_id = 100003;
  grant.session_type = "Aqua";
  grant.service_generation = 7;
  grant.challenge = challenge;
  grant.ttl_ms = 60'000;
  grant.set_sha256 = std::string(64, 'd');
  grant.release_identity = "sha256-" + grant.set_sha256;
  grant.helper_file_name = "imcodes-virtual-display-helper";
  grant.helper_sha256 = std::string(64, 'e');
  grant.helper_size = 4096;
  grant.helper_designated_requirement = kRequirement;
  grant.helper_bundle_identifier = "cc.imcodes.node.virtual-display-helper";
  grant.team_id = "ABCDE12345";
  grant.arch = "arm64";
  return grant;
}

rd::MacosVirtualDisplayConfiguration Configuration() {
  // The shipped defaults, so the fixture cannot drift into a configuration
  // production never uses.
  rd::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 7;
  return configuration;
}

rd::MacosVirtualDisplayMode Mode() {
  rd::MacosVirtualDisplayMode mode;
  mode.pixels = common::PixelSize{1920, 1080};
  mode.refresh_rate_hz = 60.0;
  mode.scale = 2.0;
  return mode;
}

/** Stands in for the helper process. Records every frame that reached it. */
struct HelperProcess {
  std::vector<rd::VirtualDisplayHelperCommand> seen;
  std::uint32_t held_display_id = 0;
  std::string presence = "absent";
  bool answering = true;

  rd::VirtualDisplayHelperExchange Exchange() {
    return [this](const std::string& request_line, std::string* reply_line,
                  std::uint32_t) {
      rd::VirtualDisplayHelperCommand command;
      assert(rd::ParseVirtualDisplayHelperCommand(request_line, &command));
      seen.push_back(command);
      if (!answering) return false;
      rd::VirtualDisplayHelperReply reply;
      reply.ok = true;
      reply.generation = command.generation;
      reply.cookie = command.cookie;
      reply.admitted = true;
      switch (command.verb) {
        case rd::VirtualDisplayHelperVerb::kHold:
          if (held_display_id == 0) held_display_id = 42;
          if (presence == "absent") presence = "inactive";
          break;
        case rd::VirtualDisplayHelperVerb::kEnable:
          presence = "active";
          break;
        case rd::VirtualDisplayHelperVerb::kDisable:
          presence = "inactive";
          break;
        case rd::VirtualDisplayHelperVerb::kRelease:
          held_display_id = 0;
          presence = "absent";
          break;
        case rd::VirtualDisplayHelperVerb::kStatus:
        case rd::VirtualDisplayHelperVerb::kInvalid:
          break;
      }
      reply.display_id = held_display_id;
      reply.presence = presence;
      *reply_line = rd::SerializeVirtualDisplayHelperReply(reply);
      return !reply_line->empty();
    };
  }

  [[nodiscard]] std::uint32_t Count(rd::VirtualDisplayHelperVerb verb) const {
    std::uint32_t total = 0;
    for (const auto& command : seen)
      if (command.verb == verb) ++total;
    return total;
  }
};

struct Chain {
  HelperProcess helper_process;
  /** The ROOT daemon: the one and only inbound peer. */
  rd::ControlPeerIdentity daemon{0, 4242, true};
  rd::AgentSessionContext session{501, 100003, "Aqua", 7};
  rd::SocketIdentity socket{16, 900};
  std::uint64_t clock_ms = 1'000'000;
  bool helper_alive = true;
  bool active_display = false;
  /** True while the control socket is reachable at all. */
  bool agent_reachable = true;

  rd::MacosVirtualDisplayAgent agent;
  rd::MacosVirtualDisplayHelperBackend helper;
  rd::MacosVirtualDisplayControlServer server;

  Chain()
      : agent(AgentSeam(), [](rd::AgentRevocation) {}),
        helper(HelperOptions(), helper_process.Exchange()),
        server(&agent, ServerSeam()) {}

  static rd::MacosVirtualDisplayHelperOptions HelperOptions() {
    rd::MacosVirtualDisplayHelperOptions options;
    options.binding.epoch = kHelperEpoch;
    options.binding.cookie_seed = kHelperSeed;
    options.binding.uid = 501;
    options.binding.generation = kHelperGeneration;
    options.binding.release_identity = "sha256-" + std::string(64, 'd');
    return options;
  }

  rd::AgentSeam AgentSeam() {
    rd::AgentSeam seam;
    seam.daemon_identity = [this] { return daemon; };
    seam.observe_session = [this] { return session; };
    seam.socket_identity = [this] { return socket; };
    seam.now_ms = [this] { return clock_ms; };
    seam.start_helper = [](const rd::VirtualDisplayGrant&, std::string*) {
      return true;
    };
    seam.helper_alive = [this] { return helper_alive; };
    seam.stop_helper = [] {};
    seam.helper_holds_active_display = [this] { return active_display; };
    return seam;
  }

  rd::ControlServerSeam ServerSeam() {
    rd::ControlServerSeam seam;
    seam.daemon_identity = [this] { return daemon; };
    seam.authority_challenge = [] { return LinkChallenge(); };
    seam.now_ms = [this] { return clock_ms; };
    return seam;
  }

  /**
   * The worker's path to the agent, as it actually is in production.
   *
   * The worker does NOT speak to the agent. It speaks to the daemon over the
   * existing authenticated Node IPC, and the daemon proxies the semantic
   * request onto its one authenticated link. That indirection is modelled here
   * rather than shortcut, because "the worker can reach the agent" is precisely
   * the property the design forbids.
   */
  rd::VirtualDisplayControlExchange WorkerExchangeViaDaemon() {
    return [this](const std::string& request_line, std::string* reply_line,
                  std::uint32_t) {
      if (!agent_reachable) return false;  // the daemon's link is down
      *reply_line = server.Handle(request_line);
      return !reply_line->empty();
    };
  }

  void Establish() {
    const std::string grant = rd::SerializeVirtualDisplayGrant(Grant());
    const std::string answered = server.Handle(grant);
    rd::VirtualDisplayControlReply reply;
    std::string error;
    assert(rd::ParseVirtualDisplayControlReply(answered, &reply, &error));
    assert(reply.ok);
    server.BindHelper(&helper);
  }

  rd::MacosVirtualDisplayRouteBackend MakeRoute(std::uint64_t generation) {
    rd::MacosVirtualDisplayRouteOptions options;
    options.route_generation = generation;
    return rd::MacosVirtualDisplayRouteBackend(options, WorkerExchangeViaDaemon());
  }
};

// ---------------------------------------------------------------------------

// The ordinary path, driven entirely through the interface the session uses.
void ARouteDrivesADisplayItNeverOwns() {
  Chain chain;
  chain.Establish();
  rd::MacosVirtualDisplayRouteBackend route = chain.MakeRoute(7);

  // No capability is taken until one is needed: a worker that never uses a
  // display must not occupy a slot in the agent's bounded route table.
  assert(!route.has_capability());

  assert(route.ProbeSupport() == common::ReadinessState::kReady);
  assert(route.has_capability());

  std::uint32_t display_id = 0;
  std::string error;
  assert(route.Create(Configuration(), &display_id, &error));
  assert(display_id == 42);

  assert(route.ApplyMode(display_id, Mode(), {}, &error));
  assert(route.WaitUntilOnline(display_id, 1'000, &error));

  // The mode really arrived at the helper, in exact units.
  bool saw_mode = false;
  for (const auto& command : chain.helper_process.seen) {
    if (command.verb != rd::VirtualDisplayHelperVerb::kEnable) continue;
    saw_mode = true;
    assert(command.pixels_wide == 1920);
    assert(command.pixels_high == 1080);
    assert(command.refresh_millihertz == 60'000);
    assert(command.scale_percent == 200);
  }
  assert(saw_mode);

  // And every frame the helper saw carried the HELPER credentials, which this
  // route never possessed.
  for (const auto& command : chain.helper_process.seen) {
    assert(command.epoch == kHelperEpoch);
    assert(command.generation == kHelperGeneration);
    assert(command.cookie ==
           rd::DeriveHelperCookie(kHelperSeed, command.request_index));
  }
}

// The defect this whole architecture exists to fix: a finished route must not
// take the display with it.
void FinishingARouteLeavesTheDisplayWarm() {
  Chain chain;
  chain.Establish();

  std::uint32_t first_id = 0;
  std::string error;
  {
    rd::MacosVirtualDisplayRouteBackend route = chain.MakeRoute(7);
    assert(route.Create(Configuration(), &first_id, &error));
    assert(route.ApplyMode(first_id, Mode(), {}, &error));
    assert(chain.helper_process.presence == "active");
    route.Destroy();
  }

  // No release ever reached the helper, and the display is still held.
  assert(chain.helper_process.Count(rd::VirtualDisplayHelperVerb::kRelease) == 0);
  assert(chain.helper_process.held_display_id == 42);
  // Registered and warm, not active: the route that was using it has gone.
  assert(chain.helper_process.presence == "inactive");

  // The NEXT route gets the same warm display back, without a fresh create on
  // an OS where release-to-remove does not reliably remove.
  const std::uint32_t holds_before =
      chain.helper_process.Count(rd::VirtualDisplayHelperVerb::kHold);
  rd::MacosVirtualDisplayRouteBackend second = chain.MakeRoute(8);
  std::uint32_t second_id = 0;
  assert(second.Create(Configuration(), &second_id, &error));
  assert(second_id == first_id);
  assert(second.ApplyMode(second_id, Mode(), {}, &error));
  assert(chain.helper_process.presence == "active");
  // A hold was still sent -- it is how the id is learned -- but it found the
  // existing display rather than creating a second one.
  assert(chain.helper_process.Count(rd::VirtualDisplayHelperVerb::kHold) ==
         holds_before + 1);
  assert(chain.helper_process.held_display_id == 42);
}

// A route cannot mint its own authority, and cannot reuse another's.
void ARouteCannotForgeOrBorrowACredential() {
  Chain chain;
  chain.Establish();

  rd::MacosVirtualDisplayRouteBackend seven = chain.MakeRoute(7);
  std::uint32_t display_id = 0;
  std::string error;
  assert(seven.Create(Configuration(), &display_id, &error));

  // A second route with its own generation gets its OWN seed, so a frame
  // captured from one cannot be replayed into the other.
  rd::MacosVirtualDisplayRouteBackend eight = chain.MakeRoute(8);
  assert(eight.Create(Configuration(), &display_id, &error));

  // Replaying route 7's exact first relay frame is refused: its index is no
  // longer above the agent's floor for that generation.
  rd::VirtualDisplayControlRequest replay;
  replay.verb = rd::VirtualDisplayControlVerb::kRelay;
  replay.route_generation = 7;
  replay.route_epoch = chain.agent.epoch();
  replay.request_index = 1;
  replay.route_cookie = 1;  // not derivable; a guess
  replay.helper_verb = rd::VirtualDisplayHelperVerb::kStatus;
  const std::string line = rd::SerializeVirtualDisplayControlRequest(replay);
  assert(!line.empty());
  rd::VirtualDisplayControlReply refused;
  std::string parse_error;
  assert(rd::ParseVirtualDisplayControlReply(
      chain.server.Handle(line), &refused, &parse_error));
  assert(!refused.ok);
}

// Losing the agent fails the route closed. It must never silently re-acquire
// against a display the peer was never told about.
void LosingTheAgentFailsTheRouteClosed() {
  Chain chain;
  chain.Establish();
  rd::MacosVirtualDisplayRouteBackend route = chain.MakeRoute(7);

  std::uint32_t display_id = 0;
  std::string error;
  assert(route.Create(Configuration(), &display_id, &error));

  chain.agent_reachable = false;
  // Bounded: a dead agent latches after a few unanswered round trips rather
  // than making every later call pay the full timeout.
  for (int attempt = 0; attempt < 8; ++attempt) {
    assert(!route.ApplyMode(display_id, Mode(), {}, &error));
  }
  assert(route.ProbeSupport() == common::ReadinessState::kUnavailable);

  // Even once the socket comes back, the latched backend stays failed: this
  // route's view of the world is stale and it must be rebuilt, not resumed.
  chain.agent_reachable = true;
  assert(!route.ApplyMode(display_id, Mode(), {}, &error));

  // A freshly built route recovers, which is what makes the latch a policy
  // rather than a dead end.
  rd::MacosVirtualDisplayRouteBackend rebuilt = chain.MakeRoute(9);
  std::uint32_t rebuilt_id = 0;
  assert(rebuilt.Create(Configuration(), &rebuilt_id, &error));
  assert(rebuilt_id == 42);
}

// An agent that answers with something other than the agent's grammar is not a
// soft failure: something else is on that socket.
void AnUnintelligibleAnswerIsTerminal() {
  Chain chain;
  chain.Establish();
  rd::MacosVirtualDisplayRouteOptions options;
  options.route_generation = 7;
  rd::MacosVirtualDisplayRouteBackend route(
      options, [](const std::string&, std::string* reply, std::uint32_t) {
        *reply = "ok sure whatever";
        return true;
      });
  std::string error;
  std::uint32_t display_id = 0;
  assert(!route.Create(Configuration(), &display_id, &error));
  // Latched on the FIRST such answer, not after a retry budget.
  assert(route.ProbeSupport() == common::ReadinessState::kUnavailable);
  assert(!route.has_capability());
}

// A route that never obtained a display must not send anything on teardown.
void DestroyWithoutACreateIsSilent() {
  Chain chain;
  chain.Establish();
  rd::MacosVirtualDisplayRouteBackend route = chain.MakeRoute(7);
  route.Destroy();
  assert(chain.helper_process.seen.empty());
  assert(chain.server.route_count() == 0);
}

// Readiness is answerable through the same socket, without a capability and
// without touching anything.
void ReadinessCrossesTheSameSocketAndMutatesNothing() {
  Chain chain;
  chain.Establish();

  rd::VirtualDisplayControlRequest ready;
  ready.verb = rd::VirtualDisplayControlVerb::kReady;
  ready.nonce = 0xFEEDBEEFULL;
  const std::string line = rd::SerializeVirtualDisplayControlRequest(ready);

  rd::VirtualDisplayControlReply reply;
  std::string error;
  assert(rd::ParseVirtualDisplayControlReply(
      chain.server.Handle(line), &reply, &error));
  assert(reply.ok);
  assert(reply.nonce == ready.nonce);
  assert(reply.qualified_to_create);
  assert(!reply.display_control_admitted);
  // Nothing reached the helper, and no route was issued.
  assert(chain.helper_process.seen.empty());
  assert(chain.server.route_count() == 0);

  // The strict question turns true only when a display really is held and
  // active -- and asking still costs nothing.
  chain.active_display = true;
  assert(rd::ParseVirtualDisplayControlReply(
      chain.server.Handle(line), &reply, &error));
  assert(reply.display_control_admitted);
  assert(chain.helper_process.seen.empty());
}

}  // namespace

int main() {
  ARouteDrivesADisplayItNeverOwns();
  FinishingARouteLeavesTheDisplayWarm();
  ARouteCannotForgeOrBorrowACredential();
  LosingTheAgentFailsTheRouteClosed();
  AnUnintelligibleAnswerIsTerminal();
  DestroyWithoutACreateIsSilent();
  ReadinessCrossesTheSameSocketAndMutatesNothing();
  std::printf("macos virtual display route counterfactual ok\n");
  return 0;
}
