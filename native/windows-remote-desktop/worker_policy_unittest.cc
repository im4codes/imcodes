#include "third_party/imcodes_remote_desktop/worker_policy.h"

#include <dxgi.h>

#include <algorithm>
#include <vector>

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

TEST(WorkerPolicyTest, FollowsTheDesktopThatCurrentlyReceivesInput) {
  int failures = 0;
  EXPECT_EQ(SelectDesktopFollowAction(L"Default", L"Default", &failures),
            DesktopFollowAction::kStay);
  EXPECT_EQ(SelectDesktopFollowAction(L"Winlogon", L"Default", &failures),
            DesktopFollowAction::kFollow);
  EXPECT_EQ(SelectDesktopFollowAction(L"Default", L"Winlogon", &failures),
            DesktopFollowAction::kFollow);
  EXPECT_EQ(failures, 0);
}

TEST(WorkerPolicyTest, GivesUpOnlyAfterTheInputDesktopStaysUnreadable) {
  int failures = 0;
  for (int attempt = 1; attempt < kDesktopFollowFailureLimit; ++attempt) {
    EXPECT_EQ(SelectDesktopFollowAction(L"", L"Default", &failures),
              DesktopFollowAction::kStay);
  }
  EXPECT_EQ(SelectDesktopFollowAction(L"", L"Default", &failures),
            DesktopFollowAction::kUnavailable);
  EXPECT_EQ(failures, 0);

  // A single readable poll clears the streak, and a missing counter never
  // escalates.
  failures = kDesktopFollowFailureLimit - 1;
  EXPECT_EQ(SelectDesktopFollowAction(L"Default", L"Default", &failures),
            DesktopFollowAction::kStay);
  EXPECT_EQ(failures, 0);
  EXPECT_EQ(SelectDesktopFollowAction(L"", L"Default", nullptr),
            DesktopFollowAction::kStay);
}

TEST(WorkerPolicyTest, IgnoresTheDesktopFlickerWindowsShowsWhileItLocks) {
  // Measured on real hardware: locking reports the sign-in desktop for well
  // under one poll period, drops the curtain back on the user's own desktop,
  // and only moves for good once a key arrives. Moving on that first sample is
  // what left capture reading a desktop Windows had stopped displaying.
  std::wstring candidate;
  EXPECT_FALSE(DesktopFollowSettled(L"Winlogon", &candidate));
  EXPECT_FALSE(DesktopFollowSettled(L"Default", &candidate));
  EXPECT_TRUE(DesktopFollowSettled(L"Default", &candidate));
  // The real move still lands on the very next agreeing sample.
  EXPECT_FALSE(DesktopFollowSettled(L"Winlogon", &candidate));
  EXPECT_TRUE(DesktopFollowSettled(L"Winlogon", &candidate));
  // An unreadable poll is never a destination and never counts toward one.
  EXPECT_FALSE(DesktopFollowSettled(L"", &candidate));
  EXPECT_FALSE(DesktopFollowSettled(L"Winlogon", &candidate));
  EXPECT_TRUE(DesktopFollowSettled(L"Winlogon", &candidate));
  // Without somewhere to keep the candidate, any readable desktop is settled.
  EXPECT_TRUE(DesktopFollowSettled(L"Default", nullptr));
  EXPECT_FALSE(DesktopFollowSettled(L"", nullptr));
}

TEST(WorkerPolicyTest, RebindsCaptureWheneverItIsNotOnTheDisplayedDesktop) {
  // Compared against what the source reports it is reading, so a rebind
  // Windows refused mid-switch is retried instead of assumed.
  EXPECT_TRUE(ShouldRebindCapture(L"Winlogon", L"Default"));
  EXPECT_TRUE(ShouldRebindCapture(L"Default", L""));
  EXPECT_FALSE(ShouldRebindCapture(L"Default", L"Default"));
  // An unreadable input desktop is no destination: staying put beats moving
  // capture somewhere nobody asked for.
  EXPECT_FALSE(ShouldRebindCapture(L"", L"Default"));
}

