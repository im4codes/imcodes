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
// adapter) -- but CapabilityReadiness::ViewReady() requires encoder AND
// disclosure readiness, and Linux has neither yet (see
// LinuxNoopEncoderAdapter's own comment, and LinuxDisclosureAdapter),
// so SessionCore::Start() currently fails on every real host. Left failing
// loudly rather than faked; see the comment at its call site in
// StartTransport().
//
// DELIBERATELY NOT YET DONE, scoped as follow-up: the data-channel wire
// protocol (pointer/keyboard/clipboard JSON messages the web/mobile client
// actually sends -- macOS and Windows each parse their own copy of this,
// there is no shared implementation to reuse yet) and the daemon-side worker
// process/challenge/generation protocol. Channels open and are tracked by
// TransportSessionCore for readiness purposes; incoming messages on them are
// not yet parsed or dispatched to the input/clipboard adapters.

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>

#include "api/data_channel_interface.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "rtc_base/thread.h"

#include "../remote-desktop-common/quality_ladder.h"
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
class LinuxNoopEncoderAdapter final : public common::EncoderAdapter {
 public:
  common::ReadinessState ProbeReadiness() override {
    return common::ReadinessState::kUnavailable;
  }
  bool Configure(const common::EncoderConfiguration&,
                common::H264AccessUnitSink) override {
    return false;
  }
  bool Encode(common::CapturedFrame, bool) override { return false; }
  void Stop() noexcept override {}
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
  bool Tick(common::TransportTime now);
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

  // Real input dispatch through common::SessionCore/InputLedger -- the same
  // ownership/release/epoch-fencing semantics macOS's session wraps, backed
  // here by the already-qualified X11InputAdapter. NOT YET called from
  // anywhere: wiring these to the data-channel wire protocol (parsing the
  // pointer/keyboard JSON messages the web/mobile client actually sends) is
  // the next piece, deliberately not done in this pass -- see this file's
  // header comment.
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
  std::unique_ptr<common::NativeVideoSourceLease> video_lease_;
  webrtc::scoped_refptr<webrtc::VideoTrackInterface> video_track_;
  std::map<std::string, webrtc::scoped_refptr<webrtc::DataChannelInterface>>
      channels_;
  common::TransportSessionCore transport_core_;
  // Declared after the adapters it wraps (adapters_ is a reference to the
  // caller-owned LinuxPlatformAdapters, which must outlive this session
  // anyway) so SessionCore's own StopPlatformResources() runs before
  // anything it depends on is torn down.
  LinuxNoopEncoderAdapter noop_encoder_;
  common::SessionCore core_;
  bool core_started_ = false;
  bool closed_ = false;
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_REMOTE_DESKTOP_SESSION_H_
