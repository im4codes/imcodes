/** A browser-local placeholder is not an authoritative projection of a send. */
export const TIMELINE_OPTIMISTIC_EVENT_ID_PREFIX = 'optimistic:';

/** Small immutable send metadata retained by legacy history projections.
 * Never inherit pending/failed or preview-completeness state from another copy. */
export const TIMELINE_SEND_METADATA_FIELDS = [
  'commandId', 'clientMessageId', 'sharedActor', 'messageOrigin', 'aliasAudit',
  'attachments', 'queueAppended', 'pendingMessageVersion', 'uiLocale',
] as const;

/** Identity of one send, not its body, label, timestamp or delivery attempt.
 * Legacy records without either field deliberately have no identity. */
export function getTimelineSendId(payload: Record<string, unknown>): string | undefined {
  for (const value of [payload.commandId, payload.clientMessageId]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
