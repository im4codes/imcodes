#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string_view>

#include "quality_ladder.h"

namespace rd = imcodes::rd;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "remote-desktop common protocol extraction failure: " << message
            << '\n';
  std::exit(1);
}

}  // namespace

int main() {
  // The pre-SDP ICE queue used to be exercised here through
  // rd::PendingRemoteIceCandidates. That class was deleted: no production
  // translation unit consumed it any more once the queue moved into
  // TransportSessionCore, which additionally terminates on candidate overflow
  // instead of merely refusing the push.
  //
  // The coverage did not move here, because it already exists in a stronger
  // form: remote-desktop-common-transport-session-core.test.ts compiles
  // transport_session_core.cc with the same -Wall -Wextra -Werror -pedantic
  // sanitizer flags and nothing but -I on this directory, so the live queue is
  // proven platform-SDK-free there, buffering and flush order included.
  // Duplicating its adapter and ladder fakes into this harness would copy ~100
  // lines to re-prove that.

  const rd::TransportBitratePolicy direct =
      rd::SelectTransportBitratePolicy(true);
  const rd::TransportBitratePolicy relayed =
      rd::SelectTransportBitratePolicy(false);
  Require(direct.min_bps == 350'000 &&
              direct.start_bps == 12'000'000 &&
              direct.max_bps == 15'000'000,
          "direct transport bitrate fixture remains unchanged");
  Require(relayed.min_bps == direct.min_bps &&
              relayed.start_bps == 1'500'000 &&
              relayed.max_bps == direct.max_bps,
          "relay transport bitrate fixture remains unchanged");

  const rd::QualitySelection quality =
      rd::SelectQuality(15'000'000, 1366, 768);
  Require(std::string_view(quality.id) == "720p30" &&
              quality.width == 1280 && quality.height == 718 &&
              quality.fps == 30 && quality.bitrate_bps == 15'000'000,
          "Windows quality-ladder fixture remains byte-for-byte compatible");
  Require(rd::ClampAggregateVideoBitrate(15'000'000, 0, 50'000'000) ==
              10'000'000,
          "aggregate bitrate reservation remains bounded");
  return 0;
}
