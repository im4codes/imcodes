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
// The refresh is bounded so it cannot fight the latency goal (latency first):
//   - it waits for a settled picture: the capture's keep-alive re-delivers an
//     unchanged picture every 500 ms, so the 3rd consecutive unchanged frame is
//     about 1.5 s of true stillness, longer than a typical pause while typing
//     or reading. "Unchanged" means the capture produced no new frame; a change
//     that never produces one (a pointer-only movement) also looks still, which
//     is fine here;
//   - at most once per static run (it fires on exactly that 3rd frame);
//   - never sooner than kMinIntervalMs after the previous refresh;
//   - only when enough frames have been coded since the last keyframe;
//   - only when the link target can carry the burst (about 234 KB, 0.31 s at
//     6 Mbps) in well under half a second.
// The burst is a one-off (a forced keyframe encodes in 20-60 ms on that Mac, so
// the encoder is not held up); what it can delay is the picture after it on the
// wire, which is why it is gated on stillness and on link speed.
inline constexpr std::uint32_t kStaticRefreshMinUnchangedRun = 3;
inline constexpr std::uint32_t kStaticRefreshMinFramesSinceKey = 10;
inline constexpr std::uint32_t kStaticRefreshMinBitrateBps = 6'000'000;
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
    if (!unchanged) {
      unchanged_run_ = 0;
      return false;
    }
    if (unchanged_run_ < std::numeric_limits<std::uint32_t>::max()) ++unchanged_run_;
    if (unchanged_run_ != kStaticRefreshMinUnchangedRun) return false;
    if (frames_since_key < kStaticRefreshMinFramesSinceKey) return false;
    if (bitrate_bps < kStaticRefreshMinBitrateBps) return false;
    if (now_ms - last_refresh_ms_ < kStaticRefreshMinIntervalMs) return false;
    last_refresh_ms_ = now_ms;
    return true;
  }

  // A new encoder session starts with its own keyframe: forget the run.
  void Reset() { unchanged_run_ = 0; }

 private:
  std::uint32_t unchanged_run_ = 0;
  std::int64_t last_refresh_ms_ = std::numeric_limits<std::int64_t>::min() / 2;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_STATIC_REFRESH_POLICY_H_
