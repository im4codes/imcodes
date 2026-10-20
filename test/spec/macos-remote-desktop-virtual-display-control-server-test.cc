// Production-composition counterexamples for the control-socket dispatch.
//
// This drives the REAL agent state machine, the REAL helper backend and the
// REAL wire grammar, wired together the way the resident LaunchAgent wires
// them. The only fakes are the OS seams -- peer credentials, the clock, and the
// socket the helper is on -- because those are the things a test cannot have.
//
// A mock agent would have proven that the server calls some methods. What has
// to be proven is that a hostile or confused peer cannot get a display action
// out of this composition, and that only holds if the real rules are running.

#include "macos_virtual_display_control_server.h"

#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

#include "macos_virtual_display_helper_binding.h"

namespace rd = imcodes::remote_desktop::macos;

namespace {

const std::string kRequirement = rd::CanonicalDesignatedRequirement(
    "cc.imcodes.node.virtual-display-helper", "ABCDE12345");

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

/** The helper's own launch binding. The route must never see any of this. */
constexpr std::uint64_t kHelperEpoch = 0xA11CE0DEBEEFF00DULL;
constexpr std::uint64_t kHelperSeed = 0x5EED5EED5EED5EEDULL;
constexpr std::uint64_t kHelperGeneration = 99;

/** Records every frame that actually reached the helper. */
struct HelperWire {
  std::vector<rd::VirtualDisplayHelperCommand> seen;
  std::uint32_t held_display_id = 0;
  std::string presence = "absent";
  bool answer = true;
  bool admitted = true;

