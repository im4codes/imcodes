#include "linux_native_video_source.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

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

// Real product requirement, not an edge case: this desktop must be
// watchable/controllable by more than one connection at once (an owner plus
// a guest viewer, or simply a reconnect landing before the old route has
// torn down) -- see this file's own header and CaptureAdapter's contract in
// platform_interfaces.h for why capture itself has no concept of "more than
// one caller." X11CaptureAdapter is a single process-wide instance
// (LinuxPlatformAdapters owns exactly one), and its own Start()/Stop() are
// exclusive by design (`running_.exchange(true)` rejects a second Start()
// outright) -- correct for a capture adapter that has no way to know how
// many callers it has, since Stop() takes no parameters to say which one is
// leaving. Rather than change that shared contract (used by VNC/Portal too,
// and mirrored on Windows/macOS), this multiplexer sits in FRONT of it,
// entirely on the Linux side: the first Lease to Start() is the only one
// that ever actually calls the real capture.Start(); every later Lease just
// registers its own sink and immediately gets fed the same frames. Only the
// last remaining Lease's destruction calls the real capture.Stop().
//
// Real, live-observed failure this fixes: a still-active session's capture
// was still running when a second, unrelated PREPARE arrived for the same
// worker process (session_id genuinely different, not a duplicate message) --
// the second session's Start() call hit the exclusive guard, returned false,
// and the browser's whole connection attempt died with protocol_error within
// seconds, while the FIRST session was healthy the entire time.
class SharedCaptureMultiplexer {
 public:
  bool Subscribe(CaptureAdapter& capture, const DisplayTopology& display,
                 std::uint64_t id, common::CapturedFrameSink sink) {
    bool need_start = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      sinks_[id] = std::move(sink);
      need_start = !started_;
    }
    if (!need_start) return true;
    // capture.Start() delivers its first frame SYNCHRONOUSLY (X11CaptureAdapter
    // ::Start() calls sink() before returning, deliberately, so a caller learns
    // immediately whether capture actually works) -- and that sink is Fanout(),
    // which locks mutex_ itself. Calling Start() while still holding mutex_
    // here would self-deadlock the very first Subscribe() on every session,
    // forever, on this same (single, signaling) thread that always drives this
    // multiplexer -- confirmed live: the worker hung with zero stdout output,
    // not even a WebRTC answer, on literally the first session of a rebuild
    // that otherwise compiled and linked cleanly.
    const bool started = capture.Start(display, [this](CapturedFrame frame) {
      Fanout(frame);
    });
    std::lock_guard<std::mutex> lock(mutex_);
    started_ = started;
    if (!started) {
      sinks_.erase(id);
      return false;
    }
    return true;
  }

  void Unsubscribe(CaptureAdapter& capture, std::uint64_t id) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    sinks_.erase(id);
    if (sinks_.empty() && started_) {
      capture.Stop();
      started_ = false;
    }
  }

 private:
  void Fanout(const CapturedFrame& frame) {
    // Copy sinks out before invoking them: a sink can synchronously trigger
    // work that re-enters this multiplexer (e.g. a WebRTC callback tearing
    // its own Lease down), which must not deadlock or invalidate sinks_
    // while this loop is iterating it.
    std::vector<common::CapturedFrameSink> targets;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      targets.reserve(sinks_.size());
      for (auto& [id, sink] : sinks_) targets.push_back(sink);
    }
    for (auto& sink : targets) sink(frame);
  }

  std::mutex mutex_;
  std::unordered_map<std::uint64_t, common::CapturedFrameSink> sinks_;
  bool started_ = false;
};

SharedCaptureMultiplexer& GlobalCaptureMultiplexer() {
  static SharedCaptureMultiplexer instance;
  return instance;
}

std::uint64_t NextLeaseId() noexcept {
  static std::atomic<std::uint64_t> counter{1};
  return counter.fetch_add(1, std::memory_order_relaxed);
}

class Lease final : public common::NativeVideoSourceLease {
 public:
  Lease(CaptureAdapter& capture, DisplayTopology display)
      : capture_(capture),
        display_(std::move(display)),
        source_(webrtc::make_ref_counted<Source>()),
        id_(NextLeaseId()) {}

  ~Lease() override {
    if (started_) GlobalCaptureMultiplexer().Unsubscribe(capture_, id_);
  }

  bool Start() override {
    started_ = GlobalCaptureMultiplexer().Subscribe(
        capture_, display_, id_, [this](CapturedFrame frame) {
          captured_frames_.fetch_add(1, std::memory_order_release);
          source_->PushFrame(frame);
        });
    return started_;
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
    return captured_frames_.load(std::memory_order_acquire);
  }
  std::uint64_t dropped_frames() const noexcept override { return 0; }
  bool protected_content_masked() const noexcept override { return false; }

 private:
  CaptureAdapter& capture_;
  DisplayTopology display_;
  std::string display_id_storage_ = display_.display_id;
  webrtc::scoped_refptr<Source> source_;
  // Written on the capture poll thread (X11CaptureAdapter::PollLoop's own
  // dedicated std::thread, via the Subscribe() sink lambda above), read on
  // the signaling thread (LinuxRemoteDesktopSession::HandleMediaStats, via
  // the libwebrtc GetStats() callback) -- a genuine cross-thread race on a
  // plain integer otherwise; std::atomic with acquire/release is the fix,
  // not just a defensive habit. Confirmed live via targeted instrumentation
  // during the investigation into an intermittent second-concurrent-session
  // media-delivery stall: this counter (and therefore the native
  // TransportSessionCore::Tick() media-stall watchdog that reads it via
  // captured_frames()) is the only place this specific race could produce a
  // stale read.
  std::atomic<std::uint64_t> captured_frames_{0};
  const std::uint64_t id_;
  bool started_ = false;
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
