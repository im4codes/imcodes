#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>

#include "video_toolbox_h264_encoder.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <mutex>
#include <set>
#include <utility>
#include <vector>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::uint32_t kMaximumPendingFrames = 8;
constexpr std::uint32_t kMaximumDimension = 16'384;
constexpr std::uint32_t kMaximumFrameRate = 120;
constexpr std::uint32_t kMinimumBitrateBps = 100'000;
constexpr std::uint32_t kMaximumBitrateBps = 100'000'000;
constexpr std::array<std::byte, 4> kAnnexBStartCode = {
    std::byte{0}, std::byte{0}, std::byte{0}, std::byte{1}};

std::string StatusMessage(std::string_view operation, OSStatus status) {
  return std::string(operation) + " failed with OSStatus " +
         std::to_string(status);
}

bool IsValidConfiguration(const common::EncoderConfiguration& configuration,
                          const VideoToolboxEncoderLimits& limits) {
  return configuration.encoded_pixels.IsValid() &&
         configuration.encoded_pixels.width <= limits.max_dimension &&
         configuration.encoded_pixels.height <= limits.max_dimension &&
         (configuration.encoded_pixels.width & 1U) == 0 &&
         (configuration.encoded_pixels.height & 1U) == 0 &&
         configuration.frame_rate > 0 &&
         configuration.frame_rate <= kMaximumFrameRate &&
         configuration.bitrate_bps >= kMinimumBitrateBps &&
         configuration.bitrate_bps <= kMaximumBitrateBps;
}

CFStringRef ProfileLevel(common::H264Profile profile) {
  switch (profile) {
    case common::H264Profile::kConstrainedBaseline:
      return kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel;
    case common::H264Profile::kMain:
      return kVTProfileLevel_H264_Main_AutoLevel;
    case common::H264Profile::kHigh:
      return kVTProfileLevel_H264_High_AutoLevel;
  }
  return nullptr;
}

bool SetProperty(VTCompressionSessionRef session,
                 CFStringRef key,
                 CFTypeRef value,
                 VideoToolboxEncoderError* error) {
  const OSStatus status = VTSessionSetProperty(session, key, value);
  if (status == noErr) {
    return true;
  }
  if (error != nullptr) {
    *error = {VideoToolboxEncoderErrorCode::kEncoderPropertyRejected,
              StatusMessage("VTSessionSetProperty", status)};
  }
  return false;
}

template <typename Integer>
CFNumberRef Number(Integer value) {
  if constexpr (sizeof(Integer) <= sizeof(std::int32_t)) {
    const std::int32_t converted = static_cast<std::int32_t>(value);
    return CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &converted);
  } else {
    const std::int64_t converted = static_cast<std::int64_t>(value);
    return CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt64Type, &converted);
  }
}

bool UsingHardwareEncoder(VTCompressionSessionRef session,
                          bool* using_hardware) {
  if (using_hardware == nullptr) {
    return false;
  }
  CFTypeRef value = nullptr;
  const OSStatus status = VTSessionCopyProperty(
      session, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
      kCFAllocatorDefault, &value);
  // NOT SUPPORTED IS AN ANSWER, NOT AN ERROR.
  //
  // Measured on a Mac Pro 6,1 running macOS 12.7.6: a software-only H.264
  // session creates successfully (status 0) but this property returns
  // kVTPropertyNotSupportedErr (-12900) with no value. VideoToolbox only
  // publishes the key when it has something to report.
  //
  // Treating that as a failure rejected every software session on that host,
  // so `encoder` stayed false and the runtime profile resolved to
  // `unavailable` on a machine that encodes fine. An absent key means
  // VideoToolbox is NOT claiming hardware acceleration, which is exactly
  // `using_hardware = false`.
  //
  // This stays fail-closed for hardware: the caller demands an AFFIRMATIVE
  // true before it will accept a hardware session, so an unsupported property
  // still rejects the hardware kind. Only the software kind, which requires
  // `using_hardware` to be false, is unblocked.
  if (status == kVTPropertyNotSupportedErr) {
    if (value != nullptr) {
      CFRelease(value);
    }
    *using_hardware = false;
    return true;
  }
  if (status != noErr || value == nullptr ||
      CFGetTypeID(value) != CFBooleanGetTypeID()) {
    if (value != nullptr) {
      CFRelease(value);
    }
    return false;
  }
  *using_hardware = CFBooleanGetValue(static_cast<CFBooleanRef>(value));
  CFRelease(value);
  return true;
}

// Constrained profiles the Apple SOFTWARE encoder rejects, and the plain
// profile that is spec-equivalent for our purposes.
//
// Measured on macOS 12.7.6 (Intel): the software H.264 encoder returns
// kVTParameterErr (-12902) for ConstrainedBaseline_AutoLevel and
// ConstrainedHigh_AutoLevel while accepting Baseline/Main/High.
//
// Falling back is only sound because the emitted bitstream was INSPECTED, not
// assumed. Encoding a real 640x480 frame with Baseline_AutoLevel on that host
// produced an SPS of profile_idc=66, profile_iop=0xe0 (constraint_set0=1,
// constraint_set1=1, constraint_set2=1), level_idc=30, i.e.
// profile-level-id 42e01e. profile_idc 66 with constraint_set1 set IS
// Constrained Baseline, so the stream remains compatible with the negotiated
// 42e01f offer; only the level differs, and 3.0 is within the advertised 3.1.
// ConstrainedBaseline is the ONLY constrained profile ProfileLevel() can
// produce, so it is the only one mapped here. A ConstrainedHigh branch would be
// unreachable surface that no test could exercise and no measurement covers.
CFStringRef PlainProfileForRejectedConstrained(CFStringRef requested) {
  if (requested == kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel) {
    return kVTProfileLevel_H264_Baseline_AutoLevel;
  }
  return nullptr;
}

