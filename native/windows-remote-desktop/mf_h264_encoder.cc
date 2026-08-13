#include "third_party/imcodes_remote_desktop/mf_h264_encoder.h"

#include <codecapi.h>
#include <mferror.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <iterator>
#include <thread>
#include <utility>

#include "api/make_ref_counted.h"
#include "api/video/encoded_image.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame_buffer.h"
#include "libyuv/convert.h"
#include "libyuv/scale.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "modules/video_coding/codecs/h264/include/h264_globals.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "rtc_base/logging.h"
#include "third_party/imcodes_remote_desktop/json_protocol.h"
#include "third_party/imcodes_remote_desktop/worker_policy.h"

namespace imcodes::rd {
namespace {

static_assert(kPerPeerVideoBitrateBps == kMaxVideoBitrateBps);
static_assert(kAggregateVideoBitrateBps == kMaxAggregateVideoBitrateBps);

using Microsoft::WRL::ComPtr;

std::mutex g_diagnostics_mutex;
MfH264RuntimeDiagnostics g_diagnostics;
std::atomic<bool> g_hardware_encoder_allowed{true};
std::mutex g_bitrate_budget_mutex;
uint64_t g_aggregate_reserved_bitrate_bps = 0;

uint32_t ReserveAggregateBitrate(uint32_t requested_bps,
                                 uint32_t previous_reservation_bps) {
  std::lock_guard lock(g_bitrate_budget_mutex);
  const uint32_t granted = ClampAggregateVideoBitrate(
      requested_bps, previous_reservation_bps,
      g_aggregate_reserved_bitrate_bps);
  // A denied resize leaves the caller's prior reservation intact. SetRates
  // likewise leaves reserved_bitrate_bps_ unchanged, so Release cannot later
  // subtract the same reservation from an unrelated peer a second time.
  if (granted == 0) return 0;
  if (g_aggregate_reserved_bitrate_bps >= previous_reservation_bps)
    g_aggregate_reserved_bitrate_bps -= previous_reservation_bps;
  else
    g_aggregate_reserved_bitrate_bps = 0;
  g_aggregate_reserved_bitrate_bps += granted;
  return granted;
}

void ReleaseAggregateBitrate(uint32_t reservation_bps) {
  if (reservation_bps == 0) return;
  std::lock_guard lock(g_bitrate_budget_mutex);
  g_aggregate_reserved_bitrate_bps =
      g_aggregate_reserved_bitrate_bps >= reservation_bps
          ? g_aggregate_reserved_bitrate_bps - reservation_bps
          : 0;
}

bool IsH264(const webrtc::SdpVideoFormat& format) {
  return _stricmp(format.name.c_str(), "H264") == 0;
}

bool HardwareEncoderAllowedByEnvironment() {
  // The production default remains vendor-neutral hardware preference. This
  // exact opt-in diagnostic override exercises the same signed worker's
  // Windows software MFT path without maintaining a second binary.
  wchar_t value[16]{};
  const DWORD length = GetEnvironmentVariableW(
      L"IMCODES_REMOTE_DESKTOP_ENCODER_MODE", value, std::size(value));
  return g_hardware_encoder_allowed.load() &&
         (length == 0 || length >= std::size(value) ||
          _wcsicmp(value, L"software") != 0);
}

bool HasAnnexBStartCode(const uint8_t* data, size_t size) {
  for (size_t index = 0; index + 4 < size; ++index) {
    if (data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1)
      return true;
    else if (index + 4 < size && data[index] == 0 && data[index + 1] == 0 &&
             data[index + 2] == 0 && data[index + 3] == 1)
      return true;
  }
  return false;
}

bool HasIdr(const uint8_t* data, size_t size) {
  for (size_t index = 0; index + 4 < size; ++index) {
    size_t prefix = 0;
    if (data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1)
      prefix = 3;
    else if (index + 4 < size && data[index] == 0 && data[index + 1] == 0 &&
             data[index + 2] == 0 && data[index + 3] == 1)
      prefix = 4;
    if (prefix && index + prefix < size &&
        (data[index + prefix] & 0x1f) == 5) {
      return true;
    }
  }
  return false;
}

int64_t SteadyNowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

int64_t SteadyNowUs() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

VARIANT UInt32Variant(uint32_t value) {
  VARIANT variant;
  VariantInit(&variant);
  variant.vt = VT_UI4;
  variant.ulVal = value;
  return variant;
}

VARIANT BoolVariant(bool value) {
  VARIANT variant;
  VariantInit(&variant);
  variant.vt = VT_BOOL;
  variant.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  return variant;
}

}  // namespace

MfH264RuntimeDiagnostics GetMfH264RuntimeDiagnostics() {
  std::lock_guard lock(g_diagnostics_mutex);
  return g_diagnostics;
}

void DisqualifyHardwareEncoderForProcess() {
  g_hardware_encoder_allowed = false;
}

MfH264Encoder::MfH264Encoder(bool prefer_hardware)
    : prefer_hardware_(prefer_hardware) {}
MfH264Encoder::~MfH264Encoder() {
  Release();
}

int MfH264Encoder::InitEncode(const webrtc::VideoCodec* codec_settings,
                              const Settings&) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!codec_settings || codec_settings->codecType != webrtc::kVideoCodecH264 ||
      codec_settings->width < 64 || codec_settings->height < 64 ||
      codec_settings->width > 4096 || codec_settings->height > 4096) {
    return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
  }
  transform_.Reset();
  video_processor_.Reset();
  scaled_i420_ = nullptr;
  codec_api_.Reset();
  event_generator_.Reset();
  pending_.clear();
  async_input_requests_ = 0;
  async_output_events_ = 0;
  hardware_stall_polls_ = 0;
  hardware_encode_attempts_without_output_ = 0;
  hardware_inputs_without_output_ = 0;
  hardware_output_stream_changes_ = 0;
  consecutive_slow_hardware_frames_ = 0;
  first_hardware_input_at_ms_ = 0;
  async_drain_complete_ = false;
  source_width_ = codec_settings->width & ~1;
  source_height_ = codec_settings->height & ~1;
  ReleaseAggregateBitrate(reserved_bitrate_bps_);
  reserved_bitrate_bps_ = ReserveAggregateBitrate(
      codec_settings->startBitrate * 1000u, 0);
  if (reserved_bitrate_bps_ == 0) return WEBRTC_VIDEO_CODEC_MEMORY;
  bitrate_bps_ = reserved_bitrate_bps_;
  quality_ = SelectQuality(bitrate_bps_, source_width_, source_height_);
  width_ = quality_.width;
  height_ = quality_.height;
  fps_ = quality_.fps;
  const bool attempted_hardware =
      ShouldAttemptHardwareEncoder(prefer_hardware_, hardware_disqualified_);
  initialized_ = attempted_hardware && ConfigureVideoProcessor() &&
                 ActivateTransform(true) && ConfigureTransform();
  if (!initialized_) {
    if (attempted_hardware) {
      hardware_disqualified_ = true;
      DisqualifyHardwareEncoderForProcess();
    }
    video_processor_.Reset();
    transform_.Reset();
    codec_api_.Reset();
    event_generator_.Reset();
    pending_.clear();
    initialized_ = ConfigureVideoProcessor() && ActivateTransform(false) &&
                   ConfigureTransform();
  }
  if (!initialized_) {
    ReleaseAggregateBitrate(reserved_bitrate_bps_);
    reserved_bitrate_bps_ = 0;
  }
  force_keyframe_ = true;
  reconfigure_pending_ = false;
  last_encoded_timestamp_us_ = 0;
  performance_ = {};
  PublishDiagnostics();
  return initialized_ ? WEBRTC_VIDEO_CODEC_OK : WEBRTC_VIDEO_CODEC_ERROR;
}

