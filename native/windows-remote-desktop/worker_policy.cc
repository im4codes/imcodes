#include "third_party/imcodes_remote_desktop/worker_policy.h"

#include <algorithm>
#include <cstdlib>

#include <dxgi.h>
#include <wtsapi32.h>

namespace imcodes::rd {

bool DisplayOutputIsPresentable(bool imcodes_virtual,
                                bool has_active_monitor_target) {
  return imcodes_virtual || has_active_monitor_target;
}

CaptureAcquireAction ClassifyCaptureAcquireResult(HRESULT result) {
  if (result == S_OK) return CaptureAcquireAction::kFrame;
  if (result == DXGI_ERROR_WAIT_TIMEOUT) return CaptureAcquireAction::kWait;
  if (result == DXGI_ERROR_ACCESS_LOST || result == DXGI_ERROR_DEVICE_REMOVED ||
      result == DXGI_ERROR_DEVICE_RESET) {
    return CaptureAcquireAction::kReset;
  }
  return CaptureAcquireAction::kDrop;
}

WorkerEnvironmentAction SelectWorkerEnvironmentAction(uint32_t event_mask) {
  if (event_mask & (kEnvironmentSuspend |
                    kEnvironmentSessionUnavailable)) {
    return WorkerEnvironmentAction::kStopProtected;
  }
  // A lock or unlock only moves the desktop, so it is answered by following
  // rather than by tearing the session down. It is checked after the stop
  // cases so a logoff that arrives with it still wins.
  if (event_mask & (kEnvironmentSessionLocked | kEnvironmentSessionUnlocked))
    return WorkerEnvironmentAction::kFollowDesktop;
  if (event_mask & (kEnvironmentResume | kEnvironmentSessionAvailable))
    return WorkerEnvironmentAction::kStopAndReinitialize;
  if (event_mask & kEnvironmentCompositionChanged)
    return WorkerEnvironmentAction::kStopAndReinitialize;
  if (event_mask & kEnvironmentDisplayChanged)
    return WorkerEnvironmentAction::kRefreshTopology;
  return WorkerEnvironmentAction::kNone;
}


bool AdvanceGdiFallbackState(bool captured,
                             bool gdi_fallback_allowed,
                             int* consecutive_waits) {
  if (!consecutive_waits) return false;
  if (captured || !gdi_fallback_allowed) {
    if (captured) *consecutive_waits = 0;
    return false;
  }
  if (++(*consecutive_waits) < kFirstFrameWaitsBeforeGdiFallback) return false;
  *consecutive_waits = 0;
  return true;
}

DesktopFollowAction SelectDesktopFollowAction(
    const std::wstring& input_desktop,
    const std::wstring& bound,
    int* consecutive_failures) {
  if (input_desktop.empty()) {
    if (consecutive_failures &&
        ++(*consecutive_failures) >= kDesktopFollowFailureLimit) {
      *consecutive_failures = 0;
      return DesktopFollowAction::kUnavailable;
    }
    return DesktopFollowAction::kStay;
  }
  if (consecutive_failures) *consecutive_failures = 0;
  return input_desktop == bound ? DesktopFollowAction::kStay
                                : DesktopFollowAction::kFollow;
}

bool DesktopFollowSettled(const std::wstring& observed,
                          std::wstring* candidate) {
  if (!candidate) return !observed.empty();
  if (observed.empty()) {
    candidate->clear();
    return false;
  }
  const bool settled = *candidate == observed;
  *candidate = observed;
  return settled;
}

bool ShouldRebindCapture(const std::wstring& input_desktop,
                         const std::wstring& bound) {
  return !input_desktop.empty() && input_desktop != bound;
}

AutoUnlockStep SelectAutoUnlockStep(bool secret_configured,
                                    bool controller_present,
                                    bool input_ready,
                                    bool session_locked,
                                    bool on_sign_in_desktop,
                                    int raise_attempts_this_lock,
                                    int type_attempts_this_lock) {
  if (!secret_configured || !controller_present || !input_ready ||
      !session_locked) {
    return AutoUnlockStep::kNone;
  }
  if (on_sign_in_desktop) {
    return type_attempts_this_lock < kAutoUnlockAttemptsPerLock
               ? AutoUnlockStep::kTypeSecret
               : AutoUnlockStep::kNone;
  }
  return raise_attempts_this_lock < kAutoUnlockRaiseAttemptsPerLock
             ? AutoUnlockStep::kRaiseCredentialUi
             : AutoUnlockStep::kNone;
}

bool ShouldAcceptUnlockRequest(bool secret_configured,
                               bool controller_present,
                               bool input_ready,
                               bool session_locked) {
  return secret_configured && controller_present && input_ready &&
         session_locked;
}

bool ClipboardAllowedOnDesktop(const std::wstring& desktop) {
  return desktop == L"Default";
}



bool AdvanceTopologyRefreshDebounce(bool refresh_requested,
                                    int* remaining_ticks) {
  if (!remaining_ticks) return false;
  if (refresh_requested) {
    *remaining_ticks = kTopologyRefreshDebounceTicks;
    return false;
  }
  if (*remaining_ticks <= 0) return false;
  --*remaining_ticks;
  return *remaining_ticks == 0;
}

bool AdvanceEmptyTopologyConsecutive(int* consecutive_empty_ticks) {
  if (!consecutive_empty_ticks) return false;
  if (++(*consecutive_empty_ticks) <= kEmptyTopologyGraceTicks) return false;
  *consecutive_empty_ticks = 0;
  return true;
}

DWORD CurrentDwmProcessIdForCurrentSession() {
  DWORD session_id = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session_id)) return 0;
  PWTS_PROCESS_INFOW processes = nullptr;
  DWORD count = 0;
  if (!WTSEnumerateProcessesW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &processes,
                              &count)) {
    return 0;
  }
  DWORD process_id = 0;
  for (DWORD index = 0; index < count; ++index) {
    const WTS_PROCESS_INFOW& process = processes[index];
    if (process.SessionId == session_id && process.pProcessName &&
        lstrcmpiW(process.pProcessName, L"dwm.exe") == 0) {
      process_id = process.ProcessId;
      break;
    }
  }
  WTSFreeMemory(processes);
  return process_id;
}

