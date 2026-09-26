#include "macos_virtual_display_agent.h"

#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

/** splitmix64. Avalanche so a route's epoch does not leak its neighbour's. */
std::uint64_t Mix(std::uint64_t value) noexcept {
  value += 0x9E3779B97F4A7C15ULL;
  value = (value ^ (value >> 30U)) * 0xBF58476D1CE4E5B9ULL;
  value = (value ^ (value >> 27U)) * 0x94D049BB133111EBULL;
  return value ^ (value >> 31U);
}

/**
 * Derives per-agent secrets from the grant's challenge.
 *
 * The challenge is unpredictable and single-use, so anything derived from it
 * is unpredictable too -- and a replayed grant cannot resurrect the old epoch
 * because the challenge is already spent.
 */
std::uint64_t DeriveFromChallenge(const std::string& challenge,
                                  std::uint64_t salt) noexcept {
  std::uint64_t accumulator = salt;
  for (const unsigned char character : challenge)
    accumulator = Mix(accumulator ^ character);
  return accumulator == 0 ? 1U : accumulator;
}

}  // namespace

bool AgentSeam::IsComplete() const noexcept {
  return daemon_identity && observe_session && socket_identity && now_ms &&
         start_helper && helper_alive && stop_helper &&
         helper_holds_active_display;
}

MacosVirtualDisplayAgent::MacosVirtualDisplayAgent(
    AgentSeam seam,
    std::function<void(AgentRevocation)> on_revoked)
    : seam_(std::move(seam)), on_revoked_(std::move(on_revoked)) {
  if (!seam_.IsComplete()) {
    // An incomplete seam is permanently unowning rather than "not started yet".
    state_ = AgentOwnershipState::kRevoked;
    last_revocation_ = AgentRevocation::kStopRequested;
    last_error_ = "agent OS seam is incomplete";
  }
}

