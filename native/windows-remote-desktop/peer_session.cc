#include "third_party/imcodes_remote_desktop/peer_session.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <optional>
#include <utility>

#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/rtp_parameters.h"
#include "api/rtp_sender_interface.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/stats/rtc_stats_collector_callback.h"
#include "api/stats/rtcstats_objects.h"
#include "api/transport/bitrate_settings.h"
#include "rtc_base/logging.h"
#include "third_party/imcodes_remote_desktop/display_preferences.h"
#include "third_party/imcodes_remote_desktop/mf_h264_encoder.h"
#include "third_party/imcodes_remote_desktop/quality_ladder.h"
#include "third_party/imcodes_remote_desktop/worker_policy.h"

namespace imcodes::rd {
namespace {

bool ExactKeys(const Json::Value& root,
               std::initializer_list<const char*> required,
               std::initializer_list<const char*> optional = {}) {
  if (!root.isObject()) return false;
  std::set<std::string> allowed;
  for (const char* key : required) {
    allowed.insert(key);
    if (!root.isMember(key)) return false;
  }
  for (const char* key : optional) allowed.insert(key);
  for (const std::string& key : root.getMemberNames()) {
    if (!allowed.contains(key)) return false;
  }
  return true;
}

class SetRemoteObserver
    : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  explicit SetRemoteObserver(std::function<void(bool)> done)
      : done_(std::move(done)) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    done_(error.ok());
  }

 private:
  const std::function<void(bool)> done_;
};

class SetLocalObserver
    : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  explicit SetLocalObserver(std::function<void(bool)> done)
      : done_(std::move(done)) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    done_(error.ok());
  }

 private:
  const std::function<void(bool)> done_;
};

class AnswerObserver
    : public webrtc::CreateSessionDescriptionObserver {
 public:
  explicit AnswerObserver(std::weak_ptr<PeerSession> session)
      : session_(std::move(session)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* description) override {
    std::unique_ptr<webrtc::SessionDescriptionInterface> owned(description);
    std::string sdp;
    if (!description || !description->ToString(&sdp)) return;
    if (auto session = session_.lock())
      session->SendAnswer(std::move(owned), sdp);
  }
  void OnFailure(webrtc::RTCError) override {
    if (auto session = session_.lock()) session->Close("peer_failed");
  }

 private:
  const std::weak_ptr<PeerSession> session_;
};

std::u16string Utf8ToUtf16(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                       value.data(), value.size(), nullptr, 0);
  if (size <= 0) return {};
  std::wstring wide(static_cast<size_t>(size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          value.size(), wide.data(), size) != size) {
    return {};
  }
  return std::u16string(reinterpret_cast<const char16_t*>(wide.data()),
                        wide.size());
}

std::string Utf16ToUtf8(const std::u16string& value) {
  if (value.empty()) return {};
  const auto* wide = reinterpret_cast<const wchar_t*>(value.data());
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide,
                                       static_cast<int>(value.size()), nullptr,
                                       0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide,
                          static_cast<int>(value.size()), result.data(), size,
                          nullptr, nullptr) != size) {
    return {};
  }
  return result;
}

bool SameDisplay(const DisplayInfo& left, const DisplayInfo& right) {
  return left.id == right.id && left.label == right.label &&
         left.device_name == right.device_name &&
         left.desktop_rect.left == right.desktop_rect.left &&
         left.desktop_rect.top == right.desktop_rect.top &&
         left.desktop_rect.right == right.desktop_rect.right &&
         left.desktop_rect.bottom == right.desktop_rect.bottom &&
         left.width == right.width && left.height == right.height &&
         left.rotation_degrees == right.rotation_degrees &&
         std::abs(left.dpi_scale - right.dpi_scale) < 0.001 &&
         left.primary == right.primary && left.available == right.available &&
         left.imcodes_virtual == right.imcodes_virtual;
}

bool SameTopology(const std::vector<DisplayInfo>& left,
                  const std::vector<DisplayInfo>& right) {
  return left.size() == right.size() &&
         std::equal(left.begin(), left.end(), right.begin(), SameDisplay);
}

bool InputApplied(common::InputResult result) noexcept {
  return result == common::InputResult::kApplied;
}

common::TransportTime CurrentTransportTime() noexcept {
  return {
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count(),
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count(),
  };
}

common::DataChannelKind CommonChannelKind(const std::string& label) {
  if (label == kControlChannel) return common::DataChannelKind::kControl;
  if (label == kKeyboardChannel) return common::DataChannelKind::kKeyboard;
  return common::DataChannelKind::kPointer;
}

const char* ChannelLabel(common::DataChannelKind channel) noexcept {
  switch (channel) {
    case common::DataChannelKind::kControl:
      return kControlChannel;
    case common::DataChannelKind::kKeyboard:
      return kKeyboardChannel;
    case common::DataChannelKind::kPointer:
      return kPointerChannel;
  }
  return kControlChannel;
}

common::PeerConnectionState CommonPeerConnectionState(
    webrtc::PeerConnectionInterface::PeerConnectionState state) noexcept {
  using WebRtcState =
      webrtc::PeerConnectionInterface::PeerConnectionState;
  switch (state) {
    case WebRtcState::kNew:
      return common::PeerConnectionState::kNew;
    case WebRtcState::kConnecting:
      return common::PeerConnectionState::kConnecting;
    case WebRtcState::kConnected:
      return common::PeerConnectionState::kConnected;
    case WebRtcState::kDisconnected:
      return common::PeerConnectionState::kDisconnected;
    case WebRtcState::kFailed:
      return common::PeerConnectionState::kFailed;
    case WebRtcState::kClosed:
      return common::PeerConnectionState::kClosed;
  }
  return common::PeerConnectionState::kFailed;
}

common::DataChannelState CommonDataChannelState(
    webrtc::DataChannelInterface::DataState state) noexcept {
  switch (state) {
    case webrtc::DataChannelInterface::kConnecting:
      return common::DataChannelState::kConnecting;
    case webrtc::DataChannelInterface::kOpen:
      return common::DataChannelState::kOpen;
    case webrtc::DataChannelInterface::kClosing:
    case webrtc::DataChannelInterface::kClosed:
      return common::DataChannelState::kClosed;
  }
  return common::DataChannelState::kFailed;
}

}  // namespace

class PeerMediaStatsObserver : public webrtc::RTCStatsCollectorCallback {
 public:
  PeerMediaStatsObserver(std::weak_ptr<PeerSession> session,
                         uint64_t generation)
      : session_(std::move(session)), generation_(generation) {}

  void OnStatsDelivered(
      const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report)
      override {
    bool has_outbound_video = false;
    uint64_t outbound_bytes = 0;
    if (report) {
      for (const auto* stats :
           report->GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>()) {
        if (!stats->kind || *stats->kind != "video" || !stats->bytes_sent)
          continue;
        has_outbound_video = true;
        const uint64_t bytes = *stats->bytes_sent;
        outbound_bytes = std::numeric_limits<uint64_t>::max() - outbound_bytes <
                                 bytes
                             ? std::numeric_limits<uint64_t>::max()
                             : outbound_bytes + bytes;
      }
    }
    if (auto session = session_.lock()) {
      session->HandleMediaStats(generation_, has_outbound_video,
                                outbound_bytes);
    }
  }

 private:
  const std::weak_ptr<PeerSession> session_;
  const uint64_t generation_;
};

PeerDataObserver::PeerDataObserver(std::weak_ptr<PeerSession> session,
                                   std::string label)
    : session_(std::move(session)), label_(std::move(label)) {}

void PeerDataObserver::OnStateChange() {
  if (auto session = session_.lock()) session->HandleChannelState(label_);
}

void PeerDataObserver::OnMessage(const webrtc::DataBuffer& buffer) {
  if (auto session = session_.lock()) session->HandleData(label_, buffer);
}

common::QualitySelection PeerSession::WindowsQualityLadder::Select(
    const common::QualityTarget& target) const noexcept {
  const QualitySelection selected = SelectQuality(
      target.bitrate_bps, static_cast<int>(target.source_pixels.width),
      static_cast<int>(target.source_pixels.height));
  return {
      selected.id,
      {static_cast<std::uint32_t>(selected.width),
       static_cast<std::uint32_t>(selected.height)},
      static_cast<std::uint32_t>(selected.fps),
      selected.bitrate_bps,
  };
}

std::shared_ptr<PeerSession> PeerSession::Create(
    Authority authority,
    webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
    std::vector<DisplayInfo> displays,
    AcquireSource acquire_source,
    ReleaseSource release_source,
    InputArbiter* input,
    ClipboardSequence clipboard_sequence,
    ReadClipboardText read_clipboard_text,
    RequestUnlock request_unlock,
    webrtc::Thread* signaling_thread,
    EmitJson emit) {
  return std::shared_ptr<PeerSession>(new PeerSession(
      std::move(authority), std::move(factory), std::move(displays),
      std::move(acquire_source), std::move(release_source), input,
      std::move(clipboard_sequence), std::move(read_clipboard_text),
      std::move(request_unlock), signaling_thread,
      std::move(emit)));
}

