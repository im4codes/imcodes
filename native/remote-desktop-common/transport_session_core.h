#ifndef IMCODES_REMOTE_DESKTOP_COMMON_TRANSPORT_SESSION_CORE_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_TRANSPORT_SESSION_CORE_H_

#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <string_view>

#include "protocol_contracts.h"

namespace imcodes::remote_desktop::common {

// TransportSessionCore is signaling-sequence confined. Platform consumers
// marshal libwebrtc callbacks onto their owning sequence before entering it;
// the common target intentionally owns no thread or OS event-loop primitive.

enum class TransportSessionMode : std::uint8_t {
  kView,
  kControl,
};

enum class PeerConnectionState : std::uint8_t {
  kNew,
  kConnecting,
  kConnected,
  kDisconnected,
  kFailed,
  kClosed,
};

enum class DataChannelKind : std::uint8_t {
  kControl,
  kKeyboard,
  kPointer,
};

enum class DataChannelState : std::uint8_t {
  kMissing,
  kConnecting,
  kOpen,
  kClosed,
  kFailed,
};

enum class TransportPath : std::uint8_t {
  kUnknown,
  kDirect,
  kRelay,
};

enum class TransportTerminalReason : std::uint8_t {
  kNone,
  kStopped,
  kRouteExpired,
  kLeaseExpired,
  kIdleTimeout,
  kMediaStalled,
  kPeerFailed,
  kChannelFailed,
  kCandidateOverflow,
  kAdapterFailure,
  kProtocolViolation,
};

struct RouteAuthorityIdentity {
  std::string request_id;
  std::string session_id;
  // Opaque binding chosen by the signaling authority. It may be a negotiated
  // profile hash, a legacy capability token, or another exact route binding;
  // the common core compares it byte-for-byte and never interprets it.
  std::string negotiated_capability_binding;
  WorkerGeneration daemon_generation = 0;
  std::uint64_t route_generation = 0;

  [[nodiscard]] bool IsValid() const noexcept;
};

// Authority deadlines are Unix epoch times, while watchdogs use a monotonic
// clock. Callers must sample both at the same admission/event boundary. Wall
// clock adjustments therefore affect absolute authority but never idle/media
// elapsed time.
struct TransportTime {
  std::int64_t unix_ms = 0;
  std::int64_t monotonic_ms = 0;

  [[nodiscard]] bool IsValid() const noexcept {
    return unix_ms >= 0 && monotonic_ms >= 0;
  }
};

struct RouteAuthority {
  RouteAuthorityIdentity identity;
  std::int64_t expires_at_unix_ms = 0;
  std::int64_t lease_expires_at_unix_ms = 0;
  TransportSessionMode mode = TransportSessionMode::kView;
  std::uint64_t input_epoch = 0;

