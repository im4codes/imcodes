#ifndef IMCODES_MACOS_REMOTE_DESKTOP_CODEC_ENCODER_ADAPTERS_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_CODEC_ENCODER_ADAPTERS_H_

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>

#include "raw_video_path.h"
#include "reconfigurable_encoder.h"

namespace imcodes::remote_desktop::macos {

// An "encoder" that does not encode: it forwards the captured frame, untouched,
// to the transport's raw sink, where libwebrtc's own libvpx encoder (VP9/VP8)
// compresses it and its own RTP stack sends it. It exists so the session keeps
// one capture -> EncoderAdapter -> network shape whichever codec was negotiated.
//
// It prefers NV12 input: libvpx takes planar 4:2:0, and a capture that already
// delivers 420v turns the colour conversion into a plane split.
class RawFrameEncoderAdapter final : public ReconfigurableEncoder {
 public:
  explicit RawFrameEncoderAdapter(std::shared_ptr<RawVideoPath> path)
      : path_(std::move(path)) {}

  // Ready whenever raw codecs are allowed: libvpx is part of the pinned SDK.
  [[nodiscard]] common::ReadinessState ProbeReadiness() override {
    return path_ != nullptr && path_->raw_codecs_allowed()
               ? common::ReadinessState::kReady
               : common::ReadinessState::kUnavailable;
  }
  // `sink` is never called: there are no H.264 access units on this path.
  bool Configure(const common::EncoderConfiguration& configuration,
                 common::H264AccessUnitSink sink) override;
  bool Encode(common::CapturedFrame frame, bool request_keyframe) override;
  void Stop() noexcept override;
  [[nodiscard]] common::EncoderClass ImplementationClass() const noexcept override {
    return common::EncoderClass::kSoftware;
  }
  [[nodiscard]] std::uint64_t DroppedFrames() const noexcept override {
    return refused_frames_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] common::PixelFormat PreferredInputFormat() const noexcept override {
    return common::PixelFormat::kNv12;
  }

  bool ReconfigureFromQualitySelection(
      const imcodes::rd::QualitySelection& selection) override;
  [[nodiscard]] std::optional<common::EncoderConfiguration> Configuration()
      const override;
  void SetConfigurationObserver(std::function<void()> observer) override;

 private:
  const std::shared_ptr<RawVideoPath> path_;
  mutable std::mutex mutex_;
  std::optional<common::EncoderConfiguration> configuration_;
  std::function<void()> observer_;
  std::atomic<std::uint64_t> refused_frames_{0};
};

// Chooses, per frame, between VideoToolbox H.264 and the raw (libvpx) path by
// what was negotiated. Media starts when the session does, before the browser's
// offer arrives, so the codec is not known up front; until it is, and for H.264,
// frames take the old path unchanged.
//
// A Mac that has a hardware H.264 encoder never allows raw codecs
// (RawVideoPath::raw_codecs_allowed() stays false), so this adapter is then
// exactly the VideoToolbox encoder it wraps.
class CodecSwitchingEncoderAdapter final : public ReconfigurableEncoder {
 public:
  // Both encoders are borrowed and must outlive this adapter.
  CodecSwitchingEncoderAdapter(ReconfigurableEncoder& h264,
                               ReconfigurableEncoder& raw,
                               std::shared_ptr<RawVideoPath> path)
      : h264_(h264), raw_(raw), path_(std::move(path)) {}

  [[nodiscard]] common::ReadinessState ProbeReadiness() override {
    return h264_.ProbeReadiness();
  }
  bool Configure(const common::EncoderConfiguration& configuration,
                 common::H264AccessUnitSink sink) override;
  bool Encode(common::CapturedFrame frame, bool request_keyframe) override;
  void Stop() noexcept override;
  [[nodiscard]] common::EncoderClass ImplementationClass() const noexcept override;
  [[nodiscard]] std::uint64_t DroppedFrames() const noexcept override;
  // BGRA by default, so neither codec pays a conversion round trip. NV12 only when
  // this node may send a raw codec AND NV12 capture was asked for (an opt-in for
  // A/B measurement; RawVideoPath::PreferNv12Capture): a capture that already
  // delivers 420v makes the VP9 conversion a plane split, and the H.264 fallback
  // then converts back (see Encode).
  [[nodiscard]] common::PixelFormat PreferredInputFormat() const noexcept override;

  bool ReconfigureFromQualitySelection(
      const imcodes::rd::QualitySelection& selection) override;
  [[nodiscard]] std::optional<common::EncoderConfiguration> Configuration()
      const override;
  void SetConfigurationObserver(std::function<void()> observer) override;

  // Frames converted NV12 -> BGRA because H.264 was in use while the capture
  // delivered NV12. Non-zero is expected only on the H.264 fallback.
  [[nodiscard]] std::uint64_t fallback_conversions() const noexcept {
    return fallback_conversions_.load(std::memory_order_relaxed);
  }

 private:
  [[nodiscard]] bool RawActive() const noexcept {
    return path_ != nullptr && path_->raw_active() && raw_configured_.load();
  }

  ReconfigurableEncoder& h264_;
  ReconfigurableEncoder& raw_;
  const std::shared_ptr<RawVideoPath> path_;
  std::atomic<bool> h264_configured_{false};
  std::atomic<bool> raw_configured_{false};
  // The route the previous frame took, so a switch asks H.264 for a keyframe: its
  // session was idle and the viewer has nothing to predict from.
  std::atomic<int> last_route_{0};
  std::atomic<std::uint64_t> fallback_conversions_{0};
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_CODEC_ENCODER_ADAPTERS_H_
