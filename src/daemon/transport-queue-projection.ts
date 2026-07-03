import type { PendingTransportMessage } from '../agent/transport-session-runtime.js';
import { containsProhibitedQueueProjectionField } from '../../shared/transport-queue-privacy.js';
import type { QueueSnapshot } from '../../shared/transport-queue-types.js';
import { getTransportQueueStore } from './transport-queue-store.js';

export type TransportQueueSnapshotSource =
  | 'command_handler'
  | 'session_manager'
  | 'transport_pending_snapshot'
  | 'session_list'
  | 'subsession_sync'
  | 'lifecycle'
  | 'send_tool'
  | 'p2p_orchestrator'
  | 'openspec_auto_deliver'
  | 'timeline_emitter'
  | 'server_bridge'
  | 'test'
  | string;

export interface LegacyTransportPendingMessageEntry {
  clientMessageId: string;
  text: string;
}

export interface LegacyTransportPendingQueueSnapshot {
  pendingMessages: string[];
  pendingEntries: LegacyTransportPendingMessageEntry[];
  failedEntries: LegacyTransportPendingMessageEntry[];
  pendingVersion: number;
  queueEpoch: string;
  queueAuthorityId: string;
  queueSnapshot: QueueSnapshot;
  source: 'sqlite';
}

export interface TransportPendingRuntimeSnapshot {
  pendingMessages?: string[];
  pendingEntries?: PendingTransportMessage[];
  pendingVersion?: number;
}

export type TransportQueueSnapshotPayload = {
  queueSnapshot: QueueSnapshot;
  queueEpoch: QueueSnapshot['queueEpoch'];
  queueAuthorityId: QueueSnapshot['queueAuthorityId'];
  pendingMessageVersion: QueueSnapshot['pendingMessageVersion'];
  pendingMessageEntries: QueueSnapshot['pendingMessageEntries'];
  failedMessageEntries: QueueSnapshot['failedMessageEntries'];
  resetReason?: QueueSnapshot['resetReason'];
  dropReason?: QueueSnapshot['dropReason'];
  activityGeneration?: QueueSnapshot['activityGeneration'];
  degraded?: QueueSnapshot['degraded'];
  degradedReason?: QueueSnapshot['degradedReason'];
};

export function buildTransportQueueSnapshot(
  sessionName: string,
  source: TransportQueueSnapshotSource,
): QueueSnapshot {
  const snapshot = getTransportQueueStore().readSnapshotSafely(sessionName, source);
  if (containsProhibitedQueueProjectionField(snapshot)) {
    return {
      type: 'transport.queue.snapshot',
      sessionName: snapshot.sessionName,
      queueEpoch: snapshot.queueEpoch,
      queueAuthorityId: snapshot.queueAuthorityId,
      pendingMessageVersion: snapshot.pendingMessageVersion,
      pendingMessageEntries: [],
      failedMessageEntries: [],
      source,
      degraded: true,
      degradedReason: 'queue_projection_privacy_violation',
    };
  }
  return snapshot;
}

export function transportQueueSnapshotToPayload(snapshot: QueueSnapshot): TransportQueueSnapshotPayload {
  return {
    queueSnapshot: snapshot,
    queueEpoch: snapshot.queueEpoch,
    queueAuthorityId: snapshot.queueAuthorityId,
    pendingMessageVersion: snapshot.pendingMessageVersion,
    pendingMessageEntries: snapshot.pendingMessageEntries,
    failedMessageEntries: snapshot.failedMessageEntries,
    ...(snapshot.resetReason ? { resetReason: snapshot.resetReason } : {}),
    ...(snapshot.dropReason ? { dropReason: snapshot.dropReason } : {}),
    ...(snapshot.activityGeneration !== undefined ? { activityGeneration: snapshot.activityGeneration } : {}),
    ...(snapshot.degraded !== undefined ? { degraded: snapshot.degraded } : {}),
    ...(snapshot.degradedReason ? { degradedReason: snapshot.degradedReason } : {}),
  };
}

export function buildTransportQueueSnapshotPayload(
  sessionName: string,
  source: TransportQueueSnapshotSource,
): TransportQueueSnapshotPayload {
  return transportQueueSnapshotToPayload(buildTransportQueueSnapshot(sessionName, source));
}

export function buildLegacyTransportPendingQueueSnapshot(
  sessionName: string,
  source: TransportQueueSnapshotSource,
): LegacyTransportPendingQueueSnapshot {
  const snapshot = buildTransportQueueSnapshot(sessionName, source);
  return {
    pendingMessages: snapshot.pendingMessageEntries.map((entry) => entry.text),
    pendingEntries: snapshot.pendingMessageEntries.map((entry) => ({
      clientMessageId: entry.clientMessageId,
      text: entry.text,
    })),
    failedEntries: snapshot.failedMessageEntries.map((entry) => ({
      clientMessageId: entry.clientMessageId,
      text: entry.text,
    })),
    pendingVersion: snapshot.pendingMessageVersion,
    queueEpoch: snapshot.queueEpoch,
    queueAuthorityId: snapshot.queueAuthorityId,
    queueSnapshot: snapshot,
    source: 'sqlite',
  };
}
