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
  /** Exact diagnostic alias; authority still requires epoch + authority id + version. */
  pendingCount: number;
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
    pendingCount: snapshot.pendingMessageEntries.length,
    pendingMessageEntries: snapshot.pendingMessageEntries,
    failedMessageEntries: snapshot.failedMessageEntries,
    ...(snapshot.resetReason ? { resetReason: snapshot.resetReason } : {}),
    ...(snapshot.dropReason ? { dropReason: snapshot.dropReason } : {}),
    ...(snapshot.activityGeneration !== undefined ? { activityGeneration: snapshot.activityGeneration } : {}),
    ...(snapshot.degraded !== undefined ? { degraded: snapshot.degraded } : {}),
    ...(snapshot.degradedReason ? { degradedReason: snapshot.degradedReason } : {}),
  };
}

/** Projection without legacy scalar counters: same queue identity and entries, minus the legacy
 *  scalar `pendingCount`. Clients derive the count from `pendingMessageEntries`;
 *  emitting both let the two drift, and session.state is the copy that goes to
 *  every viewer, so it is the one kept minimal. */
export function transportQueueSnapshotWithoutLegacyCounters(
  snapshot: QueueSnapshot,
): Omit<TransportQueueSnapshotPayload, 'pendingCount'> {
  const { pendingCount: _pendingCount, ...rest } = transportQueueSnapshotToPayload(snapshot);
  return rest;
}

/** Variant of buildTransportQueueSnapshotPayload that omits the legacy
 *  scalar `pendingCount` so session.state stays the minimal projection. */
export function buildTransportQueueSnapshotPayloadWithoutLegacyCounters(
  sessionName: string,
  source: TransportQueueSnapshotSource,
): Omit<TransportQueueSnapshotPayload, 'pendingCount'> {
  return transportQueueSnapshotWithoutLegacyCounters(buildTransportQueueSnapshot(sessionName, source));
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
