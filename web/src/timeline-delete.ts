import { MSG_COMMAND_ACK, MSG_COMMAND_FAILED } from '@shared/ack-protocol.js';
import {
  TIMELINE_DELETE_ACK_TIMEOUT_MS,
  TIMELINE_DELETE_ERROR_CODES,
  type TimelineDeleteErrorCode,
} from '@shared/timeline-protocol.js';
import type { WsClient } from './ws-client.js';

/** What the context menu deletes: every stored event of the rendered block. */
export interface TimelineDeleteTargets {
  /** The id the menu was opened on (`eventIds[0]` when it is one of them). */
  primaryEventId: string;
  eventIds: string[];
  /** event id -> event type, so the daemon can tombstone an id it no longer holds. */
  eventTypes: Record<string, string>;
}

export class TimelineDeleteError extends Error {
  constructor(readonly code: TimelineDeleteErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'TimelineDeleteError';
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(TIMELINE_DELETE_ERROR_CODES));

/** Map whatever the daemon answered (incl. an older daemon's free text) onto a stable code. */
export function normalizeTimelineDeleteError(raw: unknown): TimelineDeleteErrorCode {
  return typeof raw === 'string' && KNOWN_CODES.has(raw) ? raw as TimelineDeleteErrorCode : TIMELINE_DELETE_ERROR_CODES.FAILED;
}

/** i18n key for a delete failure (all seven locales carry these). */
export function timelineDeleteErrorKey(code: TimelineDeleteErrorCode): string {
  switch (code) {
    case TIMELINE_DELETE_ERROR_CODES.TIMEOUT: return 'chat.delete_message_error_timeout';
    case TIMELINE_DELETE_ERROR_CODES.SESSION_NOT_FOUND: return 'chat.delete_message_error_session';
    default: return 'chat.delete_message_error';
  }
}

/**
 * Ask the daemon to delete (hide) a message for every viewer and resolve only when it
 * acknowledged. Rejects with a coded {@link TimelineDeleteError} on a daemon error ack,
 * a command.failed, a dead socket, or no answer within the timeout - never silently.
 */
export function requestTimelineMessageDelete(
  ws: Pick<WsClient, 'deleteTimelineMessage' | 'onMessage' | 'connected'>,
  sessionName: string,
  targets: TimelineDeleteTargets,
  timeoutMs = TIMELINE_DELETE_ACK_TIMEOUT_MS,
): Promise<void> {
  const commandId = globalThis.crypto?.randomUUID?.()
    ?? `delete-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return new Promise((resolve, reject) => {
    if (!ws.connected) {
      // `WsClient.send` drops silently while the socket is down; without this the
      // user would wait the whole timeout to learn nothing was sent.
      reject(new TimelineDeleteError(TIMELINE_DELETE_ERROR_CODES.TIMEOUT, 'not connected'));
      return;
    }
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (error?: TimelineDeleteError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new TimelineDeleteError(TIMELINE_DELETE_ERROR_CODES.TIMEOUT)), timeoutMs);
    unsubscribe = ws.onMessage((message) => {
      if (message.type === MSG_COMMAND_ACK && message.commandId === commandId) {
        if (message.status === 'error') finish(new TimelineDeleteError(normalizeTimelineDeleteError(message.error)));
        else finish();
      } else if (message.type === MSG_COMMAND_FAILED && message.commandId === commandId) {
        finish(new TimelineDeleteError(TIMELINE_DELETE_ERROR_CODES.FAILED));
      }
    });
    try {
      ws.deleteTimelineMessage(sessionName, targets.primaryEventId, {
        eventIds: targets.eventIds,
        eventTypes: targets.eventTypes,
        commandId,
      });
    } catch (err) {
      finish(new TimelineDeleteError(TIMELINE_DELETE_ERROR_CODES.FAILED, err instanceof Error ? err.message : undefined));
    }
  });
}

interface DeleteTargetItem {
  key: string;
  event?: { eventId: string };
  /** Assistant text segments merged into one bubble. */
  eventIds?: readonly string[];
  /** memory.context rows attached to a user message. */
  linkedEvents?: ReadonlyArray<{ eventId: string }>;
}

/**
 * The rendered bubble a context menu was opened on can be MORE than the one event id in
 * its `data-event-id`: consecutive assistant.text events merge into one block keyed by
 * the first of them. Deleting only that id left the rest of the block on screen ("删不掉").
 * Resolve every stored event of the block, plus any rows attached to it.
 */
export function resolveTimelineDeleteTargets(
  items: readonly DeleteTargetItem[],
  events: ReadonlyArray<{ eventId: string; type: string }>,
  eventId: string,
): TimelineDeleteTargets {
  const item = items.find((candidate) => (
    candidate.key === eventId
    || candidate.event?.eventId === eventId
    || candidate.eventIds?.includes(eventId)
  ));
  const ids = new Set<string>([eventId]);
  for (const id of item?.eventIds ?? []) ids.add(id);
  if (item?.event) ids.add(item.event.eventId);
  for (const linked of item?.linkedEvents ?? []) ids.add(linked.eventId);
  const typeById = new Map<string, string>();
  for (const event of events) if (ids.has(event.eventId)) typeById.set(event.eventId, event.type);
  const eventTypes: Record<string, string> = {};
  for (const id of ids) {
    const type = typeById.get(id);
    if (type) eventTypes[id] = type;
  }
  return { primaryEventId: eventId, eventIds: [...ids], eventTypes };
}
