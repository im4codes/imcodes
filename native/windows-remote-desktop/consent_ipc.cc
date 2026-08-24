#include "third_party/imcodes_remote_desktop/consent_ipc.h"

#include <algorithm>
#include <initializer_list>
#include <vector>

namespace imcodes::rd {
namespace {

constexpr char kConsentViewMode[] = "view";
constexpr char kConsentControlMode[] = "control";
// The label is attacker-influenced. The contract bounds it at 128 bytes; this
// is the same bound restated at the process boundary that will draw it.
constexpr size_t kMaxRequesterLabelBytes = 128;

bool StringField(const Json::Value& root, const char* key, std::string* out) {
  if (!root.isMember(key) || !root[key].isString()) return false;
  *out = root[key].asString();
  return true;
}

bool HasExactKeys(const Json::Value& root,
                  std::initializer_list<const char*> expected) {
  const std::vector<std::string> names = root.getMemberNames();
  if (names.size() != expected.size()) return false;
  return std::all_of(expected.begin(), expected.end(), [&root](const char* key) {
    return root.isMember(key);
  });
}

}  // namespace

std::optional<ConsentFrame> ParseConsentFrame(const Json::Value& root) {
  if (!root.isObject() || !root.isMember("type") || !root["type"].isString()) {
    return std::nullopt;
  }
  const std::string type = root["type"].asString();

  if (type == consent_ipc::kSurfaceQuery) {
    // Carries nothing; anything extra is a protocol error, not a hint.
    if (!HasExactKeys(root, {"type"})) return std::nullopt;
    ConsentFrame frame{};
    frame.kind = ConsentFrameKind::kSurfaceQuery;
    return frame;
  }

  if (type == consent_ipc::kDismiss) {
    if (!HasExactKeys(root, {"type", "approvalId"})) return std::nullopt;
    std::string approval_id;
    if (!StringField(root, "approvalId", &approval_id)) return std::nullopt;
    if (!IsSafeId(approval_id)) return std::nullopt;
    ConsentFrame frame{};
    frame.kind = ConsentFrameKind::kDismiss;
    frame.approval_id = approval_id;
    return frame;
  }

  if (type != consent_ipc::kAsk) return std::nullopt;
  if (!HasExactKeys(root, {
        "type", "approvalId", "requesterLabel", "mode", "deadlineMs"})) {
    return std::nullopt;
  }

  ConsentAsk ask{};
  if (!StringField(root, "approvalId", &ask.approval_id)) return std::nullopt;
  if (!IsSafeId(ask.approval_id)) return std::nullopt;
  if (!StringField(root, "requesterLabel", &ask.requester_label)) {
    return std::nullopt;
  }
  // Reject rather than truncate: a silently shortened label would still be
  // drawn as though it were the whole truth about who is asking.
  if (ask.requester_label.empty()
      || ask.requester_label.size() > kMaxRequesterLabelBytes) {
    return std::nullopt;
  }
  std::string mode;
  if (!StringField(root, "mode", &mode)) return std::nullopt;
  if (mode != kConsentViewMode && mode != kConsentControlMode) return std::nullopt;
  ask.control_mode = mode == kConsentControlMode;

  if (!root.isMember("deadlineMs") || !root["deadlineMs"].isIntegral()) {
    return std::nullopt;
  }
  const Json::Int64 deadline = root["deadlineMs"].asInt64();
  // A zero or unbounded deadline would leave a question on the local user's
  // screen with nothing to close it.
  if (deadline <= 0
      || deadline > static_cast<Json::Int64>(consent_ipc::kMaxDeadlineMs)) {
    return std::nullopt;
  }
  ask.deadline_ms = static_cast<uint32_t>(deadline);

  ConsentFrame frame{};
  frame.kind = ConsentFrameKind::kAsk;
  frame.ask = ask;
  frame.approval_id = ask.approval_id;
  return frame;
}

Json::Value ConsentAnswerEnvelope(const std::string& approval_id,
                                  const char* outcome) {
  Json::Value root(Json::objectValue);
  root["type"] = consent_ipc::kAnswer;
  root["approvalId"] = approval_id;
  root["outcome"] = outcome;
  return root;
}

Json::Value ConsentSurfaceStateEnvelope(bool ui_available,
                                        bool interactive_session,
                                        bool protected_desktop_active) {
  Json::Value root(Json::objectValue);
  root["type"] = consent_ipc::kSurfaceState;
  root["uiAvailable"] = ui_available;
  root["interactiveSession"] = interactive_session;
  root["protectedDesktopActive"] = protected_desktop_active;
  return root;
}

const char* ConsentOutcomeLiteral(ConsentPrompt::Outcome outcome) {
  switch (outcome) {
    case ConsentPrompt::Outcome::kAllowed:
      return consent_ipc::kOutcomeAllowed;
    case ConsentPrompt::Outcome::kDenied:
      return consent_ipc::kOutcomeDenied;
    case ConsentPrompt::Outcome::kTimedOut:
      return consent_ipc::kOutcomeTimedOut;
    case ConsentPrompt::Outcome::kUnavailable:
      return consent_ipc::kOutcomeUnavailable;
    case ConsentPrompt::Outcome::kCancelled:
      break;
  }
  // Default to cancelled, never to a decision: an outcome this function does
  // not recognise is by definition not a human answer.
  return consent_ipc::kOutcomeCancelled;
}

}  // namespace imcodes::rd
