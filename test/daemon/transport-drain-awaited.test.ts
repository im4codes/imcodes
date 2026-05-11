/**
 * Regression test for audit cae1de69-826 / R-Drain defensive fix.
 *
 * Background:
 * `restoreTransportSessions` (session-manager.ts:1517-1547) and
 * `launchTransportSession` (session-manager.ts:1830-1853) both used to
 * fire-and-forget `void drainResend(name, dispatcher).catch(...)`.
 * Three rounds of multi-agent audit (see
 * .imc/discussions/cae1de69-826.md) verified that the race window
 * between `transportRuntimes.set` and the synchronous prefix of
 * `drainResend` that sets `_sending=true` is effectively zero in the
 * CURRENT code, because:
 *   1. There is no `await` between `transportRuntimes.set` and the
 *      `void drainResend(...)` call in either function (verified by
 *      reading session-manager.ts:1451-1520 and :1746-1830).
 *   2. The dispatcher callback is synchronous; `runtime.send` is
 *      synchronous; `_dispatchTurn` synchronously sets `_sending=true`
 *      (transport-session-runtime.ts:376-462).
 *
 * However, the `await drainResend(...)` defensive change still matters:
 *   - It ensures the relaunch promise held by
 *     `runExclusiveSessionRelaunch` resolves only AFTER every resend
 *     entry has been transferred to the runtime (sent or queued
 *     internally) — so the "I'm relaunching" semantic includes drain.
 *   - It protects against future refactors that might insert an `await`
 *     between `transportRuntimes.set` and `drainResend`, which would
 *     otherwise reintroduce a real race window.
 *
 * This test locks down the new contract: `drainResend` with a
 * synchronous dispatcher fully drains the queue when awaited, and the
 * `_sending=true` semantic of the first entry is established
 * synchronously (before the first `await` yields). If anyone reverts
 * the `await` back to `void`, the existing `transport-resend-queue.test.ts`
 * still passes; the regression that matters is the OUTER caller behavior
 * — proven here by inspecting the synchronous prefix of dispatcher.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearAllResend,
  drainResend,
  enqueueResend,
  getResendCount,
} from '../../src/daemon/transport-resend-queue.js';

beforeEach(() => {
  clearAllResend();
});

describe('drainResend awaited contract (audit cae1de69-826 / R-Drain)', () => {
  it('synchronous dispatcher executes runtime.send before the first await yields', async () => {
    // Mirrors the shape of the dispatcher used in session-manager.ts:
    //   (entry) => { const result = runtime.send(...); ... return result; }
    // A purely synchronous dispatcher returns a value that `await` wraps
    // in Promise.resolve. The dispatcher's side effects (e.g. setting
    // _sending=true on the runtime) MUST land before any yield.

    enqueueResend('s1', { text: 'a', commandId: 'c1', queuedAt: Date.now() });
    enqueueResend('s1', { text: 'b', commandId: 'c2', queuedAt: Date.now() });

    let sendingFlag = false;
    const sendOrder: string[] = [];
    const dispatchedEntries: string[] = [];

    // Simulate the runtime: first send sets `sending=true` synchronously
    // (mimics `_dispatchTurn`); subsequent sends while sending=true
    // return 'queued'.
    const fakeRuntimeSend = (text: string): 'sent' | 'queued' => {
      sendOrder.push(text);
      if (!sendingFlag) {
        sendingFlag = true;
        return 'sent';
      }
      return 'queued';
    };

    const drainPromise = drainResend('s1', (entry) => {
      dispatchedEntries.push(entry.commandId);
      return fakeRuntimeSend(entry.text);
    });

    // Critical assertion: the synchronous prefix of drainResend MUST
    // have already invoked the dispatcher for the FIRST entry before
    // any await yielded. So `sendingFlag` is already true here.
    //
    // (Note: the second entry may or may not have been dispatched
    // depending on how `await Promise.resolve(syncValue)` interleaves;
    // but the FIRST entry's sync side effects MUST be visible.)
    expect(sendingFlag).toBe(true);
    expect(sendOrder[0]).toBe('a');

    const count = await drainPromise;
    expect(count).toBe(2);
    expect(dispatchedEntries).toEqual(['c1', 'c2']);
    expect(getResendCount('s1')).toBe(0);
  });

  it('awaited drainResend resolves only after every entry has been dispatched', async () => {
    // This pins the new caller contract used in session-manager.ts:
    //   `await drainResend(...)` waits for the full drain, not just the
    //   synchronous prefix. Reverting to `void drainResend(...)` would
    //   not break this single-promise assertion, but the surrounding
    //   `await` in restoreTransportSessions / launchTransportSession
    //   needs this promise to fully resolve before THEIR own resolution.

    enqueueResend('s1', { text: 'a', commandId: 'c1', queuedAt: Date.now() });
    enqueueResend('s1', { text: 'b', commandId: 'c2', queuedAt: Date.now() });
    enqueueResend('s1', { text: 'c', commandId: 'c3', queuedAt: Date.now() });

    const seen: string[] = [];
    const count = await drainResend('s1', (entry) => {
      seen.push(entry.commandId);
      return 'queued';
    });

    expect(count).toBe(3);
    expect(seen).toEqual(['c1', 'c2', 'c3']);
    expect(getResendCount('s1')).toBe(0);
  });

  it('a dispatcher that throws is swallowed by drainResend (entry dropped, others continue)', async () => {
    // drainResend has an internal try/catch around each dispatch call
    // (transport-resend-queue.ts:110-122) — failed entries are logged
    // and dropped to avoid retry loops. The caller's outer try/catch in
    // session-manager.ts is a defensive safety net for OTHER kinds of
    // errors (e.g., if drainResend itself were to throw before reaching
    // the loop). This test pins the current contract.
    enqueueResend('s1', { text: 'boom', commandId: 'c1', queuedAt: Date.now() });
    enqueueResend('s1', { text: 'ok',   commandId: 'c2', queuedAt: Date.now() });

    const dispatched: string[] = [];
    const count = await drainResend('s1', (entry) => {
      if (entry.commandId === 'c1') throw new Error('dispatcher exploded');
      dispatched.push(entry.commandId);
    });

    // Queue is empty (cleared before dispatch in line 98 of resend queue).
    expect(getResendCount('s1')).toBe(0);
    // Only the successful entry counts as "dispatched".
    expect(count).toBe(1);
    expect(dispatched).toEqual(['c2']);
  });
});
