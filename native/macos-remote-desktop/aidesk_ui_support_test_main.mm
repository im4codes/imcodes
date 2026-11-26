// Test driver for aidesk_ui_support.mm (macOS only; driven by test/native/aidesk-ui-support.test.ts, which compiles it with clang++).
// argv: <mode> <home directory>. HOME is pointed at the directory so nothing touches the real user's logs or locks.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>

#include "aidesk_ui_support.h"

namespace macos = imcodes::remote_desktop::macos;

int main(int argc, char* argv[]) {
  if (argc < 3) return 64;
  const std::string mode = argv[1];
  setenv("HOME", argv[2], 1);
  @autoreleasepool {
    if (mode == "blocked") {
      // A main thread that does a blocking call: the watchdog must say so, with the phase.
      macos::UiDiagnosticsStart("test");
      macos::UiPhase("blocked_phase");
      usleep(900 * 1000);  // blocking-ok: the point of this test
      [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.4]];
      macos::UiLogFlush();
      return macos::PrintUiLog();
    }
    if (mode == "quiet") {
      macos::UiDiagnosticsStart("test");
      [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:1.0]];
      macos::UiLogFlush();
      return macos::PrintUiLog();
    }
    if (mode == "rotate") {
      const std::string directory = std::string(argv[2]) + "/" + macos::kAiDeskUiLogDirectory;
      system(("mkdir -p '" + directory + "'").c_str());
      std::ofstream(directory + "/" + macos::kAiDeskUiLogFile) << std::string(macos::kUiLogMaxBytes + 10, 'x') << "\n";
      macos::UiDiagnosticsStart("test");
      macos::UiLogEvent("after_rotation");
      macos::UiLogFlush();
      // Only the current file (the moved-aside one is the padding written above).
      std::ifstream current(directory + "/" + macos::kAiDeskUiLogFile);
      std::printf("%s\n", std::string((std::istreambuf_iterator<char>(current)), std::istreambuf_iterator<char>()).c_str());
      return 0;
    }
    if (mode == "flood") {
      // However much is logged, a run writes at most kUiLogMaxLinesPerRun lines.
      macos::UiDiagnosticsStart("test");
      for (int i = 0; i < 1000; ++i) macos::UiLogEvent("flood_event");
      macos::UiLogFlush();
      return macos::PrintUiLog();
    }
    if (mode == "claim" || mode == "claim-observe") {
      const macos::UiRoleClaim claim = macos::ClaimUiRole();
      std::printf("claim=%s\n", claim == macos::UiRoleClaim::kOwner ? "owner" : claim == macos::UiRoleClaim::kHandedOver ? "handed_over" : "unlocked");
      std::fflush(stdout);
      if (claim == macos::UiRoleClaim::kOwner) {
        if (mode == "claim-observe") macos::ObserveUiRequests(^{ std::printf("request_received\n"); std::fflush(stdout); });
        [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:3.0]];
      }
      return 0;
    }
  }
  return 64;
}
