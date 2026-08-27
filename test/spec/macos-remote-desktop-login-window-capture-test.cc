// Counterfactuals for LoginWindow capture selection, bounds and profile.
//
// Linked without any Apple header so every branch runs under ASan/UBSan on a
// machine that has no login window, no signing identity and no pinned checkout.
// Both backends are the same fake type on purpose: that is the property under
// test — one interface means the bounds cannot drift between the two paths.

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#include "macos_login_window_capture.h"

namespace macos = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

int g_failures = 0;

void Check(bool condition, const char* label) {
  if (condition) return;
  std::fprintf(stderr, "FAIL %s\n", label);
  ++g_failures;
}

/**
 * Observations recorded here rather than on the stream itself.
 *
 * The supervisor destroys the stream on every failure path -- correctly -- so a
 * test that read counters through a pointer to it would be reading freed
 * memory. ASan caught exactly that in the first version of this file.
 */
struct StreamObservations {
  int stops = 0;
  std::uint32_t start_timeout = 0;
  std::uint32_t first_frame_timeout = 0;
  std::uint32_t stop_timeout = 0;
  bool created = false;
};

class FakeStream final : public macos::ScreenCaptureKitBackendStream {
 public:
  bool start_ok = true;
  bool first_frame_ok = true;
  StreamObservations* observations = nullptr;

  bool Start(std::uint32_t timeout_ms, std::string* error) override {
    if (observations != nullptr) observations->start_timeout = timeout_ms;
    if (!start_ok && error != nullptr) *error = "start_failed";
    return start_ok;
  }
  bool WaitForFirstFrame(std::uint32_t timeout_ms, std::string* error) override {
    if (observations != nullptr) observations->first_frame_timeout = timeout_ms;
    if (!first_frame_ok && error != nullptr) *error = "no_first_frame";
    return first_frame_ok;
  }
  void Stop(std::uint32_t timeout_ms) noexcept override {
    if (observations == nullptr) return;
    observations->stop_timeout = timeout_ms;
    ++observations->stops;
  }
};

class FakeBackend final : public macos::ScreenCaptureKitBackend {
 public:
  bool enumerate_ok = true;
  bool empty_displays = false;
  bool create_ok = true;
  // Set on the stream the fake hands back, so a start/first-frame failure can
  // be arranged without subclassing.
  bool stream_start_ok = true;
  bool stream_first_frame_ok = true;
  int enumerate_calls = 0;
  int create_calls = 0;
  std::uint32_t enumerate_timeout = 0;
  std::uint32_t enumerate_max = 0;
  macos::ScreenCaptureKitStreamConfiguration last_configuration;
  StreamObservations observations;

  common::ReadinessState ProbeReadiness() noexcept override {
    return common::ReadinessState{};
  }

  bool EnumerateDisplays(
      std::uint32_t timeout_ms,
      std::uint32_t max_displays,
      std::vector<macos::ScreenCaptureKitBackendDisplay>* displays,
      macos::CaptureError* error) override {
    (void)error;
    ++enumerate_calls;
    enumerate_timeout = timeout_ms;
    enumerate_max = max_displays;
    if (!enumerate_ok) return false;
    if (!empty_displays && displays != nullptr) {
      macos::ScreenCaptureKitBackendDisplay display;
      display.native_display_id = 7;
      display.encoded_pixels = common::PixelSize{1920, 1080};
      displays->push_back(display);
    }
    return true;
  }

  std::unique_ptr<macos::ScreenCaptureKitBackendStream> CreateStream(
      const macos::ScreenCaptureKitStreamConfiguration& configuration,
      macos::ScreenCaptureKitBackendFrameSink frame_sink,
      macos::ScreenCaptureKitBackendErrorSink error_sink,
      macos::CaptureError* error) override {
    (void)frame_sink;
    (void)error_sink;
    (void)error;
    ++create_calls;
    last_configuration = configuration;
    if (!create_ok) return nullptr;
    auto stream = std::make_unique<FakeStream>();
    stream->start_ok = stream_start_ok;
    stream->first_frame_ok = stream_first_frame_ok;
    stream->observations = &observations;
    observations.created = true;
    return stream;
  }
};

macos::CaptureSessionBinding Binding(const char* session_type) {
  macos::CaptureSessionBinding binding;
  binding.session_type = session_type;
  binding.audit_session_id = 100001;
  binding.uid = 501;
  binding.launch_challenge = std::string(43, 'A');
  binding.worker_generation = 3;
  return binding;
}

macos::LoginWindowCaptureRequest Request(const char* session_type,
                                         std::uint32_t major,
                                         std::uint32_t minor) {
  macos::LoginWindowCaptureRequest request;
  request.binding = Binding(session_type);
  request.os_major = major;
  request.os_minor = minor;
  return request;
}

