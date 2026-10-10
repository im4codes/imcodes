// aiDesk auto-unlock Authorization Plug-in: mechanism sequencing and contract.
//
// Apple's engine, not this code, verifies the password. A plug-in cannot ask
// "was it right?" at submission time, because the built-in password mechanism
// has not run yet. The sequence is therefore TWO mechanisms around Apple's:
//
//   aiDeskAutoUnlock:submit   -> copies username/password into VOLATILE engine
//                                context, then allows the engine to continue
//   builtin:authenticate      -> Apple verifies. We never see the plaintext
//                                result path, only its verdict afterwards.
//   aiDeskAutoUnlock:settle   -> reads the verdict, clears BOTH context values,
//                                and feeds the result to the attempt ledger
//
// Without `settle` there is no authenticated verifier result at all, and the
// ledger can only ever be cleared on submission -- which is the lockout bypass
// this file exists to make impossible.
//
// Everything here is free of Apple types so the sequencing, the flag contract
// and the clear-on-every-failure rule are testable without a login window.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PLUGIN_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PLUGIN_H_

#include <cstdint>
#include <string>
#include <string_view>

#include "macos_auto_unlock_authority.h"
#include "macos_auto_unlock_authorization_context.h"

namespace imcodes::remote_desktop::macos {

/** Mechanism identifiers as they appear in the authorization right definition. */
inline constexpr char kAutoUnlockPluginName[] = "aiDeskAutoUnlock";
inline constexpr char kAutoUnlockMechanismSubmit[] = "aiDeskAutoUnlock:submit";
inline constexpr char kAutoUnlockMechanismSettle[] = "aiDeskAutoUnlock:settle";
/** Apple's verifier. It must sit BETWEEN ours, never before or after both. */
inline constexpr char kAutoUnlockMechanismBuiltinAuthenticate[] =
    "builtin:authenticate";

/**
 * Engine context keys. These are Apple's documented environment keys; the
 * built-in mechanism reads exactly these.
 */
inline constexpr char kAutoUnlockContextKeyUsername[] = "username";
inline constexpr char kAutoUnlockContextKeyPassword[] = "password";

/**
 * Context flags, named rather than passed as a bare integer.
 *
 * VOLATILE means the engine keeps the value only for this authorization and
 * never writes it to the credential store or to disk. EXTRACTABLE would let
 * another mechanism -- including one we do not ship -- read the value back out
 * of the engine. Auto-unlock therefore sets volatile and deliberately does NOT
 * set extractable, so the password is write-only from our side.
 */
enum class AutoUnlockContextFlags : std::uint32_t {
  kVolatileNonExtractable = 0x1,
};

/** What Apple's built-in mechanism reported, before it is settled. */
enum class AutoUnlockMechanismVerdict {
  kAllow,
  kDeny,
  /** The engine gave no usable verdict. Never treated as success. */
  kUndetermined,
};

/** What a mechanism tells the engine to do next. */
enum class AutoUnlockMechanismDisposition {
  kAllow,
  kDeny,
};

[[nodiscard]] AutoUnlockVerifierResult VerifierResultForVerdict(
    AutoUnlockMechanismVerdict verdict) noexcept;

/**
 * The engine operations a mechanism performs, behind a seam.
 *
 * `SetContextValue` returning false must abort: a half-populated context would
 * leave a username with no password, which the built-in mechanism would treat
 * as an interactive prompt rather than an auto-unlock.
 */
class AutoUnlockPluginEngine {
 public:
  virtual ~AutoUnlockPluginEngine() = default;
  [[nodiscard]] virtual bool SetContextValue(std::string_view key,
                                             AutoUnlockContextFlags flags,
                                             const char* bytes,
                                             std::size_t length) = 0;
  virtual void ClearContextValue(std::string_view key) noexcept = 0;
  [[nodiscard]] virtual AutoUnlockMechanismVerdict ReadVerdict() = 0;
  virtual void SetDisposition(AutoUnlockMechanismDisposition disposition) = 0;
};

/**
 * Writes into engine context. This is the production replacement for the
 * abstract writer the injector already depends on.
 */
class EnginePluginContextWriter final
    : public AutoUnlockAuthorizationContextWriter {
 public:
  explicit EnginePluginContextWriter(AutoUnlockPluginEngine& engine);

  [[nodiscard]] bool SetVolatileUsername(const char* bytes,
                                         std::size_t length) override;
  [[nodiscard]] bool SetVolatilePassword(const char* bytes,
                                         std::size_t length) override;
  void ClearUsername() noexcept override;
  void ClearPassword() noexcept override;

 private:
  AutoUnlockPluginEngine& engine_;
};

/** Outcome of the settle mechanism, after Apple's verifier has run. */
struct AutoUnlockSettleOutcome {
  AutoUnlockAttemptState next_state;
  AutoUnlockMechanismDisposition disposition =
      AutoUnlockMechanismDisposition::kDeny;
  bool context_cleared = false;
};

/** What the engine could observe about the session asking to unlock. */
struct AutoUnlockSubmitObservation {
  std::uint32_t uid = 0;
  std::uint32_t audit_session_id = 0;
  std::string local_user_name;
  std::string session_type;
  /** False when the session is not actually locked; submitting then would be
   *  handing a password to a session nobody asked to unlock. */
  bool locked = false;
};

enum class AutoUnlockSubmitStatus {
  /** Context populated. The engine may proceed to builtin:authenticate. This is
   *  PENDING, not unlocked: the verifier has not run. */
  kPendingVerifier,
  kRefused,
};

struct AutoUnlockSubmitOutcome {
  AutoUnlockSubmitStatus status = AutoUnlockSubmitStatus::kRefused;
  /** Exact refusal token, or empty when pending. */
  std::string refusal;
  /** Ledger AFTER this attempt; already spent when pending. */
  AutoUnlockAttemptState next_state;
  AutoUnlockMechanismDisposition disposition =
      AutoUnlockMechanismDisposition::kDeny;

  [[nodiscard]] bool pending_verifier() const noexcept {
    return status == AutoUnlockSubmitStatus::kPendingVerifier;
  }
};

/**
 * Runs the submit mechanism.
 *
 * Order is the security property. The one-shot authority is consumed FIRST, so a
 * session with no operator-approved authority never reaches the policy check,
 * let alone the keychain. Identity is compared against what the authority names
 * before anything is decrypted, and `RunAutoUnlockAttempt` then re-checks policy,
 * surface, signer, binding and lockout with the credential still untouched.
 *
 * Allowing here means only "proceed to the verifier". It is never a claim that
 * the session unlocked, and it does not clear the ledger.
 */
[[nodiscard]] AutoUnlockSubmitOutcome RunAutoUnlockSubmitMechanism(
    AutoUnlockPluginEngine& engine,
    const AutoUnlockSubmitObservation& observation,
    const AutoUnlockAttemptState& state,
    std::int64_t now_ms,
    const AutoUnlockAuthorityStore& authority_store,
    AutoUnlockCredentialBackend* backend);

/**
 * Runs the settle mechanism.
 *
 * Clears BOTH context values unconditionally -- on allow, on deny and on an
 * undetermined verdict -- before deciding anything. A password left in engine
 * context after the verifier has finished is readable by every later mechanism
 * in the right's list, including ones we do not control.
 */
[[nodiscard]] AutoUnlockSettleOutcome RunAutoUnlockSettleMechanism(
    AutoUnlockPluginEngine& engine,
    const AutoUnlockAttemptState& submitted_state,
    std::int64_t now_ms);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PLUGIN_H_
