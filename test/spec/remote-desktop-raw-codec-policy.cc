#include <cstdlib>
#include <iostream>
#include <string_view>

#include "raw_codec_policy.h"

namespace macos = imcodes::remote_desktop::macos;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "raw codec policy failure: " << message << '\n';
  std::exit(1);
}

void OnlyANoHardwareMacWhoseCaptureScalesMayOfferRawCodecs() {
  // CGDisplayStream on a Mac with only Apple's software H.264 encoder: the case
  // the whole path exists for.
  const macos::RawCodecDecision pro = macos::DecideRawCodecs(false, true);
  Require(pro.allowed && pro.reason == macos::RawCodecReason::kAllowed, "no hardware + scalable capture: allowed");

  // A Mac with a hardware encoder keeps it, whatever the capture can do.
  Require(!macos::DecideRawCodecs(true, true).allowed, "hardware H.264: not allowed");
  Require(macos::DecideRawCodecs(true, true).reason == macos::RawCodecReason::kHardwareH264, "reason: hardware");
  Require(!macos::DecideRawCodecs(true, false).allowed, "hardware + unscalable capture: not allowed");
  Require(macos::DecideRawCodecs(true, false).reason == macos::RawCodecReason::kHardwareH264,
          "hardware wins as the stated reason");

  // ScreenCaptureKit (macOS >= 13) without a hardware encoder, e.g. a VM: the
  // capture would hand libvpx native-size frames forever, so H.264 stays.
  const macos::RawCodecDecision vm = macos::DecideRawCodecs(false, false);
  Require(!vm.allowed && vm.reason == macos::RawCodecReason::kCaptureCannotScale,
          "no hardware but capture cannot scale: stays on H.264");
}

void ReasonsHaveStableLogTokens() {
  Require(std::string_view(macos::RawCodecReasonName(macos::RawCodecReason::kAllowed)) == "allowed", "allowed");
  Require(std::string_view(macos::RawCodecReasonName(macos::RawCodecReason::kHardwareH264)) == "hardware_h264", "hardware");
  Require(std::string_view(macos::RawCodecReasonName(macos::RawCodecReason::kCaptureCannotScale)) == "capture_cannot_scale",
          "cannot scale");
}

}  // namespace

int main() {
  OnlyANoHardwareMacWhoseCaptureScalesMayOfferRawCodecs();
  ReasonsHaveStableLogTokens();
  std::cout << "raw codec policy counterfactuals passed\n";
  return 0;
}
