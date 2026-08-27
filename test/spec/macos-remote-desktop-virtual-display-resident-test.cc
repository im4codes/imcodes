// Lifetime counterexamples for the assembled resident owner.
//
// The individual pieces are proven elsewhere. What is proven here is the
// WIRING: the places where the supervisor, the agent and the control server can
// disagree about what is currently owned. Each of these was a real shape at
// some point in this design, and each one leaves a display that either nobody
// is authorised to control or nobody is watching.

#include "macos_virtual_display_resident.h"

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
  // Below the permitted maximum on purpose: the 'grant outlives its
  // challenge' fixture adds one, and that grant must still be otherwise
  // valid or the refusal would prove nothing about the challenge rule.
  challenge.ttl_ms = 30'000;
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
  grant.ttl_ms = 30'000;  // within the challenge's promise
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

/** A fake OS for BOTH seams, so one story governs the whole composition. */
struct FakeOs {
  /** The ROOT daemon: the one and only inbound peer. */
  rd::ControlPeerIdentity daemon{0, 4242, true};
  rd::AgentSessionContext session{501, 100003, "Aqua", 7};
  rd::SocketIdentity socket{16, 900};
  std::uint64_t clock_ms = 1'000'000;
  bool active_display = false;
  /** The generation the authenticated link minted for this connection. */
  std::uint64_t link_generation = 7;
  /**
   * The audit session the DAEMON promised, which is a different fact from the
   * one the kernel reports about this process. They agree in the ordinary case
   * and only the challenge rule notices when they do not.
   */
  std::uint32_t link_asid = 100003;

  // Supervisor-side state.
  bool spawn_ok = true;
  bool resolve_ok = true;
  bool ready_ok = true;
  bool helper_running = false;
  std::uint32_t spawns = 0;
  std::uint32_t terminations = 0;
  std::uint64_t random_state = 0x1234'5678'9ABC'DEF0ULL;
  /** What the supervisor was actually asked to verify, per attempt. */
  struct ResolveAsk {
    std::string release_identity;
    std::string expected_sha256;
    std::string expected_requirement;
  };
  std::vector<ResolveAsk> resolves;
  /** Parent-side descriptors the supervisor was handed. */
  int open_descriptors = 0;

  rd::ResidentOwnerSeam OwnerSeam() {
    rd::ResidentOwnerSeam seam;
    seam.daemon_identity = [this] { return daemon; };
    seam.authority_challenge = [this] {
      auto challenge = LinkChallenge();
      challenge.service_generation = link_generation;
      challenge.audit_session_id = link_asid;
      return challenge;
    };
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
    seam.resolve_verified_helper =
        [this](const std::string& release, const std::string& sha256,
               const std::string& requirement, std::string* path,
               std::string* error) {
          resolves.push_back({release, sha256, requirement});
          if (!resolve_ok) {
            if (error) *error = "helper identity did not verify";
            return false;
          }
          *path = "/verified/imcodes-virtual-display-helper";
          return true;
        };
    seam.random_u64 = [this] {
      random_state = random_state * 6364136223846793005ULL + 1442695040888963407ULL;
      return random_state == 0 ? 1ULL : random_state;
    };
    seam.spawn_helper = [this](const std::string&,
                               const rd::VirtualDisplayHelperBinding&,
                               rd::SupervisedHelper* helper,
                               std::string* error) {
      ++spawns;
      if (!spawn_ok) {
        if (error) *error = "spawn refused";
        return false;
      }
      helper->pid = 4321;
      helper->binding_write_fd = 30;
      helper->control_fd = 31;
      open_descriptors += 2;
      helper_running = true;
      return true;
    };
    seam.await_ready = [this](const rd::SupervisedHelper&, std::uint32_t) {
      return ready_ok;
    };
    seam.still_running = [this](std::int32_t) { return helper_running; };
    seam.terminate_and_reap = [this](std::int32_t, std::uint32_t) {
      ++terminations;
      helper_running = false;
    };
    seam.close_fd = [this](int) { --open_descriptors; };
    seam.now_ms = [this] { return clock_ms; };
    return seam;
  }
};

struct Resident {
  FakeOs os;
  rd::MacosVirtualDisplayResidentOwner owner;

  Resident()
      : owner(rd::SupervisorPolicy{}, os.Supervisor(), os.OwnerSeam()) {}

  rd::VirtualDisplayControlReply Ask(const std::string& line) {
    rd::VirtualDisplayControlReply reply;
    std::string error;
    const std::string answered = owner.Handle(line);
    assert(!answered.empty());
    assert(rd::ParseVirtualDisplayControlReply(answered, &reply, &error));
    return reply;
  }

  rd::VirtualDisplayControlReply Grant(const std::string& challenge =
                                           std::string(43, 'A')) {
    return Ask(rd::SerializeVirtualDisplayGrant(::Grant(challenge)));
  }

