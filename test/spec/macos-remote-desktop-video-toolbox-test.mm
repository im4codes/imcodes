#include <cstddef>
#include <cstdint>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "video_toolbox_h264_encoder.h"

namespace encoder = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

bool Check(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
  }
  return condition;
}

class Bytes final : public common::FrameStorage {
 public:
  Bytes(std::uint32_t row_bytes, std::uint32_t height)
      : bytes_(static_cast<std::size_t>(row_bytes) * height, std::byte{0xee}) {
    for (std::uint32_t row = 0; row < height; ++row) {
      const std::size_t offset = static_cast<std::size_t>(row) * row_bytes;
      for (std::uint32_t index = 0; index < row_bytes; ++index) {
        bytes_[offset + index] =
            std::byte{static_cast<unsigned char>((row * 32 + index) & 0xff)};
      }
    }
  }

  const std::byte* data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }

 private:
  std::vector<std::byte> bytes_;
};

common::CapturedFrame Frame(std::uint32_t width = 4,
                            std::uint32_t height = 4,
                            std::uint32_t row_bytes = 24,
                            std::int64_t timestamp = 10) {
  return common::CapturedFrame{
      .encoded_pixels = {width, height},
      .pixel_format = common::PixelFormat::kBgra8888,
      .row_bytes = row_bytes,
      .capture_time_us = timestamp,
      .color_primaries = common::ColorPrimaries::kDisplayP3,
      .storage = std::make_shared<Bytes>(row_bytes, height),
  };
}

common::EncoderConfiguration Configuration(std::uint32_t width = 4,
                                           std::uint32_t height = 4) {
  return common::EncoderConfiguration{
      .encoded_pixels = {width, height},
      .frame_rate = 30,
      .bitrate_bps = 3'000'000,
      .profile = common::H264Profile::kConstrainedBaseline,
  };
}

common::H264AccessUnit AccessUnit(std::int64_t timestamp, bool keyframe) {
  return common::H264AccessUnit{
      .bytes = {std::byte{0}, std::byte{0}, std::byte{0}, std::byte{1},
                std::byte{0x65}},
      .presentation_time_us = timestamp,
      .profile = common::H264Profile::kConstrainedBaseline,
      .keyframe = keyframe,
  };
}

class FakeBackend final : public encoder::VideoToolboxEncoderBackend {
 public:
  struct Pending {
    std::uint64_t id;
    std::int64_t timestamp;
    bool keyframe;
    std::uint32_t row_bytes;
  };

  bool hardware_available = true;
  bool software_available = true;
  bool hardware_configure_succeeds = true;
  bool software_configure_succeeds = true;
  bool accept_encode = true;
  bool stopped = false;
  std::vector<encoder::VideoToolboxEncoderKind> configured_kinds;
  std::vector<common::EncoderConfiguration> configurations;
  std::vector<Pending> pending;
  encoder::VideoToolboxBackendOutputSink output_sink;
  encoder::VideoToolboxBackendErrorSink error_sink;

  bool HardwareEncoderAvailable() noexcept override {
    return hardware_available;
  }

  bool AppleSoftwareEncoderAvailable() noexcept override {
    return software_available;
  }

  bool Configure(const common::EncoderConfiguration& configuration,
                 encoder::VideoToolboxEncoderKind kind,
                 encoder::VideoToolboxBackendOutputSink next_output_sink,
                 encoder::VideoToolboxBackendErrorSink next_error_sink,
                 const encoder::VideoToolboxEncoderLimits& limits,
                 encoder::VideoToolboxEncoderError* error) override {
    (void)limits;
    configured_kinds.push_back(kind);
    configurations.push_back(configuration);
    const bool succeeds = kind == encoder::VideoToolboxEncoderKind::kHardware
                              ? hardware_configure_succeeds
                              : software_configure_succeeds;
    if (!succeeds) {
      *error = {encoder::VideoToolboxEncoderErrorCode::kEncoderCreationFailed,
                "fake configure failure"};
      return false;
    }
    stopped = false;
    output_sink = std::move(next_output_sink);
    error_sink = std::move(next_error_sink);
    return true;
  }

