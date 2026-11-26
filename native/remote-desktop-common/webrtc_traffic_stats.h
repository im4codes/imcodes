#ifndef IMCODES_REMOTE_DESKTOP_COMMON_WEBRTC_TRAFFIC_STATS_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_WEBRTC_TRAFFIC_STATS_H_
#include <algorithm>
#include "traffic_stats.h"
#include "api/stats/rtc_stats_report.h"
#include "api/stats/rtcstats_objects.h"
namespace imcodes::rd {
// Only transport counters: adding RTP or candidate-pair counters too would
// count the very same packets twice. No bitrate/time extrapolation.
inline std::vector<TrafficSample> ReadTrafficStats(const webrtc::RTCStatsReport& report) {
  std::vector<TrafficSample> values;
  constexpr std::uint64_t kMaxSafeInteger = 9'007'199'254'740'991ULL;
  for (const auto* stats : report.GetStatsOfType<webrtc::RTCTransportStats>()) {
    if (!stats->bytes_sent || !stats->bytes_received) continue;
    values.push_back({stats->id(), std::min(*stats->bytes_sent, kMaxSafeInteger),
                      std::min(*stats->bytes_received, kMaxSafeInteger)});
  }
  return values;
}
}  // namespace imcodes::rd
#endif
