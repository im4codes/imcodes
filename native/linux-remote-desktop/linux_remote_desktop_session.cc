#include "linux_remote_desktop_session.h"

#include <cstdio>
#include <utility>

#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"

#include "../remote-desktop-common/quality_ladder.h"

namespace imcodes::remote_desktop::linux_platform {
namespace {

using common::DataChannelKind;
using common::DataChannelState;
using common::IceCandidate;
using common::PeerConnectionState;
using common::QualitySelection;
using common::QualityTarget;
using common::RouteAuthority;
using common::RouteAuthorityIdentity;
using common::TransportCallbackStamp;
using common::TransportDiagnostics;
using common::TransportPath;
using common::TransportTerminalReason;
using common::TransportTime;

DataChannelKind ChannelKindFromLabel(const std::string& label) {
  if (label == "keyboard") return DataChannelKind::kKeyboard;
  if (label == "pointer") return DataChannelKind::kPointer;
  return DataChannelKind::kControl;
}

const char* ChannelLabel(DataChannelKind kind) {
  switch (kind) {
    case DataChannelKind::kControl: return "control";
    case DataChannelKind::kKeyboard: return "keyboard";
    case DataChannelKind::kPointer: return "pointer";
  }
  return "control";
}

class SetLocalObs : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  explicit SetLocalObs(std::function<void()> on_success = {})
      : on_success_(std::move(on_success)) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    if (!error.ok()) {
      std::fprintf(stderr, "linux session: SetLocalDescription failed: %s\n",
                  error.message());
      return;
    }
    if (on_success_) on_success_();
  }

 private:
  std::function<void()> on_success_;
};

class SetRemoteObs : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  explicit SetRemoteObs(std::function<void(bool)> on_done)
      : on_done_(std::move(on_done)) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    on_done_(error.ok());
  }

 private:
  std::function<void(bool)> on_done_;
};

class CreateAnswerObs : public webrtc::CreateSessionDescriptionObserver {
 public:
  explicit CreateAnswerObs(
      std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>)>
          on_success)
      : on_success_(std::move(on_success)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
    on_success_(std::unique_ptr<webrtc::SessionDescriptionInterface>(desc));
  }
  void OnFailure(webrtc::RTCError error) override {
    std::fprintf(stderr, "linux session: CreateAnswer failed: %s\n",
                error.message());
  }

 private:
  std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>)>
      on_success_;
};

}  // namespace

common::QualitySelection
LinuxRemoteDesktopSession::LinuxQualityLadder::Select(
    const common::QualityTarget& target) const noexcept {
  // Reuses the SAME fixed preset ladder macOS/Windows drive their encoder
  // reconfiguration from (imcodes::rd::SelectQuality in quality_ladder.h),
  // not a Linux-specific one -- the ladder itself is already codec-agnostic
  // and shared; only the encoder that ends up applying it differs.
  const imcodes::rd::QualitySelection selection = imcodes::rd::SelectQuality(
      target.bitrate_bps, target.source_pixels.width,
      target.source_pixels.height);
  return common::QualitySelection{
      selection.id,
      common::PixelSize{static_cast<std::uint32_t>(selection.width),
                        static_cast<std::uint32_t>(selection.height)},
      static_cast<std::uint32_t>(selection.fps),
      selection.bitrate_bps,
  };
}

std::shared_ptr<LinuxRemoteDesktopSession> LinuxRemoteDesktopSession::Create(
    webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
    LinuxPlatformAdapters& adapters, webrtc::Thread* signaling_thread,
    LinuxEmitIceCandidate emit_ice_candidate) {
  return std::shared_ptr<LinuxRemoteDesktopSession>(
      new LinuxRemoteDesktopSession(std::move(factory), adapters,
                                    signaling_thread,
                                    std::move(emit_ice_candidate)));
}