PeerSession::PeerSession(
    Authority authority,
    webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory,
    std::vector<DisplayInfo> displays,
    AcquireSource acquire_source,
    ReleaseSource release_source,
    InputArbiter* input,
    ClipboardSequence clipboard_sequence,
    ReadClipboardText read_clipboard_text,
    RequestUnlock request_unlock,
    webrtc::Thread* signaling_thread,
    EmitJson emit)
    : authority_(std::move(authority)),
      factory_(std::move(factory)),
      displays_(std::move(displays)),
      input_(input),
      request_unlock_(std::move(request_unlock)),
      signaling_thread_(signaling_thread),
      emit_(std::move(emit)),
      transport_core_(*this, transport_quality_ladder_) {
  capture_adapter_ = std::make_unique<WindowsDxgiCaptureTrackAdapter>(
      std::move(acquire_source), std::move(release_source));
  if (input_) {
    clipboard_adapter_ = std::make_unique<WindowsClipboardAdapter>(
        *input_, std::move(clipboard_sequence), std::move(read_clipboard_text),
        authority_.session_id + ":clipboard");
  }
  display_adapter_ = std::make_unique<WindowsDisplayAdapter>(
      [this]() -> const std::vector<DisplayInfo>& { return displays_; });
  RefreshCommonTopology();
  const auto primary = std::find_if(displays_.begin(), displays_.end(),
                                    [](const DisplayInfo& display) {
                                      return display.primary;
                                    });
  if (primary != displays_.end())
    selected_display_ = static_cast<size_t>(primary - displays_.begin());
}

PeerSession::~PeerSession() {
  Close("worker_failed", false);
}

common::RouteAuthorityIdentity PeerSession::CommonIdentity() const {
  return {
      authority_.request_id,
      authority_.session_id,
      authority_.capability,
      static_cast<common::WorkerGeneration>(authority_.daemon_generation),
      static_cast<std::uint64_t>(authority_.route_generation.value_or(1)),
  };
}

common::RouteAuthority PeerSession::CommonAuthority(
    const Authority& authority) const {
  return {
      {
          authority.request_id,
          authority.session_id,
          authority.capability,
          static_cast<common::WorkerGeneration>(authority.daemon_generation),
          static_cast<std::uint64_t>(authority.route_generation.value_or(1)),
      },
      authority.expires_at_ms,
      authority.lease_expires_at_ms,
      authority.mode == kControlMode ? common::TransportSessionMode::kControl
                                     : common::TransportSessionMode::kView,
      static_cast<std::uint64_t>(authority.input_epoch),
  };
}

common::TransportCallbackStamp PeerSession::CallbackStamp() const {
  const common::RouteAuthorityIdentity identity = CommonIdentity();
  return {identity.daemon_generation, identity.route_generation};
}

bool PeerSession::StartTransport(const common::RouteAuthority& authority) {
  if (authority.identity.request_id != authority_.request_id ||
      authority.identity.session_id != authority_.session_id ||
      authority.identity.negotiated_capability_binding !=
          authority_.capability) {
    return false;
  }
  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  config.bundle_policy =
      webrtc::PeerConnectionInterface::kBundlePolicyMaxBundle;
  config.continual_gathering_policy =
      webrtc::PeerConnectionInterface::GATHER_CONTINUALLY;
  for (const IceServer& source : authority_.ice_servers) {
    webrtc::PeerConnectionInterface::IceServer server;
    server.urls = source.urls;
    server.username = source.username;
    server.password = source.credential;
    config.servers.push_back(std::move(server));
  }
  webrtc::PeerConnectionDependencies dependencies(this);
  auto result = factory_->CreatePeerConnectionOrError(
      config, std::move(dependencies));
  if (!result.ok()) return false;
  peer_ = std::move(result.value());
  return ApplyTransportBitratePolicy(false);
}

bool PeerSession::Initialize() {
  const auto startup_virtual_display = std::find_if(
      displays_.begin(), displays_.end(),
      [](const DisplayInfo& display) { return display.imcodes_virtual; });
  if (startup_virtual_display != displays_.end()) {
    VirtualDisplayPreferences preferences;
    // Only honor a persisted DPI scale when the persisted mode matches the
    // actual mode currently enumerated. A stale entry left behind by a failed
    // higher-resolution switch (or by another worker that crashed mid-rebind)
    // is treated as no preference, and the recommended scale for the actual
    // current resolution is used instead. This prevents a stale scale from
    // being applied on a display that no longer exposes that resolution, which
    // would otherwise ship mismatched texture descriptors to the compositor and
    // cause c00001ad-format dwm crashes during the first media frame.
    const bool scale_persisted_for_current_mode =
        LoadVirtualDisplayPreferences(&preferences) &&
        preferences.width == startup_virtual_display->width &&
        preferences.height == startup_virtual_display->height &&
        IsAllowedRemoteDisplayScale(preferences.dpi_scale_percent);
    const int desired_scale = scale_persisted_for_current_mode
        ? preferences.dpi_scale_percent
        : RecommendedRemoteDisplayScale(startup_virtual_display->width,
                                        startup_virtual_display->height);
    if (std::lround(startup_virtual_display->dpi_scale * 100.0) !=
            desired_scale &&
        SetDisplayDpiScale(*startup_virtual_display, desired_scale)) {
      std::vector<DisplayInfo> refreshed = EnumerateDisplays();
      if (!refreshed.empty()) displays_ = std::move(refreshed);
    }
  }
  if (!factory_ || !capture_adapter_ ||
      capture_adapter_->ProbeReadiness() != common::ReadinessState::kReady ||
      displays_.empty() || !input_ || !signaling_thread_ ||
      !signaling_thread_->IsCurrent() || !RefreshCommonTopology()) {
    return false;
  }
  if (!transport_core_.Start(CommonAuthority(authority_),
                             CurrentTransportTime()) ||
      !transport_core_.SetLocalIceEmissionReady(CallbackStamp())) {
    return false;
  }
  // An IM.codes virtual display exists only after the real desktop failed its
  // bounded presentability gate. Prefer that exact adapter on the retry; never
  // select a similarly named third-party virtual adapter. Without it, retain
  // the normal primary-first behavior and try other attached real displays.
  std::vector<size_t> candidates;
  candidates.reserve(displays_.size());
  const auto virtual_display = std::find_if(
      displays_.begin(), displays_.end(),
      [](const DisplayInfo& display) { return display.imcodes_virtual; });
  if (virtual_display != displays_.end()) {
    candidates.push_back(
        static_cast<size_t>(virtual_display - displays_.begin()));
  }
  if (std::find(candidates.begin(), candidates.end(), selected_display_) ==
      candidates.end()) {
    candidates.push_back(selected_display_);
  }
  for (size_t index = 0; index < displays_.size(); ++index) {
    if (std::find(candidates.begin(), candidates.end(), index) ==
        candidates.end()) {
      candidates.push_back(index);
    }
  }
  for (const size_t index : candidates) {
    auto candidate = capture_adapter_->Acquire(ToCommonDisplayTopology(
        displays_[index], CommonIdentity().daemon_generation));
    if (!candidate) continue;
    if (candidate->Start() && candidate->WaitForFirstFrame(
            std::chrono::milliseconds(kFirstPresentableFrameTimeoutMs))) {
      selected_display_ = index;
      source_ = std::move(candidate);
      break;
    }
  }
  if (!source_) return false;
  webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> native_source(
      source_->source());
  if (!native_source) return false;
  track_ = factory_->CreateVideoTrack(native_source,
                                      "imcodes-remote-desktop");
  if (!track_) return false;
  track_->set_content_hint(
      webrtc::VideoTrackInterface::ContentHint::kDetailed);
  const auto added = peer_->AddTrack(track_, {"imcodes-remote-desktop"});
  if (!added.ok()) return false;
  webrtc::RtpParameters parameters = added.value()->GetParameters();
  if (parameters.encodings.empty()) return false;
  for (webrtc::RtpEncodingParameters& encoding : parameters.encodings) {
    encoding.min_bitrate_bps = static_cast<int>(kMinVideoBitrateBps);
    encoding.max_bitrate_bps = static_cast<int>(kPerPeerVideoBitrateBps);
    encoding.max_framerate = 30.0;
  }
  parameters.degradation_preference =
      webrtc::DegradationPreference::MAINTAIN_RESOLUTION;
  // Held until the input channels are open — see video_activated_.
  for (webrtc::RtpEncodingParameters& encoding : parameters.encodings) {
    encoding.active = false;
  }
  if (!added.value()->SetParameters(parameters).ok()) return false;
  Json::Value initial = BaseEnvelope(kModeStateType, authority_);
  initial["mode"] = authority_.mode;
  initial["inputEpoch"] = authority_.input_epoch;
  initial["reason"] = "initial";
  emit_(initial);
  emit_transport_terminal_ = true;
  return true;
}

bool PeerSession::ApplyTransportBitratePolicy(bool direct) {
  if (!peer_) return false;
  if (direct_bitrate_policy_.has_value() &&
      *direct_bitrate_policy_ == direct) {
    return true;
  }
  const TransportBitratePolicy policy =
      SelectTransportBitratePolicy(direct);
  webrtc::BitrateSettings bitrate_settings;
  bitrate_settings.min_bitrate_bps = static_cast<int>(policy.min_bps);
  bitrate_settings.start_bitrate_bps = static_cast<int>(policy.start_bps);
  bitrate_settings.max_bitrate_bps = static_cast<int>(policy.max_bps);
  const webrtc::RTCError result = peer_->SetBitrate(bitrate_settings);
  if (!result.ok()) {
    RTC_LOG(LS_WARNING) << "remote desktop bitrate reseed failed: "
                        << result.message();
    return false;
  }
  direct_bitrate_policy_ = direct;
  return true;
}

