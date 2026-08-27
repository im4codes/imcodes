#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "screen_capture_kit_adapter.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>
#include <mutex>
#include <unordered_map>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

// The ScreenCaptureKitLimits bounds moved to screen_capture_kit_limits.cc
// together with IsValid(); leaving copies here would be a second source of
// truth for the same limits.

std::string DisplayId(common::WorkerGeneration generation,
                      std::uint32_t native_display_id) {
  return "macos-display:" + std::to_string(generation) + ":" +
         std::to_string(native_display_id);
}

common::DisplayRotation RotationForDisplay(CGDirectDisplayID display_id) {
  int degrees = static_cast<int>(std::lround(CGDisplayRotation(display_id)));
  degrees = ((degrees % 360) + 360) % 360;
  switch (degrees) {
    case 90:
      return common::DisplayRotation::k90;
    case 180:
      return common::DisplayRotation::k180;
    case 270:
      return common::DisplayRotation::k270;
    default:
      return common::DisplayRotation::k0;
  }
}

std::string NSErrorMessage(NSError* error) {
  if (error == nil) {
    return "unknown ScreenCaptureKit error";
  }
  NSString* description = error.localizedDescription;
  return description == nil ? "unknown ScreenCaptureKit error"
                            : std::string(description.UTF8String);
}

dispatch_time_t Deadline(std::uint32_t timeout_ms) {
  return dispatch_time(DISPATCH_TIME_NOW,
                       static_cast<int64_t>(timeout_ms) * NSEC_PER_MSEC);
}

class PixelBufferStorage final : public common::FrameStorage {
 public:
  explicit PixelBufferStorage(CVPixelBufferRef pixel_buffer)
      : pixel_buffer_(pixel_buffer) {
    if (pixel_buffer_ == nullptr) {
      return;
    }
    CVPixelBufferRetain(pixel_buffer_);
    if (CVPixelBufferLockBaseAddress(pixel_buffer_,
                                     kCVPixelBufferLock_ReadOnly) !=
        kCVReturnSuccess) {
      CVPixelBufferRelease(pixel_buffer_);
      pixel_buffer_ = nullptr;
      return;
    }
    locked_ = true;
    data_ = static_cast<const std::byte*>(
        CVPixelBufferGetBaseAddress(pixel_buffer_));
    size_ = CVPixelBufferGetDataSize(pixel_buffer_);
  }

  ~PixelBufferStorage() override {
    if (pixel_buffer_ == nullptr) {
      return;
    }
    if (locked_) {
      CVPixelBufferUnlockBaseAddress(pixel_buffer_,
                                     kCVPixelBufferLock_ReadOnly);
    }
    CVPixelBufferRelease(pixel_buffer_);
  }

  [[nodiscard]] const std::byte* data() const noexcept override {
    return data_;
  }

  [[nodiscard]] std::size_t size() const noexcept override { return size_; }

 private:
  CVPixelBufferRef pixel_buffer_ = nullptr;
  bool locked_ = false;
  const std::byte* data_ = nullptr;
  std::size_t size_ = 0;
};

common::ColorPrimaries ColorPrimariesForBuffer(CVPixelBufferRef buffer) {
  CFTypeRef value = CVBufferCopyAttachment(
      buffer, kCVImageBufferColorPrimariesKey, nullptr);
  if (value == nullptr || CFGetTypeID(value) != CFStringGetTypeID()) {
    if (value != nullptr) {
      CFRelease(value);
    }
    return common::ColorPrimaries::kUnspecified;
  }
  common::ColorPrimaries result = common::ColorPrimaries::kUnspecified;
  if (CFEqual(value, kCVImageBufferColorPrimaries_ITU_R_709_2)) {
    result = common::ColorPrimaries::kBt709;
  } else if (CFEqual(value, kCVImageBufferColorPrimaries_P3_D65)) {
    result = common::ColorPrimaries::kDisplayP3;
  }
  CFRelease(value);
  return result;
}