bool MacosVirtualDisplayAgent::AcceptGrant(
    const std::string& grant_line,
    const VirtualDisplayAuthorityChallenge& challenge,
    std::string* error) {
  const auto fail = [&](const std::string& message) {
    last_error_ = message;
    if (error != nullptr) *error = message;
    return false;
  };
  if (!seam_.IsComplete())
    return fail(last_error_.empty() ? "agent OS seam is incomplete" : last_error_);

  // LINK FIRST. A grant is only as good as the channel it arrived on, and
  // parsing before identifying that channel means doing work on an
  // unidentified party's behalf.
  const ControlPeerIdentity daemon = seam_.daemon_identity();
  if (!daemon.IsValid())
    return fail("authority link is not authenticated");
  // Deliberately NO "peer uid == this agent's uid" test. The peer is root and
  // this agent is the console user, so they are never equal -- an earlier
  // version required equality, which was correct when several kinds of peer
  // shared one listener and is now the one comparison that would refuse the
  // only legitimate caller.

  const AgentSessionContext observed = seam_.observe_session();
  if (!observed.IsValid())
    return fail("agent session context is unavailable");

  VirtualDisplayGrant grant;
  if (!ParseVirtualDisplayGrant(grant_line, &grant))
    return fail("grant is malformed");

  // BOUND TO THIS CONNECTION. Every field here is load-bearing: the challenge
  // proves the grant came through the channel we authenticated, the service
  // generation refuses one minted for a previous incarnation of the daemon, the
  // audit session refuses the neighbouring login window, and the expiry ceiling
  // refuses a grant that would outlive the promise it was made under.
  std::string mismatch;
  if (!GrantMatchesAuthorityChallenge(grant, challenge, &mismatch))
    return fail(mismatch);

  const std::uint64_t now_ms = seam_.now_ms();

  // THE PRESENTATION DEADLINE, enforced before anything is admitted, reserved
  // or started.
  //
  // `deadline_ms` was formed by the link at receipt, from the challenge's TTL
  // and this process's own monotonic clock, so both sides of this comparison
  // come from one clock domain. It is checked HERE rather than only stored,
  // because everything that follows -- admission, the ledger reservation, and
  // the helper launch -- would otherwise act on a promise that has lapsed.
  //
  // It is also what stops a swept ledger entry from making an old challenge
  // reusable: the ledger prunes on its own schedule, but the link's deadline
  // does not come back.
  if (challenge.deadline_ms == 0 || now_ms == 0
      || now_ms >= challenge.deadline_ms) {
    return fail("grant refused: challenge_expired");
  }

  const GrantAdmission admission =
      EvaluateGrantAdmission(grant, observed, now_ms);
  if (admission != GrantAdmission::kAdmitted)
    return fail(std::string("grant refused: ") + GrantAdmissionText(admission));

  // RESERVE the challenge atomically, before anything is started.
  //
  // A single "last challenge" string left two live replays: A -> B -> A, and
  // two concurrent presentations of A both observing "free". Reservation is one
  // critical section covering check AND record, so a concurrent duplicate loses
  // here rather than starting a second helper.
  const ChallengeReservation reservation = challenges_.Reserve(
      observed.service_generation, grant.challenge, now_ms + grant.ttl_ms,
      now_ms);
  if (reservation != ChallengeReservation::kReserved) {
    switch (reservation) {
      case ChallengeReservation::kAlreadySpent:
        return fail("grant refused: challenge_replayed");
      case ChallengeReservation::kAlreadyPending:
        return fail("grant refused: challenge_in_flight");
      default:
        return fail("grant refused: challenge_ledger_rejected");
    }
  }

  // The socket object, not its path. Recorded now so a later unlink/recreate is
  // detectable rather than invisible.
  const SocketIdentity socket = seam_.socket_identity();
  if (!socket.IsValid()) {
    challenges_.Rollback(observed.service_generation, grant.challenge);
    return fail("control socket identity is unavailable");
  }

  // A NEW grant supersedes whatever was owned: stop first, so two helpers can
  // never be live at once.
  if (state_ == AgentOwnershipState::kOwning)
    seam_.stop_helper();

  std::string start_error;
  if (!seam_.start_helper(grant, &start_error)) {
    // ROLL BACK. A failed launch must not burn the challenge: the daemon is
    // entitled to retry with the same grant, and a burned one would lock it out
    // of its own capability.
    challenges_.Rollback(observed.service_generation, grant.challenge);
    state_ = AgentOwnershipState::kIdle;
    return fail(start_error.empty() ? "helper could not be started" : start_error);
  }

  // COMMIT only once everything succeeded. It stays spent until it expires, so
  // A -> B -> A cannot come back.
  challenges_.Commit(observed.service_generation, grant.challenge);
  grant_ = std::move(grant);
  bound_session_ = observed;
  bound_socket_ = socket;
  epoch_ = DeriveFromChallenge(grant_.challenge, 0x9E3779B9ULL);
  cookie_seed_ = DeriveFromChallenge(grant_.challenge, 0xC0FFEEULL);
  issued_routes_ = 0;
  state_ = AgentOwnershipState::kOwning;
  last_revocation_ = AgentRevocation::kNone;
  last_error_.clear();
  return true;
}

AgentReadinessAnswer MacosVirtualDisplayAgent::Readiness(std::uint64_t nonce) {
  AgentReadinessAnswer answer;
  answer.nonce = nonce;
  // A zero nonce cannot bind an answer to a question, so it gets the same
  // answer as no ownership at all.
  if (nonce == 0 || state_ != AgentOwnershipState::kOwning)
    return answer;
  // NOTHING here creates, holds, enables or spawns. The two questions the agent
  // can answer without side effects:
  //   * qualified_to_create -- a live bound helper exists. TRUE with no display
  //     present; that is the headless case, and requiring a display here would
  //     deadlock the first create.
  //   * display_control_admitted -- a display is held AND active. The only
  //     thing that may ever be advertised.
  answer.qualified_to_create = seam_.helper_alive();
  answer.display_control_admitted =
      answer.qualified_to_create && seam_.helper_holds_active_display();
  return answer;
}

