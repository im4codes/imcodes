#include <atomic>
#include <cassert>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "macos_media_sender_binder.h"
#include "macos_transport_session_adapter.h"
#include "pinned_libwebrtc_h264_sender.h"
#include "pinned_libwebrtc_transport_backend.h"
#include "raw_frame_conversion.h"
#include "support/webrtc_teardown_stubs.h"

namespace imcodes::remote_desktop::macos {

// Stub implementations for the two sidecar translation units linked in the
// real worker (`pinned_libwebrtc_h264_sender.cc` and `raw_frame_conversion.cc`),
// keeping this ASan/UBSan test independent of CoreVideo/libyuv while compiling
// the real `pinned_libwebrtc_transport_backend.cc` verbatim.
namespace {
class StubPinnedH264Sender final : public H264SenderBackend {
 public:
  bool Start(const H264SenderConfiguration& configuration) override {
    return configuration.IsValid();
  }
  bool Submit(H264SenderFrame,
              H264SenderCompletionCallback completion) override {
    if (completion) completion(H264SenderCompletion::kAccepted, 64);
    return true;
  }
  void Cancel(common::WorkerGeneration) noexcept override {}
};
}  // namespace

std::unique_ptr<H264SenderBackend> CreatePinnedLibwebrtcH264Sender(
    webrtc::EncodedImageCallback* callback) {
  if (callback == nullptr) return nullptr;
  return std::make_unique<StubPinnedH264Sender>();
}

bool ConvertFrameToI420(const common::CapturedFrame&, const I420Planes&) {
  return true;
}

std::optional<common::CapturedFrame> ConvertNv12FrameToBgra(
    const common::CapturedFrame&,
    std::size_t) {
  return std::nullopt;
}

}  // namespace imcodes::remote_desktop::macos

namespace {

using namespace imcodes::remote_desktop;
using namespace imcodes::remote_desktop::macos;

class RecordingSink final : public MacosTransportCallbackSink {
 public:
  void OnPeerConnectionState(const common::TransportCallbackStamp&,
                             common::PeerConnectionState) override {
    peer_callbacks.fetch_add(1, std::memory_order_relaxed);
  }
  void OnDataChannelState(const common::TransportCallbackStamp&,
                          common::DataChannelKind,
                          common::DataChannelState) override {}
  void OnDataChannelMessage(const common::TransportCallbackStamp&,
                            common::DataChannelKind,
                            std::string) override {}
  void OnLocalIceCandidate(const common::TransportCallbackStamp&,
                           common::IceCandidate) override {}
  void OnTransportPath(const common::TransportCallbackStamp&,
                       common::TransportPath) override {}
  void OnQualityTarget(const common::TransportCallbackStamp&,
                       common::QualityTarget) override {
    rate_callbacks.fetch_add(1, std::memory_order_relaxed);
  }
  void OnTerminal(common::TransportTerminalReason) override {}

