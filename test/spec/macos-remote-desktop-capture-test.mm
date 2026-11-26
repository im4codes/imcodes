#include <dispatch/dispatch.h>

#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "screen_capture_kit_adapter.h"

namespace capture = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

bool Check(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
  }
  return condition;
}

class Bytes final : public common::FrameStorage {
 public:
  explicit Bytes(std::size_t size) : bytes_(size, std::byte{0x2a}) {}
  const std::byte* data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }

 private:
  std::vector<std::byte> bytes_;
};

common::CapturedFrame Frame(std::int64_t timestamp = 10) {
  // Backpressure ownership does not depend on production-sized pixels. Keep
  // the sanitizer fake tiny while still satisfying the real BGRA stride and
  // storage contract introduced for padded CVPixelBuffer rows.
  constexpr std::uint32_t kWidth = 4;
  constexpr std::uint32_t kHeight = 4;
  constexpr std::size_t kRowBytes = kWidth * 4;
  constexpr std::size_t kFrameBytes = kRowBytes * kHeight;
  return common::CapturedFrame{
      .encoded_pixels = {kWidth, kHeight},
      .pixel_format = common::PixelFormat::kBgra8888,
      .row_bytes = kRowBytes,
      .capture_time_us = timestamp,
      .color_primaries = common::ColorPrimaries::kDisplayP3,
      .storage = std::make_shared<Bytes>(kFrameBytes),
  };
}

class FakeBackend;

class FakeStream final : public capture::ScreenCaptureKitBackendStream {
 public:
  FakeStream(FakeBackend* backend,
             capture::ScreenCaptureKitStreamConfiguration config)
      : backend_(backend), config_(std::move(config)) {}
  bool Start(std::uint32_t timeout_ms, std::string* error) override;
  bool WaitForFirstFrame(std::uint32_t timeout_ms,
                         std::string* error) override;
  void Stop(std::uint32_t timeout_ms) noexcept override;
  [[nodiscard]] bool SupportsAudio() const noexcept override;
  bool SetAudioEnabled(bool enabled) noexcept override;
  void SetAudioEnabledAsync(
      bool enabled,
      std::function<void(bool)> completion) noexcept override;

 private:
  FakeBackend* backend_;
  capture::ScreenCaptureKitStreamConfiguration config_;
};

class FakeBackend final : public capture::ScreenCaptureKitBackend {
 public:
  common::ReadinessState readiness = common::ReadinessState::kReady;
  std::vector<capture::ScreenCaptureKitBackendDisplay> displays;
  bool enumeration_succeeds = true;
  bool stream_start_succeeds = true;
  bool first_frame_ready = true;
  bool stream_started = false;
  bool stream_stopped = false;
  bool supports_output_size = false;
  bool supports_audio = true;
  bool supports_audio_toggle = true;
  bool defer_audio_update = false;
  bool last_audio_enabled = false;
  std::uint32_t audio_toggle_count = 0;
  std::uint32_t stream_start_count = 0;
  std::uint32_t stream_stop_count = 0;
  std::uint32_t enumeration_timeout = 0;
  std::uint32_t first_frame_timeout = 0;
  capture::ScreenCaptureKitStreamConfiguration configuration;
  capture::ScreenCaptureKitBackendFrameSink frame_sink;
  capture::ScreenCaptureKitBackendErrorSink error_sink;
  std::mutex fake_mutex;
  std::condition_variable fake_cv;
  std::vector<capture::ScreenCaptureKitStreamConfiguration> created_configs;
  std::vector<std::pair<bool, std::function<void(bool)>>>
      pending_audio_completions;
  bool block_second_first_frame = false;
  bool allow_second_first_frame = false;
  bool second_in_warmup = false;
  bool block_first_stop = false;
  bool allow_first_stop = false;
  bool first_in_stop = false;

  [[nodiscard]] bool SupportsOutputSize() const noexcept override {
    return supports_output_size;
  }

  [[nodiscard]] bool SupportsAudio() const noexcept override {
    return supports_audio;
  }

  common::ReadinessState ProbeReadiness() noexcept override {
    return readiness;
  }

  bool EnumerateDisplays(
      std::uint32_t timeout_ms,
      std::uint32_t max_displays,
      std::vector<capture::ScreenCaptureKitBackendDisplay>* output,
      capture::CaptureError* error) override {
    enumeration_timeout = timeout_ms;
    if (!enumeration_succeeds) {
      *error = {capture::CaptureErrorCode::kEnumerationTimedOut,
                "fake enumeration timeout"};
      return false;
    }
    *output = displays;
    if (output->size() > max_displays) {
      output->resize(max_displays);
    }
    *error = {};
    return true;
  }

  std::unique_ptr<capture::ScreenCaptureKitBackendStream> CreateStream(
      const capture::ScreenCaptureKitStreamConfiguration& next_configuration,
      capture::ScreenCaptureKitBackendFrameSink next_frame_sink,
      capture::ScreenCaptureKitBackendErrorSink next_error_sink,
      capture::CaptureError* error) override {
    {
      std::lock_guard lock(fake_mutex);
      configuration = next_configuration;
      created_configs.push_back(next_configuration);
      frame_sink = std::move(next_frame_sink);
      error_sink = std::move(next_error_sink);
    }
    fake_cv.notify_all();
    *error = {};
    return std::make_unique<FakeStream>(this, next_configuration);
  }

  void Emit(common::CapturedFrame frame) { frame_sink(std::move(frame)); }
  void Fail(capture::CaptureError error) { error_sink(std::move(error)); }
};

bool FakeStream::Start(std::uint32_t timeout_ms, std::string* error) {
  (void)timeout_ms;
  backend_->stream_started = backend_->stream_start_succeeds;
  ++backend_->stream_start_count;
  if (!backend_->stream_start_succeeds && error != nullptr) {
    *error = "fake start failure";
  }
  return backend_->stream_start_succeeds;
}

