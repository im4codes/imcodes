/**
 * Unit tests for the EmbeddingPool main-thread client.
 *
 * We never spawn a real worker_threads worker here — that would pull in
 * @huggingface/transformers and a 700 MB model. Instead the pool is
 * constructed with an injected `workerFactory` returning an EventEmitter
 * that mimics the Worker API surface we depend on (`postMessage`, `on`,
 * `terminate`, `unref`).
 *
 * The tests pin the protocol invariants the route and daemon fallback
 * rely on: single-flight per id, structured-clone payload, sticky-disable
 * on deterministic failures, timeout rejection, optimistic queueing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { EmbeddingPool } from '../src/util/embedding-pool.js';
import { EMBEDDING_DIM } from '../../shared/embedding-config.js';

type WorkerMessage = unknown;

class FakeWorker extends EventEmitter {
  posted: WorkerMessage[] = [];
  terminated = false;
  postMessage(msg: WorkerMessage): void {
    this.posted.push(msg);
  }
  unref(): void { /* no-op */ }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

function makePool(): { pool: EmbeddingPool; getWorker: () => FakeWorker } {
  let lastWorker: FakeWorker | null = null;
  const pool = new EmbeddingPool(() => {
    lastWorker = new FakeWorker();
    return lastWorker as unknown as import('node:worker_threads').Worker;
  });
  return { pool, getWorker: () => {
    if (!lastWorker) throw new Error('worker not yet spawned');
    return lastWorker;
  } };
}

function freshFloat(dim = EMBEDDING_DIM, seed = 1): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = (i + seed) * 0.001;
  return v;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EmbeddingPool basic flow', () => {
  it('spawns the worker lazily on the first embed call, not in the constructor', () => {
    const { pool, getWorker } = makePool();
    expect(() => getWorker()).toThrow();
    void pool.embed('hello'); // do not await — we just want to trigger spawn
    expect(getWorker().posted.length).toBe(1);
  });

  it('routes a result back to the matching pending request by id', async () => {
    const { pool, getWorker } = makePool();
    const promise = pool.embed('hello');
    const worker = getWorker();
    const sent = worker.posted[0] as { id: number; type: string; text: string };
    expect(sent.type).toBe('embed');
    expect(sent.text).toBe('hello');
    expect(typeof sent.id).toBe('number');

    const embedding = freshFloat();
    worker.emit('message', { id: sent.id, type: 'result', embedding });

    const got = await promise;
    expect(got).not.toBeNull();
    expect(got).toBeInstanceOf(Float32Array);
    expect(got!.length).toBe(EMBEDDING_DIM);
    expect(got![5]).toBeCloseTo(embedding[5]);
  });

  it('routes responses correctly when many requests are in flight at once', async () => {
    const { pool, getWorker } = makePool();
    const a = pool.embed('a');
    const b = pool.embed('b');
    const c = pool.embed('c');
    const worker = getWorker();
    expect(worker.posted.length).toBe(3);

    const ids = (worker.posted as Array<{ id: number }>).map((m) => m.id);
    // Reply out-of-order to verify the pool routes by id, not by FIFO.
    worker.emit('message', { id: ids[2], type: 'result', embedding: freshFloat(EMBEDDING_DIM, 30) });
    worker.emit('message', { id: ids[0], type: 'result', embedding: freshFloat(EMBEDDING_DIM, 10) });
    worker.emit('message', { id: ids[1], type: 'result', embedding: freshFloat(EMBEDDING_DIM, 20) });

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra![0]).toBeCloseTo((0 + 10) * 0.001);
    expect(rb![0]).toBeCloseTo((0 + 20) * 0.001);
    expect(rc![0]).toBeCloseTo((0 + 30) * 0.001);
  });

  it('reuses the same worker across many calls (singleton, not per-call)', async () => {
    const { pool, getWorker } = makePool();
    const p1 = pool.embed('first');
    const w1 = getWorker();
    p1.catch(() => { /* abandon */ });

    const p2 = pool.embed('second');
    const w2 = getWorker();
    p2.catch(() => { /* abandon */ });

    expect(w1).toBe(w2);
  });
});

