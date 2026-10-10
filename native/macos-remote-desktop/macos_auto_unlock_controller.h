// Generation/user/session-bound automatic-unlock controller.
//
// This is the decision half, kept free of Security.framework and of any Apple
// header so it can be linked and sanitized without a real keychain, a real
// login window or a signing identity. The keychain half lives behind
// `AutoUnlockCredentialBackend` and is faked in tests.
//
// Semantics mirror `src/node/macos-remote-desktop-auto-unlock.ts` exactly. Two
// copies of a security decision is a liability, so the native side is pinned to
// the TypeScript one by a contract test rather than by prose.
//
// Nothing here can hold a credential. `ConsumeCredential` hands a bounded span
// to a callback and the backend zeroes it as the callback returns; there is no
// getter, no member and no return path that carries the bytes.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_CONTROLLER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_CONTROLLER_H_

#include <cstdint>
#include <functional>
#include <string>
#include <string_view>

namespace imcodes::remote_desktop::macos {

/** Policy modes. Values match the TypeScript contract byte for byte. */
inline constexpr char kAutoUnlockPolicyDisabled[] = "disabled";
inline constexpr char kAutoUnlockPolicyLoginWindowOnly[] = "loginwindow_only";
inline constexpr char kAutoUnlockPolicyAlways[] = "always";

/** Surfaces. `filevault_preboot` exists only so it can be refused by name. */
inline constexpr char kAutoUnlockSurfaceLoginWindow[] = "login_window";
inline constexpr char kAutoUnlockSurfaceLockedSession[] = "locked_session";
inline constexpr char kAutoUnlockSurfaceFileVaultPreboot[] = "filevault_preboot";

/** Refusal reasons, mirrored from the TypeScript contract. */
inline constexpr char kAutoUnlockRefusalPolicyDisabled[] = "policy_disabled";
inline constexpr char kAutoUnlockRefusalSurfaceNotPermitted[] =
    "surface_not_permitted";
inline constexpr char kAutoUnlockRefusalFileVaultPrebootUnsupported[] =
    "filevault_preboot_unsupported";
inline constexpr char kAutoUnlockRefusalSignerMismatch[] = "signer_mismatch";
inline constexpr char kAutoUnlockRefusalUserMismatch[] = "user_mismatch";
inline constexpr char kAutoUnlockRefusalSessionMismatch[] = "session_mismatch";
inline constexpr char kAutoUnlockRefusalGenerationMismatch[] =
    "generation_mismatch";
inline constexpr char kAutoUnlockRefusalCredentialUnavailable[] =
    "credential_unavailable";
inline constexpr char kAutoUnlockRefusalAttemptsExhausted[] =
    "attempts_exhausted";
inline constexpr char kAutoUnlockRefusalLockedOut[] = "locked_out";
inline constexpr char kAutoUnlockRefusalInjectionUnavailable[] =
    "injection_unavailable";

inline constexpr int kAutoUnlockMaxAttempts = 3;
inline constexpr std::int64_t kAutoUnlockLockoutMs = 15 * 60 * 1000;

/** The exact principal one attempt is bound to. */
struct AutoUnlockBinding {
  std::string local_user_name;
  std::uint32_t local_user_uid = 0;
  std::string session_type;
  std::uint32_t audit_session_id = 0;
  std::uint64_t worker_generation = 0;
};

struct AutoUnlockAttemptState {
  int attempts = 0;
  /** Epoch ms when a lockout ends; 0 when not locked out. */
  std::int64_t locked_out_until_ms = 0;
  /** Nonce of the last authority actually spent. Persisted with the ledger so
   *  replay stays refusable across processes and across a crash: unlinking the
   *  authority enforces single-consume only while that one file exists, but a
   *  record restored from a copy would otherwise be spendable a second time. */
  std::string last_nonce;
};

/**
 * Where the credential lives and who may read it.
 *
 * `designated_requirement` is the ACL the item was created with: the exact
 * stable requirement of the signed agent, not a bundle identifier. A bundle id
 * can be claimed by any unsigned binary that writes an Info.plist; the
 * designated requirement pins the signing identity.
 */
struct AutoUnlockCredentialReference {
  std::string keychain_path;
  std::string service;
  std::string account;
  std::string designated_requirement;
};

/**
 * Bounded, in-process credential consumption.
 *
 * The callback receives a span that is valid only for its duration. The backend
 * zeroes the buffer as the callback returns, whether it succeeded or threw.
 * There is deliberately no overload that returns the bytes.
 */
using AutoUnlockCredentialConsumer =
    std::function<bool(const char* bytes, std::size_t length)>;

/** Keychain seam. Faked in tests; the real one is Security.framework. */
class AutoUnlockCredentialBackend {
 public:
  virtual ~AutoUnlockCredentialBackend() = default;