  [[nodiscard]] bool IsValid(const TransportTime& now,
                             std::int64_t maximum_future_ms) const noexcept;
};

// Generation-only callback stamp. A transport adapter receives the full route
// identity at StartTransport, then attaches this non-secret stamp to async
// libwebrtc callbacks so a replaced route cannot mutate its successor.
struct TransportCallbackStamp {
  WorkerGeneration daemon_generation = 0;
  std::uint64_t route_generation = 0;
};

inline constexpr std::size_t kTransportMaximumIceCandidates = 128;
inline constexpr std::size_t kTransportMaximumIceMediaIdBytes = 256;
inline constexpr std::size_t kTransportMaximumIceCandidateBytes = 16 * 1024;
inline constexpr std::int64_t kTransportMaximumLeaseFutureMs = 75'000;
inline constexpr std::int64_t kTransportMaximumIdleTimeoutMs = 15 * 60 * 1000;
inline constexpr std::int64_t kTransportMaximumMediaStallTimeoutMs = 60'000;
inline constexpr std::uint32_t kTransportMaximumQualityTargetBps = 15'000'000;

struct TransportSessionLimits {
  std::size_t maximum_remote_ice_candidates = kTransportMaximumIceCandidates;
  std::size_t maximum_local_ice_candidates = kTransportMaximumIceCandidates;
  std::size_t maximum_ice_media_id_bytes = kTransportMaximumIceMediaIdBytes;
  std::size_t maximum_ice_candidate_bytes = kTransportMaximumIceCandidateBytes;
  std::int64_t maximum_lease_future_ms = kTransportMaximumLeaseFutureMs;
  std::int64_t idle_timeout_ms = kTransportMaximumIdleTimeoutMs;
  std::int64_t media_stall_timeout_ms = 10'000;
  std::uint32_t maximum_quality_target_bps = kTransportMaximumQualityTargetBps;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct TransportDiagnostics {
  std::uint64_t sequence = 0;
  PeerConnectionState peer_state = PeerConnectionState::kNew;
  TransportPath path = TransportPath::kUnknown;
  TransportSessionMode mode = TransportSessionMode::kView;
  bool required_channels_ready = false;
  std::size_t pending_remote_ice = 0;
  std::size_t pending_local_ice = 0;
  std::size_t accepted_remote_ice = 0;
  std::size_t accepted_local_ice = 0;
  std::int64_t authority_expires_at_unix_ms = 0;
  std::int64_t lease_expires_at_unix_ms = 0;
  std::int64_t last_activity_monotonic_ms = 0;
  std::int64_t last_media_progress_monotonic_ms = 0;
  std::uint64_t source_frames_at_media_progress = 0;
  std::uint64_t last_observed_source_frames = 0;
  std::uint64_t last_outbound_video_bytes = 0;
  std::optional<QualitySelection> quality;
  TransportTerminalReason terminal_reason = TransportTerminalReason::kNone;
};

// The only transport-owned platform seam. Implementations wrap the pinned
// libwebrtc PeerConnection/DataChannel objects but expose no libwebrtc or OS
// types to the common target. Every callback is synchronous on the owning
// signaling sequence and must not re-enter TransportSessionCore.
class TransportSessionAdapter {
 public:
  virtual ~TransportSessionAdapter() = default;

  virtual bool StartTransport(const RouteAuthority& authority) = 0;
  virtual bool AddRemoteIceCandidate(const IceCandidate& candidate) = 0;
  virtual bool EmitLocalIceCandidate(const IceCandidate& candidate) = 0;
  virtual bool ApplyQuality(const QualitySelection& selection) = 0;

  virtual void ReleaseControlAuthority(const RouteAuthorityIdentity& identity,
                                       std::uint64_t input_epoch) noexcept = 0;
  virtual void CloseDataChannel(DataChannelKind channel) noexcept = 0;
  virtual void CloseTransport() noexcept = 0;
  virtual void PublishDiagnostics(
      const TransportDiagnostics& diagnostics) noexcept = 0;
  virtual void OnTerminal(TransportTerminalReason reason) noexcept = 0;
};

class TransportSessionCore final {
 public:
  TransportSessionCore(TransportSessionAdapter& adapter,
                       const QualityLadder& quality_ladder,
                       TransportSessionLimits limits = {});
  ~TransportSessionCore();

  TransportSessionCore(const TransportSessionCore&) = delete;
  TransportSessionCore& operator=(const TransportSessionCore&) = delete;

  bool Start(RouteAuthority authority, TransportTime now);
  bool RenewLease(const RouteAuthority& renewal, TransportTime now);
  bool UpdateMode(const RouteAuthority& update, TransportTime now);

  bool AddRemoteIceCandidate(const RouteAuthorityIdentity& identity,
                             IceCandidate candidate);
  bool SetRemoteDescriptionReady(const TransportCallbackStamp& callback_stamp);
  bool OnLocalIceCandidate(const TransportCallbackStamp& callback_stamp,
                           IceCandidate candidate);
  bool SetLocalIceEmissionReady(const TransportCallbackStamp& callback_stamp);

  bool OnPeerConnectionState(const TransportCallbackStamp& callback_stamp,
                             PeerConnectionState state, TransportTime now);
  bool OnDataChannelState(const TransportCallbackStamp& callback_stamp,
                          DataChannelKind channel, DataChannelState state);
  bool OnTransportPath(const TransportCallbackStamp& callback_stamp,
                       TransportPath path);
  bool UpdateQualityTarget(const TransportCallbackStamp& callback_stamp,
                           const QualityTarget& target);
  bool RecordActivity(const RouteAuthorityIdentity& identity,
                      TransportTime now);
  bool RecordMediaProgress(const TransportCallbackStamp& callback_stamp,
                           std::uint64_t source_frames,
                           std::uint64_t outbound_video_bytes,
                           TransportTime now);
  bool ResetMediaProgress(const TransportCallbackStamp& callback_stamp,
                          TransportTime now);

