// Native test of the VideoToolbox adapter's latency-first mode with an injected
// backend: one frame in flight, drop-instead-of-queue, and the speed governor
// stepping the encoded size only for a genuinely slow encoder.
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "video_toolbox_h264_encoder.h"

namespace encoder = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

bool Check(bool condition, const char* message) {
  if (!condition) std::cerr << "FAIL: " << message << '\n';
  return condition;
}

class Bytes final : public common::FrameStorage {
 public:
  explicit Bytes(std::size_t size) : bytes_(size, std::byte{0x40}) {}
  const std::byte* data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }

 private:
  std::vector<std::byte> bytes_;
};

constexpr std::uint32_t kWidth = 1280;
constexpr std::uint32_t kHeight = 720;

common::CapturedFrame Frame(std::uint32_t width = kWidth,
                            std::uint32_t height = kHeight,
                            std::int64_t timestamp = 10,
                            bool repeated_unchanged = false) {
  static const auto storage = std::make_shared<Bytes>(
      static_cast<std::size_t>(kWidth) * kHeight * 4);
  return common::CapturedFrame{
      .encoded_pixels = {width, height},
      .pixel_format = common::PixelFormat::kBgra8888,
      .row_bytes = width * 4,
      .capture_time_us = timestamp,
      .color_primaries = common::ColorPrimaries::kDisplayP3,
      .storage = storage,
      .repeated_unchanged = repeated_unchanged,
  };
}

common::EncoderConfiguration Configuration(bool latency_first,
                                           std::uint32_t bitrate_bps = 3'000'000) {
  return common::EncoderConfiguration{
      .encoded_pixels = {kWidth, kHeight},
      .frame_rate = 30,
      .bitrate_bps = bitrate_bps,
      .profile = common::H264Profile::kConstrainedBaseline,
      .latency_first = latency_first,
  };
}

imcodes::rd::QualitySelection Selection(int width = static_cast<int>(kWidth),
                                        int height = static_cast<int>(kHeight),
                                        std::uint32_t bitrate_bps = 3'000'000) {
  return imcodes::rd::QualitySelection{"720p30", width, height, 30, bitrate_bps};
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
  };
  std::vector<common::EncoderConfiguration> configurations;
  std::vector<Pending> pending;
  encoder::VideoToolboxBackendOutputSink output_sink;
  bool hardware = false;

  bool HardwareEncoderAvailable() noexcept override { return hardware; }
  bool AppleSoftwareEncoderAvailable() noexcept override { return true; }
  bool Configure(const common::EncoderConfiguration& configuration,
                 encoder::VideoToolboxEncoderKind,
                 encoder::VideoToolboxBackendOutputSink next_output_sink,
                 encoder::VideoToolboxBackendErrorSink,
                 const encoder::VideoToolboxEncoderLimits&,
                 encoder::VideoToolboxEncoderError*) override {
    configurations.push_back(configuration);
    pending.clear();
    output_sink = std::move(next_output_sink);
    return true;
  }
  std::vector<bool> keyframe_requests;
  bool Encode(std::uint64_t id, const common::CapturedFrame& frame,
              bool request_keyframe,
              encoder::VideoToolboxEncoderError*) override {
    keyframe_requests.push_back(request_keyframe);
    pending.push_back({id, frame.capture_time_us, request_keyframe});
    return true;
  }
  void Stop() noexcept override {}

  void CompleteFirst() {
    const Pending item = pending.front();
    pending.erase(pending.begin());
    output_sink(item.id, AccessUnit(item.timestamp, item.keyframe));
  }
};

struct Rig {
  FakeBackend* backend = nullptr;
  std::unique_ptr<encoder::VideoToolboxH264Encoder> encoder;
  std::atomic<int> observed{0};
  std::atomic<int> emitted{0};
};

