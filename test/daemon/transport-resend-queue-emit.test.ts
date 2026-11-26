/**
 * Regression tests for audit 0419d1ac-1f4 — resend queue user-visible
 * signals (N-R3 droppedOldest + N-R6 TTL summary).
 *
 * Background: prior to this fix, `enqueueResend` silently dropped the
 * oldest entry when the queue overflowed `MAX_RESEND_ENTRIES` (10) and
 * `drainResend` silently dropped entries that exceeded
 * `RESEND_EXPIRY_MS` (5 min) — only a `logger.warn` / `logger.info`
 * trail told anyone. Combined with web's `reconcileQueuedOptimisticMessages`
 * already removing the optimistic bubble and adding the commandId to
 * `settledCommandIdsRef`, the dropped entries were:
 *   - no longer visible as pending bubble (web removed it)
 *   - unable to surface via `command.ack error` reversal (web settle
 *     guard short-circuits `markOptimisticFailed`)
 *   - not visible as chat history (daemon never dispatched them)
 * — i.e. silent data loss.
 *
 * These tests pin the new contract:
 *   T-N3   — `enqueueResend` overflow → return `droppedOldest: true`,
 *            and (verified separately in command-handler tests) callers
 *            emit `assistant.text` warning.
 *   T-N6   — `drainResend` invokes the `onExpired` callback once with
 *            the count of TTL-dropped entries.
 *   T-N6b  — `onExpired` is NOT called when no entries expire.
 *   T-N6c  — `onExpired` callback exceptions are swallowed (don't crash drain).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueResend,
  getResendCount,
  getResendEntries,
  clearAllResend,
  drainResend,
  MAX_RESEND_ENTRIES,
  RESEND_EXPIRY_MS,
} from '../../src/daemon/transport-resend-queue.js';
import { getTransportQueueRevision } from '../../src/daemon/transport-queue-revision.js';
import { buildTransportPendingQueueSnapshot } from '../../src/daemon/transport-pending-snapshot.js';

beforeEach(() => {
  clearAllResend();
});

describe('transport-resend-queue user-visible signals (audit 0419d1ac-1f4)', () => {
  it('T-N3: enqueueResend returns droppedOldest=true when queue overflows MAX_RESEND_ENTRIES', () => {
    // Fill the queue to capacity.
    for (let i = 0; i < MAX_RESEND_ENTRIES; i++) {
      const result = enqueueResend('s1', { text: `msg-${i}`, commandId: `c-${i}`, queuedAt: i });
      expect(result.droppedOldest).toBe(false);
    }
    expect(getResendCount('s1')).toBe(MAX_RESEND_ENTRIES);

    // Adding one more triggers oldest drop.
    const overflow = enqueueResend('s1', { text: 'overflow', commandId: 'c-overflow', queuedAt: 999 });
    expect(overflow.accepted).toBe(true);
    expect(overflow.droppedOldest).toBe(true);
    expect(typeof overflow.pendingVersion).toBe('number');
    // Count stays at cap.
    expect(getResendCount('s1')).toBe(MAX_RESEND_ENTRIES);
  });

  it('resend mutations advance a session queue revision', async () => {
    const first = enqueueResend('s-version', { text: 'first', commandId: 'c1', queuedAt: Date.now() });
    expect(first.pendingVersion).toBe(1);
    const second = enqueueResend('s-version', { text: 'second', commandId: 'c2', queuedAt: Date.now() });
    expect(second.pendingVersion).toBe(2);
    expect(getTransportQueueRevision('s-version')).toBe(2);

    await drainResend('s-version', () => 'sent');
    expect(getResendEntries('s-version')).toEqual([]);
    expect(getTransportQueueRevision('s-version')).toBeGreaterThan(second.pendingVersion);
    expect(buildTransportPendingQueueSnapshot('s-version', undefined).pendingEntries).toEqual([]);
  });

  it('drainResend reports committed delivery facts for successfully dispatched entries', async () => {
    const now = Date.now();
    enqueueResend('s-delivery', { text: 'one', commandId: 'c-one', clientMessageId: 'm-one', queuedAt: now });
    enqueueResend('s-delivery', { text: 'two', commandId: 'c-two', clientMessageId: 'm-two', queuedAt: now });
    const onDelivered = vi.fn();

    const count = await drainResend('s-delivery', () => 'sent', undefined, undefined, onDelivered);

    expect(count).toBe(2);
    expect(onDelivered).toHaveBeenCalledTimes(2);
    expect(onDelivered.mock.calls.flatMap((call) => call[0].deliveryFacts).map((fact) => fact.clientMessageId))
      .toEqual(['m-one', 'm-two']);
    for (const call of onDelivered.mock.calls) {
      const fact = call[0].deliveryFacts[0];
      expect(fact).toEqual(expect.objectContaining({
        type: 'transport.queue.delivery',
        sessionName: 's-delivery',
        queueEpoch: expect.any(String),
        queueAuthorityId: expect.any(String),
        pendingMessageVersion: expect.any(Number),
        deliveryFrameId: expect.any(String),
        deliveryFrameVersion: expect.any(Number),
      }));
    }
  });

  it('resend pending snapshots carry the queue revision', () => {
    const result = enqueueResend('s-snapshot', { text: 'queued', commandId: 'cmd-q', clientMessageId: 'msg-q', queuedAt: Date.now() });
    const snapshot = buildTransportPendingQueueSnapshot('s-snapshot', undefined);
    expect(snapshot.source).toBe('sqlite');
    expect(snapshot.pendingVersion).toBe(result.pendingVersion);
    expect(snapshot.pendingEntries).toEqual([{ clientMessageId: 'msg-q', text: 'queued' }]);
  });

  it('T-N6: drainResend invokes onExpired callback with count of TTL-dropped entries', async () => {
    const now = Date.now();
    // 2 expired entries + 1 fresh entry.
    enqueueResend('s1', { text: 'stale-1', commandId: 'c-stale-1', queuedAt: now - (RESEND_EXPIRY_MS + 60_000) });
    enqueueResend('s1', { text: 'stale-2', commandId: 'c-stale-2', queuedAt: now - (RESEND_EXPIRY_MS + 30_000) });
    enqueueResend('s1', { text: 'fresh', commandId: 'c-fresh', queuedAt: now });

    const dispatched = vi.fn();
    const onExpired = vi.fn();
    const count = await drainResend('s1', dispatched, onExpired);

    // Only the fresh entry got dispatched.
    expect(count).toBe(1);
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(dispatched.mock.calls[0]?.[0]?.commandId).toBe('c-fresh');

    // onExpired called exactly once with the expired count (NOT per-entry).
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onExpired).toHaveBeenCalledWith({ expiredCount: 2 });
  });

  it('T-N6b: onExpired is NOT invoked when no entries expire', async () => {
    const now = Date.now();
    enqueueResend('s1', { text: 'fresh-1', commandId: 'c-1', queuedAt: now });
    enqueueResend('s1', { text: 'fresh-2', commandId: 'c-2', queuedAt: now });

    const dispatched = vi.fn();
    const onExpired = vi.fn();
    const count = await drainResend('s1', dispatched, onExpired);

    expect(count).toBe(2);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('T-N6c: onExpired callback exceptions do not crash the drain', async () => {
    const now = Date.now();
    enqueueResend('s1', { text: 'stale', commandId: 'c-stale', queuedAt: now - (RESEND_EXPIRY_MS + 1000) });
    enqueueResend('s1', { text: 'fresh', commandId: 'c-fresh', queuedAt: now });

    const dispatched = vi.fn();
    const onExpired = vi.fn(() => { throw new Error('boom from onExpired'); });

    // Even though onExpired throws, drainResend must still return a sensible count.
    const count = await drainResend('s1', dispatched, onExpired);
    expect(count).toBe(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
    // Queue cleared.
    expect(getResendCount('s1')).toBe(0);
  });

  it('T-N6d: drainResend with no onExpired callback still drops expired entries silently (backward compat)', async () => {
    // Existing callers (if any) without the new third argument must continue to work.
    const now = Date.now();
    enqueueResend('s1', { text: 'stale', commandId: 'c-stale', queuedAt: now - (RESEND_EXPIRY_MS + 1000) });
    enqueueResend('s1', { text: 'fresh', commandId: 'c-fresh', queuedAt: now });

    const dispatched = vi.fn();
    const count = await drainResend('s1', dispatched);

    expect(count).toBe(1);
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it('T-N7: drainResend invokes onDispatchFailed once with failed dispatch count', async () => {
    const now = Date.now();
    enqueueResend('s1', { text: 'fail-1', commandId: 'c-fail-1', queuedAt: now });
    enqueueResend('s1', { text: 'ok', commandId: 'c-ok', queuedAt: now });
    enqueueResend('s1', { text: 'fail-2', commandId: 'c-fail-2', queuedAt: now });

    const dispatched = vi.fn()
      .mockImplementationOnce(() => { throw new Error('boom 1'); })
      .mockImplementationOnce(() => 'sent')
      .mockImplementationOnce(() => { throw new Error('boom 2'); });
    const onExpired = vi.fn();
    const onDispatchFailed = vi.fn();

    const count = await drainResend('s1', dispatched, onExpired, onDispatchFailed);

    expect(count).toBe(1);
    expect(onExpired).not.toHaveBeenCalled();
    expect(onDispatchFailed).toHaveBeenCalledTimes(1);
    expect(onDispatchFailed).toHaveBeenCalledWith({ failedCount: 2 });
    expect(getResendCount('s1')).toBe(0);
  });
});