bool MacosVirtualDisplayAgent::IssueRouteGrant(std::uint64_t route_generation,
                                               RouteDisplayGrant* grant,
                                               std::string* error) {
  const auto fail = [&](const char* message) {
    last_error_ = message;
    if (error != nullptr) *error = message;
    return false;
  };
  if (grant == nullptr || route_generation == 0)
    return fail("invalid route grant request");
  if (state_ != AgentOwnershipState::kOwning)
    return fail("agent owns no display authority");
  if (!seam_.helper_alive()) {
    // Revoke rather than hand out a capability against a helper that is gone.
    Revoke(AgentRevocation::kHelperLost);
    return fail("helper is not alive");
  }
  // A CAPABILITY, not a descriptor. Handing down the helper fd would hand down
  // the ability to talk to it directly, forever, with no generation attached.
  grant->route_generation = route_generation;
  grant->uid = bound_session_.uid;
  // Per-route derivation: two routes never share an epoch, so a frame from one
  // cannot authenticate against the other.
  grant->epoch = Mix(epoch_ ^ Mix(route_generation));
  grant->cookie_seed = Mix(cookie_seed_ ^ Mix(route_generation + 1U));
  if (grant->epoch == 0) grant->epoch = 1;
  if (grant->cookie_seed == 0) grant->cookie_seed = 1;
  ++issued_routes_;
  return true;
}

bool MacosVirtualDisplayAgent::Poll() {
  if (state_ != AgentOwnershipState::kOwning)
    return false;
  // Session drift first: a uid, audit session or session-type change means the
  // grant was issued for a session that no longer exists, and everything
  // downstream of it is void.
  const AgentSessionContext observed = seam_.observe_session();
  if (!observed.IsValid() || observed.uid != bound_session_.uid
    || observed.audit_session_id != bound_session_.audit_session_id
    || observed.session_type != bound_session_.session_type) {
    Revoke(AgentRevocation::kSessionChanged);
    return false;
  }
  if (observed.service_generation != bound_session_.service_generation) {
    // The OLD generation's entries go with it; nothing can present them again.
    Revoke(AgentRevocation::kServiceGenerationChanged);
    return false;
  }
  // ABA: the socket may have been unlinked and recreated under the same path.
  const SocketIdentity socket = seam_.socket_identity();
  if (!socket.IsValid() || !socket.Matches(bound_socket_)) {
    Revoke(AgentRevocation::kDaemonDisconnected);
    return false;
  }
  // The grant's expiry is deliberately NOT re-checked here.
  //
  // It bounds the PRESENTATION -- how long an unaccepted grant may be handed
  // in -- and `ChallengeLedger::Reserve` already refuses one presented at or
  // after it, so a late grant can never be accepted. Re-checking it every poll
  // treated a 60-second launch capability as the lifetime of the ownership it
  // established: a perfectly healthy helper was torn down mid-session, with a
  // live daemon lease, an unchanged session and an unchanged service
  // generation, for no reason the operator could see.
  //
  // Continuing authority is the live state, and every part of it is checked
  // above: the session (uid, audit session, type), the service generation, the
  // daemon socket object itself, and helper liveness below. Those go away when
  // the authority really does.
  if (!seam_.helper_alive()) {
    Revoke(AgentRevocation::kHelperLost);
    return false;
  }
  return true;
}

void MacosVirtualDisplayAgent::Revoke(AgentRevocation reason) {
  if (state_ == AgentOwnershipState::kRevoked && epoch_ == 0)
    return;  // idempotent
  // Authority is cleared BEFORE the helper is torn down, so nothing observing
  // mid-teardown can still act under it.
  state_ = AgentOwnershipState::kRevoked;
  last_revocation_ = reason;
  epoch_ = 0;
  cookie_seed_ = 0;
  // A rotated or revoked generation can never be replayed into, so keeping its
  // ledger entries is pure growth. Dropping them here is what keeps the ledger
  // bounded across a long-lived agent's many revocations.
  if (bound_session_.service_generation != 0)
    challenges_.ForgetGeneration(bound_session_.service_generation);
  if (seam_.stop_helper)
    seam_.stop_helper();
  if (on_revoked_)
    on_revoked_(reason);
}

}  // namespace imcodes::remote_desktop::macos