  bool Encode(std::uint64_t submission_id,
              const common::CapturedFrame& frame,
              bool request_keyframe,
              encoder::VideoToolboxEncoderError* error) override {
    if (!accept_encode) {
      *error = {encoder::VideoToolboxEncoderErrorCode::kEncodeFailed,
                "fake encode rejection"};
      return false;
    }
    pending.push_back({submission_id, frame.capture_time_us, request_keyframe,
                       frame.row_bytes});
    return true;
  }

  void Stop() noexcept override { stopped = true; }

  void CompleteFirst() {
    Pending item = pending.front();
    pending.erase(pending.begin());
    output_sink(item.id, AccessUnit(item.timestamp, item.keyframe));
  }

  void FailFirst() {
    Pending item = pending.front();
    pending.erase(pending.begin());
    error_sink(item.id, {encoder::VideoToolboxEncoderErrorCode::kEncodeFailed,
                         "fake asynchronous failure"});
  }
};

bool TestPaddedBgraCopyHonorsBothStrides() {
  const common::CapturedFrame frame = Frame(4, 3, 24);
  std::vector<std::byte> destination(32 * 3, std::byte{0xaa});
  std::uint64_t copied = 0;
  encoder::VideoToolboxEncoderError error;
  if (!Check(encoder::video_toolbox_detail::CopyBgraFrameRows(
                 frame, destination.data(), 32, destination.size(), &copied,
                 &error),
             "padded BGRA copy should succeed") ||
      !Check(
          copied == 32U * 3U,
          "copy count must include bytes actually written including padding")) {
    return false;
  }
  const std::byte* source = frame.storage->data();
  for (std::size_t row = 0; row < 3; ++row) {
    for (std::size_t index = 0; index < 16; ++index) {
      if (!Check(destination[row * 32 + index] == source[row * 24 + index],
                 "copy must honor the explicit source stride")) {
        return false;
      }
    }
    for (std::size_t index = 16; index < 32; ++index) {
      if (!Check(destination[row * 32 + index] == std::byte{0},
                 "destination padding must be zeroed")) {
        return false;
      }
    }
  }

  error = {};
  return Check(
      !encoder::video_toolbox_detail::CopyBgraFrameRows(
          frame, destination.data(), 15, destination.size(), nullptr, &error) &&
          error.code == encoder::VideoToolboxEncoderErrorCode::
                            kPixelBufferAllocationFailed,
      "undersized destination stride must fail closed");
}

bool TestBoundedAvccToAnnexBContract() {
  const std::vector<std::vector<std::byte>> parameter_sets = {
      {std::byte{0x67}, std::byte{0x42}},
      {std::byte{0x68}, std::byte{0xce}},
  };
  const std::vector<std::byte> avcc = {
      std::byte{0},    std::byte{0},    std::byte{0},    std::byte{3},
      std::byte{0x65}, std::byte{0x11}, std::byte{0x22}, std::byte{0},
      std::byte{0},    std::byte{0},    std::byte{2},    std::byte{0x06},
      std::byte{0x33},
  };
  std::vector<std::byte> annex_b;
  encoder::VideoToolboxEncoderError error;
  if (!Check(encoder::video_toolbox_detail::ConvertAvccPayloadToAnnexB(
                 parameter_sets, avcc, 4, 64, &annex_b, &error),
             "bounded AVCC payload should convert to Annex-B")) {
    return false;
  }
  const std::vector<std::byte> expected = {
      std::byte{0},    std::byte{0},    std::byte{0},    std::byte{1},
      std::byte{0x67}, std::byte{0x42}, std::byte{0},    std::byte{0},
      std::byte{0},    std::byte{1},    std::byte{0x68}, std::byte{0xce},
      std::byte{0},    std::byte{0},    std::byte{0},    std::byte{1},
      std::byte{0x65}, std::byte{0x11}, std::byte{0x22}, std::byte{0},
      std::byte{0},    std::byte{0},    std::byte{1},    std::byte{0x06},
      std::byte{0x33},
  };
  if (!Check(annex_b == expected, "keyframe parameter sets and VCL NALs must "
                                  "share one Annex-B access unit")) {
    return false;
  }

  const std::vector<std::byte> truncated = {
      std::byte{0}, std::byte{0}, std::byte{0}, std::byte{4}, std::byte{0x65},
  };
  error = {};
  return Check(
      !encoder::video_toolbox_detail::ConvertAvccPayloadToAnnexB(
          {}, truncated, 4, 64, &annex_b, &error) &&
          annex_b.empty() &&
          error.code ==
              encoder::VideoToolboxEncoderErrorCode::kMalformedAccessUnit,
      "truncated AVCC must fail without partial Annex-B output");
}

