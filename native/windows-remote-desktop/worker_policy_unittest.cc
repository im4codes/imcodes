#include "third_party/imcodes_remote_desktop/worker_policy.h"

#include <dxgi.h>

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

TEST(WorkerPolicyTest, ClassifiesBoundedDxgiDeviceRecovery) {
  EXPECT_EQ(ClassifyCaptureAcquireResult(S_OK), CaptureAcquireAction::kFrame);
  EXPECT_EQ(ClassifyCaptureAcquireResult(DXGI_ERROR_WAIT_TIMEOUT),
            CaptureAcquireAction::kWait);
  EXPECT_EQ(ClassifyCaptureAcquireResult(DXGI_ERROR_ACCESS_LOST),
            CaptureAcquireAction::kReset);
  EXPECT_EQ(ClassifyCaptureAcquireResult(DXGI_ERROR_DEVICE_REMOVED),
            CaptureAcquireAction::kReset);
  EXPECT_EQ(ClassifyCaptureAcquireResult(E_FAIL), CaptureAcquireAction::kDrop);
}

TEST(WorkerPolicyTest, FailsClosedAcrossDisplaySessionAndPowerChanges) {
  EXPECT_EQ(SelectWorkerEnvironmentAction(0),
            WorkerEnvironmentAction::kNone);
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentDisplayChanged),
            WorkerEnvironmentAction::kRefreshTopology);
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentResume),
            WorkerEnvironmentAction::kStopAndReinitialize);
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentSessionAvailable),
            WorkerEnvironmentAction::kStopAndReinitialize);
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentCompositionChanged),
            WorkerEnvironmentAction::kStopAndReinitialize);
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentSuspend |
                                           kEnvironmentDisplayChanged),
            WorkerEnvironmentAction::kStopProtected);
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentSessionUnavailable |
                                           kEnvironmentResume),
            WorkerEnvironmentAction::kStopProtected);
}

TEST(WorkerPolicyTest, DebouncesDisplayTopologyUntilItStabilizes) {
  int remaining = 0;
  EXPECT_FALSE(AdvanceTopologyRefreshDebounce(true, &remaining));
  EXPECT_EQ(remaining, kTopologyRefreshDebounceTicks);
  for (int tick = 1; tick < kTopologyRefreshDebounceTicks; ++tick) {
    EXPECT_FALSE(AdvanceTopologyRefreshDebounce(false, &remaining));
  }
  EXPECT_TRUE(AdvanceTopologyRefreshDebounce(false, &remaining));
  EXPECT_EQ(remaining, 0);
  EXPECT_FALSE(AdvanceTopologyRefreshDebounce(false, &remaining));
  EXPECT_FALSE(AdvanceTopologyRefreshDebounce(true, nullptr));
}

TEST(WorkerPolicyTest, DetectsOnlyARealCompositorProcessReplacement) {
  DWORD previous_process_id = 0;
  EXPECT_FALSE(AdvanceCompositorProcessGeneration(0, &previous_process_id));
  EXPECT_EQ(previous_process_id, 0u);
  EXPECT_FALSE(
      AdvanceCompositorProcessGeneration(101, &previous_process_id));
  EXPECT_EQ(previous_process_id, 101u);
  EXPECT_FALSE(
      AdvanceCompositorProcessGeneration(101, &previous_process_id));
  EXPECT_FALSE(AdvanceCompositorProcessGeneration(0, &previous_process_id));
  EXPECT_EQ(previous_process_id, 101u);
  EXPECT_TRUE(AdvanceCompositorProcessGeneration(202, &previous_process_id));
  EXPECT_EQ(previous_process_id, 202u);
  EXPECT_FALSE(AdvanceCompositorProcessGeneration(303, nullptr));
}

TEST(WorkerPolicyTest, SelectsStableThenPrimaryThenAvailableDisplay) {
  const std::vector<DisplaySelectionCandidate> displays = {
      {"old", false, false}, {"primary", true, true}, {"other", false, true}};
  EXPECT_EQ(SelectDisplayAfterTopologyChange(displays, "other"), 2u);
  EXPECT_EQ(SelectDisplayAfterTopologyChange(displays, "old"), 1u);
  EXPECT_EQ(SelectDisplayAfterTopologyChange({{"none", true, false}}, "none"),
            1u);
}

