#include <cstddef>
#include <cstdint>
#include <iostream>
#include <memory>
#include <utility>
#include <vector>

#include "h264_sender_bridge.h"
#include "video_toolbox_h264_encoder.h"

namespace sender = imcodes::remote_desktop::macos;
namespace encoder = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

bool Check(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << '\n';
  }
  return condition;
}

common::H264AccessUnit AccessUnit(
    std::int64_t timestamp, std::size_t bytes, bool keyframe = false,
    common::H264Profile profile = common::H264Profile::kConstrainedBaseline) {
  return common::H264AccessUnit{
      .bytes = std::vector<std::byte>(bytes, std::byte{0x65}),
      .presentation_time_us = timestamp,
      .profile = profile,
      .keyframe = keyframe,
  };
}

class FrameBytes final : public common::FrameStorage {
public:
  FrameBytes() : bytes_(64, std::byte{0x11}) {}
  const std::byte *data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }

private:
  std::vector<std::byte> bytes_;
};

common::CapturedFrame CapturedFrame(std::int64_t timestamp) {
  return common::CapturedFrame{
      .encoded_pixels = {4, 4},
      .pixel_format = common::PixelFormat::kBgra8888,
      .row_bytes = 16,
      .capture_time_us = timestamp,
      .color_primaries = common::ColorPrimaries::kBt709,
      .storage = std::make_shared<FrameBytes>(),
  };
}

class FakeVideoToolboxBackend final
    : public encoder::VideoToolboxEncoderBackend {
public:
  bool HardwareEncoderAvailable() noexcept override { return true; }
  bool AppleSoftwareEncoderAvailable() noexcept override { return false; }

  bool Configure(const common::EncoderConfiguration &,
                 encoder::VideoToolboxEncoderKind,
                 encoder::VideoToolboxBackendOutputSink next_output,
                 encoder::VideoToolboxBackendErrorSink next_error,
                 const encoder::VideoToolboxEncoderLimits &,
                 encoder::VideoToolboxEncoderError *) override {
    output = std::move(next_output);
    error = std::move(next_error);
    return true;
  }

  bool Encode(std::uint64_t submission_id, const common::CapturedFrame &frame,
              bool request_keyframe,
              encoder::VideoToolboxEncoderError *) override {
    pending_id = submission_id;
    pending_timestamp = frame.capture_time_us;
    pending_keyframe = request_keyframe;
    return true;
  }

  void Stop() noexcept override {}

  void Complete() {
    output(pending_id, AccessUnit(pending_timestamp, 6, pending_keyframe));
  }

  std::uint64_t pending_id = 0;
  std::int64_t pending_timestamp = 0;
  bool pending_keyframe = false;
  encoder::VideoToolboxBackendOutputSink output;
  encoder::VideoToolboxBackendErrorSink error;
};

class FakeSender final : public sender::H264SenderBackend {
public:
  struct Pending {
    sender::H264SenderFrame frame;
    sender::H264SenderCompletionCallback completion;
  };

  bool start_succeeds = true;
  bool submit_succeeds = true;
  std::vector<sender::H264SenderConfiguration> configurations;
  std::vector<Pending> pending;
  std::vector<common::WorkerGeneration> canceled;

  bool Start(const sender::H264SenderConfiguration &configuration) override {
    configurations.push_back(configuration);
    return start_succeeds;
  }

  bool Submit(sender::H264SenderFrame frame,
              sender::H264SenderCompletionCallback completion) override {
    if (!submit_succeeds) {
      return false;
    }
    pending.push_back({std::move(frame), std::move(completion)});
    return true;
  }

  void Cancel(common::WorkerGeneration generation) noexcept override {
    canceled.push_back(generation);
  }

  void Complete(std::size_t index, sender::H264SenderCompletion result,
                std::size_t copied_bytes = 0) {
    auto completion = pending.at(index).completion;
    completion(result, copied_bytes);
  }
};

