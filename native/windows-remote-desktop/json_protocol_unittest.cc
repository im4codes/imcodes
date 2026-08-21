#include "third_party/imcodes_remote_desktop/json_protocol.h"

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

constexpr int64_t kNowMs = 1'000'000;

Json::Value AuthorityBase(const char* type) {
  Json::Value root(Json::objectValue);
  root["type"] = type;
  root["requestId"] = "request_12345678";
  root["sessionId"] = "session_12345678";
  root["capability"] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return root;
}

TEST(JsonProtocolTest, AcceptsOnlyExactBoundedPrepareAuthority) {
  Json::Value root = AuthorityBase(kPrepareType);
  root["expiresAt"] = Json::Int64(kNowMs + 120'000);
  root["leaseExpiresAt"] = Json::Int64(kNowMs + 15'000);
  root["daemonGeneration"] = 7;
  root["mode"] = kViewMode;
  root["inputEpoch"] = 0;
  root["reconnectAttempt"] = 3;
  Json::Value ice(Json::arrayValue);
  ice.append("stun:stun.example.test:3478");
  root["iceServers"] = ice;

  const auto parsed = ParseServiceSignal(root, kNowMs);
  ASSERT_TRUE(parsed.has_value());
  EXPECT_EQ(parsed->kind, Signal::Kind::kPrepare);
  EXPECT_EQ(parsed->authority.daemon_generation, 7);
  EXPECT_EQ(parsed->authority.reconnect_attempt, 3);

  root["reconnectAttempt"] = 4;
  EXPECT_FALSE(ParseServiceSignal(root, kNowMs).has_value());
  root["reconnectAttempt"] = 3;

  root["unexpected"] = true;
  EXPECT_FALSE(ParseServiceSignal(root, kNowMs).has_value());
}

TEST(JsonProtocolTest, AcceptsDefaultControlPrepareAuthority) {
  Json::Value root = AuthorityBase(kPrepareType);
  root["expiresAt"] = Json::Int64(kNowMs + 120'000);
  root["leaseExpiresAt"] = Json::Int64(kNowMs + 15'000);
  root["daemonGeneration"] = 7;
  root["mode"] = kControlMode;
  root["inputEpoch"] = 1;
  Json::Value ice(Json::arrayValue);
  ice.append("stun:stun.example.test:3478");
  root["iceServers"] = ice;

  const auto parsed = ParseServiceSignal(root, kNowMs);
  ASSERT_TRUE(parsed.has_value());
  EXPECT_EQ(parsed->authority.mode, kControlMode);
  EXPECT_EQ(parsed->authority.input_epoch, 1);
}

TEST(JsonProtocolTest, RejectsExpiredAndOverlongLeaseAuthorities) {
  Json::Value root = AuthorityBase(kLeaseType);
  root["leaseExpiresAt"] = Json::Int64(kNowMs);
  root["daemonGeneration"] = 7;
  root["mode"] = kViewMode;
  root["inputEpoch"] = 0;
  EXPECT_FALSE(ParseServiceSignal(root, kNowMs).has_value());

  root["leaseExpiresAt"] = Json::Int64(kNowMs + kLeaseMaxFutureMs + 1);
  EXPECT_FALSE(ParseServiceSignal(root, kNowMs).has_value());
}

TEST(JsonProtocolTest, AcceptsTheBoundedSixtySecondControllerLease) {
  Json::Value root = AuthorityBase(kLeaseType);
  root["leaseExpiresAt"] = Json::Int64(kNowMs + 60'000);
  root["daemonGeneration"] = 7;
  root["mode"] = kViewMode;
  root["inputEpoch"] = 0;

  const auto parsed = ParseServiceSignal(root, kNowMs);
  ASSERT_TRUE(parsed.has_value());
  EXPECT_EQ(parsed->authority.lease_expires_at_ms, kNowMs + 60'000);
}

TEST(JsonProtocolTest, RejectsUnknownModeReasonAndMalformedCapability) {
  Json::Value root = AuthorityBase(kModeStateType);
  root["mode"] = kControlMode;
  root["inputEpoch"] = 1;
  root["reason"] = "worker_decided";
  EXPECT_FALSE(ParseServiceSignal(root, kNowMs).has_value());

  root["reason"] = "user_selected";
  ASSERT_TRUE(ParseServiceSignal(root, kNowMs).has_value());
  root["capability"] = "too-short";
  EXPECT_FALSE(ParseServiceSignal(root, kNowMs).has_value());
}

TEST(JsonProtocolTest, StrictJsonParserRejectsTrailingContent) {
  Json::Value value;
  EXPECT_TRUE(ParseJson("{\"value\":1}", &value));
  EXPECT_FALSE(ParseJson("{\"value\":1} trailing", &value));
  EXPECT_FALSE(ParseJson("[]", &value));
}

}  // namespace
}  // namespace imcodes::rd
