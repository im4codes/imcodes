/**
 * Heap guard: act before the V8 heap limit, not at it.
 *
 *   warn (60 %)      collect once (to tell garbage from live data), write a sanitised diagnostic, shed heavy reads
 *                    (timeline history pages shrink, the same way they do on a congested uplink), sample faster;
 *   critical (85 %)  flush the session store, write the diagnostic, exit with DAEMON_MEMORY_GUARD_EXIT_CODE so the
 *                    service manager restarts the daemon -- instead of an abort in the middle of a write that leaves
 *                    nothing behind but a GC trace;
 *   restart loop     a third critical inside the restart window does NOT restart again (a daemon that exhausts its
 *                    heap straight after every start would restart forever): it keeps refusing heavy load and
 *                    raises the alert.
 *
 * Everything the guard needs from the outside is injected, so the state machine is testable without a 8 GB heap.
 */
import v8 from 'node:v8';
import { loadavg } from 'node:os';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIAGNOSTICS_DIR,
  DAEMON_HEAP_RESTART_RATIO,
  DAEMON_HEAP_WARN_RATIO,
  DAEMON_MEMORY_DIAGNOSTIC_KEEP,
  DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS,
  DAEMON_MEMORY_GUARD_EXIT_CODE,
  DAEMON_MEMORY_GUARD_FAST_INTERVAL_MS,
  DAEMON_MEMORY_GUARD_GC_MAX_INTERVAL_MS,
  DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS,
  DAEMON_MEMORY_GUARD_HARD_EXIT_MS,
  DAEMON_FATAL_REPORT_FILE_PATTERN,
  DAEMON_FATAL_REPORT_HEADER_FIELDS_REMOVED,
  DAEMON_FATAL_REPORT_SANITIZED_KEY,
  DAEMON_MEMORY_GUARD_INTERVAL_MS,
  DAEMON_MEMORY_GUARD_MAX_RESTARTS_IN_WINDOW,
  DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS,
  DAEMON_MEMORY_GUARD_STATE_FILE,
  classifyDaemonHeap,
  type DaemonMemoryLevel,
} from '../../shared/daemon-memory-guard.js';
import { collectMemoryProbes } from './memory-probes.js';

export interface MemoryGuardLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface MemoryGuardDeps {
  now(): number;
  heap(): { usedBytes: number; limitBytes: number };
  /** Force a major collection; absent without --expose-gc. */
  gc?(): void;
  /** Persist a diagnostic; returns where, or undefined when it could not be written. */
  writeDiagnostic(summary: Record<string, unknown>): string | undefined;
  /** Numbers-only per-subsystem sizes. */
  probes(): Record<string, Record<string, number>>;
  /** Flush what must survive and exit so the service manager restarts the daemon. */
  restart(reason: string): Promise<void>;
  /** False when nothing would bring the daemon back (a dev run): the guard then only sheds. Default: true. */
  canRestart?(): boolean;
  /** Timestamps of earlier guard restarts, newest last, and a way to add one. */
  readRestarts(): number[];
  recordRestart(at: number): void;
  log: MemoryGuardLogger;
}

export interface MemoryGuard {
  /** One sample; resolves to the level it settled at. */
  tick(): Promise<DaemonMemoryLevel>;
  level(): DaemonMemoryLevel;
  /** Heavy reads should be served small (or refused) while this is true. */
  isShedding(): boolean;
  /** The guard wanted to restart but the restart loop protection said no. */
  isRestartSuppressed(): boolean;
  start(): void;
  stop(): void;
}