bool FakeStream::WaitForFirstFrame(std::uint32_t timeout_ms,
                                   std::string* error) {
  backend_->first_frame_timeout = timeout_ms;
  {
    std::unique_lock lock(backend_->fake_mutex);
    if (backend_->block_second_first_frame && backend_->created_configs.size() >= 2) {
      backend_->second_in_warmup = true;
      backend_->fake_cv.notify_all();
      backend_->fake_cv.wait(
          lock, [this]() { return backend_->allow_second_first_frame; });
    }
  }
  if (!backend_->first_frame_ready && error != nullptr) {
    *error = "fake first-frame timeout";
  }
  return backend_->first_frame_ready;
}

void FakeStream::Stop(std::uint32_t timeout_ms) noexcept {
  (void)timeout_ms;
  {
    std::unique_lock lock(backend_->fake_mutex);
    if (backend_->block_first_stop &&
        config_.audio_gate == backend_->created_configs[0].audio_gate) {
      backend_->first_in_stop = true;
      backend_->fake_cv.notify_all();
      backend_->fake_cv.wait(lock,
                             [this]() { return backend_->allow_first_stop; });
    }
  }
  backend_->stream_stopped = true;
  ++backend_->stream_stop_count;
}

bool FakeStream::SupportsAudio() const noexcept {
  return backend_->supports_audio && backend_->supports_audio_toggle;
}

bool FakeStream::SetAudioEnabled(bool enabled) noexcept {
  if (!SupportsAudio()) {
    return false;
  }
  backend_->last_audio_enabled = enabled;
  ++backend_->audio_toggle_count;
  return true;
}

void FakeStream::SetAudioEnabledAsync(
    bool enabled,
    std::function<void(bool)> completion) noexcept {
  if (!SupportsAudio()) {
    if (completion) completion(false);
    return;
  }
  std::function<void(bool)> deferred;
  {
    std::lock_guard lock(backend_->fake_mutex);
    backend_->last_audio_enabled = enabled;
    ++backend_->audio_toggle_count;
    if (backend_->defer_audio_update) {
      backend_->pending_audio_completions.emplace_back(enabled,
                                                       std::move(completion));
      backend_->fake_cv.notify_all();
      return;
    }
    deferred = std::move(completion);
  }
  if (deferred) deferred(true);
}

capture::ScreenCaptureKitBackendDisplay Display(
    std::uint32_t native_id,
    double logical_x,
    common::DisplayRotation rotation = common::DisplayRotation::k0) {
  return capture::ScreenCaptureKitBackendDisplay{
      .native_display_id = native_id,
      .encoded_pixels = {1920, 1080},
      .logical_input_bounds = {logical_x, 0, 960, 540},
      .scale = 2.0,
      .rotation = rotation,
      .cursor_supported = true,
  };
}

bool TestReadinessAndTopology() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(9, 960), Display(3, 0)};
  capture::ScreenCaptureKitAdapter adapter(
      77, std::move(backend),
      {.enumeration_timeout_ms = 125,
       .stream_start_timeout_ms = 125,
       .first_frame_timeout_ms = 125,
       .stream_stop_timeout_ms = 125,
       .frame_rate = 30,
       .max_displays = 4,
       .max_pending_frames = 1});

  if (!Check(adapter.ProbeReadiness() == common::ReadinessState::kReady,
             "capture readiness should be ready")) {
    return false;
  }
  auto first = adapter.EnumerateTopology();
  if (!Check(first.has_value() && first->IsValid(),
             "first topology should be valid") ||
      !Check(fake->enumeration_timeout == 125,
             "enumeration timeout must be bounded and forwarded") ||
      !Check(first->revision == 1 && first->displays.size() == 2,
             "first topology should have revision one and two displays") ||
      !Check(first->displays[0].display_id == "macos-display:77:3" &&
                 first->displays[1].display_id == "macos-display:77:9",
             "display identifiers must be stable, generation scoped and sorted") ||
      !Check(first->displays[0].encoded_pixels.width == 1920 &&
                 first->displays[0].logical_input_bounds.width == 960 &&
                 first->displays[0].scale == 2.0 &&
                 first->displays[0].rotation == common::DisplayRotation::k0,
             "topology must separate encoded and logical geometry") ||
      !Check(adapter.CursorCaptureSupported(first->displays[0].display_id),
             "cursor capability should be explicit")) {
    return false;
  }
  auto unchanged = adapter.EnumerateTopology();
  if (!Check(unchanged.has_value() && unchanged->revision == 1,
             "unchanged topology must keep its revision")) {
    return false;
  }
  fake->displays[1].rotation = common::DisplayRotation::k90;
  auto changed = adapter.EnumerateTopology();
  if (!Check(changed.has_value() && changed->revision == 2,
             "topology metadata changes must advance the revision")) {
    return false;
  }
  fake->displays.erase(fake->displays.begin());
  auto removed = adapter.EnumerateTopology();
  if (!Check(removed.has_value() && removed->revision == 3 &&
                 removed->displays.size() == 1,
             "display removal must advance topology revision")) {
    return false;
  }
  fake->displays.push_back(Display(21, -960));
  auto added = adapter.EnumerateTopology();
  return Check(added.has_value() && added->revision == 4 &&
                   added->displays.size() == 2,
               "display addition must advance topology revision");
}

bool TestMainDisplayIsListedFirst() {
  // Node m3: two identical monitors. Whichever display macOS numbers lowest is
  // not necessarily the one with the menu bar; the one at the origin of the
  // global display space is.
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(2, 960), Display(8, 0), Display(5, -960)};
  capture::ScreenCaptureKitAdapter adapter(6, std::move(backend));
  auto topology = adapter.EnumerateTopology();
  return Check(topology.has_value() && topology->displays.size() == 3 &&
                   topology->displays[0].display_id == "macos-display:6:8" &&
                   topology->displays[1].display_id == "macos-display:6:2" &&
                   topology->displays[2].display_id == "macos-display:6:5",
               "the main display goes first, the rest stay in id order");
}

