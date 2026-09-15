#include "macos_authenticated_session_readiness.h"

#include <string_view>
#include <utility>

#include "macos_worker_ipc_client.h"

namespace imcodes::remote_desktop::macos {
namespace {

bool IsReady(common::ReadinessState state) noexcept {
  return state == common::ReadinessState::kReady;
}

void AppendFlag(std::string* frame, std::string_view name, bool value) {
  frame->append(",\"").append(name).append("\":")
      .append(value ? "true" : "false");
}

}  // namespace

bool BuildAuthenticatedGraphicalReadinessFrame(
    const CaptureSessionBinding& binding,
    const AuthenticatedGraphicalPeer& peer,
    const common::CapabilityReadiness& observed,
    bool cleanup_reachable,
    std::string* out) {
  if (out == nullptr || !binding.IsComplete() || peer.pid_version == 0 ||
      peer.uid != binding.uid ||
      peer.audit_session_id != binding.audit_session_id ||
      peer.worker_generation != binding.worker_generation ||
      peer.session_type != binding.session_type ||
      peer.launch_challenge != binding.launch_challenge) {
    return false;
  }
  const SessionCapabilityProfile profile =
      CapabilityProfileFor(binding.session_type);
  if (!profile.capture) return false;

  const bool capture = IsReady(observed.capture);
  const bool encoder = IsReady(observed.encoder);
  const bool input = IsReady(observed.input) &&
      profile.pointer && profile.keyboard;
  const bool clipboard = IsReady(observed.clipboard) && profile.clipboard;
  const bool display = IsReady(observed.display);
  const bool disclosure = IsReady(observed.disclosure);
  const bool graphical_session = IsReady(observed.graphical_session);

  // A forbidden adapter reporting Ready is a composition defect, not a value
  // to silently mask. Refusing the whole frame makes that widening observable.
  if ((!profile.clipboard && IsReady(observed.clipboard)) ||
      (!(profile.pointer && profile.keyboard) && IsReady(observed.input))) {
    return false;
  }

  std::string frame;
  frame.reserve(640);
  frame.append("{\"type\":\"").append(kGraphicalReadinessMessageType)
      .append("\",\"ipcVersion\":")
      .append(std::to_string(kWorkerIpcVersion))
      .append(",\"workerGeneration\":")
      .append(std::to_string(peer.worker_generation))
      .append(",\"uid\":").append(std::to_string(peer.uid))
      .append(",\"auditSessionId\":")
      .append(std::to_string(peer.audit_session_id))
      .append(",\"pidVersion\":")
      .append(std::to_string(peer.pid_version))
      .append(",\"sessionType\":\"").append(peer.session_type)
      .append("\",\"launchChallenge\":\"")
      .append(peer.launch_challenge).append("\"");
  AppendFlag(&frame, "capture", capture);
  AppendFlag(&frame, "encoder", encoder);
  AppendFlag(&frame, "input", input);
  AppendFlag(&frame, "clipboard", clipboard);
  AppendFlag(&frame, "display", display);
  AppendFlag(&frame, "disclosure", disclosure);
  AppendFlag(&frame, "graphicalSession", graphical_session);
  AppendFlag(&frame, "cleanupReachable", cleanup_reachable);
  frame.push_back('}');
  if (frame.size() >= kIpcMaxFrameBytes) return false;
  *out = std::move(frame);
  return true;
}

}  // namespace imcodes::remote_desktop::macos
