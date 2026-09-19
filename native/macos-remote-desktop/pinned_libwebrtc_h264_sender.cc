#include "pinned_libwebrtc_h264_sender.h"

#include <cstdint>
#include <mutex>
#include <utility>

#include "api/video/encoded_image.h"
#include "api/video_codecs/video_encoder.h"
#include "modules/video_coding/codecs/h264/include/h264_globals.h"
#include "modules/video_coding/codecs/interface/common_constants.h"
#include "modules/video_coding/include/video_codec_interface.h"

namespace imcodes::remote_desktop::macos {
namespace {

class PinnedLibwebrtcH264Sender final : public H264SenderBackend {
public:
  explicit PinnedLibwebrtcH264Sender(webrtc::EncodedImageCallback *callback)
      : callback_(callback) {}

  bool Start(const H264SenderConfiguration &configuration) override {
    if (callback_ == nullptr || !configuration.IsValid()) {
      return false;
    }
    std::lock_guard submission_lock(submission_mutex_);
    std::lock_guard lock(mutex_);
    configuration_ = configuration;
    drop_next_delta_ = false;
    active_ = true;
    return true;
  }

  bool Submit(H264SenderFrame frame,
              H264SenderCompletionCallback completion) override {
    std::unique_lock submission_lock(submission_mutex_);
    H264SenderConfiguration configuration;
    bool drop_without_submission = false;
    {
      std::lock_guard lock(mutex_);
      if (!active_ || frame.generation != configuration_.generation ||
          frame.profile != configuration_.profile || frame.bytes.empty()) {
        return false;
      }
      if (drop_next_delta_ && !frame.keyframe) {
        drop_next_delta_ = false;
        drop_without_submission = true;
      } else {
        configuration = configuration_;
      }
    }
    if (drop_without_submission) {
      submission_lock.unlock();
      completion(H264SenderCompletion::kDropped, 0);
      return true;
    }

    // EncodedImageBuffer::Create is the sole payload copy in this bridge. Its
    // size was admitted by H264SenderBridge before this point; libwebrtc owns
    // the resulting ref-counted storage after OnEncodedImage returns.
    auto encoded = webrtc::EncodedImageBuffer::Create(
        reinterpret_cast<const std::uint8_t *>(frame.bytes.data()),
        frame.bytes.size());
    if (encoded == nullptr) {
      submission_lock.unlock();
      completion(H264SenderCompletion::kFatal, 0);
      return true;
    }

    webrtc::EncodedImage image;
    image.SetEncodedData(std::move(encoded));
    image._encodedWidth = configuration.encoded_pixels.width;
    image._encodedHeight = configuration.encoded_pixels.height;
    image.SetRtpTimestamp(frame.rtp_timestamp_90khz);
    image.capture_time_ms_ = frame.capture_time_ms;
    image.set_frame_type(frame.keyframe
                             ? webrtc::VideoFrameType::kVideoFrameKey
                             : webrtc::VideoFrameType::kVideoFrameDelta);
    image.content_type_ = webrtc::VideoContentType::SCREENSHARE;

    webrtc::CodecSpecificInfo codec;
    codec.codecType = webrtc::kVideoCodecH264;
    codec.codecSpecific.H264.packetization_mode =
        webrtc::H264PacketizationMode::NonInterleaved;
    codec.codecSpecific.H264.temporal_idx = webrtc::kNoTemporalIdx;
    codec.codecSpecific.H264.idr_frame = frame.keyframe;
    codec.codecSpecific.H264.base_layer_sync = false;

    const webrtc::EncodedImageCallback::Result result =
        callback_->OnEncodedImage(image, &codec);
    if (result.error == webrtc::EncodedImageCallback::Result::OK &&
        result.drop_next_frame) {
      std::lock_guard lock(mutex_);
      if (active_ && configuration_.generation == frame.generation) {
        drop_next_delta_ = true;
      }
    }
    submission_lock.unlock();
    completion(result.error == webrtc::EncodedImageCallback::Result::OK
                   ? H264SenderCompletion::kAccepted
                   : H264SenderCompletion::kDropped,
               frame.bytes.size());
    return true;
  }

  void Cancel(common::WorkerGeneration generation) noexcept override {
    std::lock_guard submission_lock(submission_mutex_);
    std::lock_guard lock(mutex_);
    if (active_ && configuration_.generation == generation) {
      active_ = false;
      drop_next_delta_ = false;
      configuration_ = {};
    }
  }

private:
  webrtc::EncodedImageCallback *callback_ = nullptr;
  std::mutex submission_mutex_;
  std::mutex mutex_;
  bool active_ = false;
  bool drop_next_delta_ = false;
  H264SenderConfiguration configuration_;
};

} // namespace

std::unique_ptr<H264SenderBackend>
CreatePinnedLibwebrtcH264Sender(webrtc::EncodedImageCallback *callback) {
  return std::make_unique<PinnedLibwebrtcH264Sender>(callback);
}

} // namespace imcodes::remote_desktop::macos
