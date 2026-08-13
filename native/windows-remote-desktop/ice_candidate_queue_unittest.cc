#include "third_party/imcodes_remote_desktop/ice_candidate_queue.h"

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

TEST(PendingRemoteIceCandidatesTest, PreservesTrickleOrderUntilRemoteSdp) {
  PendingRemoteIceCandidates pending(3);
  EXPECT_TRUE(pending.Push("0", "candidate:first"));
  EXPECT_TRUE(pending.Push("0", "candidate:second"));

  std::vector<PendingRemoteIceCandidate> values = pending.TakeAll();
  ASSERT_EQ(values.size(), 2u);
  EXPECT_EQ(values[0].candidate, "candidate:first");
  EXPECT_EQ(values[1].candidate, "candidate:second");
  EXPECT_EQ(pending.size(), 0u);
}

TEST(PendingRemoteIceCandidatesTest, IsBoundedAndClearIsIdempotent) {
  PendingRemoteIceCandidates pending(1);
  EXPECT_TRUE(pending.Push("0", "candidate:first"));
  EXPECT_FALSE(pending.Push("0", "candidate:overflow"));
  EXPECT_EQ(pending.size(), 1u);
  pending.Clear();
  pending.Clear();
  EXPECT_EQ(pending.size(), 0u);
}

}  // namespace
}  // namespace imcodes::rd