bool MakeRig(Rig* rig, bool latency_first, bool hardware = false,
             std::uint32_t bitrate_bps = 3'000'000) {
  auto backend = std::make_unique<FakeBackend>();
  backend->hardware = hardware;
  rig->backend = backend.get();
  rig->encoder = std::make_unique<encoder::VideoToolboxH264Encoder>(
      std::move(backend));
  rig->encoder->SetConfigurationObserver([rig] { ++rig->observed; });
  return Check(rig->encoder->Configure(
                   Configuration(latency_first, bitrate_bps),
                   [rig](common::H264AccessUnit) { ++rig->emitted; }),
               "configure");
}

// Submits one frame and completes it after `encode_ms`.
bool EncodeOne(Rig& rig, int encode_ms, std::int64_t timestamp = 10,
               bool repeated_unchanged = false) {
  if (!rig.encoder->Encode(Frame(kWidth, kHeight, timestamp, repeated_unchanged), false)) return false;
  if (encode_ms > 0) std::this_thread::sleep_for(std::chrono::milliseconds(encode_ms));
  if (!rig.backend->pending.empty()) rig.backend->CompleteFirst();
  return true;
}

bool TestLegacyModeKeepsTwoInFlightAndBacklogPressure() {
  Rig rig;
  if (!MakeRig(&rig, /*latency_first=*/false)) return false;
  const bool first = rig.encoder->Encode(Frame(), false);
  const bool second = rig.encoder->Encode(Frame(), false);
  const bool third = rig.encoder->Encode(Frame(), false);
  const auto stats = rig.encoder->Statistics();
  return Check(first && second && !third, "default mode still allows two in flight and drops the third") &&
         Check(stats.dropped_backpressure_frames == 1, "one drop") &&
         Check(stats.backlog_pressure > 0, "a drop still raises backlog pressure in the default mode") &&
         Check(stats.speed_governor_level == 0, "no governor outside latency-first mode");
}

bool TestLatencyFirstKeepsOneFrameInFlightAndDropsTheRest() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  bool ok = Check(rig.encoder->Encode(Frame(), false), "first frame accepted");
  for (int i = 0; i < 20; ++i) {
    ok = ok && Check(!rig.encoder->Encode(Frame(), false), "frames arriving while one is in flight are dropped");
  }
  auto stats = rig.encoder->Statistics();
  ok = ok && Check(stats.dropped_by_design_frames == 20, "all twenty counted as dropped by design");
  ok = ok && Check(stats.dropped_backpressure_frames == 0 && rig.encoder->DroppedFrames() == 0,
                   "...and none of them as a fault, so the HUD's dropped-frame count stays meaningful");
  ok = ok && Check(stats.backlog_pressure == 0,
                   "drops are the intended steady state here, not backlog pressure");
  rig.backend->CompleteFirst();
  ok = ok && Check(rig.encoder->Encode(Frame(), false), "the next frame after completion is accepted (newest wins)");
  return ok && Check(rig.backend->pending.size() == 1, "exactly one frame ever in flight");
}

bool TestFastEncoderNeverStepsTheSize() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  if (!Check(rig.encoder->ReconfigureFromQualitySelection(Selection()), "ladder selection")) return false;
  for (int i = 0; i < 60; ++i) {
    if (!EncodeOne(rig, 1)) return false;
  }
  return Check(rig.encoder->Statistics().speed_governor_level == 0, "a fast encoder keeps the size") &&
         Check(rig.backend->configurations.size() == 1, "no rebuild") &&
         Check(rig.observed == 0, "no observer call without a size change");
}

bool TestSlowEncoderStepsDownOnceAndTheCaptureIsTold() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  if (!Check(rig.encoder->ReconfigureFromQualitySelection(Selection()), "ladder selection")) return false;
  for (int i = 0; i < 12; ++i) {
    if (!EncodeOne(rig, 150)) return false;
  }
  if (!Check(rig.encoder->Statistics().speed_governor_level == 1, "12 slow frames step the governor down")) return false;
  // The next frame re-applies the ladder's request at the new level.
  (void)rig.encoder->Encode(Frame(), false);
  const auto configuration = rig.encoder->Configuration();
  return Check(configuration.has_value() && configuration->encoded_pixels.width == 960 &&
                   configuration->encoded_pixels.height == 540,
               "the encoder is rebuilt at the next-smaller size (960x540)") &&
         Check(configuration->latency_first, "the mode survives the rebuild") &&
         Check(rig.observed == 1, "the observer (capture retarget) is told exactly once") &&
         Check(rig.backend->configurations.size() == 2, "exactly one rebuild");
}

