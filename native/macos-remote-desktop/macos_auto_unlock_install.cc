#include "macos_auto_unlock_install.h"

namespace imcodes::remote_desktop::macos {

AutoUnlockInstallResult InstallAutoUnlockAuthorization(
    const AutoUnlockInstallRequest& request,
    const AutoUnlockPluginInspector& inspector,
    const AuthorizationRightStore& store,
    const std::vector<AuthorizationRightDefinition>& desired) {
  AutoUnlockInstallResult result;

  // Identity first, always. A refusal here must leave the AuthorizationDB
  // untouched, so nothing below may run before this settles.
  result.identity = InspectAutoUnlockPluginIdentity(
      request.layout, request.acl_designated_requirement, inspector);
  if (!result.identity.qualified()) {
    result.status = AutoUnlockInstallStatus::kRefusedIdentity;
    result.error = result.identity.error.empty()
                       ? "plug-in identity is not qualified"
                       : result.identity.error;
    return result;
  }

  const AuthorizationRightTransactionResult applied =
      ApplyAuthorizationRights(desired, store);
  result.snapshot = applied.snapshot;
  result.created = applied.created;
  if (applied.applied()) {
    result.status = AutoUnlockInstallStatus::kInstalled;
    return result;
  }
  result.error = applied.error;
  result.status =
      applied.status == AuthorizationRightTransactionStatus::kRollbackFailed
          ? AutoUnlockInstallStatus::kRightsRollbackFailed
          : AutoUnlockInstallStatus::kRightsRolledBack;
  return result;
}

AuthorizationRightTransactionResult UninstallAutoUnlockAuthorization(
    const std::vector<AuthorizationRightDefinition>& snapshot,
    const std::vector<std::string>& created,
    const AuthorizationRightStore& store) {
  // Deliberately does NOT re-check identity: a bundle that has been tampered
  // with or removed must still be uninstallable, or a broken plug-in would
  // become permanently wired into the login path.
  return RestoreAuthorizationRights(snapshot, created, store);
}

}  // namespace imcodes::remote_desktop::macos
