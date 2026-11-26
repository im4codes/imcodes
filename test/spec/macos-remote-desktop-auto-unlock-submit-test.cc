// Production submit/settle counterfactuals. No keychain, no login window, no
// installation: the authority store and credential backend are fakes, so the
// refusal ordering and the ledger are provable offline.
#include "macos_auto_unlock_plugin.h"
#include "macos_auto_unlock_rights.h"

#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace md = imcodes::remote_desktop::macos;
namespace {
int g_failures = 0;
void Check(bool c, const char* w) { if (!c) { std::printf("FAIL: %s\n", w); ++g_failures; } }

constexpr std::uint32_t kUid = 501, kAsid = 0x186a3;
constexpr std::uint64_t kGeneration = 77;
const char kRequirement[] = "identifier \"to.aidesk.remote-desktop.autounlock\"";

struct FakeEngine final : md::AutoUnlockPluginEngine {
  std::map<std::string, std::string> context;
  md::AutoUnlockMechanismVerdict verdict = md::AutoUnlockMechanismVerdict::kDeny;
  md::AutoUnlockMechanismDisposition disposition = md::AutoUnlockMechanismDisposition::kDeny;
  bool fail_password = false;
  bool SetContextValue(std::string_view k, md::AutoUnlockContextFlags, const char* b, std::size_t n) override {
    if (fail_password && k == md::kAutoUnlockContextKeyPassword) return false;
    context[std::string(k)] = std::string(b, n); return true;
  }
  void ClearContextValue(std::string_view k) noexcept override { context.erase(std::string(k)); }
  md::AutoUnlockMechanismVerdict ReadVerdict() override { return verdict; }
  void SetDisposition(md::AutoUnlockMechanismDisposition d) override { disposition = d; }
};

struct FakeBackend final : md::AutoUnlockCredentialBackend {
  int consumes = 0; bool signer_ok = true; bool present = true;
  bool VerifySigner(const md::AutoUnlockCredentialReference&) override { return signer_ok; }
  bool ConsumeCredential(const md::AutoUnlockCredentialReference&,
                         const std::function<bool(const char*, std::size_t)>& consumer) override {
    ++consumes;
    if (!present) return false;
    char secret[] = "hunter2";
    return consumer(secret, 7);
  }
};

md::AutoUnlockAuthority Authority(std::int64_t now,
                                  const std::string& nonce = "fixture-nonce") {
  md::AutoUnlockAuthority a;
  a.policy = md::kAutoUnlockPolicyAlways;
  a.surface = md::kAutoUnlockSurfaceLockedSession;
  a.enrolled.local_user_uid = kUid;
  a.enrolled.local_user_name = "alice";
  a.enrolled.session_type = "Aqua";
  a.enrolled.audit_session_id = kAsid;
  a.enrolled.worker_generation = kGeneration;
  a.designated_requirement = kRequirement;
  // route_generation and nonce became mandatory bindings: an authority naming no
  // route, or carrying no nonce, would satisfy a route check and a replay check
  // that mean nothing.
  a.route_generation = 9;
  a.nonce = nonce;
  a.issued_at_ms = now;
  a.expires_at_ms = now + 60'000;
  return a;
}

struct FakeStore {
  std::map<std::uint64_t, std::string> records;
  int takes = 0;
  static std::uint64_t Key(std::uint32_t uid, std::uint32_t asid) {
    return (static_cast<std::uint64_t>(uid) << 32) | asid;
  }
  void Put(std::uint32_t uid, std::uint32_t asid, const std::string& s) { records[Key(uid, asid)] = s; }
  md::AutoUnlockAuthorityStore Store() {
    md::AutoUnlockAuthorityStore s;
    s.take = [this](std::uint32_t uid, std::uint32_t asid) -> std::optional<std::string> {
      ++takes;
      const auto f = records.find(Key(uid, asid));
      if (f == records.end()) return std::nullopt;
      const std::string v = f->second;
      records.erase(f);          // read AND remove: single-consume
      return v;
    };
    s.discard = [this](std::uint32_t uid, std::uint32_t asid) { records.erase(Key(uid, asid)); };
    return s;
  }
};

md::AutoUnlockSubmitObservation Observation() {
  md::AutoUnlockSubmitObservation o;
  o.uid = kUid; o.audit_session_id = kAsid;
  o.local_user_name = "alice"; o.session_type = "Aqua"; o.locked = true;
  return o;
}

void HappyPathIsPendingNotUnlocked() {
  FakeEngine e; FakeBackend b; FakeStore s;
  s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
  const auto r = md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000, s.Store(), &b);
  Check(r.pending_verifier(), "a fully matching session reaches the verifier");
  Check(r.disposition == md::AutoUnlockMechanismDisposition::kAllow,
        "allow means proceed to the verifier");
  Check(r.next_state.attempts == 1, "submission SPENDS the attempt; it is not an unlock");
  Check(e.context.count("username") == 1 && e.context.count("password") == 1,
        "both context values are written");
}

