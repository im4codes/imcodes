#ifndef IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_IPC_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_IPC_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace imcodes::remote_desktop::common {

// Wire constants are authored in shared/aidesk-local-ipc.ts and bound by the
// cross-language contract test. This core deliberately has no FLTK or OS SDK
// dependency; a platform stream adapter supplies bytes.
inline constexpr std::uint32_t kLocalManagementProtocolVersion = 1;
inline constexpr std::size_t kLocalManagementMaximumFrameBytes = 1048576;
inline constexpr char kLocalManagementHelloType[] = "aidesk_local.hello";
inline constexpr char kLocalManagementWelcomeType[] = "aidesk_local.welcome";
inline constexpr char kLocalManagementSnapshotType[] = "aidesk_local.snapshot";
inline constexpr char kLocalManagementActionType[] = "aidesk_local.action";
inline constexpr char kLocalManagementAckType[] = "aidesk_local.ack";
inline constexpr char kLocalManagementRefreshType[] = "aidesk_local.refresh";
inline constexpr char kLocalManagementErrorType[] = "aidesk_local.error";
inline constexpr char kLocalManagementUnauthorizedError[] = "unauthorized";
inline constexpr char kLocalManagementInvalidFrameError[] = "invalid_frame";
inline constexpr char kLocalManagementFrameTooLargeError[] = "frame_too_large";
inline constexpr char kLocalManagementVersionMismatchError[] = "version_mismatch";
inline constexpr char kLocalManagementInvalidCapabilityError[] =
    "invalid_capability";
inline constexpr char kLocalManagementStaleRevisionError[] = "stale_revision";
inline constexpr char kLocalManagementInvalidActionError[] = "invalid_action";
inline constexpr char kLocalManagementNotFoundError[] = "not_found";
inline constexpr char kLocalManagementRequestConflictError[] =
    "request_conflict";
inline constexpr char kLocalManagementActionFailedError[] = "action_failed";

enum class LocalManagementAccessState : std::uint8_t {
  kReady,
  kPaused,
  kStopping,
  kUnavailable,
};

enum class LocalManagementServiceState : std::uint8_t {
  kReady,
  kStarting,
  kStopped,
  kRepairRequired,
  kVersionMismatch,
};

enum class LocalManagementConnectionRole : std::uint8_t {
  kView,
  kControl,
};

enum class LocalManagementAction : std::uint8_t {
  kPause,
  kResume,
  kStopAll,
  kDisconnect,
};

struct LocalManagementConnection {
  std::string id;
  std::string label;
  std::int64_t connected_at_ms = 0;
  std::int64_t duration_ms = 0;
  LocalManagementConnectionRole role = LocalManagementConnectionRole::kView;
};

struct LocalManagementSnapshot {
  std::uint64_t revision = 0;
  std::string public_node_id;
  LocalManagementServiceState service_state =
      LocalManagementServiceState::kStopped;
  LocalManagementAccessState access_state =
      LocalManagementAccessState::kUnavailable;
  bool paused = false;
  std::string management_url;
  std::string share_url;
  std::vector<LocalManagementConnection> connections;
};

struct LocalManagementAck {
  std::string request_id;
  bool ok = false;
  std::uint64_t applied_revision = 0;
  std::string error;
};

struct LocalManagementWelcome {
  std::string runtime_version;
  std::string product_version;
  std::string session_id;
  std::string capability;
  std::int64_t capability_expires_at_ms = 0;
  LocalManagementSnapshot snapshot;
};

struct LocalManagementBootstrap {
  std::string endpoint;
  std::string bootstrap_secret;
  std::string runtime_version;
  std::string product_version;
};

[[nodiscard]] std::optional<LocalManagementBootstrap>
ParseLocalManagementBootstrap(std::string_view json);

struct LocalManagementEvent {
  enum class Kind : std::uint8_t { kWelcome, kSnapshot, kAck, kError };
  Kind kind = Kind::kError;
  std::optional<LocalManagementWelcome> welcome;
  std::optional<LocalManagementSnapshot> snapshot;
  std::optional<LocalManagementAck> ack;
  std::string error;
};

class LocalManagementFrameDecoder final {
 public:
  // Returns false on a zero/oversized/malformed frame and remains failed.
  bool Push(std::string_view bytes, std::vector<std::string>* payloads);
  [[nodiscard]] bool failed() const noexcept { return failed_; }
  void Reset();

 private:
  std::string buffered_;
  bool failed_ = false;
};

[[nodiscard]] std::optional<std::string> EncodeLocalManagementFrame(
    std::string_view json);

class LocalManagementClientCore final {
 public:
  LocalManagementClientCore(std::string bootstrap_secret,
                            std::string ui_version,
                            std::string product_version);

  [[nodiscard]] std::optional<std::string> EncodeHello(
      std::string_view client_nonce) const;
  [[nodiscard]] std::optional<std::string> EncodeRefresh(
      std::string_view request_id) const;
  [[nodiscard]] std::optional<std::string> EncodeAction(
      std::string_view request_id,
      std::uint64_t expected_revision,
      LocalManagementAction action,
      std::string_view connection_id = {}) const;

  // Consumes arbitrary stream chunks. A malformed message fails closed until
  // ResetForReconnect(); transport ownership stays outside this class.
  bool Consume(std::string_view bytes, std::vector<LocalManagementEvent>* events);
  void ResetForReconnect();

  [[nodiscard]] bool authenticated() const noexcept {
    return !capability_.empty();
  }
  [[nodiscard]] const std::string& capability() const noexcept {
    return capability_;
  }
  [[nodiscard]] const std::optional<LocalManagementSnapshot>& snapshot() const
      noexcept {
    return snapshot_;
  }

 private:
  bool ConsumePayload(std::string_view payload,
                      std::vector<LocalManagementEvent>* events);

  std::string bootstrap_secret_;
  std::string ui_version_;
  std::string product_version_;
  std::string capability_;
  std::string session_id_;
  std::optional<LocalManagementSnapshot> snapshot_;
  LocalManagementFrameDecoder decoder_;
  bool failed_ = false;
};

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_IPC_H_
