// Native test of the capture adapter's output-size switching with an injected
// backend: no screen is captured and no permission is involved.
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
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
  if (!condition) std::cerr << "FAIL: " << message << '\n';
  return condition;
}

bool WaitFor(const std::function<bool()>& condition, int milliseconds = 4000) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(milliseconds);
  while (std::chrono::steady_clock::now() < deadline) {
    if (condition()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return condition();
}

std::string Size(common::PixelSize size) {
  return std::to_string(size.width) + "x" + std::to_string(size.height);
}

class Log {
 public:
  void Add(std::string line) {
    std::lock_guard lock(mutex_);
    lines_.push_back(std::move(line));
  }
  std::vector<std::string> Snapshot() const {
    std::lock_guard lock(mutex_);
    return lines_;
  }
  std::size_t Count(const std::string& line) const {
    std::size_t count = 0;
    for (const auto& entry : Snapshot()) count += entry == line ? 1U : 0U;
    return count;
  }
  long IndexOf(const std::string& line) const {
    const auto lines = Snapshot();
    for (std::size_t i = 0; i < lines.size(); ++i) {
      if (lines[i] == line) return static_cast<long>(i);
    }
    return -1;
  }

 private:
  mutable std::mutex mutex_;
  std::vector<std::string> lines_;
};

class FakeStream final : public capture::ScreenCaptureKitBackendStream {
 public:
  FakeStream(Log* log, common::PixelSize size, bool first_frame_ok, int block_ms)
      : log_(log), size_(size), first_frame_ok_(first_frame_ok), block_ms_(block_ms) {}
  bool Start(std::uint32_t, std::string*) override {
    log_->Add("start " + Size(size_));
    return true;
  }
  bool WaitForFirstFrame(std::uint32_t, std::string* error) override {
    log_->Add("first-frame-begin " + Size(size_));
    // Stands in for a capture API that is slow to deliver its first frame.
    if (block_ms_ > 0) std::this_thread::sleep_for(std::chrono::milliseconds(block_ms_));
    log_->Add("first-frame " + Size(size_));
    if (!first_frame_ok_ && error != nullptr) *error = "fake first-frame timeout";
    return first_frame_ok_;
  }
  void Stop(std::uint32_t) noexcept override { log_->Add("stop " + Size(size_)); }

 private:
  Log* log_;
  common::PixelSize size_;
  bool first_frame_ok_;
  int block_ms_;
};

class FakeBackend final : public capture::ScreenCaptureKitBackend {
 public:
  explicit FakeBackend(bool supports_output_size) : supports_(supports_output_size) {}
  Log log;
  std::atomic<bool> next_first_frame_ok{true};
  // The next created stream takes this long to deliver its first frame.
  std::atomic<int> next_block_first_frame_ms{0};
  std::mutex sinks_mutex;
  std::vector<capture::ScreenCaptureKitBackendFrameSink> frame_sinks;

  bool SupportsOutputSize() const noexcept override { return supports_; }
  common::ReadinessState ProbeReadiness() noexcept override { return common::ReadinessState::kReady; }
  bool EnumerateDisplays(std::uint32_t, std::uint32_t,
                         std::vector<capture::ScreenCaptureKitBackendDisplay>* out,
                         capture::CaptureError* error) override {
    out->push_back(capture::ScreenCaptureKitBackendDisplay{
        .native_display_id = 7,
        .encoded_pixels = {5120, 2700},
        .logical_input_bounds = {0, 0, 2560, 1350},
        .scale = 2.0,
        .rotation = common::DisplayRotation::k0,
        .cursor_supported = true,
    });
    *error = {};
    return true;
  }
  std::unique_ptr<capture::ScreenCaptureKitBackendStream> CreateStream(
      const capture::ScreenCaptureKitStreamConfiguration& configuration,
      capture::ScreenCaptureKitBackendFrameSink frame_sink,
      capture::ScreenCaptureKitBackendErrorSink,
      capture::CaptureError* error) override {
    log.Add("create " + Size(configuration.encoded_pixels));
    {
      std::lock_guard lock(sinks_mutex);
      frame_sinks.push_back(std::move(frame_sink));
    }
    *error = {};
    return std::make_unique<FakeStream>(&log, configuration.encoded_pixels,
                                        next_first_frame_ok.exchange(true),
                                        next_block_first_frame_ms.exchange(0));
  }

 private:
  bool supports_;
};

struct Rig {
  FakeBackend* backend = nullptr;
  std::unique_ptr<capture::ScreenCaptureKitAdapter> adapter;
  common::DisplayTopology display;
};

bool MakeRig(Rig* rig, bool supports_output_size, bool start = true) {
  auto backend = std::make_unique<FakeBackend>(supports_output_size);
  rig->backend = backend.get();
  rig->adapter = std::make_unique<capture::ScreenCaptureKitAdapter>(
      3, std::move(backend),
      capture::ScreenCaptureKitLimits{.enumeration_timeout_ms = 100,
                                      .stream_start_timeout_ms = 100,
                                      .first_frame_timeout_ms = 100,
                                      .stream_stop_timeout_ms = 100,
                                      .frame_rate = 30,
                                      .max_displays = 4,
                                      .max_pending_frames = 2});
  const auto topology = rig->adapter->EnumerateTopology();
  if (!Check(topology.has_value() && !topology->displays.empty(), "topology")) return false;
  rig->display = topology->displays[0];
  if (!start) return true;
  return Check(rig->adapter->Start(rig->display, [](common::CapturedFrame) {}), "start");
}

bool TestBackendWithoutSupportKeepsTheNativeStreamAlone() {
  Rig rig;
  if (!MakeRig(&rig, /*supports_output_size=*/false)) return false;
  const bool ok =
      Check(!rig.adapter->SupportsOutputSize(), "no support is reported") &&
      Check(!rig.adapter->SetOutputSize({2560, 1350}), "SetOutputSize is refused") &&
      Check(!rig.adapter->OutputSize().has_value(), "output size stays native (empty)") &&
      Check(rig.backend->log.Count("create 5120x2700") == 1, "one native stream") &&
      Check(rig.backend->log.Snapshot().size() == 4, "create/start/first-frame only: nothing else was created");
  rig.adapter->Stop();
  return ok;
}

bool TestSwitchIsMakeBeforeBreak() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  if (!Check(rig.adapter->SupportsOutputSize(), "support is reported") ||
      !Check(!rig.adapter->OutputSize().has_value(), "starts at the native size") ||
      !Check(rig.adapter->SetOutputSize({2560, 1350}), "request accepted")) {
    return false;
  }
  if (!Check(WaitFor([&] {
        const auto size = rig.adapter->OutputSize();
        return size.has_value() && size->width == 2560 && size->height == 1350;
      }),
             "output size reaches 2560x1350")) {
    return false;
  }
  const bool old_stopped = WaitFor([&] { return rig.backend->log.Count("stop 5120x2700") == 1; });
  const long new_first = rig.backend->log.IndexOf("first-frame 2560x1350");
  const long old_stop = rig.backend->log.IndexOf("stop 5120x2700");
  const bool ok = Check(old_stopped, "the old stream is stopped") &&
                  Check(new_first >= 0 && old_stop > new_first,
                        "the old stream stops only after the new one delivered its first frame") &&
                  Check(rig.backend->log.Count("create 2560x1350") == 1, "exactly one new stream");
  rig.adapter->Stop();
  return ok && Check(rig.backend->log.Count("stop 2560x1350") == 1, "Stop stops the current stream once") &&
         Check(!rig.adapter->OutputSize().has_value(), "no output size after Stop");
}

