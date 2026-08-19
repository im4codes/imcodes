#include "third_party/imcodes_remote_desktop/peer_session.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <optional>
#include <thread>
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
      acquire_source_(std::move(acquire_source)),
      release_source_(std::move(release_source)),
      input_(input),
      clipboard_sequence_(std::move(clipboard_sequence)),
      read_clipboard_text_(std::move(read_clipboard_text)),
      request_unlock_(std::move(request_unlock)),
      signaling_thread_(signaling_thread),
      emit_(std::move(emit)) {
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
  if (!factory_ || displays_.empty() || !input_ || !signaling_thread_ ||
      !signaling_thread_->IsCurrent()) {
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
  webrtc::BitrateSettings bitrate_settings;
  bitrate_settings.min_bitrate_bps =
      static_cast<int>(kMinVideoBitrateBps);
  bitrate_settings.start_bitrate_bps =
      static_cast<int>(kInitialVideoBitrateBps);
  bitrate_settings.max_bitrate_bps =
      static_cast<int>(kPerPeerVideoBitrateBps);
  if (!peer_->SetBitrate(bitrate_settings).ok()) return false;
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
    auto candidate = acquire_source_(displays_[index]);
    if (!candidate) continue;
    candidate->Start();
    if (candidate->WaitForFirstFrame(
            std::chrono::milliseconds(kFirstPresentableFrameTimeoutMs))) {
      selected_display_ = index;
      source_ = std::move(candidate);
      break;
    }
    if (release_source_) release_source_(candidate->display());
  }
  if (!source_) return false;
  track_ = factory_->CreateVideoTrack(source_, "imcodes-remote-desktop");
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
  if (!added.value()->SetParameters(parameters).ok()) return false;
  Json::Value initial = BaseEnvelope(kModeStateType, authority_);
  initial["mode"] = authority_.mode;
  initial["inputEpoch"] = authority_.input_epoch;
  initial["reason"] = "initial";
  emit_(initial);
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
  remote_description_set_ = false;
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
    pending_remote_ice_.Clear();
    Close("peer_failed");
    return;
  }
  remote_description_set_ = true;
  if (!FlushPendingRemoteIce()) {
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
  if (closed_ || !peer_ || ++remote_ice_count_ > kMaxIceCandidates)
    return false;
  webrtc::SdpParseError error;
  std::unique_ptr<webrtc::IceCandidate> parsed(
      webrtc::CreateIceCandidate(mid, 0, candidate, &error));
  if (!parsed) return false;
  if (!remote_description_set_) {
    return pending_remote_ice_.Push(mid, candidate);
  }
  return peer_->AddIceCandidate(parsed.get());
}

bool PeerSession::FlushPendingRemoteIce() {
  std::vector<PendingRemoteIceCandidate> pending =
      pending_remote_ice_.TakeAll();
  for (PendingRemoteIceCandidate& value : pending) {
    webrtc::SdpParseError error;
    std::unique_ptr<webrtc::IceCandidate> parsed(
        webrtc::CreateIceCandidate(value.mid, 0, value.candidate, &error));
    if (!parsed || !peer_->AddIceCandidate(parsed.get())) {
      std::fill(value.mid.begin(), value.mid.end(), '\0');
      std::fill(value.candidate.begin(), value.candidate.end(), '\0');
      for (PendingRemoteIceCandidate& remaining : pending) {
        std::fill(remaining.mid.begin(), remaining.mid.end(), '\0');
        std::fill(remaining.candidate.begin(), remaining.candidate.end(), '\0');
      }
      return false;
    }
    std::fill(value.mid.begin(), value.mid.end(), '\0');
    std::fill(value.candidate.begin(), value.candidate.end(), '\0');
  }
  return true;
}

bool PeerSession::Renew(const Authority& renewal) {
  if (!Matches(renewal) || renewal.daemon_generation != authority_.daemon_generation ||
      renewal.lease_expires_at_ms <= authority_.lease_expires_at_ms ||
      renewal.input_epoch != authority_.input_epoch ||
      renewal.mode != authority_.mode) {
    return false;
  }
  authority_.lease_expires_at_ms = renewal.lease_expires_at_ms;
  return true;
}

bool PeerSession::SetMode(const Authority& update, const std::string& reason) {
  const bool mode_changed = update.mode != authority_.mode;
  if (!Matches(update) ||
      (mode_changed && update.input_epoch != authority_.input_epoch + 1) ||
      (!mode_changed && update.input_epoch != authority_.input_epoch) ||
      (update.mode != kViewMode && update.mode != kControlMode)) {
    return false;
  }
  if (mode_changed) {
    ReleaseInput();
    last_pointer_sequence_ = 0;
  }
  authority_.mode = update.mode;
  authority_.input_epoch = update.input_epoch;
  Json::Value response = BaseEnvelope(kModeStateType, authority_);
  response["mode"] = authority_.mode;
  response["inputEpoch"] = authority_.input_epoch;
  response["reason"] = reason == "initial" ? "initial" : "user_selected";
  emit_(response);
  SendStatus(relayed_ ? "relayed" : "direct", InputReady());
  return true;
}