  rd::VirtualDisplayHelperExchange Exchange() {
    return [this](const std::string& request_line, std::string* reply_line,
                  std::uint32_t) {
      rd::VirtualDisplayHelperCommand command;
      // Parsed with the real grammar: a test that accepted a line the helper
      // would reject would be proving something about a wire nobody speaks.
      assert(rd::ParseVirtualDisplayHelperCommand(request_line, &command));
      seen.push_back(command);
      if (!answer) return false;

      rd::VirtualDisplayHelperReply reply;
      reply.ok = true;
      reply.generation = command.generation;
      reply.cookie = command.cookie;
      reply.admitted = admitted;
      switch (command.verb) {
        case rd::VirtualDisplayHelperVerb::kHold:
          held_display_id = 42;
          presence = "inactive";
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
};

struct FakeOs {
  /** The ROOT daemon. There is no other peer: the agent binds nothing. */
  rd::ControlPeerIdentity daemon{0, 4242, true};
  /** The secret the current link minted. Moves when the link is re-established. */
  std::string link_secret = std::string(43, 'A');
  rd::AgentSessionContext session{501, 100003, "Aqua", 7};
  rd::SocketIdentity socket{16, 900};
  std::uint64_t clock_ms = 1'000'000;
  bool helper_started = false;
  bool alive = true;
  bool active_display = false;
  /** Anything a readiness probe must NEVER cause. */
  std::uint32_t mutations = 0;

  rd::AgentSeam AgentSeam() {
    rd::AgentSeam seam;
    seam.daemon_identity = [this] { return daemon; };
    seam.observe_session = [this] { return session; };
    seam.socket_identity = [this] { return socket; };
    seam.now_ms = [this] { return clock_ms; };
    seam.start_helper = [this](const rd::VirtualDisplayGrant&, std::string*) {
      helper_started = true;
      ++mutations;
      return true;
    };
    seam.helper_alive = [this] { return alive; };
    seam.stop_helper = [this] { ++mutations; };
    seam.helper_holds_active_display = [this] { return active_display; };
    return seam;
  }

  rd::ControlServerSeam ServerSeam() {
    rd::ControlServerSeam seam;
    seam.daemon_identity = [this] { return daemon; };
    // The challenge the link minted for THIS connection. A second grant needs
    // a second connection, so the fixture moves both together -- exactly as a
    // reconnecting daemon would.
    seam.authority_challenge = [this] { return LinkChallenge(link_secret); };
    seam.now_ms = [this] { return clock_ms; };
    return seam;
  }
};

/** The whole production composition, assembled once. */
struct Composition {
  FakeOs os;
  HelperWire wire;
  std::vector<rd::AgentRevocation> revocations;
  rd::MacosVirtualDisplayAgent agent;
  rd::MacosVirtualDisplayHelperBackend helper;
  rd::MacosVirtualDisplayControlServer server;

  Composition()
      : agent(os.AgentSeam(),
              [this](rd::AgentRevocation reason) {
                revocations.push_back(reason);
              }),
        helper(HelperOptions(), wire.Exchange()),
        server(&agent, os.ServerSeam()) {}

  static rd::MacosVirtualDisplayHelperOptions HelperOptions() {
    rd::MacosVirtualDisplayHelperOptions options;
    options.binding.epoch = kHelperEpoch;
    options.binding.cookie_seed = kHelperSeed;
    options.binding.uid = 501;
    options.binding.generation = kHelperGeneration;
    options.binding.release_identity = "sha256-" + std::string(64, 'd');
    return options;
  }

  std::string Send(const std::string& line) {
    return server.Handle(line);
  }

  rd::VirtualDisplayControlReply Ask(const std::string& line) {
    rd::VirtualDisplayControlReply reply;
    std::string error;
    const std::string answered = Send(line);
    // Never empty: a peer that gets no answer cannot tell a refusal from a
    // hang, and every reply must survive its own parser.
    assert(!answered.empty());
    assert(rd::ParseVirtualDisplayControlReply(answered, &reply, &error));
    return reply;
  }

  /** Brings the composition to "daemon granted, helper owned". */
  void Establish() {
    const std::string grant = rd::SerializeVirtualDisplayGrant(Grant());
    assert(!grant.empty());
    const rd::VirtualDisplayControlReply reply = Ask(grant);
    assert(reply.ok);
    server.BindHelper(&helper);
  }

  rd::VirtualDisplayControlReply Route(std::uint64_t generation) {
    rd::VirtualDisplayControlRequest request;
    request.verb = rd::VirtualDisplayControlVerb::kRoute;
    request.route_generation = generation;
    return Ask(rd::SerializeVirtualDisplayControlRequest(request));
  }

  rd::VirtualDisplayControlRequest RelayFrame(
      const rd::VirtualDisplayControlReply& route,
      rd::VirtualDisplayHelperVerb verb,
      std::uint64_t index) {
    rd::VirtualDisplayControlRequest request;
    request.verb = rd::VirtualDisplayControlVerb::kRelay;
    request.route_generation = route.route_generation;
    request.route_epoch = route.route_epoch;
    request.request_index = index;
    request.route_cookie = rd::DeriveHelperCookie(route.cookie_seed, index);
    request.helper_verb = verb;
    if (verb == rd::VirtualDisplayHelperVerb::kEnable) {
      request.display_id = 42;
      request.pixels_wide = 1920;
      request.pixels_high = 1080;
      request.refresh_millihertz = 60'000;
      request.scale_percent = 200;
    } else if (verb == rd::VirtualDisplayHelperVerb::kDisable) {
      request.display_id = 42;
    }
    return request;
  }
};

// ---------------------------------------------------------------------------

// There is no "is this the daemon" test any more, because there is no second
// entrance. What replaces it is stricter: an UNAUTHENTICATED link admits
// nothing at all -- not a grant, not a route, not even a readiness question --
// and the agent binds no socket, so a peer of any other kind has nowhere to
// arrive.
void AnUnauthenticatedLinkAdmitsNothing() {
  Composition composition;
  const std::string grant = rd::SerializeVirtualDisplayGrant(Grant());

  for (const rd::ControlPeerIdentity impostor : {
           rd::ControlPeerIdentity{},                  // default: not authenticated
           rd::ControlPeerIdentity{0, 4242, false},    // root, but link never proved it
           rd::ControlPeerIdentity{501, 4242, true},   // authenticated, but NOT root
           rd::ControlPeerIdentity{0, 0, true},        // no real process behind it
       }) {
    Composition hostile;
    hostile.os.daemon = impostor;
    assert(hostile.Ask(grant).error == "link_unauthenticated");
    assert(!hostile.os.helper_started);

    rd::VirtualDisplayControlRequest ready;
    ready.verb = rd::VirtualDisplayControlVerb::kReady;
    ready.nonce = 1;
    assert(hostile.Ask(rd::SerializeVirtualDisplayControlRequest(ready))
               .error == "link_unauthenticated");
    assert(hostile.Route(7).error == "link_unauthenticated");
  }

  // uid 0 is the CORRECT uid here, and the rule has to say so: an earlier
  // version of ControlPeerIdentity required uid != 0, which would have refused
  // the only peer this channel can ever have.
  assert((rd::ControlPeerIdentity{0, 4242, true}).IsValid());
  assert(!(rd::ControlPeerIdentity{501, 4242, true}).IsValid());

  const rd::VirtualDisplayControlReply from_daemon = composition.Ask(grant);
  assert(from_daemon.ok);
  assert(composition.os.helper_started);
}

// Readiness must be answerable without owning anything, and must never cause
// anything. A probe that could create stranded one display per invocation,
// permanently, because release-to-remove does not remove on macOS 26.x.
void ReadinessNeverMutatesAndCarriesNoCapability() {
  Composition composition;
  rd::VirtualDisplayControlRequest ready;
  ready.verb = rd::VirtualDisplayControlVerb::kReady;
  ready.nonce = 0xABCDEF0123456789ULL;
  const std::string line = rd::SerializeVirtualDisplayControlRequest(ready);

  // Before any grant: answerable, honest, and inert.
  const rd::VirtualDisplayControlReply cold =
      composition.Ask(line);
  assert(cold.ok);
  assert(cold.nonce == ready.nonce);
  assert(!cold.qualified_to_create);
  assert(!cold.display_control_admitted);
  assert(composition.os.mutations == 0);
  assert(composition.wire.seen.empty());

  composition.Establish();
  const std::uint32_t after_establish = composition.os.mutations;

  for (int repeat = 0; repeat < 8; ++repeat) {
    const rd::VirtualDisplayControlReply warm =
        composition.Ask(line);
    assert(warm.ok);
    assert(warm.nonce == ready.nonce);
    // Qualified to create, but a display is NOT being claimed: conflating the
    // two deadlocks the first create on a headless host.
    assert(warm.qualified_to_create);
    assert(!warm.display_control_admitted);
  }
  // Not one spawn, stop, hold or enable across eight probes.
  assert(composition.os.mutations == after_establish);
  assert(composition.wire.seen.empty());

  // And the strict question becomes true only when a display really is held.
  composition.os.active_display = true;
  const rd::VirtualDisplayControlReply admitted =
      composition.Ask(line);
  assert(admitted.display_control_admitted);
  assert(composition.os.mutations == after_establish);

  // A readiness answer is not a capability.
  assert(admitted.route_epoch == 0);
  assert(admitted.cookie_seed == 0);
}

// The route gets a capability and NOTHING else. In particular it never learns
// the helper's epoch or cookie seed -- a peer that could stamp a helper frame
// would drive the display forever, under no generation anyone can revoke.
void ARouteNeverLearnsTheHelperCredentials() {
  Composition composition;
  composition.Establish();

  const rd::VirtualDisplayControlReply route = composition.Route(7);
  assert(route.ok);
  assert(route.route_generation == 7);
  assert(route.route_epoch != 0);
  assert(route.cookie_seed != 0);
  assert(route.uid == 501);

  // The two credential sets are disjoint. This is the single most important
  // assertion in this file.
  assert(route.route_epoch != kHelperEpoch);
  assert(route.cookie_seed != kHelperSeed);

  // The serialized reply must not contain the helper's secrets in ANY form.
  rd::VirtualDisplayControlRequest ask;
  ask.verb = rd::VirtualDisplayControlVerb::kRoute;
  ask.route_generation = 7;
  const std::string wire = composition.Send(rd::SerializeVirtualDisplayControlRequest(ask));
  assert(wire.find(std::to_string(kHelperEpoch)) == std::string::npos);
  assert(wire.find(std::to_string(kHelperSeed)) == std::string::npos);
  assert(wire.find(std::to_string(kHelperGeneration)) == std::string::npos);
  // No descriptor is handed down either.
  assert(wire.find("fd=") == std::string::npos);
}

// A relay is re-authored, never forwarded. What reaches the helper carries the
// helper's credentials, which the route never supplied.
void RelayIsReauthoredNotForwarded() {
  Composition composition;
  composition.Establish();
  const rd::VirtualDisplayControlReply route = composition.Route(7);
  assert(route.ok);

  const rd::VirtualDisplayControlRequest hold =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kHold, 1);
  const rd::VirtualDisplayControlReply held = composition.Ask(
      rd::SerializeVirtualDisplayControlRequest(hold));
  assert(held.ok);
  assert(held.display_id == 42);

  assert(composition.wire.seen.size() == 1);
  // COPIED, not referenced: the next relay push_backs into this vector and can
  // reallocate it. A reference here dangles, which ASan catches -- and which
  // would otherwise read as a passing assertion on freed memory.
  const rd::VirtualDisplayHelperCommand sent = composition.wire.seen.back();
  assert(sent.verb == rd::VirtualDisplayHelperVerb::kHold);
  // The helper saw the HELPER credentials, not the route's.
  assert(sent.epoch == kHelperEpoch);
  assert(sent.generation == kHelperGeneration);
  assert(sent.epoch != route.route_epoch);
  assert(sent.cookie != hold.route_cookie);
  assert(sent.cookie == rd::DeriveHelperCookie(kHelperSeed, sent.request_index));

  // The mode really travels with the enable: a bare enable discards the
  // worker's selection and leaves whatever WindowServer picked.
  const rd::VirtualDisplayControlRequest enable =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kEnable, 2);
  assert(composition
             .Ask(rd::SerializeVirtualDisplayControlRequest(enable))
             .ok);
  const rd::VirtualDisplayHelperCommand enabled = composition.wire.seen.back();
  assert(enabled.verb == rd::VirtualDisplayHelperVerb::kEnable);
  assert(enabled.pixels_wide == 1920);
  assert(enabled.pixels_high == 1080);
  assert(enabled.refresh_millihertz == 60'000);
  assert(enabled.scale_percent == 200);

  // The helper's own index advances independently of the route's.
  assert(enabled.request_index > sent.request_index);
}

// A route may not release the helper. This is the rule that stops the display
// dying with the route -- the original defect the resident owner exists to fix.
void ARouteCanNeverReleaseTheHelper() {
  Composition composition;
  composition.Establish();
  const rd::VirtualDisplayControlReply route = composition.Route(7);
  const rd::VirtualDisplayControlRequest hold =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kHold, 1);
  assert(composition
             .Ask(rd::SerializeVirtualDisplayControlRequest(hold))
             .ok);
  assert(composition.wire.held_display_id == 42);

  // The frame is unrepresentable, so it cannot be sent honestly...
  rd::VirtualDisplayControlRequest release =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kRelease, 2);
  assert(rd::SerializeVirtualDisplayControlRequest(release).empty());

