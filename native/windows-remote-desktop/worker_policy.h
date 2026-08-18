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

enum class WorkerEnvironmentAction {
  kNone,
  kRefreshTopology,
  kStopProtected,
  kStopAndReinitialize,
};

enum class WorkerDesktopAction {
  kContinue,
  kStopProtected,
  kTerminateSecureConsole,
};

inline constexpr int kWorkerDesktopMismatchLimit = 3;

// DXGI can hold a duplication open on an idle, monitor-less desktop and never
// present a first frame (AcquireNextFrame returns DXGI_ERROR_WAIT_TIMEOUT
// forever). Capture must not stall there: after this many consecutive waits
// with nothing captured yet, the source switches to its GDI fallback. The
// budget stays far below PeerSession's first-frame timeout so the switch still
// happens inside session setup.
inline constexpr int kFirstFrameWaitsBeforeGdiFallback = 5;

// True when a source that has never produced a frame should switch to GDI.
// `consecutive_waits` is advanced in place and reset once the switch is made.
bool AdvanceGdiFallbackState(bool captured,
                             bool gdi_fallback_allowed,
                             bool any_frame_captured,
                             int* consecutive_waits);

// Keeps the ordinary active-user worker and the privileged Winlogon worker on
// their own desktops. A secure-console worker must be replaced after unlock;
// it must never carry authority or input ownership onto the user's desktop.
WorkerDesktopAction AdvanceWorkerDesktopState(bool secure_console,
                                               bool expected_desktop_active,
                                               int* consecutive_mismatches);
// The ordinary worker still relies on its interactive indicator probe. The
// privileged worker has an additional per-dispatch gate so no input can cross
// the short Winlogon-to-Default teardown window after sign-in.
bool WorkerInputDesktopAllowed(bool secure_console,
                               bool expected_desktop_active);
bool WorkerClipboardAllowed(bool secure_console);

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

bool IsAllowedRemoteDisplayMode(int width, int height);
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