TEST(WorkerPolicyTest, PointerFreshnessIsPerChannelSoOneStreamCannotSilenceAnother) {
  // Motion travels on the unreliable channel; clicks and the reliable position
  // sample travel on the ordered one. They are one stream of sequence numbers
  // but two independent deliveries, so freshness has to be judged per channel.
  // Judging it against a single shared counter is what stopped the remote
  // cursor following: every click raised the bar above the motion already in
  // flight, and that motion was discarded on arrival.
  bool control_seen = false;
  uint64_t control_last = 0;
  bool pointer_seen = false;
  uint64_t pointer_last = 0;

  EXPECT_TRUE(InputSequenceIsFresh(pointer_seen, pointer_last, 10));
  pointer_seen = true;
  pointer_last = 10;

  EXPECT_TRUE(InputSequenceIsFresh(control_seen, control_last, 11));
  control_seen = true;
  control_last = 11;

  // The next motion still lands, even though a higher sequence was just
  // accepted on the other channel.
  EXPECT_TRUE(InputSequenceIsFresh(pointer_seen, pointer_last, 12));
  pointer_last = 12;

  // A genuine replay on that same channel is still refused.
  EXPECT_FALSE(InputSequenceIsFresh(pointer_seen, pointer_last, 12));
  EXPECT_FALSE(InputSequenceIsFresh(pointer_seen, pointer_last, 11));

  // And the reliable channel keeps its own ordering.
  EXPECT_FALSE(InputSequenceIsFresh(control_seen, control_last, 11));
  EXPECT_TRUE(InputSequenceIsFresh(control_seen, control_last, 13));
}

TEST(WorkerPolicyTest, WakesTheLockCurtainBeforeItTypesAnything) {
  // A locked machine rests on the curtain, which has no password box at all,
  // so a session that connects to it finds nothing to type into. That is why
  // typing alone never fired: the sign-in desktop is only reached after a key.
  EXPECT_EQ(SelectAutoUnlockStep(true, true, true, true, false, 0, 0),
            AutoUnlockStep::kRaiseCredentialUi);
  EXPECT_EQ(SelectAutoUnlockStep(true, true, true, true, true, 1, 0),
            AutoUnlockStep::kTypeSecret);
  // Waking is bounded too: the curtain can swallow a keystroke, but not
  // forever.
  EXPECT_EQ(SelectAutoUnlockStep(true, true, true, true, false,
                                 kAutoUnlockRaiseAttemptsPerLock, 0),
            AutoUnlockStep::kNone);
  // One typed attempt per lock: a wrong password must never loop an account
  // into a lockout.
  EXPECT_EQ(SelectAutoUnlockStep(true, true, true, true, true, 1,
                                 kAutoUnlockAttemptsPerLock),
            AutoUnlockStep::kNone);
  // Every guard is independently sufficient to refuse.
  EXPECT_EQ(SelectAutoUnlockStep(false, true, true, true, true, 0, 0),
            AutoUnlockStep::kNone);
  EXPECT_EQ(SelectAutoUnlockStep(true, false, true, true, true, 0, 0),
            AutoUnlockStep::kNone);
  EXPECT_EQ(SelectAutoUnlockStep(true, true, false, true, true, 0, 0),
            AutoUnlockStep::kNone);
  // An unlocked session is never typed into, whatever desktop it reports.
  EXPECT_EQ(SelectAutoUnlockStep(true, true, true, false, true, 0, 0),
            AutoUnlockStep::kNone);
}

TEST(WorkerPolicyTest, LetsAControllerRetryTheUnlockItAskedFor) {
  // Not once-per-lock: the operator asked, and the sign-in UI is exactly where
  // a single attempt can silently do nothing.
  EXPECT_TRUE(ShouldAcceptUnlockRequest(true, true, true, true));
  EXPECT_FALSE(ShouldAcceptUnlockRequest(false, true, true, true));
  EXPECT_FALSE(ShouldAcceptUnlockRequest(true, false, true, true));
  EXPECT_FALSE(ShouldAcceptUnlockRequest(true, true, false, true));
  // Nothing to unlock on a session that is not locked.
  EXPECT_FALSE(ShouldAcceptUnlockRequest(true, true, true, false));
}

