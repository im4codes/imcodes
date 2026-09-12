/**
 * Context-store worker SELF-RECOVERY regressions.
 *
 * Field incident: daemon.log showed repeated "context-store RPC timed out",
 * after which `listReplicationStates` / `listDirtyTargets` /
 * `selectTurnUsageSyncBatch` kept failing with "context-store worker
 * unavailable" and the store never came back on its own.
 *
 * Two distinct defects are pinned here:
 *
 *  1. Recovery was purely REQUEST-DRIVEN. `respawn()` tore the generation down
 *     and only `maybeRespawn()` on a later call could rebuild it, so a quiet
 *     period (or callers that stopped retrying after their own failures) left
 *     the store down indefinitely. There is now an automatic, unref'd,
 *     bounded-exponential rebuild timer.
 *
 *  2. `consecutiveTimeouts` was NOT reset per generation, so the >=3 strikes
 *     that killed generation N carried into generation N+1 and the very first
 *     slow RPC on the fresh worker tore it down again - an unbounded tear-down
 *     loop that could never reach a served op.
 *
 * Plus the in-flight retry-class policy: a request that was DISPATCHED and then
 * lost to a worker death/timeout has an UNKNOWN outcome, so append / lease /
 * commit-bundle ops must surface `indeterminate` instead of a retryable error.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_STORE_OP_RETRY_CLASS,
  CONTEXT_STORE_RPC_ERROR,
  CONTEXT_STORE_RPC_OPS,
  CONTEXT_STORE_RPC_SELF_HEAL,
  CONTEXT_STORE_UNSAFE_RETRY_OPS,
  CONTEXT_STORE_WORKER_DOWN_REASON,
  CONTEXT_STORE_WORKER_HEALTH,
  contextStoreOpRetryClass,
  type ContextStoreRpcRequest,
} from '../../shared/context-store-rpc.js';
import {
  ContextStoreWorkerClient,
  type ContextStoreHealthSnapshot,
} from '../../src/store/context-store-worker-client.js';

const { consecutiveTimeoutsBeforeRespawn, respawnCooldownMs, timeoutBackoffBaseMs } =
  CONTEXT_STORE_RPC_SELF_HEAL;

class FakeWorker extends EventEmitter {
  readonly unref = vi.fn();
  readonly terminate = vi.fn(async () => 0);
  readonly postMessage = vi.fn((_message: ContextStoreRpcRequest) => {});
  /** id of the last request the client pushed into this worker */
  lastRequest(): ContextStoreRpcRequest {
    const calls = this.postMessage.mock.calls;
    if (calls.length === 0) throw new Error('no request was dispatched into this worker');
    return calls[calls.length - 1][0];
  }
}

function createHarness() {
  const workers: FakeWorker[] = [];
  const client = new ContextStoreWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as never;
  });
  return { client, workers };
}

