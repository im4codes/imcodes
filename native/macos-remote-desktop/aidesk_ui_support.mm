// Compiled only by scripts/build-aidesk-app.mjs (native/macos-remote-desktop/aidesk-agent-build.json), always with -fobjc-arc.
#if !__has_feature(objc_arc)
#error "aidesk_ui_support.mm requires Objective-C ARC"
#endif

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include "aidesk_ui_support.h"

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <mach-o/dyld.h>
#include <spawn.h>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>

#include "macos_permission_onboarding.h"

namespace imcodes::remote_desktop::macos {
namespace {

std::atomic<const char*> g_phase{kUiPhaseLaunch};
std::atomic<unsigned> g_lines{0};
const char* g_role = "ui";
std::uint64_t g_start_ms = 0;
dispatch_queue_t g_log_queue = nullptr;
dispatch_source_t g_watchdog = nullptr;
int g_lock_fd = -1;

std::uint64_t NowMs() {
  return clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1000000ull;
}

// mkdir -p: the parents of a fresh home (a test, a new account) may not exist yet.
void MakeDirectories(const std::string& path) {
  for (std::string::size_type slash = path.find('/', 1); slash != std::string::npos; slash = path.find('/', slash + 1)) {
    ::mkdir(path.substr(0, slash).c_str(), 0700);
  }
  ::mkdir(path.c_str(), 0700);
}

std::string LogDirectory() {
  const char* home = getenv("HOME");
  std::string base = home != nullptr && home[0] == '/' ? home : std::string(NSHomeDirectory().fileSystemRepresentation);
  return base + "/" + kAiDeskUiLogDirectory;
}

void AppendLine(const std::string& line) {
  const std::string directory = LogDirectory();
  MakeDirectories(directory);
  const std::string path = directory + "/" + kAiDeskUiLogFile;
  struct stat metadata = {};
  if (::stat(path.c_str(), &metadata) == 0 && static_cast<std::uint64_t>(metadata.st_size) >= kUiLogMaxBytes) {
    ::rename(path.c_str(), (path + ".1").c_str());
  }
  const int fd = ::open(path.c_str(), O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) return;
  (void)::write(fd, line.data(), line.size());
  ::close(fd);
}

void LogLine(const std::string& event) {
  if (g_log_queue == nullptr || g_lines.fetch_add(1) >= kUiLogMaxLinesPerRun) return;
  const std::string line = std::to_string(NowMs() - g_start_ms) + " " + event + " role=" + g_role + "\n";
  dispatch_async(g_log_queue, ^{ AppendLine(line); });
}

std::string LockDirectory() {
  const char* home = getenv("HOME");
  std::string base = home != nullptr && home[0] == '/' ? home : std::string(NSHomeDirectory().fileSystemRepresentation);
  return base + "/Library/Application Support/" + kMacosRemoteDesktopWorkerBundleIdentifier;
}

NSString* RequestName() {
  return [NSString stringWithFormat:@"%s.ui-open-panel", kMacosRemoteDesktopWorkerBundleIdentifier];
}

NSString* AckName() {
  return [NSString stringWithFormat:@"%s.ui-open-panel-ack", kMacosRemoteDesktopWorkerBundleIdentifier];
}

}  // namespace

void UiDiagnosticsStart(const char* role) noexcept {
  g_role = role != nullptr ? role : "ui";
  g_start_ms = NowMs();
  g_log_queue = dispatch_queue_create("to.aidesk.ui-log", DISPATCH_QUEUE_SERIAL);
  LogLine("process_start");
  // The watchdog asks the main thread to run a block every 100 ms and notes it when the answer is late. At most one probe is in
  // flight, so a main thread that is stuck costs one note per few seconds, not a growing queue.
  static std::atomic<bool> in_flight{false};
  static std::atomic<std::uint64_t> sent_at{0};
  static std::atomic<std::uint64_t> last_note{0};
  dispatch_queue_t queue = dispatch_queue_create_with_target("to.aidesk.ui-watchdog", DISPATCH_QUEUE_SERIAL,
                                                             dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  g_watchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
  dispatch_source_set_timer(g_watchdog, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), 100 * NSEC_PER_MSEC, 20 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(g_watchdog, ^{
    const std::uint64_t now = NowMs();
    if (in_flight.load()) {
      const std::uint64_t waited = now - sent_at.load();
      if (waited > kMainThreadDelayLogMs && now - last_note.load() > 5000) {
        last_note.store(now);
        LogLine("main_thread_blocked ms=" + std::to_string(waited) + " phase=" + g_phase.load());
      }
      return;
    }
    in_flight.store(true);
    sent_at.store(now);
    dispatch_async(dispatch_get_main_queue(), ^{
      const std::uint64_t delay = NowMs() - sent_at.load();
      in_flight.store(false);
      if (delay > kMainThreadDelayLogMs && NowMs() - last_note.load() > 1000) {
        last_note.store(NowMs());
        LogLine("main_thread_delay ms=" + std::to_string(delay) + " phase=" + g_phase.load());
      }
    });
  });
  dispatch_resume(g_watchdog);
}

void UiPhase(const char* phase) noexcept {
  if (phase == nullptr) return;
  g_phase.store(phase);
  LogLine(std::string("phase ") + phase);
}

void UiLogEvent(const char* event) noexcept {
  if (event != nullptr) LogLine(event);
}

void UiLogFlush() noexcept {
  if (g_log_queue != nullptr) dispatch_sync(g_log_queue, ^{});  // blocking-ok: the log's own queue, a file append at most
}

int PrintUiLog() noexcept {
  const std::string path = LogDirectory() + "/" + kAiDeskUiLogFile;
  for (const std::string& file : {path + ".1", path}) {
    FILE* in = std::fopen(file.c_str(), "r");
    if (in == nullptr) continue;
    char buffer[4096];
    std::size_t read;
    while ((read = std::fread(buffer, 1, sizeof buffer, in)) > 0) std::fwrite(buffer, 1, read, stdout);
    std::fclose(in);
  }
  return 0;
}

extern "C" char** environ;

namespace {
// Starts this same executable in the user-facing role. Its ClaimUiRole decides: it becomes the instance, or hands the request to the one
// that exists and exits.
void StartUserFacingInstance() {
  static dispatch_queue_t queue = dispatch_queue_create("to.aidesk.ui-start", DISPATCH_QUEUE_SERIAL);
  dispatch_async(queue, ^{
    std::uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::string path(size, '\0');
    if (size == 0 || _NSGetExecutablePath(path.data(), &size) != 0) return;
    path.resize(std::strlen(path.c_str()));
    char* argv[] = {path.data(), const_cast<char*>("--aidesk-background"), const_cast<char*>("--aidesk-open-panel"), nullptr};
    pid_t child = -1;
    if (::posix_spawn(&child, path.c_str(), nullptr, nullptr, argv, environ) == 0) {
      LogLine("launcher_started_ui");
      // Reaped on this queue so the instance that takes over never becomes a zombie of the launcher.
      int status = 0;
      while (::waitpid(child, &status, 0) < 0 && errno == EINTR) {}  // blocking-ok: own queue
    }
  });
}
}  // namespace

}  // namespace imcodes::remote_desktop::macos

@interface AiDeskLauncherDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AiDeskLauncherDelegate
- (BOOL)applicationShouldHandleReopen:(NSApplication*)application hasVisibleWindows:(BOOL)hasVisibleWindows {
  (void)application;
  (void)hasVisibleWindows;
  imcodes::remote_desktop::macos::StartUserFacingInstance();
  return NO;
}
@end

namespace imcodes::remote_desktop::macos {

void InstallLauncherReopenHandler() noexcept {
  static AiDeskLauncherDelegate* delegate = [[AiDeskLauncherDelegate alloc] init];  // NSApplication keeps its delegate weakly
  [NSApp setDelegate:delegate];
  // The launcher has no window and no Dock presence. Said again once the run loop is up: the first request (made before it ran) is
  // only honoured after the process has finished checking in, and a launcher left classified as a regular application is what the
  // Dock shows as an icon that cannot be opened.
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    LogLine("launcher_ready");
  });
}

