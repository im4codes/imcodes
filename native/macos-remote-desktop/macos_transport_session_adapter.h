#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_TRANSPORT_SESSION_ADAPTER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_TRANSPORT_SESSION_ADAPTER_H_

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "../remote-desktop-common/transport_session_core.h"

namespace imcodes::remote_desktop::macos {

// The three channels TransportSessionCore treats as required. Declared here as
// an ordered array so the adapter, the backend and the tests cannot disagree
// about which channels must exist before control authority is granted.
inline constexpr common::DataChannelKind kRequiredDataChannels[] = {
    common::DataChannelKind::kControl,
    common::DataChannelKind::kKeyboard,
    common::DataChannelKind::kPointer,
};

[[nodiscard]] const char* DataChannelLabel(
    common::DataChannelKind channel) noexcept;

struct MacosTransportIceServer {
  std::string uri;
  std::string username;
  std::string credential;
};

struct MacosTransportBackendConfiguration {
  std::vector<MacosTransportIceServer> ice_servers;
  // Route identity is carried through so the backend can stamp every async
  // libwebrtc callback. The backend must never reinterpret it.
  common::RouteAuthorityIdentity identity;
  std::uint32_t start_bitrate_bps = 0;
  std::uint32_t min_bitrate_bps = 0;
  std::uint32_t max_bitrate_bps = 0;
};

// Narrow seam over the repository-pinned upstream libwebrtc PeerConnection.
// Everything below this interface is upstream WebRTC: ICE, DTLS-SRTP, SCTP,
// RTP/RTCP, pacing and congestion control. This project implements none of
// them and must never grow a second media stack behind this seam.
class MacosTransportSessionAdapter;
class MacosMediaSenderBinder;

// Upper bound on one SDP body. Pinned by the cross-layer token test to
// `REMOTE_DESKTOP_LIMITS.SDP_BYTES` in shared/remote-desktop.ts: a native bound
// larger than the host's would let the worker accept an offer the daemon has
// already refused, and a smaller one would reject a legitimate answer.
inline constexpr std::size_t kMacosTransportMaximumSdpBytes = 256 * 1024;

class MacosPeerConnectionBackend {
 public:
  virtual ~MacosPeerConnectionBackend() = default;

  // Binds the session's media sender so the backend can hand it the encoded-
  // image callback upstream produces in VideoEncoder::InitEncode. Borrowed;
  // the session owns the binder and outlives the backend.
  virtual void BindMediaSender(MacosMediaSenderBinder* binder) noexcept = 0;

  // The adapter owns the backend, while the backend must stamp callbacks with
  // the adapter's route. Binding after construction breaks that cycle without
  // handing the backend an ownership reference it could outlive.
  virtual void BindAdapter(MacosTransportSessionAdapter* adapter) noexcept = 0;

