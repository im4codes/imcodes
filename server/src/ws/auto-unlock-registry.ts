import type { ControlledNodeAutoUnlockResult } from '../../../shared/controlled-node-auto-unlock.js';

/**
 * In-flight auto-unlock requests, bound to the node connection that received
 * them. A reply from a different node, or from a later connection generation,
 * is dropped rather than resolving someone else's request.
 *
 * Only the boolean outcome travels back through here; the secret itself exists
 * on this side for the length of one WebSocket send and is never stored.
 */
interface PendingAutoUnlock {
  targetServerId: string;
  generation: number;
  resolve: (result: ControlledNodeAutoUnlockResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingAutoUnlock>();
let droppedResults = 0;

export function autoUnlockRegistryStats(): { inFlight: number; droppedResults: number } {
  return { inFlight: pending.size, droppedResults };
}

export function registerPendingAutoUnlock(
  targetServerId: string,
  requestId: string,
  generation: number,
  deadlineMs: number,
): Promise<ControlledNodeAutoUnlockResult | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.get(requestId)?.timer === timer) pending.delete(requestId);
      resolve(null);
    }, deadlineMs);
    timer.unref?.();
    pending.set(requestId, { targetServerId, generation, resolve, timer });
  });
}

export function resolvePendingAutoUnlock(
  fromServerId: string,
  fromGeneration: number,
  result: ControlledNodeAutoUnlockResult,
): boolean {
  const entry = pending.get(result.requestId);
  if (!entry || entry.targetServerId !== fromServerId || entry.generation !== fromGeneration) {
    droppedResults++;
    return false;
  }
  pending.delete(result.requestId);
  clearTimeout(entry.timer);
  entry.resolve(result);
  return true;
}

export function cancelPendingAutoUnlock(requestId: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve(null);
  return true;
}
