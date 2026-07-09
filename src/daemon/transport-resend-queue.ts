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
 *     runtime is added to `transportRuntimes`. SQLite handoff is committed
 *     before entries leave the in-memory holder or dispatch begins.
 *
 * Cancellation:
 *   - `clearResend(session)` is called on explicit user actions that should
 *     discard pending work (`/stop`, `/clear`, session removal).
 */

import { randomUUID } from 'node:crypto';
import logger from '../util/logger.js';
import type { TransportAttachment } from '../../shared/transport-attachments.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
import type { QueueDeliveryFact, QueueDropReason, QueueResetReason, QueueSnapshot } from '../../shared/transport-queue-types.js';
import {
  bumpTransportQueueRevision,
  clearAllTransportQueueRevisions,
} from './transport-queue-revision.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from './transport-queue-store.js';

/** Queued entry age limit. Matches hook-server.ts QUEUE_EXPIRY_MS (5 minutes). */
export const RESEND_EXPIRY_MS = 5 * 60 * 1000;
/** Per-session cap to prevent unbounded growth during prolonged outages. */
export const MAX_RESEND_ENTRIES = 10;

export interface ResendEntry {
  /** User-visible task text — the ORIGINAL marker text used for the timeline. */
  text: string;
  /**
   * Agent-bound text after alias expansion (A′). When set it is delivered to the
   * provider (via runtime.send metadata) while `text` stays the timeline copy.
   */
  providerText?: string;
  /** Provider-visible context to pass through TransportSessionRuntime messagePreamble. */
  messagePreamble?: string;
  /** Original clientMessageId so command.ack correlation survives the resend. */
  commandId: string;
  /** Stable queue identity. Command ids are receipts only and never queue authority ids. */
  clientMessageId?: string;
  /** Attachment refs at enqueue time. Not resolved lazily — we do not re-walk the store. */
  attachments?: TransportAttachment[];
  /** Server-authored share actor for attribution only; never injected into provider prompts. */
  sharedActor?: SharedActorEnvelope;
  /** @internal: this logical user event has already been written to the timeline. */
  timelineCommitted?: boolean;
  /** @internal: this logical user event has already been written to runtime history. */
  historyCommitted?: boolean;
  /** Enqueue timestamp for expiry calculation. */
  queuedAt: number;
}

const queues = new Map<string, ResendEntry[]>();

/**
 * Append an entry. If the queue is already at MAX_RESEND_ENTRIES the oldest
 * entry is discarded (FIFO) so newly-typed messages always take priority.
 */
