// Counterfactuals for the automatic-unlock controller.
//
// The controller is linked without Security.framework so every branch can run
// under ASan/UBSan on a machine with no keychain, no signing identity and no
// login window. The keychain and injector are faked; what is proven here is the
// decision order and the credential's lifetime, which is where the security
// properties live.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "macos_auto_unlock_controller.h"

namespace macos = imcodes::remote_desktop::macos;

namespace {

int g_failures = 0;

void Check(bool condition, const char* label) {
  if (condition) return;
  std::fprintf(stderr, "FAIL %s\n", label);
  ++g_failures;
}

constexpr char kRequirement[] =
    "identifier \"to.aiDesk.remote-desktop.launch-agent\" and anchor apple generic";

class FakeBackend final : public macos::AutoUnlockCredentialBackend {
 public:
  bool signer_ok = true;
  bool item_readable = true;
  std::string secret = "hunter2";
  int consume_calls = 0;
  int verify_calls = 0;
  // Recorded so a test can prove the span was zeroed before the read returned.
  std::vector<char> observed_after_return;

  [[nodiscard]] bool ConsumeCredential(
      const macos::AutoUnlockCredentialReference& reference,
      const macos::AutoUnlockCredentialConsumer& consumer) override {
    (void)reference;
    ++consume_calls;
    if (!item_readable) return false;
    std::vector<char> buffer(secret.begin(), secret.end());
    const bool accepted = consumer(buffer.data(), buffer.size());
    // The real backend zeroes here; the fake mirrors it so the test can observe
    // that nothing retained a live pointer.
    std::memset(buffer.data(), 0, buffer.size());
    observed_after_return = buffer;
    return accepted;
  }

  [[nodiscard]] bool VerifySigner(
      const macos::AutoUnlockCredentialReference& reference) override {
    (void)reference;
    ++verify_calls;
    return signer_ok;
  }
};

class FakeInjector final : public macos::AutoUnlockInjector {
 public:
  bool available = true;
  bool succeed = true;
  int inject_calls = 0;
  std::size_t last_length = 0;