  rd::VirtualDisplayControlReply Route(std::uint64_t generation) {
    rd::VirtualDisplayControlRequest request;
    request.verb = rd::VirtualDisplayControlVerb::kRoute;
    request.route_generation = generation;
    return Ask(rd::SerializeVirtualDisplayControlRequest(request));
  }

  rd::VirtualDisplayControlReply Ready(std::uint64_t nonce) {
    rd::VirtualDisplayControlRequest request;
    request.verb = rd::VirtualDisplayControlVerb::kReady;
    request.nonce = nonce;
    return Ask(rd::SerializeVirtualDisplayControlRequest(request));
  }
};

// ---------------------------------------------------------------------------

// The helper can be started by an admitted grant and by nothing else. This is
// structural rather than checked: the agent's start_helper seam is the only
// edge into the supervisor.
void NothingButAnAdmittedGrantCanStartTheHelper() {
  Resident resident;
  assert(resident.os.spawns == 0);

  // Readiness, a route request and a relayed frame all fail to start anything.
  assert(resident.Ready(1).ok);
  assert(!resident.Route(7).ok);
  assert(resident.os.spawns == 0);

  // A grant arriving on a link that was never authenticated starts nothing.
  // There is no "wrong kind of peer" case left to test, because the agent
  // binds no socket -- a different kind of peer has nowhere to arrive.
  const std::string grant = rd::SerializeVirtualDisplayGrant(Grant());
  {
    Resident unauthenticated;
    unauthenticated.os.daemon = rd::ControlPeerIdentity{};
    assert(unauthenticated.Ask(grant).error == "link_unauthenticated");
    assert(unauthenticated.os.spawns == 0);
  }
  {
    // Authenticated, but not root: root is the trust root, and nothing else
    // may mint authority however well it authenticated.
    Resident not_root;
    not_root.os.daemon = rd::ControlPeerIdentity{501, 4242, true};
    assert(not_root.Ask(grant).error == "link_unauthenticated");
    assert(not_root.os.spawns == 0);
  }
  assert(resident.os.spawns == 0);

  // The daemon's grant is the one and only thing that does.
  assert(resident.Grant().ok);
  assert(resident.os.spawns == 1);
  assert(resident.owner.supervisor_state() == rd::SupervisorState::kReady);
  assert(resident.owner.state() == rd::AgentOwnershipState::kOwning);

  // And the verification the supervisor performed used the GRANT's identity
  // facts. Neither was read from the filesystem next to us (self-attestation:
  // whoever can replace the helper can replace a manifest in the same write)
  // nor from the environment (`ps -E` and every child can read one).
  const rd::VirtualDisplayGrant granted = ::Grant();
  assert(resident.os.resolves.size() == 1);
  assert(resident.os.resolves.front().release_identity ==
         granted.release_identity);
  assert(resident.os.resolves.front().expected_sha256 == granted.helper_sha256);
  assert(resident.os.resolves.front().expected_requirement ==
         granted.helper_designated_requirement);
  // Not the empty string, which a seam that simply forgot to pass them on
  // would also satisfy.
  assert(!resident.os.resolves.front().expected_sha256.empty());
  assert(!resident.os.resolves.front().expected_requirement.empty());
}

