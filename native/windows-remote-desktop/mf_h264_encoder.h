#ifndef IMCODES_REMOTE_DESKTOP_MF_H264_ENCODER_H_
#define IMCODES_REMOTE_DESKTOP_MF_H264_ENCODER_H_

#include <windows.h>
#include <codecapi.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>

#include <cstdint>
#include <cstddef>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <wrl/client.h>

#include "api/environment/environment.h"
#include "api/video/i420_buffer.h"
#include "api/video_codecs/scalability_mode.h"
#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/video_encoder_factory.h"
#include "third_party/imcodes_remote_desktop/common/protocol_contracts.h"
#include "third_party/imcodes_remote_desktop/quality_ladder.h"

namespace imcodes::rd {

struct MfH264RuntimeDiagnostics {
  bool initialized = false;
  bool hardware = false;
  std::string preset = "1080p30";
  int width = 1920;
  int height = 1080;
  int fps = 30;
  uint32_t bitrate_bps = kInitialVideoBitrateBps;
};

struct MfH264PerformanceDiagnostics {
  uint64_t encode_calls = 0;
  uint64_t conversion_us = 0;
  uint64_t input_wait_us = 0;
  uint64_t process_input_us = 0;
  uint64_t output_pump_us = 0;
};

MfH264RuntimeDiagnostics GetMfH264RuntimeDiagnostics();
// Number of initialized Media Foundation encoders currently owned by the
// worker.  A single encoder may consume the legacy preference/diagnostics
// snapshot; once peers share a worker each transport's SetRates target is the
// only safe quality authority.
std::size_t GetMfH264ActiveEncoderCount();
std::optional<MfH264RuntimeDiagnostics>
GetMfH264RuntimeDiagnosticsForSession(std::string_view session_id);
struct MfH264QualityDecision {
  bool accepted = false;
  bool has_encoder_bitrate = false;
  uint32_t encoder_bitrate_bps = 0;
};
// Pure quality decision seam used by PeerSession and native regression tests.
// A missing session-bound encoder is a normal lazy-libwebrtc window and must
// never borrow another peer's diagnostics.
MfH264QualityDecision EvaluateMfH264QualityDecision(
    const std::optional<MfH264RuntimeDiagnostics>& own,
    const imcodes::remote_desktop::common::QualitySelection& selection,
    std::size_t active_encoder_count,
    bool closed) noexcept;
void SetMfH264QualityPreferenceForSession(
    std::string_view session_id,
    const QualityPreference& preference) noexcept;
void DisqualifyHardwareEncoderForProcess();
// Legacy encoder preference (relay cap already folded in), published by a
// session's quality ladder. It is consumed for single-viewer compatibility;
// with multiple active encoders each transport's SetRates target is the
// authoritative per-viewer quality input.
void SetMfH264QualityPreference(const QualityPreference& preference) noexcept;

// Media Foundation H.264 encoder integrated behind libwebrtc's encoder API.
// libwebrtc remains authoritative for RTP/RTCP, PLI, NACK, pacing,
// retransmission and congestion feedback; SetRates is the only network-driven
// input translated to the platform encoder.
class MfH264Encoder final : public webrtc::VideoEncoder {
 public:
  explicit MfH264Encoder(bool prefer_hardware = true,
                         std::string session_id = {});
  ~MfH264Encoder() override;

  int InitEncode(const webrtc::VideoCodec* codec_settings,
                 const Settings& settings) override;
  int32_t RegisterEncodeCompleteCallback(
      webrtc::EncodedImageCallback* callback) override;
  int32_t Release() override;
  int32_t Encode(
      const webrtc::VideoFrame& frame,
      const std::vector<webrtc::VideoFrameType>* frame_types) override;
  MfH264PerformanceDiagnostics GetPerformanceDiagnostics() const;
  void SetRates(const RateControlParameters& parameters) override;
  EncoderInfo GetEncoderInfo() const override;
  // Re-select under a changed preference without waiting for SetRates.
  void ApplyQualityPreference(const QualityPreference& preference);
  const std::string& session_id() const { return session_id_; }
  // Per-instance diagnostics used by the peer's quality adapter and native
  // multi-peer tests. The legacy free getter is only a single-viewer
  // compatibility snapshot.
  MfH264RuntimeDiagnostics GetRuntimeDiagnostics() const;

