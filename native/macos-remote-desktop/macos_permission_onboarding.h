#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_PERMISSION_ONBOARDING_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_PERMISSION_ONBOARDING_H_

#include <memory>

#include "macos_native_command_v1.h"

namespace imcodes::remote_desktop::macos {

inline constexpr char kMacosRemoteDesktopWorkerBundleIdentifier[] =
    "to.aidesk.app";
inline constexpr char kAiDeskMainExecutableName[] = "aidesk-agent";
inline constexpr char kAiDeskComputerUseHelperName[] = "OpenComputerUse";

// The argument that marks a launch-agent start. Declared here, with the
// dispatch that reads it, so the product has one definition of the string
// instead of a copy per executable kept in step by comment.
inline constexpr char kAiDeskLaunchAgentArgument[] =
    "--macos-remote-desktop-launch-agent";

enum class AiDeskProductHelper {
  kComputerUse,
  kRemoteDesktopWorker,
  kRemoteDesktopLaunchAgent,
};

// Which helper a command line asks for. Computer Use is the default because
// that is what an unadorned launch means; the remote-desktop helpers announce
// themselves with their own flags.
[[nodiscard]] AiDeskProductHelper SelectAiDeskProductHelper(
    int argc,
    const char* const argv[]) noexcept;

// True when the current executable is running from the exact signed worker
// application bundle, irrespective of its command-line mode.
[[nodiscard]] bool IsMacosPermissionResponsibleApplication() noexcept;

// Initializes the LaunchServices application identity without requesting or
// changing any TCC permission. This lets non-interactive readiness and the
// production LaunchAgent path observe grants owned by the signed app rather
// than being attributed to a parent terminal.
void PrepareMacosPermissionResponsibleApplication() noexcept;

// True only for the main executable of the signed aiDesk.to application. A
// nested helper sees the same outer NSBundle, so the executable basename is
// also checked to prevent recursive dispatch.
[[nodiscard]] bool IsAiDeskProductMainExecutable() noexcept;

// Replaces the aiDesk.to host process with one sealed helper from the same app
// bundle. Returns false without executing when the path is absent, a symlink,
// non-regular, or not executable.
[[nodiscard]] bool ExecAiDeskProductHelper(
    AiDeskProductHelper helper,
    int argc,
    const char* const argv[]) noexcept;

// True only for a LaunchServices/Finder launch of the exact signed onboarding
// app. An ordinary LaunchAgent process or a raw command-line worker can never
// take this path merely because it was restarted.
[[nodiscard]] bool IsLocalOnboardingAppLaunch(
    int argc,
    const char* const argv[]) noexcept;

// Apple-framework implementation of the explicit registration seam. Kept out
// of worker_main so AppKit can never become an in-process disclosure surface.
std::unique_ptr<NativePermissionOnboarding> CreateMacosPermissionOnboarding();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_PERMISSION_ONBOARDING_H_