  [[nodiscard]] bool Available() const override { return available; }
  [[nodiscard]] bool Inject(const char* bytes, std::size_t length) override {
    ++inject_calls;
    last_length = length;
    Check(bytes != nullptr && length > 0, "injector receives a non-empty span");
    return succeed;
  }
};

macos::AutoUnlockBinding Binding() {
  macos::AutoUnlockBinding binding;
  binding.local_user_name = "operator";
  binding.local_user_uid = 501;
  binding.session_type = "LoginWindow";
  binding.audit_session_id = 100001;
  binding.worker_generation = 4;
  return binding;
}

macos::AutoUnlockRequest Request() {
  macos::AutoUnlockRequest request;
  request.policy = macos::kAutoUnlockPolicyLoginWindowOnly;
  request.surface = macos::kAutoUnlockSurfaceLoginWindow;
  request.enrolled = Binding();
  request.observed = Binding();
  request.credential.keychain_path = "/Library/Keychains/System.keychain";
  request.credential.service = "to.aiDesk.remote-desktop.auto-unlock";
  request.credential.account = "operator";
  request.credential.designated_requirement = kRequirement;
  request.now_ms = 1000000;
  return request;
}

void HappyPathConsumesExactlyOnce() {
  FakeBackend backend;
  FakeInjector injector;
  const macos::AutoUnlockOutcome outcome =
      macos::RunAutoUnlockAttempt(Request(), &backend, &injector);
  Check(outcome.submitted_to_verifier(),
        "a bound, permitted attempt reaches the verifier");
  Check(outcome.refusal.empty(), "a success carries no refusal");
  Check(backend.consume_calls == 1, "the credential is read exactly once");
  Check(injector.inject_calls == 1, "the injector runs exactly once");
  Check(injector.last_length == 7, "the exact span length reaches the injector");
  // Submission SPENDS the attempt. This assertion previously required the
  // opposite -- that reaching the verifier cleared the ledger -- which is what
  // let a wrong password reset the counter on every try. Only an authenticated
  // acceptance clears it, and that is settled separately.
  Check(outcome.next_state.attempts == 1,
        "a submitted attempt is spent, not forgiven");
  Check(outcome.next_state.locked_out_until_ms == 0,
        "a first submission does not lock out");
  Check(macos::SettleAutoUnlockVerifierResult(
            outcome.next_state, macos::AutoUnlockVerifierResult::kAccepted,
            Request().now_ms)
                .attempts == 0,
        "an authenticated acceptance is what clears the ledger");
  for (char byte : backend.observed_after_return) {
    Check(byte == 0, "the credential buffer is zeroed once the read returns");
  }
}

void DisabledAndUnknownPolicyRefuseWithoutTouchingAnything() {
  for (const char* policy : {macos::kAutoUnlockPolicyDisabled, "enabled", ""}) {
    FakeBackend backend;
    FakeInjector injector;
    macos::AutoUnlockRequest request = Request();
    request.policy = policy;
    const macos::AutoUnlockOutcome outcome =
        macos::RunAutoUnlockAttempt(request, &backend, &injector);
    Check(!outcome.submitted_to_verifier(),
          "a disabled or unknown policy refuses");
    Check(outcome.refusal == macos::kAutoUnlockRefusalPolicyDisabled,
          "an unrecognized policy resolves to disabled, not to a guess");
    Check(backend.consume_calls == 0 && backend.verify_calls == 0,
          "a refused policy never touches the keychain");
    Check(injector.inject_calls == 0, "a refused policy never injects");
  }
}

void FileVaultPrebootIsRefusedUnderEveryPolicy() {
  for (const char* policy :
       {macos::kAutoUnlockPolicyDisabled, macos::kAutoUnlockPolicyLoginWindowOnly,
        macos::kAutoUnlockPolicyAlways}) {
    FakeBackend backend;
    FakeInjector injector;
    macos::AutoUnlockRequest request = Request();
    request.policy = policy;
    request.surface = macos::kAutoUnlockSurfaceFileVaultPreboot;
    const macos::AutoUnlockOutcome outcome =
        macos::RunAutoUnlockAttempt(request, &backend, &injector);
    Check(outcome.refusal == macos::kAutoUnlockRefusalFileVaultPrebootUnsupported,
          "FileVault preboot is refused by name, never attempted");
    Check(backend.consume_calls == 0, "preboot never reaches the keychain");
  }
}

void WrongSignerNeverReachesTheKeychain() {
  FakeBackend backend;
  FakeInjector injector;
  backend.signer_ok = false;
  const macos::AutoUnlockOutcome outcome =
      macos::RunAutoUnlockAttempt(Request(), &backend, &injector);
  Check(outcome.refusal == macos::kAutoUnlockRefusalSignerMismatch,
        "a wrong signer is refused");
  Check(backend.verify_calls == 1, "the signer is actually checked");
  Check(backend.consume_calls == 0,
        "a wrong signer never reaches the credential");

  FakeBackend empty_requirement;
  FakeInjector second;
  macos::AutoUnlockRequest request = Request();
  request.credential.designated_requirement.clear();
  const macos::AutoUnlockOutcome blank =
      macos::RunAutoUnlockAttempt(request, &empty_requirement, &second);
  Check(blank.refusal == macos::kAutoUnlockRefusalSignerMismatch,
        "an empty requirement is a refusal, not an absent constraint");
  Check(empty_requirement.verify_calls == 0,
        "an empty requirement short-circuits before verification");
}

void BindingMismatchesRefuseByExactReason() {
  struct Case {
    const char* label;
    macos::AutoUnlockBinding observed;
    const char* refusal;
  };
  macos::AutoUnlockBinding uid = Binding();
  uid.local_user_uid = 502;
  macos::AutoUnlockBinding name = Binding();
  name.local_user_name = "other";
  macos::AutoUnlockBinding asid = Binding();
  asid.audit_session_id = 100002;
  macos::AutoUnlockBinding type = Binding();
  type.session_type = "Aqua";
  macos::AutoUnlockBinding generation = Binding();
  generation.worker_generation = 5;

  const Case cases[] = {
      {"uid", uid, macos::kAutoUnlockRefusalUserMismatch},
      {"name", name, macos::kAutoUnlockRefusalUserMismatch},
      {"asid", asid, macos::kAutoUnlockRefusalSessionMismatch},
      {"type", type, macos::kAutoUnlockRefusalSessionMismatch},
      {"generation", generation, macos::kAutoUnlockRefusalGenerationMismatch},
  };
  for (const Case& entry : cases) {
    FakeBackend backend;
    FakeInjector injector;
    macos::AutoUnlockRequest request = Request();
    request.observed = entry.observed;
    const macos::AutoUnlockOutcome outcome =
        macos::RunAutoUnlockAttempt(request, &backend, &injector);
    Check(outcome.refusal == entry.refusal, entry.label);
    Check(backend.consume_calls == 0,
          "a mismatched binding never reaches the credential");
  }
}

void UnavailableInjectorRefusesBeforeDecrypting() {
  FakeBackend backend;
  FakeInjector injector;
  injector.available = false;
  const macos::AutoUnlockOutcome outcome =
      macos::RunAutoUnlockAttempt(Request(), &backend, &injector);
  Check(outcome.refusal == macos::kAutoUnlockRefusalInjectionUnavailable,
        "an injector that cannot observe its surface refuses");
  // The point of the ordering: a machine that cannot inject must never bring
  // the plaintext into memory for nothing.
  Check(backend.consume_calls == 0,
        "an unavailable injector never decrypts the credential");
}

void MissingAndDeniedGiveOneAnswer() {
  FakeBackend backend;
  FakeInjector injector;
  backend.item_readable = false;
  const macos::AutoUnlockOutcome outcome =
      macos::RunAutoUnlockAttempt(Request(), &backend, &injector);
  Check(outcome.refusal == macos::kAutoUnlockRefusalCredentialUnavailable,
        "a missing item and a denied ACL are one answer");
  Check(outcome.next_state.attempts == 1,
        "a credential failure burns exactly one attempt");
}

void AttemptsAreBoundedAndLockoutExpires() {
  macos::AutoUnlockAttemptState state;
  for (int attempt = 1; attempt <= macos::kAutoUnlockMaxAttempts; ++attempt) {
    FakeBackend backend;
    FakeInjector injector;
    macos::AutoUnlockRequest request = Request();
    request.state = state;
    const macos::AutoUnlockOutcome outcome =
        macos::RunAutoUnlockAttempt(request, &backend, &injector);
    Check(outcome.submitted_to_verifier(), "each bounded attempt is admitted");
    // Thread the REAL ledger. The previous version assigned
    // `state.attempts = attempt` by hand, which fabricated the accumulation the
    // code never produced and hid a lockout bypass: submission used to clear the
    // ledger, so a wrong password reset the counter on every try.
    Check(outcome.next_state.attempts == attempt,
          "a submitted attempt is spent, not forgiven");
    state = outcome.next_state;
  }
  FakeBackend backend;
  FakeInjector injector;
  macos::AutoUnlockRequest request = Request();
  request.state = state;
  const macos::AutoUnlockOutcome exhausted =
      macos::RunAutoUnlockAttempt(request, &backend, &injector);
  Check(exhausted.refusal == macos::kAutoUnlockRefusalAttemptsExhausted,
        "the attempt bound is enforced");
  Check(exhausted.next_state.locked_out_until_ms ==
            request.now_ms + macos::kAutoUnlockLockoutMs,
        "exhaustion starts the exact lockout");
  Check(backend.consume_calls == 0, "an exhausted ledger never decrypts");

  macos::AutoUnlockRequest during = Request();
  during.state = exhausted.next_state;
  during.now_ms = exhausted.next_state.locked_out_until_ms - 1;
  FakeBackend locked_backend;
  FakeInjector locked_injector;
  Check(macos::RunAutoUnlockAttempt(during, &locked_backend, &locked_injector)
                .refusal == macos::kAutoUnlockRefusalLockedOut,
        "a live lockout refuses");

  macos::AutoUnlockRequest after = Request();
  after.state = exhausted.next_state;
  after.now_ms = exhausted.next_state.locked_out_until_ms;
  FakeBackend fresh_backend;
  FakeInjector fresh_injector;
  const macos::AutoUnlockOutcome resumed =
      macos::RunAutoUnlockAttempt(after, &fresh_backend, &fresh_injector);
  Check(resumed.submitted_to_verifier(), "an expired lockout admits again");
  // Fresh, not resumed: the expired ledger restarts at zero and this attempt
  // then spends exactly one -- it does not continue the previous count.
  Check(resumed.next_state.attempts == 1,
        "an expired lockout starts a fresh ledger, not a spent one");
}

}  // namespace

