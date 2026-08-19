#ifndef IMCODES_REMOTE_DESKTOP_QUALITY_LADDER_H_
#define IMCODES_REMOTE_DESKTOP_QUALITY_LADDER_H_

#include <cstdint>

namespace imcodes::rd {

struct QualitySelection {
  const char* id;
  int width;
  int height;
  int fps;
  uint32_t bitrate_bps;
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
inline constexpr uint32_t kAggregateVideoBitrateBps = 60'000'000;

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

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_QUALITY_LADDER_H_
