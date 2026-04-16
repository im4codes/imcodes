export interface TransportPendingMessageEntry {
  clientMessageId: string;
  text: string;
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

export function mergeTransportPendingMessagesForRunningState(
  existing: string[] | null | undefined,
  pendingFromEvent: unknown,
  hasPendingMessagesField: boolean,
): string[] {
  const existingMessages = Array.isArray(existing) ? existing.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
  if (!hasPendingMessagesField) return existingMessages;
  const fromEvent = extractTransportPendingMessages(pendingFromEvent);
  // When the event says pending=[] but the session had queued messages, keep
  // them visible.  The agent just picked up the message — it hasn't appeared
  // in the timeline yet (no assistant.text event).  Clearing now would flash-
  // remove the queue before the user sees any response.  The queue will be
  // cleared by the next authoritative idle event (with pending=[]).
  if (fromEvent.length === 0 && existingMessages.length > 0) return existingMessages;
  return fromEvent;
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
  const fromEvent = normalizeTransportPendingEntries(
    pendingFromEvent,
    pendingMessagesFromEvent,
    scopeKey,
  );
  // Keep existing entries when event says empty but we had queued messages —
  // same rationale as mergeTransportPendingMessagesForRunningState.
  if (fromEvent.length === 0 && existingEntries.length > 0) return existingEntries;
  return fromEvent;
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