bool PeerSession::ApplyOffer(const std::string& sdp) {
  if (closed_ || !peer_ || setting_remote_description_ || sdp.empty() ||
      sdp.size() > 256 * 1024)
    return false;
  webrtc::SdpParseError error;
  std::unique_ptr<webrtc::SessionDescriptionInterface> offer =
      webrtc::CreateSessionDescription(webrtc::SdpType::kOffer, sdp, &error);
  if (!offer) return false;
  setting_remote_description_ = true;
  std::weak_ptr<PeerSession> weak = shared_from_this();
  peer_->SetRemoteDescription(
      std::move(offer),
      webrtc::make_ref_counted<SetRemoteObserver>([weak](bool success) {
        if (auto session = weak.lock()) session->OnRemoteDescriptionSet(success);
      }));
  return true;
}

void PeerSession::OnRemoteDescriptionSet(bool success) {
  setting_remote_description_ = false;
  if (!success) {
    Close("peer_failed");
    return;
  }
  if (!transport_core_.SetRemoteDescriptionReady(CallbackStamp())) {
    Close("peer_failed");
    return;
  }
  CreateAnswer();
}

void PeerSession::CreateAnswer() {
  if (closed_ || !peer_) return;
  answer_observer_ =
      webrtc::make_ref_counted<AnswerObserver>(weak_from_this());
  peer_->CreateAnswer(answer_observer_.get(),
                      webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
}

void PeerSession::SendAnswer(
    std::unique_ptr<webrtc::SessionDescriptionInterface> answer,
    const std::string& sdp) {
  if (closed_ || !peer_ || !answer) return;
  std::weak_ptr<PeerSession> weak = shared_from_this();
  peer_->SetLocalDescription(
      std::move(answer),
      webrtc::make_ref_counted<SetLocalObserver>(
          [weak, sdp](bool success) {
            if (auto session = weak.lock()) {
              if (!success) {
                session->Close("peer_failed");
                return;
              }
              Json::Value response =
                  BaseEnvelope(kAnswerType, session->authority_);
              response["sdp"] = sdp;
              session->emit_(response);
            }
          }));
}

bool PeerSession::AddIce(const std::string& mid,
                         const std::string& candidate) {
  if (closed_ || !peer_) return false;
  webrtc::SdpParseError error;
  std::unique_ptr<webrtc::IceCandidate> parsed(
      webrtc::CreateIceCandidate(mid, 0, candidate, &error));
  if (!parsed) return false;
  return transport_core_.AddRemoteIceCandidate(
      CommonIdentity(), common::IceCandidate{mid, candidate});
}

bool PeerSession::AddRemoteIceCandidate(
    const common::IceCandidate& candidate) {
  webrtc::SdpParseError error;
  std::unique_ptr<webrtc::IceCandidate> parsed(
      webrtc::CreateIceCandidate(candidate.media_id, 0,
                                candidate.candidate, &error));
  return parsed && peer_ && peer_->AddIceCandidate(parsed.get());
}

bool PeerSession::Renew(const Authority& renewal) {
  if (!Matches(renewal) ||
      renewal.daemon_generation != authority_.daemon_generation ||
      renewal.route_generation != authority_.route_generation ||
      !transport_core_.RenewLease(CommonAuthority(renewal),
                                  CurrentTransportTime())) {
    return false;
  }
  authority_.lease_expires_at_ms = renewal.lease_expires_at_ms;
  return true;
}

bool PeerSession::SetMode(const Authority& update, const std::string& reason) {
  if (!Matches(update) ||
      (update.mode != kViewMode && update.mode != kControlMode) ||
      !transport_core_.UpdateMode(CommonAuthority(update),
                                  CurrentTransportTime())) {
    return false;
  }
  // The input epoch moves with the mode, and every input frame is bound to it,
  // so a stale-mode packet is already refused without a separate counter.
  authority_.mode = update.mode;
  authority_.input_epoch = update.input_epoch;
  authority_.lease_expires_at_ms = update.lease_expires_at_ms;
  Json::Value response = BaseEnvelope(kModeStateType, authority_);
  response["mode"] = authority_.mode;
  response["inputEpoch"] = authority_.input_epoch;
  response["reason"] = reason == "initial" ? "initial" : "user_selected";
  emit_(response);
  SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
  return true;
}

bool PeerSession::Tick(int64_t now_unix_ms) {
  common::TransportTime now = CurrentTransportTime();
  now.unix_ms = now_unix_ms;
  return transport_core_.Tick(now);
}

void PeerSession::TouchActivity() {
  transport_core_.RecordActivity(CommonIdentity(), CurrentTransportTime());
}

void PeerSession::CheckMediaProgress() {
  if (closed_ || !peer_ || !source_ ||
      peer_->peer_connection_state() !=
          webrtc::PeerConnectionInterface::PeerConnectionState::kConnected) {
    return;
  }
  const int64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now().time_since_epoch())
                             .count();
  if (media_stats_in_flight_ &&
      now_ms - media_stats_requested_at_ms_ < 3'000) {
    return;
  }
  if (!media_stats_in_flight_ && media_stats_requested_at_ms_ > 0 &&
      now_ms - media_stats_requested_at_ms_ < 1'000) {
    return;
  }
  media_stats_in_flight_ = true;
  media_stats_requested_at_ms_ = now_ms;
  const uint64_t generation = ++media_stats_generation_;
  auto callback = webrtc::make_ref_counted<PeerMediaStatsObserver>(
      weak_from_this(), generation);
  peer_->GetStats(callback.get());
}

void PeerSession::HandleMediaStats(uint64_t generation,
                                   bool has_outbound_video,
                                   uint64_t outbound_bytes) {
  if (signaling_thread_ && !signaling_thread_->IsCurrent()) {
    std::weak_ptr<PeerSession> weak = weak_from_this();
    signaling_thread_->PostTask(
        [weak, generation, has_outbound_video, outbound_bytes] {
          if (auto session = weak.lock()) {
            session->HandleMediaStats(generation, has_outbound_video,
                                      outbound_bytes);
          }
        });
    return;
  }
  if (closed_ || generation != media_stats_generation_) return;
  media_stats_in_flight_ = false;
  if (!has_outbound_video || !source_) return;
  const uint64_t source_frames = source_->captured_frames();
  const bool media_started =
      transport_core_.diagnostics().last_outbound_video_bytes > 0;
  if (!transport_core_.RecordMediaProgress(
          CallbackStamp(), source_frames, outbound_bytes,
          CurrentTransportTime()) &&
      transport_core_.terminal_reason() ==
          common::TransportTerminalReason::kMediaStalled) {
    DisqualifyHardwareEncoderForProcess();
  } else if (outbound_bytes > 0 && !media_started) {
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
  }
}

void PeerSession::ResetMediaProgressWatchdog() {
  ++media_stats_generation_;
  media_stats_in_flight_ = false;
  media_stats_requested_at_ms_ = 0;
  if (transport_core_.started() && !transport_core_.terminal()) {
    transport_core_.ResetMediaProgress(CallbackStamp(),
                                       CurrentTransportTime());
  }
}

void PeerSession::Close(const char* terminal_reason, bool emit_terminal) {
  if (closed_) return;
  pending_terminal_reason_ = terminal_reason ? terminal_reason : "worker_failed";
  emit_transport_terminal_ = emit_terminal;
  common::TransportTerminalReason reason =
      common::TransportTerminalReason::kAdapterFailure;
  if (pending_terminal_reason_ == "stopped_by_controller") {
    reason = common::TransportTerminalReason::kStopped;
  } else if (pending_terminal_reason_ == "peer_failed") {
    reason = common::TransportTerminalReason::kPeerFailed;
  } else if (pending_terminal_reason_ == "protocol_error") {
    reason = common::TransportTerminalReason::kProtocolViolation;
  } else if (pending_terminal_reason_ == "idle_timeout") {
    reason = common::TransportTerminalReason::kIdleTimeout;
  }
  if (transport_core_.started() && !transport_core_.terminal()) {
    transport_core_.Stop(reason);
    return;
  }
  if (closed_.exchange(true)) return;
  ReleaseInput();
  for (const auto channel : {common::DataChannelKind::kControl,
                             common::DataChannelKind::kKeyboard,
                             common::DataChannelKind::kPointer}) {
    CloseDataChannel(channel);
  }
  CloseTransport();
  if (emit_terminal) emit_(TerminalEnvelope(authority_, pending_terminal_reason_.c_str()));
  std::fill(authority_.capability.begin(), authority_.capability.end(), '\0');
}

bool PeerSession::EmitLocalIceCandidate(
    const common::IceCandidate& candidate) {
  if (closed_) return false;
  Json::Value message = BaseEnvelope(kIceType, authority_);
  message["candidate"] = candidate.candidate;
  message["mid"] = candidate.media_id;
  emit_(message);
  return true;
}

bool PeerSession::ApplyQuality(const common::QualitySelection& selection) {
  const MfH264RuntimeDiagnostics actual = GetMfH264RuntimeDiagnostics();
  return actual.preset == selection.preset_id &&
         actual.width == static_cast<int>(selection.encoded_pixels.width) &&
         actual.height == static_cast<int>(selection.encoded_pixels.height) &&
         actual.fps == static_cast<int>(selection.frame_rate) &&
         actual.bitrate_bps == selection.bitrate_bps;
}

