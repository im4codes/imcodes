#include "linux_native_video_source.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <string>
#include <utility>

#include "api/make_ref_counted.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "api/video/video_frame_buffer.h"
#include "media/base/adapted_video_track_source.h"
#include "third_party/libyuv/include/libyuv/convert.h"

#include "../remote-desktop-common/value_types.h"

namespace imcodes::remote_desktop::linux_platform {
namespace {

using imcodes::remote_desktop::common::CaptureAdapter;
using imcodes::remote_desktop::common::CapturedFrame;
using imcodes::remote_desktop::common::DisplayTopology;
using imcodes::remote_desktop::common::PixelFormat;
using imcodes::remote_desktop::common::PixelSize;
using imcodes::remote_desktop::common::ReadinessState;

// The concrete webrtc::VideoTrackSourceInterface. Captured BGRA frames are
// converted to I420 (libwebrtc's native format) with libyuv and pushed
// through AdaptedVideoTrackSource::OnFrame -- from there on this is an
// entirely ordinary WebRTC video source; nothing downstream knows or cares
// that the frames originated from X11 rather than a webcam.
// Not final: webrtc::make_ref_counted<Source>() wraps this in
// RefCountedObject<Source>, which inherits from it.
class Source : public webrtc::AdaptedVideoTrackSource {
 public:
  Source() = default;

  webrtc::MediaSourceInterface::SourceState state() const override {
    return webrtc::MediaSourceInterface::kLive;
  }
  bool remote() const override { return false; }
  bool is_screencast() const override { return true; }
  std::optional<bool> needs_denoising() const override { return false; }

  void PushFrame(const CapturedFrame& frame) {
    if (!frame.IsValid() || frame.pixel_format != PixelFormat::kBgra8888 ||
        !frame.storage) {
      return;
    }
    const int width = static_cast<int>(frame.encoded_pixels.width);
    const int height = static_cast<int>(frame.encoded_pixels.height);
    int adapted_width = 0, adapted_height = 0, crop_width = 0, crop_height = 0,
        crop_x = 0, crop_y = 0;
    if (!AdaptFrame(width, height, frame.capture_time_us, &adapted_width,
                    &adapted_height, &crop_width, &crop_height, &crop_x,
                    &crop_y)) {
      OnFrameDropped();
      return;
    }
    const uint8_t* bgra = reinterpret_cast<const uint8_t*>(frame.storage->data()) +
                          static_cast<std::size_t>(crop_y) * frame.row_bytes +
                          static_cast<std::size_t>(crop_x) * 4;
    // BGRA (X11's byte order: B,G,R,A in memory) is exactly what libyuv calls
    // ARGB (its naming is word-order 0xAARRGGBB, which in little-endian
    // memory bytes is B,G,R,A first). Convert the cropped region straight to
    // I420 at its own size, then scale only if a sink actually asked for a
    // different one -- the common case (no active downscale request) needs
    // no second pass at all.
    auto cropped = webrtc::I420Buffer::Create(crop_width, crop_height);
    libyuv::ARGBToI420(bgra, static_cast<int>(frame.row_bytes),
                       cropped->MutableDataY(), cropped->StrideY(),
                       cropped->MutableDataU(), cropped->StrideU(),
                       cropped->MutableDataV(), cropped->StrideV(),
                       crop_width, crop_height);
    webrtc::scoped_refptr<webrtc::I420Buffer> i420;
    if (adapted_width == crop_width && adapted_height == crop_height) {
      i420 = cropped;
    } else {
      i420 = webrtc::I420Buffer::Create(adapted_width, adapted_height);
      i420->ScaleFrom(*cropped);
    }
    webrtc::VideoFrame::Builder builder;
    webrtc::VideoFrame built = builder.set_video_frame_buffer(i420)
                                    .set_timestamp_us(frame.capture_time_us)
                                    .set_rotation(webrtc::kVideoRotation_0)
                                    .build();
    OnFrame(built);
    {
      std::lock_guard<std::mutex> lock(first_frame_mutex_);
      if (!first_frame_seen_) {
        first_frame_seen_ = true;
        first_frame_cv_.notify_all();
      }
    }
  }

  bool WaitForFirstFrame(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(first_frame_mutex_);
    return first_frame_cv_.wait_for(lock, timeout,
                                    [this] { return first_frame_seen_; });
  }

 private:
  std::mutex first_frame_mutex_;
  std::condition_variable first_frame_cv_;
  bool first_frame_seen_ = false;
};

class Lease final : public common::NativeVideoSourceLease {
 public:
  Lease(CaptureAdapter& capture, DisplayTopology display)
      : capture_(capture),
        display_(std::move(display)),
        source_(webrtc::make_ref_counted<Source>()) {}

  ~Lease() override { capture_.Stop(); }

  bool Start() override {
    return capture_.Start(display_, [this](CapturedFrame frame) {
      ++captured_frames_;
      source_->PushFrame(frame);
    });
  }

  bool WaitForFirstFrame(std::chrono::milliseconds timeout) override {
    return source_->WaitForFirstFrame(timeout);
  }

  webrtc::VideoTrackSourceInterface* source() const noexcept override {
    return source_.get();
  }
  std::string_view display_id() const noexcept override {
    return display_id_storage_;
  }
  std::string_view source_identity() const noexcept override {
    return "linux-x11";
  }
  PixelSize encoded_pixels() const noexcept override {
    return display_.encoded_pixels;
  }
  std::uint64_t captured_frames() const noexcept override {
    return captured_frames_;
  }
  std::uint64_t dropped_frames() const noexcept override { return 0; }
  bool protected_content_masked() const noexcept override { return false; }

 private:
  CaptureAdapter& capture_;
  DisplayTopology display_;
  std::string display_id_storage_ = display_.display_id;
  webrtc::scoped_refptr<Source> source_;
  std::uint64_t captured_frames_ = 0;
};

}  // namespace

LinuxNativeCaptureAdapter::LinuxNativeCaptureAdapter(
    common::CaptureAdapter& capture) noexcept
    : capture_(capture) {}

ReadinessState LinuxNativeCaptureAdapter::ProbeReadiness() {
  return capture_.ProbeReadiness();
}

std::unique_ptr<common::NativeVideoSourceLease>
LinuxNativeCaptureAdapter::Acquire(const DisplayTopology& display) {
  return std::make_unique<Lease>(capture_, display);
}

}  // namespace imcodes::remote_desktop::linux_platform
