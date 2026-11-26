// Real-SDK & real-worker end-to-end qualification for Linux Remote Desktop
// PulseAudio / PipeWire loopback audio (`@DEFAULT_MONITOR@`).
//
// Modes:
//   --session-live <display>         Runs in-process LinuxRemoteDesktopSession
//                                    qualification against live X11 + PulseAudio:
//                                    view-mode set_audio(true/false) PCM proof,
//                                    control-mode set_audio + Stop() refcount,
//                                    and older viewer video-only offer (no m=audio).
//   --worker-audio <worker-bin>      Spawns the REAL worker executable with live
//                                    PulseAudio monitor and verifies non-zero
//                                    decoded Opus audio when set_audio=true and
//                                    silence/teardown after set_audio=false.
//   --worker-headless <worker-bin>   Spawns the REAL worker executable with an
//                                    unreachable PulseAudio socket and verifies
//                                    no crash/hang while streaming video and
//                                    handling set_audio(true/false).
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/data_channel_interface.h"
#include "api/enable_media.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/media_stream_interface.h"
#include "api/peer_connection_interface.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "modules/audio_device/include/audio_device_default.h"
#include "rtc_base/ssl_adapter.h"

#include "../../native/linux-remote-desktop/linux_platform_adapters.h"
#include "../../native/linux-remote-desktop/linux_pulse_loopback_capture.h"
#include "../../native/linux-remote-desktop/linux_remote_desktop_session.h"
#include "../../native/remote-desktop-common/data_channel_constants.h"
#include "../../native/remote-desktop-common/json_protocol.h"
#include "../../native/remote-desktop-common/loopback_audio_device_module.h"

namespace rd = imcodes::remote_desktop::linux_platform;
namespace common = imcodes::remote_desktop::common;

namespace {

class ClientPlayoutAdm
    : public webrtc::webrtc_impl::AudioDeviceModuleDefault<
          webrtc::AudioDeviceModule> {
 public:
  ~ClientPlayoutAdm() override { Terminate(); }

  int32_t RegisterAudioCallback(webrtc::AudioTransport* audio_callback) override {
    std::lock_guard<std::mutex> lock(cb_mu_);
    audio_callback_ = audio_callback;
    return 0;
  }
  int32_t Init() override {
    initialized_ = true;
    return 0;
  }
  int32_t Terminate() override {
    StopPlayout();
    initialized_ = false;
    std::lock_guard<std::mutex> lock(cb_mu_);
    audio_callback_ = nullptr;
    return 0;
  }
  bool Initialized() const override { return initialized_; }
  int16_t PlayoutDevices() override { return 1; }
  int32_t PlayoutIsAvailable(bool* available) override {
    if (available) *available = true;
    return 0;
  }
  int32_t StereoPlayoutIsAvailable(bool* available) const override {
    if (available) *available = true;
    return 0;
  }
  int32_t SetStereoPlayout(bool) override { return 0; }
  int32_t InitPlayout() override {
    playout_initialized_ = true;
    return 0;
  }
  bool PlayoutIsInitialized() const override { return playout_initialized_; }
  int32_t StartPlayout() override {
    std::lock_guard<std::mutex> lock(life_mu_);
    if (playing_.load()) return 0;
    playing_.store(true);
    playout_thread_ = std::thread([this]() {
      std::int16_t out[480 * 2] = {};
      while (playing_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (!playing_.load()) break;
        std::lock_guard<std::mutex> cb_lock(cb_mu_);
        if (audio_callback_) {
          size_t n_out = 0;
          int64_t elapsed = 0;
          int64_t ntp = 0;
          audio_callback_->NeedMorePlayData(480, 4, 2, 48000, out, n_out,
                                            &elapsed, &ntp);
        }
      }
    });
    return 0;
  }
  int32_t StopPlayout() override {
    std::thread t;
    {
      std::lock_guard<std::mutex> lock(life_mu_);
      playing_.store(false);
      t = std::move(playout_thread_);
    }
    if (t.joinable()) t.join();
    return 0;
  }
  bool Playing() const override { return playing_.load(); }

 private:
  std::mutex life_mu_;
  std::mutex cb_mu_;
  webrtc::AudioTransport* audio_callback_ = nullptr;
  std::thread playout_thread_;
  std::atomic<bool> initialized_{false};
  std::atomic<bool> playout_initialized_{false};
  std::atomic<bool> playing_{false};
};

class SetLocalObs : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    if (!error.ok()) {
      std::fprintf(stderr, "client SetLocalDescription: %s\n", error.message());
    }
  }
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

class CreateOfferObs : public webrtc::CreateSessionDescriptionObserver {
 public:
  explicit CreateOfferObs(
      std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>)>
          on_success)
      : on_success_(std::move(on_success)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
    on_success_(std::unique_ptr<webrtc::SessionDescriptionInterface>(desc));
  }
  void OnFailure(webrtc::RTCError error) override {
    std::fprintf(stderr, "client CreateOffer: %s\n", error.message());
  }

 private:
  std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>)>
      on_success_;
};

class VideoFrameSink : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  void OnFrame(const webrtc::VideoFrame& frame) override {
    std::lock_guard<std::mutex> lock(mu_);
    ++frames_;
    if (!seen_) {
      seen_ = true;
      width_ = frame.width();
      height_ = frame.height();
    }
    cv_.notify_all();
  }
  bool WaitForFrame(std::chrono::milliseconds timeout, int* w, int* h) {
    std::unique_lock<std::mutex> lock(mu_);
    if (!cv_.wait_for(lock, timeout, [this] { return seen_; })) return false;
    *w = width_;
    *h = height_;
    return true;
  }
  bool WaitForMoreFrames(int min_additional, std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mu_);
    const int target = frames_ + min_additional;
    return cv_.wait_for(lock, timeout, [this, target] { return frames_ >= target; });
  }
  void OnFrameUpdateNotifyAll() { cv_.notify_all(); }

 private:
  std::mutex mu_;
  std::condition_variable cv_;
  bool seen_ = false;
  int width_ = 0;
  int height_ = 0;
  int frames_ = 0;
};

class AudioFrameSink : public webrtc::AudioTrackSinkInterface {
 public:
  void OnData(const void* audio_data,
              int bits_per_sample,
              int sample_rate,
              size_t number_of_channels,
              size_t number_of_frames) override {
    if (bits_per_sample != 16 || audio_data == nullptr ||
        number_of_frames == 0 || number_of_channels == 0) {
      return;
    }
    const auto* pcm = static_cast<const std::int16_t*>(audio_data);
    const size_t total = number_of_frames * number_of_channels;
    int chunk_peak = 0;
    for (size_t i = 0; i < total; ++i) {
      const int v = std::abs(static_cast<int>(pcm[i]));
      if (v > chunk_peak) chunk_peak = v;
    }
    std::lock_guard<std::mutex> lock(mu_);
    ++chunks_;
    last_sample_rate_ = sample_rate;
    last_channels_ = number_of_channels;
    recent_peak_ = chunk_peak;
    if (chunk_peak > max_peak_) max_peak_ = chunk_peak;
    if (chunk_peak >= 200) {
      ++non_zero_chunks_;
    }
    cv_.notify_all();
  }

  void ResetCounters() {
    std::lock_guard<std::mutex> lock(mu_);
    chunks_ = 0;
    non_zero_chunks_ = 0;
    max_peak_ = 0;
    recent_peak_ = 0;
  }

  bool WaitForNonZeroAudio(std::chrono::milliseconds timeout,
                           int* out_peak,
                           int* out_rate,
                           size_t* out_channels) {
    std::unique_lock<std::mutex> lock(mu_);
    if (!cv_.wait_for(lock, timeout,
                      [this] { return non_zero_chunks_ >= 3; })) {
      return false;
    }
    if (out_peak) *out_peak = max_peak_;
    if (out_rate) *out_rate = last_sample_rate_;
    if (out_channels) *out_channels = last_channels_;
    return true;
  }

