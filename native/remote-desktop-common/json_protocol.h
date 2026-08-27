#ifndef IMCODES_REMOTE_DESKTOP_COMMON_JSON_PROTOCOL_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_JSON_PROTOCOL_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "json/value.h"
#include "data_channel_constants.h"
#include "signaling_types.h"

namespace imcodes::rd {

inline constexpr int kProtocolVersion = 2;
inline constexpr int kIpcVersion = 1;
inline constexpr size_t kMaxIpcLineBytes = 512 * 1024;
inline constexpr size_t kMaxClipboardTextBytes = 12 * 1024;
inline constexpr int kMaxIceCandidates = 128;
inline constexpr int kMaxDisplays = 16;
// The Server grants a 60 s controller lease and renews it every 15 s.  Accept
// bounded clock/skew and IPC scheduling headroom beyond the normal lease, but
// never let a malformed authority turn into an unbounded worker lifetime.
inline constexpr int64_t kLeaseMaxFutureMs = 75'000;
inline constexpr int64_t kIdleTimeoutMs = 15 * 60 * 1000;
// How long the picture waits for the input channels before going out anyway.
// Their handshake is a handful of small packets, so this is a backstop for a
// viewer that never opens them, not a budget the normal path spends.
inline constexpr int64_t kVideoGateTimeoutMs = 2'000;
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

// The data-message type tokens moved to data_channel_constants.h (already
// included above) so a target that must not link JsonCpp can still name them.

inline constexpr char kRejectNotPermitted[] = "not_permitted";
inline constexpr char kRejectRateLimited[] = "rate_limited";
inline constexpr char kRejectDisplayUnavailable[] = "display_unavailable";
inline constexpr char kRejectModeUnsupported[] = "mode_unsupported";
inline constexpr char kRejectModeChangeFailed[] = "mode_change_failed";
inline constexpr char kRejectScaleChangeFailed[] = "scale_change_failed";
inline constexpr char kRejectCaptureFailed[] = "capture_failed";
inline constexpr char kRejectUnlockUnavailable[] = "unlock_unavailable";

// Why a controlling session still cannot send input. Reported on the status
// frame so a toolbar full of greyed controls can say what it is waiting on.
inline constexpr char kInputBlockedNoControl[] = "no_control";
inline constexpr char kInputBlockedChannels[] = "channels";
inline constexpr char kInputBlockedAwaitingFrame[] = "awaiting_frame";
inline constexpr char kInputBlockedSelectDisplay[] = "select_display";
inline constexpr char kInputBlockedInputUnavailable[] = "input_unavailable";

inline constexpr char kViewMode[] = "view";
inline constexpr char kControlMode[] = "control";
inline constexpr char kModeReasonInitial[] = "initial";
inline constexpr char kModeReasonUserSelected[] = "user_selected";
inline constexpr char kModeReasonAuthorityLost[] = "authority_lost";

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

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_JSON_PROTOCOL_H_
