import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONTROLLED_NODE_LIVENESS_ACTIVITY_WINDOW_MS,
  CONTROLLED_NODE_LIVENESS_LEASE_FILE,
  CONTROLLED_NODE_LIVENESS_BACKSTOP_STATE_FILE,
  controlledNodeLivenessBackstopMs,
  CONTROLLED_NODE_LIVENESS_WRITE_INTERVAL_MS,
  CONTROLLED_NODE_UNREACHABLE_WARN_AFTER_MS,
  CONTROLLED_NODE_UNREACHABLE_WARN_REPEAT_MS,
} from '../../shared/controlled-node-service.js';

export const CONTROLLED_NODE_HEALTH_LEASE_FILE = 'health-lease.json';
export const CONTROLLED_NODE_HEALTH_LEASE_VERSION = 1 as const;
export const CONTROLLED_NODE_HEALTH_WRITE_INTERVAL_MS = 15_000;
export const CONTROLLED_NODE_HEALTH_STALE_MS = 180_000;
export const CONTROLLED_NODE_HEALTH_WATCHDOG_STATE_FILE = 'health-watchdog-state.json';

export interface ControlledNodeHealthLease {
  version: typeof CONTROLLED_NODE_HEALTH_LEASE_VERSION;
  pid: number;
  updatedAt: number;
}

export function controlledNodeHealthLeasePath(journalPath: string): string {
  return join(dirname(journalPath), CONTROLLED_NODE_HEALTH_LEASE_FILE);
}

/** The process-liveness lease (renewed while the node is making progress, connected or not): see controlled-node-service.ts. */
export function controlledNodeLivenessLeasePath(journalPath: string): string {
  return join(dirname(journalPath), CONTROLLED_NODE_LIVENESS_LEASE_FILE);
}

export function controlledNodeHealthWatchdogStatePath(journalPath: string): string {
  return join(dirname(journalPath), CONTROLLED_NODE_HEALTH_WATCHDOG_STATE_FILE);
}

/**
 * Atomically publish proof that this exact process received an authenticated
 * server heartbeat acknowledgement. External Windows/macOS watchdogs consume
 * this lease; process existence alone is deliberately not considered healthy.
 */
export async function writeControlledNodeHealthLease(
  path: string,
  now = Date.now(),
  pid = process.pid,
): Promise<void> {
  const lease: ControlledNodeHealthLease = {
    version: CONTROLLED_NODE_HEALTH_LEASE_VERSION,
    pid,
    updatedAt: now,
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function waitForControlledNodeOnlineLease(
  path: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    wallNow?: () => number;
    monotonicNow?: () => number;
    processExists?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    readLease?: () => Promise<unknown>;
  } = {},
): Promise<ControlledNodeHealthLease> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const pollMs = options.pollMs ?? 250;
  const wallNow = options.wallNow ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const readLease = options.readLease ?? (() => readJson(path));
  const processExists = options.processExists ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  });
  // Called after the installer has deliberately cleared the previous
  // generation's lease. This timestamp additionally rejects a stale file if a
  // filesystem/antivirus race resurrects it.
  const notBefore = wallNow();
  const startedAt = monotonicNow();
  while (monotonicNow() - startedAt <= timeoutMs) {
    try {
      const parsed = await readLease();
      if (isControlledNodeHealthLease(parsed)) {
        const futureMs = parsed.updatedAt - wallNow();
        if (parsed.updatedAt >= notBefore && futureMs <= 60_000 && processExists(parsed.pid)) {
          return parsed;
        }
      }
    } catch {
      // The service has not published its first authenticated ack yet.
    }
    await sleep(pollMs);
  }
  throw new Error('controlled node service did not authenticate after installation');
}

function isControlledNodeHealthLease(value: unknown): value is ControlledNodeHealthLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return lease.version === CONTROLLED_NODE_HEALTH_LEASE_VERSION
    && typeof lease.pid === 'number'
    && Number.isSafeInteger(lease.pid)
    && lease.pid > 0
    && typeof lease.updatedAt === 'number'
    && Number.isSafeInteger(lease.updatedAt)
    && lease.updatedAt >= 0;
}

interface ControlledNodeHealthWatchdogState {
  version: 1;
  failureSince: number;
  reason: string;
}

