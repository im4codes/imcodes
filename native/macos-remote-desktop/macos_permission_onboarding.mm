#include "macos_permission_onboarding.h"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <chrono>
#include <climits>
#include <cstdlib>
#include <cerrno>
#include <string>
#include <string_view>
#include <vector>

#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <sysexits.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;

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

// Developer ID team every product helper is signed by.
constexpr char kAiDeskHelperTeamIdentifier[] = "M675E26Q67";

// Signing identifier each remote-desktop helper must carry when launched from
// the component store. Computer Use never launches from outside the bundle.
const char* HelperSigningIdentifier(AiDeskProductHelper helper) noexcept {
  switch (helper) {
    case AiDeskProductHelper::kRemoteDesktopWorker:
      return "cc.imcodes.node.remote-desktop-worker";
    case AiDeskProductHelper::kRemoteDesktopLaunchAgent:
      return "cc.imcodes.node.remote-desktop-agent";
    case AiDeskProductHelper::kComputerUse:
      return nullptr;
  }
  return nullptr;
}

// Root-owned and writable by nobody else. The launch below runs with this
// app's Screen Recording and Accessibility grants, so a user able to replace
// or rewrite what gets launched would get those grants for their own code.
bool IsRootOwnedAndSealed(const struct stat& metadata) noexcept {
  return metadata.st_uid == 0 && (metadata.st_mode & (S_IWGRP | S_IWOTH)) == 0;
}

// `directory` must already be canonical (no symlinks, `.` or `..`), and it and
// every ancestor up to `/` must be root-owned directories nobody else can
// write. A directory that someone else can write lets them swap its entries
// between this check and the launch.
bool VerifySealedComponentDirectory(const std::string& directory) noexcept {
  if (directory.size() < 2 || directory.front() != '/' ||
      directory.back() == '/' || directory.find("//") != std::string::npos ||
      directory.find("/./") != std::string::npos ||
      directory.find("/../") != std::string::npos) {
    return false;
  }
  char resolved[PATH_MAX];
  if (::realpath(directory.c_str(), resolved) == nullptr ||
      directory != resolved) {
    return false;
  }
  std::string cursor = directory;
  for (;;) {
    struct stat metadata = {};
    if (::lstat(cursor.c_str(), &metadata) != 0 || !S_ISDIR(metadata.st_mode) ||
        !IsRootOwnedAndSealed(metadata)) {
      return false;
    }
    if (cursor == "/")
      return true;
    const std::string::size_type slash = cursor.find_last_of('/');
    cursor = slash == 0 ? "/" : cursor.substr(0, slash);
  }
}

// The helper must be the Developer ID build this product ships, identified by
// its exact signing identifier. Checked immediately before the launch; the
// sealed directory and file ownership keep it from changing in between.
bool VerifyHelperSignature(const std::string& path,
                           const char* identifier) noexcept {
  if (identifier == nullptr)
    return false;
  @autoreleasepool {
    NSURL* url = [NSURL fileURLWithFileSystemRepresentation:path.c_str()
                                                isDirectory:NO
                                              relativeToURL:nil];
    if (url == nil)
      return false;
    SecStaticCodeRef code = nullptr;
    if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags,
                                    &code) != errSecSuccess ||
        code == nullptr) {
      return false;
    }
    NSString* text = [NSString
        stringWithFormat:@"identifier \"%s\" and anchor apple generic and "
                         @"certificate leaf[subject.OU] = \"%s\"",
                         identifier, kAiDeskHelperTeamIdentifier];
    SecRequirementRef requirement = nullptr;
    const bool created =
        SecRequirementCreateWithString((__bridge CFStringRef)text,
                                       kSecCSDefaultFlags, &requirement) ==
            errSecSuccess &&
        requirement != nullptr;
    const bool valid =
        created && SecStaticCodeCheckValidity(
                       code, kSecCSStrictValidate | kSecCSCheckAllArchitectures,
                       requirement) == errSecSuccess;
    if (requirement != nullptr)
      CFRelease(requirement);
    CFRelease(code);
    return valid;
  }
}