bool AdvanceCompositorProcessGeneration(DWORD current_process_id,
                                        DWORD* previous_process_id) {
  if (!previous_process_id || current_process_id == 0) return false;
  if (*previous_process_id == 0) {
    *previous_process_id = current_process_id;
    return false;
  }
  if (*previous_process_id == current_process_id) return false;
  *previous_process_id = current_process_id;
  return true;
}

size_t SelectDisplayAfterTopologyChange(
    const std::vector<DisplaySelectionCandidate>& candidates,
    const std::string& previous_id) {
  const auto real_primary = std::find_if(
      candidates.begin(), candidates.end(), [](const auto& candidate) {
        return candidate.primary && candidate.available &&
               !candidate.imcodes_virtual;
      });
  const auto real_available = std::find_if(
      candidates.begin(), candidates.end(), [](const auto& candidate) {
        return candidate.available && !candidate.imcodes_virtual;
      });
  const auto preferred = std::find_if(
      candidates.begin(), candidates.end(), [&](const auto& candidate) {
        return candidate.id == previous_id && candidate.available;
      });
  if (preferred != candidates.end() &&
      (!preferred->imcodes_virtual || real_available == candidates.end())) {
    return static_cast<size_t>(preferred - candidates.begin());
  }
  if (real_primary != candidates.end())
    return static_cast<size_t>(real_primary - candidates.begin());
  if (real_available != candidates.end())
    return static_cast<size_t>(real_available - candidates.begin());
  const auto primary = std::find_if(
      candidates.begin(), candidates.end(), [](const auto& candidate) {
        return candidate.primary && candidate.available;
      });
  if (primary != candidates.end())
    return static_cast<size_t>(primary - candidates.begin());
  const auto available = std::find_if(
      candidates.begin(), candidates.end(), [](const auto& candidate) {
        return candidate.available;
      });
  return available == candidates.end()
             ? candidates.size()
             : static_cast<size_t>(available - candidates.begin());
}

bool DisplaySelectionRequiresExplicitChoice(
    const std::vector<DisplaySelectionCandidate>& candidates,
    const std::string& previous_id) {
  if (previous_id.empty()) return false;
  return std::none_of(candidates.begin(), candidates.end(),
                      [&](const auto& candidate) {
                        return candidate.id == previous_id &&
                               candidate.available;
                      });
}

void FinalizeDisplayModeList(std::vector<DisplayMode>* modes,
                             int current_width,
                             int current_height) {
  if (!modes) return;
  const auto same_size = [](const DisplayMode& left, const DisplayMode& right) {
    return left.width == right.width && left.height == right.height;
  };
  const DisplayMode current{current_width, current_height};
  const bool current_allowed =
      IsAllowedRemoteDisplayMode(current_width, current_height);
  // Deduplicate defensively: enumeration order is the driver's business.
  std::vector<DisplayMode> distinct;
  for (const DisplayMode& mode : *modes) {
    if (!IsAllowedRemoteDisplayMode(mode.width, mode.height)) continue;
    if (std::any_of(distinct.begin(), distinct.end(),
                    [&](const DisplayMode& kept) { return same_size(kept, mode); })) {
      continue;
    }
    distinct.push_back(mode);
  }
  if (current_allowed &&
      std::none_of(distinct.begin(), distinct.end(),
                   [&](const DisplayMode& kept) { return same_size(kept, current); })) {
    distinct.push_back(current);
  }
  std::sort(distinct.begin(), distinct.end(),
            [](const DisplayMode& left, const DisplayMode& right) {
              const int64_t left_area =
                  static_cast<int64_t>(left.width) * left.height;
              const int64_t right_area =
                  static_cast<int64_t>(right.width) * right.height;
              if (left_area != right_area) return left_area > right_area;
              return left.width > right.width;
            });
  if (distinct.size() > kMaxDisplayModes) {
    const bool current_kept =
        current_allowed &&
        std::any_of(distinct.begin(), distinct.begin() + kMaxDisplayModes,
                    [&](const DisplayMode& kept) { return same_size(kept, current); });
    distinct.resize(kMaxDisplayModes);
    if (current_allowed && !current_kept) {
      // The screen's own mode outranks the smallest one that made the cut.
      distinct.back() = current;
      std::sort(distinct.begin(), distinct.end(),
                [](const DisplayMode& left, const DisplayMode& right) {
                  const int64_t left_area =
                      static_cast<int64_t>(left.width) * left.height;
                  const int64_t right_area =
                      static_cast<int64_t>(right.width) * right.height;
                  if (left_area != right_area) return left_area > right_area;
                  return left.width > right.width;
                });
    }
  }
  *modes = std::move(distinct);
}

