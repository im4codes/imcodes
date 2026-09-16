// Linux-only, on-host qualification of LinuxRemoteDesktopSession, driven
// through its REAL public API only (Start, ApplyOffer, AddRemoteIce, the
// emit-ICE callback) from a separate "client" PeerConnection representing
// whatever real signaling would otherwise deliver these messages -- proving
// common::TransportSessionCore (the SAME state machine macOS/Windows
// production code uses) genuinely drives a real libwebrtc PeerConnection
// through the Linux adapters end to end, not just that the codec pipeline
// works in isolation (already proven by
// linux-remote-desktop-webrtc-loopback-qualification.cc). Exit 0 means the
// session qualified; any other exit names the failure.
//
// NOT exercised here, deliberately deferred (see
// linux_remote_desktop_session.h's own header comment): the data-channel
// wire protocol (pointer/keyboard/clipboard), so this client only adds a
// receive-only video transceiver and no data channels --
// `required_channels_ready` in the printed diagnostics is correctly 0.
//
// Build (same SDK-artifact recipe as the loopback qualification; see that
// file's header for the full explanation), all one line:
//
//   <same FLAGS/CLANG_MAJOR setup, then:>
//   toolchain/bin/clang --driver-mode=g++ ... \
//     <repo-root>/test/spec/linux-remote-desktop-session-qualification.cc \
//     <repo-root>/native/remote-desktop-common/{value_types,session_core,transport_session_core,input_ledger,quality_ladder}.cc \
//     <repo-root>/native/linux-remote-desktop/linux_{capability_probe,capture_selection,platform_adapters,x11_backend,native_video_source,remote_desktop_session}.cc \
//     lib/libimcodes_linux_libwebrtc_sdk.a lib/libimcodes_linux_libcxx_runtime_sdk.a lib/libjsoncpp.a \
//     -lX11 -lXext -lXtst -lXfixes -lXrandr -lpthread -ldl -o session-qual
//
// Then: DISPLAY=:0 ./session-qual
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/peer_connection_interface.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "rtc_base/ssl_adapter.h"

#include "../../native/linux-remote-desktop/linux_platform_adapters.h"
#include "../../native/linux-remote-desktop/linux_remote_desktop_session.h"

namespace rd = imcodes::remote_desktop::linux_platform;
namespace common = imcodes::remote_desktop::common;

namespace {

class SetLocalObs : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    if (!error.ok()) std::fprintf(stderr, "client SetLocalDescription: %s\n", error.message());
  }
};
class SetRemoteObs : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  explicit SetRemoteObs(std::function<void(bool)> on_done) : on_done_(std::move(on_done)) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override { on_done_(error.ok()); }
 private:
  std::function<void(bool)> on_done_;
};
class CreateOfferObs : public webrtc::CreateSessionDescriptionObserver {
 public:
  explicit CreateOfferObs(std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>)> on_success)
      : on_success_(std::move(on_success)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
    on_success_(std::unique_ptr<webrtc::SessionDescriptionInterface>(desc));
  }
  void OnFailure(webrtc::RTCError error) override { std::fprintf(stderr, "client CreateOffer: %s\n", error.message()); }
 private:
  std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>)> on_success_;
};

class FrameSink : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  void OnFrame(const webrtc::VideoFrame& frame) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!seen_) { seen_ = true; width_ = frame.width(); height_ = frame.height(); cv_.notify_all(); }
  }
  bool WaitForFrame(std::chrono::milliseconds timeout, int* w, int* h) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!cv_.wait_for(lock, timeout, [this] { return seen_; })) return false;
    *w = width_; *h = height_;
    return true;
  }
 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  bool seen_ = false;
  int width_ = 0, height_ = 0;
};

class ClientObserver : public webrtc::PeerConnectionObserver {
 public:
  ClientObserver(std::function<void(const webrtc::IceCandidate*)> on_ice,
                std::function<void(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>)> on_track)
      : on_ice_(std::move(on_ice)), on_track_(std::move(on_track)) {}
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState) override {}
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override { on_ice_(candidate); }
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState state) override {
    std::fprintf(stderr, "client: connection state=%d\n", static_cast<int>(state));
  }
  void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) override {
    on_track_(transceiver);
  }
 private:
  std::function<void(const webrtc::IceCandidate*)> on_ice_;
  std::function<void(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>)> on_track_;
};

}  // namespace