TEST(WorkerPolicyTest, KeepsTheClipboardOnTheSignedInDesktopOnly) {
  EXPECT_TRUE(ClipboardAllowedOnDesktop(L"Default"));
  EXPECT_FALSE(ClipboardAllowedOnDesktop(L"Winlogon"));
  EXPECT_FALSE(ClipboardAllowedOnDesktop(L""));
  EXPECT_FALSE(ClipboardAllowedOnDesktop(L"Screen-saver"));
}

TEST(WorkerPolicyTest, TreatsLockAndUnlockAsAFollowRatherThanAnEnding) {
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentSessionLocked),
            WorkerEnvironmentAction::kFollowDesktop);
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentSessionUnlocked),
            WorkerEnvironmentAction::kFollowDesktop);
  // A logoff or a suspend arriving with the lock still ends the session.
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentSessionLocked |
                                          kEnvironmentSessionUnavailable),
            WorkerEnvironmentAction::kStopProtected);
  EXPECT_EQ(SelectWorkerEnvironmentAction(kEnvironmentSessionLocked |
                                          kEnvironmentSuspend),
            WorkerEnvironmentAction::kStopProtected);
}

TEST(WorkerPolicyTest, EngagesGdiAfterAnyRunOfFailedCaptures) {
  EXPECT_GT(kGdiFallbackDxgiProbeTicks, kFirstFrameWaitsBeforeGdiFallback);
  EXPECT_LT(kGdiFallbackDxgiProbeTicks, kGdiFallbackDxgiRetryTicks);
  int waits = 0;
  for (int attempt = 1; attempt < kFirstFrameWaitsBeforeGdiFallback; ++attempt) {
    EXPECT_FALSE(AdvanceGdiFallbackState(false, true, &waits));
  }
  EXPECT_TRUE(AdvanceGdiFallbackState(false, true, &waits));
  EXPECT_EQ(waits, 0);

  // A capture that succeeds clears the streak. The run of failures counts even
  // for a source that streamed happily before: locking a session invalidates
  // DXGI duplication on a desktop that was working a moment earlier.
  waits = 0;
  for (int attempt = 0; attempt < kFirstFrameWaitsBeforeGdiFallback * 2; ++attempt) {
    EXPECT_FALSE(AdvanceGdiFallbackState(true, true, &waits));
  }
  waits = kFirstFrameWaitsBeforeGdiFallback - 1;
  EXPECT_FALSE(AdvanceGdiFallbackState(true, true, &waits));
  EXPECT_EQ(waits, 0);

  // Disallowed fallback and a missing counter both stay closed.
  waits = 0;
  for (int attempt = 0; attempt < kFirstFrameWaitsBeforeGdiFallback * 2; ++attempt) {
    EXPECT_FALSE(AdvanceGdiFallbackState(false, false, &waits));
  }
  EXPECT_FALSE(AdvanceGdiFallbackState(false, true, nullptr));
}