bool IsCompleteScreenFrame(CMSampleBufferRef sample_buffer) {
  CFArrayRef attachments =
      CMSampleBufferGetSampleAttachmentsArray(sample_buffer, false);
  if (attachments == nullptr || CFArrayGetCount(attachments) == 0) {
    return false;
  }
  CFDictionaryRef dictionary = static_cast<CFDictionaryRef>(
      CFArrayGetValueAtIndex(attachments, 0));
  CFTypeRef status = CFDictionaryGetValue(
      dictionary, (__bridge const void*)SCStreamFrameInfoStatus);
  return status != nullptr &&
         [(__bridge NSNumber*)status integerValue] == SCFrameStatusComplete;
}

std::optional<common::CapturedFrame> ConvertFrame(
    CMSampleBufferRef sample_buffer) {
  if (sample_buffer == nullptr || !CMSampleBufferIsValid(sample_buffer) ||
      !IsCompleteScreenFrame(sample_buffer)) {
    return std::nullopt;
  }
  CVPixelBufferRef pixel_buffer =
      CMSampleBufferGetImageBuffer(sample_buffer);
  if (pixel_buffer == nullptr) {
    return std::nullopt;
  }

  CMTime timestamp = CMSampleBufferGetPresentationTimeStamp(sample_buffer);
  const double seconds = CMTimeGetSeconds(timestamp);
  if (!std::isfinite(seconds) || seconds < 0.0 ||
      seconds > static_cast<double>(std::numeric_limits<std::int64_t>::max()) /
                    1'000'000.0) {
    return std::nullopt;
  }

  auto storage = std::make_shared<PixelBufferStorage>(pixel_buffer);
  common::CapturedFrame frame{
      .encoded_pixels =
          {static_cast<std::uint32_t>(CVPixelBufferGetWidth(pixel_buffer)),
           static_cast<std::uint32_t>(CVPixelBufferGetHeight(pixel_buffer))},
      .pixel_format = common::PixelFormat::kBgra8888,
      .row_bytes =
          static_cast<std::uint32_t>(CVPixelBufferGetBytesPerRow(pixel_buffer)),
      .capture_time_us =
          static_cast<std::int64_t>(std::llround(seconds * 1'000'000.0)),
      .color_primaries = ColorPrimariesForBuffer(pixel_buffer),
      .storage = std::move(storage),
  };
  if (!frame.IsValid()) {
    return std::nullopt;
  }
  return frame;
}

}  // namespace
}  // namespace imcodes::remote_desktop::macos

@interface IMCodesScreenCaptureOutput
    : NSObject <SCStreamOutput, SCStreamDelegate> {
@private
  void (^_frameHandler)(CMSampleBufferRef);
  void (^_errorHandler)(NSError*);
}
@property(nonatomic, copy) void (^frameHandler)(CMSampleBufferRef);
@property(nonatomic, copy) void (^errorHandler)(NSError*);
@end

@implementation IMCodesScreenCaptureOutput
@synthesize frameHandler = _frameHandler;
@synthesize errorHandler = _errorHandler;

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type == SCStreamOutputTypeScreen && self.frameHandler != nil) {
    self.frameHandler(sampleBuffer);
  }
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
  (void)stream;
  if (self.errorHandler != nil) {
    self.errorHandler(error);
  }
}
@end

namespace imcodes::remote_desktop::macos {
namespace {

class AppleScreenCaptureKitStream final : public ScreenCaptureKitBackendStream {
 public:
  AppleScreenCaptureKitStream(
      SCStream* stream,
      IMCodesScreenCaptureOutput* output,
      dispatch_queue_t queue,
      ScreenCaptureKitBackendFrameSink frame_sink,
      ScreenCaptureKitBackendErrorSink error_sink)
      : stream_(stream), output_(output), queue_(queue) {
    output_.frameHandler = ^(CMSampleBufferRef sample_buffer) {
      std::optional<common::CapturedFrame> frame = ConvertFrame(sample_buffer);
      if (frame.has_value()) {
        if (!first_frame_seen_.exchange(true)) {
          dispatch_semaphore_signal(first_frame_semaphore_);
        }
        frame_sink(std::move(*frame));
      }
    };
    output_.errorHandler = ^(NSError* error) {
      terminal_error_seen_.store(true);
      if (!first_frame_seen_.load()) {
        dispatch_semaphore_signal(first_frame_semaphore_);
      }
      error_sink(CaptureError{CGPreflightScreenCaptureAccess()
                                  ? CaptureErrorCode::kStreamStopped
                                  : CaptureErrorCode::kPermissionDenied,
                              NSErrorMessage(error)});
    };
  }

