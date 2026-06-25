/**
 * Archive-backfill scheduling flag — a plain per-thread, module-scoped boolean
 * with NO database access, extracted from `context-store.ts` so the daemon main
 * thread can toggle it without importing the synchronous store (task 4.5 import
 * guard). The flag is read by `context-store.ts`'s `ensureDb()` scheduling
 * logic in whichever thread that store instance runs.
 *
 * Semantics: the daemon main thread disables it after spawning the context-store
 * worker, so the archive-backfill timer runs ONLY in the worker (the single DB
 * owner). The worker, tests, and the CLI leave it enabled (they are the sole
 * connection in their process/thread). It also fail-safes the cold-fallback
 * path: if the main thread ever opens the store in-process (worker down), it
 * still will not start a duplicate backfill timer.
 */
let archiveBackfillSchedulingEnabled = true;

/** Disable/enable archive-backfill scheduling for THIS thread's store instance. */
export function setArchiveBackfillSchedulingEnabled(enabled: boolean): void {
  archiveBackfillSchedulingEnabled = enabled;
}

export function isArchiveBackfillSchedulingEnabled(): boolean {
  return archiveBackfillSchedulingEnabled;
}

/** Reset to the default (enabled) — used by `resetContextStoreForTests`. */
export function resetArchiveBackfillSchedulingForTests(): void {
  archiveBackfillSchedulingEnabled = true;
}