bool TestPermissionAndEnumerationFailures() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->readiness = common::ReadinessState::kUnavailable;
  capture::ScreenCaptureKitAdapter adapter(5, std::move(backend));
  if (!Check(adapter.ProbeReadiness() == common::ReadinessState::kUnavailable,
             "missing Screen Recording permission must be unavailable") ||
      !Check(!adapter.EnumerateTopology().has_value(),
             "unavailable capture must not enumerate")) {
    return false;
  }
  return Check(adapter.LastError().code ==
                   capture::CaptureErrorCode::kPermissionDenied,
               "permission denial must remain distinguishable");
}

bool TestSelectedDisplayBackpressureAndTeardown() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(4, 0)};
  capture::ScreenCaptureKitAdapter adapter(
      8, std::move(backend),
      {.enumeration_timeout_ms = 100,
       .stream_start_timeout_ms = 100,
       .first_frame_timeout_ms = 75,
       .stream_stop_timeout_ms = 100,
       .frame_rate = 24,
       .max_displays = 4,
       .max_pending_frames = 1});
  auto topology = adapter.EnumerateTopology();
  if (!Check(topology.has_value(), "stream test topology missing")) {
    return false;
  }

  std::mutex mutex;
  std::condition_variable entered_cv;
  std::condition_variable release_cv;
  bool entered = false;
  bool release = false;
  std::uint32_t delivered = 0;
  if (!Check(adapter.Start(topology->displays[0], [&](common::CapturedFrame frame) {
        std::unique_lock lock(mutex);
        ++delivered;
        entered = frame.IsValid();
        entered_cv.notify_one();
        release_cv.wait(lock, [&] { return release; });
      }),
      "selected display stream should start")) {
    return false;
  }
  if (!Check(fake->configuration.native_display_id == 4 &&
                 fake->configuration.display_lookup_timeout_ms == 100 &&
                 fake->configuration.frame_rate == 24 &&
                 fake->configuration.max_pending_frames == 1 &&
                 fake->configuration.show_cursor,
             "stream configuration must preserve selection, bounds and cursor")) {
    return false;
  }
  if (!Check(fake->first_frame_timeout == 75,
             "capture must enforce a bounded first-frame deadline")) {
    return false;
  }

  auto invalid_stride = Frame(10);
  invalid_stride.row_bytes = 1;
  fake->Emit(std::move(invalid_stride));
  if (!Check(adapter.Statistics().rejected_invalid_frames == 1,
             "padded BGRA frames must carry an explicit valid row stride")) {
    return false;
  }

  std::thread first([&] { fake->Emit(Frame(11)); });
  {
    std::unique_lock lock(mutex);
    entered_cv.wait(lock, [&] { return entered; });
  }
  fake->Emit(Frame(12));
  auto saturated = adapter.Statistics();
  if (!Check(saturated.pending_frames == 1 &&
                 saturated.dropped_backpressure_frames == 1,
             "a saturated consumer must drop instead of growing the queue")) {
    return false;
  }
  {
    std::lock_guard lock(mutex);
    release = true;
  }
  release_cv.notify_one();
  first.join();
  if (!Check(delivered == 1 && adapter.Statistics().pending_frames == 0,
             "only the accepted frame should reach the sink")) {
    return false;
  }

  adapter.Stop();
  fake->Emit(Frame(13));
  const auto stopped = adapter.Statistics();
  return Check(fake->stream_stopped && stopped.ignored_late_frames == 1 &&
                   delivered == 1,
               "teardown must stop the stream and ignore late frames");
}

bool TestStaleTopologyAndStreamError() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(7, 0)};
  capture::ScreenCaptureKitAdapter adapter(9, std::move(backend));
  auto topology = adapter.EnumerateTopology();
  if (!Check(topology.has_value(), "error test topology missing")) {
    return false;
  }
  auto stale = topology->displays[0];
  stale.encoded_pixels.width = 1280;
  if (!Check(!adapter.Start(stale, [](common::CapturedFrame) {}),
             "stale topology metadata must not start capture")) {
    return false;
  }
  if (!Check(adapter.Start(topology->displays[0], [](common::CapturedFrame) {}),
             "current topology should start capture")) {
    return false;
  }
  fake->Fail({capture::CaptureErrorCode::kStreamStopped,
              "fake capture interruption"});
  fake->Emit(Frame(14));
  return Check(adapter.LastError().code ==
                   capture::CaptureErrorCode::kStreamStopped &&
                   adapter.Statistics().ignored_late_frames == 1,
               "capture errors must terminate delivery and expose a reason");
}

bool TestMonitorSwitchStopsThePreviousStream() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(14, 0), Display(15, 960)};
  capture::ScreenCaptureKitAdapter adapter(13, std::move(backend));
  auto topology = adapter.EnumerateTopology();
  if (!Check(topology.has_value() && topology->displays.size() == 2,
             "monitor-switch topology missing") ||
      !Check(adapter.Start(topology->displays[0],
                           [](common::CapturedFrame) {}),
             "first monitor must start") ||
      !Check(fake->configuration.native_display_id == 14,
             "first monitor selection must reach ScreenCaptureKit")) {
    return false;
  }
  if (!Check(adapter.Start(topology->displays[1],
                           [](common::CapturedFrame) {}),
             "second monitor must start") ||
      !Check(fake->configuration.native_display_id == 15 &&
                 fake->stream_start_count == 2 &&
                 fake->stream_stop_count == 1,
             "monitor switch must stop the old stream before starting the new one")) {
    return false;
  }
  adapter.Stop();
  return Check(fake->stream_stop_count == 2,
               "terminal cleanup must stop the selected monitor stream");
}

bool TestStartFailureAlwaysTearsDown() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(12, 0)};
  fake->stream_start_succeeds = false;
  capture::ScreenCaptureKitAdapter adapter(11, std::move(backend));
  auto topology = adapter.EnumerateTopology();
  if (!Check(topology.has_value(), "start-failure topology missing")) {
    return false;
  }
  return Check(!adapter.Start(topology->displays[0],
                              [](common::CapturedFrame) {}) &&
                   fake->stream_stopped &&
                   adapter.LastError().code ==
                       capture::CaptureErrorCode::kStreamStartFailed,
               "failed or timed-out starts must still stop their stream");
}