bool ConfigureLowLatencyProperties(
    VTCompressionSessionRef session,
    const common::EncoderConfiguration& configuration,
    VideoToolboxEncoderKind kind,
    VideoToolboxEncoderError* error) {
  if (!SetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue,
                   error) ||
      !SetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering,
                   kCFBooleanFalse, error)) {
    return false;
  }

  CFStringRef profile_level = ProfileLevel(configuration.profile);
  if (profile_level == nullptr) {
    return false;
  }
  const OSStatus profile_status = VTSessionSetProperty(
      session, kVTCompressionPropertyKey_ProfileLevel, profile_level);
  if (profile_status != noErr) {
    // Retry is gated on ALL THREE of: the software kind, an exact constrained
    // mapping, and the exact measured status kVTParameterErr (-12902). Hardware
    // keeps the exact requested profile, and any other status fails closed --
    // an unexpected failure must not be laundered into a different profile.
    CFStringRef plain =
        (kind == VideoToolboxEncoderKind::kQualifiedAppleSoftware &&
         profile_status == kVTParameterErr)
            ? PlainProfileForRejectedConstrained(profile_level)
            : nullptr;
    if (plain == nullptr ||
        !SetProperty(session, kVTCompressionPropertyKey_ProfileLevel, plain,
                     error)) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kInvalidConfiguration,
                  "VideoToolbox rejected the requested H.264 profile level"};
      }
      return false;
    }
  }

  CFNumberRef frame_rate = Number(configuration.frame_rate);
  CFNumberRef bitrate = Number(configuration.bitrate_bps);
  const std::uint32_t keyframe_interval =
      std::min<std::uint32_t>(configuration.frame_rate * 2, 240);
  CFNumberRef keyframe_count = Number(keyframe_interval);
  const double keyframe_seconds_value = 2.0;
  CFNumberRef keyframe_seconds = CFNumberCreate(
      kCFAllocatorDefault, kCFNumberDoubleType, &keyframe_seconds_value);
  const std::uint64_t bytes_per_second =
      std::max<std::uint64_t>(1, configuration.bitrate_bps / 8);
  CFNumberRef data_limit = Number(bytes_per_second);
  const double one_second_value = 1.0;
  CFNumberRef one_second = CFNumberCreate(
      kCFAllocatorDefault, kCFNumberDoubleType, &one_second_value);
  const void* data_rate_values[] = {data_limit, one_second};
  CFArrayRef data_rate_limits = CFArrayCreate(
      kCFAllocatorDefault, data_rate_values, 2, &kCFTypeArrayCallBacks);

  const bool ok =
      SetProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate,
                  frame_rate, error) &&
      SetProperty(session, kVTCompressionPropertyKey_AverageBitRate, bitrate,
                  error) &&
      SetProperty(session, kVTCompressionPropertyKey_DataRateLimits,
                  data_rate_limits, error) &&
      SetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval,
                  keyframe_count, error) &&
      SetProperty(session,
                  kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                  keyframe_seconds, error);

  CFRelease(frame_rate);
  CFRelease(bitrate);
  CFRelease(keyframe_count);
  CFRelease(keyframe_seconds);
  CFRelease(data_limit);
  CFRelease(one_second);
  CFRelease(data_rate_limits);
  return ok;
}

class ScopedPixelBuffer {
 public:
  ScopedPixelBuffer() = default;
  ~ScopedPixelBuffer() {
    if (value_ != nullptr) {
      CVPixelBufferRelease(value_);
    }
  }

  ScopedPixelBuffer(const ScopedPixelBuffer&) = delete;
  ScopedPixelBuffer& operator=(const ScopedPixelBuffer&) = delete;

  CVPixelBufferRef* out() { return &value_; }
  [[nodiscard]] CVPixelBufferRef get() const { return value_; }

 private:
  CVPixelBufferRef value_ = nullptr;
};

class ScopedPixelTransferSession {
 public:
  ~ScopedPixelTransferSession() {
    if (value_ != nullptr) {
      VTPixelTransferSessionInvalidate(value_);
      CFRelease(value_);
    }
  }

  VTPixelTransferSessionRef* out() { return &value_; }
  [[nodiscard]] VTPixelTransferSessionRef get() const { return value_; }

 private:
  VTPixelTransferSessionRef value_ = nullptr;
};

bool CreateBgraPixelBuffer(common::PixelSize size,
                           ScopedPixelBuffer* output,
                           VideoToolboxEncoderError* error) {
  NSDictionary* attributes = @{
    (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey : @{},
    (__bridge NSString*)kCVPixelBufferMetalCompatibilityKey : @YES,
  };
  const CVReturn result = CVPixelBufferCreate(
      kCFAllocatorDefault, size.width, size.height, kCVPixelFormatType_32BGRA,
      (__bridge CFDictionaryRef)attributes, output->out());
  if (result == kCVReturnSuccess && output->get() != nullptr) {
    return true;
  }
  if (error != nullptr) {
    *error = {
        VideoToolboxEncoderErrorCode::kPixelBufferAllocationFailed,
        "CVPixelBufferCreate failed with status " + std::to_string(result)};
  }
  return false;
}

bool CopyBgraRows(const common::CapturedFrame& frame,
                  CVPixelBufferRef destination,
                  std::uint64_t* copied_bytes,
                  VideoToolboxEncoderError* error) {
  if (destination == nullptr) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kPixelBufferAllocationFailed,
                "VideoToolbox input pixel buffer is missing"};
    }
    return false;
  }
  if (CVPixelBufferLockBaseAddress(destination, 0) != kCVReturnSuccess) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kPixelBufferAllocationFailed,
                "unable to lock VideoToolbox input pixel buffer"};
    }
    return false;
  }
  auto unlock = [&] { CVPixelBufferUnlockBaseAddress(destination, 0); };
  auto* destination_bytes =
      static_cast<std::byte*>(CVPixelBufferGetBaseAddress(destination));
  const std::size_t destination_row_bytes =
      CVPixelBufferGetBytesPerRow(destination);
  const bool copied = video_toolbox_detail::CopyBgraFrameRows(
      frame, destination_bytes, destination_row_bytes,
      CVPixelBufferGetDataSize(destination), copied_bytes, error);
  unlock();
  return copied;
}

