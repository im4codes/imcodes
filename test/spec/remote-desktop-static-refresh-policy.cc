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

void AMovingPictureNeverRefreshes() {
  rd::StaticRefreshPolicy policy;
  for (int i = 0; i < 200; ++i) {
    Require(!policy.OnFrame(false, kPlenty, kFast, i * 33), "changed frames never trigger a refresh");
  }
}

void TheFirstUnchangedFrameOfARunRefreshesOnce() {
  rd::StaticRefreshPolicy policy;
  Require(!policy.OnFrame(false, kPlenty, kFast, 0), "motion");
  Require(policy.OnFrame(true, kPlenty, kFast, 500), "the picture settled: refresh");
  for (int i = 1; i <= 20; ++i) {
    Require(!policy.OnFrame(true, kPlenty, kFast, 500 + i * 500), "no second refresh within the same static run");
  }
}

void ARefreshNeedsEnoughCodedFramesSinceTheKeyframe() {
  rd::StaticRefreshPolicy policy;
  policy.OnFrame(false, 3, kFast, 0);
  Require(!policy.OnFrame(true, 3, kFast, 500), "3 coded frames: the refresh would be worse than the keyframe it replaces");
  policy.OnFrame(false, 9, kFast, 1000);
  Require(!policy.OnFrame(true, 9, kFast, 1500), "9 coded frames: still too few");
  policy.OnFrame(false, 10, kFast, 2000);
  Require(policy.OnFrame(true, 10, kFast, 2500), "10 coded frames: allowed");
}

void ASlowLinkNeverRefreshes() {
  rd::StaticRefreshPolicy policy;
  policy.OnFrame(false, kPlenty, 3'999'999, 0);
  Require(!policy.OnFrame(true, kPlenty, 3'999'999, 500), "below 4 Mbps the burst would take too long");
  policy.OnFrame(false, kPlenty, 4'000'000, 1000);
  Require(policy.OnFrame(true, kPlenty, 4'000'000, 1500), "exactly 4 Mbps is enough");
}

void RefreshesAreSpacedAtLeastFiveSeconds() {
  rd::StaticRefreshPolicy policy;
  policy.OnFrame(false, kPlenty, kFast, 0);
  Require(policy.OnFrame(true, kPlenty, kFast, 1000), "first refresh");
  // Motion resumes and stops again right away.
  policy.OnFrame(false, kPlenty, kFast, 1200);
  Require(!policy.OnFrame(true, kPlenty, kFast, 1800), "a second static run inside 5 s is not refreshed");
  policy.OnFrame(false, kPlenty, kFast, 5000);
  Require(!policy.OnFrame(true, kPlenty, kFast, 5900), "4.9 s after the first: still too soon");
  policy.OnFrame(false, kPlenty, kFast, 6100);
  Require(policy.OnFrame(true, kPlenty, kFast, 6400), "5.4 s after the first: allowed");
}

void AnUnrefreshedRunCanStillRefreshLater() {
  // A run that was refused (too few frames) leaves no state behind that blocks
  // the next one.
  rd::StaticRefreshPolicy policy;
  policy.OnFrame(false, 2, kFast, 0);
  Require(!policy.OnFrame(true, 2, kFast, 500), "refused");
  policy.OnFrame(false, kPlenty, kFast, 900);
  Require(policy.OnFrame(true, kPlenty, kFast, 1400), "the next run refreshes");
}

void ResetForgetsTheRun() {
  rd::StaticRefreshPolicy policy;
  policy.OnFrame(false, kPlenty, kFast, 0);
  policy.OnFrame(true, kPlenty, kFast, 500);  // refreshed
  policy.Reset();
  // After a rebuild the encoder's first picture may already be unchanged: the
  // run counts as new, but the interval rule still holds.
  Require(!policy.OnFrame(true, kPlenty, kFast, 1000), "interval rule survives a reset");
  policy.OnFrame(false, kPlenty, kFast, 7000);
  Require(policy.OnFrame(true, kPlenty, kFast, 7500), "refresh allowed again after the interval");
}

}  // namespace

int main() {
  AMovingPictureNeverRefreshes();
  TheFirstUnchangedFrameOfARunRefreshesOnce();
  ARefreshNeedsEnoughCodedFramesSinceTheKeyframe();
  ASlowLinkNeverRefreshes();
  RefreshesAreSpacedAtLeastFiveSeconds();
  AnUnrefreshedRunCanStillRefreshLater();
  ResetForgetsTheRun();
  std::cout << "static refresh policy counterfactuals passed\n";
  return 0;
}
