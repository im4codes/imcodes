import type { SharedActorEnvelope } from '@shared/tab-sharing.js';
import {
  createTransportQueueReducerState,
  reduceTransportQueueEvent,
} from '../../shared/transport-queue-reducer.js';
import type { QueueProjectionEntry } from '../../shared/transport-queue-types.js';

export interface TransportPendingMessageEntry {
  clientMessageId: string;
  text: string;
  sharedActor?: SharedActorEnvelope;
}

export interface TransportPendingQueueSnapshot {
  messages: string[];
  entries: TransportPendingMessageEntry[];
  changed: boolean;
}

export function synthesizeTransportPendingMessageEntries(
  messages: string[] | null | undefined,
  scopeKey: string,
): TransportPendingMessageEntry[] {
  void messages;
  void scopeKey;
  return [];
}

/**
 * Extract a pending-queue version from a daemon event/snapshot payload.
 * Returns `undefined` when absent (legacy daemon, or a stale resend/relaunch
 * snapshot from older daemons). Once the UI has observed a versioned baseline,
 * unversioned snapshots are no longer allowed to overwrite it because they
 * cannot be ordered against already-drained messages.
 */
export function extractTransportPendingVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Decide whether an incoming pending-queue snapshot should be applied,
 * given the newest version already applied for that session.
 *
 * The daemon's TransportSessionRuntime stamps a monotonic version on every
 * queue mutation and carries it on every snapshot. A snapshot whose version
 * is strictly older than what we've already applied is stale (delivered out
 * of order on a weak network) and MUST be ignored, otherwise it resurrects
 * queue entries the daemon has already drained — the root cause of UI/daemon
 * queue desync.
 *
 * Rules:
 *   - `next === undefined`  → apply only before a versioned baseline exists
 *   - `prev === undefined`  → apply (no baseline yet)
 *   - otherwise             → apply only if `next >= prev`
 */
export function shouldApplyTransportQueueSnapshot(
  prev: number | undefined,
  next: number | undefined,
): boolean {
  if (next === undefined) return prev === undefined;
  if (prev === undefined) return true;
  return next >= prev;
}

export function shouldApplyTransportQueueSnapshotForPayload(
  prev: number | undefined,
  next: number | undefined,
  options: {
    hasExplicitSnapshot: boolean;
    isExplicitEmpty: boolean;
  },
): boolean {
  void options;
  return shouldApplyTransportQueueSnapshot(prev, next);
}

/**
 * Fold an applied snapshot's version into the stored baseline. Unversioned
 * snapshots leave the baseline untouched; versioned snapshots advance
 * monotonically. Version 0 is no longer a magic reset value — accepting an
 * arbitrary 0 after a higher baseline lets stale queued snapshots resurrect
 * drained queue cards.
 */
export function nextTransportQueueVersion(
  prev: number | undefined,
  next: number | undefined,
): number | undefined {
  if (next === undefined) return prev;
  if (prev === undefined) return next;
  return Math.max(prev, next);
}

export function hasExplicitTransportPendingSnapshot(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(payload, 'pendingMessageEntries')
    || Object.prototype.hasOwnProperty.call(payload, 'queueEpoch')
    || Object.prototype.hasOwnProperty.call(payload, 'queueAuthorityId');
}

export function extractTransportPendingMessages(value: unknown): string[] {
  void value;
  return [];
}

export function extractTransportPendingMessageEntries(value: unknown): TransportPendingMessageEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const clientMessageId = typeof (entry as { clientMessageId?: unknown }).clientMessageId === 'string'
      ? (entry as { clientMessageId: string }).clientMessageId.trim()
      : '';
    const text = typeof (entry as { text?: unknown }).text === 'string'
      ? (entry as { text: string }).text
      : '';
    if (!clientMessageId || !text) return [];
    const sharedActor = (entry as { sharedActor?: unknown }).sharedActor;
    return [{
      clientMessageId,
      text,
      ...(sharedActor && typeof sharedActor === 'object' ? { sharedActor: sharedActor as SharedActorEnvelope } : {}),
    }];
  });
}

