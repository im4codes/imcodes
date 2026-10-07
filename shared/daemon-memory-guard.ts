/**
 * Daemon heap guard (158, 2026-10-07: two V8 heap OOM aborts, 1.2 GB -> 8.2 GB in under two minutes, nothing
 * written, the session store caught mid-export). The guard watches the JS heap against its configured limit
 * and acts BEFORE the limit: shed load, write a sanitised diagnostic, then restart in a controlled way.
 */

/** Share of the V8 heap limit at which the guard warns, writes a diagnostic and sheds heavy reads. */
export const DAEMON_HEAP_WARN_RATIO = 0.6;
/** Share of the V8 heap limit at which the guard restarts the daemon in a controlled way. */
export const DAEMON_HEAP_RESTART_RATIO = 0.85;
/** The heap is sampled this often, and this often once it is past the warn level (growth was ~60 MB/s). */
export const DAEMON_MEMORY_GUARD_INTERVAL_MS = 5_000;
export const DAEMON_MEMORY_GUARD_FAST_INTERVAL_MS = 1_000;
/** A forced GC (to tell garbage from live data) at most this often. */
export const DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS = 10_000;
/** A diagnostic file at most this often while the heap stays past the warn level. */
export const DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS = 10 * 60_000;
/** More than this many guard restarts inside the window is a loop: the guard stops restarting and only refuses load. */
export const DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS = 30 * 60_000;
export const DAEMON_MEMORY_GUARD_MAX_RESTARTS_IN_WINDOW = 2;
/** Exit status of a guard restart (EX_TEMPFAIL): the service manager restarts the daemon, an operator can tell why. */
export const DAEMON_MEMORY_GUARD_EXIT_CODE = 75;
/** The flush before a controlled restart gives up after this long (the heap is nearly full; a hung disk must not hang us into the abort). */
export const DAEMON_MEMORY_GUARD_FLUSH_TIMEOUT_MS = 5_000;
/** Under memory pressure a timeline history reply is held to this budget (the same size a congested uplink gets); the client pages for the rest. */
export const DAEMON_MEMORY_PRESSURE_HISTORY_BUDGET_BYTES = 128 * 1024;
/** Diagnostic files (guard summaries and the runtime's fatal-error reports) live here, under the state directory. */
export const DAEMON_DIAGNOSTICS_DIR = 'diagnostics';
export const DAEMON_MEMORY_DIAGNOSTIC_KEEP = 10;
export const DAEMON_MEMORY_GUARD_STATE_FILE = 'memory-guard-state.json';


/**
 * Make the runtime write a compact JSON report (native stack, heap statistics) when it dies of a fatal error such as
 * heap exhaustion, instead of only printing the GC trace.
 */
export function daemonFatalReportNodeOptions(stateHome: string): string {
  return `--report-on-fatalerror --report-compact --report-directory=${stateHome}/${DAEMON_DIAGNOSTICS_DIR}`;
}

export type DaemonMemoryLevel = 'ok' | 'warn' | 'critical';

export function classifyDaemonHeap(usedBytes: number, limitBytes: number): DaemonMemoryLevel {
  if (!(limitBytes > 0)) return 'ok';
  const ratio = usedBytes / limitBytes;
  if (ratio >= DAEMON_HEAP_RESTART_RATIO) return 'critical';
  if (ratio >= DAEMON_HEAP_WARN_RATIO) return 'warn';
  return 'ok';
}
