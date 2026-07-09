import type {
  QueueAttachmentProjection,
  QueueProjectionEntry,
  QueueSharedActorProjection,
  QueueStoredEntry,
} from './transport-queue-types.js';

const MAX_SAFE_STRING = 512;

function safeString(value: unknown, maxLength = MAX_SAFE_STRING): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function buildQueueSharedActorProjection(value: unknown): QueueSharedActorProjection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const projection: QueueSharedActorProjection = {
    ...(safeString(record.actorId ?? record.id, 128) ? { actorId: safeString(record.actorId ?? record.id, 128) } : {}),
    ...(safeString(record.displayName ?? record.name, 128) ? { displayName: safeString(record.displayName ?? record.name, 128) } : {}),
    ...(safeString(record.role, 64) ? { role: safeString(record.role, 64) } : {}),
    ...(safeString(record.type, 64) ? { type: safeString(record.type, 64) } : {}),
    ...(safeString(record.avatarUrl, 512) ? { avatarUrl: safeString(record.avatarUrl, 512) } : {}),
    ...(safeString(record.color, 64) ? { color: safeString(record.color, 64) } : {}),
  };
  return Object.keys(projection).length > 0 ? projection : undefined;
}

export function buildQueueAttachmentProjection(value: unknown): QueueAttachmentProjection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const attachmentId = safeString(record.attachmentId ?? record.id, 256);
  if (!attachmentId) return undefined;
  return {
    attachmentId,
    ...(safeString(record.filename ?? record.name, 256) ? { filename: safeString(record.filename ?? record.name, 256) } : {}),
    ...(safeString(record.mimeType ?? record.type, 128) ? { mimeType: safeString(record.mimeType ?? record.type, 128) } : {}),
    ...(safeNumber(record.size) !== undefined ? { size: safeNumber(record.size) } : {}),
  };
}

export function buildQueueProjectionEntry(entry: QueueStoredEntry): QueueProjectionEntry {
  return {
    clientMessageId: entry.clientMessageId,
    text: entry.text,
    status: entry.status,
    placement: entry.placement,
    ordinal: entry.ordinal,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.commandId ? { commandId: entry.commandId } : {}),
    ...(entry.activityGeneration !== undefined ? { activityGeneration: entry.activityGeneration } : {}),
    ...(entry.replacesClientMessageId ? { replacesClientMessageId: entry.replacesClientMessageId } : {}),
    ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
    ...(entry.attachments?.length ? { attachments: entry.attachments.map(buildQueueAttachmentProjection).filter((item): item is QueueAttachmentProjection => !!item) } : {}),
    ...(entry.sharedActor ? { sharedActor: buildQueueSharedActorProjection(entry.sharedActor) } : {}),
  };
}

export function containsProhibitedQueueProjectionField(value: unknown): boolean {
  const prohibited = new Set([
    'messagePreamble',
    'providerText',
    'daemonPath',
    'rawProviderPayload',
    'providerPayload',
    'toolInput',
    'toolOutput',
    'env',
    'secret',
    'secrets',
    'rawSessionHistory',
    'rawSharedActorEnvelope',
    'sharedActorEnvelope',
    'fullChildTranscript',
    'timelineCommitted',
    'historyCommitted',
    'privateMaterialRef',
    'providerRouting',
  ]);
  const visit = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    if (Array.isArray(item)) return item.some(visit);
    for (const [key, child] of Object.entries(item)) {
      if (prohibited.has(key)) return true;
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(value);
}
