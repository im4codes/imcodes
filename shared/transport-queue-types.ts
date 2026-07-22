export type QueueEntryStatus =
  | 'queued'
  | 'handoff_inflight'
  | 'dispatching'
  | 'failed'
  | 'expired'
  | 'capacity_evicted'
  | 'cancelled'
  | 'sent'
  | 'deleted'
  | 'dismissed'
  | 'session_removed';

export type QueuePlacement = 'normal' | 'front';

export type QueueDropReason =
  | 'expired'
  | 'capacity_evicted'
  | 'user_cleared'
  | 'user_stopped'
  | 'session_removed'
  | 'private_material_missing';

export type QueueResetReason =
  | 'sqlite_restore'
  | 'runtime_recreated'
  | 'user_clear'
  | 'authority_corrupt_reinitialized';

export type QueueFailureReason =
  | 'dispatch_failed'
  | 'expired'
  | 'capacity_evicted'
  | 'cancelled'
  | 'private_material_missing'
  | 'sqlite_degraded';

export interface QueueSharedActorProjection {
  actorId?: string;
  displayName?: string;
  role?: string;
  type?: string;
  avatarUrl?: string;
  color?: string;
}

export interface QueueAttachmentProjection {
  attachmentId: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface QueuePrivateDispatchMaterial {
  clientMessageId: string;
  text: string;
  messagePreamble?: string;
  attachmentRefs?: unknown[];
  sharedActorEnvelope?: unknown;
  providerRouting?: Record<string, unknown>;
  timelineCommitted?: boolean;
  historyCommitted?: boolean;
  /** Private peer-audit ownership marker. Never expose through queue projections. */
  peerAudit?: {
    contractVersion: string;
    attemptHash: string;
  };
}

export interface QueueDispatchMaterial {
  clientMessageId: string;
  text: string;
  messagePreamble?: string;
  attachments?: unknown[];
  sharedActor?: unknown;
}

export interface QueueStoredEntry {
  sessionName: string;
  queueEpoch: string;
  queueAuthorityId: string;
  clientMessageId: string;
  commandId?: string;
  text: string;
  status: QueueEntryStatus;
  placement: QueuePlacement;
  ordinal: number;
  createdAt: number;
  updatedAt: number;
  pendingMessageVersion: number;
  activityGeneration?: number | string;
  replacesClientMessageId?: string;
  failureReason?: QueueFailureReason;
  dropReason?: QueueDropReason;
  resetReason?: QueueResetReason;
  attachments?: QueueAttachmentProjection[];
  sharedActor?: QueueSharedActorProjection;
  handoffId?: string;
  handoffStartedAt?: number;
  handoffExpiresAt?: number;
  handoffAttempt?: number;
  privateMaterialRef?: string;
}

export interface QueueProjectionEntry {
  clientMessageId: string;
  text: string;
  status: QueueEntryStatus;
  placement: QueuePlacement;
  ordinal: number;
  createdAt: number;
  updatedAt: number;
  commandId?: string;
  activityGeneration?: number | string;
  replacesClientMessageId?: string;
  failureReason?: QueueFailureReason;
  attachments?: QueueAttachmentProjection[];
  sharedActor?: QueueSharedActorProjection;
}

export interface QueueSnapshot {
  type: 'transport.queue.snapshot';
  sessionName: string;
  queueEpoch: string;
  queueAuthorityId: string;
  pendingMessageVersion: number;
  pendingMessageEntries: QueueProjectionEntry[];
  failedMessageEntries: QueueProjectionEntry[];
  source: string;
  resetReason?: QueueResetReason;
  dropReason?: QueueDropReason;
  activityGeneration?: number | string;
  degraded?: boolean;
  degradedReason?: string;
}

export interface QueueDeliveryFact {
  type: 'transport.queue.delivery';
  sessionName: string;
  clientMessageId: string;
  queueEpoch: string;
  queueAuthorityId: string;
  pendingMessageVersion: number;
  deliveryFrameId: string;
  deliveryFrameVersion: number;
  activityGeneration?: number | string;
  providerEventId?: string;
}

export interface QueueMutationReceipt {
  type: 'transport.queue.receipt';
  sessionName: string;
  commandId: string;
  status: 'accepted' | 'error';
  reason?: string;
}

export interface QueueFailureDropEvent {
  type: 'transport.queue.failure';
  sessionName: string;
  queueEpoch: string;
  queueAuthorityId: string;
  pendingMessageVersion: number;
  clientMessageId: string;
  failureReason?: QueueFailureReason;
  dropReason?: QueueDropReason;
}

export interface QueueResetEvent {
  type: 'transport.queue.reset';
  sessionName: string;
  queueEpoch: string;
  queueAuthorityId: string;
  pendingMessageVersion: number;
  resetReason: QueueResetReason;
}

export type QueueEvent =
  | QueueSnapshot
  | QueueDeliveryFact
  | QueueMutationReceipt
  | QueueFailureDropEvent
  | QueueResetEvent;

/**
 * Canonical value-position constant for the delivery-fact event type. Typed
 * against the interface discriminator so it can never drift from
 * `QueueDeliveryFact['type']`. Import this instead of hardcoding the string
 * in daemon/server/web (zero-tolerance shared-constant rule).
 */
export const TRANSPORT_QUEUE_DELIVERY_EVENT_TYPE: QueueDeliveryFact['type'] = 'transport.queue.delivery';

export const LIVE_QUEUE_ENTRY_STATUSES = new Set<QueueEntryStatus>([
  'queued',
  'handoff_inflight',
  'dispatching',
]);

export const FAILED_QUEUE_ENTRY_STATUSES = new Set<QueueEntryStatus>([
  'failed',
  'expired',
  'capacity_evicted',
  'cancelled',
]);

export const QUEUE_RESET_REASONS = new Set<QueueResetReason>([
  'sqlite_restore',
  'runtime_recreated',
  'user_clear',
  'authority_corrupt_reinitialized',
]);

export const QUEUE_DROP_REASONS = new Set<QueueDropReason>([
  'expired',
  'capacity_evicted',
  'user_cleared',
  'user_stopped',
  'session_removed',
  'private_material_missing',
]);