bool PeerSession::Expired(int64_t now_ms) const {
  return closed_ || now_ms >= authority_.expires_at_ms ||
         now_ms >= authority_.lease_expires_at_ms || IdleExpired();
}

bool PeerSession::IdleExpired() const {
  return std::chrono::steady_clock::now() - last_activity_ >=
         std::chrono::milliseconds(kIdleTimeoutMs);
}

void PeerSession::TouchActivity() {
  last_activity_ = std::chrono::steady_clock::now();
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
  const int64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now().time_since_epoch())
                             .count();
  const uint64_t source_frames = source_->captured_frames();
  if (!media_stats_initialized_ ||
      outbound_bytes != last_outbound_video_bytes_) {
    media_stats_initialized_ = true;
    last_outbound_video_bytes_ = outbound_bytes;
    source_frames_at_media_progress_ = source_frames;
    last_media_progress_at_ms_ = now_ms;
    return;
  }
  if (MediaProgressShouldFailover(
          last_outbound_video_bytes_, outbound_bytes,
          source_frames_at_media_progress_, source_frames,
          now_ms - last_media_progress_at_ms_)) {
    DisqualifyHardwareEncoderForProcess();
    Close("peer_failed");
  }
}

void PeerSession::ResetMediaProgressWatchdog() {
  ++media_stats_generation_;
  media_stats_in_flight_ = false;
  media_stats_initialized_ = false;
  last_outbound_video_bytes_ = 0;
  source_frames_at_media_progress_ = source_ ? source_->captured_frames() : 0;
  media_stats_requested_at_ms_ = 0;
  last_media_progress_at_ms_ = 0;
}

void PeerSession::Close(const char* terminal_reason, bool emit_terminal) {
  if (closed_.exchange(true)) return;
  ResetMediaProgressWatchdog();
  ReleaseInput();
  for (auto& [label, channel] : channels_) {
    const auto observer = channel_observers_.find(label);
    if (observer != channel_observers_.end()) channel->UnregisterObserver();
    channel->Close();
  }
  channel_observers_.clear();
  channels_.clear();
  // Detach the source before closing the peer.  On older Windows hardware
  // encoders libwebrtc can otherwise retain queued full-resolution frames
  // while asynchronous PeerConnection teardown is still draining.  A rapid
  // reconnect would then overlap that queue with the replacement software
  // encoder and hit the worker's bounded memory job before teardown finishes.
  if (peer_) {
    for (const auto& sender : peer_->GetSenders()) {
      if (sender->track() && sender->track()->kind() ==
                                 webrtc::MediaStreamTrackInterface::kVideoKind) {
        sender->SetTrack(nullptr);
      }
    }
  }
  track_ = nullptr;
  if (source_ && release_source_) release_source_(source_->display());
  source_ = nullptr;
  if (peer_) peer_->Close();
  peer_ = nullptr;
  answer_observer_ = nullptr;
  setting_remote_description_ = false;
  remote_description_set_ = false;
  pending_remote_ice_.Clear();
  if (emit_terminal) emit_(TerminalEnvelope(authority_, terminal_reason));
  std::fill(authority_.capability.begin(), authority_.capability.end(), '\0');
}

