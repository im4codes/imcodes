import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  CONTEXT_STORE_L1_OPS,
  CONTEXT_STORE_RPC_BACKPRESSURE,
  CONTEXT_STORE_RPC_ERROR,
  defaultPriorityForOp,
} from '../../shared/context-store-rpc.js';
import * as store from '../../src/store/context-store.js';
import { checkpointWal, writeProcessedProjection } from '../../src/store/context-store.js';
import { EMBEDDING_DIM, decodeEmbedding, encodeEmbedding } from '../../src/context/embedding.js';
import { ContextStoreWorkerClient } from '../../src/store/context-store-worker-client.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const NAMESPACE: ContextNamespace = {
  scope: 'project_shared',
  projectId: 'github.com/acme/repo',
  enterpriseId: 'ent-1',
};

describe('context-store worker foundation', () => {
  let tempDir: string;
  let client: ContextStoreWorkerClient;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('context-store-worker');
    client = new ContextStoreWorkerClient();
  });

  afterEach(async () => {
    vi.useRealTimers();
    client.dispose();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  // ── Registry integrity (the hand-maintained allowlist must match the store) ──
  it('every L1 allowlist op resolves to a callable context-store export', () => {
    const missing = CONTEXT_STORE_L1_OPS.filter(
      (op) => typeof (store as unknown as Record<string, unknown>)[op] !== 'function',
    );
    expect(missing).toEqual([]);
  });


  it('defaults authorized management recall to normal priority, not L3 high', () => {
    expect(defaultPriorityForOp('searchLocalMemoryAuthorizedBounded')).toBe('normal');
    expect(defaultPriorityForOp('searchLocalMemorySemanticBounded')).toBe('high');
  });

  // ── 1.6: client↔worker round-trip ──
  it('round-trips a write/read op through the worker', async () => {
    await client.whenReady();
    expect(client.isReady).toBe(true);
    await client.call('setContextMeta', ['greeting', 'hello-from-main']);
    const value = await client.call<string | undefined>('getContextMeta', ['greeting']);
    expect(value).toBe('hello-from-main');
  });

  // ── 1.6: structured-clone of rows + embedding BLOBs across the thread boundary ──
  it('structured-clones object rows and embedding buffers across the worker', async () => {
    await client.whenReady();
    const projection = await client.call<{ id: string; summary: string }>('writeProcessedProjection', [
      {
        namespace: NAMESPACE,
        class: 'recent_summary',
        origin: 'chat_compacted',
        sourceEventIds: ['evt-1'],
        summary: 'worker round-trip projection',
        content: { trigger: 'idle' },
        createdAt: 100,
        updatedAt: 110,
      },
    ]);
    expect(projection.id).toBeTruthy();
    expect(projection.summary).toBe('worker round-trip projection');

    // Embedding BLOB: encode on main → save via worker (Buffer arg) → read via
    // worker (Map<string, row> return) → bytes survive structured clone.
    const vec = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] = (i % 7) / 7;
    const blob = encodeEmbedding(vec);
    await client.call('saveProjectionEmbedding', [projection.id, blob, 'worker round-trip projection']);

    const rows = await client.call<Map<string, { embedding: Buffer | Uint8Array | null }>>(
      'getProjectionEmbeddings',
      [[projection.id]],
    );
    expect(rows).toBeInstanceOf(Map);
    const decoded = decodeEmbedding(rows.get(projection.id)?.embedding ?? null);
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(EMBEDDING_DIM);
    expect(decoded![3]).toBeCloseTo(vec[3], 5);
  });

  // ── 1.6: unknown-RPC rejection with a stable code ──
  it('rejects an unknown op with a stable unsupported_operation code', async () => {
    await client.whenReady();
    await expect(
      client.call('totally_not_a_real_op' as never, []),
    ).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.unsupportedOperation });
  });

  // ── 1.6: error serialization is a plain {code, message} with no stack/path ──
  it('serializes a thrown op error as a plain code+message (no stack/path leak)', async () => {
    await client.whenReady();
    let caught: { code?: string; message?: string } | null = null;
    try {
      // Missing required projection fields → the store function throws.
      await client.call('writeProcessedProjection', [{}]);
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }
    expect(caught).not.toBeNull();
    expect(typeof caught!.code).toBe('string');
    expect(caught!.code).toBeTruthy();
    expect(typeof caught!.message).toBe('string');
    // No multi-line stack frames and no source path leaked into the wire message.
    expect(caught!.message).not.toMatch(/\n\s+at /);
    expect(caught!.message).not.toContain('context-store.ts');
  });

  // ── 1.6: per-RPC timeout + late-response discard ──
  it('times out a pending RPC and discards the late worker reply', async () => {
    await client.whenReady();
    vi.useFakeTimers();
    const pending = client.call('getContextMeta', ['greeting'], { timeoutMs: 5000 });
    const assertion = expect(pending).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.timeout });
    // Synchronous advance: fire the client-side timeout WITHOUT flushing the
    // event loop, so the worker's (real) reply cannot race ahead of the timer.
    vi.advanceTimersByTime(5000);
    await assertion;
    expect(client.pendingAwaitedCount).toBe(0);

    // The worker's (real) reply lands after the timeout; it must be discarded
    // without resolving anything or leaking a pending slot.
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.pendingAwaitedCount).toBe(0);
  });

  // ── 1.6: backpressure — a flood of fire-and-forget never exceeds the cap ──
  it('caps in-flight fire-and-forget at the backpressure limit', async () => {
    await client.whenReady();
    for (let i = 0; i < 200; i++) {
      client.fireAndForget('recordMemoryHits', [[`id-${i}`]]);
    }
    expect(client.pendingFireAndForgetCount).toBeLessThanOrEqual(
      CONTEXT_STORE_RPC_BACKPRESSURE.maxFireAndForgetPending,
    );
  });

  // ── 1.6: warmup — R1 read returns empty before ready (not queued behind ensureDb) ──
  it('returns empty for an R1 read before the worker is warm, then serves after ready', async () => {
    client.start(); // eager spawn begins warming ensureDb in the worker
    expect(client.isReady).toBe(false);
    const before = await client.callR1OrEmpty<string[]>('queryProcessedProjections', [{}], []);
    expect(before).toEqual([]); // immediate empty, not blocked on ensureDb

    await client.whenReady();
    expect(client.isReady).toBe(true);
    const after = await client.callR1OrEmpty<unknown[]>('queryProcessedProjections', [{ namespace: NAMESPACE }], []);
    expect(Array.isArray(after)).toBe(true);
  });

  // ── 1.6: backpressure — awaited cap rejects with overloaded ──
  it('rejects awaited mutations past the awaited cap with context_store_overloaded', async () => {
    await client.whenReady();
    vi.useFakeTimers(); // freeze responses so the pending map fills
    const inflight: Promise<unknown>[] = [];
    for (let i = 0; i < CONTEXT_STORE_RPC_BACKPRESSURE.maxAwaitedPending; i++) {
      inflight.push(client.call('getContextMeta', ['greeting'], { timeoutMs: 60_000 }).catch(() => undefined));
    }
    await expect(
      client.call('getContextMeta', ['greeting'], { timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: CONTEXT_STORE_RPC_ERROR.overloaded });
    // Drain: time everything out so afterEach disposes cleanly.
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(inflight);
    vi.useRealTimers();
  });

  // ── callOrElse: the migration seam used by md-ingest / skill-review ──
  it('callOrElse uses the worker when warm, and the local fallback when not warm', async () => {
    await client.whenReady();
    await client.call('setContextMeta', ['ck', 'from-worker']);

    let fallbackCalls = 0;
    const viaWorker = await client.callOrElse('getContextMeta', ['ck'], () => {
      fallbackCalls += 1;
      return 'local';
    });
    expect(viaWorker).toBe('from-worker');
    expect(fallbackCalls).toBe(0);

    // A fresh, never-warmed client takes the local fallback immediately.
    const cold = new ContextStoreWorkerClient();
    const viaFallback = await cold.callOrElse('getContextMeta', ['ck'], () => 'local-fallback');
    expect(viaFallback).toBe('local-fallback');
    cold.dispose();
  });

  it('callOrElse falls back to local when the worker op errors', async () => {
    await client.whenReady();
    const result = await client.callOrElse('totally_unknown_op' as never, [], () => 'local-after-error');
    expect(result).toBe('local-after-error');
  });
});