export function normalizeTransportPendingEntries(
  entries: unknown,
  messages: unknown,
  scopeKey: string,
  options: {
    hasEntriesField?: boolean;
    hasMessagesField?: boolean;
  } = {},
): TransportPendingMessageEntry[] {
  const hasEntriesField = options.hasEntriesField ?? Array.isArray(entries);
  const hasMessagesField = options.hasMessagesField ?? Array.isArray(messages);
  const normalizedEntries = extractTransportPendingMessageEntries(entries);

  // New transport snapshots treat the structured entries field as authoritative.
  // If entries is present, including an explicit empty array, never synthesize a
  // legacy tail from messages: those messages may be stale display data from an
  // earlier snapshot and would resurrect already-drained queue cards.
  if (hasEntriesField) return normalizedEntries;

  void hasMessagesField;
  void messages;
  void scopeKey;
  return [];
}

export function removeTransportPendingEntryForUserMessage(
  existingEntries: unknown,
  existingMessages: unknown,
  payload: { clientMessageId?: unknown; commandId?: unknown; text?: unknown },
  scopeKey: string,
): TransportPendingQueueSnapshot {
  void scopeKey;
  const messages = normalizeTransportPendingEntries(existingEntries, existingMessages, scopeKey, {
    hasEntriesField: Array.isArray(existingEntries),
    hasMessagesField: Array.isArray(existingMessages),
  }).map((entry) => entry.text);
  const entries = normalizeTransportPendingEntries(existingEntries, messages, scopeKey, {
    hasEntriesField: Array.isArray(existingEntries),
    hasMessagesField: Array.isArray(existingMessages),
  });
  const candidateIds = [
    payload.clientMessageId,
  ].flatMap((value) => (typeof value === 'string' && value.trim() ? [value.trim()] : []));
  const candidateIdSet = new Set(candidateIds);
  const idMatchIndex = candidateIdSet.size > 0
    ? entries.findIndex((entry) => candidateIdSet.has(entry.clientMessageId))
    : -1;
  const matchIndex = idMatchIndex;
  if (matchIndex < 0) return { messages, entries, changed: false };
  const nextEntries = entries.filter((_, index) => index !== matchIndex);
  return {
    messages: nextEntries.map((entry) => entry.text),
    entries: nextEntries,
    changed: true,
  };
}

export function mergeTransportPendingMessagesForRunningState(
  existing: string[] | null | undefined,
  pendingFromEvent: unknown,
  hasPendingMessagesField: boolean,
): string[] {
  const existingMessages = Array.isArray(existing) ? existing.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
  void pendingFromEvent;
  void hasPendingMessagesField;
  return existingMessages;
}

export function mergeTransportPendingEntriesForRunningState(
  existing: TransportPendingMessageEntry[] | null | undefined,
  pendingFromEvent: unknown,
  pendingMessagesFromEvent: unknown,
  hasPendingMessagesField: boolean,
  scopeKey: string,
  hasPendingEntriesField = hasPendingMessagesField && Array.isArray(pendingFromEvent),
): TransportPendingMessageEntry[] {
  const existingEntries = Array.isArray(existing)
    ? existing.filter((entry) => typeof entry?.clientMessageId === 'string' && entry.clientMessageId && typeof entry?.text === 'string' && entry.text)
    : [];
  void pendingFromEvent;
  void pendingMessagesFromEvent;
  void hasPendingMessagesField;
  void scopeKey;
  void hasPendingEntriesField;
  return existingEntries;
}

export function mergeTransportPendingMessagesForIdleState(
  existing: string[] | null | undefined,
  pendingFromEvent: unknown,
  hasPendingMessagesField: boolean,
): string[] {
  const existingMessages = Array.isArray(existing) ? existing.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
  void pendingFromEvent;
  void hasPendingMessagesField;
  return existingMessages;
}

export function mergeTransportPendingEntriesForIdleState(
  existing: TransportPendingMessageEntry[] | null | undefined,
  pendingFromEvent: unknown,
  pendingMessagesFromEvent: unknown,
  hasPendingMessagesField: boolean,
  scopeKey: string,
  hasPendingEntriesField = hasPendingMessagesField && Array.isArray(pendingFromEvent),
): TransportPendingMessageEntry[] {
  const existingEntries = Array.isArray(existing)
    ? existing.filter((entry) => typeof entry?.clientMessageId === 'string' && entry.clientMessageId && typeof entry?.text === 'string' && entry.text)
    : [];
  void pendingFromEvent;
  void pendingMessagesFromEvent;
  void hasPendingMessagesField;
  void scopeKey;
  void hasPendingEntriesField;
  return existingEntries;
}