LinuxRemoteDesktopSession::LinuxRemoteDesktopSession(
    webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
    LinuxPlatformAdapters& adapters, webrtc::Thread* signaling_thread,
    LinuxEmitIceCandidate emit_ice_candidate)
    : factory_(std::move(factory)),
      adapters_(adapters),
      native_capture_(adapters.capture()),
      signaling_thread_(signaling_thread),
      emit_ice_candidate_(std::move(emit_ice_candidate)),
      transport_core_(*this, quality_ladder_),
      core_(common::PlatformAdapters{
          adapters.capture(), noop_encoder_, adapters.input(),
          adapters.clipboard(), adapters.display(), adapters.disclosure(),
          adapters.session_monitor()}) {}

LinuxRemoteDesktopSession::~LinuxRemoteDesktopSession() { Stop(); }

bool LinuxRemoteDesktopSession::Start(const common::RouteAuthority& authority,
                                      common::TransportTime now) {
  return transport_core_.Start(authority, now);
}

bool LinuxRemoteDesktopSession::Tick(common::TransportTime now) {
  return transport_core_.Tick(now);
}

void LinuxRemoteDesktopSession::Stop() noexcept {
  if (closed_) return;
  transport_core_.Stop();
}

common::TransportDiagnostics LinuxRemoteDesktopSession::diagnostics() const {
  return transport_core_.diagnostics();
}

common::TransportCallbackStamp LinuxRemoteDesktopSession::CallbackStamp()
    const {
  const auto* authority = transport_core_.authority();
  return TransportCallbackStamp{
      authority ? authority->identity.daemon_generation : 0,
      authority ? authority->identity.route_generation : 0,
  };
}

// --- common::TransportSessionAdapter ---------------------------------------

bool LinuxRemoteDesktopSession::StartTransport(
    const common::RouteAuthority&) {
  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;

  webrtc::PeerConnectionDependencies pc_deps(this);
  auto result = factory_->CreatePeerConnectionOrError(config, std::move(pc_deps));
  if (!result.ok()) {
    std::fprintf(stderr, "linux session: CreatePeerConnectionOrError failed\n");
    return false;
  }
  peer_ = result.value();

  auto topology = adapters_.display().EnumerateTopology();
  if (!topology || topology->displays.empty()) {
    std::fprintf(stderr, "linux session: no displays enumerated\n");
    peer_->Close();
    peer_ = nullptr;
    return false;
  }
  video_lease_ = native_capture_.Acquire(topology->displays[0]);
  if (!video_lease_ || !video_lease_->Start()) {
    std::fprintf(stderr, "linux session: capture lease Start() failed\n");
    peer_->Close();
    peer_ = nullptr;
    return false;
  }
  video_track_ = factory_->CreateVideoTrack(
      webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface>(
          video_lease_->source()),
      "linuxdesktop");
  auto add_track_result = peer_->AddTrack(video_track_, {"linuxdesktop-stream"});
  if (!add_track_result.ok()) {
    std::fprintf(stderr, "linux session: AddTrack failed\n");
    peer_->Close();
    peer_ = nullptr;
    return false;
  }

  // SessionCore owns input-ledger dispatch independently of the transport;
  // starting it here (once capture/display are already known good, same as
  // the video track above) is what makes ApplyPointerMove/ApplyKey/etc.
  // below actually reach the X11 input adapter. See this file's top-of-file
  // comment for why both of SessionCore::Start()'s gates (CapabilityReadiness
  // ::ViewReady() and DesktopTopology::IsValid()) are now honestly
  // satisfiable on Linux -- `*topology` here is the same EnumerateTopology()
  // result already used for native_capture_.Acquire() above, so its
  // `generation` field being nonzero (X11DisplayAdapter's own fix) is what
  // makes IsValid() pass here too.
  core_started_ = core_.Start(adapters_.MeasureReadiness(), *topology);
  if (!core_started_) {
    std::fprintf(stderr, "linux session: SessionCore::Start failed\n");
  }
  return true;
}