void PeerSession::ReleaseControlAuthority(
    const common::RouteAuthorityIdentity& identity,
    std::uint64_t input_epoch) noexcept {
  if (identity.request_id == authority_.request_id &&
      identity.session_id == authority_.session_id &&
      input_epoch == static_cast<std::uint64_t>(authority_.input_epoch)) {
    ReleaseInput();
  }
}

void PeerSession::CloseDataChannel(
    common::DataChannelKind channel_kind) noexcept {
  const std::string label = ChannelLabel(channel_kind);
  const auto channel = channels_.find(label);
  if (channel == channels_.end()) return;
  const auto observer = channel_observers_.find(label);
  if (observer != channel_observers_.end()) {
    channel->second->UnregisterObserver();
    channel_observers_.erase(observer);
  }
  channel->second->Close();
  channels_.erase(channel);
}

void PeerSession::CloseTransport() noexcept {
  closed_ = true;
  ++media_stats_generation_;
  media_stats_in_flight_ = false;
  media_stats_requested_at_ms_ = 0;
  // Detach the source before closing the peer. On older Windows hardware
  // encoders this prevents queued full-resolution frames from overlapping a
  // rapid replacement session and exceeding the worker's bounded memory job.
  if (peer_) {
    for (const auto& sender : peer_->GetSenders()) {
      if (sender->track() && sender->track()->kind() ==
                                 webrtc::MediaStreamTrackInterface::kVideoKind) {
        sender->SetTrack(nullptr);
      }
    }
  }
  track_ = nullptr;
  source_.reset();
  if (peer_) peer_->Close();
  peer_ = nullptr;
  answer_observer_ = nullptr;
  setting_remote_description_ = false;
}

void PeerSession::PublishDiagnostics(
    const common::TransportDiagnostics& diagnostics) noexcept {
  transport_diagnostics_ = diagnostics;
}

void PeerSession::OnTerminal(
    common::TransportTerminalReason reason) noexcept {
  const char* wire_reason = pending_terminal_reason_.empty()
                                ? "peer_failed"
                                : pending_terminal_reason_.c_str();
  if (pending_terminal_reason_.empty()) {
    switch (reason) {
      case common::TransportTerminalReason::kStopped:
        wire_reason = "stopped_by_controller";
        break;
      case common::TransportTerminalReason::kRouteExpired:
        wire_reason = "route_expired";
        break;
      case common::TransportTerminalReason::kLeaseExpired:
        wire_reason = "lease_expired";
        break;
      case common::TransportTerminalReason::kIdleTimeout:
        wire_reason = "idle_timeout";
        break;
      case common::TransportTerminalReason::kProtocolViolation:
      case common::TransportTerminalReason::kCandidateOverflow:
        wire_reason = "protocol_error";
        break;
      case common::TransportTerminalReason::kNone:
      case common::TransportTerminalReason::kMediaStalled:
      case common::TransportTerminalReason::kPeerFailed:
      case common::TransportTerminalReason::kChannelFailed:
      case common::TransportTerminalReason::kAdapterFailure:
        wire_reason = "peer_failed";
        break;
    }
  }
  if (emit_transport_terminal_) emit_(TerminalEnvelope(authority_, wire_reason));
  std::fill(authority_.capability.begin(), authority_.capability.end(), '\0');
}

bool PeerSession::IsRelayed() const noexcept {
  return transport_core_.path() == common::TransportPath::kRelay;
}

bool PeerSession::controlling() const {
  return !closed_ && authority_.mode == kControlMode &&
         authority_.input_epoch > 0;
}

bool PeerSession::ReleaseInputForPlatformTransition() {
  return ReleaseInput();
}

bool PeerSession::protected_content_masked() const {
  return source_ && source_->protected_content_masked();
}

bool PeerSession::RefreshDisplays(std::vector<DisplayInfo> displays) {
  if (closed_) return false;
  // A transient `displays.empty()` is the same observation the WorkerRuntime
  // already debounces through AdvanceEmptyTopologyConsecutive(); treating it
  // as a hard fail here would short-circuit that grace window and surface a
  // premature `media_unavailable` to the caller.
  if (displays.empty()) return true;
  if (SameTopology(displays_, displays)) return true;
  const std::string previous_id =
      source_ ? std::string(source_->display_id())
              : displays_[selected_display_].id;
  std::vector<DisplaySelectionCandidate> candidates;
  candidates.reserve(displays.size());
  for (const auto& display : displays) {
    candidates.push_back({display.id, display.primary, display.available,
                          display.imcodes_virtual});
  }
  if (DisplaySelectionRequiresExplicitChoice(candidates, previous_id)) {
    // Never silently retarget pointer/keyboard input when the selected monitor
    // disappears. Keep the old track only as a bounded visual handoff until
    // the controller explicitly chooses one of the new opaque display ids.
    ReleaseInput();
    layout_acknowledged_ = false;
    displays_ = std::move(displays);
    selected_display_ = 0;
    selection_required_ = true;
    ++layout_revision_;
    if (!RefreshCommonTopology()) return false;
    last_sequence_by_channel_.clear();
    SendTopology();
    SendQuality();
    SendStatus("switching_display", false);
    return true;
  }
  const size_t selected_index =
      SelectDisplayAfterTopologyChange(candidates, previous_id);
  if (selected_index >= displays.size()) return false;
  auto selected = displays.begin() + selected_index;

  ReleaseInput();
  layout_acknowledged_ = false;
  const bool replace_source =
      !source_ || source_->source_identity() != DisplaySourceKey(*selected);
  if (replace_source) {
    webrtc::scoped_refptr<webrtc::RtpSenderInterface> video_sender;
    for (const auto& sender : peer_->GetSenders()) {
      if (sender->track() && sender->track()->kind() ==
                                 webrtc::MediaStreamTrackInterface::kVideoKind) {
        video_sender = sender;
        break;
      }
    }
    // A topology transition is allowed to be noisy: indirect-display drivers
    // commonly publish the new output before DXGI duplication can open it.
    // Keep the proven live track attached until the replacement is ready.
    // Dropping it first turns a transient display change into a terminal
    // media_unavailable for the whole remote-control session.
    if (!video_sender) return true;
    auto next_source = capture_adapter_->Acquire(ToCommonDisplayTopology(
        *selected, CommonIdentity().daemon_generation));
    if (!next_source) return true;
    if (!next_source->Start()) return true;
    webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface>
        next_native_source(next_source->source());
    if (!next_native_source) return true;
    auto next_track = factory_->CreateVideoTrack(next_native_source,
                                                 "imcodes-remote-desktop");
    if (!next_track) return true;
    const bool replaced = video_sender->SetTrack(next_track.get()) &&
                          video_sender->GenerateKeyFrame({}).ok();
    if (!replaced) {
      return true;
    }
    auto previous_source = std::move(source_);
    source_ = std::move(next_source);
    track_ = std::move(next_track);
    previous_source.reset();
    ResetMediaProgressWatchdog();
  }
  selected_display_ = static_cast<size_t>(selected - displays.begin());
  selection_required_ = false;
  displays_ = std::move(displays);
  ++layout_revision_;
  if (!RefreshCommonTopology()) return false;
  last_sequence_by_channel_.clear();
  SendTopology();
  SendQuality();
  SendStatus("switching_display", false);
  return true;
}

void PeerSession::OnDataChannel(
    webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) {
  if (signaling_thread_ && !signaling_thread_->IsCurrent()) {
    std::weak_ptr<PeerSession> weak = weak_from_this();
    signaling_thread_->PostTask([weak, channel = std::move(channel)]() mutable {
      if (auto session = weak.lock())
        session->OnDataChannel(std::move(channel));
    });
    return;
  }
  if (closed_ || !channel) return;
  const std::string label = channel->label();
  bool valid = false;
  if (label == kControlChannel)
    valid = channel->ordered() && !channel->maxRetransmitsOpt();
  else if (label == kKeyboardChannel)
    valid = channel->ordered() && !channel->maxRetransmitsOpt();
  else if (label == kPointerChannel)
    valid = !channel->ordered() && channel->maxRetransmitsOpt() == 0;
  if (!valid || channels_.contains(label)) {
    channel->Close();
    return;
  }
  auto observer = std::make_unique<PeerDataObserver>(weak_from_this(), label);
  channel->RegisterObserver(observer.get());
  channels_[label] = channel;
  channel_observers_[label] = std::move(observer);
  transport_core_.OnDataChannelState(
      CallbackStamp(), CommonChannelKind(label),
      CommonDataChannelState(channel->state()));
}

void PeerSession::OnIceCandidate(const webrtc::IceCandidate* candidate) {
  if (closed_ || !candidate) return;
  std::string value;
  if (!candidate->ToString(&value) || value.size() > 16 * 1024) return;
  std::string mid = candidate->sdp_mid();
  if (signaling_thread_ && !signaling_thread_->IsCurrent()) {
    std::weak_ptr<PeerSession> weak = weak_from_this();
    signaling_thread_->PostTask(
        [weak, mid = std::move(mid), value = std::move(value)]() mutable {
          if (auto session = weak.lock())
            session->EmitIceCandidate(std::move(mid), std::move(value));
        });
    return;
  }
  EmitIceCandidate(std::move(mid), std::move(value));
}

void PeerSession::EmitIceCandidate(std::string mid, std::string candidate) {
  if (closed_) return;
  transport_core_.OnLocalIceCandidate(
      CallbackStamp(), common::IceCandidate{std::move(mid),
                                             std::move(candidate)});
}