void ApplyColorPrimaries(common::ColorPrimaries primaries,
                         CVPixelBufferRef pixel_buffer) {
  CFStringRef value = nullptr;
  switch (primaries) {
    case common::ColorPrimaries::kUnspecified:
      return;
    case common::ColorPrimaries::kBt709:
      value = kCVImageBufferColorPrimaries_ITU_R_709_2;
      break;
    case common::ColorPrimaries::kDisplayP3:
      value = kCVImageBufferColorPrimaries_P3_D65;
      break;
  }
  CVBufferSetAttachment(pixel_buffer, kCVImageBufferColorPrimariesKey, value,
                        kCVAttachmentMode_ShouldPropagate);
}

bool AppendAnnexBNal(const std::uint8_t* bytes,
                     std::size_t size,
                     std::size_t limit,
                     std::vector<std::byte>* output) {
  if (bytes == nullptr || size == 0 || limit < kAnnexBStartCode.size() ||
      output->size() > limit ||
      kAnnexBStartCode.size() > limit - output->size() ||
      size > limit - output->size() - kAnnexBStartCode.size()) {
    return false;
  }
  output->insert(output->end(), kAnnexBStartCode.begin(),
                 kAnnexBStartCode.end());
  output->insert(output->end(), reinterpret_cast<const std::byte*>(bytes),
                 reinterpret_cast<const std::byte*>(bytes + size));
  return true;
}

bool IsKeyframe(CMSampleBufferRef sample_buffer) {
  CFArrayRef attachments =
      CMSampleBufferGetSampleAttachmentsArray(sample_buffer, false);
  if (attachments == nullptr || CFArrayGetCount(attachments) == 0) {
    return false;
  }
  CFDictionaryRef dictionary =
      static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
  CFTypeRef not_sync =
      CFDictionaryGetValue(dictionary, kCMSampleAttachmentKey_NotSync);
  return not_sync == nullptr || !CFEqual(not_sync, kCFBooleanTrue);
}

bool CopyBlockBuffer(CMBlockBufferRef block,
                     std::size_t limit,
                     std::vector<std::uint8_t>* bytes) {
  const std::size_t length = CMBlockBufferGetDataLength(block);
  if (length == 0 || length > limit) {
    return false;
  }
  bytes->resize(length);
  return CMBlockBufferCopyDataBytes(block, 0, length, bytes->data()) ==
         kCMBlockBufferNoErr;
}

std::optional<common::H264AccessUnit> ConvertAvccToAnnexB(
    CMSampleBufferRef sample_buffer,
    std::int64_t presentation_time_us,
    common::H264Profile profile,
    std::size_t max_bytes,
    VideoToolboxEncoderError* error) {
  if (sample_buffer == nullptr || !CMSampleBufferDataIsReady(sample_buffer)) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                "VideoToolbox returned an unreadable sample buffer"};
    }
    return std::nullopt;
  }

  common::H264AccessUnit output{
      .bytes = {},
      .presentation_time_us = presentation_time_us,
      .profile = profile,
      .keyframe = IsKeyframe(sample_buffer),
  };
  std::vector<std::vector<std::byte>> parameter_sets;

  CMFormatDescriptionRef format =
      CMSampleBufferGetFormatDescription(sample_buffer);
  int nal_length_bytes_value = 0;
  if (format == nullptr) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                "VideoToolbox sample has no H.264 format description"};
    }
    return std::nullopt;
  }

  if (output.keyframe) {
    const std::uint8_t* parameter_set = nullptr;
    std::size_t parameter_set_size = 0;
    std::size_t parameter_set_count = 0;
    OSStatus status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format, 0, &parameter_set, &parameter_set_size, &parameter_set_count,
        &nal_length_bytes_value);
    if (status != noErr || parameter_set_count == 0) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                  StatusMessage("H.264 parameter-set query", status)};
      }
      return std::nullopt;
    }
    for (std::size_t index = 0; index < parameter_set_count; ++index) {
      status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, index, &parameter_set, &parameter_set_size, nullptr,
          &nal_length_bytes_value);
      if (status != noErr || parameter_set == nullptr ||
          parameter_set_size == 0 || parameter_set_size > max_bytes) {
        if (error != nullptr) {
          *error = {VideoToolboxEncoderErrorCode::kAccessUnitTooLarge,
                    "H.264 parameter sets exceed the bounded Annex-B output"};
        }
        return std::nullopt;
      }
      parameter_sets.emplace_back(
          reinterpret_cast<const std::byte*>(parameter_set),
          reinterpret_cast<const std::byte*>(parameter_set +
                                             parameter_set_size));
    }
  } else {
    const std::uint8_t* ignored = nullptr;
    std::size_t ignored_size = 0;
    std::size_t ignored_count = 0;
    const OSStatus status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format, 0, &ignored, &ignored_size, &ignored_count,
        &nal_length_bytes_value);
    if (status != noErr) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                  StatusMessage("H.264 NAL length query", status)};
      }
      return std::nullopt;
    }
  }
  if (nal_length_bytes_value <= 0 || nal_length_bytes_value > 4) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                "VideoToolbox returned an invalid AVCC NAL length width"};
    }
    return std::nullopt;
  }
  const std::size_t nal_length_bytes =
      static_cast<std::size_t>(nal_length_bytes_value);

  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample_buffer);
  std::vector<std::uint8_t> avcc;
  if (block == nullptr || !CopyBlockBuffer(block, max_bytes, &avcc)) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kAccessUnitTooLarge,
                "VideoToolbox AVCC payload is empty or exceeds its bound"};
    }
    return std::nullopt;
  }

  const auto avcc_bytes = std::span<const std::byte>(
      reinterpret_cast<const std::byte*>(avcc.data()), avcc.size());
  if (!video_toolbox_detail::ConvertAvccPayloadToAnnexB(
          parameter_sets, avcc_bytes, nal_length_bytes, max_bytes,
          &output.bytes, error)) {
    return std::nullopt;
  }

  if (!output.IsValid()) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                "VideoToolbox produced an empty H.264 access unit"};
    }
    return std::nullopt;
  }
  return output;
}

