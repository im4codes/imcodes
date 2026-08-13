#include "third_party/imcodes_remote_desktop/quality_ladder.h"

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

TEST(QualityLadderTest, MapsOnlyUpstreamBitrateToFixedPresets) {
  EXPECT_STREQ(SelectQuality(8'000'000, 3840, 2160).id, "2160p15");
  EXPECT_STREQ(SelectQuality(7'999'999, 3840, 2160).id, "1080p30");
  EXPECT_STREQ(SelectQuality(4'500'000, 1920, 1080).id, "900p30");
  EXPECT_STREQ(SelectQuality(3'000'000, 1920, 1080).id, "720p30");
  EXPECT_STREQ(SelectQuality(1'800'000, 1920, 1080).id, "720p15");
  EXPECT_STREQ(SelectQuality(1'000'000, 1920, 1080).id, "540p15");
  EXPECT_STREQ(SelectQuality(1, 1920, 1080).id, "360p5");
}

TEST(QualityLadderTest, NeverUpscalesAndPreservesAspect) {
  const QualitySelection small = SelectQuality(8'000'000, 1366, 768);
  EXPECT_EQ(small.width, 1366);
  EXPECT_EQ(small.height, 768);
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
  EXPECT_EQ(high.bitrate_bps, 8'000'000u);
  EXPECT_EQ(high.fps, 15);
}

TEST(QualityLadderTest, EnforcesPerPeerAndAggregateBitrateBudgets) {
  EXPECT_EQ(ClampAggregateVideoBitrate(20'000'000, 0, 0), 8'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(8'000'000, 0, 20'000'000),
            4'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(8'000'000, 6'000'000, 22'000'000),
            8'000'000u);
  EXPECT_EQ(ClampAggregateVideoBitrate(1'000'000, 0, 24'000'000), 0u);
}

}  // namespace
}  // namespace imcodes::rd