  int WaitAndSampleMaxPeak(std::chrono::milliseconds window) {
    ResetCounters();
    std::this_thread::sleep_for(window);
    std::lock_guard<std::mutex> lock(mu_);
    return max_peak_;
  }

  int chunks() {
    std::lock_guard<std::mutex> lock(mu_);
    return chunks_;
  }

 private:
  std::mutex mu_;
  std::condition_variable cv_;
  int chunks_ = 0;
  int non_zero_chunks_ = 0;
  int max_peak_ = 0;
  int recent_peak_ = 0;
  int last_sample_rate_ = 0;
  size_t last_channels_ = 0;
};

class ControlDcObserver : public webrtc::DataChannelObserver {
 public:
  void Attach(webrtc::scoped_refptr<webrtc::DataChannelInterface> dc) {
    dc_ = std::move(dc);
    dc_->RegisterObserver(this);
    OnStateChange();
  }
  void OnStateChange() override {
    if (dc_ && dc_->state() == webrtc::DataChannelInterface::kOpen) {
      std::lock_guard<std::mutex> lock(mu_);
      open_ = true;
      cv_.notify_all();
    }
  }
  void OnMessage(const webrtc::DataBuffer& buffer) override {
    if (buffer.binary || buffer.size() == 0) return;
    Json::Value parsed;
    if (!imcodes::rd::ParseJson(
            std::string(
                reinterpret_cast<const char*>(buffer.data.data()),
                buffer.size()),
            &parsed) ||
        !parsed.isObject()) {
      return;
    }
    if (parsed["type"].isString() &&
        parsed["type"].asString() == imcodes::rd::kTopologyType &&
        parsed["layoutRevision"].isUInt64()) {
      std::lock_guard<std::mutex> lock(mu_);
      layout_revision_ = parsed["layoutRevision"].asUInt64();
      cv_.notify_all();
    }
  }
  bool WaitOpen(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mu_);
    return cv_.wait_for(lock, timeout, [this] { return open_; });
  }
  bool WaitLayoutRevision(std::chrono::milliseconds timeout,
                          std::uint64_t* out_revision) {
    std::unique_lock<std::mutex> lock(mu_);
    if (!cv_.wait_for(lock, timeout,
                      [this] { return layout_revision_ > 0; })) {
      return false;
    }
    if (out_revision) *out_revision = layout_revision_;
    return true;
  }
  bool SendJson(const Json::Value& value) {
    if (!dc_ || dc_->state() != webrtc::DataChannelInterface::kOpen) {
      return false;
    }
    return dc_->Send(webrtc::DataBuffer(imcodes::rd::WriteJson(value)));
  }

 private:
  webrtc::scoped_refptr<webrtc::DataChannelInterface> dc_;
  std::mutex mu_;
  std::condition_variable cv_;
  bool open_ = false;
  std::uint64_t layout_revision_ = 0;
};

