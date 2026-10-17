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
/** A collection that did not bring the heap back under the warn line means live data: the next one waits twice as long, up to this. */
export const DAEMON_MEMORY_GUARD_GC_MAX_INTERVAL_MS = 120_000;
/** A diagnostic file at most this often while the heap stays past the warn level. */
export const DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS = 10 * 60_000;
/** More than this many guard restarts inside the window is a loop: the guard stops restarting and only refuses load. */
export const DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS = 30 * 60_000;
export const DAEMON_MEMORY_GUARD_MAX_RESTARTS_IN_WINDOW = 2;
/** Exit status of a guard restart (EX_TEMPFAIL): the service manager restarts the daemon, an operator can tell why. */
export const DAEMON_MEMORY_GUARD_EXIT_CODE = 75;
/** Under memory pressure a timeline history reply is held to this budget (the same size a congested uplink gets); the client pages for the rest. */
export const DAEMON_MEMORY_PRESSURE_HISTORY_BUDGET_BYTES = 128 * 1024;
/** Diagnostic files (guard summaries and the runtime's fatal-error reports) live here, under the state directory. */
export const DAEMON_DIAGNOSTICS_DIR = 'diagnostics';
export const DAEMON_MEMORY_DIAGNOSTIC_KEEP = 10;
export const DAEMON_MEMORY_GUARD_STATE_FILE = 'memory-guard-state.json';
/** The runtime's own fatal-error reports (`report.<date>.<pid>...json`) land in the same directory. */
export const DAEMON_FATAL_REPORT_FILE_PATTERN = /^report\..*\.json$/;
/** Marker the sweep stamps on a report it has sanitised. */
export const DAEMON_FATAL_REPORT_SANITIZED_KEY = 'imcodesSanitized';
/** What the runtime's report holds that must not outlive the crash: the whole environment (provider keys), addresses, paths of the invocation. */
export const DAEMON_FATAL_REPORT_HEADER_FIELDS_REMOVED = ['networkInterfaces', 'commandLine', 'cwd', 'host'] as const;
/** The 85 % restart is a last resort: a shutdown stuck on a nearly full heap is cut off after this. */
export const DAEMON_MEMORY_GUARD_HARD_EXIT_MS = 40_000;
/** Cached large strings (hashes, interned texts, serialised exports) are bounded by characters, not entries. */
export const SESSION_BLOB_CACHE_MAX_CHARS = 32 * 1024 * 1024;


/**
 * Make the runtime write a compact JSON report (native stack, heap statistics) when it dies of a fatal error such as
 * heap exhaustion, instead of only printing the GC trace.
 */
export function daemonFatalReportNodeOptions(
  stateHome: string,
  quoting: 'plain' | 'systemd' = 'plain',
  /** Give the runtime `--report-exclude-env`: ONLY for a node known to understand it (an unknown option in NODE_OPTIONS stops node from starting). */
  excludeEnvFlag = false,
): string {
  const directory = `${stateHome}/${DAEMON_DIAGNOSTICS_DIR}`;
  // NODE_OPTIONS splits on spaces unless a value is double-quoted (a macOS home can contain one).
  let value = directory;
  if (/[^A-Za-z0-9_\-./:@+]/.test(directory)) {
    value = `"${directory.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    // Inside a systemd Environment="..." the inner quotes must be escaped again, and a % is a specifier.
    if (quoting === 'systemd') value = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  }
  // The flag is what keeps the environment out of the FATAL-error report (the runtime property process.report.excludeEnv
  // only reaches reports requested from JS). It is off unless the caller proves the node that will run knows it; every
  // report is also swept at the next start (memory-guard.ts: sanitizeFatalReports), which works on every node.
  return `--report-on-fatalerror --report-compact ${excludeEnvFlag ? '--report-exclude-env ' : ''}--report-directory=${value}`;
}

export type DaemonMemoryLevel = 'ok' | 'warn' | 'critical';

export function classifyDaemonHeap(usedBytes: number, limitBytes: number): DaemonMemoryLevel {
  if (!(limitBytes > 0)) return 'ok';
  const ratio = usedBytes / limitBytes;
  if (ratio >= DAEMON_HEAP_RESTART_RATIO) return 'critical';
  if (ratio >= DAEMON_HEAP_WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * "Largest retained allocations" section of the guard's diagnostic (158, 2026-10-08: seven GB in the large-object space,
 * one-line numbers could not say which code allocated it). V8's sampling heap profiler records, for every ~interval bytes
 * allocated, the call stack of the allocation, and reports only the samples still alive. Sizes and code locations only,
 * never a value.
 */
export const DAEMON_HEAP_SAMPLER_INTERVAL_BYTES = 512 * 1024;
/** Entries of the section, the frames kept per entry (innermost first), and the profile nodes walked at most. */
export const DAEMON_HEAP_RETAINED_TOP_N = 15;
export const DAEMON_HEAP_RETAINED_FRAMES = 6;
export const DAEMON_HEAP_RETAINED_MAX_NODES = 200_000;
/** Environment switch: `0` keeps the sampler off (it costs a stack capture per ~interval bytes allocated, a few percent at most). */
export const DAEMON_HEAP_SAMPLER_ENV = 'IMCODES_HEAP_SAMPLER';