bool LinuxRemoteDesktopSession::AddRemoteIceCandidate(
    const common::IceCandidate& candidate) {
  if (!peer_) return false;
  auto parsed = webrtc::IceCandidate::Create(candidate.media_id, 0,
                                             candidate.candidate);
  if (!parsed) return false;
  peer_->AddIceCandidate(std::move(parsed), [](webrtc::RTCError error) {
    if (!error.ok()) {
      std::fprintf(stderr, "linux session: AddIceCandidate failed: %s\n",
                  error.message());
    }
  });
  return true;
}

bool LinuxRemoteDesktopSession::EmitLocalIceCandidate(
    const common::IceCandidate& candidate) {
  if (emit_ice_candidate_) emit_ice_candidate_(candidate.media_id, candidate.candidate);
  return true;
}

bool LinuxRemoteDesktopSession::ApplyQuality(
    const common::QualitySelection&) {
  // The video source already adapts to whatever resolution a sink's
  // VideoSinkWants asks for (AdaptedVideoTrackSource); a dedicated
  // resolution/bitrate push analogous to macOS/Windows' encoder
  // Reconfigure() is deferred until Linux has its own bespoke encoder (see
  // libwebrtc-sdk.gni) rather than libwebrtc's builtin one.
  return true;
}

void LinuxRemoteDesktopSession::ReleaseControlAuthority(
    const common::RouteAuthorityIdentity&, std::uint64_t) noexcept {
  adapters_.input().ReleaseAllEmittedState();
}

void LinuxRemoteDesktopSession::CloseDataChannel(
    common::DataChannelKind channel) noexcept {
  const std::string label = ChannelLabel(channel);
  auto it = channels_.find(label);
  if (it == channels_.end()) return;
  it->second->Close();
  channels_.erase(it);
}

void LinuxRemoteDesktopSession::CloseTransport() noexcept {
  if (video_track_) {
    video_track_ = nullptr;
  }
  video_lease_.reset();
  for (auto& [label, channel] : channels_) channel->Close();
  channels_.clear();
  if (peer_) {
    peer_->Close();
    peer_ = nullptr;
  }
  if (core_started_) {
    core_.Stop(common::TerminalError{});
    core_started_ = false;
  }
  closed_ = true;
}

void LinuxRemoteDesktopSession::PublishDiagnostics(
    const common::TransportDiagnostics&) noexcept {
  // Wired to the daemon's own status-reporting path once this session is
  // driven from a real worker process rather than this qualification-level
  // wiring; a no-op here is correct for now.
}

void LinuxRemoteDesktopSession::OnTerminal(
    common::TransportTerminalReason) noexcept {
  CloseTransport();
}

// --- ApplyOffer / AddRemoteIce: the real, externally-driven signaling ------

