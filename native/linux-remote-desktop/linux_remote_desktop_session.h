#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_REMOTE_DESKTOP_SESSION_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_REMOTE_DESKTOP_SESSION_H_

// Wires common::TransportSessionCore (the SAME state machine macOS and
// Windows use: route authority, ICE queueing, data-channel readiness, quality
// target application, idle/media watchdogs, diagnostics, terminal reasons) to
// a REAL libwebrtc PeerConnection driven by the X11 platform adapters --
// unlike the throwaway loopback qualification, offer/ICE come from an actual
// caller (ApplyOffer/AddRemoteIceCandidate), not an in-process peer.
//
// Also wires common::SessionCore (input-ledger-backed ApplyPointerMove/
// ApplyKey/ApplyButton/ApplyWheel/ApplyText dispatch to the X11 input
// adapter). SessionCore::Start() gates on TWO independent checks, both of
// which used to fail unconditionally on Linux and now honestly pass:
//   - CapabilityReadiness::ViewReady() requires capture/encoder/disclosure/
//     graphical_session all kReady. LinuxNoopEncoderAdapter documents why
//     kReady is correct for this delivery model (see its own comment), the
//     on-screen X11DisclosureAdapter (linux_x11_backend.h) is a real,
//     working consent indicator rather than a stub, and
//     LinuxPlatformAdapters::MeasureReadiness() now actually populates
//     graphical_session (previously left at its kUnknown default, which
//     silently failed ViewReady() forever regardless of the other three).
//   - DesktopTopology::IsValid()/DisplayTopology::IsValid() both require a
//     nonzero `generation`. X11DisplayAdapter::EnumerateTopology() left it
//     at 0 (only `revision` was ever incremented); it now stamps the same
//     WorkerGeneration matching Windows' ToCommonDesktopTopology pattern.
//
// Data-channel dispatch (pointer/keyboard, plus the "hello"/"keepalive"/
// release_all slice of "control"): parsed with data_channel_payload.h, the
// SAME bounded parser Windows and macOS both consume ("a divergence here
// would be a divergence in what each platform accepts as input" -- that
// header's own comment), then routed through this session's own
// SessionCore/InputLedger, exactly as ApplyPointerMove/ApplyKey/etc.'s own
// header comment already promised they would be. NOT YET DONE, scoped as a
// real follow-up: display selection/mode/scale, clipboard, and auto-unlock --
// Linux has one fixed display and does not advertise
// REMOTE_DESKTOP_CLIPBOARD_CAPABILITY or CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY,
// so those "control" kinds have nothing to route to yet and stay silently
// ignored (an unknown-but-well-formed control kind), matching this file's own
// established "never claim readiness this session cannot back" convention.
//
// DELIBERATELY NOT YET DONE, scoped as follow-up: the daemon-side worker
// process/challenge/generation protocol.

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>

#include "api/data_channel_interface.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "rtc_base/thread.h"

#include "../remote-desktop-common/data_channel_payload.h"
#include "../remote-desktop-common/quality_ladder.h"
#include "../remote-desktop-common/signaling_types.h"
#include "../remote-desktop-common/session_core.h"
#include "../remote-desktop-common/transport_session_core.h"
#include "linux_native_video_source.h"
#include "linux_platform_adapters.h"