int32_t MfH264Encoder::RegisterEncodeCompleteCallback(
    webrtc::EncodedImageCallback* callback) {
  std::lock_guard<std::mutex> lock(mutex_);
  callback_ = callback;
  return WEBRTC_VIDEO_CODEC_OK;
}

int32_t MfH264Encoder::Release() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (transform_) {
    transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    transform_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
    if (async_)
      DrainAsyncTransform(500);
    else
      DrainOutput();
    if (transform_)
      transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
  }
  if (video_processor_) {
    video_processor_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    video_processor_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    video_processor_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
  }
  pending_.clear();
  ReleaseAggregateBitrate(reserved_bitrate_bps_);
  reserved_bitrate_bps_ = 0;
  codec_api_.Reset();
  event_generator_.Reset();
  transform_.Reset();
  video_processor_.Reset();
  scaled_i420_ = nullptr;
  async_input_requests_ = 0;
  async_output_events_ = 0;
  hardware_stall_polls_ = 0;
  hardware_encode_attempts_without_output_ = 0;
  hardware_inputs_without_output_ = 0;
  hardware_output_stream_changes_ = 0;
  consecutive_slow_hardware_frames_ = 0;
  first_hardware_input_at_ms_ = 0;
  async_drain_complete_ = false;
  initialized_ = false;
  hardware_ = false;
  async_ = false;
  reconfigure_pending_ = false;
  last_encoded_timestamp_us_ = 0;
  PublishDiagnostics();
  return WEBRTC_VIDEO_CODEC_OK;
}

