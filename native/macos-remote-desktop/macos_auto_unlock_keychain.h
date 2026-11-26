// Classic file-keychain credential store for automatic unlock.
//
// Deliberately the *classic* `SecKeychain*` API against
// /Library/Keychains/System.keychain rather than the modern data-protection
// `SecItem*` API. Only the file keychain supports a per-item ACL naming a
// trusted application, which is the whole mechanism this feature relies on: the
// credential must be readable by exactly one signed binary and by nothing else,
// including root-run tools that are not that binary.
//
// The API is deprecated by Apple. That is accepted knowingly: the replacement
// has no equivalent of "only this signed code may read this item", so moving to
// it would mean widening the ACL, which is the opposite of the requirement.
//
// Nothing here returns the credential. `ConsumeSystemKeychainCredential` hands a
// bounded span to a callback and zeroes the buffer as the callback returns.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_KEYCHAIN_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_KEYCHAIN_H_

#include <cstddef>
#include <string>

#include "macos_auto_unlock_controller.h"

namespace imcodes::remote_desktop::macos {

/** The one keychain this feature will touch. Never the login keychain. */
inline constexpr char kSystemKeychainPath[] = "/Library/Keychains/System.keychain";

/** Why an enrolment refused. Never distinguishes "exists" from "denied". */
enum class AutoUnlockEnrollmentStatus {
  kOk,
  /** The agent path does not satisfy the configured designated requirement. */
  kSignerRejected,
  /** The path is not the System keychain, or a field was out of bounds. */
  kInvalidReference,
  /** Keychain refused the operation. Deliberately coarse. */
  kStoreFailed,
};

/**
 * Enrols one generic-password item.
 *
 * Order matters and is enforced here rather than by the caller:
 *   1. the reference is checked to be the System keychain,
 *   2. the agent at `agent_path` is verified against
 *      `reference.designated_requirement` with Security.framework,
 *   3. only then is an ACL created naming that exact binary,
 *   4. and only then is the item written.
 *
 * Step 2 before step 3 is the point: creating the ACL first and validating
 * afterwards would leave a window in which a broad item exists on disk.
 *
 * `secret`/`secret_length` are consumed in-process and zeroed before returning.
 * The caller must have obtained them locally; nothing in this header accepts a
 * path, a file descriptor or a socket from which they could have been read.
 */
[[nodiscard]] AutoUnlockEnrollmentStatus EnrollSystemKeychainCredential(
    const AutoUnlockCredentialReference& reference,
    const std::string& agent_path,
    char* secret,
    std::size_t secret_length);

/** Deletes the item. Missing and denied both report `kStoreFailed`. */
[[nodiscard]] AutoUnlockEnrollmentStatus DeleteSystemKeychainCredential(
    const AutoUnlockCredentialReference& reference);

/**
 * Reads the item and hands it to `consumer` as a bounded span.
 *
 * Returns false for a missing item and for an ACL denial alike. The buffer is
 * zeroed as `consumer` returns, including when it returns false.
 */
[[nodiscard]] bool ConsumeSystemKeychainCredential(
    const AutoUnlockCredentialReference& reference,
    const AutoUnlockCredentialConsumer& consumer);

/**
 * Whether `agent_path` satisfies `requirement`.
 *
 * Thin wrapper over SecStaticCodeCreateWithPath + SecRequirementCreateWithString
 * + SecStaticCodeCheckValidity, exposed so enrolment and the runtime backend
 * cannot drift apart on what "the right signer" means.
 */
[[nodiscard]] bool AgentSatisfiesDesignatedRequirement(
    const std::string& agent_path, const std::string& requirement);

/** Security.framework-backed backend for `RunAutoUnlockAttempt`. */
class SystemKeychainCredentialBackend final
    : public AutoUnlockCredentialBackend {
 public:
  explicit SystemKeychainCredentialBackend(std::string agent_path)
      : agent_path_(std::move(agent_path)) {}

  [[nodiscard]] bool ConsumeCredential(
      const AutoUnlockCredentialReference& reference,
      const AutoUnlockCredentialConsumer& consumer) override;

  [[nodiscard]] bool VerifySigner(
      const AutoUnlockCredentialReference& reference) override;

 private:
  std::string agent_path_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_AUTO_UNLOCK_KEYCHAIN_H_
