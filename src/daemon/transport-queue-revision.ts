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
    // If the daemon just restarted and the first visible queue mutation already
    // has runtime version 1, emit 0 once so the web reset rule can establish a
    // fresh baseline instead of rejecting a lower-than-old-session number.
    const initial = normalized === undefined || normalized <= 1 ? 0 : normalized;
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
  const next = current === undefined ? 0 : current + 1;
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
