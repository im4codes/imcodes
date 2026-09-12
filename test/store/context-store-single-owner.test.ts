/**
 * SINGLE-OWNER invariant across generation retirement.
 *
 * ## The defect
 *
 * `markWorkerUnavailable` cleared the current worker, fired
 * `dead.terminate()` WITHOUT awaiting it, and then armed the rebuild timer
 * independently. `terminate()` sends SIGTERM and only resolves on the child's
 * `exit`, so a child wedged inside a blocking SQLite call never settles it -
 * which is precisely the hang scenario that triggers a respawn in the first
 * place. Once the backoff elapsed, `ensureWorker()` created a NEW generation
 * while the old OS process was still alive and still able to hold and write the
 * database.
 *
 * Generation fencing does NOT cover this: it discards the old generation's IPC
 * replies, but it cannot undo that process's side effects on disk.
 *
 * The previous suite could not catch it because its FakeWorker resolved
 * `terminate()` immediately, so the boundary was never exercised.
 *
 * ## The contract pinned here
 *
 *  - retirement invalidates the old generation's IPC immediately, but NO new
 *    generation may be created until that generation's exit is CONFIRMED;
 *  - if graceful termination is not confirmed within a hard upper bound, the
 *    owner escalates to a bounded force kill;
 *  - if even that is not confirmed, the client stays unavailable / fail-closed
 *    rather than create a second owner;
 *  - confirming exit creates EXACTLY ONE successor;
 *  - late `ready` / response / `exit` from the retiring generation are inert.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_STORE_RPC_ERROR,
  CONTEXT_STORE_RPC_SELF_HEAL,
  CONTEXT_STORE_WORKER_HEALTH,
  type ContextStoreRpcRequest,
} from '../../shared/context-store-rpc.js';
import { ContextStoreWorkerClient } from '../../src/store/context-store-worker-client.js';

const {
  consecutiveTimeoutsBeforeRespawn,
  respawnCooldownMs,
  timeoutBackoffBaseMs,
  terminateConfirmMs,
  forceKillConfirmMs,
} = CONTEXT_STORE_RPC_SELF_HEAL;

/** A worker whose `terminate()` NEVER settles - the hung-child case. */
class HangingWorker extends EventEmitter {
  readonly unref = vi.fn();
  readonly postMessage = vi.fn((_message: ContextStoreRpcRequest) => {});
  readonly forceKill = vi.fn();
  readonly terminate = vi.fn(() => new Promise<number>(() => {}));

  lastRequest(): ContextStoreRpcRequest {
    const calls = this.postMessage.mock.calls;
    if (calls.length === 0) throw new Error('nothing was dispatched into this worker');
    return calls[calls.length - 1][0];
  }
}

function createHarness() {
  const workers: HangingWorker[] = [];
  const client = new ContextStoreWorkerClient(() => {
    const worker = new HangingWorker();
    workers.push(worker);
    return worker as never;
  });
  return { client, workers };
}

/** Drive a ready generation into a timeout-triggered respawn. */
async function tripRespawn(client: ContextStoreWorkerClient, tag: string): Promise<void> {
  for (let i = 0; i < consecutiveTimeoutsBeforeRespawn; i += 1) {
    const pending = client.run('getContextMeta', [`${tag}-${i}`], { timeoutMs: 1 });
    const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  }
}

