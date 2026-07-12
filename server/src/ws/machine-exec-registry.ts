// Per-pod pending-RPC registry for MACHINE_EXEC (10.6). A relay request registers
// a pending entry keyed by correlationId and bound to the target server id + the
// target's WS connection generation at dispatch time. A MACHINE_EXEC_RESULT is
// accepted ONLY from that exact (serverId, generation) with a matching in-flight
// correlationId; everything else is dropped and counted. A new connection
// generation abandons all prior-generation pendings as `indeterminate`.
import type { RemoteExecResult } from '../../../shared/remote-exec.js';

interface PendingExec {
  targetServerId: string;
  generation: number;
  resolve: (result: RemoteExecResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingExec>();
let droppedResults = 0;

/** Metrics accessor (diagnostics / tests). */
export function machineExecRegistryStats(): { inFlight: number; droppedResults: number } {
  return { inFlight: pending.size, droppedResults };
}

/**
 * Register a pending exec. Resolves with the node's result, or `null` if the
 * deadline elapses (→ the relay reports `dispatched_no_result` / indeterminate).
 */
export function registerPendingExec(
  targetServerId: string,
  correlationId: string,
  generation: number,
  deadlineMs: number,
): Promise<RemoteExecResult | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.get(correlationId)?.timer === timer) pending.delete(correlationId);
      resolve(null);
    }, deadlineMs);
    timer.unref?.();
    pending.set(correlationId, { targetServerId, generation, resolve, timer });
  });
}

/**
 * Resolve a pending exec from a daemon result. Accepts ONLY when the correlationId
 * matches an in-flight entry AND the delivering connection's (serverId, generation)
 * equals the one the request was dispatched on. Returns true if delivered.
 */
export function resolvePendingExec(
  fromServerId: string,
  fromGeneration: number,
  result: RemoteExecResult & { correlationId?: string },
): boolean {
  const correlationId = typeof result.correlationId === 'string' ? result.correlationId : undefined;
  if (!correlationId) { droppedResults++; return false; }
  const entry = pending.get(correlationId);
  if (!entry || entry.targetServerId !== fromServerId || entry.generation !== fromGeneration) {
    droppedResults++;
    return false;
  }
  pending.delete(correlationId);
  clearTimeout(entry.timer);
  entry.resolve(result);
  return true;
}

/** Abandon all pendings for a target's prior generations (reconnect / disconnect). */
export function abandonPriorGenerations(targetServerId: string, keepGeneration: number): number {
  let abandoned = 0;
  for (const [id, entry] of pending) {
    if (entry.targetServerId === targetServerId && entry.generation !== keepGeneration) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(null); // → dispatched_no_result (indeterminate)
      abandoned++;
    }
  }
  return abandoned;
}
