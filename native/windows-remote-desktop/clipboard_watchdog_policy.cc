#include "third_party/imcodes_remote_desktop/clipboard_watchdog_policy.h"

namespace imcodes::remote_desktop::clipboard_watchdog {

CleanupDecision DecideCleanup(MarkerPhase phase,
                              uint32_t recorded_sequence,
                              uint32_t current_sequence,
                              bool expected_hash_matches) {
  if (!expected_hash_matches) return CleanupDecision::kPreserveReplacement;
  if (phase == MarkerPhase::kOwned &&
      recorded_sequence != current_sequence) {
    return CleanupDecision::kPreserveReplacement;
  }
  return CleanupDecision::kClear;
}

bool ShouldAdoptClipboard(uint32_t baseline_sequence,
                          uint32_t current_sequence,
                          bool expected_hash_matches) {
  return baseline_sequence != current_sequence && expected_hash_matches;
}

}  // namespace imcodes::remote_desktop::clipboard_watchdog