struct FrameContext {
  std::uint64_t submission_id = 0;
  std::int64_t presentation_time_us = 0;
  common::H264Profile profile = common::H264Profile::kConstrainedBaseline;
  std::size_t max_access_unit_bytes = 0;
  VideoToolboxBackendOutputSink output_sink;
  VideoToolboxBackendErrorSink error_sink;
};

void CompressionOutput(void*,
                       void* source_frame_ref_con,
                       OSStatus status,
                       VTEncodeInfoFlags,
                       CMSampleBufferRef sample_buffer) {
  std::unique_ptr<FrameContext> context(
      static_cast<FrameContext*>(source_frame_ref_con));
  if (!context) {
    return;
  }
  if (status != noErr) {
    context->error_sink(
        context->submission_id,
        {VideoToolboxEncoderErrorCode::kEncodeFailed,
         StatusMessage("VideoToolbox encode callback", status)});
    return;
  }
  VideoToolboxEncoderError error;
  auto access_unit = ConvertAvccToAnnexB(
      sample_buffer, context->presentation_time_us, context->profile,
      context->max_access_unit_bytes, &error);
  if (!access_unit.has_value()) {
    context->error_sink(context->submission_id, std::move(error));
    return;
  }
  context->output_sink(context->submission_id, std::move(*access_unit));
}

VTCompressionSessionRef CreateCompressionSession(
    const common::EncoderConfiguration& configuration,
    VideoToolboxEncoderKind kind,
    VideoToolboxEncoderError* error) {
  NSDictionary* encoder_specification = nil;
  switch (kind) {
    case VideoToolboxEncoderKind::kHardware:
      encoder_specification = @{
        (__bridge NSString*)
        kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder :
            @YES,
        (__bridge NSString*)
        kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder :
            @YES,
      };
      break;
    case VideoToolboxEncoderKind::kQualifiedAppleSoftware:
      encoder_specification = @{
        (__bridge NSString*)
        kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder :
            @NO,
      };
      break;
    case VideoToolboxEncoderKind::kNone:
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kInvalidConfiguration,
                  "encoder kind must be hardware or qualified Apple software"};
      }
      return nullptr;
  }

  VTCompressionSessionRef session = nullptr;
  const OSStatus status = VTCompressionSessionCreate(
      kCFAllocatorDefault, configuration.encoded_pixels.width,
      configuration.encoded_pixels.height, kCMVideoCodecType_H264,
      (__bridge CFDictionaryRef)encoder_specification, nullptr, nullptr,
      CompressionOutput, nullptr, &session);
  if (status != noErr || session == nullptr) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kEncoderCreationFailed,
                StatusMessage("VTCompressionSessionCreate", status)};
    }
    return nullptr;
  }

  bool using_hardware = false;
  if (!UsingHardwareEncoder(session, &using_hardware) ||
      (kind == VideoToolboxEncoderKind::kHardware && !using_hardware) ||
      (kind == VideoToolboxEncoderKind::kQualifiedAppleSoftware &&
       using_hardware)) {
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    if (error != nullptr) {
      *error = {
          kind == VideoToolboxEncoderKind::kHardware
              ? VideoToolboxEncoderErrorCode::kHardwareUnavailable
              : VideoToolboxEncoderErrorCode::kSoftwareFallbackUnqualified,
          "VideoToolbox did not create the requested encoder kind"};
    }
    return nullptr;
  }

  if (!ConfigureLowLatencyProperties(session, configuration, kind, error)) {
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    return nullptr;
  }
  const OSStatus prepare = VTCompressionSessionPrepareToEncodeFrames(session);
  if (prepare != noErr) {
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    if (error != nullptr) {
      *error = {
          VideoToolboxEncoderErrorCode::kEncoderCreationFailed,
          StatusMessage("VTCompressionSessionPrepareToEncodeFrames", prepare)};
    }
    return nullptr;
  }
  return session;
}

