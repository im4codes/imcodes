import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const CONTROLLED_NODE_HEALTH_LEASE_FILE = 'health-lease.json';
export const CONTROLLED_NODE_HEALTH_LEASE_VERSION = 1 as const;
export const CONTROLLED_NODE_HEALTH_WRITE_INTERVAL_MS = 15_000;

export interface ControlledNodeHealthLease {
  version: typeof CONTROLLED_NODE_HEALTH_LEASE_VERSION;
  pid: number;
  updatedAt: number;
}

export function controlledNodeHealthLeasePath(journalPath: string): string {
  return join(dirname(journalPath), CONTROLLED_NODE_HEALTH_LEASE_FILE);
}

/**
 * Atomically publish proof that this exact process received an authenticated
 * server heartbeat acknowledgement. The external Windows watchdog consumes
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