  ~AppleScreenCaptureKitStream() override { Stop(250); }

  bool Start(std::uint32_t timeout_ms, std::string* error) override {
    NSError* output_error = nil;
    if (![stream_ addStreamOutput:output_
                            type:SCStreamOutputTypeScreen
              sampleHandlerQueue:queue_
                           error:&output_error]) {
      if (error != nullptr) {
        *error = NSErrorMessage(output_error);
      }
      return false;
    }

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSError* start_error = nil;
    start_requested_ = true;
    [stream_ startCaptureWithCompletionHandler:^(NSError* completion_error) {
      start_error = completion_error;
      dispatch_semaphore_signal(semaphore);
    }];
    if (dispatch_semaphore_wait(semaphore, Deadline(timeout_ms)) != 0) {
      if (error != nullptr) {
        *error = "ScreenCaptureKit stream start timed out";
      }
      return false;
    }
    if (start_error != nil) {
      if (error != nullptr) {
        *error = NSErrorMessage(start_error);
      }
      return false;
    }
    return true;
  }

  bool WaitForFirstFrame(std::uint32_t timeout_ms,
                         std::string* error) override {
    if (first_frame_seen_.load()) {
      return true;
    }
    if (dispatch_semaphore_wait(first_frame_semaphore_, Deadline(timeout_ms)) !=
        0) {
      if (error != nullptr) {
        *error = "ScreenCaptureKit first frame timed out";
      }
      return false;
    }
    if (!first_frame_seen_.load()) {
      if (error != nullptr) {
        *error = terminal_error_seen_.load()
                     ? "ScreenCaptureKit stopped before the first frame"
                     : "ScreenCaptureKit first frame was unavailable";
      }
      return false;
    }
    return true;
  }

  void Stop(std::uint32_t timeout_ms) noexcept override {
    if (!start_requested_) {
      output_.frameHandler = nil;
      output_.errorHandler = nil;
      return;
    }
    start_requested_ = false;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [stream_ stopCaptureWithCompletionHandler:^(NSError* error) {
      (void)error;
      dispatch_semaphore_signal(semaphore);
    }];
    (void)dispatch_semaphore_wait(semaphore, Deadline(timeout_ms));
    output_.frameHandler = nil;
    output_.errorHandler = nil;
  }

 private:
  __strong SCStream* stream_ = nil;
  __strong IMCodesScreenCaptureOutput* output_ = nil;
  dispatch_queue_t queue_ = nullptr;
  dispatch_semaphore_t first_frame_semaphore_ =
      dispatch_semaphore_create(0);
  std::atomic<bool> first_frame_seen_{false};
  std::atomic<bool> terminal_error_seen_{false};
  bool start_requested_ = false;
};

class AppleScreenCaptureKitBackend final : public ScreenCaptureKitBackend {
 public:
  [[nodiscard]] common::ReadinessState ProbeReadiness() noexcept override {
    // CGPreflightScreenCaptureAccess is intentionally non-interactive. Never
    // call CGRequestScreenCaptureAccess from a remote route.
    if ([SCShareableContent class] == Nil) {
      return common::ReadinessState::kUnavailable;
    }
    return CGPreflightScreenCaptureAccess()
               ? common::ReadinessState::kReady
               : common::ReadinessState::kUnavailable;
  }

