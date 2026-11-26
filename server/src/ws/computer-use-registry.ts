import type { ComputerUseResultFrame, ComputerUseResult } from '../../../shared/computer-use.js';

interface PendingComputerUse {
  targetServerId: string;
  generation: number;
  resolve: (result: ComputerUseResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingComputerUse>();
let droppedResults = 0;

export function computerUseRegistryStats(): { inFlight: number; droppedResults: number } {
  return { inFlight: pending.size, droppedResults };
}

export function registerPendingComputerUse(
  targetServerId: string,
  correlationId: string,
  generation: number,
  deadlineMs: number,
): Promise<ComputerUseResult | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.get(correlationId)?.timer === timer) pending.delete(correlationId);
      resolve(null);
    }, deadlineMs);
    timer.unref?.();
    pending.set(correlationId, { targetServerId, generation, resolve, timer });
  });
}

export function resolvePendingComputerUse(
  fromServerId: string,
  fromGeneration: number,
  result: ComputerUseResultFrame,
): boolean {
  const entry = pending.get(result.correlationId);
  if (!entry || entry.targetServerId !== fromServerId || entry.generation !== fromGeneration) {
    droppedResults++;
    return false;
  }
  pending.delete(result.correlationId);
  clearTimeout(entry.timer);
  const { type: _type, ...payload } = result;
  entry.resolve(payload);
  return true;
}

export function cancelPendingComputerUse(correlationId: string): boolean {
  const entry = pending.get(correlationId);
  if (!entry) return false;
  pending.delete(correlationId);
  clearTimeout(entry.timer);
  entry.resolve(null);
  return true;
}

export function abandonComputerUsePriorGenerations(targetServerId: string, keepGeneration: number): number {
  let abandoned = 0;
  for (const [id, entry] of pending) {
    if (entry.targetServerId === targetServerId && entry.generation !== keepGeneration) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(null);
      abandoned++;
    }
  }
  return abandoned;
}
