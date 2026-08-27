#include "macos_login_window_capture.h"

#include <utility>
#include <vector>

namespace imcodes::remote_desktop::macos {
namespace {

[[nodiscard]] LoginWindowCaptureOutcome Fail(LoginWindowCaptureStatus status,
                                             LoginWindowCaptureBackend backend,
                                             SessionCapabilityProfile profile) {
  LoginWindowCaptureOutcome outcome;
  outcome.status = status;
  outcome.backend = backend;
  outcome.profile = profile;
  return outcome;
}

/**
 * The one ordered admission gate.
 *
 * Both the composition seam and the standalone start path run exactly this, so
 * a future change that loosens one cannot leave the other strict. `*selected`
 * is only meaningful when the returned status is kOk.
 */
[[nodiscard]] LoginWindowCaptureStatus AdmitCapture(
    const LoginWindowCaptureRequest& request,
    const CaptureSessionBinding* previous_binding,
    LoginWindowCaptureBackend* selected) {
  *selected = LoginWindowCaptureBackend::kUnavailable;
  if (!request.binding.IsComplete()) {
    return LoginWindowCaptureStatus::kBindingIncomplete;
  }
  // A surviving binding from a different principal is refused before anything
  // is started: logging in or out replaces the principal outright.
  if (previous_binding != nullptr
      && !CaptureAuthorityMayMigrate(*previous_binding, request.binding)) {
    return LoginWindowCaptureStatus::kAuthorityMigrated;
  }
  if (!CapabilityProfileFor(request.binding.session_type).capture) {
    return LoginWindowCaptureStatus::kProfileForbidsCapture;
  }
  // The same bounds govern whichever backend is chosen; an invalid set is
  // refused once here rather than per backend.
  if (!request.limits.IsValid()) {
    return LoginWindowCaptureStatus::kBoundsInvalid;
  }
  *selected = SelectCaptureBackend(request.binding.session_type,
                                   request.os_major, request.os_minor);
  if (*selected == LoginWindowCaptureBackend::kUnavailable) {
    return LoginWindowCaptureStatus::kBackendUnavailable;
  }
  return LoginWindowCaptureStatus::kOk;
}

}  // namespace

bool CaptureSessionBinding::IsComplete() const noexcept {
  // Generation and audit session are 1-based: zero is the absence of a session,
  // not a session numbered zero, and treating it as one would let a callback
  // that outlived its generation match a fresh binding.
  return (session_type == kSessionTypeAqua
          || session_type == kSessionTypeLoginWindow)
      && audit_session_id != 0
      && worker_generation != 0
      && !launch_challenge.empty();
}

LoginWindowCaptureBackend SelectCaptureBackend(std::string_view session_type,
                                               std::uint32_t os_major,
                                               std::uint32_t os_minor) {
  if (session_type == kSessionTypeAqua) {
    // Aqua's ScreenCaptureKit path predates the artifact's own 12.3 minimum.
    return LoginWindowCaptureBackend::kScreenCaptureKit;
  }
  if (session_type != kSessionTypeLoginWindow) {
    // Not a session type this worker serves. Guessing would mean capturing a
    // surface nobody asked for.
    return LoginWindowCaptureBackend::kUnavailable;
  }
  const bool at_least = os_major > kLoginWindowScreenCaptureKitMajor
      || (os_major == kLoginWindowScreenCaptureKitMajor
          && os_minor >= kLoginWindowScreenCaptureKitMinor);
  return at_least ? LoginWindowCaptureBackend::kScreenCaptureKit
                  : LoginWindowCaptureBackend::kCgDisplayStream;
}

SessionCapabilityProfile CapabilityProfileFor(std::string_view session_type) {
  SessionCapabilityProfile profile;
  if (session_type == kSessionTypeAqua) {
    profile.capture = true;
    profile.pointer = true;
    profile.keyboard = true;
    profile.clipboard = true;
    profile.file_transfer = true;
    profile.keychain = true;
    profile.shell = true;
    profile.computer_use = true;
    return profile;
  }
  if (session_type == kSessionTypeLoginWindow) {
    // Capture and login-safe input only. Every omission below is load-bearing:
    // there is no logged-in user, so a clipboard read would be reading whatever
    // the previous session left behind and a shell would run as a principal the
    // operator never authenticated as.
    profile.capture = true;
    profile.pointer = true;
    profile.keyboard = true;
    return profile;
  }
  // Unknown session type: nothing at all.
  return profile;
}

bool CaptureAuthorityMayMigrate(const CaptureSessionBinding& previous,
                                const CaptureSessionBinding& next) {
  return previous.session_type == next.session_type
      && previous.audit_session_id == next.audit_session_id
      && previous.uid == next.uid
      && previous.launch_challenge == next.launch_challenge
      && previous.worker_generation == next.worker_generation;
}

LoginWindowCaptureOutcome StartLoginWindowCapture(
    const LoginWindowCaptureRequest& request,
    const CaptureSessionBinding* previous_binding,
    ScreenCaptureKitBackend* screen_capture_kit,
    ScreenCaptureKitBackend* cg_display_stream,
    ScreenCaptureKitBackendFrameSink frame_sink,
    ScreenCaptureKitBackendErrorSink error_sink,
    std::unique_ptr<ScreenCaptureKitBackendStream>* stream) {
  const SessionCapabilityProfile profile =
      CapabilityProfileFor(request.binding.session_type);

  if (stream == nullptr) {
    return Fail(LoginWindowCaptureStatus::kBindingIncomplete,
                LoginWindowCaptureBackend::kUnavailable, profile);
  }
  stream->reset();

  LoginWindowCaptureBackend selected = LoginWindowCaptureBackend::kUnavailable;
  const LoginWindowCaptureStatus admitted =
      AdmitCapture(request, previous_binding, &selected);
  if (admitted != LoginWindowCaptureStatus::kOk) {
    return Fail(admitted, selected, profile);
  }

  ScreenCaptureKitBackend* backend = nullptr;
  if (selected == LoginWindowCaptureBackend::kScreenCaptureKit) {
    backend = screen_capture_kit;
  } else if (selected == LoginWindowCaptureBackend::kCgDisplayStream) {
    backend = cg_display_stream;
  }
  if (backend == nullptr) {
    // Selected a backend this build does not carry. Refused rather than
    // silently falling back to the other one, which would capture through a
    // path the running OS cannot actually serve at this surface.
    return Fail(LoginWindowCaptureStatus::kBackendUnavailable, selected, profile);
  }

  std::vector<ScreenCaptureKitBackendDisplay> displays;
  CaptureError error;
  if (!backend->EnumerateDisplays(request.limits.enumeration_timeout_ms,
                                  request.limits.max_displays, &displays,
                                  &error)
      || displays.empty()) {
    return Fail(LoginWindowCaptureStatus::kEnumerationFailed, selected, profile);
  }

  ScreenCaptureKitStreamConfiguration configuration;
  configuration.native_display_id = displays.front().native_display_id;
  configuration.encoded_pixels = displays.front().encoded_pixels;
  configuration.display_lookup_timeout_ms = request.limits.enumeration_timeout_ms;
  configuration.frame_rate = request.limits.frame_rate;
  configuration.max_pending_frames = request.limits.max_pending_frames;
  // No cursor at the login window: the compositor draws its own, and a second
  // one is a visible artifact rather than a feature.
  configuration.show_cursor =
      request.binding.session_type != kSessionTypeLoginWindow;

  std::unique_ptr<ScreenCaptureKitBackendStream> created =
      backend->CreateStream(configuration, std::move(frame_sink),
                            std::move(error_sink), &error);
  if (created == nullptr) {
    return Fail(LoginWindowCaptureStatus::kStreamFailed, selected, profile);
  }

  std::string message;
  if (!created->Start(request.limits.stream_start_timeout_ms, &message)) {
    // Stop within the teardown bound before returning: a failed start must not
    // leave a half-live stream behind.
    created->Stop(request.limits.stream_stop_timeout_ms);
    return Fail(LoginWindowCaptureStatus::kStreamFailed, selected, profile);
  }
  if (!created->WaitForFirstFrame(request.limits.first_frame_timeout_ms,
                                  &message)) {
    created->Stop(request.limits.stream_stop_timeout_ms);
    return Fail(LoginWindowCaptureStatus::kFirstFrameTimedOut, selected, profile);
  }

  *stream = std::move(created);
  LoginWindowCaptureOutcome outcome;
  outcome.status = LoginWindowCaptureStatus::kOk;
  outcome.backend = selected;
  outcome.profile = profile;
  return outcome;
}

LoginWindowCaptureOutcome ComposeSessionCapture(
    const LoginWindowCaptureRequest& request,
    const CaptureSessionBinding* previous_binding,
    const LoginWindowCaptureBackendFactory& factory,
    std::unique_ptr<ScreenCaptureKitBackend>* capture_backend) {
  const SessionCapabilityProfile profile =
      CapabilityProfileFor(request.binding.session_type);
  if (capture_backend == nullptr) {
    return Fail(LoginWindowCaptureStatus::kBindingIncomplete,
                LoginWindowCaptureBackend::kUnavailable, profile);
  }
  capture_backend->reset();
  if (!factory) {
    return Fail(LoginWindowCaptureStatus::kBackendUnavailable,
                LoginWindowCaptureBackend::kUnavailable, profile);
  }

  LoginWindowCaptureBackend selected = LoginWindowCaptureBackend::kUnavailable;
  const LoginWindowCaptureStatus admitted =
      AdmitCapture(request, previous_binding, &selected);
  if (admitted != LoginWindowCaptureStatus::kOk) {
    return Fail(admitted, selected, profile);
  }

  std::unique_ptr<ScreenCaptureKitBackend> created = factory(selected);
  if (created == nullptr) {
    // The build does not carry the backend the running release needs. Refused
    // rather than substituted: substituting is exactly the Aqua fallback that
    // would serve a surface the login window does not have.
    return Fail(LoginWindowCaptureStatus::kBackendUnavailable, selected,
                profile);
  }

  *capture_backend = std::move(created);
  LoginWindowCaptureOutcome outcome;
  outcome.status = LoginWindowCaptureStatus::kOk;
  outcome.backend = selected;
  outcome.profile = profile;
  return outcome;
}

}  // namespace imcodes::remote_desktop::macos