export function enqueueResend(sessionName: string, entry: ResendEntry): {
  accepted: true;
  droppedOldest: boolean;
  pendingVersion: number;
  queueSnapshot?: QueueSnapshot;
  dropSnapshot?: QueueSnapshot;
} | {
  accepted: false;
  droppedOldest: false;
  pendingVersion: number;
  reason: 'sqlite_enqueue_failed';
} {
  const list = queues.get(sessionName) ?? [];
  const clientMessageId = entry.clientMessageId?.trim() || randomUUID();
  let droppedOldest = false;
  const normalizedEntry: ResendEntry = {
    ...entry,
    clientMessageId,
  };
  const evicted = list.length >= MAX_RESEND_ENTRIES ? list[0] : undefined;
  let queueSnapshot: QueueSnapshot;
  let dropSnapshot: QueueSnapshot | undefined;
  try {
    const result = getTransportQueueStore().enqueueWithCapacityEviction({
      sessionName,
      clientMessageId: normalizedEntry.clientMessageId,
      commandId: normalizedEntry.commandId,
      text: normalizedEntry.text,
      now: normalizedEntry.queuedAt,
      privateMaterialJson: JSON.stringify({
        clientMessageId: normalizedEntry.clientMessageId,
        text: normalizedEntry.text,
        ...(normalizedEntry.providerText != null ? { providerText: normalizedEntry.providerText } : {}),
        ...(normalizedEntry.messagePreamble ? { messagePreamble: normalizedEntry.messagePreamble } : {}),
        ...(normalizedEntry.attachments?.length ? { attachmentRefs: normalizedEntry.attachments } : {}),
        ...(normalizedEntry.sharedActor ? { sharedActorEnvelope: normalizedEntry.sharedActor } : {}),
        ...(normalizedEntry.timelineCommitted ? { timelineCommitted: true } : {}),
        ...(normalizedEntry.historyCommitted ? { historyCommitted: true } : {}),
      }),
    }, evicted?.clientMessageId);
    queueSnapshot = result.queueSnapshot;
    dropSnapshot = result.dropSnapshot;
  } catch (err) {
    const existingSnapshot = (() => {
      try {
        return getTransportQueueStore().readSnapshot(sessionName);
      } catch {
        return null;
      }
    })();
    const alreadyAuthoritative = existingSnapshot?.pendingMessageEntries.some(
      (candidate) => candidate.clientMessageId === normalizedEntry.clientMessageId,
    ) === true;
    if (alreadyAuthoritative && existingSnapshot) {
      queueSnapshot = existingSnapshot;
      logger.warn(
        { err, sessionName, commandId: entry.commandId, clientMessageId: normalizedEntry.clientMessageId },
        'transport queue sqlite enqueue found existing live entry; preserving resend memory handoff',
      );
    } else {
      logger.warn({ err, sessionName, commandId: entry.commandId }, 'transport queue sqlite enqueue failed for resend entry; resend enqueue rejected');
      return {
        accepted: false,
        droppedOldest: false,
        pendingVersion: bumpTransportQueueRevision(sessionName),
        reason: 'sqlite_enqueue_failed',
      };
    }
  }
  if (list.length >= MAX_RESEND_ENTRIES) {
    const removed = list.shift();
    droppedOldest = true;
    logger.warn(
      { sessionName, droppedCommandId: removed?.commandId, size: list.length + 1 },
      'transport resend queue full — dropped oldest entry',
    );
  }
  list.push(normalizedEntry);
  queues.set(sessionName, list);
  return { accepted: true, droppedOldest, pendingVersion: queueSnapshot.pendingMessageVersion, queueSnapshot, ...(dropSnapshot ? { dropSnapshot } : {}) };
}

/** Non-mutating snapshot of the queue for UI / diagnostics. */
export function getResendEntries(sessionName: string): ResendEntry[] {
  return [...(queues.get(sessionName) ?? [])];
}

/** Non-mutating snapshot of non-expired entries for UI / diagnostics. */
export function getFreshResendEntries(sessionName: string, nowMs: number = Date.now()): ResendEntry[] {
  return (queues.get(sessionName) ?? []).filter((entry) => nowMs - entry.queuedAt <= RESEND_EXPIRY_MS);
}

/** Non-mutating snapshot of every resend queue for daemon status diagnostics. */
export function listResendQueues(): Array<{ sessionName: string; entries: ResendEntry[] }> {
  return [...queues.entries()].map(([sessionName, entries]) => ({
    sessionName,
    entries: [...entries],
  }));
}

/** Non-mutating snapshot of every queue, excluding TTL-expired zombie entries. */
export function listFreshResendQueues(nowMs: number = Date.now()): Array<{ sessionName: string; entries: ResendEntry[] }> {
  return [...queues.entries()]
    .map(([sessionName, entries]) => ({
      sessionName,
      entries: entries.filter((entry) => nowMs - entry.queuedAt <= RESEND_EXPIRY_MS),
    }))
    .filter((queue) => queue.entries.length > 0);
}

/** Number of entries currently queued for a session. */
export function getResendCount(sessionName: string): number {
  return queues.get(sessionName)?.length ?? 0;
}