bool TestFirstFrameDeadlineAlwaysTearsDown() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(13, 0)};
  fake->first_frame_ready = false;
  capture::ScreenCaptureKitAdapter adapter(
      12, std::move(backend),
      {.enumeration_timeout_ms = 100,
       .stream_start_timeout_ms = 100,
       .first_frame_timeout_ms = 45,
       .stream_stop_timeout_ms = 100,
       .frame_rate = 30,
       .max_displays = 4,
       .max_pending_frames = 1});
  auto topology = adapter.EnumerateTopology();
  if (!Check(topology.has_value(), "first-frame topology missing")) {
    return false;
  }
  return Check(!adapter.Start(topology->displays[0],
                              [](common::CapturedFrame) {}) &&
                   fake->first_frame_timeout == 45 && fake->stream_stopped &&
                   adapter.LastError().code ==
                       capture::CaptureErrorCode::kFirstFrameTimedOut,
               "first-frame timeout must fail closed and tear down capture");
}

bool TestCoreAudioPcmToLoopbackBufferFormatsAndEdges() {
  imcodes::rd::AudioLoopbackBuffer buffer;
  constexpr std::uint32_t kFlagFloat = 1U << 0;
  constexpr std::uint32_t kFlagBigEndian = 1U << 1;
  constexpr std::uint32_t kFlagSignedInt = 1U << 2;
  constexpr std::uint32_t kFlagNonInterleaved = 1U << 5;
  constexpr std::size_t kFrames = imcodes::rd::kAudioFrameSamplesPerChannel;

  std::vector<float> left(kFrames, 0.5f);
  std::vector<float> right(kFrames, -0.5f);
  const void* planar_ptrs[2] = {left.data(), right.data()};
  const std::size_t planar_sizes[2] = {left.size() * sizeof(float),
                                       right.size() * sizeof(float)};

  // Disabled buffer must drop incoming audio without buffering.
  capture::PushCoreAudioPcmToLoopbackBuffer(buffer, 48000, 2, 32,
                                            kFlagFloat | kFlagNonInterleaved,
                                            kFrames, 2, planar_ptrs,
                                            planar_sizes);
  if (!Check(buffer.BufferedFrames() == 0,
             "disabled loopback buffer must ignore pushed PCM")) {
    return false;
  }

  buffer.SetEnabled(true);
  // Edge guards: 0 frames, big-endian, short buffer must be safely ignored.
  const std::size_t short_sizes[2] = {4, 4};
  capture::PushCoreAudioPcmToLoopbackBuffer(buffer, 48000, 2, 32,
                                            kFlagFloat | kFlagNonInterleaved,
                                            0, 2, planar_ptrs, planar_sizes);
  capture::PushCoreAudioPcmToLoopbackBuffer(
      buffer, 48000, 2, 32, kFlagFloat | kFlagBigEndian, kFrames, 2,
      planar_ptrs, planar_sizes);
  capture::PushCoreAudioPcmToLoopbackBuffer(buffer, 48000, 2, 32,
                                            kFlagFloat | kFlagNonInterleaved,
                                            kFrames, 2, planar_ptrs,
                                            short_sizes);
  if (!Check(buffer.BufferedFrames() == 0,
             "zero-frame, big-endian, and truncated buffers must be ignored")) {
    return false;
  }

  // Planar Float32 stereo @ 48kHz.
  capture::PushCoreAudioPcmToLoopbackBuffer(buffer, 48000, 2, 32,
                                            kFlagFloat | kFlagNonInterleaved,
                                            kFrames, 2, planar_ptrs,
                                            planar_sizes);
  std::int16_t out[imcodes::rd::kAudioFrameSamples]{};
  if (!Check(buffer.Pop10msFrame(out) && std::abs(out[0] - 16384) <= 4 &&
                 std::abs(out[1] + 16384) <= 4,
             "planar Float32 stereo must normalize to stereo Int16")) {
    return false;
  }

  // Interleaved Float32 @ 44.1kHz (resamples into 48kHz).
  std::vector<float> interleaved_f32(441 * 2, 0.25f);
  const void* interleaved_ptr[1] = {interleaved_f32.data()};
  const std::size_t interleaved_size[1] = {interleaved_f32.size() * sizeof(float)};
  capture::PushCoreAudioPcmToLoopbackBuffer(buffer, 44100, 2, 32, kFlagFloat,
                                            441, 1, interleaved_ptr,
                                            interleaved_size);
  if (!Check(buffer.BufferedFrames() >= 470,
             "44.1kHz interleaved Float32 must resample toward 48kHz")) {
    return false;
  }

  // Reset and test interleaved Int16 stereo @ 48kHz.
  buffer.SetEnabled(false);
  buffer.SetEnabled(true);
  std::vector<std::int16_t> interleaved_i16(kFrames * 2, 0);
  for (std::size_t i = 0; i < kFrames; ++i) {
    interleaved_i16[i * 2] = 1234;
    interleaved_i16[i * 2 + 1] = -4321;
  }
  const void* i16_ptr[1] = {interleaved_i16.data()};
  const std::size_t i16_size[1] = {interleaved_i16.size() * sizeof(std::int16_t)};
  capture::PushCoreAudioPcmToLoopbackBuffer(buffer, 48000, 2, 16, kFlagSignedInt,
                                            kFrames, 1, i16_ptr, i16_size);
  if (!Check(buffer.Pop10msFrame(out) && out[0] == 1234 && out[1] == -4321,
             "interleaved Int16 stereo must pass through cleanly")) {
    return false;
  }

  // Planar Float32 mono duplicates L into both L and R.
  const void* mono_ptr[1] = {left.data()};
  const std::size_t mono_size[1] = {left.size() * sizeof(float)};
  capture::PushCoreAudioPcmToLoopbackBuffer(buffer, 48000, 1, 32, kFlagFloat,
                                            kFrames, 1, mono_ptr, mono_size);
  if (!Check(buffer.Pop10msFrame(out) && std::abs(out[0] - 16384) <= 4 &&
                 std::abs(out[1] - 16384) <= 4,
             "mono Float32 must duplicate cleanly to stereo")) {
    return false;
  }

  // Planar Int16 stereo.
  std::vector<std::int16_t> i16_left(kFrames, 321);
  std::vector<std::int16_t> i16_right(kFrames, -654);
  const void* planar_i16_ptrs[2] = {i16_left.data(), i16_right.data()};
  const std::size_t planar_i16_sizes[2] = {i16_left.size() * sizeof(std::int16_t),
                                           i16_right.size() * sizeof(std::int16_t)};
  capture::PushCoreAudioPcmToLoopbackBuffer(
      buffer, 48000, 2, 16, kFlagSignedInt | kFlagNonInterleaved, kFrames, 2,
      planar_i16_ptrs, planar_i16_sizes);
  return Check(buffer.Pop10msFrame(out) && out[0] == 321 && out[1] == -654,
               "planar Int16 stereo must normalize cleanly");
}