void PeerSession::OnConnectionChange(
    webrtc::PeerConnectionInterface::PeerConnectionState state) {
  if (signaling_thread_ && !signaling_thread_->IsCurrent()) {
    std::weak_ptr<PeerSession> weak = weak_from_this();
    signaling_thread_->PostTask([weak, state] {
      if (auto session = weak.lock()) session->OnConnectionChange(state);
    });
    return;
  }
  if (!transport_core_.OnPeerConnectionState(
          CallbackStamp(), CommonPeerConnectionState(state),
          CurrentTransportTime())) {
    return;
  }
  if (state == webrtc::PeerConnectionInterface::PeerConnectionState::kConnected) {
    // Start the bounded wait for the input channels here: a viewer that never
    // opens all three must still end up with a picture.
    if (video_gate_deadline_ms_ == 0) {
      video_gate_deadline_ms_ =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now().time_since_epoch())
              .count() + kVideoGateTimeoutMs;
    }
    ActivateVideoIfReady();
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
  } else if (state ==
                 webrtc::PeerConnectionInterface::PeerConnectionState::kNew ||
             state == webrtc::PeerConnectionInterface::PeerConnectionState::kConnecting ||
             state == webrtc::PeerConnectionInterface::PeerConnectionState::kDisconnected) {
    SendStatus("connecting", false);
  }
}

void PeerSession::OnIceSelectedCandidatePairChanged(
    const webrtc::CandidatePairChangeEvent& event) {
  const bool relayed =
      event.selected_candidate_pair.local_candidate().is_relay() ||
      event.selected_candidate_pair.remote_candidate().is_relay();
  if (signaling_thread_ && !signaling_thread_->IsCurrent()) {
    std::weak_ptr<PeerSession> weak = weak_from_this();
    signaling_thread_->PostTask([weak, relayed] {
      if (auto session = weak.lock()) {
        if (!session->transport_core_.OnTransportPath(
                session->CallbackStamp(),
                relayed ? common::TransportPath::kRelay
                        : common::TransportPath::kDirect)) {
          return;
        }
        session->ApplyTransportBitratePolicy(!relayed);
        session->SendStatus(relayed ? "relayed" : "direct",
                            session->InputReady());
      }
    });
    return;
  }
  if (!transport_core_.OnTransportPath(
          CallbackStamp(), relayed ? common::TransportPath::kRelay
                                   : common::TransportPath::kDirect)) {
    return;
  }
  ApplyTransportBitratePolicy(!relayed);
  SendStatus(relayed ? "relayed" : "direct", InputReady());
}

void PeerSession::HandleChannelState(const std::string& label) {
  if (signaling_thread_ && !signaling_thread_->IsCurrent()) {
    std::weak_ptr<PeerSession> weak = weak_from_this();
    signaling_thread_->PostTask([weak, label] {
      if (auto session = weak.lock()) session->HandleChannelState(label);
    });
    return;
  }
  const auto found = channels_.find(label);
  if (found == channels_.end()) return;
  if (!transport_core_.OnDataChannelState(
          CallbackStamp(), CommonChannelKind(label),
          CommonDataChannelState(found->second->state()))) {
    return;
  }
  if (found->second->state() == webrtc::DataChannelInterface::kOpen &&
      label == kControlChannel) {
    SendTopology();
    SendQuality();
  }
  if (found->second->state() == webrtc::DataChannelInterface::kOpen &&
      ChannelsReady()) {
    // The channels are up, so the pipe is free for the picture now.
    ActivateVideoIfReady();
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
  }
}

void PeerSession::HandleData(const std::string& label,
                             const webrtc::DataBuffer& buffer) {
  if (closed_ || buffer.binary || buffer.size() == 0 ||
      buffer.size() > kMaxDataMessageBytes) {
    return;
  }
  const std::string text(reinterpret_cast<const char*>(buffer.data.data()),
                         buffer.data.size());
  if (signaling_thread_ && !signaling_thread_->IsCurrent()) {
    std::weak_ptr<PeerSession> weak = weak_from_this();
    signaling_thread_->PostTask([weak, label, text] {
      if (auto session = weak.lock())
        session->HandleDataOnSignaling(label, text);
    });
    return;
  }
  HandleDataOnSignaling(label, text);
}

void PeerSession::HandleDataOnSignaling(const std::string& label,
                                        const std::string& text) {
  if (closed_) return;
  Json::Value root;
  if (!ParseJson(text, &root) || !root["type"].isString()) return;
  const std::string type = root["type"].asString();
  if (label == kControlChannel && type == kControlType)
    HandleControl(label, root);
  else if (label == kControlChannel && type == kPointerType)
    HandlePointer(label, root);
  else if (label == kControlChannel && type == kReleaseAllType) {
    uint64_t sequence = 0;
    if (ExactKeys(root, {"type", "protocolVersion", "sessionId", "sequence",
                          "layoutRevision", "inputEpoch"}) &&
        ValidateInputBase(root, label, true, &sequence)) {
      if (ReleaseInput()) {
        last_sequence_by_channel_[label] = sequence;
        TouchActivity();
        SendInputAck(sequence);
      }
    }
  } else if (label == kKeyboardChannel && type == kKeyboardType)
    HandleKeyboard(label, root);
  else if (label == kPointerChannel && type == kPointerType)
    HandlePointer(label, root);
}

bool PeerSession::Matches(const Authority& other) const {
  return other.request_id == authority_.request_id &&
         other.session_id == authority_.session_id &&
         other.capability == authority_.capability;
}

bool PeerSession::ValidateInputBase(const Json::Value& root,
                                    const std::string& channel,
                                    bool require_control,
                                    uint64_t* sequence) {
  if (!root["protocolVersion"].isInt() ||
      root["protocolVersion"].asInt() != kProtocolVersion ||
      !root["sessionId"].isString() ||
      root["sessionId"].asString() != authority_.session_id ||
      !root["sequence"].isUInt64() ||
      !root["layoutRevision"].isInt() ||
      root["layoutRevision"].asInt() != layout_revision_ ||
      !root["inputEpoch"].isInt() || root["inputEpoch"].asInt() < 0 ||
      root["inputEpoch"].asInt() != authority_.input_epoch ||
      (require_control && !InputReady())) {
    return false;
  }
  *sequence = root["sequence"].asUInt64();
  const auto previous = last_sequence_by_channel_.find(channel);
  return InputSequenceIsFresh(previous != last_sequence_by_channel_.end(),
                              previous == last_sequence_by_channel_.end()
                                  ? 0
                                  : previous->second,
                              *sequence);
}

bool PeerSession::ConsumeRate(const std::string& bucket, int maximum,
                              std::chrono::seconds window) {
  const auto now = std::chrono::steady_clock::now();
  RateWindow& rate = rate_windows_[bucket];
  if (rate.start.time_since_epoch().count() == 0 || now - rate.start >= window) {
    rate.start = now;
    rate.count = 0;
  }
  return ++rate.count <= maximum;
}