int32_t MfH264Encoder::Encode(
    const webrtc::VideoFrame& frame,
    const std::vector<webrtc::VideoFrameType>* frame_types) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!initialized_ || !transform_ || !callback_)
    return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
  const auto i420 = frame.video_frame_buffer()->ToI420();
  if (!i420 || i420->width() != source_width_ ||
      i420->height() != source_height_)
    return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
  if (reconfigure_pending_ && !Reconfigure())
    return WEBRTC_VIDEO_CODEC_ERROR;
  const int64_t frame_timestamp_us = frame.timestamp_us();
  const int64_t minimum_interval_us = 1'000'000 / std::max(1, fps_);
  if (last_encoded_timestamp_us_ > 0 &&
      frame_timestamp_us - last_encoded_timestamp_us_ < minimum_interval_us)
    return WEBRTC_VIDEO_CODEC_OK;
  if (hardware_ &&
      HardwareEncoderThroughputShouldFallback(
          consecutive_slow_hardware_frames_) &&
      !FallbackToSoftware("sustained encode time exceeded frame budget")) {
    return WEBRTC_VIDEO_CODEC_ERROR;
  }
  const int64_t encode_start_us = SteadyNowUs();
  ++performance_.encode_calls;
  if (hardware_) ++hardware_encode_attempts_without_output_;
  if (async_) {
    const int64_t output_start_us = SteadyNowUs();
    const bool pumped = PumpAsyncEvents(1, false);
    const int drained = pumped ? DrainOutput() : WEBRTC_VIDEO_CODEC_ERROR;
    performance_.output_pump_us += SteadyNowUs() - output_start_us;
    if (!pumped || drained != WEBRTC_VIDEO_CODEC_OK)
      return WEBRTC_VIDEO_CODEC_ERROR;
  }
  const bool hardware_output_overdue =
      hardware_ && first_hardware_input_at_ms_ > 0 &&
      SteadyNowMs() - first_hardware_input_at_ms_ >= 250;
  if (hardware_ &&
      (hardware_output_overdue || HardwareEncoderShouldFallback(
          std::max({pending_.size(), hardware_inputs_without_output_,
                    hardware_encode_attempts_without_output_}),
          hardware_stall_polls_, kMaxEncoderQueueFrames)) &&
      !FallbackToSoftware("stalled or exceeded bounded queue")) {
    return WEBRTC_VIDEO_CODEC_ERROR;
  }
  if (!EncoderQueueHasCapacity(pending_.size(), kMaxEncoderQueueFrames)) {
    if (!async_) DrainOutput();
    if (!EncoderQueueHasCapacity(pending_.size(), kMaxEncoderQueueFrames))
      return WEBRTC_VIDEO_CODEC_OK;
  }
  bool upstream_requested_keyframe = false;
  if (frame_types) {
    upstream_requested_keyframe =
        std::find(frame_types->begin(), frame_types->end(),
                  webrtc::VideoFrameType::kVideoFrameKey) != frame_types->end();
  }
  bool requested_keyframe =
      EncoderKeyFrameRequested(force_keyframe_, upstream_requested_keyframe);
  if (requested_keyframe) RequestKeyFrame();

  const int64_t sample_time = frame.timestamp_us() * 10;
  const int64_t sample_duration = 10'000'000LL / std::max(1, fps_);
  ComPtr<IMFSample> sample;
  const int64_t conversion_start_us = SteadyNowUs();
  const bool converted = ConvertFrame(*i420, sample_time, sample_duration,
                                      sample.ReleaseAndGetAddressOf());
  performance_.conversion_us += SteadyNowUs() - conversion_start_us;
  if (!converted)
    return WEBRTC_VIDEO_CODEC_ERROR;
  HRESULT hr = S_OK;
  const auto wait_for_async_input = [this](size_t attempts) {
    const int64_t wait_start_us = SteadyNowUs();
    const bool ready = WaitForAsyncInput(attempts);
    performance_.input_wait_us += SteadyNowUs() - wait_start_us;
    return ready;
  };
  if (async_ && !wait_for_async_input(20)) {
    if (!hardware_ || pending_.empty() ||
        !HardwareEncoderShouldFallback(
            pending_.size(), ++hardware_stall_polls_,
            kMaxEncoderQueueFrames)) {
      return WEBRTC_VIDEO_CODEC_OK;
    }
    if (!FallbackToSoftware("stopped granting input"))
      return WEBRTC_VIDEO_CODEC_ERROR;
    requested_keyframe = true;
    RequestKeyFrame();
  }
  const auto process_input = [this, &sample]() {
    const int64_t process_start_us = SteadyNowUs();
    const HRESULT result = transform_->ProcessInput(0, sample.Get(), 0);
    performance_.process_input_us += SteadyNowUs() - process_start_us;
    return result;
  };
  if (async_) {
    // An asynchronous MFT grants exactly one ProcessInput call with each
    // METransformNeedInput event.  Never probe ProcessInput opportunistically:
    // doing so is explicitly invalid for hardware encoders.
    --async_input_requests_;
    hr = process_input();
  } else {
    hr = process_input();
    if (hr == MF_E_NOTACCEPTING) {
      DrainOutput();
      hr = process_input();
    }
  }
  if (FAILED(hr) && hardware_) {
    if (!FallbackToSoftware("ProcessInput failed"))
      return WEBRTC_VIDEO_CODEC_ERROR;
    requested_keyframe = true;
    RequestKeyFrame();
    if (async_) {
      if (!wait_for_async_input(20)) return WEBRTC_VIDEO_CODEC_ERROR;
      --async_input_requests_;
    }
    hr = process_input();
  }
  if (FAILED(hr)) return WEBRTC_VIDEO_CODEC_ERROR;
  hardware_stall_polls_ = 0;
  if (hardware_) {
    if (hardware_inputs_without_output_ == 0)
      first_hardware_input_at_ms_ = SteadyNowMs();
    ++hardware_inputs_without_output_;
  }
  last_encoded_timestamp_us_ = frame_timestamp_us;
  pending_.push_back(PendingFrame{frame.rtp_timestamp(), frame.ntp_time_ms(),
                                  sample_time, requested_keyframe});
  force_keyframe_ = false;
  const int64_t output_start_us = SteadyNowUs();
  const bool pumped = !async_ || PumpAsyncEvents(5, false);
  const int drained = pumped ? DrainOutput() : WEBRTC_VIDEO_CODEC_ERROR;
  performance_.output_pump_us += SteadyNowUs() - output_start_us;
  if (hardware_ && pumped && drained == WEBRTC_VIDEO_CODEC_OK) {
    const int64_t elapsed_us = SteadyNowUs() - encode_start_us;
    consecutive_slow_hardware_frames_ = UpdateHardwareSlowFrameCount(
        elapsed_us, fps_, consecutive_slow_hardware_frames_);
  }
  return pumped ? drained : WEBRTC_VIDEO_CODEC_ERROR;
}

MfH264PerformanceDiagnostics MfH264Encoder::GetPerformanceDiagnostics() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return performance_;
}

void MfH264Encoder::SetRates(const RateControlParameters& parameters) {
  std::lock_guard<std::mutex> lock(mutex_);
  const int64_t target_bps = parameters.bitrate.get_sum_bps();
  const uint32_t requested_bps = static_cast<uint32_t>(
      std::clamp<int64_t>(target_bps, kMinVideoBitrateBps,
                          kPerPeerVideoBitrateBps));
  const uint32_t granted_bps = ReserveAggregateBitrate(
      requested_bps, reserved_bitrate_bps_);
  if (granted_bps == 0) return;
  reserved_bitrate_bps_ = granted_bps;
  bitrate_bps_ = granted_bps;
  const QualitySelection next =
      SelectQuality(bitrate_bps_, source_width_, source_height_);
  reconfigure_pending_ = reconfigure_pending_ || next.width != width_ ||
                         next.height != height_ || next.fps != fps_;
  quality_ = next;
  VARIANT bitrate = UInt32Variant(bitrate_bps_);
  SetCodecValue(CODECAPI_AVEncCommonMeanBitRate, bitrate);
  VariantClear(&bitrate);
  PublishDiagnostics();
}

