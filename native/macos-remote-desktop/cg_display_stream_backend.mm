#include "cg_display_stream_backend.h"

#import <CoreGraphics/CoreGraphics.h>
#import <CoreVideo/CoreVideo.h>
#import <dispatch/dispatch.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <vector>

// CGDisplayStream is deprecated in favour of ScreenCaptureKit. Silenced only in
// this file and only because ScreenCaptureKit cannot serve the login window on
// the releases this backend exists for; using the replacement here would mean
// having no login-window capture at all below 14.4.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

namespace imcodes::remote_desktop::macos {
namespace {

namespace common = imcodes::remote_desktop::common;

/** Owns one IOSurface-backed frame for as long as the frame is alive. */
class SurfaceStorage final : public common::FrameStorage {
 public:
  SurfaceStorage(std::vector<std::byte> bytes) : bytes_(std::move(bytes)) {}

  [[nodiscard]] const std::byte* data() const noexcept override {
    return bytes_.data();
  }
  [[nodiscard]] std::size_t size() const noexcept override {
    return bytes_.size();
  }

 private:
  std::vector<std::byte> bytes_;
};

[[nodiscard]] std::int64_t NowMicroseconds() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

/**
 * Copies one IOSurface into an owned buffer.
 *
 * A copy rather than a retained surface on purpose: CGDisplayStream recycles
 * its surface pool aggressively, and a consumer that held the surface past the
 * handler would be reading frames that the compositor had already overwritten.
 * The row stride is preserved so the encoder sees the same geometry the SCK
 * path produces.
 */
[[nodiscard]] bool CopySurface(IOSurfaceRef surface, common::CapturedFrame* out) {
  if (surface == nullptr || out == nullptr) return false;
  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) != kIOReturnSuccess) {
    return false;
  }
  const std::size_t width = IOSurfaceGetWidth(surface);
  const std::size_t height = IOSurfaceGetHeight(surface);
  const std::size_t row_bytes = IOSurfaceGetBytesPerRow(surface);
  const auto* base = static_cast<const std::byte*>(IOSurfaceGetBaseAddress(surface));
  bool copied = false;
  if (base != nullptr && width > 0 && height > 0 && row_bytes > 0) {
    std::vector<std::byte> bytes(row_bytes * height);
    std::memcpy(bytes.data(), base, bytes.size());
    out->encoded_pixels = common::PixelSize{static_cast<std::uint32_t>(width),
                                            static_cast<std::uint32_t>(height)};
    out->pixel_format = common::PixelFormat::kBgra8888;
    out->row_bytes = static_cast<std::uint32_t>(row_bytes);
    out->capture_time_us = NowMicroseconds();
    out->storage = std::make_shared<SurfaceStorage>(std::move(bytes));
    copied = true;
  }
  (void)IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
  return copied;
}

class CgDisplayStreamHandle final : public ScreenCaptureKitBackendStream {
 public:
  CgDisplayStreamHandle(CGDirectDisplayID display,
                        const ScreenCaptureKitStreamConfiguration& configuration,
                        ScreenCaptureKitBackendFrameSink frame_sink,
                        ScreenCaptureKitBackendErrorSink error_sink)
      : display_(display),
        max_pending_(configuration.max_pending_frames),
        frame_sink_(std::move(frame_sink)),
        error_sink_(std::move(error_sink)) {
    queue_ = dispatch_queue_create("to.aidesk.remote-desktop.cgdisplaystream",
                                   DISPATCH_QUEUE_SERIAL);
  }

  ~CgDisplayStreamHandle() override {
    // Bounded teardown even on destruction: a stream left running would keep
    // delivering into a sink whose owner is gone.
    Stop(kDestructorStopTimeoutMs);
    // No dispatch_release: this file is compiled with ARC, which owns dispatch
    // objects. An explicit release here is both a compile error and, if it were
    // allowed, an over-release.
  }

  [[nodiscard]] bool Create(const ScreenCaptureKitStreamConfiguration& config,
                            std::string* error) {
    if (queue_ == nullptr) {
      if (error != nullptr) *error = "cgdisplaystream_queue_unavailable";
      return false;
    }
    const std::size_t width = config.encoded_pixels.width;
    const std::size_t height = config.encoded_pixels.height;
    if (width == 0 || height == 0) {
      if (error != nullptr) *error = "cgdisplaystream_invalid_geometry";
      return false;
    }

    // The login window draws its own cursor; compositing a second one would be
    // a visible artifact rather than a feature.
    const void* keys[] = {kCGDisplayStreamShowCursor,
                          kCGDisplayStreamMinimumFrameTime};
    const double minimum_frame_time =
        config.frame_rate > 0 ? 1.0 / static_cast<double>(config.frame_rate) : 0.0;
    CFNumberRef frame_time = CFNumberCreate(kCFAllocatorDefault,
                                            kCFNumberDoubleType,
                                            &minimum_frame_time);
    const void* values[] = {config.show_cursor ? kCFBooleanTrue : kCFBooleanFalse,
                            frame_time};
    CFDictionaryRef properties =
        CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2,
                           &kCFTypeDictionaryKeyCallBacks,
                           &kCFTypeDictionaryValueCallBacks);
    if (frame_time != nullptr) CFRelease(frame_time);

