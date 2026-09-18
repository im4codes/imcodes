#include "linux_remote_desktop_session.h"

#include <chrono>
#include <cstddef>
#include <cstdio>
#include <iterator>
#include <limits>
#include <utility>

#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/stats/rtc_stats_collector_callback.h"
#include "api/stats/rtcstats_objects.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"

#include "../remote-desktop-common/data_channel_constants.h"
#include "../remote-desktop-common/data_channel_payload.h"
#include "../remote-desktop-common/json_protocol.h"
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

bool LinuxRemoteDesktopSession::RenewLease(const common::RouteAuthority& renewal,
                                           common::TransportTime now) {
  if (closed_) return false;
  return transport_core_.RenewLease(renewal, now);
}

bool LinuxRemoteDesktopSession::UpdateMode(const common::RouteAuthority& update,
                                           common::TransportTime now) {
  if (closed_ || !transport_core_.UpdateMode(update, now)) return false;
  // The transport core has already released every physically held key/
  // button on a control->view switch or a control epoch advance (its
  // ReleaseControlAuthority -> this class's adapter seam). SessionCore keeps
  // its own ledger/state, so it is told too: SetControlActive(false) clears
  // the ledger and drops to kViewing; SetControlActive(true) is idempotent
  // when already controlling.
  if (!core_started_) return true;
  return core_.SetControlActive(update.mode ==
                                common::TransportSessionMode::kControl);
}

namespace {
// Real outbound video RTP bytes, from the peer connection's OWN stats --
// mirrors Windows' PeerMediaStatsObserver (peer_session.cc) and macOS' own
// equivalent exactly: sum RTCOutboundRtpStreamStats::bytes_sent across every
// "video" kind stream. A CapturedFrame reaching Source::PushFrame (see
// linux_native_video_source.cc) proves the local pipeline works, not that a
// byte ever left this process -- this is the one signal that proves that.
class LinuxMediaStatsObserver : public webrtc::RTCStatsCollectorCallback {
 public:
  explicit LinuxMediaStatsObserver(
      std::weak_ptr<LinuxRemoteDesktopSession> session)
      : session_(std::move(session)) {}

  void OnStatsDelivered(
      const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report)
      override {
    bool has_outbound_video = false;
    std::uint64_t outbound_bytes = 0;
    if (report) {
      for (const auto* stats :
           report->GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>()) {
        if (!stats->kind.has_value() || *stats->kind != "video" ||
            !stats->bytes_sent.has_value()) {
          continue;
        }
        has_outbound_video = true;
        const std::uint64_t bytes = *stats->bytes_sent;
        outbound_bytes =
            std::numeric_limits<std::uint64_t>::max() - outbound_bytes < bytes
                ? std::numeric_limits<std::uint64_t>::max()
                : outbound_bytes + bytes;
      }
    }
    if (auto session = session_.lock()) {
      session->HandleMediaStats(has_outbound_video, outbound_bytes);
    }
  }

 private:
  const std::weak_ptr<LinuxRemoteDesktopSession> session_;
};
}  // namespace

void LinuxRemoteDesktopSession::CheckMediaProgress() {
  if (closed_ || !peer_ ||
      peer_->peer_connection_state() !=
          webrtc::PeerConnectionInterface::PeerConnectionState::kConnected) {
    return;
  }
  if (media_stats_in_flight_) return;
  media_stats_in_flight_ = true;
  peer_->GetStats(webrtc::make_ref_counted<LinuxMediaStatsObserver>(
      weak_from_this()).get());
}

