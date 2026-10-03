// Production-chain counterfactual: launch context -> session identity ->
// worker composition -> capability admission.
//
// The point of this file is that it links the SAME functions the LaunchAgent
// worker calls, in the same order, rather than re-describing them. Every case
// below is a counterfactual: it asserts what the chain refuses, because the
// failure this slice exists to prevent is a worker that quietly composes the
// ordinary Aqua session at a login window and reports success.

#include "macos_authenticated_session_readiness.h"
#include "macos_login_window_capture.h"
#include "macos_session_identity.h"
#include "macos_worker_ipc_client.h"

#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace macos = imcodes::remote_desktop::macos;

namespace {

int g_failures = 0;

void Check(bool condition, const char* what) {
  if (condition) return;
  std::fprintf(stderr, "FAILED: %s\n", what);
  ++g_failures;
}

// ---------------------------------------------------------------------------
// Launch-context parsing.
// ---------------------------------------------------------------------------

std::map<std::string, std::string>& Environment() {
  static std::map<std::string, std::string> environment;
  return environment;
}

const char* LookupEnvironment(const char* name) {
  const auto found = Environment().find(name);
  return found == Environment().end() ? nullptr : found->second.c_str();
}

void ResetEnvironment(const char* session_type, const char* audit_session) {
  Environment() = {
      {macos::kEnvSocketPath, "/tmp/imcodes-test.sock"},
      {macos::kEnvLaunchChallenge,
       "0123456789012345678901234567890123456789012"},
      {macos::kEnvWorkerGeneration, "7"},
  };
  if (session_type != nullptr) {
    Environment()[macos::kEnvSessionType] = session_type;
  }
  if (audit_session != nullptr) {
    Environment()[macos::kEnvAuditSessionId] = audit_session;
  }
}

void ParserCounterfactuals() {
  macos::WorkerLaunchContext context;

  ResetEnvironment("Aqua", "100003");
  Check(macos::ReadWorkerLaunchContext(LookupEnvironment, &context),
        "an Aqua launch context parses");
  Check(context.session_type == "Aqua", "Aqua session type is carried through");
  Check(context.audit_session_id == 100003u, "audit session id is carried");
  Check(context.worker_generation == 7u, "worker generation is carried");

  ResetEnvironment("LoginWindow", "100000");
  Check(macos::ReadWorkerLaunchContext(LookupEnvironment, &context),
        "a LoginWindow launch context parses");
  Check(context.session_type == "LoginWindow",
        "LoginWindow session type is carried through");

  // Absent session type: the profile is derived from it, so a default would
  // silently hand the login window the full user surface.
  ResetEnvironment(nullptr, "100003");
  Check(!macos::ReadWorkerLaunchContext(LookupEnvironment, &context),
        "a missing session type is refused, never defaulted");

  ResetEnvironment("aqua", "100003");
  Check(!macos::ReadWorkerLaunchContext(LookupEnvironment, &context),
        "session type matching is exact, not case-insensitive");

  ResetEnvironment("Console", "100003");
  Check(!macos::ReadWorkerLaunchContext(LookupEnvironment, &context),
        "an unrecognized session type is refused");

  // Audit session 0 is the absence of a session, not a session numbered zero.
  ResetEnvironment("LoginWindow", "0");
  Check(!macos::ReadWorkerLaunchContext(LookupEnvironment, &context),
        "audit session zero is refused");

  ResetEnvironment("LoginWindow", nullptr);
  Check(!macos::ReadWorkerLaunchContext(LookupEnvironment, &context),
        "a missing audit session is refused");

  ResetEnvironment("LoginWindow", "notanumber");
  Check(!macos::ReadWorkerLaunchContext(LookupEnvironment, &context),
        "a non-numeric audit session is refused");
}

void BootstrapCounterfactuals() {
  macos::BootstrapHelloContext hello;
  hello.uid = 88;
  hello.audit_session_id = 100000;
  hello.session_type = "LoginWindow";
  hello.instance_nonce =
      "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";
  std::string encoded;
  Check(macos::BuildBootstrapHelloFrame(hello, &encoded),
        "a LoginWindow instance can author a bootstrap hello without an Aqua user");
  Check(encoded.find("HOME") == std::string::npos &&
            encoded.find("TMPDIR") == std::string::npos &&
            encoded.find("challenge") == std::string::npos &&
            encoded.find("workerGeneration") == std::string::npos,
        "the bootstrap hello carries no inherited user or worker authority");

  const std::string socket =
      "/private/var/run/imcodes-node/graphical-sessions/88/100000/"
      "remote-desktop-agent.sock";
  const std::string grant =
      "{\"type\":\"remote_desktop.macos_bootstrap.grant\","
      "\"bootstrapVersion\":1,\"uid\":88,\"auditSessionId\":100000,"
      "\"sessionType\":\"LoginWindow\","
      "\"instanceNonce\":\"LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL\","
      "\"workerGeneration\":7,"
      "\"challenge\":\"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\","
      "\"socketPath\":\"" + socket + "\"}";
  macos::BootstrapGrant parsed;
  Check(macos::ParseBootstrapGrantFrame(grant, hello, &parsed),
        "the exact session-bound grant is accepted");
  Check(parsed.socket_path == socket && parsed.worker_generation == 7,
        "the accepted grant carries the isolated socket and generation");

  const auto replace_once = [](std::string value, const std::string& before,
                               const std::string& after) {
    const std::size_t at = value.find(before);
    if (at != std::string::npos) value.replace(at, before.size(), after);
    return value;
  };
  Check(!macos::ParseBootstrapGrantFrame(
            replace_once(grant, "\"uid\":88", "\"uid\":501"), hello,
            &parsed),
        "a mismatched uid grant is refused");
  Check(!macos::ParseBootstrapGrantFrame(
            replace_once(grant, "\"auditSessionId\":100000",
                          "\"auditSessionId\":100001"),
            hello, &parsed),
        "a successor audit-session grant is refused by the predecessor");
  Check(!macos::ParseBootstrapGrantFrame(
            replace_once(grant, hello.instance_nonce,
                          "RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR"),
            hello, &parsed),
        "a replayed grant for another process nonce is refused");
  Check(!macos::ParseBootstrapGrantFrame(
            replace_once(grant, socket,
                          "/private/var/run/imcodes-node/graphical-sessions/"
                          "88/99999/remote-desktop-agent.sock"),
            hello, &parsed),
        "a previous graphical-session socket is refused");
}

// ---------------------------------------------------------------------------
// Session identity: what the worker cross-checks the declaration against.
// ---------------------------------------------------------------------------

macos::MacosSessionIdentityObservation AquaObservation() {
  macos::MacosSessionIdentityObservation observation;
  observation.session_dictionary_available = true;
  observation.login_done = true;
  observation.on_console = true;
  observation.has_console_user = true;
  observation.audit_session_id = 100003;
  observation.window_server_audit_session_id = 100003;
  observation.uid = 501;
  return observation;
}

macos::MacosSessionIdentityObservation LoginWindowObservation() {
  macos::MacosSessionIdentityObservation observation = AquaObservation();
  observation.login_done = false;
  observation.has_console_user = false;
  return observation;
}

void IdentityCounterfactuals() {
  Check(macos::ClassifyMacosSessionType(AquaObservation()) == "Aqua",
        "a logged-in console session classifies as Aqua");
  Check(macos::ClassifyMacosSessionType(LoginWindowObservation())
            == "LoginWindow",
        "no completed login and no named user classifies as LoginWindow");

  // A locked desktop is a logged-in Aqua session. Classifying it as a login
  // window would strip a real user's own session down to the restricted
  // profile the moment the screen saver kicked in.
  Check(macos::ClassifyMacosSessionType(AquaObservation()) == "Aqua",
        "a locked but logged-in session keeps the Aqua profile");

  // The two signals disagree: one is being misread. Refused rather than
  // guessed. This is the case that catches a misspelled dictionary key.
  macos::MacosSessionIdentityObservation disagreeing = AquaObservation();
  disagreeing.login_done = false;
  Check(macos::ClassifyMacosSessionType(disagreeing).empty(),
        "a named user with no completed login is refused, not guessed");
  disagreeing = AquaObservation();
  disagreeing.has_console_user = false;
  Check(macos::ClassifyMacosSessionType(disagreeing).empty(),
        "a completed login with no named user is refused, not guessed");

  macos::MacosSessionIdentityObservation background = AquaObservation();
  background.on_console = false;
  Check(macos::ClassifyMacosSessionType(background).empty(),
        "a background fast-user-switching session is not Aqua");

  macos::MacosSessionIdentityObservation no_dictionary = AquaObservation();
  no_dictionary.session_dictionary_available = false;
  Check(macos::ClassifyMacosSessionType(no_dictionary).empty(),
        "no session dictionary is not evidence of a login window");

  macos::MacosSessionIdentityObservation no_audit = AquaObservation();
  no_audit.audit_session_id = 0;
  Check(macos::ClassifyMacosSessionType(no_audit).empty(),
        "an absent audit session is refused");

  macos::MacosSessionIdentityObservation skewed = AquaObservation();
  skewed.window_server_audit_session_id = 100004;
  Check(macos::ClassifyMacosSessionType(skewed).empty(),
        "a dictionary describing another session is refused");

  // The declaration arrives through the environment. It is a claim, and the
  // worker requires it to equal what the kernel says.
  const macos::MacosSessionIdentityObservation aqua = AquaObservation();
  Check(macos::MacosSessionIdentityMatches(aqua, "Aqua", 100003, 501),
        "a truthful Aqua declaration matches");
  Check(!macos::MacosSessionIdentityMatches(aqua, "LoginWindow", 100003, 501),
        "an Aqua session may not declare itself a login window");
  const macos::MacosSessionIdentityObservation login = LoginWindowObservation();
  Check(!macos::MacosSessionIdentityMatches(login, "Aqua", 100003, 501),
        "a login window may not declare itself Aqua and take the user profile");
  Check(!macos::MacosSessionIdentityMatches(aqua, "Aqua", 100004, 501),
        "a forged audit session id is refused");
  Check(!macos::MacosSessionIdentityMatches(aqua, "Aqua", 100003, 502),
        "a forged uid is refused");
  Check(!macos::MacosSessionIdentityMatches(no_dictionary, "", 100003, 501),
        "two unknowns are not an agreement");
}

// ---------------------------------------------------------------------------
// Worker composition: which backend the real session adapter will own.
// ---------------------------------------------------------------------------

class CountingBackend final : public macos::ScreenCaptureKitBackend {
 public:
  imcodes::remote_desktop::common::ReadinessState ProbeReadiness() noexcept
      override {
    return imcodes::remote_desktop::common::ReadinessState::kReady;
  }
  bool EnumerateDisplays(std::uint32_t, std::uint32_t,
                         std::vector<macos::ScreenCaptureKitBackendDisplay>*,
                         macos::CaptureError*) override {
    return false;
  }
  std::unique_ptr<macos::ScreenCaptureKitBackendStream> CreateStream(
      const macos::ScreenCaptureKitStreamConfiguration&,
      macos::ScreenCaptureKitBackendFrameSink,
      macos::ScreenCaptureKitBackendErrorSink,
      macos::CaptureError*) override {
    return nullptr;
  }
};

struct FactoryLog {
  int calls = 0;
  macos::LoginWindowCaptureBackend requested =
      macos::LoginWindowCaptureBackend::kUnavailable;
  bool refuse = false;
};

macos::LoginWindowCaptureBackendFactory MakeFactory(FactoryLog* log) {
  return [log](macos::LoginWindowCaptureBackend selected)
             -> std::unique_ptr<macos::ScreenCaptureKitBackend> {
    ++log->calls;
    log->requested = selected;
    if (log->refuse) return nullptr;
    return std::make_unique<CountingBackend>();
  };
}

macos::LoginWindowCaptureRequest MakeRequest(const char* session_type,
                                             std::uint32_t major,
                                             std::uint32_t minor) {
  macos::LoginWindowCaptureRequest request;
  request.binding.session_type = session_type;
  request.binding.audit_session_id = 100003;
  request.binding.uid = 501;
  request.binding.launch_challenge = "challenge";
  request.binding.worker_generation = 7;
  request.os_major = major;
  request.os_minor = minor;
  return request;
}

void CompositionCounterfactuals() {
  // Aqua composes the ScreenCaptureKit backend.
  {
    FactoryLog log;
    std::unique_ptr<macos::ScreenCaptureKitBackend> backend;
    const auto outcome = macos::ComposeSessionCapture(
        MakeRequest("Aqua", 13, 6), nullptr, MakeFactory(&log), &backend);
    Check(outcome.status == macos::LoginWindowCaptureStatus::kOk,
          "Aqua composition succeeds");
    Check(outcome.backend == macos::LoginWindowCaptureBackend::kScreenCaptureKit,
          "Aqua selects ScreenCaptureKit");
    Check(backend != nullptr, "Aqua composition yields an owned backend");
    Check(outcome.profile.clipboard, "Aqua keeps its clipboard");
  }

  // The load-bearing case: a pre-14.4 login window must NOT get the
  // ScreenCaptureKit backend, because that backend cannot see the login window
  // on those releases. If this ever returns kScreenCaptureKit the operator gets
  // a session that composes cleanly and shows nothing.
  for (const auto& release : std::vector<std::pair<std::uint32_t, std::uint32_t>>{
           {12, 3}, {13, 6}, {14, 0}, {14, 3}}) {
    FactoryLog log;
    std::unique_ptr<macos::ScreenCaptureKitBackend> backend;
    const auto outcome = macos::ComposeSessionCapture(
        MakeRequest("LoginWindow", release.first, release.second), nullptr,
        MakeFactory(&log), &backend);
    Check(outcome.status == macos::LoginWindowCaptureStatus::kOk,
          "a pre-14.4 login window composes");
    Check(outcome.backend == macos::LoginWindowCaptureBackend::kCgDisplayStream,
          "a pre-14.4 login window selects CGDisplayStream, never SCK");
    Check(log.requested == macos::LoginWindowCaptureBackend::kCgDisplayStream,
          "the factory is asked for CGDisplayStream");
    Check(backend != nullptr, "the login window composition owns a backend");
  }

  for (const auto& release : std::vector<std::pair<std::uint32_t, std::uint32_t>>{
           {14, 4}, {14, 7}, {15, 0}, {26, 2}}) {
    FactoryLog log;
    std::unique_ptr<macos::ScreenCaptureKitBackend> backend;
    const auto outcome = macos::ComposeSessionCapture(
        MakeRequest("LoginWindow", release.first, release.second), nullptr,
        MakeFactory(&log), &backend);
    Check(outcome.backend == macos::LoginWindowCaptureBackend::kScreenCaptureKit,
          "14.4 and later serve the login window with ScreenCaptureKit");
    Check(backend != nullptr, "the 14.4+ login window composition owns a backend");
  }

  // A build that cannot supply the selected backend refuses. It must never
  // substitute the other one: substitution IS the Aqua fallback.
  {
    FactoryLog log;
    log.refuse = true;
    std::unique_ptr<macos::ScreenCaptureKitBackend> backend;
    const auto outcome = macos::ComposeSessionCapture(
        MakeRequest("LoginWindow", 13, 6), nullptr, MakeFactory(&log), &backend);
    Check(outcome.status == macos::LoginWindowCaptureStatus::kBackendUnavailable,
          "an unavailable backend is refused");
    Check(backend == nullptr,
          "a refused composition leaves no backend behind to fall back on");
    Check(log.calls == 1, "the factory is asked exactly once, for one backend");
  }

  // Admission ordering: nothing is constructed when the binding is not
  // admissible. A factory call on these paths would mean the worker had already
  // started acquiring capture resources for a principal it then rejected.
  struct RefusedCase {
    const char* what;
    macos::LoginWindowCaptureRequest request;
    const macos::CaptureSessionBinding* previous;
    macos::LoginWindowCaptureStatus expected;
  };

  macos::LoginWindowCaptureRequest incomplete = MakeRequest("LoginWindow", 13, 6);
  incomplete.binding.launch_challenge.clear();

  macos::LoginWindowCaptureRequest zero_audit = MakeRequest("LoginWindow", 13, 6);
  zero_audit.binding.audit_session_id = 0;

  macos::LoginWindowCaptureRequest zero_generation =
      MakeRequest("LoginWindow", 13, 6);
  zero_generation.binding.worker_generation = 0;

  macos::LoginWindowCaptureRequest unknown_type = MakeRequest("Console", 13, 6);

  macos::LoginWindowCaptureRequest bad_bounds = MakeRequest("LoginWindow", 13, 6);
  bad_bounds.limits.frame_rate = 0;

  // Logging in replaces the principal: a LoginWindow binding must not survive
  // into the Aqua session that follows it.
  macos::CaptureSessionBinding previous = MakeRequest("LoginWindow", 13, 6).binding;
  macos::LoginWindowCaptureRequest after_login = MakeRequest("Aqua", 13, 6);

  const std::vector<RefusedCase> refused = {
      {"an incomplete binding is refused before any backend exists", incomplete,
       nullptr, macos::LoginWindowCaptureStatus::kBindingIncomplete},
      {"a zero audit session is refused", zero_audit, nullptr,
       macos::LoginWindowCaptureStatus::kBindingIncomplete},
      {"a zero worker generation is refused", zero_generation, nullptr,
       macos::LoginWindowCaptureStatus::kBindingIncomplete},
      // Refused at binding completeness, which is the first gate: an
      // unrecognized session type is not a principal, so the ordering never
      // reaches the profile check.
      {"an unknown session type composes nothing", unknown_type, nullptr,
       macos::LoginWindowCaptureStatus::kBindingIncomplete},
      {"invalid bounds are refused once, before backend selection", bad_bounds,
       nullptr, macos::LoginWindowCaptureStatus::kBoundsInvalid},
      {"authority does not migrate from the login window into Aqua",
       after_login, &previous,
       macos::LoginWindowCaptureStatus::kAuthorityMigrated},
  };

  for (const RefusedCase& refused_case : refused) {
    FactoryLog log;
    std::unique_ptr<macos::ScreenCaptureKitBackend> backend;
    const auto outcome =
        macos::ComposeSessionCapture(refused_case.request, refused_case.previous,
                                     MakeFactory(&log), &backend);
    Check(outcome.status == refused_case.expected, refused_case.what);
    Check(backend == nullptr, "a refused composition owns no backend");
    Check(log.calls == 0, "a refused composition never reaches the factory");
  }
}

// ---------------------------------------------------------------------------
// Capability admission: what the composed session may then do.
// ---------------------------------------------------------------------------

void ProfileCounterfactuals() {
  const macos::SessionCapabilityProfile aqua =
      macos::CapabilityProfileFor("Aqua");
  Check(aqua.capture && aqua.pointer && aqua.keyboard && aqua.clipboard
            && aqua.file_transfer && aqua.keychain && aqua.shell
            && aqua.computer_use,
        "an Aqua session keeps the full surface");

  const macos::SessionCapabilityProfile login =
      macos::CapabilityProfileFor("LoginWindow");
  // Capture plus login-safe pointer/keyboard/button: enough to type a password
  // and click, which is the entire point of reaching a login window remotely.
  Check(login.capture, "the login window may be captured");
  Check(login.pointer, "the login window admits pointer input");
  Check(login.keyboard, "the login window admits key and button input");
  // Everything below is a user-only operation. There is no logged-in user, so
  // a clipboard read would return whatever the previous session left behind and
  // a shell would run as a principal nobody authenticated as.
  Check(!login.clipboard, "the login window has no clipboard");
  Check(!login.file_transfer, "the login window has no file transfer");
  Check(!login.keychain, "the login window has no keychain access");
  Check(!login.shell, "the login window has no shell");
  Check(!login.computer_use, "the login window has no Computer Use surface");

  const macos::SessionCapabilityProfile unknown =
      macos::CapabilityProfileFor("Console");
  Check(!unknown.capture && !unknown.pointer && !unknown.keyboard
            && !unknown.clipboard && !unknown.file_transfer && !unknown.keychain
            && !unknown.shell && !unknown.computer_use,
        "an unrecognized session type gets nothing at all");
}

// ---------------------------------------------------------------------------
// Authenticated readiness: the post-composition evidence the daemon consumes.
// ---------------------------------------------------------------------------

void AuthenticatedReadinessCounterfactuals() {
  macos::WorkerLaunchContext launch{
      .socket_path =
          "/private/var/run/imcodes-node/graphical-sessions/88/100000/"
          "remote-desktop-agent.sock",
      .challenge = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      .worker_generation = 7,
      .session_type = "LoginWindow",
      .audit_session_id = 100000,
      .uid = 88,
  };
  const std::string acknowledgement =
      "{\"type\":\"remote_desktop.macos_ipc.authenticated\","
      "\"ipcVersion\":1,\"workerGeneration\":7,\"uid\":88,"
      "\"auditSessionId\":100000,\"pidVersion\":44,"
      "\"sessionType\":\"LoginWindow\","
      "\"launchChallenge\":"
      "\"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\"}";
  macos::IpcAuthenticationAcknowledgement peer_ack;
  Check(macos::IsGraphicalBootstrapLaunchContext(launch) &&
            macos::ParseIpcAuthenticationAcknowledgement(
                acknowledgement, launch, &peer_ack),
        "the exact graphical socket and authenticated peer admit readiness");

  macos::CaptureSessionBinding binding{
      .session_type = launch.session_type,
      .audit_session_id = launch.audit_session_id,
      .uid = launch.uid,
      .launch_challenge = launch.challenge,
      .worker_generation = launch.worker_generation,
  };
  macos::AuthenticatedGraphicalPeer peer{
      .uid = peer_ack.uid,
      .audit_session_id = peer_ack.audit_session_id,
      .pid_version = peer_ack.pid_version,
      .worker_generation = peer_ack.worker_generation,
      .session_type = peer_ack.session_type,
      .launch_challenge = peer_ack.launch_challenge,
  };
  imcodes::remote_desktop::common::CapabilityReadiness readiness{
      .capture = imcodes::remote_desktop::common::ReadinessState::kReady,
      .encoder = imcodes::remote_desktop::common::ReadinessState::kReady,
      .input = imcodes::remote_desktop::common::ReadinessState::kReady,
      .clipboard = imcodes::remote_desktop::common::ReadinessState::kUnavailable,
      .display = imcodes::remote_desktop::common::ReadinessState::kReady,
      .disclosure = imcodes::remote_desktop::common::ReadinessState::kReady,
      .graphical_session = imcodes::remote_desktop::common::ReadinessState::kReady,
  };
  std::string frame;
  Check(macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, peer, readiness, true, &frame),
        "the authenticated post-composition readiness frame is authored");
  peer.audit_session_id = 100001;
  Check(!macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, peer, readiness, true, &frame),
        "a successor graphical session cannot reuse readiness");
  peer.audit_session_id = binding.audit_session_id;
  readiness.clipboard =
      imcodes::remote_desktop::common::ReadinessState::kReady;
  Check(!macos::BuildAuthenticatedGraphicalReadinessFrame(
            binding, peer, readiness, true, &frame),
        "a widened LoginWindow composition is refused rather than masked");
}