 private:
  struct PendingFrame {
    uint32_t rtp_timestamp;
    int64_t capture_time_ms;
    int64_t sample_time_100ns;
    bool requested_keyframe;
  };

  bool ActivateTransform(bool hardware);
  bool ConfigureVideoProcessor();
  bool ConvertFrame(const webrtc::I420BufferInterface& frame,
                    int64_t sample_time_100ns,
                    int64_t sample_duration_100ns,
                    IMFSample** output);
  bool ConvertFrameWithLibyuv(const webrtc::I420BufferInterface& frame,
                              int64_t sample_time_100ns,
                              int64_t sample_duration_100ns,
                              IMFSample** output);
  bool ConfigureTransform();
  bool TryAcceptCompatibleOutputType();
  bool Reconfigure();
  bool FallbackToSoftware(const char* reason);
  bool SetCodecValue(const GUID& key, VARIANT value);
  bool PumpAsyncEvents(size_t attempts, bool wait_for_input);
  bool WaitForAsyncInput(size_t attempts);
  int DrainAsyncTransform(size_t attempts);
  int DrainOutput();
  int DeliverSample(IMFSample* sample);
  void RequestKeyFrame();
  void PublishDiagnostics() const;

  int InitEncodeLocked(const webrtc::VideoCodec* codec_settings,
                       const Settings& settings);
  mutable std::mutex mutex_;
  Microsoft::WRL::ComPtr<IMFTransform> transform_;
  Microsoft::WRL::ComPtr<IMFTransform> video_processor_;
  Microsoft::WRL::ComPtr<ICodecAPI> codec_api_;
  Microsoft::WRL::ComPtr<IMFMediaEventGenerator> event_generator_;
  webrtc::scoped_refptr<webrtc::I420Buffer> scaled_i420_;
  webrtc::EncodedImageCallback* callback_ = nullptr;
  std::deque<PendingFrame> pending_;
  int width_ = 0;
  int height_ = 0;
  int source_width_ = 0;
  int source_height_ = 0;
  int fps_ = 30;
  uint32_t bitrate_bps_ = kInitialVideoBitrateBps;
  uint32_t reserved_bitrate_bps_ = 0;
  bool initialized_ = false;
  const bool prefer_hardware_;
  // Once a hardware transform fails its output/throughput gate, rate-driven
  // reconfiguration must not silently reactivate the same unstable MFT. A
  // runtime failure also burns the process-level fuse so replacement encoder
  // objects cannot thrash the same driver during this worker lifetime.
  bool hardware_disqualified_ = false;
  bool hardware_ = false;
  bool async_ = false;
  size_t async_input_requests_ = 0;
  size_t async_output_events_ = 0;
  size_t hardware_stall_polls_ = 0;
  size_t hardware_encode_attempts_without_output_ = 0;
  size_t hardware_inputs_without_output_ = 0;
  size_t hardware_output_stream_changes_ = 0;
  size_t consecutive_slow_hardware_frames_ = 0;
  int64_t first_hardware_input_at_ms_ = 0;
  bool async_drain_complete_ = false;
  bool force_keyframe_ = true;
  bool reconfigure_pending_ = false;
  int64_t last_encoded_timestamp_us_ = 0;
  MfH264PerformanceDiagnostics performance_;
  mutable MfH264RuntimeDiagnostics diagnostics_;
  std::string session_id_;
  QualityPreference preference_{};
  QualitySelection quality_{"1080p30", 1920, 1080, 30,
                            kInitialVideoBitrateBps};
};

class MfH264EncoderFactory final : public webrtc::VideoEncoderFactory {
 public:
  explicit MfH264EncoderFactory(std::string session_id = {});
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override;
  CodecSupport QueryCodecSupport(
      const webrtc::SdpVideoFormat& format,
      std::optional<std::string> scalability_mode,
      std::optional<webrtc::Resolution> resolution) const override;
  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment& env,
      const webrtc::SdpVideoFormat& format) override;

 private:
  const std::string session_id_;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_MF_H264_ENCODER_H_
