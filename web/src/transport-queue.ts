import type { SharedActorEnvelope } from '@shared/tab-sharing.js';

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

function normalizeTransportPendingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function isLegacyTransportPendingMessageId(clientMessageId: string, scopeKey: string): boolean {
  return typeof clientMessageId === 'string'
    && clientMessageId.startsWith(`${scopeKey}:legacy:`);
}

export function synthesizeTransportPendingMessageEntries(
  messages: string[] | null | undefined,
  scopeKey: string,
): TransportPendingMessageEntry[] {
  const normalizedMessages = Array.isArray(messages)
    ? messages.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  return normalizedMessages.map((text, index) => ({
    clientMessageId: `${scopeKey}:legacy:${index}:${text}`,
    text,
  }));
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
  return Object.prototype.hasOwnProperty.call(payload, 'pendingMessages')
    || Object.prototype.hasOwnProperty.call(payload, 'pendingMessageEntries')
    || Object.prototype.hasOwnProperty.call(payload, 'transportPendingMessages')
    || Object.prototype.hasOwnProperty.call(payload, 'transportPendingMessageEntries');
}

export function extractTransportPendingMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

export function extractTransportPendingMessageEntries(value: unknown): TransportPendingMessageEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const clientMessageId = typeof (entry as { clientMessageId?: unknown }).clientMessageId === 'string'
      ? (entry as { clientMessageId: string }).clientMessageId.trim()
      : '';
    const text = typeof (entry as { text?: unknown }).text === 'string'
      ? (entry as { text: string }).text.trim()
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

  if (!hasMessagesField) return [];
  return synthesizeTransportPendingMessageEntries(extractTransportPendingMessages(messages), scopeKey);
}

export function removeTransportPendingEntryForUserMessage(
  existingEntries: unknown,
  existingMessages: unknown,
  payload: { clientMessageId?: unknown; commandId?: unknown; text?: unknown },
  scopeKey: string,
): TransportPendingQueueSnapshot {
  const messages = extractTransportPendingMessages(existingMessages);
  const entries = normalizeTransportPendingEntries(existingEntries, messages, scopeKey, {
    // This is stored state, not an incoming authoritative snapshot. Older
    // clients may have messages without structured entries; keep legacy
    // fallback alive when the stored entry list is empty but messages exist.
    hasEntriesField: Array.isArray(existingEntries) && existingEntries.length > 0,
    hasMessagesField: Array.isArray(existingMessages),
  });
  const candidateIds = [
    payload.clientMessageId,
    payload.commandId,
  ].flatMap((value) => (typeof value === 'string' && value.trim() ? [value.trim()] : []));
  const candidateIdSet = new Set(candidateIds);
  const normalizedText = typeof payload.text === 'string'
    ? normalizeTransportPendingText(payload.text)
    : '';
  const matchIndex = candidateIdSet.size > 0
    ? entries.findIndex((entry) => candidateIdSet.has(entry.clientMessageId))
    : (() => {
        if (!normalizedText) return -1;
        const matches = entries
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => normalizeTransportPendingText(entry.text) === normalizedText);
        return matches.length === 1 ? matches[0].index : -1;
      })();
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
  // Tri-state semantics (matches idle merge):
  //   field absent   → preserve existing (state-only event, not queue-authoritative)
  //   field present  → replace with provided value (including explicit empty = clear)
  // When drain fires, daemon emits running WITH explicit empty pending so the queue
  // clears simultaneously with user.message entering the timeline.
  if (!hasPendingMessagesField) return existingMessages;
  return extractTransportPendingMessages(pendingFromEvent);
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
  if (!hasPendingMessagesField && !hasPendingEntriesField) return existingEntries;
  return normalizeTransportPendingEntries(
    pendingFromEvent,
    pendingMessagesFromEvent,
    scopeKey,
    {
      hasEntriesField: hasPendingEntriesField,
      hasMessagesField: hasPendingMessagesField,
    },
  );
}

export function mergeTransportPendingMessagesForIdleState(
  existing: string[] | null | undefined,
  pendingFromEvent: unknown,
  hasPendingMessagesField: boolean,
): string[] {
  const existingMessages = Array.isArray(existing) ? existing.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
  if (!hasPendingMessagesField) return existingMessages;
  return extractTransportPendingMessages(pendingFromEvent);
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
  if (!hasPendingMessagesField && !hasPendingEntriesField) return existingEntries;
  return normalizeTransportPendingEntries(
    pendingFromEvent,
    pendingMessagesFromEvent,
    scopeKey,
    {
      hasEntriesField: hasPendingEntriesField,
      hasMessagesField: hasPendingMessagesField,
    },
  );
}


export interface TransportPendingQueueSyncState {
  transportPendingMessages?: string[] | null;
  transportPendingMessageEntries?: TransportPendingMessageEntry[] | null;
  transportPendingMessageVersion?: number | null;
}

export function hasTransportPendingSyncSnapshot(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'transportPendingMessages')
    || Object.prototype.hasOwnProperty.call(value, 'transportPendingMessageEntries');
}

export function buildTransportPendingSyncPatch(
  existing: TransportPendingQueueSyncState,
  value: Record<string, unknown>,
  scopeKey: string,
): Partial<TransportPendingQueueSyncState> {
  if (!hasTransportPendingSyncSnapshot(value)) return {};
  const incomingVersion = extractTransportPendingVersion(value.transportPendingMessageVersion);
  const hasPendingMessagesField = Object.prototype.hasOwnProperty.call(value, 'transportPendingMessages');
  const hasPendingEntriesField = Object.prototype.hasOwnProperty.call(value, 'transportPendingMessageEntries');
  const parsedMessages = extractTransportPendingMessages(value.transportPendingMessages);
  const pendingEntries = normalizeTransportPendingEntries(
    value.transportPendingMessageEntries,
    parsedMessages,
    scopeKey,
    {
      hasEntriesField: hasPendingEntriesField,
      hasMessagesField: hasPendingMessagesField,
    },
  );
  const pendingMessages = hasPendingEntriesField
    ? pendingEntries.map((entry) => entry.text)
    : parsedMessages;
  if (!shouldApplyTransportQueueSnapshotForPayload(existing.transportPendingMessageVersion ?? undefined, incomingVersion, {
    hasExplicitSnapshot: hasPendingMessagesField || hasPendingEntriesField,
    isExplicitEmpty: (hasPendingMessagesField || hasPendingEntriesField) && pendingMessages.length === 0 && pendingEntries.length === 0,
  })) {
    return {};
  }
  return {
    transportPendingMessages: pendingMessages,
    transportPendingMessageEntries: pendingEntries,
    transportPendingMessageVersion: nextTransportQueueVersion(
      existing.transportPendingMessageVersion ?? undefined,
      incomingVersion,
    ),
  };
}