TEST(WorkerPolicyTest, LeavesTheHeadlessDisplayWhenARealDisplayAppears) {
  const std::vector<DisplaySelectionCandidate> displays = {
      {"headless", true, true, true},
      {"real-secondary", false, true, false},
      {"real-primary", true, true, false}};
  EXPECT_EQ(SelectDisplayAfterTopologyChange(displays, "headless"), 2u);
  EXPECT_EQ(SelectDisplayAfterTopologyChange(displays, "real-secondary"), 1u);
  EXPECT_EQ(SelectDisplayAfterTopologyChange(
                {{"headless", true, true, true}}, "headless"),
            0u);
}

TEST(WorkerPolicyTest, RequiresExplicitChoiceWhenSelectedDisplayDisappears) {
  const std::vector<DisplaySelectionCandidate> displays = {
      {"new-primary", true, true, false},
      {"new-secondary", false, true, false}};
  EXPECT_TRUE(DisplaySelectionRequiresExplicitChoice(displays, "removed"));
  EXPECT_FALSE(
      DisplaySelectionRequiresExplicitChoice(displays, "new-secondary"));
  EXPECT_FALSE(DisplaySelectionRequiresExplicitChoice(displays, ""));
}

TEST(WorkerPolicyTest, AllowsOnlyFixedCommonDisplayModes) {
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(1280, 720));
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(1920, 1080));
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(2560, 1440));
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(3840, 2160));
  EXPECT_FALSE(IsAllowedRemoteDisplayMode(1024, 768));
  EXPECT_FALSE(IsAllowedRemoteDisplayMode(3840, 1080));
  EXPECT_FALSE(IsAllowedRemoteDisplayMode(0, 0));
}

TEST(WorkerPolicyTest, AllowsOnlyFixedDpiScalesAndRecommendsPerResolution) {
  for (const int percent : {100, 125, 150, 175, 200, 225, 250, 300})
    EXPECT_TRUE(IsAllowedRemoteDisplayScale(percent));
  EXPECT_FALSE(IsAllowedRemoteDisplayScale(110));
  EXPECT_FALSE(IsAllowedRemoteDisplayScale(500));
  EXPECT_EQ(RecommendedRemoteDisplayScale(1280, 720), 125);
  EXPECT_EQ(RecommendedRemoteDisplayScale(1920, 1080), 150);
  EXPECT_EQ(RecommendedRemoteDisplayScale(2560, 1440), 175);
  EXPECT_EQ(RecommendedRemoteDisplayScale(3840, 2160), 225);
  EXPECT_EQ(RecommendedRemoteDisplayScale(1024, 768), 100);
}

