#include "macos_auto_unlock_plugin.h"

namespace imcodes::remote_desktop::macos {
namespace {
constexpr std::size_t kMaximumContextBytes = 256;
}  // namespace

AutoUnlockVerifierResult VerifierResultForVerdict(
    AutoUnlockMechanismVerdict verdict) noexcept {
  switch (verdict) {
    case AutoUnlockMechanismVerdict::kAllow:
      return AutoUnlockVerifierResult::kAccepted;
    case AutoUnlockMechanismVerdict::kDeny:
      return AutoUnlockVerifierResult::kRejected;
    case AutoUnlockMechanismVerdict::kUndetermined:
      break;
  }
  // Silence is settled as a rejection, never as success.
  return AutoUnlockVerifierResult::kIndeterminate;
}

EnginePluginContextWriter::EnginePluginContextWriter(
    AutoUnlockPluginEngine& engine)
    : engine_(engine) {}

bool EnginePluginContextWriter::SetVolatileUsername(const char* bytes,
                                                    std::size_t length) {
  if (bytes == nullptr || length == 0 || length > kMaximumContextBytes)
    return false;
  return engine_.SetContextValue(kAutoUnlockContextKeyUsername,
                                 AutoUnlockContextFlags::kVolatileNonExtractable,
                                 bytes, length);
}

bool EnginePluginContextWriter::SetVolatilePassword(const char* bytes,
                                                    std::size_t length) {
  if (bytes == nullptr || length == 0 || length > kMaximumContextBytes)
    return false;
  return engine_.SetContextValue(kAutoUnlockContextKeyPassword,
                                 AutoUnlockContextFlags::kVolatileNonExtractable,
                                 bytes, length);
}

void EnginePluginContextWriter::ClearUsername() noexcept {
  engine_.ClearContextValue(kAutoUnlockContextKeyUsername);
}

void EnginePluginContextWriter::ClearPassword() noexcept {
  engine_.ClearContextValue(kAutoUnlockContextKeyPassword);
}

namespace {

AutoUnlockSubmitOutcome RefuseSubmit(AutoUnlockPluginEngine& engine,
                                     std::string_view refusal,
                                     const AutoUnlockAttemptState& state) {
  // Clear before refusing. A refusal that left a half-written context would
  // hand builtin:authenticate a username with no password.
  engine.ClearContextValue(kAutoUnlockContextKeyPassword);
  engine.ClearContextValue(kAutoUnlockContextKeyUsername);
  AutoUnlockSubmitOutcome outcome;
  outcome.status = AutoUnlockSubmitStatus::kRefused;
  outcome.refusal.assign(refusal);
  outcome.next_state = state;
  outcome.disposition = AutoUnlockMechanismDisposition::kDeny;
  engine.SetDisposition(outcome.disposition);
  return outcome;
}

}  // namespace

AutoUnlockSubmitOutcome RunAutoUnlockSubmitMechanism(
    AutoUnlockPluginEngine& engine,
    const AutoUnlockSubmitObservation& observation,
    const AutoUnlockAttemptState& state,
    std::int64_t now_ms,
    const AutoUnlockAuthorityStore& authority_store,
    AutoUnlockCredentialBackend* backend) {
  // A session that is not locked has nothing to unlock. Refusing first means an
  // unlocked session never even consumes an authority.
  if (!observation.locked)
    return RefuseSubmit(engine, kAutoUnlockRefusalSurfaceNotPermitted, state);
  if (observation.uid == 0 || observation.audit_session_id == 0 ||
      observation.local_user_name.empty()) {
    return RefuseSubmit(engine, kAutoUnlockRefusalUserMismatch, state);
  }

  // One-shot authority first: no authority, no attempt, no keychain access.
  const AutoUnlockAuthorityResult authority = ConsumeAutoUnlockAuthority(
      observation.uid, observation.audit_session_id, now_ms, authority_store);
  if (!authority.consumed())
    return RefuseSubmit(engine, kAutoUnlockRefusalSignerMismatch, state);

  // The observed session must be the one the authority names. Comparing here
  // keeps a stale-but-unexpired authority from being spent by another session.
  if (authority.authority.enrolled.local_user_name !=
          observation.local_user_name ||
      authority.authority.enrolled.session_type != observation.session_type) {
    return RefuseSubmit(engine, kAutoUnlockRefusalUserMismatch, state);
  }

  // Replay: this exact authority has already been spent once. Removing the file
  // stops the ordinary second read, but not a record restored from a copy or
  // recovered after a crash, so the ledger remembers the last spent nonce.
  if (!state.last_nonce.empty() &&
      state.last_nonce == authority.authority.nonce) {
    return RefuseSubmit(engine, kAutoUnlockRefusalSignerMismatch, state);
  }

  AutoUnlockRequest request;
  request.policy = authority.authority.policy;
  request.surface = authority.authority.surface;
  request.enrolled = authority.authority.enrolled;
  request.observed = authority.authority.enrolled;
  request.observed.local_user_uid = observation.uid;
  request.observed.local_user_name = observation.local_user_name;
  request.observed.session_type = observation.session_type;
  request.observed.audit_session_id = observation.audit_session_id;
  request.credential.designated_requirement =
      authority.authority.designated_requirement;
  request.state = state;
  request.now_ms = now_ms;

  EnginePluginContextWriter writer(engine);
  AuthorizationContextAutoUnlockInjector injector(
      writer, observation.local_user_name);

  const AutoUnlockOutcome outcome =
      RunAutoUnlockAttempt(request, backend, &injector);
  if (!outcome.submitted_to_verifier())
    return RefuseSubmit(engine, outcome.refusal, outcome.next_state);

  AutoUnlockSubmitOutcome submitted;
  submitted.status = AutoUnlockSubmitStatus::kPendingVerifier;
  // Already spent. Allowing the engine to continue is not an unlock.
  submitted.next_state = outcome.next_state;
  // Record the spent nonce even on the refusal paths below this point's sibling
  // returns -- those already carry `state`, which preserves whatever nonce was
  // last spent. Here the attempt really was submitted, so this nonce is burnt.
  submitted.next_state.last_nonce = authority.authority.nonce;
  submitted.disposition = AutoUnlockMechanismDisposition::kAllow;
  engine.SetDisposition(submitted.disposition);
  return submitted;
}

AutoUnlockSettleOutcome RunAutoUnlockSettleMechanism(
    AutoUnlockPluginEngine& engine,
    const AutoUnlockAttemptState& submitted_state,
    std::int64_t now_ms) {
  AutoUnlockSettleOutcome outcome;

  // Read the verdict BEFORE clearing, then clear unconditionally. Ordering
  // matters: clearing first would discard the engine state the verdict is read
  // from on some paths, and clearing only on success would leave the password
  // readable by later mechanisms whenever the unlock failed.
  const AutoUnlockMechanismVerdict verdict = engine.ReadVerdict();
  engine.ClearContextValue(kAutoUnlockContextKeyPassword);
  engine.ClearContextValue(kAutoUnlockContextKeyUsername);
  outcome.context_cleared = true;

  const AutoUnlockVerifierResult result = VerifierResultForVerdict(verdict);
  outcome.next_state =
      SettleAutoUnlockVerifierResult(submitted_state, result, now_ms);
  outcome.disposition = result == AutoUnlockVerifierResult::kAccepted
                            ? AutoUnlockMechanismDisposition::kAllow
                            : AutoUnlockMechanismDisposition::kDeny;
  engine.SetDisposition(outcome.disposition);
  return outcome;
}

}  // namespace imcodes::remote_desktop::macos
