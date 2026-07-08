import type { PendingTransportMessage, TransportSessionRuntime } from '../agent/transport-session-runtime.js';
import { enqueueResend, getResendCount, getResendEntries } from './transport-resend-queue.js';

export interface TransportRuntimeQueuePreservationResult {
  beforeCount: number;
  afterCount: number;
  preservedCount: number;
  activeCount: number;
  pendingCount: number;
}

function preserveEntries(
  sessionName: string,
  entries: PendingTransportMessage[],
  seenCommandIds: Set<string>,
): number {
  let preservedCount = 0;
  for (const entry of entries) {
    if (seenCommandIds.has(entry.clientMessageId)) continue;
    enqueueResend(sessionName, {
      text: entry.text,
      ...(entry.providerText != null ? { providerText: entry.providerText } : {}),
      ...(entry.messagePreamble ? { messagePreamble: entry.messagePreamble } : {}),
      commandId: entry.clientMessageId,
      clientMessageId: entry.clientMessageId,
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
      ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
      ...(entry.historyCommitted ? { historyCommitted: true } : {}),
      queuedAt: Date.now(),
    });
    seenCommandIds.add(entry.clientMessageId);
    preservedCount++;
  }
  return preservedCount;
}

export function preserveTransportRuntimeQueuesToResend(
  sessionName: string,
  runtime: TransportSessionRuntime,
): TransportRuntimeQueuePreservationResult {
  const activeEntries = runtime.activeDispatchEntriesForResend ?? runtime.activeDispatchEntries ?? [];
  const pendingEntries = runtime.pendingEntriesForResend ?? runtime.pendingEntries ?? [];
  const beforeCount = getResendCount(sessionName);
  const seenCommandIds = new Set(getResendEntries(sessionName).map((entry) => entry.commandId));
  const preservedActiveCount = preserveEntries(sessionName, activeEntries, seenCommandIds);
  const preservedPendingCount = preserveEntries(sessionName, pendingEntries, seenCommandIds);
  const afterCount = getResendCount(sessionName);
  return {
    beforeCount,
    afterCount,
    preservedCount: preservedActiveCount + preservedPendingCount,
    activeCount: activeEntries.length,
    pendingCount: pendingEntries.length,
  };
}
