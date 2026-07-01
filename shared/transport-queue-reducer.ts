import {
  FAILED_QUEUE_ENTRY_STATUSES,
  LIVE_QUEUE_ENTRY_STATUSES,
  QUEUE_RESET_REASONS,
  type QueueDeliveryFact,
  type QueueEvent,
  type QueueMutationReceipt,
  type QueueProjectionEntry,
  type QueueResetEvent,
  type QueueSnapshot,
} from './transport-queue-types.js';

export interface TransportQueueReducerState {
  sessionName?: string;
  queueEpoch?: string;
  queueAuthorityId?: string;
  pendingMessageVersion?: number;
  pendingMessageEntries: QueueProjectionEntry[];
  failedMessageEntries: QueueProjectionEntry[];
  deliveredTombstones: Record<string, true>;
  receipts: Record<string, QueueMutationReceipt>;
  degradedEvidence: string[];
}

export function createTransportQueueReducerState(sessionName?: string): TransportQueueReducerState {
  return {
    ...(sessionName ? { sessionName } : {}),
    pendingMessageEntries: [],
    failedMessageEntries: [],
    deliveredTombstones: {},
    receipts: {},
    degradedEvidence: [],
  };
}

function sortEntries(entries: QueueProjectionEntry[]): QueueProjectionEntry[] {
  return [...entries].sort((a, b) => {
    if (a.placement !== b.placement) return a.placement === 'front' ? -1 : 1;
    return a.ordinal - b.ordinal || a.createdAt - b.createdAt || a.clientMessageId.localeCompare(b.clientMessageId);
  });
}

function tombstoneKey(epoch: string, clientMessageId: string): string {
  return `${epoch}:${clientMessageId}`;
}

function hasBaseline(state: TransportQueueReducerState): state is TransportQueueReducerState & {
  queueEpoch: string;
  queueAuthorityId: string;
  pendingMessageVersion: number;
} {
  return !!state.queueEpoch && !!state.queueAuthorityId && typeof state.pendingMessageVersion === 'number';
}

function withDegraded(state: TransportQueueReducerState, reason: string): TransportQueueReducerState {
  return {
    ...state,
    degradedEvidence: [...state.degradedEvidence, reason],
  };
}

function canApplySnapshot(state: TransportQueueReducerState, snapshot: QueueSnapshot | QueueResetEvent): true | string {
  if (!snapshot.queueEpoch || !snapshot.queueAuthorityId || !Number.isFinite(snapshot.pendingMessageVersion)) {
    return 'missing_epoch_authority_or_version';
  }
  if (!hasBaseline(state)) return true;
  if (snapshot.queueEpoch === state.queueEpoch && snapshot.queueAuthorityId !== state.queueAuthorityId) {
    return 'same_epoch_authority_mismatch';
  }
  if (snapshot.queueEpoch !== state.queueEpoch && snapshot.queueAuthorityId === state.queueAuthorityId) {
    return 'different_epoch_authority_reuse';
  }
  if (snapshot.queueEpoch !== state.queueEpoch) {
    const resetReason = 'resetReason' in snapshot ? snapshot.resetReason : undefined;
    return resetReason && QUEUE_RESET_REASONS.has(resetReason) ? true : 'cross_epoch_without_recognized_reset';
  }
  if (snapshot.pendingMessageVersion < state.pendingMessageVersion) {
    return 'stale_version';
  }
  return true;
}

