#include "macos_auto_unlock_controller.h"

namespace imcodes::remote_desktop::macos {
namespace {

[[nodiscard]] AutoUnlockOutcome Refuse(std::string_view refusal,
                                       const AutoUnlockAttemptState& state) {
  AutoUnlockOutcome outcome;
  outcome.status = AutoUnlockAttemptStatus::kRefused;
  outcome.refusal.assign(refusal);
  outcome.next_state = state;
  return outcome;
}

[[nodiscard]] bool PolicyPermits(std::string_view policy,
                                 std::string_view surface) {
  if (policy == kAutoUnlockPolicyLoginWindowOnly) {
    return surface == kAutoUnlockSurfaceLoginWindow;
  }
  if (policy == kAutoUnlockPolicyAlways) {
    return surface == kAutoUnlockSurfaceLoginWindow
        || surface == kAutoUnlockSurfaceLockedSession;
  }
  return false;
}

/** Empty when the bindings match; otherwise the exact refusal token. */
[[nodiscard]] std::string_view BindingMismatch(
    const AutoUnlockBinding& enrolled, const AutoUnlockBinding& observed) {
  if (enrolled.local_user_uid != observed.local_user_uid
      || enrolled.local_user_name != observed.local_user_name) {
    return kAutoUnlockRefusalUserMismatch;
  }
  // A different audit session is a different graphical instance even when the
  // session type matches, so authority cannot migrate into a successor.
  if (enrolled.session_type != observed.session_type
      || enrolled.audit_session_id != observed.audit_session_id) {
    return kAutoUnlockRefusalSessionMismatch;
  }
  if (enrolled.worker_generation != observed.worker_generation) {
    return kAutoUnlockRefusalGenerationMismatch;
  }
  return {};
}

}  // namespace

AutoUnlockOutcome RunAutoUnlockAttempt(const AutoUnlockRequest& request,
                                       AutoUnlockCredentialBackend* backend,
                                       AutoUnlockInjector* injector) {
  const AutoUnlockAttemptState& state = request.state;

  // Pre-boot is EFI-era: no System keychain and no LaunchAgent exist yet.
  // Named and refused rather than attempted, under every policy.
  if (request.surface == kAutoUnlockSurfaceFileVaultPreboot) {
    return Refuse(kAutoUnlockRefusalFileVaultPrebootUnsupported, state);
  }
  if (request.policy == kAutoUnlockPolicyDisabled
      || (request.policy != kAutoUnlockPolicyLoginWindowOnly
          && request.policy != kAutoUnlockPolicyAlways)) {
    // An unrecognized policy resolves to disabled rather than to a guess.
    return Refuse(kAutoUnlockRefusalPolicyDisabled, state);
  }
  if (!PolicyPermits(request.policy, request.surface)) {
    return Refuse(kAutoUnlockRefusalSurfaceNotPermitted, state);
  }
  if (backend == nullptr || request.credential.designated_requirement.empty()) {
    return Refuse(kAutoUnlockRefusalSignerMismatch, state);
  }
  // The signer is settled before the keychain is touched at all: a wrong signer
  // must not even reach the item.
  if (!backend->VerifySigner(request.credential)) {
    return Refuse(kAutoUnlockRefusalSignerMismatch, state);
  }

  const std::string_view mismatch =
      BindingMismatch(request.enrolled, request.observed);
  if (!mismatch.empty()) return Refuse(mismatch, state);

  if (state.locked_out_until_ms > request.now_ms) {
    return Refuse(kAutoUnlockRefusalLockedOut, state);
  }

  // An expired lockout starts a fresh ledger rather than resuming a spent one.
  const int attempts =
      (state.locked_out_until_ms > 0 && state.locked_out_until_ms <= request.now_ms)
          ? 0
          : state.attempts;
  if (attempts >= kAutoUnlockMaxAttempts) {
    AutoUnlockAttemptState next;
    next.attempts = attempts;
    next.locked_out_until_ms = request.now_ms + kAutoUnlockLockoutMs;
    return Refuse(kAutoUnlockRefusalAttemptsExhausted, next);
  }

  // Injector availability is checked BEFORE the credential is read. A machine
  // that cannot observe which account surface it would type into must never
  // decrypt the item at all -- otherwise a failed unlock would still have
  // brought the plaintext into memory for nothing.
  if (injector == nullptr || !injector->Available()) {
    return Refuse(kAutoUnlockRefusalInjectionUnavailable, state);
  }

  AutoUnlockAttemptState spent;
  spent.attempts = attempts + 1;
  spent.locked_out_until_ms = 0;

  bool injected = false;
  const bool read = backend->ConsumeCredential(
      request.credential,
      [injector, &injected](const char* bytes, std::size_t length) {
        // The span is valid only inside this callback; the backend zeroes it as
        // this returns. Nothing may copy it out.
        injected = injector->Inject(bytes, length);
        return injected;
      });

  if (!read) {
    // Missing item and ACL denial are one answer on purpose.
    return Refuse(kAutoUnlockRefusalCredentialUnavailable, spent);
  }
  if (!injected) {
    return Refuse(kAutoUnlockRefusalInjectionUnavailable, spent);
  }

  AutoUnlockOutcome outcome;
  outcome.status = AutoUnlockAttemptStatus::kSubmittedToVerifier;
  // The attempt stays SPENT. Reaching the verifier is not passing it, and the
  // wrong password reaches it exactly as readily as the right one. Clearing the
  // ledger here would reset the counter on every failed guess and make the
  // attempt bound -- and therefore the lockout -- unreachable. Only an
  // authenticated acceptance, applied through SettleAutoUnlockVerifierResult,
  // may clear it.
  outcome.next_state = spent;
  return outcome;
}

AutoUnlockAttemptState SettleAutoUnlockVerifierResult(
    const AutoUnlockAttemptState& submitted_state,
    AutoUnlockVerifierResult result,
    std::int64_t now_ms) noexcept {
  if (result == AutoUnlockVerifierResult::kAccepted) {
    // The only path that forgives a spent attempt.
    return AutoUnlockAttemptState{};
  }
  // Rejected and indeterminate are one answer: an unanswered submission must
  // not be cheaper than a refused one, or silence becomes a free retry.
  AutoUnlockAttemptState next = submitted_state;
  if (next.attempts >= kAutoUnlockMaxAttempts) {
    next.locked_out_until_ms = now_ms + kAutoUnlockLockoutMs;
  }
  return next;
}

}  // namespace imcodes::remote_desktop::macos
