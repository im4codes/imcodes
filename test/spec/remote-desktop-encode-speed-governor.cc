#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string_view>

#include "encode_speed_governor.h"

namespace rd = imcodes::rd;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "encode speed governor failure: " << message << '\n';
  std::exit(1);
}

// Feeds `frames` frames of `encode_ms`, one every `interval_ms`, returning the
// number of level changes.
int Feed(rd::EncodeSpeedGovernor& governor, std::int64_t& now_ms, int frames,
         double encode_ms, std::int64_t interval_ms = 100) {
  int changes = 0;
  for (int i = 0; i < frames; ++i) {
    now_ms += interval_ms;
    if (governor.OnFrameEncoded(now_ms, encode_ms)) ++changes;
  }
  return changes;
}

void SizesNeverGrowAndStayEven() {
  for (int level = 0; level <= rd::kEncodeMaxLevel; ++level) {
    const rd::EncodeSize size = rd::ApplyEncodeSpeedLevel(2560, 1350, level);
    Require(size.width <= 2560 && size.height <= 1350, "never larger than requested");
    Require(size.width % 2 == 0 && size.height % 2 == 0, "even dimensions");
    if (level > 0) {
      const rd::EncodeSize previous = rd::ApplyEncodeSpeedLevel(2560, 1350, level - 1);
      Require(size.width < previous.width, "each level is smaller");
    }
  }
  const rd::EncodeSize level0 = rd::ApplyEncodeSpeedLevel(2560, 1350, 0);
  Require(level0.width == 2560 && level0.height == 1350, "level 0 is exactly the request");
  const rd::EncodeSize level1 = rd::ApplyEncodeSpeedLevel(2560, 1350, 1);
  Require(level1.width == 1920 && level1.height == 1012, "level 1 is 1920x1012");
}

void FloorKeepsAPictureLegible() {
  Require(rd::MaxEncodeSpeedLevel(2560, 1350) == rd::kEncodeMaxLevel, "5K-class output can go deep");
  Require(rd::MaxEncodeSpeedLevel(1280, 720) == 2, "720p stops at 720x405... never below 640x360");
  const int deepest = rd::MaxEncodeSpeedLevel(1280, 720);
  const rd::EncodeSize size = rd::ApplyEncodeSpeedLevel(1280, 720, deepest);
  Require(size.width >= rd::kEncodeMinWidth && size.height >= rd::kEncodeMinHeight, "floor respected");
  Require(rd::MaxEncodeSpeedLevel(640, 360) == 0, "already at the floor: no levels");
}

void FastEncoderNeverChangesLevel() {
  rd::EncodeSpeedGovernor governor;
  std::int64_t now = 0;
  Require(Feed(governor, now, 500, 58.0) == 0, "a 58 ms encoder (17 fps) keeps full resolution");
  Require(governor.level() == 0, "still level 0");
}

void SlowEncoderStepsDownOnceThenHolds() {
  rd::EncodeSpeedGovernor governor;
  std::int64_t now = 0;
  Require(Feed(governor, now, 40, 200.0) == 1, "200 ms per frame steps down exactly once in the first seconds");
  Require(governor.level() == 1, "level 1");
  // Still slow after the step: the hold prevents an immediate second step...
  Require(Feed(governor, now, 10, 200.0, 100) == 0, "no second step inside the hold");
  // ...but a persistently slow encoder keeps stepping down, one level per hold.
  Require(Feed(governor, now, 200, 200.0, 100) >= 1, "later steps happen after the hold");
  Require(governor.level() <= rd::kEncodeMaxLevel, "bounded");
}

void NoiseBelowTheThresholdDoesNotStep() {
  rd::EncodeSpeedGovernor governor;
  std::int64_t now = 0;
  // Median stays at 100 ms even though a third of the frames spike: below the
  // 130 ms threshold, so resolution is kept.
  int changes = 0;
  for (int i = 0; i < 300; ++i) {
    now += 100;
    const double ms = (i % 3 == 0) ? 400.0 : 100.0;
    if (governor.OnFrameEncoded(now, ms)) ++changes;
  }
  Require(changes == 0, "median-based decision ignores spikes");
}

