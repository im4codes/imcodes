// Install / disable / uninstall entry point for the auto-unlock plug-in.
//
// This is the production consumer of the transactional right installer. It
// exists so the snapshot/read-back/rollback/restore machinery is reached by a
// real entry point rather than only by tests.
//
// It performs no system installation. The caller supplies the store and the
// inspector, so the same entry point drives a fixture directory in tests and the
// real AuthorizationDB in a signed deployment -- and the ordering guarantees are
// identical in both.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_INSTALL_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_INSTALL_H_

#include <string>
#include <vector>

#include "macos_auto_unlock_package.h"
#include "macos_auto_unlock_rights.h"

namespace imcodes::remote_desktop::macos {

struct AutoUnlockInstallRequest {
  AutoUnlockPluginLayout layout;
  /** What the System-keychain ACL currently names. */
  std::string acl_designated_requirement;
};

enum class AutoUnlockInstallStatus {
  kInstalled,
  kRefusedIdentity,   // unsigned, drifted, or ACL still naming something else
  kRightsRolledBack,
  kRightsRollbackFailed,
};

struct AutoUnlockInstallResult {
  AutoUnlockInstallStatus status = AutoUnlockInstallStatus::kRefusedIdentity;
  AutoUnlockPluginIdentity identity;
  /** Persist verbatim; uninstall cannot be truthful without it. */
  std::vector<AuthorizationRightDefinition> snapshot;
  std::vector<std::string> created;
  std::string error;

  [[nodiscard]] bool installed() const noexcept {
    return status == AutoUnlockInstallStatus::kInstalled;
  }
};

/**
 * Installs the right definitions, but only for a qualified plug-in.
 *
 * Identity is settled BEFORE any right is touched. Registering mechanisms that
 * point at an unsigned or drifted bundle would hand the login path to code whose
 * identity we cannot vouch for, and it would do so by rewriting rights the OS
 * owns. Refusing first means a failed identity check cannot leave the
 * AuthorizationDB modified at all.
 */
[[nodiscard]] AutoUnlockInstallResult InstallAutoUnlockAuthorization(
    const AutoUnlockInstallRequest& request,
    const AutoUnlockPluginInspector& inspector,
    const AuthorizationRightStore& store,
    const std::vector<AuthorizationRightDefinition>& desired);

/** Disable and uninstall are the same operation: restore the exact snapshot. */
[[nodiscard]] AuthorizationRightTransactionResult UninstallAutoUnlockAuthorization(
    const std::vector<AuthorizationRightDefinition>& snapshot,
    const std::vector<std::string>& created,
    const AuthorizationRightStore& store);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_INSTALL_H_
