import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTEXT_STORE_RPC_ERROR } from '../../shared/context-store-rpc.js';
import {
  getContextStoreClient,
  resetContextStoreClientForTests,
} from '../../src/store/context-store-worker-client.js';
import { resetContextStoreForTests } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

/**
 * Production-owner failure policy (OpenSpec context-store-worker-isolation,
 * REWORK pass). Once `start()` declares the worker the production DB owner,
 * `run()` / `callOrElse()` MUST reject with `context_store_unavailable` while the
 * worker is not warm — NOT fall back to a main-thread in-process op (which would
 * open a second SQLite connection behind the single-owner worker). Tests / CLI
 * (no `start()`) keep the in-process cold-fallback path. `fireAndForget` accepts
 * only the narrowed fire-and-forget ops.
 */
describe('context-store production-owner failure policy', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('context-store-prod-owner');
  });

  afterEach(async () => {
    resetContextStoreClientForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  // A1: started=true + worker not-yet-warm -> run()/callOrElse() REJECT.
  it('rejects run() / callOrElse() with context_store_unavailable in production-owner mode before warm', async () => {
    resetContextStoreClientForTests();
    const c = getContextStoreClient();
    c.start(); // spawns the worker on a separate thread; it cannot post `ready`
    // within this microtask, so the client is the declared owner but NOT warm.
    expect(c.isProductionOwner).toBe(true);
    expect(c.isReady).toBe(false);

    await expect(c.run('getProcessedProjectionById', ['nope'])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });

    // callOrElse MUST reject in owner mode too — it must NOT silently invoke the
    // provided fallback closure (that closure exists only for the tests/CLI path).
    let fallbackInvoked = false;
    await expect(
      c.callOrElse('getProcessedProjectionById', ['nope'], () => {
        fallbackInvoked = true;
        return 'FALLBACK';
      }),
    ).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unavailable });
    expect(fallbackInvoked).toBe(false);
  });

  // A2: started=false (no start) -> run()/callOrElse use the in-process cold path.
  it('uses the in-process cold fallback for run() / callOrElse() when not a production owner', async () => {
    resetContextStoreClientForTests();
    const c = getContextStoreClient(); // do NOT call start()
    expect(c.isProductionOwner).toBe(false);

    // run() dispatches the op in-process via the shared op-handler map; a missing
    // id on the empty isolated DB resolves to undefined (no throw, no reject).
    await expect(c.run('getProcessedProjectionById', ['nope'])).resolves.toBeUndefined();

    // callOrElse: worker not warm + !started -> the fallback closure runs.
    const viaFallback = await c.callOrElse('getProcessedProjectionById', ['nope'], () => 'FALLBACK');
    expect(viaFallback).toBe('FALLBACK');
  });

  // A3: fireAndForget accepts a narrowed fire-and-forget op, refuses anything else.
  it('fireAndForget accepts a fire-and-forget op and no-ops a non-fire-and-forget op', () => {
    resetContextStoreClientForTests();
    const c = getContextStoreClient();

    // A legitimate fire-and-forget op is accepted: it spawns the worker lazily and
    // enqueues a pending entry (count goes to 1).
    expect(c.pendingFireAndForgetCount).toBe(0);
    c.fireAndForget('recordMemoryHits', [['x']]);
    expect(c.pendingFireAndForgetCount).toBe(1);

    // A durable mutation cast through the fire-and-forget lane is refused by the
    // runtime `isFireAndForgetOp` guard: it must NOT throw and must NOT enqueue
    // (the pending count is unchanged — the op was dropped before dispatch).
    const before = c.pendingFireAndForgetCount;
    expect(() => c.fireAndForget('writeContextObservation' as never, [{}])).not.toThrow();
    expect(c.pendingFireAndForgetCount).toBe(before);
  });

  // D: a worker warmup failure must NOT advertise the client as warm. We drive
  // the real warmup-failure path through the public API by pointing the worker's
  // DB path at a directory (so `ensureDb()` throws); the worker then posts
  // `{type:'ready', warmupError}`, which resolves `whenReady()` but keeps
  // `isReady` false — and in owner mode the failure policy still rejects.
  it('does not advertise warm when the worker reports a warmup failure', async () => {
    // `tempDir` (a directory) is the isolated DB *folder*; opening it AS the
    // sqlite file fails, which is exactly the warmup-failure trigger. Re-point
    // the store DB path at the directory and reset the store so the worker spawns
    // against it. The harness `afterEach` clears IMCODES_CONTEXT_DB_PATH.
    process.env.IMCODES_CONTEXT_DB_PATH = tempDir;
    resetContextStoreForTests();
    resetContextStoreClientForTests();

    const c = getContextStoreClient();
    c.start();
    expect(c.isProductionOwner).toBe(true);

    // whenReady() must resolve (callers never hang) even though warmup failed…
    await c.whenReady();
    // …but the client must NOT claim to be warm.
    expect(c.isReady).toBe(false);

    // And owner-mode failure policy holds: an awaited op rejects (no main-thread
    // in-process fallback while the worker owner is unavailable).
    await expect(c.run('getProcessedProjectionById', ['nope'])).rejects.toMatchObject({
      code: CONTEXT_STORE_RPC_ERROR.unavailable,
    });
  }, 20_000);
});