void PeerSession::HandleControl(const std::string& channel,
                                const Json::Value& root) {
  if (!ExactKeys(root, {"type", "protocolVersion", "sessionId", "sequence",
                        "layoutRevision", "inputEpoch", "kind"},
                 {"displayId", "width", "height", "dpiScalePercent",
                  "requestId",
                  "frameWidth", "frameHeight", "acknowledgedSequence"}) ||
      !root["kind"].isString()) {
    return;
  }
  const std::string kind = root["kind"].asString();
  uint64_t sequence = 0;
  const bool require_control = kind == "set_display_mode" ||
      kind == "set_display_scale" || kind == "copy_selection" ||
      kind == "unlock";
  // A command that needs control but arrives without it is the one refusal the
  // controller cannot see any other way: the picture keeps updating and the
  // click simply vanishes. Answer it, but only for this session's own frames.
  if (require_control && !InputReady() && root["sessionId"].isString() &&
      root["sessionId"].asString() == authority_.session_id) {
    SendControlRejected(kind.c_str(), kRejectNotPermitted);
    return;
  }
  if (!ValidateInputBase(root, channel, require_control,
                         &sequence)) {
    return;
  }
  bool acknowledge_layout = false;
  if (kind == "hello" || kind == "keepalive") {
    if (root.isMember("displayId") || root.isMember("width") ||
        root.isMember("height") || root.isMember("frameWidth") ||
        root.isMember("frameHeight") ||
        root.isMember("dpiScalePercent") || root.isMember("requestId") ||
        root.isMember("acknowledgedSequence"))
      return;
  } else if (kind == "frame_presented") {
    const common::DisplayTopology* presented =
        common_topology_ && selected_display_ < displays_.size()
            ? common_topology_->FindDisplay(displays_[selected_display_].id)
            : nullptr;
    if (selection_required_ || selected_display_ >= displays_.size() ||
        presented == nullptr ||
        !root["displayId"].isString() || !root["frameWidth"].isInt() ||
        !root["frameHeight"].isInt() || root.isMember("width") ||
        root.isMember("height") || root.isMember("dpiScalePercent") ||
        root.isMember("requestId") || root.isMember("acknowledgedSequence") ||
        root["displayId"].asString() != displays_[selected_display_].id ||
        !PresentedFrameMatchesDisplay(
            root["frameWidth"].asInt(), root["frameHeight"].asInt(),
            static_cast<int>(presented->encoded_pixels.width),
            static_cast<int>(presented->encoded_pixels.height))) {
      return;
    }
    acknowledge_layout = true;
  } else if (kind == "select_display") {
    if (!root["displayId"].isString() ||
        root.isMember("width") || root.isMember("height") ||
        root.isMember("dpiScalePercent") || root.isMember("requestId") ||
        root.isMember("frameWidth") || root.isMember("frameHeight") ||
        root.isMember("acknowledgedSequence")) {
      return;
    }
    const std::string display_id = root["displayId"].asString();
    if (!ConsumeRate("monitor", 30, std::chrono::minutes(1))) {
      SendControlRejected(kind.c_str(), kRejectRateLimited, display_id);
      return;
    }
    // The layout operations report their own specific refusal reason.
    if (!SelectDisplay(display_id)) return;
  } else if (kind == "set_display_mode") {
    if (!root["displayId"].isString() || !root["width"].isInt() ||
        !root["height"].isInt() || root.isMember("frameWidth") ||
        root.isMember("frameHeight") || root.isMember("dpiScalePercent") ||
        root.isMember("requestId") ||
        root.isMember("acknowledgedSequence")) {
      return;
    }
    const std::string display_id = root["displayId"].asString();
    if (!ConsumeRate("monitor", 30, std::chrono::minutes(1))) {
      SendControlRejected(kind.c_str(), kRejectRateLimited, display_id);
      return;
    }
    if (!SetDisplayMode(display_id, root["width"].asInt(),
                        root["height"].asInt())) {
      return;
    }
  } else if (kind == "set_display_scale") {
    if (!root["displayId"].isString() || !root["dpiScalePercent"].isInt() ||
        root.isMember("width") || root.isMember("height") ||
        root.isMember("requestId") || root.isMember("frameWidth") ||
        root.isMember("frameHeight") ||
        root.isMember("acknowledgedSequence")) {
      return;
    }
    const std::string display_id = root["displayId"].asString();
    if (!ConsumeRate("monitor", 30, std::chrono::minutes(1))) {
      SendControlRejected(kind.c_str(), kRejectRateLimited, display_id);
      return;
    }
    if (!SetDisplayScale(display_id, root["dpiScalePercent"].asInt())) return;
  } else if (kind == "unlock") {
    if (root.isMember("displayId") || root.isMember("width") ||
        root.isMember("height") || root.isMember("dpiScalePercent") ||
        root.isMember("requestId") || root.isMember("frameWidth") ||
        root.isMember("frameHeight") ||
        root.isMember("acknowledgedSequence")) {
      return;
    }
    // Bounded like every other privileged action, and answered either way: a
    // silent unlock button is exactly the "nothing happened" this session
    // already suffered from once.
    if (!ConsumeRate("unlock", 10, std::chrono::minutes(1))) {
      SendControlRejected(kind.c_str(), kRejectRateLimited);
      return;
    }
    if (!request_unlock_ || !request_unlock_()) {
      SendControlRejected(kind.c_str(), kRejectUnlockUnavailable);
      return;
    }
  } else if (kind == "copy_selection") {
    if (!root["requestId"].isString() ||
        !IsSafeId(root["requestId"].asString()) ||
        root.isMember("displayId") || root.isMember("width") ||
        root.isMember("height") || root.isMember("dpiScalePercent") ||
        root.isMember("frameWidth") || root.isMember("frameHeight") ||
        root.isMember("acknowledgedSequence") ||
        !ConsumeRate("clipboard", 30, std::chrono::minutes(1)) ||
        !CopySelection(root["requestId"].asString())) {
      return;
    }
  } else {
    return;
  }
  last_sequence_by_channel_[channel] = sequence;
  TouchActivity();
  if (acknowledge_layout) {
    layout_acknowledged_ = true;
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
  }
}

void PeerSession::HandlePointer(const std::string& channel,
                                const Json::Value& root) {
  if (!ExactKeys(root, {"type", "protocolVersion", "sessionId", "sequence",
                        "layoutRevision", "inputEpoch", "kind"},
                 {"x", "y", "button", "deltaX", "deltaY"}) ||
      !root["kind"].isString() ||
      !ConsumeRate("pointer", 240, std::chrono::seconds(1))) {
    return;
  }
  uint64_t sequence = 0;
  // Replay protection is per channel, and deliberately so. The pointer channel
  // is unordered and may drop what it likes; the control channel is reliable
  // and ordered. A single sequence bar shared between them means every clicked
  // button and every reliable position sample raises it above the motion
  // already in flight on the other channel, which is then discarded on
  // arrival — the remote cursor stops following and only moves when a click
  // carries a position with it. ValidateInputBase already requires a strict
  // increase within each channel, which is what stale-packet rejection needs.
  if (!ValidateInputBase(root, channel, true, &sequence) ||
      authority_.input_epoch <= 0) return;
  const std::string kind = root["kind"].asString();
  const common::InputStamp stamp{
      InputControllerId(channel),
      static_cast<common::InputEpoch>(authority_.input_epoch),
      static_cast<common::InputSequence>(sequence),
      static_cast<common::TopologyRevision>(layout_revision_),
  };
  common::InputStamp pointer_stamp = stamp;
  pointer_stamp.controller_id += ":position";
  bool accepted = false;
  if (kind == "move" && root["x"].isNumeric() && root["y"].isNumeric() &&
      !root.isMember("button") && !root.isMember("deltaX") &&
      !root.isMember("deltaY") && root["x"].asDouble() >= 0.0 &&
      root["x"].asDouble() <= 1.0 && root["y"].asDouble() >= 0.0 &&
      root["y"].asDouble() <= 1.0) {
    accepted = InputApplied(input_->ApplyPointerStamped(
        pointer_stamp, static_cast<common::TopologyRevision>(layout_revision_),
        displays_[selected_display_], root["x"].asDouble(),
        root["y"].asDouble()));
  } else if ((kind == "button_down" || kind == "button_up" ||
              kind == "button_click") &&
             root["button"].isString() && !root.isMember("deltaX") &&
             !root.isMember("deltaY") &&
             (!root.isMember("x") || (root["x"].isNumeric() &&
              root["x"].asDouble() >= 0.0 && root["x"].asDouble() <= 1.0)) &&
             (!root.isMember("y") || (root["y"].isNumeric() &&
              root["y"].asDouble() >= 0.0 && root["y"].asDouble() <= 1.0))) {
    if (root.isMember("x") && root.isMember("y") &&
        !InputApplied(input_->ApplyPointerStamped(
            pointer_stamp,
            static_cast<common::TopologyRevision>(layout_revision_),
            displays_[selected_display_], root["x"].asDouble(),
            root["y"].asDouble()))) {
      return;
    }
    if (kind == "button_down") {
      accepted = InputApplied(input_->ApplyButtonStamped(
          stamp, static_cast<common::TopologyRevision>(layout_revision_),
          root["button"].asString(), true));
    } else if (kind == "button_up") {
      accepted = InputApplied(input_->ApplyButtonStamped(
          stamp, static_cast<common::TopologyRevision>(layout_revision_),
          root["button"].asString(), false));
    } else {
      accepted = input_->Click(root["button"].asString());
    }
  } else if (kind == "wheel" && root["deltaX"].isNumeric() &&
             root["deltaY"].isNumeric() && !root.isMember("button") &&
             root["deltaX"].asDouble() >= -10000.0 &&
             root["deltaX"].asDouble() <= 10000.0 &&
             root["deltaY"].asDouble() >= -10000.0 &&
             root["deltaY"].asDouble() <= 10000.0 &&
             (!root.isMember("x") || (root["x"].isNumeric() &&
              root["x"].asDouble() >= 0.0 && root["x"].asDouble() <= 1.0)) &&
             (!root.isMember("y") || (root["y"].isNumeric() &&
              root["y"].asDouble() >= 0.0 && root["y"].asDouble() <= 1.0))) {
    if (root.isMember("x") && root.isMember("y") &&
        !InputApplied(input_->ApplyPointerStamped(
            pointer_stamp,
            static_cast<common::TopologyRevision>(layout_revision_),
            displays_[selected_display_], root["x"].asDouble(),
            root["y"].asDouble()))) {
      return;
    }
    accepted = InputApplied(input_->ApplyWheelStamped(
        stamp, static_cast<common::TopologyRevision>(layout_revision_),
        root["deltaX"].asDouble(), root["deltaY"].asDouble()));
  }
  if (accepted) {
    last_sequence_by_channel_[channel] = sequence;
    TouchActivity();
    if (channel == kControlChannel &&
        (kind == "button_down" || kind == "button_up" ||
         kind == "button_click")) {
      SendInputAck(sequence);
    }
  }
}