bool TestHardwarePreferenceKeyframesAndQueueBound() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  encoder::VideoToolboxH264Encoder adapter(std::move(backend), {},
                                           {.max_pending_frames = 2,
                                            .max_dimension = 8'192,
                                            .max_input_bytes = 1024,
                                            .max_copy_bytes_per_frame = 2048,
                                            .max_access_unit_bytes = 1024});
  std::vector<common::H264AccessUnit> output;
  if (!Check(adapter.ProbeReadiness() == common::ReadinessState::kReady,
             "hardware availability should make the adapter ready") ||
      !Check(adapter.Configure(Configuration(),
                               [&](common::H264AccessUnit unit) {
                                 output.push_back(std::move(unit));
                               }),
             "hardware configuration should succeed") ||
      !Check(adapter.ActiveEncoderKind() ==
                     encoder::VideoToolboxEncoderKind::kHardware &&
                 fake->configured_kinds.size() == 1 &&
                 fake->configured_kinds[0] ==
                     encoder::VideoToolboxEncoderKind::kHardware,
             "hardware must be preferred before any software path")) {
    return false;
  }

  if (!Check(adapter.Encode(Frame(4, 4, 24, 11), false),
             "first padded frame should be accepted") ||
      !Check(adapter.Encode(Frame(4, 4, 28, 12), false),
             "second padded frame should be accepted") ||
      !Check(!adapter.Encode(Frame(4, 4, 32, 13), false),
             "third pending frame must be dropped at the queue bound") ||
      !Check(fake->pending.size() == 2 && fake->pending[0].keyframe &&
                 !fake->pending[1].keyframe && fake->pending[0].row_bytes == 24,
             "first configure must force exactly the next keyframe and "
             "preserve stride") ||
      !Check(adapter.Statistics().dropped_backpressure_frames == 1 &&
                 adapter.Statistics().pending_frames == 2,
             "bounded queue statistics must be truthful")) {
    return false;
  }
  fake->CompleteFirst();
  if (!Check(output.size() == 1 && output[0].keyframe &&
                 adapter.Statistics().pending_frames == 1,
             "completed keyframe access unit must reach the common sink")) {
    return false;
  }
  if (!Check(adapter.Encode(Frame(4, 4, 24, 14), true),
             "explicit keyframe request should be accepted") ||
      !Check(fake->pending.back().keyframe,
             "explicit keyframe request must reach the backend")) {
    return false;
  }
  fake->CompleteFirst();
  fake->CompleteFirst();
  return Check(adapter.Statistics().emitted_access_units == 3 &&
                   adapter.Statistics().pending_frames == 0,
               "all accepted submissions must settle exactly once");
}