/** Drive `consecutiveTimeoutsBeforeRespawn` awaited timeouts on a READY worker. */
async function tripTimeoutRespawn(client: ContextStoreWorkerClient, tag: string): Promise<void> {
  for (let i = 0; i < consecutiveTimeoutsBeforeRespawn; i += 1) {
    const pending = client.run('getContextMeta', [`${tag}-${i}`], { timeoutMs: 1 });
    const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('context-store worker automatic bounded recovery', () => {
  it('rebuilds the worker on its own timer with NO caller issuing a request', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    await tripTimeoutRespawn(client, 'auto');
    expect(client.isReady).toBe(false);
    expect(workers).toHaveLength(1);

    // Nothing calls the client from here on - recovery must be self-driven.
    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs - 1);
    expect(workers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(workers).toHaveLength(2);

    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();
    expect(client.isReady).toBe(true);
    client.dispose();
  });

  it('escalates the timeout rebuild delay exponentially and caps it', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    // Episode 1 -> base delay.
    await tripTimeoutRespawn(client, 'e1');
    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs);
    expect(workers).toHaveLength(2);
    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();

    // Episode 2 with NO successful op in between -> doubled delay.
    await tripTimeoutRespawn(client, 'e2');
    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs * 2 - 1);
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers).toHaveLength(3);

    expect(client.getHealthSnapshot().consecutiveTimeoutRespawns).toBe(2);
    client.dispose();
  });

  it('never exceeds one rebuild per cleared backoff window (no respawn storm)', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();
    await tripTimeoutRespawn(client, 'storm');

    // A single very long jump must produce exactly ONE new generation, not one
    // per elapsed backoff interval.
    await vi.advanceTimersByTimeAsync(respawnCooldownMs * 10);
    expect(workers).toHaveLength(2);
    client.dispose();
  });

  it('stops rebuilding after dispose', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();
    await tripTimeoutRespawn(client, 'disposed');

    client.dispose();
    await vi.advanceTimersByTimeAsync(respawnCooldownMs * 4);
    expect(workers).toHaveLength(1);
    expect(client.getHealthSnapshot().state).toBe(CONTEXT_STORE_WORKER_HEALTH.disposed);
  });

  it('gives a FRESH generation a clean timeout strike count', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    await tripTimeoutRespawn(client, 'strike');
    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs);
    expect(workers).toHaveLength(2);
    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();
    expect(client.getHealthSnapshot().consecutiveTimeouts).toBe(0);

    // ONE slow RPC on the fresh generation must NOT tear it down: the previous
    // generation's strikes are gone. (Before the fix the inherited count was
    // already >= 3, so this single timeout respawned immediately.)
    const pending = client.run('getContextMeta', ['single'], { timeoutMs: 1 });
    const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;

    expect(client.isReady).toBe(true);
    expect(workers[1].terminate).not.toHaveBeenCalled();
    expect(workers).toHaveLength(2);
    client.dispose();
  });

  it('clears the timeout escalation once a generation actually serves an op', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    await tripTimeoutRespawn(client, 'reset');
    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs);
    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();

    // A served op is the ONLY healthy signal - it must clear the escalation.
    const ok = client.run('getContextMeta', ['served']);
    workers[1].emit('message', { id: workers[1].lastRequest().id, ok: true, result: 'v' });
    await expect(ok).resolves.toBe('v');
    expect(client.getHealthSnapshot().consecutiveTimeoutRespawns).toBe(0);

    // The next episode therefore starts from the BASE delay again, not doubled.
    await tripTimeoutRespawn(client, 'reset2');
    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs - 1);
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers).toHaveLength(3);
    client.dispose();
  });

  it('reports observable health transitions with a bounded retry delay', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    const seen: ContextStoreHealthSnapshot[] = [];
    client.setHealthObserver((snapshot) => seen.push(snapshot));
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();
    await tripTimeoutRespawn(client, 'health');

    const down = client.getHealthSnapshot();
    expect(down.state).toBe(CONTEXT_STORE_WORKER_HEALTH.backoff);
    expect(down.lastDownReason).toBe(CONTEXT_STORE_WORKER_DOWN_REASON.timeoutRespawn);
    expect(down.retryInMs).toBeGreaterThan(0);
    expect(down.retryInMs).toBeLessThanOrEqual(respawnCooldownMs);

    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs);
    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();
    expect(client.getHealthSnapshot().state).toBe(CONTEXT_STORE_WORKER_HEALTH.ready);

    const states = seen.map((s) => s.state);
    expect(states).toContain(CONTEXT_STORE_WORKER_HEALTH.starting);
    expect(states).toContain(CONTEXT_STORE_WORKER_HEALTH.ready);
    expect(states).toContain(CONTEXT_STORE_WORKER_HEALTH.backoff);
    // Transition-only: a state is never reported twice in a row.
    for (let i = 1; i < states.length; i += 1) expect(states[i]).not.toBe(states[i - 1]);
    client.dispose();
  });
});

describe('context-store in-flight retry-class policy', () => {
  it('marks a DISPATCHED unsafe-retry op indeterminate when the worker dies, and leaves reads retryable', async () => {
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    const append = client.run('recordTurnUsage', [{ turn: 1 }]);
    const read = client.run('getContextMeta', ['k']);
    const appendAssertion = expect(append).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.indeterminate,
    });
    const readAssertion = expect(read).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.workerExit,
    });

    workers[0].emit('exit', 1);
    await appendAssertion;
    await readAssertion;
    client.dispose();
  });

  it('marks a DISPATCHED unsafe-retry op indeterminate on timeout, not plain timeout', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    const lease = client.run('selectTurnUsageSyncBatch', [{ limit: 5 }], { timeoutMs: 1 });
    const assertion = expect(lease).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.indeterminate,
    });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    client.dispose();
  });

  it('keeps a NEVER-dispatched unsafe-retry op cleanly retryable', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();
    await tripTimeoutRespawn(client, 'undispatched');

    // Throttled: the request never reached a worker, so its outcome is KNOWN
    // (it did not happen) and it must stay retryable, not indeterminate.
    await expect(client.run('enqueueContextJob', [{ kind: 'x' }])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });
    client.dispose();
  });

  it('classifies every allowlisted op and fails closed on unknown names', () => {
    const ops = new Set<string>(CONTEXT_STORE_RPC_OPS);
    // A typo in the unsafe list would silently downgrade an op to safeRetry.
    for (const op of CONTEXT_STORE_UNSAFE_RETRY_OPS) {
      expect(ops.has(op), `${op} is not a real context-store RPC op`).toBe(true);
      expect(contextStoreOpRetryClass(op)).toBe(CONTEXT_STORE_OP_RETRY_CLASS.unsafeRetry);
    }
    expect(contextStoreOpRetryClass('getContextMeta')).toBe(CONTEXT_STORE_OP_RETRY_CLASS.safeRetry);
    expect(contextStoreOpRetryClass('listDirtyTargets')).toBe(CONTEXT_STORE_OP_RETRY_CLASS.safeRetry);
    expect(contextStoreOpRetryClass('listReplicationStates')).toBe(CONTEXT_STORE_OP_RETRY_CLASS.safeRetry);
    // Unclassified / future op names are assumed side-effecting.
    expect(contextStoreOpRetryClass('someBrandNewOp')).toBe(CONTEXT_STORE_OP_RETRY_CLASS.unsafeRetry);
  });
});