function isControlledNodeHealthWatchdogState(value: unknown): value is ControlledNodeHealthWatchdogState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1
    && typeof state.failureSince === 'number'
    && Number.isSafeInteger(state.failureSince)
    && state.failureSince >= 0
    && typeof state.reason === 'string';
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export interface ControlledNodeHealthWatchdogResult {
  healthy: boolean;
  restarted: boolean;
  reason: 'healthy' | 'lease_missing' | 'lease_invalid' | 'lease_future' | 'lease_pid_missing' | 'lease_stale';
}

type LeaseReading =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'lease'; lease: ControlledNodeHealthLease };

async function readLeaseFile(path: string): Promise<LeaseReading> {
  try {
    const parsed = await readJson(path);
    return isControlledNodeHealthLease(parsed) ? { kind: 'lease', lease: parsed } : { kind: 'invalid' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
}

/**
 * One-shot macOS health check, invoked by a separate periodic LaunchDaemon.
 *
 * It judges whether the node PROCESS is alive and working, not whether the server is reachable: the liveness lease is
 * renewed while the node's connection machinery makes progress (an ack, or a connection attempt / failure / retry), so
 * an unreachable server is not a reason to restart it. The authenticated health lease is accepted as well (a node
 * that predates the liveness lease only writes that one).
 *
 * Missing/invalid leases receive a full grace window so first boot and normal process replacement are not mistaken
 * for a wedge. A stale lease whose exact PID is still alive is decisive evidence of the observed fake-alive state and
 * can be restarted immediately.
 */
export async function runMacosControlledNodeHealthWatchdog(options: {
  journalPath: string;
  now?: () => number;
  staleMs?: number;
  processExists?: (pid: number) => boolean;
  restartService: () => void | Promise<void>;
}): Promise<ControlledNodeHealthWatchdogResult> {
  const now = options.now?.() ?? Date.now();
  const staleMs = options.staleMs ?? CONTROLLED_NODE_HEALTH_STALE_MS;
  const statePath = controlledNodeHealthWatchdogStatePath(options.journalPath);
  const processExists = options.processExists ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  });

  // The liveness lease first: it is the one a current node renews through an outage. Either lease being fresh and
  // bound to a live process is enough.
  const readings = [
    await readLeaseFile(controlledNodeLivenessLeasePath(options.journalPath)),
    await readLeaseFile(controlledNodeHealthLeasePath(options.journalPath)),
  ];
  const judged = readings.map((reading) => {
    if (reading.kind !== 'lease') return { reading, ageMs: Number.POSITIVE_INFINITY, pidAlive: false };
    return {
      reading,
      ageMs: now - reading.lease.updatedAt,
      pidAlive: processExists(reading.lease.pid),
    };
  });
  if (judged.some((entry) => entry.reading.kind === 'lease' && entry.pidAlive && entry.ageMs >= -60_000 && entry.ageMs <= staleMs)) {
    await rm(statePath, { force: true }).catch(() => {});
    return { healthy: true, restarted: false, reason: 'healthy' };
  }

  // Not healthy: name the failure after the first lease that exists (the liveness lease, else the health lease).
  let reason: ControlledNodeHealthWatchdogResult['reason'] = 'lease_missing';
  let pidAlive = false;
  const primary = judged.find((entry) => entry.reading.kind === 'lease') ?? judged.find((entry) => entry.reading.kind === 'invalid');
  if (primary?.reading.kind === 'invalid') reason = 'lease_invalid';
  else if (primary) {
    pidAlive = primary.pidAlive;
    if (primary.ageMs < -60_000) reason = 'lease_future';
    else if (!primary.pidAlive) reason = 'lease_pid_missing';
    else reason = 'lease_stale';
  }

  let failureSince = now;
  try {
    const parsed = await readJson(statePath);
    if (isControlledNodeHealthWatchdogState(parsed)) failureSince = Math.min(parsed.failureSince, now);
  } catch {
    // Missing/corrupt state starts a fresh bounded grace window.
  }

  // A live process with a lease already stale for the full threshold is conclusive. Other states may simply be a
  // fresh replacement, so require persistence across the grace window before restarting.
  const decisiveStaleProcess = reason === 'lease_stale' && pidAlive;
  const shouldRestart = decisiveStaleProcess || now - failureSince >= staleMs;
  await writeJsonAtomic(statePath, {
    version: 1,
    failureSince,
    reason,
  } satisfies ControlledNodeHealthWatchdogState);
  if (!shouldRestart) return { healthy: false, restarted: false, reason };

  await options.restartService();
  await rm(statePath, { force: true }).catch(() => {});
  return { healthy: false, restarted: true, reason };
}