// ── 1.6: WAL two-level — PASSIVE non-increasing vs threshold-triggered TRUNCATE ──
describe('context-store WAL checkpoint (two-level)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('context-store-wal');
  });

  afterEach(async () => {
    delete process.env.IMCODES_CONTEXT_WAL_TRUNCATE_BYTES;
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  function seedProjections(count: number): void {
    for (let i = 0; i < count; i++) {
      writeProcessedProjection({
        namespace: NAMESPACE,
        class: 'recent_summary',
        origin: 'chat_compacted',
        sourceEventIds: [`evt-${i}`],
        summary: `wal seed projection ${i} ${'x'.repeat(200)}`,
        content: { trigger: 'idle', i },
        createdAt: 100 + i,
        updatedAt: 110 + i,
      });
    }
  }

  it('uses PASSIVE under the threshold and keeps the WAL non-increasing', () => {
    seedProjections(5);
    const result = checkpointWal();
    expect(result.mode).toBe('PASSIVE');
    expect(result.walBytesAfter).toBeLessThanOrEqual(result.walBytesBefore);
  });

  it('escalates to TRUNCATE past the threshold and shrinks the WAL', () => {
    process.env.IMCODES_CONTEXT_WAL_TRUNCATE_BYTES = '1024'; // tiny threshold
    seedProjections(40); // grow the WAL past 1 KB
    const result = checkpointWal();
    expect(result.mode).toBe('TRUNCATE');
    expect(result.walBytesAfter).toBeLessThanOrEqual(result.walBytesBefore);
  });
});
