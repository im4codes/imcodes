#ifndef IMCODES_REMOTE_DESKTOP_COMMON_STATIC_REFRESH_POLICY_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_STATIC_REFRESH_POLICY_H_

// Header-only and platform-neutral: pure arithmetic over a few counters, so it
// is unit-tested on any host and shared by every encoder that wants it.

#include <cstdint>
#include <limits>

namespace imcodes::rd {

// A moving picture is encoded at whatever quality keeps it current; when it
// stops moving, the viewer keeps looking at that same moving-quality picture
// until the next periodic keyframe (up to half a minute on a quiet screen).
// Text that was sharp when still looks soft when you stop scrolling. The fix is
// one extra, sharper keyframe once the picture has settled.
//
// Measured on a 2013 Mac Pro with Apple's software H.264 (2560x1350 code-like
// text, luma PSNR / SSIM against the source):
//   an ordinary keyframe                         140 KB   42.2 dB  0.9951
//   a keyframe forced after >= 10 coded frames   208-234 KB 45.2-45.5 dB 0.998
//   a keyframe forced after only 1-3 coded frames 106-127 KB 39-41 dB  (worse)
// The software encoder's rate control banks the bits that cheap (static)
// frames did not spend and a forced keyframe spends them, so what matters is
// how many frames were coded since the last keyframe, not the bitrate setting
// (raising it to 20 or 30 Mbps changed nothing). Hence the first rule below.
//
// The refresh is bounded so it can never fight the latency goal:
//   - at most once per static run: only the first unchanged frame after a
//     changed one can trigger it;
//   - never sooner than kMinIntervalMs after the previous refresh;
//   - only when enough frames have been coded since the last keyframe;
//   - only when the link target is high enough to send the burst (about
//     234 KB) in well under half a second.
inline constexpr std::uint32_t kStaticRefreshMinFramesSinceKey = 10;
inline constexpr std::uint32_t kStaticRefreshMinBitrateBps = 4'000'000;
inline constexpr std::int64_t kStaticRefreshMinIntervalMs = 5'000;

class StaticRefreshPolicy {
 public:
  // Call once for every frame the encoder accepts. `unchanged` is true when the
  // capture re-delivered the previous picture because nothing changed.
  // Returns true when this frame should be encoded as a forced keyframe.
  bool OnFrame(bool unchanged,
               std::uint32_t frames_since_key,
               std::uint32_t bitrate_bps,
               std::int64_t now_ms) {
    const bool first_unchanged = unchanged && !previous_unchanged_;
    previous_unchanged_ = unchanged;
    if (!first_unchanged) return false;
    if (frames_since_key < kStaticRefreshMinFramesSinceKey) return false;
    if (bitrate_bps < kStaticRefreshMinBitrateBps) return false;
    if (now_ms - last_refresh_ms_ < kStaticRefreshMinIntervalMs) return false;
    last_refresh_ms_ = now_ms;
    return true;
  }

  // A new encoder session starts with its own keyframe: forget the run.
  void Reset() { previous_unchanged_ = false; }

 private:
  bool previous_unchanged_ = false;
  std::int64_t last_refresh_ms_ = std::numeric_limits<std::int64_t>::min() / 2;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_STATIC_REFRESH_POLICY_H_
