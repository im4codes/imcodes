#include "third_party/imcodes_remote_desktop/privacy_ipc.h"

#include <algorithm>

namespace imcodes::rd {
namespace {

bool StringField(const Json::Value& root, const char* key, std::string* out) {
  if (!root.isMember(key) || !root[key].isString()) return false;
  *out = root[key].asString();
  return true;
}

bool NonNegativeIntField(const Json::Value& root, const char* key,
                         int64_t* out) {
  if (!root.isMember(key) || !root[key].isIntegral()) return false;
  const Json::Int64 value = root[key].asInt64();
  if (value < 0 || value > 9'007'199'254'740'991LL) return false;
  *out = value;
  return true;
}

bool RouteListField(const Json::Value& root, const char* key,
                    std::vector<PrivacyRouteGeneration>* out) {
  if (!root.isMember(key) || !root[key].isArray() || root[key].size() == 0 ||
      root[key].size() > 16) {
    return false;
  }
  for (const Json::Value& entry : root[key]) {
    if (!entry.isObject() || entry.getMemberNames().size() != 2) return false;
    PrivacyRouteGeneration route{};
    if (!StringField(entry, "routeId", &route.route_id) ||
        !IsSafeId(route.route_id) ||
        !NonNegativeIntField(entry, "routeGeneration",
                             &route.route_generation) ||
        std::any_of(out->begin(), out->end(), [&](const auto& existing) {
          return existing.route_id == route.route_id;
        })) {
      return false;
    }
    out->push_back(std::move(route));
  }
  return true;
}

}  // namespace

std::optional<PrivacyFrame> ParsePrivacyFrame(const Json::Value& root) {
  if (!root.isObject() || !root.isMember("type") || !root["type"].isString()) {
    return std::nullopt;
  }
  const std::string type = root["type"].asString();
  const bool is_shield = type == privacy_ipc::kShield;
  if (!is_shield && type != privacy_ipc::kRelease) return std::nullopt;
  const Json::Value::Members members = root.getMemberNames();
  if ((is_shield && members.size() != 5) ||
      (!is_shield && members.size() != 3)) {
    return std::nullopt;
  }

  PrivacyFrame frame{};
  frame.kind = is_shield ? PrivacyFrameKind::kShield : PrivacyFrameKind::kRelease;
  if (!StringField(root, "epochId", &frame.epoch_id)) return std::nullopt;
  // Same id shape the rest of the contract uses; a short or exotic id is a
  // protocol error, not something to normalise.
  if (!IsSafeId(frame.epoch_id)) return std::nullopt;

  if (is_shield) {
    if (!NonNegativeIntField(root, "revision", &frame.revision)) {
      return std::nullopt;
    }
    if (!StringField(root, "presentationSource", &frame.presentation_source)) {
      return std::nullopt;
    }
    if (frame.presentation_source.empty() ||
        !RouteListField(root, "routes", &frame.expected_routes)) {
      return std::nullopt;
    }
  } else {
    // RELEASE ends exactly one durable revision. An absent revision is not a
    // request to release whichever shield happens to be active.
    if (!NonNegativeIntField(root, "revision", &frame.revision)) {
      return std::nullopt;
    }
  }
  return frame;
}

Json::Value PrivacyShieldedEnvelope(
    const std::string& epoch_id,
    int64_t revision,
    int64_t worker_generation,
    bool input_released,
    const std::vector<PrivacyRouteGeneration>& routes) {
  Json::Value root(Json::objectValue);
  root["type"] = privacy_ipc::kShielded;
  root["epochId"] = epoch_id;
  root["revision"] = static_cast<Json::Int64>(revision);
  root["workerGeneration"] = static_cast<Json::Int64>(worker_generation);
  root["inputReleased"] = input_released;
  Json::Value list(Json::arrayValue);
  for (const PrivacyRouteGeneration& route : routes) {
    Json::Value entry(Json::objectValue);
    entry["routeId"] = route.route_id;
    entry["routeGeneration"] = static_cast<Json::Int64>(route.route_generation);
    list.append(entry);
  }
  // Always present, even when empty: an absent array would be indistinguishable
  // from "the worker forgot to report routes", and the node would then ack a
  // set it never actually saw.
  root["routes"] = list;
  return root;
}

Json::Value PrivacyReleasedEnvelope(const std::string& epoch_id,
                                    bool secret_cleanup_complete,
                                    int64_t fresh_frame_worker_generation) {
  Json::Value root(Json::objectValue);
  root["type"] = privacy_ipc::kReleased;
  root["epochId"] = epoch_id;
  root["secretCleanupComplete"] = secret_cleanup_complete;
  root["freshFrameWorkerGeneration"] =
      static_cast<Json::Int64>(fresh_frame_worker_generation);
  return root;
}

}  // namespace imcodes::rd