bool TestSameSizeIsIdempotentAndNeverUpscales() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  rig.adapter->SetOutputSize({1920, 1012});
  if (!Check(WaitFor([&] { return rig.adapter->OutputSize().has_value(); }), "switched")) return false;
  const auto creates_before = rig.backend->log.Count("create 1920x1012");
  const bool again = rig.adapter->SetOutputSize({1920, 1012});
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  bool ok = Check(again, "same size is accepted") &&
            Check(creates_before == 1 && rig.backend->log.Count("create 1920x1012") == 1,
                  "same size creates no second stream");
  // Asking for more than native is the native stream: the switch goes back.
  ok = ok && Check(rig.adapter->SetOutputSize({9999, 9999}), "oversize request accepted (clamped)");
  ok = ok && Check(WaitFor([&] { return !rig.adapter->OutputSize().has_value(); }),
                   "an oversize request returns to the native size (empty)");
  ok = ok && Check(rig.backend->log.Count("create 5120x2700") == 2,
                   "never a stream larger than native");
  rig.adapter->Stop();
  return ok;
}

bool TestFailedSwitchKeepsTheRunningStream() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  rig.backend->next_first_frame_ok = false;
  if (!Check(rig.adapter->SetOutputSize({2560, 1350}), "request accepted")) return false;
  if (!Check(WaitFor([&] { return rig.backend->log.Count("stop 2560x1350") == 1; }),
             "the failed new stream is torn down")) {
    return false;
  }
  bool ok = Check(!rig.adapter->OutputSize().has_value(), "still native: the old stream keeps running") &&
            Check(rig.backend->log.Count("stop 5120x2700") == 0, "the old stream was not stopped");
  // A later request can succeed.
  ok = ok && Check(rig.adapter->SetOutputSize({2560, 1350}), "request accepted again") &&
       Check(WaitFor([&] { return rig.adapter->OutputSize().has_value(); }), "the retry succeeds");
  rig.adapter->Stop();
  return ok;
}

