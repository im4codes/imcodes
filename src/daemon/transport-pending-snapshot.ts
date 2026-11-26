import type { PendingTransportMessage } from '../agent/transport-session-runtime.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
import { buildLegacyTransportPendingQueueSnapshot } from './transport-queue-projection.js';

export interface TransportPendingMessageEntry {
  clientMessageId: string;
  text: string;
  sharedActor?: SharedActorEnvelope;
}

export interface TransportPendingQueueSnapshot {
  pendingMessages: string[];
  pendingEntries: TransportPendingMessageEntry[];
  pendingVersion?: number;
  queueEpoch?: string;
  queueAuthorityId?: string;
  failedEntries?: TransportPendingMessageEntry[];
  source: 'sqlite' | 'empty';
}

export interface TransportPendingRuntimeSnapshot {
  pendingMessages?: string[];
  pendingEntries?: PendingTransportMessage[];
  pendingVersion?: number;
}

export function buildTransportPendingQueueSnapshot(
  sessionName: string,
  runtime: TransportPendingRuntimeSnapshot | null | undefined,
): TransportPendingQueueSnapshot {
  void runtime;
  const snapshot = buildLegacyTransportPendingQueueSnapshot(sessionName, 'transport_pending_snapshot');
  return {
    pendingMessages: snapshot.pendingMessages,
    pendingEntries: snapshot.pendingEntries,
    failedEntries: snapshot.failedEntries,
    pendingVersion: snapshot.pendingVersion,
    queueEpoch: snapshot.queueEpoch,
    queueAuthorityId: snapshot.queueAuthorityId,
    source: snapshot.source,
  };
}
