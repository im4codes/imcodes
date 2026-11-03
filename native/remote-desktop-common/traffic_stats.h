#ifndef IMCODES_REMOTE_DESKTOP_COMMON_TRAFFIC_STATS_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_TRAFFIC_STATS_H_
#include <cstdint>
#include <atomic>
#include <chrono>
#include <string>
#include <vector>
namespace imcodes::rd {
inline constexpr char kTrafficType[] = "remote_desktop.traffic";
// Stable for one native peer, survives its signaling reconnect; a replacement
// peer/process gets a different key even when libwebrtc reuses "T01".
inline std::string NewTrafficPeerId() {
  static std::atomic<std::uint64_t> sequence{0};
  return std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
         "-" + std::to_string(sequence.fetch_add(1));
}
struct TrafficSample {
  std::string transport_id;
  std::uint64_t bytes_sent = 0;
  std::uint64_t bytes_received = 0;
};
}  // namespace imcodes::rd
#endif