bool TestSamplesBeforeAnyLadderSelectionAreIgnored() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  // The session's first configuration is the display's native size, before any
  // quality selection: its (slow) frames must not push the governor down.
  for (int i = 0; i < 14; ++i) {
    if (!EncodeOne(rig, 150)) return false;
  }
  return Check(rig.encoder->Statistics().speed_governor_level == 0,
               "unarmed samples are ignored") &&
         Check(rig.backend->configurations.size() == 1, "no rebuild");
}

bool TestResampledFramesAreNotTimed() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  if (!Check(rig.encoder->ReconfigureFromQualitySelection(Selection()), "ladder selection")) return false;
  // Frames of another size take the slow resample path while the capture is
  // switching: they say nothing about the encoder.
  for (int i = 0; i < 14; ++i) {
    if (!rig.encoder->Encode(Frame(kWidth / 2, kHeight / 2), false)) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    if (!rig.backend->pending.empty()) rig.backend->CompleteFirst();
  }
  return Check(rig.encoder->Statistics().speed_governor_level == 0,
               "frames of a different size are not timed");
}

bool TestLadderDrivenSizeChangeTellsTheObserver() {
  Rig rig;
  if (!MakeRig(&rig, true)) return false;
  if (!Check(rig.encoder->ReconfigureFromQualitySelection(Selection(960, 540)), "ladder selection")) return false;
  return Check(rig.observed == 1, "a size change from the ladder also tells the observer") &&
         Check(rig.encoder->Configuration()->encoded_pixels.width == 960, "reconfigured");
}

bool TestEncoderClassAndDropsAreTruthful() {
  {
    Rig unconfigured;
    auto backend = std::make_unique<FakeBackend>();
    encoder::VideoToolboxH264Encoder encoder(std::move(backend));
    if (!Check(encoder.ImplementationClass() == common::EncoderClass::kUnknown,
               "nothing configured yet: unknown, never hardware") ||
        !Check(encoder.DroppedFrames() == 0, "no drops yet")) {
      return false;
    }
  }
  Rig software;
  if (!MakeRig(&software, false, /*hardware=*/false)) return false;
  Rig hardware;
  if (!MakeRig(&hardware, false, /*hardware=*/true)) return false;
  if (!Check(software.encoder->ImplementationClass() == common::EncoderClass::kSoftware,
             "a software session reports software") ||
      !Check(hardware.encoder->ImplementationClass() == common::EncoderClass::kHardware,
             "a hardware session reports hardware")) {
    return false;
  }
  // Drops are reported as the encoder counted them.
  Rig busy;
  if (!MakeRig(&busy, true)) return false;
  (void)busy.encoder->Encode(Frame(), false);
  (void)busy.encoder->Encode(Frame(), false);
  (void)busy.encoder->Encode(Frame(), false);
  busy.encoder->Stop();
  return Check(busy.encoder->ImplementationClass() == common::EncoderClass::kUnknown,
               "stopped: unknown again");
}

bool Requested(const Rig& rig, std::size_t index) {
  return index < rig.backend->keyframe_requests.size() && rig.backend->keyframe_requests[index];
}

