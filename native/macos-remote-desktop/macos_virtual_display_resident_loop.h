// The resident agent's run loop, extracted from main() so it can be proven.
//
// main() cannot be tested, and everything interesting in this loop is a
// lifetime rule:
//
//   * The authority's lifetime IS the daemon connection's lifetime. EOF on the
//     link revokes immediately and terminally -- routes dropped, helper
//     stopped, readiness false -- and the loop exits rather than waiting for a
//     new daemon. A new daemon must perform a NEW generation handshake, which
//     means a new agent process.
//   * The worker's exit ends the agent. The agent exists to serve a console
//     session; when the session's worker is gone there is nothing left to own a
//     display for.
//   * Nothing else ends it. In particular a refused frame, a malformed request
//     or a helper failure are all answered and survived: one bad frame must not
//     become a lost display.
//
// Every effect is behind a seam, so all of the above is provable with no
// process, no socket and no display.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_RESIDENT_LOOP_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_RESIDENT_LOOP_H_

#include <cstdint>
#include <functional>
#include <string>

#include "macos_virtual_display_authority_link.h"
#include "macos_virtual_display_resident.h"

namespace imcodes::remote_desktop::macos {

/** Why the resident loop stopped. Distinct so a field report is unambiguous. */
enum class ResidentLoopOutcome {
  kDaemonGone,      // the authority link closed: authority is over
  kWorkerExited,    // the session's worker ended
  kStopRequested,   // a signal asked us to stop
  kNotWired,        // seam or owner missing; nothing was ever served
};

[[nodiscard]] const char* ResidentLoopOutcomeText(
    ResidentLoopOutcome outcome) noexcept;

struct ResidentLoopSeam {
  /**
   * Waits until the link has a frame OR the interval elapses.
   *
   * The interval is what makes the loop notice things nothing wakes it for --
   * a dead helper, a moved session, an expired grant. A loop that only woke on
   * traffic would keep advertising a display long after it was gone.
   */
  std::function<bool(int descriptor, std::uint32_t interval_ms)> wait_readable;
  /** True while the supervised worker is still running. */
  std::function<bool()> worker_alive;
  /** Writes one reply line. False on any short or failed write. */
  std::function<bool(int descriptor, const std::string& line)> write_line;
  /** Bounded teardown of the worker. Always reaps. */
  std::function<void()> stop_worker;
  /** True once a signal has asked this process to stop. */
  std::function<bool()> stop_requested;

  [[nodiscard]] bool IsComplete() const noexcept;
};

struct ResidentLoopOptions {
  /** How often to re-poll when the link is quiet. */
  std::uint32_t poll_interval_ms = 1'000;
  /**
   * Bound on frames served, for tests. Zero means unbounded, which is what
   * production uses -- a resident agent that stopped after N requests would be
   * a resident agent that silently stopped.
   */
  std::uint64_t max_frames = 0;
};

/**
 * Serves the link until authority ends.
 *
 * Always tears the worker and the owner down before returning, on every path,
 * so there is no exit that leaves a helper running with nobody watching it.
 */
[[nodiscard]] ResidentLoopOutcome RunResidentLoop(
    MacosVirtualDisplayResidentOwner* owner,
    MacosVirtualDisplayAuthorityLink* link,
    const ResidentLoopOptions& options,
    const ResidentLoopSeam& seam);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_RESIDENT_LOOP_H_
