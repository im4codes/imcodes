/**
 * The ONE post-finish convergence wire.
 *
 * A successful `finish` is the event that can leave an aggregate exactly ready
 * for its next automatic step. Both finish paths (the intent handler and the
 * legacy assignment-only tool) returned immediately after committing, so the
 * only thing that carried the task forward was the 60s implementation
 * watchdog: progress depended on POLLING rather than on the event that caused
 * it, and a restart in between widened that window to the next boot sweep.
 *
 * This does not add a second dispatcher. `dispatchReadyAudit` is already
 * fail-closed and idempotent -- it refuses when the task is not
 * `ready_for_audit`, when there is no `auditPolicy`, when the ready implementer
 * or the live auditor is not unique, and it derives a deterministic attempt id,
 * send idempotency key and message id from (taskId, revision). Calling it on
 * every successful finish therefore either advances the task exactly once or
 * reports `ignored`/`blocked`; it can never mint a second brief and never
 * fabricates a revision, verdict, Git or CI byte.
 *
 * Defined once and imported by both call sites so the rule cannot drift.
 */
export async function advanceSupervisionTaskAfterFinish(
  taskId: string,
  dispatchReadyAudit?: (taskId: string) => Promise<unknown>,
): Promise<void> {
  const trimmed = taskId.trim();
  if (!trimmed) return;
  try {
    const dispatch = dispatchReadyAudit
      ?? (await import('./send-tool.js')).dispatchReadyAudit;
    await dispatch(trimmed);
  } catch {
    // The finish commit is authoritative and must never be reported as failed
    // because a downstream convergence step could not run. The dispatcher owns
    // its own durable blocker report, and the boot sweep plus the watchdog tick
    // remain the backstop for a crash between the commit and materialization.
  }
}