export interface TransportPendingQueueSyncState {
  transportPendingMessages?: string[] | null;
  transportPendingMessageEntries?: TransportPendingMessageEntry[] | null;
  pendingMessageEntries?: TransportPendingMessageEntry[] | null;
  transportPendingMessageVersion?: number | null;
  queueEpoch?: string | null;
  queueAuthorityId?: string | null;
  failedMessageEntries?: TransportPendingMessageEntry[] | null;
}

export interface TransportPendingQueueSyncPatch {
  transportPendingMessages?: string[];
  transportPendingMessageEntries?: TransportPendingMessageEntry[];
  transportPendingMessageVersion?: number;
  queueEpoch?: string;
  queueAuthorityId?: string;
  failedMessageEntries?: TransportPendingMessageEntry[];
}

export function hasTransportPendingSyncSnapshot(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'pendingMessageEntries')
    || Object.prototype.hasOwnProperty.call(value, 'queueEpoch')
    || Object.prototype.hasOwnProperty.call(value, 'queueAuthorityId')
    || Object.prototype.hasOwnProperty.call(value, 'failedMessageEntries');
}

function toQueueProjectionEntries(value: unknown, status: QueueProjectionEntry['status']): QueueProjectionEntry[] {
  return extractTransportPendingMessageEntries(value).map((entry, ordinal) => ({
    clientMessageId: entry.clientMessageId,
    text: entry.text,
    status,
    placement: 'normal',
    ordinal,
    createdAt: 0,
    updatedAt: 0,
  }));
}

export function buildTransportPendingSyncPatch(
  existing: TransportPendingQueueSyncState,
  value: Record<string, unknown>,
  scopeKey: string,
): TransportPendingQueueSyncPatch {
  void scopeKey;
  if (!hasTransportPendingSyncSnapshot(value)) return {};
  const incomingVersion = extractTransportPendingVersion(value.pendingMessageVersion);
  const hasNewPendingEntriesField = Object.prototype.hasOwnProperty.call(value, 'pendingMessageEntries');
  const pendingEntriesValue = hasNewPendingEntriesField ? value.pendingMessageEntries : undefined;
  const queueEpoch = typeof value.queueEpoch === 'string' ? value.queueEpoch : undefined;
  const queueAuthorityId = typeof value.queueAuthorityId === 'string' ? value.queueAuthorityId : undefined;
  if (!queueEpoch || !queueAuthorityId || incomingVersion === undefined) return {};
  const baseline = createTransportQueueReducerState();
  baseline.queueEpoch = existing.queueEpoch ?? undefined;
  baseline.queueAuthorityId = existing.queueAuthorityId ?? undefined;
  baseline.pendingMessageVersion = existing.transportPendingMessageVersion ?? undefined;
  baseline.pendingMessageEntries = toQueueProjectionEntries(existing.transportPendingMessageEntries, 'queued');
  baseline.failedMessageEntries = toQueueProjectionEntries(existing.failedMessageEntries, 'failed');
  const next = reduceTransportQueueEvent(baseline, {
    type: 'transport.queue.snapshot',
    sessionName: '',
    queueEpoch,
    queueAuthorityId,
    pendingMessageVersion: incomingVersion,
    pendingMessageEntries: toQueueProjectionEntries(pendingEntriesValue, 'queued'),
    failedMessageEntries: toQueueProjectionEntries(value.failedMessageEntries, 'failed'),
    source: 'web-sync',
    ...(typeof value.resetReason === 'string' ? { resetReason: value.resetReason as never } : {}),
  });
  if (next === baseline || next.degradedEvidence.length > baseline.degradedEvidence.length) return {};
  return {
    queueEpoch,
    queueAuthorityId,
    transportPendingMessageVersion: next.pendingMessageVersion,
    transportPendingMessages: next.pendingMessageEntries.map((entry) => entry.text),
    transportPendingMessageEntries: next.pendingMessageEntries.map((entry) => ({
      clientMessageId: entry.clientMessageId,
      text: entry.text,
    })),
    failedMessageEntries: next.failedMessageEntries.map((entry) => ({
      clientMessageId: entry.clientMessageId,
      text: entry.text,
    })),
  };
}
