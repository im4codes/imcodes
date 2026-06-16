import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CONTEXT_STORE_RPC_ERROR } from '../../shared/context-store-rpc.js';
import { ContextStoreWorkerClient } from '../../src/store/context-store-worker-client.js';

class FakeWorker extends EventEmitter {
  readonly unref = vi.fn();
  readonly terminate = vi.fn(async () => 0);
  postMessage = vi.fn((_message: unknown) => {});
}

function createHarness(postMessage?: FakeWorker['postMessage']) {
  const workers: FakeWorker[] = [];
  const client = new ContextStoreWorkerClient(() => {
    const worker = new FakeWorker();
    if (postMessage) worker.postMessage = postMessage;
    workers.push(worker);
    return worker as never;
  });
  return { client, workers };
}

describe('context-store worker client lifecycle repair', () => {
  it('settles whenReady and respawns after warmup failure without accepting stale ready messages', async () => {
    const { client, workers } = createHarness();
    client.start();
    expect(workers).toHaveLength(1);
    const firstReady = client.whenReady();

    workers[0].emit('message', { type: 'ready', warmupError: 'bad db' });
    await firstReady;
    expect(client.isReady).toBe(false);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);

    await expect(client.run('getContextMeta', ['k'])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });
    expect(workers).toHaveLength(2);

    workers[0].emit('message', { type: 'ready' });
    expect(client.isReady).toBe(false);

    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();
    expect(client.isReady).toBe(true);
    client.dispose();
  });

  it('settles whenReady on pre-ready clean exit', async () => {
    const { client, workers } = createHarness();
    const ready = client.whenReady();
    expect(workers).toHaveLength(1);
    workers[0].emit('exit', 0);
    await expect(ready).resolves.toBeUndefined();
    expect(client.isReady).toBe(false);
    client.dispose();
  });

  it('cleans pending awaited RPCs when postMessage cannot clone args', async () => {
    const cloneFailure = new DOMException('function could not be cloned', 'DataCloneError');
    const { client } = createHarness(vi.fn(() => { throw cloneFailure; }));
    await expect(client.call('getContextMeta', [() => undefined as never])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.cloneError,
    });
    expect(client.pendingAwaitedCount).toBe(0);
    client.dispose();
  });

  it('swallows fire-and-forget clone errors and clears the pending slot', () => {
    const { client } = createHarness(vi.fn(() => { throw new DOMException('bad clone', 'DataCloneError'); }));
    expect(() => client.fireAndForget('recordMemoryHits', [() => undefined as never])).not.toThrow();
    expect(client.pendingFireAndForgetCount).toBe(0);
    client.dispose();
  });


  it('respawns on the next production request after consecutive awaited timeouts', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();
    expect(client.isReady).toBe(true);

    for (let i = 0; i < 3; i += 1) {
      const pending = client.run('getContextMeta', [`timeout-${i}`], { timeoutMs: 1 });
      const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    }

    expect(client.isReady).toBe(false);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(1);

    await expect(client.run('getContextMeta', ['during-cooldown'])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });
    expect(workers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(client.run('getContextMeta', ['after-timeout'])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });
    expect(workers).toHaveLength(2);
    workers[1].emit('message', { type: 'ready' });
    await client.whenReady();
    expect(client.isReady).toBe(true);
    client.dispose();
    vi.useRealTimers();
  });

  it('does not respawn via fire-and-forget during the respawn cooldown (audit H-B)', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    for (let i = 0; i < 3; i += 1) {
      const pending = client.run('getContextMeta', [`timeout-${i}`], { timeoutMs: 1 });
      const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    }
    expect(client.isReady).toBe(false);
    expect(workers).toHaveLength(1);

    // Fire-and-forget during the cooldown MUST NOT respawn the worker — that would
    // defeat the respawn-storm throttle that run/callOrElse/callR1OrEmpty honor.
    client.fireAndForget('recordMemoryHits', [[]]);
    expect(workers).toHaveLength(1);

    // After the cooldown elapses, fire-and-forget may drive a respawn again.
    await vi.advanceTimersByTimeAsync(60_000);
    client.fireAndForget('recordMemoryHits', [[]]);
    expect(workers).toHaveLength(2);
    client.dispose();
    vi.useRealTimers();
  });

  it('does not let whenReady bypass respawn cooldown after consecutive timeouts', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    for (let i = 0; i < 3; i += 1) {
      const pending = client.run('getContextMeta', [`timeout-${i}`], { timeoutMs: 1 });
      const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    }

    expect(client.isReady).toBe(false);
    expect(workers).toHaveLength(1);

    await expect(client.whenReady()).resolves.toBeUndefined();
    expect(client.isReady).toBe(false);
    expect(workers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const readyAfterCooldown = client.whenReady();
    expect(workers).toHaveLength(2);
    workers[1].emit('message', { type: 'ready' });
    await expect(readyAfterCooldown).resolves.toBeUndefined();
    expect(client.isReady).toBe(true);

    client.dispose();
    vi.useRealTimers();
  });

  it('does not mask dispatched RPC errors as unavailable in production owner mode', async () => {
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();

    const pending = client.run('getContextMeta', ['k']);
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    const request = workers[0].postMessage.mock.calls[0][0] as { id: number };
    workers[0].emit('message', {
      id: request.id,
      ok: false,
      error: { code: CONTEXT_STORE_RPC_ERROR.opFailed, message: 'boom' },
    });
    await expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.opFailed });
    client.dispose();
  });

  it('throttles a SECOND consecutive warmup/crash failure with backoff and recovers after it (audit N-1)', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    // 1st warmup failure → immediate retry allowed (transient fast-recovery preserved).
    workers[0].emit('message', { type: 'ready', warmupError: 'bad db 1' });
    await expect(client.run('getContextMeta', ['k1'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(2);
    // 2nd consecutive warmup failure (no successful op served between) → now backing off.
    workers[1].emit('message', { type: 'ready', warmupError: 'bad db 2' });
    await expect(client.run('getContextMeta', ['k2'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(2); // throttled: NO new worker spawned during backoff
    // after the warmup backoff elapses, the next request respawns.
    await vi.advanceTimersByTimeAsync(500);
    await expect(client.run('getContextMeta', ['k3'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(3);
    client.dispose();
    vi.useRealTimers();
  });

  it('throttles a direct call() during the warmup/crash backoff — all dispatch paths (audit N-1)', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready', warmupError: 'bad db 1' });
    await expect(client.run('getContextMeta', ['k1'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    workers[1].emit('message', { type: 'ready', warmupError: 'bad db 2' });
    await expect(client.run('getContextMeta', ['k2'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(2); // backing off
    // A DIRECT call() during backoff MUST reject unavailable WITHOUT spawning or leaking a pending slot.
    await expect(client.call('getContextMeta', ['direct'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(2);
    expect(client.pendingAwaitedCount).toBe(0);
    client.dispose();
    vi.useRealTimers();
  });

  it('does not spawn via whenReady or fireAndForget during the warmup/crash backoff (audit N-1)', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready', warmupError: 'bad db 1' });
    await expect(client.run('getContextMeta', ['k1'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    workers[1].emit('message', { type: 'ready', warmupError: 'bad db 2' });
    await expect(client.run('getContextMeta', ['k2'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(2); // backing off
    await expect(client.whenReady()).resolves.toBeUndefined();
    expect(workers).toHaveLength(2);
    expect(client.isReady).toBe(false);
    client.fireAndForget('recordMemoryHits', [[]]);
    expect(workers).toHaveLength(2);
    client.dispose();
    vi.useRealTimers();
  });

  it('counts a warmupError and its terminate-induced exit as ONE failure (per-generation dedup, audit N-1)', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    // warmupError tears down generation 1; a follow-on exit on the SAME generation must NOT re-count.
    workers[0].emit('message', { type: 'ready', warmupError: 'bad db' });
    workers[0].emit('exit', 1);
    // Still the FIRST failure → next request respawns immediately (not backing off).
    await expect(client.run('getContextMeta', ['k1'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(2);
    client.dispose();
    vi.useRealTimers();
  });

  it('keeps the timeout cooldown and warmup/crash backoff independent — a timeout respawn does not arm the warmup backoff (audit N-1)', async () => {
    vi.useFakeTimers();
    const { client, workers } = createHarness();
    client.start();
    workers[0].emit('message', { type: 'ready' });
    await client.whenReady();
    // 3 consecutive awaited timeouts → timeout-respawn (reason=timeout_respawn; MUST NOT arm warmup backoff).
    for (let i = 0; i < 3; i += 1) {
      const pending = client.run('getContextMeta', [`t-${i}`], { timeoutMs: 1 });
      const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    }
    expect(workers).toHaveLength(1);
    // Past the 60s timeout cooldown a request respawns (cooldown over, warmup counter still 0).
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(client.run('getContextMeta', ['after'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(2);
    // The respawned worker fails warmup ONCE → because timeout never polluted the warmup
    // counter, this is the FIRST warmup failure → immediate retry (count 0→1, not throttled).
    workers[1].emit('message', { type: 'ready', warmupError: 'bad db' });
    await expect(client.run('getContextMeta', ['w'])).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(workers).toHaveLength(3);
    client.dispose();
    vi.useRealTimers();
  });
});
