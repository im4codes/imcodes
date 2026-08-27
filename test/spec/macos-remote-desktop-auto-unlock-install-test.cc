// Counterfactuals for plug-in identity, ACL targeting and the install/uninstall
// transaction. Fixture paths only; no system installation, no keychain, no
// AuthorizationDB mutation.
#include "macos_auto_unlock_install.h"
#include "macos_auto_unlock_plugin.h"

#include <algorithm>
#include <cstdio>
#include <map>
#include <set>
#include <string>

namespace md = imcodes::remote_desktop::macos;
namespace {
int g_failures = 0;
void Check(bool c, const char* what) { if (!c) { std::printf("FAIL: %s\n", what); ++g_failures; } }

const char kPluginRequirement[] =
    "identifier \"to.aidesk.remote-desktop.autounlock\" and anchor apple generic";
const char kLaunchAgentRequirement[] =
    "identifier \"to.aidesk.remote-desktop.agent\" and anchor apple generic";

struct FakeBundle {
  std::set<std::string> files;
  std::string bundle_identifier = md::kAutoUnlockPluginBundleIdentifier;
  bool signed_bundle = true;
  std::string requirement = kPluginRequirement;

  static md::AutoUnlockPluginLayout Layout() {
    return md::AutoUnlockPluginLayout::ForBundle("/fixture/aiDeskAutoUnlock.bundle");
  }
  void Populate() {
    const auto layout = Layout();
    files.insert(layout.info_plist_path);
    files.insert(layout.executable_path);
  }
  md::AutoUnlockPluginInspector Inspector() {
    md::AutoUnlockPluginInspector i;
    i.file_exists = [this](const std::string& p) { return files.count(p) != 0; };
    i.read_bundle_identifier = [this](const std::string&) -> std::optional<std::string> {
      return bundle_identifier.empty() ? std::nullopt
                                       : std::optional<std::string>(bundle_identifier);
    };
    i.read_designated_requirement = [this](const std::string&) -> std::optional<std::string> {
      return signed_bundle ? std::optional<std::string>(requirement) : std::nullopt;
    };
    return i;
  }
};

struct FakeRights {
  std::map<std::string, std::string> rights;
  int writes = 0;
  std::string corrupt_for;
  md::AuthorizationRightStore Store() {
    md::AuthorizationRightStore s;
    s.read = [this](const std::string& n) -> std::optional<std::string> {
      const auto f = rights.find(n);
      return f == rights.end() ? std::nullopt : std::optional<std::string>(f->second);
    };
    s.write = [this](const std::string& n, const std::string& v, std::string*) {
      ++writes; rights[n] = (n == corrupt_for) ? v + "-corrupt" : v; return true;
    };
    s.remove = [this](const std::string& n, std::string*) { rights.erase(n); return true; };
    return s;
  }
};

const std::vector<md::AuthorizationRightDefinition> Desired() {
  return {{md::kAutoUnlockRightLoginConsole, "<console/>"},
          {md::kAutoUnlockRightScreensaver, "<saver/>"}};
}

md::AutoUnlockInstallRequest Request(const std::string& acl) {
  md::AutoUnlockInstallRequest r;
  r.layout = FakeBundle::Layout();
  r.acl_designated_requirement = acl;
  return r;
}

void QualifiedPluginInstalls() {
  FakeBundle bundle; bundle.Populate();
  FakeRights rights;
  const auto result = md::InstallAutoUnlockAuthorization(
      Request(kPluginRequirement), bundle.Inspector(), rights.Store(), Desired());
  Check(result.installed(), "a signed, matching plug-in installs");
  Check(result.identity.qualified(), "identity qualifies");
  Check(result.created.size() == 2, "absent rights are recorded as created");
}

void AclStillPointingAtLaunchAgentIsRefused() {
  // The exact misconfiguration that would let anything running as the agent
  // read the System-keychain credential.
  FakeBundle bundle; bundle.Populate();
  FakeRights rights;
  const auto result = md::InstallAutoUnlockAuthorization(
      Request(kLaunchAgentRequirement), bundle.Inspector(), rights.Store(), Desired());
  Check(!result.installed(), "an ACL naming the LaunchAgent is refused");
  Check(result.identity.status == md::AutoUnlockPluginIdentityStatus::kIdentifierDrift,
        "the refusal is identifier drift, named exactly");
  Check(rights.writes == 0, "a refused identity never touches a single right");
}

void UnsignedBundleIsRefusedNotFabricated() {
  FakeBundle bundle; bundle.Populate(); bundle.signed_bundle = false;
  FakeRights rights;
  const auto result = md::InstallAutoUnlockAuthorization(
      Request(kPluginRequirement), bundle.Inspector(), rights.Store(), Desired());
  Check(!result.installed(), "an unsigned bundle does not install");
  Check(result.identity.status == md::AutoUnlockPluginIdentityStatus::kUnsigned,
        "unsigned is reported as unsigned, not invented as qualified");
  Check(result.identity.designated_requirement.empty(),
        "no requirement string is fabricated for an unsigned bundle");
  Check(rights.writes == 0, "an unsigned bundle never touches a right");
}

void IdentifierDriftIsRefused() {
  FakeBundle bundle; bundle.Populate();
  bundle.bundle_identifier = "to.aidesk.remote-desktop.autounlock.evil";
  FakeRights rights;
  const auto result = md::InstallAutoUnlockAuthorization(
      Request(kPluginRequirement), bundle.Inspector(), rights.Store(), Desired());
  Check(result.identity.status == md::AutoUnlockPluginIdentityStatus::kIdentifierDrift,
        "a bundle id that differs from the compiled id is drift");
  Check(rights.writes == 0, "drift never touches a right");
}

void MissingBundleFileIsRefused() {
  FakeBundle bundle; bundle.Populate();
  bundle.files.erase(FakeBundle::Layout().executable_path);
  FakeRights rights;
  const auto result = md::InstallAutoUnlockAuthorization(
      Request(kPluginRequirement), bundle.Inspector(), rights.Store(), Desired());
  Check(result.identity.status == md::AutoUnlockPluginIdentityStatus::kIncompleteLayout,
        "a bundle missing its executable cannot qualify");
  Check(rights.writes == 0, "an incomplete bundle never touches a right");
}

void RightsReadbackMismatchRollsBackFromTheEntryPoint() {
  FakeBundle bundle; bundle.Populate();
  FakeRights rights;
  rights.rights[md::kAutoUnlockRightLoginConsole] = "<old-console/>";
  rights.rights[md::kAutoUnlockRightScreensaver] = "<old-saver/>";
  rights.corrupt_for = md::kAutoUnlockRightLoginConsole;
  const auto result = md::InstallAutoUnlockAuthorization(
      Request(kPluginRequirement), bundle.Inspector(), rights.Store(), Desired());
  Check(result.status == md::AutoUnlockInstallStatus::kRightsRolledBack,
        "a read-back mismatch rolls back through the production entry point");
  Check(rights.rights[md::kAutoUnlockRightScreensaver] == "<old-saver/>",
        "the untouched right keeps its prior definition");
}

void DisableRestoresPriorDefinitions() {
  FakeBundle bundle; bundle.Populate();
  FakeRights rights;
  rights.rights[md::kAutoUnlockRightLoginConsole] = "<old-console keys=all/>";
  rights.rights[md::kAutoUnlockRightScreensaver] = "<old-saver keys=all/>";
  const auto installed = md::InstallAutoUnlockAuthorization(
      Request(kPluginRequirement), bundle.Inspector(), rights.Store(), Desired());
  Check(installed.installed(), "install succeeds");
  const auto restored = md::UninstallAutoUnlockAuthorization(
      installed.snapshot, installed.created, rights.Store());
  Check(restored.status == md::AuthorizationRightTransactionStatus::kRolledBack,
        "disable restores");
  Check(rights.rights[md::kAutoUnlockRightLoginConsole] == "<old-console keys=all/>",
        "the prior definition returns byte-identical");
}

void UninstallWorksEvenWhenTheBundleIsGone() {
  // A tampered or deleted bundle must still be uninstallable, or a broken
  // plug-in stays wired into the login path forever.
  FakeBundle bundle; bundle.Populate();
  FakeRights rights;
  rights.rights[md::kAutoUnlockRightLoginConsole] = "<old-console/>";
  rights.rights[md::kAutoUnlockRightScreensaver] = "<old-saver/>";
  const auto installed = md::InstallAutoUnlockAuthorization(
      Request(kPluginRequirement), bundle.Inspector(), rights.Store(), Desired());
  Check(installed.installed(), "install succeeds");
  bundle.files.clear();  // bundle deleted from disk
  const auto restored = md::UninstallAutoUnlockAuthorization(
      installed.snapshot, installed.created, rights.Store());
  Check(restored.status == md::AuthorizationRightTransactionStatus::kRolledBack,
        "uninstall does not depend on the bundle still existing");
  Check(rights.rights[md::kAutoUnlockRightLoginConsole] == "<old-console/>",
        "prior definitions still return");
}

void MechanismListPutsAppleBetweenOurs() {
  const auto list = md::AutoUnlockMechanismList();
  Check(list.size() == 3, "exactly three mechanisms");
  Check(list[0] == md::kAutoUnlockMechanismSubmit, "submit first");
  Check(list[1] == md::kAutoUnlockMechanismBuiltinAuthenticate,
        "Apple's verifier sits between ours");
  Check(list[2] == md::kAutoUnlockMechanismSettle, "settle last");
}
}  // namespace

int main() {
  QualifiedPluginInstalls();
  AclStillPointingAtLaunchAgentIsRefused();
  UnsignedBundleIsRefusedNotFabricated();
  IdentifierDriftIsRefused();
  MissingBundleFileIsRefused();
  RightsReadbackMismatchRollsBackFromTheEntryPoint();
  DisableRestoresPriorDefinitions();
  UninstallWorksEvenWhenTheBundleIsGone();
  MechanismListPutsAppleBetweenOurs();
  if (g_failures != 0) { std::printf("%d install counterfactual(s) failed\n", g_failures); return 1; }
  std::printf("macos auto unlock install counterfactual ok\n");
  return 0;
}
