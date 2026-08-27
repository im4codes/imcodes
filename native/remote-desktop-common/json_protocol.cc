#include "json_protocol.h"

#include <algorithm>
#include <memory>
#include <set>
#include <string_view>
#include <utility>

#include "json/reader.h"
#include "json/writer.h"

namespace imcodes::rd {
namespace {

bool ExactKeys(const Json::Value& value,
               std::initializer_list<const char*> keys,
               std::initializer_list<const char*> optional = {}) {
  if (!value.isObject()) return false;
  std::set<std::string> expected;
  for (const char* key : keys) expected.insert(key);
  for (const char* key : optional) {
    if (value.isMember(key)) expected.insert(key);
  }
  const auto names = value.getMemberNames();
  return names.size() == expected.size() &&
         std::all_of(names.begin(), names.end(), [&](const std::string& key) {
           return expected.contains(key);
         });
}

bool ReadBoundedString(const Json::Value& root,
                       const char* key,
                       size_t max_bytes,
                       std::string* out) {
  const Json::Value& value = root[key];
  if (!value.isString()) return false;
  *out = value.asString();
  return !out->empty() && out->size() <= max_bytes;
}

bool ParseIceServers(const Json::Value& value,
                     std::vector<IceServer>* output) {
  if (!value.isArray() || value.empty() || value.size() > 8) return false;
  for (const Json::Value& entry : value) {
    IceServer server;
    if (entry.isString()) {
      const std::string url = entry.asString();
      if (url.empty() || url.size() > 2048) return false;
      server.urls.push_back(url);
    } else if (ExactKeys(entry, {"urls", "username", "credential"}) &&
               entry["urls"].isArray() && !entry["urls"].empty() &&
               entry["urls"].size() <= 8 && entry["username"].isString() &&
               entry["credential"].isString()) {
      for (const Json::Value& url : entry["urls"]) {
        if (!url.isString() || url.asString().empty() ||
            url.asString().size() > 2048) {
          return false;
        }
        server.urls.push_back(url.asString());
      }
      server.username = entry["username"].asString();
      server.credential = entry["credential"].asString();
      if (server.username.size() > 1024 || server.credential.size() > 1024) {
        return false;
      }
    } else {
      return false;
    }
    output->push_back(std::move(server));
  }
  return true;
}

bool ParseAuthorityFields(const Json::Value& root,
                          int64_t now_ms,
                          bool with_ice,
                          Authority* authority) {
  if (!ReadBoundedString(root, "requestId", 128, &authority->request_id) ||
      !ReadBoundedString(root, "sessionId", 128, &authority->session_id) ||
      !ReadBoundedString(root, "capability", 128, &authority->capability) ||
      !IsSafeId(authority->request_id) || !IsSafeId(authority->session_id) ||
      !IsSafeCapability(authority->capability)) {
    return false;
  }
  if (root.isMember("mode")) {
    if (!root["mode"].isString()) return false;
    authority->mode = root["mode"].asString();
    if (authority->mode != kViewMode && authority->mode != kControlMode) {
      return false;
    }
  }
  if (root.isMember("inputEpoch")) {
    if (!root["inputEpoch"].isInt() || root["inputEpoch"].asInt() < 0) {
      return false;
    }
    authority->input_epoch = root["inputEpoch"].asInt();
  }
  if (root.isMember("daemonGeneration")) {
    if (!root["daemonGeneration"].isInt() ||
        root["daemonGeneration"].asInt() <= 0) {
      return false;
    }
    authority->daemon_generation = root["daemonGeneration"].asInt();
  }
  if (root.isMember("routeGeneration")) {
    constexpr int64_t kMaximumSafeInteger = 9'007'199'254'740'991;
    if (!root["routeGeneration"].isInt64()) return false;
    const int64_t route_generation = root["routeGeneration"].asInt64();
    if (route_generation < 0 || route_generation > kMaximumSafeInteger) {
      return false;
    }
    authority->route_generation = route_generation;
  }
  if (root.isMember("reconnectAttempt")) {
    if (!root["reconnectAttempt"].isInt() ||
        root["reconnectAttempt"].asInt() < 0 ||
        root["reconnectAttempt"].asInt() > 3) {
      return false;
    }
    authority->reconnect_attempt = root["reconnectAttempt"].asInt();
  }
  if (root.isMember("expiresAt")) {
    if (!root["expiresAt"].isInt64()) return false;
    authority->expires_at_ms = root["expiresAt"].asInt64();
    if (authority->expires_at_ms <= now_ms) return false;
  }
  if (root.isMember("leaseExpiresAt")) {
    if (!root["leaseExpiresAt"].isInt64()) return false;
    authority->lease_expires_at_ms = root["leaseExpiresAt"].asInt64();
    if (authority->lease_expires_at_ms <= now_ms ||
        authority->lease_expires_at_ms > now_ms + kLeaseMaxFutureMs) {
      return false;
    }
  }
  return !with_ice || ParseIceServers(root["iceServers"],
                                     &authority->ice_servers);
}

bool HasSafeTokenCharacters(std::string_view value) {
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return (character >= 'A' && character <= 'Z') ||
           (character >= 'a' && character <= 'z') ||
           (character >= '0' && character <= '9') || character == '_' ||
           character == '-';
  });
}

}  // namespace

