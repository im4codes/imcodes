#ifndef IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_POLICY_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_POLICY_H_

#include "../remote-desktop-common/data_channel_constants.h"

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

// Stable tokens for the worker's one-line decision log AND the `rawCodecs` field of
// the encoder message sent to the viewer: one vocabulary, defined once in
// data_channel_constants.h.
[[nodiscard]] constexpr const char* RawCodecReasonName(RawCodecReason reason) noexcept {
  switch (reason) {
    case RawCodecReason::kAllowed: return imcodes::rd::kRawCodecsAllowed;
    case RawCodecReason::kHardwareH264: return imcodes::rd::kRawCodecsHardwareH264;
    case RawCodecReason::kCaptureCannotScale:
      return imcodes::rd::kRawCodecsCaptureCannotScale;
    case RawCodecReason::kDisabledBySetting:
      return imcodes::rd::kRawCodecsDisabledBySetting;
  }
  return "unknown";
}

// How many cores the libvpx encoder is told it has. libwebrtc derives the encoder's
// thread count from the core count it is handed, so this is the thread cap.
//
// Measured on a 12-core / 24-thread Intel Mac Pro (VP9 real-time, 2560x1350 text,
// tiles on, 8 Mbps), encode time per frame:
//     2 threads 21-35 ms | 4: 13.8-20 | 6: 11.8-17 | 8: 9.8-13 | 12: 9-12 | 24: no gain.
// So more than 12 is never useful (the cap), and a machine reporting more cores than
// that gets 12. A low-core Mac keeps what it has: 4 threads still encode in 14-20 ms,
// and the encoder is bursty (about 0.4-0.7 of one core on average at 10 frames/s), so
// no core is held back for the capture. The floor is 2: a report of 0 or 1 core is
// almost always a misreport, and a single thread is about two to three times slower.
inline constexpr int kRawEncoderMaxCores = 12;
inline constexpr int kRawEncoderMinCores = 2;

[[nodiscard]] constexpr int RawEncoderCoreBudget(int reported_cores) noexcept {
  if (reported_cores < kRawEncoderMinCores) return kRawEncoderMinCores;
  if (reported_cores > kRawEncoderMaxCores) return kRawEncoderMaxCores;
  return reported_cores;
}

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_RAW_CODEC_POLICY_H_