  /**
   * Reads the item and hands it to `consumer`.
   *
   * Returns false for a missing item AND for an ACL denial, on purpose:
   * distinguishing them would tell a caller whether the item exists.
   */
  [[nodiscard]] virtual bool ConsumeCredential(
      const AutoUnlockCredentialReference& reference,
      const AutoUnlockCredentialConsumer& consumer) = 0;

  /** Whether the caller satisfies the reference's designated requirement. */
  [[nodiscard]] virtual bool VerifySigner(
      const AutoUnlockCredentialReference& reference) = 0;
};

/**
 * One-shot unlock injection.
 *
 * Separate from the backend because it is the piece that cannot be verified
 * without a real login window: `Available()` must return false whenever the
 * implementation cannot observe which account surface it would be typing into.
 * Failing closed there is the difference between "did not unlock" and "typed a
 * password into whatever had focus".
 */
class AutoUnlockInjector {
 public:
  virtual ~AutoUnlockInjector() = default;
  [[nodiscard]] virtual bool Available() const = 0;
  [[nodiscard]] virtual bool Inject(const char* bytes, std::size_t length) = 0;
};

struct AutoUnlockRequest {
  std::string policy;
  std::string surface;
  AutoUnlockBinding enrolled;
  AutoUnlockBinding observed;
  AutoUnlockCredentialReference credential;
  AutoUnlockAttemptState state;
  std::int64_t now_ms = 0;
};

/**
 * What one attempt achieved.
 *
 * There is deliberately no "unlocked" value. This code never learns whether the
 * session unlocked: it hands a username and password to Apple's built-in
 * password mechanism as volatile engine context, and that mechanism performs the
 * actual verification out of process. The furthest this side can truthfully
 * report is that the credential reached the verifier.
 */
enum class AutoUnlockAttemptStatus {
  /** Never reached the verifier. `refusal` says why. */
  kRefused,
  /** Copied into volatile authorization context. Result still unknown. */
  kSubmittedToVerifier,
};

struct AutoUnlockOutcome {
  AutoUnlockAttemptStatus status = AutoUnlockAttemptStatus::kRefused;
  /** Empty only when submitted; otherwise the exact refusal token. */
  std::string refusal;
  /**
   * The ledger AFTER this attempt. A submitted attempt is already SPENT here;
   * it is cleared only by `SettleAutoUnlockVerifierResult` on a real acceptance.
   */
  AutoUnlockAttemptState next_state;

  [[nodiscard]] bool submitted_to_verifier() const noexcept {
    return status == AutoUnlockAttemptStatus::kSubmittedToVerifier;
  }
};

/** What Apple's password mechanism reported back through the plug-in. */
enum class AutoUnlockVerifierResult {
  kAccepted,
  kRejected,
  /** No authenticated answer arrived. Treated exactly like a rejection. */
  kIndeterminate,
};

/**
 * Applies an authenticated verifier result to a spent ledger.
 *
 * This exists because submission is not success. Clearing the ledger when the
 * credential was merely copied into context lets a WRONG password reset the
 * attempt counter on every try, so the bound is never reached and lockout never
 * engages. Only `kAccepted` clears it; anything else keeps the attempt spent and
 * starts the lockout once the bound is reached.
 */
[[nodiscard]] AutoUnlockAttemptState SettleAutoUnlockVerifierResult(
    const AutoUnlockAttemptState& submitted_state,
    AutoUnlockVerifierResult result,
    std::int64_t now_ms) noexcept;

/**
 * Runs one bounded attempt.
 *
 * Fail-closed and ordered: FileVault preboot, policy, surface, signer, binding,
 * lockout, injector availability, then finally the credential. The signer is
 * settled before the keychain is touched at all, and injector availability
 * before the credential is read, so a machine that cannot inject never decrypts
 * anything.
 */
[[nodiscard]] AutoUnlockOutcome RunAutoUnlockAttempt(
    const AutoUnlockRequest& request,
    AutoUnlockCredentialBackend* backend,
    AutoUnlockInjector* injector);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_CONTROLLER_H_