  std::atomic<int> peer_callbacks{0};
  std::atomic<int> rate_callbacks{0};
};

common::RouteAuthority MakeAuthority() {
  common::RouteAuthority authority;
  authority.identity.request_id = "req-teardown";
  authority.identity.session_id = "sess-teardown";
  authority.identity.negotiated_capability_binding = "cap-teardown";
  authority.identity.daemon_generation = 1;
  authority.identity.route_generation = 2;
  authority.lease_expires_at_unix_ms = 60'000;
  return authority;
}

std::vector<MacosTransportIceServer> MakeIce() {
  return {MacosTransportIceServer{"stun:stun.example.com:3478", "", ""}};
}

H264SenderConfiguration MakeSenderConfig() {
  H264SenderConfiguration cfg;
  cfg.generation = 2;
  cfg.encoded_pixels = common::PixelSize{1280, 720};
  return cfg;
}

void TestDoubleCloseAfterBinderDestroyed() {
  imcodes::test_stubs::ResetControl();
  RecordingSink sink;
  // Intentionally mirror WorkerRoute's declaration order: adapter first,
  // session/binder second (so C++ destroys binder BEFORE adapter).
  auto backend = CreatePinnedLibwebrtcTransportBackend();
  auto* raw_backend = backend.get();
  auto adapter = std::make_unique<MacosTransportSessionAdapter>(
      std::move(backend), sink, MakeIce());
  auto binder = std::make_unique<MacosMediaSenderBinder>();
  raw_backend->BindAdapter(adapter.get());
  raw_backend->BindMediaSender(binder.get());

  assert(adapter->StartTransport(MakeAuthority()));
  std::string answer;
  assert(adapter->NegotiateOffer("v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n", &answer));
  assert(!answer.empty());
  assert(binder->bound());
  assert(binder->Start(MakeSenderConfig()));

  // Mimic CloseTransport() before binder destruction, followed by ~adapter()
  // triggering ~PinnedLibwebrtcTransportBackend() -> second Close().
  adapter->CloseTransport();
  binder.reset();
  adapter.reset();

  // Retained encoders tearing down after BOTH binder and adapter died must not UAF.
  for (auto& enc : imcodes::test_stubs::Control().leaked_encoders) {
    webrtc::VideoEncoder::RateControlParameters params;
    params.bitrate.sum = 3'000'000;
    enc->SetRates(params);
    assert(enc->RegisterEncodeCompleteCallback(nullptr) == WEBRTC_VIDEO_CODEC_OK);
    assert(enc->Release() == WEBRTC_VIDEO_CODEC_OK);
  }
  imcodes::test_stubs::Control().leaked_encoders.clear();
}

void TestAdapterDestroyedBeforeBinder() {
  imcodes::test_stubs::ResetControl();
  RecordingSink sink;
  auto backend = CreatePinnedLibwebrtcTransportBackend();
  auto* raw_backend = backend.get();
  auto adapter = std::make_unique<MacosTransportSessionAdapter>(
      std::move(backend), sink, MakeIce());
  auto binder = std::make_unique<MacosMediaSenderBinder>();
  raw_backend->BindAdapter(adapter.get());
  raw_backend->BindMediaSender(binder.get());

  assert(adapter->StartTransport(MakeAuthority()));
  assert(binder->Start(MakeSenderConfig()));

  // Destroy adapter/backend while binder still lives, then continue using and
  // destroying binder and any retained encoders.
  adapter->CloseTransport();
  adapter.reset();
  H264SenderFrame frame;
  frame.generation = MakeSenderConfig().generation;
  frame.bytes = {std::byte{0x00}, std::byte{0x00}, std::byte{0x00},
                 std::byte{0x01}, std::byte{0x65}};
  assert(binder->Submit(std::move(frame), nullptr));
  binder->Cancel(MakeSenderConfig().generation);
  binder.reset();
  imcodes::test_stubs::Control().leaked_encoders.clear();
}

void TestFirstCloseAfterBinderDestroyed() {
  imcodes::test_stubs::ResetControl();
  RecordingSink sink;
  // Scenario A: Warmed unopened route where binder dies before ~adapter().
  {
    auto backend = CreatePinnedLibwebrtcTransportBackend();
    auto* raw_backend = backend.get();
    auto adapter = std::make_unique<MacosTransportSessionAdapter>(
        std::move(backend), sink, MakeIce());
    auto binder = std::make_unique<MacosMediaSenderBinder>();
    raw_backend->BindAdapter(adapter.get());
    raw_backend->BindMediaSender(binder.get());

    binder.reset();
    adapter.reset();
  }

  // Scenario B: Opened route where binder dies BEFORE CloseTransport() was
  // ever called (direct ~MacosTransportSessionAdapter() -> Close()).
  {
    imcodes::test_stubs::ResetControl();
    auto backend = CreatePinnedLibwebrtcTransportBackend();
    auto* raw_backend = backend.get();
    auto adapter = std::make_unique<MacosTransportSessionAdapter>(
        std::move(backend), sink, MakeIce());
    auto binder = std::make_unique<MacosMediaSenderBinder>();
    std::shared_ptr<RawVideoPath> raw = binder->raw_video();
    raw_backend->BindAdapter(adapter.get());
    raw_backend->BindMediaSender(binder.get());

    assert(adapter->StartTransport(MakeAuthority()));
    std::string answer;
    assert(adapter->NegotiateOffer("v=0\r\n", &answer));

    // Destroy binder first while transport is still open.
    binder.reset();
    // Now ~adapter() invokes CloseTransport() -> backend_->Close() for the
    // FIRST time with dead binder_, then ~PinnedLibwebrtcTransportBackend()
    // calls Close() a SECOND time.
    adapter.reset();

    // Sink must have been cleared from RawVideoPath without dereferencing binder.
    common::CapturedFrame frame;
    frame.encoded_pixels = common::PixelSize{640, 360};
    assert(!raw->PushFrame(frame));
    imcodes::test_stubs::Control().leaked_encoders.clear();
  }
}

void TestPumpAndDirectBackendCloseIdempotency() {
  imcodes::test_stubs::ResetControl();
  imcodes::test_stubs::Control().hold_encoder_past_close = false;
  RecordingSink sink;

  auto backend = CreatePinnedLibwebrtcTransportBackend();
  auto adapter = std::make_unique<MacosTransportSessionAdapter>(
      CreatePinnedLibwebrtcTransportBackend(), sink, MakeIce());
  auto binder = std::make_unique<MacosMediaSenderBinder>();
  binder->raw_video()->AllowRawCodecs(true);
  backend->BindAdapter(adapter.get());
  backend->BindMediaSender(binder.get());

  MacosTransportBackendConfiguration cfg;
  cfg.ice_servers = MakeIce();
  cfg.identity = MakeAuthority().identity;
  assert(backend->Open(cfg));
  assert(binder->Start(MakeSenderConfig()));
  // Let ImcodesVideoTrackSource::Pump() iterate reading raw_->configured_pixels().
  std::this_thread::sleep_for(std::chrono::milliseconds(160));
  binder->Cancel(MakeSenderConfig().generation);
  std::this_thread::sleep_for(std::chrono::milliseconds(90));

  // Destroy binder before backend->Close() and repeated Close() calls.
  binder.reset();
  backend->Close();
  backend->Close();

  // Closed backend rejects subsequent Bind/Open/Negotiate calls safely.
  std::string answer;
  assert(!backend->Open(cfg));
  assert(!backend->NegotiateOffer("v=0\r\n", &answer));
  backend.reset();
  adapter.reset();
}

void TestOpenFailureCleanupPaths() {
  struct FailureFlag {
    bool imcodes::test_stubs::StubControl::* member;
  };
  const FailureFlag flags[] = {
      {&imcodes::test_stubs::StubControl::fail_thread_start},
      {&imcodes::test_stubs::StubControl::fail_create_factory},
      {&imcodes::test_stubs::StubControl::fail_create_peer},
      {&imcodes::test_stubs::StubControl::fail_create_video_track},
      {&imcodes::test_stubs::StubControl::fail_add_track},
      {&imcodes::test_stubs::StubControl::fail_set_bitrate_limits},
  };

  for (const auto& flag : flags) {
    imcodes::test_stubs::ResetControl();
    imcodes::test_stubs::Control().*(flag.member) = true;
    RecordingSink sink;
    auto backend = CreatePinnedLibwebrtcTransportBackend();
    auto* raw_backend = backend.get();
    auto adapter = std::make_unique<MacosTransportSessionAdapter>(
        std::move(backend), sink, MakeIce());
    auto binder = std::make_unique<MacosMediaSenderBinder>();
    raw_backend->BindAdapter(adapter.get());
    raw_backend->BindMediaSender(binder.get());

    assert(!adapter->StartTransport(MakeAuthority()));
    binder.reset();
    adapter.reset();
    imcodes::test_stubs::Control().leaked_encoders.clear();
  }
}

void TestConcurrentCloseRace() {
  for (int iter = 0; iter < 10; ++iter) {
    imcodes::test_stubs::ResetControl();
    RecordingSink sink;
    auto backend = CreatePinnedLibwebrtcTransportBackend();
    auto* raw_backend = backend.get();
    auto adapter = std::make_unique<MacosTransportSessionAdapter>(
        std::move(backend), sink, MakeIce());
    auto binder = std::make_unique<MacosMediaSenderBinder>();
    auto raw = binder->raw_video();
    raw_backend->BindAdapter(adapter.get());
    raw_backend->BindMediaSender(binder.get());
    assert(adapter->StartTransport(MakeAuthority()));
    assert(binder->Start(MakeSenderConfig()));

    std::atomic<bool> stop{false};
    std::thread activity([&] {
      int n = 0;
      while (!stop.load(std::memory_order_acquire)) {
        std::string ans;
        (void)raw_backend->NegotiateOffer("v=0\r\n", &ans);
        (void)raw_backend->SampleTraffic();
        common::CapturedFrame f;
        f.encoded_pixels = common::PixelSize{640, 360};
        (void)raw->PushFrame(f);
        if ((++n % 4) == 0) std::this_thread::yield();
      }
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    adapter->CloseTransport();
    stop.store(true, std::memory_order_release);
    activity.join();

    binder.reset();
    adapter.reset();
    imcodes::test_stubs::Control().leaked_encoders.clear();
  }
}

void TestAudioTrackDefaultDisabledAndToggle() {
  imcodes::test_stubs::ResetControl();
  RecordingSink sink;
  auto backend = CreatePinnedLibwebrtcTransportBackend();
  auto* raw_backend = backend.get();
  auto buffer = raw_backend->AudioBuffer();
  assert(buffer != nullptr);
  assert(!buffer->enabled());

  auto adapter = std::make_unique<MacosTransportSessionAdapter>(
      std::move(backend), sink, MakeIce());
  auto binder = std::make_unique<MacosMediaSenderBinder>();
  raw_backend->BindAdapter(adapter.get());
  raw_backend->BindMediaSender(binder.get());
  assert(adapter->StartTransport(MakeAuthority()));
  assert(!buffer->enabled());

  adapter->SetAudioEnabled(true);
  assert(buffer->enabled());
  adapter->SetAudioEnabled(false);
  assert(!buffer->enabled());

  adapter->CloseTransport();
  binder.reset();
  adapter.reset();
  assert(!buffer->enabled());
}

}  // namespace

int main() {
  TestDoubleCloseAfterBinderDestroyed();
  TestAdapterDestroyedBeforeBinder();
  TestFirstCloseAfterBinderDestroyed();
  TestPumpAndDirectBackendCloseIdempotency();
  TestOpenFailureCleanupPaths();
  TestConcurrentCloseRace();
  TestAudioTrackDefaultDisabledAndToggle();
  return 0;
}
