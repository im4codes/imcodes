// Production counterfactuals for the executable-consumed seams.
//
// These replace the earlier tests that merely pinned "not implemented"
// strings. Every case asserts a behaviour the daemon depends on: the exact v1
// readiness shape, cleanup commands that report failure when they cannot act,
// a bounded frame loop that terminates instead of resynchronizing, and a
// disclosure admission rule that cannot be satisfied by a stale process.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "macos_disclosure_control.h"
#include "macos_host_command_dispatch.h"
#include "macos_native_command_v1.h"
#include "macos_worker_control.h"
#include "macos_worker_ipc_client.h"

namespace macos = imcodes::remote_desktop::macos;

namespace {

int g_failures = 0;

void Check(bool condition, const char* label) {
  if (condition)
    return;
  std::fprintf(stderr, "FAIL %s\n", label);
  ++g_failures;
}

macos::NativeReadinessV1 ReadySnapshot() {
  macos::NativeReadinessV1 snapshot;
  snapshot.active_aqua_user_uids = {501};
  snapshot.session_state = macos::kNativeSessionStateActiveUnlocked;
  snapshot.screen_recording = true;
  snapshot.encoder = true;
  snapshot.accessibility = true;
  snapshot.clipboard = true;
  snapshot.disclosure = true;
  snapshot.lifecycle_observation = true;
  snapshot.release_input = true;
  snapshot.stop_capture = true;
  snapshot.virtual_display = true;
  return snapshot;
}

class FixedProbe final : public macos::NativeReadinessProbe {
 public:
  explicit FixedProbe(macos::NativeReadinessV1 snapshot, bool succeed = true)
      : snapshot_(std::move(snapshot)), succeed_(succeed) {}
  bool Collect(macos::NativeReadinessV1* out) noexcept override {
    ++calls;
    if (!succeed_)
      return false;
    *out = snapshot_;
    return true;
  }
  int calls = 0;

 private:
  macos::NativeReadinessV1 snapshot_;
  bool succeed_;
};

class RecordingCleanup final : public macos::NativeCleanupTarget {
 public:
  RecordingCleanup(std::uint64_t active, bool has_session)
      : active_(active), has_session_(has_session) {}
  bool ReleaseAllInput(std::uint64_t generation) noexcept override {
    ++release_calls;
    return Matches(generation);
  }
  bool StopCapture(std::uint64_t generation) noexcept override {
    ++stop_calls;
    return Matches(generation);
  }
  int release_calls = 0;
  int stop_calls = 0;

 private:
  bool Matches(std::uint64_t generation) const noexcept {
    if (!has_session_ || active_ == 0)
      return false;
    return generation == 0 || generation == active_;
  }
  std::uint64_t active_;
  bool has_session_;
};

class RecordingOnboarding final : public macos::NativePermissionOnboarding {
 public:
  explicit RecordingOnboarding(bool succeed = true) : succeed_(succeed) {}

  bool RequestRegistration() noexcept override {
    ++calls;
    return succeed_;
  }

  int calls = 0;