bool SetAudioSync(capture::ScreenCaptureKitAdapter& adapter, bool enabled) {
  std::promise<bool> p;
  auto f = p.get_future();
  adapter.SetAudioEnabledAsync(enabled,
                               [&p](bool active) { p.set_value(active); });
  return f.get();
}

void InjectMarkerPcm(const capture::ScreenCaptureKitStreamConfiguration& cfg,
                     std::int16_t marker_value) {
  if (cfg.audio_buffer == nullptr) return;
  constexpr std::size_t kFrames = imcodes::rd::kAudioFrameSamplesPerChannel;
  std::vector<std::int16_t> samples(kFrames * 2, marker_value);
  const void* ptrs[1] = {samples.data()};
  const std::size_t sizes[1] = {samples.size() * sizeof(std::int16_t)};
  constexpr std::uint32_t kFlagSignedInt = 1U << 2;
  (void)capture::PushCoreAudioPcmToLoopbackBufferIfAllowed(
      *cfg.audio_buffer, cfg.audio_gate.get(), 48000, 2, 16, kFlagSignedInt,
      kFrames, 1, ptrs, sizes);
}

bool TestScreenCaptureKitAudioDynamicToggleAndFallback() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(21, 0)};
  capture::ScreenCaptureKitAdapter adapter(20, std::move(backend));
  auto buffer = std::make_shared<imcodes::rd::AudioLoopbackBuffer>();
  buffer->SetEnabled(true);
  adapter.SetAudioBuffer(buffer);

  // Toggling audio before Start must fail closed without leaving audio enabled.
  if (!Check(!SetAudioSync(adapter, true),
             "SetAudioEnabledAsync before Start must fail closed without stream")) {
    return false;
  }
  auto topology = adapter.EnumerateTopology();
  if (!Check(topology.has_value(), "audio test topology missing")) {
    return false;
  }
  std::size_t delivered = 0;
  if (!Check(adapter.Start(topology->displays[0],
                           [&](common::CapturedFrame) { ++delivered; }) &&
                 !fake->configuration.capture_audio &&
                 fake->configuration.audio_buffer == buffer &&
                 fake->configuration.audio_gate != nullptr &&
                 !fake->configuration.audio_gate->load() &&
                 fake->stream_start_count == 1,
             "Start must keep audio disabled by default with closed gate")) {
    return false;
  }

  // Enable and disable dynamically without restarting video capture.
  if (!Check(SetAudioSync(adapter, true) && fake->last_audio_enabled &&
                 fake->configuration.audio_gate->load() &&
                 SetAudioSync(adapter, true) && fake->audio_toggle_count == 1,
             "duplicate ON must short-circuit without extra stream update")) {
    return false;
  }
  if (!Check(!SetAudioSync(adapter, false) && !fake->last_audio_enabled &&
                 !fake->configuration.audio_gate->load() &&
                 fake->audio_toggle_count == 2 &&
                 fake->stream_start_count == 1 &&
                 fake->stream_stop_count == 0,
             "dynamic SetAudioEnabledAsync must toggle live stream without video restart")) {
    return false;
  }

  // Unsupported backend (macOS 12 / CGDisplayStream) stays silent false without error.
  fake->supports_audio = false;
  if (!Check(!SetAudioSync(adapter, true) && !adapter.SupportsAudio() &&
                 !fake->configuration.audio_gate->load() &&
                 !adapter.LastError().IsError(),
             "unsupported backend audio toggle must fail silently with gate closed")) {
    return false;
  }
  fake->Emit(Frame());
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  adapter.Stop();
  return Check(delivered == 1 && !adapter.LastError().IsError(),
               "video delivery must stay unbroken after silent audio fallback");
}

