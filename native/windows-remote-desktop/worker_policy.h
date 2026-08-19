#ifndef IMCODES_REMOTE_DESKTOP_WORKER_POLICY_H_
#define IMCODES_REMOTE_DESKTOP_WORKER_POLICY_H_

#include <windows.h>

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace imcodes::rd {

enum class CaptureAcquireAction { kFrame, kWait, kReset, kDrop };

inline constexpr int kFirstPresentableFrameTimeoutMs = 3'000;
inline constexpr DWORD kWorkerShutdownGraceMs = 5'000;
inline constexpr int kTopologyRefreshDebounceTicks = 4;
// Bounded grace window for a transient empty DXGI enumeration (one indirect
// display driver dipping, a single DWM composition cycle, or a hot-swap that
// resolves within the next few ticks). Mirrors the topology-refresh debounce
// semantics so the worker survives a single-tick dip without emitting the
// terminal `media_unavailable` reason. Sustained loss still terminates.
inline constexpr int kEmptyTopologyGraceTicks = 4;
// Deliberately shorter than the browser's 10-second receive watchdog so the
// worker can disqualify a wedged hardware encoder before browser teardown wins
// the race and immediately recreates the same broken encoder.
inline constexpr int64_t kMediaProgressTimeoutMs = 7'000;

inline constexpr uint32_t kEnvironmentDisplayChanged = 1u << 0;
inline constexpr uint32_t kEnvironmentSuspend = 1u << 1;
inline constexpr uint32_t kEnvironmentResume = 1u << 2;
inline constexpr uint32_t kEnvironmentSessionUnavailable = 1u << 3;
inline constexpr uint32_t kEnvironmentSessionAvailable = 1u << 4;
inline constexpr uint32_t kEnvironmentCompositionChanged = 1u << 5;
// The session locked or unlocked. Deliberately *not* a session ending: one
// worker follows the desktops instead, which is what keeps signing in from
// looking like a dropped connection.
inline constexpr uint32_t kEnvironmentSessionLocked = 1u << 6;
inline constexpr uint32_t kEnvironmentSessionUnlocked = 1u << 7;

enum class WorkerEnvironmentAction {
  kFollowDesktop,
  kNone,
  kRefreshTopology,
  kStopProtected,
  kStopAndReinitialize,
};

// What one long-lived worker should do when Windows moves input between the
// user's desktop and the sign-in/lock desktop. Following keeps the peer, the
// encoder and the grant alive across a sign-in, so the viewer sees the picture
// change instead of a reconnect.
enum class DesktopFollowAction { kStay, kFollow, kUnavailable };

// `input_desktop` is the desktop that currently receives input, `bound` the one
// the worker's indicator/input thread owns. An unreadable input desktop is
// reported as a failure rather than silently treated as a match, and
// `consecutive_failures` bounds how long that can last before the caller gives
// up and lets itself be replaced.
DesktopFollowAction SelectDesktopFollowAction(const std::wstring& input_desktop,
                                              const std::wstring& bound,
                                              int* consecutive_failures);

inline constexpr int kDesktopFollowFailureLimit = 12;

/**
 * Whether an observed input desktop has settled enough to move the worker to
 * it.
 *
 * Locking a session does not move input once: Windows reports the sign-in
 * desktop for a few hundred milliseconds, puts the lock curtain back on the
 * user's own desktop, and only moves for good when a key finally arrives.
 * Measured on real hardware, that first excursion lasts under one poll period.
 * Tearing the indicator down and rebinding capture on that flicker leaves the
 * worker reading a desktop Windows is no longer displaying, which is a frozen
 * picture with no way back — so require the same desktop twice before moving.
 *
 * `candidate` carries the desktop seen last tick and is updated in place.
 * An empty observation is never a candidate: an unreadable input desktop is
 * handled as a failure by SelectDesktopFollowAction, not as a destination.
 */
bool DesktopFollowSettled(const std::wstring& observed, std::wstring* candidate);

inline constexpr int kDesktopFollowSettleSamples = 2;

/**
 * Whether capture must be moved to `input_desktop`.
 *
 * Capture is reconciled against the desktop that receives input on every tick,
 * not only when the worker moves its indicator: the two can disagree after a
 * refused rebind or a desktop that flickered back, and a `bound` that is merely
 * assumed rather than reported is how a session ends up streaming a desktop
 * Windows stopped displaying.
 */
bool ShouldRebindCapture(const std::wstring& input_desktop,
                         const std::wstring& bound);

/**
 * What answering the sign-in screen needs next.
 *
 * A locked Windows session is not one screen but two. It rests on the lock
 * curtain, which lives on the user's own desktop and has no password box at
 * all; only a keystroke moves it to the credential box on the sign-in desktop.
 * Measured on real hardware, a machine left alone returns to the curtain, so a
 * session that connects to a locked box finds no password box to type into —
 * which is exactly why typing was never attempted.
 */
enum class AutoUnlockStep {
  kNone,
  /** Wake the curtain so the credential box exists. */
  kRaiseCredentialUi,
  /** The credential box is up: type the stored secret. */
  kTypeSecret,
};

/**
 * Auto unlock is a convenience for a watching operator, never an unattended
 * door: it requires a stored secret, a controller on the session, input that
 * this worker can actually deliver, and a locked session in front of them.
 * Both steps are bounded per lock, so a swallowed keystroke can be retried
 * while a wrong password can never loop the account into a lockout.
 */
AutoUnlockStep SelectAutoUnlockStep(bool secret_configured,
                                    bool controller_present,
                                    bool input_ready,
                                    bool session_locked,
                                    bool on_sign_in_desktop,
                                    int raise_attempts_this_lock,
                                    int type_attempts_this_lock);

inline constexpr int kAutoUnlockAttemptsPerLock = 1;
// The curtain can swallow the first keystroke while it is still animating, and
// waking it costs nothing but a space bar on a screen with no password box.
inline constexpr int kAutoUnlockRaiseAttemptsPerLock = 3;

/**
 * Whether a controller's explicit unlock request may run. Unlike the automatic
 * path it is not once-per-lock — the operator asked for it, and the sign-in UI
 * is exactly the place where one attempt can silently do nothing — but it still
 * requires a stored secret, control of the session, and a locked screen.
 */
bool ShouldAcceptUnlockRequest(bool secret_configured,
                               bool controller_present,
                               bool input_ready,
                               bool session_locked);

// The clipboard belongs to the signed-in user's own desktop and must never be
// readable while the sign-in/lock desktop is up, whatever launched the worker.
bool ClipboardAllowedOnDesktop(const std::wstring& desktop);



// DXGI can hold a duplication open on an idle, monitor-less desktop and never
// present a first frame (AcquireNextFrame returns DXGI_ERROR_WAIT_TIMEOUT
// forever). Capture must not stall there: after this many consecutive waits
// with nothing captured yet, the source switches to its GDI fallback. The
// budget stays far below PeerSession's first-frame timeout so the switch still
// happens inside session setup.
inline constexpr int kFirstFrameWaitsBeforeGdiFallback = 5;

// True when a source should switch to its GDI fallback. Any run of consecutive
// non-captures counts, not only a cold start: a session lock invalidates DXGI
// duplication on a desktop that was streaming happily a moment earlier, and a
// worker that follows the desktop meets that case on every sign-in.
bool AdvanceGdiFallbackState(bool captured,
                             bool gdi_fallback_allowed,
                             int* consecutive_waits);

// While the GDI fallback is engaged, DXGI is re-probed on this cadence so a
// desktop that starts presenting again returns to the hardware path instead of
// staying on the slower fallback for the rest of the session.
inline constexpr int kGdiFallbackDxgiRetryTicks = 150;

// Keeps the ordinary active-user worker and the privileged Winlogon worker on
// their own desktops. A secure-console worker must be replaced after unlock;
// it must never carry authority or input ownership onto the user's desktop.
// The ordinary worker still relies on its interactive indicator probe. The
// privileged worker has an additional per-dispatch gate so no input can cross
// the short Winlogon-to-Default teardown window after sign-in.

CaptureAcquireAction ClassifyCaptureAcquireResult(HRESULT result);
WorkerEnvironmentAction SelectWorkerEnvironmentAction(uint32_t event_mask);
bool AdvanceTopologyRefreshDebounce(bool refresh_requested,
                                    int* remaining_ticks);
// Increments the consecutive-empty-topology counter on every call and returns
// `true` only after the counter strictly exceeds `kEmptyTopologyGraceTicks`.
// Returns `false` for `nullptr` and for every tick strictly inside the grace
// window; resets the counter to zero on the tick that fires the action so the
// next transient dip is debounced again from scratch.
bool AdvanceEmptyTopologyConsecutive(int* consecutive_empty_ticks);
DWORD CurrentDwmProcessIdForCurrentSession();
// Tracks the session-local DWM process without treating a temporarily absent
// compositor as a restart. The first observed pid establishes the baseline;
// a later nonzero pid change requires capture and peer reinitialization.
bool AdvanceCompositorProcessGeneration(DWORD current_process_id,
                                        DWORD* previous_process_id);

struct DisplaySelectionCandidate {
  std::string id;
  bool primary;
  bool available;
  bool imcodes_virtual = false;
};

// Prefers the still-available selected real display. If the selected output is
// the exact IM.codes headless display and a real output appears, prefer a real
// primary/available output. Returns candidates.size() when none is usable.
size_t SelectDisplayAfterTopologyChange(
    const std::vector<DisplaySelectionCandidate>& candidates,
    const std::string& previous_id);
bool DisplaySelectionRequiresExplicitChoice(
    const std::vector<DisplaySelectionCandidate>& candidates,
    const std::string& previous_id);

/** One resolution a display's driver actually offers. */
struct DisplayMode {
  int width = 0;
  int height = 0;
};

/**
 * Turn a driver's raw enumeration into the list a menu should offer: distinct
 * sizes, largest first, bounded — and always including the mode the display is
 * running right now, which a plain "keep the first N" would happily drop and
 * leave the operator looking at a menu that does not contain their own screen.
 */
void FinalizeDisplayModeList(std::vector<DisplayMode>* modes,
                             int current_width,
                             int current_height);

// How many raw driver modes are worth walking. Drivers enumerate one entry per
// refresh rate and colour depth, so this is far above any real distinct count.
inline constexpr size_t kMaxEnumeratedDisplayModes = 1024;

bool IsAllowedRemoteDisplayMode(int width, int height);

// Bounds only: the offered resolutions come from the driver's own list.
inline constexpr int kMinRemoteDisplayEdge = 480;
inline constexpr int kMaxRemoteDisplayEdge = 16'384;
// Distinct sizes reported per display. Drivers enumerate hundreds of modes that
// differ only in refresh rate or colour depth; an operator picks a size.
inline constexpr size_t kMaxDisplayModes = 32;
bool IsAllowedRemoteDisplayScale(int percent);
int RecommendedRemoteDisplayScale(int width, int height);
// A browser may re-enable input only after presenting a decoded frame whose
// geometry is compatible with the currently selected display. Adaptive
// encoding may scale the dimensions but must preserve the display aspect.
bool PresentedFrameMatchesDisplay(int frame_width,
                                  int frame_height,
                                  int display_width,
                                  int display_height);

bool EncoderQueueHasCapacity(size_t pending_frames, size_t maximum_frames);
bool EncoderKeyFrameRequested(bool forced, bool upstream_requested);
bool HardwareEncoderShouldFallback(size_t pending_frames,
                                   size_t stalled_input_polls,
                                   size_t maximum_frames);
inline constexpr size_t kHardwareSlowFrameLimit = 15;
size_t UpdateHardwareSlowFrameCount(int64_t encode_duration_us,
                                    int target_fps,
                                    size_t previous_slow_frames);
bool HardwareEncoderThroughputShouldFallback(size_t consecutive_slow_frames);
bool ShouldAttemptHardwareEncoder(bool prefer_hardware,
                                  bool hardware_disqualified);
bool MediaProgressShouldFailover(uint64_t previous_bytes,
                                 uint64_t current_bytes,
                                 uint64_t source_frames_at_progress,
                                 uint64_t current_source_frames,
                                 int64_t elapsed_ms);
bool InputSequenceIsFresh(bool has_previous,
                          uint64_t previous_sequence,
                          uint64_t current_sequence);

const char* SessionExpiryReason(int64_t now_ms,
                                int64_t authority_expires_at_ms,
                                int64_t lease_expires_at_ms,
                                bool idle_expired);

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_WORKER_POLICY_H_