  // ...and forging it by hand is refused by the parser before the server ever
  // sees a verb.
  const rd::VirtualDisplayControlRequest disable =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kDisable, 2);
  std::string forged = rd::SerializeVirtualDisplayControlRequest(disable);
  const std::size_t at = forged.find("op=disable");
  assert(at != std::string::npos);
  forged.replace(at, std::string("op=disable").size(), "op=release");
  const rd::VirtualDisplayControlReply refused =
      composition.Ask(forged);
  assert(!refused.ok);

  // The helper never saw a release, and the display is still held and warm.
  for (const auto& command : composition.wire.seen)
    assert(command.verb != rd::VirtualDisplayHelperVerb::kRelease);
  assert(composition.wire.held_display_id == 42);

  // The backend refuses release on its OWN account, not only because the
  // control grammar cannot express it. Two layers, because the grammar could
  // gain a verb and this guard must not depend on it not doing so.
  {
    rd::VirtualDisplayHelperCommand direct;
    direct.verb = rd::VirtualDisplayHelperVerb::kRelease;
    direct.display_id = 42;
    std::string error;
    const std::size_t before = composition.wire.seen.size();
    assert(!composition.helper.RelayFromRoute(direct, nullptr, &error));
    assert(error == "route_verb_forbidden");
    // Refused BEFORE the wire, not after: nothing reached the helper.
    assert(composition.wire.seen.size() == before);
    // And an invalid verb is refused the same way rather than forwarded blank.
    rd::VirtualDisplayHelperCommand blank;
    assert(!composition.helper.RelayFromRoute(blank, nullptr, &error));
    assert(composition.wire.seen.size() == before);
  }

