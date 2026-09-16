// Linux-only, on-host qualification of the full media pipeline: real X11
// capture (the same adapters linux-remote-desktop-adapters-qualification.cc
// exercises) -> libwebrtc's own builtin video encoder -> a genuine loopback
// PeerConnection pair (offer/answer + ICE exchanged in-process, since this is
// a same-process proof, not a network signaling integration) -> decode -> a
// received VideoFrame with the right dimensions on the "far end". That is the
// actual claim "Linux remote desktop connects" makes; this is what verifies
// it. Exit 0 means the pipeline qualified end to end; any other exit names
// the failure.
//
// Unlike the other qualification binaries here, this one links the Linux
// libwebrtc SDK native/linux-remote-desktop/build-libwebrtc-sdk.sh produces,
// not just X11: build the SDK first, then (all one line, from the SDK
// artifact root, with its own toolchain and sdk-compile-flags.json --
// see that script's own header for exactly what those contain and why a
// hand-guessed flag set is not a substitute):
//
//   FLAGS=$(python3 -c 'import json,shlex; d=json.load(open("sdk-compile-flags.json")); \
//     print(" ".join(shlex.quote(f) for f in d["defines"]+["-I"+p for p in d["includeDirs"]]+ \
//     ["-isystem"+p for p in d["systemIncludeDirs"]]+d["compileFlags"]+d["cxxFlags"]))')
//   CLANG_MAJOR=$(basename $(find toolchain/lib/clang -mindepth 1 -maxdepth 1 -type d))
//   ln -sf lld toolchain/bin/ld.lld
//   toolchain/bin/clang --driver-mode=g++ -resource-dir="$PWD/toolchain/lib/clang/$CLANG_MAJOR" \
//     $FLAGS -I <repo-root> -B"$PWD/toolchain/bin" -fuse-ld=lld \
//     <repo-root>/test/spec/linux-remote-desktop-webrtc-loopback-qualification.cc \
//     <repo-root>/native/remote-desktop-common/value_types.cc \
//     <repo-root>/native/linux-remote-desktop/linux_{capability_probe,capture_selection,platform_adapters,x11_backend,native_video_source}.cc \
//     lib/libimcodes_linux_libwebrtc_sdk.a lib/libimcodes_linux_libcxx_runtime_sdk.a lib/libjsoncpp.a \
//     -lX11 -lXext -lXtst -lXfixes -lXrandr -lpthread -ldl -o loopback-qual
//
// Then run it against a real (or Xvfb) X server: DISPLAY=:0 ./loopback-qual
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/media_stream_interface.h"
#include "api/peer_connection_interface.h"
#include "api/rtp_transceiver_interface.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"
#include "rtc_base/ssl_adapter.h"

#include "../../native/linux-remote-desktop/linux_capability_probe.h"
#include "../../native/linux-remote-desktop/linux_platform_adapters.h"
#include "../../native/linux-remote-desktop/linux_native_video_source.h"

namespace rd = imcodes::remote_desktop::linux_platform;
namespace common = imcodes::remote_desktop::common;

namespace {

// --- glue: two PeerConnections in one process, ICE/SDP wired directly ------

class SetLocalObs : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  explicit SetLocalObs(const char* who) : who_(who) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    if (!error.ok()) {
      std::fprintf(stderr, "%s: SetLocalDescription failed: %s\n", who_,
                   error.message());
    }
  }
 private:
  const char* who_;
};

class SetRemoteObs : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  explicit SetRemoteObs(const char* who) : who_(who) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    if (!error.ok()) {
      std::fprintf(stderr, "%s: SetRemoteDescription failed: %s\n", who_,
                   error.message());
    }
  }
 private:
  const char* who_;
};

class Observer : public webrtc::PeerConnectionObserver {
 public:
  Observer(const char* who,
          std::function<void(std::unique_ptr<webrtc::IceCandidate>)> on_ice)
      : who_(who), on_ice_(std::move(on_ice)) {}

  void OnSignalingChange(
      webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>)
      override {}
  void OnIceGatheringChange(
      webrtc::PeerConnectionInterface::IceGatheringState state) override {
    std::fprintf(stderr, "%s: ice gathering state=%d\n", who_,
                static_cast<int>(state));
  }
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override {
    // IceCandidate is move-only with no Clone(); reconstruct an equivalent
    // one from its own SDP-ized string, the same thing a real signaling
    // channel would transmit and the far end would parse back.
    auto reconstructed = webrtc::IceCandidate::Create(
        candidate->sdp_mid(), candidate->sdp_mline_index(),
        candidate->ToString());
    if (reconstructed) on_ice_(std::move(reconstructed));
  }
  void OnConnectionChange(
      webrtc::PeerConnectionInterface::PeerConnectionState state) override {
    std::fprintf(stderr, "%s: connection state=%d\n", who_,
                static_cast<int>(state));
  }