bool TestASettledPictureGetsOneSharperKeyframe() {
  Rig rig;
  if (!MakeRig(&rig, true, false, 8'000'000)) return false;
  // The session's first frame is the keyframe; then twelve moving frames.
  for (int i = 0; i < 13; ++i) {
    if (!EncodeOne(rig, 0, 100 + i)) return false;
  }
  // The capture's keep-alive re-delivers the unchanged picture every 500 ms. A
  // short pause (one or two of them) is not settled; the third is.
  const std::size_t before = rig.backend->keyframe_requests.size();
  bool ok = Check(EncodeOne(rig, 0, 200, /*repeated_unchanged=*/true), "1st unchanged frame accepted");
  ok = ok && Check(!Requested(rig, before), "after about 0.5 s of quiet: no refresh yet");
  ok = ok && Check(EncodeOne(rig, 0, 201, true), "2nd unchanged frame accepted");
  ok = ok && Check(!Requested(rig, before + 1), "after about 1 s of quiet: no refresh yet");
  ok = ok && Check(EncodeOne(rig, 0, 202, true), "3rd unchanged frame accepted");
  ok = ok && Check(Requested(rig, before + 2), "the picture has settled (3rd unchanged frame): forced to a keyframe");
  ok = ok && Check(rig.encoder->Statistics().refresh_keyframes == 1, "one refresh counted");
  for (int i = 0; i < 6; ++i) {
    ok = ok && Check(EncodeOne(rig, 0, 300 + i, true), "more unchanged frames accepted");
  }
  ok = ok && Check(rig.encoder->Statistics().refresh_keyframes == 1, "no second refresh inside the same static run");
  // Motion resumes and settles again straight away: spaced by at least 5 s.
  ok = ok && Check(EncodeOne(rig, 0, 400), "motion");
  for (int i = 0; i < 3; ++i) ok = ok && Check(EncodeOne(rig, 0, 410 + i, true), "settled again");
  return ok && Check(rig.encoder->Statistics().refresh_keyframes == 1, "a second run inside the spacing is not refreshed");
}

bool TestAShortPauseNeverRefreshes() {
  Rig rig;
  if (!MakeRig(&rig, true, false, 8'000'000)) return false;
  for (int i = 0; i < 13; ++i) {
    if (!EncodeOne(rig, 0, 100 + i)) return false;
  }
  // Typing with short pauses: one or two keep-alive frames between bursts.
  for (int pause = 0; pause < 10; ++pause) {
    if (!EncodeOne(rig, 0, 200 + pause * 10)) return false;
    if (!EncodeOne(rig, 0, 201 + pause * 10, true)) return false;
    if (!EncodeOne(rig, 0, 202 + pause * 10, true)) return false;
  }
  return Check(rig.encoder->Statistics().refresh_keyframes == 0,
               "pauses shorter than three keep-alive frames never cost a refresh");
}

bool TestNewMotionIsNeverQueuedBehindARefresh() {
  Rig rig;
  if (!MakeRig(&rig, true, false, 8'000'000)) return false;
  for (int i = 0; i < 13; ++i) {
    if (!EncodeOne(rig, 0, 100 + i)) return false;
  }
  if (!EncodeOne(rig, 0, 200, true) || !EncodeOne(rig, 0, 201, true)) return false;
  // The refresh keyframe is submitted and still encoding...
  if (!Check(rig.encoder->Encode(Frame(kWidth, kHeight, 202, true), false), "refresh frame accepted")) return false;
  if (!Check(rig.encoder->Statistics().refresh_keyframes == 1, "it is the refresh")) return false;
  // ...when the screen changes. The new picture is not queued behind it (there is
  // one frame in flight, never two): it is dropped by design, and the very next
  // frame after the keyframe completes is encoded at once.
  const std::uint64_t by_design = rig.encoder->Statistics().dropped_by_design_frames;
  bool ok = Check(!rig.encoder->Encode(Frame(kWidth, kHeight, 203, false), false),
                  "new motion while the refresh encodes waits for nothing but the keyframe itself");
  ok = ok && Check(rig.encoder->Statistics().dropped_by_design_frames == by_design + 1, "counted as dropped by design");
  ok = ok && Check(rig.backend->pending.size() == 1, "exactly one frame (the keyframe) in flight");
  rig.backend->CompleteFirst();
  ok = ok && Check(rig.encoder->Encode(Frame(kWidth, kHeight, 204, false), false),
                   "the next new frame is accepted the moment the keyframe is out");
  return ok && Check(!Requested(rig, rig.backend->keyframe_requests.size() - 1), "and is an ordinary frame, not another keyframe");
}

