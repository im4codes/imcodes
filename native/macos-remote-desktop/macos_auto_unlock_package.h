// Bundle layout and code identity for the auto-unlock Authorization Plug-in.
//
// The plug-in is the ONLY component allowed to read the System-keychain item, so
// its identity is a security boundary rather than packaging trivia. Three things
// must agree: the bundle's CFBundleIdentifier, the identifier compiled into the
// plug-in host, and the identifier named by the keychain ACL's designated
// requirement. Any disagreement means the credential could be read by something
// other than the code we intended, so drift is refused rather than reported.
//
// Nothing here fabricates a Developer ID. An unsigned or ad-hoc build produces a
// layout that is structurally correct and explicitly NOT qualified; only a real
// signing pass can supply the requirement string.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PACKAGE_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PACKAGE_H_

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace imcodes::remote_desktop::macos {

inline constexpr char kAutoUnlockPluginBundleIdentifier[] =
    "to.aidesk.remote-desktop.autounlock";
inline constexpr char kAutoUnlockPluginBundleName[] = "aiDeskAutoUnlock";
inline constexpr char kAutoUnlockPluginExecutableName[] = "aiDeskAutoUnlock";
/** Where macOS loads authorization plug-ins from. Never written by this code. */
inline constexpr char kAutoUnlockPluginInstallDirectory[] =
    "/Library/Security/SecurityAgentPlugins";

/** Files a loadable plug-in bundle must contain to be usable at all. */
struct AutoUnlockPluginLayout {
  std::string bundle_path;
  std::string info_plist_path;
  std::string executable_path;

  [[nodiscard]] static AutoUnlockPluginLayout ForBundle(
      const std::string& bundle_path);
};

enum class AutoUnlockPluginIdentityStatus {
  kQualified,        // signed, and every identifier agrees
  kUnsigned,         // structurally valid, deliberately NOT qualified
  kIdentifierDrift,  // bundle id != compiled id, or != ACL requirement
  kIncompleteLayout, // a required file is missing
};

struct AutoUnlockPluginIdentity {
  AutoUnlockPluginIdentityStatus status =
      AutoUnlockPluginIdentityStatus::kIncompleteLayout;
  std::string bundle_identifier;
  /** Exact designated requirement, present only when signed. */
  std::string designated_requirement;
  std::string error;

  [[nodiscard]] bool qualified() const noexcept {
    return status == AutoUnlockPluginIdentityStatus::kQualified;
  }
};

/** Filesystem and codesign facts, seamed so fixtures replace the real OS. */
struct AutoUnlockPluginInspector {
  std::function<bool(const std::string& path)> file_exists;
  /** CFBundleIdentifier read from the bundle's Info.plist. */
  std::function<std::optional<std::string>(const std::string& info_plist_path)>
      read_bundle_identifier;
  /** Designated requirement, or nullopt when unsigned/ad-hoc. */
  std::function<std::optional<std::string>(const std::string& bundle_path)>
      read_designated_requirement;

  [[nodiscard]] bool IsComplete() const noexcept;
};

/**
 * Resolves the plug-in's identity.
 *
 * `expected_acl_requirement` is what the System-keychain ACL currently names. It
 * is compared here because an ACL still pointing at the LaunchAgent is exactly
 * the misconfiguration that would let any code running as that agent read the
 * credential; passing it in makes that a detectable state rather than an
 * assumption.
 */
[[nodiscard]] AutoUnlockPluginIdentity InspectAutoUnlockPluginIdentity(
    const AutoUnlockPluginLayout& layout,
    const std::string& expected_acl_requirement,
    const AutoUnlockPluginInspector& inspector);

/**
 * The right definition the installer applies, built from the plug-in identity.
 *
 * Apple's verifier is placed BETWEEN our two mechanisms. Any other order means
 * `settle` reads a verdict that does not exist yet, and the ledger would clear
 * on submission -- the lockout bypass.
 */
[[nodiscard]] std::vector<std::string> AutoUnlockMechanismList();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_PACKAGE_H_