 private:
  const char* who_;
  std::function<void(std::unique_ptr<webrtc::IceCandidate>)> on_ice_;
};

// Receives the decoded video on the "far end" and signals once a real,
// correctly-sized frame arrives.
class FrameSink : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  void OnFrame(const webrtc::VideoFrame& frame) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!seen_) {
      seen_ = true;
      width_ = frame.width();
      height_ = frame.height();
      cv_.notify_all();
    }
  }
  bool WaitForFrame(std::chrono::milliseconds timeout, int* width,
                    int* height) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!cv_.wait_for(lock, timeout, [this] { return seen_; })) return false;
    *width = width_;
    *height = height_;
    return true;
  }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  bool seen_ = false;
  int width_ = 0, height_ = 0;
};

class CreateSdpObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  explicit CreateSdpObserver(
      std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>)>
          on_success)
      : on_success_(std::move(on_success)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
    on_success_(std::unique_ptr<webrtc::SessionDescriptionInterface>(desc));
  }
  void OnFailure(webrtc::RTCError error) override {
    std::fprintf(stderr, "CreateOffer/Answer failed: %s\n", error.message());
  }

 private:
  std::function<void(std::unique_ptr<webrtc::SessionDescriptionInterface>)>
      on_success_;
};

}  // namespace