namespace imcodes::remote_desktop::linux_platform {

using LinuxEmitIceCandidate =
    std::function<void(const std::string& mid, const std::string& sdp)>;

// common::PlatformAdapters (and therefore common::SessionCore, which this
// session uses for the SAME input-ledger-backed dispatch macOS's
// MacosRemoteDesktopSession wraps) requires an EncoderAdapter reference.
// Linux has none: frames leave via NativeCaptureAdapter's pooled
// VideoTrackSource, never through CaptureAdapter/EncoderAdapter's
// push-a-CapturedFrame/emit-an-H264AccessUnit model. SessionCore only ever
// calls Stop() on it (session_core.cc's StopPlatformResources), so a no-op
// is exactly correct, not a stub standing in for missing behavior.
// kReady, not kUnavailable: this is a genuine "not applicable" case, not a
// missing capability standing in as unavailable. CaptureAdapter/EncoderAdapter
// describe ONE of platform_interfaces.h's two documented delivery models
// (push a CapturedFrame, get an H264AccessUnit back) -- macOS's model. This
// session uses the OTHER one (NativeCaptureAdapter's pooled VideoTrackSource
// + libwebrtc's own VideoEncoderFactory), the same one Windows uses, where
// encoding happens inside libwebrtc and is never observable through this
// interface at all. There is no SEPARATE Linux encoder object whose
// readiness this could honestly report as anything else; the real
// admission check for this delivery model is CreatePeerConnectionOrError/
// CreateVideoTrack actually succeeding in StartTransport, which is exactly
// where a real failure already surfaces (independent of SessionCore's
// gate). Reporting kUnavailable here would not describe a missing
// capability -- it would permanently fail CapabilityReadiness::ViewReady()
// for a delivery model that was never going to populate this field.
//
// NOTE ON WHO ACTUALLY GATES ViewReady()'s encoder field: SessionCore never
// calls ProbeReadiness() on this class directly (session_core.cc only ever
// calls Stop() on the encoder adapter, per the comment above). The
// CapabilityReadiness passed into SessionCore::Start() comes from
// LinuxPlatformAdapters::MeasureReadiness() (linux_platform_adapters.cc),
// which mirrors readiness.encoder from readiness.capture rather than
// consulting this method -- "the encoder rides the capture path and can
// never outrank it," in that function's own words. This method's kReady
// return is kept in sync with that conclusion (and stays the honest answer
// for any future caller that does query this class directly), but it is not
// itself the mechanism that satisfies the gate.
class LinuxNoopEncoderAdapter final : public common::EncoderAdapter {
 public:
  common::ReadinessState ProbeReadiness() override {
    return common::ReadinessState::kReady;
  }
  bool Configure(const common::EncoderConfiguration&,
                common::H264AccessUnitSink) override {
    return false;
  }
  bool Encode(common::CapturedFrame, bool) override { return false; }
  void Stop() noexcept override {}
};

// The capture adapter this session's SessionCore sees. SessionCore stops its
// capture adapter whenever the session ends (StopPlatformResources, also run
// by its destructor), but on Linux the real X11 capture is one process-wide
// instance shared by every session through the SharedCaptureMultiplexer in
// linux_native_video_source.cc, which alone may stop it -- once its last
// lease is gone. Handed the shared adapter itself, the first session to end
// stopped capture for all the others while the multiplexer still counted it
// as running: every session started after that connected, opened its data
// channels, and never sent a single video byte (mediaStarted stayed false,
// so the Server killed each attempt at its negotiation deadline) until the
// last older session was gone -- up to the five-minute grace a reloaded
// page's old route is held for. Readiness still comes from the real adapter;
// starting and stopping belong to the leases.
class LinuxSessionCaptureView final : public common::CaptureAdapter {
 public:
  explicit LinuxSessionCaptureView(common::CaptureAdapter& shared) noexcept
      : shared_(shared) {}
  common::ReadinessState ProbeReadiness() override {
    return shared_.ProbeReadiness();
  }
  bool Start(const common::DisplayTopology&, common::CapturedFrameSink) override {
    return false;
  }
  void Stop() noexcept override {}

