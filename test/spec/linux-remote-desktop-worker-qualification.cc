// Out-of-process qualification for linux_remote_desktop_worker_main.cc:
// unlike linux-remote-desktop-session-qualification.cc (which drives
// LinuxRemoteDesktopSession's C++ API directly, in-process), this spawns the
// REAL worker executable as a child process and drives it only through its
// actual stdin/stdout JSON-line protocol -- the exact boundary
// LinuxRemoteDesktopWorkerHost (src/node/linux-remote-desktop-worker-host.ts)
// crosses. Proves the process-spawn/pipe/JSON-framing path genuinely works,
// not just the native session logic it wraps (already proven separately).
//
// Usage: linux-remote-desktop-worker-qualification <path-to-worker-binary>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

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

#include "../../native/remote-desktop-common/json_protocol.h"

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

/** Spawns the worker with real OS pipes wired to its stdin/stdout, exactly
 * as child_process.spawn() would from the TypeScript host. */
class WorkerProcess {
 public:
  bool Start(const char* path) {
    int in_pipe[2];   // parent writes[1] -> child reads[0] (child stdin)
    int out_pipe[2];  // child writes[1] -> parent reads[0] (child stdout)
    if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0) return false;
    pid_ = fork();
    if (pid_ < 0) return false;
    if (pid_ == 0) {
      dup2(in_pipe[0], STDIN_FILENO);
      dup2(out_pipe[1], STDOUT_FILENO);
      close(in_pipe[0]); close(in_pipe[1]);
      close(out_pipe[0]); close(out_pipe[1]);
      execl(path, path, static_cast<char*>(nullptr));
      _exit(127);
    }
    close(in_pipe[0]);
    close(out_pipe[1]);
    stdin_fd_ = in_pipe[1];
    stdout_fd_ = out_pipe[0];
    return true;
  }

  // Called from at least two independent threads in practice: the test's
  // main thread (PREPARE) and the client PeerConnection's own signaling
  // thread (OFFER, and every trickled ICE candidate, via
  // ClientObserver's callbacks -- always delivered on that thread by
  // libwebrtc's own contract, never the thread that registered them). Two
  // callers racing an unsynchronized multi-write() loop can genuinely
  // interleave their bytes on the pipe once a line crosses one write()'s
  // worth of kernel buffer space, corrupting JSON framing on the worker's
  // stdin in a way that does not reliably reproduce -- exactly the
  // "sometimes 0 ICE candidates, sometimes fine" symptom this mutex fixes.
  void WriteLine(const std::string& line) {
    const std::string framed = line + "\n";
    std::lock_guard<std::mutex> lock(write_mutex_);
    ssize_t remaining = static_cast<ssize_t>(framed.size());
    const char* cursor = framed.data();
    while (remaining > 0) {
      const ssize_t written = write(stdin_fd_, cursor, static_cast<size_t>(remaining));
      if (written <= 0) return;
      cursor += written;
      remaining -= written;
    }
  }

  /** Runs on its own thread: reads lines, dispatches by "type" field. */
  void PumpOutput(std::function<void(const Json::Value&)> on_message) {
    std::string buffer;
    char chunk[4096];
    for (;;) {
      const ssize_t got = read(stdout_fd_, chunk, sizeof(chunk));
      if (got <= 0) return;
      buffer.append(chunk, static_cast<size_t>(got));
      for (;;) {
        const auto newline = buffer.find('\n');
        if (newline == std::string::npos) break;
        const std::string line = buffer.substr(0, newline);
        buffer.erase(0, newline + 1);
        Json::Value value;
        if (imcodes::rd::ParseJson(line, &value)) on_message(value);
      }
    }
  }

  void Stop() {
    if (stdin_fd_ >= 0) close(stdin_fd_);
    if (pid_ > 0) { int status = 0; waitpid(pid_, &status, 0); }
  }

 private:
  pid_t pid_ = -1;
  int stdin_fd_ = -1;
  int stdout_fd_ = -1;
  std::mutex write_mutex_;
};

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: %s <worker-binary-path>\n", argv[0]); return 1; }
  webrtc::InitializeSSL();

  WorkerProcess worker;
  if (!worker.Start(argv[1])) { std::fprintf(stderr, "FAILED: could not spawn worker\n"); return 2; }

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
  if (!factory) { std::fprintf(stderr, "FAILED: client CreatePeerConnectionFactory failed\n"); return 3; }

  webrtc::PeerConnectionInterface::RTCConfiguration client_config;
  client_config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  FrameSink sink;
  bool sink_attached = false;
  std::mutex attach_mutex;
  std::condition_variable attach_cv;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> client_pc;

  const std::string kSessionId = "worker-qual-sess-1";
  // IsSafeCapability (json_protocol.cc) requires exactly 43 characters,
  // matching a real base64url-encoded 32-byte bearer token's length.
  const std::string kCapability = "worker-qual-capability-token-0123456789abcd";
  const std::string kRequestId = "worker-qual-req-1";

  auto client_observer = webrtc::make_ref_counted<ClientObserver>(
      [&](const webrtc::IceCandidate* candidate) {
        Json::Value ice(Json::objectValue);
        ice["type"] = imcodes::rd::kIceType;
        ice["requestId"] = kRequestId;
        ice["sessionId"] = kSessionId;
        ice["capability"] = kCapability;
        ice["mid"] = candidate->sdp_mid();
        std::string sdp;
        candidate->ToString(&sdp);
        ice["candidate"] = sdp;
        worker.WriteLine(imcodes::rd::WriteJson(ice));
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
  if (!client_result.ok()) { std::fprintf(stderr, "FAILED: client CreatePeerConnectionOrError failed\n"); return 4; }
  client_pc = client_result.value();
  // recvonly, not RtpTransceiverInit{}'s kSendRecv default: a real viewer
  // never sends video back, and offering sendrecv here makes the worker's
  // own answer negotiate an (unused, but real) receive pipeline alongside
  // its send one -- worth eliminating as a variable while chasing why the
  // connection closes right after DTLS completes.
  webrtc::RtpTransceiverInit recvonly;
  recvonly.direction = webrtc::RtpTransceiverDirection::kRecvOnly;
  client_pc->AddTransceiver(webrtc::MediaType::VIDEO, recvonly);

  std::mutex done_mutex;
  std::condition_variable done_cv;
  bool got_answer = false;
  bool got_answer_ok = false;

  // The worker's own stdout pump: dispatches ANSWER/ICE/STATUS/TERMINAL.
  // Detached, not joined at the end of main(): every early `return` on a
  // failure path (there are several below) would otherwise skip the join,
  // and a still-joinable std::thread's destructor calls std::terminate() --
  // a real SIGABRT/core dump this test hit on every failure path, with a
  // stack that has nothing to do with whatever the actual failure was.
  std::thread pump([&]() {
    worker.PumpOutput([&](const Json::Value& message) {
      const std::string type = message["type"].isString() ? message["type"].asString() : "";
      if (type == imcodes::rd::kAnswerType) {
        auto remote_answer = webrtc::CreateSessionDescription(
            webrtc::SdpType::kAnswer, message["sdp"].asString());
        signaling_thread->PostTask([&client_pc, &done_mutex, &done_cv, &got_answer,
                                   &got_answer_ok, answer = std::move(remote_answer)]() mutable {
          client_pc->SetRemoteDescription(
              std::move(answer),
              webrtc::make_ref_counted<SetRemoteObs>([&](bool ok) {
                std::lock_guard<std::mutex> lock(done_mutex);
                got_answer = true;
                got_answer_ok = ok;
                done_cv.notify_all();
              }));
        });
      } else if (type == imcodes::rd::kIceType) {
        const std::string mid = message["mid"].asString();
        const std::string candidate_sdp = message["candidate"].asString();
        signaling_thread->PostTask([&client_pc, mid, candidate_sdp]() {
          auto candidate = webrtc::IceCandidate::Create(mid, 0, candidate_sdp);
          if (candidate) {
            client_pc->AddIceCandidate(std::move(candidate), [](webrtc::RTCError e) {
              if (!e.ok()) std::fprintf(stderr, "client AddIceCandidate: %s\n", e.message());
            });
          }
        });
      } else if (type == imcodes::rd::kStatusType) {
        std::fprintf(stderr, "worker status: state=%s peerConnected=%s mediaStarted=%s\n",
                     message["state"].isString() ? message["state"].asCString() : "?",
                     message["peerConnected"].isBool() && message["peerConnected"].asBool() ? "true" : "false",
                     message["mediaStarted"].isBool() && message["mediaStarted"].asBool() ? "true" : "false");
      } else if (type == imcodes::rd::kTerminalType) {
        std::fprintf(stderr, "worker terminal: reason=%s\n",
                     message["reason"].isString() ? message["reason"].asCString() : "?");
      }
    });
  });
  pump.detach();

  // --- PREPARE ---
  // Must be real wall-clock time, not a fixed placeholder: the worker (a
  // separate process) validates expiresAt/leaseExpiresAt against its OWN
  // NowUnixMs() call (json_protocol.cc's ParseAuthorityFields), which the
  // in-process session-qualification test never has to satisfy since it
  // passes the same hardcoded "now" on both sides of one C++ call.
  const int64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  Json::Value prepare(Json::objectValue);
  prepare["type"] = imcodes::rd::kPrepareType;
  prepare["requestId"] = kRequestId;
  prepare["sessionId"] = kSessionId;
  prepare["capability"] = kCapability;
  // leaseExpiresAt must be within kLeaseMaxFutureMs (75s, json_protocol.cc)
  // of the worker's own now -- unlike the in-process session-qualification
  // test's 60s, which never crosses that check at all since it drives
  // TransportSessionCore's C++ API directly, this one goes through real
  // JSON validation.
  prepare["expiresAt"] = static_cast<Json::Int64>(now_ms + 60'000);
  prepare["leaseExpiresAt"] = static_cast<Json::Int64>(now_ms + 60'000);
  prepare["daemonGeneration"] = 1;
  prepare["mode"] = imcodes::rd::kViewMode;
  prepare["inputEpoch"] = 1;
  // ParseIceServers (json_protocol.cc) rejects an empty array -- a real
  // PREPARE always carries at least one server, so this must too, even for
  // a loopback test where the peers never actually need a STUN roundtrip.
  Json::Value ice_servers(Json::arrayValue);
  ice_servers.append("stun:stun.l.google.com:19302");
  prepare["iceServers"] = ice_servers;
  worker.WriteLine(imcodes::rd::WriteJson(prepare));

  // --- OFFER, once the client has created one ---
  signaling_thread->PostTask([&]() {
    auto create_offer_observer = webrtc::make_ref_counted<CreateOfferObs>(
        [&](std::unique_ptr<webrtc::SessionDescriptionInterface> offer) {
          std::string offer_sdp;
          offer->ToString(&offer_sdp);
          client_pc->SetLocalDescription(std::move(offer), webrtc::make_ref_counted<SetLocalObs>());

          Json::Value offer_msg(Json::objectValue);
          offer_msg["type"] = imcodes::rd::kOfferType;
          offer_msg["requestId"] = kRequestId;
          offer_msg["sessionId"] = kSessionId;
          offer_msg["capability"] = kCapability;
          offer_msg["sdp"] = offer_sdp;
          worker.WriteLine(imcodes::rd::WriteJson(offer_msg));
        });
    client_pc->CreateOffer(create_offer_observer.get(),
                           webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
  });

  {
    std::unique_lock<std::mutex> lock(done_mutex);
    if (!done_cv.wait_for(lock, std::chrono::seconds(10), [&] { return got_answer; })) {
      std::fprintf(stderr, "FAILED: offer/answer exchange (through the real worker process) timed out\n");
      return 5;
    }
    if (!got_answer_ok) { std::fprintf(stderr, "FAILED: answer application failed\n"); return 6; }
  }

  int width = 0, height = 0;
  if (!sink.WaitForFrame(std::chrono::seconds(15), &width, &height)) {
    std::fprintf(stderr, "FAILED: no decoded frame arrived from the real worker process within 15s\n");
    return 7;
  }
  std::fprintf(stderr,
              "linux remote desktop WORKER (out-of-process, real stdin/stdout protocol): ok -- received %dx%d\n",
              width, height);

  // --- STOP, then clean shutdown ---
  Json::Value stop(Json::objectValue);
  stop["type"] = imcodes::rd::kStopType;
  stop["requestId"] = kRequestId;
  stop["sessionId"] = kSessionId;
  stop["capability"] = kCapability;
  worker.WriteLine(imcodes::rd::WriteJson(stop));
  std::this_thread::sleep_for(std::chrono::milliseconds(200));

  client_pc->Close();
  worker.Stop();
  // pump is detached (see its own comment); no join here. worker.Stop()
  // already closed stdin_fd_ and waited for the child to exit, which closes
  // its stdout and ends the pump thread's read() loop on its own shortly
  // after this returns.
  webrtc::CleanupSSL();
  return 0;
}