export interface ControlledNodeHealthLeasePublisher {
  recordAuthenticatedHeartbeat(): void;
  flush(): Promise<void>;
}

/** Throttle the five-second heartbeat stream to one durable write per 15 s. */
export function createControlledNodeHealthLeasePublisher(
  path: string,
  options: {
    now?: () => number;
    monotonicNow?: () => number;
    pid?: number;
    intervalMs?: number;
    writeLease?: (path: string, now: number, pid: number) => Promise<void>;
    onError?: (error: unknown) => void;
  } = {},
): ControlledNodeHealthLeasePublisher {
  const now = options.now ?? Date.now;
  // Keep the persisted timestamp on wall time for external watchdogs, but
  // throttle on a monotonic clock. NTP, manual clock changes and resume-time
  // corrections must never defer authenticated lease renewal.
  const monotonicNow = options.monotonicNow
    ?? (options.now ? options.now : () => performance.now());
  const pid = options.pid ?? process.pid;
  const intervalMs = options.intervalMs ?? CONTROLLED_NODE_HEALTH_WRITE_INTERVAL_MS;
  const writeLease = options.writeLease ?? writeControlledNodeHealthLease;
  let lastWriteStartedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const recordAuthenticatedHeartbeat = (): void => {
    const observedAt = now();
    const throttleAt = monotonicNow();
    if (inFlight || throttleAt - lastWriteStartedAt < intervalMs) return;
    lastWriteStartedAt = throttleAt;
    inFlight = writeLease(path, observedAt, pid)
      .catch((error) => { options.onError?.(error); })
      .finally(() => { inFlight = null; });
  };

  return {
    recordAuthenticatedHeartbeat,
    async flush(): Promise<void> {
      await inFlight;
    },
  };
}

