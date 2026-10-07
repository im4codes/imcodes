#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string_view>

#include "static_refresh_policy.h"

namespace rd = imcodes::rd;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "static refresh policy failure: " << message << '\n';
  std::exit(1);
}

constexpr std::uint32_t kPlenty = 30;
constexpr std::uint32_t kFast = 8'000'000;

// The capture's keep-alive: one unchanged frame every 500 ms.
bool Still(rd::StaticRefreshPolicy& policy, std::int64_t& now, int frames,
           std::uint32_t since_key = kPlenty, std::uint32_t bitrate = kFast) {
  bool fired = false;
  for (int i = 0; i < frames; ++i) {
    now += 500;
    fired = policy.OnFrame(true, since_key, bitrate, now) || fired;
  }
  return fired;
}

void AMovingPictureNeverRefreshes() {
  rd::StaticRefreshPolicy policy;
  for (int i = 0; i < 200; ++i) {
    Require(!policy.OnFrame(false, kPlenty, kFast, i * 33), "changed frames never trigger a refresh");
  }
}

void OnlyAGenuinelySettledPictureRefreshes() {
  // A short pause (typing, reading) is one or two keep-alive frames: not still enough.
  rd::StaticRefreshPolicy policy;
  std::int64_t now = 0;
  policy.OnFrame(false, kPlenty, kFast, now);
  Require(!Still(policy, now, 1), "after 0.5 s of quiet: no refresh");
  Require(!Still(policy, now, 1), "after 1.0 s of quiet: no refresh");
  Require(Still(policy, now, 1), "after 1.5 s of quiet (the 3rd unchanged frame): refresh");
}

void ARefreshHappensOncePerStaticRun() {
  rd::StaticRefreshPolicy policy;
  std::int64_t now = 0;
  policy.OnFrame(false, kPlenty, kFast, now);
  Require(Still(policy, now, 3), "the run settles and refreshes");
  Require(!Still(policy, now, 40), "no second refresh within the same static run");
}

void APauseThatEndsBeforeSettlingDoesNothing() {
  rd::StaticRefreshPolicy policy;
  std::int64_t now = 0;
  for (int pause = 0; pause < 50; ++pause) {
    policy.OnFrame(false, kPlenty, kFast, now);
    Require(!Still(policy, now, 2), "a 1 s pause never refreshes");
  }
}

void ARefreshNeedsEnoughCodedFramesSinceTheKeyframe() {
  rd::StaticRefreshPolicy policy;
  std::int64_t now = 0;
  policy.OnFrame(false, 3, kFast, now);
  Require(!Still(policy, now, 3, 3), "3 coded frames: the refresh would be worse than the keyframe it replaces");
  policy.OnFrame(false, 9, kFast, now);
  Require(!Still(policy, now, 3, 9), "9 coded frames: still too few");
  policy.OnFrame(false, 10, kFast, now);
  Require(Still(policy, now, 3, 10), "10 coded frames: allowed");
}

void ASlowLinkNeverRefreshes() {
  rd::StaticRefreshPolicy policy;
  std::int64_t now = 0;
  policy.OnFrame(false, kPlenty, 5'999'999, now);
  Require(!Still(policy, now, 3, kPlenty, 5'999'999), "below 6 Mbps the burst would take too long");
  policy.OnFrame(false, kPlenty, 6'000'000, now);
  Require(Still(policy, now, 3, kPlenty, 6'000'000), "exactly 6 Mbps is enough");
}

void RefreshesAreSpacedAtLeastFiveSeconds() {
  rd::StaticRefreshPolicy policy;
  std::int64_t now = 0;
  policy.OnFrame(false, kPlenty, kFast, now);
  Require(Still(policy, now, 3), "first refresh");
  const std::int64_t first = now;
  // Motion resumes and settles again straight away.
  now += 200;
  policy.OnFrame(false, kPlenty, kFast, now);
  Require(!Still(policy, now, 3), "a second static run inside 5 s is not refreshed");
  Require(now - first < rd::kStaticRefreshMinIntervalMs, "(that run really was inside the spacing)");
  now = first + 6'000;
  policy.OnFrame(false, kPlenty, kFast, now);
  Require(Still(policy, now, 3), "6 s after the first: allowed");
}

void ARefusedRunLeavesNothingBehind() {
  rd::StaticRefreshPolicy policy;
  std::int64_t now = 0;
  policy.OnFrame(false, 2, kFast, now);
  Require(!Still(policy, now, 3, 2), "refused (too few frames)");
  policy.OnFrame(false, kPlenty, kFast, now);
  Require(Still(policy, now, 3), "the next run refreshes");
}

void ResetForgetsTheRunButNotTheSpacing() {
  rd::StaticRefreshPolicy policy;
  std::int64_t now = 0;
  policy.OnFrame(false, kPlenty, kFast, now);
  Require(Still(policy, now, 3), "refreshed");
  policy.Reset();
  Require(!Still(policy, now, 3), "interval rule survives a reset");
  policy.OnFrame(false, kPlenty, kFast, now);
  now += 6'000;
  Require(Still(policy, now, 3), "refresh allowed again after the interval");
}

}  // namespace

int main() {
  AMovingPictureNeverRefreshes();
  OnlyAGenuinelySettledPictureRefreshes();
  ARefreshHappensOncePerStaticRun();
  APauseThatEndsBeforeSettlingDoesNothing();
  ARefreshNeedsEnoughCodedFramesSinceTheKeyframe();
  ASlowLinkNeverRefreshes();
  RefreshesAreSpacedAtLeastFiveSeconds();
  ARefusedRunLeavesNothingBehind();
  ResetForgetsTheRunButNotTheSpacing();
  std::cout << "static refresh policy counterfactuals passed\n";
  return 0;
}