void UnlockedSessionNeverConsumesAuthorityOrKeychain() {
  FakeEngine e; FakeBackend b; FakeStore s;
  s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
  auto o = Observation(); o.locked = false;
  const auto r = md::RunAutoUnlockSubmitMechanism(e, o, {}, 1'000, s.Store(), &b);
  Check(!r.pending_verifier(), "an unlocked session is refused");
  Check(s.takes == 0, "an unlocked session never consumes the one-shot authority");
  Check(b.consumes == 0, "an unlocked session never touches the keychain");
}

void MissingAuthorityRefusesBeforeKeychain() {
  FakeEngine e; FakeBackend b; FakeStore s;  // store empty
  const auto r = md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000, s.Store(), &b);
  Check(!r.pending_verifier(), "no authority means no submission");
  Check(b.consumes == 0, "no authority means the credential is never decrypted");
  Check(e.context.empty(), "nothing is written to context");
}

void AuthorityIsSingleConsume() {
  FakeEngine e1; FakeBackend b1; FakeStore s;
  s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
  Check(md::RunAutoUnlockSubmitMechanism(e1, Observation(), {}, 1'000, s.Store(), &b1)
            .pending_verifier(), "first use succeeds");
  FakeEngine e2; FakeBackend b2;
  const auto second = md::RunAutoUnlockSubmitMechanism(e2, Observation(), {}, 1'000, s.Store(), &b2);
  Check(!second.pending_verifier(), "the same authority cannot be replayed");
  Check(b2.consumes == 0, "a replayed authority never reaches the keychain");
}

void CrossSessionAndCrossGenerationRefused() {
  { // different ASID
    FakeEngine e; FakeBackend b; FakeStore s;
    s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
    auto o = Observation(); o.audit_session_id = kAsid + 1;
    const auto r = md::RunAutoUnlockSubmitMechanism(e, o, {}, 1'000, s.Store(), &b);
    Check(!r.pending_verifier(), "an authority issued for another audit session is refused");
    Check(b.consumes == 0, "cross-session never decrypts");
  }
  { // authority naming a different user than the observed session
    FakeEngine e; FakeBackend b; FakeStore s;
    auto a = Authority(1'000); a.enrolled.local_user_name = "bob";
    s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(a));
    const auto r = md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000, s.Store(), &b);
    Check(!r.pending_verifier(), "an authority naming another user is refused");
    Check(b.consumes == 0, "user mismatch never decrypts");
  }
  { // generation 0 is not a usable authority
    FakeEngine e; FakeBackend b; FakeStore s;
    auto a = Authority(1'000); a.enrolled.worker_generation = 0;
    s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(a));
    const auto r = md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000, s.Store(), &b);
    Check(!r.pending_verifier(), "generation 0 is refused, never defaulted to 1");
  }
}

void ExpiredAuthorityRefused() {
  FakeEngine e; FakeBackend b; FakeStore s;
  s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
  const auto r = md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000 + 61'000, s.Store(), &b);
  Check(!r.pending_verifier(), "an expired authority is refused");
  Check(b.consumes == 0, "expiry never decrypts");
}

void KeychainDeniedAndPartialWriteLeaveNothing() {
  { // ACL denial / missing item are one answer
    FakeEngine e; FakeBackend b; b.present = false; FakeStore s;
    s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
    const auto r = md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000, s.Store(), &b);
    Check(!r.pending_verifier(), "a denied or missing keychain item refuses");
    Check(e.context.empty(), "no context survives a keychain refusal");
    Check(r.next_state.attempts == 1, "a keychain refusal still spends the attempt");
  }
  { // password write fails after username landed
    FakeEngine e; e.fail_password = true; FakeBackend b; FakeStore s;
    s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
    const auto r = md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000, s.Store(), &b);
    Check(!r.pending_verifier(), "a partial context write refuses");
    Check(e.context.empty(), "a partial write is zeroed, leaving no username behind");
  }
  { // wrong signer never reaches the item
    FakeEngine e; FakeBackend b; b.signer_ok = false; FakeStore s;
    s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
    const auto r = md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000, s.Store(), &b);
    Check(!r.pending_verifier(), "a signer mismatch refuses");
    Check(b.consumes == 0, "a wrong signer never decrypts");
  }
}

