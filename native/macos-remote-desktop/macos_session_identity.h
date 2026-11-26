// Which session this process was actually loaded into, from the OS.
//
// One plist carries `LimitLoadToSessionType` = Aqua AND LoginWindow, so the
// installed artifact cannot say which of the two any given launch is. It has to
// be discovered at runtime, and it has to be discovered from the kernel and the
// window server rather than from the environment: an environment variable is
// writable by whoever launched the process, and the capability profile is
// derived from exactly this value.
//
// The classification is a pure function over an observation struct so the
// ordering and the fail-closed cases can be exercised on a machine that is not
// at a login window. Only `ObserveMacosSessionIdentity` touches Apple APIs.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_SESSION_IDENTITY_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_SESSION_IDENTITY_H_

#include <cstdint>
#include <string_view>

namespace imcodes::remote_desktop::macos {

/** What the window server and the kernel report about this process. */
struct MacosSessionIdentityObservation {
  /**
   * Whether a window-server session dictionary could be read at all. False
   * means there is no graphical session to classify; it is not evidence of a
   * login window.
   */
  bool session_dictionary_available = false;
  /** Login has completed for this session; a user is logged in. */
  bool login_done = false;
  /** This session owns the physical console. */
  bool on_console = false;
  /**
   * Whether those two keys were present at all, as distinct from present and
   * false. A misspelled key reads as absent, and absent-means-false is how a
   * logged-in desktop would silently classify as a login window; separating
   * the two is what lets a live test assert the key names themselves.
   */
  bool login_done_present = false;
  bool on_console_present = false;
  /**
   * A console user is named. Independent of `login_done` on purpose: the two
   * must agree, so one misread key cannot decide the capability profile.
   */
  bool has_console_user = false;
  /**
   * The audit session the window server believes it is describing. Required to
   * equal `audit_session_id`; otherwise the dictionary describes some other
   * session and none of its fields are about this process.
   */
  std::uint32_t window_server_audit_session_id = 0;
  /** Kernel audit session id. 1-based; zero is the absence of a session. */
  std::uint32_t audit_session_id = 0;
  /** Kernel uid, never the environment's idea of it. */
  std::uint32_t uid = 0;
};

/**
 * Classifies one observation.
 *
 * Returns `kSessionTypeAqua`, `kSessionTypeLoginWindow`, or an empty view when
 * the observation does not identify either. Empty is the fail-closed answer and
 * callers must refuse on it: the alternative is guessing, and a wrong guess
 * hands the login window the full logged-in user surface.
 *
 * A logged-in session that does not own the console is deliberately *not*
 * classified as Aqua. That is a fast-user-switching background session; it is
 * not the login window, but it is also not the desktop an operator asked to
 * reach, and capturing it would serve a surface nobody selected.
 */
[[nodiscard]] std::string_view ClassifyMacosSessionType(
    const MacosSessionIdentityObservation& observation);

/**
 * Whether the identity a LaunchAgent declared still matches the running one.
 *
 * The declaration reaches the worker through the environment, which is
 * writable by whoever launched the process, so it is never the authority --
 * it is a claim, re-derived here and required to be identical. A mismatch is
 * either a forged launch or a session that changed under the worker between
 * agent exec and worker start; both must fail closed rather than proceed with
 * a profile that belongs to a different principal.
 */
[[nodiscard]] bool MacosSessionIdentityMatches(
    const MacosSessionIdentityObservation& observation,
    std::string_view declared_session_type,
    std::uint32_t declared_audit_session_id,
    std::uint32_t declared_uid);

/** Reads the live observation from the window server and the kernel. */
[[nodiscard]] MacosSessionIdentityObservation ObserveMacosSessionIdentity();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_SESSION_IDENTITY_H_