class AppleVideoToolboxEncoderBackend final
    : public VideoToolboxEncoderBackend {
 public:
  ~AppleVideoToolboxEncoderBackend() override { Stop(); }

  bool HardwareEncoderAvailable() noexcept override {
    common::EncoderConfiguration probe{
        {64, 64}, 5, 350'000, common::H264Profile::kConstrainedBaseline};
    VideoToolboxEncoderError error;
    VTCompressionSessionRef session = CreateCompressionSession(
        probe, VideoToolboxEncoderKind::kHardware, &error);
    if (session == nullptr) {
      return false;
    }
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    return true;
  }

  bool AppleSoftwareEncoderAvailable() noexcept override {
    common::EncoderConfiguration probe{
        {64, 64}, 5, 350'000, common::H264Profile::kConstrainedBaseline};
    VideoToolboxEncoderError error;
    VTCompressionSessionRef session = CreateCompressionSession(
        probe, VideoToolboxEncoderKind::kQualifiedAppleSoftware, &error);
    if (session == nullptr) {
      return false;
    }
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    return true;
  }

  bool Configure(const common::EncoderConfiguration& configuration,
                 VideoToolboxEncoderKind kind,
                 VideoToolboxBackendOutputSink output_sink,
                 VideoToolboxBackendErrorSink error_sink,
                 const VideoToolboxEncoderLimits& limits,
                 VideoToolboxEncoderError* error) override {
    Stop();
    if (!output_sink || !error_sink ||
        !IsValidConfiguration(configuration, limits)) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kInvalidConfiguration,
                  "invalid VideoToolbox backend configuration"};
      }
      return false;
    }
    VTCompressionSessionRef session =
        CreateCompressionSession(configuration, kind, error);
    if (session == nullptr) {
      return false;
    }
    std::lock_guard lock(mutex_);
    session_ = session;
    configuration_ = configuration;
    limits_ = limits;
    output_sink_ = std::move(output_sink);
    error_sink_ = std::move(error_sink);
    return true;
  }

  bool Encode(std::uint64_t submission_id,
              const common::CapturedFrame& frame,
              bool request_keyframe,
              VideoToolboxEncoderError* error) override {
    std::lock_guard lock(mutex_);
    if (session_ == nullptr || !frame.IsValid() ||
        frame.pixel_format != common::PixelFormat::kBgra8888) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kUnsupportedFrame,
                  "VideoToolbox encode requires a configured BGRA8888 frame"};
      }
      return false;
    }
    const std::uint64_t input_extent =
        static_cast<std::uint64_t>(frame.row_bytes) *
        frame.encoded_pixels.height;
    const bool scaling =
        frame.encoded_pixels.width != configuration_.encoded_pixels.width ||
        frame.encoded_pixels.height != configuration_.encoded_pixels.height;
    if (input_extent > limits_.max_input_bytes) {
      if (error != nullptr) {
        *error = {
            VideoToolboxEncoderErrorCode::kCopyLimitExceeded,
            "captured frame exceeds the bounded VideoToolbox copy budget"};
      }
      return false;
    }

    ScopedPixelBuffer source;
    if (!CreateBgraPixelBuffer(frame.encoded_pixels, &source, error)) {
      return false;
    }
    std::uint64_t actual_copy_bytes = CVPixelBufferGetDataSize(source.get());
    if (actual_copy_bytes > limits_.max_copy_bytes_per_frame) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kCopyLimitExceeded,
                  "source pixel buffer exceeds the bounded copy budget"};
      }
      return false;
    }
    if (!CopyBgraRows(frame, source.get(), nullptr, error)) {
      return false;
    }
    ApplyColorPrimaries(frame.color_primaries, source.get());

    ScopedPixelBuffer scaled;
    CVPixelBufferRef input = source.get();
    if (scaling) {
      if (!CreateBgraPixelBuffer(configuration_.encoded_pixels, &scaled,
                                 error)) {
        return false;
      }
      const std::uint64_t scaled_bytes = CVPixelBufferGetDataSize(scaled.get());
      if (scaled_bytes > limits_.max_copy_bytes_per_frame - actual_copy_bytes) {
        if (error != nullptr) {
          *error = {VideoToolboxEncoderErrorCode::kCopyLimitExceeded,
                    "scaled pixel buffer exceeds the bounded copy budget"};
        }
        return false;
      }
      ScopedPixelTransferSession transfer;
      const OSStatus create_transfer =
          VTPixelTransferSessionCreate(kCFAllocatorDefault, transfer.out());
      if (create_transfer != noErr || transfer.get() == nullptr ||
          VTSessionSetProperty(transfer.get(),
                               kVTPixelTransferPropertyKey_ScalingMode,
                               kVTScalingMode_Normal) != noErr) {
        if (error != nullptr) {
          *error = {VideoToolboxEncoderErrorCode::kPixelTransferFailed,
                    StatusMessage("VTPixelTransferSessionCreate/configure",
                                  create_transfer)};
        }
        return false;
      }
      const OSStatus transfer_status = VTPixelTransferSessionTransferImage(
          transfer.get(), source.get(), scaled.get());
      if (transfer_status != noErr) {
        if (error != nullptr) {
          *error = {VideoToolboxEncoderErrorCode::kPixelTransferFailed,
                    StatusMessage("VTPixelTransferSessionTransferImage",
                                  transfer_status)};
        }
        return false;
      }
      input = scaled.get();
      ApplyColorPrimaries(frame.color_primaries, scaled.get());
    }

    auto context = std::make_unique<FrameContext>(FrameContext{
        .submission_id = submission_id,
        .presentation_time_us = frame.capture_time_us,
        .profile = configuration_.profile,
        .max_access_unit_bytes = limits_.max_access_unit_bytes,
        .output_sink = output_sink_,
        .error_sink = error_sink_,
    });
    CFDictionaryRef frame_properties = nullptr;
    NSDictionary* keyframe_properties = request_keyframe ? @{
      (__bridge NSString*)kVTEncodeFrameOptionKey_ForceKeyFrame : @YES
    }
                                                         : nil;
    if (keyframe_properties != nil) {
      frame_properties = (__bridge CFDictionaryRef)keyframe_properties;
    }
    VTEncodeInfoFlags info_flags = 0;
    const CMTime presentation_time =
        CMTimeMake(frame.capture_time_us, 1'000'000);
    FrameContext* raw_context = context.release();
    const OSStatus status = VTCompressionSessionEncodeFrame(
        session_, input, presentation_time, kCMTimeInvalid, frame_properties,
        raw_context, &info_flags);
    if (status != noErr) {
      delete raw_context;
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kEncodeFailed,
                  StatusMessage("VTCompressionSessionEncodeFrame", status)};
      }
      return false;
    }
    return true;
  }

  void Stop() noexcept override {
    VTCompressionSessionRef session = nullptr;
    {
      std::lock_guard lock(mutex_);
      session = session_;
      session_ = nullptr;
      output_sink_ = {};
      error_sink_ = {};
    }
    if (session != nullptr) {
      (void)VTCompressionSessionCompleteFrames(session, kCMTimeInvalid);
      VTCompressionSessionInvalidate(session);
      CFRelease(session);
    }
  }

 private:
  mutable std::mutex mutex_;
  VTCompressionSessionRef session_ = nullptr;
  common::EncoderConfiguration configuration_;
  VideoToolboxEncoderLimits limits_;
  VideoToolboxBackendOutputSink output_sink_;
  VideoToolboxBackendErrorSink error_sink_;
};