  bool EnumerateDisplays(
      std::uint32_t timeout_ms,
      std::uint32_t max_displays,
      std::vector<ScreenCaptureKitBackendDisplay>* displays,
      CaptureError* error) override {
    if (displays == nullptr || error == nullptr) {
      return false;
    }
    if (ProbeReadiness() != common::ReadinessState::kReady) {
      *error = {CaptureErrorCode::kPermissionDenied,
                "Screen Recording permission is not currently granted"};
      return false;
    }

    struct Result {
      std::mutex mutex;
      SCShareableContent* content = nil;
      NSError* error = nil;
    };
    auto result = std::make_shared<Result>();
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [SCShareableContent
        getShareableContentExcludingDesktopWindows:YES
                                onScreenWindowsOnly:YES
                                 completionHandler:^(SCShareableContent* content,
                                                     NSError* content_error) {
                                   {
                                     std::lock_guard lock(result->mutex);
                                     result->content = content;
                                     result->error = content_error;
                                   }
                                   dispatch_semaphore_signal(semaphore);
                                 }];
    if (dispatch_semaphore_wait(semaphore, Deadline(timeout_ms)) != 0) {
      *error = {CaptureErrorCode::kEnumerationTimedOut,
                "ScreenCaptureKit display enumeration timed out"};
      return false;
    }

    SCShareableContent* content = nil;
    NSError* content_error = nil;
    {
      std::lock_guard lock(result->mutex);
      content = result->content;
      content_error = result->error;
    }
    if (content_error != nil || content == nil) {
      *error = {CGPreflightScreenCaptureAccess()
                    ? CaptureErrorCode::kEnumerationFailed
                    : CaptureErrorCode::kPermissionDenied,
                NSErrorMessage(content_error)};
      return false;
    }

    std::vector<ScreenCaptureKitBackendDisplay> found;
    found.reserve(std::min<std::size_t>(content.displays.count, max_displays));
    for (SCDisplay* display in content.displays) {
      if (found.size() >= max_displays) {
        break;
      }
      const CGRect frame = display.frame;
      const auto pixel_width = static_cast<std::uint32_t>(display.width);
      const auto pixel_height = static_cast<std::uint32_t>(display.height);
      if (display.displayID == 0 || pixel_width == 0 || pixel_height == 0 ||
          !std::isfinite(frame.origin.x) || !std::isfinite(frame.origin.y) ||
          !std::isfinite(frame.size.width) ||
          !std::isfinite(frame.size.height) || frame.size.width <= 0.0 ||
          frame.size.height <= 0.0) {
        continue;
      }
      const double scale_x = pixel_width / frame.size.width;
      const double scale_y = pixel_height / frame.size.height;
      const double scale = std::max(scale_x, scale_y);
      ScreenCaptureKitBackendDisplay candidate{
          .native_display_id = display.displayID,
          .encoded_pixels = {pixel_width, pixel_height},
          .logical_input_bounds = {frame.origin.x, frame.origin.y,
                                   frame.size.width, frame.size.height},
          .scale = scale,
          .rotation = RotationForDisplay(display.displayID),
          .cursor_supported = true,
      };
      if (candidate.encoded_pixels.IsValid() &&
          candidate.logical_input_bounds.IsValid() &&
          std::isfinite(candidate.scale) && candidate.scale > 0.0 &&
          candidate.scale <= 16.0) {
        found.push_back(candidate);
      }
    }
    std::sort(found.begin(), found.end(), [](const auto& left, const auto& right) {
      return left.native_display_id < right.native_display_id;
    });
    if (found.empty()) {
      *error = {CaptureErrorCode::kNoPresentableDisplay,
                "ScreenCaptureKit reported no presentable display"};
      return false;
    }
    *displays = std::move(found);
    *error = {};
    return true;
  }