void SubmissionIsNotSuccessAndWrongPasswordsLockOut() {
  // The security property the old contract lost. A verifier that keeps saying
  // "no" must still walk the ledger to exhaustion and then lock out.
  macos::AutoUnlockAttemptState state;
  for (int attempt = 1; attempt <= macos::kAutoUnlockMaxAttempts; ++attempt) {
    FakeBackend backend;
    FakeInjector injector;
    macos::AutoUnlockRequest request = Request();
    request.state = state;
    const macos::AutoUnlockOutcome outcome =
        macos::RunAutoUnlockAttempt(request, &backend, &injector);
    Check(outcome.submitted_to_verifier(), "a wrong password still reaches the verifier");
    // Apple's mechanism rejects it. That must not be cheaper than a refusal.
    state = macos::SettleAutoUnlockVerifierResult(
        outcome.next_state, macos::AutoUnlockVerifierResult::kRejected,
        request.now_ms);
    Check(state.attempts == attempt, "a rejected attempt stays spent");
  }
  Check(state.locked_out_until_ms > 0,
        "repeated verifier rejection reaches the lockout");

  FakeBackend backend;
  FakeInjector injector;
  macos::AutoUnlockRequest request = Request();
  request.state = state;
  request.now_ms = state.locked_out_until_ms - 1;
  const macos::AutoUnlockOutcome refused =
      macos::RunAutoUnlockAttempt(request, &backend, &injector);
  Check(refused.refusal == macos::kAutoUnlockRefusalLockedOut,
        "the lockout earned by wrong passwords is enforced");
  Check(backend.consume_calls == 0,
        "a locked-out attempt never decrypts the credential");
}

