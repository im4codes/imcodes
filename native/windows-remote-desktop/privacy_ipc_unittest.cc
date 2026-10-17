#include "third_party/imcodes_remote_desktop/privacy_ipc.h"

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

Json::Value Route(const char* id, Json::Int64 generation) {
  Json::Value route(Json::objectValue);
  route["routeId"] = id;
  route["routeGeneration"] = generation;
  return route;
}

Json::Value Shield() {
  Json::Value root(Json::objectValue);
  root["type"] = privacy_ipc::kShield;
  root["epochId"] = "epoch_1234567890";
  root["revision"] = Json::Int64(7);
  root["presentationSource"] = "signed_shell";
  Json::Value routes(Json::arrayValue);
  routes.append(Route("route_1234567890", 11));
  routes.append(Route("route_8765432109", 12));
  root["routes"] = routes;
  return root;
}

TEST(PrivacyIpcTest, ParsesExactNonEmptyExpectedRouteSnapshot) {
  const auto parsed = ParsePrivacyFrame(Shield());
  ASSERT_TRUE(parsed.has_value());
  EXPECT_EQ(parsed->kind, PrivacyFrameKind::kShield);
  EXPECT_EQ(parsed->revision, 7);
  ASSERT_EQ(parsed->expected_routes.size(), 2u);
  EXPECT_EQ(parsed->expected_routes[0].route_id, "route_1234567890");
  EXPECT_EQ(parsed->expected_routes[0].route_generation, 11);
}

TEST(PrivacyIpcTest, RejectsEmptyDuplicateAndMalformedRouteSnapshots) {
  Json::Value empty = Shield();
  empty["routes"] = Json::Value(Json::arrayValue);
  EXPECT_FALSE(ParsePrivacyFrame(empty).has_value());

  Json::Value duplicate = Shield();
  duplicate["routes"].append(Route("route_1234567890", 13));
  EXPECT_FALSE(ParsePrivacyFrame(duplicate).has_value());

  Json::Value negative = Shield();
  negative["routes"][Json::ArrayIndex{0}]["routeGeneration"] =
      Json::Int64(-1);
  EXPECT_FALSE(ParsePrivacyFrame(negative).has_value());

  Json::Value unsafe = Shield();
  unsafe["routes"][Json::ArrayIndex{0}]["routeGeneration"] =
      Json::Int64(9'007'199'254'740'992LL);
  EXPECT_FALSE(ParsePrivacyFrame(unsafe).has_value());

  Json::Value extra = Shield();
  extra["routes"][Json::ArrayIndex{0}]["daemonGeneration"] = 99;
  EXPECT_FALSE(ParsePrivacyFrame(extra).has_value());
}

TEST(PrivacyIpcTest, RequiresExactRevisionForRelease) {
  Json::Value release(Json::objectValue);
  release["type"] = privacy_ipc::kRelease;
  release["epochId"] = "epoch_1234567890";
  EXPECT_FALSE(ParsePrivacyFrame(release).has_value());
  release["revision"] = Json::Int64(7);
  const auto parsed = ParsePrivacyFrame(release);
  ASSERT_TRUE(parsed.has_value());
  EXPECT_EQ(parsed->kind, PrivacyFrameKind::kRelease);
  EXPECT_EQ(parsed->revision, 7);
}

TEST(PrivacyIpcTest, ShieldedEnvelopeCarriesExactRevisionAndRoutes) {
  const std::vector<PrivacyRouteGeneration> routes{
      {"route_1234567890", 11}, {"route_8765432109", 12}};
  const Json::Value envelope =
      PrivacyShieldedEnvelope("epoch_1234567890", 7, 23, true, routes);
  EXPECT_EQ(envelope["revision"].asInt64(), 7);
  ASSERT_EQ(envelope["routes"].size(), 2u);
  EXPECT_EQ(envelope["routes"][1]["routeGeneration"].asInt64(), 12);
}

}  // namespace
}  // namespace imcodes::rd
