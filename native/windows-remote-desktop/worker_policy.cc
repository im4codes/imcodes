#include "third_party/imcodes_remote_desktop/worker_policy.h"

#include <algorithm>
#include <cstdlib>

#include <dxgi.h>

namespace imcodes::rd {

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
  if (event_mask & (kEnvironmentResume | kEnvironmentSessionAvailable))
    return WorkerEnvironmentAction::kStopAndReinitialize;
  if (event_mask & kEnvironmentDisplayChanged)
    return WorkerEnvironmentAction::kRefreshTopology;
  return WorkerEnvironmentAction::kNone;
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

bool IsAllowedRemoteDisplayMode(int width, int height) {
  return (width == 1280 && height == 720) ||
         (width == 1920 && height == 1080) ||
         (width == 2560 && height == 1440) ||
         (width == 3840 && height == 2160);
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

int RecommendedRemoteDisplayScale(int width, int height) {
  if (width == 1280 && height == 720) return 125;
  if (width == 1920 && height == 1080) return 150;
  if (width == 2560 && height == 1440) return 175;
  if (width == 3840 && height == 2160) return 225;
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