    stream_ = CGDisplayStreamCreateWithDispatchQueue(
        display_, width, height, kCVPixelFormatType_32BGRA, properties, queue_,
        ^(CGDisplayStreamFrameStatus status, uint64_t /*display_time*/,
          IOSurfaceRef surface, CGDisplayStreamUpdateRef /*update*/) {
          HandleFrame(status, surface);
        });
    if (properties != nullptr) CFRelease(properties);
    if (stream_ == nullptr) {
      if (error != nullptr) *error = "cgdisplaystream_create_failed";
      return false;
    }
    return true;
  }

  bool Start(std::uint32_t timeout_ms, std::string* error) override {
    (void)timeout_ms;
    if (stream_ == nullptr) {
      if (error != nullptr) *error = "cgdisplaystream_not_created";
      return false;
    }
    if (CGDisplayStreamStart(stream_) != kCGErrorSuccess) {
      if (error != nullptr) *error = "cgdisplaystream_start_failed";
      return false;
    }
    started_ = true;
    return true;
  }

  bool WaitForFirstFrame(std::uint32_t timeout_ms, std::string* error) override {
    std::unique_lock lock(mutex_);
    const bool arrived = first_frame_.wait_for(
        lock, std::chrono::milliseconds(timeout_ms),
        [this] { return saw_frame_ || failed_; });
    if (!arrived || failed_) {
      if (error != nullptr) *error = "cgdisplaystream_no_first_frame";
      return false;
    }
    return true;
  }

  void Stop(std::uint32_t timeout_ms) noexcept override {
    if (stream_ == nullptr) return;
    if (started_) {
      (void)CGDisplayStreamStop(stream_);
      started_ = false;
      // The handler may already be executing on the serial queue. Draining it
      // within the bound is what makes teardown safe: releasing the stream with
      // a live handler would free the sink out from under it.
      if (queue_ != nullptr) {
        dispatch_semaphore_t drained = dispatch_semaphore_create(0);
        dispatch_async(queue_, ^{ dispatch_semaphore_signal(drained); });
        (void)dispatch_semaphore_wait(
            drained, dispatch_time(DISPATCH_TIME_NOW,
                                   static_cast<int64_t>(timeout_ms) * NSEC_PER_MSEC));
        // `drained` is ARC-managed; it is released when this scope ends.
      }
    }
    CFRelease(stream_);
    stream_ = nullptr;
  }

 private:
  static constexpr std::uint32_t kDestructorStopTimeoutMs = 2'000;

  void HandleFrame(CGDisplayStreamFrameStatus status, IOSurfaceRef surface) {
    if (status == kCGDisplayStreamFrameStatusStopped) return;
    if (status == kCGDisplayStreamFrameStatusFrameBlank
        || status == kCGDisplayStreamFrameStatusFrameIdle) {
      // Not an error and not a frame: the screen simply did not change.
      return;
    }
    if (surface == nullptr) {
      Fail("cgdisplaystream_null_surface");
      return;
    }
    // Backpressure: the same bound the SCK path uses. Dropping here is
    // deliberate -- queueing without a bound turns a slow encoder into
    // unbounded memory growth on a machine nobody is logged into.
    if (pending_.load(std::memory_order_relaxed) >= max_pending_) return;

    common::CapturedFrame frame;
    if (!CopySurface(surface, &frame) || !frame.IsValid()) {
      Fail("cgdisplaystream_unreadable_surface");
      return;
    }
    {
      std::lock_guard lock(mutex_);
      saw_frame_ = true;
    }
    first_frame_.notify_all();
    if (frame_sink_) {
      pending_.fetch_add(1, std::memory_order_relaxed);
      frame_sink_(std::move(frame));
      pending_.fetch_sub(1, std::memory_order_relaxed);
    }
  }

  void Fail(const char* code) {
    {
      std::lock_guard lock(mutex_);
      failed_ = true;
    }
    first_frame_.notify_all();
    if (error_sink_) {
      CaptureError error;
      error.code = CaptureErrorCode::kInvalidFrame;
      error.detail = code;
      error_sink_(std::move(error));
    }
  }

  CGDirectDisplayID display_ = 0;
  std::uint32_t max_pending_ = 2;
  ScreenCaptureKitBackendFrameSink frame_sink_;
  ScreenCaptureKitBackendErrorSink error_sink_;
  dispatch_queue_t queue_ = nullptr;
  CGDisplayStreamRef stream_ = nullptr;
  bool started_ = false;
  std::atomic<std::uint32_t> pending_{0};
  std::mutex mutex_;
  std::condition_variable first_frame_;
  bool saw_frame_ = false;
  bool failed_ = false;
};

