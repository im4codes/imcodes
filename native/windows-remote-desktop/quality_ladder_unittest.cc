#include "third_party/imcodes_remote_desktop/quality_ladder.h"

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

TEST(QualityLadderTest, MapsOnlyUpstreamBitrateToFixedPresets) {
  EXPECT_STREQ(SelectQuality(15'000'000, 3840, 2160).id, "2160p30");
  EXPECT_STREQ(SelectQuality(12'000'000, 3840, 2160).id, "2160p15");
  EXPECT_STREQ(SelectQuality(10'000'000, 3840, 2160).id, "1440p30");
  EXPECT_STREQ(SelectQuality(15'000'000, 1920, 1080).id, "1080p30");
  EXPECT_STREQ(SelectQuality(4'500'000, 1920, 1080).id, "900p30");
  EXPECT_STREQ(SelectQuality(3'000'000, 1920, 1080).id, "720p30");
  EXPECT_STREQ(SelectQuality(2'999'999, 1920, 1080).id, "720p15");
  EXPECT_STREQ(SelectQuality(1, 1920, 1080).id, "360p5");
}

TEST(QualityLadderTest, SeedsDirectLinksHighWithoutRaisingCongestionFloor) {
  const TransportBitratePolicy direct = SelectTransportBitratePolicy(true);
  EXPECT_EQ(direct.min_bps, 350'000u);
  EXPECT_EQ(direct.start_bps, 12'000'000u);
  EXPECT_EQ(direct.max_bps, 15'000'000u);

  const TransportBitratePolicy relayed = SelectTransportBitratePolicy(false);
  EXPECT_EQ(relayed.min_bps, direct.min_bps);
  EXPECT_EQ(relayed.start_bps, 1'500'000u);
  EXPECT_EQ(relayed.max_bps, direct.max_bps);
}

TEST(QualityLadderTest, NeverUpscalesAndPreservesAspect) {
  const QualitySelection small = SelectQuality(15'000'000, 1366, 768);
  EXPECT_EQ(small.width, 1280);
  EXPECT_EQ(small.height, 718);
  const QualitySelection portrait = SelectQuality(3'000'000, 1080, 1920);
  EXPECT_EQ(portrait.width, 404);
  EXPECT_EQ(portrait.height, 720);
  EXPECT_EQ(portrait.width % 2, 0);
  EXPECT_EQ(portrait.height % 2, 0);
}

TEST(QualityLadderTest, ClampsBitrateAndFps) {
  const QualitySelection low = SelectQuality(0, 1920, 1080);
  EXPECT_EQ(low.bitrate_bps, 350'000u);
  EXPECT_EQ(low.fps, 5);
  const QualitySelection high = SelectQuality(UINT32_MAX, 3840, 2160);
  EXPECT_EQ(high.bitrate_bps, 15'000'000u);
  EXPECT_EQ(high.fps, 30);
}

TEST(QualityLadderTest, OffersSixtyFpsOnlyWhenTheViewerAllowsIt) {
  QualityPreference sixty;
  sixty.max_fps = 60;
  EXPECT_STREQ(SelectQuality(15'000'000, 2560, 1440).id, "1440p30");
  EXPECT_STREQ(SelectQuality(15'000'000, 2560, 1440, sixty).id, "1440p60");
  EXPECT_STREQ(SelectQuality(9'000'000, 1920, 1080, sixty).id, "1080p60");
}

TEST(QualityLadderTest, SmoothKeepsFrameRateByShedResolution) {
  QualityPreference smooth;
  smooth.max_height = 1080;
  smooth.priority = QualityPriority::kFramerate;
  EXPECT_STREQ(SelectQuality(15'000'000, 5120, 2880, smooth).id, "1080p30");
  EXPECT_STREQ(SelectQuality(2'000'000, 5120, 2880, smooth).id, "540p30");
  EXPECT_STREQ(SelectQuality(800'000, 5120, 2880, smooth).id, "360p30");
  // Below every 30 fps rung the frame rate finally gives way.
  EXPECT_STREQ(SelectQuality(500'000, 5120, 2880, smooth).id, "720p10");
}

TEST(QualityLadderTest, SharpKeepsResolutionByShedFrameRate) {
  QualityPreference sharp;
  sharp.priority = QualityPriority::kResolution;
  EXPECT_STREQ(SelectQuality(12'000'000, 3840, 2160, sharp).id, "2160p15");
  EXPECT_STREQ(SelectQuality(800'000, 1920, 1080, sharp).id, "720p10");
}

TEST(QualityLadderTest, SaverCapsResolutionFrameRateAndBitrate) {
  QualityPreference saver;
  saver.max_height = 720;
  saver.max_fps = 15;
  saver.max_bitrate_bps = 1'800'000;
  const QualitySelection selected = SelectQuality(15'000'000, 1920, 1080, saver);
  EXPECT_STREQ(selected.id, "720p15");
  EXPECT_EQ(selected.bitrate_bps, 1'800'000u);
}

TEST(QualityLadderTest, RelayCapBindsOnlyRelayedSessions) {
  const TransportBitratePolicy relayed = SelectTransportBitratePolicy(false, 500'000);
  EXPECT_EQ(relayed.start_bps, 500'000u);
  EXPECT_EQ(relayed.max_bps, 500'000u);
  EXPECT_EQ(relayed.min_bps, 350'000u);
  EXPECT_EQ(SelectTransportBitratePolicy(true, 500'000).max_bps, 15'000'000u);
  EXPECT_EQ(EffectiveBitrateCap(0, 500'000, false), 500'000u);
  EXPECT_EQ(EffectiveBitrateCap(0, 500'000, true), 0u);
  EXPECT_EQ(EffectiveBitrateCap(2'000'000, 500'000, false), 500'000u);
  QualityPreference capped;
  capped.max_bitrate_bps = EffectiveBitrateCap(0, 500'000, false);
  const QualitySelection selected = SelectQuality(15'000'000, 1920, 1080, capped);
  EXPECT_STREQ(selected.id, "720p10");
  EXPECT_EQ(selected.bitrate_bps, 500'000u);
}

TEST(QualityLadderTest, EnforcesPerPeerAndAggregateBitrateBudgets) {
  EXPECT_EQ(ClampAggregateVideoBitrate(20'000'000, 0, 0), 15'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(15'000'000, 0, 50'000'000),
            10'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(15'000'000, 12'000'000, 57'000'000),
            15'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(1'000'000, 0, 60'000'000), 0u);
}

TEST(QualityLadderTest, BacklogPressureLeavesAnUnstrugglingEncoderAlone) {
  EXPECT_EQ(ApplyEncodeBacklogPressure(6'000'000, 0), 6'000'000u);
}

TEST(QualityLadderTest, BacklogPressureNeverIncreasesTheTarget) {
  uint32_t previous = 6'000'000;
  for (uint32_t pressure = 1; pressure <= 24; ++pressure) {
    const uint32_t current = ApplyEncodeBacklogPressure(6'000'000, pressure);
    EXPECT_LE(current, previous);
    EXPECT_LE(current, 6'000'000u);
    EXPECT_GE(current, kMinVideoBitrateBps);
    previous = current;
  }
}

TEST(QualityLadderTest, BacklogPressureNeverDropsBelowTheMinimumFloor) {
  EXPECT_EQ(ApplyEncodeBacklogPressure(400'000, 12), kMinVideoBitrateBps);
  EXPECT_EQ(ApplyEncodeBacklogPressure(400'000, 24), kMinVideoBitrateBps);
}

TEST(QualityLadderTest, BacklogPressureLeavesATargetBelowTheFloorAlone) {
  // A fresh path reports targets below the floor; there is nothing left to
  // discount, and the result must never be raised above the target.
  EXPECT_EQ(ApplyEncodeBacklogPressure(34'167, 3), 34'167u);
  EXPECT_EQ(ApplyEncodeBacklogPressure(kMinVideoBitrateBps, 12),
            kMinVideoBitrateBps);
}

TEST(QualityLadderTest, BacklogPressureFeedsBackIntoALowerLadderRung) {
  // Sustained local backlog lands on a smaller/slower rung than the network
  // alone would have chosen, entirely independent of congestion control.
  const QualitySelection unpressured = SelectQuality(6'000'000, 1920, 1080);
  EXPECT_STREQ(unpressured.id, "1080p30");

  const uint32_t pressured_bitrate =
      ApplyEncodeBacklogPressure(6'000'000, 9);
  const QualitySelection pressured =
      SelectQuality(pressured_bitrate, 1920, 1080);
  EXPECT_STRNE(pressured.id, unpressured.id);
}

}  // namespace
}  // namespace imcodes::rd