 private:
  common::CaptureAdapter& shared_;
};

class LinuxRemoteDesktopSession final
    : public webrtc::PeerConnectionObserver,
      private common::TransportSessionAdapter,
      public std::enable_shared_from_this<LinuxRemoteDesktopSession> {
 public:
  static std::shared_ptr<LinuxRemoteDesktopSession> Create(
      webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
      LinuxPlatformAdapters& adapters,
      webrtc::Thread* signaling_thread,
      LinuxEmitIceCandidate emit_ice_candidate);
  ~LinuxRemoteDesktopSession() override;

  // Route authority lifecycle -- see common::TransportSessionCore for the
  // exact contract (deadlines, renewal, mode changes).
  bool Start(const common::RouteAuthority& authority, common::TransportTime now);
  // Called before Start() with PREPARE's ice_servers (STUN/TURN) -- Start()
  // only receives common::RouteAuthority, which (unlike the wire-level
  // imcodes::rd::Authority WorkerSession holds) has no field for them, so
  // this is the only path they can reach StartTransport() through. See
  // StartTransport()'s own comment for why never wiring these in mattered.
  void SetIceServers(std::vector<imcodes::rd::IceServer> ice_servers) {
    ice_servers_ = std::move(ice_servers);
  }
  bool Tick(common::TransportTime now);
  // LEASE: push the renewable deadline forward. Thin pass-through to
  // common::TransportSessionCore::RenewLease, which owns every deadline and
  // identity rule. Without this the session only ever held PREPARE's
  // original lease (authorize + LEASE_DURATION_MS, 60s), and the core's own
  // AuthorityAlive() check ended every session exactly then.
  bool RenewLease(const common::RouteAuthority& renewal,
                  common::TransportTime now);
  // MODE_STATE: a view<->control switch, or a same-mode input-epoch advance
  // (the Server's signaling-resume fence). Applies it to the transport core,
  // then mirrors the resulting mode into SessionCore -- the input gate
  // (EnsureControlAvailable) every Apply* call below goes through -- exactly
  // as macOS's ApplyModeAuthority does.
  bool UpdateMode(const common::RouteAuthority& update,
                  common::TransportTime now);
  // Real outbound video RTP bytes, from the peer connection's OWN stats --
  // not merely "a frame was pushed into the local WebRTC pipeline" (see
  // linux_native_video_source.cc's SharedCaptureMultiplexer/Lease, which
  // proves capture itself works but says nothing about whether a byte ever
  // left this process). Without this, common::TransportDiagnostics::
  // last_outbound_video_bytes stays permanently 0 -- mirrors Windows'
  // PeerSession::CheckMediaProgress/HandleMediaStats and macOS' own
  // RecordMediaProgress plumbing exactly (see their own worker_main tick
  // loops), which this Linux session never had at all until now. Rate-limited
  // internally (a stats round trip is not free); safe to call every
  // PublishStatus tick.
  void CheckMediaProgress();
  // Callback target for LinuxMediaStatsObserver (linux_remote_desktop_session
  // .cc), a free class (not a member/friend) in that file's anonymous
  // namespace -- public for the same reason Windows' own
  // PeerSession::HandleMediaStats() is (peer_session.h): posts back onto the
  // signaling thread itself if libwebrtc ever delivers off it (it does not
  // today, but PeerConnection::GetStats' own contract does not promise
  // otherwise), matching this class's own signaling-thread-confinement rule
  // (see this file's header comment).
  void HandleMediaStats(bool has_outbound_video, std::uint64_t outbound_bytes);
  void Stop() noexcept;

  // Real, externally-driven signaling (not the loopback qualification's
  // in-process peer): a caller passes in whatever offer/ICE actually arrived
  // over the daemon's own signaling channel.
  bool ApplyOffer(const std::string& offer_sdp,
                  std::function<void(bool ok, const std::string& answer_sdp)>
                      on_answer);
  bool AddRemoteIce(const std::string& mid, const std::string& sdp);

  [[nodiscard]] common::TransportDiagnostics diagnostics() const;
  [[nodiscard]] bool closed() const noexcept { return closed_; }
  // Linux has exactly one display in its topology (no selection/mode/scale
  // surface yet -- see this file's header comment), so nothing downstream
  // needs a display_id parameter the way macOS's multi-display session does.
  [[nodiscard]] const common::DesktopTopology* topology() const noexcept {
    return core_.topology();
  }
  // True once the browser has acknowledged actually decoding/presenting a
  // frame for the CURRENT topology revision -- set by HandleDataChannelMessage's
  // "frame_presented" branch, mirroring macOS's own frame_ready computation
  // (macos_remote_desktop_worker_main.mm's EmitStatus: "the four facts the
  // Server requires before it calls the session connected and disarms its
  // negotiation timeout"). Server-side, server/src/ws/remote-desktop-router.ts's
  // connectionReady strictly requires peerConnected && dataChannelsReady &&
  // mediaStarted && firstFramePresented all === true before it clears
  // route.negotiationTimer (REMOTE_DESKTOP_LIMITS.NEGOTIATION_TIMEOUT_MS,
  // 45s) -- omitting this field left it permanently undefined, so every
  // Linux session (however healthy) was killed by the negotiation timeout
  // exactly 45s after PREPARE, then immediately re-prepared by the browser,
  // which looked like a disconnect/reconnect loop but was really a session
  // that could structurally never finish connecting.
  [[nodiscard]] bool FramePresented() const noexcept {
    const common::DesktopTopology* current = topology();
    return current != nullptr && presented_layout_revision_ == current->revision;
  }

  // Real input dispatch through common::SessionCore/InputLedger -- the same
  // ownership/release/epoch-fencing semantics macOS's session wraps, backed
  // here by the already-qualified X11InputAdapter. Called from
  // HandleDataChannelMessage() below, which is what OnDataChannel's own
  // observer feeds.
  common::InputResult ApplyPointerMove(const common::PointerMove& move);
  common::InputResult ApplyKey(const common::KeyTransition& transition);
  common::InputResult ApplyButton(const common::ButtonTransition& transition);
  common::InputResult ClickButton(const common::ButtonTransition& transition);
  common::InputResult ApplyWheel(const common::WheelInput& input);
  common::InputResult ApplyText(const common::TextInput& input);
  void ReleaseController(std::string_view controller_id) noexcept;

  // webrtc::PeerConnectionObserver.
  void OnSignalingChange(
      webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(
      webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) override;
  void OnIceGatheringChange(
      webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override;
  void OnConnectionChange(
      webrtc::PeerConnectionInterface::PeerConnectionState state) override;

 private:
  LinuxRemoteDesktopSession(
      webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
      LinuxPlatformAdapters& adapters,
      webrtc::Thread* signaling_thread,
      LinuxEmitIceCandidate emit_ice_candidate);

  // common::TransportSessionAdapter -- the only methods that touch libwebrtc
  // transport objects; TransportSessionCore owns their state, fencing and
  // cleanup ordering, exactly as it does for macOS/Windows.
  bool StartTransport(const common::RouteAuthority& authority) override;
  bool AddRemoteIceCandidate(const common::IceCandidate& candidate) override;
  bool EmitLocalIceCandidate(const common::IceCandidate& candidate) override;
  bool ApplyQuality(const common::QualitySelection& selection) override;
  void ReleaseControlAuthority(const common::RouteAuthorityIdentity& identity,
                              std::uint64_t input_epoch) noexcept override;
  void CloseDataChannel(common::DataChannelKind channel) noexcept override;
  void CloseTransport() noexcept override;
  void PublishDiagnostics(
      const common::TransportDiagnostics& diagnostics) noexcept override;
  void OnTerminal(common::TransportTerminalReason reason) noexcept override;

  common::TransportCallbackStamp CallbackStamp() const;

  // Invoked from LinuxDataChannelObserver::OnMessage -- itself always on the
  // signaling thread (a webrtc::DataChannelObserver guarantee), which is
  // also where every other caller into this class already runs, so no
  // cross-thread post is needed here (unlike macOS's IPC-process worker,
  // which posts across a socket boundary this process does not have).
  void HandleDataChannelMessage(common::DataChannelKind channel,
                                const std::string& payload);
  // Mirrors macOS's WorkerTransportSink::SendTopology(): the browser's own
  // display list (snapshot.displays) starts empty and is ONLY ever
  // populated by a remote_desktop.data.display_topology message over the
  // control channel -- nothing else on the wire tells it a display exists
  // at all. Never sending this meant snapshot.displays stayed permanently
  // empty for every real Linux session, which made the browser's own
  // statusMatchesConsumedTopology gate (remote-desktop-client.ts) false
  // forever regardless of anything STATUS carries, which in turn meant
  // acknowledgePresentedFrame() never had a pending frame to acknowledge,
  // so FRAME_PRESENTED never got sent either -- input never enabled,
  // client-side, no matter how correct the native dispatch/STATUS fields
  // were. Sent once, right when the control channel opens (same trigger
  // macOS uses).
  bool SendTopology();
  // Mirrors macOS's WorkerTransportSink::SendInputAck / Windows'
  // PeerSession::SendInputAck. The browser arms a 3 s timer on every
  // reliable input transition and fails the session as peer_failed when no
  // ack arrives, so without this every keypress or click on Linux tore the
  // session down three seconds later.
  bool SendInputAck(std::uint64_t acknowledged_sequence);
  // Answer a copy_selection request (macOS's WorkerTransportSink::
  // SendClipboard shape): the remote selection's text, or not available.
  bool SendClipboard(const std::string& request_id,
                     const std::optional<std::string>& text);
  // Called from LinuxDataChannelObserver::OnStateChange() once a channel's
  // own DataChannelInterface::state() actually reaches kOpen.
  void OnChannelReady(common::DataChannelKind kind);
  [[nodiscard]] bool CorrelationMatches(
      const imcodes::rd::DataChannelMessage& message) const;
  [[nodiscard]] common::InputStamp InputStampFor(
      const imcodes::rd::DataChannelMessage& message,
      common::DataChannelKind channel,
      bool position = false) const;

  // Mirrors Windows' PeerDataObserver: a thin webrtc::DataChannelObserver
  // that exists only to hand bytes back to the owning session, which is what
  // actually owns InputLedger/SessionCore state. Holds a weak reference so
  // an observer outliving its session (libwebrtc may deliver a final
  // OnStateChange after Close()) never resurrects a torn-down session.
  class LinuxDataChannelObserver final : public webrtc::DataChannelObserver {
   public:
    LinuxDataChannelObserver(std::weak_ptr<LinuxRemoteDesktopSession> session,
                             common::DataChannelKind channel);
    // OnDataChannel fires when the channel is created/negotiated, NOT when
    // it is actually open -- calling DataChannelInterface::Send() that
    // early returns false every time (confirmed live: topology/authority
    // both present, channel found in channels_, Send() still returned 0).
    // This is the real "did open" signal; SendTopology() belongs here, not
    // in OnDataChannel.
    void OnStateChange() override;
    void OnMessage(const webrtc::DataBuffer& buffer) override;

   private:
    const std::weak_ptr<LinuxRemoteDesktopSession> session_;
    const common::DataChannelKind channel_;
  };

  class LinuxQualityLadder final : public common::QualityLadder {
   public:
    common::QualitySelection Select(
        const common::QualityTarget& target) const noexcept override;
  } quality_ladder_;

  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  LinuxPlatformAdapters& adapters_;
  LinuxNativeCaptureAdapter native_capture_;
  // Kept for the future data-channel dispatch work (posting parsed input back
  // onto this thread the way macOS/Windows do); every current caller already
  // runs on it, so nothing here posts to it yet.
  [[maybe_unused]] webrtc::Thread* const signaling_thread_;
  LinuxEmitIceCandidate emit_ice_candidate_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> peer_;
  std::vector<imcodes::rd::IceServer> ice_servers_;
  std::unique_ptr<common::NativeVideoSourceLease> video_lease_;
  webrtc::scoped_refptr<webrtc::VideoTrackInterface> video_track_;
  std::map<std::string, webrtc::scoped_refptr<webrtc::DataChannelInterface>>
      channels_;
  // Keeps each LinuxDataChannelObserver alive for exactly as long as the
  // DataChannelInterface it is registered on -- libwebrtc does not take
  // ownership of an observer itself, only a raw pointer to it (Windows'
  // channel_observers_ is the same shape for the same reason).
  std::map<std::string, std::unique_ptr<LinuxDataChannelObserver>>
      channel_observers_;
  // Monotonically increasing sequence stamped on every message this session
  // sends out over a data channel (topology today; matches macOS/Windows'
  // own outbound_sequence_ convention).
  std::uint64_t outbound_sequence_ = 0;
  // Topology revision the browser last acknowledged actually presenting a
  // compatible decoded frame for -- see FramePresented() above. Zero (never
  // equal to a real topology's revision, which starts at 1 -- matches
  // macOS's own presented_layout_revision_ default) until the first valid
  // "frame_presented" control message arrives.
  common::TopologyRevision presented_layout_revision_ = 0;
  // Guards CheckMediaProgress()'s GetStats() round trip against overlap --
  // a callback can still be in flight when the next PublishStatus tick asks
  // again; this keeps at most one outstanding per session.
  bool media_stats_in_flight_ = false;
  common::TransportSessionCore transport_core_;
  // Declared after the adapters it wraps (adapters_ is a reference to the
  // caller-owned LinuxPlatformAdapters, which must outlive this session
  // anyway) so SessionCore's own StopPlatformResources() runs before
  // anything it depends on is torn down.
  LinuxNoopEncoderAdapter noop_encoder_;
  LinuxSessionCaptureView capture_view_;
  common::SessionCore core_;
  bool core_started_ = false;
  bool closed_ = false;
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_REMOTE_DESKTOP_SESSION_H_
