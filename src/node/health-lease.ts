import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

/**
 * One-shot macOS health check, invoked by a separate periodic LaunchDaemon.
 * Missing/invalid leases receive a full grace window so first boot and normal
 * process replacement are not mistaken for a wedge. A stale lease whose exact
 * PID is still alive is decisive evidence of the observed fake-alive state and
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
  const leasePath = controlledNodeHealthLeasePath(options.journalPath);
  const statePath = controlledNodeHealthWatchdogStatePath(options.journalPath);
  const processExists = options.processExists ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  });

  let lease: ControlledNodeHealthLease | null = null;
  let reason: ControlledNodeHealthWatchdogResult['reason'] = 'lease_missing';
  try {
    const parsed = await readJson(leasePath);
    if (isControlledNodeHealthLease(parsed)) lease = parsed;
    else reason = 'lease_invalid';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reason = 'lease_invalid';
  }

  const ageMs = lease ? now - lease.updatedAt : Number.POSITIVE_INFINITY;
  const pidAlive = lease ? processExists(lease.pid) : false;
  if (lease && pidAlive && ageMs >= -60_000 && ageMs <= staleMs) {
    await rm(statePath, { force: true }).catch(() => {});
    return { healthy: true, restarted: false, reason: 'healthy' };
  }
  if (lease) {
    if (ageMs < -60_000) reason = 'lease_future';
    else if (!pidAlive) reason = 'lease_pid_missing';
    else reason = 'lease_stale';
  }

  let failureSince = now;
  try {
    const parsed = await readJson(statePath);
    if (isControlledNodeHealthWatchdogState(parsed)) failureSince = Math.min(parsed.failureSince, now);
  } catch {
    // Missing/corrupt state starts a fresh bounded grace window.
  }

  // A live process with an authenticated lease already stale for the full
  // threshold is conclusive. Other states may simply be a fresh replacement,
  // so require persistence across the grace window before restarting.
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
    pid?: number;
    intervalMs?: number;
    writeLease?: (path: string, now: number, pid: number) => Promise<void>;
    onError?: (error: unknown) => void;
  } = {},
): ControlledNodeHealthLeasePublisher {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const intervalMs = options.intervalMs ?? CONTROLLED_NODE_HEALTH_WRITE_INTERVAL_MS;
  const writeLease = options.writeLease ?? writeControlledNodeHealthLease;
  let lastWriteStartedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const recordAuthenticatedHeartbeat = (): void => {
    const observedAt = now();
    if (inFlight || observedAt - lastWriteStartedAt < intervalMs) return;
    lastWriteStartedAt = observedAt;
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

/** Publish systemd's native watchdog pulse only after an authenticated ack. */
export function createSystemdWatchdogNotifier(options: {
  now?: () => number;
  pid?: number;
  intervalMs?: number;
  notify?: (pid: number) => Promise<void>;
  onError?: (error: unknown) => void;
} = {}): ControlledNodeHealthLeasePublisher {
  const notify = options.notify ?? ((pid: number) => new Promise<void>((resolve, reject) => {
    execFile('systemd-notify', [`--pid=${pid}`, 'WATCHDOG=1'], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  }));
  return createControlledNodeHealthLeasePublisher('systemd-watchdog', {
    now: options.now,
    pid: options.pid,
    intervalMs: options.intervalMs,
    writeLease: async (_path, _now, pid) => notify(pid),
    onError: options.onError,
  });
}
