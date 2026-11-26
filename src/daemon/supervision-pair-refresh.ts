/**
 * Coalesced "a pair (or its participant's live state) changed" refresh.
 *
 * A burst of markers, checklist ticks or streamed activity costs one refresh
 * per project, 250 ms after the first change. The flush hands the console the
 * WHOLE coalesced id set: dropping the later ids left their live checklist
 * counts stale until a reconnect.
 */
export const SUPERVISION_PAIR_REFRESH_DELAY_MS = 250;

export type SupervisionPairRefreshReason = 'task_pair_changed' | 'session_activity_changed';

export interface SupervisionPairRefreshDeps {
  /** Sessions whose live presentation a pair row embeds (executor, auditor). */
  participantsOf(project: string, taskId: string): readonly string[];
  /** Forget a participant's memoized live state (see supervision-session-presentation.ts). */
  invalidatePresentation(sessionName: string): void;
  pairsChanged(project: string, taskIds: ReadonlySet<string>, reason: SupervisionPairRefreshReason): void;
  /** Badges follow pair rows, reminders and session state - not streamed activity alone. */
  publishBadges(): void;
  delayMs?: number;
}

export interface SupervisionPairRefreshScheduler {
  schedule(project: string, taskId: string, reason: SupervisionPairRefreshReason): void;
  dispose(): void;
}

export function createSupervisionPairRefreshScheduler(deps: SupervisionPairRefreshDeps): SupervisionPairRefreshScheduler {
  const pending = new Map<string, { timer: NodeJS.Timeout; taskIds: Set<string>; reason: SupervisionPairRefreshReason }>();
  return {
    schedule(project, taskId, reason) {
      const existing = pending.get(project);
      if (existing) {
        existing.taskIds.add(taskId);
        if (reason === 'task_pair_changed') existing.reason = reason;
        return;
      }
      const taskIds = new Set([taskId]);
      const timer = setTimeout(() => {
        const flushed = pending.get(project);
        pending.delete(project);
        const flushReason = flushed?.reason ?? reason;
        const flushedTaskIds = flushed?.taskIds ?? taskIds;
        // This flush runs ~250 ms after the event that armed it - inside the
        // live-state memo's TTL of the read made while the session was still
        // streaming. Forget the dirty pairs' participants so each row is built
        // from the state the event announced; otherwise running -> idle was
        // re-read as "running", found unchanged, sent no delta, and the panel
        // stayed on "running" until some unrelated event touched the pair.
        for (const dirtyTaskId of flushedTaskIds) {
          for (const sessionName of deps.participantsOf(project, dirtyTaskId)) deps.invalidatePresentation(sessionName);
        }
        deps.pairsChanged(project, flushedTaskIds, flushReason);
        if (flushReason === 'task_pair_changed') deps.publishBadges();
      }, deps.delayMs ?? SUPERVISION_PAIR_REFRESH_DELAY_MS);
      timer.unref?.();
      pending.set(project, { timer, taskIds, reason });
    },
    dispose() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    },
  };
}
