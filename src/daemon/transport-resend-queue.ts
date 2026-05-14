/**
 * Transport resend queue — holds user messages that arrived while a transport
 * provider runtime was offline, so they can be automatically re-sent once the
 * runtime reconnects.
 *
 * Scope:
 *   - One queue per session (keyed by session name).
 *   - Entries are FIFO and expire after RESEND_EXPIRY_MS to avoid zombie resends
 *     from long-ago outages.
 *   - Bounded by MAX_RESEND_ENTRIES per session; oldest is dropped when full.
 *
 * Drain:
 *   - `drainResend()` is invoked from `restoreTransportSessions()` after the
 *     runtime is added to `transportRuntimes`. The queue is emptied before any
 *     dispatch so re-queueing inside the dispatcher is safe.
 *
 * Cancellation:
 *   - `clearResend(session)` is called on explicit user actions that should
 *     discard pending work (`/stop`, `/clear`, session removal).
 */

import logger from '../util/logger.js';
import type { TransportAttachment } from '../../shared/transport-attachments.js';

/** Queued entry age limit. Matches hook-server.ts QUEUE_EXPIRY_MS (5 minutes). */
export const RESEND_EXPIRY_MS = 5 * 60 * 1000;
/** Per-session cap to prevent unbounded growth during prolonged outages. */
export const MAX_RESEND_ENTRIES = 10;

export interface ResendEntry {
  /** User-visible task text — will be passed to runtime.send() as userMessage. */
  text: string;
  /** Provider-visible context to pass through TransportSessionRuntime messagePreamble. */
  messagePreamble?: string;
  /** Original clientMessageId so command.ack correlation survives the resend. */
  commandId: string;
  /** Attachment refs at enqueue time. Not resolved lazily — we do not re-walk the store. */
  attachments?: TransportAttachment[];
  /** Enqueue timestamp for expiry calculation. */
  queuedAt: number;
}

const queues = new Map<string, ResendEntry[]>();

/**
 * Append an entry. If the queue is already at MAX_RESEND_ENTRIES the oldest
 * entry is discarded (FIFO) so newly-typed messages always take priority.
 */
export function enqueueResend(sessionName: string, entry: ResendEntry): { accepted: true; droppedOldest: boolean } {
  const list = queues.get(sessionName) ?? [];
  let droppedOldest = false;
  if (list.length >= MAX_RESEND_ENTRIES) {
    const removed = list.shift();
    droppedOldest = true;
    logger.warn(
      { sessionName, droppedCommandId: removed?.commandId, size: list.length + 1 },
      'transport resend queue full — dropped oldest entry',
    );
  }
  list.push(entry);
  queues.set(sessionName, list);
  return { accepted: true, droppedOldest };
}

/** Non-mutating snapshot of the queue for UI / diagnostics. */
export function getResendEntries(sessionName: string): ResendEntry[] {
  return [...(queues.get(sessionName) ?? [])];
}

/** Number of entries currently queued for a session. */
export function getResendCount(sessionName: string): number {
  return queues.get(sessionName)?.length ?? 0;
}

/** Drop every queued entry for a session. Used by /stop, /clear, session delete. */
export function clearResend(sessionName: string): void {
  queues.delete(sessionName);
}

/** Drop every queued entry everywhere. Test helper. */
export function clearAllResend(): void {
  queues.clear();
}

export type ResendDispatcher = (entry: ResendEntry) => Promise<unknown> | unknown;

/**
 * Optional callback invoked once at the end of `drainResend` when one or more
 * entries were dropped because they exceeded `RESEND_EXPIRY_MS` (TTL).
 *
 * Added by audit 0419d1ac-1f4 (N-R6 / O4) so callers — typically the
 * transport-session restore / launch path in `src/agent/session-manager.ts`
 * — can emit a user-visible `assistant.text` summary telling the user that
 * N queued messages timed out. Earlier behaviour only logged at `info`
 * level; the user had no signal that their messages were lost.
 *
 * We pass a `count` rather than the entries themselves to keep the
 * timeline emit lightweight (no leaking of original text into the summary).
 * Callers needing per-entry diagnostics can read the existing `logger.info`
 * trail.
 */
export type ResendExpireCallback = (info: { expiredCount: number }) => void;

/**
 * Drain and dispatch. The internal queue is cleared BEFORE calling `dispatch`
 * so a dispatcher that wants to re-enqueue (e.g. still not really ready) can
 * do so safely. Expired entries are dropped. Failed dispatches are logged but
 * not retried — the next user action will resurface any real error.
 *
 * Returns the number of entries successfully dispatched.
 *
 * Optional `onExpired` callback runs once at the end of the drain if any
 * entries were skipped for TTL (audit 0419d1ac-1f4). It is called only
 * when `expiredCount > 0` and runs after every entry has been processed,
 * keeping the timeline emit out of the per-entry inner loop.
 */
export async function drainResend(
  sessionName: string,
  dispatch: ResendDispatcher,
  onExpired?: ResendExpireCallback,
): Promise<number> {
  const list = queues.get(sessionName);
  if (!list || list.length === 0) return 0;
  queues.delete(sessionName);

  const now = Date.now();
  let dispatched = 0;
  let expiredCount = 0;
  for (const entry of list) {
    if (now - entry.queuedAt > RESEND_EXPIRY_MS) {
      expiredCount += 1;
      logger.info(
        { sessionName, commandId: entry.commandId, ageMs: now - entry.queuedAt },
        'transport resend entry expired — dropping without redelivery',
      );
      continue;
    }
    try {
      await dispatch(entry);
      dispatched++;
      logger.info(
        { sessionName, commandId: entry.commandId },
        'transport resend delivered after reconnect',
      );
    } catch (err) {
      logger.warn(
        { err, sessionName, commandId: entry.commandId },
        'transport resend dispatch failed — dropping entry to avoid loops',
      );
    }
  }
  if (expiredCount > 0 && onExpired) {
    try {
      onExpired({ expiredCount });
    } catch (err) {
      logger.warn({ err, sessionName, expiredCount }, 'drainResend: onExpired callback threw');
    }
  }
  return dispatched;
}