function applySnapshot(state: TransportQueueReducerState, snapshot: QueueSnapshot): TransportQueueReducerState {
  const decision = canApplySnapshot(state, snapshot);
  if (decision !== true) return withDegraded(state, decision);

  const isNewEpoch = state.queueEpoch !== undefined && state.queueEpoch !== snapshot.queueEpoch;
  const deliveredTombstones = isNewEpoch ? {} : { ...state.deliveredTombstones };
  const liveEntries = sortEntries(snapshot.pendingMessageEntries
    .filter((entry) => LIVE_QUEUE_ENTRY_STATUSES.has(entry.status))
    .filter((entry) => !deliveredTombstones[tombstoneKey(snapshot.queueEpoch, entry.clientMessageId)]));
  const failedEntries = sortEntries(snapshot.failedMessageEntries
    .filter((entry) => FAILED_QUEUE_ENTRY_STATUSES.has(entry.status)));
  return {
    ...state,
    sessionName: snapshot.sessionName,
    queueEpoch: snapshot.queueEpoch,
    queueAuthorityId: snapshot.queueAuthorityId,
    pendingMessageVersion: snapshot.pendingMessageVersion,
    pendingMessageEntries: liveEntries,
    failedMessageEntries: failedEntries,
    deliveredTombstones,
  };
}

function applyDelivery(state: TransportQueueReducerState, delivery: QueueDeliveryFact): TransportQueueReducerState {
  if (!hasBaseline(state)) return withDegraded(state, 'delivery_without_baseline');
  if (delivery.queueEpoch !== state.queueEpoch || delivery.queueAuthorityId !== state.queueAuthorityId) {
    return withDegraded(state, 'delivery_epoch_or_authority_mismatch');
  }
  const deliveredTombstones = {
    ...state.deliveredTombstones,
    [tombstoneKey(delivery.queueEpoch, delivery.clientMessageId)]: true as const,
  };
  return {
    ...state,
    pendingMessageVersion: Math.max(state.pendingMessageVersion, delivery.pendingMessageVersion),
    pendingMessageEntries: state.pendingMessageEntries.filter((entry) => entry.clientMessageId !== delivery.clientMessageId),
    failedMessageEntries: state.failedMessageEntries.filter((entry) => entry.clientMessageId !== delivery.clientMessageId),
    deliveredTombstones,
  };
}

function applyReset(state: TransportQueueReducerState, reset: QueueResetEvent): TransportQueueReducerState {
  const decision = canApplySnapshot(state, reset);
  if (decision !== true) return withDegraded(state, decision);
  return {
    ...state,
    sessionName: reset.sessionName,
    queueEpoch: reset.queueEpoch,
    queueAuthorityId: reset.queueAuthorityId,
    pendingMessageVersion: reset.pendingMessageVersion,
    pendingMessageEntries: [],
    failedMessageEntries: [],
    deliveredTombstones: {},
  };
}

export function reduceTransportQueueEvent(
  state: TransportQueueReducerState,
  event: QueueEvent,
): TransportQueueReducerState {
  switch (event.type) {
    case 'transport.queue.snapshot':
      return applySnapshot(state, event);
    case 'transport.queue.delivery':
      return applyDelivery(state, event);
    case 'transport.queue.reset':
      return applyReset(state, event);
    case 'transport.queue.receipt':
      return {
        ...state,
        receipts: {
          ...state.receipts,
          [event.commandId]: event,
        },
      };
    case 'transport.queue.failure':
      if (!hasBaseline(state) || event.queueEpoch !== state.queueEpoch || event.queueAuthorityId !== state.queueAuthorityId) {
        return withDegraded(state, 'failure_epoch_or_authority_mismatch');
      }
      return {
        ...state,
        pendingMessageVersion: Math.max(state.pendingMessageVersion, event.pendingMessageVersion),
        pendingMessageEntries: state.pendingMessageEntries.filter((entry) => entry.clientMessageId !== event.clientMessageId),
      };
    default:
      return state;
  }
}

export function selectLiveQueueEntries(state: TransportQueueReducerState): QueueProjectionEntry[] {
  return state.pendingMessageEntries;
}

export function selectFailedQueueEntries(state: TransportQueueReducerState): QueueProjectionEntry[] {
  return state.failedMessageEntries;
}

export function selectLiveQueueCount(state: TransportQueueReducerState): number {
  return state.pendingMessageEntries.length;
}

export function selectSessionHasLiveQueue(state: TransportQueueReducerState): boolean {
  return selectLiveQueueCount(state) > 0;
}

export function selectReceipt(state: TransportQueueReducerState, commandId: string): QueueMutationReceipt | undefined {
  return state.receipts[commandId];
}