  // Returns false after a terminal deadline fired. Time is supplied by the
  // consumer so tests and both platform event loops share identical behavior.
  bool Tick(TransportTime now);
  void Stop(TransportTerminalReason reason =
                TransportTerminalReason::kStopped) noexcept;

  [[nodiscard]] bool started() const noexcept { return started_; }
  [[nodiscard]] bool terminal() const noexcept { return terminal_; }
  [[nodiscard]] bool required_channels_ready() const noexcept;
  [[nodiscard]] bool control_ready() const noexcept;
  [[nodiscard]] PeerConnectionState peer_state() const noexcept {
    return peer_state_;
  }
  [[nodiscard]] TransportPath path() const noexcept { return path_; }
  [[nodiscard]] TransportTerminalReason terminal_reason() const noexcept {
    return terminal_reason_;
  }
  [[nodiscard]] const RouteAuthority* authority() const noexcept {
    return started_ ? &authority_ : nullptr;
  }
  [[nodiscard]] std::size_t pending_remote_ice() const noexcept {
    return pending_remote_ice_.size();
  }
  [[nodiscard]] std::size_t pending_local_ice() const noexcept {
    return pending_local_ice_.size();
  }
  [[nodiscard]] TransportDiagnostics diagnostics() const;

 private:
  static constexpr std::size_t ChannelIndex(DataChannelKind channel) noexcept {
    return static_cast<std::size_t>(channel);
  }

  bool IdentityMatches(const RouteAuthorityIdentity& identity) const noexcept;
  bool CallbackMatches(const TransportCallbackStamp& stamp) const noexcept;
  bool CandidateIsValid(const IceCandidate& candidate) const noexcept;
  bool FlushRemoteIce();
  bool FlushLocalIce();
  bool QualitySelectionIsValid(
      const QualitySelection& selection) const noexcept;
  bool ObserveTime(TransportTime now) noexcept;
  bool AuthorityAlive(TransportTime now) noexcept;
  void ResetMediaProgressState(std::int64_t monotonic_ms) noexcept;
  void ReleaseControlAuthority() noexcept;
  void PublishDiagnostics() noexcept;
  void ClearCandidates() noexcept;
  void Terminate(TransportTerminalReason reason) noexcept;

  TransportSessionAdapter& adapter_;
  const QualityLadder& quality_ladder_;
  const TransportSessionLimits limits_;
  RouteAuthority authority_;
  std::array<DataChannelState, 3> channels_ = {
      DataChannelState::kMissing,
      DataChannelState::kMissing,
      DataChannelState::kMissing,
  };
  std::deque<IceCandidate> pending_remote_ice_;
  std::deque<IceCandidate> pending_local_ice_;
  std::optional<QualitySelection> quality_;
  PeerConnectionState peer_state_ = PeerConnectionState::kNew;
  TransportPath path_ = TransportPath::kUnknown;
  std::int64_t last_observed_monotonic_ms_ = 0;
  std::int64_t last_activity_monotonic_ms_ = 0;
  std::int64_t last_media_progress_monotonic_ms_ = 0;
  std::uint64_t last_outbound_video_bytes_ = 0;
  std::uint64_t source_frames_at_media_progress_ = 0;
  std::uint64_t last_observed_source_frames_ = 0;
  std::size_t accepted_remote_ice_ = 0;
  std::size_t accepted_local_ice_ = 0;
  std::uint64_t diagnostics_sequence_ = 0;
  TransportTerminalReason terminal_reason_ = TransportTerminalReason::kNone;
  bool started_ = false;
  bool terminal_ = false;
  bool remote_description_ready_ = false;
  bool local_ice_emission_ready_ = false;
  bool media_watchdog_armed_ = false;
  bool media_progress_initialized_ = false;
  bool control_authority_released_ = true;
  bool cleanup_complete_ = false;
};

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_TRANSPORT_SESSION_CORE_H_
