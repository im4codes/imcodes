#ifndef IMCODES_REMOTE_DESKTOP_COMMON_SIGNALING_TYPES_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_SIGNALING_TYPES_H_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace imcodes::rd {

// Platform-neutral service signaling values. JSON parsing lives in
// json_protocol, while native platform command dispatch consumes these values
// without depending on JsonCpp or an operating-system framework.
struct IceServer {
  std::vector<std::string> urls;
  std::string username;
  std::string credential;
};

struct Authority {
  std::string request_id;
  std::string session_id;
  std::string capability;
  std::int64_t expires_at_ms = 0;
  std::int64_t lease_expires_at_ms = 0;
  int daemon_generation = 0;
  // Independent Server route epoch. Missing remains parseable for legacy v2
  // authenticated access, but is never eligible for management-privacy ACK.
  std::optional<std::int64_t> route_generation;
  std::string mode;
  int input_epoch = 0;
  int reconnect_attempt = 0;
  std::vector<IceServer> ice_servers;
};

struct Signal {
  enum class Kind { kPrepare, kOffer, kIce, kLease, kMode, kStop };
  Kind kind = Kind::kStop;
  Authority authority;
  std::string sdp;
  std::string candidate;
  std::string mid;
  std::string reason;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_SIGNALING_TYPES_H_
