import type { PendingTransportMessage, TransportSessionRuntime } from '../agent/transport-session-runtime.js';
import { isDeepStrictEqual } from 'node:util';
import { enqueueResend, getResendCount, getResendEntries, recipientFromSessionRecord } from './transport-resend-queue.js';
import { getSession } from '../store/session-store.js';

export interface TransportRuntimeQueuePreservationResult {
  beforeCount: number;
  afterCount: number;
  preservedCount: number;
  /** Entries refused because an existing id carried different private authority. */
  rejectedCount: number;
  activeCount: number;
  pendingCount: number;
}

function preserveEntries(
  sessionName: string,
  entries: PendingTransportMessage[],
  seenSnapshotIds: Set<string>,
  existingIds: Set<string>,
  legacyByCommandId: Map<string, ReturnType<typeof getResendEntries>[number]>,
  recipient: ReturnType<typeof recipientFromSessionRecord>,
): { preservedCount: number; rejectedCount: number } {
  let preservedCount = 0;
  let rejectedCount = 0;
  for (const entry of entries) {
    if (seenSnapshotIds.has(entry.clientMessageId)) continue;
    seenSnapshotIds.add(entry.clientMessageId);
    const legacy = legacyByCommandId.get(entry.clientMessageId);
    if (legacy && legacy.clientMessageId !== entry.clientMessageId) {
      const durableShape = {
        text: legacy.text,
        providerText: legacy.providerText,
        aliasAudit: legacy.aliasAudit,
        messagePreamble: legacy.messagePreamble,
        attachments: legacy.attachments,
        sharedActor: legacy.sharedActor,
        sharedMachineAuthority: legacy.sharedMachineAuthority,
        deliveryMode: legacy.deliveryMode,
        activeTurnDeliveryKind: legacy.activeTurnDeliveryKind,
        peerAudit: legacy.peerAudit,
        delegationReply: legacy.delegationReply,
        supervisionReference: legacy.supervisionReference,
        timelineCommitted: legacy.timelineCommitted,
        historyCommitted: legacy.historyCommitted,
        registeredSystemContract: legacy.registeredSystemContract,
      };
      const replayShape = {
        text: entry.text,
        providerText: entry.providerText,
        aliasAudit: entry.aliasAudit,
        messagePreamble: entry.messagePreamble,
        attachments: entry.attachments,
        sharedActor: entry.sharedActor,
        sharedMachineAuthority: entry.sharedMachineAuthority,
        deliveryMode: entry.deliveryMode,
        activeTurnDeliveryKind: entry.activeTurnDeliveryKind,
        peerAudit: entry.peerAudit,
        delegationReply: entry.delegationReply,
        supervisionReference: entry.supervisionReference,
        timelineCommitted: entry.timelineCommitted,
        historyCommitted: entry.historyCommitted,
        registeredSystemContract: entry.registeredSystemContract,
      };
      if (!isDeepStrictEqual(durableShape, replayShape)) rejectedCount++;
      continue;
    }
    const existed = existingIds.has(entry.clientMessageId);
    const queued = enqueueResend(sessionName, {
      // Use the disappearing runtime's captured identity, not a same-named live
      // record that may already have rotated. The replacement runtime can rebind
      // the same instance across epochs; it must never make the old row prove
      // ownership by borrowing the successor's current registry projection.
      ...(recipient ? { recipient } : {}),
      text: entry.text,
      ...(entry.providerText != null ? { providerText: entry.providerText } : {}),
      ...(entry.aliasAudit ? { aliasAudit: entry.aliasAudit } : {}),
      ...(entry.messagePreamble ? { messagePreamble: entry.messagePreamble } : {}),
      commandId: entry.clientMessageId,
      clientMessageId: entry.clientMessageId,
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
      ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
      ...(entry.historyCommitted ? { historyCommitted: true } : {}),
      ...(entry.deliveryMode ? { deliveryMode: entry.deliveryMode } : {}),
      ...(entry.activeTurnDeliveryKind
        ? { activeTurnDeliveryKind: entry.activeTurnDeliveryKind }
        : {}),
      ...(entry.peerAudit ? { peerAudit: entry.peerAudit } : {}),
      ...(entry.delegationReply ? { delegationReply: entry.delegationReply } : {}),
      ...(entry.supervisionReference
        ? { supervisionReference: entry.supervisionReference }
        : {}),
      ...(entry.registeredSystemContract
        ? { registeredSystemContract: entry.registeredSystemContract }
        : {}),
      queuedAt: Date.now(),
    });
    if (!queued.accepted) {
      rejectedCount++;
      continue;
    }
    existingIds.add(entry.clientMessageId);
    if (!existed) preservedCount++;
  }
  return { preservedCount, rejectedCount };
}

export function preserveTransportRuntimeQueuesToResend(
  sessionName: string,
  runtime: TransportSessionRuntime,
): TransportRuntimeQueuePreservationResult {
  const activeEntries = runtime.activeDispatchEntriesForResend ?? runtime.activeDispatchEntries ?? [];
  const pendingEntries = runtime.pendingEntriesForResend ?? runtime.pendingEntries ?? [];
  const beforeCount = getResendCount(sessionName);
  const existingIds = new Set(getResendEntries(sessionName)
    .map((entry) => entry.clientMessageId ?? entry.commandId));
  const legacyByCommandId = new Map(getResendEntries(sessionName)
    .map((entry) => [entry.commandId, entry] as const));
  const recipient = runtime.recipientIdentity ?? recipientFromSessionRecord(getSession(sessionName));
  const seenSnapshotIds = new Set<string>();
  const active = preserveEntries(
    sessionName, activeEntries, seenSnapshotIds, existingIds, legacyByCommandId, recipient,
  );
  const pending = preserveEntries(
    sessionName, pendingEntries, seenSnapshotIds, existingIds, legacyByCommandId, recipient,
  );
  const afterCount = getResendCount(sessionName);
  return {
    beforeCount,
    afterCount,
    preservedCount: active.preservedCount + pending.preservedCount,
    rejectedCount: active.rejectedCount + pending.rejectedCount,
    activeCount: activeEntries.length,
    pendingCount: pendingEntries.length,
  };
}
