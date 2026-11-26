#include "macos_authenticated_session_readiness.h"
#include "macos_worker_ipc_client.h"

#include <cstdio>
#include <string>

namespace macos = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

int failures = 0;

void Check(bool condition, const char* description) {
  if (condition) return;
  std::fprintf(stderr, "FAILED: %s\n", description);
  ++failures;
}

macos::WorkerLaunchContext Launch() {
  return {
      .socket_path =
          "/private/var/run/imcodes-node/graphical-sessions/88/100000/"
          "remote-desktop-agent.sock",
      .challenge = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      .worker_generation = 7,
      .session_type = "LoginWindow",
      .audit_session_id = 100000,
      .uid = 88,
  };
}

std::string AuthenticationFrame() {
  return
      "{\"type\":\"remote_desktop.macos_ipc.authenticated\","
      "\"ipcVersion\":1,\"workerGeneration\":7,\"uid\":88,"
      "\"auditSessionId\":100000,\"pidVersion\":44,"
      "\"sessionType\":\"LoginWindow\","
      "\"launchChallenge\":"
      "\"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\"}";
}

macos::CaptureSessionBinding Binding() {
  return {
      .session_type = "LoginWindow",
      .audit_session_id = 100000,
      .uid = 88,
      .launch_challenge =
          "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      .worker_generation = 7,
  };
}

macos::AuthenticatedGraphicalPeer Peer() {
  return {
      .uid = 88,
      .audit_session_id = 100000,
      .pid_version = 44,
      .worker_generation = 7,
      .session_type = "LoginWindow",
      .launch_challenge =
          "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  };
}

common::CapabilityReadiness ReadyLoginWindow() {
  return {
      .capture = common::ReadinessState::kReady,
      .encoder = common::ReadinessState::kReady,
      .input = common::ReadinessState::kReady,
      .clipboard = common::ReadinessState::kUnavailable,
      .display = common::ReadinessState::kReady,
      .disclosure = common::ReadinessState::kReady,
      .graphical_session = common::ReadinessState::kReady,
  };
}

void AuthenticationCounterexamples() {
  const macos::WorkerLaunchContext launch = Launch();
  Check(macos::IsGraphicalBootstrapLaunchContext(launch),
        "the isolated uid/asid socket identifies a graphical bootstrap");

  macos::WorkerLaunchContext legacy = launch;
  legacy.socket_path =
      "/private/var/run/imcodes-node/user-sessions/88/remote-desktop-agent.sock";
  Check(!macos::IsGraphicalBootstrapLaunchContext(legacy),
        "the legacy Aqua path cannot impersonate graphical bootstrap authority");

  macos::IpcAuthenticationAcknowledgement acknowledgement;
  const std::string valid = AuthenticationFrame();
  Check(macos::ParseIpcAuthenticationAcknowledgement(
            valid, launch, &acknowledgement),
        "the exact authenticated peer acknowledgement is accepted");
  Check(acknowledgement.pid_version == 44,
        "the kernel pid version survives authentication parsing");

  const auto replace = [](std::string value, const std::string& before,
                          const std::string& after) {
    const std::size_t at = value.find(before);
    if (at != std::string::npos) value.replace(at, before.size(), after);
    return value;
  };
  Check(!macos::ParseIpcAuthenticationAcknowledgement(
            replace(valid, "\"uid\":88", "\"uid\":501"), launch,
            &acknowledgement),
        "a mismatched uid is refused");
  Check(!macos::ParseIpcAuthenticationAcknowledgement(
            replace(valid, "\"auditSessionId\":100000",
                    "\"auditSessionId\":100001"),
            launch, &acknowledgement),
        "a successor audit session is refused");
  Check(!macos::ParseIpcAuthenticationAcknowledgement(
            replace(valid, "\"pidVersion\":44", "\"pidVersion\":0"),
            launch, &acknowledgement),
        "an acknowledgement without kernel process identity is refused");
  Check(!macos::ParseIpcAuthenticationAcknowledgement(
            replace(valid, "\"workerGeneration\":7",
                    "\"workerGeneration\":8"),
            launch, &acknowledgement),
        "a successor worker generation is refused");
  Check(!macos::ParseIpcAuthenticationAcknowledgement(
            replace(valid, "\"LoginWindow\"", "\"Aqua\""), launch,
            &acknowledgement),
        "an opposite session type is refused");
  Check(!macos::ParseIpcAuthenticationAcknowledgement(
            valid.substr(0, valid.size() - 1) + ",\"extra\":true}", launch,
            &acknowledgement),
        "an extra acknowledgement field is refused");
}

void ReadinessCounterexamples() {
  const macos::CaptureSessionBinding binding = Binding();
  const macos::AuthenticatedGraphicalPeer peer = Peer();
  const common::CapabilityReadiness ready = ReadyLoginWindow();
  std::string frame;
  Check(macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, peer, ready, true, &frame),
        "post-authenticated LoginWindow composition can attest readiness");
  Check(frame ==
            "{\"type\":\"remote_desktop.macos_ipc.graphical_readiness\","
            "\"ipcVersion\":1,\"workerGeneration\":7,\"uid\":88,"
            "\"auditSessionId\":100000,\"pidVersion\":44,"
            "\"sessionType\":\"LoginWindow\","
            "\"launchChallenge\":"
            "\"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\","
            "\"capture\":true,\"encoder\":true,\"input\":true,"
            "\"clipboard\":false,\"display\":true,"
            "\"disclosure\":true,\"graphicalSession\":true,"
            "\"cleanupReachable\":true}",
        "the attestation has the exact bound key set and restricted profile");

  macos::AuthenticatedGraphicalPeer mismatched = peer;
  mismatched.uid = 501;
  Check(!macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, mismatched, ready, true, &frame),
        "a peer for another uid cannot author readiness");
  mismatched = peer;
  mismatched.audit_session_id = 100001;
  Check(!macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, mismatched, ready, true, &frame),
        "a successor session cannot reuse predecessor composition");
  mismatched = peer;
  mismatched.pid_version = 0;
  Check(!macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, mismatched, ready, true, &frame),
        "pre-authenticated readiness is refused");
  mismatched = peer;
  mismatched.worker_generation = 8;
  Check(!macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, mismatched, ready, true, &frame),
        "a stale generation cannot author readiness");
  mismatched = peer;
  mismatched.launch_challenge =
      "RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR";
  Check(!macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, mismatched, ready, true, &frame),
        "a replayed challenge cannot author readiness");

  common::CapabilityReadiness widened = ready;
  widened.clipboard = common::ReadinessState::kReady;
  Check(!macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, peer, widened, true, &frame),
        "LoginWindow clipboard readiness is a fail-closed composition defect");
  Check(macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, peer, ready, false, &frame) &&
            frame.find("\"cleanupReachable\":false") != std::string::npos,
        "unreachable cleanup is represented honestly rather than promoted");
}

}  // namespace

int main() {
  AuthenticationCounterexamples();
  ReadinessCounterexamples();
  if (failures != 0) return 1;
  std::puts("macos authenticated readiness counterfactual ok");
  return 0;
}