 private:
  bool succeed_;
};

macos::NativeCommandResult Run(
    const std::vector<const char*>& argv,
    macos::NativeReadinessProbe* probe,
    macos::NativeCleanupTarget* cleanup,
    macos::NativePermissionOnboarding* onboarding = nullptr) {
  return macos::RunNativeCommandV1(static_cast<int>(argv.size()), argv.data(),
                                   probe, cleanup, onboarding);
}

// ---------------------------------------------------------------------------

void ReadinessEmitsExactlyTheContractShape() {
  std::string encoded;
  Check(macos::SerializeNativeReadinessV1(ReadySnapshot(), &encoded),
        "ready snapshot serializes");
  // The TypeScript parser uses exactKeys, so a missing or extra key is fatal
  // there. Assert the exact byte sequence rather than "contains".
  const std::string expected =
      "{\"version\":1,\"activeAquaUserUids\":[501],"
      "\"sessionState\":\"active_unlocked\","
      "\"screenRecording\":true,\"encoder\":true,\"accessibility\":true,"
      "\"clipboard\":true,\"disclosure\":true,\"lifecycleObservation\":true,"
      "\"releaseInput\":true,\"stopCapture\":true,"
      "\"virtualDisplay\":true}";
  Check(encoded == expected, "readiness JSON is byte-exact");

  macos::NativeReadinessV1 empty;
  Check(macos::SerializeNativeReadinessV1(empty, &encoded),
        "default snapshot serializes");
  Check(encoded.find("\"activeAquaUserUids\":[]") != std::string::npos,
        "empty uid list is an empty array");
  Check(encoded.find("\"sessionState\":\"inactive\"") != std::string::npos,
        "default session state is inactive");
}

void ReadinessRefusesUnrepresentableSnapshots() {
  std::string encoded;
  macos::NativeReadinessV1 bad_state = ReadySnapshot();
  bad_state.session_state = "unlocked";  // not in the closed set
  Check(!macos::SerializeNativeReadinessV1(bad_state, &encoded),
        "unknown session state is refused");

  macos::NativeReadinessV1 zero_uid = ReadySnapshot();
  zero_uid.active_aqua_user_uids = {0};
  Check(!macos::SerializeNativeReadinessV1(zero_uid, &encoded),
        "zero uid is refused");

  macos::NativeReadinessV1 duplicate = ReadySnapshot();
  duplicate.active_aqua_user_uids = {501, 501};
  Check(!macos::SerializeNativeReadinessV1(duplicate, &encoded),
        "duplicate uid is refused");

  macos::NativeReadinessV1 too_many = ReadySnapshot();
  too_many.active_aqua_user_uids.clear();
  for (std::uint32_t index = 1;
       index <= macos::kNativeReadinessMaxActiveUids + 1; ++index) {
    too_many.active_aqua_user_uids.push_back(index);
  }
  Check(!macos::SerializeNativeReadinessV1(too_many, &encoded),
        "over-cap uid list is refused");
}

void ReadinessCommandAsksTheProbeExactlyOnce() {
  FixedProbe probe(ReadySnapshot());
  RecordingCleanup cleanup(7, true);
  const auto result =
      Run({"worker", macos::kNativeCommandReadinessV1}, &probe, &cleanup);
  Check(result.outcome == macos::NativeCommandOutcome::kOk,
        "readiness command succeeds");
  Check(probe.calls == 1, "probe consulted exactly once");
  Check(!result.stdout_text.empty() && result.stdout_text.back() == '\n',
        "readiness output is newline terminated");
  // No prompting and no inference: a failing probe is a failed command, never
  // a fabricated snapshot.
  FixedProbe failing(ReadySnapshot(), false);
  const auto failed =
      Run({"worker", macos::kNativeCommandReadinessV1}, &failing, &cleanup);
  Check(failed.outcome == macos::NativeCommandOutcome::kFailed,
        "failing probe fails the command");
  Check(failed.stdout_text.empty(), "failed probe emits no snapshot");
}

void ReadinessRejectsGenerationScoping() {
  FixedProbe probe(ReadySnapshot());
  RecordingCleanup cleanup(7, true);
  const auto result =
      Run({"worker", macos::kNativeCommandReadinessV1, "--generation", "7"},
          &probe, &cleanup);
  Check(result.outcome == macos::NativeCommandOutcome::kUsage,
        "readiness refuses a generation argument");
  Check(probe.calls == 0, "usage error never reaches the probe");
}

void PermissionRegistrationIsExplicitAndUserControlled() {
  FixedProbe probe(ReadySnapshot());
  RecordingCleanup cleanup(7, true);
  RecordingOnboarding onboarding;
  const auto result = Run({"worker", macos::kNativeCommandRequestPermissionsV1},
                          &probe, &cleanup, &onboarding);
  Check(result.outcome == macos::NativeCommandOutcome::kOk,
        "permission registration request succeeds");
  Check(onboarding.calls == 1,
        "permission registration invokes the onboarding seam exactly once");
  Check(result.stdout_text ==
            "macos_remote_desktop_permission_registration_requested\n",
        "permission registration reports request rather than grant");
  Check(probe.calls == 0,
        "permission registration never fabricates a readiness snapshot");

  RecordingOnboarding failing(false);
  const auto failed = Run({"worker", macos::kNativeCommandRequestPermissionsV1},
                          &probe, &cleanup, &failing);
  Check(failed.outcome == macos::NativeCommandOutcome::kFailed,
        "failed registration request fails closed");
  Check(failing.calls == 1 && failed.stdout_text.empty(),
        "failed registration never claims that permission was granted");

  RecordingOnboarding scoped;
  const auto invalid = Run({"worker", macos::kNativeCommandRequestPermissionsV1,
                            "--generation", "7"},
                           &probe, &cleanup, &scoped);
  Check(invalid.outcome == macos::NativeCommandOutcome::kUsage,
        "permission registration refuses generation scoping");
  Check(scoped.calls == 0,
        "invalid permission registration never reaches Apple APIs");
}

void CleanupFailsWhenItCannotActOnActiveGeneration() {
  FixedProbe probe(ReadySnapshot());
  {
    // No active session at all: the command must fail so the daemon can tell
    // "released" from "there was nothing to release".
    RecordingCleanup idle(0, false);
    const auto release =
        Run({"worker", macos::kNativeCommandReleaseInputV1}, &probe, &idle);
    Check(release.outcome == macos::NativeCommandOutcome::kFailed,
          "release without an active generation fails");
    Check(idle.release_calls == 1, "cleanup target still consulted");
    const auto stop =
        Run({"worker", macos::kNativeCommandStopCaptureV1}, &probe, &idle);
    Check(stop.outcome == macos::NativeCommandOutcome::kFailed,
          "stop without an active generation fails");
  }
  {
    RecordingCleanup active(7, true);
    const auto matched = Run(
        {"worker", macos::kNativeCommandReleaseInputV1, "--generation", "7"},
        &probe, &active);
    Check(matched.outcome == macos::NativeCommandOutcome::kOk,
          "matching generation releases");
    const auto mismatched = Run(
        {"worker", macos::kNativeCommandReleaseInputV1, "--generation", "8"},
        &probe, &active);
    Check(mismatched.outcome == macos::NativeCommandOutcome::kFailed,
          "mismatched generation fails");
    // Idempotent in effect: repeating the matching command stays successful.
    const auto repeated = Run(
        {"worker", macos::kNativeCommandReleaseInputV1, "--generation", "7"},
        &probe, &active);
    Check(repeated.outcome == macos::NativeCommandOutcome::kOk,
          "repeat release is idempotent");
  }
}

void CommandParsingRejectsMalformedGeneration() {
  FixedProbe probe(ReadySnapshot());
  RecordingCleanup cleanup(7, true);
  for (const char* bad : {"07", "-1", "1 ", "", "x", "99999999999999999999"}) {
    const auto result =
        Run({"worker", macos::kNativeCommandStopCaptureV1, "--generation", bad},
            &probe, &cleanup);
    Check(result.outcome == macos::NativeCommandOutcome::kUsage,
          "malformed generation is a usage error");
  }
  const auto two_commands = Run({"worker", macos::kNativeCommandStopCaptureV1,
                                 macos::kNativeCommandReleaseInputV1},
                                &probe, &cleanup);
  Check(two_commands.outcome == macos::NativeCommandOutcome::kUsage,
        "two command tokens is a usage error");
  const auto not_a_command =
      Run({"worker", "--macos-remote-desktop-launch-agent"}, &probe, &cleanup);
  Check(not_a_command.outcome == macos::NativeCommandOutcome::kNotACommand,
        "ordinary launch is not a command");
}

// ---------------------------------------------------------------------------

void LaunchContextRefusesDefaults() {
  macos::WorkerLaunchContext context;
  // Missing socket, missing challenge and missing generation must all fail
  // rather than default: a defaulted generation would let this process attach
  // to a session it was not launched for.
  Check(!macos::ReadWorkerLaunchContext(
            [](const char*) -> const char* { return nullptr; }, &context),
        "empty environment is refused");
  Check(!macos::ReadWorkerLaunchContext(
            [](const char* name) -> const char* {
              if (std::strcmp(name, macos::kEnvSocketPath) == 0) {
                return "relative/path";
              }
              if (std::strcmp(name, macos::kEnvLaunchChallenge) == 0) {
                return "0123456789012345678901234567890123456789012";
              }
              if (std::strcmp(name, macos::kEnvWorkerGeneration) == 0) {
                return "7";
              }
              return nullptr;
            },
            &context),
        "relative socket path is refused");
  Check(!macos::ReadWorkerLaunchContext(
            [](const char* name) -> const char* {
              if (std::strcmp(name, macos::kEnvSocketPath) == 0)
                return "/tmp/s";
              if (std::strcmp(name, macos::kEnvLaunchChallenge) == 0) {
                return "too-short";
              }
              if (std::strcmp(name, macos::kEnvWorkerGeneration) == 0) {
                return "7";
              }
              return nullptr;
            },
            &context),
        "short challenge is refused");
  // A launch that names no session type is refused. It used to be the complete
  // environment; it no longer is, because the capability profile is derived
  // from the session type and defaulting it would hand a login window the whole
  // logged-in user surface.
  Check(!macos::ReadWorkerLaunchContext(
            [](const char* name) -> const char* {
              if (std::strcmp(name, macos::kEnvSocketPath) == 0) {
                return "/private/var/run/imcodes-node/s.sock";
              }
              if (std::strcmp(name, macos::kEnvLaunchChallenge) == 0) {
                return "0123456789012345678901234567890123456789012";
              }
              if (std::strcmp(name, macos::kEnvWorkerGeneration) == 0) {
                return "7";
              }
              return nullptr;
            },
            &context),
        "an environment with no session type is refused");
  Check(macos::ReadWorkerLaunchContext(
            [](const char* name) -> const char* {
              if (std::strcmp(name, macos::kEnvSocketPath) == 0) {
                return "/private/var/run/imcodes-node/s.sock";
              }
              if (std::strcmp(name, macos::kEnvLaunchChallenge) == 0) {
                return "0123456789012345678901234567890123456789012";
              }
              if (std::strcmp(name, macos::kEnvWorkerGeneration) == 0) {
                return "7";
              }
              if (std::strcmp(name, macos::kEnvSessionType) == 0) {
                return "LoginWindow";
              }
              if (std::strcmp(name, macos::kEnvAuditSessionId) == 0) {
                return "100003";
              }
              return nullptr;
            },
            &context),
        "complete environment is accepted");
  Check(context.worker_generation == 7, "generation parsed");
  Check(context.session_type == "LoginWindow", "session type parsed");
  Check(context.audit_session_id == 100003u, "audit session id parsed");
}

void HelloFrameIsExact() {
  macos::WorkerLaunchContext context;
  context.socket_path = "/tmp/s";
  context.challenge = "0123456789012345678901234567890123456789012";
  context.worker_generation = 7;
  std::string frame;
  Check(macos::BuildHelloFrame(context, &frame), "hello builds");
  const std::string expected =
      "{\"type\":\"remote_desktop.macos_ipc.hello\",\"ipcVersion\":1,"
      "\"workerGeneration\":7,"
      "\"challenge\":\"0123456789012345678901234567890123456789012\"}";
  Check(frame == expected, "hello frame is byte-exact");

  context.worker_generation = 0;
  Check(!macos::BuildHelloFrame(context, &frame), "zero generation refused");
}

void HostFrameParsingSeparatesStaleFromMalformed() {
  macos::HostCommandFrame parsed;
  const std::string good =
      "{\"type\":\"remote_desktop.macos_ipc.host_command\",\"ipcVersion\":1,"
      "\"workerGeneration\":7,\"command\":{\"type\":\"remote_desktop.stop\"}}";
  Check(macos::ParseHostCommandFrame(good, 7, &parsed) ==
            macos::HostFrameOutcome::kAccepted,
        "well-formed current frame accepted");
  Check(parsed.command_type == "remote_desktop.stop", "command type extracted");

  // A frame for another generation is reported as stale, not corrupt, so the
  // worker can log the right cause.
  Check(macos::ParseHostCommandFrame(good, 8, &parsed) ==
            macos::HostFrameOutcome::kStale,
        "other generation is stale");

  for (const char* bad : {
           "",
           "{}",
           "not json",
           "{\"type\":\"remote_desktop.macos_ipc.hello\",\"ipcVersion\":1,"
           "\"workerGeneration\":7,\"command\":{}}",
           "{\"type\":\"remote_desktop.macos_ipc.host_command\","
           "\"ipcVersion\":2,\"workerGeneration\":7,\"command\":{}}",
           "{\"type\":\"remote_desktop.macos_ipc.host_command\","
           "\"ipcVersion\":1,\"workerGeneration\":7,\"command\":{}} trailing",
           "{\"type\":\"remote_desktop.macos_ipc.host_command\","
           "\"ipcVersion\":1,\"workerGeneration\":7,\"command\":{},\"x\":1}",
       }) {
    Check(macos::ParseHostCommandFrame(bad, 7, &parsed) ==
              macos::HostFrameOutcome::kMalformed,
          "malformed frame rejected");
  }

  // A brace inside a string must not terminate the command object early.
  const std::string braced =
      "{\"type\":\"remote_desktop.macos_ipc.host_command\",\"ipcVersion\":1,"
      "\"workerGeneration\":7,\"command\":{\"type\":\"remote_desktop.stop\","
      "\"note\":\"}\"}}";
  Check(macos::ParseHostCommandFrame(braced, 7, &parsed) ==
            macos::HostFrameOutcome::kAccepted,
        "brace inside string does not end the object");
}

void FrameReaderTerminatesInsteadOfResynchronizing() {
  macos::FrameReader reader(32);
  std::vector<std::string> frames;
  Check(reader.Feed("a\nbb\n", &frames), "short frames feed");
  Check(frames.size() == 2 && frames[0] == "a" && frames[1] == "bb",
        "frames split on newline");

  frames.clear();
  const std::string oversized(64, 'x');
  Check(!reader.Feed(oversized, &frames), "oversize feed fails");
  Check(reader.overflowed(), "reader latches overflow");
  // Once overflowed the reader must stay refusing: resynchronizing to the next
  // newline is exactly how an oversized peer walks a reader past a boundary.
  Check(!reader.Feed("\nrecovered\n", &frames),
        "reader never resynchronizes after overflow");
}

void WorkerMessageFrameRefusesUnsafePayloads() {
  std::string frame;
  Check(macos::BuildWorkerMessageFrame(
            7, "{\"type\":\"remote_desktop.status\"}", &frame),
        "well-formed message frames");
  Check(frame.find("\"workerGeneration\":7") != std::string::npos,
        "generation stamped");
  Check(!macos::BuildWorkerMessageFrame(7, "not an object", &frame),
        "non-object refused");
  Check(!macos::BuildWorkerMessageFrame(7, "{\"a\":\"\n\"}", &frame),
        "embedded newline refused");
  Check(!macos::BuildWorkerMessageFrame(0, "{}", &frame),
        "zero generation refused");
}

// ---------------------------------------------------------------------------

void DisclosureEventsRoundTripAndFailClosed() {
  std::string line;
  Check(
      macos::SerializeDisclosureEvent(macos::DisclosureEvent::kReady, 7, &line),
      "ready serializes");
  Check(line == "IMCODES_DISCLOSURE_READY 7", "ready line is exact");

  macos::DisclosureEvent event = macos::DisclosureEvent::kFailed;
  std::uint64_t generation = 0;
  Check(macos::ParseDisclosureEvent(line, &event, &generation), "ready parses");
  Check(event == macos::DisclosureEvent::kReady && generation == 7,
        "ready round trips");

  for (const char* bad : {
           "",
           "IMCODES_DISCLOSURE_READY",
           "IMCODES_DISCLOSURE_READY 0",
           "IMCODES_DISCLOSURE_READY 07",
           "IMCODES_DISCLOSURE_READY 7 extra",
           "IMCODES_DISCLOSURE_UNKNOWN 7",
           "imcodes_disclosure_ready 7",
       }) {
    Check(!macos::ParseDisclosureEvent(bad, &event, &generation),
          "malformed disclosure line refused");
  }
}

void RouteAdmissionRequiresLiveDisclosure() {
  macos::DisclosureAdmission admission(7);
  // Nothing is admissible before the separate component confirms a window.
  Check(!admission.route_admissible(), "no admission before ready");

  // A ready for a different generation must never grant admission.
  Check(!admission.Apply(macos::DisclosureEvent::kReady, 8),
        "other generation ignored");
  Check(!admission.route_admissible(), "stale ready grants nothing");

  Check(admission.Apply(macos::DisclosureEvent::kReady, 7), "ready applies");
  Check(admission.route_admissible(), "ready admits the route");

  Check(admission.Apply(macos::DisclosureEvent::kStop, 7), "stop applies");
  Check(!admission.route_admissible(), "stop revokes admission");
  Check(admission.stop_requested(), "stop is recorded as user intent");
  Check(admission.terminated(), "stop terminates");
  // Terminal is one-way: a later ready cannot resurrect the session.
  Check(!admission.Apply(macos::DisclosureEvent::kReady, 7),
        "ready after stop is refused");
  Check(!admission.route_admissible(), "admission stays revoked");

  for (const auto losing :
       {macos::DisclosureEvent::kClosed, macos::DisclosureEvent::kFailed}) {
    macos::DisclosureAdmission fresh(9);
    Check(fresh.Apply(macos::DisclosureEvent::kReady, 9), "ready applies");
    Check(fresh.Apply(losing, 9), "losing event applies");
    // Losing the window is not user intent, but it revokes admission just as
    // hard: no visible disclosure means no remote access.
    Check(!fresh.route_admissible(), "lost window revokes admission");
    Check(!fresh.stop_requested(), "lost window is not a user stop");
  }
}

// ---------------------------------------------------------------------------
// Integration defect (1): cleanup must reach the long-lived generation.
// ---------------------------------------------------------------------------

void ControlSocketPathIsDerivedWithoutEnvironment() {
  std::string path;
  Check(macos::BuildControlSocketPath(501, &path), "path builds for a uid");
  // The cleanup process is launched with an empty environment, so the path can
  // only come from the compile-time root plus its own uid.
  Check(path ==
            "/private/var/run/imcodes-node/user-sessions/501/remote-desktop/"
            "remote-desktop-control.sock",
        "control socket path is exact");
  // A truncated sun_path would connect somewhere other than intended.
  Check(path.size() < 104, "path fits sockaddr_un");
  // Even the widest representable uid must fit, so the derivation can never
  // depend on which user is logged in. (97 bytes at uid 4294967295; the
  // length guard in BuildControlSocketPath is therefore unreachable via uid
  // alone and is kept only as defence against a future root/name change.)
  std::string widest;
  Check(macos::BuildControlSocketPath(4294967295u, &widest),
        "widest uid still fits");
  Check(widest.size() < 104, "widest uid path fits sockaddr_un");
  Check(widest.find("/4294967295/") != std::string::npos,
        "widest uid appears in the path");
}

void ControlProtocolRoundTripsAndFailsClosed() {
  std::string request;
  Check(macos::SerializeControlRequest(macos::ControlVerb::kReleaseInput, 7,
                                       &request),
        "request serializes");
  Check(request == "IMCODES_CONTROL_V1 RELEASE_INPUT 7",
        "request line is exact");

  macos::ControlVerb verb = macos::ControlVerb::kStopCapture;
  std::uint64_t generation = 0;
  Check(macos::ParseControlRequest(request, &verb, &generation),
        "request parses");
  Check(verb == macos::ControlVerb::kReleaseInput && generation == 7,
        "request round trips");

  for (const char* bad : {
           "",
           "IMCODES_CONTROL_V1 RELEASE_INPUT",
           "IMCODES_CONTROL_V1 RELEASE_INPUT 7 extra",
           "IMCODES_CONTROL_V1  RELEASE_INPUT 7",
           "IMCODES_CONTROL_V0 RELEASE_INPUT 7",
           "IMCODES_CONTROL_V1 REBOOT 7",
           "IMCODES_CONTROL_V1 RELEASE_INPUT 07",
       }) {
    Check(!macos::ParseControlRequest(bad, &verb, &generation),
          "malformed request refused");
  }

  std::string reply;
  Check(macos::SerializeControlOk(7, &reply), "ok serializes");
  Check(reply == "IMCODES_CONTROL_V1 OK 7", "ok line is exact");
  macos::ControlResponse response;
  Check(macos::ParseControlResponse(reply, &response), "ok parses");
  Check(response.ok && response.generation == 7,
        "success names the generation that acted");

  // A success that does not name a generation proves nothing and is refused.
  Check(!macos::ParseControlResponse("IMCODES_CONTROL_V1 OK 0", &response),
        "zero generation success refused");
  Check(!macos::SerializeControlOk(0, &reply), "cannot serialize zero ok");

  Check(
      macos::SerializeControlError(macos::kControlErrorNoActiveSession, &reply),
      "error serializes");
  Check(macos::ParseControlResponse(reply, &response), "error parses");
  Check(!response.ok && response.error == "no_active_session",
        "error reason round trips");
  // A reason containing a space would silently split the fixed line format.
  Check(!macos::SerializeControlError("no active session", &reply),
        "spaced reason refused");
}

void CleanupCannotSucceedWithoutALiveGeneration() {
  std::string reason;
  // This is the defect the integration review found: a fresh sibling process
  // owns nothing, so acting on its own state would be meaningless. Zero active
  // generation must never authorize a cleanup.
  Check(!macos::ControlRequestMayAct(0, 0, &reason),
        "no active session refuses any-generation cleanup");
  Check(reason == "no_active_session", "reason is no_active_session");
  Check(!macos::ControlRequestMayAct(7, 0, &reason),
        "no active session refuses exact-generation cleanup");

  Check(macos::ControlRequestMayAct(0, 7, &reason),
        "zero request acts on whatever is owned");
  Check(macos::ControlRequestMayAct(7, 7, &reason), "exact match acts");
  Check(!macos::ControlRequestMayAct(8, 7, &reason),
        "stale generation is refused");
  Check(reason == "generation_mismatch", "reason is generation_mismatch");
}

}  // namespace