  // A route that is FINISHED sends disable, and the display stays registered.
  assert(composition
             .Ask(rd::SerializeVirtualDisplayControlRequest(disable))
             .ok);
  assert(composition.wire.held_display_id == 42);
  assert(composition.wire.presence == "inactive");
}

// Replay, cookie forgery, epoch mismatch, foreign uid, unknown route.
void RelayCredentialsAreEnforced() {
  Composition composition;
  composition.Establish();
  const rd::VirtualDisplayControlReply route = composition.Route(7);

  const auto send = [&](const rd::VirtualDisplayControlRequest& request) {
    return composition.Ask(rd::SerializeVirtualDisplayControlRequest(request));
  };

  const rd::VirtualDisplayControlRequest first =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kStatus, 1);
  assert(send(first).ok);
  const std::size_t after_first = composition.wire.seen.size();

  // EXACT replay of a frame that already succeeded.
  const rd::VirtualDisplayControlReply replayed = send(first);
  assert(!replayed.ok);
  assert(replayed.error == "route_replay");
  assert(composition.wire.seen.size() == after_first);

  // Going backwards is a replay too.
  rd::VirtualDisplayControlRequest older =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kStatus, 1);
  assert(send(older).error == "route_replay");

  // A cookie the peer guessed rather than derived.
  rd::VirtualDisplayControlRequest forged =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kStatus, 2);
  forged.route_cookie ^= 1ULL;
  assert(send(forged).error == "route_cookie_unbound");
  assert(composition.wire.seen.size() == after_first);

  // A wrong route epoch.
  rd::VirtualDisplayControlRequest wrong_epoch =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kStatus, 2);
  wrong_epoch.route_epoch ^= 1ULL;
  assert(send(wrong_epoch).error == "route_epoch_mismatch");

  // A generation nobody issued.
  rd::VirtualDisplayControlReply borrowed = route;
  borrowed.route_generation = 8;
  assert(composition
             .Ask(rd::SerializeVirtualDisplayControlRequest(composition.RelayFrame(
                      borrowed, rd::VirtualDisplayHelperVerb::kStatus, 2)))
             .error == "route_unknown");

  // The index is burned even by a frame the helper never saw, so a failed
  // attempt cannot be retried under the same credential.
  rd::VirtualDisplayControlRequest reuse_two =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kStatus, 2);
  assert(send(reuse_two).ok);
  assert(send(reuse_two).error == "route_replay");
}