void SelectionFollowsTheRunningRelease() {
  using macos::LoginWindowCaptureBackend;
  // ScreenCaptureKit only serves the login window from 14.4.
  Check(macos::SelectCaptureBackend(macos::kSessionTypeLoginWindow, 14, 3)
            == LoginWindowCaptureBackend::kCgDisplayStream,
        "14.3 login window uses CGDisplayStream");
  Check(macos::SelectCaptureBackend(macos::kSessionTypeLoginWindow, 13, 6)
            == LoginWindowCaptureBackend::kCgDisplayStream,
        "13.6 login window uses CGDisplayStream");
  Check(macos::SelectCaptureBackend(macos::kSessionTypeLoginWindow, 14, 4)
            == LoginWindowCaptureBackend::kScreenCaptureKit,
        "14.4 login window uses ScreenCaptureKit");
  Check(macos::SelectCaptureBackend(macos::kSessionTypeLoginWindow, 15, 1)
            == LoginWindowCaptureBackend::kScreenCaptureKit,
        "15.1 login window uses ScreenCaptureKit");
  // Aqua's path predates the artifact minimum.
  Check(macos::SelectCaptureBackend(macos::kSessionTypeAqua, 12, 3)
            == LoginWindowCaptureBackend::kScreenCaptureKit,
        "Aqua always uses ScreenCaptureKit");
  // An unknown session type is refused, not defaulted.
  Check(macos::SelectCaptureBackend("Background", 15, 1)
            == LoginWindowCaptureBackend::kUnavailable,
        "an unknown session type selects nothing");
}

void LoginWindowProfileGrantsCaptureAndInputOnly() {
  const macos::SessionCapabilityProfile login =
      macos::CapabilityProfileFor(macos::kSessionTypeLoginWindow);
  Check(login.capture && login.pointer && login.keyboard,
        "the login window keeps capture and input");
  // Nobody is logged in; each of these would act as a principal the operator
  // never authenticated as.
  Check(!login.clipboard, "no clipboard at the login window");
  Check(!login.file_transfer, "no file transfer at the login window");
  Check(!login.keychain, "no keychain at the login window");
  Check(!login.shell, "no shell at the login window");
  Check(!login.computer_use, "no Computer Use at the login window");

  const macos::SessionCapabilityProfile aqua =
      macos::CapabilityProfileFor(macos::kSessionTypeAqua);
  Check(aqua.clipboard && aqua.shell && aqua.computer_use,
        "Aqua retains its full surface");

  const macos::SessionCapabilityProfile unknown =
      macos::CapabilityProfileFor("Background");
  Check(!unknown.capture && !unknown.pointer && !unknown.keyboard,
        "an unknown session type gets nothing at all");
}

void BothBackendsAreDrivenWithIdenticalBounds() {
  for (int index = 0; index < 2; ++index) {
    const bool modern = index == 0;
    FakeBackend sck;
    FakeBackend cgs;
    std::unique_ptr<macos::ScreenCaptureKitBackendStream> stream;
    macos::LoginWindowCaptureRequest request = Request(
        macos::kSessionTypeLoginWindow, 14, modern ? 4 : 3);
    const macos::LoginWindowCaptureOutcome outcome =
        macos::StartLoginWindowCapture(request, nullptr, &sck, &cgs, {}, {},
                                       &stream);
    Check(outcome.status == macos::LoginWindowCaptureStatus::kOk,
          "capture starts on both backends");
    FakeBackend& used = modern ? sck : cgs;
    FakeBackend& idle = modern ? cgs : sck;
    Check(idle.enumerate_calls == 0, "the unselected backend is never touched");
    // The property under test: one interface, one set of bounds.
    Check(used.enumerate_timeout == request.limits.enumeration_timeout_ms,
          "enumeration bound reaches the backend");
    Check(used.enumerate_max == request.limits.max_displays,
          "display bound reaches the backend");
    Check(used.last_configuration.frame_rate == request.limits.frame_rate,
          "frame rate bound reaches the backend");
    Check(used.observations.created
              && used.observations.start_timeout
                     == request.limits.stream_start_timeout_ms,
          "start bound reaches the stream");
    Check(used.observations.first_frame_timeout
              == request.limits.first_frame_timeout_ms,
          "first-frame bound reaches the stream");
    // The login window draws its own cursor; a second one is an artifact.
    Check(!used.last_configuration.show_cursor,
          "the login window stream hides the cursor");
  }
}

void FailedStartAndFirstFrameTearDownWithinTheBound() {
  for (int index = 0; index < 2; ++index) {
    FakeBackend sck;
    FakeBackend cgs;
    sck.stream_start_ok = index != 0;
    sck.stream_first_frame_ok = index != 1;
    std::unique_ptr<macos::ScreenCaptureKitBackendStream> stream;
    const macos::LoginWindowCaptureRequest request =
        Request(macos::kSessionTypeLoginWindow, 14, 4);
    const macos::LoginWindowCaptureOutcome outcome =
        macos::StartLoginWindowCapture(request, nullptr, &sck, &cgs, {}, {},
                                       &stream);
    Check(outcome.status != macos::LoginWindowCaptureStatus::kOk,
          "a failed start or first frame is not success");
    Check(stream == nullptr, "no stream is published on failure");
    // A failed start must not leave a half-live stream behind.
    Check(sck.observations.created && sck.observations.stops == 1,
          "the stream is stopped exactly once on failure");
    Check(sck.observations.stop_timeout
              == request.limits.stream_stop_timeout_ms,
          "teardown uses the configured bound");
  }
}