bool IsAllowedRemoteDisplayMode(int width, int height) {
  // A bound, not a menu. Which resolutions exist is the driver's answer — a
  // machine with no monitor attached often offers exactly one, and pinning four
  // common sizes here is what left the operator clicking entries that could
  // never apply. Windows still refuses anything its driver does not have.
  return width >= kMinRemoteDisplayEdge && height >= kMinRemoteDisplayEdge &&
         width <= kMaxRemoteDisplayEdge && height <= kMaxRemoteDisplayEdge;
}

bool IsAllowedRemoteDisplayScale(int percent) {
  switch (percent) {
    case 100:
    case 125:
    case 150:
    case 175:
    case 200:
    case 225:
    case 250:
    case 300:
      return true;
    default:
      return false;
  }
}

int RecommendedRemoteDisplayScale(int width, int /*height*/) {
  // Banded by width rather than matched against four exact sizes, so any
  // resolution a driver reports still gets a readable default. The bands
  // reproduce what the fixed sizes used to return.
  if (width >= 3840) return 225;
  if (width >= 2560) return 175;
  if (width >= 1920) return 150;
  if (width >= 1280) return 125;
  return 100;
}

bool PresentedFrameMatchesDisplay(int frame_width,
                                  int frame_height,
                                  int display_width,
                                  int display_height) {
  constexpr int kMaximumDimension = 16'384;
  if (frame_width <= 0 || frame_height <= 0 ||
      display_width <= 0 || display_height <= 0 ||
      frame_width > kMaximumDimension || frame_height > kMaximumDimension ||
      display_width > kMaximumDimension || display_height > kMaximumDimension) {
    return false;
  }
  const int64_t first = static_cast<int64_t>(frame_width) * display_height;
  const int64_t second = static_cast<int64_t>(frame_height) * display_width;
  const int64_t maximum = std::max(first, second);
  // Permit one percent for even-dimension scaling/codec alignment while
  // rejecting stale landscape/portrait or materially different layouts.
  return std::abs(first - second) * 100 <= maximum;
}

bool EncoderQueueHasCapacity(size_t pending_frames, size_t maximum_frames) {
  return maximum_frames > 0 && pending_frames < maximum_frames;
}

bool EncoderKeyFrameRequested(bool forced, bool upstream_requested) {
  return forced || upstream_requested;
}

bool HardwareEncoderShouldFallback(size_t pending_frames,
                                   size_t stalled_input_polls,
                                   size_t maximum_frames) {
  if (maximum_frames == 0 || pending_frames == 0) return false;
  return pending_frames >= maximum_frames ||
         stalled_input_polls >= maximum_frames;
}

size_t UpdateHardwareSlowFrameCount(int64_t encode_duration_us,
                                    int target_fps,
                                    size_t previous_slow_frames) {
  if (target_fps <= 0 || encode_duration_us < 0) return 0;
  const int64_t frame_budget_us = 1'000'000 / target_fps + 5'000;
  if (encode_duration_us <= frame_budget_us) return 0;
  return previous_slow_frames < kHardwareSlowFrameLimit
             ? previous_slow_frames + 1
             : previous_slow_frames;
}

bool HardwareEncoderThroughputShouldFallback(size_t consecutive_slow_frames) {
  return consecutive_slow_frames >= kHardwareSlowFrameLimit;
}

bool ShouldAttemptHardwareEncoder(bool prefer_hardware,
                                  bool hardware_disqualified) {
  return prefer_hardware && !hardware_disqualified;
}

bool MediaProgressShouldFailover(uint64_t previous_bytes,
                                 uint64_t current_bytes,
                                 uint64_t source_frames_at_progress,
                                 uint64_t current_source_frames,
                                 int64_t elapsed_ms) {
  return current_bytes == previous_bytes &&
         current_source_frames > source_frames_at_progress &&
         elapsed_ms >= kMediaProgressTimeoutMs;
}

bool InputSequenceIsFresh(bool has_previous,
                          uint64_t previous_sequence,
                          uint64_t current_sequence) {
  return !has_previous || current_sequence > previous_sequence;
}

const char* SessionExpiryReason(int64_t now_ms,
                                int64_t authority_expires_at_ms,
                                int64_t lease_expires_at_ms,
                                bool idle_expired) {
  if (idle_expired) return "idle_timeout";
  if (now_ms >= authority_expires_at_ms) return "authority_expired";
  if (now_ms >= lease_expires_at_ms) return "lease_expired";
  return nullptr;
}

}  // namespace imcodes::rd
