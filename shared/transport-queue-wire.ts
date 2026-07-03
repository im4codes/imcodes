import { containsProhibitedQueueProjectionField } from './transport-queue-privacy.js';
import {
  FAILED_QUEUE_ENTRY_STATUSES,
  LIVE_QUEUE_ENTRY_STATUSES,
  QUEUE_DROP_REASONS,
  QUEUE_RESET_REASONS,
  type QueueEvent,
} from './transport-queue-types.js';

const QUEUE_EVENT_TYPES = new Set([
  'transport.queue.snapshot',
  'transport.queue.delivery',
  'transport.queue.receipt',
  'transport.queue.failure',
  'transport.queue.reset',
]);

const LEGACY_LIVE_QUEUE_FIELDS = new Set([
  'pendingMessages',
  'transportPendingMessages',
  'pendingCount',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasLegacyLiveQueueField(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (LEGACY_LIVE_QUEUE_FIELDS.has(key)) return true;
  }
  return false;
}

export function containsLegacyLiveQueueEvidence(value: unknown): boolean {
  const visit = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    if (Array.isArray(item)) return item.some(visit);
    if (hasLegacyLiveQueueField(item)) return true;
    return Object.values(item).some(visit);
  };
  return visit(value);
}

export function isTransportQueueEventType(type: unknown): type is QueueEvent['type'] {
  return typeof type === 'string' && QUEUE_EVENT_TYPES.has(type);
}

function hasQueueBaseline(value: Record<string, unknown>): boolean {
  return typeof value.sessionName === 'string'
    && typeof value.queueEpoch === 'string'
    && typeof value.queueAuthorityId === 'string'
    && typeof value.pendingMessageVersion === 'number'
    && Number.isFinite(value.pendingMessageVersion);
}

function isProjectionEntry(value: unknown, statusSet: Set<string>): boolean {
  return isRecord(value)
    && typeof value.clientMessageId === 'string'
    && typeof value.text === 'string'
    && typeof value.status === 'string'
    && statusSet.has(value.status)
    && (value.placement === 'normal' || value.placement === 'front')
    && typeof value.ordinal === 'number'
    && Number.isFinite(value.ordinal)
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt);
}

export function isValidTransportQueueWireEvent(value: unknown): value is QueueEvent {
  if (!isRecord(value) || !isTransportQueueEventType(value.type)) return false;
  if (containsLegacyLiveQueueEvidence(value) || containsProhibitedQueueProjectionField(value)) return false;
  switch (value.type) {
    case 'transport.queue.snapshot':
      return hasQueueBaseline(value)
        && Array.isArray(value.pendingMessageEntries)
        && value.pendingMessageEntries.every((entry) => isProjectionEntry(entry, LIVE_QUEUE_ENTRY_STATUSES))
        && Array.isArray(value.failedMessageEntries)
        && value.failedMessageEntries.every((entry) => isProjectionEntry(entry, FAILED_QUEUE_ENTRY_STATUSES))
        && (value.resetReason === undefined || (typeof value.resetReason === 'string' && QUEUE_RESET_REASONS.has(value.resetReason as never)))
        && (value.dropReason === undefined || (typeof value.dropReason === 'string' && QUEUE_DROP_REASONS.has(value.dropReason as never)));
    case 'transport.queue.delivery':
      return hasQueueBaseline(value)
        && typeof value.clientMessageId === 'string'
        && typeof value.deliveryFrameId === 'string'
        && typeof value.deliveryFrameVersion === 'number'
        && Number.isFinite(value.deliveryFrameVersion);
    case 'transport.queue.receipt':
      return typeof value.sessionName === 'string'
        && typeof value.commandId === 'string'
        && (value.status === 'accepted' || value.status === 'error');
    case 'transport.queue.failure':
      return hasQueueBaseline(value)
        && typeof value.clientMessageId === 'string'
        && (value.dropReason === undefined || (typeof value.dropReason === 'string' && QUEUE_DROP_REASONS.has(value.dropReason as never)));
    case 'transport.queue.reset':
      return hasQueueBaseline(value)
        && typeof value.resetReason === 'string'
        && QUEUE_RESET_REASONS.has(value.resetReason as never);
    default:
      return false;
  }
}
