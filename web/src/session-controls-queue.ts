import { TRANSPORT_QUEUE_DELIVERY_EVENT_TYPE } from '@shared/transport-queue-types.js';
import type { TimelineEvent } from './ws-client.js';

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * clientMessageIds / commandIds of every user message or queue-delivery fact
 * already committed to `sessionName`'s timeline. Such an id must never remain
 * editable in the queue card, whatever a stale queue snapshot still says.
 */
export function collectSettledQueuedIds(
  events: readonly TimelineEvent[] | undefined,
  sessionName: string | undefined,
): ReadonlySet<string> {
  if (!sessionName || !events || events.length === 0) return NO_IDS;
  const ids = new Set<string>();
  for (const event of events) {
    if (event.sessionId !== sessionName) continue;
    if (event.type !== 'user.message' && event.type !== TRANSPORT_QUEUE_DELIVERY_EVENT_TYPE) continue;
    const clientMessageId = typeof event.payload.clientMessageId === 'string'
      ? event.payload.clientMessageId.trim()
      : '';
    if (clientMessageId) ids.add(clientMessageId);
    if (event.type === 'user.message') {
      const commandId = typeof event.payload.commandId === 'string'
        ? event.payload.commandId.trim()
        : '';
      if (commandId) ids.add(commandId);
    }
  }
  return ids.size === 0 ? NO_IDS : ids;
}