webrtc::VideoEncoder::EncoderInfo MfH264Encoder::GetEncoderInfo() const {
  std::lock_guard<std::mutex> lock(mutex_);
  EncoderInfo info;
  info.implementation_name = hardware_ ? "MediaFoundation-H264-Hardware"
                                       : "MediaFoundation-H264-Software";
  info.is_hardware_accelerated = hardware_;
  info.supports_native_handle = false;
  info.has_trusted_rate_controller = false;
  info.requested_resolution_alignment = 2;
  info.apply_alignment_to_all_simulcast_layers = true;
  info.scaling_settings = ScalingSettings(24, 37, 320 * 180);
  info.preferred_pixel_formats = {webrtc::VideoFrameBuffer::Type::kI420};
  return info;
}

bool MfH264Encoder::ActivateTransform(bool hardware) {
  MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  const UINT32 flags = hardware
      ? MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER
      : MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT |
            MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER;
  IMFActivate** activations = nullptr;
  UINT32 count = 0;
  if (FAILED(MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, &input, &output,
                       &activations, &count))) {
    return false;
  }
  for (UINT32 index = 0; index < count && !transform_; ++index) {
    ComPtr<IMFTransform> candidate;
    if (SUCCEEDED(activations[index]->ActivateObject(IID_PPV_ARGS(&candidate))))
      transform_ = candidate;
  }
  for (UINT32 index = 0; index < count; ++index) activations[index]->Release();
  CoTaskMemFree(activations);
  hardware_ = hardware && transform_;
  if (!transform_) return false;
  transform_.As(&codec_api_);
  event_generator_.Reset();
  async_ = false;
  async_input_requests_ = 0;
  async_output_events_ = 0;
  async_drain_complete_ = false;
  ComPtr<IMFAttributes> attributes;
  if (SUCCEEDED(transform_->GetAttributes(&attributes)) && attributes) {
    UINT32 is_async = FALSE;
    attributes->GetUINT32(MF_TRANSFORM_ASYNC, &is_async);
    async_ = is_async == TRUE;
    if (async_) {
      if (FAILED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE)) ||
          FAILED(transform_.As(&event_generator_)) || !event_generator_) {
        transform_.Reset();
        codec_api_.Reset();
        hardware_ = false;
        return false;
      }
    }
    attributes->SetUINT32(MF_LOW_LATENCY, TRUE);
  }
  return true;
}

bool MfH264Encoder::ConfigureVideoProcessor() {
  video_processor_.Reset();
  if (FAILED(CoCreateInstance(CLSID_VideoProcessorMFT, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&video_processor_)))) {
    return false;
  }
  ComPtr<IMFAttributes> attributes;
  if (FAILED(video_processor_->GetAttributes(&attributes)) || !attributes ||
      FAILED(attributes->SetUINT32(MF_LOW_LATENCY, TRUE)) ||
      FAILED(attributes->SetUINT32(MF_XVP_DISABLE_FRC, TRUE)) ||
      FAILED(attributes->SetUINT32(MF_XVP_CALLER_ALLOCATES_OUTPUT, TRUE))) {
    video_processor_.Reset();
    return false;
  }
  ComPtr<IMFMediaType> input;
  if (FAILED(MFCreateMediaType(&input)) ||
      FAILED(input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
      FAILED(input->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_I420)) ||
      FAILED(MFSetAttributeSize(input.Get(), MF_MT_FRAME_SIZE, source_width_,
                                source_height_)) ||
      FAILED(MFSetAttributeRatio(input.Get(), MF_MT_FRAME_RATE, fps_, 1)) ||
      FAILED(MFSetAttributeRatio(input.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1)) ||
      FAILED(input->SetUINT32(MF_MT_DEFAULT_STRIDE, source_width_)) ||
      FAILED(input->SetUINT32(MF_MT_INTERLACE_MODE,
                              MFVideoInterlace_Progressive)) ||
      FAILED(video_processor_->SetInputType(0, input.Get(), 0))) {
    video_processor_.Reset();
    return false;
  }
  ComPtr<IMFMediaType> output;
  if (FAILED(MFCreateMediaType(&output)) ||
      FAILED(output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
      FAILED(output->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12)) ||
      FAILED(MFSetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, width_,
                                height_)) ||
      FAILED(MFSetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, fps_, 1)) ||
      FAILED(MFSetAttributeRatio(output.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1)) ||
      FAILED(output->SetUINT32(MF_MT_DEFAULT_STRIDE, width_)) ||
      FAILED(output->SetUINT32(MF_MT_INTERLACE_MODE,
                               MFVideoInterlace_Progressive)) ||
      FAILED(video_processor_->SetOutputType(0, output.Get(), 0)) ||
      FAILED(video_processor_->ProcessMessage(
          MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) ||
      FAILED(video_processor_->ProcessMessage(
          MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0))) {
    video_processor_.Reset();
    return false;
  }
  return true;
}