/** Expire stale resend entries before projecting queue state without dispatching. */
export function expireResendEntries(sessionName: string, nowMs: number = Date.now()): QueueSnapshot | undefined {
  const list = queues.get(sessionName);
  if (!list || list.length === 0) return undefined;

  const freshEntries = list.filter((entry) => nowMs - entry.queuedAt <= RESEND_EXPIRY_MS);
  const expiredEntries = list.filter((entry) => nowMs - entry.queuedAt > RESEND_EXPIRY_MS);
  if (expiredEntries.length === 0) return undefined;

  if (freshEntries.length > 0) {
    queues.set(sessionName, freshEntries);
  } else {
    queues.delete(sessionName);
  }
  bumpTransportQueueRevision(sessionName);

  let snapshot: QueueSnapshot | undefined;
  for (const entry of expiredEntries) {
    const clientMessageId = entry.clientMessageId;
    if (!clientMessageId) {
      logger.warn({ sessionName, commandId: entry.commandId }, 'transport queue mark expired skipped for resend entry without clientMessageId');
      continue;
    }
    try {
      snapshot = getTransportQueueStore().markFailed(sessionName, clientMessageId, 'expired', nowMs);
    } catch (err) {
      logger.warn({ err, sessionName, commandId: entry.commandId }, 'transport queue sqlite mark expired failed for resend projection');
    }
  }
  logger.info(
    { sessionName, expiredCount: expiredEntries.length, freshCount: freshEntries.length },
    'transport resend expired stale entries before queue projection',
  );
  return snapshot;
}

/** Drop queued entries matching a predicate. Returns the number removed. */
export function removeResendEntries(
  sessionName: string,
  predicate: (entry: ResendEntry) => boolean,
): number {
  const list = queues.get(sessionName);
  if (!list || list.length === 0) return 0;
  const kept = list.filter((entry) => !predicate(entry));
  const removed = list.length - kept.length;
  if (kept.length === 0) {
    queues.delete(sessionName);
  } else if (removed > 0) {
    queues.set(sessionName, kept);
  }
  if (removed > 0) bumpTransportQueueRevision(sessionName);
  if (removed > 0) {
    for (const entry of list) {
      if (predicate(entry)) {
        if (!entry.clientMessageId) {
          logger.warn({ sessionName, commandId: entry.commandId }, 'transport queue drop skipped for resend entry without clientMessageId');
          continue;
        }
        try {
          getTransportQueueStore().drop(sessionName, entry.clientMessageId, 'user_cleared');
        } catch (err) {
          logger.warn({ err, sessionName, commandId: entry.commandId }, 'transport queue sqlite drop failed for removed resend entry');
        }
      }
    }
  }
  return removed;
}

/** Drop every queued entry for a session. Used by /stop, /clear, session delete. */
export function clearResend(
  sessionName: string,
  reason: QueueResetReason | QueueDropReason = 'user_clear',
): QueueSnapshot | undefined {
  let snapshot: QueueSnapshot | undefined;
  if (queues.has(sessionName)) bumpTransportQueueRevision(sessionName);
  if (queues.has(sessionName)) {
    try {
      if (reason === 'user_clear' || reason === 'sqlite_restore' || reason === 'runtime_recreated' || reason === 'authority_corrupt_reinitialized') {
        snapshot = getTransportQueueStore().reset(sessionName, reason);
      } else {
        snapshot = getTransportQueueStore().dropAll(sessionName, reason);
      }
    } catch (err) {
      logger.warn({ err, sessionName, reason }, 'transport queue sqlite clear failed for clearResend');
    }
  }
  queues.delete(sessionName);
  return snapshot;
}

