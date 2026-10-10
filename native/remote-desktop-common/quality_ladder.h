#ifndef IMCODES_REMOTE_DESKTOP_COMMON_QUALITY_LADDER_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_QUALITY_LADDER_H_

#include <cstdint>

namespace imcodes::rd {

struct QualitySelection {
  const char* id;
  int width;
  int height;
  int fps;
  uint32_t bitrate_bps;
};

// What the viewer asked for (per viewer: every viewer has its own encoder).
// A default-constructed preference reproduces the automatic selection exactly.
enum class QualityPriority {
  // Highest ladder rung the bitrate affords (the historical behaviour).
  kBalanced,
  // Keep the frame rate; give up resolution first ("Smooth").
  kFramerate,
  // Keep the resolution; give up frame rate first ("Sharp").
  kResolution,
};

struct QualityPreference {
  // Largest rung height to use; 0 = no cap (native).
  int max_height = 0;
  // Frame-rate ceiling: 15, 30 or 60. 60 fps rungs are only ever considered
  // when this allows them.
  int max_fps = 30;
  // Encoder bitrate ceiling; 0 = the default per-peer ceiling. Above
  // kPerPeerVideoBitrateBps it RAISES the ceiling, up to
  // kMaxViewerVideoBitrateBps (Ultra: 4K text needs more than the default).
  uint32_t max_bitrate_bps = 0;
  QualityPriority priority = QualityPriority::kBalanced;
};

struct TransportBitratePolicy {
  uint32_t min_bps;
  uint32_t start_bps;
  uint32_t max_bps;
};

// Seed libwebrtc with a crisp desktop prior without turning that prior into a
// hard floor: congestion feedback may still reduce the stream to 350 kbps.
// Direct sessions may then probe up to the user-facing 15 Mbps ceiling.
inline constexpr uint32_t kMinVideoBitrateBps = 350'000;
inline constexpr uint32_t kInitialVideoBitrateBps = 12'000'000;
/**
 * What the bandwidth estimator is told to start from.
 *
 * This is not the encoder's target — the estimator drives that — it is how
 * hard the very first moments of a session push. A node whose UDP is blocked
 * reaches the viewer over a TURN relay on a single TCP connection, where
 * everything is strictly in order: opening the session at the encoder's
 * headroom put a multi-megabit burst in front of the SCTP handshake that the
 * input channels need, so the picture arrived while input stayed dead for
 * seconds. Start modestly and let the estimator climb, which it does in about
 * a second on a link that can take it.
 */
inline constexpr uint32_t kInitialTransportBitrateBps = 1'500'000;
inline constexpr uint32_t kPerPeerVideoBitrateBps = 15'000'000;
// The most one viewer may ask its own stream to carry.
inline constexpr uint32_t kMaxViewerVideoBitrateBps = 30'000'000;
inline constexpr uint32_t kAggregateVideoBitrateBps = 60'000'000;

// Keep relay startup conservative so video cannot starve the input-channel
// handshake on a shared ordered TURN/TCP path. Once ICE proves the session is
// direct, reseed libwebrtc with the crisp desktop prior. The minimum remains
// 350 kbps in both cases, so congestion feedback can always back off.
//
// `relay_cap_bps` (0 = none) is the operator's relayed-traffic ceiling: when
// the session is NOT direct it bounds both the start and the maximum, so the
// estimator never pushes a relayed stream past it. Direct sessions ignore it.
//
// `viewer_ceiling_bps` is ViewerVideoBitrateCeiling() of the viewer's
// preference: the most the estimator may reach on a direct route.
TransportBitratePolicy SelectTransportBitratePolicy(
    bool direct,
    uint32_t relay_cap_bps = 0,
    uint32_t viewer_ceiling_bps = kPerPeerVideoBitrateBps);

// The bitrate this viewer's stream may reach: the default per-peer ceiling,
// or more when the viewer explicitly asked for more (never beyond
// kMaxViewerVideoBitrateBps). The encoder, the RTP encoding and the
// bandwidth estimator are all bounded by it.
uint32_t ViewerVideoBitrateCeiling(const QualityPreference& preference);

// The encoder bitrate ceiling to apply: the viewer's own cap, tightened by the
// relay cap while the session is relayed. 0 = no cap.
uint32_t EffectiveBitrateCap(uint32_t viewer_cap_bps,
                             uint32_t relay_cap_bps,
                             bool direct);

// Returns this encoder's new reservation after accounting for all other live
// encoders. A zero result means the aggregate budget cannot fit even the
// minimum production preset.
uint32_t ClampAggregateVideoBitrate(uint32_t requested_bps,
                                    uint32_t previous_reservation_bps,
                                    uint64_t aggregate_reserved_bps);

// Deterministically maps libwebrtc's upstream target bitrate to the shared
// production ladder. This function performs no network estimation.
QualitySelection SelectQuality(uint32_t target_bitrate_bps,
                               int source_width,
                               int source_height);

// As above, within the viewer's preference: rungs above `max_height` or
// `max_fps` are never chosen, the target is capped at `max_bitrate_bps`, and
// `priority` decides which of the affordable rungs wins.
QualitySelection SelectQuality(uint32_t target_bitrate_bps,
                               int source_width,
                               int source_height,
                               const QualityPreference& preference);

/**
 * Discounts `target_bitrate_bps` in proportion to `backlog_pressure`, a
 * caller-tracked, unitless measure of how far a LOCAL encode pipeline is
 * falling behind capture (e.g. a rolling counter that rises when frames are
 * dropped for still being busy with the previous ones and decays on frames
 * that keep up). Feed the result back into `SelectQuality` to land on a
 * lower rung of the ladder.
 *
 * Network congestion control has nothing to say about this: a CPU-bound
 * software encode path, or a GPU shared with something else, can fall
 * behind capture on a fast, completely uncongested link, and the bandwidth
 * estimator will keep authorizing a target the encoder cannot actually
 * sustain. Left alone, that grows an ever-larger backlog of stale frames
 * instead of a smaller, live picture -- exactly backwards from "keep it
 * blurry, keep it live." This turns local lateness into the same kind of
 * downward pressure network congestion already applies, so a struggling
 * encoder pulls itself down a rung even while the network stays perfectly
 * happy with the higher target.
 *
 * `backlog_pressure` of 0 returns `target_bitrate_bps` unchanged, and so
 * does a target already at or below `kMinVideoBitrateBps`. The reduction
 * never lowers the result below `kMinVideoBitrateBps` and never raises it
 * above `target_bitrate_bps` -- this only ever discounts what the caller
 * already decided, never overrides it upward.
 */
uint32_t ApplyEncodeBacklogPressure(uint32_t target_bitrate_bps,
                                    uint32_t backlog_pressure);

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_QUALITY_LADDER_H_