void LinuxRemoteDesktopSession::HandleMediaStats(
    bool has_outbound_video, std::uint64_t outbound_bytes) {
  media_stats_in_flight_ = false;
  if (closed_ || !has_outbound_video || !video_lease_) return;
  const std::uint64_t source_frames = video_lease_->captured_frames();
  (void)transport_core_.RecordMediaProgress(
      CallbackStamp(), source_frames, outbound_bytes, SampleNow());
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
  config.bundle_policy = webrtc::PeerConnectionInterface::kBundlePolicyMaxBundle;
  config.continual_gathering_policy =
      webrtc::PeerConnectionInterface::GATHER_CONTINUALLY;
  // Windows' PeerSession::StartTransport wires authority_.ice_servers (the
  // deployment's STUN/TURN, from PREPARE) into config.servers the same way;
  // this file never did, so every Linux session ran host-candidates-only.
  // On a host with many virtual interfaces (211: ~10 Docker bridge networks,
  // each producing its own host candidate) that is not just slower --
  // ICE has no relay to fall back to when the pair it settles on stops
  // working (a NAT binding timing out, STUN consent-freshness failing),
  // so peer.connectionState genuinely flips to "failed" after a while,
  // the browser calls restartIce(), and every restart is doomed to hit the
  // exact same host-only candidate set and fail the same way -- burning
  // through REMOTE_DESKTOP_LIMITS.MAX_ICE_RESTARTS (8) and then
  // terminating the whole route with protocol_error. Windows/macOS sessions
  // do not show this because they always had a TURN relay to actually fall
  // back to.
  for (const imcodes::rd::IceServer& source : ice_servers_) {
    webrtc::PeerConnectionInterface::IceServer server;
    server.urls = source.urls;
    server.username = source.username;
    server.password = source.credential;
    config.servers.push_back(std::move(server));
  }

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

void LinuxRemoteDesktopSession::LinuxDataChannelObserver::OnStateChange() {
  if (auto session = session_.lock()) {
    session->OnChannelReady(channel_);
  }
}

void LinuxRemoteDesktopSession::OnChannelReady(DataChannelKind kind) {
  auto it = channels_.find(ChannelLabel(kind));
  if (it == channels_.end() || !it->second ||
      it->second->state() != webrtc::DataChannelInterface::kOpen) {
    return;
  }
  if (kind == DataChannelKind::kControl) {
    SendTopology();
  }
}

bool LinuxRemoteDesktopSession::SendTopology() {
  const common::DesktopTopology* topology = core_.topology();
  const common::RouteAuthority* authority = transport_core_.authority();
  auto it = channels_.find(ChannelLabel(DataChannelKind::kControl));
  if (topology == nullptr || authority == nullptr ||
      it == channels_.end() || !it->second) {
    return false;
  }
  Json::Value root(Json::objectValue);
  root["type"] = imcodes::rd::kTopologyType;
  root["protocolVersion"] = imcodes::rd::kProtocolVersion;
  root["sessionId"] = authority->identity.session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["layoutRevision"] = Json::UInt64(topology->revision);
  Json::Value displays(Json::arrayValue);
  for (std::size_t index = 0; index < topology->displays.size(); ++index) {
    const common::DisplayTopology& display = topology->displays[index];
    Json::Value encoded(Json::objectValue);
    encoded["id"] = display.display_id;
    encoded["label"] = display.display_id;
    encoded["primary"] = index == 0;
    encoded["available"] = true;
    encoded["width"] = display.encoded_pixels.width;
    encoded["height"] = display.encoded_pixels.height;
    encoded["dpiScale"] = display.scale;
    encoded["rotation"] = static_cast<unsigned int>(display.rotation);
    Json::Value bounds(Json::objectValue);
    bounds["x"] = display.logical_input_bounds.x;
    bounds["y"] = display.logical_input_bounds.y;
    bounds["width"] = display.logical_input_bounds.width;
    bounds["height"] = display.logical_input_bounds.height;
    encoded["inputBounds"] = std::move(bounds);
    // Wire shape is shared/remote-desktop.ts's isDisplayOperations(): EXACTLY
    // setMode/setScale, nothing else. display.operations.selectable is a
    // native-side-only concept (DisplayOperations in value_types.h) with no
    // wire counterpart -- sending it as a third key made
    // hasExactKeys(value.operations, ['setMode','setScale']) reject every
    // display entry, which made isDisplay() reject the whole array, which
    // made validateDisplayTopology() reject the entire message: confirmed
    // live, this worker's own topology reached the browser exactly as
    // built (verified with a raw WebRTC listener bypassing the app's
    // validator), but the real app silently dropped it right here, so
    // snapshot.displays never populated and input never enabled -- despite
    // every other piece (SetControlActive, STATUS fields, sending topology
    // at all) being correct.
    Json::Value operations(Json::objectValue);
    operations["setMode"] = display.operations.set_mode;
    operations["setScale"] = display.operations.set_scale;
    encoded["operations"] = std::move(operations);
    displays.append(std::move(encoded));
  }
  root["displays"] = std::move(displays);
  if (!topology->displays.empty()) {
    root["selectedDisplayId"] = topology->displays.front().display_id;
  }
  const std::string payload = imcodes::rd::WriteJson(root);
  return it->second->Send(webrtc::DataBuffer(payload));
}

bool LinuxRemoteDesktopSession::SendInputAck(
    std::uint64_t acknowledged_sequence) {
  const common::DesktopTopology* topology = core_.topology();
  const common::RouteAuthority* authority = transport_core_.authority();
  auto it = channels_.find(ChannelLabel(DataChannelKind::kControl));
  if (topology == nullptr || authority == nullptr || it == channels_.end() ||
      !it->second ||
      it->second->state() != webrtc::DataChannelInterface::kOpen) {
    return false;
  }
  Json::Value root(Json::objectValue);
  root["type"] = imcodes::rd::kControlType;
  root["protocolVersion"] = imcodes::rd::kProtocolVersion;
  root["sessionId"] = authority->identity.session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["layoutRevision"] = Json::UInt64(topology->revision);
  root["inputEpoch"] = Json::UInt64(authority->input_epoch);
  root["kind"] = imcodes::rd::kInputAckKind;
  root["acknowledgedSequence"] = Json::UInt64(acknowledged_sequence);
  const std::string payload = imcodes::rd::WriteJson(root);
  return it->second->Send(webrtc::DataBuffer(payload));
}

bool LinuxRemoteDesktopSession::SendClipboard(
    const std::string& request_id, const std::optional<std::string>& text) {
  const common::RouteAuthority* authority = transport_core_.authority();
  auto it = channels_.find(ChannelLabel(DataChannelKind::kControl));
  if (authority == nullptr || it == channels_.end() || !it->second ||
      it->second->state() != webrtc::DataChannelInterface::kOpen) {
    return false;
  }
  Json::Value root(Json::objectValue);
  root["type"] = imcodes::rd::kClipboardType;
  root["protocolVersion"] = imcodes::rd::kProtocolVersion;
  root["sessionId"] = authority->identity.session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["requestId"] = request_id;
  // Same rule as macOS: nothing, or more than the browser accepts, is "not
  // available" rather than a silently cut-off copy.
  const bool available = text.has_value() && !text->empty() &&
                         text->size() <= imcodes::rd::kMaxClipboardTextBytes;
  root["available"] = available;
  if (available) root["text"] = *text;
  const std::string payload = imcodes::rd::WriteJson(root);
  return it->second->Send(webrtc::DataBuffer(payload));
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
  // Same bookkeeping as macOS's WorkerTransportSink::HandleDataChannelMessage
  // and Windows' PeerSession input handlers: every accepted message counts as
  // route activity, and every reliable input transition is acknowledged.
  bool accepted = false;
  bool acknowledge = false;

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
        accepted = applied(ApplyPointerMove({
            InputStampFor(message, channel, true),
            display_id,
            *message.pointer.x,
            *message.pointer.y,
        }));
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
        accepted = applied(
            message.pointer.kind == imcodes::rd::PointerKind::kButtonClick
                ? ClickButton(transition)
                : ApplyButton(transition));
        acknowledge = channel == DataChannelKind::kControl;
        break;
      }
      case imcodes::rd::PointerKind::kWheel:
        if (!message.pointer.delta_x.has_value() ||
            !message.pointer.delta_y.has_value()) {
          return;
        }
        accepted = applied(ApplyWheel({
            InputStampFor(message, channel),
            *message.pointer.delta_x,
            *message.pointer.delta_y,
        }));
        break;
    }
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kKeyboard &&
             channel == DataChannelKind::kKeyboard) {
    if (message.keyboard.kind == imcodes::rd::KeyboardKind::kText) {
      if (!message.keyboard.text.has_value()) return;
      accepted = applied(
          ApplyText({InputStampFor(message, channel), *message.keyboard.text}));
    } else {
      if (!message.keyboard.code.has_value()) return;
      accepted = applied(ApplyKey({
          InputStampFor(message, channel),
          *message.keyboard.code,
          message.keyboard.kind == imcodes::rd::KeyboardKind::kKeyDown,
      }));
    }
    acknowledge = true;
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kReleaseAll &&
             channel == DataChannelKind::kControl) {
    ReleaseController("control");
    ReleaseController("control:position");
    ReleaseController("keyboard");
    ReleaseController("pointer");
    ReleaseController("pointer:position");
    accepted = true;
    acknowledge = true;
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kControl &&
             channel == DataChannelKind::kControl &&
             message.control.kind == imcodes::rd::kCopySelectionKind) {
    // Copy/Cut in the browser: hand back the remote selection. Only a
    // controller may read the remote machine's clipboard, as on macOS.
    if (!message.control.request_id.has_value() ||
        authority->mode != common::TransportSessionMode::kControl) {
      return;
    }
    std::string text;
    const bool copied = adapters_.clipboard().CopySelection(&text);
    (void)SendClipboard(*message.control.request_id,
                        copied ? std::optional<std::string>(std::move(text))
                               : std::nullopt);
    accepted = true;
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kControl &&
             channel == DataChannelKind::kControl &&
             (message.control.kind == imcodes::rd::kHelloKind ||
              message.control.kind == imcodes::rd::kKeepaliveKind)) {
    // The browser's 30 s data keepalive is what keeps an open-but-idle
    // session inside the core's idle timeout, as on macOS/Windows.
    accepted = true;
  } else if (message.kind == imcodes::rd::DataChannelMessageKind::kControl &&
             channel == DataChannelKind::kControl &&
             message.control.kind == "frame_presented") {
    // The one "control" kind that IS acted on despite the general "not yet
    // routed" comment below: the Server's negotiationTimer
    // (server/src/ws/remote-desktop-router.ts, REMOTE_DESKTOP_LIMITS.
    // NEGOTIATION_TIMEOUT_MS, 45s) never clears without this, no matter how
    // healthy offer/ICE/lease/mode_state are -- see FramePresented()'s own
    // comment in the header. Validated exactly like macOS's equivalent
    // branch: the acknowledged display must be the (only) one this session
    // has, and the presented frame's aspect ratio must be compatible with
    // it -- both already bounded upstream by data_channel_payload.h's shared
    // parser, re-checked here the same defense-in-depth way macOS does.
    const common::DesktopTopology* topology = core_.topology();
    if (topology == nullptr || topology->displays.empty() ||
        !message.control.display_id.has_value() ||
        *message.control.display_id != topology->displays.front().display_id ||
        !message.control.frame_width.has_value() ||
        !message.control.frame_height.has_value() ||
        *message.control.frame_width == 0 || *message.control.frame_height == 0 ||
        *message.control.frame_width > 16'384 ||
        *message.control.frame_height > 16'384 ||
        !common::PresentedFrameCompatibleWithDisplay(
            {static_cast<std::uint32_t>(*message.control.frame_width),
             static_cast<std::uint32_t>(*message.control.frame_height)},
            topology->displays.front().encoded_pixels)) {
      return;
    }
    presented_layout_revision_ = topology->revision;
    accepted = true;
  }
  // Other "control" kinds (display/unlock-shaped) are parsed but
  // not acted on -- see this file's header comment for why those have
  // nothing to route to yet on Linux. Silently accepting rather than closing
  // the channel: an unimplemented-but-well-formed control kind is not a
  // protocol violation.
  if (!accepted ||
      !transport_core_.RecordActivity(authority->identity, SampleNow())) {
    return;
  }
  if (acknowledge) (void)SendInputAck(message.correlation.sequence);
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
  const common::TransportDiagnostics before = transport_core_.diagnostics();
  const RouteAuthority* authority = transport_core_.authority();
  const std::string session_id =
      authority != nullptr ? authority->identity.session_id : std::string();
  if (!transport_core_.OnPeerConnectionState(CallbackStamp(), mapped,
                                             SampleNow()) &&
      before.terminal_reason == common::TransportTerminalReason::kNone &&
      transport_core_.diagnostics().terminal_reason ==
          common::TransportTerminalReason::kProtocolViolation) {
    // Error path only: the core refused a libwebrtc state transition and
    // ended the session as protocol_error; name the transition.
    static constexpr const char* kNames[] = {"new",          "connecting",
                                             "connected",    "disconnected",
                                             "failed",       "closed"};
    const auto name = [](PeerConnectionState value) {
      const auto index = static_cast<std::size_t>(value);
      return index < std::size(kNames) ? kNames[index] : "unknown";
    };
    std::fprintf(stderr,
                 "linux worker: session %.8s peer state %s -> %s refused\n",
                 session_id.c_str(), name(before.peer_state),
                 name(mapped));
  }
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