// A grant must be the one the daemon promised ON THIS CONNECTION.
//
// This is the rule that was written, unit-tested, and then never reached from
// production: the control server went straight to AcceptGrant and the predicate
// was exercised only by its own test. Every case below is a STRUCTURALLY VALID
// grant -- it parses, it is canonical, it names this session -- and every one
// must produce zero spawns.
void AGrantMustMatchTheChallengeThisConnectionMinted() {
  const rd::VirtualDisplayAuthorityChallenge link = LinkChallenge();
  const struct {
    const char* what;
    rd::VirtualDisplayGrant (*forge)();
  } cases[] = {
      {"a challenge from another connection", [] {
         // Captured from a previous lease, or minted by something else
         // entirely. Same session, same release, same everything else.
         auto grant = ::Grant();
         grant.challenge = std::string(43, 'B');
         return grant;
       }},
      {"a previous service generation", [] {
         // A daemon restarted; this grant was minted for the incarnation
         // before it.
         auto grant = ::Grant();
         grant.service_generation = 6;
         return grant;
       }},
      {"the neighbouring login window", [] {
         // Same uid. uid alone cannot tell two successive sessions apart,
         // which is the entire reason the audit session travels.
         auto grant = ::Grant();
         grant.audit_session_id = 100004;
         return grant;
       }},
      {"an expiry past the promise it was made under", [] {
         auto grant = ::Grant();
         grant.ttl_ms = LinkChallenge().ttl_ms + 1;
         return grant;
       }},
  };

  for (const auto& entry : cases) {
    Resident resident;
    const rd::VirtualDisplayGrant forged = entry.forge();
    // The fixture must be forging a grant that is otherwise BEYOND reproach,
    // or the refusal below would prove nothing about the challenge rule.
    assert(forged.IsValid());
    const std::string line = rd::SerializeVirtualDisplayGrant(forged);
    assert(!line.empty());

    const rd::VirtualDisplayControlReply reply = resident.Ask(line);
    assert(!reply.ok);
    assert(resident.os.spawns == 0);
    assert(resident.owner.state() != rd::AgentOwnershipState::kOwning);
    assert(resident.os.open_descriptors == 0);
    // And no route can be had off the back of it either.
    assert(!resident.Route(7).ok);
  }

  // THE CASE THE SESSION CHECK CANNOT CATCH.
  //
  // The agent's own session rules compare a grant against what the KERNEL says
  // this process is. The challenge rule compares it against what the DAEMON
  // promised. Those two are different facts, and when they disagree only the
  // challenge rule sees it: here the grant matches the kernel exactly -- so
  // EvaluateGrantAdmission is satisfied -- while naming a session the daemon
  // never issued a challenge for.
  {
    Resident resident;
    // The kernel says this agent is in session 100004...
    resident.os.session.audit_session_id = 100004;
    // ...and the grant agrees with the kernel, so the session check passes.
    auto grant = ::Grant();
    grant.audit_session_id = 100004;
    assert(grant.IsValid());
    // But the link's challenge was minted for 100003. Refused.
    assert(resident.os.link_asid == 100003);
    const rd::VirtualDisplayControlReply reply =
        resident.Ask(rd::SerializeVirtualDisplayGrant(grant));
    assert(!reply.ok);
    assert(resident.os.spawns == 0);

    // Move the daemon's promise onto the same session and it is admitted, so
    // this is a disagreement rule rather than a refusal of 100004.
    Resident agreed;
    agreed.os.session.audit_session_id = 100004;
    agreed.os.link_asid = 100004;
    assert(agreed.Ask(rd::SerializeVirtualDisplayGrant(grant)).ok);
    assert(agreed.os.spawns == 1);
  }

  // The exact match is admitted, so the rule is a rule and not a blanket
  // refusal that would satisfy every case above just as well.
  {
    Resident resident;
    assert(resident.Grant().ok);
    assert(resident.os.spawns == 1);
    assert(resident.owner.state() == rd::AgentOwnershipState::kOwning);
  }
  (void)link;
}

// The service generation the agent binds to is the one the LINK minted, and it
// is fixed for that connection.
//
// It used to be hardcoded to 1, which made the whole generation rule vacuous:
// every daemon incarnation looked like generation 1, so a grant minted for a
// previous one was indistinguishable from a current one.
void TheServiceGenerationComesFromTheLinkNotAConstant() {
  for (const std::uint64_t generation : {2ULL, 7ULL, 4242ULL}) {
    Resident resident;
    resident.os.link_generation = generation;
    resident.os.session.service_generation = generation;

    auto grant = ::Grant();
    grant.service_generation = generation;
    const rd::VirtualDisplayControlReply reply =
        resident.Ask(rd::SerializeVirtualDisplayGrant(grant));
    assert(reply.ok);
    assert(resident.os.spawns == 1);

    // A grant naming the constant that used to be hardcoded is refused for
    // every generation that is not it -- which is the point.
    Resident other;
    other.os.link_generation = generation;
    other.os.session.service_generation = generation;
    auto hardcoded = ::Grant();
    hardcoded.service_generation = 1;
    if (generation != 1) {
      assert(!other.Ask(rd::SerializeVirtualDisplayGrant(hardcoded)).ok);
      assert(other.os.spawns == 0);
    }
  }
}

// A helper that dies must stop being advertised before anyone can observe the
// loss, and every outstanding route must go with it.
void LosingTheHelperUnbindsEveryRouteImmediately() {
  Resident resident;
  assert(resident.Grant().ok);
  assert(resident.Route(7).ok);
  assert(resident.owner.route_count() == 1);

  // The helper crashes.
  resident.os.helper_running = false;
  assert(!resident.owner.Poll());

  // No route survives, and a fresh one cannot be issued.
  assert(resident.owner.route_count() == 0);
  assert(!resident.Route(7).ok);
  assert(!resident.Route(8).ok);

  // Readiness still answers, and answers honestly.
  const rd::VirtualDisplayControlReply ready = resident.Ready(5);
  assert(ready.ok);
  assert(ready.nonce == 5);
  assert(!ready.qualified_to_create);
  assert(!ready.display_control_admitted);
}

