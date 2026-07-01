import logger from '../util/logger.js';
import { getTransportQueueStore } from './transport-queue-store.js';

/**
 * Deprecated compatibility shim for old pending-queue revision call sites.
 *
 * The queue authority is SQLite (`TransportQueueStore`). These functions must
 * not mint authoritative versions; they only expose the committed SQLite
 * `pendingMessageVersion` while remaining source-compatible with older emit
 * paths that are being migrated to structured queue snapshots.
 */

const observedRuntimeVersions = new Map<string, number>();

function normalizeRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function getTransportQueueRevision(sessionName: string): number | undefined {
  const snapshot = getTransportQueueStore().readSnapshotSafely(sessionName, 'revision_shim');
  if (snapshot.degraded) return undefined;
  return snapshot.pendingMessageVersion;
}

export function observeTransportQueueRevision(sessionName: string, observed: unknown): number {
  const normalized = normalizeRevision(observed);
  if (normalized !== undefined) {
    observedRuntimeVersions.set(sessionName, normalized);
    const committed = getTransportQueueRevision(sessionName) ?? 0;
    if (normalized > committed) {
      logger.debug(
        { sessionName, observedRuntimeVersion: normalized, committedQueueVersion: committed },
        'ignored runtime pending version for SQLite transport queue revision shim',
      );
    }
    return committed;
  }
  return getTransportQueueRevision(sessionName) ?? 0;
}

export function bumpTransportQueueRevision(sessionName: string): number {
  const committed = getTransportQueueRevision(sessionName) ?? 0;
  logger.debug({ sessionName, committedQueueVersion: committed }, 'ignored deprecated transport queue revision bump');
  return committed;
}

export function clearTransportQueueRevision(sessionName: string): void {
  observedRuntimeVersions.delete(sessionName);
}

export function clearAllTransportQueueRevisions(): void {
  observedRuntimeVersions.clear();
}
