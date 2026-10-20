#include "../remote-desktop-common/local_management_ipc.h"

#include <cstdint>
#include <string>
#include <vector>

#include "../remote-desktop-common/json_protocol.h"
#include "test/gtest.h"

namespace imcodes::remote_desktop::common {
namespace {

std::string Payload(const std::string& frame) {
  EXPECT_GE(frame.size(), 4U);
  const auto length =
      (static_cast<std::uint32_t>(static_cast<unsigned char>(frame[0])) << 24U) |
      (static_cast<std::uint32_t>(static_cast<unsigned char>(frame[1])) << 16U) |
      (static_cast<std::uint32_t>(static_cast<unsigned char>(frame[2])) << 8U) |
      static_cast<std::uint32_t>(static_cast<unsigned char>(frame[3]));
  EXPECT_EQ(frame.size(), static_cast<std::size_t>(length) + 4U);
  return frame.substr(4);
}

std::string Welcome(std::uint64_t revision = 1) {
  return "{\"type\":\"aidesk_local.welcome\",\"protocolVersion\":1,"
         "\"runtimeVersion\":\"2026.9.1\",\"productVersion\":\"2026.9.1\","
         "\"sessionId\":\"session_1234567890\","
         "\"capability\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\","
         "\"capabilityExpiresAt\":1700000300000,\"snapshot\":{"
         "\"type\":\"aidesk_local.snapshot\",\"protocolVersion\":1,"
         "\"revision\":" + std::to_string(revision) +
         ",\"publicNodeId\":\"9535523706\",\"serviceState\":\"ready\","
         "\"accessState\":\"ready\",\"paused\":false,"
         "\"managementUrl\":\"https://im.codes/?aideskAction=manage\","
         "\"shareUrl\":\"https://im.codes/?aideskAction=share\","
         "\"connections\":[{"
         "\"id\":\"connection_123456\",\"label\":\"Alice\","
         "\"connectedAt\":1700000000000,\"durationMs\":10000,"
         "\"mode\":\"control\"}]}}";
}

TEST(LocalManagementIpcTest, EncodesHelloAndAuthenticatedActions) {
  LocalManagementClientCore client(
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "1.0.0", "2026.9.1");
  const auto hello = client.EncodeHello("nonce_1234567890");
  ASSERT_TRUE(hello.has_value());
  Json::Value hello_json;
  ASSERT_TRUE(imcodes::rd::ParseJson(Payload(*hello), &hello_json));
  EXPECT_EQ(hello_json["type"].asString(), kLocalManagementHelloType);
  EXPECT_EQ(hello_json["productVersion"].asString(), "2026.9.1");
  EXPECT_FALSE(client.EncodeAction("request_12345678", 1,
                                   LocalManagementAction::kPause)
                   .has_value());

  const auto welcome_frame = EncodeLocalManagementFrame(Welcome());
  ASSERT_TRUE(welcome_frame.has_value());
  std::vector<LocalManagementEvent> events;
  ASSERT_TRUE(client.Consume(welcome_frame->substr(0, 7), &events));
  EXPECT_TRUE(events.empty());
  ASSERT_TRUE(client.Consume(welcome_frame->substr(7), &events));
  ASSERT_EQ(events.size(), 1U);
  ASSERT_TRUE(events[0].welcome.has_value());
  EXPECT_EQ(events[0].welcome->snapshot.connections.size(), 1U);
  EXPECT_EQ(events[0].welcome->snapshot.connections[0].role,
            LocalManagementConnectionRole::kControl);

  const auto action = client.EncodeAction(
      "request_12345678", 1, LocalManagementAction::kDisconnect,
      "connection_123456");
  ASSERT_TRUE(action.has_value());
  Json::Value action_json;
  ASSERT_TRUE(imcodes::rd::ParseJson(Payload(*action), &action_json));
  EXPECT_EQ(action_json["capability"].asString(), client.capability());
  EXPECT_EQ(action_json["action"].asString(), "disconnect");
  EXPECT_EQ(action_json["connectionId"].asString(), "connection_123456");
}

TEST(LocalManagementIpcTest, RejectsRollbackAndRecoversOnlyAfterReconnect) {
  LocalManagementClientCore client(
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "1.0.0", "2026.9.1");
  const auto welcome = EncodeLocalManagementFrame(Welcome(2));
  ASSERT_TRUE(welcome.has_value());
  std::vector<LocalManagementEvent> events;
  ASSERT_TRUE(client.Consume(*welcome, &events));

  const std::string stale =
      "{\"type\":\"aidesk_local.snapshot\",\"protocolVersion\":1,"
      "\"revision\":1,\"publicNodeId\":\"9535523706\","
      "\"serviceState\":\"ready\",\"accessState\":\"ready\","
      "\"paused\":false,\"managementUrl\":\"https://im.codes/manage\","
      "\"shareUrl\":\"https://im.codes/share\",\"connections\":[]}";
  const auto stale_frame = EncodeLocalManagementFrame(stale);
  ASSERT_TRUE(stale_frame.has_value());
  EXPECT_FALSE(client.Consume(*stale_frame, &events));
  EXPECT_FALSE(client.EncodeRefresh("refresh_12345678").has_value());
  client.ResetForReconnect();
  EXPECT_FALSE(client.authenticated());
  EXPECT_TRUE(client.EncodeHello("nonce_1234567890").has_value());
}

TEST(LocalManagementIpcTest, RejectsSnapshotBeforeAuthenticatedWelcome) {
  LocalManagementClientCore client(
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "1.0.0", "2026.9.1");
  const std::string snapshot =
      "{\"type\":\"aidesk_local.snapshot\",\"protocolVersion\":1,"
      "\"revision\":1,\"publicNodeId\":\"9535523706\","
      "\"serviceState\":\"ready\",\"accessState\":\"ready\","
      "\"paused\":false,\"managementUrl\":\"https://im.codes/manage\","
      "\"shareUrl\":\"https://im.codes/share\",\"connections\":[]}";
  const auto frame = EncodeLocalManagementFrame(snapshot);
  ASSERT_TRUE(frame.has_value());
  std::vector<LocalManagementEvent> events;
  EXPECT_FALSE(client.Consume(*frame, &events));
  EXPECT_TRUE(events.empty());
}

TEST(LocalManagementIpcTest, AcceptsMultipleMaximumBoundedFramesPerRead) {
  const std::string payload(kLocalManagementMaximumFrameBytes, 'x');
  const auto first = EncodeLocalManagementFrame(payload);
  const auto second = EncodeLocalManagementFrame(payload);
  ASSERT_TRUE(first.has_value());
  ASSERT_TRUE(second.has_value());
  LocalManagementFrameDecoder decoder;
  std::vector<std::string> decoded;
  ASSERT_TRUE(decoder.Push(*first + *second, &decoded));
  ASSERT_EQ(decoded.size(), 2U);
  EXPECT_EQ(decoded[0].size(), kLocalManagementMaximumFrameBytes);
  EXPECT_EQ(decoded[1].size(), kLocalManagementMaximumFrameBytes);
}

}  // namespace
}  // namespace imcodes::remote_desktop::common
