#pragma once

#include <cstdint>

namespace imcodes::remote_desktop::clipboard_watchdog {

// The shared policy fixes the lifetime at exactly sixty seconds. Keeping the
// native value named and source-guarded prevents a future shell from silently
// extending a bearer link's clipboard exposure.
inline constexpr uint64_t kCleanupDelayMs = 60'000;

enum class MarkerPhase : uint8_t {
  kArmed = 1,
  kOwned = 2,
};

enum class CleanupDecision {
  kClear,
  kPreserveReplacement,
};

// An armed marker is written before the shell copies. After a crash it has no
// trustworthy post-copy sequence yet, so an exact expected hash is the only
// evidence that the managed value reached the clipboard. Once ownership was
// observed, both the recorded sequence and hash must still match.
CleanupDecision DecideCleanup(MarkerPhase phase,
                              uint32_t recorded_sequence,
                              uint32_t current_sequence,
                              bool expected_hash_matches);

bool ShouldAdoptClipboard(uint32_t baseline_sequence,
                          uint32_t current_sequence,
                          bool expected_hash_matches);

}  // namespace imcodes::remote_desktop::clipboard_watchdog