// ---------------------------------------------------------------------------
// Live probe: the dictionary keys themselves.
//
// Every case above builds its observation by hand, so none of them can tell
// whether `ObserveMacosSessionIdentity` reads the right keys out of the window
// server. That is not hypothetical: the login key is spelled `kCGSession...`
// with one S while its neighbours use two, and a misspelled key reads as
// absent -- which classifies a logged-in desktop as a login window and strips
// a real user's session down to the restricted profile.
//
// Runs only where the answer is knowable: a session that owns the console and
// names a user is a logged-in desktop by definition, whatever the login key
// says, so the classification must be Aqua. On a machine with no window server
// session, or one genuinely at a login window, this is skipped rather than
// guessed at.
// ---------------------------------------------------------------------------

void LiveProbeCounterfactual() {
  const macos::MacosSessionIdentityObservation observed =
      macos::ObserveMacosSessionIdentity();
  if (!observed.session_dictionary_available) {
    std::printf("skipped live probe: no window server session dictionary\n");
    return;
  }

  // Key names first, and by presence rather than by value. Asserting on values
  // alone is not enough: a misspelled key reads as absent, and the guard that
  // decides whether to run the rest of this probe is itself built out of those
  // keys, so a misspelling would silently skip the check instead of failing it.
  //
  // These three exist in every window server session, login window included.
  Check(observed.login_done_present,
        "the login-done key name is correct (kCGSessionLoginDoneKey -- one S, "
        "unlike its neighbours)");
  Check(observed.on_console_present,
        "the on-console key name is correct (kCGSSessionOnConsoleKey)");
  Check(observed.window_server_audit_session_id != 0,
        "the audit-id key name is correct (kCGSSessionAuditIDKey)");
  // The user-name key is legitimately absent at a login window, so it is
  // asserted against the login state rather than unconditionally: a completed
  // login names a user.
  if (observed.login_done) {
    Check(observed.has_console_user,
          "a completed login names a console user -- if this fails the "
          "user-name key is being misread");
  }

  Check(observed.audit_session_id != 0,
        "the kernel reports an audit session for this process");
  Check(observed.window_server_audit_session_id == observed.audit_session_id,
        "the window server and the kernel agree on the audit session");

  if (!observed.on_console || !observed.has_console_user) {
    std::printf(
        "skipped live classification: not a logged-in console session "
        "(console=%d user=%d)\n",
        observed.on_console ? 1 : 0, observed.has_console_user ? 1 : 0);
    return;
  }
  Check(macos::ClassifyMacosSessionType(observed) == "Aqua",
        "a live logged-in console session classifies as Aqua");
  Check(!macos::MacosSessionIdentityMatches(observed, "LoginWindow",
                                            observed.audit_session_id,
                                            observed.uid),
        "a live Aqua session refuses a forged LoginWindow declaration");
}

}  // namespace

int main() {
  ParserCounterfactuals();
  BootstrapCounterfactuals();
  IdentityCounterfactuals();
  CompositionCounterfactuals();
  ProfileCounterfactuals();
  AuthenticatedReadinessCounterfactuals();
  LiveProbeCounterfactual();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d production-chain counterfactual(s) failed\n",
                 g_failures);
    return 1;
  }
  std::printf("macos loginwindow production chain counterfactual ok\n");
  return 0;
}