void BindingAndMigrationAreRefusedBeforeAnyBackendIsTouched() {
  struct Case {
    const char* label;
    macos::CaptureSessionBinding binding;
    macos::LoginWindowCaptureStatus status;
  };
  macos::CaptureSessionBinding no_asid = Binding(macos::kSessionTypeLoginWindow);
  no_asid.audit_session_id = 0;
  macos::CaptureSessionBinding no_generation =
      Binding(macos::kSessionTypeLoginWindow);
  no_generation.worker_generation = 0;
  macos::CaptureSessionBinding no_challenge =
      Binding(macos::kSessionTypeLoginWindow);
  no_challenge.launch_challenge.clear();
  macos::CaptureSessionBinding unknown_type = Binding("Background");

  const Case cases[] = {
      {"missing asid", no_asid,
       macos::LoginWindowCaptureStatus::kBindingIncomplete},
      {"missing generation", no_generation,
       macos::LoginWindowCaptureStatus::kBindingIncomplete},
      {"missing challenge", no_challenge,
       macos::LoginWindowCaptureStatus::kBindingIncomplete},
      {"unknown session type", unknown_type,
       macos::LoginWindowCaptureStatus::kBindingIncomplete},
  };
  for (const Case& entry : cases) {
    FakeBackend sck;
    FakeBackend cgs;
    std::unique_ptr<macos::ScreenCaptureKitBackendStream> stream;
    macos::LoginWindowCaptureRequest request =
        Request(macos::kSessionTypeLoginWindow, 14, 4);
    request.binding = entry.binding;
    const macos::LoginWindowCaptureOutcome outcome =
        macos::StartLoginWindowCapture(request, nullptr, &sck, &cgs, {}, {},
                                       &stream);
    Check(outcome.status == entry.status, entry.label);
    Check(sck.enumerate_calls == 0 && cgs.enumerate_calls == 0,
          "an incomplete binding never touches a backend");
  }

  // Logging in replaces the principal outright.
  const macos::CaptureSessionBinding login =
      Binding(macos::kSessionTypeLoginWindow);
  for (const macos::CaptureSessionBinding& next :
       {Binding(macos::kSessionTypeAqua), [] {
          macos::CaptureSessionBinding other =
              Binding(macos::kSessionTypeLoginWindow);
          other.audit_session_id = 100002;
          return other;
        }()}) {
    FakeBackend sck;
    FakeBackend cgs;
    std::unique_ptr<macos::ScreenCaptureKitBackendStream> stream;
    macos::LoginWindowCaptureRequest request =
        Request(macos::kSessionTypeLoginWindow, 14, 4);
    request.binding = next;
    const macos::LoginWindowCaptureOutcome outcome =
        macos::StartLoginWindowCapture(request, &login, &sck, &cgs, {}, {},
                                       &stream);
    Check(outcome.status == macos::LoginWindowCaptureStatus::kAuthorityMigrated,
          "authority may not migrate across principals");
    Check(sck.enumerate_calls == 0 && cgs.enumerate_calls == 0,
          "a migrated authority never touches a backend");
  }
  Check(macos::CaptureAuthorityMayMigrate(login, login),
        "an identical binding is not a migration");
}

void MissingBackendRefusesRatherThanFallingBack() {
  FakeBackend sck;
  std::unique_ptr<macos::ScreenCaptureKitBackendStream> stream;
  macos::LoginWindowCaptureRequest request =
      Request(macos::kSessionTypeLoginWindow, 14, 3);
  // 14.3 selects CGDisplayStream, which this build does not carry. Falling back
  // to ScreenCaptureKit would capture through a path the running OS cannot
  // serve at this surface.
  const macos::LoginWindowCaptureOutcome outcome =
      macos::StartLoginWindowCapture(request, nullptr, &sck, nullptr, {}, {},
                                     &stream);
  Check(outcome.status == macos::LoginWindowCaptureStatus::kBackendUnavailable,
        "a missing backend is refused");
  Check(sck.enumerate_calls == 0, "no fallback to the other backend");
}

}  // namespace

int main() {
  SelectionFollowsTheRunningRelease();
  LoginWindowProfileGrantsCaptureAndInputOnly();
  BothBackendsAreDrivenWithIdenticalBounds();
  FailedStartAndFirstFrameTearDownWithinTheBound();
  BindingAndMigrationAreRefusedBeforeAnyBackendIsTouched();
  MissingBackendRefusesRatherThanFallingBack();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d login-window capture failure(s)\n", g_failures);
    return EXIT_FAILURE;
  }
  std::printf("macos login window capture counterfactual ok\n");
  return EXIT_SUCCESS;
}
