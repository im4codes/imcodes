#ifndef IMCODES_REMOTE_DESKTOP_COMMON_ENCODE_SPEED_GOVERNOR_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_ENCODE_SPEED_GOVERNOR_H_

// Header-only and platform-neutral on purpose: the policy is pure arithmetic,
// so it is unit-tested on any host and shared by every encoder that wants it.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace imcodes::rd {

// A machine without a usable hardware H.264 encoder (an Intel Mac Pro running
// Apple's software encoder, say) can be asked for more pixels than it can
// encode in real time. The bandwidth estimator cannot see that: the link is
// fine, the encoder is the limit.
//
// Priorities, in order: the picture is current (low latency), then it is sharp,
// then it is smooth. So resolution is the LAST thing given up: a slow encoder
// first shows up as a lower frame rate (the pipeline keeps one frame in flight
// and drops the rest, so the encoder always works on the newest frame), and
// only when a single frame takes so long that even that is not enough does
// this governor ask for the next-smaller output size.
//
// It watches how long one frame takes from submission to encoded output. A
// median above kEncodeStepDownMs (about 8 frames a second) steps one level
// down. It steps back up only when the *predicted* time at the larger size is
// comfortably inside the budget, so it cannot oscillate: stepping down needs
// the measured median above kEncodeStepDownMs, stepping up needs the median
// scaled to the larger size at or below kEncodeStepUpMs, and a change of either
// kind starts a hold during which no further change is made.

inline constexpr double kEncodeStepDownMs = 130.0;
inline constexpr double kEncodeStepUpMs = 90.0;
// Linear scale per level: 0.75 => about 0.56x the pixels, so the time model
// below (time proportional to pixels) predicts a step-down lands near 45%
// of the previous encode time.
inline constexpr double kEncodeLevelLinearScale = 0.75;
inline constexpr double kEncodeLevelPixelRatio =
    kEncodeLevelLinearScale * kEncodeLevelLinearScale;
inline constexpr int kEncodeMaxLevel = 4;
inline constexpr int kEncodeMinWidth = 640;
inline constexpr int kEncodeMinHeight = 360;
inline constexpr std::size_t kEncodeWindowFrames = 12;
inline constexpr std::int64_t kEncodeStepDownHoldMs = 4'000;
inline constexpr std::int64_t kEncodeStepUpHoldMs = 20'000;

struct EncodeSize {
  int width = 0;
  int height = 0;
};

inline int EvenAtLeastTwoGovernor(double value) {
  const int v = static_cast<int>(std::floor(value));
  return std::max(2, v & ~1);
}

// The output size at `level` (0 = as requested). Never larger than requested.
inline EncodeSize ApplyEncodeSpeedLevel(int width, int height, int level) {
  level = std::clamp(level, 0, kEncodeMaxLevel);
  if (level == 0) return EncodeSize{width, height};
  const double scale = std::pow(kEncodeLevelLinearScale, level);
  return EncodeSize{EvenAtLeastTwoGovernor(width * scale),
                    EvenAtLeastTwoGovernor(height * scale)};
}

// The deepest level that still leaves a legible picture (>= 640x360).
inline int MaxEncodeSpeedLevel(int width, int height) {
  int level = 0;
  while (level < kEncodeMaxLevel) {
    const EncodeSize next = ApplyEncodeSpeedLevel(width, height, level + 1);
    if (next.width < kEncodeMinWidth || next.height < kEncodeMinHeight) break;
    ++level;
  }
  return level;
}

class EncodeSpeedGovernor {
 public:
  // Bounds the level for the size currently being requested.
  void SetMaxLevel(int max_level) {
    max_level_ = std::clamp(max_level, 0, kEncodeMaxLevel);
    if (level_ > max_level_) {
      level_ = max_level_;
      ClearWindow();
    }
  }

  [[nodiscard]] int level() const { return level_; }

  // A new encoder session was built (size or rate changed): the samples of the
  // old one no longer describe it. A full window of fresh samples (a median, so
  // a slow warm-up frame or two is outvoted) is needed before the next decision.
  void ClearWindow() {
    count_ = 0;
    next_ = 0;
  }

  // Feeds one frame's submit-to-output time. Returns true when level() moved.
  bool OnFrameEncoded(std::int64_t now_ms, double encode_ms) {
    if (!(encode_ms >= 0.0) || !std::isfinite(encode_ms)) return false;
    window_[next_] = encode_ms;
    next_ = (next_ + 1) % kEncodeWindowFrames;
    if (count_ < kEncodeWindowFrames) ++count_;
    if (count_ < kEncodeWindowFrames) return false;

    const double median = Median();
    const std::int64_t since_change = now_ms - last_change_ms_;
    if (median > kEncodeStepDownMs && level_ < max_level_ &&
        since_change >= kEncodeStepDownHoldMs) {
      ++level_;
      Changed(now_ms);
      return true;
    }
    if (level_ > 0 && since_change >= kEncodeStepUpHoldMs &&
        median / kEncodeLevelPixelRatio <= kEncodeStepUpMs) {
      --level_;
      Changed(now_ms);
      return true;
    }
    return false;
  }

 private:
  [[nodiscard]] double Median() const {
    std::array<double, kEncodeWindowFrames> sorted = window_;
    std::sort(sorted.begin(), sorted.begin() + static_cast<std::ptrdiff_t>(count_));
    return sorted[count_ / 2];
  }

  void Changed(std::int64_t now_ms) {
    last_change_ms_ = now_ms;
    ClearWindow();
  }

  std::array<double, kEncodeWindowFrames> window_{};
  std::size_t count_ = 0;
  std::size_t next_ = 0;
  int level_ = 0;
  int max_level_ = kEncodeMaxLevel;
  std::int64_t last_change_ms_ = std::numeric_limits<std::int64_t>::min() / 2;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_ENCODE_SPEED_GOVERNOR_H_