bool TestNotRunningRefusesAndStopCancelsAQueuedSwitch() {
  Rig rig;
  if (!MakeRig(&rig, true, /*start=*/false)) return false;
  if (!Check(!rig.adapter->SetOutputSize({2560, 1350}), "refused before Start")) return false;
  if (!Check(rig.adapter->Start(rig.display, [](common::CapturedFrame) {}), "start")) return false;
  rig.adapter->SetOutputSize({2560, 1350});
  rig.adapter->Stop();
  // Whatever the race, after Stop nothing keeps running and nothing is reported.
  const bool settled = WaitFor([&] {
    const auto lines = rig.backend->log.Snapshot();
    std::size_t starts = 0, stops = 0;
    for (const auto& line : lines) {
      if (line.rfind("start ", 0) == 0) ++starts;
      if (line.rfind("stop ", 0) == 0) ++stops;
    }
    return starts == stops;
  });
  return Check(settled, "every started stream is stopped") &&
         Check(!rig.adapter->OutputSize().has_value(), "no output size after Stop") &&
         Check(!rig.adapter->SetOutputSize({2560, 1350}), "refused after Stop");
}

class Bytes final : public common::FrameStorage {
 public:
  Bytes() : bytes_(64, std::byte{0x2a}) {}
  const std::byte* data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }

 private:
  std::vector<std::byte> bytes_;
};

common::CapturedFrame TinyFrame() {
  return common::CapturedFrame{
      .encoded_pixels = {4, 4},
      .pixel_format = common::PixelFormat::kBgra8888,
      .row_bytes = 16,
      .capture_time_us = 10,
      .color_primaries = common::ColorPrimaries::kDisplayP3,
      .storage = std::make_shared<Bytes>(),
  };
}

bool TestStopDoesNotWaitForASlowRetarget() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  rig.backend->next_block_first_frame_ms = 1500;
  if (!Check(rig.adapter->SetOutputSize({2560, 1350}), "request accepted")) return false;
  if (!Check(WaitFor([&] { return rig.backend->log.Count("first-frame-begin 2560x1350") == 1; }),
             "the retarget is waiting for its first frame")) {
    return false;
  }
  const auto before = std::chrono::steady_clock::now();
  rig.adapter->Stop();
  const auto waited = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::steady_clock::now() - before).count();
  bool ok = Check(waited < 700, "Stop() returns without waiting for the slow retarget");
  ok = ok && Check(WaitFor([&] { return rig.backend->log.Count("stop 2560x1350") == 1; }, 5000),
                   "the late stream is stopped, not installed");
  ok = ok && Check(!rig.adapter->OutputSize().has_value(), "no output size after Stop");
  return ok && Check(rig.backend->log.Count("stop 5120x2700") == 1, "the running stream was stopped once by Stop()");
}

