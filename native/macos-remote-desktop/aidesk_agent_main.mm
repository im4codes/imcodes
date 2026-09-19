// The main executable of the signed aiDesk.to application bundle.
//
// Its whole job is to be the process macOS attributes permissions to. Screen
// Recording and Accessibility are granted to a *responsible application*, and
// helpers launched from a root daemon are otherwise attributed to whatever
// started them -- a terminal, launchd, sudo -- so the grant lands on something
// the user never chose and cannot see. Shipping every helper inside one signed
// bundle whose main executable replaces itself with the helper makes that
// responsible application this app, once, for all of them.
//
// Two ways in, and they are the only two:
//
//   Finder or Dock double-click  -> ask for the permissions.
//   Anything else                -> become the helper the arguments name.
//
// Deliberately free of the remote-desktop stack. The onboarding unit needs
// only AppKit and ApplicationServices, so this builds with clang alone on any
// macOS machine; linking the worker's libwebrtc world in here would make the
// app unbuildable without it, for no gain.

#include <sysexits.h>

#include <cstdlib>
#include <iostream>

#include "macos_permission_onboarding.h"

namespace macos = imcodes::remote_desktop::macos;

int main(int argc, char* argv[]) {
  // Registers the LaunchServices identity without asking for anything, so a
  // later permission check is answered against this bundle rather than a
  // parent process.
  if (macos::IsMacosPermissionResponsibleApplication())
    macos::PrepareMacosPermissionResponsibleApplication();

  if (macos::IsLocalOnboardingAppLaunch(argc, argv)) {
    auto onboarding = macos::CreateMacosPermissionOnboarding();
    if (!onboarding) {
      std::cerr << "aidesk_onboarding_unavailable\n";
      return EX_SOFTWARE;
    }
    // One prompt per permission, from the app the user just launched.
    return onboarding->RequestRegistration() ? EXIT_SUCCESS : EXIT_FAILURE;
  }

  if (!macos::IsAiDeskProductMainExecutable()) {
    // Running this outside the signed bundle would hand the caller an
    // exec into a path it chose. Refuse rather than resolve it.
    std::cerr << "aidesk_agent_requires_signed_bundle\n";
    return EX_USAGE;
  }

  (void)macos::ExecAiDeskProductHelper(
      macos::SelectAiDeskProductHelper(argc, argv), argc, argv);
  // `exec` only returns on failure.
  std::cerr << "aidesk_product_helper_exec_failed\n";
  return EX_UNAVAILABLE;
}