void PeerSession::HandleKeyboard(const std::string& channel,
                                 const Json::Value& root) {
  if (!ExactKeys(root, {"type", "protocolVersion", "sessionId", "sequence",
                        "layoutRevision", "inputEpoch", "kind"},
                 {"code", "key", "repeat", "text"}) ||
      !root["kind"].isString() ||
      !ConsumeRate("keyboard", 120, std::chrono::seconds(1))) {
    return;
  }
  uint64_t sequence = 0;
  if (!ValidateInputBase(root, channel, true, &sequence) ||
      authority_.input_epoch <= 0) return;
  const std::string kind = root["kind"].asString();
  const common::InputStamp stamp{
      InputControllerId(channel),
      static_cast<common::InputEpoch>(authority_.input_epoch),
      static_cast<common::InputSequence>(sequence),
      static_cast<common::TopologyRevision>(layout_revision_),
  };
  bool accepted = false;
  if ((kind == "key_down" || kind == "key_up") &&
      root["code"].isString() && root["key"].isString() &&
      root["repeat"].isBool() && !root.isMember("text") &&
      root["code"].asString().size() <= 64 &&
      root["key"].asString().size() <= 64) {
    const std::string code = root["code"].asString();
    const bool secure_attention = code == "Delete" &&
        (pressed_codes_.contains("ControlLeft") ||
         pressed_codes_.contains("ControlRight")) &&
        (pressed_codes_.contains("AltLeft") ||
         pressed_codes_.contains("AltRight"));
    if (secure_attention) return;
    if (kind == "key_down") {
      accepted = InputApplied(input_->ApplyKeyStamped(
          stamp, static_cast<common::TopologyRevision>(layout_revision_), code,
          true, root["repeat"].asBool()));
      if (accepted) pressed_codes_.insert(code);
    } else {
      accepted = InputApplied(input_->ApplyKeyStamped(
          stamp, static_cast<common::TopologyRevision>(layout_revision_), code,
          false));
      pressed_codes_.erase(code);
    }
  } else if (kind == "text" && root["text"].isString()) {
    if (root.isMember("code") || root.isMember("key") ||
        root.isMember("repeat") || root["text"].asString().size() > 4096) {
      return;
    }
    accepted = InputApplied(input_->ApplyTextStamped(
        stamp, static_cast<common::TopologyRevision>(layout_revision_),
        root["text"].asString()));
  }
  if (accepted) {
    last_sequence_by_channel_[channel] = sequence;
    TouchActivity();
    SendInputAck(sequence);
  }
}

void PeerSession::SendTopology() {
  Json::Value root(Json::objectValue);
  root["type"] = kTopologyType;
  root["protocolVersion"] = kProtocolVersion;
  root["sessionId"] = authority_.session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["layoutRevision"] = layout_revision_;
  Json::Value displays(Json::arrayValue);
  for (const DisplayInfo& display : displays_) {
    const common::DisplayTopology* topology =
        common_topology_ ? common_topology_->FindDisplay(display.id) : nullptr;
    if (topology == nullptr) continue;
    Json::Value value(Json::objectValue);
    value["id"] = display.id;
    value["label"] = display.label;
    value["primary"] = display.primary;
    value["available"] = display.available;
    value["width"] = topology->encoded_pixels.width;
    value["height"] = topology->encoded_pixels.height;
    value["dpiScale"] = topology->scale;
    value["rotation"] = static_cast<unsigned int>(topology->rotation);
    if (!display.modes.empty()) {
      // The resolutions this driver actually offers. Without them the browser
      // can only guess at a fixed set, and every guess the driver lacks is a
      // menu entry that does nothing.
      Json::Value modes(Json::arrayValue);
      for (const DisplayMode& mode : display.modes) {
        Json::Value entry(Json::objectValue);
        entry["width"] = mode.width;
        entry["height"] = mode.height;
        modes.append(entry);
      }
      value["modes"] = modes;
    }
    displays.append(value);
  }
  root["displays"] = displays;
  if (!selection_required_)
    root["selectedDisplayId"] = displays_[selected_display_].id;
  SendControl(root);
}

void PeerSession::SendQuality() {
  const MfH264RuntimeDiagnostics diagnostics =
      GetMfH264RuntimeDiagnostics();
  if (diagnostics.initialized && source_) {
    transport_core_.UpdateQualityTarget(
        CallbackStamp(),
        common::QualityTarget{
            diagnostics.bitrate_bps,
            source_->encoded_pixels(),
        });
    if (closed_) return;
  }
  Json::Value root(Json::objectValue);
  root["type"] = kQualityType;
  root["protocolVersion"] = kProtocolVersion;
  root["sessionId"] = authority_.session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["preset"] = diagnostics.preset;
  root["encoderClass"] = diagnostics.hardware ? "hardware" : "software";
  root["width"] = diagnostics.width;
  root["height"] = diagnostics.height;
  root["fps"] = diagnostics.fps;
  root["bitrateBps"] = diagnostics.bitrate_bps;
  root["droppedFrames"] = Json::UInt64(source_ ? source_->dropped_frames() : 0);
  root["rttMs"] = 0;
  SendControl(root);
}

void PeerSession::SendInputAck(uint64_t acknowledged_sequence) {
  Json::Value root(Json::objectValue);
  root["type"] = kControlType;
  root["protocolVersion"] = kProtocolVersion;
  root["sessionId"] = authority_.session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["layoutRevision"] = layout_revision_;
  root["inputEpoch"] = authority_.input_epoch;
  root["kind"] = "input_ack";
  root["acknowledgedSequence"] = Json::UInt64(acknowledged_sequence);
  SendControl(root);
}

bool PeerSession::CopySelection(const std::string& request_id) {
  std::string text;
  if (!clipboard_adapter_ || !clipboard_adapter_->CopySelection(&text)) {
    return SendClipboard(request_id, std::nullopt);
  }
  const std::u16string decoded = Utf8ToUtf16(text);
  return SendClipboard(request_id,
                       decoded.empty()
                           ? std::optional<std::u16string>{}
                           : std::optional<std::u16string>{decoded});
}

bool PeerSession::SendClipboard(
    const std::string& request_id,
    const std::optional<std::u16string>& text) {
  std::string encoded = text ? Utf16ToUtf8(*text) : std::string{};
  const bool available = !encoded.empty() &&
      encoded.size() <= kMaxClipboardTextBytes;
  Json::Value root(Json::objectValue);
  root["type"] = kClipboardType;
  root["protocolVersion"] = kProtocolVersion;
  root["sessionId"] = authority_.session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["requestId"] = request_id;
  root["available"] = available;
  if (available) root["text"] = std::move(encoded);
  return SendControl(root);
}

void PeerSession::SendStatus(const char* state, bool input_enabled) {
  reported_input_ready_ = input_enabled;
  Json::Value root = BaseEnvelope(kStatusType, authority_);
  root["mode"] = authority_.mode;
  root["inputEpoch"] = authority_.input_epoch;
  const common::TransportDiagnostics diagnostics =
      transport_core_.diagnostics();
  const bool peer_connected =
      diagnostics.peer_state == common::PeerConnectionState::kConnected;
  const bool route_state = std::strcmp(state, "direct") == 0 ||
                           std::strcmp(state, "relayed") == 0;
  // A selected candidate pair is transport diagnostics, not PeerConnection
  // readiness. Until libwebrtc reports kConnected, keep the lifecycle state
  // truthful so the Server cannot clear its negotiation timeout early.
  root["state"] = route_state && !peer_connected ? "connecting" : state;
  if (diagnostics.path != common::TransportPath::kUnknown) {
    root["route"] = diagnostics.path == common::TransportPath::kRelay
                        ? "relay"
                        : "direct";
  }
  root["peerConnected"] = peer_connected;
  root["dataChannelsReady"] = diagnostics.required_channels_ready;
  root["mediaStarted"] = diagnostics.last_outbound_video_bytes > 0;
  root["firstFramePresented"] = layout_acknowledged_;
  if (!selection_required_ && selected_display_ < displays_.size()) {
    root["selectedDisplayId"] = displays_[selected_display_].id;
    root["layoutRevision"] = layout_revision_;
  }
  root["inputEnabled"] = input_enabled;
  root["atomicButtonClick"] = true;
  if (!input_enabled) {
    // A session that is connected and controlling but cannot type is the most
    // opaque state this protocol has: every control greys out with nothing to
    // explain it. Name what it is waiting on.
    if (const char* blocked = InputBlockedReason()) root["inputBlocked"] = blocked;
  }
  if (sign_in_screen_) root["signInScreen"] = true;
  if (unlock_available_) root["unlockAvailable"] = true;
  emit_(root);
}

void PeerSession::SetSignInState(bool sign_in_screen, bool unlock_available) {
  if (closed_ ||
      (sign_in_screen == sign_in_screen_ &&
       unlock_available == unlock_available_)) {
    return;
  }
  sign_in_screen_ = sign_in_screen;
  unlock_available_ = unlock_available;
  SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
}

bool PeerSession::SendControlRejected(const char* kind,
                                      const char* reason,
                                      const std::string& display_id) {
  // Bounded like every other outbound answer: a controller that floods control
  // frames must not be able to make this session answer each one.
  if (!ConsumeRate("reject", 60, std::chrono::minutes(1))) return false;
  Json::Value root(Json::objectValue);
  root["type"] = kControlRejectedType;
  root["protocolVersion"] = kProtocolVersion;
  root["sessionId"] = authority_.session_id;
  root["sequence"] = Json::UInt64(outbound_sequence_++);
  root["kind"] = kind;
  root["reason"] = reason;
  if (!display_id.empty()) root["displayId"] = display_id;
  SendControl(root);
  return false;
}