bool PeerSession::controlling() const {
  return !closed_ && authority_.mode == kControlMode &&
         authority_.input_epoch > 0;
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
  const DisplayInfo previous = source_ ? source_->display()
                                       : displays_[selected_display_];
  const std::string previous_id = previous.id;
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
  const bool replace_source = !source_ ||
      DisplaySourceKey(source_->display()) != DisplaySourceKey(*selected);
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
    auto next_source = acquire_source_(*selected);
    if (!next_source) return true;
    next_source->Start();
    auto next_track = factory_->CreateVideoTrack(next_source,
                                                  "imcodes-remote-desktop");
    const bool replaced = video_sender->SetTrack(next_track.get()) &&
                          video_sender->GenerateKeyFrame({}).ok();
    if (!replaced) {
      if (release_source_) release_source_(next_source->display());
      return true;
    }
    const std::optional<DisplayInfo> previous_display =
        source_ ? std::optional<DisplayInfo>(source_->display()) : std::nullopt;
    source_ = std::move(next_source);
    track_ = std::move(next_track);
    if (previous_display && release_source_) release_source_(*previous_display);
    ResetMediaProgressWatchdog();
  }
  selected_display_ = static_cast<size_t>(selected - displays.begin());
  selection_required_ = false;
  displays_ = std::move(displays);
  ++layout_revision_;
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
  if (closed_ || ++local_ice_count_ > kMaxIceCandidates) {
    if (local_ice_count_ > kMaxIceCandidates) Close("protocol_error");
    return;
  }
  Json::Value message = BaseEnvelope(kIceType, authority_);
  message["candidate"] = std::move(candidate);
  message["mid"] = std::move(mid);
  emit_(message);
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
  if (state == webrtc::PeerConnectionInterface::PeerConnectionState::kConnected) {
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
  } else if (state ==
                 webrtc::PeerConnectionInterface::PeerConnectionState::kFailed ||
             state ==
                 webrtc::PeerConnectionInterface::PeerConnectionState::kClosed) {
    Close("peer_failed");
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
        session->relayed_ = relayed;
        session->SendStatus(relayed ? "relayed" : "direct",
                            session->InputReady());
      }
    });
    return;
  }
  relayed_ = relayed;
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
  if (found->second->state() == webrtc::DataChannelInterface::kOpen &&
      label == kControlChannel) {
    SendTopology();
    SendQuality();
  }
  if (found->second->state() == webrtc::DataChannelInterface::kOpen &&
      ChannelsReady()) {
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
  } else if (found->second->state() ==
             webrtc::DataChannelInterface::kClosed) {
    Close("peer_failed");
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
    if (selection_required_ || selected_display_ >= displays_.size() ||
        !root["displayId"].isString() || !root["frameWidth"].isInt() ||
        !root["frameHeight"].isInt() || root.isMember("width") ||
        root.isMember("height") || root.isMember("dpiScalePercent") ||
        root.isMember("requestId") || root.isMember("acknowledgedSequence") ||
        root["displayId"].asString() != displays_[selected_display_].id ||
        !PresentedFrameMatchesDisplay(
            root["frameWidth"].asInt(), root["frameHeight"].asInt(),
            displays_[selected_display_].width,
            displays_[selected_display_].height)) {
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
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
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
  if (!ValidateInputBase(root, channel, true, &sequence) ||
      authority_.input_epoch <= 0 || sequence <= last_pointer_sequence_) return;
  const std::string kind = root["kind"].asString();
  bool accepted = false;
  if (kind == "move" && root["x"].isNumeric() && root["y"].isNumeric() &&
      !root.isMember("button") && !root.isMember("deltaX") &&
      !root.isMember("deltaY") && root["x"].asDouble() >= 0.0 &&
      root["x"].asDouble() <= 1.0 && root["y"].asDouble() >= 0.0 &&
      root["y"].asDouble() <= 1.0) {
    accepted = input_->Move(displays_[selected_display_], root["x"].asDouble(),
                            root["y"].asDouble());
  } else if ((kind == "button_down" || kind == "button_up") &&
             root["button"].isString() && !root.isMember("deltaX") &&
             !root.isMember("deltaY") &&
             (!root.isMember("x") || (root["x"].isNumeric() &&
              root["x"].asDouble() >= 0.0 && root["x"].asDouble() <= 1.0)) &&
             (!root.isMember("y") || (root["y"].isNumeric() &&
              root["y"].asDouble() >= 0.0 && root["y"].asDouble() <= 1.0))) {
    if (root.isMember("x") && root.isMember("y") &&
        !input_->Move(displays_[selected_display_], root["x"].asDouble(),
                      root["y"].asDouble())) {
      return;
    }
    accepted = kind == "button_down"
                   ? input_->ButtonDown(authority_.session_id,
                                        root["button"].asString())
                   : input_->ButtonUp(authority_.session_id,
                                      root["button"].asString());
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
        !input_->Move(displays_[selected_display_], root["x"].asDouble(),
                      root["y"].asDouble())) {
      return;
    }
    accepted = input_->Wheel(root["deltaX"].asDouble(),
                             root["deltaY"].asDouble());
  }
  if (accepted) {
    last_pointer_sequence_ = sequence;
    last_sequence_by_channel_[channel] = sequence;
    TouchActivity();
    if (channel == kControlChannel &&
        (kind == "button_down" || kind == "button_up")) {
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
      accepted = input_->KeyDown(authority_.session_id, code,
                                 root["repeat"].asBool());
      if (accepted) pressed_codes_.insert(code);
    } else {
      accepted = input_->KeyUp(authority_.session_id, code);
      pressed_codes_.erase(code);
    }
  } else if (kind == "text" && root["text"].isString()) {
    if (root.isMember("code") || root.isMember("key") ||
        root.isMember("repeat") || root["text"].asString().size() > 4096) {
      return;
    }
    const std::u16string text = Utf8ToUtf16(root["text"].asString());
    accepted = !text.empty() && input_->Text(text);
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
    Json::Value value(Json::objectValue);
    value["id"] = display.id;
    value["label"] = display.label;
    value["primary"] = display.primary;
    value["available"] = display.available;
    value["width"] = display.width;
    value["height"] = display.height;
    value["dpiScale"] = display.dpi_scale;
    value["rotation"] = display.rotation_degrees;
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
  if (!clipboard_sequence_ || !read_clipboard_text_)
    return SendClipboard(request_id, std::nullopt);
  const DWORD previous_sequence = clipboard_sequence_();
  const std::string owner = authority_.session_id + ":clipboard";
  if (!input_->CopyShortcut(owner))
    return SendClipboard(request_id, std::nullopt);
  for (int attempt = 0; attempt < 6; ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    const auto text = read_clipboard_text_(previous_sequence);
    if (text) return SendClipboard(request_id, text);
  }
  return SendClipboard(request_id, std::nullopt);
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
  root["state"] = state;
  root["route"] = relayed_ ? "relay" : "direct";
  if (!selection_required_ && selected_display_ < displays_.size()) {
    root["selectedDisplayId"] = displays_[selected_display_].id;
    root["layoutRevision"] = layout_revision_;
  }
  root["inputEnabled"] = input_enabled;
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
  SendStatus(relayed_ ? "relayed" : "direct", InputReady());
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
  auto next_source = acquire_source_(*found);
  if (!next_source) {
    layout_acknowledged_ = previous_layout_acknowledged;
    SendTopology();
    SendQuality();
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
    return SendControlRejected("select_display", kRejectCaptureFailed, id);
  }
  next_source->Start();
  auto next_track = factory_->CreateVideoTrack(next_source,
                                                "imcodes-remote-desktop");
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
    if (release_source_) release_source_(next_source->display());
    layout_acknowledged_ = previous_layout_acknowledged;
    SendTopology();
    SendQuality();
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
    return SendControlRejected("select_display", kRejectCaptureFailed, id);
  }
  const std::optional<DisplayInfo> previous_display =
      source_ ? std::optional<DisplayInfo>(source_->display()) : std::nullopt;
  selected_display_ = index;
  selection_required_ = false;
  source_ = std::move(next_source);
  track_ = std::move(next_track);
  ResetMediaProgressWatchdog();
  if (previous_display && release_source_) release_source_(*previous_display);
  ++layout_revision_;
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
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
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
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
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
  if (ChangeDisplaySettingsExW(found->device_name.c_str(), &mode, nullptr,
                               CDS_UPDATEREGISTRY,
                               nullptr) != DISP_CHANGE_SUCCESSFUL) {
    layout_acknowledged_ = previous_layout_acknowledged;
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
    return SendControlRejected("set_display_mode", kRejectModeChangeFailed, id);
  }
  // Do not drive the undocumented per-monitor DPI packet while DXGI is still
  // bound to the old mode. On the IM.codes display persist the paired readable
  // scale; Initialize applies it on the next verified worker session before
  // capture starts. Physical-display DPI remains an explicit user operation.
  const int recommended_scale = RecommendedRemoteDisplayScale(width, height);
  if (found->imcodes_virtual) {
    SaveVirtualDisplayPreferences({width, height, recommended_scale});
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
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
    return true;
  }
  ReleaseInput();
  const bool previous_layout_acknowledged = layout_acknowledged_;
  layout_acknowledged_ = false;
  if (!SetDisplayDpiScale(*found, percent)) {
    layout_acknowledged_ = previous_layout_acknowledged;
    SendTopology();
    SendStatus(relayed_ ? "relayed" : "direct", InputReady());
    return SendControlRejected("set_display_scale", kRejectScaleChangeFailed,
                               id);
  }
  found->dpi_scale = static_cast<double>(percent) / 100.0;
  if (found->imcodes_virtual) {
    SaveVirtualDisplayPreferences({found->width, found->height, percent});
  }
  ++layout_revision_;
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
  for (const char* label : {kControlChannel, kKeyboardChannel,
                            kPointerChannel}) {
    const auto found = channels_.find(label);
    if (found == channels_.end() ||
        found->second->state() != webrtc::DataChannelInterface::kOpen) {
      return false;
    }
  }
  return true;
}

void PeerSession::PublishInputReadinessIfChanged() {
  if (closed_ || !peer_) return;
  const bool ready = InputReady();
  if (ready == reported_input_ready_) return;
  reported_input_ready_ = ready;
  SendStatus(relayed_ ? "relayed" : "direct", ready);
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

bool PeerSession::ReleaseInput() {
  const bool released = input_->ReleaseOwner(authority_.session_id);
  pressed_codes_.clear();
  return released;
}

}  // namespace imcodes::rd
