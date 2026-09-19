#include "quality_ladder.h"

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

// Ordered by descending threshold. The 60 fps rungs are only eligible when a
// viewer's preference allows 60 fps; the 30 fps low-bitrate rungs let
// "Smooth" keep its frame rate by giving up resolution; the 10 fps rungs keep
// text legible on a ~500 kbps relay-capped path. Mirrored in
// shared/remote-desktop.ts (REMOTE_DESKTOP_QUALITY_LADDER).
constexpr std::array<Preset, 16> kLadder = {{
    {"2160p30", 3840, 2160, 30, 15'000'000},
    {"1440p60", 2560, 1440, 60, 14'000'000},
    {"2160p15", 3840, 2160, 15, 12'000'000},
    {"1440p30", 2560, 1440, 30, 10'000'000},
    {"1080p60", 1920, 1080, 60, 9'000'000},
    {"1080p30", 1920, 1080, 30, 6'000'000},
    {"720p60", 1280, 720, 60, 4'800'000},
    {"900p30", 1600, 900, 30, 4'500'000},
    {"720p30", 1280, 720, 30, 3'000'000},
    {"720p15", 1280, 720, 15, 1'800'000},
    {"540p30", 960, 540, 30, 1'600'000},
    {"540p15", 960, 540, 15, 1'000'000},
    {"360p30", 640, 360, 30, 700'000},
    {"720p10", 1280, 720, 10, 450'000},
    {"540p10", 960, 540, 10, 380'000},
    {"360p5", 640, 360, 5, 350'000},
}};

int EvenAtLeastTwo(int value) {
  return std::max(2, value & ~1);
}

}  // namespace

TransportBitratePolicy SelectTransportBitratePolicy(bool direct,
                                                    uint32_t relay_cap_bps) {
  TransportBitratePolicy policy{
      kMinVideoBitrateBps,
      direct ? kInitialVideoBitrateBps : kInitialTransportBitrateBps,
      kPerPeerVideoBitrateBps,
  };
  if (!direct && relay_cap_bps > 0) {
    const uint32_t cap = std::max(relay_cap_bps, kMinVideoBitrateBps);
    policy.max_bps = std::min(policy.max_bps, cap);
    policy.start_bps = std::min(policy.start_bps, cap);
  }
  return policy;
}

uint32_t EffectiveBitrateCap(uint32_t viewer_cap_bps,
                             uint32_t relay_cap_bps,
                             bool direct) {
  const uint32_t relay = direct ? 0 : relay_cap_bps;
  if (viewer_cap_bps == 0) return relay;
  if (relay == 0) return viewer_cap_bps;
  return std::min(viewer_cap_bps, relay);
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
  return SelectQuality(target_bitrate_bps, source_width, source_height,
                       QualityPreference{});
}

QualitySelection SelectQuality(uint32_t target_bitrate_bps,
                               int source_width,
                               int source_height,
                               const QualityPreference& preference) {
  uint32_t ceiling = kPerPeerVideoBitrateBps;
  if (preference.max_bitrate_bps > 0) {
    ceiling = std::clamp(preference.max_bitrate_bps, kMinVideoBitrateBps,
                         kPerPeerVideoBitrateBps);
  }
  const uint32_t bounded_bitrate =
      std::clamp(target_bitrate_bps, kMinVideoBitrateBps, ceiling);
  source_width = std::max(2, source_width);
  source_height = std::max(2, source_height);
  const uint64_t source_pixels =
      static_cast<uint64_t>(source_width) * source_height;
  const int max_fps = preference.max_fps > 0 ? preference.max_fps : 30;
  const auto affordable = [&](const Preset& candidate) {
    const uint64_t candidate_pixels =
        static_cast<uint64_t>(candidate.width) * candidate.height;
    return bounded_bitrate >= candidate.threshold_bps &&
           candidate_pixels <= source_pixels && candidate.fps <= max_fps &&
           (preference.max_height <= 0 ||
            candidate.height <= preference.max_height);
  };
  const Preset* preset = nullptr;
  switch (preference.priority) {
    case QualityPriority::kFramerate: {
      // Keep the frame rate the viewer allows (capped at 30 for this pass;
      // 60 is a ceiling, not a floor), shedding resolution first. Only when
      // no rung at that rate is affordable does the frame rate drop.
      const int wanted_fps = std::min(max_fps, 30);
      for (const Preset& candidate : kLadder) {
        if (affordable(candidate) && candidate.fps >= wanted_fps) {
          preset = &candidate;
          break;
        }
      }
      break;
    }
    case QualityPriority::kResolution: {
      // Most pixels the bitrate affords; the higher frame rate breaks ties.
      for (const Preset& candidate : kLadder) {
        if (!affordable(candidate)) continue;
        const uint64_t pixels =
            static_cast<uint64_t>(candidate.width) * candidate.height;
        const uint64_t best_pixels =
            preset == nullptr
                ? 0
                : static_cast<uint64_t>(preset->width) * preset->height;
        if (preset == nullptr || pixels > best_pixels ||
            (pixels == best_pixels && candidate.fps > preset->fps)) {
          preset = &candidate;
        }
      }
      break;
    }
    case QualityPriority::kBalanced:
      break;
  }
  if (preset == nullptr) {
    for (const Preset& candidate : kLadder) {
      if (affordable(candidate)) {
        preset = &candidate;
        break;
      }
    }
  }
  if (preset == nullptr) preset = &kLadder.back();
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

uint32_t ApplyEncodeBacklogPressure(uint32_t target_bitrate_bps,
                                    uint32_t backlog_pressure) {
  // A target already at or below the floor has nothing left to discount.
  // Congestion control does report such targets on a fresh path, and the
  // clamp below would otherwise be handed a floor above its ceiling -- the
  // hardened libc++ in the macOS worker aborts on that (node m3: a backlogged
  // dual-5K encoder crashed on every connect).
  if (backlog_pressure == 0 || target_bitrate_bps <= kMinVideoBitrateBps) {
    return target_bitrate_bps;
  }
  // Beyond this the reduction is already deep enough that kMinVideoBitrateBps
  // clamping dominates; capping keeps the pow() argument small and bounded.
  constexpr uint32_t kMaxBacklogPressure = 12;
  const uint32_t capped = std::min(backlog_pressure, kMaxBacklogPressure);
  // Halves roughly every 3 steps of sustained pressure: gentle enough that a
  // couple of isolated blips do not visibly change anything, steep enough
  // that real, sustained backlog reaches the floor within a handful of
  // frames rather than degrading so slowly the queue keeps growing anyway.
  const double reduction = std::pow(0.5, static_cast<double>(capped) / 3.0);
  const double reduced = static_cast<double>(target_bitrate_bps) * reduction;
  return static_cast<uint32_t>(std::clamp(
      reduced, static_cast<double>(kMinVideoBitrateBps),
      static_cast<double>(target_bitrate_bps)));
}

}  // namespace imcodes::rd
