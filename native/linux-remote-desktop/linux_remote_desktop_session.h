#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_REMOTE_DESKTOP_SESSION_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_REMOTE_DESKTOP_SESSION_H_

// Wires common::TransportSessionCore (the SAME state machine macOS and
// Windows use: route authority, ICE queueing, data-channel readiness, quality
// target application, idle/media watchdogs, diagnostics, terminal reasons) to
// a REAL libwebrtc PeerConnection driven by the X11 platform adapters --
// unlike the throwaway loopback qualification, offer/ICE come from an actual
// caller (ApplyOffer/AddRemoteIceCandidate), not an in-process peer.
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
#include "../remote-desktop-common/transport_session_core.h"
#include "linux_native_video_source.h"
#include "linux_platform_adapters.h"

namespace imcodes::remote_desktop::linux_platform {

using LinuxEmitIceCandidate =
    std::function<void(const std::string& mid, const std::string& sdp)>;

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
  bool closed_ = false;
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_REMOTE_DESKTOP_SESSION_H_
