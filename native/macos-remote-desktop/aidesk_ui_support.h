#ifndef IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_UI_SUPPORT_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_UI_SUPPORT_H_

// What keeps the aiDesk.to application answering, and tells why when it does not.
//
//  * A run-loop watchdog and a phase log. Every process the app runs logs a few whole-millisecond events (no user names, paths or
//    URLs: event and phase names and numbers only) to ~/Library/Logs/IM.codes/aidesk-ui.log, at most kUiLogMaxBytes (the previous
//    file is kept as .1), and a watchdog notes when the main thread did not run a block for more than kMainThreadDelayLogMs, with the
//    phase the app was in. Read it with `aidesk-agent --aidesk-ui-log` or `imcodes-node --aidesk-ui-log`.
//  * One user-facing instance. The same bundle (one TCC identity) is also started as the launcher that holds the remote-desktop
//    helpers; LaunchServices treats both as one application, so a request for the UI could be handed to a process that has no UI.
//    The UI role therefore takes a lock of its own and a second request is handed to the first, whichever process it was sent to.
//
// Everything here is non-blocking on the main thread except ClaimUiRole's bounded hand-over wait, which runs before any window exists.

#include <cstdint>

namespace imcodes::remote_desktop::macos {

// `aidesk-agent --aidesk-ui-log`: print the log (headless, no UI).
inline constexpr char kAiDeskUiLogArgument[] = "--aidesk-ui-log";
// Directory below the user's home, and the file in it. Mirrored in shared/aidesk-ui-log.ts (pinned by test/spec).
inline constexpr char kAiDeskUiLogDirectory[] = "Library/Logs/IM.codes";
inline constexpr char kAiDeskUiLogFile[] = "aidesk-ui.log";
inline constexpr std::uint64_t kUiLogMaxBytes = 64 * 1024;
inline constexpr std::uint64_t kMainThreadDelayLogMs = 250;
inline constexpr unsigned kUiLogMaxLinesPerRun = 200;
// How long a second UI request waits for the first instance to take it over before it becomes an instance itself.
inline constexpr double kUiHandOverWaitSeconds = 1.5;

// Phases the app reports (the log names the one the main thread was in when it was late).
inline constexpr char kUiPhaseLaunch[] = "launch";
inline constexpr char kUiPhaseClaimRole[] = "claim_role";
inline constexpr char kUiPhaseStatusItem[] = "status_item";
inline constexpr char kUiPhasePanelWindow[] = "panel_window";
inline constexpr char kUiPhasePanelWebView[] = "panel_web_view";
inline constexpr char kUiPhasePanelLoad[] = "panel_load";
inline constexpr char kUiPhaseIdle[] = "idle";
inline constexpr char kUiPhaseHelperWait[] = "helper_wait";

// Starts the log and the watchdog for this process. `role` is a fixed word ("ui", "launcher").
void UiDiagnosticsStart(const char* role) noexcept;
// Marks the phase the main thread is about to be in and logs the transition.
void UiPhase(const char* phase) noexcept;
// One event line, name only. Safe from any thread; never blocks (the write happens on its own queue).
void UiLogEvent(const char* event) noexcept;
// Waits (briefly, on a queue of its own) until everything logged so far is on disk. For a process that is about to exit.
void UiLogFlush() noexcept;
// Writes the log to stdout; returns the process exit status.
int PrintUiLog() noexcept;

// In the launcher role (the process that holds the remote-desktop helpers and has no window): a request that reaches it as "the app"
// -- a Dock click, `open -b <id>`, `open <app>` -- starts the user-facing instance (or, if there is one, hands the request to it).
// Call once, before the launcher's event loop runs.
void InstallLauncherReopenHandler() noexcept;

enum class UiRoleClaim {
  kOwner,       // this process is the one user-facing instance
  kHandedOver,  // another instance took the request: exit
  kUnlocked,    // the lock could not be used, or the other instance did not answer: carry on as an instance
};
// Takes the user-facing role, or hands an "open the panel" request to the instance that has it.
UiRoleClaim ClaimUiRole() noexcept;
// In the owning instance: `handler` runs on the main thread for every hand-over request (it should open the panel).
void ObserveUiRequests(void (^handler)(void)) noexcept;

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_AIDESK_UI_SUPPORT_H_
