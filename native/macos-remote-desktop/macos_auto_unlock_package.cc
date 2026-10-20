#include "macos_auto_unlock_package.h"

#include "macos_auto_unlock_plugin.h"

namespace imcodes::remote_desktop::macos {

AutoUnlockPluginLayout AutoUnlockPluginLayout::ForBundle(
    const std::string& bundle_path) {
  AutoUnlockPluginLayout layout;
  layout.bundle_path = bundle_path;
  layout.info_plist_path = bundle_path + "/Contents/Info.plist";
  layout.executable_path =
      bundle_path + "/Contents/MacOS/" + kAutoUnlockPluginExecutableName;
  return layout;
}

bool AutoUnlockPluginInspector::IsComplete() const noexcept {
  return file_exists && read_bundle_identifier && read_designated_requirement;
}

AutoUnlockPluginIdentity InspectAutoUnlockPluginIdentity(
    const AutoUnlockPluginLayout& layout,
    const std::string& expected_acl_requirement,
    const AutoUnlockPluginInspector& inspector) {
  AutoUnlockPluginIdentity identity;
  if (!inspector.IsComplete() || layout.bundle_path.empty()) {
    identity.status = AutoUnlockPluginIdentityStatus::kIncompleteLayout;
    identity.error = "plug-in inspector or layout is incomplete";
    return identity;
  }
  // A bundle missing either file cannot load, so there is nothing to qualify.
  for (const std::string& path :
       {layout.info_plist_path, layout.executable_path}) {
    if (!inspector.file_exists(path)) {
      identity.status = AutoUnlockPluginIdentityStatus::kIncompleteLayout;
      identity.error = "plug-in bundle is missing " + path;
      return identity;
    }
  }

  const std::optional<std::string> bundle_identifier =
      inspector.read_bundle_identifier(layout.info_plist_path);
  if (!bundle_identifier.has_value() || bundle_identifier->empty()) {
    identity.status = AutoUnlockPluginIdentityStatus::kIncompleteLayout;
    identity.error = "plug-in bundle has no CFBundleIdentifier";
    return identity;
  }
  identity.bundle_identifier = *bundle_identifier;

  // Drift between the shipped bundle and the identifier compiled into the host
  // means the loaded code is not the code this build believes it is.
  if (*bundle_identifier != kAutoUnlockPluginBundleIdentifier) {
    identity.status = AutoUnlockPluginIdentityStatus::kIdentifierDrift;
    identity.error = "bundle identifier does not match the compiled plug-in id";
    return identity;
  }

  const std::optional<std::string> requirement =
      inspector.read_designated_requirement(layout.bundle_path);
  if (!requirement.has_value() || requirement->empty()) {
    // Structurally fine, deliberately not qualified. No fabricated identity.
    identity.status = AutoUnlockPluginIdentityStatus::kUnsigned;
    identity.error = "plug-in bundle is unsigned; signing is a manual gate";
    return identity;
  }
  identity.designated_requirement = *requirement;

  // The decisive check. An ACL naming anything else -- most importantly the
  // LaunchAgent -- must never reach the credential.
  if (expected_acl_requirement.empty() ||
      expected_acl_requirement != *requirement) {
    identity.status = AutoUnlockPluginIdentityStatus::kIdentifierDrift;
    identity.error =
        "System keychain ACL does not name the plug-in designated requirement";
    return identity;
  }

  identity.status = AutoUnlockPluginIdentityStatus::kQualified;
  return identity;
}

std::vector<std::string> AutoUnlockMechanismList() {
  return {kAutoUnlockMechanismSubmit, kAutoUnlockMechanismBuiltinAuthenticate,
          kAutoUnlockMechanismSettle};
}

}  // namespace imcodes::remote_desktop::macos
