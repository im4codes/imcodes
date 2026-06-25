/**
 * Daemon-scoped protocol revision for transport pending-queue snapshots.
 *
 * TransportSessionRuntime has its own internal pendingVersion, but resend queues
 * also exist while no runtime is available. The web client compares a single
 * pendingMessageVersion number per session, so every runtime/resend snapshot
 * must share one comparable revision namespace.
 */

const revisions = new Map<string, number>();
const observedRuntimeVersions = new Map<string, number>();

function normalizeRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function getTransportQueueRevision(sessionName: string): number | undefined {
  return revisions.get(sessionName);
}

export function observeTransportQueueRevision(sessionName: string, observed: unknown): number {
  const current = revisions.get(sessionName);
  const normalized = normalizeRevision(observed);
  if (current === undefined) {
    // Never use 0 as an ordinary queue revision. Older UI code treated 0 as a
    // reset and would lower its baseline, allowing stale queued snapshots to
    // resurrect already-drained queue cards. A future epoch/generation field can
    // model true restarts explicitly; within this numeric namespace revisions
    // must be monotonic and positive.
    const initial = normalized === undefined || normalized < 1 ? 1 : normalized;
    revisions.set(sessionName, initial);
    if (normalized !== undefined) observedRuntimeVersions.set(sessionName, normalized);
    return initial;
  }
  if (normalized !== undefined) {
    const lastObserved = observedRuntimeVersions.get(sessionName);
    observedRuntimeVersions.set(sessionName, normalized);
    if (lastObserved === undefined && normalized > current) {
      revisions.set(sessionName, normalized);
      return normalized;
    }
    if (lastObserved !== undefined && normalized > lastObserved) {
      const next = current + (normalized - lastObserved);
      revisions.set(sessionName, next);
      return next;
    }
  }
  return current;
}

export function bumpTransportQueueRevision(sessionName: string): number {
  const current = revisions.get(sessionName);
  const next = current === undefined ? 1 : current + 1;
  revisions.set(sessionName, next);
  return next;
}

export function clearTransportQueueRevision(sessionName: string): void {
  revisions.delete(sessionName);
  observedRuntimeVersions.delete(sessionName);
}

export function clearAllTransportQueueRevisions(): void {
  revisions.clear();
  observedRuntimeVersions.clear();
}