/** `systemd-notify WATCHDOG=1` for one pid (the unit sets NotifyAccess=all). */
export function notifySystemdWatchdog(pid: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile('systemd-notify', [`--pid=${pid}`, 'WATCHDOG=1'], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export interface ControlledNodeLivenessPublisher {
  /**
   * The connection machinery did something: a connection attempt, a failure, a scheduled retry, an opened socket, an ack.
   * `socket_opened` also starts the clock of the unacknowledged-open backstop.
   */
  recordConnectionActivity(kind?: string): void;
  /** An authenticated heartbeat acknowledgement (also counts as activity). */
  recordAuthenticatedHeartbeat(): void;
  /** Starts the periodic renewal (idempotent); the timer never keeps the process alive. */
  start(): void;
  stop(): void;
  /** One renewal decision; exposed for tests and for an immediate first pulse. */
  tick(): Promise<void>;
}

/**
 * Publishes "this node process is alive and working" for the platform watchdogs (the liveness lease file, and on Linux
 * the systemd watchdog pulse), independently of whether the server is reachable.
 *
 * It renews only while the node's connection machinery has shown activity within the activity window. A healthy node
 * acks every 5 s and a node that cannot reach the server keeps scheduling and failing connection attempts, so both are
 * alive; a process whose event loop is blocked cannot run the timer at all, and one whose connection machinery has
 * stopped doing anything stops being renewed -- the watchdog then restarts it. The process starting counts as activity,
 * so a freshly started node is not restarted before it had a chance to connect.
 */
export function createControlledNodeLivenessPublisher(options: {
  path: string;
  /** Linux: also feed the service manager's watchdog. */
  notifyWatchdog?: (pid: number) => Promise<void>;
  now?: () => number;
  monotonicNow?: () => number;
  pid?: number;
  intervalMs?: number;
  activityWindowMs?: number;
  writeLease?: (path: string, now: number, pid: number) => Promise<void>;
  onError?: (error: unknown) => void;
  /** Called (at most once per repeat interval) while no authenticated ack was seen for the warn threshold. */
  onUnreachable?: (silentForMs: number) => void;
  unreachableWarnAfterMs?: number;
  unreachableWarnRepeatMs?: number;
  /** Backstop level carried over from earlier restarts that no ack followed (0 = none); see controlledNodeLivenessBackstopMs. */
  backstopLevel?: number;
  /** Overrides the period of the level (tests). */
  unackedOpenBackstopMs?: number;
  /** Called once when the backstop stops the renewal; the level the NEXT process should start at is `nextLevel`. */
  onBackstop?: (unackedForMs: number, nextLevel: number) => void;
  /** Called on the first authenticated ack after a backstop level was in force (the level is back to 0). */
  onBackstopCleared?: () => void;
}): ControlledNodeLivenessPublisher {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const pid = options.pid ?? process.pid;
  const intervalMs = options.intervalMs ?? CONTROLLED_NODE_LIVENESS_WRITE_INTERVAL_MS;
  const activityWindowMs = options.activityWindowMs ?? CONTROLLED_NODE_LIVENESS_ACTIVITY_WINDOW_MS;
  const writeLease = options.writeLease ?? writeControlledNodeHealthLease;
  const warnAfterMs = options.unreachableWarnAfterMs ?? CONTROLLED_NODE_UNREACHABLE_WARN_AFTER_MS;
  const warnRepeatMs = options.unreachableWarnRepeatMs ?? CONTROLLED_NODE_UNREACHABLE_WARN_REPEAT_MS;
  const startedAt = monotonicNow();
  let lastActivityAt = startedAt;
  let lastAckAt = startedAt;
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  let firstOpenedUnackedAt: number | undefined;
  let backstopReported = false;
  let backstopCleared = false;
  const backstopLevel = options.backstopLevel ?? 0;
  const backstopMs = options.unackedOpenBackstopMs ?? controlledNodeLivenessBackstopMs(backstopLevel);
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  const publish = async (): Promise<void> => {
    const results = await Promise.allSettled([
      writeLease(options.path, now(), pid),
      options.notifyWatchdog ? options.notifyWatchdog(pid) : Promise.resolve(),
    ]);
    for (const result of results) if (result.status === 'rejected') options.onError?.(result.reason);
  };

  const tick = async (): Promise<void> => {
    const at = monotonicNow();
    if (options.onUnreachable && at - lastAckAt >= warnAfterMs && at - lastWarnAt >= warnRepeatMs) {
      lastWarnAt = at;
      options.onUnreachable(at - lastAckAt);
    }
    if (at - lastActivityAt > activityWindowMs) return; // stuck: let the watchdog act
    if (firstOpenedUnackedAt !== undefined && at - firstOpenedUnackedAt >= backstopMs) {
      // Sockets keep opening, nothing ever acknowledges this node: stuck inside the connection handling, not offline.
      if (!backstopReported) {
        backstopReported = true;
        options.onBackstop?.(at - firstOpenedUnackedAt, backstopLevel + 1);
      }
      return;
    }
    if (inFlight) return inFlight;
    inFlight = publish().finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    recordConnectionActivity(kind?: string): void {
      lastActivityAt = monotonicNow();
      if (kind === 'socket_opened' && firstOpenedUnackedAt === undefined) firstOpenedUnackedAt = lastActivityAt;
    },
    recordAuthenticatedHeartbeat(): void {
      lastActivityAt = monotonicNow();
      lastAckAt = lastActivityAt;
      firstOpenedUnackedAt = undefined;
      backstopReported = false;
      if (backstopLevel > 0 && !backstopCleared) {
        backstopCleared = true;
        options.onBackstopCleared?.();
      }
    },
    start(): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

export function controlledNodeLivenessBackstopStatePath(journalPath: string): string {
  return join(dirname(journalPath), CONTROLLED_NODE_LIVENESS_BACKSTOP_STATE_FILE);
}

/** The backstop level of earlier processes; a missing or damaged file is level 0. */
export async function readLivenessBackstopLevel(path: string): Promise<number> {
  try {
    const parsed = await readJson(path) as { version?: unknown; level?: unknown };
    return parsed.version === 1 && typeof parsed.level === 'number' && Number.isSafeInteger(parsed.level) && parsed.level > 0
      ? Math.min(parsed.level, 20)
      : 0;
  } catch {
    return 0;
  }
}

export async function writeLivenessBackstopLevel(path: string, level: number): Promise<void> {
  if (level <= 0) {
    await rm(path, { force: true });
    return;
  }
  await writeJsonAtomic(path, { version: 1, level: Math.min(level, 20) });
}