// A route issued under a previous authority is stale even though its
// credentials still verify: the daemon presenting a new grant moves the agent's
// epoch, and a capability from a superseded authority was never authorised by
// the current one.
void ANewGrantInvalidatesEveryOutstandingRoute() {
  Composition composition;
  composition.Establish();
  const rd::VirtualDisplayControlReply route = composition.Route(7);
  assert(composition.server.route_count() == 1);

  const rd::VirtualDisplayControlRequest before =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kStatus, 1);
  assert(composition
             .Ask(rd::SerializeVirtualDisplayControlRequest(before))
             .ok);

  // A second grant, on a re-established link. Both the link's challenge and the
  // grant's move together, because a grant is only admissible against the
  // challenge minted on the connection it arrived over.
  composition.os.link_secret = std::string(43, 'B');
  const std::string second =
      rd::SerializeVirtualDisplayGrant(Grant(std::string(43, 'B')));
  assert(composition.Ask(second).ok);
  assert(composition.server.route_count() == 0);

  const rd::VirtualDisplayControlRequest after =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kStatus, 2);
  const rd::VirtualDisplayControlReply refused = composition.Ask(
      rd::SerializeVirtualDisplayControlRequest(after));
  assert(!refused.ok);
  assert(refused.error == "route_unknown");
}

// Losing the helper revokes every route immediately. Silently re-binding a live
// route to a fresh helper hands that route a DIFFERENT display, under a new
// epoch, without the peer ever being told.
void RebindingTheHelperDropsEveryRoute() {
  Composition composition;
  composition.Establish();
  const rd::VirtualDisplayControlReply route = composition.Route(7);
  assert(composition.server.route_count() == 1);

  composition.server.BindHelper(nullptr);
  assert(composition.server.route_count() == 0);

  // With no helper owned, a relay is REFUSED, not deferred or queued.
  const rd::VirtualDisplayControlReply refused = composition.Ask(
      rd::SerializeVirtualDisplayControlRequest(composition.RelayFrame(
          route, rd::VirtualDisplayHelperVerb::kStatus, 1)));
  assert(!refused.ok);
  assert(refused.error == "helper_not_owned");

  // And so is a fresh route request: no helper means no capability to give.
  assert(composition.Route(9).error == "helper_not_owned");

  // Readiness still answers, honestly and without a capability.
  rd::VirtualDisplayControlRequest ready;
  ready.verb = rd::VirtualDisplayControlVerb::kReady;
  ready.nonce = 5;
  const rd::VirtualDisplayControlReply answered = composition.Ask(
      rd::SerializeVirtualDisplayControlRequest(ready));
  assert(answered.ok);
  assert(answered.nonce == 5);
}

