import type { PendingTransportMessage, TransportSessionRuntime } from '../agent/transport-session-runtime.js';
import { isDeepStrictEqual } from 'node:util';
import { enqueueResend, getResendCount, getResendEntries, recipientFromSessionRecord } from './transport-resend-queue.js';
import { getSession } from '../store/session-store.js';
import { getTransportQueueStore } from './transport-queue-store.js';

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
  durableStatuses: Map<string, string>,
): { preservedCount: number; rejectedCount: number } {
  let preservedCount = 0;
  let rejectedCount = 0;
  for (const entry of entries) {
    if (seenSnapshotIds.has(entry.clientMessageId)) continue;
    seenSnapshotIds.add(entry.clientMessageId);
    // A dispatching/handoff row is already owned by the previous runtime. It
    // may have crossed the provider boundary, so copying its active payload to
    // the resend holder would turn a reconnect into a duplicate delivery. The
    // durable lease remains quarantined until expiry, when normal recovery can
    // retry it under the same id if no acceptance tombstone arrived.
    const durableStatus = durableStatuses.get(entry.clientMessageId);
    if (durableStatus === 'handoff_inflight' || durableStatus === 'dispatching') continue;
    if (!durableStatus) {
      try {
        if (getTransportQueueStore().hasDeliveryTombstone(sessionName, entry.clientMessageId)) continue;
      } catch {
        // Preserve conservatively when the tombstone read is unavailable.
      }
    }
    const legacy = legacyByCommandId.get(entry.clientMessageId);
    if (legacy && legacy.clientMessageId !== entry.clientMessageId) {
      const durableShape = {
        text: legacy.text,
        providerText: legacy.providerText,
        aliasAudit: legacy.aliasAudit,
        messageOrigin: legacy.messageOrigin,
        messagePreamble: legacy.messagePreamble,
        attachments: legacy.attachments,
        sharedActor: legacy.sharedActor,
        sharedMachineAuthority: legacy.sharedMachineAuthority,
        deliveryMode: legacy.deliveryMode,
        activeTurnDeliveryKind: legacy.activeTurnDeliveryKind,
        peerAudit: legacy.peerAudit,
        delegationReply: legacy.delegationReply,
        commandMode: legacy.commandMode,
        supervisionReference: legacy.supervisionReference,
        timelineCommitted: legacy.timelineCommitted,
        historyCommitted: legacy.historyCommitted,
        registeredSystemContract: legacy.registeredSystemContract,
      };
      const replayShape = {
        text: entry.text,
        providerText: entry.providerText,
        aliasAudit: entry.aliasAudit,
        messageOrigin: entry.messageOrigin,
        messagePreamble: entry.messagePreamble,
        attachments: entry.attachments,
        sharedActor: entry.sharedActor,
        sharedMachineAuthority: entry.sharedMachineAuthority,
        deliveryMode: entry.deliveryMode,
        activeTurnDeliveryKind: entry.activeTurnDeliveryKind,
        peerAudit: entry.peerAudit,
        delegationReply: entry.delegationReply,
        commandMode: entry.commandMode,
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
      ...(entry.messageOrigin ? { messageOrigin: entry.messageOrigin } : {}),
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
      ...(entry.commandMode ? { commandMode: true as const } : {}),
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
  const durableStatuses = new Map<string, string>();
  try {
    const snapshot = getTransportQueueStore().readSnapshot(sessionName);
    for (const entry of [...snapshot.pendingMessageEntries, ...snapshot.failedMessageEntries]) {
      durableStatuses.set(entry.clientMessageId, entry.status);
    }
  } catch {
    // The enqueue path remains the authority when diagnostics are unavailable.
  }
  const seenSnapshotIds = new Set<string>();
  const active = preserveEntries(
    sessionName, activeEntries, seenSnapshotIds, existingIds, legacyByCommandId, recipient, durableStatuses,
  );
  const pending = preserveEntries(
    sessionName, pendingEntries, seenSnapshotIds, existingIds, legacyByCommandId, recipient, durableStatuses,
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
