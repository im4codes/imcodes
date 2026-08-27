#include "macos_transport_session_adapter.h"

#include <utility>

#include "../remote-desktop-common/data_channel_constants.h"

namespace imcodes::remote_desktop::macos {

const char* DataChannelLabel(common::DataChannelKind channel) noexcept {
  switch (channel) {
    case common::DataChannelKind::kControl:
      return imcodes::rd::kControlChannel;
    case common::DataChannelKind::kKeyboard:
      return imcodes::rd::kKeyboardChannel;
    case common::DataChannelKind::kPointer:
      return imcodes::rd::kPointerChannel;
  }
  return "";
}

MacosTransportSessionAdapter::MacosTransportSessionAdapter(
    std::unique_ptr<MacosPeerConnectionBackend> backend,
    MacosTransportCallbackSink& sink,
    std::vector<MacosTransportIceServer> ice_servers,
    LocalIceEmitter local_ice_emitter)
    : backend_(std::move(backend)),
      sink_(sink),
      ice_servers_(std::move(ice_servers)),
      local_ice_emitter_(std::move(local_ice_emitter)) {}

MacosTransportSessionAdapter::~MacosTransportSessionAdapter() {
  CloseTransport();
}

bool MacosTransportSessionAdapter::ConfigureIceServers(
    std::vector<MacosTransportIceServer> ice_servers) {
  if (started_ || closed_ || ice_servers.empty() || ice_servers.size() > 64) {
    return false;
  }
  for (const auto& server : ice_servers) {
    if (server.uri.empty() || server.uri.size() > 2048 ||
        server.username.size() > 1024 || server.credential.size() > 1024) {
      return false;
    }
  }
  ice_servers_ = std::move(ice_servers);
  return true;
}

bool MacosTransportSessionAdapter::StampMatches(
    const common::TransportCallbackStamp& stamp) const noexcept {
  return started_ && !closed_ &&
         stamp.daemon_generation == stamp_.daemon_generation &&
         stamp.route_generation == stamp_.route_generation;
}

bool MacosTransportSessionAdapter::StartTransport(
    const common::RouteAuthority& authority) {
  // Single-shot by construction. A replaced route must build a new adapter so
  // a stale libwebrtc callback can never be re-admitted under a new identity.
  if (started_ || closed_ || backend_ == nullptr)
    return false;
  if (!authority.identity.IsValid())
    return false;

  MacosTransportBackendConfiguration configuration;
  configuration.ice_servers = ice_servers_;
  configuration.identity = authority.identity;
  if (!backend_->Open(configuration)) {
    // Open must be all-or-nothing; do not latch started_ on a partial peer.
    return false;
  }

  identity_ = authority.identity;
  stamp_.daemon_generation = authority.identity.daemon_generation;
  stamp_.route_generation = authority.identity.route_generation;
  started_ = true;
  return true;
}

bool MacosTransportSessionAdapter::NegotiateOffer(std::string_view offer_sdp,
                                                  std::string* answer_sdp) {
  // Every rejection below is enforced here rather than in the backend: a
  // backend that is merely permissive must not be able to widen authority.
  if (answer_sdp == nullptr)
    return false;
  if (!started_ || closed_)
    return false;
  if (offer_sdp.empty())
    return false;
  if (offer_sdp.size() > kMacosTransportMaximumSdpBytes)
    return false;
  // Refuse rather than queue. Two overlapping chains would both reach
  // SetLocalDescription and the later answer would silently win, which is
  // indistinguishable from the peer having answered the earlier offer. This
  // also refuses re-entry from inside the wait.
  if (negotiation_in_flight_)
    return false;

  negotiation_in_flight_ = true;
  std::string produced;
  const bool ok = backend_->NegotiateOffer(offer_sdp, &produced);
  negotiation_in_flight_ = false;

  // The route may have been closed while upstream was negotiating. Publishing
  // an answer for a route that no longer exists would install a peer the
  // session has already torn down.
  if (!ok || closed_)
    return false;
  if (produced.empty() || produced.size() > kMacosTransportMaximumSdpBytes) {
    return false;
  }
  *answer_sdp = std::move(produced);
  return true;
}

bool MacosTransportSessionAdapter::AddRemoteIceCandidate(
    const common::IceCandidate& candidate) {
  if (!started_ || closed_)
    return false;
  if (candidate.candidate.empty())
    return false;
  if (candidate.media_id.size() > common::kTransportMaximumIceMediaIdBytes ||
      candidate.candidate.size() > common::kTransportMaximumIceCandidateBytes) {
    return false;
  }
  return backend_->AddRemoteIceCandidate(candidate);
}

bool MacosTransportSessionAdapter::EmitLocalIceCandidate(
    const common::IceCandidate& candidate) {
  if (!started_ || closed_)
    return false;
  if (candidate.candidate.empty())
    return false;
  if (candidate.media_id.size() > common::kTransportMaximumIceMediaIdBytes ||
      candidate.candidate.size() > common::kTransportMaximumIceCandidateBytes) {
    return false;
  }
  // Local ICE is an outbound signaling message. It must go to the daemon,
  // never back down into the PeerConnection that produced it. The backend
  // fallback exists only for checkout-independent adapter fakes; production
  // construction always injects the socket-bound emitter.
  return local_ice_emitter_ ? local_ice_emitter_(candidate)
                            : backend_->EmitLocalIceCandidate(candidate);
}

bool MacosTransportSessionAdapter::SendDataChannel(
    common::DataChannelKind channel,
    std::string_view payload) {
  return started_ && !closed_ && !payload.empty() &&
         payload.size() <= imcodes::rd::kMaxDataMessageBytes &&
         backend_->SendDataChannel(channel, payload);
}

bool MacosTransportSessionAdapter::ApplyQuality(
    const common::QualitySelection& selection) {
  if (!started_ || closed_)
    return false;
  if (selection.bitrate_bps == 0 ||
      selection.bitrate_bps > common::kTransportMaximumQualityTargetBps) {
    return false;
  }
  // Upstream congestion control owns the actual send rate. This only moves the
  // bounds it is allowed to operate between.
  const std::uint32_t maximum = selection.bitrate_bps;
  const std::uint32_t start = maximum;
  const std::uint32_t minimum = maximum / 8 == 0 ? 1 : maximum / 8;
  return backend_->ApplyBitrate(minimum, start, maximum);
}

void MacosTransportSessionAdapter::ReleaseControlAuthority(
    const common::RouteAuthorityIdentity& identity,
    std::uint64_t input_epoch) noexcept {
  if (!started_ || closed_)
    return;
  // Byte-exact identity comparison: releasing control for a different route
  // would silently strip authority from the wrong session.
  if (identity.request_id != identity_.request_id ||
      identity.session_id != identity_.session_id ||
      identity.negotiated_capability_binding !=
          identity_.negotiated_capability_binding ||
      identity.daemon_generation != identity_.daemon_generation ||
      identity.route_generation != identity_.route_generation) {
    return;
  }
  released_input_epoch_ = input_epoch;
  // Control-bearing channels close; the view channel stays so the viewer can
  // keep observing after control is revoked.
  backend_->CloseDataChannel(common::DataChannelKind::kKeyboard);
  backend_->CloseDataChannel(common::DataChannelKind::kPointer);
}

void MacosTransportSessionAdapter::CloseDataChannel(
    common::DataChannelKind channel) noexcept {
  if (!started_ || closed_)
    return;
  backend_->CloseDataChannel(channel);
}

void MacosTransportSessionAdapter::CloseTransport() noexcept {
  if (closed_)
    return;
  closed_ = true;
  // Drop the in-flight marker before tearing the backend down. A completion
  // that arrives after Close must not be reported as this route's answer.
  negotiation_in_flight_ = false;
  if (backend_ != nullptr)
    backend_->Close();
}

void MacosTransportSessionAdapter::PublishDiagnostics(
    const common::TransportDiagnostics& diagnostics) noexcept {
  last_diagnostics_sequence_ = diagnostics.sequence;
}

void MacosTransportSessionAdapter::OnTerminal(
    common::TransportTerminalReason reason) noexcept {
  // Session terminal cleanup re-enters this adapter through the common core.
  // Notify the sink only on the originating edge; otherwise the worker sink
  // calls back into the already locked session and deadlocks.
  if (terminal_notified_)
    return;
  terminal_notified_ = true;
  // Terminal is a one-way door: tear the peer down before telling anyone, so
  // no further callback can be delivered after the terminal notification.
  CloseTransport();
  sink_.OnTerminal(reason);
}

void MacosTransportSessionAdapter::ReportPeerConnectionState(
    const common::TransportCallbackStamp& stamp,
    common::PeerConnectionState state) {
  if (!StampMatches(stamp))
    return;
  sink_.OnPeerConnectionState(stamp, state);
}

void MacosTransportSessionAdapter::ReportDataChannelState(
    const common::TransportCallbackStamp& stamp,
    common::DataChannelKind channel,
    common::DataChannelState state) {
  if (!StampMatches(stamp))
    return;
  sink_.OnDataChannelState(stamp, channel, state);
}

void MacosTransportSessionAdapter::ReportDataChannelMessage(
    const common::TransportCallbackStamp& stamp,
    common::DataChannelKind channel,
    std::string payload) {
  if (!StampMatches(stamp) || payload.empty() ||
      payload.size() > imcodes::rd::kMaxDataMessageBytes) {
    return;
  }
  sink_.OnDataChannelMessage(stamp, channel, std::move(payload));
}

void MacosTransportSessionAdapter::ReportLocalIceCandidate(
    const common::TransportCallbackStamp& stamp,
    common::IceCandidate candidate) {
  if (!StampMatches(stamp))
    return;
  if (candidate.candidate.empty())
    return;
  if (candidate.media_id.size() > common::kTransportMaximumIceMediaIdBytes ||
      candidate.candidate.size() > common::kTransportMaximumIceCandidateBytes) {
    return;
  }
  sink_.OnLocalIceCandidate(stamp, std::move(candidate));
}

void MacosTransportSessionAdapter::ReportTransportPath(
    const common::TransportCallbackStamp& stamp,
    common::TransportPath path) {
  if (!StampMatches(stamp))
    return;
  sink_.OnTransportPath(stamp, path);
}

void MacosTransportSessionAdapter::ReportQualityTarget(
    const common::TransportCallbackStamp& stamp,
    common::QualityTarget target) {
  if (!StampMatches(stamp))
    return;
  sink_.OnQualityTarget(stamp, target);
}

}  // namespace imcodes::remote_desktop::macos