bool TestSoftwareFallbackRequiresQualification() {
  {
    auto backend = std::make_unique<FakeBackend>();
    FakeBackend* fake = backend.get();
    fake->hardware_available = false;
    encoder::VideoToolboxH264Encoder adapter(
        std::move(backend), {.allow_apple_software_fallback = true,
                             .apple_software_fallback_qualified = false});
    if (!Check(adapter.ProbeReadiness() == common::ReadinessState::kUnavailable,
               "unqualified software fallback must not advertise ready") ||
        !Check(
            !adapter.Configure(Configuration(), [](common::H264AccessUnit) {}),
            "unqualified software fallback must not configure") ||
        !Check(fake->configured_kinds.empty(),
               "unqualified fallback must not even attempt software")) {
      return false;
    }
  }

  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  fake->hardware_available = true;
  fake->hardware_configure_succeeds = false;
  encoder::VideoToolboxH264Encoder adapter(
      std::move(backend), {.allow_apple_software_fallback = true,
                           .apple_software_fallback_qualified = true});
  return Check(
             adapter.Configure(Configuration(), [](common::H264AccessUnit) {}),
             "qualified Apple software fallback should configure") &&
         Check(
             fake->configured_kinds.size() == 2 &&
                 fake->configured_kinds[0] ==
                     encoder::VideoToolboxEncoderKind::kHardware &&
                 fake->configured_kinds[1] == encoder::VideoToolboxEncoderKind::
                                                  kQualifiedAppleSoftware &&
                 adapter.ActiveEncoderKind() ==
                     encoder::VideoToolboxEncoderKind::kQualifiedAppleSoftware,
             "software fallback must occur only after failed hardware "
             "preference");
}

bool TestQualityReconfigureAndAsyncFailure() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  encoder::VideoToolboxH264Encoder adapter(std::move(backend));
  std::uint32_t delivered = 0;
  if (!Check(adapter.Configure(Configuration(1920, 1080),
                               [&](common::H264AccessUnit) { ++delivered; }),
             "initial quality should configure") ||
      !Check(
          adapter.ReconfigureFromQualitySelection({.id = "720p15",
                                                   .width = 1280,
                                                   .height = 720,
                                                   .fps = 15,
                                                   .bitrate_bps = 1'800'000}),
          "common quality selection should reconfigure")) {
    return false;
  }
  const auto configuration = adapter.Configuration();
  if (!Check(configuration.has_value() &&
                 configuration->encoded_pixels.width == 1280 &&
                 configuration->encoded_pixels.height == 720 &&
                 configuration->frame_rate == 15 &&
                 configuration->bitrate_bps == 1'800'000 &&
                 fake->configurations.size() == 2,
             "quality ladder values must reach encoder configuration")) {
    return false;
  }

  if (!Check(adapter.Encode(Frame(1920, 1080, 7680, 21), false),
             "post-reconfigure frame should be accepted") ||
      !Check(fake->pending.back().keyframe,
             "first frame after quality reconfigure must be a keyframe")) {
    return false;
  }
  fake->FailFirst();
  return Check(adapter.Statistics().failed_frames == 1 &&
                   adapter.Statistics().pending_frames == 0 && delivered == 0 &&
                   adapter.LastError().code ==
                       encoder::VideoToolboxEncoderErrorCode::kEncodeFailed,
               "asynchronous backend failure must settle and expose the row");
}

bool TestStopIgnoresLateOutput() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  encoder::VideoToolboxH264Encoder adapter(std::move(backend));
  std::uint32_t delivered = 0;
  if (!Check(adapter.Configure(Configuration(),
                               [&](common::H264AccessUnit) { ++delivered; }),
             "late-output test should configure") ||
      !Check(adapter.Encode(Frame(), false),
             "late-output test should accept one frame")) {
    return false;
  }
  adapter.Stop();
  fake->CompleteFirst();
  return Check(delivered == 0 &&
                   adapter.Statistics().ignored_late_outputs == 1 &&
                   adapter.Statistics().pending_frames == 0 && fake->stopped,
               "terminal stop must fence stale VideoToolbox output");
}

}  // namespace

int main() {
  @autoreleasepool {
    return TestPaddedBgraCopyHonorsBothStrides() &&
                   TestBoundedAvccToAnnexBContract() &&
                   TestHardwarePreferenceKeyframesAndQueueBound() &&
                   TestSoftwareFallbackRequiresQualification() &&
                   TestQualityReconfigureAndAsyncFailure() &&
                   TestStopIgnoresLateOutput()
               ? 0
               : 1;
  }
}
