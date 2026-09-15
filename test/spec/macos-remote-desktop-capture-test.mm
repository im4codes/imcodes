#include <condition_variable>
#include <cstddef>
#include <cstdint>
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
  explicit FakeStream(FakeBackend* backend) : backend_(backend) {}
  bool Start(std::uint32_t timeout_ms, std::string* error) override;
  bool WaitForFirstFrame(std::uint32_t timeout_ms,
                         std::string* error) override;
  void Stop(std::uint32_t timeout_ms) noexcept override;

 private:
  FakeBackend* backend_;
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
  std::uint32_t stream_start_count = 0;
  std::uint32_t stream_stop_count = 0;
  std::uint32_t enumeration_timeout = 0;
  std::uint32_t first_frame_timeout = 0;
  capture::ScreenCaptureKitStreamConfiguration configuration;
  capture::ScreenCaptureKitBackendFrameSink frame_sink;
  capture::ScreenCaptureKitBackendErrorSink error_sink;

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
    configuration = next_configuration;
    frame_sink = std::move(next_frame_sink);
    error_sink = std::move(next_error_sink);
    *error = {};
    return std::make_unique<FakeStream>(this);
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
  if (!backend_->first_frame_ready && error != nullptr) {
    *error = "fake first-frame timeout";
  }
  return backend_->first_frame_ready;
}

void FakeStream::Stop(std::uint32_t timeout_ms) noexcept {
  (void)timeout_ms;
  backend_->stream_stopped = true;
  ++backend_->stream_stop_count;
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

}  // namespace

int main() {
  @autoreleasepool {
    return TestReadinessAndTopology() &&
                   TestPermissionAndEnumerationFailures() &&
                   TestSelectedDisplayBackpressureAndTeardown() &&
                   TestStaleTopologyAndStreamError() &&
                   TestMonitorSwitchStopsThePreviousStream() &&
                   TestStartFailureAlwaysTearsDown() &&
                   TestFirstFrameDeadlineAlwaysTearsDown()
               ? 0
               : 1;
  }
}