bool TestAsyncAudioControlCoalescesNeverBlocksAndRespectsGeneration() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(31, 0)};
  fake->defer_audio_update = true;
  capture::ScreenCaptureKitAdapter adapter(30, std::move(backend));
  auto buffer = std::make_shared<imcodes::rd::AudioLoopbackBuffer>();
  buffer->SetEnabled(true);
  adapter.SetAudioBuffer(buffer);
  auto topology = adapter.EnumerateTopology();
  if (!Check(topology.has_value(), "async control test topology missing")) {
    return false;
  }
  std::atomic<std::size_t> delivered{0};
  if (!Check(adapter.Start(topology->displays[0],
                           [&](common::CapturedFrame) { ++delivered; }),
             "async control test capture must start")) {
    return false;
  }

  // Dispatch ON whose Apple updateConfiguration completion is deferred.
  std::mutex cb_mutex;
  std::condition_variable cb_cv;
  std::vector<std::pair<int, bool>> results;
  adapter.SetAudioEnabledAsync(true, [&](bool active) {
    std::lock_guard lock(cb_mutex);
    results.emplace_back(1, active);
    cb_cv.notify_all();
  });
  {
    std::unique_lock lock(fake->fake_mutex);
    if (!Check(fake->fake_cv.wait_for(
                   lock, std::chrono::seconds(2),
                   [&]() { return fake->pending_audio_completions.size() == 1; }),
               "ON request must reach stream SetAudioEnabledAsync")) {
      return false;
    }
  }
  // Video continues flowing while audio config is stalled.
  fake->Emit(Frame(100));
  fake->Emit(Frame(200));
  if (!Check(delivered.load() == 2 && !fake->configuration.audio_gate->load(),
             "video must deliver while updateConfiguration is pending and gate stay closed")) {
    return false;
  }

  // Send OFF -> ON -> OFF while #1 is in flight: coalesces and closes gate immediately.
  adapter.SetAudioEnabledAsync(false, [&](bool active) {
    std::lock_guard lock(cb_mutex);
    results.emplace_back(2, active);
    cb_cv.notify_all();
  });
  adapter.SetAudioEnabledAsync(true, [&](bool active) {
    std::lock_guard lock(cb_mutex);
    results.emplace_back(3, active);
    cb_cv.notify_all();
  });
  adapter.SetAudioEnabledAsync(false, [&](bool active) {
    std::lock_guard lock(cb_mutex);
    results.emplace_back(4, active);
    cb_cv.notify_all();
  });
  if (!Check(!fake->configuration.audio_gate->load(),
             "OFF must close audio delivery gate immediately")) {
    return false;
  }

  // Complete #1 (which was ON) with success=true: must NOT open gate because #4 OFF superseded it!
  std::function<void(bool)> cb1;
  {
    std::lock_guard lock(fake->fake_mutex);
    cb1 = std::move(fake->pending_audio_completions[0].second);
  }
  cb1(true);
  // Wait for coalesced OFF to arrive on stream.
  {
    std::unique_lock lock(fake->fake_mutex);
    if (!Check(fake->fake_cv.wait_for(
                   lock, std::chrono::seconds(2),
                   [&]() { return fake->pending_audio_completions.size() == 2; }),
               "superseded ON + rapid toggles must coalesce into single follow-up OFF")) {
      return false;
    }
    if (!Check(!fake->pending_audio_completions[1].first &&
                   !fake->configuration.audio_gate->load(),
               "coalesced config must be OFF and keep audio gate closed")) {
      return false;
    }
  }
  std::function<void(bool)> cb2;
  {
    std::lock_guard lock(fake->fake_mutex);
    cb2 = std::move(fake->pending_audio_completions[1].second);
    fake->pending_audio_completions.clear();
  }
  cb2(true);
  {
    std::unique_lock lock(cb_mutex);
    if (!Check(cb_cv.wait_for(lock, std::chrono::seconds(2),
                              [&]() { return results.size() == 4; }),
               "all coalesced audio callbacks must settle")) {
      return false;
    }
    for (const auto& [id, active] : results) {
      if (!Check(!active, "superseded ON and final OFF must all settle false")) {
        (void)id;
        return false;
      }
    }
  }

  // Test failed ON remains closed, then Stop/Start invalidates stale stream completion.
  results.clear();
  adapter.SetAudioEnabledAsync(true, [&](bool active) {
    std::lock_guard lock(cb_mutex);
    results.emplace_back(5, active);
    cb_cv.notify_all();
  });
  {
    std::unique_lock lock(fake->fake_mutex);
    if (!Check(fake->fake_cv.wait_for(
                   lock, std::chrono::seconds(2),
                   [&]() { return fake->pending_audio_completions.size() == 1; }),
               "second ON must reach stream")) {
      return false;
    }
    cb1 = std::move(fake->pending_audio_completions[0].second);
    fake->pending_audio_completions.clear();
  }
  cb1(false);
  {
    std::unique_lock lock(cb_mutex);
    if (!Check(cb_cv.wait_for(lock, std::chrono::seconds(2),
                              [&]() { return results.size() == 1 && !results[0].second; }) &&
                   !fake->configuration.audio_gate->load(),
               "failed updateConfiguration must keep audio closed")) {
      return false;
    }
  }

  // Start ON on stream 1, Stop + restart stream 2 before stream 1 completes.
  adapter.SetAudioEnabledAsync(true, {});
  {
    std::unique_lock lock(fake->fake_mutex);
    if (!Check(fake->fake_cv.wait_for(
                   lock, std::chrono::seconds(2),
                   [&]() { return fake->pending_audio_completions.size() == 1; }),
               "stream 1 ON must queue before Stop")) {
      return false;
    }
    cb1 = std::move(fake->pending_audio_completions[0].second);
    fake->pending_audio_completions.clear();
  }
  adapter.Stop();
  if (!Check(adapter.Start(topology->displays[0],
                           [&](common::CapturedFrame) { ++delivered; }),
             "stream 2 must start cleanly")) {
    return false;
  }
  // Fire late completion from stream 1 with ok=true: stream 2 gate MUST remain closed!
  cb1(true);
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  if (!Check(!fake->configuration.audio_gate->load(),
             "late completion from previous stream generation must not open new stream gate")) {
    return false;
  }
  adapter.Stop();
  return true;
}

