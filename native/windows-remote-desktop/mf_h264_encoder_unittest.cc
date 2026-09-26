#include "third_party/imcodes_remote_desktop/mf_h264_encoder.h"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <thread>
#include <vector>

#include <mfapi.h>

#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "api/units/data_rate.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "test/gtest.h"

namespace imcodes::rd {
namespace {

uint64_t FileTimeTicks(const FILETIME& value) {
  ULARGE_INTEGER ticks{};
  ticks.LowPart = value.dwLowDateTime;
  ticks.HighPart = value.dwHighDateTime;
  return ticks.QuadPart;
}

double CurrentProcessCpuSeconds() {
  FILETIME created{};
  FILETIME exited{};
  FILETIME kernel{};
  FILETIME user{};
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel,
                       &user)) {
    return 0.0;
  }
  return static_cast<double>(FileTimeTicks(kernel) + FileTimeTicks(user)) /
         10'000'000.0;
}

bool EncoderBenchmarksEnabled() {
  wchar_t value[8] = {};
  const DWORD length = GetEnvironmentVariableW(
      L"IMCODES_RUN_ENCODER_BENCHMARKS", value, std::size(value));
  return length > 0 && length < std::size(value) && value[0] == L'1';
}

bool EncoderBenchmarkPrefersHardware() {
  wchar_t value[16] = {};
  const DWORD length = GetEnvironmentVariableW(
      L"IMCODES_ENCODER_BENCHMARK_MODE", value, std::size(value));
  return length == 0 || length >= std::size(value) ||
         _wcsicmp(value, L"software") != 0;
}

int64_t SteadyNowMicros() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

class RecordingCallback final : public webrtc::EncodedImageCallback {
 public:
  Result OnEncodedImage(
      const webrtc::EncodedImage& image,
      const webrtc::CodecSpecificInfo*) override {
    const int previous = frames.fetch_add(1);
    const int64_t delivered_at_us = SteadyNowMicros();
    if (previous == 0) first_delivery_us.store(delivered_at_us);
    last_delivery_us.store(delivered_at_us);
    bytes += image.size();
    keyframe = keyframe || image.IsKey();
    return Result(Result::OK);
  }

  void OnFrameDropped(uint32_t, int, bool) override { dropped++; }

  std::atomic<int> frames{0};
  std::atomic<int64_t> first_delivery_us{0};
  std::atomic<int64_t> last_delivery_us{0};
  std::atomic<size_t> bytes{0};
  std::atomic<bool> keyframe{false};
  std::atomic<int> dropped{0};
};