// An agent that stopped while the helper kept running would leave a display
// nobody is authorised to control and nobody is watching.
void RevokingAuthorityAlsoTearsDownTheHelper() {
  Resident resident;
  assert(resident.Grant().ok);
  assert(resident.os.helper_running);

  // The console session moves under us -- a different login window.
  resident.os.session.audit_session_id = 100004;
  assert(!resident.owner.Poll());

  assert(!resident.os.helper_running);
  assert(resident.os.terminations >= 1);
  assert(resident.owner.route_count() == 0);
  // Descriptors are reclaimed, not leaked, on the failure path.
  assert(resident.os.open_descriptors == 0);
  // The reason is recorded rather than collapsed into a bare failure: a field
  // report that cannot distinguish "the session moved" from "the helper died"
  // sends an operator looking in the wrong place.
  assert(resident.owner.last_revocation() == rd::AgentRevocation::kSessionChanged);
}

// The grant's expiry bounds the PRESENTATION, not the ownership it created.
//
// It used to tear both sides down, which meant a healthy helper died about a
// minute into every session -- live daemon lease, unchanged session, unchanged
// service generation -- for no reason an operator could observe. What ends the
// ownership is the live state going away, and every one of those is covered by
// the cases around this one.
void AnExpiredGrantDoesNotEndALiveOwnership() {
  Resident resident;
  assert(resident.Grant().ok);
  resident.os.clock_ms = 9'000'000;  // far past any presentation TTL
  assert(resident.owner.Poll());
  assert(resident.os.helper_running);

  // ...and nothing was widened: presenting the same promise twice inside its
  // window is still refused. (The old form of this asserted that a grant
  // "presented late" was refused, by advancing a monotonic clock past a
  // daemon-stamped epoch deadline -- a comparison that could not fire on a
  // real machine, so it proved nothing.)
  Resident twice;
  assert(twice.Grant().ok);
  assert(!twice.Grant().ok);
}

// The control socket being replaced under the same name is an ABA: a path is a
// rendezvous, never an identity.
void AReplacedControlSocketRevokes() {
  Resident resident;
  assert(resident.Grant().ok);
  resident.os.socket.inode = 901;  // same path, different object
  assert(!resident.owner.Poll());
  assert(!resident.os.helper_running);
}

// A helper that cannot be verified must leave the owner unowning rather than
// half-started, and must not consume the whole restart budget silently.
void AnUnverifiableHelperLeavesNothingOwned() {
  Resident resident;
  resident.os.resolve_ok = false;

  assert(!resident.Grant().ok);
  assert(resident.os.spawns == 0);
  assert(resident.owner.state() != rd::AgentOwnershipState::kOwning);
  assert(!resident.Route(7).ok);
  assert(resident.os.open_descriptors == 0);

  // Readiness is honest about it rather than silent.
  const rd::VirtualDisplayControlReply ready = resident.Ready(9);
  assert(ready.ok);
  assert(!ready.qualified_to_create);
  assert(!ready.display_control_admitted);
}

// A helper that never says ready is a dead helper, and the descriptors it was
// given must come back.
void AHelperThatNeverAnswersIsTornDown() {
  Resident resident;
  resident.os.ready_ok = false;
  assert(!resident.Grant().ok);
  assert(resident.os.spawns >= 1);
  assert(!resident.os.helper_running);
  assert(resident.os.open_descriptors == 0);
  assert(resident.owner.state() != rd::AgentOwnershipState::kOwning);
}

// Stopping is idempotent and reclaims everything, including from a state where
// nothing was ever owned.
void StopIsIdempotentAndReclaimsEverything() {
  {
    Resident resident;
    resident.owner.Stop();
    resident.owner.Stop();
    assert(resident.os.open_descriptors == 0);
  }
  {
    Resident resident;
    assert(resident.Grant().ok);
    assert(resident.Route(7).ok);
    resident.owner.Stop();
    resident.owner.Stop();
    assert(!resident.os.helper_running);
    assert(resident.os.open_descriptors == 0);
    assert(resident.owner.route_count() == 0);
    // Still answers, still refuses, never crashes.
    assert(!resident.Route(7).ok);
    assert(resident.Ready(3).ok);
  }
}

}  // namespace

int main() {
  NothingButAnAdmittedGrantCanStartTheHelper();
  AGrantMustMatchTheChallengeThisConnectionMinted();
  TheServiceGenerationComesFromTheLinkNotAConstant();
  LosingTheHelperUnbindsEveryRouteImmediately();
  RevokingAuthorityAlsoTearsDownTheHelper();
  AnExpiredGrantDoesNotEndALiveOwnership();
  AReplacedControlSocketRevokes();
  AnUnverifiableHelperLeavesNothingOwned();
  AHelperThatNeverAnswersIsTornDown();
  StopIsIdempotentAndReclaimsEverything();
  std::printf("macos virtual display resident counterfactual ok\n");
  return 0;
}