async function startReady(client: ContextStoreWorkerClient, workers: HangingWorker[]): Promise<void> {
  client.start();
  workers[0].emit('message', { type: 'ready' });
  await client.whenReady();
  expect(client.isReady).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('generation retirement gates the next generation on confirmed exit', () => {
  it('creates NO successor while termination hangs, across every backoff window', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    await startReady(client, workers);

    await tripRespawn(client, 'hang');
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(client.getHealthSnapshot().state).toBe(CONTEXT_STORE_WORKER_HEALTH.retiring);
    expect(client.getHealthSnapshot().retiringGeneration).toBe(1);

    // Far past the timeout backoff AND the 60s cap: the old generation has not
    // confirmed exit, so there must still be exactly one generation.
    await vi.advanceTimersByTimeAsync(respawnCooldownMs * 6);
    expect(workers).toHaveLength(1);
    expect(client.isReady).toBe(false);

    // Every dispatch path declines rather than spawning a second owner.
    await expect(client.run('getContextMeta', ['blocked'])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });
    await expect(client.call('getContextMeta', ['blocked-direct'])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });
    await expect(client.whenReady()).resolves.toBeUndefined();
    client.fireAndForget('recordMemoryHits', [[]]);
    expect(workers).toHaveLength(1);

    client.dispose();
  });

  it('escalates to a bounded force kill and still refuses a second owner', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    await startReady(client, workers);
    await tripRespawn(client, 'force');

    expect(workers[0].forceKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(terminateConfirmMs);
    expect(workers[0].forceKill).toHaveBeenCalledTimes(1);
    expect(client.getHealthSnapshot().retirementForced).toBe(true);
    expect(workers).toHaveLength(1);

    // Even after the post-kill window, an unconfirmed exit must keep the client
    // unavailable - fail closed beats two writers.
    await vi.advanceTimersByTimeAsync(forceKillConfirmMs + respawnCooldownMs);
    expect(workers).toHaveLength(1);
    expect(client.getHealthSnapshot().state).toBe(CONTEXT_STORE_WORKER_HEALTH.retiring);
    await expect(client.run('getContextMeta', ['still-blocked'])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });

    client.dispose();
  });

  it('creates EXACTLY ONE successor once exit is confirmed', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    await startReady(client, workers);
    await tripRespawn(client, 'confirm');
    await vi.advanceTimersByTimeAsync(respawnCooldownMs * 3);
    expect(workers).toHaveLength(1);

    // The authoritative confirmation: the process is gone.
    workers[0].emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(workers).toHaveLength(2);
    expect(client.getHealthSnapshot().retiringGeneration).toBeNull();

    // And only one, even after more time passes.
    await vi.advanceTimersByTimeAsync(respawnCooldownMs * 3);
    expect(workers).toHaveLength(2);

    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();
    expect(client.isReady).toBe(true);
    expect(client.getHealthSnapshot().state).toBe(CONTEXT_STORE_WORKER_HEALTH.ready);
    client.dispose();
  });

  it('ignores late ready / response / exit from the retiring generation', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    await startReady(client, workers);

    // Drive the respawn with exactly the strike budget, capturing the FIRST
    // request id so the retiring generation has a live id it could still answer.
    // (Spending an extra timeout beforehand would trip the respawn early and the
    // last request would be refused rather than timed out.)
    let orphanId = 0;
    for (let i = 0; i < consecutiveTimeoutsBeforeRespawn; i += 1) {
      const pending = client.run('getContextMeta', [`late-${i}`], { timeoutMs: 1 });
      const assertion = expect(pending).rejects.toMatchObject({
        code: CONTEXT_STORE_RPC_ERROR.timeout,
      });
      if (i === 0) orphanId = workers[0].lastRequest().id;
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    }
    expect(orphanId).toBeGreaterThan(0);
    expect(client.getHealthSnapshot().state).toBe(CONTEXT_STORE_WORKER_HEALTH.retiring);

    // A retiring generation is still "current" by number until its successor
    // exists, so these must be rejected by the retirement rule, not by luck.
    workers[0].emit('message', { type: 'ready' });
    expect(client.isReady).toBe(false);
    workers[0].emit('message', { id: orphanId, ok: true, result: 'stale' });
    expect(client.isReady).toBe(false);
    expect(client.getHealthSnapshot().consecutiveTimeoutRespawns).toBe(1);
    expect(workers).toHaveLength(1);

    // Confirm exit, then prove a SECOND exit from the dead generation cannot
    // disturb the successor. Confirmation clears the single-owner GATE; the
    // timeout backoff still governs WHEN the successor appears, so advance it.
    workers[0].emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getHealthSnapshot().retiringGeneration).toBeNull();
    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs);
    expect(workers).toHaveLength(2);
    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();

    workers[0].emit('exit', 1);
    workers[0].emit('message', { type: 'ready', warmupError: 'stale warmup' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.isReady).toBe(true);
    expect(workers).toHaveLength(2);
    expect(client.getHealthSnapshot().state).toBe(CONTEXT_STORE_WORKER_HEALTH.ready);

    client.dispose();
  });

  it('does not gate when the generation already exited on its own', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    await startReady(client, workers);

    // A self-exit is already confirmation, so no retirement gate is opened and
    // recovery proceeds on the normal bounded path.
    workers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getHealthSnapshot().retiringGeneration).toBeNull();
    expect(workers[0].terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(timeoutBackoffBaseMs);
    expect(workers.length).toBeGreaterThanOrEqual(2);
    client.dispose();
  });
});