bool MfH264Encoder::ConvertFrame(
    const webrtc::I420BufferInterface& frame,
    int64_t sample_time_100ns,
    int64_t sample_duration_100ns,
    IMFSample** output) {
  if (!video_processor_ || !output) return false;
  *output = nullptr;
  // The capture source already produces system-memory I420. libyuv is pinned
  // by libwebrtc and provides SIMD scaling/interleave without the synchronous
  // XVP output latency seen on legacy Intel drivers. Keep the Media Foundation
  // video processor below as the platform fallback if this bounded conversion
  // cannot allocate or rejects a layout.
  if (ConvertFrameWithLibyuv(frame, sample_time_100ns,
                             sample_duration_100ns, output)) {
    return true;
  }
  const DWORD y_bytes = static_cast<DWORD>(source_width_ * source_height_);
  const DWORD chroma_width = static_cast<DWORD>(source_width_ / 2);
  const DWORD chroma_height = static_cast<DWORD>(source_height_ / 2);
  const DWORD input_bytes = y_bytes + 2 * chroma_width * chroma_height;
  ComPtr<IMFSample> input_sample;
  ComPtr<IMFMediaBuffer> input_buffer;
  if (FAILED(MFCreateSample(&input_sample)) ||
      FAILED(MFCreateMemoryBuffer(input_bytes, &input_buffer)) ||
      FAILED(input_sample->AddBuffer(input_buffer.Get()))) {
    return false;
  }
  BYTE* destination = nullptr;
  DWORD capacity = 0;
  if (FAILED(input_buffer->Lock(&destination, &capacity, nullptr)) ||
      capacity < input_bytes) {
    if (destination) input_buffer->Unlock();
    return false;
  }
  for (int row = 0; row < source_height_; ++row) {
    std::memcpy(destination + static_cast<size_t>(row) * source_width_,
                frame.DataY() + static_cast<size_t>(row) * frame.StrideY(),
                source_width_);
  }
  BYTE* u = destination + y_bytes;
  BYTE* v = u + chroma_width * chroma_height;
  for (DWORD row = 0; row < chroma_height; ++row) {
    std::memcpy(u + static_cast<size_t>(row) * chroma_width,
                frame.DataU() + static_cast<size_t>(row) * frame.StrideU(),
                chroma_width);
    std::memcpy(v + static_cast<size_t>(row) * chroma_width,
                frame.DataV() + static_cast<size_t>(row) * frame.StrideV(),
                chroma_width);
  }
  input_buffer->Unlock();
  if (FAILED(input_buffer->SetCurrentLength(input_bytes)) ||
      FAILED(input_sample->SetSampleTime(sample_time_100ns)) ||
      FAILED(input_sample->SetSampleDuration(sample_duration_100ns)) ||
      FAILED(video_processor_->ProcessInput(0, input_sample.Get(), 0))) {
    return false;
  }

  const DWORD output_bytes = static_cast<DWORD>(width_ * height_ * 3 / 2);
  ComPtr<IMFSample> output_sample;
  ComPtr<IMFMediaBuffer> output_buffer;
  if (FAILED(MFCreateSample(&output_sample)) ||
      FAILED(MFCreateMemoryBuffer(output_bytes, &output_buffer)) ||
      FAILED(output_sample->AddBuffer(output_buffer.Get())) ||
      FAILED(output_sample->SetSampleTime(sample_time_100ns)) ||
      FAILED(output_sample->SetSampleDuration(sample_duration_100ns))) {
    return false;
  }
  MFT_OUTPUT_DATA_BUFFER converted{};
  converted.dwStreamID = 0;
  converted.pSample = output_sample.Get();
  DWORD status = 0;
  const HRESULT result =
      video_processor_->ProcessOutput(0, 1, &converted, &status);
  if (converted.pEvents) converted.pEvents->Release();
  if (FAILED(result)) return false;
  *output = output_sample.Detach();
  return true;
}

bool MfH264Encoder::ConvertFrameWithLibyuv(
    const webrtc::I420BufferInterface& frame,
    int64_t sample_time_100ns,
    int64_t sample_duration_100ns,
    IMFSample** output) {
  if (!output) return false;
  const webrtc::I420BufferInterface* source = &frame;
  if (source_width_ != width_ || source_height_ != height_) {
    if (!scaled_i420_ || scaled_i420_->width() != width_ ||
        scaled_i420_->height() != height_) {
      scaled_i420_ = webrtc::I420Buffer::Create(width_, height_);
    }
    if (!scaled_i420_ ||
        libyuv::I420Scale(
            frame.DataY(), frame.StrideY(), frame.DataU(), frame.StrideU(),
            frame.DataV(), frame.StrideV(), source_width_, source_height_,
            scaled_i420_->MutableDataY(), scaled_i420_->StrideY(),
            scaled_i420_->MutableDataU(), scaled_i420_->StrideU(),
            scaled_i420_->MutableDataV(), scaled_i420_->StrideV(), width_,
            height_, libyuv::kFilterBilinear) != 0) {
      return false;
    }
    source = scaled_i420_.get();
  }

  const DWORD output_bytes = static_cast<DWORD>(width_ * height_ * 3 / 2);
  ComPtr<IMFSample> output_sample;
  ComPtr<IMFMediaBuffer> output_buffer;
  if (FAILED(MFCreateSample(&output_sample)) ||
      FAILED(MFCreateMemoryBuffer(output_bytes, &output_buffer)) ||
      FAILED(output_sample->AddBuffer(output_buffer.Get()))) {
    return false;
  }
  BYTE* destination = nullptr;
  DWORD capacity = 0;
  if (FAILED(output_buffer->Lock(&destination, &capacity, nullptr)) ||
      capacity < output_bytes) {
    if (destination) output_buffer->Unlock();
    return false;
  }
  const int converted = libyuv::I420ToNV12(
      source->DataY(), source->StrideY(), source->DataU(), source->StrideU(),
      source->DataV(), source->StrideV(), destination, width_,
      destination + static_cast<size_t>(width_) * height_, width_, width_,
      height_);
  output_buffer->Unlock();
  if (converted != 0 ||
      FAILED(output_buffer->SetCurrentLength(output_bytes)) ||
      FAILED(output_sample->SetSampleTime(sample_time_100ns)) ||
      FAILED(output_sample->SetSampleDuration(sample_duration_100ns))) {
    return false;
  }
  *output = output_sample.Detach();
  return true;
}