int main() {
  webrtc::InitializeSSL();

  auto connection = rd::X11Connection::Open();
  if (!connection) { std::fprintf(stderr, "cannot open X display\n"); return 10; }
  auto adapters = rd::LinuxPlatformAdapters::Create(connection);
  if (!adapters) { std::fprintf(stderr, "LinuxPlatformAdapters::Create failed\n"); return 11; }

  auto signaling_thread = webrtc::Thread::Create();
  signaling_thread->Start();
  auto worker_thread = webrtc::Thread::Create();
  worker_thread->Start();
  auto network_thread = webrtc::Thread::CreateWithSocketServer();
  network_thread->Start();

  webrtc::PeerConnectionFactoryDependencies factory_deps;
  factory_deps.network_thread = network_thread.get();
  factory_deps.worker_thread = worker_thread.get();
  factory_deps.signaling_thread = signaling_thread.get();
  factory_deps.audio_encoder_factory = webrtc::CreateBuiltinAudioEncoderFactory();
  factory_deps.audio_decoder_factory = webrtc::CreateBuiltinAudioDecoderFactory();
  factory_deps.video_encoder_factory = webrtc::CreateBuiltinVideoEncoderFactory();
  factory_deps.video_decoder_factory = webrtc::CreateBuiltinVideoDecoderFactory();
  webrtc::EnableMedia(factory_deps);
  auto factory = webrtc::CreateModularPeerConnectionFactory(std::move(factory_deps));
  if (!factory) { std::fprintf(stderr, "CreatePeerConnectionFactory failed\n"); return 12; }

  // --- the session under test: the "worker" side, driven only through its
  // real public API from here on. ---
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> client_pc;
  auto session = rd::LinuxRemoteDesktopSession::Create(
      factory, *adapters, signaling_thread.get(),
      [&](const std::string& mid, const std::string& sdp) {
        signaling_thread->PostTask([&client_pc, mid, sdp]() {
          auto candidate = webrtc::IceCandidate::Create(mid, 0, sdp);
          if (candidate) {
            client_pc->AddIceCandidate(std::move(candidate), [](webrtc::RTCError e) {
              if (!e.ok()) std::fprintf(stderr, "client AddIceCandidate: %s\n", e.message());
            });
          }
        });
      });

  common::RouteAuthority authority;
  authority.identity.request_id = "req-1";
  authority.identity.session_id = "sess-1";
  authority.identity.negotiated_capability_binding = "cap-1";
  authority.identity.daemon_generation = 1;
  authority.identity.route_generation = 1;
  authority.mode = common::TransportSessionMode::kView;
  authority.input_epoch = 1;
  const int64_t now_unix_ms = 1'700'000'000'000;
  authority.expires_at_unix_ms = now_unix_ms + 60'000;
  authority.lease_expires_at_unix_ms = now_unix_ms + 60'000;
  common::TransportTime now{now_unix_ms, 0};

  if (!session->Start(authority, now)) {
    std::fprintf(stderr, "session->Start failed\n");
    return 13;
  }

  // --- the client side: an ordinary PeerConnection representing whatever
  // real signaling would otherwise carry these messages. ---
  webrtc::PeerConnectionInterface::RTCConfiguration client_config;
  client_config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  FrameSink sink;
  std::mutex attach_mutex;
  std::condition_variable attach_cv;
  bool sink_attached = false;
  auto client_observer = std::make_unique<ClientObserver>(
      [&](const webrtc::IceCandidate* candidate) {
        auto mid = candidate->sdp_mid();
        auto sdp = candidate->ToString();
        signaling_thread->PostTask([&session, mid, sdp]() { session->AddRemoteIce(mid, sdp); });
      },
      [&](webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) {
        auto* video_track = static_cast<webrtc::VideoTrackInterface*>(
            transceiver->receiver()->track().get());
        video_track->AddOrUpdateSink(&sink, webrtc::VideoSinkWants());
        std::lock_guard<std::mutex> lock(attach_mutex);
        sink_attached = true;
        attach_cv.notify_all();
      });
  webrtc::PeerConnectionDependencies client_deps(client_observer.get());
  auto client_result = factory->CreatePeerConnectionOrError(client_config, std::move(client_deps));
  if (!client_result.ok()) { std::fprintf(stderr, "client CreatePeerConnectionOrError failed\n"); return 14; }
  client_pc = client_result.value();
  // Unified Plan: a receive-only transceiver so the client actually offers
  // to receive video (it sends none of its own).
  client_pc->AddTransceiver(webrtc::MediaType::VIDEO,
                            webrtc::RtpTransceiverInit{});

  std::mutex done_mutex;
  std::condition_variable done_cv;
  bool got_answer = false;
  bool got_answer_ok = false;

  signaling_thread->PostTask([&]() {
    auto create_offer_observer = webrtc::make_ref_counted<CreateOfferObs>(
        [&](std::unique_ptr<webrtc::SessionDescriptionInterface> offer) {
          std::string offer_sdp;
          offer->ToString(&offer_sdp);
          client_pc->SetLocalDescription(std::move(offer), webrtc::make_ref_counted<SetLocalObs>());

          session->ApplyOffer(offer_sdp, [&](bool ok, const std::string& answer_sdp) {
            if (!ok) {
              std::lock_guard<std::mutex> lock(done_mutex);
              got_answer = true;
              got_answer_ok = false;
              done_cv.notify_all();
              return;
            }
            auto remote_answer = webrtc::CreateSessionDescription(webrtc::SdpType::kAnswer, answer_sdp);
            client_pc->SetRemoteDescription(
                std::move(remote_answer),
                webrtc::make_ref_counted<SetRemoteObs>([&](bool set_ok) {
                  std::lock_guard<std::mutex> lock(done_mutex);
                  got_answer = true;
                  got_answer_ok = set_ok;
                  done_cv.notify_all();
                }));
          });
        });
    client_pc->CreateOffer(create_offer_observer.get(),
                           webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
  });

  {
    std::unique_lock<std::mutex> lock(done_mutex);
    if (!done_cv.wait_for(lock, std::chrono::seconds(10), [&] { return got_answer; })) {
      std::fprintf(stderr, "offer/answer exchange timed out\n");
      return 15;
    }
    if (!got_answer_ok) {
      std::fprintf(stderr, "answer application failed\n");
      return 16;
    }
  }

  int width = 0, height = 0;
  if (!sink.WaitForFrame(std::chrono::seconds(15), &width, &height)) {
    std::fprintf(stderr, "FAILED: no decoded frame arrived at the client within 15s\n");
    return 17;
  }
  std::fprintf(stderr,
              "linux remote desktop session (real TransportSessionCore-driven API): ok -- received %dx%d\n",
              width, height);

  auto diagnostics = session->diagnostics();
  std::fprintf(stderr, "session diagnostics: peer_state=%d path=%d required_channels_ready=%d\n",
              static_cast<int>(diagnostics.peer_state), static_cast<int>(diagnostics.path),
              diagnostics.required_channels_ready);

  session->Stop();
  client_pc->Close();
  webrtc::CleanupSSL();
  return 0;
}
