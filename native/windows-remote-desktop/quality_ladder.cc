#include "third_party/imcodes_remote_desktop/quality_ladder.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace imcodes::rd {
namespace {

struct Preset {
  const char* id;
  int width;
  int height;
  int fps;
  uint32_t threshold_bps;
};

constexpr std::array<Preset, 9> kLadder = {{
    {"2160p30", 3840, 2160, 30, 15'000'000},
    {"2160p15", 3840, 2160, 15, 12'000'000},
    {"1440p30", 2560, 1440, 30, 10'000'000},
    {"1080p30", 1920, 1080, 30, 6'000'000},
    {"900p30", 1600, 900, 30, 4'500'000},
    {"720p30", 1280, 720, 30, 3'000'000},
    {"720p15", 1280, 720, 15, 1'800'000},
    {"540p15", 960, 540, 15, 1'000'000},
    {"360p5", 640, 360, 5, 350'000},
}};

int EvenAtLeastTwo(int value) {
  return std::max(2, value & ~1);
}

}  // namespace

TransportBitratePolicy SelectTransportBitratePolicy(bool direct) {
  return TransportBitratePolicy{
      kMinVideoBitrateBps,
      direct ? kInitialVideoBitrateBps : kInitialTransportBitrateBps,
      kPerPeerVideoBitrateBps,
  };
}

uint32_t ClampAggregateVideoBitrate(uint32_t requested_bps,
                                    uint32_t previous_reservation_bps,
                                    uint64_t aggregate_reserved_bps) {
  const uint64_t other_reserved = aggregate_reserved_bps >= previous_reservation_bps
                                      ? aggregate_reserved_bps - previous_reservation_bps
                                      : 0;
  const uint64_t available = other_reserved >= kAggregateVideoBitrateBps
                                 ? 0
                                 : kAggregateVideoBitrateBps - other_reserved;
  if (available < kMinVideoBitrateBps) return 0;
  return static_cast<uint32_t>(std::min<uint64_t>(
      std::clamp(requested_bps, kMinVideoBitrateBps,
                 kPerPeerVideoBitrateBps),
      available));
}

QualitySelection SelectQuality(uint32_t target_bitrate_bps,
                               int source_width,
                               int source_height) {
  const uint32_t bounded_bitrate =
      std::clamp(target_bitrate_bps, kMinVideoBitrateBps,
                 kPerPeerVideoBitrateBps);
  source_width = std::max(2, source_width);
  source_height = std::max(2, source_height);
  const Preset* preset = &kLadder.back();
  const uint64_t source_pixels =
      static_cast<uint64_t>(source_width) * source_height;
  for (const Preset& candidate : kLadder) {
    const uint64_t candidate_pixels =
        static_cast<uint64_t>(candidate.width) * candidate.height;
    if (bounded_bitrate >= candidate.threshold_bps &&
        candidate_pixels <= source_pixels) {
      preset = &candidate;
      break;
    }
  }
  const double scale = std::min(
      {1.0, static_cast<double>(preset->width) / source_width,
       static_cast<double>(preset->height) / source_height});
  return QualitySelection{
      preset->id,
      EvenAtLeastTwo(static_cast<int>(std::floor(source_width * scale))),
      EvenAtLeastTwo(static_cast<int>(std::floor(source_height * scale))),
      preset->fps,
      bounded_bitrate,
  };
}

}  // namespace imcodes::rd
