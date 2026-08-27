#include "transport_session_core.h"

#include <algorithm>
#include <limits>
#include <utility>

namespace imcodes::remote_desktop::common {
namespace {

bool IsBoundedIdentityPart(std::string_view value,
                           std::size_t maximum_bytes) noexcept {
  if (value.empty() || value.size() > maximum_bytes) return false;
  return std::none_of(value.begin(), value.end(), [](unsigned char byte) {
    return byte == 0 || byte < 0x20 || byte == 0x7f;
  });
}

void ClearString(std::string* value) noexcept {
  std::fill(value->begin(), value->end(), '\0');
  value->clear();
}

void ClearCandidate(IceCandidate* candidate) noexcept {
  ClearString(&candidate->media_id);
  ClearString(&candidate->candidate);
}

bool SameIdentity(const RouteAuthorityIdentity& left,
                  const RouteAuthorityIdentity& right) noexcept {
  return left.request_id == right.request_id &&
         left.session_id == right.session_id &&
         left.negotiated_capability_binding ==
             right.negotiated_capability_binding &&
         left.daemon_generation == right.daemon_generation &&
         left.route_generation == right.route_generation;
}

bool PeerTransitionAllowed(PeerConnectionState previous,
                           PeerConnectionState next) noexcept {
  if (previous == next) return true;
  switch (previous) {
    case PeerConnectionState::kNew:
      return next == PeerConnectionState::kConnecting ||
             next == PeerConnectionState::kConnected ||
             next == PeerConnectionState::kFailed ||
             next == PeerConnectionState::kClosed;
    case PeerConnectionState::kConnecting:
      return next == PeerConnectionState::kConnected ||
             next == PeerConnectionState::kDisconnected ||
             next == PeerConnectionState::kFailed ||
             next == PeerConnectionState::kClosed;
    case PeerConnectionState::kConnected:
      return next == PeerConnectionState::kConnecting ||
             next == PeerConnectionState::kDisconnected ||
             next == PeerConnectionState::kFailed ||
             next == PeerConnectionState::kClosed;
    case PeerConnectionState::kDisconnected:
      return next == PeerConnectionState::kConnecting ||
             next == PeerConnectionState::kConnected ||
             next == PeerConnectionState::kFailed ||
             next == PeerConnectionState::kClosed;
    case PeerConnectionState::kFailed:
    case PeerConnectionState::kClosed:
      return false;
  }
  return false;
}

bool DataChannelTransitionAllowed(DataChannelState previous,
                                  DataChannelState next) noexcept {
  if (previous == next) return true;
  switch (previous) {
    case DataChannelState::kMissing:
      return next == DataChannelState::kConnecting ||
             next == DataChannelState::kOpen ||
             next == DataChannelState::kClosed ||
             next == DataChannelState::kFailed;
    case DataChannelState::kConnecting:
      return next == DataChannelState::kOpen ||
             next == DataChannelState::kClosed ||
             next == DataChannelState::kFailed;
    case DataChannelState::kOpen:
      return next == DataChannelState::kClosed ||
             next == DataChannelState::kFailed;
    case DataChannelState::kClosed:
    case DataChannelState::kFailed:
      return false;
  }
  return false;
}

}  // namespace

bool RouteAuthorityIdentity::IsValid() const noexcept {
  return IsBoundedIdentityPart(request_id, 128) &&
         IsBoundedIdentityPart(session_id, 128) &&
         IsBoundedIdentityPart(negotiated_capability_binding, 128) &&
         daemon_generation != 0 && route_generation != 0;
}

bool RouteAuthority::IsValid(const TransportTime& now,
                             std::int64_t maximum_future_ms) const noexcept {
  if (!identity.IsValid() || !now.IsValid() || maximum_future_ms <= 0 ||
      expires_at_unix_ms <= now.unix_ms ||
      lease_expires_at_unix_ms <= now.unix_ms ||
      lease_expires_at_unix_ms > expires_at_unix_ms ||
      lease_expires_at_unix_ms - now.unix_ms > maximum_future_ms) {
    return false;
  }
  return mode != TransportSessionMode::kControl || input_epoch != 0;
}

bool TransportSessionLimits::IsValid() const noexcept {
  return maximum_remote_ice_candidates != 0 &&
         maximum_remote_ice_candidates <= kTransportMaximumIceCandidates &&
         maximum_local_ice_candidates != 0 &&
         maximum_local_ice_candidates <= kTransportMaximumIceCandidates &&
         maximum_ice_media_id_bytes != 0 &&
         maximum_ice_media_id_bytes <= kTransportMaximumIceMediaIdBytes &&
         maximum_ice_candidate_bytes != 0 &&
         maximum_ice_candidate_bytes <= kTransportMaximumIceCandidateBytes &&
         maximum_lease_future_ms > 0 &&
         maximum_lease_future_ms <= kTransportMaximumLeaseFutureMs &&
         idle_timeout_ms > 0 &&
         idle_timeout_ms <= kTransportMaximumIdleTimeoutMs &&
         media_stall_timeout_ms > 0 &&
         media_stall_timeout_ms <= kTransportMaximumMediaStallTimeoutMs &&
         maximum_quality_target_bps != 0 &&
         maximum_quality_target_bps <= kTransportMaximumQualityTargetBps;
}

TransportSessionCore::TransportSessionCore(TransportSessionAdapter& adapter,
                                           const QualityLadder& quality_ladder,
                                           TransportSessionLimits limits)
    : adapter_(adapter), quality_ladder_(quality_ladder), limits_(limits) {}

TransportSessionCore::~TransportSessionCore() {
  if (started_ && !terminal_) Stop();
}

bool TransportSessionCore::Start(RouteAuthority authority, TransportTime now) {
  if (started_ || terminal_ || !limits_.IsValid() ||
      !authority.IsValid(now, limits_.maximum_lease_future_ms)) {
    return false;
  }

  authority_ = std::move(authority);
  started_ = true;
  last_observed_monotonic_ms_ = now.monotonic_ms;
  last_activity_monotonic_ms_ = now.monotonic_ms;
  ResetMediaProgressState(now.monotonic_ms);
  control_authority_released_ =
      authority_.mode != TransportSessionMode::kControl;
  peer_state_ = PeerConnectionState::kNew;
  if (!adapter_.StartTransport(authority_)) {
    Terminate(TransportTerminalReason::kAdapterFailure);
    return false;
  }
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::RenewLease(const RouteAuthority& renewal,
                                      TransportTime now) {
  if (!started_ || terminal_ || !ObserveTime(now) || !AuthorityAlive(now) ||
      !renewal.IsValid(now, limits_.maximum_lease_future_ms) ||
      !SameIdentity(authority_.identity, renewal.identity) ||
      renewal.expires_at_unix_ms != authority_.expires_at_unix_ms ||
      renewal.mode != authority_.mode ||
      renewal.input_epoch != authority_.input_epoch ||
      renewal.lease_expires_at_unix_ms <= authority_.lease_expires_at_unix_ms) {
    return false;
  }
  authority_.lease_expires_at_unix_ms = renewal.lease_expires_at_unix_ms;
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::UpdateMode(const RouteAuthority& update,
                                      TransportTime now) {
  if (!started_ || terminal_ || !ObserveTime(now) || !AuthorityAlive(now) ||
      !update.IsValid(now, limits_.maximum_lease_future_ms) ||
      !SameIdentity(authority_.identity, update.identity) ||
      update.expires_at_unix_ms != authority_.expires_at_unix_ms ||
      update.lease_expires_at_unix_ms < authority_.lease_expires_at_unix_ms) {
    return false;
  }

  const bool changed = update.mode != authority_.mode;
  if ((!changed && update.input_epoch != authority_.input_epoch) ||
      (changed &&
       (authority_.input_epoch == std::numeric_limits<std::uint64_t>::max() ||
        update.input_epoch != authority_.input_epoch + 1))) {
    return false;
  }

  if (authority_.mode == TransportSessionMode::kControl &&
      update.mode == TransportSessionMode::kView) {
    ReleaseControlAuthority();
  }
  authority_ = update;
  if (authority_.mode == TransportSessionMode::kControl) {
    control_authority_released_ = false;
  }
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::IdentityMatches(
    const RouteAuthorityIdentity& identity) const noexcept {
  return started_ && !terminal_ && SameIdentity(authority_.identity, identity);
}

bool TransportSessionCore::CallbackMatches(
    const TransportCallbackStamp& stamp) const noexcept {
  return started_ && !terminal_ &&
         stamp.daemon_generation == authority_.identity.daemon_generation &&
         stamp.route_generation == authority_.identity.route_generation;
}

bool TransportSessionCore::CandidateIsValid(
    const IceCandidate& candidate) const noexcept {
  return !candidate.media_id.empty() &&
         candidate.media_id.size() <= limits_.maximum_ice_media_id_bytes &&
         !candidate.candidate.empty() &&
         candidate.candidate.size() <= limits_.maximum_ice_candidate_bytes &&
         candidate.media_id.find('\0') == std::string::npos &&
         candidate.candidate.find('\0') == std::string::npos;
}

bool TransportSessionCore::AddRemoteIceCandidate(
    const RouteAuthorityIdentity& identity, IceCandidate candidate) {
  if (!IdentityMatches(identity)) return false;
  if (!CandidateIsValid(candidate)) {
    ClearCandidate(&candidate);
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }
  if (accepted_remote_ice_ >= limits_.maximum_remote_ice_candidates) {
    ClearCandidate(&candidate);
    Terminate(TransportTerminalReason::kCandidateOverflow);
    return false;
  }
  ++accepted_remote_ice_;
  if (remote_description_ready_) {
    const bool applied = adapter_.AddRemoteIceCandidate(candidate);
    ClearCandidate(&candidate);
    if (!applied) Terminate(TransportTerminalReason::kAdapterFailure);
    return applied;
  }
  pending_remote_ice_.push_back(std::move(candidate));
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::SetRemoteDescriptionReady(
    const TransportCallbackStamp& callback_stamp) {
  if (!CallbackMatches(callback_stamp)) return false;
  remote_description_ready_ = true;
  return FlushRemoteIce();
}

bool TransportSessionCore::OnLocalIceCandidate(
    const TransportCallbackStamp& callback_stamp, IceCandidate candidate) {
  if (!CallbackMatches(callback_stamp)) return false;
  if (!CandidateIsValid(candidate)) {
    ClearCandidate(&candidate);
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }
  if (accepted_local_ice_ >= limits_.maximum_local_ice_candidates) {
    ClearCandidate(&candidate);
    Terminate(TransportTerminalReason::kCandidateOverflow);
    return false;
  }
  ++accepted_local_ice_;
  if (local_ice_emission_ready_) {
    const bool emitted = adapter_.EmitLocalIceCandidate(candidate);
    ClearCandidate(&candidate);
    if (!emitted) Terminate(TransportTerminalReason::kAdapterFailure);
    return emitted;
  }
  pending_local_ice_.push_back(std::move(candidate));
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::SetLocalIceEmissionReady(
    const TransportCallbackStamp& callback_stamp) {
  if (!CallbackMatches(callback_stamp)) return false;
  local_ice_emission_ready_ = true;
  return FlushLocalIce();
}

bool TransportSessionCore::FlushRemoteIce() {
  while (!pending_remote_ice_.empty()) {
    IceCandidate candidate = std::move(pending_remote_ice_.front());
    pending_remote_ice_.pop_front();
    const bool applied = adapter_.AddRemoteIceCandidate(candidate);
    ClearCandidate(&candidate);
    if (!applied) {
      Terminate(TransportTerminalReason::kAdapterFailure);
      return false;
    }
  }
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::FlushLocalIce() {
  while (!pending_local_ice_.empty()) {
    IceCandidate candidate = std::move(pending_local_ice_.front());
    pending_local_ice_.pop_front();
    const bool emitted = adapter_.EmitLocalIceCandidate(candidate);
    ClearCandidate(&candidate);
    if (!emitted) {
      Terminate(TransportTerminalReason::kAdapterFailure);
      return false;
    }
  }
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::OnPeerConnectionState(
    const TransportCallbackStamp& callback_stamp, PeerConnectionState state,
    TransportTime now) {
  if (!CallbackMatches(callback_stamp) || !ObserveTime(now) ||
      !AuthorityAlive(now)) {
    return false;
  }
  const PeerConnectionState previous = peer_state_;
  if (!PeerTransitionAllowed(previous, state)) {
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }
  peer_state_ = state;
  if (state == PeerConnectionState::kFailed ||
      state == PeerConnectionState::kClosed) {
    Terminate(TransportTerminalReason::kPeerFailed);
    return false;
  }
  if (state == PeerConnectionState::kConnected &&
      previous != PeerConnectionState::kConnected) {
    media_watchdog_armed_ = true;
    ResetMediaProgressState(now.monotonic_ms);
  } else if (state != PeerConnectionState::kConnected) {
    media_watchdog_armed_ = false;
  }
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::OnDataChannelState(
    const TransportCallbackStamp& callback_stamp, DataChannelKind channel,
    DataChannelState state) {
  if (!CallbackMatches(callback_stamp)) return false;
  const std::size_t index = ChannelIndex(channel);
  if (index >= channels_.size()) {
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }
  const DataChannelState previous = channels_[index];
  if (!DataChannelTransitionAllowed(previous, state)) {
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }
  channels_[index] = state;
  if (state == DataChannelState::kClosed ||
      state == DataChannelState::kFailed) {
    Terminate(TransportTerminalReason::kChannelFailed);
    return false;
  }
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::OnTransportPath(
    const TransportCallbackStamp& callback_stamp, TransportPath path) {
  if (!CallbackMatches(callback_stamp)) return false;
  if (path == TransportPath::kUnknown) {
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }
  path_ = path;
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::QualitySelectionIsValid(
    const QualitySelection& selection) const noexcept {
  return !selection.preset_id.empty() && selection.preset_id.size() <= 64 &&
         selection.encoded_pixels.IsValid() && selection.frame_rate > 0 &&
         selection.frame_rate <= 240 && selection.bitrate_bps > 0 &&
         selection.bitrate_bps <= limits_.maximum_quality_target_bps;
}

bool TransportSessionCore::UpdateQualityTarget(
    const TransportCallbackStamp& callback_stamp, const QualityTarget& target) {
  if (!CallbackMatches(callback_stamp) || !target.source_pixels.IsValid() ||
      target.bitrate_bps == 0 ||
      target.bitrate_bps > limits_.maximum_quality_target_bps) {
    return false;
  }
  QualitySelection selection = quality_ladder_.Select(target);
  if (!QualitySelectionIsValid(selection)) {
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }
  if (!adapter_.ApplyQuality(selection)) {
    Terminate(TransportTerminalReason::kAdapterFailure);
    return false;
  }
  quality_ = std::move(selection);
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::RecordActivity(
    const RouteAuthorityIdentity& identity, TransportTime now) {
  if (!IdentityMatches(identity) || !ObserveTime(now) || !AuthorityAlive(now)) {
    return false;
  }
  last_activity_monotonic_ms_ = now.monotonic_ms;
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::RecordMediaProgress(
    const TransportCallbackStamp& callback_stamp, std::uint64_t source_frames,
    std::uint64_t outbound_video_bytes, TransportTime now) {
  if (!CallbackMatches(callback_stamp) ||
      peer_state_ != PeerConnectionState::kConnected || !ObserveTime(now) ||
      !AuthorityAlive(now)) {
    return false;
  }
  if (media_progress_initialized_ &&
      (outbound_video_bytes < last_outbound_video_bytes_ ||
       source_frames < last_observed_source_frames_)) {
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }

  last_observed_source_frames_ = source_frames;
  if (!media_progress_initialized_ ||
      outbound_video_bytes > last_outbound_video_bytes_) {
    media_progress_initialized_ = true;
    last_outbound_video_bytes_ = outbound_video_bytes;
    source_frames_at_media_progress_ = source_frames;
    last_media_progress_monotonic_ms_ = now.monotonic_ms;
  } else if (source_frames > source_frames_at_media_progress_ &&
             now.monotonic_ms - last_media_progress_monotonic_ms_ >=
                 limits_.media_stall_timeout_ms) {
    Terminate(TransportTerminalReason::kMediaStalled);
    return false;
  }
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::ResetMediaProgress(
    const TransportCallbackStamp& callback_stamp, TransportTime now) {
  if (!CallbackMatches(callback_stamp) || !ObserveTime(now) ||
      !AuthorityAlive(now)) {
    return false;
  }
  ResetMediaProgressState(now.monotonic_ms);
  PublishDiagnostics();
  return true;
}

bool TransportSessionCore::Tick(TransportTime now) {
  if (!started_ || terminal_ || !ObserveTime(now)) return false;
  if (now.monotonic_ms - last_activity_monotonic_ms_ >=
      limits_.idle_timeout_ms) {
    Terminate(TransportTerminalReason::kIdleTimeout);
    return false;
  }
  if (!AuthorityAlive(now)) return false;
  if (media_watchdog_armed_ && media_progress_initialized_ &&
      peer_state_ == PeerConnectionState::kConnected &&
      last_observed_source_frames_ > source_frames_at_media_progress_ &&
      now.monotonic_ms - last_media_progress_monotonic_ms_ >=
          limits_.media_stall_timeout_ms) {
    Terminate(TransportTerminalReason::kMediaStalled);
    return false;
  }
  return true;
}

bool TransportSessionCore::required_channels_ready() const noexcept {
  return std::all_of(
      channels_.begin(), channels_.end(),
      [](DataChannelState state) { return state == DataChannelState::kOpen; });
}

bool TransportSessionCore::control_ready() const noexcept {
  return started_ && !terminal_ &&
         authority_.mode == TransportSessionMode::kControl &&
         peer_state_ == PeerConnectionState::kConnected &&
         required_channels_ready();
}

TransportDiagnostics TransportSessionCore::diagnostics() const {
  return TransportDiagnostics{
      diagnostics_sequence_,
      peer_state_,
      path_,
      authority_.mode,
      required_channels_ready(),
      pending_remote_ice_.size(),
      pending_local_ice_.size(),
      accepted_remote_ice_,
      accepted_local_ice_,
      authority_.expires_at_unix_ms,
      authority_.lease_expires_at_unix_ms,
      last_activity_monotonic_ms_,
      last_media_progress_monotonic_ms_,
      source_frames_at_media_progress_,
      last_observed_source_frames_,
      last_outbound_video_bytes_,
      quality_,
      terminal_reason_,
  };
}

bool TransportSessionCore::ObserveTime(TransportTime now) noexcept {
  if (!now.IsValid() || now.monotonic_ms < last_observed_monotonic_ms_) {
    Terminate(TransportTerminalReason::kProtocolViolation);
    return false;
  }
  last_observed_monotonic_ms_ = now.monotonic_ms;
  return true;
}

bool TransportSessionCore::AuthorityAlive(TransportTime now) noexcept {
  if (now.unix_ms >= authority_.expires_at_unix_ms) {
    Terminate(TransportTerminalReason::kRouteExpired);
    return false;
  }
  if (now.unix_ms >= authority_.lease_expires_at_unix_ms) {
    Terminate(TransportTerminalReason::kLeaseExpired);
    return false;
  }
  return true;
}

void TransportSessionCore::ResetMediaProgressState(
    std::int64_t monotonic_ms) noexcept {
  media_progress_initialized_ = false;
  last_media_progress_monotonic_ms_ = monotonic_ms;
  last_outbound_video_bytes_ = 0;
  source_frames_at_media_progress_ = 0;
  last_observed_source_frames_ = 0;
}

void TransportSessionCore::ReleaseControlAuthority() noexcept {
  if (control_authority_released_ || !started_) return;
  control_authority_released_ = true;
  adapter_.ReleaseControlAuthority(authority_.identity, authority_.input_epoch);
}

void TransportSessionCore::PublishDiagnostics() noexcept {
  ++diagnostics_sequence_;
  adapter_.PublishDiagnostics(diagnostics());
}

void TransportSessionCore::ClearCandidates() noexcept {
  for (IceCandidate& candidate : pending_remote_ice_) {
    ClearCandidate(&candidate);
  }
  pending_remote_ice_.clear();
  for (IceCandidate& candidate : pending_local_ice_) {
    ClearCandidate(&candidate);
  }
  pending_local_ice_.clear();
}

void TransportSessionCore::Terminate(TransportTerminalReason reason) noexcept {
  if (terminal_ || cleanup_complete_) return;
  terminal_ = true;
  terminal_reason_ = reason == TransportTerminalReason::kNone
                         ? TransportTerminalReason::kProtocolViolation
                         : reason;

  // Safety ordering is deliberate and shared by both platforms: revoke input
  // authority first, close every required SCTP surface, erase queued network
  // material, close the PeerConnection once, then publish the terminal fact.
  ReleaseControlAuthority();
  for (DataChannelKind channel :
       {DataChannelKind::kControl, DataChannelKind::kKeyboard,
        DataChannelKind::kPointer}) {
    adapter_.CloseDataChannel(channel);
  }
  ClearCandidates();
  adapter_.CloseTransport();
  cleanup_complete_ = true;
  peer_state_ = PeerConnectionState::kClosed;
  PublishDiagnostics();
  adapter_.OnTerminal(terminal_reason_);
}

void TransportSessionCore::Stop(TransportTerminalReason reason) noexcept {
  if (!started_ || terminal_) return;
  Terminate(reason);
}

}  // namespace imcodes::remote_desktop::common
