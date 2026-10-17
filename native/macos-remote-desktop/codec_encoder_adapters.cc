#include "codec_encoder_adapters.h"

#include <algorithm>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

// Same ceiling the VideoToolbox encoder puts on a frame it copies.
constexpr std::size_t kMaxFallbackBgraBytes = 128U * 1024U * 1024U;

enum Route : int { kRouteNone = 0, kRouteH264 = 1, kRouteRaw = 2 };

std::uint32_t EvenAtLeastTwo(int value) {
  return static_cast<std::uint32_t>(std::max(2, value & ~1));
}

}  // namespace

bool RawFrameEncoderAdapter::Configure(
    const common::EncoderConfiguration& configuration,
    common::H264AccessUnitSink /*sink*/) {
  if (path_ == nullptr || !path_->raw_codecs_allowed() ||
      !configuration.encoded_pixels.IsValid()) {
    return false;
  }
  common::EncoderConfiguration stored = configuration;
  // I420 chroma needs even dimensions.
  stored.encoded_pixels.width &= ~1U;
  stored.encoded_pixels.height &= ~1U;
  if (!stored.encoded_pixels.IsValid()) return false;
  std::lock_guard lock(mutex_);
  configuration_ = stored;
  return true;
}

bool RawFrameEncoderAdapter::Encode(common::CapturedFrame frame,
                                    bool /*request_keyframe*/) {
  {
    std::lock_guard lock(mutex_);
    if (!configuration_.has_value()) {
      refused_frames_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
  }
  // The frame is read-only shared storage; nothing is copied here.
  if (path_ != nullptr && path_->PushFrame(frame)) return true;
  refused_frames_.fetch_add(1, std::memory_order_relaxed);
  return false;
}

void RawFrameEncoderAdapter::Stop() noexcept {
  std::lock_guard lock(mutex_);
  configuration_.reset();
}

bool RawFrameEncoderAdapter::ReconfigureFromQualitySelection(
    const imcodes::rd::QualitySelection& selection) {
  if (selection.width <= 0 || selection.height <= 0 || selection.fps <= 0)
    return false;
  std::function<void()> observer;
  {
    std::lock_guard lock(mutex_);
    if (!configuration_.has_value()) return false;
    const common::PixelSize size{EvenAtLeastTwo(selection.width),
                                 EvenAtLeastTwo(selection.height)};
    const bool size_changed = size.width != configuration_->encoded_pixels.width ||
                              size.height != configuration_->encoded_pixels.height;
    configuration_->encoded_pixels = size;
    configuration_->frame_rate = static_cast<std::uint32_t>(selection.fps);
    configuration_->bitrate_bps = selection.bitrate_bps;
    if (size_changed) observer = observer_;
  }
  // Outside the lock: the observer re-enters Configuration().
  if (observer) observer();
  return true;
}

std::optional<common::EncoderConfiguration> RawFrameEncoderAdapter::Configuration()
    const {
  std::lock_guard lock(mutex_);
  return configuration_;
}

void RawFrameEncoderAdapter::SetConfigurationObserver(
    std::function<void()> observer) {
  std::lock_guard lock(mutex_);
  observer_ = std::move(observer);
}

bool CodecSwitchingEncoderAdapter::Configure(
    const common::EncoderConfiguration& configuration,
    common::H264AccessUnitSink sink) {
  const bool raw_wanted = path_ != nullptr && path_->raw_codecs_allowed();
  const bool h264_ok = h264_.Configure(configuration, std::move(sink));
  const bool raw_ok = raw_wanted && raw_.Configure(configuration, {});
  h264_configured_.store(h264_ok);
  raw_configured_.store(raw_ok);
  last_route_.store(kRouteNone);
  // Usable if either encoder is: a machine whose VideoToolbox session cannot be
  // created can still send VP9.
  return h264_ok || raw_ok;
}

bool CodecSwitchingEncoderAdapter::Encode(common::CapturedFrame frame,
                                          bool request_keyframe) {
  if (RawActive()) {
    last_route_.store(kRouteRaw);
    return raw_.Encode(std::move(frame), request_keyframe);
  }
  if (!h264_configured_.load()) return false;
  if (frame.pixel_format != common::PixelFormat::kBgra8888) {
    // VideoToolbox is fed BGRA. This happens only when the capture was asked for
    // NV12 on behalf of the raw path and H.264 was negotiated instead.
    std::optional<common::CapturedFrame> converted =
        path_ != nullptr ? path_->ConvertNv12ToBgra(frame, kMaxFallbackBgraBytes)
                         : std::nullopt;
    if (!converted.has_value()) return false;
    fallback_conversions_.fetch_add(1, std::memory_order_relaxed);
    frame = std::move(*converted);
  }
  const bool switched = last_route_.exchange(kRouteH264) == kRouteRaw;
  return h264_.Encode(std::move(frame), request_keyframe || switched);
}

void CodecSwitchingEncoderAdapter::Stop() noexcept {
  h264_configured_.store(false);
  raw_configured_.store(false);
  last_route_.store(kRouteNone);
  h264_.Stop();
  raw_.Stop();
}

common::EncoderClass CodecSwitchingEncoderAdapter::ImplementationClass()
    const noexcept {
  return RawActive() ? raw_.ImplementationClass() : h264_.ImplementationClass();
}

std::uint64_t CodecSwitchingEncoderAdapter::DroppedFrames() const noexcept {
  return RawActive() ? raw_.DroppedFrames() : h264_.DroppedFrames();
}

common::PixelFormat CodecSwitchingEncoderAdapter::PreferredInputFormat()
    const noexcept {
  // BGRA unless NV12 was asked for: with BGRA the VP9 path converts once with libyuv
  // and the H.264 fallback needs no conversion at all. When NV12 is asked for, only
  // if the H.264 fallback can convert back; an NV12 capture with no way to feed
  // VideoToolbox would leave H.264 unusable.
  return path_ != nullptr && path_->raw_codecs_allowed() &&
                 path_->prefer_nv12_capture() && path_->has_nv12_to_bgra()
             ? raw_.PreferredInputFormat()
             : h264_.PreferredInputFormat();
}

bool CodecSwitchingEncoderAdapter::ReconfigureFromQualitySelection(
    const imcodes::rd::QualitySelection& selection) {
  // With a raw codec in use the idle VideoToolbox session is left alone:
  // rebuilding it for a ladder step would burn a session nobody reads.
  if (RawActive()) return raw_.ReconfigureFromQualitySelection(selection);
  // Otherwise both, so a raw codec negotiated a moment later already starts at
  // the size the ladder chose.
  const bool h264_applied = h264_.ReconfigureFromQualitySelection(selection);
  (void)raw_.ReconfigureFromQualitySelection(selection);
  return h264_applied;
}

std::optional<common::EncoderConfiguration>
CodecSwitchingEncoderAdapter::Configuration() const {
  return RawActive() ? raw_.Configuration() : h264_.Configuration();
}

void CodecSwitchingEncoderAdapter::SetConfigurationObserver(
    std::function<void()> observer) {
  h264_.SetConfigurationObserver(observer);
  raw_.SetConfigurationObserver(std::move(observer));
}

}  // namespace imcodes::remote_desktop::macos
