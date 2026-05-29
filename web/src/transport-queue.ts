export interface TransportPendingMessageEntry {
  clientMessageId: string;
  text: string;
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
 * Returns `undefined` when absent (legacy daemon, or the resend/relaunch
 * paths that emit unversioned snapshots) — callers treat `undefined` as
 * "always apply", preserving pre-versioning behavior.
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
 *   - `next === undefined`  → apply (unversioned legacy/resend snapshot)
 *   - `prev === undefined`  → apply (no baseline yet)
 *   - `next === 0`          → apply (a fresh runtime restarts the sequence at
 *                             0; accept it and let callers reset the baseline)
 *   - otherwise             → apply only if `next >= prev`
 */
export function shouldApplyTransportQueueSnapshot(
  prev: number | undefined,
  next: number | undefined,
): boolean {
  if (next === undefined) return true;
  if (prev === undefined) return true;
  if (next === 0) return true;
  return next >= prev;
}

/**
 * Fold an applied snapshot's version into the stored baseline. A fresh
 * runtime (`next === 0`) resets the baseline; an unversioned snapshot
 * (`next === undefined`) leaves the baseline untouched; otherwise the
 * baseline advances monotonically.
 */
export function nextTransportQueueVersion(
  prev: number | undefined,
  next: number | undefined,
): number | undefined {
  if (next === undefined) return prev;
  if (next === 0) return 0;
  if (prev === undefined) return next;
  return Math.max(prev, next);
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
    return [{ clientMessageId, text }];
  });
}

export function normalizeTransportPendingEntries(
  entries: unknown,
  messages: unknown,
  scopeKey: string,
): TransportPendingMessageEntry[] {
  const normalizedMessages = extractTransportPendingMessages(messages);
  const normalizedEntries = extractTransportPendingMessageEntries(entries);
  if (normalizedMessages.length === 0) return normalizedEntries;
  if (normalizedEntries.length === 0) return synthesizeTransportPendingMessageEntries(normalizedMessages, scopeKey);
  return normalizedMessages.map((text, index) => {
    const matchingEntry = normalizedEntries[index];
    if (matchingEntry && matchingEntry.text === text) return matchingEntry;
    return {
      clientMessageId: `${scopeKey}:legacy:${index}:${text}`,
      text,
    };
  });
}

export function removeTransportPendingEntryForUserMessage(
  existingEntries: unknown,
  existingMessages: unknown,
  payload: { clientMessageId?: unknown; commandId?: unknown; text?: unknown },
  scopeKey: string,
): TransportPendingQueueSnapshot {
  const messages = extractTransportPendingMessages(existingMessages);
  const entries = normalizeTransportPendingEntries(existingEntries, messages, scopeKey);
  const candidateIds = [
    payload.clientMessageId,
    payload.commandId,
  ].flatMap((value) => (typeof value === 'string' && value.trim() ? [value.trim()] : []));
  const candidateIdSet = new Set(candidateIds);
  const normalizedText = typeof payload.text === 'string'
    ? normalizeTransportPendingText(payload.text)
    : '';
  const matchIndex = entries.findIndex((entry) => {
    if (candidateIdSet.has(entry.clientMessageId)) return true;
    return !!normalizedText && normalizeTransportPendingText(entry.text) === normalizedText;
  });
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
): TransportPendingMessageEntry[] {
  const existingEntries = Array.isArray(existing)
    ? existing.filter((entry) => typeof entry?.clientMessageId === 'string' && entry.clientMessageId && typeof entry?.text === 'string' && entry.text)
    : [];
  if (!hasPendingMessagesField) return existingEntries;
  return normalizeTransportPendingEntries(
    pendingFromEvent,
    pendingMessagesFromEvent,
    scopeKey,
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
): TransportPendingMessageEntry[] {
  const existingEntries = Array.isArray(existing)
    ? existing.filter((entry) => typeof entry?.clientMessageId === 'string' && entry.clientMessageId && typeof entry?.text === 'string' && entry.text)
    : [];
  if (!hasPendingMessagesField) return existingEntries;
  return normalizeTransportPendingEntries(
    pendingFromEvent,
    pendingMessagesFromEvent,
    scopeKey,
  );
}
