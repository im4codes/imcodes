#ifndef IMCODES_MACOS_REMOTE_DESKTOP_VIDEO_TOOLBOX_H264_ENCODER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_VIDEO_TOOLBOX_H264_ENCODER_H_

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "../remote-desktop-common/platform_interfaces.h"
#include "../remote-desktop-common/quality_ladder.h"

namespace imcodes::remote_desktop::macos {

enum class VideoToolboxEncoderKind : std::uint8_t {
  kNone,
  kHardware,
  kQualifiedAppleSoftware,
};

enum class VideoToolboxEncoderErrorCode : std::uint8_t {
  kNone,
  kInvalidConfiguration,
  kHardwareUnavailable,
  kSoftwareFallbackUnqualified,
  kEncoderCreationFailed,
  kEncoderPropertyRejected,
  kUnsupportedFrame,
  kCopyLimitExceeded,
  kPixelBufferAllocationFailed,
  kPixelTransferFailed,
  kEncodeFailed,
  kMalformedAccessUnit,
  kAccessUnitTooLarge,
  kStopped,
};

struct VideoToolboxEncoderError {
  VideoToolboxEncoderErrorCode code = VideoToolboxEncoderErrorCode::kNone;
  std::string detail;

  [[nodiscard]] bool IsError() const noexcept {
    return code != VideoToolboxEncoderErrorCode::kNone;
  }
};

// Software fallback is deliberately two-keyed. Product/release qualification
// must opt in, and the Apple backend must prove that a software-only
// VideoToolbox H.264 session can actually be created. A failed hardware probe
// alone never silently enables software encoding.
struct VideoToolboxEncoderPolicy {
  bool allow_apple_software_fallback = false;
  bool apple_software_fallback_qualified = false;
};

struct VideoToolboxEncoderLimits {
  std::uint32_t max_pending_frames = 2;
  std::uint32_t max_dimension = 8'192;
  std::size_t max_input_bytes = 128U * 1024U * 1024U;
  std::size_t max_copy_bytes_per_frame = 192U * 1024U * 1024U;
  std::size_t max_access_unit_bytes = 32U * 1024U * 1024U;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct VideoToolboxEncoderStatistics {
  std::uint64_t accepted_frames = 0;
  std::uint64_t emitted_access_units = 0;
  std::uint64_t dropped_backpressure_frames = 0;
  std::uint64_t rejected_invalid_frames = 0;
  std::uint64_t failed_frames = 0;
  std::uint64_t ignored_late_outputs = 0;
  std::uint64_t emitted_access_unit_bytes = 0;
  std::uint32_t pending_frames = 0;
};

using VideoToolboxBackendOutputSink =
    std::function<void(std::uint64_t, common::H264AccessUnit)>;
using VideoToolboxBackendErrorSink =
    std::function<void(std::uint64_t, VideoToolboxEncoderError)>;

// Backend seam intentionally contains no Apple SDK types. Encode receives the
// common BGRA8888 frame contract, including an explicit row stride. Backends
// must issue exactly one output or error callback for every accepted
// submission, including frames flushed by Stop().
class VideoToolboxEncoderBackend {
 public:
  virtual ~VideoToolboxEncoderBackend() = default;

  [[nodiscard]] virtual bool HardwareEncoderAvailable() noexcept = 0;
  [[nodiscard]] virtual bool AppleSoftwareEncoderAvailable() noexcept = 0;
  virtual bool Configure(const common::EncoderConfiguration& configuration,
                         VideoToolboxEncoderKind kind,
                         VideoToolboxBackendOutputSink output_sink,
                         VideoToolboxBackendErrorSink error_sink,
                         const VideoToolboxEncoderLimits& limits,
                         VideoToolboxEncoderError* error) = 0;
  virtual bool Encode(std::uint64_t submission_id,
                      const common::CapturedFrame& frame,
                      bool request_keyframe,
                      VideoToolboxEncoderError* error) = 0;
  virtual void Stop() noexcept = 0;
};

namespace video_toolbox_detail {

// Testable production copy primitive used before VideoToolbox submission. It
// copies visible BGRA bytes row by row, honors both explicit strides, zeroes
// destination padding, and never reads capture padding as image data. The
// returned byte count includes destination padding because those bytes are
// actually written and therefore belong to the per-frame copy budget.
bool CopyBgraFrameRows(const common::CapturedFrame& frame,
                       std::byte* destination,
                       std::size_t destination_row_bytes,
                       std::size_t destination_size,
                       std::uint64_t* copied_bytes,
                       VideoToolboxEncoderError* error);

// Pure, executable AVCC parser used by the Apple callback after it extracts
// format-description parameter sets and a bounded block-buffer payload.
bool ConvertAvccPayloadToAnnexB(
    const std::vector<std::vector<std::byte>>& parameter_sets,
    std::span<const std::byte> avcc,
    std::size_t nal_length_bytes,
    std::size_t max_output_bytes,
    std::vector<std::byte>* annex_b,
    VideoToolboxEncoderError* error);

}  // namespace video_toolbox_detail

// The output contract is one complete Annex-B access unit per callback. A
// keyframe access unit includes its current SPS/PPS before VCL NAL units, so it
// can be handed to the pinned libwebrtc bridge without inventing RTP, RTCP,
// pacing or congestion-control behavior in this adapter.
class VideoToolboxH264Encoder final : public common::EncoderAdapter {
 public:
  explicit VideoToolboxH264Encoder(VideoToolboxEncoderPolicy policy = {},
                                   VideoToolboxEncoderLimits limits = {});
  VideoToolboxH264Encoder(std::unique_ptr<VideoToolboxEncoderBackend> backend,
                          VideoToolboxEncoderPolicy policy = {},
                          VideoToolboxEncoderLimits limits = {});
  ~VideoToolboxH264Encoder() override;

  VideoToolboxH264Encoder(const VideoToolboxH264Encoder&) = delete;
  VideoToolboxH264Encoder& operator=(const VideoToolboxH264Encoder&) = delete;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Configure(const common::EncoderConfiguration& configuration,
                 common::H264AccessUnitSink sink) override;
  bool Encode(common::CapturedFrame frame, bool request_keyframe) override;
  void Stop() noexcept override;

  // Applies the existing common quality ladder. Reconfiguration recreates the
  // VideoToolbox session when needed and forces the first accepted frame to be
  // a keyframe; it never estimates bandwidth itself.
  bool ReconfigureFromQualitySelection(
      const imcodes::rd::QualitySelection& selection);

  [[nodiscard]] VideoToolboxEncoderKind ActiveEncoderKind() const noexcept;
  [[nodiscard]] std::optional<common::EncoderConfiguration> Configuration()
      const;
  [[nodiscard]] VideoToolboxEncoderError LastError() const;
  [[nodiscard]] VideoToolboxEncoderStatistics Statistics() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_VIDEO_TOOLBOX_H264_ENCODER_H_
