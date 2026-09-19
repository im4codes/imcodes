// Production-composition counterexamples for the resident agent's ownership.
// These drive the real state machine, not a parser in isolation.
#include "macos_virtual_display_agent.h"

#include <cassert>
#include <cstdio>
#include <set>
#include <string>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;

namespace {

// Built by the SAME function production uses, so the fixture cannot quietly
// drift into a spelling the parser would refuse.
const std::string kRequirement = rd::CanonicalDesignatedRequirement(
    "cc.imcodes.node.virtual-display-helper", "ABCDE12345");

/** The challenge the authenticated link minted, as the agent holds it. */
rd::VirtualDisplayAuthorityChallenge LinkChallenge(
    const std::string& secret = std::string(43, 'A'),
    std::uint64_t generation = 7) {
  rd::VirtualDisplayAuthorityChallenge challenge;
  challenge.challenge = secret;
  challenge.service_generation = generation;
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
  // The release directory name IS `sha256-` + the set digest by construction;
  // a pair that disagrees is a grant assembled from two different sets.
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

struct FakeAgentOs {
  /** The ROOT daemon, as the authority link proved it. uid 0 is correct. */
  rd::ControlPeerIdentity peer{0, 4242, true};
  rd::AgentSessionContext session{501, 100003, "Aqua", 7};
  rd::SocketIdentity socket{16, 900};
  std::uint64_t clock_ms = 1'000'000;
  bool start_ok = true;
  bool alive = true;
  bool active_display = false;

  std::uint32_t starts = 0;
  std::uint32_t stops = 0;
  /** Anything a readiness probe must NEVER cause. */
  std::uint32_t mutations = 0;

  rd::AgentSeam Seam() {
    rd::AgentSeam seam;
    seam.daemon_identity = [this] { return peer; };
    seam.observe_session = [this] { return session; };
    seam.socket_identity = [this] { return socket; };
    seam.now_ms = [this] { return clock_ms; };
    seam.start_helper = [this](const rd::VirtualDisplayGrant&, std::string* error) {
      ++starts;
      ++mutations;
      if (!start_ok) {
        if (error) *error = "helper refused to start";
        return false;
      }
      return true;
    };
    seam.helper_alive = [this] { return alive; };
    seam.stop_helper = [this] { ++stops; ++mutations; };
    seam.helper_holds_active_display = [this] { return active_display; };
    return seam;
  }
};

struct Revocations {
  std::vector<rd::AgentRevocation> entries;
  std::function<void(rd::AgentRevocation)> Callback() {
    return [this](rd::AgentRevocation reason) { entries.push_back(reason); };
  }
  rd::AgentRevocation back() const {
    return entries.empty() ? rd::AgentRevocation::kNone : entries.back();
  }
};

std::string Line(const rd::VirtualDisplayGrant& grant) {
  return rd::SerializeVirtualDisplayGrant(grant);
}

void OwnsOnlyAfterAnAuthenticatedPeerPresentsAValidGrant() {
  FakeAgentOs os;
  Revocations revocations;
  rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
  assert(agent.state() == rd::AgentOwnershipState::kIdle);

  std::string error;
  assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
  assert(agent.state() == rd::AgentOwnershipState::kOwning);
  assert(agent.epoch() != 0);
  assert(os.starts == 1);
}

// The link, not the frame, is what is checked first. A grant is only as good
// as the channel it arrived on, and parsing before establishing that channel
// means doing work on an unidentified party's behalf.
void AnUnauthenticatedLinkIsRefusedBeforeTheGrantIsEvenParsed() {
  {
    FakeAgentOs os;
    // The link never proved the daemon.
    os.peer.authenticated = false;
    Revocations revocations;
    rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
    std::string error;
    assert(!agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(error.find("authority link") != std::string::npos);
    // Nothing was started: a grant is only as good as the channel it came on.
    assert(os.starts == 0);
    assert(agent.state() == rd::AgentOwnershipState::kIdle);
  }
  {
    // Authenticated, but NOT root. Root is the trust root; nothing else may
    // mint authority however well it authenticated itself.
    FakeAgentOs os;
    os.peer.uid = 501;
    Revocations revocations;
    rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
    std::string error;
    assert(!agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(os.starts == 0);
  }
  {
    // uid 0 is the EXPECTED value here, so the rule must accept it. An earlier
    // ControlPeerIdentity required uid != 0 -- written when several kinds of
    // peer shared one listener -- which would now refuse the only legitimate
    // caller this channel can ever have.
    FakeAgentOs os;
    assert(os.peer.uid == 0);
    assert(os.peer.IsValid());
    Revocations revocations;
    rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
    std::string error;
    assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(os.starts == 1);
  }
  {
    // Even a perfectly authenticated link cannot present a malformed grant.
    FakeAgentOs os;
    Revocations revocations;
    rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
    std::string error;
    assert(!agent.AcceptGrant("grant1 uid=501", LinkChallenge(), &error));
    assert(os.starts == 0);
  }
}

void GrantsForAnotherSessionAreRefused() {
  const struct { const char* label; rd::AgentSessionContext session; } cases[] = {
      {"another uid", {502, 100003, "Aqua", 7}},
      {"a new login window under the same uid", {501, 100004, "Aqua", 7}},
      {"a different session type", {501, 100003, "LoginWindow", 7}},
      {"a superseded agent incarnation", {501, 100003, "Aqua", 8}},
  };
  for (const auto& entry : cases) {
    FakeAgentOs os;
    os.session = entry.session;
    os.peer.uid = entry.session.uid;
    Revocations revocations;
    rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
    std::string error;
    assert(!agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(os.starts == 0);
  }
}

void AnExpiredOrReplayedGrantIsRefused() {
  FakeAgentOs os;
  Revocations revocations;
  rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
  std::string error;
  const auto grant = Grant();
  assert(agent.AcceptGrant(Line(grant), LinkChallenge(), &error));

  // The SAME challenge again is a replay, even from the right peer.
  assert(!agent.AcceptGrant(Line(grant), LinkChallenge(), &error));
  assert(error.find("challenge_replayed") != std::string::npos);
  // A fresh challenge from the same daemon is fine.
  assert(agent.AcceptGrant(Line(Grant(std::string(43, 'B'))),
                          LinkChallenge(std::string(43, 'B')), &error));
  // A -> B -> A: the ledger still remembers A. A single "last challenge" string
  // would have forgotten it the moment B arrived.
  assert(!agent.AcceptGrant(Line(grant), LinkChallenge(), &error));
  assert(error.find("challenge_replayed") != std::string::npos);

  // The presentation window is a DURATION measured on this process's own
  // monotonic clock, so it cannot be exceeded at the instant the grant arrives
  // -- "now minus now" is zero against any TTL. What that window bounds is the
  // ledger entry: a challenge stops being answerable once its TTL elapses.
  //
  // This replaces an assertion that only ever passed by accident. It advanced a
  // monotonic clock past a daemon-stamped EPOCH deadline; the two were never
  // comparable, so `now >= expires` was false on every real machine and the
  // refusal it claimed to prove could not happen in production.
  {
    FakeAgentOs late;
    rd::MacosVirtualDisplayAgent agentLate(late.Seam(), revocations.Callback());
    assert(agentLate.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    // LEDGER PRUNE DOES NOT REOPEN THE CHALLENGE.
    //
    // Past the TTL the ledger sweeps its entry, so on the ledger's own terms
    // the challenge looks free again. The link's deadline is what stops that
    // becoming a reuse window: it was formed at receipt and does not come
    // back. Before this was enforced, a swept entry made an old challenge
    // admissible a second time.
    late.clock_ms += rd::kVirtualDisplayGrantMaxLifetimeMs + 1;
    assert(!agentLate.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(error.find("challenge_expired") != std::string::npos);
  }

  // The presentation deadline, at its exact boundary and on both sides of it.
  {
    Revocations revocations;
    // BEFORE the deadline: admitted.
    FakeAgentOs early;
    early.clock_ms = 1'000'000 + 59'999;   // deadline is 1'000'000 + 60'000
    rd::MacosVirtualDisplayAgent ok(early.Seam(), revocations.Callback());
    std::string error;
    assert(ok.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(ok.state() == rd::AgentOwnershipState::kOwning);

    // EXACTLY AT the deadline: refused. `>=`, so the last admissible instant
    // is one millisecond earlier.
    FakeAgentOs exact;
    exact.clock_ms = 1'000'000 + 60'000;
    rd::MacosVirtualDisplayAgent atDeadline(exact.Seam(), revocations.Callback());
    assert(!atDeadline.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(error.find("challenge_expired") != std::string::npos);
    assert(exact.starts == 0);            // nothing was started

    // AFTER the deadline: refused, and still nothing started or reserved.
    FakeAgentOs after;
    after.clock_ms = 9'000'000;
    rd::MacosVirtualDisplayAgent late2(after.Seam(), revocations.Callback());
    assert(!late2.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(error.find("challenge_expired") != std::string::npos);
    assert(after.starts == 0);
    assert(late2.state() != rd::AgentOwnershipState::kOwning);
  }

  // An ACCEPTED authority is not torn down by the presentation deadline.
  //
  // The deadline bounds acceptance only. A helper that is alive, in the same
  // session and under the same service generation keeps its authority however
  // far past the window the clock runs -- otherwise a healthy display would
  // die about a minute into every session.
  {
    FakeAgentOs os;
    Revocations revocations;
    rd::MacosVirtualDisplayAgent held(os.Seam(), revocations.Callback());
    std::string error;
    assert(held.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    os.clock_ms = 999'000'000;            // very far past the deadline
    assert(held.Poll());
    assert(held.state() == rd::AgentOwnershipState::kOwning);
    assert(revocations.entries.empty());
  }
}

void ReadinessNeverMutatesAnything() {
  FakeAgentOs os;
  Revocations revocations;
  rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
  std::string error;
  assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
  const std::uint32_t baseline = os.mutations;

  // Headless: a live helper holding NO display is still qualified to create.
  os.active_display = false;
  auto answer = agent.Readiness(4242);
  assert(answer.nonce == 4242);
  assert(answer.qualified_to_create);
  assert(!answer.display_control_admitted);

  // Held AND active is the only shape that may be advertised.
  os.active_display = true;
  answer = agent.Readiness(4243);
  assert(answer.display_control_admitted);

  // A zero nonce cannot bind an answer to a question.
  answer = agent.Readiness(0);
  assert(!answer.qualified_to_create && !answer.display_control_admitted);

  // Many probes, zero side effects.
  for (std::uint64_t nonce = 1; nonce <= 50; ++nonce)
    (void)agent.Readiness(nonce);
  assert(os.mutations == baseline);
  assert(os.starts == 1);
  assert(os.stops == 0);
}

void RouteClientsGetCapabilitiesNotDescriptors() {
  FakeAgentOs os;
  Revocations revocations;
  rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
  std::string error;
  assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));

  rd::RouteDisplayGrant first;
  rd::RouteDisplayGrant second;
  assert(agent.IssueRouteGrant(11, &first, &error));
  assert(agent.IssueRouteGrant(12, &second, &error));
  assert(first.IsValid() && second.IsValid());
  assert(first.uid == 501 && second.uid == 501);
  // Per-route derivation: a frame minted for one route must not authenticate
  // against the other.
  assert(first.epoch != second.epoch);
  assert(first.cookie_seed != second.cookie_seed);
  // Never the agent's own epoch, which owns the helper itself.
  assert(first.epoch != agent.epoch() && second.epoch != agent.epoch());

  assert(!agent.IssueRouteGrant(0, &first, &error));

  // A dead helper must not yield a capability -- it revokes instead.
  os.alive = false;
  assert(!agent.IssueRouteGrant(13, &first, &error));
  assert(agent.state() == rd::AgentOwnershipState::kRevoked);
  assert(revocations.back() == rd::AgentRevocation::kHelperLost);
}

void EverythingThatCanMoveRevokesTerminally() {
  const struct { const char* label; void (*mutate)(FakeAgentOs&);
                 rd::AgentRevocation expected; } cases[] = {
      {"the helper died", [](FakeAgentOs& os) { os.alive = false; },
       rd::AgentRevocation::kHelperLost},
      {"the user logged out and back in",
       [](FakeAgentOs& os) { os.session.audit_session_id = 100004; },
       rd::AgentRevocation::kSessionChanged},
      {"the session type changed",
       [](FakeAgentOs& os) { os.session.session_type = "LoginWindow"; },
       rd::AgentRevocation::kSessionChanged},
      {"the agent was replaced",
       [](FakeAgentOs& os) { os.session.service_generation = 8; },
       rd::AgentRevocation::kServiceGenerationChanged},
      {"the control socket was recreated under the same path (ABA)",
       [](FakeAgentOs& os) { os.socket.inode = 901; },
       rd::AgentRevocation::kDaemonDisconnected},
  };
  {
    // THE GRANT BOUNDS THE PRESENTATION, NOT THE OWNERSHIP.
    //
    // A launch capability is valid for about a minute. Treating that as the
    // lifetime of the ownership it established tore down a perfectly healthy
    // helper mid-session -- live daemon lease, unchanged session, unchanged
    // service generation -- for no reason an operator could see.
    FakeAgentOs os;
    Revocations revocations;
    rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
    std::string error;
    assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(agent.Poll());
    // Far past the grant's expiry, with every piece of live state unchanged.
    os.clock_ms = 9'000'000;
    assert(agent.Poll());
    assert(agent.state() == rd::AgentOwnershipState::kOwning);
    assert(revocations.entries.empty());

    // ...and the live state is still what revokes it.
    os.alive = false;
    assert(!agent.Poll());
    assert(revocations.back() == rd::AgentRevocation::kHelperLost);
  }
  {
    // What bounds presentation is the ledger's window, measured on THIS
    // process's clock, not the wall time at which the daemon minted the grant.
    //
    // The assertion here used to advance a monotonic clock past a daemon
    // EPOCH deadline and call the result "late". Those two numbers were never
    // comparable, so it passed only because the fixture picked both -- on a
    // real machine the comparison was false and no late grant was ever
    // refused. A grant arriving on a fresh connection IS fresh; what must not
    // work is presenting one twice inside its window.
    FakeAgentOs os;
    Revocations revocations;
    rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
    std::string error;
    // Inside the challenge's window -- the point being proved here is REPLAY,
    // not lateness, so the presentation deadline must not be what refuses the
    // second call. Lateness has its own counterfactuals above.
    os.clock_ms = 1'030'000;
    assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(!agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(error.find("challenge_replayed") != std::string::npos);
  }

  for (const auto& entry : cases) {
    FakeAgentOs os;
    Revocations revocations;
    rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
    std::string error;
    assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
    assert(agent.Poll());

    entry.mutate(os);
    assert(!agent.Poll());
    assert(agent.state() == rd::AgentOwnershipState::kRevoked);
    assert(revocations.back() == entry.expected);
    // Terminal: no capability, no readiness claim, and the helper was stopped.
    assert(agent.epoch() == 0);
    rd::RouteDisplayGrant grant;
    assert(!agent.IssueRouteGrant(11, &grant, &error));
    const auto answer = agent.Readiness(9);
    assert(!answer.qualified_to_create && !answer.display_control_admitted);
    assert(os.stops >= 1);
  }
}

void AFailedStartLeavesNothingOwned() {
  FakeAgentOs os;
  os.start_ok = false;
  Revocations revocations;
  rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
  std::string error;
  assert(!agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
  assert(agent.state() == rd::AgentOwnershipState::kIdle);
  rd::RouteDisplayGrant grant;
  assert(!agent.IssueRouteGrant(11, &grant, &error));
  // The challenge was NOT spent: a refused grant must not lock the daemon out
  // of retrying with the same one.
  os.start_ok = true;
  assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
}

void AReplacementGrantStopsTheOldHelperFirst() {
  FakeAgentOs os;
  Revocations revocations;
  rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
  std::string error;
  assert(agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
  const std::uint64_t first_epoch = agent.epoch();
  assert(agent.AcceptGrant(Line(Grant(std::string(43, 'C'))),
                          LinkChallenge(std::string(43, 'C')), &error));
  // Two helpers must never be live at once.
  assert(os.stops == 1);
  assert(os.starts == 2);
  // A new grant is a new epoch, so nothing minted under the old one survives.
  assert(agent.epoch() != first_epoch);
}

void AnIncompleteSeamOwnsNothingPermanently() {
  Revocations revocations;
  rd::MacosVirtualDisplayAgent agent(rd::AgentSeam{}, revocations.Callback());
  assert(agent.state() == rd::AgentOwnershipState::kRevoked);
  std::string error;
  assert(!agent.AcceptGrant(Line(Grant()), LinkChallenge(), &error));
  const auto answer = agent.Readiness(1);
  assert(!answer.qualified_to_create && !answer.display_control_admitted);
}


void RotationForgetsTheOldGenerationsLedger() {
  // A long-lived agent revokes many times. If each revocation left its ledger
  // entries behind, the set would grow without bound -- and the entries cannot
  // be replayed into anyway, because the generation they belong to is gone.
  FakeAgentOs os;
  Revocations revocations;
  rd::MacosVirtualDisplayAgent agent(os.Seam(), revocations.Callback());
  std::string error;
  assert(agent.AcceptGrant(Line(Grant(std::string(43, 'A'))),
                          LinkChallenge(std::string(43, 'A')), &error));
  assert(agent.ledger_size() == 1);

  // The agent is replaced under us.
  os.session.service_generation = 8;
  assert(!agent.Poll());
  assert(revocations.back() == rd::AgentRevocation::kServiceGenerationChanged);
  assert(agent.ledger_size() == 0);

  // A grant for the OLD generation is refused outright now.
  assert(!agent.AcceptGrant(Line(Grant(std::string(43, 'A'))),
                          LinkChallenge(std::string(43, 'A')), &error));
  assert(error.find("service_generation_mismatch") != std::string::npos);

  // The SAME challenge string is usable again under the NEW generation: it is a
  // different capability, and the old one can no longer be presented at all.
  // A new service generation arrives on a NEW daemon connection, so the link's
  // challenge carries the new generation too. Passing the old challenge here
  // would be presenting a grant against a promise that was never made.
  auto rotated = Grant(std::string(43, 'A'));
  rotated.service_generation = 8;
  assert(agent.AcceptGrant(Line(rotated),
                           LinkChallenge(std::string(43, 'A'), 8), &error));
  assert(agent.ledger_size() == 1);
}

}  // namespace

int main() {
  OwnsOnlyAfterAnAuthenticatedPeerPresentsAValidGrant();
  AnUnauthenticatedLinkIsRefusedBeforeTheGrantIsEvenParsed();
  GrantsForAnotherSessionAreRefused();
  AnExpiredOrReplayedGrantIsRefused();
  ReadinessNeverMutatesAnything();
  RouteClientsGetCapabilitiesNotDescriptors();
  EverythingThatCanMoveRevokesTerminally();
  AFailedStartLeavesNothingOwned();
  AReplacementGrantStopsTheOldHelperFirst();
  RotationForgetsTheOldGenerationsLedger();
  AnIncompleteSeamOwnsNothingPermanently();
  std::printf("macos virtual display agent counterfactual ok\n");
  return 0;
}