UiRoleClaim ClaimUiRole() noexcept {
  @autoreleasepool {
    const std::string directory = LockDirectory();
    MakeDirectories(directory);
    const int fd = ::open((directory + "/ui.lock").c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (fd < 0) return UiRoleClaim::kUnlocked;
    if (::flock(fd, LOCK_EX | LOCK_NB) == 0) {
      g_lock_fd = fd;  // held until this process ends
      LogLine("ui_role_owner");
      return UiRoleClaim::kOwner;
    }
    ::close(fd);
    // Another instance has the UI: ask it to open the panel and wait a moment for it to say it did. An older instance that does not
    // know the request never answers, and this one then carries on as an instance of its own.
    __block BOOL acknowledged = NO;
    NSDistributedNotificationCenter* center = [NSDistributedNotificationCenter defaultCenter];
    id observer = [center addObserverForName:AckName() object:nil queue:nil usingBlock:^(NSNotification*) { acknowledged = YES; }];
    [center postNotificationName:RequestName() object:nil userInfo:nil deliverImmediately:YES];
    const NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:kUiHandOverWaitSeconds];
    while (!acknowledged && [deadline timeIntervalSinceNow] > 0) {
      // blocking-ok: bounded (kUiHandOverWaitSeconds), and before this process has any window or Dock presence
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    [center removeObserver:observer];
    LogLine(acknowledged ? "ui_request_handed_over" : "ui_request_unanswered");
    return acknowledged ? UiRoleClaim::kHandedOver : UiRoleClaim::kUnlocked;
  }
}

void ObserveUiRequests(void (^handler)(void)) noexcept {
  NSDistributedNotificationCenter* center = [NSDistributedNotificationCenter defaultCenter];
  [center addObserverForName:RequestName() object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification*) {
    LogLine("ui_request_received");
    handler();
    [[NSDistributedNotificationCenter defaultCenter] postNotificationName:AckName() object:nil userInfo:nil deliverImmediately:YES];
  }];
}

}  // namespace imcodes::remote_desktop::macos