// The route table refuses at its cap rather than evicting. Evicting an old
// route would drop its replay floor, and a dropped floor is a replay window --
// the exact bug the floor exists to close.
void TheRouteTableRefusesRatherThanEvicts() {
  Composition composition;
  composition.Establish();

  std::vector<rd::VirtualDisplayControlReply> issued;
  for (std::uint64_t generation = 1;
       generation <= rd::kVirtualDisplayControlMaxRoutes; ++generation) {
    const rd::VirtualDisplayControlReply reply = composition.Route(generation);
    assert(reply.ok);
    issued.push_back(reply);
  }
  assert(composition.server.route_count() ==
         rd::kVirtualDisplayControlMaxRoutes);

  const rd::VirtualDisplayControlReply overflow =
      composition.Route(rd::kVirtualDisplayControlMaxRoutes + 1);
  assert(!overflow.ok);
  assert(overflow.error == "route_table_full");

  // The FIRST route is still usable, which is what "refuses rather than
  // evicts" has to mean.
  const rd::VirtualDisplayControlRequest still_good =
      composition.RelayFrame(issued.front(),
                             rd::VirtualDisplayHelperVerb::kStatus, 1);
  assert(composition
             .Ask(rd::SerializeVirtualDisplayControlRequest(still_good))
             .ok);

  // Re-issuing an EXISTING generation is still allowed at the cap: it consumes
  // no new slot, and refusing it would strand a worker that simply restarted.
  assert(composition.Route(1).ok);
}

// A capability names the console session the AGENT is bound to, which the
// agent derived from the kernel. The daemon proxies for a worker it
// authenticated over Node IPC, but it cannot ask for a capability into a
// session this agent is not in -- there is no field in which to ask.
void ACapabilityNamesTheAgentsOwnSession() {
  Composition composition;
  composition.Establish();

  const rd::VirtualDisplayControlReply route = composition.Route(7);
  assert(route.ok);
  // The uid came from the admitted grant, not from anything the request said:
  // the route request has no uid field at all.
  assert(route.uid == 501);
  assert(route.uid == composition.os.session.uid);

  // When the console session moves under us the agent revokes, and every
  // capability goes with it -- including for a daemon that is still perfectly
  // authenticated.
  composition.os.session.audit_session_id = 100004;
  assert(!composition.agent.Poll());
  assert(!composition.Route(8).ok);

  const rd::VirtualDisplayControlRequest stale =
      composition.RelayFrame(route, rd::VirtualDisplayHelperVerb::kStatus, 1);
  assert(!composition
              .Ask(rd::SerializeVirtualDisplayControlRequest(stale))
              .ok);
  assert(composition.wire.seen.empty());
}

// Every refusal must survive its own parser and must carry nothing usable.
void EveryRefusalIsWellFormedAndEmpty() {
  Composition composition;
  const std::vector<std::string> hostile = {
      "",
      "ctl1",
      "ctl1r ok=1",
      "nonsense",
      "ctl1 verb=ready",
      "ctl1 verb=relay rgen=1",
      std::string(rd::kVirtualDisplayControlMaxBytes + 1, 'x'),
      "grant1 nonsense",
  };
  for (const std::string& line : hostile) {
    const std::string answered =
        composition.Send(line);
    assert(!answered.empty());
    rd::VirtualDisplayControlReply reply;
    std::string error;
    assert(rd::ParseVirtualDisplayControlReply(answered, &reply, &error));
    assert(!reply.ok);
    assert(!reply.error.empty());
    // IsValid() already forbids a capability on a refusal; asserted again here
    // because this is the property that matters at the boundary.
    assert(reply.route_epoch == 0 && reply.cookie_seed == 0 && reply.uid == 0);
    assert(!reply.qualified_to_create && !reply.display_control_admitted);
  }
  assert(composition.wire.seen.empty());
  assert(composition.os.mutations == 0);
}

}  // namespace

int main() {
  AnUnauthenticatedLinkAdmitsNothing();
  ReadinessNeverMutatesAndCarriesNoCapability();
  ARouteNeverLearnsTheHelperCredentials();
  RelayIsReauthoredNotForwarded();
  ARouteCanNeverReleaseTheHelper();
  RelayCredentialsAreEnforced();
  ANewGrantInvalidatesEveryOutstandingRoute();
  RebindingTheHelperDropsEveryRoute();
  TheRouteTableRefusesRatherThanEvicts();
  ACapabilityNamesTheAgentsOwnSession();
  EveryRefusalIsWellFormedAndEmpty();
  std::printf("macos virtual display control-server counterfactual ok\n");
  return 0;
}