  std::unique_ptr<ScreenCaptureKitBackendStream> CreateStream(
      const ScreenCaptureKitStreamConfiguration& configuration,
      ScreenCaptureKitBackendFrameSink frame_sink,
      ScreenCaptureKitBackendErrorSink error_sink,
      CaptureError* error) override {
    if (error == nullptr) {
      return nullptr;
    }
    if (ProbeReadiness() != common::ReadinessState::kReady) {
      *error = {CaptureErrorCode::kPermissionDenied,
                "Screen Recording permission is not currently granted"};
      return nullptr;
    }

    // Stream creation re-enumerates so a stale SCDisplay Objective-C object is
    // never retained across a topology refresh.
    struct Result {
      std::mutex mutex;
      SCShareableContent* content = nil;
      NSError* error = nil;
    };
    auto result = std::make_shared<Result>();
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [SCShareableContent
        getShareableContentExcludingDesktopWindows:YES
                                onScreenWindowsOnly:YES
                                 completionHandler:^(SCShareableContent* content,
                                                     NSError* content_error) {
                                   {
                                     std::lock_guard lock(result->mutex);
                                     result->content = content;
                                     result->error = content_error;
                                   }
                                   dispatch_semaphore_signal(semaphore);
                                 }];
    if (dispatch_semaphore_wait(
            semaphore, Deadline(configuration.display_lookup_timeout_ms)) != 0) {
      *error = {CaptureErrorCode::kEnumerationTimedOut,
                "ScreenCaptureKit stream display lookup timed out"};
      return nullptr;
    }
    SCShareableContent* content = nil;
    NSError* content_error = nil;
    {
      std::lock_guard lock(result->mutex);
      content = result->content;
      content_error = result->error;
    }
    if (content_error != nil || content == nil) {
      *error = {CGPreflightScreenCaptureAccess()
                    ? CaptureErrorCode::kEnumerationFailed
                    : CaptureErrorCode::kPermissionDenied,
                NSErrorMessage(content_error)};
      return nullptr;
    }
    SCDisplay* selected = nil;
    for (SCDisplay* display in content.displays) {
      if (display.displayID == configuration.native_display_id) {
        selected = display;
        break;
      }
    }
    if (selected == nil) {
      *error = {CaptureErrorCode::kInvalidDisplay,
                "selected display is no longer present"};
      return nullptr;
    }

    SCContentFilter* filter =
        [[SCContentFilter alloc] initWithDisplay:selected excludingWindows:@[]];
    SCStreamConfiguration* stream_configuration =
        [[SCStreamConfiguration alloc] init];
    stream_configuration.width = configuration.encoded_pixels.width;
    stream_configuration.height = configuration.encoded_pixels.height;
    stream_configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    stream_configuration.minimumFrameInterval =
        CMTimeMake(1, configuration.frame_rate);
    stream_configuration.queueDepth = configuration.max_pending_frames;
    stream_configuration.showsCursor = configuration.show_cursor;

    IMCodesScreenCaptureOutput* output =
        [[IMCodesScreenCaptureOutput alloc] init];
    dispatch_queue_t queue = dispatch_queue_create(
        "codes.im.remote-desktop.capture", DISPATCH_QUEUE_SERIAL);
    SCStream* stream = [[SCStream alloc] initWithFilter:filter
                                          configuration:stream_configuration
                                               delegate:output];
    if (stream == nil) {
      *error = {CaptureErrorCode::kStreamStartFailed,
                "ScreenCaptureKit did not create a stream"};
      return nullptr;
    }
    *error = {};
    return std::make_unique<AppleScreenCaptureKitStream>(
        stream, output, queue, std::move(frame_sink), std::move(error_sink));
  }
};

struct DeliveryState {
  mutable std::mutex mutex;
  bool accepting = false;
  std::uint32_t max_pending_frames = 0;
  common::CapturedFrameSink sink;
  CaptureError last_error;
  ScreenCaptureKitStatistics statistics;

  void Deliver(common::CapturedFrame frame) {
    common::CapturedFrameSink current_sink;
    {
      std::lock_guard lock(mutex);
      if (!accepting) {
        ++statistics.ignored_late_frames;
        return;
      }
      if (!frame.IsValid()) {
        ++statistics.rejected_invalid_frames;
        return;
      }
      if (statistics.pending_frames >= max_pending_frames) {
        ++statistics.dropped_backpressure_frames;
        return;
      }
      ++statistics.pending_frames;
      ++statistics.accepted_frames;
      current_sink = sink;
    }
    current_sink(std::move(frame));
    {
      std::lock_guard lock(mutex);
      if (statistics.pending_frames > 0) {
        --statistics.pending_frames;
      }
    }
  }

