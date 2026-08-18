#ifndef IMCODES_REMOTE_DESKTOP_JSON_PROTOCOL_H_
#define IMCODES_REMOTE_DESKTOP_JSON_PROTOCOL_H_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "json/value.h"

namespace imcodes::rd {

inline constexpr int kProtocolVersion = 2;
inline constexpr int kIpcVersion = 1;
inline constexpr size_t kMaxIpcLineBytes = 512 * 1024;
inline constexpr size_t kMaxDataMessageBytes = 16 * 1024;
inline constexpr size_t kMaxClipboardTextBytes = 12 * 1024;
inline constexpr int kMaxIceCandidates = 128;
inline constexpr int kMaxDisplays = 16;
inline constexpr int64_t kLeaseMaxFutureMs = 20'000;
inline constexpr int64_t kIdleTimeoutMs = 15 * 60 * 1000;
inline constexpr size_t kMaxSessions = 4;
inline constexpr size_t kMaxCaptureSources = 4;
inline constexpr size_t kMaxGpuCaptureSurfaces = 4;
inline constexpr size_t kMaxEncoderQueueFrames = 3;
inline constexpr size_t kMaxWorkerMemoryBytes = 1024ULL * 1024ULL * 1024ULL;
inline constexpr uint32_t kMaxVideoBitrateBps = 15'000'000;
inline constexpr uint32_t kMaxAggregateVideoBitrateBps = 60'000'000;

inline constexpr char kWorkerHelloType[] = "remote_desktop.worker_hello";
inline constexpr char kWorkerCrashType[] = "remote_desktop.worker_crash";
// Worker → service: the node answered its own sign-in screen with the stored
// secret. Content-free by design; it records that it happened, never what.
inline constexpr char kAutoUnlockAttemptType[] =
    "remote_desktop.auto_unlock_attempt";
inline constexpr char kPrepareType[] = "remote_desktop.prepare";
inline constexpr char kOfferType[] = "remote_desktop.offer";
inline constexpr char kAnswerType[] = "remote_desktop.answer";
inline constexpr char kIceType[] = "remote_desktop.ice";
inline constexpr char kLeaseType[] = "remote_desktop.lease";
inline constexpr char kModeStateType[] = "remote_desktop.mode_state";
inline constexpr char kCancelType[] = "remote_desktop.cancel";
inline constexpr char kStopType[] = "remote_desktop.stop";
inline constexpr char kStatusType[] = "remote_desktop.status";
inline constexpr char kTerminalType[] = "remote_desktop.terminal";
inline constexpr char kHeadlessDisplayReason[] = "headless_display";

inline constexpr char kTopologyType[] = "remote_desktop.data.display_topology";
inline constexpr char kQualityType[] = "remote_desktop.data.quality";
inline constexpr char kClipboardType[] = "remote_desktop.data.clipboard";
inline constexpr char kPointerType[] = "remote_desktop.data.pointer";
inline constexpr char kKeyboardType[] = "remote_desktop.data.keyboard";
inline constexpr char kControlType[] = "remote_desktop.data.control";
inline constexpr char kReleaseAllType[] = "remote_desktop.data.release_all";
// Worker → browser: a control command was understood but refused. Success is
// already visible in the topology and status frames; without this, a refusal is
// indistinguishable from a lost click.
inline constexpr char kControlRejectedType[] =
    "remote_desktop.data.control_rejected";

inline constexpr char kRejectNotPermitted[] = "not_permitted";
inline constexpr char kRejectRateLimited[] = "rate_limited";
inline constexpr char kRejectDisplayUnavailable[] = "display_unavailable";
inline constexpr char kRejectModeUnsupported[] = "mode_unsupported";
inline constexpr char kRejectModeChangeFailed[] = "mode_change_failed";
inline constexpr char kRejectScaleChangeFailed[] = "scale_change_failed";
inline constexpr char kRejectCaptureFailed[] = "capture_failed";

inline constexpr char kControlChannel[] = "imcodes-rd-control";
inline constexpr char kKeyboardChannel[] = "imcodes-rd-keyboard";
inline constexpr char kPointerChannel[] = "imcodes-rd-pointer";

inline constexpr char kViewMode[] = "view";
inline constexpr char kControlMode[] = "control";

struct IceServer {
  std::vector<std::string> urls;
  std::string username;
  std::string credential;
};

struct Authority {
  std::string request_id;
  std::string session_id;
  std::string capability;
  int64_t expires_at_ms = 0;
  int64_t lease_expires_at_ms = 0;
  int daemon_generation = 0;
  std::string mode;
  int input_epoch = 0;
  int reconnect_attempt = 0;
  std::vector<IceServer> ice_servers;
};

struct Signal {
  enum class Kind { kPrepare, kOffer, kIce, kLease, kMode, kStop };
  Kind kind;
  Authority authority;
  std::string sdp;
  std::string candidate;
  std::string mid;
  std::string reason;
};

bool ParseJson(const std::string& text, Json::Value* out);
std::string WriteJson(const Json::Value& value);
std::optional<Signal> ParseServiceSignal(const Json::Value& root,
                                         int64_t now_ms);
bool IsSafeId(const std::string& value);
bool IsSafeCapability(const std::string& value);

Json::Value BaseEnvelope(const char* type, const Authority& authority);
Json::Value TerminalEnvelope(const Authority& authority,
                             const char* reason);

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_JSON_PROTOCOL_H_