class CgDisplayStreamBackend final : public ScreenCaptureKitBackend {
 public:
  common::ReadinessState ProbeReadiness() noexcept override {
    // Preflight, never request: a backend that triggered a TCC prompt at the
    // login window would prompt where nobody can answer it.
    return CGPreflightScreenCaptureAccess() ? common::ReadinessState::kReady
                                            : common::ReadinessState::kUnavailable;
  }

  bool EnumerateDisplays(std::uint32_t timeout_ms,
                         std::uint32_t max_displays,
                         std::vector<ScreenCaptureKitBackendDisplay>* displays,
                         CaptureError* error) override {
    (void)timeout_ms;
    if (displays == nullptr || max_displays == 0) {
      if (error != nullptr) {
        error->code = CaptureErrorCode::kEnumerationFailed;
        error->detail = "cgdisplaystream_invalid_enumeration_request";
      }
      return false;
    }
    std::vector<CGDirectDisplayID> ids(max_displays);
    std::uint32_t count = 0;
    if (CGGetActiveDisplayList(max_displays, ids.data(), &count) != kCGErrorSuccess) {
      if (error != nullptr) {
        error->code = CaptureErrorCode::kEnumerationFailed;
        error->detail = "cgdisplaystream_enumeration_failed";
      }
      return false;
    }
    for (std::uint32_t index = 0; index < count; ++index) {
      const CGDirectDisplayID id = ids[index];
      ScreenCaptureKitBackendDisplay display;
      display.native_display_id = static_cast<std::uint32_t>(id);
      // Encoded pixels come from the display mode, not the logical bounds:
      // on a Retina panel those differ, and encoding at the logical size would
      // send a half-resolution image.
      CGDisplayModeRef mode = CGDisplayCopyDisplayMode(id);
      const std::size_t pixel_width =
          mode != nullptr ? CGDisplayModeGetPixelWidth(mode) : CGDisplayPixelsWide(id);
      const std::size_t pixel_height =
          mode != nullptr ? CGDisplayModeGetPixelHeight(mode) : CGDisplayPixelsHigh(id);
      if (mode != nullptr) CGDisplayModeRelease(mode);
      const CGRect bounds = CGDisplayBounds(id);
      display.encoded_pixels = common::PixelSize{
          static_cast<std::uint32_t>(pixel_width),
          static_cast<std::uint32_t>(pixel_height)};
      // LogicalRect is in points, which are genuinely fractional on a scaled
      // display; truncating to integers here would misplace input near an edge.
      display.logical_input_bounds = common::LogicalRect{
          static_cast<double>(bounds.origin.x),
          static_cast<double>(bounds.origin.y),
          static_cast<double>(bounds.size.width),
          static_cast<double>(bounds.size.height)};
      display.scale = bounds.size.width > 0
          ? static_cast<double>(pixel_width) / bounds.size.width
          : 1.0;
      display.cursor_supported = false;
      displays->push_back(display);
    }
    return !displays->empty();
  }

  std::unique_ptr<ScreenCaptureKitBackendStream> CreateStream(
      const ScreenCaptureKitStreamConfiguration& configuration,
      ScreenCaptureKitBackendFrameSink frame_sink,
      ScreenCaptureKitBackendErrorSink error_sink,
      CaptureError* error) override {
    auto handle = std::make_unique<CgDisplayStreamHandle>(
        static_cast<CGDirectDisplayID>(configuration.native_display_id),
        configuration, std::move(frame_sink), std::move(error_sink));
    std::string message;
    if (!handle->Create(configuration, &message)) {
      if (error != nullptr) {
        error->code = CaptureErrorCode::kStreamStartFailed;
        error->detail = message;
      }
      // Returning null rather than a half-built handle: a partially created
      // stream is a failure, not a degraded success.
      return nullptr;
    }
    return handle;
  }
};

}  // namespace

std::unique_ptr<ScreenCaptureKitBackend> CreateCgDisplayStreamBackend() {
  std::uint32_t count = 0;
  if (CGGetActiveDisplayList(0, nullptr, &count) != kCGErrorSuccess || count == 0) {
    // No usable display. Refusing here means a caller cannot mistake
    // "constructed" for "able to capture".
    return nullptr;
  }
  return std::make_unique<CgDisplayStreamBackend>();
}

}  // namespace imcodes::remote_desktop::macos

#pragma clang diagnostic pop
