#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PROVISION_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PROVISION_H_

#include <cstdint>
#include <string>

#include "macos_auto_unlock_paths.h"

namespace imcodes::remote_desktop::macos {

enum class AutoUnlockProvisionStatus {
  kProvisioned,
  /** Provisioning is privileged; nothing unprivileged may create this tree. */
  kRefusedNotRoot,
  /** Something already occupies the path and is not safe to adopt. */
  kRefusedUnsafeExisting,
  kFailed,
};

struct AutoUnlockProvisionResult {
  AutoUnlockProvisionStatus status = AutoUnlockProvisionStatus::kFailed;
  std::string path;

  [[nodiscard]] bool provisioned() const noexcept {
    return status == AutoUnlockProvisionStatus::kProvisioned;
  }
};

/**
 * Creates the root-owned 0700 state directory, idempotently.
 *
 * Called on every production issue attempt, not only at install: a missing
 * directory must never turn into a silent permanent refusal. First boot, a
 * wiped /var/db, or an admin deleting the directory all self-heal here.
 *
 * Adoption is deliberately picky. An existing path that is a symlink, is not a
 * directory, or is owned by anyone other than root is REFUSED rather than
 * repaired: chmod-ing an attacker-created directory into place would bless
 * whatever they already left inside it.
 *
 * `effective_uid` is explicit so the privilege requirement is provable in a temp
 * directory without running the suite as root.
 */
[[nodiscard]] AutoUnlockProvisionResult ProvisionAutoUnlockStateDirectory(
    const std::string& base_directory, AutoUnlockStoreIdentity identity);

/** Removes a user's authority and ledger. Un-enrolment must not leave a
 *  consumable authority behind. */
[[nodiscard]] bool RevokeAutoUnlockUserState(const std::string& base_directory,
                                             std::uint32_t enrolled_uid,
                                             AutoUnlockStoreIdentity identity);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PROVISION_H_