// ── HOST_COMMAND dispatch ──────────────────────────────────────────────────
//
// The dispatcher was extracted from the worker entry point precisely so these
// cases can exist: inside the entry point it pulls in ScreenCaptureKit and
// libwebrtc and cannot be linked here at all.

class FakeSession final : public macos::HostCommandSessionSeam {
 public:
  bool Prepare(const imcodes::rd::Authority& authority,
               std::int64_t now_unix_ms,
               std::int64_t now_monotonic_ms) override {
    ++prepares;
    last = authority;
    return accept && now_unix_ms == 1000 && now_monotonic_ms == 2000;
  }
  bool NegotiateOffer(const imcodes::rd::Authority& authority,
                      std::string_view offer_sdp,
                      std::string* answer_sdp) override {
    ++offers;
    last = authority;
    if (!accept || offer_sdp != "v=0\r\no=offer")
      return false;
    *answer_sdp = "v=0\r\no=answer";
    return true;
  }
  bool AddRemoteIce(const imcodes::rd::Authority& authority,
                    std::string_view media_id,
                    std::string_view candidate) override {
    ++ice;
    last = authority;
    return accept && media_id == "0" && candidate == "candidate:1";
  }
  bool RenewLease(const imcodes::rd::Authority& authority,
                  std::int64_t now_unix_ms,
                  std::int64_t now_monotonic_ms) override {
    ++leases;
    last = authority;
    return accept && now_unix_ms == 1000 && now_monotonic_ms == 2000;
  }
  bool SetMode(const imcodes::rd::Authority& authority,
               std::string_view reason,
               std::int64_t now_unix_ms,
               std::int64_t now_monotonic_ms) override {
    ++modes;
    last = authority;
    return accept && reason == "user_selected" && now_unix_ms == 1000 &&
           now_monotonic_ms == 2000;
  }
  bool Stop(const imcodes::rd::Authority& authority) override {
    ++stops;
    last = authority;
    return accept;
  }