bool MfH264Encoder::ConfigureTransform() {
  ComPtr<IMFMediaType> output;
  if (FAILED(MFCreateMediaType(&output)) ||
      FAILED(output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
      FAILED(output->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264)) ||
      FAILED(MFSetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, width_,
                                height_)) ||
      FAILED(MFSetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, fps_, 1)) ||
      FAILED(output->SetUINT32(MF_MT_AVG_BITRATE, bitrate_bps_)) ||
      FAILED(output->SetUINT32(MF_MT_INTERLACE_MODE,
                               MFVideoInterlace_Progressive)) ||
      FAILED(output->SetUINT32(MF_MT_MPEG2_PROFILE,
                               eAVEncH264VProfile_Base)) ||
      FAILED(transform_->SetOutputType(0, output.Get(), 0))) {
    return false;
  }
  ComPtr<IMFMediaType> input;
  if (FAILED(MFCreateMediaType(&input)) ||
      FAILED(input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
      FAILED(input->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12)) ||
      FAILED(MFSetAttributeSize(input.Get(), MF_MT_FRAME_SIZE, width_,
                                height_)) ||
      FAILED(MFSetAttributeRatio(input.Get(), MF_MT_FRAME_RATE, fps_, 1)) ||
      FAILED(input->SetUINT32(MF_MT_INTERLACE_MODE,
                              MFVideoInterlace_Progressive)) ||
      FAILED(transform_->SetInputType(0, input.Get(), 0))) {
    return false;
  }

  VARIANT low_latency = BoolVariant(true);
  SetCodecValue(CODECAPI_AVEncCommonLowLatency, low_latency);
  SetCodecValue(CODECAPI_AVEncCommonRealTime, low_latency);
  VariantClear(&low_latency);
  VARIANT rate_control = UInt32Variant(eAVEncCommonRateControlMode_CBR);
  SetCodecValue(CODECAPI_AVEncCommonRateControlMode, rate_control);
  VariantClear(&rate_control);
  VARIANT bitrate = UInt32Variant(bitrate_bps_);
  SetCodecValue(CODECAPI_AVEncCommonMeanBitRate, bitrate);
  VariantClear(&bitrate);
  VARIANT gop = UInt32Variant(static_cast<uint32_t>(fps_ * 2));
  SetCodecValue(CODECAPI_AVEncMPVGOPSize, gop);
  VariantClear(&gop);

  if (FAILED(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
                                        0)) ||
      FAILED(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM,
                                        0))) {
    return false;
  }
  // Asynchronous transforms advertise their input capacity through events.
  // Waiting here also proves that the selected hardware/software MFT is
  // actually operational before it is exposed to libwebrtc.
  return !async_ || WaitForAsyncInput(500);
}

bool MfH264Encoder::TryAcceptCompatibleOutputType() {
  // A few legacy hardware encoders advertise a concrete H.264 type only after
  // their first input even though encoders are not supposed to renegotiate
  // their output while streaming. Accept one such update only when every
  // browser-visible format property remains compatible with the negotiated
  // stream. A repeated or incompatible change falls back to the Microsoft
  // software MFT instead of risking a loop or an SDP/bitstream mismatch.
  constexpr DWORD kMaxOutputTypes = 32;
  for (DWORD index = 0; index < kMaxOutputTypes; ++index) {
    ComPtr<IMFMediaType> candidate;
    const HRESULT available = transform_->GetOutputAvailableType(
        0, index, candidate.ReleaseAndGetAddressOf());
    if (available == MF_E_NO_MORE_TYPES) break;
    if (FAILED(available) || !candidate) return false;

    GUID major = GUID_NULL;
    GUID subtype = GUID_NULL;
    UINT32 candidate_width = 0;
    UINT32 candidate_height = 0;
    UINT32 frame_rate_numerator = 0;
    UINT32 frame_rate_denominator = 0;
    if (FAILED(candidate->GetGUID(MF_MT_MAJOR_TYPE, &major)) ||
        major != MFMediaType_Video ||
        FAILED(candidate->GetGUID(MF_MT_SUBTYPE, &subtype)) ||
        subtype != MFVideoFormat_H264 ||
        FAILED(MFGetAttributeSize(candidate.Get(), MF_MT_FRAME_SIZE,
                                  &candidate_width, &candidate_height)) ||
        candidate_width != static_cast<UINT32>(width_) ||
        candidate_height != static_cast<UINT32>(height_) ||
        FAILED(MFGetAttributeRatio(candidate.Get(), MF_MT_FRAME_RATE,
                                   &frame_rate_numerator,
                                   &frame_rate_denominator)) ||
        frame_rate_denominator == 0 ||
        static_cast<uint64_t>(frame_rate_numerator) !=
            static_cast<uint64_t>(fps_) * frame_rate_denominator) {
      continue;
    }

    UINT32 interlace = MFVideoInterlace_Progressive;
    if (SUCCEEDED(candidate->GetUINT32(MF_MT_INTERLACE_MODE, &interlace)) &&
        interlace != MFVideoInterlace_Progressive) {
      continue;
    }
    UINT32 profile = eAVEncH264VProfile_Base;
    if (SUCCEEDED(candidate->GetUINT32(MF_MT_MPEG2_PROFILE, &profile)) &&
        profile != eAVEncH264VProfile_Base) {
      continue;
    }
    if (FAILED(candidate->SetUINT32(MF_MT_MPEG2_PROFILE,
                                    eAVEncH264VProfile_Base)) ||
        FAILED(candidate->SetUINT32(MF_MT_AVG_BITRATE, bitrate_bps_)) ||
        FAILED(transform_->SetOutputType(0, candidate.Get(), 0))) {
      continue;
    }
    return true;
  }
  return false;
}

bool MfH264Encoder::Reconfigure() {
  if (transform_) {
    transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    transform_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
  }
  if (video_processor_) {
    video_processor_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    video_processor_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    video_processor_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
  }
  pending_.clear();
  codec_api_.Reset();
  event_generator_.Reset();
  transform_.Reset();
  video_processor_.Reset();
  scaled_i420_ = nullptr;
  async_input_requests_ = 0;
  async_output_events_ = 0;
  hardware_stall_polls_ = 0;
  hardware_encode_attempts_without_output_ = 0;
  hardware_inputs_without_output_ = 0;
  hardware_output_stream_changes_ = 0;
  consecutive_slow_hardware_frames_ = 0;
  first_hardware_input_at_ms_ = 0;
  async_drain_complete_ = false;
  width_ = quality_.width;
  height_ = quality_.height;
  fps_ = quality_.fps;
  const bool attempted_hardware =
      ShouldAttemptHardwareEncoder(prefer_hardware_, hardware_disqualified_);
  initialized_ = attempted_hardware && ConfigureVideoProcessor() &&
                 ActivateTransform(true) && ConfigureTransform();
  if (!initialized_) {
    if (attempted_hardware) {
      hardware_disqualified_ = true;
      DisqualifyHardwareEncoderForProcess();
    }
    codec_api_.Reset();
    transform_.Reset();
    video_processor_.Reset();
    initialized_ = ConfigureVideoProcessor() && ActivateTransform(false) &&
                   ConfigureTransform();
  }
  reconfigure_pending_ = false;
  force_keyframe_ = true;
  last_encoded_timestamp_us_ = 0;
  PublishDiagnostics();
  return initialized_;
}