/** Drop every queued entry everywhere. Test helper. */
export function clearAllResend(): void {
  queues.clear();
  clearAllTransportQueueRevisions();
  if (process.env.VITEST) resetTransportQueueStoreForTests();
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
export type ResendDispatchFailureCallback = (info: { failedCount: number }) => void;
export type ResendDeliveryCallback = (info: { deliveryFacts: QueueDeliveryFact[] }) => void;

/**
 * Drain and dispatch. Fresh entries first acquire a committed SQLite handoff
 * lease. If the lease cannot be written, the in-memory holder is preserved and
 * dispatch does not begin. Expired entries are removed only after their failed
 * status commits.
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
  onDispatchFailed?: ResendDispatchFailureCallback,
  onDelivered?: ResendDeliveryCallback,
): Promise<number> {
  const list = queues.get(sessionName);
  if (!list || list.length === 0) return 0;

  const now = Date.now();
  const freshEntries = list.filter((entry) => now - entry.queuedAt <= RESEND_EXPIRY_MS);
  const expiredEntries = list.filter((entry) => now - entry.queuedAt > RESEND_EXPIRY_MS);
  const freshClientMessageIds = freshEntries.map((entry) => entry.clientMessageId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (freshClientMessageIds.length !== freshEntries.length) {
    logger.warn({ sessionName }, 'transport resend drain blocked: entry missing clientMessageId');
    return 0;
  }
  try {
    const leased = getTransportQueueStore().markHandoffInFlight(
      sessionName,
      freshClientMessageIds,
      RESEND_EXPIRY_MS,
      now,
    );
    if (leased.length !== freshEntries.length) {
      logger.warn({ sessionName, requested: freshEntries.length, leased: leased.length }, 'transport queue sqlite handoff lease incomplete for resend drain');
      return 0;
    }
  } catch (err) {
    logger.warn({ err, sessionName }, 'transport queue sqlite handoff mark failed for resend drain; preserving resend queue');
    return 0;
  }
  queues.delete(sessionName);
  bumpTransportQueueRevision(sessionName);
  let dispatched = 0;
  let expiredCount = 0;
  let failedCount = 0;
  for (const entry of list) {
    if (now - entry.queuedAt > RESEND_EXPIRY_MS) {
      if (!entry.clientMessageId) {
        logger.warn({ sessionName, commandId: entry.commandId }, 'transport queue mark expired skipped for resend entry without clientMessageId');
        continue;
      }
      expiredCount += 1;
      try {
        getTransportQueueStore().markFailed(sessionName, entry.clientMessageId, 'expired', now);
      } catch (err) {
        logger.warn({ err, sessionName, commandId: entry.commandId }, 'transport queue sqlite mark expired failed for resend entry');
      }
      logger.info(
        { sessionName, commandId: entry.commandId, ageMs: now - entry.queuedAt },
        'transport resend entry expired — dropping without redelivery',
      );
      continue;
    }
    try {
      const dispatchResult = await dispatch(entry);
      const clientMessageId = entry.clientMessageId;
      if (!clientMessageId) {
        failedCount += 1;
        logger.warn({ sessionName, commandId: entry.commandId }, 'transport resend dispatch finalized as failed: missing clientMessageId');
        continue;
      }
      if (dispatchResult !== 'queued') {
        try {
          const result = getTransportQueueStore().finalizeSentBatch(
            sessionName,
            [clientMessageId],
          );
          if (result.deliveryFacts.length > 0) onDelivered?.({ deliveryFacts: result.deliveryFacts });
        } catch (err) {
          logger.warn({ err, sessionName, commandId: entry.commandId }, 'transport queue sqlite finalizeSent failed for resend entry');
        }
      }
      dispatched++;
      logger.info(
        { sessionName, commandId: entry.commandId, dispatchResult },
        dispatchResult === 'queued'
          ? 'transport resend accepted into runtime queue after reconnect'
          : 'transport resend delivered after reconnect',
      );
    } catch (err) {
      failedCount += 1;
      const clientMessageId = entry.clientMessageId;
      if (!clientMessageId) {
        logger.warn({ err, sessionName, commandId: entry.commandId }, 'transport queue sqlite mark failed skipped for resend entry without clientMessageId');
        continue;
      }
      try {
        getTransportQueueStore().markFailed(sessionName, clientMessageId, 'dispatch_failed', now);
      } catch (storeErr) {
        logger.warn({ err: storeErr, sessionName, commandId: entry.commandId }, 'transport queue sqlite mark failed failed for resend entry');
      }
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
  if (failedCount > 0 && onDispatchFailed) {
    try {
      onDispatchFailed({ failedCount });
    } catch (err) {
      logger.warn({ err, sessionName, failedCount }, 'drainResend: onDispatchFailed callback threw');
    }
  }
  return dispatched;
}
