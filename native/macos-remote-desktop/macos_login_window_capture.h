// LoginWindow capture supervision: backend selection, bounds and profile.
//
// Two things live here that must not live anywhere else.
//
// 1. Backend selection. ScreenCaptureKit only serves the login window from
//    macOS 14.4; below that the only backend that can see it is
//    CGDisplayStream. One signed artifact ships to both, so the choice is made
//    from the running OS version, never at build time.
//
// 2. LoginWindow profile enforcement at the point of consumption. The session
//    type decides what the worker may do, and a login window is not a smaller
//    Aqua session -- nobody is logged in, so there is no user whose clipboard,
//    files, keychain, shell or Computer Use surface could legitimately be
//    reached. Enforcing it here rather than trusting the caller means a future
//    adapter cannot widen it by advertising more.
//
// Deliberately free of Apple headers: both backends are consumed through the
// existing `ScreenCaptureKitBackend` seam, so selection, bounds and profile can
// be linked and sanitized on a machine with no login window at all. That is
// also why CGDisplayStream is not a second interface -- one interface means the
// frame/topology/first-frame/teardown bounds cannot drift between the two.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_LOGIN_WINDOW_CAPTURE_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_LOGIN_WINDOW_CAPTURE_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

#include "screen_capture_kit_adapter.h"

namespace imcodes::remote_desktop::macos {

/** Session types, matching `macos_auto_unlock_controller.h` and the TS contract. */
inline constexpr char kSessionTypeAqua[] = "Aqua";
inline constexpr char kSessionTypeLoginWindow[] = "LoginWindow";

/** First macOS release whose ScreenCaptureKit serves the login window. */
inline constexpr std::uint32_t kLoginWindowScreenCaptureKitMajor = 14;
inline constexpr std::uint32_t kLoginWindowScreenCaptureKitMinor = 4;

enum class LoginWindowCaptureBackend : std::uint8_t {
  /** No backend may serve this combination. */
  kUnavailable,
  kScreenCaptureKit,
  kCgDisplayStream,
};

/**
 * Chooses the backend for one session type on one running release.
 *
 * Aqua has had a working ScreenCaptureKit path since the artifact's own 12.3
 * minimum, so only the login window needs the older backend. An unrecognized
 * session type is `kUnavailable` rather than a default: guessing here would
 * mean capturing a surface nobody asked for.
 */
[[nodiscard]] LoginWindowCaptureBackend SelectCaptureBackend(
    std::string_view session_type,
    std::uint32_t os_major,
    std::uint32_t os_minor);

/** What a worker in a given session type may do. */
struct SessionCapabilityProfile {
  bool capture = false;
  bool pointer = false;
  bool keyboard = false;
  bool clipboard = false;
  bool file_transfer = false;
  bool keychain = false;
  bool shell = false;
  bool computer_use = false;
};

/**
 * Derives the profile from the session type alone.
 *
 * Derived, not intersected with a configured set: an intersection would let an
 * adapter that advertises clipboard inherit it at the login window by accident.
 */
[[nodiscard]] SessionCapabilityProfile CapabilityProfileFor(
    std::string_view session_type);

/** The exact principal a capture generation is bound to. */
struct CaptureSessionBinding {
  std::string session_type;
  std::uint32_t audit_session_id = 0;
  std::uint32_t uid = 0;
  std::string launch_challenge;
  std::uint64_t worker_generation = 0;

  [[nodiscard]] bool IsComplete() const noexcept;
};

/**
 * Whether authority established for `previous` may still be honoured for
 * `next`.
 *
 * True only when every field is identical. Logging in replaces the principal,
 * so a LoginWindow binding must never survive into the Aqua session that
 * follows it, and a second login window is a different audit session even
 * though the session type matches.
 */
[[nodiscard]] bool CaptureAuthorityMayMigrate(
    const CaptureSessionBinding& previous, const CaptureSessionBinding& next);

enum class LoginWindowCaptureStatus : std::uint8_t {
  kOk,
  kBackendUnavailable,
  kBindingIncomplete,
  kAuthorityMigrated,
  kProfileForbidsCapture,
  kBoundsInvalid,
  kEnumerationFailed,
  kStreamFailed,
  kFirstFrameTimedOut,
};

struct LoginWindowCaptureRequest {
  CaptureSessionBinding binding;
  std::uint32_t os_major = 0;
  std::uint32_t os_minor = 0;
  ScreenCaptureKitLimits limits;
};

struct LoginWindowCaptureOutcome {
  LoginWindowCaptureStatus status = LoginWindowCaptureStatus::kBackendUnavailable;
  LoginWindowCaptureBackend backend = LoginWindowCaptureBackend::kUnavailable;
  SessionCapabilityProfile profile;
};

/**
 * Starts one bounded capture generation.
 *
 * `screen_capture_kit` and `cg_display_stream` are the same interface on
 * purpose; whichever is selected is driven with the identical limits, so the
 * enumeration, start, first-frame and teardown bounds cannot diverge between
 * the two paths.
 *
 * Fail-closed and ordered: binding completeness, then migration, then profile,
 * then bounds, then backend selection, and only then is any backend touched.
 * On any failure after the stream exists it is stopped within the teardown
 * bound before returning, so no path leaves capture running.
 */
/**
 * Factory for the backend a session type/release combination needs.
 *
 * Injected rather than called directly so the admission ordering below can be
 * exercised without a login window, and so the production worker names both
 * real backends explicitly at one place.
 */
using LoginWindowCaptureBackendFactory =
    std::function<std::unique_ptr<ScreenCaptureKitBackend>(
        LoginWindowCaptureBackend)>;

/**
 * Decides what the production session may compose, without starting anything.
 *
 * This is the seam the LaunchAgent worker uses. It runs the identical ordered
 * fail-closed admission as `StartLoginWindowCapture` -- binding completeness,
 * then migration, then profile, then bounds, then backend selection -- and then
 * hands back the backend the real `ScreenCaptureKitAdapter` will own, so the
 * session captures through the selected path rather than through whatever
 * default it would otherwise have constructed.
 *
 * It exists instead of calling `StartLoginWindowCapture` from the worker
 * because that would open a second live stream on the same display alongside
 * the session's own, and a probe stream whose frames go nowhere is not
 * evidence that the session can capture.
 *
 * On any non-kOk status `*capture_backend` is left null.
 */
[[nodiscard]] LoginWindowCaptureOutcome ComposeSessionCapture(
    const LoginWindowCaptureRequest& request,
    const CaptureSessionBinding* previous_binding,
    const LoginWindowCaptureBackendFactory& factory,
    std::unique_ptr<ScreenCaptureKitBackend>* capture_backend);

[[nodiscard]] LoginWindowCaptureOutcome StartLoginWindowCapture(
    const LoginWindowCaptureRequest& request,
    const CaptureSessionBinding* previous_binding,
    ScreenCaptureKitBackend* screen_capture_kit,
    ScreenCaptureKitBackend* cg_display_stream,
    ScreenCaptureKitBackendFrameSink frame_sink,
    ScreenCaptureKitBackendErrorSink error_sink,
    std::unique_ptr<ScreenCaptureKitBackendStream>* stream);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_LOGIN_WINDOW_CAPTURE_H_