bool MfH264Encoder::FallbackToSoftware(const char* reason) {
  if (!hardware_) return initialized_;
  hardware_disqualified_ = true;
  DisqualifyHardwareEncoderForProcess();
  RTC_LOG(LS_WARNING)
      << "Media Foundation hardware H.264 encoder "
      << (reason ? reason : "became unusable")
      << "; using the approved software MFT fallback";
  if (transform_) {
    transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    transform_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
  }
  if (video_processor_) {
    video_processor_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    video_processor_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    video_processor_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
  }
  pending_.clear();
  codec_api_.Reset();
  event_generator_.Reset();
  transform_.Reset();
  video_processor_.Reset();
  scaled_i420_ = nullptr;
  async_input_requests_ = 0;
  async_output_events_ = 0;
  hardware_stall_polls_ = 0;
  hardware_encode_attempts_without_output_ = 0;
  hardware_inputs_without_output_ = 0;
  hardware_output_stream_changes_ = 0;
  consecutive_slow_hardware_frames_ = 0;
  first_hardware_input_at_ms_ = 0;
  async_drain_complete_ = false;
  initialized_ = ConfigureVideoProcessor() && ActivateTransform(false) &&
                 ConfigureTransform();
  force_keyframe_ = true;
  last_encoded_timestamp_us_ = 0;
  PublishDiagnostics();
  return initialized_;
}

bool MfH264Encoder::SetCodecValue(const GUID& key, VARIANT value) {
  return codec_api_ && SUCCEEDED(codec_api_->SetValue(&key, &value));
}