  bool accept = true;
  int prepares = 0;
  int offers = 0;
  int ice = 0;
  int leases = 0;
  int modes = 0;
  int stops = 0;
  imcodes::rd::Authority last;
};

class FakeDisclosure final : public macos::HostCommandDisclosureSeam {
 public:
  explicit FakeDisclosure(bool admissible) noexcept : admissible_(admissible) {}
  [[nodiscard]] bool route_admissible() const override { return admissible_; }

 private:
  bool admissible_;
};

class RecordingSink final : public macos::HostCommandMessageSink {
 public:
  bool EmitInitialMode(const imcodes::rd::Authority&) override {
    emitted.push_back("mode:initial");
    return emit_ok;
  }
  bool EmitAnswer(const imcodes::rd::Authority&,
                  std::string_view answer_sdp) override {
    emitted.push_back("answer:" + std::string(answer_sdp));
    return emit_ok;
  }
  bool EmitModeState(const imcodes::rd::Authority&,
                     std::string_view reason) override {
    emitted.push_back("mode:" + std::string(reason));
    return emit_ok;
  }
  bool EmitTerminal(const imcodes::rd::Authority&,
                    std::string_view reason,
                    std::string_view detail) override {
    emitted.push_back("terminal:" + std::string(reason) + ":" +
                      std::string(detail));
    return emit_ok;
  }
  bool emit_ok = true;
  std::vector<std::string> emitted;
};

