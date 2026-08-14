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

TEST(QualityLadderTest, EnforcesPerPeerAndAggregateBitrateBudgets) {
  EXPECT_EQ(ClampAggregateVideoBitrate(20'000'000, 0, 0), 15'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(15'000'000, 0, 50'000'000),
            10'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(15'000'000, 12'000'000, 57'000'000),
            15'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(1'000'000, 0, 60'000'000), 0u);
}

}  // namespace
}  // namespace imcodes::rd