  void Fail(CaptureError error) {
    std::lock_guard lock(mutex);
    if (!accepting) {
      return;
    }
    accepting = false;
    sink = {};
    last_error = std::move(error);
  }
};

}  // namespace

// ScreenCaptureKitLimits::IsValid moved to screen_capture_kit_limits.cc so
// the LoginWindow capture supervisor can validate the same bounds without
// linking ScreenCaptureKit. Not duplicated: relocated.

class ScreenCaptureKitAdapter::Impl {
 public:
  Impl(common::WorkerGeneration generation,
       std::unique_ptr<ScreenCaptureKitBackend> capture_backend,
       ScreenCaptureKitLimits capture_limits)
      : worker_generation(generation),
        backend(std::move(capture_backend)),
        limits(capture_limits),
        delivery(std::make_shared<DeliveryState>()) {
    delivery->max_pending_frames = limits.max_pending_frames;
  }

  [[nodiscard]] common::ReadinessState ProbeReadiness() {
    if (worker_generation == 0 || !backend || !limits.IsValid()) {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = {CaptureErrorCode::kStreamStartFailed,
                              "invalid ScreenCaptureKit adapter configuration"};
      return common::ReadinessState::kUnavailable;
    }
    const common::ReadinessState readiness = backend->ProbeReadiness();
    if (readiness != common::ReadinessState::kReady) {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = {
          CaptureErrorCode::kPermissionDenied,
          "Screen Recording permission is not currently granted"};
    }
    return readiness;
  }

  std::optional<common::DesktopTopology> EnumerateTopology() {
    if (ProbeReadiness() != common::ReadinessState::kReady) {
      return std::nullopt;
    }
    std::vector<ScreenCaptureKitBackendDisplay> backend_displays;
    CaptureError error;
    if (!backend->EnumerateDisplays(limits.enumeration_timeout_ms,
                                    limits.max_displays, &backend_displays,
                                    &error)) {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = std::move(error);
      return std::nullopt;
    }
    if (backend_displays.empty() ||
        backend_displays.size() > limits.max_displays) {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = {CaptureErrorCode::kNoPresentableDisplay,
                              "invalid ScreenCaptureKit display set"};
      return std::nullopt;
    }

    std::sort(backend_displays.begin(), backend_displays.end(),
              [](const auto& left, const auto& right) {
                return left.native_display_id < right.native_display_id;
              });
    std::unordered_map<std::string, ScreenCaptureKitBackendDisplay> next;
    common::DesktopTopology topology{
        .generation = worker_generation,
        .revision = topology_revision,
        .displays = {},
    };
    for (const auto& backend_display : backend_displays) {
      const std::string display_id =
          DisplayId(worker_generation, backend_display.native_display_id);
      common::DisplayTopology display{
          .display_id = display_id,
          .generation = worker_generation,
          .encoded_pixels = backend_display.encoded_pixels,
          .logical_input_bounds = backend_display.logical_input_bounds,
          .scale = backend_display.scale,
          .rotation = backend_display.rotation,
          .operations = {.selectable = true,
                         .set_mode = false,
                         .set_scale = false},
      };
      if (backend_display.native_display_id == 0 || !display.IsValid() ||
          !next.emplace(display_id, backend_display).second) {
        std::lock_guard lock(delivery->mutex);
        delivery->last_error = {CaptureErrorCode::kInvalidDisplay,
                                "ScreenCaptureKit returned invalid display metadata"};
        return std::nullopt;
      }
      topology.displays.push_back(std::move(display));
    }

    const bool changed = !EquivalentDisplays(displays, next);
    if (changed && !displays.empty()) {
      ++topology_revision;
    }
    topology.revision = topology_revision;
    displays = std::move(next);
    if (!topology.IsValid()) {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = {CaptureErrorCode::kInvalidDisplay,
                              "ScreenCaptureKit topology failed validation"};
      return std::nullopt;
    }
    {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = {};
    }
    return topology;
  }