struct DeliveryState {
  mutable std::mutex mutex;
  std::uint64_t generation = 0;
  bool accepting = false;
  bool force_next_keyframe = false;
  std::uint32_t max_pending_frames = 0;
  std::size_t max_access_unit_bytes = 0;
  std::uint64_t next_submission_id = 1;
  std::set<std::uint64_t> pending;
  common::H264AccessUnitSink sink;
  VideoToolboxEncoderError last_error;
  VideoToolboxEncoderStatistics statistics;

  std::optional<std::pair<std::uint64_t, bool>> Begin(
      const common::CapturedFrame& frame,
      bool request_keyframe) {
    std::lock_guard lock(mutex);
    if (!accepting || !frame.IsValid() ||
        frame.pixel_format != common::PixelFormat::kBgra8888) {
      ++statistics.rejected_invalid_frames;
      last_error = {
          VideoToolboxEncoderErrorCode::kUnsupportedFrame,
          "encoder rejected an invalid or unsupported captured frame"};
      return std::nullopt;
    }
    if (pending.size() >= max_pending_frames) {
      ++statistics.dropped_backpressure_frames;
      return std::nullopt;
    }
    const std::uint64_t id = next_submission_id++;
    pending.insert(id);
    statistics.pending_frames = static_cast<std::uint32_t>(pending.size());
    const bool force = request_keyframe || force_next_keyframe;
    force_next_keyframe = false;
    return std::pair{id, force};
  }

  void Reject(std::uint64_t id, VideoToolboxEncoderError error) {
    std::lock_guard lock(mutex);
    if (pending.erase(id) == 0) {
      return;
    }
    ++statistics.failed_frames;
    statistics.pending_frames = static_cast<std::uint32_t>(pending.size());
    force_next_keyframe = true;
    last_error = std::move(error);
  }

  void Emit(std::uint64_t callback_generation,
            std::uint64_t id,
            common::H264AccessUnit access_unit) {
    common::H264AccessUnitSink current_sink;
    {
      std::lock_guard lock(mutex);
      if (!accepting || generation != callback_generation ||
          pending.erase(id) == 0) {
        ++statistics.ignored_late_outputs;
        return;
      }
      statistics.pending_frames = static_cast<std::uint32_t>(pending.size());
      if (!access_unit.IsValid() ||
          access_unit.bytes.size() > max_access_unit_bytes) {
        ++statistics.failed_frames;
        last_error = {
            VideoToolboxEncoderErrorCode::kAccessUnitTooLarge,
            "backend returned an invalid or oversized H.264 access unit"};
        force_next_keyframe = true;
        return;
      }
      ++statistics.emitted_access_units;
      statistics.emitted_access_unit_bytes += access_unit.bytes.size();
      current_sink = sink;
    }
    current_sink(std::move(access_unit));
  }

  void Fail(std::uint64_t callback_generation,
            std::uint64_t id,
            VideoToolboxEncoderError error) {
    std::lock_guard lock(mutex);
    if (!accepting || generation != callback_generation ||
        pending.erase(id) == 0) {
      ++statistics.ignored_late_outputs;
      return;
    }
    statistics.pending_frames = static_cast<std::uint32_t>(pending.size());
    ++statistics.failed_frames;
    force_next_keyframe = true;
    last_error = std::move(error);
  }

  void Stop() {
    std::lock_guard lock(mutex);
    ++generation;
    accepting = false;
    force_next_keyframe = false;
    pending.clear();
    statistics.pending_frames = 0;
    sink = {};
  }
};

}  // namespace

namespace video_toolbox_detail {

bool CopyBgraFrameRows(const common::CapturedFrame& frame,
                       std::byte* destination,
                       std::size_t destination_row_bytes,
                       std::size_t destination_size,
                       std::uint64_t* copied_bytes,
                       VideoToolboxEncoderError* error) {
  if (!frame.IsValid() ||
      frame.pixel_format != common::PixelFormat::kBgra8888) {
    if (error != nullptr) {
      *error = {
          VideoToolboxEncoderErrorCode::kUnsupportedFrame,
          "encoder requires a valid BGRA8888 frame with explicit row_bytes"};
    }
    return false;
  }
  const std::size_t visible_row_bytes =
      static_cast<std::size_t>(frame.encoded_pixels.width) * 4;
  const std::uint64_t required_destination =
      static_cast<std::uint64_t>(destination_row_bytes) *
      frame.encoded_pixels.height;
  if (destination == nullptr || destination_row_bytes < visible_row_bytes ||
      required_destination == 0 || required_destination > destination_size) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kPixelBufferAllocationFailed,
                "VideoToolbox input buffer has an invalid bounded row layout"};
    }
    return false;
  }

  const std::byte* source = frame.storage->data();
  for (std::uint32_t row = 0; row < frame.encoded_pixels.height; ++row) {
    std::byte* destination_row =
        destination + static_cast<std::size_t>(row) * destination_row_bytes;
    std::memset(destination_row, 0, destination_row_bytes);
    std::memcpy(destination_row,
                source + static_cast<std::size_t>(row) * frame.row_bytes,
                visible_row_bytes);
  }
  if (copied_bytes != nullptr) {
    *copied_bytes = static_cast<std::uint64_t>(destination_row_bytes) *
                    frame.encoded_pixels.height;
  }
  return true;
}