class ClientObserver : public webrtc::PeerConnectionObserver {
 public:
  ClientObserver(
      std::function<void(const webrtc::IceCandidate*)> on_ice,
      std::function<void(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>)>
          on_track)
      : on_ice_(std::move(on_ice)), on_track_(std::move(on_track)) {}
  void OnSignalingChange(
      webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(
      webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceGatheringChange(
      webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override {
    on_ice_(candidate);
  }
  void OnConnectionChange(
      webrtc::PeerConnectionInterface::PeerConnectionState) override {}
  void OnTrack(
      webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver)
      override {
    on_track_(std::move(transceiver));
  }

 private:
  std::function<void(const webrtc::IceCandidate*)> on_ice_;
  std::function<void(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>)>
      on_track_;
};

Json::Value MakeSetAudioControl(const std::string& session_id,
                                std::uint64_t sequence,
                                std::uint64_t input_epoch,
                                bool enabled,
                                std::uint64_t layout_revision = 1) {
  Json::Value msg(Json::objectValue);
  msg["protocolVersion"] = 2;
  msg["sessionId"] = session_id;
  msg["sequence"] = static_cast<Json::UInt64>(sequence);
  msg["layoutRevision"] = static_cast<Json::UInt64>(layout_revision);
  msg["inputEpoch"] = static_cast<Json::UInt64>(input_epoch);
  msg["type"] = imcodes::rd::kControlType;
  msg["kind"] = imcodes::rd::kSetAudioKind;
  msg["enabled"] = enabled;
  return msg;
}

int RunSessionLive() {
  webrtc::InitializeSSL();
  auto connection = rd::X11Connection::Open();
  if (!connection) {
    std::fprintf(stderr, "FAILED: cannot open X display\n");
    return 10;
  }
  auto adapters = rd::LinuxPlatformAdapters::Create(connection);
  if (!adapters) {
    std::fprintf(stderr, "FAILED: LinuxPlatformAdapters::Create failed\n");
    return 11;
  }

  auto signaling_thread = webrtc::Thread::Create();
  signaling_thread->Start();
  auto worker_thread = webrtc::Thread::Create();
  worker_thread->Start();
  auto network_thread = webrtc::Thread::CreateWithSocketServer();
  network_thread->Start();

  auto audio_capture = std::make_shared<rd::LinuxAudioCaptureCoordinator>();

  webrtc::PeerConnectionFactoryDependencies server_deps;
  server_deps.network_thread = network_thread.get();
  server_deps.worker_thread = worker_thread.get();
  server_deps.signaling_thread = signaling_thread.get();
  server_deps.adm =
      webrtc::make_ref_counted<imcodes::rd::LoopbackAudioDeviceModule>(
          audio_capture->buffer());
  server_deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  server_deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  server_deps.video_encoder_factory = webrtc::CreateBuiltinVideoEncoderFactory();
  server_deps.video_decoder_factory = webrtc::CreateBuiltinVideoDecoderFactory();
  webrtc::EnableMedia(server_deps);
  auto server_factory =
      webrtc::CreateModularPeerConnectionFactory(std::move(server_deps));
  if (!server_factory) return 12;

  webrtc::PeerConnectionFactoryDependencies client_deps;
  client_deps.network_thread = network_thread.get();
  client_deps.worker_thread = worker_thread.get();
  client_deps.signaling_thread = signaling_thread.get();
  client_deps.adm = webrtc::make_ref_counted<ClientPlayoutAdm>();
  client_deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  client_deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  client_deps.video_encoder_factory = webrtc::CreateBuiltinVideoEncoderFactory();
  client_deps.video_decoder_factory = webrtc::CreateBuiltinVideoDecoderFactory();
  webrtc::EnableMedia(client_deps);
  auto client_factory =
      webrtc::CreateModularPeerConnectionFactory(std::move(client_deps));
  if (!client_factory) return 13;

  const auto make_authority = [](const std::string& sid,
                                 common::TransportSessionMode mode,
                                 std::uint64_t epoch) {
    common::RouteAuthority a;
    a.identity.request_id = "req-" + sid;
    a.identity.session_id = sid;
    a.identity.negotiated_capability_binding =
        "cap-token-012345678901234567890123456789012";
    a.identity.daemon_generation = 1;
    a.identity.route_generation = 1;
    a.mode = mode;
    a.input_epoch = epoch;
    const int64_t unix_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count();
    a.expires_at_unix_ms = unix_ms + 60'000;
    a.lease_expires_at_unix_ms = unix_ms + 60'000;
    return a;
  };
  const auto now_time = []() {
    return common::TransportTime{
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count(),
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count(),
    };
  };

  // --- Case 1: view mode set_audio(true/false) with live PulseAudio PCM ---
  {
    const std::string sid = "audio-qual-view";
    VideoFrameSink video_sink;
    AudioFrameSink audio_sink;
    ControlDcObserver dc_obs;
    std::unique_ptr<ClientObserver> client_obs;
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> client_pc;
    std::shared_ptr<rd::LinuxRemoteDesktopSession> session;

    session = rd::LinuxRemoteDesktopSession::Create(
        server_factory, *adapters, signaling_thread.get(),
        [&](const std::string& mid, const std::string& sdp) {
          signaling_thread->PostTask([&client_pc, mid, sdp]() {
            if (!client_pc) return;
            if (auto c = webrtc::IceCandidate::Create(mid, 0, sdp)) {
              client_pc->AddIceCandidate(std::move(c), [](webrtc::RTCError) {});
            }
          });
        },
        audio_capture);
    const common::RouteAuthority view_auth =
        make_authority(sid, common::TransportSessionMode::kView, 1);
    if (!session->Start(view_auth, now_time())) {
      return 14;
    }

    client_obs = std::make_unique<ClientObserver>(
        [&](const webrtc::IceCandidate* c) {
          auto mid = c->sdp_mid();
          auto sdp = c->ToString();
          signaling_thread->PostTask(
              [&session, mid, sdp]() { session->AddRemoteIce(mid, sdp); });
        },
        [&](webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> tr) {
          auto track = tr->receiver()->track();
          if (track->kind() == webrtc::MediaStreamTrackInterface::kVideoKind) {
            static_cast<webrtc::VideoTrackInterface*>(track.get())
                ->AddOrUpdateSink(&video_sink, webrtc::VideoSinkWants());
          } else if (track->kind() ==
                     webrtc::MediaStreamTrackInterface::kAudioKind) {
            static_cast<webrtc::AudioTrackInterface*>(track.get())
                ->AddSink(&audio_sink);
          }
        });
    webrtc::PeerConnectionInterface::RTCConfiguration cfg;
    cfg.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    webrtc::PeerConnectionDependencies deps(client_obs.get());
    client_pc = client_factory->CreatePeerConnectionOrError(cfg, std::move(deps))
                    .value();

    webrtc::RtpTransceiverInit recvonly;
    recvonly.direction = webrtc::RtpTransceiverDirection::kRecvOnly;
    client_pc->AddTransceiver(webrtc::MediaType::VIDEO, recvonly);
    client_pc->AddTransceiver(webrtc::MediaType::AUDIO, recvonly);
    auto dc_res = client_pc->CreateDataChannelOrError(
        imcodes::rd::kControlChannel, nullptr);
    if (!dc_res.ok()) return 15;
    dc_obs.Attach(dc_res.value());

    std::mutex done_mu;
    std::condition_variable done_cv;
    bool got_answer = false;
    bool got_answer_ok = false;
    signaling_thread->PostTask([&]() {
      auto obs = webrtc::make_ref_counted<CreateOfferObs>(
          [&](std::unique_ptr<webrtc::SessionDescriptionInterface> offer) {
            std::string offer_sdp;
            offer->ToString(&offer_sdp);
            client_pc->SetLocalDescription(
                std::move(offer), webrtc::make_ref_counted<SetLocalObs>());
            session->ApplyOffer(offer_sdp, [&](bool ok, const std::string& ans) {
              if (!ok) {
                std::lock_guard<std::mutex> lock(done_mu);
                got_answer = true;
                got_answer_ok = false;
                done_cv.notify_all();
                return;
              }
              auto remote = webrtc::CreateSessionDescription(
                  webrtc::SdpType::kAnswer, ans);
              client_pc->SetRemoteDescription(
                  std::move(remote),
                  webrtc::make_ref_counted<SetRemoteObs>([&](bool set_ok) {
                    std::lock_guard<std::mutex> lock(done_mu);
                    got_answer = true;
                    got_answer_ok = set_ok;
                    done_cv.notify_all();
                  }));
            });
          });
      client_pc->CreateOffer(
          obs.get(), webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
    });
    {
      std::unique_lock<std::mutex> lock(done_mu);
      if (!done_cv.wait_for(lock, std::chrono::seconds(10),
                            [&] { return got_answer && got_answer_ok; })) {
        return 16;
      }
    }
    int w = 0, h = 0;
    if (!video_sink.WaitForFrame(std::chrono::seconds(15), &w, &h)) return 17;
    if (!dc_obs.WaitOpen(std::chrono::seconds(5))) return 18;
    if (audio_capture->active_sessions() != 0 || session->audio_enabled()) {
      std::fprintf(stderr, "FAILED: initial audio state should be disabled\n");
      return 19;
    }

    // Enable audio in VIEW mode!
    if (!dc_obs.SendJson(MakeSetAudioControl(sid, 1, 1, true))) return 20;
    bool enabled_observed = false;
    for (int i = 0; i < 60; ++i) {
      if (session->audio_enabled() && audio_capture->active_sessions() == 1) {
        enabled_observed = true;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(15));
    }
    if (!enabled_observed) {
      std::fprintf(stderr, "FAILED: view-mode set_audio(true) did not acquire lease\n");
      return 21;
    }

    int peak = 0;
    int rate = 0;
    size_t channels = 0;
    if (!audio_sink.WaitForNonZeroAudio(std::chrono::seconds(10), &peak, &rate,
                                        &channels)) {
      std::fprintf(stderr,
                   "FAILED: client AudioTrack did not receive non-zero PCM "
                   "(chunks=%d)\n",
                   audio_sink.chunks());
      return 22;
    }
    std::fprintf(stderr,
                 "SESSION_LIVE_AUDIO_OK: peak=%d rate=%d ch=%zu frames=%llu\n",
                 peak, rate, channels,
                 static_cast<unsigned long long>(
                     audio_capture->capture().frames_captured()));

    // Disable audio in VIEW mode -> refcount returns to 0!
    if (!dc_obs.SendJson(MakeSetAudioControl(sid, 2, 1, false))) return 23;
    bool disabled_observed = false;
    for (int i = 0; i < 60; ++i) {
      if (!session->audio_enabled() && audio_capture->active_sessions() == 0 &&
          !audio_capture->capture().enabled()) {
        disabled_observed = true;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(15));
    }
    if (!disabled_observed) {
      std::fprintf(stderr, "FAILED: view-mode set_audio(false) did not release lease\n");
      return 24;
    }

    // Switch session to CONTROL mode, re-enable audio, then Stop() -> must release to 0!
    common::RouteAuthority ctrl_auth = view_auth;
    ctrl_auth.mode = common::TransportSessionMode::kControl;
    ctrl_auth.input_epoch = 2;
    signaling_thread->BlockingCall([&]() {
      if (!session->UpdateMode(ctrl_auth, now_time())) {
        std::fprintf(stderr, "FAILED: UpdateMode(kControl) rejected\n");
      }
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    if (!dc_obs.SendJson(MakeSetAudioControl(sid, 3, 2, true))) return 25;
    bool control_enabled = false;
    for (int i = 0; i < 60; ++i) {
      if (session->audio_enabled() && audio_capture->active_sessions() == 1) {
        control_enabled = true;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(15));
    }
    if (!control_enabled) {
      std::fprintf(stderr, "FAILED: control-mode set_audio(true) did not acquire lease\n");
      return 26;
    }
    signaling_thread->BlockingCall([&]() {
      session->Stop();
      client_pc->Close();
      client_pc = nullptr;
    });
    signaling_thread->BlockingCall([]() {});
    if (!session->closed() || audio_capture->active_sessions() != 0 ||
        audio_capture->capture().enabled()) {
      std::fprintf(stderr,
                   "FAILED: session->Stop() did not release audio lease "
                   "(closed=%d active=%zu capture_enabled=%d)\n",
                   static_cast<int>(session->closed()),
                   audio_capture->active_sessions(),
                   static_cast<int>(audio_capture->capture().enabled()));
      return 27;
    }
  }

  // --- Case 2: Older viewer SDP without m=audio still negotiates video ---
  {
    const std::string sid = "audio-qual-legacy-video-only";
    VideoFrameSink video_sink;
    std::unique_ptr<ClientObserver> client_obs;
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> client_pc;
    std::shared_ptr<rd::LinuxRemoteDesktopSession> session;
    session = rd::LinuxRemoteDesktopSession::Create(
        server_factory, *adapters, signaling_thread.get(),
        [&](const std::string& mid, const std::string& sdp) {
          signaling_thread->PostTask([&client_pc, mid, sdp]() {
            if (!client_pc) return;
            if (auto c = webrtc::IceCandidate::Create(mid, 0, sdp)) {
              client_pc->AddIceCandidate(std::move(c), [](webrtc::RTCError) {});
            }
          });
        },
        audio_capture);
    if (!session->Start(
            make_authority(sid, common::TransportSessionMode::kView, 1),
            now_time())) {
      return 28;
    }
    client_obs = std::make_unique<ClientObserver>(
        [&](const webrtc::IceCandidate* c) {
          auto mid = c->sdp_mid();
          auto sdp = c->ToString();
          signaling_thread->PostTask(
              [&session, mid, sdp]() { session->AddRemoteIce(mid, sdp); });
        },
        [&](webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> tr) {
          if (tr->receiver()->track()->kind() ==
              webrtc::MediaStreamTrackInterface::kVideoKind) {
            static_cast<webrtc::VideoTrackInterface*>(
                tr->receiver()->track().get())
                ->AddOrUpdateSink(&video_sink, webrtc::VideoSinkWants());
          }
        });
    webrtc::PeerConnectionInterface::RTCConfiguration cfg;
    cfg.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    webrtc::PeerConnectionDependencies deps(client_obs.get());
    client_pc = client_factory->CreatePeerConnectionOrError(cfg, std::move(deps))
                    .value();
    webrtc::RtpTransceiverInit recvonly;
    recvonly.direction = webrtc::RtpTransceiverDirection::kRecvOnly;
    client_pc->AddTransceiver(webrtc::MediaType::VIDEO, recvonly);  // NO m=audio!

    std::mutex done_mu;
    std::condition_variable done_cv;
    bool got_answer = false;
    bool got_answer_ok = false;
    signaling_thread->PostTask([&]() {
      auto obs = webrtc::make_ref_counted<CreateOfferObs>(
          [&](std::unique_ptr<webrtc::SessionDescriptionInterface> offer) {
            std::string offer_sdp;
            offer->ToString(&offer_sdp);
            client_pc->SetLocalDescription(
                std::move(offer), webrtc::make_ref_counted<SetLocalObs>());
            session->ApplyOffer(offer_sdp, [&](bool ok, const std::string& ans) {
              if (!ok) {
                std::lock_guard<std::mutex> lock(done_mu);
                got_answer = true;
                got_answer_ok = false;
                done_cv.notify_all();
                return;
              }
              auto remote = webrtc::CreateSessionDescription(
                  webrtc::SdpType::kAnswer, ans);
              client_pc->SetRemoteDescription(
                  std::move(remote),
                  webrtc::make_ref_counted<SetRemoteObs>([&](bool set_ok) {
                    std::lock_guard<std::mutex> lock(done_mu);
                    got_answer = true;
                    got_answer_ok = set_ok;
                    done_cv.notify_all();
                  }));
            });
          });
      client_pc->CreateOffer(
          obs.get(), webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
    });
    {
      std::unique_lock<std::mutex> lock(done_mu);
      if (!done_cv.wait_for(lock, std::chrono::seconds(10),
                            [&] { return got_answer && got_answer_ok; })) {
        return 29;
      }
    }
    int w = 0, h = 0;
    if (!video_sink.WaitForFrame(std::chrono::seconds(15), &w, &h)) return 30;
    signaling_thread->BlockingCall([&]() {
      session->Stop();
      client_pc->Close();
      client_pc = nullptr;
    });
    signaling_thread->BlockingCall([]() {});
  }

  // --- Case 3: Wedged pa_simple_read subprocess never blocks Stop/SET_AUDIO(false) or concurrent video/control ---
  {
    rd::CaptureSubprocessSpec hung_spec;
    hung_spec.executable_path = "/proc/self/exe";
    hung_spec.args = {rd::kAudioCaptureHelperArg, "--mock-hung-read"};
    hung_spec.stop_grace = std::chrono::milliseconds(40);
    auto hung_capture = std::make_shared<rd::LinuxAudioCaptureCoordinator>(
        std::make_shared<imcodes::rd::AudioLoopbackBuffer>(),
        rd::PulseApiLoader{},
        std::chrono::milliseconds(2000),
        std::move(hung_spec));

    const std::string sid_a = "audio-qual-concurrent-video";
    const std::string sid_b = "audio-qual-hung-capture";
    VideoFrameSink video_sink_a;
    VideoFrameSink video_sink_b;
    ControlDcObserver dc_obs_b;
    std::unique_ptr<ClientObserver> client_obs_a;
    std::unique_ptr<ClientObserver> client_obs_b;
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> client_pc_a;
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> client_pc_b;
    std::shared_ptr<rd::LinuxRemoteDesktopSession> session_a;
    std::shared_ptr<rd::LinuxRemoteDesktopSession> session_b;

    auto adapters_a = rd::LinuxPlatformAdapters::Create(connection);
    auto adapters_b = rd::LinuxPlatformAdapters::Create(connection);
    if (!adapters_a || !adapters_b) return 30;
    auto topo_a_preview = adapters->display().EnumerateTopology();
    if (!topo_a_preview || topo_a_preview->displays.empty()) return 30;
    const std::string display_id_a = topo_a_preview->displays.front().display_id;

    session_a = rd::LinuxRemoteDesktopSession::Create(
        server_factory, *adapters_a, signaling_thread.get(),
        [&](const std::string& mid, const std::string& sdp) {
          signaling_thread->PostTask([&client_pc_a, mid, sdp]() {
            if (!client_pc_a) return;
            if (auto c = webrtc::IceCandidate::Create(mid, 0, sdp)) {
              client_pc_a->AddIceCandidate(std::move(c), [](webrtc::RTCError) {});
            }
          });
        },
        audio_capture);
    session_b = rd::LinuxRemoteDesktopSession::Create(
        server_factory, *adapters_b, signaling_thread.get(),
        [&](const std::string& mid, const std::string& sdp) {
          signaling_thread->PostTask([&client_pc_b, mid, sdp]() {
            if (!client_pc_b) return;
            if (auto c = webrtc::IceCandidate::Create(mid, 0, sdp)) {
              client_pc_b->AddIceCandidate(std::move(c), [](webrtc::RTCError) {});
            }
          });
        },
        hung_capture);

    if (!session_a->Start(make_authority(sid_a, common::TransportSessionMode::kControl, 1), now_time()) ||
        !session_b->Start(make_authority(sid_b, common::TransportSessionMode::kView, 1), now_time())) {
      return 31;
    }

    client_obs_a = std::make_unique<ClientObserver>(
        [&](const webrtc::IceCandidate* c) {
          auto mid = c->sdp_mid();
          auto sdp = c->ToString();
          signaling_thread->PostTask([&session_a, mid, sdp]() { session_a->AddRemoteIce(mid, sdp); });
        },
        [&](webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> tr) {
          if (tr->receiver()->track()->kind() == webrtc::MediaStreamTrackInterface::kVideoKind) {
            static_cast<webrtc::VideoTrackInterface*>(tr->receiver()->track().get())
                ->AddOrUpdateSink(&video_sink_a, webrtc::VideoSinkWants());
          }
        });
    client_obs_b = std::make_unique<ClientObserver>(
        [&](const webrtc::IceCandidate* c) {
          auto mid = c->sdp_mid();
          auto sdp = c->ToString();
          signaling_thread->PostTask([&session_b, mid, sdp]() { session_b->AddRemoteIce(mid, sdp); });
        },
        [&](webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> tr) {
          if (tr->receiver()->track()->kind() == webrtc::MediaStreamTrackInterface::kVideoKind) {
            static_cast<webrtc::VideoTrackInterface*>(tr->receiver()->track().get())
                ->AddOrUpdateSink(&video_sink_b, webrtc::VideoSinkWants());
          }
        });

    webrtc::PeerConnectionInterface::RTCConfiguration cfg;
    cfg.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    client_pc_a = client_factory->CreatePeerConnectionOrError(
        cfg, webrtc::PeerConnectionDependencies(client_obs_a.get())).value();
    client_pc_b = client_factory->CreatePeerConnectionOrError(
        cfg, webrtc::PeerConnectionDependencies(client_obs_b.get())).value();

    webrtc::RtpTransceiverInit recvonly;
    recvonly.direction = webrtc::RtpTransceiverDirection::kRecvOnly;
    client_pc_a->AddTransceiver(webrtc::MediaType::VIDEO, recvonly);
    client_pc_b->AddTransceiver(webrtc::MediaType::VIDEO, recvonly);
    client_pc_b->AddTransceiver(webrtc::MediaType::AUDIO, recvonly);
    auto dc_res_b = client_pc_b->CreateDataChannelOrError(imcodes::rd::kControlChannel, nullptr);
    if (!dc_res_b.ok()) return 32;
    dc_obs_b.Attach(dc_res_b.value());

    const auto connect_pair = [&](webrtc::PeerConnectionInterface* pc,
                                  rd::LinuxRemoteDesktopSession* sess) -> bool {
      std::mutex mu;
      std::condition_variable cv;
      bool done = false;
      bool ok = false;
      signaling_thread->PostTask([&]() {
        auto obs = webrtc::make_ref_counted<CreateOfferObs>(
            [&](std::unique_ptr<webrtc::SessionDescriptionInterface> offer) {
              std::string offer_sdp;
              offer->ToString(&offer_sdp);
              pc->SetLocalDescription(std::move(offer), webrtc::make_ref_counted<SetLocalObs>());
              sess->ApplyOffer(offer_sdp, [&](bool ans_ok, const std::string& ans) {
                if (!ans_ok) {
                  std::lock_guard<std::mutex> l(mu);
                  done = true;
                  ok = false;
                  cv.notify_all();
                  return;
                }
                auto remote = webrtc::CreateSessionDescription(webrtc::SdpType::kAnswer, ans);
                pc->SetRemoteDescription(
                    std::move(remote),
                    webrtc::make_ref_counted<SetRemoteObs>([&](bool set_ok) {
                      std::lock_guard<std::mutex> l(mu);
                      done = true;
                      ok = set_ok;
                      cv.notify_all();
                    }));
              });
            });
        pc->CreateOffer(obs.get(), webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
      });
      std::unique_lock<std::mutex> l(mu);
      return cv.wait_for(l, std::chrono::seconds(10), [&] { return done && ok; });
    };

    if (!connect_pair(client_pc_a.get(), session_a.get()) ||
        !connect_pair(client_pc_b.get(), session_b.get())) {
      return 33;
    }
    int wa = 0, ha = 0, wb = 0, hb = 0;
    if (!video_sink_a.WaitForFrame(std::chrono::seconds(15), &wa, &ha) ||
        !video_sink_b.WaitForFrame(std::chrono::seconds(15), &wb, &hb)) {
      return 34;
    }
    if (!dc_obs_b.WaitOpen(std::chrono::seconds(5))) return 35;

    // Enable audio on B whose helper hangs indefinitely inside pa_simple_read.
    if (!dc_obs_b.SendJson(MakeSetAudioControl(sid_b, 1, 1, true))) return 36;
    bool b_enabled = false;
    for (int i = 0; i < 60; ++i) {
      if (session_b->audio_enabled() && hung_capture->active_sessions() == 1) {
        b_enabled = true;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(15));
    }
    if (!b_enabled) return 37;
    std::this_thread::sleep_for(std::chrono::milliseconds(80));

    // Disabling audio on B & stopping B must return in bounded time (<400ms)
    // even while pa_simple_read is wedged forever, and must NOT stall session A!
    const auto t_cancel0 = std::chrono::steady_clock::now();
    if (!dc_obs_b.SendJson(MakeSetAudioControl(sid_b, 2, 1, false))) return 38;
    bool b_disabled = false;
    for (int i = 0; i < 40; ++i) {
      if (!session_b->audio_enabled() && hung_capture->active_sessions() == 0 &&
          !hung_capture->buffer()->enabled() && !hung_capture->capture().enabled()) {
        b_disabled = true;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    const auto cancel_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t_cancel0).count();
    if (!b_disabled || cancel_ms >= 500) {
      std::fprintf(stderr, "FAILED: wedged read SET_AUDIO(false) stalled (%lldms)\n",
                   static_cast<long long>(cancel_ms));
      return 39;
    }

    // Re-enable wedged capture on B, then Stop() B on signaling thread -> bounded teardown!
    if (!dc_obs_b.SendJson(MakeSetAudioControl(sid_b, 3, 1, true))) return 40;
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
    const auto t_stop0 = std::chrono::steady_clock::now();
    signaling_thread->BlockingCall([&]() {
      session_b->Stop();
      client_pc_b->Close();
      client_pc_b = nullptr;
    });
    signaling_thread->BlockingCall([]() {});
    const auto stop_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t_stop0).count();
    if (!session_b->closed() || hung_capture->active_sessions() != 0 ||
        hung_capture->buffer()->enabled() || hung_capture->capture().enabled() ||
        stop_ms >= 500) {
      std::fprintf(stderr, "FAILED: wedged read session->Stop() stalled (%lldms)\n",
                   static_cast<long long>(stop_ms));
      return 41;
    }

    // Verify session A keeps receiving video and can apply control input!
    if (!video_sink_a.WaitForMoreFrames(2, std::chrono::seconds(5))) {
      std::fprintf(stderr, "FAILED: concurrent session A video stalled after B wedged capture\n");
      return 42;
    }
    common::InputResult move_result = common::InputResult::kTerminal;
    signaling_thread->BlockingCall([&]() {
      common::PointerMove move;
      move.stamp = common::InputStamp{"ctrl", 1, 1, 1};
      move.display_id = display_id_a;
      move.normalized_x = 0.5;
      move.normalized_y = 0.5;
      move_result = session_a->ApplyPointerMove(move);
    });
    if (move_result != common::InputResult::kApplied) {
      std::fprintf(stderr, "FAILED: concurrent session A control input failed (rc=%d)\n",
                   static_cast<int>(move_result));
      return 43;
    }
    std::fprintf(stderr, "SESSION_HUNG_CAPTURE_ISOLATION_OK: cancel=%lldms stop=%lldms\n",
                 static_cast<long long>(cancel_ms), static_cast<long long>(stop_ms));

    signaling_thread->BlockingCall([&]() {
      session_a->Stop();
      client_pc_a->Close();
      client_pc_a = nullptr;
    });
    signaling_thread->BlockingCall([]() {});
  }

  server_factory = nullptr;
  client_factory = nullptr;
  network_thread->Stop();
  worker_thread->Stop();
  signaling_thread->Stop();
  webrtc::CleanupSSL();
  std::printf("SESSION_LIVE_AUDIO_QUAL_PASSED\n");
  return 0;
}

class WorkerProcess {
 public:
  bool Start(const char* path) {
    int in_pipe[2];
    int out_pipe[2];
    if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0) return false;
    pid_ = fork();
    if (pid_ < 0) return false;
    if (pid_ == 0) {
      dup2(in_pipe[0], STDIN_FILENO);
      dup2(out_pipe[1], STDOUT_FILENO);
      close(in_pipe[0]);
      close(in_pipe[1]);
      close(out_pipe[0]);
      close(out_pipe[1]);
      execl(path, path, static_cast<char*>(nullptr));
      _exit(127);
    }
    close(in_pipe[0]);
    close(out_pipe[1]);
    stdin_fd_ = in_pipe[1];
    stdout_fp_ = fdopen(out_pipe[0], "r");
    return stdout_fp_ != nullptr;
  }

  void WriteLine(const std::string& line) {
    if (stdin_fd_ < 0) return;
    std::string payload = line + "\n";
    ssize_t off = 0;
    const ssize_t len = static_cast<ssize_t>(payload.size());
    while (off < len) {
      ssize_t n = write(stdin_fd_, payload.data() + off, len - off);
      if (n <= 0) break;
      off += n;
    }
  }

  void PumpOutput(std::function<void(const Json::Value&)> on_msg) {
    char buf[65536];
    while (stdout_fp_ && std::fgets(buf, sizeof(buf), stdout_fp_)) {
      Json::Value root;
      if (imcodes::rd::ParseJson(buf, &root)) on_msg(root);
    }
  }

  int StopAndWait() {
    if (stdin_fd_ >= 0) {
      close(stdin_fd_);
      stdin_fd_ = -1;
    }
    int status = -1;
    if (pid_ > 0) {
      waitpid(pid_, &status, 0);
      pid_ = -1;
    }
    if (stdout_fp_) {
      fclose(stdout_fp_);
      stdout_fp_ = nullptr;
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  }

  ~WorkerProcess() {
    if (stdin_fd_ >= 0) close(stdin_fd_);
    if (pid_ > 0) waitpid(pid_, nullptr, WNOHANG);
    if (stdout_fp_) fclose(stdout_fp_);
  }

 private:
  pid_t pid_ = -1;
  int stdin_fd_ = -1;
  FILE* stdout_fp_ = nullptr;
};

int RunWorkerAudio(const char* worker_path, bool expect_live_audio) {
  webrtc::InitializeSSL();
  WorkerProcess worker;
  if (!worker.Start(worker_path)) {
    std::fprintf(stderr, "FAILED: spawn %s\n", worker_path);
    return 40;
  }

  auto signaling_thread = webrtc::Thread::Create();
  signaling_thread->Start();
  auto worker_thread = webrtc::Thread::Create();
  worker_thread->Start();
  auto network_thread = webrtc::Thread::CreateWithSocketServer();
  network_thread->Start();

  webrtc::PeerConnectionFactoryDependencies deps;
  deps.network_thread = network_thread.get();
  deps.worker_thread = worker_thread.get();
  deps.signaling_thread = signaling_thread.get();
  deps.adm = webrtc::make_ref_counted<ClientPlayoutAdm>();
  deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  deps.video_encoder_factory = webrtc::CreateBuiltinVideoEncoderFactory();
  deps.video_decoder_factory = webrtc::CreateBuiltinVideoDecoderFactory();
  webrtc::EnableMedia(deps);
  auto factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
  if (!factory) return 41;

  VideoFrameSink video_sink;
  AudioFrameSink audio_sink;
  ControlDcObserver dc_obs;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> client_pc;
  const std::string kSessionId =
      expect_live_audio ? "worker-audio-live-1" : "worker-audio-headless-1";
  const std::string kCapability = "worker-qual-capability-token-0123456789abcd";
  const std::string kRequestId = "worker-audio-req-1";

  std::mutex mu;
  std::condition_variable cv;
  bool got_answer = false;
  bool got_answer_ok = false;

  std::thread pump([&]() {
    worker.PumpOutput([&](const Json::Value& message) {
      const std::string type =
          message["type"].isString() ? message["type"].asString() : "";
      if (type == imcodes::rd::kAnswerType) {
        auto remote_answer = webrtc::CreateSessionDescription(
            webrtc::SdpType::kAnswer, message["sdp"].asString());
        signaling_thread->PostTask(
            [&client_pc, &mu, &cv, &got_answer, &got_answer_ok,
             ans = std::move(remote_answer)]() mutable {
              client_pc->SetRemoteDescription(
                  std::move(ans),
                  webrtc::make_ref_counted<SetRemoteObs>([&](bool ok) {
                    std::lock_guard<std::mutex> lock(mu);
                    got_answer = true;
                    got_answer_ok = ok;
                    cv.notify_all();
                  }));
            });
      } else if (type == imcodes::rd::kIceType) {
        const std::string mid = message["mid"].asString();
        const std::string cand = message["candidate"].asString();
        signaling_thread->PostTask([&client_pc, mid, cand]() {
          if (auto c = webrtc::IceCandidate::Create(mid, 0, cand)) {
            client_pc->AddIceCandidate(std::move(c), [](webrtc::RTCError) {});
          }
        });
      }
    });
  });
  pump.detach();

  auto obs = webrtc::make_ref_counted<ClientObserver>(
      [&](const webrtc::IceCandidate* c) {
        Json::Value ice(Json::objectValue);
        ice["type"] = imcodes::rd::kIceType;
        ice["requestId"] = kRequestId;
        ice["sessionId"] = kSessionId;
        ice["capability"] = kCapability;
        ice["mid"] = c->sdp_mid();
        std::string sdp;
        c->ToString(&sdp);
        ice["candidate"] = sdp;
        worker.WriteLine(imcodes::rd::WriteJson(ice));
      },
      [&](webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> tr) {
        auto track = tr->receiver()->track();
        if (track->kind() == webrtc::MediaStreamTrackInterface::kVideoKind) {
          static_cast<webrtc::VideoTrackInterface*>(track.get())
              ->AddOrUpdateSink(&video_sink, webrtc::VideoSinkWants());
        } else if (track->kind() ==
                   webrtc::MediaStreamTrackInterface::kAudioKind) {
          static_cast<webrtc::AudioTrackInterface*>(track.get())
              ->AddSink(&audio_sink);
        }
      });

  webrtc::PeerConnectionInterface::RTCConfiguration cfg;
  cfg.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  webrtc::PeerConnectionDependencies pc_deps(obs.get());
  client_pc =
      factory->CreatePeerConnectionOrError(cfg, std::move(pc_deps)).value();
  webrtc::RtpTransceiverInit recvonly;
  recvonly.direction = webrtc::RtpTransceiverDirection::kRecvOnly;
  client_pc->AddTransceiver(webrtc::MediaType::VIDEO, recvonly);
  client_pc->AddTransceiver(webrtc::MediaType::AUDIO, recvonly);
  auto dc_res =
      client_pc->CreateDataChannelOrError(imcodes::rd::kControlChannel, nullptr);
  if (!dc_res.ok()) return 42;
  dc_obs.Attach(dc_res.value());

  const int64_t now_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count();
  Json::Value prepare(Json::objectValue);
  prepare["type"] = imcodes::rd::kPrepareType;
  prepare["requestId"] = kRequestId;
  prepare["sessionId"] = kSessionId;
  prepare["capability"] = kCapability;
  prepare["expiresAt"] = static_cast<Json::Int64>(now_ms + 60'000);
  prepare["leaseExpiresAt"] = static_cast<Json::Int64>(now_ms + 60'000);
  prepare["daemonGeneration"] = 1;
  prepare["mode"] = imcodes::rd::kViewMode;
  prepare["inputEpoch"] = 1;
  Json::Value ice_servers(Json::arrayValue);
  ice_servers.append("stun:stun.l.google.com:19302");
  prepare["iceServers"] = ice_servers;
  worker.WriteLine(imcodes::rd::WriteJson(prepare));

  signaling_thread->PostTask([&]() {
    auto co = webrtc::make_ref_counted<CreateOfferObs>(
        [&](std::unique_ptr<webrtc::SessionDescriptionInterface> offer) {
          std::string sdp;
          offer->ToString(&sdp);
          client_pc->SetLocalDescription(
              std::move(offer), webrtc::make_ref_counted<SetLocalObs>());
          Json::Value offer_msg(Json::objectValue);
          offer_msg["type"] = imcodes::rd::kOfferType;
          offer_msg["requestId"] = kRequestId;
          offer_msg["sessionId"] = kSessionId;
          offer_msg["capability"] = kCapability;
          offer_msg["sdp"] = sdp;
          worker.WriteLine(imcodes::rd::WriteJson(offer_msg));
        });
    client_pc->CreateOffer(
        co.get(), webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
  });

  {
    std::unique_lock<std::mutex> lock(mu);
    if (!cv.wait_for(lock, std::chrono::seconds(10),
                     [&] { return got_answer && got_answer_ok; })) {
      return 43;
    }
  }
  int w = 0, h = 0;
  if (!video_sink.WaitForFrame(std::chrono::seconds(15), &w, &h)) return 44;
  if (!dc_obs.WaitOpen(std::chrono::seconds(5))) return 45;

  if (!dc_obs.SendJson(MakeSetAudioControl(kSessionId, 1, 1, true))) return 46;
  if (expect_live_audio) {
    int peak = 0;
    int rate = 0;
    size_t ch = 0;
    if (!audio_sink.WaitForNonZeroAudio(std::chrono::seconds(10), &peak, &rate,
                                        &ch)) {
      std::fprintf(stderr, "FAILED: worker live audio did not produce non-zero PCM\n");
      return 47;
    }
    if (!dc_obs.SendJson(MakeSetAudioControl(kSessionId, 2, 1, false))) {
      return 48;
    }
    // Allow Opus encoder / NetEq PLC fadeout (~500ms) to settle to silence.
    std::this_thread::sleep_for(std::chrono::milliseconds(600));
    const int post_off_peak =
        audio_sink.WaitAndSampleMaxPeak(std::chrono::milliseconds(250));
    if (post_off_peak >= 200) {
      std::fprintf(stderr,
                   "FAILED: worker audio kept sending non-zero PCM after set_audio(false) peak=%d\n",
                   post_off_peak);
      return 49;
    }
    std::printf("WORKER_LIVE_AUDIO_PASSED: video=%dx%d peak=%d post_off_peak=%d\n",
                w, h, peak, post_off_peak);
  } else {
    const int denied_peak =
        audio_sink.WaitAndSampleMaxPeak(std::chrono::milliseconds(350));
    if (denied_peak >= 200) {
      std::fprintf(stderr,
                   "FAILED: denied/headless worker unexpectedly produced audio peak=%d\n",
                   denied_peak);
      return 52;
    }
    if (!dc_obs.SendJson(MakeSetAudioControl(kSessionId, 2, 1, false))) {
      return 50;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    std::printf("WORKER_HEADLESS_AUDIO_FALLBACK_PASSED: video=%dx%d peak=%d\n",
                w, h, denied_peak);
  }

  Json::Value stop(Json::objectValue);
  stop["type"] = imcodes::rd::kStopType;
  stop["requestId"] = kRequestId;
  stop["sessionId"] = kSessionId;
  stop["capability"] = kCapability;
  worker.WriteLine(imcodes::rd::WriteJson(stop));
  std::this_thread::sleep_for(std::chrono::milliseconds(150));

  signaling_thread->BlockingCall([&]() {
    client_pc->Close();
    client_pc = nullptr;
  });
  signaling_thread->BlockingCall([]() {});
  const int rc = worker.StopAndWait();
  factory = nullptr;
  network_thread->Stop();
  worker_thread->Stop();
  signaling_thread->Stop();
  webrtc::CleanupSSL();
  if (rc != 0) {
    std::fprintf(stderr, "FAILED: worker exited with %d\n", rc);
    return 51;
  }
  return 0;
}

int RunWorkerDeferredAudio(const char* worker_path, const char* trigger_path) {
  webrtc::InitializeSSL();
  WorkerProcess worker;
  if (!worker.Start(worker_path)) {
    std::fprintf(stderr, "FAILED: could not spawn worker binary %s\n", worker_path);
    return 60;
  }

  auto signaling_thread = webrtc::Thread::Create();
  signaling_thread->Start();
  auto worker_thread = webrtc::Thread::Create();
  worker_thread->Start();
  auto network_thread = webrtc::Thread::CreateWithSocketServer();
  network_thread->Start();

  webrtc::PeerConnectionFactoryDependencies deps;
  deps.network_thread = network_thread.get();
  deps.worker_thread = worker_thread.get();
  deps.signaling_thread = signaling_thread.get();
  deps.adm = webrtc::make_ref_counted<ClientPlayoutAdm>();
  deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  deps.video_encoder_factory = webrtc::CreateBuiltinVideoEncoderFactory();
  deps.video_decoder_factory = webrtc::CreateBuiltinVideoDecoderFactory();
  webrtc::EnableMedia(deps);
  auto factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
  if (!factory) return 61;

  struct ActiveClient {
    std::string session_id;
    std::string capability;
    std::string request_id;
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc;
    std::mutex mu;
    std::condition_variable cv;
    bool got_answer = false;
    bool got_answer_ok = false;
  };
  std::mutex active_mu;
  ActiveClient* active = nullptr;

  std::thread pump([&]() {
    worker.PumpOutput([&](const Json::Value& message) {
      std::lock_guard<std::mutex> lock(active_mu);
      if (active == nullptr) return;
      const std::string type =
          message["type"].isString() ? message["type"].asString() : "";
      if (type == imcodes::rd::kAnswerType) {
        auto remote_answer = webrtc::CreateSessionDescription(
            webrtc::SdpType::kAnswer, message["sdp"].asString());
        ActiveClient* target = active;
        signaling_thread->PostTask(
            [target, ans = std::move(remote_answer)]() mutable {
              target->pc->SetRemoteDescription(
                  std::move(ans),
                  webrtc::make_ref_counted<SetRemoteObs>([target](bool ok) {
                    std::lock_guard<std::mutex> l(target->mu);
                    target->got_answer = true;
                    target->got_answer_ok = ok;
                    target->cv.notify_all();
                  }));
            });
      } else if (type == imcodes::rd::kIceType) {
        const std::string mid = message["mid"].asString();
        const std::string cand = message["candidate"].asString();
        ActiveClient* target = active;
        signaling_thread->PostTask([target, mid, cand]() {
          if (auto c = webrtc::IceCandidate::Create(mid, 0, cand)) {
            target->pc->AddIceCandidate(std::move(c), [](webrtc::RTCError) {});
          }
        });
      }
    });
  });
  pump.detach();

  const auto run_session = [&](const std::string& sid, bool expect_audio,
                               int* out_peak) -> int {
    VideoFrameSink video_sink;
    AudioFrameSink audio_sink;
    ControlDcObserver dc_obs;
    ActiveClient client;
    client.session_id = sid;
    client.capability = "worker-deferred-cap-0123456789abcdef0123456";
    client.request_id = "req-" + sid;
    {
      std::lock_guard<std::mutex> lock(active_mu);
      active = &client;
    }

    auto obs = webrtc::make_ref_counted<ClientObserver>(
        [&](const webrtc::IceCandidate* c) {
          Json::Value ice(Json::objectValue);
          ice["type"] = imcodes::rd::kIceType;
          ice["requestId"] = client.request_id;
          ice["sessionId"] = client.session_id;
          ice["capability"] = client.capability;
          ice["mid"] = c->sdp_mid();
          std::string sdp;
          c->ToString(&sdp);
          ice["candidate"] = sdp;
          worker.WriteLine(imcodes::rd::WriteJson(ice));
        },
        [&](webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> tr) {
          auto track = tr->receiver()->track();
          if (track->kind() == webrtc::MediaStreamTrackInterface::kVideoKind) {
            static_cast<webrtc::VideoTrackInterface*>(track.get())
                ->AddOrUpdateSink(&video_sink, webrtc::VideoSinkWants());
          } else if (track->kind() ==
                     webrtc::MediaStreamTrackInterface::kAudioKind) {
            static_cast<webrtc::AudioTrackInterface*>(track.get())
                ->AddSink(&audio_sink);
          }
        });

    webrtc::PeerConnectionInterface::RTCConfiguration cfg;
    cfg.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    client.pc = factory->CreatePeerConnectionOrError(
        cfg, webrtc::PeerConnectionDependencies(obs.get())).value();
    webrtc::RtpTransceiverInit recvonly;
    recvonly.direction = webrtc::RtpTransceiverDirection::kRecvOnly;
    client.pc->AddTransceiver(webrtc::MediaType::VIDEO, recvonly);
    client.pc->AddTransceiver(webrtc::MediaType::AUDIO, recvonly);
    auto dc_res = client.pc->CreateDataChannelOrError(imcodes::rd::kControlChannel, nullptr);
    if (!dc_res.ok()) return 62;
    dc_obs.Attach(dc_res.value());

    const int64_t now_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count();
    Json::Value prepare(Json::objectValue);
    prepare["type"] = imcodes::rd::kPrepareType;
    prepare["requestId"] = client.request_id;
    prepare["sessionId"] = client.session_id;
    prepare["capability"] = client.capability;
    prepare["expiresAt"] = static_cast<Json::Int64>(now_ms + 60'000);
    prepare["leaseExpiresAt"] = static_cast<Json::Int64>(now_ms + 60'000);
    prepare["daemonGeneration"] = 1;
    prepare["mode"] = imcodes::rd::kViewMode;
    prepare["inputEpoch"] = 1;
    Json::Value ice_servers(Json::arrayValue);
    ice_servers.append("stun:stun.l.google.com:19302");
    prepare["iceServers"] = ice_servers;
    worker.WriteLine(imcodes::rd::WriteJson(prepare));

    signaling_thread->PostTask([&]() {
      auto co = webrtc::make_ref_counted<CreateOfferObs>(
          [&](std::unique_ptr<webrtc::SessionDescriptionInterface> offer) {
            std::string sdp;
            offer->ToString(&sdp);
            client.pc->SetLocalDescription(
                std::move(offer), webrtc::make_ref_counted<SetLocalObs>());
            Json::Value offer_msg(Json::objectValue);
            offer_msg["type"] = imcodes::rd::kOfferType;
            offer_msg["requestId"] = client.request_id;
            offer_msg["sessionId"] = client.session_id;
            offer_msg["capability"] = client.capability;
            offer_msg["sdp"] = sdp;
            worker.WriteLine(imcodes::rd::WriteJson(offer_msg));
          });
      client.pc->CreateOffer(
          co.get(), webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
    });

    {
      std::unique_lock<std::mutex> lock(client.mu);
      if (!client.cv.wait_for(lock, std::chrono::seconds(10),
                              [&] { return client.got_answer && client.got_answer_ok; })) {
        return 63;
      }
    }
    int w = 0, h = 0;
    if (!video_sink.WaitForFrame(std::chrono::seconds(15), &w, &h)) return 64;
    if (!dc_obs.WaitOpen(std::chrono::seconds(5))) return 65;
    std::uint64_t layout_revision = 1;
    if (!dc_obs.WaitLayoutRevision(std::chrono::seconds(5), &layout_revision)) {
      return 65;
    }

    if (!dc_obs.SendJson(MakeSetAudioControl(sid, 1, 1, true, layout_revision))) {
      return 66;
    }
    if (expect_audio) {
      int rate = 0;
      size_t ch = 0;
      if (!audio_sink.WaitForNonZeroAudio(std::chrono::seconds(10), out_peak,
                                          &rate, &ch)) {
        return 67;
      }
      if (!dc_obs.SendJson(MakeSetAudioControl(sid, 2, 1, false, layout_revision))) {
        return 68;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(600));
      const int post_off = audio_sink.WaitAndSampleMaxPeak(std::chrono::milliseconds(250));
      if (post_off >= 200) return 69;
    } else {
      const int pre_peak = audio_sink.WaitAndSampleMaxPeak(std::chrono::milliseconds(300));
      *out_peak = pre_peak;
      if (pre_peak >= 200) return 70;
      if (!dc_obs.SendJson(MakeSetAudioControl(sid, 2, 1, false, layout_revision))) {
        return 71;
      }
    }

    Json::Value stop(Json::objectValue);
    stop["type"] = imcodes::rd::kStopType;
    stop["requestId"] = client.request_id;
    stop["sessionId"] = client.session_id;
    stop["capability"] = client.capability;
    worker.WriteLine(imcodes::rd::WriteJson(stop));
    std::this_thread::sleep_for(std::chrono::milliseconds(150));

    {
      std::lock_guard<std::mutex> lock(active_mu);
      active = nullptr;
    }
    signaling_thread->BlockingCall([&]() {
      client.pc->Close();
      client.pc = nullptr;
    });
    signaling_thread->BlockingCall([]() {});
    return 0;
  };

  int pre_peak = 0;
  const int rc1 = run_session("worker-deferred-1", false, &pre_peak);
  if (rc1 != 0) return rc1;

  std::fprintf(stderr, "WAITING_FOR_SOCKET_READY\n");
  std::fflush(stderr);
  bool ready = false;
  for (int i = 0; i < 300; ++i) {
    if (::access(trigger_path, F_OK) == 0) {
      ready = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (!ready) return 72;

  int live_peak = 0;
  const int rc2 = run_session("worker-deferred-2", true, &live_peak);
  if (rc2 != 0) return rc2;

  const int rc = worker.StopAndWait();
  factory = nullptr;
  network_thread->Stop();
  worker_thread->Stop();
  signaling_thread->Stop();
  webrtc::CleanupSSL();
  if (rc != 0) return 73;
  std::printf("WORKER_DEFERRED_SOCKET_AUDIO_PASSED: pre_peak=%d live_peak=%d\n",
              pre_peak, live_peak);
  return 0;
}

}  // namespace

int RunMockHungReadHelper(int argc, char** argv) {
  auto loader = []() -> rd::PulseSimpleApi {
    rd::PulseSimpleApi api;
    api.pa_simple_new = [](const char*, const char*, std::int32_t, const char*,
                           const char*, const rd::PulseSampleSpec*, const void*,
                           const rd::PulseBufferAttr*, int*) -> rd::PulseSimpleHandle* {
      return reinterpret_cast<rd::PulseSimpleHandle*>(
          static_cast<std::uintptr_t>(0x9abc));
    };
    api.pa_simple_read = [](rd::PulseSimpleHandle*, void*, std::size_t, int*) -> int {
      for (int i = 0; i < 600; ++i) {
        ::sleep(60);
      }
      return -1;
    };
    api.pa_simple_free = [](rd::PulseSimpleHandle*) {};
    return api;
  };
  return rd::RunPulseCaptureHelperMain(argc, argv, loader);
}

int main(int argc, char** argv) {
  if (argc >= 2 && std::strcmp(argv[1], rd::kAudioCaptureHelperArg) == 0) {
    if (argc >= 3 && std::strcmp(argv[2], "--mock-hung-read") == 0) {
      return RunMockHungReadHelper(argc, argv);
    }
    return rd::RunPulseCaptureHelperMain(argc, argv);
  }
  rd::EnableSelfAudioCaptureHelper();
  if (argc >= 2 && std::strcmp(argv[1], "--session-live") == 0) {
    return RunSessionLive();
  }
  if (argc >= 3 && std::strcmp(argv[1], "--worker-audio") == 0) {
    return RunWorkerAudio(argv[2], true);
  }
  if (argc >= 3 && std::strcmp(argv[1], "--worker-headless") == 0) {
    return RunWorkerAudio(argv[2], false);
  }
  if (argc >= 4 && std::strcmp(argv[1], "--worker-deferred-audio") == 0) {
    return RunWorkerDeferredAudio(argv[2], argv[3]);
  }
  std::fprintf(stderr,
               "usage: %s --session-live | --worker-audio <bin> | --worker-headless <bin> | --worker-deferred-audio <bin> <trigger>\n",
               argv[0]);
  return 2;
}