  static bool EquivalentDisplays(
      const std::unordered_map<std::string, ScreenCaptureKitBackendDisplay>& left,
      const std::unordered_map<std::string, ScreenCaptureKitBackendDisplay>& right) {
    if (left.size() != right.size()) {
      return false;
    }
    for (const auto& [id, value] : left) {
      const auto it = right.find(id);
      if (it == right.end()) {
        return false;
      }
      const auto& other = it->second;
      if (value.native_display_id != other.native_display_id ||
          value.encoded_pixels.width != other.encoded_pixels.width ||
          value.encoded_pixels.height != other.encoded_pixels.height ||
          value.logical_input_bounds.x != other.logical_input_bounds.x ||
          value.logical_input_bounds.y != other.logical_input_bounds.y ||
          value.logical_input_bounds.width != other.logical_input_bounds.width ||
          value.logical_input_bounds.height != other.logical_input_bounds.height ||
          value.scale != other.scale || value.rotation != other.rotation ||
          value.cursor_supported != other.cursor_supported) {
        return false;
      }
    }
    return true;
  }

  bool Start(const common::DisplayTopology& display,
             common::CapturedFrameSink sink) {
    if (!sink || !display.IsValid() ||
        display.generation != worker_generation) {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = {CaptureErrorCode::kInvalidDisplay,
                              "capture start received an invalid display"};
      return false;
    }
    const auto found = displays.find(display.display_id);
    if (found == displays.end()) {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = {CaptureErrorCode::kInvalidDisplay,
                              "capture start requires a current enumerated display"};
      return false;
    }
    const auto& current = found->second;
    if (display.encoded_pixels.width != current.encoded_pixels.width ||
        display.encoded_pixels.height != current.encoded_pixels.height ||
        display.logical_input_bounds.x != current.logical_input_bounds.x ||
        display.logical_input_bounds.y != current.logical_input_bounds.y ||
        display.logical_input_bounds.width !=
            current.logical_input_bounds.width ||
        display.logical_input_bounds.height !=
            current.logical_input_bounds.height ||
        display.scale != current.scale || display.rotation != current.rotation) {
      std::lock_guard lock(delivery->mutex);
      delivery->last_error = {
          CaptureErrorCode::kInvalidDisplay,
          "capture start rejected stale display topology metadata"};
      return false;
    }
    Stop();
    {
      std::lock_guard lock(delivery->mutex);
      delivery->accepting = true;
      delivery->sink = std::move(sink);
      delivery->last_error = {};
    }

    const auto shared_delivery = delivery;
    CaptureError create_error;
    stream = backend->CreateStream(
        ScreenCaptureKitStreamConfiguration{
            .native_display_id = found->second.native_display_id,
            .encoded_pixels = display.encoded_pixels,
            .display_lookup_timeout_ms = limits.enumeration_timeout_ms,
            .frame_rate = limits.frame_rate,
            .max_pending_frames = limits.max_pending_frames,
            .show_cursor = found->second.cursor_supported,
        },
        [shared_delivery](common::CapturedFrame frame) {
          shared_delivery->Deliver(std::move(frame));
        },
        [shared_delivery](CaptureError error) {
          shared_delivery->Fail(std::move(error));
        },
        &create_error);
    if (!stream) {
      delivery->Fail(create_error.IsError()
                         ? std::move(create_error)
                         : CaptureError{CaptureErrorCode::kStreamStartFailed,
                                        "ScreenCaptureKit stream creation failed"});
      return false;
    }
    std::string start_error;
    if (!stream->Start(limits.stream_start_timeout_ms, &start_error)) {
      delivery->Fail({CaptureErrorCode::kStreamStartFailed,
                      start_error.empty() ? "ScreenCaptureKit stream start failed"
                                          : std::move(start_error)});
      stream->Stop(limits.stream_stop_timeout_ms);
      stream.reset();
      return false;
    }
    std::string first_frame_error;
    if (!stream->WaitForFirstFrame(limits.first_frame_timeout_ms,
                                   &first_frame_error)) {
      delivery->Fail(
          {CaptureErrorCode::kFirstFrameTimedOut,
           first_frame_error.empty()
               ? "ScreenCaptureKit first frame did not arrive before deadline"
               : std::move(first_frame_error)});
      stream->Stop(limits.stream_stop_timeout_ms);
      stream.reset();
      return false;
    }
    return true;
  }