imcodes::rd::Authority Authority() {
  imcodes::rd::Authority authority;
  authority.request_id = "request_12345678";
  authority.session_id = "session_12345678";
  authority.capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  authority.expires_at_ms = 50'000;
  authority.lease_expires_at_ms = 20'000;
  authority.daemon_generation = 9;
  authority.route_generation = 4;
  authority.mode = "view";
  authority.input_epoch = 0;
  return authority;
}

imcodes::rd::Signal Signal(imcodes::rd::Signal::Kind kind) {
  imcodes::rd::Signal signal;
  signal.kind = kind;
  signal.authority = Authority();
  return signal;
}

macos::HostCommandResult Dispatch(const imcodes::rd::Signal& signal,
                                  FakeSession* session,
                                  FakeDisclosure* disclosure,
                                  RecordingSink* sink) {
  return macos::DispatchHostCommand(signal, 1000, 2000, session, disclosure,
                                    sink);
}

void StopTearsDownBeforeTerminal() {
  FakeSession session;
  FakeDisclosure disclosure(true);
  RecordingSink sink;
  const auto result = Dispatch(Signal(imcodes::rd::Signal::Kind::kStop),
                               &session, &disclosure, &sink);
  Check(session.stops == 1, "stop reaches the live session exactly once");
  Check(result.disposition == macos::HostCommandDisposition::kTerminate,
        "stop terminates the worker route loop");
  Check(sink.emitted.size() == 1 &&
            sink.emitted[0] == "terminal:stopped_by_controller:",
        "stop emits the protocol terminal rather than an invalid status");
}