bool TestRetargetAudioGateExcludesWarmupAndStaleStreams() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->displays = {Display(41, 0)};
  fake->supports_output_size = true;
  fake->block_second_first_frame = true;
  fake->block_first_stop = true;
  capture::ScreenCaptureKitAdapter adapter(40, std::move(backend));
  auto buffer = std::make_shared<imcodes::rd::AudioLoopbackBuffer>();
  buffer->SetEnabled(true);
  adapter.SetAudioBuffer(buffer);
  auto topology = adapter.EnumerateTopology();
  if (!Check(topology.has_value(), "retarget gate test topology missing")) {
    return false;
  }
  if (!Check(adapter.Start(topology->displays[0], [](common::CapturedFrame) {}),
             "retarget test stream 1 must start") ||
      !Check(SetAudioSync(adapter, true),
             "retarget test stream 1 must enable audio")) {
    return false;
  }

  capture::ScreenCaptureKitStreamConfiguration cfg1;
  {
    std::lock_guard lock(fake->fake_mutex);
    if (!Check(fake->created_configs.size() == 1,
               "expected stream 1 config")) {
      return false;
    }
    cfg1 = fake->created_configs[0];
  }

  // Start Retarget; stream 2 waits inside WaitForFirstFrame (warmup).
  if (!Check(adapter.SetOutputSize({1280, 720}),
             "SetOutputSize retarget must dispatch")) {
    return false;
  }
  capture::ScreenCaptureKitStreamConfiguration cfg2;
  {
    std::unique_lock lock(fake->fake_mutex);
    if (!Check(fake->fake_cv.wait_for(lock, std::chrono::seconds(2),
                                      [&]() { return fake->second_in_warmup; }) &&
                   fake->created_configs.size() == 2,
               "stream 2 must enter warmup before handover")) {
      fake->allow_second_first_frame = true;
      fake->allow_first_stop = true;
      fake->fake_cv.notify_all();
      return false;
    }
    cfg2 = fake->created_configs[1];
  }

  // Concurrent injection during warmup: stream 2 (marker 2222) MUST be blocked; stream 1 (1111) passes.
  InjectMarkerPcm(cfg2, 2222);
  InjectMarkerPcm(cfg1, 1111);
  std::int16_t popped[imcodes::rd::kAudioFrameSamples]{};
  if (!Check(buffer->Pop10msFrame(popped) && popped[0] == 1111 &&
                 !buffer->Pop10msFrame(popped),
             "warmup stream 2 must never write PCM while stream 1 is active")) {
    std::lock_guard lock(fake->fake_mutex);
    fake->allow_second_first_frame = true;
    fake->allow_first_stop = true;
    fake->fake_cv.notify_all();
    return false;
  }

  // Release stream 2 first frame so handover happens and stream 1 enters Stop().
  {
    std::unique_lock lock(fake->fake_mutex);
    fake->allow_second_first_frame = true;
    fake->fake_cv.notify_all();
    if (!Check(fake->fake_cv.wait_for(lock, std::chrono::seconds(2),
                                      [&]() { return fake->first_in_stop; }),
               "stream 1 must enter Stop after handover")) {
      return false;
    }
  }

  // Concurrent injection after handover while old stream is stopping: old (3333) blocked, new (4444) passes.
  InjectMarkerPcm(cfg1, 3333);
  InjectMarkerPcm(cfg2, 4444);
  if (!Check(buffer->Pop10msFrame(popped) && popped[0] == 4444 &&
                 !buffer->Pop10msFrame(popped),
             "retired stream 1 must never write PCM after atomic gate handover")) {
    std::lock_guard lock(fake->fake_mutex);
    fake->allow_first_stop = true;
    fake->fake_cv.notify_all();
    return false;
  }

  {
    std::lock_guard lock(fake->fake_mutex);
    fake->allow_first_stop = true;
    fake->fake_cv.notify_all();
  }

  // Controlled pause of an old PCM callback right before the ring write boundary:
  // capture old stream config while active, pause Thread A, trigger a Retarget
  // handover to stream 3 + push 5555, then release Thread A (1111) and verify
  // the shared AudioLoopbackBuffer::mutex_ gate rejects the old callback.
  fake->allow_second_first_frame = true;
  fake->block_second_first_frame = false;
  fake->block_first_stop = false;
  if (!Check(adapter.SetOutputSize({800, 600}),
             "Retarget to 800x600 must dispatch cleanly")) {
    return false;
  }
  {
    std::unique_lock lock(fake->fake_mutex);
    if (!Check(fake->fake_cv.wait_for(
                   lock, std::chrono::seconds(2),
                   [&]() { return fake->created_configs.size() == 3; }),
               "expected stream 3 config")) {
      return false;
    }
  }
  std::promise<void> old_entered;
  std::promise<void> release_old;
  std::shared_future<void> release_future = release_old.get_future().share();
  const capture::ScreenCaptureKitStreamConfiguration cfg2_copy = cfg2;
  std::thread paused_old([&]() {
    // Enter while stream 2 or 3 handover is about to happen, then pause right
    // before the atomic gate+ring boundary.
    old_entered.set_value();
    release_future.wait();
    InjectMarkerPcm(cfg2_copy, 6666);
  });
  old_entered.get_future().wait();
  // Force another Retarget while old PCM thread is paused.
  if (!Check(adapter.SetOutputSize({1024, 576}),
             "Retarget to 1024x576 must dispatch cleanly")) {
    release_old.set_value();
    paused_old.join();
    return false;
  }
  capture::ScreenCaptureKitStreamConfiguration cfg4;
  {
    std::unique_lock lock(fake->fake_mutex);
    if (!Check(fake->fake_cv.wait_for(
                   lock, std::chrono::seconds(2),
                   [&]() { return fake->created_configs.size() == 4; }),
               "expected stream 4 config")) {
      release_old.set_value();
      paused_old.join();
      return false;
    }
    cfg4 = fake->created_configs[3];
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  release_old.set_value();
  paused_old.join();
  InjectMarkerPcm(cfg4, 7777);
  if (!Check(buffer->Pop10msFrame(popped) && popped[0] == 7777 &&
                 !buffer->Pop10msFrame(popped),
             "paused old PCM callback must be rejected at ring sync boundary")) {
    return false;
  }

  adapter.Stop();
  return true;
}

