export function extractTransportPendingMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

export function mergeTransportPendingMessagesForRunningState(
  existing: string[] | null | undefined,
  pendingFromEvent: unknown,
  hasPendingMessagesField: boolean,
): string[] {
  const existingMessages = Array.isArray(existing) ? existing.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
  if (!hasPendingMessagesField) return existingMessages;
  const nextMessages = extractTransportPendingMessages(pendingFromEvent);
  if (nextMessages.length > 0) return nextMessages;
  return existingMessages;
}