TEST(WorkerPolicyTest, RequiresANewDxgiFrameBeforeLeavingGdiFallback) {
  EXPECT_TRUE(CanReuseCaptureFrameAfterWait(
      CaptureWaitPolicy::kReuseLastFrame, true));
  EXPECT_FALSE(CanReuseCaptureFrameAfterWait(
      CaptureWaitPolicy::kReuseLastFrame, false));
  EXPECT_FALSE(CanReuseCaptureFrameAfterWait(
      CaptureWaitPolicy::kRequireFreshFrame, true));
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

TEST(WorkerPolicyTest, RejectsHalfHeadlessPhysicalOutput) {
  EXPECT_FALSE(DisplayOutputIsPresentable(false, false));
  EXPECT_TRUE(DisplayOutputIsPresentable(false, true));
  EXPECT_TRUE(DisplayOutputIsPresentable(true, false));
  EXPECT_TRUE(DisplayOutputIsPresentable(true, true));
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

TEST(WorkerPolicyTest, KeepsTheScreensOwnModeInTheOfferedList) {
  // Drivers enumerate in their own order and repeat every size once per refresh
  // rate and colour depth, so the list is deduplicated, sorted and only then
  // trimmed — and the mode the screen is actually running is never the one
  // dropped, whatever the driver reported.
  std::vector<DisplayMode> modes{{1280, 720}, {1280, 720}, {1600, 900},
                                 {320, 240},  {1024, 768}};
  FinalizeDisplayModeList(&modes, 1366, 768);
  ASSERT_EQ(modes.size(), 4u);
  EXPECT_EQ(modes[0].width, 1600);
  EXPECT_EQ(modes[1].width, 1366);  // the current mode, absent from the driver
  EXPECT_EQ(modes[2].width, 1280);
  EXPECT_EQ(modes[3].width, 1024);

  // Beyond the cap the current mode still survives, at the cost of the
  // smallest size that would otherwise have made it.
  std::vector<DisplayMode> many;
  for (size_t index = 0; index < kMaxDisplayModes + 4; ++index) {
    many.push_back({3840 - static_cast<int>(index) * 8, 2160});
  }
  FinalizeDisplayModeList(&many, 800, 600);
  EXPECT_EQ(many.size(), kMaxDisplayModes);
  EXPECT_TRUE(std::any_of(many.begin(), many.end(), [](const DisplayMode& mode) {
    return mode.width == 800 && mode.height == 600;
  }));

  // A display whose driver reports nothing still offers what it is running.
  std::vector<DisplayMode> empty;
  FinalizeDisplayModeList(&empty, 1920, 1080);
  ASSERT_EQ(empty.size(), 1u);
  EXPECT_EQ(empty[0].height, 1080);

  // A current mode outside the bounds is not smuggled in by being current.
  std::vector<DisplayMode> tiny;
  FinalizeDisplayModeList(&tiny, 320, 240);
  EXPECT_TRUE(tiny.empty());
}

TEST(WorkerPolicyTest, BoundsDisplayModesInsteadOfEnumeratingThem) {
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(1280, 720));
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(3840, 2160));
  // Which resolutions exist is the driver's answer. A monitor-less GPU usually
  // offers exactly 1024x768, and refusing it here is what left the operator
  // clicking sizes that could never apply.
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(1024, 768));
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(800, 600));
  EXPECT_TRUE(IsAllowedRemoteDisplayMode(3840, 1080));
  // Bounds still hold.
  EXPECT_FALSE(IsAllowedRemoteDisplayMode(320, 240));
  EXPECT_FALSE(IsAllowedRemoteDisplayMode(kMaxRemoteDisplayEdge + 1, 1080));
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
  // An arbitrary driver-reported size still lands in a band.
  EXPECT_EQ(RecommendedRemoteDisplayScale(1600, 900), 125);
  EXPECT_EQ(RecommendedRemoteDisplayScale(2048, 1152), 150);
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

// REPRODUCTION: prior to the empty-topology-grace fix, the worker had no
// bounded counter between transient DXGI/DWM dips and the terminal
// `media_unavailable` emission in Maintenance() / RefreshTopologyOnSignaling()
// / RefreshDisplays(). This test calls the helper that did not yet exist and
// the constant that did not yet exist. On the unfixed worker, this file fails
// to compile (proving the missing bounded grace), then passes once the helper
// lands in worker_policy.{h,cc} and is wired into worker_main.cc.
TEST(WorkerPolicyTest, DelaysEmptyTopologyActionUntilGraceExceeded) {
  EXPECT_EQ(kEmptyTopologyGraceTicks, kTopologyRefreshDebounceTicks);

  int consecutive = 0;
  for (int tick = 1; tick < kEmptyTopologyGraceTicks; ++tick) {
    EXPECT_FALSE(AdvanceEmptyTopologyConsecutive(&consecutive));
  }
  EXPECT_FALSE(AdvanceEmptyTopologyConsecutive(&consecutive));
  EXPECT_TRUE(AdvanceEmptyTopologyConsecutive(&consecutive));
  EXPECT_EQ(consecutive, 0);
  EXPECT_FALSE(AdvanceEmptyTopologyConsecutive(nullptr));
}

}  // namespace
}  // namespace imcodes::rd