int main() {
  webrtc::InitializeSSL();

  // --- X11 platform adapters: the SAME code already qualified live on real
  // hardware earlier this session, unchanged here. ---
  auto connection = rd::X11Connection::Open();
  if (!connection) {
    std::fprintf(stderr, "cannot open X display\n");
    return 10;
  }
  auto adapters = rd::LinuxPlatformAdapters::Create(connection);
  if (!adapters) {
    std::fprintf(stderr, "LinuxPlatformAdapters::Create failed\n");
    return 11;
  }
  auto topology = adapters->display().EnumerateTopology();
  if (!topology || topology->displays.empty()) {
    std::fprintf(stderr, "no displays enumerated\n");
    return 12;
  }
  const common::DisplayTopology display = topology->displays[0];
  std::fprintf(stderr, "display: %s %dx%d\n", display.display_id.c_str(),
              display.encoded_pixels.width, display.encoded_pixels.height);

  rd::LinuxNativeCaptureAdapter native_capture(adapters->capture());
  auto lease = native_capture.Acquire(display);
  if (!lease->Start()) {
    std::fprintf(stderr, "capture lease Start() failed\n");
    return 13;
  }

  // --- one factory, two PeerConnections: sender (X11 video) and receiver. -
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
  if (!factory) {
    std::fprintf(stderr, "CreatePeerConnectionFactory failed\n");
    return 14;
  }

  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  // Loopback: no STUN/TURN needed, host candidates connect directly.

  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> sender_pc;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> receiver_pc;

  auto sender_observer = std::make_unique<Observer>(
      "sender", [&](std::unique_ptr<webrtc::IceCandidate> candidate) {
        signaling_thread->PostTask([&receiver_pc, c = std::move(candidate)]() mutable {
          receiver_pc->AddIceCandidate(std::move(c), [](webrtc::RTCError e) {
            if (!e.ok()) std::fprintf(stderr, "receiver AddIceCandidate: %s\n", e.message());
          });
        });
      });
  auto receiver_observer = std::make_unique<Observer>(
      "receiver", [&](std::unique_ptr<webrtc::IceCandidate> candidate) {
        signaling_thread->PostTask([&sender_pc, c = std::move(candidate)]() mutable {
          sender_pc->AddIceCandidate(std::move(c), [](webrtc::RTCError e) {
            if (!e.ok()) std::fprintf(stderr, "sender AddIceCandidate: %s\n", e.message());
          });
        });
      });

  webrtc::PeerConnectionDependencies sender_deps(sender_observer.get());
  webrtc::PeerConnectionDependencies receiver_deps(receiver_observer.get());

  auto sender_result = factory->CreatePeerConnectionOrError(config, std::move(sender_deps));
  auto receiver_result = factory->CreatePeerConnectionOrError(config, std::move(receiver_deps));
  if (!sender_result.ok() || !receiver_result.ok()) {
    std::fprintf(stderr, "CreatePeerConnectionOrError failed\n");
    return 15;
  }
  sender_pc = sender_result.value();
  receiver_pc = receiver_result.value();

  auto track = factory->CreateVideoTrack(
      webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface>(lease->source()),
      "x11video");
  auto add_track_result = sender_pc->AddTrack(track, {"x11stream"});
  if (!add_track_result.ok()) {
    std::fprintf(stderr, "AddTrack failed\n");
    return 16;
  }

  FrameSink sink;
  bool sink_attached = false;
  std::mutex attach_mutex;
  std::condition_variable attach_cv;

  // The receiver's OnTrack (delivered on the signaling thread) attaches the
  // sink once the remote track actually shows up.
  class TrackObserver : public Observer {
   public:
    TrackObserver(const char* who,
                 std::function<void(std::unique_ptr<webrtc::IceCandidate>)> on_ice,
                 std::function<void(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>)> on_track)
        : Observer(who, std::move(on_ice)), on_track_(std::move(on_track)) {}
    void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) override {
      on_track_(transceiver);
    }
   private:
    std::function<void(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>)> on_track_;
  };
  auto receiver_observer2 = std::make_unique<TrackObserver>(
      "receiver",
      [&](std::unique_ptr<webrtc::IceCandidate> candidate) {
        signaling_thread->PostTask([&sender_pc, c = std::move(candidate)]() mutable {
          sender_pc->AddIceCandidate(std::move(c), [](webrtc::RTCError e) {
            if (!e.ok()) std::fprintf(stderr, "sender AddIceCandidate: %s\n", e.message());
          });
        });
      },
      [&](webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) {
        auto* video_track = static_cast<webrtc::VideoTrackInterface*>(
            transceiver->receiver()->track().get());
        video_track->AddOrUpdateSink(&sink, webrtc::VideoSinkWants());
        std::lock_guard<std::mutex> lock(attach_mutex);
        sink_attached = true;
        attach_cv.notify_all();
      });
  // Recreate the receiver PC with the track-aware observer (simplest way to
  // avoid a forward-declared vtable dance for this one-shot proof program).
  receiver_pc = nullptr;
  webrtc::PeerConnectionDependencies receiver_deps2(receiver_observer2.get());
  auto receiver_result2 = factory->CreatePeerConnectionOrError(config, std::move(receiver_deps2));
  if (!receiver_result2.ok()) {
    std::fprintf(stderr, "CreatePeerConnectionOrError (receiver2) failed\n");
    return 17;
  }
  receiver_pc = receiver_result2.value();

  // --- offer/answer, driven from the signaling thread ----------------------
  std::mutex done_mutex;
  std::condition_variable done_cv;
  bool answer_set = false;

  signaling_thread->PostTask([&]() {
    auto create_offer_observer = webrtc::make_ref_counted<CreateSdpObserver>(
        [&](std::unique_ptr<webrtc::SessionDescriptionInterface> offer) {
          std::string offer_sdp;
          offer->ToString(&offer_sdp);
          sender_pc->SetLocalDescription(
              std::move(offer), webrtc::make_ref_counted<SetLocalObs>("sender"));

          auto remote_offer = webrtc::CreateSessionDescription(
              webrtc::SdpType::kOffer, offer_sdp);
          receiver_pc->SetRemoteDescription(
              std::move(remote_offer),
              webrtc::make_ref_counted<SetRemoteObs>("receiver"));

          auto create_answer_observer = webrtc::make_ref_counted<CreateSdpObserver>(
              [&](std::unique_ptr<webrtc::SessionDescriptionInterface> answer) {
                std::string answer_sdp;
                answer->ToString(&answer_sdp);
                receiver_pc->SetLocalDescription(
                    std::move(answer),
                    webrtc::make_ref_counted<SetLocalObs>("receiver"));

                auto remote_answer = webrtc::CreateSessionDescription(
                    webrtc::SdpType::kAnswer, answer_sdp);
                sender_pc->SetRemoteDescription(
                    std::move(remote_answer),
                    webrtc::make_ref_counted<SetRemoteObs>("sender"));
                std::lock_guard<std::mutex> lock(done_mutex);
                answer_set = true;
                done_cv.notify_all();
              });
          receiver_pc->CreateAnswer(create_answer_observer.get(),
                                    webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
        });
    sender_pc->CreateOffer(create_offer_observer.get(),
                           webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
  });

  {
    std::unique_lock<std::mutex> lock(done_mutex);
    if (!done_cv.wait_for(lock, std::chrono::seconds(10), [&] { return answer_set; })) {
      std::fprintf(stderr, "offer/answer exchange timed out\n");
      return 18;
    }
  }

  if (!lease->WaitForFirstFrame(std::chrono::seconds(5))) {
    std::fprintf(stderr, "no captured frame reached the video source\n");
    return 19;
  }
  std::fprintf(stderr, "captured %llu frame(s) into the video source\n",
              static_cast<unsigned long long>(lease->captured_frames()));

  int width = 0, height = 0;
  if (!sink.WaitForFrame(std::chrono::seconds(15), &width, &height)) {
    std::fprintf(stderr,
                "FAILED: no decoded frame arrived at the receiver within 15s\n");
    return 20;
  }
  std::fprintf(stderr, "linux remote desktop loopback: ok -- received %dx%d\n",
              width, height);

  sender_pc->Close();
  receiver_pc->Close();
  webrtc::CleanupSSL();
  return 0;
}
