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
import { readFileSync } from 'node:fs';
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
  it('reuses the supervision authority gate at both resend and runtime FIFO drain edges', () => {
    const manager = readFileSync(new URL('../../src/agent/session-manager.ts', import.meta.url), 'utf8');
    // Both edges share ONE admission: the supervision heartbeat gate for every
    // entry, plus the ended-task gate for queued delegation replies.
    const resendGate = manager.indexOf('const admission = resolveTransportQueueEntryAdmission(sessionName, entry);');
    const resendDispatch = manager.indexOf('deliverTransportResendEntry(runtime, entry, ownership)');
    const runtimeGate = manager.indexOf('runtime.pendingDrainAdmission = (entry) => resolveTransportQueueEntryAdmission(sessionName, entry);');

    expect(resendGate).toBeGreaterThanOrEqual(0);
    expect(resendGate).toBeLessThan(resendDispatch);
    expect(runtimeGate).toBeGreaterThan(resendDispatch);
  });

  it('kills either-edge regression to the stale boolean-authorizer literal', () => {
    const manager = readFileSync(new URL('../../src/agent/session-manager.ts', import.meta.url), 'utf8');
    const admission = readFileSync(new URL('../../src/daemon/delegation-reply-task-liveness.ts', import.meta.url), 'utf8');
    const resendResolver = 'const admission = resolveTransportQueueEntryAdmission(sessionName, entry);';
    const runtimeResolver = 'runtime.pendingDrainAdmission = (entry) => resolveTransportQueueEntryAdmission(sessionName, entry);';
    const staleBooleanLiteral = 'authorizeQueuedSupervisionHeartbeatDelivery({';
    const triStateHeartbeat = 'const supervision = resolveQueuedSupervisionHeartbeatDelivery({';

    const preservesBothTriStateEdges = (source: string, shared = admission): boolean => (
      source.includes(resendResolver)
      && source.includes(runtimeResolver)
      && !source.includes(staleBooleanLiteral)
      && shared.includes(triStateHeartbeat)
      && !shared.includes(staleBooleanLiteral)
    );

    expect(preservesBothTriStateEdges(manager)).toBe(true);
    expect(preservesBothTriStateEdges(manager.replace(
      resendResolver,
      `const admission = ${staleBooleanLiteral}`,
    )), 'resend edge mutant collapses stale/retry into boolean').toBe(false);
    expect(preservesBothTriStateEdges(manager.replace(
      runtimeResolver,
      `runtime.pendingDrainAdmission = (entry) => ${staleBooleanLiteral}`,
    )), 'runtime FIFO edge mutant collapses stale/retry into boolean').toBe(false);
    expect(preservesBothTriStateEdges(manager, admission.replace(
      triStateHeartbeat,
      `const supervision = ${staleBooleanLiteral}`,
    )), 'shared admission mutant collapses stale/retry into boolean').toBe(false);
  });

  it('pins the single resend-to-runtime handoff transfer and kills release/reinsert mutants', () => {
    const resend = readFileSync(new URL('../../src/daemon/transport-resend-queue.ts', import.meta.url), 'utf8');
    const manager = readFileSync(new URL('../../src/agent/session-manager.ts', import.meta.url), 'utf8');
    const delivery = readFileSync(new URL('../../src/agent/transport-resend-delivery.ts', import.meta.url), 'utf8');
    const runtime = readFileSync(new URL('../../src/agent/transport-session-runtime.ts', import.meta.url), 'utf8');
    const dispatchTransfer = 'dispatch(entry, { clientMessageId, handoffId })';
    const release = 'releaseHandoff(sessionName, handoffId, [clientMessageId])';

    const preservesExactlyOnceTransfer = (sources: {
      resend: string; manager: string; delivery: string; runtime: string;
    }): boolean => {
      const drainStart = sources.resend.indexOf('export async function drainResend(');
      const dispatchIndex = sources.resend.indexOf(dispatchTransfer, drainStart);
      const firstReleaseIndex = sources.resend.indexOf(release, drainStart);
      return drainStart >= 0
        && dispatchIndex > drainStart
        && firstReleaseIndex > dispatchIndex
        && sources.manager.includes('deliverTransportResendEntry(runtime, entry, ownership)')
        && sources.delivery.includes('queueHandoff: ownership')
        && sources.delivery.includes('entry.clientMessageId ?? entry.commandId')
        && sources.runtime.includes('if (entry.queueHandoff) {')
        && sources.runtime.includes('if (!entry.queueHandoff) this._pendingVersion++')
        && sources.runtime.includes('if (entry.queueHandoff) addReservation(entry.queueHandoff.handoffId, entry.clientMessageId)');
    };
    const sources = { resend, manager, delivery, runtime };
    expect(preservesExactlyOnceTransfer(sources)).toBe(true);
    expect(preservesExactlyOnceTransfer({
      ...sources,
      resend: resend.replace(
        `const dispatchResult = await ${dispatchTransfer};`,
        `getTransportQueueStore().${release};\n      const dispatchResult = await dispatch(entry, { clientMessageId, handoffId });`,
      ),
    }), 'pre-dispatch release mutant').toBe(false);
    expect(preservesExactlyOnceTransfer({
      ...sources,
      manager: manager.replace(
        'deliverTransportResendEntry(runtime, entry, ownership)',
        'deliverTransportResendEntry(runtime, entry)',
      ),
    }), 'manager ownership-drop mutant').toBe(false);
    expect(preservesExactlyOnceTransfer({
      ...sources,
      delivery: delivery.replace('queueHandoff: ownership', 'queueHandoff: undefined'),
    }), 'delivery ownership-drop mutant').toBe(false);
    expect(preservesExactlyOnceTransfer({
      ...sources,
      delivery: delivery.replaceAll('entry.clientMessageId ?? entry.commandId', 'entry.commandId'),
    }), 'commandId substitution mutant').toBe(false);
    expect(preservesExactlyOnceTransfer({
      ...sources,
      runtime: runtime.replace('if (entry.queueHandoff) {', 'if (false) {'),
    }), 'runtime reinsert mutant').toBe(false);
    expect(preservesExactlyOnceTransfer({
      ...sources,
      runtime: runtime.replace(
        'if (entry.queueHandoff) addReservation(entry.queueHandoff.handoffId, entry.clientMessageId)',
        'void entry.queueHandoff',
      ),
    }), 'APPEND reacquire mutant').toBe(false);
  });

  it('wires same-instance epoch rebinding and dead-runtime lease recovery before resend drain', () => {
    const source = readFileSync(new URL('../../src/agent/session-manager.ts', import.meta.url), 'utf8');
    const launch = source.slice(source.indexOf('async function launchTransportSessionInner'));
    const canonicalize = launch.indexOf('runtime.adoptOrRebindQueueRecipient()');
    const upsert = launch.indexOf('upsertSession(record);');
    const rebind = launch.indexOf('runtime.rebindQueueRecipient(runtimeRecipient, persistedRecipient)');
    const publish = launch.indexOf('emitSessionPersist(persistedRecord ?? record, name);');
    const recover = launch.indexOf("await recoverPersistedTransportQueue(runtime, name, 'launch')");
    const helper = source.slice(
      source.indexOf('async function recoverPersistedTransportQueue'),
      source.indexOf('/** Drain control traffic', source.indexOf('async function recoverPersistedTransportQueue')),
    );
    const prove = helper.indexOf('runtime.adoptOrRebindQueueRecipient()');
    const reclaim = helper.indexOf('restoreExpiredHandoffs(sessionName, Date.now(), { includeUnexpired: true })');
    const drain = helper.indexOf('await drainTransportResendQueueIntoRuntime(runtime, sessionName, context)');

    expect(canonicalize).toBeGreaterThanOrEqual(0);
    expect(upsert).toBeGreaterThan(canonicalize);
    expect(rebind).toBeGreaterThan(upsert);
    expect(publish).toBeGreaterThan(rebind);
    expect(recover).toBeGreaterThan(publish);
    expect(prove).toBeGreaterThanOrEqual(0);
    expect(reclaim).toBeGreaterThan(prove);
    expect(drain).toBeGreaterThan(reclaim);
  });

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