void RouteCommandsDriveTheSessionAndRemainLive() {
  FakeSession session;
  FakeDisclosure disclosure(true);
  RecordingSink sink;

  auto prepare = Signal(imcodes::rd::Signal::Kind::kPrepare);
  Check(Dispatch(prepare, &session, &disclosure, &sink).disposition ==
            macos::HostCommandDisposition::kContinue,
        "successful PREPARE keeps the worker alive");
  Check(session.prepares == 1 && sink.emitted.back() == "mode:initial",
        "PREPARE starts the real session and emits initial mode");

  auto offer = Signal(imcodes::rd::Signal::Kind::kOffer);
  offer.sdp = "v=0\r\no=offer";
  Check(Dispatch(offer, &session, &disclosure, &sink).disposition ==
            macos::HostCommandDisposition::kContinue,
        "successful OFFER keeps the worker alive");
  Check(session.offers == 1 && sink.emitted.back() == "answer:v=0\r\no=answer",
        "OFFER emits only the answer produced after negotiation");

  auto ice = Signal(imcodes::rd::Signal::Kind::kIce);
  ice.mid = "0";
  ice.candidate = "candidate:1";
  Check(Dispatch(ice, &session, &disclosure, &sink).disposition ==
                macos::HostCommandDisposition::kContinue &&
            session.ice == 1,
        "ICE reaches the transport without synthetic acknowledgement");

  auto lease = Signal(imcodes::rd::Signal::Kind::kLease);
  Check(Dispatch(lease, &session, &disclosure, &sink).disposition ==
                macos::HostCommandDisposition::kContinue &&
            session.leases == 1,
        "LEASE reaches authority renewal");

  auto mode = Signal(imcodes::rd::Signal::Kind::kMode);
  mode.authority.mode = "control";
  mode.authority.input_epoch = 1;
  mode.reason = "user_selected";
  Check(Dispatch(mode, &session, &disclosure, &sink).disposition ==
                macos::HostCommandDisposition::kContinue &&
            session.modes == 1 && sink.emitted.back() == "mode:user_selected",
        "MODE applies exact authority then emits mode state");
}