bool LinuxRemoteDesktopSession::ApplyOffer(
    const std::string& offer_sdp,
    std::function<void(bool, const std::string&)> on_answer) {
  if (!peer_) return false;

  auto remote_offer =
      webrtc::CreateSessionDescription(webrtc::SdpType::kOffer, offer_sdp);
  auto* peer = peer_.get();
  auto self = shared_from_this();
  peer->SetRemoteDescription(
      std::move(remote_offer),
      webrtc::make_ref_counted<SetRemoteObs>([self, peer, on_answer](bool ok) {
        if (!ok) {
          on_answer(false, {});
          return;
        }
        // Any remote ICE candidates AddRemoteIce() already queued (arrived
        // before the offer's SetRemoteDescription completed) are only safe
        // to hand to the PeerConnection now that it has an m-line/mid to
        // resolve them against.
        self->transport_core_.SetRemoteDescriptionReady(self->CallbackStamp());
        auto create_observer = webrtc::make_ref_counted<CreateAnswerObs>(
            [self, peer, on_answer](
                std::unique_ptr<webrtc::SessionDescriptionInterface> answer) {
              std::string answer_sdp;
              answer->ToString(&answer_sdp);
              peer->SetLocalDescription(
                  std::move(answer),
                  webrtc::make_ref_counted<SetLocalObs>([self]() {
                    // Only now does the far end have the answer's SDP to
                    // resolve OUR local candidates against, so only now are
                    // they safe to actually send.
                    self->transport_core_.SetLocalIceEmissionReady(
                        self->CallbackStamp());
                  }));
              on_answer(true, answer_sdp);
            });
        peer->CreateAnswer(create_observer.get(),
                           webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
      }));
  return true;
}

bool LinuxRemoteDesktopSession::AddRemoteIce(const std::string& mid,
                                             const std::string& sdp) {
  const auto* authority = transport_core_.authority();
  if (!authority) return false;
  return transport_core_.AddRemoteIceCandidate(authority->identity,
                                               IceCandidate{mid, sdp});
}

// --- webrtc::PeerConnectionObserver -----------------------------------------

void LinuxRemoteDesktopSession::OnDataChannel(
    webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) {
  const std::string label = channel->label();
  channels_[label] = channel;
  transport_core_.OnDataChannelState(CallbackStamp(), ChannelKindFromLabel(label),
                                     DataChannelState::kOpen);
}

void LinuxRemoteDesktopSession::OnIceCandidate(
    const webrtc::IceCandidate* candidate) {
  transport_core_.OnLocalIceCandidate(
      CallbackStamp(),
      IceCandidate{candidate->sdp_mid(), candidate->ToString()});
}

void LinuxRemoteDesktopSession::OnConnectionChange(
    webrtc::PeerConnectionInterface::PeerConnectionState state) {
  PeerConnectionState mapped = PeerConnectionState::kNew;
  switch (state) {
    case webrtc::PeerConnectionInterface::PeerConnectionState::kNew:
      mapped = PeerConnectionState::kNew;
      break;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kConnecting:
      mapped = PeerConnectionState::kConnecting;
      break;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kConnected:
      mapped = PeerConnectionState::kConnected;
      break;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kDisconnected:
      mapped = PeerConnectionState::kDisconnected;
      break;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kFailed:
      mapped = PeerConnectionState::kFailed;
      break;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kClosed:
      mapped = PeerConnectionState::kClosed;
      break;
  }
  common::TransportTime now{};
  transport_core_.OnPeerConnectionState(CallbackStamp(), mapped, now);
}

// --- real input dispatch through common::SessionCore -----------------------
// Not yet called from anywhere (no data-channel message parsing exists yet
// to call them from -- see this file's header comment), but a real,
// independently exercisable surface backed by the already-qualified
// X11InputAdapter, ready for that wiring.

common::InputResult LinuxRemoteDesktopSession::ApplyPointerMove(
    const common::PointerMove& move) {
  return core_.ApplyPointerMove(move);
}

common::InputResult LinuxRemoteDesktopSession::ApplyKey(
    const common::KeyTransition& transition) {
  return core_.ApplyKey(transition);
}

common::InputResult LinuxRemoteDesktopSession::ApplyButton(
    const common::ButtonTransition& transition) {
  return core_.ApplyButton(transition);
}

common::InputResult LinuxRemoteDesktopSession::ClickButton(
    const common::ButtonTransition& transition) {
  return core_.ClickButton(transition);
}

common::InputResult LinuxRemoteDesktopSession::ApplyWheel(
    const common::WheelInput& input) {
  return core_.ApplyWheel(input);
}

common::InputResult LinuxRemoteDesktopSession::ApplyText(
    const common::TextInput& input) {
  return core_.ApplyText(input);
}

void LinuxRemoteDesktopSession::ReleaseController(
    std::string_view controller_id) noexcept {
  core_.ReleaseController(controller_id);
}

}  // namespace imcodes::remote_desktop::linux_platform
