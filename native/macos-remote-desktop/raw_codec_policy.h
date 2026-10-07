#ifndef IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_POLICY_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_POLICY_H_

namespace imcodes::remote_desktop::macos {

// Whether a route may offer the codecs libwebrtc encodes itself (VP9/VP8) instead
// of VideoToolbox H.264. Pure, so every input is testable without a Mac.
//
// Raw codecs exist for a Mac whose only H.264 encoder is Apple's software one: on
// the same cores libvpx encodes the same picture several times faster. The user's
// switch can turn them off; otherwise two conditions must both hold:
//   * no hardware H.264 encoder -- a Mac that has one keeps it, unchanged;
//   * the capture honours the encoder's size (CGDisplayStream, macOS < 13). The
//     raw path hands libvpx the captured frame as it is: nothing scales it. A
//     capture that cannot be asked for a smaller output (ScreenCaptureKit) would
//     keep delivering the display's native size -- 5120x2700 on a 5K screen --
//     where the H.264 path scaled to the quality ladder's size inside
//     VideoToolbox. Such a route stays on H.264 exactly as before.
// The user's switch (see raw_codec_settings.h): `auto` leaves the decision to the
// rules below, `off` restores the H.264 behaviour exactly.
enum class RawCodecSetting { kAuto, kOff };

enum class RawCodecReason {
  kAllowed,
  kHardwareH264,
  kCaptureCannotScale,
  kDisabledBySetting,
};

struct RawCodecDecision {
  bool allowed = false;
  RawCodecReason reason = RawCodecReason::kHardwareH264;
};

[[nodiscard]] constexpr RawCodecDecision DecideRawCodecs(
    bool hardware_h264_available, bool capture_honours_output_size,
    RawCodecSetting setting = RawCodecSetting::kAuto) noexcept {
  if (setting == RawCodecSetting::kOff)
    return {false, RawCodecReason::kDisabledBySetting};
  if (hardware_h264_available) return {false, RawCodecReason::kHardwareH264};
  if (!capture_honours_output_size)
    return {false, RawCodecReason::kCaptureCannotScale};
  return {true, RawCodecReason::kAllowed};
}

// Stable tokens for the worker's one-line decision log.
[[nodiscard]] constexpr const char* RawCodecReasonName(RawCodecReason reason) noexcept {
  switch (reason) {
    case RawCodecReason::kAllowed: return "allowed";
    case RawCodecReason::kHardwareH264: return "hardware_h264";
    case RawCodecReason::kCaptureCannotScale: return "capture_cannot_scale";
    case RawCodecReason::kDisabledBySetting: return "disabled_by_setting";
  }
  return "unknown";
}

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_POLICY_H_