TEST(WorkerPolicyTest, RequiresPresentedFrameGeometryForSelectedDisplay) {
  EXPECT_TRUE(PresentedFrameMatchesDisplay(1920, 1080, 3840, 2160));
  EXPECT_TRUE(PresentedFrameMatchesDisplay(1600, 900, 3840, 2160));
  EXPECT_TRUE(PresentedFrameMatchesDisplay(900, 1600, 1080, 1920));
  EXPECT_TRUE(PresentedFrameMatchesDisplay(1364, 768, 1920, 1080));
  EXPECT_FALSE(PresentedFrameMatchesDisplay(1920, 1080, 1080, 1920));
  EXPECT_FALSE(PresentedFrameMatchesDisplay(1600, 900, 2560, 1600));
  EXPECT_FALSE(PresentedFrameMatchesDisplay(0, 1080, 1920, 1080));
  EXPECT_FALSE(PresentedFrameMatchesDisplay(16'385, 1080, 1920, 1080));
}

TEST(WorkerPolicyTest, EnforcesQueueAndKeyframePolicy) {
  EXPECT_TRUE(EncoderQueueHasCapacity(2, 3));
  EXPECT_FALSE(EncoderQueueHasCapacity(3, 3));
  EXPECT_FALSE(EncoderQueueHasCapacity(0, 0));
  EXPECT_TRUE(EncoderKeyFrameRequested(true, false));
  EXPECT_TRUE(EncoderKeyFrameRequested(false, true));
  EXPECT_FALSE(EncoderKeyFrameRequested(false, false));
  EXPECT_FALSE(HardwareEncoderShouldFallback(0, 3, 3));
  EXPECT_FALSE(HardwareEncoderShouldFallback(1, 2, 3));
  EXPECT_TRUE(HardwareEncoderShouldFallback(1, 3, 3));
  EXPECT_TRUE(HardwareEncoderShouldFallback(3, 0, 3));
}

TEST(WorkerPolicyTest, FallsBackOnlyAfterSustainedMissedFrameBudgets) {
  size_t slow_frames = 0;
  for (size_t index = 0; index < kHardwareSlowFrameLimit - 1; ++index) {
    slow_frames = UpdateHardwareSlowFrameCount(48'000, 30, slow_frames);
    EXPECT_FALSE(HardwareEncoderThroughputShouldFallback(slow_frames));
  }
  slow_frames = UpdateHardwareSlowFrameCount(48'000, 30, slow_frames);
  EXPECT_TRUE(HardwareEncoderThroughputShouldFallback(slow_frames));

  EXPECT_EQ(UpdateHardwareSlowFrameCount(33'000, 30, slow_frames), 0u);
  EXPECT_EQ(UpdateHardwareSlowFrameCount(48'000, 15, slow_frames), 0u);
  EXPECT_EQ(UpdateHardwareSlowFrameCount(-1, 30, slow_frames), 0u);
  EXPECT_EQ(UpdateHardwareSlowFrameCount(48'000, 0, slow_frames), 0u);
}

TEST(WorkerPolicyTest, KeepsHardwareFallbackStickyAcrossRateReconfiguration) {
  EXPECT_TRUE(ShouldAttemptHardwareEncoder(true, false));
  EXPECT_FALSE(ShouldAttemptHardwareEncoder(true, true));
  EXPECT_FALSE(ShouldAttemptHardwareEncoder(false, false));
  EXPECT_FALSE(ShouldAttemptHardwareEncoder(false, true));
}

TEST(WorkerPolicyTest, RequiresBothFreshCaptureAndStalledRtpForFailover) {
  EXPECT_FALSE(MediaProgressShouldFailover(100, 101, 20, 30,
                                           kMediaProgressTimeoutMs));
  EXPECT_FALSE(MediaProgressShouldFailover(100, 100, 20, 20,
                                           kMediaProgressTimeoutMs));
  EXPECT_FALSE(MediaProgressShouldFailover(100, 100, 20, 30,
                                           kMediaProgressTimeoutMs - 1));
  EXPECT_TRUE(MediaProgressShouldFailover(100, 100, 20, 21,
                                          kMediaProgressTimeoutMs));
}

TEST(WorkerPolicyTest, AcceptsZeroAsTheFirstChannelSequenceOnly) {
  EXPECT_TRUE(InputSequenceIsFresh(false, 0, 0));
  EXPECT_TRUE(InputSequenceIsFresh(false, 42, 0));
  EXPECT_FALSE(InputSequenceIsFresh(true, 0, 0));
  EXPECT_TRUE(InputSequenceIsFresh(true, 0, 1));
  EXPECT_FALSE(InputSequenceIsFresh(true, 2, 1));
}

TEST(WorkerPolicyTest, OrdersIdleAuthorityAndLeaseExpiry) {
  EXPECT_STREQ(SessionExpiryReason(100, 200, 150, true), "idle_timeout");
  EXPECT_STREQ(SessionExpiryReason(200, 200, 250, false),
               "authority_expired");
  EXPECT_STREQ(SessionExpiryReason(160, 200, 150, false), "lease_expired");
  EXPECT_EQ(SessionExpiryReason(100, 200, 150, false), nullptr);
}

}  // namespace
}  // namespace imcodes::rd
