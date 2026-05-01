import logger from '../util/logger.js';
import { incrementCounter } from '../util/metrics.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';

interface InflightMasterCompaction {
  id: string;
  sessionName: string;
  namespaceKey?: string;
  startedAt: number;
  promise: Promise<unknown>;
}

export type MasterCompactionStopReason = 'shutdown' | 'upgrade-pending' | 'test-reset';

export interface MasterCompactionMeta {
  sessionName: string;
  namespaceKey?: string;
}

export type MasterCompactionRegistration<T> =
  | { skipped: true; reason: MasterCompactionStopReason }
  | { skipped: false; id: string; promise: Promise<T> };

export interface MasterCompactionDrainResult {
  snapshotCount: number;
  drained: number;
  remainingFromSnapshot: number;
  registeredDuringDrain: number;
  timedOut: boolean;
  durationMs: number;
}

const inflight = new Map<string, InflightMasterCompaction>();
let accepting = true;
let lastStopReason: MasterCompactionStopReason | null = null;
let sequence = 0;

export function resetMasterCompactionRegistryForTests(): void {
  inflight.clear();
  accepting = true;
  lastStopReason = null;
  sequence = 0;
}

export function stopAcceptingMasterCompactions(reason: MasterCompactionStopReason = 'shutdown'): void {
  accepting = false;
  lastStopReason = reason;
  logger.debug({ reason, inflight: inflight.size }, 'master compaction registry stopped accepting new work');
}

export function resumeAcceptingMasterCompactions(): void {
  accepting = true;
  lastStopReason = null;
  logger.debug({ inflight: inflight.size }, 'master compaction registry resumed accepting new work');
}

export function resumeAcceptingMasterCompactionsForTests(): void {
  resumeAcceptingMasterCompactions();
}

export function getMasterCompactionStopReason(): MasterCompactionStopReason | null {
  return lastStopReason;
}

function skipMasterCompaction(meta: MasterCompactionMeta): { skipped: true; reason: MasterCompactionStopReason } {
  const reason = lastStopReason ?? 'shutdown';
  incrementCounter('mem.master_compaction.skipped', { reason });
  logger.warn({
    session: meta.sessionName,
    ...(meta.namespaceKey ? { namespaceKey: meta.namespaceKey } : {}),
    reason,
  }, 'master summary materialization skipped because admission is closed');
  return { skipped: true, reason };
}

export function isAcceptingMasterCompactions(): boolean {
  return accepting;
}

export function getInflightMasterCompactionCount(): number {
  return inflight.size;
}

export function getInflightMasterCompactions(): Array<{ id: string; sessionName: string; namespaceKey?: string; startedAt: number }> {
  return [...inflight.values()].map(({ id, sessionName, namespaceKey, startedAt }) => ({
    id,
    sessionName,
    ...(namespaceKey ? { namespaceKey } : {}),
    startedAt,
  }));
}

export function registerMasterCompaction<T>(
  factory: () => Promise<T>,
  meta: MasterCompactionMeta,
): MasterCompactionRegistration<T> {
  if (!accepting) return skipMasterCompaction(meta);
  const id = `master-compaction-${Date.now()}-${++sequence}`;
  const startedAt = Date.now();
  const tracked = Promise.resolve().then(factory).finally(() => {
    inflight.delete(id);
  });
  inflight.set(id, {
    id,
    sessionName: meta.sessionName,
    ...(meta.namespaceKey ? { namespaceKey: meta.namespaceKey } : {}),
    startedAt,
    promise: tracked,
  });
  return { skipped: false, id, promise: tracked };
}

export async function drainMasterCompactions(timeoutMs: number): Promise<MasterCompactionDrainResult> {
  const startedAt = Date.now();
  const snapshot = [...inflight.values()];
  const snapshotIds = new Set(snapshot.map((item) => item.id));
  if (snapshot.length === 0) {
    return {
      snapshotCount: 0,
      drained: 0,
      remainingFromSnapshot: 0,
      registeredDuringDrain: 0,
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    timeoutHandle.unref?.();
  });
  const settled = Promise.allSettled(snapshot.map((item) => item.promise)).then(() => 'settled' as const);
  const result = await Promise.race([settled, timeout]);
  if (result === 'settled' && timeoutHandle) clearTimeout(timeoutHandle);
  const remainingFromSnapshot = snapshot.filter((item) => inflight.has(item.id)).length;
  const registeredDuringDrain = [...inflight.keys()].filter((id) => !snapshotIds.has(id)).length;
  const drained = snapshot.length - remainingFromSnapshot;
  if (registeredDuringDrain > 0) {
    incrementCounter('mem.shutdown.master_drain.contract_violation', { source: 'drainMasterCompactions' });
    warnOncePerHour('mem.shutdown.master_drain.contract_violation', {
      registeredDuringDrain,
      snapshotCount: snapshot.length,
    });
    logger.error({ registeredDuringDrain, snapshotCount: snapshot.length }, 'master compaction drain observed post-snapshot registrations');
  }
  if (result === 'timeout' && remainingFromSnapshot > 0) {
    incrementCounter('mem.shutdown.master_drain.timed_out', { source: 'drainMasterCompactions' });
  }
  return {
    snapshotCount: snapshot.length,
    drained,
    remainingFromSnapshot,
    registeredDuringDrain,
    timedOut: result === 'timeout' && remainingFromSnapshot > 0,
    durationMs: Date.now() - startedAt,
  };
}