void StepsBackUpOnlyWhenPredictionFits() {
  rd::EncodeSpeedGovernor governor;
  std::int64_t now = 0;
  Feed(governor, now, 40, 200.0);
  Require(governor.level() == 1, "stepped down");
  // At the smaller size frames take 60 ms; the same content at the larger
  // size would take 60 / 0.5625 = 107 ms > 90 ms: stay down, however long.
  Require(Feed(governor, now, 600, 60.0, 100) == 0, "does not step up when the larger size would be too slow");
  Require(governor.level() == 1, "still level 1");
  // At the smaller size frames take 40 ms; predicted 71 ms <= 90 ms: step up,
  // but only after the up-hold.
  const std::int64_t before = now;
  int up_changes = 0;
  while (up_changes == 0 && now - before < 120'000) {
    up_changes += Feed(governor, now, 1, 40.0, 100);
  }
  Require(up_changes == 1, "steps up once the prediction fits");
  Require(governor.level() == 0, "back at the requested size");
  // The step-down landed on the 12th frame (a full window) at t=1200 ms.
  Require(now - 1'200 >= rd::kEncodeStepUpHoldMs, "step-up waited for the up-hold");
}

void DoesNotOscillate() {
  // Worst case for flip-flopping: a link where the larger size takes just over
  // the step-down threshold and the smaller size just under the step-up one.
  rd::EncodeSpeedGovernor governor;
  std::int64_t now = 0;
  int changes = 0;
  for (int i = 0; i < 6000; ++i) {  // 10 minutes at 10 frames/s
    now += 100;
    const double ms = governor.level() == 0 ? 135.0 : 135.0 * rd::kEncodeLevelPixelRatio;
    if (governor.OnFrameEncoded(now, ms)) ++changes;
  }
  // Level 1 takes 76 ms; predicted at level 0 is 135 ms > 90: it must settle.
  Require(changes == 1, "settles after a single step");
}

void SlowWarmupFramesAreOutvoted() {
  rd::EncodeSpeedGovernor governor;
  std::int64_t now = 0;
  // A fresh session's first couple of frames are slow; the median ignores them.
  governor.OnFrameEncoded(now += 100, 900.0);
  governor.OnFrameEncoded(now += 100, 900.0);
  Require(Feed(governor, now, 200, 50.0) == 0, "a slow warm-up does not trigger a step");
}

void MaxLevelClampsAndClears() {
  rd::EncodeSpeedGovernor governor;
  std::int64_t now = 0;
  Feed(governor, now, 40, 300.0);
  Require(governor.level() == 1, "level 1");
  governor.SetMaxLevel(0);
  Require(governor.level() == 0, "lowering the bound lowers the level");
  governor.SetMaxLevel(rd::kEncodeMaxLevel);
  Require(governor.level() == 0, "raising the bound does not raise the level");
}

void NonFiniteSamplesAreRejected() {
  rd::EncodeSpeedGovernor governor;
  Require(!governor.OnFrameEncoded(0, -1.0), "negative");
  Require(!governor.OnFrameEncoded(0, std::numeric_limits<double>::quiet_NaN()), "nan");
  Require(!governor.OnFrameEncoded(0, std::numeric_limits<double>::infinity()), "inf");
  Require(governor.level() == 0, "unchanged");
}

// Deterministic pseudo-random jitter (no <random>: the sequence is the same on
// every platform and stdlib).
class Jitter {
 public:
  explicit Jitter(std::uint32_t seed) : state_(seed) {}
  double Between(double low, double high) {
    state_ = state_ * 1664525u + 1013904223u;
    return low + (high - low) * ((state_ >> 8) / 16777216.0);
  }

 private:
  std::uint32_t state_;
};

void AJitteryNetworkCannotMakeTheSizeFlipFlop() {
  // Worst case for flip-flopping: encode times scattered across the threshold,
  // for half an hour. The size may change, but never faster than the holds allow
  // (a step down after 4 s, a step up only after 20 s), and the quiet case
  // below proves the bound is not just a loose ceiling.
  rd::EncodeSpeedGovernor governor;
  Jitter jitter(12345);
  std::int64_t now = 0;
  int changes = 0;
  int last_level = governor.level();
  std::int64_t last_change = -1'000'000'000;  // before the first change the governor has no hold
  const std::int64_t duration_ms = 30LL * 60 * 1000;
  while (now < duration_ms) {
    now += 100;
    const double raw = jitter.Between(40.0, 230.0);
    const double ms = governor.level() == 0 ? raw : raw * rd::kEncodeLevelPixelRatio;
    if (governor.OnFrameEncoded(now, ms)) {
      ++changes;
      const bool down = governor.level() > last_level;
      // A change never comes sooner than the hold of the direction it takes:
      // a step down 4 s after the previous change, a step up 20 s after it.
      Require(now - last_change >= (down ? rd::kEncodeStepDownHoldMs : rd::kEncodeStepUpHoldMs),
              "a change respects its hold");
      last_level = governor.level();
      last_change = now;
    }
  }
  // At most one step down and one step up per 24 s cycle.
  Require(changes <= static_cast<int>(2 * (duration_ms / 24'000) + 2), "bounded by the holds, whatever the jitter");
  Require(governor.level() >= 0 && governor.level() <= rd::kEncodeMaxLevel, "level stays in range");
}

void AQuietLinkDoesNotChangeTheSizeAtAll() {
  rd::EncodeSpeedGovernor governor;
  Jitter jitter(777);
  std::int64_t now = 0;
  int changes = 0;
  for (int i = 0; i < 18000; ++i) {  // 30 minutes at 10 frames/s
    now += 100;
    if (governor.OnFrameEncoded(now, jitter.Between(40.0, 118.0))) ++changes;
  }
  Require(changes == 0, "jitter that stays below the threshold never steps the size");
}

}  // namespace

int main() {
  SizesNeverGrowAndStayEven();
  FloorKeepsAPictureLegible();
  FastEncoderNeverChangesLevel();
  SlowEncoderStepsDownOnceThenHolds();
  NoiseBelowTheThresholdDoesNotStep();
  StepsBackUpOnlyWhenPredictionFits();
  DoesNotOscillate();
  SlowWarmupFramesAreOutvoted();
  MaxLevelClampsAndClears();
  NonFiniteSamplesAreRejected();
  AJitteryNetworkCannotMakeTheSizeFlipFlop();
  AQuietLinkDoesNotChangeTheSizeAtAll();
  std::cout << "encode speed governor counterfactuals passed\n";
  return 0;
}