void OnlyAuthenticatedAcceptanceClearsTheLedger() {
  macos::AutoUnlockAttemptState spent;
  spent.attempts = 2;

  const auto accepted = macos::SettleAutoUnlockVerifierResult(
      spent, macos::AutoUnlockVerifierResult::kAccepted, 1'000);
  Check(accepted.attempts == 0 && accepted.locked_out_until_ms == 0,
        "acceptance is the only thing that clears the ledger");

  const auto rejected = macos::SettleAutoUnlockVerifierResult(
      spent, macos::AutoUnlockVerifierResult::kRejected, 1'000);
  Check(rejected.attempts == 2, "rejection keeps the attempt spent");

  // Silence must cost the same as rejection, or an attacker suppresses the
  // callback and retries for free.
  const auto silent = macos::SettleAutoUnlockVerifierResult(
      spent, macos::AutoUnlockVerifierResult::kIndeterminate, 1'000);
  Check(silent.attempts == 2, "an unanswered submission is not a free retry");
  Check(silent.locked_out_until_ms == rejected.locked_out_until_ms,
        "indeterminate is settled exactly as rejection");

  macos::AutoUnlockAttemptState at_bound;
  at_bound.attempts = macos::kAutoUnlockMaxAttempts;
  const auto locked = macos::SettleAutoUnlockVerifierResult(
      at_bound, macos::AutoUnlockVerifierResult::kRejected, 5'000);
  Check(locked.locked_out_until_ms == 5'000 + macos::kAutoUnlockLockoutMs,
        "reaching the bound starts the exact lockout");
}

int main() {
  HappyPathConsumesExactlyOnce();
  DisabledAndUnknownPolicyRefuseWithoutTouchingAnything();
  FileVaultPrebootIsRefusedUnderEveryPolicy();
  WrongSignerNeverReachesTheKeychain();
  BindingMismatchesRefuseByExactReason();
  UnavailableInjectorRefusesBeforeDecrypting();
  MissingAndDeniedGiveOneAnswer();
  AttemptsAreBoundedAndLockoutExpires();
  SubmissionIsNotSuccessAndWrongPasswordsLockOut();
  OnlyAuthenticatedAcceptanceClearsTheLedger();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d auto-unlock counterfactual failure(s)\n", g_failures);
    return EXIT_FAILURE;
  }
  std::printf("macos auto unlock controller counterfactual ok\n");
  return EXIT_SUCCESS;
}