bool TestMetadataMappingAndMovedPayload() {
  auto backend = std::make_unique<FakeSender>();
  FakeSender *fake = backend.get();
  sender::H264SenderBridge bridge(std::move(backend));
  if (!Check(bridge.Start(7, {1920, 1080}, common::H264Profile::kMain),
             "bridge must start with a valid generation") ||
      !Check(fake->configurations.size() == 1 &&
                 fake->configurations[0].profile ==
                     sender::H264SenderProfile::kMain,
             "common H.264 profile must map into sender configuration")) {
    return false;
  }

  auto access_unit = AccessUnit(1'234'567, 6, true, common::H264Profile::kMain);
  const std::byte *original_storage = access_unit.bytes.data();
  if (!Check(bridge.Submit(7, std::move(access_unit)),
             "valid access unit must be accepted") ||
      !Check(fake->pending.size() == 1,
             "one access unit must reach the sender") ||
      !Check(fake->pending[0].frame.bytes.data() == original_storage,
             "generic bridge must move rather than copy payload storage") ||
      !Check(fake->pending[0].frame.capture_time_ms == 1'234,
             "capture time must map from microseconds to milliseconds") ||
      !Check(fake->pending[0].frame.rtp_timestamp_90khz == 111'111,
             "presentation time must map onto the 90 kHz video clock") ||
      !Check(fake->pending[0].frame.keyframe,
             "keyframe metadata must survive the bridge") ||
      !Check(fake->pending[0].frame.profile == sender::H264SenderProfile::kMain,
             "per-frame profile must match the negotiated sender profile")) {
    return false;
  }

  fake->Complete(0, sender::H264SenderCompletion::kAccepted, 6);
  const auto statistics = bridge.Statistics();
  return Check(statistics.delivered_access_units == 1,
               "accepted completion must be recorded") &&
         Check(statistics.webrtc_owned_copy_bytes == 6,
               "the one bounded libwebrtc-owned copy must be accounted") &&
         Check(statistics.pending_access_units == 0 &&
                   statistics.pending_bytes == 0,
               "completion must release all pending accounting");
}

