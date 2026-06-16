import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueResend,
  getFreshResendEntries,
  getResendEntries,
  getResendCount,
  listFreshResendQueues,
  listResendQueues,
  clearResend,
  clearAllResend,
  drainResend,
  RESEND_EXPIRY_MS,
  MAX_RESEND_ENTRIES,
} from '../../src/daemon/transport-resend-queue.js';

beforeEach(() => {
  clearAllResend();
});

describe('transport-resend-queue', () => {
  it('stores appended entries in FIFO order', () => {
    enqueueResend('s1', { text: 'a', commandId: 'c1', queuedAt: 10 });
    enqueueResend('s1', { text: 'b', commandId: 'c2', queuedAt: 20 });
    expect(getResendEntries('s1').map((e) => e.commandId)).toEqual(['c1', 'c2']);
    expect(getResendCount('s1')).toBe(2);
  });

  it('isolates queues per session', () => {
    enqueueResend('alpha', { text: 'a', commandId: 'ca', queuedAt: 0 });
    enqueueResend('beta', { text: 'b', commandId: 'cb', queuedAt: 0 });
    expect(getResendEntries('alpha').map((e) => e.commandId)).toEqual(['ca']);
    expect(getResendEntries('beta').map((e) => e.commandId)).toEqual(['cb']);
  });

  it('listResendQueues exposes a non-mutating all-session snapshot for diagnostics', () => {
    enqueueResend('alpha', { text: 'a', commandId: 'ca', queuedAt: 10 });
    enqueueResend('beta', { text: 'b', commandId: 'cb', queuedAt: 20 });

    const snapshot = listResendQueues();
    expect(snapshot.map((queue) => queue.sessionName).sort()).toEqual(['alpha', 'beta']);
    expect(snapshot.find((queue) => queue.sessionName === 'alpha')?.entries.map((entry) => entry.commandId)).toEqual(['ca']);

    snapshot.find((queue) => queue.sessionName === 'alpha')?.entries.push({
      text: 'mutated',
      commandId: 'mutated',
      queuedAt: 30,
    });

    expect(getResendEntries('alpha').map((entry) => entry.commandId)).toEqual(['ca']);
    expect(getResendEntries('beta').map((entry) => entry.commandId)).toEqual(['cb']);
  });

  it('fresh snapshots hide TTL-expired resend entries without mutating the queue', () => {
    const now = Date.now();
    enqueueResend('s1', { text: 'expired', commandId: 'c-expired', queuedAt: now - RESEND_EXPIRY_MS - 1 });
    enqueueResend('s1', { text: 'fresh', commandId: 'c-fresh', queuedAt: now });
    enqueueResend('s2', { text: 'also expired', commandId: 'c-expired-2', queuedAt: now - RESEND_EXPIRY_MS - 1 });

    expect(getFreshResendEntries('s1', now).map((entry) => entry.commandId)).toEqual(['c-fresh']);
    expect(listFreshResendQueues(now).map((queue) => queue.sessionName)).toEqual(['s1']);
    expect(getResendEntries('s1').map((entry) => entry.commandId)).toEqual(['c-expired', 'c-fresh']);
    expect(getResendCount('s2')).toBe(1);
  });

  it('drops the oldest entry once MAX_RESEND_ENTRIES is exceeded', () => {
    for (let i = 0; i < MAX_RESEND_ENTRIES; i++) {
      enqueueResend('s1', { text: `msg-${i}`, commandId: `c-${i}`, queuedAt: i });
    }
    expect(getResendCount('s1')).toBe(MAX_RESEND_ENTRIES);

    // Adding one more pushes the oldest out.
    const result = enqueueResend('s1', { text: 'overflow', commandId: 'c-overflow', queuedAt: 999 });
    expect(result.droppedOldest).toBe(true);
    expect(getResendCount('s1')).toBe(MAX_RESEND_ENTRIES);
    expect(getResendEntries('s1')[0].commandId).toBe('c-1'); // c-0 was dropped
    expect(getResendEntries('s1').at(-1)?.commandId).toBe('c-overflow');
  });

  it('clearResend empties a single session, leaving others intact', () => {
    enqueueResend('a', { text: 'x', commandId: 'ca', queuedAt: 0 });
    enqueueResend('b', { text: 'y', commandId: 'cb', queuedAt: 0 });
    clearResend('a');
    expect(getResendCount('a')).toBe(0);
    expect(getResendCount('b')).toBe(1);
  });

  it('drainResend dispatches entries in order and empties the queue', async () => {
    enqueueResend('s1', { text: 'first', commandId: 'c1', queuedAt: Date.now() });
    enqueueResend('s1', { text: 'second', commandId: 'c2', queuedAt: Date.now() });

    const dispatched: Array<{ text: string; commandId: string }> = [];
    const count = await drainResend('s1', (entry) => {
      dispatched.push({ text: entry.text, commandId: entry.commandId });
    });

    expect(count).toBe(2);
    expect(dispatched).toEqual([
      { text: 'first', commandId: 'c1' },
      { text: 'second', commandId: 'c2' },
    ]);
    expect(getResendCount('s1')).toBe(0);
  });

  it('drainResend drops expired entries without calling dispatch', async () => {
    const now = Date.now();
    enqueueResend('s1', { text: 'stale', commandId: 'c-stale', queuedAt: now - (RESEND_EXPIRY_MS + 1000) });
    enqueueResend('s1', { text: 'fresh', commandId: 'c-fresh', queuedAt: now });

    const dispatch = vi.fn();
    const count = await drainResend('s1', dispatch);

    expect(count).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'c-fresh' }));
    expect(getResendCount('s1')).toBe(0);
  });

  it('drainResend continues past a failing dispatcher without retrying', async () => {
    enqueueResend('s1', { text: 'a', commandId: 'c1', queuedAt: Date.now() });
    enqueueResend('s1', { text: 'b', commandId: 'c2', queuedAt: Date.now() });

    const dispatch = vi.fn()
      .mockImplementationOnce(() => { throw new Error('boom'); })
      .mockImplementationOnce(() => 'sent');

    const count = await drainResend('s1', dispatch);

    // Only the second one counted as dispatched; the first failed and was dropped.
    expect(count).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(getResendCount('s1')).toBe(0);
  });

  it('drainResend empties the queue BEFORE invoking dispatch so re-enqueue is safe', async () => {
    enqueueResend('s1', { text: 'a', commandId: 'c1', queuedAt: Date.now() });

    let observedDuringDispatch = -1;
    await drainResend('s1', (_entry) => {
      observedDuringDispatch = getResendCount('s1');
      enqueueResend('s1', { text: 're', commandId: 'c-re', queuedAt: Date.now() });
    });

    // Inside the dispatcher, the queue was already emptied.
    expect(observedDuringDispatch).toBe(0);
    // The re-enqueued entry remains after the drain completes.
    expect(getResendEntries('s1').map((e) => e.commandId)).toEqual(['c-re']);
  });

  it('drainResend is a no-op for an empty session', async () => {
    const dispatch = vi.fn();
    const count = await drainResend('nonexistent', dispatch);
    expect(count).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