bool PeerSession::SelectDisplay(const std::string& id) {
  if (!display_adapter_ || !display_adapter_->SelectDisplay(id)) {
    return SendControlRejected("select_display", kRejectDisplayUnavailable, id);
  }
  const auto found = std::find_if(displays_.begin(), displays_.end(),
                                  [&](const DisplayInfo& display) {
                                    return display.id == id && display.available;
                                  });
  if (found == displays_.end()) {
    return SendControlRejected("select_display", kRejectDisplayUnavailable, id);
  }
  const size_t index = static_cast<size_t>(found - displays_.begin());
  if (index == selected_display_ && !selection_required_) return true;
  ReleaseInput();
  const bool previous_layout_acknowledged = layout_acknowledged_;
  layout_acknowledged_ = false;
  auto next_source = capture_adapter_->Acquire(ToCommonDisplayTopology(
      *found, CommonIdentity().daemon_generation));
  if (!next_source) {
    layout_acknowledged_ = previous_layout_acknowledged;
    SendTopology();
    SendQuality();
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
    return SendControlRejected("select_display", kRejectCaptureFailed, id);
  }
  if (!next_source->Start()) {
    layout_acknowledged_ = previous_layout_acknowledged;
    return SendControlRejected("select_display", kRejectCaptureFailed, id);
  }
  webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> next_native_source(
      next_source->source());
  if (!next_native_source) {
    layout_acknowledged_ = previous_layout_acknowledged;
    return SendControlRejected("select_display", kRejectCaptureFailed, id);
  }
  auto next_track = factory_->CreateVideoTrack(next_native_source,
                                               "imcodes-remote-desktop");
  if (!next_track) {
    layout_acknowledged_ = previous_layout_acknowledged;
    return SendControlRejected("select_display", kRejectCaptureFailed, id);
  }
  bool replaced = false;
  for (const auto& sender : peer_->GetSenders()) {
    if (sender->track() && sender->track()->kind() ==
                               webrtc::MediaStreamTrackInterface::kVideoKind) {
      replaced = sender->SetTrack(next_track.get()) &&
                 sender->GenerateKeyFrame({}).ok();
      break;
    }
  }
  if (!replaced) {
    layout_acknowledged_ = previous_layout_acknowledged;
    SendTopology();
    SendQuality();
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
    return SendControlRejected("select_display", kRejectCaptureFailed, id);
  }
  auto previous_source = std::move(source_);
  selected_display_ = index;
  selection_required_ = false;
  source_ = std::move(next_source);
  track_ = std::move(next_track);
  ResetMediaProgressWatchdog();
  previous_source.reset();
  ++layout_revision_;
  if (!RefreshCommonTopology()) return false;
  last_sequence_by_channel_.clear();
  SendTopology();
  SendQuality();
  SendStatus("switching_display", false);
  return true;
}

bool PeerSession::SetDisplayMode(const std::string& id,
                                 int width,
                                 int height) {
  if (!IsAllowedRemoteDisplayMode(width, height)) {
    return SendControlRejected("set_display_mode", kRejectModeUnsupported, id);
  }
  const auto restore_current_status = [&](const char* reason) {
    SendTopology();
    SendQuality();
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
    return SendControlRejected("set_display_mode", reason, id);
  };
  const auto found = std::find_if(displays_.begin(), displays_.end(),
                                  [&](const DisplayInfo& display) {
                                    return display.id == id && display.available;
                                  });
  if (found == displays_.end() || found->device_name.empty()) {
    return restore_current_status(kRejectDisplayUnavailable);
  }
  if (found->width == width && found->height == height) {
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
    return true;
  }

  DEVMODEW mode{};
  mode.dmSize = sizeof(mode);
  if (!EnumDisplaySettingsExW(found->device_name.c_str(),
                              ENUM_CURRENT_SETTINGS, &mode, EDS_RAWMODE)) {
    return restore_current_status(kRejectDisplayUnavailable);
  }
  mode.dmPelsWidth = static_cast<DWORD>(width);
  mode.dmPelsHeight = static_cast<DWORD>(height);
  mode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
  // A GPU with no monitor attached exposes only its fallback mode list, so this
  // is where a headless box refuses every resolution the operator picks — the
  // reason the controller needs to see rather than a click that does nothing.
  if (ChangeDisplaySettingsExW(found->device_name.c_str(), &mode, nullptr,
                               CDS_TEST, nullptr) != DISP_CHANGE_SUCCESSFUL) {
    return restore_current_status(kRejectModeUnsupported);
  }

  ReleaseInput();
  const bool previous_layout_acknowledged = layout_acknowledged_;
  layout_acknowledged_ = false;
  if (!display_adapter_ ||
      !display_adapter_->SetMode(
          id, common::PixelSize{static_cast<std::uint32_t>(width),
                                static_cast<std::uint32_t>(height)})) {
    layout_acknowledged_ = previous_layout_acknowledged;
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
    return SendControlRejected("set_display_mode", kRejectModeChangeFailed, id);
  }
  SendStatus("switching_display", false);
  return true;
}

bool PeerSession::SetDisplayScale(const std::string& id, int percent) {
  if (!IsAllowedRemoteDisplayScale(percent)) {
    return SendControlRejected("set_display_scale", kRejectScaleChangeFailed,
                               id);
  }
  const auto found = std::find_if(displays_.begin(), displays_.end(),
                                  [&](const DisplayInfo& display) {
                                    return display.id == id && display.available;
                                  });
  if (found == displays_.end() || found->device_name.empty()) {
    return SendControlRejected("set_display_scale", kRejectDisplayUnavailable,
                               id);
  }
  if (std::lround(found->dpi_scale * 100.0) == percent) {
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
    return true;
  }
  ReleaseInput();
  const bool previous_layout_acknowledged = layout_acknowledged_;
  layout_acknowledged_ = false;
  if (!display_adapter_ ||
      !display_adapter_->SetScale(id, static_cast<double>(percent) / 100.0)) {
    layout_acknowledged_ = previous_layout_acknowledged;
    SendTopology();
    SendStatus(IsRelayed() ? "relayed" : "direct", InputReady());
    return SendControlRejected("set_display_scale", kRejectScaleChangeFailed,
                               id);
  }
  found->dpi_scale = static_cast<double>(percent) / 100.0;
  ++layout_revision_;
  if (!RefreshCommonTopology()) return false;
  last_sequence_by_channel_.clear();
  SendTopology();
  SendQuality();
  SendStatus("switching_display", false);
  return true;
}

bool PeerSession::SendControl(const Json::Value& value) {
  const auto channel = channels_.find(kControlChannel);
  if (channel == channels_.end() ||
      channel->second->state() != webrtc::DataChannelInterface::kOpen ||
      channel->second->buffered_amount() > 256 * 1024) {
    return false;
  }
  return channel->second->Send(webrtc::DataBuffer(WriteJson(value)));
}

bool PeerSession::ChannelsReady() const {
  return transport_core_.required_channels_ready();
}

void PeerSession::ActivateVideoIfReady() {
  if (video_activated_ || closed_ || !peer_) return;
  const int64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now().time_since_epoch())
                             .count();
  const bool expired = video_gate_deadline_ms_ > 0 &&
                       now_ms >= video_gate_deadline_ms_;
  if (!ChannelsReady() && !expired) return;
  for (const auto& sender : peer_->GetSenders()) {
    if (!sender->track() || sender->track()->kind() !=
                                webrtc::MediaStreamTrackInterface::kVideoKind) {
      continue;
    }
    webrtc::RtpParameters parameters = sender->GetParameters();
    for (webrtc::RtpEncodingParameters& encoding : parameters.encodings) {
      encoding.active = true;
    }
    if (!sender->SetParameters(parameters).ok()) return;
    sender->GenerateKeyFrame({});
    video_activated_ = true;
    return;
  }
}

void PeerSession::PublishInputReadinessIfChanged() {
  if (closed_ || !peer_) return;
  ActivateVideoIfReady();
  const bool ready = InputReady();
  if (ready == reported_input_ready_) return;
  reported_input_ready_ = ready;
  SendStatus(IsRelayed() ? "relayed" : "direct", ready);
}

const char* PeerSession::InputBlockedReason() const {
  if (!controlling()) return kInputBlockedNoControl;
  if (!ChannelsReady()) return kInputBlockedChannels;
  if (selection_required_) return kInputBlockedSelectDisplay;
  // Input stays off across a layout change until the viewer confirms it is
  // looking at a frame of the new one — the common reason it is off after a
  // desktop switch.
  if (!layout_acknowledged_) return kInputBlockedAwaitingFrame;
  if (!input_->Available()) return kInputBlockedInputUnavailable;
  return nullptr;
}

bool PeerSession::InputReady() const {
  return controlling() && ChannelsReady() && layout_acknowledged_ &&
         !selection_required_ && input_->Available();
}

bool PeerSession::RefreshCommonTopology() {
  if (!display_adapter_) return false;
  display_adapter_->SetTopologyVersion(
      static_cast<common::WorkerGeneration>(
          std::max(1, authority_.daemon_generation)),
      static_cast<common::TopologyRevision>(std::max(1, layout_revision_)));
  common_topology_ = display_adapter_->EnumerateTopology();
  return common_topology_.has_value();
}

std::string PeerSession::InputControllerId(const std::string& channel) const {
  const char* suffix = channel == kKeyboardChannel
                           ? "k"
                           : channel == kPointerChannel ? "p" : "c";
  // Capability tokens are fixed at 43 URL-safe bytes, keeping the controller
  // identity well below the common 128-byte bound even with a channel suffix.
  return "rd:" + authority_.capability + ":" + suffix;
}

bool PeerSession::ReleaseInput() {
  bool released = input_->ReleaseOwner(authority_.session_id);
  released = input_->ReleaseOwner(authority_.session_id + ":clipboard") &&
             released;
  for (const char* channel : {kControlChannel, kKeyboardChannel,
                              kPointerChannel}) {
    const std::string controller = InputControllerId(channel);
    released = InputApplied(input_->ReleaseControllerStamped(controller)) &&
               released;
    released = InputApplied(input_->ReleaseControllerStamped(
                   controller + ":position")) &&
               released;
  }
  pressed_codes_.clear();
  return released;
}

}  // namespace imcodes::rd