describe('EmbeddingPool error handling', () => {
  it('rejects requests that exceed the per-call timeout', async () => {
    vi.useFakeTimers();
    const { pool } = makePool();
    // Attach the catch handler synchronously so the rejection is observed
    // before vitest's microtask scanner sees an "unhandled" promise.
    const caught = pool.embed('hello', 50).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(60);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out after 50ms/);
  });

  it('returns null when the pool is permanently disabled', async () => {
    const pool = new EmbeddingPool(() => { throw new Error('worker spawn failed'); });
    const v = await pool.embed('hello');
    expect(v).toBeNull();
    expect(pool.isAvailable()).toBe(false);
    expect(pool.getDisableReason()).toContain('worker spawn failed');
  });

  it('sticky-disables on MODULE_NOT_FOUND from the worker (regression: detect-libc empty dir)', async () => {
    const { pool, getWorker } = makePool();
    const promise = pool.embed('hello');
    const worker = getWorker();
    const id = (worker.posted[0] as { id: number }).id;
    worker.emit('message', { id, type: 'error', code: 'MODULE_NOT_FOUND', message: "Cannot find module 'detect-libc'" });
    await expect(promise).rejects.toThrow(/detect-libc/);

    expect(pool.isAvailable()).toBe(false);
    expect(pool.getDisableReason()).toBe('MODULE_NOT_FOUND');

    // Subsequent calls short-circuit to null (no second worker spawn, no message posted).
    const second = await pool.embed('again');
    expect(second).toBeNull();
  });

  it('sticky-disables on ERR_DLOPEN_FAILED (CPU lacks AVX2 / DLL init failure)', async () => {
    const { pool, getWorker } = makePool();
    const promise = pool.embed('hello');
    const worker = getWorker();
    const id = (worker.posted[0] as { id: number }).id;
    worker.emit('message', { id, type: 'error', code: 'ERR_DLOPEN_FAILED', message: 'dlopen failed' });
    await expect(promise).rejects.toThrow();
    expect(pool.isAvailable()).toBe(false);
    expect(pool.getDisableReason()).toBe('ERR_DLOPEN_FAILED');
  });

  it('does NOT sticky-disable on transient errors (no recognized code)', async () => {
    const { pool, getWorker } = makePool();
    const promise = pool.embed('hello');
    const worker = getWorker();
    const id = (worker.posted[0] as { id: number }).id;
    worker.emit('message', { id, type: 'error', code: 'ETIMEOUT', message: 'transient' });
    await expect(promise).rejects.toThrow();

    // Still available; another call spawns OK and gets routed.
    expect(pool.isAvailable()).toBe(true);
  });

  it('rejects all pending requests when the worker emits "error"', async () => {
    const { pool, getWorker } = makePool();
    const a = pool.embed('a');
    const b = pool.embed('b');
    const worker = getWorker();
    worker.emit('error', new Error('worker crashed'));
    await expect(a).rejects.toThrow(/worker crashed/);
    await expect(b).rejects.toThrow(/worker crashed/);
    expect(pool.isAvailable()).toBe(false);
  });

  it('rejects all pending and sticky-disables on non-zero exit code', async () => {
    const { pool, getWorker } = makePool();
    const promise = pool.embed('hello');
    const worker = getWorker();
    worker.emit('exit', 137); // OOM-kill
    await expect(promise).rejects.toThrow(/embedding_worker_exit:137/);
    expect(pool.isAvailable()).toBe(false);
    expect(pool.getDisableReason()).toBe('worker_exit_137');
  });

  it('rejects payload with wrong embedding length (defends against future model swap)', async () => {
    const { pool, getWorker } = makePool();
    const promise = pool.embed('hello');
    const worker = getWorker();
    const id = (worker.posted[0] as { id: number }).id;
    worker.emit('message', { id, type: 'result', embedding: new Float32Array(7) });
    await expect(promise).rejects.toThrow(/invalid payload/);
  });
});

describe('EmbeddingPool destroy', () => {
  it('terminates the worker and rejects pending requests', async () => {
    const { pool, getWorker } = makePool();
    const promise = pool.embed('hello');
    const worker = getWorker();
    await pool.destroy();
    expect(worker.terminated).toBe(true);
    await expect(promise).rejects.toThrow(/embedding pool destroyed/);
  });

  it('is idempotent (second destroy is a no-op)', async () => {
    const { pool, getWorker } = makePool();
    pool.embed('warm').catch(() => { /* abandoned */ });
    getWorker(); // ensure spawn
    await pool.destroy();
    await pool.destroy(); // does not throw
  });
});