bool MfH264Encoder::PumpAsyncEvents(size_t attempts, bool wait_for_input) {
  if (!async_ || !event_generator_) return !async_;
  const size_t polls = std::max<size_t>(attempts, 1);
  for (size_t attempt = 0; attempt < polls; ++attempt) {
    bool received_event = false;
    for (;;) {
      ComPtr<IMFMediaEvent> event;
      const HRESULT hr =
          event_generator_->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
      if (SUCCEEDED(hr)) {
        received_event = true;
        HRESULT status = S_OK;
        if (FAILED(event->GetStatus(&status)) || FAILED(status)) return false;
        MediaEventType type = MEUnknown;
        if (FAILED(event->GetType(&type))) return false;
        if (type == METransformNeedInput)
          ++async_input_requests_;
        else if (type == METransformHaveOutput)
          ++async_output_events_;
        else if (type == METransformDrainComplete)
          async_drain_complete_ = true;
        if (type == MEError) return false;
      } else if (hr != MF_E_NO_EVENTS_AVAILABLE) {
        return false;
      } else {
        break;
      }
    }
    // Some transforms do not issue their next input request until the prior
    // output grant has been consumed.  Consume only the output events already
    // observed; DrainOutput itself never polls or invents an async grant.
    if (wait_for_input && async_output_events_ > 0 &&
        DrainOutput() != WEBRTC_VIDEO_CODEC_OK) {
      return false;
    }
    if (wait_for_input && async_input_requests_ > 0) return true;
    if (!wait_for_input && received_event) continue;
    if (attempt + 1 == polls) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return true;
}

bool MfH264Encoder::WaitForAsyncInput(size_t attempts) {
  if (async_input_requests_ > 0) return true;
  return PumpAsyncEvents(attempts, true) && async_input_requests_ > 0;
}

int MfH264Encoder::DrainAsyncTransform(size_t attempts) {
  async_drain_complete_ = false;
  for (size_t attempt = 0; attempt < attempts; ++attempt) {
    if (!PumpAsyncEvents(1, false)) return WEBRTC_VIDEO_CODEC_ERROR;
    const int drained = DrainOutput();
    if (drained != WEBRTC_VIDEO_CODEC_OK) return drained;
    if (async_drain_complete_) return WEBRTC_VIDEO_CODEC_OK;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return WEBRTC_VIDEO_CODEC_ERROR;
}

int MfH264Encoder::DrainOutput() {
  MFT_OUTPUT_STREAM_INFO info{};
  if (FAILED(transform_->GetOutputStreamInfo(0, &info)))
    return WEBRTC_VIDEO_CODEC_ERROR;
  for (size_t count = 0; count < 4; ++count) {
    // An asynchronous MFT grants exactly one ProcessOutput call with each
    // METransformHaveOutput event.  Synchronous transforms keep the ordinary
    // pull-until-NEED_MORE_INPUT behavior.
    if (async_ && async_output_events_ == 0) return WEBRTC_VIDEO_CODEC_OK;
    if (async_) --async_output_events_;
    ComPtr<IMFSample> allocated_sample;
    ComPtr<IMFMediaBuffer> allocated_buffer;
    MFT_OUTPUT_DATA_BUFFER output{};
    output.dwStreamID = 0;
    if (!(info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
      DWORD capacity = std::max<DWORD>(info.cbSize, 2 * 1024 * 1024);
      if (FAILED(MFCreateSample(&allocated_sample)) ||
          FAILED(MFCreateMemoryBuffer(capacity, &allocated_buffer)) ||
          FAILED(allocated_sample->AddBuffer(allocated_buffer.Get()))) {
        return WEBRTC_VIDEO_CODEC_MEMORY;
      }
      output.pSample = allocated_sample.Get();
    }
    DWORD status = 0;
    const HRESULT hr = transform_->ProcessOutput(0, 1, &output, &status);
    if (output.pEvents) output.pEvents->Release();
    ComPtr<IMFSample> provided_sample;
    if ((info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) && output.pSample)
      provided_sample.Attach(output.pSample);
    if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return WEBRTC_VIDEO_CODEC_OK;
    if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
      if (hardware_ && hardware_output_stream_changes_++ == 0 &&
          TryAcceptCompatibleOutputType()) {
        RTC_LOG(LS_WARNING)
            << "Media Foundation hardware H.264 encoder advertised one "
               "late compatible output type; continuing with hardware";
        return WEBRTC_VIDEO_CODEC_OK;
      }
      // The negotiated H.264 stream is fixed for this encoder instance. A
      // repeated or incompatible hardware change can otherwise recreate the
      // same legacy MFT forever without producing a frame. Fail over to the
      // approved software MFT; a software transform keeps the bounded
      // controlled-recreation path.
      if (hardware_)
        return FallbackToSoftware("changed to an incompatible output stream")
                   ? WEBRTC_VIDEO_CODEC_OK
                   : WEBRTC_VIDEO_CODEC_ERROR;
      reconfigure_pending_ = true;
      return WEBRTC_VIDEO_CODEC_OK;
    }
    if (FAILED(hr) || !output.pSample) return WEBRTC_VIDEO_CODEC_ERROR;
    const int delivered = DeliverSample(output.pSample);
    if (delivered != WEBRTC_VIDEO_CODEC_OK) return delivered;
  }
  return WEBRTC_VIDEO_CODEC_OK;
}

int MfH264Encoder::DeliverSample(IMFSample* sample) {
  if (pending_.empty()) return WEBRTC_VIDEO_CODEC_ERROR;
  ComPtr<IMFMediaBuffer> contiguous;
  if (FAILED(sample->ConvertToContiguousBuffer(&contiguous)))
    return WEBRTC_VIDEO_CODEC_ERROR;
  BYTE* bytes = nullptr;
  DWORD length = 0;
  if (FAILED(contiguous->Lock(&bytes, nullptr, &length)))
    return WEBRTC_VIDEO_CODEC_ERROR;
  // MFVideoFormat_H264 is required to produce Annex-B access units, which is
  // the representation libwebrtc's H.264 packetizer consumes. Fail closed on
  // a non-conforming transform instead of inventing an application packetizer.
  if (!HasAnnexBStartCode(bytes, length)) {
    contiguous->Unlock();
    return WEBRTC_VIDEO_CODEC_ERROR;
  }
  const PendingFrame frame = pending_.front();
  pending_.pop_front();
  hardware_stall_polls_ = 0;
  hardware_encode_attempts_without_output_ = 0;
  if (hardware_ && hardware_inputs_without_output_ > 0) {
    --hardware_inputs_without_output_;
    if (hardware_inputs_without_output_ == 0) first_hardware_input_at_ms_ = 0;
  }
  auto encoded_data = webrtc::EncodedImageBuffer::Create(bytes, length);
  const bool idr = HasIdr(bytes, length);
  if (frame.requested_keyframe && !idr) force_keyframe_ = true;
  contiguous->Unlock();

  webrtc::EncodedImage image;
  image.SetEncodedData(encoded_data);
  image._encodedWidth = width_;
  image._encodedHeight = height_;
  image.SetRtpTimestamp(frame.rtp_timestamp);
  image.ntp_time_ms_ = frame.capture_time_ms;
  image.capture_time_ms_ = frame.capture_time_ms;
  image.set_frame_type(idr ? webrtc::VideoFrameType::kVideoFrameKey
                           : webrtc::VideoFrameType::kVideoFrameDelta);
  image.content_type_ = webrtc::VideoContentType::SCREENSHARE;

  webrtc::CodecSpecificInfo codec;
  codec.codecType = webrtc::kVideoCodecH264;
  codec.codecSpecific.H264.packetization_mode =
      webrtc::H264PacketizationMode::NonInterleaved;
  codec.codecSpecific.H264.temporal_idx = webrtc::kNoTemporalIdx;
  codec.codecSpecific.H264.idr_frame = idr;
  codec.codecSpecific.H264.base_layer_sync = false;
  callback_->OnEncodedImage(image, &codec);
  return WEBRTC_VIDEO_CODEC_OK;
}

void MfH264Encoder::RequestKeyFrame() {
  VARIANT request = BoolVariant(true);
  SetCodecValue(CODECAPI_AVEncVideoForceKeyFrame, request);
  VariantClear(&request);
}

void MfH264Encoder::PublishDiagnostics() const {
  std::lock_guard lock(g_diagnostics_mutex);
  g_diagnostics = {
      initialized_, hardware_, quality_.id, width_, height_, fps_,
      bitrate_bps_,
  };
}

std::vector<webrtc::SdpVideoFormat>
MfH264EncoderFactory::GetSupportedFormats() const {
  return {webrtc::SdpVideoFormat(
      "H264", {{"level-asymmetry-allowed", "1"},
                {"packetization-mode", "1"},
                {"profile-level-id", "42e01f"}},
      {webrtc::ScalabilityMode::kL1T1})};
}

webrtc::VideoEncoderFactory::CodecSupport
MfH264EncoderFactory::QueryCodecSupport(
    const webrtc::SdpVideoFormat& format,
    std::optional<std::string> scalability_mode,
    std::optional<webrtc::Resolution> resolution) const {
  const bool size_ok = !resolution ||
                       (resolution->width <= 4096 && resolution->height <= 4096);
  const bool mode_ok = !scalability_mode || *scalability_mode == "L1T1";
  return {.is_supported = IsH264(format) && mode_ok && size_ok,
          .is_power_efficient = false};
}

std::unique_ptr<webrtc::VideoEncoder> MfH264EncoderFactory::Create(
    const webrtc::Environment&,
    const webrtc::SdpVideoFormat& format) {
  return IsH264(format)
             ? std::make_unique<MfH264Encoder>(
                   HardwareEncoderAllowedByEnvironment())
             : nullptr;
}

}  // namespace imcodes::rd