export function createMemoryGuard(deps: MemoryGuardDeps): MemoryGuard {
  let level: DaemonMemoryLevel = 'ok';
  let shedding = false;
  let restartSuppressed = false;
  let restarting = false;
  let lastGcAt = 0;
  let gcIntervalMs = DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS;
  let lastDiagnosticAt = 0;
  let lastSuppressedAlertAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  const summary = (reason: string, used: number, limit: number): Record<string, unknown> => ({
    reason,
    at: new Date(deps.now()).toISOString(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    heap: { usedBytes: used, limitBytes: limit, ratio: limit > 0 ? Number((used / limit).toFixed(3)) : 0 },
    memoryUsage: process.memoryUsage(),
    heapSpaces: v8.getHeapSpaceStatistics().map((space) => ({ name: space.space_name, sizeBytes: space.space_size, usedBytes: space.space_used_size })),
    loadavg: loadavg(),
    subsystems: deps.probes(),
    restartsInWindow: recentRestarts().length,
  });

  function recentRestarts(): number[] {
    const since = deps.now() - DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS;
    return deps.readRestarts().filter((at) => at >= since);
  }

  async function tick(): Promise<DaemonMemoryLevel> {
    let { usedBytes, limitBytes } = deps.heap();
    let next = classifyDaemonHeap(usedBytes, limitBytes);
    if (next !== 'ok' && deps.gc && deps.now() - lastGcAt >= gcIntervalMs) {
      // Heap used counts garbage not collected yet: only live data justifies shedding or a restart.
      lastGcAt = deps.now();
      try { deps.gc(); } catch { /* a failed collection leaves the reading as it was */ }
      ({ usedBytes, limitBytes } = deps.heap());
      next = classifyDaemonHeap(usedBytes, limitBytes);
      // A full collection on a multi-GB heap costs the main thread hundreds of ms: when it did not bring the heap
      // under the warn line the data is live, so the next one waits twice as long (reset once the heap is healthy).
      gcIntervalMs = next === 'ok' ? DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS : Math.min(gcIntervalMs * 2, DAEMON_MEMORY_GUARD_GC_MAX_INTERVAL_MS);
    }
    if (next === 'ok') gcIntervalMs = DAEMON_MEMORY_GUARD_GC_MIN_INTERVAL_MS;
    const previous = level;
    level = next;
    // Leave the shedding state only well below the warn line, so the edge cannot flap.
    if (next !== 'ok') shedding = true;
    else if (shedding && usedBytes / limitBytes < DAEMON_HEAP_WARN_RATIO * 0.9) shedding = false;
    if (next === 'ok') restartSuppressed = false;

    if (next === 'warn' || next === 'critical') {
      if (previous === 'ok' || deps.now() - lastDiagnosticAt >= DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS) {
        lastDiagnosticAt = deps.now();
        const file = deps.writeDiagnostic(summary(next === 'critical' ? 'heap_critical' : 'heap_warn', usedBytes, limitBytes));
        deps.log.warn({ level: next, usedBytes, limitBytes, ratio: Number((usedBytes / limitBytes).toFixed(3)), diagnostic: file }, 'daemon heap is past the warn line: heavy reads are shed');
      }
    }
    if (next === 'critical' && !restarting) {
      if (deps.canRestart && !deps.canRestart()) {
        // Exiting would leave nothing running (no service manager): keep serving, refuse heavy load, say so once in a while.
        restartSuppressed = true;
        if (deps.now() - lastSuppressedAlertAt >= DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS) {
          lastSuppressedAlertAt = deps.now();
          deps.log.error({ usedBytes, limitBytes }, 'daemon heap is critical but no service manager would restart it: NOT exiting; heavy load is refused');
        }
      } else if (recentRestarts().length >= DAEMON_MEMORY_GUARD_MAX_RESTARTS_IN_WINDOW) {
        restartSuppressed = true;
        if (deps.now() - lastSuppressedAlertAt >= DAEMON_MEMORY_GUARD_DIAGNOSTIC_MIN_INTERVAL_MS) {
          lastSuppressedAlertAt = deps.now();
          deps.log.error({ usedBytes, limitBytes, restartsInWindow: recentRestarts().length, windowMs: DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS }, 'daemon heap is critical again right after guard restarts: NOT restarting again (restart loop); heavy load is refused');
        }
      } else {
        restarting = true;
        deps.recordRestart(deps.now());
        const file = deps.writeDiagnostic(summary('heap_restart', usedBytes, limitBytes));
        deps.log.error({ usedBytes, limitBytes, diagnostic: file }, 'daemon heap is critical: restarting in a controlled way');
        try {
          await deps.restart(`heap ${Math.round(usedBytes / 1048576)} MB of ${Math.round(limitBytes / 1048576)} MB`);
        } catch (error) {
          restarting = false;
          deps.log.error({ err: error }, 'controlled restart failed');
        }
      }
    }
    return level;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().catch((error) => deps.log.warn({ err: error }, 'memory guard sample failed')).finally(schedule);
    }, level === 'ok' ? DAEMON_MEMORY_GUARD_INTERVAL_MS : DAEMON_MEMORY_GUARD_FAST_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    tick,
    level: () => level,
    isShedding: () => shedding,
    isRestartSuppressed: () => restartSuppressed,
    start() { if (!stopped) return; stopped = false; schedule(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

// --- production wiring ------------------------------------------------------------------------------------------

let activeGuard: MemoryGuard | null = null;

/** True while the daemon is past the heap warn line: serve heavy reads small. */
export function isMemoryPressureShedding(): boolean {
  return activeGuard?.isShedding() ?? false;
}

export function diagnosticsDirOf(stateDir: string): string {
  return join(stateDir, DAEMON_DIAGNOSTICS_DIR);
}

/** Write a diagnostic atomically (0600) and keep only the newest few. */
export function writeMemoryDiagnostic(stateDir: string, data: Record<string, unknown>, now = Date.now()): string | undefined {
  try {
    const dir = diagnosticsDirOf(stateDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `memory-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, file);
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    const files = readdirSync(dir).filter((name) => name.startsWith('memory-') && name.endsWith('.json')).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - DAEMON_MEMORY_DIAGNOSTIC_KEEP))) {
      try { unlinkSync(join(dir, stale)); } catch { /* already gone */ }
    }
    return file;
  } catch {
    return undefined;
  }
}

function restartStatePath(stateDir: string): string {
  return join(diagnosticsDirOf(stateDir), DAEMON_MEMORY_GUARD_STATE_FILE);
}

export function readGuardRestarts(stateDir: string): number[] {
  try {
    const path = restartStatePath(stateDir);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { restarts?: unknown };
    return Array.isArray(parsed.restarts) ? parsed.restarts.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)) : [];
  } catch {
    return [];
  }
}

export function recordGuardRestart(stateDir: string, at: number): void {
  try {
    mkdirSync(diagnosticsDirOf(stateDir), { recursive: true, mode: 0o700 });
    const since = at - DAEMON_MEMORY_GUARD_RESTART_WINDOW_MS;
    const restarts = [...readGuardRestarts(stateDir).filter((entry) => entry >= since), at];
    writeFileSync(restartStatePath(stateDir), JSON.stringify({ restarts }), { mode: 0o600 });
  } catch {
    // Without the record a restart loop could not be detected; the guard still restarts at most once per process.
  }
}

export interface StartMemoryGuardOptions {
  stateDir: string;
  log: MemoryGuardLogger;
  /** The ordered shutdown the daemon already has (flushes the session store); it exits with the given code. */
  shutdown(exitCode: number): Promise<void>;
}

/**
 * A fatal-error report is raw runtime output: the whole environment (provider keys), network addresses, the command line.
 * A restart sweeps every report left by the previous process: the secrets and addresses are removed, the heap numbers, resource
 * usage and stacks (code locations) stay, the file becomes 0600, a report that cannot be parsed (cut short by the crash) is
 * deleted rather than left unsanitised, and only the newest few are kept.
 */
export function sanitizeFatalReports(stateDir: string): { sanitized: number; removed: number } {
  const dir = diagnosticsDirOf(stateDir);
  const result = { sanitized: 0, removed: 0 };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => DAEMON_FATAL_REPORT_FILE_PATTERN.test(name)).sort();
  } catch {
    return result;
  }
  const kept: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (!lstatSync(file).isFile()) continue; // never follow a link planted in the directory
      const report = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (report[DAEMON_FATAL_REPORT_SANITIZED_KEY] !== true) {
        delete report['environmentVariables'];
        const header = report['header'];
        if (header && typeof header === 'object') for (const field of DAEMON_FATAL_REPORT_HEADER_FIELDS_REMOVED) delete (header as Record<string, unknown>)[field];
        report[DAEMON_FATAL_REPORT_SANITIZED_KEY] = true;
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, JSON.stringify(report), { mode: 0o600 });
        renameSync(temporary, file);
        result.sanitized += 1;
      }
      try { chmodSync(file, 0o600); } catch { /* best effort */ }
      kept.push(name);
    } catch {
      try { unlinkSync(file); result.removed += 1; } catch { /* already gone */ }
    }
  }
  for (const stale of kept.slice(0, Math.max(0, kept.length - DAEMON_MEMORY_DIAGNOSTIC_KEEP))) {
    try { unlinkSync(join(dir, stale)); result.removed += 1; } catch { /* already gone */ }
  }
  return result;
}

/** Something would bring the daemon back after an exit: systemd, launchd, or the Windows scheduled task. */
export function isRunningUnderSupervisor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env['IMCODES_SUPERVISED'] === '1') return true;
  if (platform === 'win32') return true;
  if (env['INVOCATION_ID'] || env['JOURNAL_STREAM']) return true; // systemd
  return Boolean(env['XPC_SERVICE_NAME'] && env['XPC_SERVICE_NAME'] !== '0'); // launchd
}

export function startMemoryGuard(options: StartMemoryGuardOptions): MemoryGuard {
  activeGuard?.stop();
  const gc = (globalThis as { gc?: () => void }).gc;
  const guard = createMemoryGuard({
    now: () => Date.now(),
    heap: () => {
      const stats = v8.getHeapStatistics();
      return { usedBytes: stats.used_heap_size, limitBytes: stats.heap_size_limit };
    },
    ...(typeof gc === 'function' ? { gc: () => gc() } : {}),
    writeDiagnostic: (data) => writeMemoryDiagnostic(options.stateDir, data),
    probes: collectMemoryProbes,
    restart: (reason) => {
      options.log.error({ reason }, 'memory guard: shutting the daemon down for a controlled restart');
      return options.shutdown(DAEMON_MEMORY_GUARD_EXIT_CODE);
    },
    canRestart: () => isRunningUnderSupervisor(),
    readRestarts: () => readGuardRestarts(options.stateDir),
    recordRestart: (at) => recordGuardRestart(options.stateDir, at),
    log: options.log,
  });
  activeGuard = guard;
  const dir = diagnosticsDirOf(options.stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  const swept = sanitizeFatalReports(options.stateDir);
  if (swept.sanitized > 0 || swept.removed > 0) options.log.info({ ...swept }, 'memory guard: fatal-error reports of earlier runs sanitised');
  guard.start();
  return guard;
}

export function stopMemoryGuard(): void {
  activeGuard?.stop();
  activeGuard = null;
}

/** Test seam: install a guard built with fake dependencies as the process-wide one. */
export function setActiveMemoryGuardForTests(guard: MemoryGuard | null): void {
  activeGuard = guard;
}