bool ConvertAvccPayloadToAnnexB(
    const std::vector<std::vector<std::byte>>& parameter_sets,
    std::span<const std::byte> avcc,
    std::size_t nal_length_bytes,
    std::size_t max_output_bytes,
    std::vector<std::byte>* annex_b,
    VideoToolboxEncoderError* error) {
  if (annex_b == nullptr || nal_length_bytes == 0 || nal_length_bytes > 4 ||
      avcc.empty()) {
    if (error != nullptr) {
      *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                "invalid bounded AVCC conversion input"};
    }
    return false;
  }
  annex_b->clear();
  for (const auto& parameter_set : parameter_sets) {
    if (!AppendAnnexBNal(
            reinterpret_cast<const std::uint8_t*>(parameter_set.data()),
            parameter_set.size(), max_output_bytes, annex_b)) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kAccessUnitTooLarge,
                  "H.264 parameter sets exceed the bounded Annex-B output"};
      }
      annex_b->clear();
      return false;
    }
  }

  std::size_t offset = 0;
  while (offset < avcc.size()) {
    if (avcc.size() - offset < nal_length_bytes) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                  "truncated AVCC NAL length"};
      }
      annex_b->clear();
      return false;
    }
    std::size_t nal_size = 0;
    for (std::size_t index = 0; index < nal_length_bytes; ++index) {
      nal_size =
          (nal_size << 8) | static_cast<std::uint8_t>(avcc[offset + index]);
    }
    offset += nal_length_bytes;
    if (nal_size == 0 || nal_size > avcc.size() - offset ||
        !AppendAnnexBNal(
            reinterpret_cast<const std::uint8_t*>(avcc.data() + offset),
            nal_size, max_output_bytes, annex_b)) {
      if (error != nullptr) {
        *error = {VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
                  "invalid or oversized AVCC NAL unit"};
      }
      annex_b->clear();
      return false;
    }
    offset += nal_size;
  }
  return !annex_b->empty();
}

}  // namespace video_toolbox_detail

bool VideoToolboxEncoderLimits::IsValid() const noexcept {
  return max_pending_frames > 0 &&
         max_pending_frames <= kMaximumPendingFrames && max_dimension > 0 &&
         max_dimension <= kMaximumDimension && max_input_bytes > 0 &&
         max_copy_bytes_per_frame >= max_input_bytes &&
         max_access_unit_bytes > 0;
}

class VideoToolboxH264Encoder::Impl {
 public:
  Impl(std::unique_ptr<VideoToolboxEncoderBackend> backend,
       VideoToolboxEncoderPolicy policy,
       VideoToolboxEncoderLimits limits)
      : backend_(std::move(backend)), policy_(policy), limits_(limits) {
    state_->max_pending_frames = limits_.max_pending_frames;
    state_->max_access_unit_bytes = limits_.max_access_unit_bytes;
  }

  common::ReadinessState ProbeReadiness() {
    if (!backend_ || !limits_.IsValid()) {
      return common::ReadinessState::kUnavailable;
    }
    if (backend_->HardwareEncoderAvailable()) {
      return common::ReadinessState::kReady;
    }
    return policy_.allow_apple_software_fallback &&
                   policy_.apple_software_fallback_qualified &&
                   backend_->AppleSoftwareEncoderAvailable()
               ? common::ReadinessState::kReady
               : common::ReadinessState::kUnavailable;
  }

  bool Configure(const common::EncoderConfiguration& configuration,
                 common::H264AccessUnitSink sink) {
    Stop();
    if (!backend_ || !limits_.IsValid() || !sink ||
        !IsValidConfiguration(configuration, limits_)) {
      std::lock_guard lock(mutex_);
      last_error_ = {VideoToolboxEncoderErrorCode::kInvalidConfiguration,
                     "invalid VideoToolbox encoder configuration"};
      return false;
    }

    std::uint64_t generation = 0;
    {
      std::lock_guard lock(state_->mutex);
      generation = ++state_->generation;
    }
    const auto state = state_;
    auto output_sink = [state, generation](std::uint64_t id,
                                           common::H264AccessUnit access_unit) {
      state->Emit(generation, id, std::move(access_unit));
    };
    auto error_sink = [state, generation](std::uint64_t id,
                                          VideoToolboxEncoderError error) {
      state->Fail(generation, id, std::move(error));
    };

    VideoToolboxEncoderError hardware_error;
    bool configured = false;
    VideoToolboxEncoderKind kind = VideoToolboxEncoderKind::kNone;
    if (backend_->HardwareEncoderAvailable()) {
      configured = backend_->Configure(
          configuration, VideoToolboxEncoderKind::kHardware, output_sink,
          error_sink, limits_, &hardware_error);
      if (configured) {
        kind = VideoToolboxEncoderKind::kHardware;
      }
    } else {
      hardware_error = {VideoToolboxEncoderErrorCode::kHardwareUnavailable,
                        "VideoToolbox H.264 hardware encoder is unavailable"};
    }

    if (!configured) {
      backend_->Stop();
      if (!policy_.allow_apple_software_fallback ||
          !policy_.apple_software_fallback_qualified) {
        std::lock_guard lock(mutex_);
        last_error_ = hardware_error.IsError()
                          ? std::move(hardware_error)
                          : VideoToolboxEncoderError{
                                VideoToolboxEncoderErrorCode::
                                    kSoftwareFallbackUnqualified,
                                "Apple software fallback is not qualified"};
        return false;
      }
      if (!backend_->AppleSoftwareEncoderAvailable()) {
        std::lock_guard lock(mutex_);
        last_error_ = {
            VideoToolboxEncoderErrorCode::kSoftwareFallbackUnqualified,
            "qualified Apple software H.264 encoder is unavailable"};
        return false;
      }
      VideoToolboxEncoderError software_error;
      configured = backend_->Configure(
          configuration, VideoToolboxEncoderKind::kQualifiedAppleSoftware,
          output_sink, error_sink, limits_, &software_error);
      if (!configured) {
        std::lock_guard lock(mutex_);
        last_error_ =
            software_error.IsError()
                ? std::move(software_error)
                : VideoToolboxEncoderError{
                      VideoToolboxEncoderErrorCode::kEncoderCreationFailed,
                      "qualified Apple software encoder failed to configure"};
        return false;
      }
      kind = VideoToolboxEncoderKind::kQualifiedAppleSoftware;
    }

    {
      std::lock_guard lock(state_->mutex);
      state_->accepting = true;
      state_->force_next_keyframe = true;
      state_->sink = sink;
      state_->last_error = {};
    }
    {
      std::lock_guard lock(mutex_);
      configuration_ = configuration;
      sink_ = std::move(sink);
      active_kind_ = kind;
      last_error_ = {};
    }
    return true;
  }

