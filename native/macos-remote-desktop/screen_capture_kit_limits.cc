// Bounds validation for ScreenCaptureKitLimits.
//
// Lives apart from screen_capture_kit_adapter.mm although it belongs to the
// same struct: the function is a pure predicate over the struct's own fields
// and needs no Apple header, but the .mm does. Keeping it here lets the
// LoginWindow capture supervisor — which drives both the ScreenCaptureKit and
// the CGDisplayStream backend through one interface — validate the same bounds
// while still being linkable and sanitizable without ScreenCaptureKit.
//
// Relocated verbatim rather than reimplemented. A second copy of these bounds
// would let the two capture paths drift apart on what counts as a valid limit,
// which is precisely what driving both through one interface exists to prevent.

#include <cstdint>

#include "screen_capture_kit_adapter.h"

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::uint32_t kMaximumTimeoutMs = 30'000;
constexpr std::uint32_t kMaximumFrameRate = 120;
constexpr std::uint32_t kMaximumPendingFrames = 8;
constexpr std::uint32_t kMaximumDisplays = 32;

}  // namespace

bool ScreenCaptureKitLimits::IsValid() const noexcept {
  return enumeration_timeout_ms > 0 &&
         enumeration_timeout_ms <= kMaximumTimeoutMs &&
         stream_start_timeout_ms > 0 &&
         stream_start_timeout_ms <= kMaximumTimeoutMs &&
         first_frame_timeout_ms > 0 &&
         first_frame_timeout_ms <= kMaximumTimeoutMs &&
         stream_stop_timeout_ms > 0 &&
         stream_stop_timeout_ms <= kMaximumTimeoutMs && frame_rate > 0 &&
         frame_rate <= kMaximumFrameRate && max_displays > 0 &&
         max_displays <= kMaximumDisplays && max_pending_frames > 0 &&
         max_pending_frames <= kMaximumPendingFrames;
}

}  // namespace imcodes::remote_desktop::macos