// A leading --aidesk-component-dir=<path> argument, if present.
bool LeadingComponentDirectory(int argc, const char* const argv[],
                               std::string* directory) noexcept {
  if (argc < 2 || argv == nullptr || argv[1] == nullptr)
    return false;
  const std::string_view first(argv[1]);
  const std::string_view prefix(kAiDeskComponentDirectoryArgumentPrefix);
  if (first.rfind(prefix, 0) != 0)
    return false;
  if (directory != nullptr)
    directory->assign(first.substr(prefix.size()));
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

namespace {
volatile sig_atomic_t g_forward_signal_child = -1;

void ForwardSignalToHelper(int signal_number) {
  if (g_forward_signal_child > 0) ::kill(g_forward_signal_child, signal_number);
}
}  // namespace

bool ExecAiDeskProductHelper(AiDeskProductHelper helper,
                             int argc,
                             const char* const argv[]) noexcept {
  if (!IsAiDeskProductMainExecutable() || argc < 1 || argv == nullptr)
    return false;
  const char* file_name = HelperFileName(helper);
  if (file_name == nullptr)
    return false;
  std::string component_directory;
  const bool from_store =
      LeadingComponentDirectory(argc, argv, &component_directory);
  @autoreleasepool {
    std::string path;
    if (from_store) {
      // Only the remote-desktop helpers may run from the node's component
      // store, and only from a sealed directory with the expected signature.
      if (helper == AiDeskProductHelper::kComputerUse ||
          !VerifySealedComponentDirectory(component_directory)) {
        return false;
      }
      path = component_directory + "/" + file_name;
    } else {
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
      path.assign(path_bytes);
    }
    struct stat metadata = {};
    if (::lstat(path.c_str(), &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        S_ISLNK(metadata.st_mode) || ::access(path.c_str(), X_OK) != 0) {
      return false;
    }
    if (from_store &&
        (!IsRootOwnedAndSealed(metadata) ||
         !VerifyHelperSignature(path, HelperSigningIdentifier(helper)))) {
      return false;
    }
    std::vector<char*> forwarded;
    forwarded.reserve(static_cast<std::size_t>(argc) + 1);
    forwarded.push_back(path.data());
    for (int index = from_store ? 2 : 1; index < argc; ++index) {
      if (argv[index] == nullptr)
        return false;
      forwarded.push_back(const_cast<char*>(argv[index]));
    }
    forwarded.push_back(nullptr);
    // SPAWN AND WAIT, never exec. macOS checks Screen Recording and
    // Accessibility against the RESPONSIBLE process. A child spawned from this
    // main executable keeps this app as its responsible process, so the one
    // grant the person gave "aiDesk.to by IM.codes.app" is the grant the helper
    // runs under. `execv` replaced this image with the helper's, whose own
    // signing identity then became the responsible code: on a real Mac the
    // in-bundle worker reported screen recording and accessibility as denied
    // while this app held both, and every helper would have needed its own
    // grant under its own name.
    pid_t child = -1;
    if (::posix_spawn(&child, path.c_str(), nullptr, nullptr, forwarded.data(), environ) != 0)
      return false;
    g_forward_signal_child = child;
    ::signal(SIGTERM, ForwardSignalToHelper);
    ::signal(SIGINT, ForwardSignalToHelper);
    ::signal(SIGHUP, ForwardSignalToHelper);
    int status = 0;
    for (;;) {
      const pid_t reaped = ::waitpid(child, &status, 0);
      if (reaped == child) break;
      if (reaped < 0 && errno != EINTR) {
        ::_exit(EX_OSERR);
      }
    }
    // The helper's outcome IS this process's outcome: callers read the exit
    // status (LaunchServices wait, launchd KeepAlive) exactly as before.
    ::_exit(WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
  }
}

void PrepareMacosPermissionResponsibleApplication() noexcept {
  PrepareResponsibleApplication(false);
}

AiDeskProductHelper SelectAiDeskProductHelper(
    int argc,
    const char* const argv[]) noexcept {
  if (argc < 2 || argv == nullptr || argv[1] == nullptr)
    return AiDeskProductHelper::kComputerUse;
  // A component-store launch names its helper in the argument after the
  // directory; with nothing after it there is nothing to launch.
  const int selector = LeadingComponentDirectory(argc, argv, nullptr) ? 2 : 1;
  if (argc <= selector || argv[selector] == nullptr)
    return AiDeskProductHelper::kComputerUse;
  const std::string_view first(argv[selector]);
  if (first == kAiDeskLaunchAgentArgument)
    return AiDeskProductHelper::kRemoteDesktopLaunchAgent;
  if (first.rfind("--imcodes-", 0) == 0 ||
      first.rfind("--macos-remote-desktop-", 0) == 0) {
    return AiDeskProductHelper::kRemoteDesktopWorker;
  }
  return AiDeskProductHelper::kComputerUse;
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