  bool Encode(common::CapturedFrame frame, bool request_keyframe) {
    auto submission = state_->Begin(frame, request_keyframe);
    if (!submission.has_value()) {
      return false;
    }
    VideoToolboxEncoderError error;
    if (!backend_->Encode(submission->first, frame, submission->second,
                          &error)) {
      if (!error.IsError()) {
        error = {VideoToolboxEncoderErrorCode::kEncodeFailed,
                 "VideoToolbox backend rejected the frame"};
      }
      state_->Reject(submission->first, error);
      std::lock_guard lock(mutex_);
      last_error_ = std::move(error);
      return false;
    }
    std::lock_guard lock(state_->mutex);
    ++state_->statistics.accepted_frames;
    return true;
  }

  bool Reconfigure(const imcodes::rd::QualitySelection& selection) {
    common::H264AccessUnitSink sink;
    common::H264Profile profile = common::H264Profile::kConstrainedBaseline;
    {
      std::lock_guard lock(mutex_);
      if (!configuration_.has_value() || !sink_) {
        last_error_ = {VideoToolboxEncoderErrorCode::kInvalidConfiguration,
                       "quality reconfigure requires an active encoder"};
        return false;
      }
      sink = sink_;
      profile = configuration_->profile;
    }
    if (selection.width <= 0 || selection.height <= 0 || selection.fps <= 0) {
      std::lock_guard lock(mutex_);
      last_error_ = {VideoToolboxEncoderErrorCode::kInvalidConfiguration,
                     "common quality selection is invalid"};
      return false;
    }
    return Configure(
        common::EncoderConfiguration{
            .encoded_pixels = {static_cast<std::uint32_t>(selection.width),
                               static_cast<std::uint32_t>(selection.height)},
            .frame_rate = static_cast<std::uint32_t>(selection.fps),
            .bitrate_bps = selection.bitrate_bps,
            .profile = profile,
        },
        std::move(sink));
  }

  void Stop() noexcept {
    state_->Stop();
    if (backend_) {
      backend_->Stop();
    }
    std::lock_guard lock(mutex_);
    configuration_.reset();
    sink_ = {};
    active_kind_ = VideoToolboxEncoderKind::kNone;
  }

  VideoToolboxEncoderKind ActiveEncoderKind() const noexcept {
    std::lock_guard lock(mutex_);
    return active_kind_;
  }

  std::optional<common::EncoderConfiguration> Configuration() const {
    std::lock_guard lock(mutex_);
    return configuration_;
  }

  VideoToolboxEncoderError LastError() const {
    std::lock_guard lock(state_->mutex);
    if (state_->last_error.IsError()) {
      return state_->last_error;
    }
    std::lock_guard own_lock(mutex_);
    return last_error_;
  }

  VideoToolboxEncoderStatistics Statistics() const {
    std::lock_guard lock(state_->mutex);
    return state_->statistics;
  }

 private:
  std::unique_ptr<VideoToolboxEncoderBackend> backend_;
  VideoToolboxEncoderPolicy policy_;
  VideoToolboxEncoderLimits limits_;
  std::shared_ptr<DeliveryState> state_ = std::make_shared<DeliveryState>();
  mutable std::mutex mutex_;
  std::optional<common::EncoderConfiguration> configuration_;
  common::H264AccessUnitSink sink_;
  VideoToolboxEncoderKind active_kind_ = VideoToolboxEncoderKind::kNone;
  VideoToolboxEncoderError last_error_;
};

VideoToolboxH264Encoder::VideoToolboxH264Encoder(
    VideoToolboxEncoderPolicy policy,
    VideoToolboxEncoderLimits limits)
    : impl_(std::make_unique<Impl>(
          std::make_unique<AppleVideoToolboxEncoderBackend>(),
          policy,
          limits)) {}

VideoToolboxH264Encoder::VideoToolboxH264Encoder(
    std::unique_ptr<VideoToolboxEncoderBackend> backend,
    VideoToolboxEncoderPolicy policy,
    VideoToolboxEncoderLimits limits)
    : impl_(std::make_unique<Impl>(std::move(backend), policy, limits)) {}

VideoToolboxH264Encoder::~VideoToolboxH264Encoder() {
  Stop();
}

common::ReadinessState VideoToolboxH264Encoder::ProbeReadiness() {
  return impl_->ProbeReadiness();
}

bool VideoToolboxH264Encoder::Configure(
    const common::EncoderConfiguration& configuration,
    common::H264AccessUnitSink sink) {
  return impl_->Configure(configuration, std::move(sink));
}

bool VideoToolboxH264Encoder::Encode(common::CapturedFrame frame,
                                     bool request_keyframe) {
  return impl_->Encode(std::move(frame), request_keyframe);
}

void VideoToolboxH264Encoder::Stop() noexcept {
  impl_->Stop();
}

bool VideoToolboxH264Encoder::ReconfigureFromQualitySelection(
    const imcodes::rd::QualitySelection& selection) {
  return impl_->Reconfigure(selection);
}

VideoToolboxEncoderKind VideoToolboxH264Encoder::ActiveEncoderKind()
    const noexcept {
  return impl_->ActiveEncoderKind();
}

std::optional<common::EncoderConfiguration>
VideoToolboxH264Encoder::Configuration() const {
  return impl_->Configuration();
}

VideoToolboxEncoderError VideoToolboxH264Encoder::LastError() const {
  return impl_->LastError();
}

VideoToolboxEncoderStatistics VideoToolboxH264Encoder::Statistics() const {
  return impl_->Statistics();
}

}  // namespace imcodes::remote_desktop::macos
