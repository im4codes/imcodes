#include "third_party/imcodes_remote_desktop/wasapi_loopback_capture.h"

#include <audioclient.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "gtest/gtest.h"

namespace imcodes::rd {
namespace {

constexpr GUID kTestSubformatFloat = {
    0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
constexpr GUID kTestSubformatPcm = {
    0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

struct FakePacket {
  std::vector<std::uint8_t> bytes;
  std::size_t frames = 0;
  std::uint32_t flags = 0;
  HRESULT next_hr = S_OK;
  bool fire_wake_after_next = false;
};

class FakeWasapiLoopbackStream final : public WasapiLoopbackStream {
 public:
  FakeWasapiLoopbackStream(ParsedWaveFormat format,
                           std::deque<FakePacket> packets,
                           HANDLE wake_event,
                           std::atomic<bool>* device_invalidated,
                           std::atomic<int>* stopped_count)
      : format_(format),
        packets_(std::move(packets)),
        wake_event_(wake_event),
        device_invalidated_(device_invalidated),
        stopped_count_(stopped_count) {}

  ~FakeWasapiLoopbackStream() override { Stop(); }

  ParsedWaveFormat format() const noexcept override { return format_; }

  HRESULT NextPacket(const std::uint8_t** data,
                     std::size_t* frames,
                     std::uint32_t* flags) override {
    if (packets_.empty()) {
      *data = nullptr;
      *frames = 0;
      *flags = 0;
      return S_FALSE;
    }
    current_ = std::move(packets_.front());
    packets_.pop_front();
    if (current_.fire_wake_after_next && device_invalidated_ != nullptr &&
        wake_event_ != nullptr) {
      device_invalidated_->store(true, std::memory_order_release);
      SetEvent(wake_event_);
    }
    if (FAILED(current_.next_hr)) {
      *data = nullptr;
      *frames = 0;
      *flags = 0;
      return current_.next_hr;
    }
    *data = current_.bytes.empty() ? nullptr : current_.bytes.data();
    *frames = current_.frames;
    *flags = current_.flags;
    return current_.next_hr;
  }

  HRESULT ReleasePacket(std::size_t /*frames*/) override { return S_OK; }

  void Stop() noexcept override {
    if (!stopped_ && stopped_count_ != nullptr) {
      stopped_count_->fetch_add(1, std::memory_order_acq_rel);
    }
    stopped_ = true;
  }

 private:
  const ParsedWaveFormat format_;
  std::deque<FakePacket> packets_;
  FakePacket current_;
  HANDLE const wake_event_;
  std::atomic<bool>* const device_invalidated_;
  std::atomic<int>* const stopped_count_;
  bool stopped_ = false;
};

class FakeWasapiLoopbackBackend final : public WasapiLoopbackBackend {
 public:
  using OpenStep = std::function<HRESULT(
      std::unique_ptr<WasapiLoopbackStream>*, HANDLE, std::atomic<bool>*)>;

  explicit FakeWasapiLoopbackBackend(std::vector<OpenStep> steps)
      : steps_(std::move(steps)) {}

  ~FakeWasapiLoopbackBackend() override { JoinWaker(); }

  void EnableEntryBarrier() {
    std::lock_guard<std::mutex> lock(barrier_mu_);
    use_entry_barrier_ = true;
  }

  bool WaitForCaptureThreadEntered(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(barrier_mu_);
    return barrier_cv_.wait_for(lock, timeout, [this] { return entered_; });
  }

  void ReleaseCaptureThreadEntry() {
    {
      std::lock_guard<std::mutex> lock(barrier_mu_);
      allow_enter_ = true;
    }
    barrier_cv_.notify_all();
  }

  void ScheduleManagedWake(HANDLE wake_event, std::chrono::milliseconds delay) {
    JoinWaker();
    wake_cancel_.store(false, std::memory_order_release);
    waker_ = std::thread([this, wake_event, delay] {
      std::unique_lock<std::mutex> lock(wake_mu_);
      wake_cv_.wait_for(lock, delay,
                        [this] { return wake_cancel_.load(std::memory_order_acquire); });
      if (!wake_cancel_.load(std::memory_order_acquire) && wake_event != nullptr) {
        SetEvent(wake_event);
      }
    });
  }

  HRESULT OpenSession(HANDLE wake_event,
                      std::atomic<bool>* device_invalidated) override {
    wake_event_ = wake_event;
    device_invalidated_ = device_invalidated;
    return S_OK;
  }

  HRESULT OpenDefaultRenderStream(
      std::unique_ptr<WasapiLoopbackStream>* out_stream) override {
    std::size_t idx = open_calls_.fetch_add(1, std::memory_order_acq_rel);
    if (steps_.empty()) return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    const std::size_t clamped = std::min(idx, steps_.size() - 1);
    return steps_[clamped](out_stream, wake_event_, device_invalidated_);
  }

  void CloseSession() noexcept override {
    JoinWaker();
    closed_sessions_.fetch_add(1, std::memory_order_acq_rel);
  }

  void OnCaptureThreadEntered() noexcept override {
    std::unique_lock<std::mutex> lock(barrier_mu_);
    entered_ = true;
    barrier_cv_.notify_all();
    if (use_entry_barrier_) {
      barrier_cv_.wait(lock, [this] { return allow_enter_; });
    }
  }

  int open_calls() const { return static_cast<int>(open_calls_.load()); }
  int closed_sessions() const { return closed_sessions_.load(); }

 private:
  void JoinWaker() noexcept {
    {
      std::lock_guard<std::mutex> lock(wake_mu_);
      wake_cancel_.store(true, std::memory_order_release);
    }
    wake_cv_.notify_all();
    if (waker_.joinable()) waker_.join();
  }

  const std::vector<OpenStep> steps_;
  std::atomic<std::size_t> open_calls_{0};
  std::atomic<int> closed_sessions_{0};
  HANDLE wake_event_ = nullptr;
  std::atomic<bool>* device_invalidated_ = nullptr;

  std::mutex barrier_mu_;
  std::condition_variable barrier_cv_;
  bool use_entry_barrier_ = false;
  bool entered_ = false;
  bool allow_enter_ = false;

  std::mutex wake_mu_;
  std::condition_variable wake_cv_;
  std::atomic<bool> wake_cancel_{false};
  std::thread waker_;
};

std::vector<std::uint8_t> MakeStereoInt16Bytes(std::size_t frames,
                                               std::int16_t left,
                                               std::int16_t right) {
  std::vector<std::uint8_t> bytes(frames * 4);
  for (std::size_t i = 0; i < frames; ++i) {
    std::int16_t pair[2] = {left, right};
    std::memcpy(bytes.data() + i * 4, pair, sizeof(pair));
  }
  return bytes;
}

TEST(WasapiLoopbackCaptureTest, ParsesWaveFormatExAndExtensibleMixFormats) {
  EXPECT_EQ(ParseWaveFormat(nullptr).format, WasapiSampleFormat::kUnsupported);

  WAVEFORMATEX invalid{};
  invalid.wFormatTag = WAVE_FORMAT_PCM;
  invalid.nChannels = 0;
  invalid.nSamplesPerSec = 48000;
  invalid.wBitsPerSample = 16;
  invalid.nBlockAlign = 4;
  EXPECT_EQ(ParseWaveFormat(&invalid).format, WasapiSampleFormat::kUnsupported);

  WAVEFORMATEX pcm16{};
  pcm16.wFormatTag = WAVE_FORMAT_PCM;
  pcm16.nChannels = 2;
  pcm16.nSamplesPerSec = 44100;
  pcm16.wBitsPerSample = 16;
  pcm16.nBlockAlign = 4;
  const ParsedWaveFormat p16 = ParseWaveFormat(&pcm16);
  EXPECT_EQ(p16.format, WasapiSampleFormat::kInt16);
  EXPECT_EQ(p16.sample_rate_hz, 44100);
  EXPECT_EQ(p16.channels, 2);

  WAVEFORMATEX ieee32{};
  ieee32.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  ieee32.nChannels = 2;
  ieee32.nSamplesPerSec = 96000;
  ieee32.wBitsPerSample = 32;
  ieee32.nBlockAlign = 8;
  const ParsedWaveFormat f32 = ParseWaveFormat(&ieee32);
  EXPECT_EQ(f32.format, WasapiSampleFormat::kFloat32);
  EXPECT_EQ(f32.sample_rate_hz, 96000);
  EXPECT_EQ(f32.channels, 2);

  WAVEFORMATEXTENSIBLE ext_float{};
  ext_float.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  ext_float.Format.nChannels = 6;
  ext_float.Format.nSamplesPerSec = 48000;
  ext_float.Format.wBitsPerSample = 32;
  ext_float.Format.nBlockAlign = 24;
  ext_float.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  ext_float.Samples.wValidBitsPerSample = 32;
  ext_float.SubFormat = kTestSubformatFloat;
  const ParsedWaveFormat ef = ParseWaveFormat(&ext_float.Format);
  EXPECT_EQ(ef.format, WasapiSampleFormat::kFloat32);
  EXPECT_EQ(ef.sample_rate_hz, 48000);
  EXPECT_EQ(ef.channels, 6);

  WAVEFORMATEXTENSIBLE ext_pcm24{};
  ext_pcm24.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  ext_pcm24.Format.nChannels = 2;
  ext_pcm24.Format.nSamplesPerSec = 48000;
  ext_pcm24.Format.wBitsPerSample = 24;
  ext_pcm24.Format.nBlockAlign = 6;
  ext_pcm24.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  ext_pcm24.Samples.wValidBitsPerSample = 24;
  ext_pcm24.SubFormat = kTestSubformatPcm;
  const ParsedWaveFormat ep24 = ParseWaveFormat(&ext_pcm24.Format);
  EXPECT_EQ(ep24.format, WasapiSampleFormat::kInt24);
  EXPECT_EQ(ep24.valid_bits_per_sample, 24);
}

TEST(WasapiLoopbackCaptureTest,
     ForwardsFloat32Int24Int32Int16AndRespectsSilentFlag) {
  auto buffer = std::make_shared<AudioLoopbackBuffer>();
  buffer->SetEnabled(true);
  std::vector<float> scratch_float;
  std::vector<std::int16_t> scratch_int16;

  auto sink = [&buffer](const float* f, const std::int16_t* i16,
                        std::size_t frames, int rate, int ch, bool silent) {
    if (silent) return;
    if (f != nullptr) buffer->PushFloat32Interleaved(f, frames, rate, ch);
    if (i16 != nullptr) buffer->PushInt16Interleaved(i16, frames, rate, ch);
  };

  ParsedWaveFormat f32;
  f32.format = WasapiSampleFormat::kFloat32;
  f32.sample_rate_hz = 48000;
  f32.channels = 2;
  f32.bits_per_sample = 32;
  f32.block_align = 8;
  std::vector<float> float_samples(kAudioFrameSamples, 0.5f);
  for (std::size_t i = 0; i < kAudioFrameSamplesPerChannel; ++i) {
    float_samples[i * 2 + 1] = -0.25f;
  }
  ForwardWasapiPacket(reinterpret_cast<const std::uint8_t*>(float_samples.data()),
                      kAudioFrameSamplesPerChannel, 0, f32, &scratch_float,
                      &scratch_int16, sink);
  std::int16_t out[kAudioFrameSamples] = {};
  ASSERT_TRUE(buffer->Pop10msFrame(out));
  EXPECT_NEAR(out[0], 16384, 2);
  EXPECT_NEAR(out[1], -8192, 2);

  std::vector<float> poison(kAudioFrameSamples, 0.99f);
  bool saw_silent = false;
  ForwardWasapiPacket(
      reinterpret_cast<const std::uint8_t*>(poison.data()),
      kAudioFrameSamplesPerChannel, 0x2u /*AUDCLNT_BUFFERFLAGS_SILENT*/, f32,
      &scratch_float, &scratch_int16,
      [&](const float* f, const std::int16_t* i16, std::size_t, int, int,
          bool silent) {
        EXPECT_TRUE(silent);
        EXPECT_EQ(f, nullptr);
        EXPECT_EQ(i16, nullptr);
        saw_silent = true;
      });
  EXPECT_TRUE(saw_silent);
  EXPECT_FALSE(buffer->Pop10msFrame(out));
  EXPECT_EQ(out[0], 0);
  EXPECT_EQ(out[1], 0);

  ParsedWaveFormat p24;
  p24.format = WasapiSampleFormat::kInt24;
  p24.sample_rate_hz = 48000;
  p24.channels = 2;
  p24.bits_per_sample = 24;
  p24.block_align = 6;
  std::vector<std::uint8_t> pcm24(kAudioFrameSamplesPerChannel * 6);
  for (std::size_t i = 0; i < kAudioFrameSamplesPerChannel; ++i) {
    pcm24[i * 6 + 0] = 0x00;
    pcm24[i * 6 + 1] = 0x00;
    pcm24[i * 6 + 2] = 0x40;
    pcm24[i * 6 + 3] = 0x00;
    pcm24[i * 6 + 4] = 0x00;
    pcm24[i * 6 + 5] = 0xC0;
  }
  ForwardWasapiPacket(pcm24.data(), kAudioFrameSamplesPerChannel, 0, p24,
                      &scratch_float, &scratch_int16, sink);
  ASSERT_TRUE(buffer->Pop10msFrame(out));
  EXPECT_NEAR(out[0], 16384, 2);
  EXPECT_NEAR(out[1], -16384, 2);
}

TEST(WasapiLoopbackCaptureTest,
     RouterRefcountsCaptureAndIsolatesPerSessionBuffers) {
  LoopbackAudioRouter router(/*enable_hardware_capture=*/false);
  auto buf_a = router.RegisterSession("sess-a");
  auto buf_b = router.RegisterSession("sess-b");
  EXPECT_EQ(router.EnabledSessionCount(), 0u);
  EXPECT_FALSE(router.CaptureEnabled());

  router.SetSessionAudioEnabled("sess-a", true);
  EXPECT_EQ(router.EnabledSessionCount(), 1u);
  EXPECT_TRUE(router.CaptureEnabled());
  EXPECT_TRUE(buf_a->enabled());
  EXPECT_FALSE(buf_b->enabled());

  std::vector<std::int16_t> tone(kAudioFrameSamples, 3210);
  router.PushCapturedPacket(nullptr, tone.data(), kAudioFrameSamplesPerChannel,
                            48000, 2, false);
  std::int16_t out_a[kAudioFrameSamples] = {};
  std::int16_t out_b[kAudioFrameSamples] = {};
  EXPECT_TRUE(buf_a->Pop10msFrame(out_a));
  EXPECT_EQ(out_a[0], 3210);
  EXPECT_FALSE(buf_b->Pop10msFrame(out_b));
  EXPECT_EQ(out_b[0], 0);

  router.SetSessionAudioEnabled("sess-b", true);
  EXPECT_EQ(router.EnabledSessionCount(), 2u);
  router.PushCapturedPacket(nullptr, tone.data(), kAudioFrameSamplesPerChannel,
                            48000, 2, false);
  EXPECT_TRUE(buf_a->Pop10msFrame(out_a));
  EXPECT_TRUE(buf_b->Pop10msFrame(out_b));
  EXPECT_EQ(out_a[0], 3210);
  EXPECT_EQ(out_b[0], 3210);

  router.SetSessionAudioEnabled("sess-a", false);
  EXPECT_EQ(router.EnabledSessionCount(), 1u);
  EXPECT_TRUE(router.CaptureEnabled());
  router.UnregisterSession("sess-b");
  EXPECT_EQ(router.EnabledSessionCount(), 0u);
  EXPECT_FALSE(router.CaptureEnabled());
}

TEST(WasapiLoopbackCaptureTest,
     ImmediateStartStopAndStopBeforeCaptureEntryReturnBoundedly) {
  // Worst-case F1 counterexample: stop is signaled BEFORE the newly spawned
  // capture thread passes its entry barrier; handles must stay valid for the
  // entire thread lifetime and join cleanly in bounded time.
  auto backend = std::make_shared<FakeWasapiLoopbackBackend>(
      std::vector<FakeWasapiLoopbackBackend::OpenStep>{
          [](std::unique_ptr<WasapiLoopbackStream>*, HANDLE, std::atomic<bool>*) {
            return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
          }});
  backend->EnableEntryBarrier();

  auto buffer = std::make_shared<AudioLoopbackBuffer>();
  buffer->SetEnabled(true);
  WasapiLoopbackCapture capture(buffer, backend);

  capture.SetEnabled(true);
  ASSERT_TRUE(backend->WaitForCaptureThreadEntered(std::chrono::seconds(2)));

  std::future<void> stopped = std::async(std::launch::async, [&] {
    capture.SetEnabled(false);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  backend->ReleaseCaptureThreadEntry();

  ASSERT_EQ(stopped.wait_for(std::chrono::seconds(2)),
            std::future_status::ready);
  stopped.get();
  EXPECT_FALSE(capture.enabled());
  EXPECT_FALSE(capture.stats().enabled);
  EXPECT_FALSE(capture.stats().stream_active);

  // Repeated zero-sleep start/stop toggles without barrier must never hang.
  auto fast_backend = std::make_shared<FakeWasapiLoopbackBackend>(
      std::vector<FakeWasapiLoopbackBackend::OpenStep>{
          [](std::unique_ptr<WasapiLoopbackStream>*, HANDLE, std::atomic<bool>*) {
            return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
          }});
  WasapiLoopbackCapture fast_capture(buffer, fast_backend);
  auto done = std::async(std::launch::async, [&] {
    for (int i = 0; i < 15; ++i) {
      fast_capture.SetEnabled(true);
      fast_capture.SetEnabled(false);
    }
    return true;
  });
  ASSERT_EQ(done.wait_for(std::chrono::seconds(3)), std::future_status::ready);
  EXPECT_TRUE(done.get());
}

TEST(WasapiLoopbackCaptureTest,
     HandlesMissingEndpointInvalidationHotSwapAndStopsDuringBackoff) {
  std::atomic<int> stopped_streams{0};
  ParsedWaveFormat fmt_44k{WasapiSampleFormat::kInt16, 44100, 2, 16, 16, 4};
  ParsedWaveFormat fmt_48k{WasapiSampleFormat::kInt16, 48000, 2, 16, 16, 4};

  std::shared_ptr<FakeWasapiLoopbackBackend> backend;
  backend = std::make_shared<FakeWasapiLoopbackBackend>(
      std::vector<FakeWasapiLoopbackBackend::OpenStep>{
          // Step 0: Session 0 / Winlogon missing endpoint -> bounded backoff.
          [&](std::unique_ptr<WasapiLoopbackStream>*, HANDLE wake_event,
              std::atomic<bool>*) {
            backend->ScheduleManagedWake(wake_event,
                                         std::chrono::milliseconds(40));
            return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
          },
          // Step 1: Stream opens at 44.1kHz, emits 1 packet, then hits
          // AUDCLNT_E_DEVICE_INVALIDATED.
          [&](std::unique_ptr<WasapiLoopbackStream>* out, HANDLE wake,
              std::atomic<bool>* inv) {
            std::deque<FakePacket> pkts;
            pkts.push_back(FakePacket{MakeStereoInt16Bytes(441, 1111, -1111),
                                      441, 0, S_OK, false});
            pkts.push_back(FakePacket{{}, 0, 0, AUDCLNT_E_DEVICE_INVALIDATED,
                                      false});
            *out = std::make_unique<FakeWasapiLoopbackStream>(
                fmt_44k, std::move(pkts), wake, inv, &stopped_streams);
            return S_OK;
          },
          // Step 2: Reopens on new default render device (48kHz), emits 1 packet,
          // then triggers IMMNotificationClient default-device hot-swap event.
          [&](std::unique_ptr<WasapiLoopbackStream>* out, HANDLE wake,
              std::atomic<bool>* inv) {
            std::deque<FakePacket> pkts;
            pkts.push_back(FakePacket{MakeStereoInt16Bytes(480, 2222, -2222),
                                      480, 0, S_OK, false});
            pkts.push_back(FakePacket{{}, 0, 0, S_FALSE, true});
            *out = std::make_unique<FakeWasapiLoopbackStream>(
                fmt_48k, std::move(pkts), wake, inv, &stopped_streams);
            return S_OK;
          },
          // Step 3: Hot-swapped endpoint drops into missing endpoint backoff to
          // also verify stopping cleanly while parked inside 500ms backoff.
          [](std::unique_ptr<WasapiLoopbackStream>*, HANDLE,
             std::atomic<bool>*) {
            return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
          },
      });

  auto buffer = std::make_shared<AudioLoopbackBuffer>();
  buffer->SetEnabled(true);
  WasapiLoopbackCapture capture(buffer, backend);
  capture.SetEnabled(true);

  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(4);
  while (std::chrono::steady_clock::now() < deadline &&
         backend->open_calls() < 4) {
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
  }
  ASSERT_GE(backend->open_calls(), 4);

  const WasapiLoopbackStats mid = capture.stats();
  EXPECT_GE(mid.device_reopens, 2u);
  EXPECT_GE(mid.frames_captured, 921u);
  EXPECT_EQ(mid.last_error_hr,
            static_cast<std::uint32_t>(HRESULT_FROM_WIN32(ERROR_NOT_FOUND)));

  // Stop while parked in backoff wait; must return well below 500ms backoff!
  const auto stop_start = std::chrono::steady_clock::now();
  capture.SetEnabled(false);
  const auto stop_elapsed = std::chrono::steady_clock::now() - stop_start;
  EXPECT_LT(stop_elapsed, std::chrono::milliseconds(300));
  EXPECT_EQ(stopped_streams.load(), 2);
  EXPECT_EQ(backend->closed_sessions(), 1);
  EXPECT_FALSE(capture.stats().stream_active);
}

TEST(WasapiLoopbackCaptureTest,
     StartStopLifecycleHandlesMissingOrRealEndpointWithoutCrash) {
  auto buffer = std::make_shared<AudioLoopbackBuffer>();
  buffer->SetEnabled(true);
  WasapiLoopbackCapture capture(buffer);
  capture.SetEnabled(true);
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  const WasapiLoopbackStats active_stats = capture.stats();
  EXPECT_TRUE(active_stats.enabled);
  capture.SetEnabled(false);
  const WasapiLoopbackStats stopped_stats = capture.stats();
  EXPECT_FALSE(stopped_stats.enabled);
  EXPECT_FALSE(stopped_stats.stream_active);
}

}  // namespace
}  // namespace imcodes::rd