bool TestPausedAudioCompletionDoesNotDeadlockDestroy() {
  // 1. External thread pauses completion while owner destroys adapter.
  {
    auto backend = std::make_unique<FakeBackend>();
    FakeBackend* fake = backend.get();
    fake->displays = {Display(42, 0)};
    fake->defer_audio_update = true;
    auto adapter = std::make_unique<capture::ScreenCaptureKitAdapter>(
        41, std::move(backend));
    auto topology = adapter->EnumerateTopology();
    if (!Check(topology.has_value() &&
                   adapter->Start(topology->displays[0],
                                  [](common::CapturedFrame) {}),
               "lifetime test stream must start")) {
      return false;
    }

    std::promise<void> entered_cb;
    std::promise<void> release_cb;
    std::shared_future<void> release_future = release_cb.get_future().share();
    std::atomic<int> cb_count{0};
    adapter->SetAudioEnabledAsync(true, [&](bool) {
      ++cb_count;
      entered_cb.set_value();
      release_future.wait();
    });

    std::function<void(bool)> stream_cb;
    {
      std::unique_lock lock(fake->fake_mutex);
      if (!Check(fake->fake_cv.wait_for(
                     lock, std::chrono::seconds(2),
                     [&]() { return fake->pending_audio_completions.size() == 1; }),
                 "expected pending stream audio update")) {
        release_cb.set_value();
        return false;
      }
      stream_cb = std::move(fake->pending_audio_completions[0].second);
      fake->pending_audio_completions.clear();
    }
    stream_cb(true);
    entered_cb.get_future().wait();

    std::promise<void> destroyed;
    std::thread owner_destroy([&]() {
      adapter.reset();
      destroyed.set_value();
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    release_cb.set_value();
    auto status = destroyed.get_future().wait_for(std::chrono::seconds(2));
    owner_destroy.join();
    if (!Check(status == std::future_status::ready && cb_count.load() == 1,
               "adapter destroy must complete promptly after releasing paused completion")) {
      return false;
    }
  }

  // 2. Last shared_ptr<ScreenCaptureKitAdapter> destroyed directly on audio_control_queue.
  {
    auto backend = std::make_unique<FakeBackend>();
    FakeBackend* fake = backend.get();
    fake->displays = {Display(43, 0)};
    fake->defer_audio_update = true;
    auto adapter = std::make_shared<capture::ScreenCaptureKitAdapter>(
        42, std::move(backend));
    auto topology = adapter->EnumerateTopology();
    if (!Check(topology.has_value() &&
                   adapter->Start(topology->displays[0],
                                  [](common::CapturedFrame) {}),
               "same-queue destroy test stream must start")) {
      return false;
    }

    std::promise<void> settled;
    adapter->SetAudioEnabledAsync(true, [adapter_ref = adapter, &settled](bool) mutable {
      adapter_ref.reset();
      settled.set_value();
    });
    adapter.reset();

    std::function<void(bool)> stream_cb;
    {
      std::unique_lock lock(fake->fake_mutex);
      if (!Check(fake->fake_cv.wait_for(
                     lock, std::chrono::seconds(2),
                     [&]() { return fake->pending_audio_completions.size() == 1; }),
                 "expected pending stream audio update for same-queue destroy")) {
        return false;
      }
      stream_cb = std::move(fake->pending_audio_completions[0].second);
      fake->pending_audio_completions.clear();
    }
    stream_cb(true);
    if (!Check(settled.get_future().wait_for(std::chrono::seconds(2)) ==
                   std::future_status::ready,
               "destroying adapter from inside audio_control_queue completion must not deadlock")) {
      return false;
    }
  }

  // 3. Pause outer Apple completion between lifetime check and dispatch_async,
  // complete adapter destruction (including queue drain), then resume enqueue
  // and verify zero post-destroy Impl or waiter callbacks run.
  {
    auto backend = std::make_unique<FakeBackend>();
    FakeBackend* fake = backend.get();
    fake->displays = {Display(44, 0)};
    fake->defer_audio_update = true;
    auto adapter = std::make_unique<capture::ScreenCaptureKitAdapter>(
        43, std::move(backend));
    auto topology = adapter->EnumerateTopology();
    if (!Check(topology.has_value() &&
                   adapter->Start(topology->displays[0],
                                  [](common::CapturedFrame) {}),
               "late-enqueue test stream must start")) {
      return false;
    }

    std::promise<void> paused_before_enqueue;
    std::promise<void> release_enqueue;
    std::shared_future<void> release_future =
        release_enqueue.get_future().share();
    adapter->SetAudioCompletionPreEnqueueHookForTest([&]() {
      paused_before_enqueue.set_value();
      release_future.wait();
    });

    std::atomic<int> waiter_calls{0};
    adapter->SetAudioEnabledAsync(true, [&](bool) { ++waiter_calls; });

    std::function<void(bool)> stream_cb;
    {
      std::unique_lock lock(fake->fake_mutex);
      if (!Check(fake->fake_cv.wait_for(
                     lock, std::chrono::seconds(2),
                     [&]() { return fake->pending_audio_completions.size() == 1; }),
                 "expected pending stream audio update for late-enqueue test")) {
        release_enqueue.set_value();
        return false;
      }
      stream_cb = std::move(fake->pending_audio_completions[0].second);
      fake->pending_audio_completions.clear();
    }

    std::thread apple_completion_thread([&]() { stream_cb(true); });
    paused_before_enqueue.get_future().wait();

    // Finish ~ScreenCaptureKitAdapter (clears lifetime + drains queue) while
    // outer Apple completion is paused right before dispatch_async.
    adapter.reset();
    const int cancels_at_destroy = waiter_calls.load();
    release_enqueue.set_value();
    apple_completion_thread.join();
    // Flush global/serial dispatch queues briefly so any late block would run.
    dispatch_semaphore_t barrier = dispatch_semaphore_create(0);
    dispatch_async(
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
          dispatch_semaphore_signal(barrier);
        });
    dispatch_semaphore_wait(
        barrier, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC));
    if (!Check(cancels_at_destroy == 1 && waiter_calls.load() == 1,
               "late audio completion between check and enqueue must not invoke post-destroy Impl or callbacks")) {
      return false;
    }
  }
  return true;
}

}  // namespace

int main() {
  @autoreleasepool {
    return TestReadinessAndTopology() &&
                   TestMainDisplayIsListedFirst() &&
                   TestPermissionAndEnumerationFailures() &&
                   TestSelectedDisplayBackpressureAndTeardown() &&
                   TestStaleTopologyAndStreamError() &&
                   TestMonitorSwitchStopsThePreviousStream() &&
                   TestStartFailureAlwaysTearsDown() &&
                   TestFirstFrameDeadlineAlwaysTearsDown() &&
                   TestCoreAudioPcmToLoopbackBufferFormatsAndEdges() &&
                   TestScreenCaptureKitAudioDynamicToggleAndFallback() &&
                   TestAsyncAudioControlCoalescesNeverBlocksAndRespectsGeneration() &&
                   TestRetargetAudioGateExcludesWarmupAndStaleStreams() &&
                   TestPausedAudioCompletionDoesNotDeadlockDestroy()
               ? 0
               : 1;
  }
}