bool ParseJson(const std::string& text, Json::Value* out) {
  if (text.empty() || text.size() > kMaxIpcLineBytes) return false;
  Json::CharReaderBuilder builder;
  builder["collectComments"] = false;
  builder["allowComments"] = false;
  builder["allowTrailingCommas"] = false;
  builder["failIfExtra"] = true;
  builder["strictRoot"] = true;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  std::string errors;
  return reader->parse(text.data(), text.data() + text.size(), out, &errors) &&
         out->isObject();
}

std::string WriteJson(const Json::Value& value) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, value);
}

bool IsSafeId(const std::string& value) {
  return value.size() >= 16 && value.size() <= 128 &&
         HasSafeTokenCharacters(value);
}

bool IsSafeCapability(const std::string& value) {
  return value.size() == 43 && HasSafeTokenCharacters(value);
}

std::optional<Signal> ParseServiceSignal(const Json::Value& root,
                                         int64_t now_ms) {
  if (!root["type"].isString()) return std::nullopt;
  const std::string type = root["type"].asString();
  Signal signal;
  if (type == kPrepareType) {
    if (!ExactKeys(root, {"type", "requestId", "sessionId", "capability",
                          "expiresAt", "leaseExpiresAt", "daemonGeneration",
                          "mode", "inputEpoch", "iceServers"},
                   {"routeGeneration", "reconnectAttempt"}) ||
        !ParseAuthorityFields(root, now_ms, true, &signal.authority)) {
      return std::nullopt;
    }
    signal.kind = Signal::Kind::kPrepare;
  } else if (type == kOfferType) {
    if (!ExactKeys(root, {"type", "requestId", "sessionId", "capability",
                          "sdp"}) ||
        !ParseAuthorityFields(root, now_ms, false, &signal.authority) ||
        !ReadBoundedString(root, "sdp", 256 * 1024, &signal.sdp)) {
      return std::nullopt;
    }
    signal.kind = Signal::Kind::kOffer;
  } else if (type == kIceType) {
    if (!ExactKeys(root, {"type", "requestId", "sessionId", "capability",
                          "candidate", "mid"}) ||
        !ParseAuthorityFields(root, now_ms, false, &signal.authority) ||
        !ReadBoundedString(root, "candidate", 16 * 1024,
                           &signal.candidate) ||
        !ReadBoundedString(root, "mid", 256, &signal.mid)) {
      return std::nullopt;
    }
    signal.kind = Signal::Kind::kIce;
  } else if (type == kLeaseType) {
    if (!ExactKeys(root, {"type", "requestId", "sessionId", "capability",
                          "leaseExpiresAt", "daemonGeneration", "mode",
                          "inputEpoch"}, {"routeGeneration"}) ||
        !ParseAuthorityFields(root, now_ms, false, &signal.authority)) {
      return std::nullopt;
    }
    signal.kind = Signal::Kind::kLease;
  } else if (type == kModeStateType) {
    if (!ExactKeys(root, {"type", "requestId", "sessionId", "capability",
                          "mode", "inputEpoch", "reason"}) ||
        !root["reason"].isString() ||
        !ParseAuthorityFields(root, now_ms, false, &signal.authority)) {
      return std::nullopt;
    }
    signal.reason = root["reason"].asString();
    if (signal.reason != kModeReasonInitial &&
        signal.reason != kModeReasonUserSelected &&
        signal.reason != kModeReasonAuthorityLost)
      return std::nullopt;
    signal.kind = Signal::Kind::kMode;
  } else if (type == kStopType || type == kCancelType) {
    if (!ExactKeys(root, {"type", "requestId", "sessionId", "capability"}) ||
        !ParseAuthorityFields(root, now_ms, false, &signal.authority)) {
      return std::nullopt;
    }
    signal.kind = Signal::Kind::kStop;
  } else {
    return std::nullopt;
  }
  return signal;
}

Json::Value BaseEnvelope(const char* type, const Authority& authority) {
  Json::Value root(Json::objectValue);
  root["type"] = type;
  root["requestId"] = authority.request_id;
  root["sessionId"] = authority.session_id;
  root["capability"] = authority.capability;
  return root;
}

Json::Value TerminalEnvelope(const Authority& authority, const char* reason) {
  Json::Value root = BaseEnvelope(kTerminalType, authority);
  root["reason"] = reason;
  return root;
}

}  // namespace imcodes::rd