bool TestARequestBeforeStartIsAppliedWhenTheCaptureStarts() {
  Rig rig;
  if (!MakeRig(&rig, true, /*start=*/false)) return false;
  if (!Check(!rig.adapter->SetOutputSize({2560, 1350}), "refused while not running (but remembered)")) return false;
  if (!Check(rig.adapter->Start(rig.display, [](common::CapturedFrame) {}), "start")) return false;
  const bool ok =
      Check(WaitFor([&] {
              const auto size = rig.adapter->OutputSize();
              return size.has_value() && size->width == 2560 && size->height == 1350;
            }),
            "the early request takes effect after Start without another request") &&
      Check(rig.backend->log.Count("create 2560x1350") == 1, "exactly one retarget stream");
  rig.adapter->Stop();
  return ok;
}

bool TestAStoppedCapturesRequestIsNotCarriedIntoTheNextOne() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  rig.adapter->Stop();
  rig.adapter->SetOutputSize({2560, 1350});  // refused, but remembered...
  rig.adapter->Stop();                       // ...and a Stop forgets it
  if (!Check(rig.adapter->Start(rig.display, [](common::CapturedFrame) {}), "restart")) return false;
  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  const bool ok = Check(!rig.adapter->OutputSize().has_value(), "a forgotten request is not applied to the next capture") &&
                  Check(rig.backend->log.Count("create 2560x1350") == 0, "no retarget stream was made");
  rig.adapter->Stop();
  return ok;
}

bool TestAStaleStreamNeverFeedsTheNextSession() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  rig.adapter->Stop();
  std::atomic<int> received{0};
  if (!Check(rig.adapter->Start(rig.display, [&](common::CapturedFrame) { ++received; }), "restart")) return false;
  capture::ScreenCaptureKitBackendFrameSink first_session_sink;
  capture::ScreenCaptureKitBackendFrameSink second_session_sink;
  {
    std::lock_guard lock(rig.backend->sinks_mutex);
    if (!Check(rig.backend->frame_sinks.size() == 2, "two sessions created two streams")) return false;
    first_session_sink = rig.backend->frame_sinks.front();
    second_session_sink = rig.backend->frame_sinks.back();
  }
  first_session_sink(TinyFrame());
  const bool stale_ignored = Check(received == 0, "a frame from the first session's stream is ignored") &&
                             Check(rig.adapter->Statistics().ignored_late_frames >= 1,
                                   "...and counted as a late frame");
  second_session_sink(TinyFrame());
  const bool current_delivered = Check(received == 1, "a frame from the current stream is delivered");
  rig.adapter->Stop();
  return stale_ignored && current_delivered;
}

}  // namespace

int main() {
  const bool ok = TestBackendWithoutSupportKeepsTheNativeStreamAlone() &&
                  TestSwitchIsMakeBeforeBreak() &&
                  TestSameSizeIsIdempotentAndNeverUpscales() &&
                  TestFailedSwitchKeepsTheRunningStream() &&
                  TestNotRunningRefusesAndStopCancelsAQueuedSwitch() &&
                  TestStopDoesNotWaitForASlowRetarget() &&
                  TestARequestBeforeStartIsAppliedWhenTheCaptureStarts() &&
                  TestAStoppedCapturesRequestIsNotCarriedIntoTheNextOne() &&
                  TestAStaleStreamNeverFeedsTheNextSession();
  if (ok) std::cout << "macos output-size capture counterfactuals passed\n";
  return ok ? 0 : 1;
}