  void Stop() noexcept {
    {
      std::lock_guard lock(delivery->mutex);
      delivery->accepting = false;
      delivery->sink = {};
    }
    if (stream) {
      stream->Stop(limits.stream_stop_timeout_ms);
      stream.reset();
    }
  }

  const common::WorkerGeneration worker_generation;
  std::unique_ptr<ScreenCaptureKitBackend> backend;
  const ScreenCaptureKitLimits limits;
  std::shared_ptr<DeliveryState> delivery;
  common::TopologyRevision topology_revision = 1;
  std::unordered_map<std::string, ScreenCaptureKitBackendDisplay> displays;
  std::unique_ptr<ScreenCaptureKitBackendStream> stream;
};

std::unique_ptr<ScreenCaptureKitBackend> CreateAppleScreenCaptureKitBackend() {
  return std::make_unique<AppleScreenCaptureKitBackend>();
}

ScreenCaptureKitAdapter::ScreenCaptureKitAdapter(
    common::WorkerGeneration worker_generation,
    ScreenCaptureKitLimits limits)
    : ScreenCaptureKitAdapter(worker_generation,
                              CreateAppleScreenCaptureKitBackend(),
                              limits) {}

ScreenCaptureKitAdapter::ScreenCaptureKitAdapter(
    common::WorkerGeneration worker_generation,
    std::unique_ptr<ScreenCaptureKitBackend> backend,
    ScreenCaptureKitLimits limits)
    : impl_(std::make_unique<Impl>(worker_generation, std::move(backend),
                                   limits)) {}

ScreenCaptureKitAdapter::~ScreenCaptureKitAdapter() { Stop(); }

common::ReadinessState ScreenCaptureKitAdapter::ProbeReadiness() {
  return impl_->ProbeReadiness();
}

std::optional<common::DesktopTopology>
ScreenCaptureKitAdapter::EnumerateTopology() {
  return impl_->EnumerateTopology();
}

bool ScreenCaptureKitAdapter::SelectDisplay(std::string_view display_id) {
  const auto found = impl_->displays.find(std::string(display_id));
  return found != impl_->displays.end();
}

bool ScreenCaptureKitAdapter::SetMode(std::string_view display_id,
                                      common::PixelSize pixels) {
  (void)display_id;
  (void)pixels;
  return false;
}

bool ScreenCaptureKitAdapter::SetScale(std::string_view display_id,
                                       double scale) {
  (void)display_id;
  (void)scale;
  return false;
}

bool ScreenCaptureKitAdapter::Start(const common::DisplayTopology& display,
                                    common::CapturedFrameSink sink) {
  return impl_->Start(display, std::move(sink));
}

void ScreenCaptureKitAdapter::Stop() noexcept { impl_->Stop(); }

bool ScreenCaptureKitAdapter::CursorCaptureSupported(
    std::string_view display_id) const noexcept {
  const auto found = impl_->displays.find(std::string(display_id));
  return found != impl_->displays.end() && found->second.cursor_supported;
}

CaptureError ScreenCaptureKitAdapter::LastError() const {
  std::lock_guard lock(impl_->delivery->mutex);
  return impl_->delivery->last_error;
}

ScreenCaptureKitStatistics ScreenCaptureKitAdapter::Statistics() const {
  std::lock_guard lock(impl_->delivery->mutex);
  return impl_->delivery->statistics;
}

}  // namespace imcodes::remote_desktop::macos