class MfH264EncoderTest : public testing::Test {
 protected:
  static void SetUpTestSuite() {
    ASSERT_TRUE(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)));
    ASSERT_TRUE(SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_FULL)));
  }

  static void TearDownTestSuite() {
    MFShutdown();
    CoUninitialize();
  }

  static void RunSyntheticEncode(bool prefer_hardware) {
    MfH264Encoder encoder(prefer_hardware);
    RecordingCallback callback;
    webrtc::VideoCodec codec;
    codec.codecType = webrtc::kVideoCodecH264;
    codec.width = 1280;
    codec.height = 720;
    codec.startBitrate = 350;
    codec.minBitrate = 350;
    codec.maxBitrate = 8000;
    codec.maxFramerate = 30;
    codec.numberOfSimulcastStreams = 1;
    codec.mode = webrtc::VideoCodecMode::kScreensharing;
    codec.active = true;
    ASSERT_EQ(encoder.RegisterEncodeCompleteCallback(&callback),
              WEBRTC_VIDEO_CODEC_OK);
    ASSERT_EQ(encoder.InitEncode(
                  &codec,
                  webrtc::VideoEncoder::Settings(
                      webrtc::VideoEncoder::Capabilities(false), 2, 1200)),
              WEBRTC_VIDEO_CODEC_OK);
    const MfH264RuntimeDiagnostics diagnostics =
        GetMfH264RuntimeDiagnostics();
    EXPECT_TRUE(diagnostics.initialized);
    std::cout << "ENCODER_CLASS="
              << (diagnostics.hardware ? "hardware" : "software")
              << ";PREFER_HARDWARE=" << (prefer_hardware ? "true" : "false")
              << std::endl;
    if (!prefer_hardware) EXPECT_FALSE(diagnostics.hardware);
    EXPECT_EQ(diagnostics.width, 640);
    EXPECT_EQ(diagnostics.height, 360);

    auto buffer = webrtc::I420Buffer::Create(1280, 720);
    std::memset(buffer->MutableDataY(), 16,
                static_cast<size_t>(buffer->StrideY()) * buffer->height());
    std::memset(buffer->MutableDataU(), 128,
                static_cast<size_t>(buffer->StrideU()) *
                    ((buffer->height() + 1) / 2));
    std::memset(buffer->MutableDataV(), 128,
                static_cast<size_t>(buffer->StrideV()) *
                    ((buffer->height() + 1) / 2));
    for (int index = 0; index < 30 && callback.frames.load() == 0; ++index) {
      webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
          .set_video_frame_buffer(buffer)
          .set_timestamp_us(static_cast<int64_t>(index + 1) * 200'000)
          .set_rtp_timestamp(static_cast<uint32_t>(index + 1) * 18'000)
          .set_ntp_time_ms((index + 1) * 200)
          .build();
      const std::vector<webrtc::VideoFrameType> frame_types = {
          index == 0 ? webrtc::VideoFrameType::kVideoFrameKey
                     : webrtc::VideoFrameType::kVideoFrameDelta};
      ASSERT_EQ(encoder.Encode(frame, &frame_types), WEBRTC_VIDEO_CODEC_OK);
      Sleep(5);
    }
    EXPECT_EQ(encoder.Release(), WEBRTC_VIDEO_CODEC_OK);
    const MfH264RuntimeDiagnostics final_diagnostics =
        GetMfH264RuntimeDiagnostics();
    std::cout << "ENCODER_FINAL_CLASS="
              << (final_diagnostics.hardware ? "hardware" : "software")
              << ";PREFER_HARDWARE="
              << (prefer_hardware ? "true" : "false") << std::endl;
    EXPECT_GT(callback.frames.load(), 0);
    EXPECT_GT(callback.bytes.load(), 0u);
    EXPECT_TRUE(callback.keyframe.load());
  }

  static void RunPacedBenchmark(const char* scenario,
                                int source_width,
                                int source_height,
                                int target_bitrate_kbps,
                                bool active_content,
                                int frame_count,
                                double minimum_output_fps = 27.0) {
    const bool prefer_hardware = EncoderBenchmarkPrefersHardware();
    MfH264Encoder encoder(prefer_hardware);
    RecordingCallback callback;
    webrtc::VideoCodec codec;
    codec.codecType = webrtc::kVideoCodecH264;
    codec.width = source_width;
    codec.height = source_height;
    codec.startBitrate = target_bitrate_kbps;
    codec.minBitrate = 350;
    codec.maxBitrate = 8000;
    codec.maxFramerate = 30;
    codec.numberOfSimulcastStreams = 1;
    codec.mode = webrtc::VideoCodecMode::kScreensharing;
    codec.active = true;
    ASSERT_EQ(encoder.RegisterEncodeCompleteCallback(&callback),
              WEBRTC_VIDEO_CODEC_OK);
    ASSERT_EQ(encoder.InitEncode(
                  &codec,
                  webrtc::VideoEncoder::Settings(
                      webrtc::VideoEncoder::Capabilities(false), 2, 1200)),
              WEBRTC_VIDEO_CODEC_OK);
    const MfH264RuntimeDiagnostics initial = GetMfH264RuntimeDiagnostics();
    ASSERT_TRUE(initial.initialized);
    const int64_t frame_interval_us =
        1'000'000 / std::max(1, initial.fps);
    const uint32_t rtp_interval =
        static_cast<uint32_t>(90'000 / std::max(1, initial.fps));

    auto buffer = webrtc::I420Buffer::Create(source_width, source_height);
    std::memset(buffer->MutableDataY(), 16,
                static_cast<size_t>(buffer->StrideY()) * buffer->height());
    std::memset(buffer->MutableDataU(), 128,
                static_cast<size_t>(buffer->StrideU()) *
                    ((buffer->height() + 1) / 2));
    std::memset(buffer->MutableDataV(), 128,
                static_cast<size_t>(buffer->StrideV()) *
                    ((buffer->height() + 1) / 2));

    const double cpu_start = CurrentProcessCpuSeconds();
    const auto wall_start = std::chrono::steady_clock::now();
    double encode_call_ms_total = 0.0;
    double encode_call_ms_max = 0.0;
    for (int index = 0; index < frame_count; ++index) {
      const auto deadline = wall_start +
          std::chrono::microseconds(static_cast<int64_t>(index) *
                                    frame_interval_us);
      std::this_thread::sleep_until(deadline);
      if (active_content) {
        // Synthetic changing pixels only. This neither captures nor reads the
        // user's desktop while still forcing the encoder off its static path.
        std::memset(buffer->MutableDataY(), 16 + (index % 200),
                    static_cast<size_t>(buffer->StrideY()) *
                        buffer->height());
      }
      webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
          .set_video_frame_buffer(buffer)
          .set_timestamp_us(static_cast<int64_t>(index + 1) *
                            frame_interval_us)
          .set_rtp_timestamp(static_cast<uint32_t>(index + 1) * rtp_interval)
          .set_ntp_time_ms(static_cast<int64_t>(index + 1) * 1000 /
                           std::max(1, initial.fps))
          .build();
      const std::vector<webrtc::VideoFrameType> frame_types = {
          index == 0 ? webrtc::VideoFrameType::kVideoFrameKey
                     : webrtc::VideoFrameType::kVideoFrameDelta};
      const auto encode_start = std::chrono::steady_clock::now();
      const int encode_result = encoder.Encode(frame, &frame_types);
      const double encode_call_ms =
          std::chrono::duration<double, std::milli>(
              std::chrono::steady_clock::now() - encode_start)
              .count();
      encode_call_ms_total += encode_call_ms;
      encode_call_ms_max = std::max(encode_call_ms_max, encode_call_ms);
      ASSERT_EQ(encode_result, WEBRTC_VIDEO_CODEC_OK);
    }
    const auto submit_end = std::chrono::steady_clock::now();
    const int encoded_before_release = callback.frames.load();
    const MfH264PerformanceDiagnostics performance =
        encoder.GetPerformanceDiagnostics();
    const auto release_start = std::chrono::steady_clock::now();
    ASSERT_EQ(encoder.Release(), WEBRTC_VIDEO_CODEC_OK);
    const auto release_end = std::chrono::steady_clock::now();
    const double cpu_end = CurrentProcessCpuSeconds();
    const double submit_seconds =
        std::chrono::duration<double>(submit_end - wall_start).count();
    const double total_seconds =
        std::chrono::duration<double>(release_end - wall_start).count();
    const double release_ms =
        std::chrono::duration<double, std::milli>(release_end - release_start)
            .count();
    SYSTEM_INFO system_info{};
    GetSystemInfo(&system_info);
    const double cpu_percent = system_info.dwNumberOfProcessors == 0
        ? 0.0
        : 100.0 * (cpu_end - cpu_start) / total_seconds /
              system_info.dwNumberOfProcessors;
    const int encoded = callback.frames.load();
    const int64_t first_delivery_us = callback.first_delivery_us.load();
    const int64_t last_delivery_us = callback.last_delivery_us.load();
    const double delivery_span_seconds =
        encoded > 1 && last_delivery_us > first_delivery_us
            ? (last_delivery_us - first_delivery_us) / 1'000'000.0
            : 0.0;
    const double output_fps = delivery_span_seconds > 0.0
        ? (encoded - 1) / delivery_span_seconds
        : 0.0;
    const double submit_fps = frame_count / submit_seconds;
    const double output_bitrate_bps =
        callback.bytes.load() * 8.0 / std::max(delivery_span_seconds, 0.001);
    const double dropped_percent =
        100.0 * (frame_count - encoded) / frame_count;
    const MfH264RuntimeDiagnostics final = GetMfH264RuntimeDiagnostics();
    std::cout << std::fixed << std::setprecision(2)
              << "ENCODER_BENCHMARK;scenario=" << scenario
              << ";initial_encoder="
              << (initial.hardware ? "hardware" : "software")
              << ";encoder=" << (final.hardware ? "hardware" : "software")
              << ";resolution=" << initial.width << 'x' << initial.height
              << ";target_fps=" << initial.fps
              << ";submitted=" << frame_count
              << ";encoded=" << encoded
              << ";encoded_before_release=" << encoded_before_release
              << ";submit_s=" << submit_seconds
              << ";submit_fps=" << submit_fps
              << ";encode_call_ms_avg="
              << encode_call_ms_total / frame_count
              << ";encode_call_ms_max=" << encode_call_ms_max
              << ";conversion_ms_avg="
              << performance.conversion_us / 1000.0 /
                     std::max<uint64_t>(performance.encode_calls, 1)
              << ";input_wait_ms_avg="
              << performance.input_wait_us / 1000.0 /
                     std::max<uint64_t>(performance.encode_calls, 1)
              << ";process_input_ms_avg="
              << performance.process_input_us / 1000.0 /
                     std::max<uint64_t>(performance.encode_calls, 1)
              << ";output_pump_ms_avg="
              << performance.output_pump_us / 1000.0 /
                     std::max<uint64_t>(performance.encode_calls, 1)
              << ";delivery_span_s=" << delivery_span_seconds
              << ";output_fps=" << output_fps
              << ";release_ms=" << release_ms
              << ";bitrate_bps=" << output_bitrate_bps
              << ";dropped_percent=" << dropped_percent
              << ";process_cpu_percent=" << cpu_percent << std::endl;

    EXPECT_GE(encoded, frame_count * 97 / 100);
    EXPECT_GE(output_fps, minimum_output_fps);
    EXPECT_LE(dropped_percent, 3.0);
    EXPECT_TRUE(callback.keyframe.load());
  }
};

TEST_F(MfH264EncoderTest, ConvertsScalesAndEncodesSyntheticFrame) {
  RunSyntheticEncode(true);
}

TEST_F(MfH264EncoderTest, UsesApprovedSoftwareMftFallback) {
  RunSyntheticEncode(false);
}

TEST_F(MfH264EncoderTest,
       IndependentEncodersKeepPreferencesAndRegistryOwnership) {
  SetMfH264QualityPreference(QualityPreference{});
  auto first = std::make_unique<MfH264Encoder>(false, "viewer-a");
  auto second = std::make_unique<MfH264Encoder>(false, "viewer-b");
  RecordingCallback first_callback;
  RecordingCallback second_callback;
  webrtc::VideoCodec first_codec;
  first_codec.codecType = webrtc::kVideoCodecH264;
  first_codec.width = 1920;
  first_codec.height = 1080;
  first_codec.startBitrate = 6000;
  first_codec.minBitrate = 350;
  first_codec.maxBitrate = 8000;
  first_codec.maxFramerate = 30;
  first_codec.numberOfSimulcastStreams = 1;
  first_codec.mode = webrtc::VideoCodecMode::kScreensharing;
  first_codec.active = true;
  const webrtc::VideoEncoder::Settings settings(
      webrtc::VideoEncoder::Capabilities(false), 2, 1200);
  ASSERT_EQ(first->RegisterEncodeCompleteCallback(&first_callback),
            WEBRTC_VIDEO_CODEC_OK);
  ASSERT_EQ(second->RegisterEncodeCompleteCallback(&second_callback),
            WEBRTC_VIDEO_CODEC_OK);
  ASSERT_EQ(first->InitEncode(&first_codec, settings), WEBRTC_VIDEO_CODEC_OK);
  ASSERT_EQ(second->InitEncode(&first_codec, settings), WEBRTC_VIDEO_CODEC_OK);
  ASSERT_EQ(GetMfH264ActiveEncoderCount(), 2u);
  QualityPreference first_preference;
  first_preference.max_height = 1080;
  first_preference.max_fps = 30;
  first_preference.max_bitrate_bps = 7'000'000;
  QualityPreference second_preference;
  second_preference.max_height = 1080;
  second_preference.max_fps = 30;
  second_preference.max_bitrate_bps = 6'500'000;
  SetMfH264QualityPreferenceForSession("viewer-a", first_preference);
  SetMfH264QualityPreferenceForSession("viewer-b", second_preference);
  webrtc::VideoEncoder::RateControlParameters first_rates;
  ASSERT_TRUE(first_rates.bitrate.SetBitrate(0, 0, 8'000'000));
  first->SetRates(first_rates);
  webrtc::VideoEncoder::RateControlParameters second_rates;
  ASSERT_TRUE(second_rates.bitrate.SetBitrate(0, 0, 8'000'000));
  second->SetRates(second_rates);
  ASSERT_TRUE(GetMfH264RuntimeDiagnosticsForSession("viewer-a"));
  ASSERT_TRUE(GetMfH264RuntimeDiagnosticsForSession("viewer-b"));
  const MfH264RuntimeDiagnostics first_quality = first->GetRuntimeDiagnostics();
  const MfH264RuntimeDiagnostics second_quality = second->GetRuntimeDiagnostics();
  // Same 1080p30 rung, different BWE targets: matching by preset/size/fps
  // would return the wrong encoder for one peer. The per-session binding must
  // preserve each viewer's own cap and actual bitrate.
  EXPECT_EQ(first_quality.height, 1080);
  EXPECT_EQ(second_quality.height, 1080);
  EXPECT_EQ(first_quality.fps, 30);
  EXPECT_EQ(second_quality.fps, 30);
  EXPECT_LE(first_quality.bitrate_bps, 7'000'000u);
  EXPECT_LE(second_quality.bitrate_bps, 6'500'000u);
  EXPECT_NE(first_quality.bitrate_bps, second_quality.bitrate_bps);

  ASSERT_EQ(first->Release(), WEBRTC_VIDEO_CODEC_OK);
  ASSERT_EQ(GetMfH264ActiveEncoderCount(), 1u);
  const MfH264RuntimeDiagnostics surviving = second->GetRuntimeDiagnostics();
  EXPECT_EQ(surviving.height, second_quality.height);
  EXPECT_EQ(surviving.bitrate_bps, second_quality.bitrate_bps);
  EXPECT_EQ(second->Release(), WEBRTC_VIDEO_CODEC_OK);
  EXPECT_EQ(GetMfH264ActiveEncoderCount(), 0u);
}

TEST_F(MfH264EncoderTest, SingleViewerPreferenceAndFeedbackRemainBound) {
  MfH264Encoder encoder(false, "single-viewer");
  RecordingCallback callback;
  webrtc::VideoCodec codec;
  codec.codecType = webrtc::kVideoCodecH264;
  codec.width = 1920;
  codec.height = 1080;
  codec.startBitrate = 6000;
  codec.minBitrate = 350;
  codec.maxBitrate = 8000;
  codec.maxFramerate = 30;
  codec.numberOfSimulcastStreams = 1;
  codec.mode = webrtc::VideoCodecMode::kScreensharing;
  codec.active = true;
  ASSERT_EQ(encoder.RegisterEncodeCompleteCallback(&callback),
            WEBRTC_VIDEO_CODEC_OK);
  ASSERT_EQ(encoder.InitEncode(
                &codec,
                webrtc::VideoEncoder::Settings(
                    webrtc::VideoEncoder::Capabilities(false), 2, 1200)),
            WEBRTC_VIDEO_CODEC_OK);
  ASSERT_EQ(GetMfH264ActiveEncoderCount(), 1u);
  QualityPreference preference;
  preference.max_height = 360;
  preference.max_fps = 15;
  preference.max_bitrate_bps = 700'000;
  SetMfH264QualityPreferenceForSession("single-viewer", preference);
  const MfH264RuntimeDiagnostics diagnostics =
      encoder.GetRuntimeDiagnostics();
  EXPECT_EQ(diagnostics.height, 360);
  EXPECT_LE(diagnostics.fps, 15);
  EXPECT_LE(diagnostics.bitrate_bps, 700'000u);
  EXPECT_EQ(encoder.Release(), WEBRTC_VIDEO_CODEC_OK);
  EXPECT_EQ(GetMfH264ActiveEncoderCount(), 0u);
}

TEST_F(MfH264EncoderTest,
       LazyPeerDoesNotBorrowTheOnlyOtherEncodersQualityDecision) {
  MfH264RuntimeDiagnostics other;
  other.initialized = true;
  other.preset = "1080p30";
  other.width = 1920;
  other.height = 1080;
  other.fps = 30;
  other.bitrate_bps = 7'000'000;
  const imcodes::remote_desktop::common::QualitySelection
      joining_peer_selection{
      "720p30", {1280, 720}, 30, 2'000'000, 2'000'000};

  const MfH264QualityDecision decision = EvaluateMfH264QualityDecision(
      std::nullopt, joining_peer_selection, 1, false);
  EXPECT_TRUE(decision.accepted);
  EXPECT_FALSE(decision.has_encoder_bitrate);
}

TEST_F(MfH264EncoderTest, SinglePeerStillRejectsAnActualQualityMismatch) {
  MfH264RuntimeDiagnostics own;
  own.initialized = true;
  own.preset = "1080p30";
  own.width = 1920;
  own.height = 1080;
  own.fps = 30;
  own.bitrate_bps = 6'000'000;
  const imcodes::remote_desktop::common::QualitySelection mismatched{
      "1080p30", {1920, 1080}, 30, 4'000'000, 6'000'000};

  const MfH264QualityDecision decision = EvaluateMfH264QualityDecision(
      own, mismatched, 1, false);
  EXPECT_FALSE(decision.accepted);
  EXPECT_TRUE(decision.has_encoder_bitrate);
  EXPECT_EQ(decision.encoder_bitrate_bps, 6'000'000u);
}

TEST_F(MfH264EncoderTest, SustainsPacedProductionLadder) {
  if (!EncoderBenchmarksEnabled()) {
    GTEST_SKIP() << "set IMCODES_RUN_ENCODER_BENCHMARKS=1 on a lab node";
  }
  RunPacedBenchmark("active_720p30", 1920, 1080, 3000, true, 180);
  RunPacedBenchmark("active_1080p30", 1920, 1080, 6000, true, 180);
  RunPacedBenchmark("static_1080p30", 1920, 1080, 6000, false, 180);
  RunPacedBenchmark("active_2160p_to_1080p30", 3840, 2160, 6000, true,
                    180);
  RunPacedBenchmark("active_2160p15_probe", 3840, 2160, 8000, true, 90,
                    13.5);
  RunPacedBenchmark("static_2160p15_probe", 3840, 2160, 8000, false, 90,
                    13.5);
}

}  // namespace
}  // namespace imcodes::rd