  // Creates the PeerConnection and media track. The browser is the offerer and
  // creates all required DataChannels; the backend accepts and validates them
  // through PeerConnectionObserver::OnDataChannel. Returning false must leave
  // nothing running: a partially constructed peer is a failure, not a
  // degraded success.
  virtual bool Open(
      const MacosTransportBackendConfiguration& configuration) = 0;
  // Runs one complete negotiation and returns only after
  // SetRemoteDescription -> CreateAnswer -> SetLocalDescription have all
  // succeeded, writing the local answer into `answer_sdp`.
  //
  // Synchronous on purpose. The caller is the single-threaded worker dispatch,
  // whose per-call sink cannot outlive the call, so an asynchronous completion
  // would have to retain a pointer that may already be dead. Upstream still
  // executes the chain on its own signaling thread; the wait is bounded and is
  // released by Close(), so a peer that never answers cannot wedge dispatch.
  //
  // Returns false on any failure, timeout or cancellation, leaving
  // `answer_sdp` untouched. There is no partial success.
  [[nodiscard]] virtual bool NegotiateOffer(std::string_view offer_sdp,
                                            std::string* answer_sdp) = 0;
  virtual bool AddRemoteIceCandidate(const common::IceCandidate& candidate) = 0;
  virtual bool EmitLocalIceCandidate(const common::IceCandidate& candidate) = 0;
  virtual bool SendDataChannel(common::DataChannelKind channel,
                               std::string_view payload) = 0;
  virtual bool ApplyBitrate(std::uint32_t min_bps,
                            std::uint32_t start_bps,
                            std::uint32_t max_bps) = 0;
  virtual void CloseDataChannel(common::DataChannelKind channel) noexcept = 0;
  virtual void Close() noexcept = 0;
};

// Session-facing callback sink. The concrete implementation forwards into
// MacosRemoteDesktopSession, which owns the TransportSessionCore state
// machine. Splitting it out keeps this adapter testable without a session.
class MacosTransportCallbackSink {
 public:
  virtual ~MacosTransportCallbackSink() = default;
  virtual void OnPeerConnectionState(
      const common::TransportCallbackStamp& stamp,
      common::PeerConnectionState state) = 0;
  virtual void OnDataChannelState(const common::TransportCallbackStamp& stamp,
                                  common::DataChannelKind channel,
                                  common::DataChannelState state) = 0;
  virtual void OnDataChannelMessage(const common::TransportCallbackStamp& stamp,
                                    common::DataChannelKind channel,
                                    std::string payload) = 0;
  virtual void OnLocalIceCandidate(const common::TransportCallbackStamp& stamp,
                                   common::IceCandidate candidate) = 0;
  virtual void OnTransportPath(const common::TransportCallbackStamp& stamp,
                               common::TransportPath path) = 0;
  virtual void OnQualityTarget(const common::TransportCallbackStamp& stamp,
                               common::QualityTarget target) = 0;
  virtual void OnTerminal(common::TransportTerminalReason reason) = 0;
};

// Real signaling transport for MacosRemoteDesktopSession.
//
// Ownership: the adapter owns the backend and therefore the PeerConnection.
// The sink is borrowed and must outlive the adapter.
//
// Fail-closed rules enforced here rather than in the backend, so a backend
// that is merely permissive cannot widen authority:
//   * StartTransport rejects an invalid or already-started route outright.
//   * Every operation after CloseTransport is rejected; the adapter is
//     single-shot and cannot be restarted under a replaced route.
//   * Candidate and quality operations are rejected before the peer is open.
class MacosTransportSessionAdapter final
    : public common::TransportSessionAdapter {
 public:
  using LocalIceEmitter =
      std::function<bool(const common::IceCandidate& candidate)>;

  MacosTransportSessionAdapter(
      std::unique_ptr<MacosPeerConnectionBackend> backend,
      MacosTransportCallbackSink& sink,
      std::vector<MacosTransportIceServer> ice_servers = {},
      LocalIceEmitter local_ice_emitter = {});
  ~MacosTransportSessionAdapter() override;

  MacosTransportSessionAdapter(const MacosTransportSessionAdapter&) = delete;
  MacosTransportSessionAdapter& operator=(const MacosTransportSessionAdapter&) =
      delete;

  bool StartTransport(const common::RouteAuthority& authority) override;
  // PREPARE supplies route-scoped ICE credentials after this adapter is
  // constructed but before StartTransport. Reconfiguration after start is
  // forbidden so one route cannot replace another route's relay authority.
  bool ConfigureIceServers(std::vector<MacosTransportIceServer> ice_servers);
  // Single in-flight by construction: a second offer while one negotiation is
  // outstanding is refused rather than queued, because two overlapping
  // SetLocalDescription chains would race to install different answers for the
  // same route. Re-entrancy is refused for the same reason.
  [[nodiscard]] bool NegotiateOffer(std::string_view offer_sdp,
                                    std::string* answer_sdp);
  bool AddRemoteIceCandidate(const common::IceCandidate& candidate) override;
  bool EmitLocalIceCandidate(const common::IceCandidate& candidate) override;
  bool SendDataChannel(common::DataChannelKind channel,
                       std::string_view payload);
  bool ApplyQuality(const common::QualitySelection& selection) override;

  void ReleaseControlAuthority(const common::RouteAuthorityIdentity& identity,
                               std::uint64_t input_epoch) noexcept override;
  void CloseDataChannel(common::DataChannelKind channel) noexcept override;
  void CloseTransport() noexcept override;
  void PublishDiagnostics(
      const common::TransportDiagnostics& diagnostics) noexcept override;
  void OnTerminal(common::TransportTerminalReason reason) noexcept override;

  // Backend-facing entry points. Each one is stamp-checked against the route
  // that started this adapter before it reaches the sink, so a callback that
  // outlived its route cannot mutate a successor.
  void ReportPeerConnectionState(const common::TransportCallbackStamp& stamp,
                                 common::PeerConnectionState state);
  void ReportDataChannelState(const common::TransportCallbackStamp& stamp,
                              common::DataChannelKind channel,
                              common::DataChannelState state);
  void ReportDataChannelMessage(const common::TransportCallbackStamp& stamp,
                                common::DataChannelKind channel,
                                std::string payload);
  void ReportLocalIceCandidate(const common::TransportCallbackStamp& stamp,
                               common::IceCandidate candidate);
  void ReportTransportPath(const common::TransportCallbackStamp& stamp,
                           common::TransportPath path);
  void ReportQualityTarget(const common::TransportCallbackStamp& stamp,
                           common::QualityTarget target);

  [[nodiscard]] bool negotiation_in_flight() const noexcept {
    return negotiation_in_flight_;
  }
  [[nodiscard]] bool started() const noexcept { return started_; }
  [[nodiscard]] bool closed() const noexcept { return closed_; }
  [[nodiscard]] common::TransportCallbackStamp stamp() const noexcept {
    return stamp_;
  }
  [[nodiscard]] std::uint64_t released_input_epoch() const noexcept {
    return released_input_epoch_;
  }
  [[nodiscard]] std::uint64_t last_diagnostics_sequence() const noexcept {
    return last_diagnostics_sequence_;
  }

 private:
  [[nodiscard]] bool StampMatches(
      const common::TransportCallbackStamp& stamp) const noexcept;

  std::unique_ptr<MacosPeerConnectionBackend> backend_;
  MacosTransportCallbackSink& sink_;
  std::vector<MacosTransportIceServer> ice_servers_;
  LocalIceEmitter local_ice_emitter_;
  common::RouteAuthorityIdentity identity_;
  common::TransportCallbackStamp stamp_{};
  bool started_ = false;
  bool closed_ = false;
  bool terminal_notified_ = false;
  bool negotiation_in_flight_ = false;
  std::uint64_t released_input_epoch_ = 0;
  std::uint64_t last_diagnostics_sequence_ = 0;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_TRANSPORT_SESSION_ADAPTER_H_
