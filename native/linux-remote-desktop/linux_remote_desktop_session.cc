#include "linux_remote_desktop_session.h"

#include <chrono>
#include <cstddef>
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

#include "../remote-desktop-common/data_channel_constants.h"
#include "../remote-desktop-common/data_channel_payload.h"
#include "../remote-desktop-common/quality_ladder.h"

namespace imcodes::remote_desktop::linux_platform {
namespace {

using common::DataChannelKind;
using common::DataChannelState;
using common::IceCandidate;
using common::InputResult;
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

// Real wire labels (shared/remote-desktop.ts's REMOTE_DESKTOP_CHANNEL,
// data_channel_constants.h's own kControlChannel/kKeyboardChannel/
// kPointerChannel) -- NOT the bare "keyboard"/"pointer" this pair used to
// compare against, which meant every channel the browser actually creates
// ("imcodes-rd-keyboard", not "keyboard") fell through to kControl here.
// Readiness/state tracking is not sensitive to that misclassification --
// TransportSessionCore only counts "is a channel with this kind open," not
// which kind it thinks it is when there is only ever one of each -- but
// dispatch below (kind-gated pointer/keyboard routing) is, so this had to
// be fixed together with adding that dispatch, not before it mattered.
DataChannelKind ChannelKindFromLabel(const std::string& label) {
  if (label == imcodes::rd::kKeyboardChannel) return DataChannelKind::kKeyboard;
  if (label == imcodes::rd::kPointerChannel) return DataChannelKind::kPointer;
  return DataChannelKind::kControl;
}

const char* ChannelLabel(DataChannelKind kind) {
  switch (kind) {
    case DataChannelKind::kControl: return imcodes::rd::kControlChannel;
    case DataChannelKind::kKeyboard: return imcodes::rd::kKeyboardChannel;
    case DataChannelKind::kPointer: return imcodes::rd::kPointerChannel;
  }
  return imcodes::rd::kControlChannel;
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

/**
 * A real, freshly-sampled TransportTime -- unix_ms from the wall clock,
 * monotonic_ms from a genuine monotonic clock (never the same source as
 * unix_ms, even though both happen to be "milliseconds since some epoch"):
 * TransportSessionCore::ObserveTime() rejects any call whose monotonic_ms
 * goes backward relative to the last one it saw, which callers such as
 * Start() already satisfy correctly by construction, but
 * webrtc::PeerConnectionObserver callbacks like OnConnectionChange take no
 * "now" parameter from outside (unlike, e.g., macOS's
 * MacosRemoteDesktopSession, whose OnPeerConnectionState() is fed a real
 * SampleNow() from its own worker main file) -- this session has to
 * synthesize one internally. A previous version of OnConnectionChange
 * passed TransportTime{} (zero-initialized), which reads as valid on its
 * own (TransportTime::IsValid() only requires non-negative fields) but is
 * always less than whatever real monotonic value an earlier Start() call
 * already recorded, immediately failing that regression check and
 * terminating the transport the instant OnConnectionChange ever fired again
 * -- silently, since ObserveTime's own failure path reports
 * kProtocolViolation, not anything that named the real cause.
 */
common::TransportTime SampleNow() noexcept {
  const auto unix_now = std::chrono::system_clock::now().time_since_epoch();
  const auto steady_now = std::chrono::steady_clock::now().time_since_epoch();
  return common::TransportTime{
      std::chrono::duration_cast<std::chrono::milliseconds>(unix_now).count(),
      std::chrono::duration_cast<std::chrono::milliseconds>(steady_now).count(),
  };
}

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
    const common::RouteAuthority& authority) {
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
  // SessionCore::Start() always lands in kViewing, never kControlling on its
  // own (see its own header/source: only an explicit SetControlActive(true)
  // moves it there) -- exactly mirroring macOS's MacosRemoteDesktopSession,
  // which calls this same seam right after its own core_.Start() succeeds,
  // gated on the requested mode. Without this, EnsureControlAvailable()
  // (session_core.cc: requires state() == kControlling) silently refuses
  // every ApplyPointerMove/ApplyKey/ApplyButton/ApplyWheel/ApplyText call
  // forever, for every session, regardless of anything the data-channel
  // dispatch above gets right -- confirmed live via gdb: a real, correctly
  // correlated pointer move reached this class's own ApplyPointerMove with
  // the right display_id and normalized coordinates, and the X11 cursor
  // still never moved, because the ledger itself was refusing control it
  // was never told this session actually holds.
  if (core_started_ &&
      authority.mode == common::TransportSessionMode::kControl) {
    core_.SetControlActive(true);
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
  it->second->UnregisterObserver();
  it->second->Close();
  channels_.erase(it);
  channel_observers_.erase(label);
}

void LinuxRemoteDesktopSession::CloseTransport() noexcept {
  if (video_track_) {
    video_track_ = nullptr;
  }
  video_lease_.reset();
  for (auto& [label, channel] : channels_) {
    channel->UnregisterObserver();
    channel->Close();
  }
  channels_.clear();
  channel_observers_.clear();
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
  const DataChannelKind kind = ChannelKindFromLabel(label);
  auto observer = std::make_unique<LinuxDataChannelObserver>(
      weak_from_this(), kind);
  channel->RegisterObserver(observer.get());
  channels_[label] = channel;
  channel_observers_[label] = std::move(observer);
  transport_core_.OnDataChannelState(CallbackStamp(), kind,
                                     DataChannelState::kOpen);
}

LinuxRemoteDesktopSession::LinuxDataChannelObserver::LinuxDataChannelObserver(
    std::weak_ptr<LinuxRemoteDesktopSession> session, DataChannelKind channel)
    : session_(std::move(session)), channel_(channel) {}

void LinuxRemoteDesktopSession::LinuxDataChannelObserver::OnMessage(
    const webrtc::DataBuffer& buffer) {
  if (buffer.binary || buffer.size() == 0 ||
      buffer.size() > imcodes::rd::kMaxDataMessageBytes) {
    return;
  }
  if (auto session = session_.lock()) {
    session->HandleDataChannelMessage(
        channel_,
        std::string(reinterpret_cast<const char*>(buffer.data.data()),
                    buffer.data.size()));
  }
}

common::InputStamp LinuxRemoteDesktopSession::InputStampFor(
    const imcodes::rd::DataChannelMessage& message,
    DataChannelKind channel,
    bool position) const {
  const char* controller = "control";
  if (channel == DataChannelKind::kKeyboard) controller = "keyboard";
  else if (channel == DataChannelKind::kPointer) controller = "pointer";
  return {
      .controller_id = position ? std::string(controller) + ":position"
                                : std::string(controller),
      .epoch = message.correlation.input_epoch,
      .sequence = message.correlation.sequence,
      .topology_revision = message.correlation.layout_revision,
  };
}

bool LinuxRemoteDesktopSession::CorrelationMatches(
    const imcodes::rd::DataChannelMessage& message) const {
  const RouteAuthority* authority = transport_core_.authority();
  const common::DesktopTopology* current_topology = core_.topology();
  return authority != nullptr && current_topology != nullptr &&
         message.correlation.session_id == authority->identity.session_id &&
         message.correlation.input_epoch == authority->input_epoch &&
         message.correlation.layout_revision == current_topology->revision;
}

void LinuxRemoteDesktopSession::HandleDataChannelMessage(
    DataChannelKind channel, const std::string& payload) {
  imcodes::rd::DataChannelMessage message;
  if (!imcodes::rd::ParseDataChannelMessage(payload, &message) ||
      !CorrelationMatches(message)) {
    return;
  }
  const RouteAuthority* authority = transport_core_.authority();
  if (authority == nullptr) return;
  const auto applied = [](InputResult result) {
    return result == InputResult::kApplied;
  };
  const common::DesktopTopology* current_topology = core_.topology();
  const std::string display_id = current_topology != nullptr &&
                                         !current_topology->displays.empty()
                                     ? current_topology->displays.front().display_id
                                     : std::string();

  if (message.kind == imcodes::rd::DataChannelMessageKind::kPointer &&
      (channel == DataChannelKind::kPointer ||
       channel == DataChannelKind::kControl)) {
    if (display_id.empty()) return;
    if (message.pointer.x.has_value() && message.pointer.y.has_value() &&
        message.pointer.kind != imcodes::rd::PointerKind::kMove) {
      // Every non-move pointer event also carries the cursor's current
      // position (the same "position" controller macOS/Windows fence
      // separately from the button/wheel action itself) so a click lands
      // exactly where the browser's own cursor was, not wherever the last
      // explicit move happened to leave the X11 pointer.
      if (!applied(ApplyPointerMove({
              InputStampFor(message, channel, true),
              display_id,
              *message.pointer.x,
              *message.pointer.y,
          }))) {
        return;
      }
    }
    switch (message.pointer.kind) {
      case imcodes::rd::PointerKind::kMove:
        if (!message.pointer.x.has_value() || !message.pointer.y.has_value()) return;
        ApplyPointerMove({
            InputStampFor(message, channel, true),
            display_id,
            *message.pointer.x,
            *message.pointer.y,
        });
        break;
      case imcodes::rd::PointerKind::kButtonDown:
      case imcodes::rd::PointerKind::kButtonUp:
      case imcodes::rd::PointerKind::kButtonClick: {
        static constexpr const char* kButtons[] = {"left", "middle", "right",
                                                    "back", "forward"};
        if (!message.pointer.button.has_value()) return;
        const std::size_t index =
            static_cast<std::size_t>(*message.pointer.button);
        if (index >= sizeof(kButtons) / sizeof(kButtons[0])) return;
        common::ButtonTransition transition{
            InputStampFor(message, channel),
            kButtons[index],
            message.pointer.kind == imcodes::rd::PointerKind::kButtonDown,
        };
        if (message.pointer.kind == imcodes::rd::PointerKind::kButtonClick) {
          ClickButton(transition);
        } else {
          ApplyButton(transition);
        }
        break;
      }
      case imcodes::rd::PointerKind::kWheel:
        if (!message.pointer.delta_x.has_value() ||
            !message.pointer.delta_y.has_value()) {
          return;
        }
        ApplyWheel({
            InputStampFor(message, channel),
            *message.pointer.delta_x,
            *message.pointer.delta_y,
        });
        break;
    }
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kKeyboard &&
             channel == DataChannelKind::kKeyboard) {
    if (message.keyboard.kind == imcodes::rd::KeyboardKind::kText) {
      if (!message.keyboard.text.has_value()) return;
      ApplyText({InputStampFor(message, channel), *message.keyboard.text});
    } else {
      if (!message.keyboard.code.has_value()) return;
      ApplyKey({
          InputStampFor(message, channel),
          *message.keyboard.code,
          message.keyboard.kind == imcodes::rd::KeyboardKind::kKeyDown,
      });
    }
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kReleaseAll &&
             channel == DataChannelKind::kControl) {
    ReleaseController("control");
    ReleaseController("control:position");
    ReleaseController("keyboard");
    ReleaseController("pointer");
    ReleaseController("pointer:position");
  }
  // "control" messages other than release_all ("hello", "keepalive", and
  // anything display/clipboard/unlock-shaped) are parsed but not acted on --
  // see this file's header comment for why those have nothing to route to
  // yet on Linux. Silently accepting rather than closing the channel: an
  // unimplemented-but-well-formed control kind is not a protocol violation.
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
  transport_core_.OnPeerConnectionState(CallbackStamp(), mapped, SampleNow());
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