void RouteCommandsRefuseWithoutVisibleDisclosure() {
  for (const auto kind :
       {imcodes::rd::Signal::Kind::kPrepare, imcodes::rd::Signal::Kind::kOffer,
        imcodes::rd::Signal::Kind::kLease, imcodes::rd::Signal::Kind::kMode,
        imcodes::rd::Signal::Kind::kIce}) {
    FakeSession session;
    FakeDisclosure disclosure(false);
    RecordingSink sink;
    const auto result = Dispatch(Signal(kind), &session, &disclosure, &sink);
    Check(result.disposition == macos::HostCommandDisposition::kTerminate &&
              result.diagnostic == macos::kDiagCommandRejected,
          "route without disclosure terminates as rejected");
    Check(session.stops == 1 && sink.emitted.size() == 1 &&
              sink.emitted[0] == "terminal:capability_unavailable:",
          "disclosure loss stops capture and emits a valid terminal");
  }
}

void RejectedOperationsStopAndEmitTruthfulTerminal() {
  FakeSession session;
  session.accept = false;
  FakeDisclosure disclosure(true);
  RecordingSink sink;
  const auto result = Dispatch(Signal(imcodes::rd::Signal::Kind::kLease),
                               &session, &disclosure, &sink);
  Check(result.disposition == macos::HostCommandDisposition::kTerminate,
        "rejected authority transition terminates");
  Check(session.leases == 1 && session.stops == 1,
        "rejected transition attempts cleanup");
  Check(
      sink.emitted.size() == 1 && sink.emitted[0] == "terminal:protocol_error:",
      "rejected transition emits protocol_error terminal");
}

