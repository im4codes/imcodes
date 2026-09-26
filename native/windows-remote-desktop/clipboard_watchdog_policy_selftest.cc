#include "third_party/imcodes_remote_desktop/clipboard_watchdog_policy.h"

using imcodes::remote_desktop::clipboard_watchdog::CleanupDecision;
using imcodes::remote_desktop::clipboard_watchdog::DecideCleanup;
using imcodes::remote_desktop::clipboard_watchdog::MarkerPhase;
using imcodes::remote_desktop::clipboard_watchdog::ShouldAdoptClipboard;

int main() {
  if (DecideCleanup(MarkerPhase::kArmed, 8, 99, true) !=
      CleanupDecision::kClear) return 1;
  if (DecideCleanup(MarkerPhase::kArmed, 8, 99, false) !=
      CleanupDecision::kPreserveReplacement) return 2;
  if (DecideCleanup(MarkerPhase::kOwned, 9, 9, true) !=
      CleanupDecision::kClear) return 3;
  if (DecideCleanup(MarkerPhase::kOwned, 9, 10, true) !=
      CleanupDecision::kPreserveReplacement) return 4;
  if (DecideCleanup(MarkerPhase::kOwned, 9, 9, false) !=
      CleanupDecision::kPreserveReplacement) return 5;
  if (!ShouldAdoptClipboard(4, 5, true)) return 6;
  if (ShouldAdoptClipboard(4, 4, true)) return 7;
  if (ShouldAdoptClipboard(4, 5, false)) return 8;
  return 0;
}