bool TestBoundedQueueDropsOldestQueuedDelta() {
  auto backend = std::make_unique<FakeSender>();
  FakeSender *fake = backend.get();
  sender::H264SenderBridge bridge(std::move(backend),
                                  {.max_pending_access_units = 3,
                                   .max_pending_bytes = 12,
                                   .max_access_unit_bytes = 8});
  if (!bridge.Start(3, {640, 480}, common::H264Profile::kConstrainedBaseline) ||
      !bridge.Submit(3, AccessUnit(1'000, 4)) ||
      !bridge.Submit(3, AccessUnit(2'000, 4)) ||
      !bridge.Submit(3, AccessUnit(3'000, 5, true))) {
    return Check(false, "bounded queue setup must succeed");
  }
  auto statistics = bridge.Statistics();
  if (!Check(fake->pending.size() == 1,
             "only one sender submission may be in flight") ||
      !Check(statistics.pending_access_units == 2 &&
                 statistics.pending_bytes == 9,
             "oldest queued delta must be evicted to fit a keyframe") ||
      !Check(statistics.dropped_backpressure_access_units == 1,
             "backpressure eviction must be visible")) {
    return false;
  }

  fake->Complete(0, sender::H264SenderCompletion::kAccepted);
  if (!Check(fake->pending.size() == 2 && fake->pending[1].frame.keyframe &&
                 fake->pending[1].frame.presentation_time_us == 3'000,
             "the retained keyframe must dispatch after completion")) {
    return false;
  }
  fake->Complete(1, sender::H264SenderCompletion::kAccepted);
  statistics = bridge.Statistics();
  return Check(statistics.pending_access_units == 0 &&
                   statistics.pending_bytes == 0,
               "drained queue must have zero retained storage");
}

bool TestGenerationFencingAndLateCallback() {
  auto backend = std::make_unique<FakeSender>();
  FakeSender *fake = backend.get();
  sender::H264SenderBridge bridge(std::move(backend));
  if (!bridge.Start(10, {1280, 720}, common::H264Profile::kHigh) ||
      !bridge.Submit(10,
                     AccessUnit(1'000, 4, true, common::H264Profile::kHigh))) {
    return Check(false, "first generation setup must succeed");
  }
  bridge.Stop();
  if (!Check(!bridge.Submit(
                 10, AccessUnit(2'000, 4, false, common::H264Profile::kHigh)),
             "stopped generation must reject new access units") ||
      !Check(!bridge.Start(10, {1280, 720}, common::H264Profile::kHigh),
             "generation reuse must fail closed") ||
      !Check(bridge.Start(11, {1280, 720}, common::H264Profile::kHigh),
             "a fresh generation must start")) {
    return false;
  }
  fake->Complete(0, sender::H264SenderCompletion::kAccepted);
  const auto statistics = bridge.Statistics();
  return Check(bridge.IsActive() && bridge.ActiveGeneration() == 11,
               "late completion must not stop the new generation") &&
         Check(statistics.ignored_late_callbacks == 1,
               "late completion must be counted and ignored") &&
         Check(fake->canceled.size() == 1 && fake->canceled[0] == 10,
               "terminal cleanup must cancel the old generation once");
}

bool TestInvalidAndFatalPathsFailClosed() {
  auto backend = std::make_unique<FakeSender>();
  FakeSender *fake = backend.get();
  sender::H264SenderBridge bridge(std::move(backend),
                                  {.max_pending_access_units = 2,
                                   .max_pending_bytes = 16,
                                   .max_access_unit_bytes = 8});
  if (!bridge.Start(21, {320, 240},
                    common::H264Profile::kConstrainedBaseline)) {
    return Check(false, "fatal-path bridge must start");
  }
  if (!Check(!bridge.Submit(21, AccessUnit(1'000, 9)),
             "oversized access unit must be rejected") ||
      !Check(bridge.Submit(21, AccessUnit(2'000, 4)),
             "valid access unit must submit") ||
      !Check(!bridge.Submit(21, AccessUnit(2'000, 4)),
             "non-increasing timestamp must be rejected")) {
    return false;
  }
  fake->Complete(0, sender::H264SenderCompletion::kFatal);
  const auto statistics = bridge.Statistics();
  return Check(!bridge.IsActive(),
               "fatal sender completion must terminate the bridge") &&
         Check(statistics.terminal_failures == 1 &&
                   statistics.pending_access_units == 0 &&
                   statistics.pending_bytes == 0,
               "fatal completion must clear all pending state") &&
         Check(fake->canceled.size() == 1 && fake->canceled[0] == 21,
               "fatal completion must cancel the active backend generation");
}

bool TestBackendSubmissionFailureIsTerminal() {
  auto backend = std::make_unique<FakeSender>();
  FakeSender *fake = backend.get();
  fake->submit_succeeds = false;
  sender::H264SenderBridge bridge(std::move(backend));
  if (!bridge.Start(31, {320, 240},
                    common::H264Profile::kConstrainedBaseline)) {
    return Check(false, "submission-failure bridge must start");
  }
  if (!Check(bridge.Submit(31, AccessUnit(1'000, 4)),
             "queue admission precedes backend submission")) {
    return false;
  }
  const auto statistics = bridge.Statistics();
  return Check(!bridge.IsActive() && statistics.terminal_failures == 1,
               "backend rejection must synchronously terminate the bridge") &&
         Check(statistics.pending_access_units == 0 &&
                   statistics.pending_bytes == 0,
               "backend rejection must release admitted storage");
}

bool TestVideoToolboxOutputFeedsTheSenderBridge() {
  auto sender_backend = std::make_unique<FakeSender>();
  FakeSender *fake_sender = sender_backend.get();
  sender::H264SenderBridge bridge(std::move(sender_backend));
  if (!bridge.Start(41, {4, 4}, common::H264Profile::kConstrainedBaseline)) {
    return Check(false, "pipeline sender bridge must start");
  }

  auto encoder_backend = std::make_unique<FakeVideoToolboxBackend>();
  FakeVideoToolboxBackend *fake_encoder = encoder_backend.get();
  encoder::VideoToolboxH264Encoder video_toolbox(std::move(encoder_backend));
  bool sink_accepted = true;
  if (!video_toolbox.Configure(
          {.encoded_pixels = {4, 4},
           .frame_rate = 30,
           .bitrate_bps = 3'000'000,
           .profile = common::H264Profile::kConstrainedBaseline},
          [&bridge, &sink_accepted](common::H264AccessUnit access_unit) {
            sink_accepted =
                bridge.Submit(41, std::move(access_unit)) && sink_accepted;
          }) ||
      !video_toolbox.Encode(CapturedFrame(90'000), true)) {
    return Check(false, "VideoToolbox fake pipeline must accept a frame");
  }
  fake_encoder->Complete();
  if (!Check(sink_accepted && fake_sender->pending.size() == 1,
             "VideoToolbox access-unit sink must feed the sender bridge") ||
      !Check(fake_sender->pending[0].frame.presentation_time_us == 90'000 &&
                 fake_sender->pending[0].frame.keyframe,
             "pipeline must preserve encoder timestamp and keyframe state")) {
    return false;
  }
  fake_sender->Complete(0, sender::H264SenderCompletion::kAccepted);
  video_toolbox.Stop();
  bridge.Stop();
  return Check(bridge.Statistics().pending_bytes == 0,
               "pipeline shutdown must release sender storage");
}

bool TestCompletionAfterDestructionIsHarmless() {
  sender::H264SenderCompletionCallback late_completion;
  {
    auto backend = std::make_unique<FakeSender>();
    FakeSender *fake = backend.get();
    sender::H264SenderBridge bridge(std::move(backend));
    if (!bridge.Start(51, {320, 240},
                      common::H264Profile::kConstrainedBaseline) ||
        !bridge.Submit(51, AccessUnit(1'000, 4))) {
      return Check(false, "destruction test setup must succeed");
    }
    late_completion = fake->pending[0].completion;
  }
  late_completion(sender::H264SenderCompletion::kAccepted, 0);
  return Check(true, "late completion after destruction must be ignored");
}

} // namespace

int main() {
  const bool ok = TestMetadataMappingAndMovedPayload() &&
                  TestBoundedQueueDropsOldestQueuedDelta() &&
                  TestGenerationFencingAndLateCallback() &&
                  TestInvalidAndFatalPathsFailClosed() &&
                  TestBackendSubmissionFailureIsTerminal() &&
                  TestVideoToolboxOutputFeedsTheSenderBridge() &&
                  TestCompletionAfterDestructionIsHarmless();
  return ok ? 0 : 1;
}
