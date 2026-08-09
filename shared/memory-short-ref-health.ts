/**
 * Persistence health for the compact memory handles, reported on the daemon's
 * control-plane heartbeat.
 *
 * A handle that fails to persist still resolves in the running process but dies
 * on the next restart. The counters and the throttled warning that report it
 * both stay inside the daemon: counters live in a process-local map, and the
 * warning ends up in the daemon log — on the same disk whose exhaustion is the
 * failure being reported, with write errors swallowed. In the original
 * disk-full incident neither signal could leave the machine.
 *
 * This travels the WebSocket instead. A failure remains visible while affected
 * rows are not durable, then clears only after a successful repair flush, so a
 * reconnecting reader sees the current persistence state rather than a missed
 * edge or an already-repaired stale alert.
 */
export interface MemoryShortRefHealth {
  /** Where the last failure happened (persist_store, persist_file, warm_load, hydrate_ref, load_file). */
  stage: string;
  /** Failures since the process started; keeps a single blip distinguishable from a stuck disk. */
  failures: number;
  /** Epoch ms of the most recent failure. */
  lastFailureAt: number;
  /** Message of the most recent failure, truncated for the wire. */
  lastError: string;
}

export const MEMORY_SHORT_REF_HEALTH_ERROR_MAX_CHARS = 200;