void ThreeWrongPasswordsLockOutThroughTheProductionPath() {
  md::AutoUnlockAttemptState ledger;
  for (int attempt = 1; attempt <= md::kAutoUnlockMaxAttempts; ++attempt) {
    FakeEngine e; e.verdict = md::AutoUnlockMechanismVerdict::kDeny;
    FakeBackend b; FakeStore s;
    // A FRESH authority per attempt, exactly as the gateway mints one per
    // route. Reusing one nonce across attempts is (correctly) refused as a
    // replay -- that is what the ledger's last_nonce exists to stop.
    s.Put(kUid, kAsid,
          md::SerializeAutoUnlockAuthority(
              Authority(1'000, "nonce-" + std::to_string(attempt))));
    const auto submitted =
        md::RunAutoUnlockSubmitMechanism(e, Observation(), ledger, 1'000, s.Store(), &b);
    Check(submitted.pending_verifier(), "each wrong password still reaches the verifier");
    const auto settled = md::RunAutoUnlockSettleMechanism(e, submitted.next_state, 1'000);
    Check(settled.disposition == md::AutoUnlockMechanismDisposition::kDeny, "deny propagates");
    ledger = settled.next_state;
    Check(ledger.attempts == attempt, "a denied verdict keeps the attempt spent");
  }
  Check(ledger.locked_out_until_ms > 0, "three wrong passwords reach the lockout");

  FakeEngine e; FakeBackend b; FakeStore s;
    s.Put(kUid, kAsid,
          md::SerializeAutoUnlockAuthority(Authority(1'000, "nonce-after")));
  const auto refused =
      md::RunAutoUnlockSubmitMechanism(e, Observation(), ledger, ledger.locked_out_until_ms - 1,
                                       s.Store(), &b);
  Check(!refused.pending_verifier(), "the earned lockout is enforced by submit");
  Check(b.consumes == 0, "a locked-out submit never decrypts the credential");
}

void SuppressedSettleIsNotAFreeRetry() {
  FakeEngine e; e.verdict = md::AutoUnlockMechanismVerdict::kUndetermined;
  FakeBackend b; FakeStore s;
  s.Put(kUid, kAsid, md::SerializeAutoUnlockAuthority(Authority(1'000)));
  const auto submitted =
      md::RunAutoUnlockSubmitMechanism(e, Observation(), {}, 1'000, s.Store(), &b);
  const auto settled = md::RunAutoUnlockSettleMechanism(e, submitted.next_state, 1'000);
  Check(settled.next_state.attempts == 1, "an unanswered verifier still spends the attempt");
  Check(settled.disposition == md::AutoUnlockMechanismDisposition::kDeny,
        "an undetermined verdict denies");
  Check(e.context.empty(), "settle clears context even when no verdict arrived");
}

void AuthorityCarriesNoCredential() {
  const std::string serialized = md::SerializeAutoUnlockAuthority(Authority(1'000));
  Check(serialized.find("hunter2") == std::string::npos, "no password in the authority record");
  Check(serialized.find("password") == std::string::npos, "no password field at all");
  Check(serialized.size() <= md::kAutoUnlockAuthorityMaxBytes, "the record is bounded");
  // A record whose fields contain the separator would re-parse differently.
  auto hostile = Authority(1'000);
  hostile.enrolled.local_user_name = "alice\nroot";
  Check(md::SerializeAutoUnlockAuthority(hostile).empty(),
        "a field containing the separator refuses to serialize");
}

// Regression: the plug-in host used to call settle for its side effects and
// throw the returned state away, while submit persisted the spent attempt.
// The ledger was therefore monotonic and a user who unlocked SUCCESSFULLY
// kAutoUnlockMaxAttempts times was locked out of their own machine. This models
// the host's load -> run -> store loop; discarding either store fails it.
void SuccessfulUnlocksNeverAccumulateLockout() {
  md::AutoUnlockAttemptState ledger;  // the persisted file, modelled
  std::int64_t now = 1'000'000;

  for (int round = 0; round < md::kAutoUnlockMaxAttempts + 2; ++round) {
    // submit spends one attempt and persists it, exactly as MechanismInvoke does
    ledger.attempts += 1;
    Check(ledger.locked_out_until_ms <= now,
          "a successful unlock round must not start locked out");

    // settle: verifier accepted -> host stores the SETTLED state
    FakeEngine engine;
    engine.verdict = md::AutoUnlockMechanismVerdict::kAllow;
    const md::AutoUnlockSettleOutcome outcome =
        md::RunAutoUnlockSettleMechanism(engine, ledger, now);
    ledger = outcome.next_state;  // <-- the line whose absence was the bug

    Check(ledger.attempts == 0,
          "an accepted verdict must clear the persisted attempt counter");
    now += 5'000;
  }
  Check(ledger.locked_out_until_ms == 0,
        "repeated SUCCESSFUL unlocks must never produce a lockout");
}

// submit's `locked` observation is not derived inside the plug-in -- a mechanism
// is never told which right invoked it. It is sound only because every right the
// plug-in may be registered into is lock-bearing. Pin that invariant here so a
// later registration into a non-lock right breaks this test instead of silently
// turning the guard into a lie.
void RegistrationTargetsOnlyLockBearingRights() {
  Check(md::IsAutoUnlockLockBearingRight(md::kAutoUnlockRightLoginConsole),
        "system.login.console must be lock-bearing");
  Check(md::IsAutoUnlockLockBearingRight(md::kAutoUnlockRightScreensaver),
        "system.login.screensaver must be lock-bearing");
  for (const char* other : {"system.login.done", "system.preferences",
                            "com.apple.trust-settings.admin", "", "system.login"}) {
    Check(!md::IsAutoUnlockLockBearingRight(other),
          "a right outside the lock-bearing set must be refused");
  }
}
// Replay at the SUBMIT boundary, not merely "the two nonces are equal". The
// store test compared strings and therefore did not notice when the refusal was
// deleted outright.
void AReplayedNonceIsRefusedBySubmitWithoutTouchingTheKeychain() {
  md::AutoUnlockAttemptState ledger;
  FakeEngine first; first.verdict = md::AutoUnlockMechanismVerdict::kDeny;
  FakeBackend backend; FakeStore store;
  store.Put(kUid, kAsid,
            md::SerializeAutoUnlockAuthority(Authority(1'000, "reused")));
  const auto submitted = md::RunAutoUnlockSubmitMechanism(
      first, Observation(), ledger, 1'000, store.Store(), &backend);
  Check(submitted.pending_verifier(), "the first use of a nonce is accepted");
  ledger = submitted.next_state;
  Check(ledger.last_nonce == "reused", "the spent nonce is recorded in the ledger");
  const int consumes_after_first = backend.consumes;

  // Same nonce again -- a record restored from a copy or recovered after a crash.
  FakeEngine second; FakeBackend backend2; FakeStore store2;
  store2.Put(kUid, kAsid,
             md::SerializeAutoUnlockAuthority(Authority(1'000, "reused")));
  const auto replayed = md::RunAutoUnlockSubmitMechanism(
      second, Observation(), ledger, 1'000, store2.Store(), &backend2);
  Check(!replayed.pending_verifier(), "a replayed nonce never reaches the verifier");
  Check(backend2.consumes == 0,
        "a replayed nonce never decrypts the credential");
  Check(consumes_after_first > 0,
        "...while the first, legitimate use did reach the backend");
  Check(replayed.next_state.attempts == ledger.attempts,
        "a refused replay does not spend a further attempt");

  // A DIFFERENT nonce on the same ledger is still allowed.
  FakeEngine third; third.verdict = md::AutoUnlockMechanismVerdict::kDeny;
  FakeBackend backend3; FakeStore store3;
  store3.Put(kUid, kAsid,
             md::SerializeAutoUnlockAuthority(Authority(1'000, "fresh")));
  Check(md::RunAutoUnlockSubmitMechanism(third, Observation(), ledger, 1'000,
                                         store3.Store(), &backend3)
            .pending_verifier(),
        "a fresh nonce on the same ledger still proceeds");
}

}  // namespace

int main() {
  HappyPathIsPendingNotUnlocked();
  UnlockedSessionNeverConsumesAuthorityOrKeychain();
  MissingAuthorityRefusesBeforeKeychain();
  AuthorityIsSingleConsume();
  CrossSessionAndCrossGenerationRefused();
  ExpiredAuthorityRefused();
  KeychainDeniedAndPartialWriteLeaveNothing();
  ThreeWrongPasswordsLockOutThroughTheProductionPath();
  SuppressedSettleIsNotAFreeRetry();
  AuthorityCarriesNoCredential();
  AReplayedNonceIsRefusedBySubmitWithoutTouchingTheKeychain();
  SuccessfulUnlocksNeverAccumulateLockout();
  RegistrationTargetsOnlyLockBearingRights();
  if (g_failures != 0) { std::printf("%d submit counterfactual(s) failed\n", g_failures); return 1; }
  std::printf("macos auto unlock submit counterfactual ok\n");
  return 0;
}