void MessageEmissionFailureTerminates() {
  FakeSession session;
  FakeDisclosure disclosure(true);
  RecordingSink sink;
  sink.emit_ok = false;
  const auto result = Dispatch(Signal(imcodes::rd::Signal::Kind::kPrepare),
                               &session, &disclosure, &sink);
  Check(result.disposition == macos::HostCommandDisposition::kTerminate &&
            result.diagnostic == macos::kDiagMessageEmissionFailed,
        "an upstream write failure cannot leave the worker running silently");
}

int main() {
  ReadinessEmitsExactlyTheContractShape();
  ReadinessRefusesUnrepresentableSnapshots();
  ReadinessCommandAsksTheProbeExactlyOnce();
  ReadinessRejectsGenerationScoping();
  PermissionRegistrationIsExplicitAndUserControlled();
  CleanupFailsWhenItCannotActOnActiveGeneration();
  CommandParsingRejectsMalformedGeneration();
  LaunchContextRefusesDefaults();
  HelloFrameIsExact();
  HostFrameParsingSeparatesStaleFromMalformed();
  FrameReaderTerminatesInsteadOfResynchronizing();
  WorkerMessageFrameRefusesUnsafePayloads();
  DisclosureEventsRoundTripAndFailClosed();
  RouteAdmissionRequiresLiveDisclosure();
  ControlSocketPathIsDerivedWithoutEnvironment();
  ControlProtocolRoundTripsAndFailsClosed();
  CleanupCannotSucceedWithoutALiveGeneration();

  StopTearsDownBeforeTerminal();
  RouteCommandsDriveTheSessionAndRemainLive();
  RouteCommandsRefuseWithoutVisibleDisclosure();
  RejectedOperationsStopAndEmitTruthfulTerminal();
  MessageEmissionFailureTerminates();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d native command counterfactual failure(s)\n",
                 g_failures);
    return EXIT_FAILURE;
  }
  std::printf("macos native command/ipc/disclosure counterfactual ok\n");
  return EXIT_SUCCESS;
}