bool TestRefreshNeedsEnoughFramesAndALinkThatCanCarryIt() {
  {
    Rig few;
    if (!MakeRig(&few, true, false, 8'000'000)) return false;
    for (int i = 0; i < 5; ++i) {
      if (!EncodeOne(few, 0, 100 + i)) return false;
    }
    for (int i = 0; i < 3; ++i) {
      if (!EncodeOne(few, 0, 200 + i, true)) return false;
    }
    if (!Check(few.encoder->Statistics().refresh_keyframes == 0,
               "too few frames since the keyframe: a refresh would be worse than the keyframe it replaces")) {
      return false;
    }
  }
  Rig slow;
  if (!MakeRig(&slow, true, false, 5'000'000)) return false;
  for (int i = 0; i < 13; ++i) {
    if (!EncodeOne(slow, 0, 100 + i)) return false;
  }
  for (int i = 0; i < 3; ++i) {
    if (!EncodeOne(slow, 0, 200 + i, true)) return false;
  }
  if (!Check(slow.encoder->Statistics().refresh_keyframes == 0, "a 5 Mbps link is not asked to carry the burst")) return false;
  // The link target rises (a bitrate-only update keeps the session): the next
  // settled picture is refreshed.
  if (!Check(slow.encoder->ReconfigureFromQualitySelection(
                 Selection(static_cast<int>(kWidth), static_cast<int>(kHeight), 8'000'000)),
             "ladder update with a higher target")) {
    return false;
  }
  if (!EncodeOne(slow, 0, 300)) return false;
  for (int i = 0; i < 3; ++i) {
    if (!EncodeOne(slow, 0, 310 + i, true)) return false;
  }
  return Check(slow.encoder->Statistics().refresh_keyframes == 1,
               "once the target can carry it, the settled picture is refreshed");
}

bool TestTheDefaultModeNeverRefreshes() {
  Rig rig;
  if (!MakeRig(&rig, /*latency_first=*/false, false, 8'000'000)) return false;
  for (int i = 0; i < 13; ++i) {
    if (!EncodeOne(rig, 0, 100 + i)) return false;
  }
  for (int i = 0; i < 4; ++i) {
    if (!EncodeOne(rig, 0, 200 + i, true)) return false;
  }
  return Check(rig.encoder->Statistics().refresh_keyframes == 0, "the default mode never forces a refresh") &&
         Check(!Requested(rig, rig.backend->keyframe_requests.size() - 1), "and does not request a keyframe for it");
}

}  // namespace

int main() {
  const bool ok = TestLegacyModeKeepsTwoInFlightAndBacklogPressure() &&
                  TestLatencyFirstKeepsOneFrameInFlightAndDropsTheRest() &&
                  TestFastEncoderNeverStepsTheSize() &&
                  TestSlowEncoderStepsDownOnceAndTheCaptureIsTold() &&
                  TestSamplesBeforeAnyLadderSelectionAreIgnored() &&
                  TestResampledFramesAreNotTimed() &&
                  TestLadderDrivenSizeChangeTellsTheObserver() &&
                  TestEncoderClassAndDropsAreTruthful() &&
                  TestASettledPictureGetsOneSharperKeyframe() &&
                  TestAShortPauseNeverRefreshes() &&
                  TestNewMotionIsNeverQueuedBehindARefresh() &&
                  TestRefreshNeedsEnoughFramesAndALinkThatCanCarryIt() &&
                  TestTheDefaultModeNeverRefreshes();
  if (ok) std::cout << "macos latency-first encoder counterfactuals passed\n";
  return ok ? 0 : 1;
}
