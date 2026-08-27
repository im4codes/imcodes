#include "macos_virtual_display_resident_loop.h"

namespace imcodes::remote_desktop::macos {

const char* ResidentLoopOutcomeText(ResidentLoopOutcome outcome) noexcept {
  switch (outcome) {
    case ResidentLoopOutcome::kDaemonGone: return "daemon_gone";
    case ResidentLoopOutcome::kWorkerExited: return "worker_exited";
    case ResidentLoopOutcome::kStopRequested: return "stop_requested";
    case ResidentLoopOutcome::kNotWired: return "resident_loop_not_wired";
  }
  return "resident_loop_not_wired";
}

bool ResidentLoopSeam::IsComplete() const noexcept {
  // Wholesale, never partial: a loop missing one seam would serve some frames
  // correctly and miss the condition that should have stopped it.
  return wait_readable != nullptr && worker_alive != nullptr &&
         write_line != nullptr && stop_worker != nullptr &&
         stop_requested != nullptr;
}

ResidentLoopOutcome RunResidentLoop(MacosVirtualDisplayResidentOwner* owner,
                                    MacosVirtualDisplayAuthorityLink* link,
                                    const ResidentLoopOptions& options,
                                    const ResidentLoopSeam& seam) {
  if (owner == nullptr || link == nullptr || !seam.IsComplete())
    return ResidentLoopOutcome::kNotWired;

  // Every return below goes through this, so there is no exit that leaves a
  // helper running with nobody watching it.
  const auto finish = [&](ResidentLoopOutcome outcome) {
    owner->Stop();
    seam.stop_worker();
    return outcome;
  };

  std::uint64_t frames = 0;
  for (;;) {
    if (seam.stop_requested())
      return finish(ResidentLoopOutcome::kStopRequested);
    // The worker is checked BEFORE serving, so a frame is never answered on
    // behalf of a session that has already ended.
    if (!seam.worker_alive())
      return finish(ResidentLoopOutcome::kWorkerExited);
    if (link->state() != AuthorityLinkState::kEstablished)
      return finish(ResidentLoopOutcome::kDaemonGone);

    // Re-poll on every turn, traffic or not. This is what notices the things
    // nothing sends a frame about: a dead helper, a moved session, an expired
    // grant. It runs even when a frame is waiting, because serving a request
    // against state we have not re-checked is how a revoked display keeps
    // being advertised for one more round trip.
    (void)owner->Poll();

    if (!seam.wait_readable(link->descriptor(), options.poll_interval_ms))
      continue;  // quiet: loop round and re-poll

    std::string line;
    std::string error;
    if (!link->NextFrame(&line, &error))
      return finish(ResidentLoopOutcome::kDaemonGone);

    // Both frame kinds are answered by the owner, which classifies them.
    const std::string reply = owner->Handle(line);
    if (!reply.empty() && !seam.write_line(link->descriptor(), reply)) {
      // The daemon stopped reading. That is the same event as EOF: authority
      // is over.
      return finish(ResidentLoopOutcome::kDaemonGone);
    }

    ++frames;
    if (options.max_frames != 0 && frames >= options.max_frames)
      return finish(ResidentLoopOutcome::kStopRequested);
  }
}

}  // namespace imcodes::remote_desktop::macos
