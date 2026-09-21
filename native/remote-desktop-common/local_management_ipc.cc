#include "local_management_ipc.h"

#include <algorithm>
#include <array>
#include <limits>
#include <set>
#include <utility>

#include "json/value.h"
#include "json_protocol.h"

namespace imcodes::remote_desktop::common {
namespace {

constexpr std::size_t kMaximumTokenBytes = 256;
constexpr std::size_t kMaximumLabelBytes = 256;
constexpr std::size_t kMaximumVersionBytes = 128;
constexpr std::size_t kMaximumConnections = 256;

bool HasExactKeys(const Json::Value& value,
                  std::initializer_list<const char*> required,
                  std::initializer_list<const char*> optional = {}) {
  if (!value.isObject()) return false;
  std::set<std::string> expected;
  for (const char* key : required) expected.insert(key);
  for (const char* key : optional) {
    if (value.isMember(key)) expected.insert(key);
  }
  const auto names = value.getMemberNames();
  return names.size() == expected.size() &&
         std::all_of(names.begin(), names.end(), [&](const std::string& key) {
           return expected.contains(key);
         });
}

bool IsSafeText(const std::string& value, std::size_t maximum_bytes) {
  return !value.empty() && value.size() <= maximum_bytes &&
         std::none_of(value.begin(), value.end(), [](unsigned char ch) {
           return ch == 0 || ch == '\r' || ch == '\n';
         });
}

bool IsSafeToken(const std::string& value) {
  return IsSafeText(value, kMaximumTokenBytes) &&
         std::all_of(value.begin(), value.end(), [](unsigned char ch) {
           return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
                  (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
         });
}

bool ReadSafeString(const Json::Value& root,
                    const char* key,
                    std::size_t maximum_bytes,
                    std::string* output) {
  if (!root[key].isString()) return false;
  *output = root[key].asString();
  return IsSafeText(*output, maximum_bytes);
}

bool ReadSafeToken(const Json::Value& root,
                   const char* key,
                   std::string* output) {
  return ReadSafeString(root, key, kMaximumTokenBytes, output) &&
         IsSafeToken(*output);
}

bool ReadRevision(const Json::Value& root,
                  const char* key,
                  std::uint64_t* output) {
  if (!root[key].isUInt64()) return false;
  *output = root[key].asUInt64();
  return *output > 0 &&
         *output <= static_cast<std::uint64_t>(9'007'199'254'740'991ULL);
}

std::optional<LocalManagementServiceState> ParseServiceState(
    const std::string& value) {
  if (value == "ready") return LocalManagementServiceState::kReady;
  if (value == "starting") return LocalManagementServiceState::kStarting;
  if (value == "stopped") return LocalManagementServiceState::kStopped;
  if (value == "repair_required") {
    return LocalManagementServiceState::kRepairRequired;
  }
  if (value == "version_mismatch") {
    return LocalManagementServiceState::kVersionMismatch;
  }
  return std::nullopt;
}

std::optional<LocalManagementAccessState> ParseAccessState(
    const std::string& value) {
  if (value == "ready") return LocalManagementAccessState::kReady;
  if (value == "paused") return LocalManagementAccessState::kPaused;
  if (value == "stopping") return LocalManagementAccessState::kStopping;
  if (value == "unavailable") return LocalManagementAccessState::kUnavailable;
  return std::nullopt;
}

bool ParseConnection(const Json::Value& value,
                     LocalManagementConnection* output) {
  if (!HasExactKeys(value,
                    {"id", "label", "connectedAt", "durationMs", "mode"}) ||
      !ReadSafeToken(value, "id", &output->id) ||
      !ReadSafeString(value, "label", kMaximumLabelBytes, &output->label) ||
      !value["connectedAt"].isInt64() ||
      !value["durationMs"].isInt64() ||
      !value["mode"].isString()) {
    return false;
  }
  output->connected_at_ms = value["connectedAt"].asInt64();
  output->duration_ms = value["durationMs"].asInt64();
  if (output->connected_at_ms < 0 || output->duration_ms < 0) return false;
  const std::string mode = value["mode"].asString();
  if (mode == "view") {
    output->role = LocalManagementConnectionRole::kView;
  } else if (mode == "control") {
    output->role = LocalManagementConnectionRole::kControl;
  } else {
    return false;
  }
  return true;
}

bool ParseSnapshot(const Json::Value& root, LocalManagementSnapshot* output) {
  if (!HasExactKeys(root, {"type", "protocolVersion", "revision",
                           "publicNodeId", "serviceState", "accessState",
                           "paused", "connections"}) ||
      root["type"].asString() != kLocalManagementSnapshotType ||
      !root["protocolVersion"].isUInt() ||
      root["protocolVersion"].asUInt() != kLocalManagementProtocolVersion ||
      !ReadRevision(root, "revision", &output->revision) ||
      !ReadSafeToken(root, "publicNodeId", &output->public_node_id) ||
      !root["serviceState"].isString() ||
      !root["accessState"].isString() || !root["paused"].isBool() ||
      !root["connections"].isArray() ||
      root["connections"].size() > kMaximumConnections) {
    return false;
  }
  const auto service_state = ParseServiceState(root["serviceState"].asString());
  const auto access_state = ParseAccessState(root["accessState"].asString());
  if (!service_state || !access_state) return false;
  output->service_state = *service_state;
  output->access_state = *access_state;
  output->paused = root["paused"].asBool();
  if (output->paused !=
      (output->access_state == LocalManagementAccessState::kPaused)) {
    return false;
  }
  output->connections.clear();
  std::set<std::string> connection_ids;
  for (const Json::Value& encoded : root["connections"]) {
    LocalManagementConnection connection;
    if (!ParseConnection(encoded, &connection) ||
        !connection_ids.insert(connection.id).second) {
      return false;
    }
    output->connections.push_back(std::move(connection));
  }
  return true;
}

bool SameSnapshot(const LocalManagementSnapshot& left,
                  const LocalManagementSnapshot& right) {
  if (left.revision != right.revision ||
      left.public_node_id != right.public_node_id ||
      left.service_state != right.service_state ||
      left.access_state != right.access_state || left.paused != right.paused ||
      left.connections.size() != right.connections.size()) {
    return false;
  }
  for (std::size_t index = 0; index < left.connections.size(); ++index) {
    const auto& a = left.connections[index];
    const auto& b = right.connections[index];
    if (a.id != b.id || a.label != b.label ||
        a.connected_at_ms != b.connected_at_ms ||
        a.duration_ms < b.duration_ms || a.role != b.role) {
      return false;
    }
  }
  return true;
}

const char* ActionText(LocalManagementAction action) {
  switch (action) {
    case LocalManagementAction::kPause:
      return "pause";
    case LocalManagementAction::kResume:
      return "resume";
    case LocalManagementAction::kStopAll:
      return "stop_all";
    case LocalManagementAction::kDisconnect:
      return "disconnect";
  }
  return nullptr;
}

void AppendBigEndianLength(std::uint32_t length, std::string* output) {
  output->push_back(static_cast<char>((length >> 24U) & 0xffU));
  output->push_back(static_cast<char>((length >> 16U) & 0xffU));
  output->push_back(static_cast<char>((length >> 8U) & 0xffU));
  output->push_back(static_cast<char>(length & 0xffU));
}

std::uint32_t ReadBigEndianLength(std::string_view bytes) {
  return (static_cast<std::uint32_t>(
              static_cast<unsigned char>(bytes[0]))
          << 24U) |
         (static_cast<std::uint32_t>(
              static_cast<unsigned char>(bytes[1]))
          << 16U) |
         (static_cast<std::uint32_t>(
              static_cast<unsigned char>(bytes[2]))
          << 8U) |
         static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[3]));
}

}  // namespace

bool LocalManagementFrameDecoder::Push(
    std::string_view bytes,
    std::vector<std::string>* payloads) {
  if (failed_ || payloads == nullptr) {
    failed_ = true;
    return false;
  }
  while (!bytes.empty()) {
    if (buffered_.size() < 4) {
      const std::size_t take = std::min(4 - buffered_.size(), bytes.size());
      buffered_.append(bytes.substr(0, take));
      bytes.remove_prefix(take);
      if (buffered_.size() < 4) continue;
    }
    const std::uint32_t length = ReadBigEndianLength(buffered_);
    if (length == 0 || length > kLocalManagementMaximumFrameBytes) {
      failed_ = true;
      return false;
    }
    const std::size_t frame_size = static_cast<std::size_t>(length) + 4;
    const std::size_t take = std::min(frame_size - buffered_.size(), bytes.size());
    buffered_.append(bytes.substr(0, take));
    bytes.remove_prefix(take);
    if (buffered_.size() < frame_size) continue;
    payloads->push_back(buffered_.substr(4, length));
    buffered_.clear();
  }
  return true;
}

void LocalManagementFrameDecoder::Reset() {
  buffered_.clear();
  failed_ = false;
}

std::optional<std::string> EncodeLocalManagementFrame(std::string_view json) {
  if (json.empty() || json.size() > kLocalManagementMaximumFrameBytes ||
      json.size() > std::numeric_limits<std::uint32_t>::max()) {
    return std::nullopt;
  }
  std::string frame;
  frame.reserve(json.size() + 4);
  AppendBigEndianLength(static_cast<std::uint32_t>(json.size()), &frame);
  frame.append(json);
  return frame;
}

LocalManagementClientCore::LocalManagementClientCore(
    std::string bootstrap_secret,
    std::string ui_version,
    std::string product_version)
    : bootstrap_secret_(std::move(bootstrap_secret)),
      ui_version_(std::move(ui_version)),
      product_version_(std::move(product_version)) {
  if (!IsSafeToken(bootstrap_secret_) ||
      !IsSafeText(ui_version_, kMaximumVersionBytes) ||
      !IsSafeText(product_version_, kMaximumVersionBytes)) {
    failed_ = true;
  }
}

std::optional<std::string> LocalManagementClientCore::EncodeHello(
    std::string_view client_nonce) const {
  if (failed_ || !IsSafeToken(std::string(client_nonce))) return std::nullopt;
  Json::Value root(Json::objectValue);
  root["type"] = kLocalManagementHelloType;
  root["protocolVersion"] = kLocalManagementProtocolVersion;
  root["bootstrapSecret"] = bootstrap_secret_;
  root["clientNonce"] = std::string(client_nonce);
  root["uiVersion"] = ui_version_;
  root["productVersion"] = product_version_;
  return EncodeLocalManagementFrame(imcodes::rd::WriteJson(root));
}

std::optional<std::string> LocalManagementClientCore::EncodeRefresh(
    std::string_view request_id) const {
  if (failed_ || capability_.empty() ||
      !IsSafeToken(std::string(request_id))) {
    return std::nullopt;
  }
  Json::Value root(Json::objectValue);
  root["type"] = kLocalManagementRefreshType;
  root["protocolVersion"] = kLocalManagementProtocolVersion;
  root["requestId"] = std::string(request_id);
  root["capability"] = capability_;
  return EncodeLocalManagementFrame(imcodes::rd::WriteJson(root));
}

std::optional<std::string> LocalManagementClientCore::EncodeAction(
    std::string_view request_id,
    std::uint64_t expected_revision,
    LocalManagementAction action,
    std::string_view connection_id) const {
  const char* action_text = ActionText(action);
  if (failed_ || capability_.empty() || action_text == nullptr ||
      expected_revision == 0 ||
      expected_revision > 9'007'199'254'740'991ULL ||
      !IsSafeToken(std::string(request_id)) ||
      (action == LocalManagementAction::kDisconnect &&
       !IsSafeToken(std::string(connection_id))) ||
      (action != LocalManagementAction::kDisconnect && !connection_id.empty())) {
    return std::nullopt;
  }
  Json::Value root(Json::objectValue);
  root["type"] = kLocalManagementActionType;
  root["protocolVersion"] = kLocalManagementProtocolVersion;
  root["requestId"] = std::string(request_id);
  root["capability"] = capability_;
  root["expectedRevision"] = Json::UInt64(expected_revision);
  root["action"] = action_text;
  if (action == LocalManagementAction::kDisconnect) {
    root["connectionId"] = std::string(connection_id);
  }
  return EncodeLocalManagementFrame(imcodes::rd::WriteJson(root));
}

bool LocalManagementClientCore::Consume(
    std::string_view bytes,
    std::vector<LocalManagementEvent>* events) {
  if (failed_ || events == nullptr) return false;
  std::vector<std::string> payloads;
  if (!decoder_.Push(bytes, &payloads)) {
    failed_ = true;
    return false;
  }
  for (const std::string& payload : payloads) {
    if (!ConsumePayload(payload, events)) {
      failed_ = true;
      return false;
    }
  }
  return true;
}

bool LocalManagementClientCore::ConsumePayload(
    std::string_view payload,
    std::vector<LocalManagementEvent>* events) {
  Json::Value root;
  if (!imcodes::rd::ParseJson(std::string(payload), &root) ||
      !root["type"].isString() || !root["protocolVersion"].isUInt() ||
      root["protocolVersion"].asUInt() != kLocalManagementProtocolVersion) {
    return false;
  }
  const std::string type = root["type"].asString();
  if (type == kLocalManagementWelcomeType) {
    if (!capability_.empty() ||
        !HasExactKeys(root, {"type", "protocolVersion", "runtimeVersion",
                             "productVersion", "sessionId", "capability",
                             "capabilityExpiresAt", "snapshot"})) {
      return false;
    }
    LocalManagementWelcome welcome;
    if (!ReadSafeString(root, "runtimeVersion", kMaximumVersionBytes,
                        &welcome.runtime_version) ||
        !ReadSafeString(root, "productVersion", kMaximumVersionBytes,
                        &welcome.product_version) ||
        welcome.product_version != product_version_ ||
        !ReadSafeToken(root, "sessionId", &welcome.session_id) ||
        !ReadSafeToken(root, "capability", &welcome.capability) ||
        !root["capabilityExpiresAt"].isInt64() ||
        !ParseSnapshot(root["snapshot"], &welcome.snapshot)) {
      return false;
    }
    welcome.capability_expires_at_ms = root["capabilityExpiresAt"].asInt64();
    if (welcome.capability_expires_at_ms <= 0) return false;
    capability_ = welcome.capability;
    session_id_ = welcome.session_id;
    snapshot_ = welcome.snapshot;
    LocalManagementEvent event;
    event.kind = LocalManagementEvent::Kind::kWelcome;
    event.welcome = std::move(welcome);
    events->push_back(std::move(event));
    return true;
  }
  if (type == kLocalManagementSnapshotType) {
    if (capability_.empty()) return false;
    LocalManagementSnapshot parsed;
    if (!ParseSnapshot(root, &parsed) ||
        (snapshot_ && (parsed.revision < snapshot_->revision ||
          (parsed.revision == snapshot_->revision &&
           !SameSnapshot(parsed, *snapshot_))))) {
      return false;
    }
    snapshot_ = parsed;
    LocalManagementEvent event;
    event.kind = LocalManagementEvent::Kind::kSnapshot;
    event.snapshot = std::move(parsed);
    events->push_back(std::move(event));
    return true;
  }
  if (type == kLocalManagementAckType) {
    if (capability_.empty()) return false;
    if (!HasExactKeys(root,
                      {"type", "protocolVersion", "requestId", "ok",
                       "appliedRevision"},
                      {"error"})) {
      return false;
    }
    LocalManagementAck ack;
    if (!ReadSafeToken(root, "requestId", &ack.request_id) ||
        !root["ok"].isBool() ||
        !ReadRevision(root, "appliedRevision", &ack.applied_revision)) {
      return false;
    }
    ack.ok = root["ok"].asBool();
    if (root.isMember("error")) {
      if (!ReadSafeString(root, "error", 128, &ack.error) || ack.ok) {
        return false;
      }
    } else if (!ack.ok) {
      return false;
    }
    LocalManagementEvent event;
    event.kind = LocalManagementEvent::Kind::kAck;
    event.ack = std::move(ack);
    events->push_back(std::move(event));
    return true;
  }
  if (type == kLocalManagementErrorType) {
    if (!HasExactKeys(root, {"type", "protocolVersion", "error"})) {
      return false;
    }
    LocalManagementEvent event;
    event.kind = LocalManagementEvent::Kind::kError;
    if (!ReadSafeString(root, "error", 128, &event.error)) return false;
    events->push_back(std::move(event));
    return true;
  }
  return false;
}

void LocalManagementClientCore::ResetForReconnect() {
  capability_.clear();
  session_id_.clear();
  snapshot_.reset();
  decoder_.Reset();
  failed_ = !IsSafeToken(bootstrap_secret_) ||
            !IsSafeText(ui_version_, kMaximumVersionBytes) ||
            !IsSafeText(product_version_, kMaximumVersionBytes);
}

}  // namespace imcodes::remote_desktop::common
