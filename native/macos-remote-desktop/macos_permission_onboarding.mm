#include "macos_permission_onboarding.h"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <chrono>
#include <cerrno>
#include <string>
#include <string_view>
#include <vector>

#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <unistd.h>

namespace imcodes::remote_desktop::macos {
namespace {

void PrepareResponsibleApplication(bool activate) noexcept {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp finishLaunching];
  if (activate)
    [NSApp activateIgnoringOtherApps:YES];
}

bool CurrentExecutablePath(std::string* out) noexcept {
  if (out == nullptr)
    return false;
  std::uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || size == 0 ||
      size > 64 * 1024) {
    return false;
  }
  std::string path(size, '\0');
  if (_NSGetExecutablePath(path.data(), &size) != 0)
    return false;
  path.resize(std::char_traits<char>::length(path.c_str()));
  if (path.empty() || path.front() != '/')
    return false;
  *out = std::move(path);
  return true;
}

const char* HelperFileName(AiDeskProductHelper helper) noexcept {
  switch (helper) {
    case AiDeskProductHelper::kComputerUse:
      return kAiDeskComputerUseHelperName;
    case AiDeskProductHelper::kRemoteDesktopWorker:
      return "imcodes-remote-desktop-worker";
    case AiDeskProductHelper::kRemoteDesktopLaunchAgent:
      return "imcodes-remote-desktop-launch-agent";
  }
  return nullptr;
}

class ApplePermissionOnboarding final : public NativePermissionOnboarding {
 public:
  bool RequestRegistration() noexcept override {
    // A CLI child of Terminal is attributed to Terminal by TCC. Initializing
    // NSApplication makes a LaunchServices-opened onboarding bundle the
    // responsible GUI application, matching the working Computer Use flow.
    PrepareResponsibleApplication(true);
    (void)CGRequestScreenCaptureAccess();
    const void* keys[] = {kAXTrustedCheckOptionPrompt};
    const void* values[] = {kCFBooleanTrue};
    CFDictionaryRef options = CFDictionaryCreate(
        kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    if (options == nullptr)
      return false;
    (void)AXIsProcessTrustedWithOptions(options);
    CFRelease(options);

    // Keep the responsible application alive while the user operates System
    // Settings. macOS only offers its normal "Quit & Reopen" flow for a live
    // application; exiting immediately after requesting registration leaves
    // a switch that appears enabled while a fresh process still reads denied.
    // Poll only the two authoritative TCC probes and bound the wait so a
    // forgotten onboarding launch cannot become a permanent background task.
    constexpr auto kPermissionWait = std::chrono::minutes(10);
    constexpr auto kProbeInterval = std::chrono::milliseconds(250);
    const auto deadline = std::chrono::steady_clock::now() + kPermissionWait;
    while (std::chrono::steady_clock::now() < deadline) {
      if (CGPreflightScreenCaptureAccess() && AXIsProcessTrusted())
        return true;
      @autoreleasepool {
        const auto interval =
            std::chrono::duration<double>(kProbeInterval).count();
        [[NSRunLoop currentRunLoop]
            runUntilDate:[NSDate dateWithTimeIntervalSinceNow:interval]];
      }
    }
    return false;
  }
};

}  // namespace

bool IsMacosPermissionResponsibleApplication() noexcept {
  @autoreleasepool {
    NSBundle* bundle = [NSBundle mainBundle];
    NSString* identifier = [bundle bundleIdentifier];
    NSURL* bundle_url = [bundle bundleURL];
    return identifier != nil && bundle_url != nil &&
           [identifier
               isEqualToString:@"to.aidesk.app"] &&
           [[[bundle_url path] pathExtension] caseInsensitiveCompare:@"app"] ==
               NSOrderedSame;
  }
}

bool IsAiDeskProductMainExecutable() noexcept {
  if (!IsMacosPermissionResponsibleApplication())
    return false;
  std::string executable;
  if (!CurrentExecutablePath(&executable))
    return false;
  const std::string::size_type slash = executable.find_last_of('/');
  return slash != std::string::npos &&
         executable.substr(slash + 1) == kAiDeskMainExecutableName;
}

bool ExecAiDeskProductHelper(AiDeskProductHelper helper,
                             int argc,
                             const char* const argv[]) noexcept {
  if (!IsAiDeskProductMainExecutable() || argc < 1 || argv == nullptr)
    return false;
  const char* file_name = HelperFileName(helper);
  if (file_name == nullptr)
    return false;
  @autoreleasepool {
    NSString* bundle_path = [[NSBundle mainBundle] bundlePath];
    if (bundle_path == nil)
      return false;
    const char* path_bytes = [[bundle_path
        stringByAppendingPathComponent:[NSString
                                           stringWithFormat:@"Contents/Helpers/%s",
                                                            file_name]]
                         fileSystemRepresentation];
    if (path_bytes == nullptr)
      return false;
    std::string path(path_bytes);
    struct stat metadata = {};
    if (::lstat(path.c_str(), &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        S_ISLNK(metadata.st_mode) || ::access(path.c_str(), X_OK) != 0) {
      return false;
    }
    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<std::size_t>(argc) + 1);
    forwarded.push_back(path.data());
    for (int index = 1; index < argc; ++index) {
      if (argv[index] == nullptr)
        return false;
      forwarded.push_back(const_cast<char*>(argv[index]));
    }
    forwarded.push_back(nullptr);
    ::execv(path.c_str(), forwarded.data());
    return false;
  }
}

void PrepareMacosPermissionResponsibleApplication() noexcept {
  PrepareResponsibleApplication(false);
}

bool IsLocalOnboardingAppLaunch(int argc, const char* const argv[]) noexcept {
  if (argc < 1 || argc > 2 || argv == nullptr)
    return false;
  if (argc == 2 && (argv[1] == nullptr ||
                    std::string_view(argv[1]).rfind("-psn_", 0) != 0)) {
    return false;
  }
  return IsMacosPermissionResponsibleApplication();
}

std::unique_ptr<NativePermissionOnboarding> CreateMacosPermissionOnboarding() {
  return std::make_unique<ApplePermissionOnboarding>();
}

}  // namespace imcodes::remote_desktop::macos
