import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { ContextNamespace } from '../../shared/context-types.js';

// Deterministic fake embedding (hoisted so the vi.mock factory can use it).
// The WORKER thread is unaffected by this main-thread mock — it only decodes
// the BLOBs we seed and never calls generateEmbedding — so mocking the query
// embedding on the main thread is exactly the two-hop dataflow under test.
const { fakeEmbed } = vi.hoisted(() => {
  const DIM = 384; // = EMBEDDING_DIM; decodeEmbedding requires exactly DIM floats
  function fakeEmbed(text: string): Float32Array {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    let s = h >>> 0;
    const v = new Float32Array(DIM);
    let norm = 0;
    for (let i = 0; i < DIM; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const x = (s / 0xffffffff) * 2 - 1;
      v[i] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i++) v[i] /= norm;
    return v;
  }
  return { fakeEmbed };
});

vi.mock('../../src/context/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/context/embedding.js')>();
  return { ...actual, generateEmbedding: async (text: string) => fakeEmbed(text) };
});

import { encodeEmbedding } from '../../src/context/embedding.js';
import {
  writeProcessedProjection,
  saveProjectionEmbedding,
} from '../../src/store/context-store.js';
import { composeEmbedSourceText } from '../../shared/memory-content-hash.js';
import { type MemorySearchQuery } from '../../src/context/memory-search.js';
import { searchLocalMemorySemanticViaWorker } from '../../src/context/memory-recall-client.js';
import { resolveMemoryConfigForNamespace } from '../../src/context/memory-config-resolver.js';
import {
  ContextStoreWorkerClient,
  getContextStoreClient,
  resetContextStoreClientForTests,
} from '../../src/store/context-store-worker-client.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const NAMESPACE: ContextNamespace = {
  scope: 'project_shared',
  projectId: 'github.com/acme/repo',
  enterpriseId: 'ent-1',
};

// Varied source phrases so each projection gets a distinct embedding and the
// worker-side rerank has a real candidate set to score (not 8 identical rows).
const PHRASES = [
  'Refactored the authentication middleware to use JWT rotation and refresh tokens',
  'Fixed garbled download filename encoding for non-ascii names on Windows clients',
  'Database migration adds a covering index on processed projection lookups',
  'Implemented worker isolation for the context store SQLite access off the main thread',
  'Discussed the weekend hiking trip, the weather forecast and trail conditions',
  'Tuned the WAL checkpoint thresholds and busy timeout for the large-DB host',
  'Added i18n locale strings for the session controls and chat composer panel',
  'Investigated proof-stale recall caused by main-thread event-loop freezes',
  'Wired push notifications through APNs and FCM for mobile session alerts',
  'Hardened the passkey WebAuthn challenge store against replay and cross-origin use',
];

// Production-scale fixture: enough rerank candidates that the worker does real
// collect+rank+redact work, while the per-projection BEGIN IMMEDIATE/COMMIT seed
// cost stays inside a single CI test budget.
const PROJECTION_COUNT = 600;
// Unmeasured warmup recalls: let the worker JIT-warm AND let V8 collect the
// large seed garbage (600 projection rows + 600 embedding Buffers) BEFORE the
// measured window, so a seed-induced GC pause is not misattributed to recall.
const WARMUP_RECALLS = 12;
// Measured front-of-turn recalls. Front-of-turn recall is one-per-turn in
// production, so a sequential stream is the realistic cadence; the main loop
// must stay responsive between every dispatch (the heavy work is off-thread).
const MEASURED_RECALLS = 40;
const RECALL_LIMIT = 5;
// Self-scheduling main-thread drift probe cadence (matches latency-tracer.ts).
const PROBE_MS = 20;
// Contractual bar from the change spec: main-thread driftMs p99 must stay an
// order of magnitude under the pre-isolation 3000-9000 ms freezes. 500 ms is a
// deliberately wide ceiling so the proof is structural, not timing-flaky on a
// loaded CI runner.
const DRIFT_P99_CEILING_MS = 500;

describe('L3 worker recall — event-loop responsiveness (driftMs proxy, 5.3)', () => {
  let tempDir: string;
  let client: ContextStoreWorkerClient;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('l3-perf');
    setContextModelRuntimeConfig(null);
    resetContextStoreClientForTests();
    client = getContextStoreClient();
  });

  afterEach(async () => {
    resetContextStoreClientForTests();
    setContextModelRuntimeConfig(null);
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  function seedProductionScale(): void {
    const patterns = resolveMemoryConfigForNamespace(NAMESPACE).extraRedactPatterns ?? [];
    for (let i = 0; i < PROJECTION_COUNT; i++) {
      const summary = `${PHRASES[i % PHRASES.length]} (revision ${i})`;
      // writeProcessedProjection returns the row with its generated id, so the
      // embedding is attached inline — no re-read loop needed.
      const projection = writeProcessedProjection({
        namespace: NAMESPACE,
        class: i % 2 === 0 ? 'recent_summary' : 'durable_memory_candidate',
        origin: 'chat_compacted',
        sourceEventIds: [`evt-${i}`],
        summary,
        content: { trigger: 'idle', index: i },
        createdAt: 1_000 + i,
        updatedAt: 2_000 + i,
      });
      // The worker decodes the stored BLOB for cosine scoring (it never recomputes
      // embeddings), so any deterministic, distinct 384-dim vector is a valid
      // rerank candidate — derive it from the per-row summary.
      const source = composeEmbedSourceText(summary, '', patterns);
      saveProjectionEmbedding(projection.id, encodeEmbedding(fakeEmbed(source)), source);
    }
  }

  it(`keeps main-thread driftMs p99 <= ${DRIFT_P99_CEILING_MS}ms while the worker serves L3 recalls on a ${PROJECTION_COUNT}-projection fixture`, async () => {
    seedProductionScale();
    // Warm the worker (ensureDb + DDL) BEFORE measuring so spawn/warmup cost is
    // excluded from the driftMs window — we measure steady-state recall only.
    await client.whenReady();
    expect(client.isReady).toBe(true);

    const query: MemorySearchQuery = {
      namespace: NAMESPACE,
      query: 'worker isolation for the context store event loop',
      limit: RECALL_LIMIT,
    };
    const recall = (): Promise<unknown> => searchLocalMemorySemanticViaWorker(query);

    // Warmup: drive recalls through the worker so V8 collects the heavy seed
    // garbage and JIT-warms the rerank — all OUTSIDE the measured window, so a
    // one-off seed GC pause is never charged to the recall path under test.
    for (let i = 0; i < WARMUP_RECALLS; i++) await recall();
    await settle();

    // monitorEventLoopDelay measures how late the libuv timer phase fires vs its
    // expected wakeup — the same driftMs the daemon reports in production
    // (lifecycle.ts / latency-tracer.ts). PLUS a self-scheduling probe that is
    // the literal latency-tracer driftMs definition (now - expectedWakeup).
    const monitor = monitorEventLoopDelay({ resolution: 10 });
    const probeDrifts: number[] = [];
    let expected = performance.now() + PROBE_MS;
    const probe = setInterval(() => {
      const now = performance.now();
      probeDrifts.push(now - expected);
      expected = now + PROBE_MS;
    }, PROBE_MS);
    monitor.enable();

    // `on('message')` deserialization markers: time each RPC from dispatch to the
    // resolved (structured-clone-deserialized) result on the main thread. Run a
    // sequential stream — the realistic front-of-turn cadence — so each reply is
    // deserialized at the worker.on('message') boundary on an otherwise idle loop.
    const roundTripMs: number[] = [];
    let servedByWorker = 0;
    for (let i = 0; i < MEASURED_RECALLS; i++) {
      const t0 = performance.now();
      const result = await recall();
      roundTripMs.push(performance.now() - t0);
      // Not a cold-start null fallback — the worker actually served it, and only
      // the bounded top-N crossed the thread boundary.
      if (result !== null) {
        servedByWorker += 1;
        expect((result as { items: unknown[] }).items.length).toBeLessThanOrEqual(RECALL_LIMIT);
      }
    }

    monitor.disable();
    clearInterval(probe);

    expect(servedByWorker).toBe(MEASURED_RECALLS);
    expect(roundTripMs).toHaveLength(MEASURED_RECALLS);

    const driftP99Ms = monitor.percentile(99) / 1e6;
    const driftMeanMs = monitor.mean / 1e6;
    const driftMaxMs = monitor.max / 1e6;
    const probeP99Ms = percentile(probeDrifts, 99);
    // Surface the measured numbers in the test output for CI triage.
    // eslint-disable-next-line no-console
    console.info(
      `[5.3 driftMs proxy] histogram p99=${driftP99Ms.toFixed(1)}ms mean=${driftMeanMs.toFixed(1)}ms `
      + `max=${driftMaxMs.toFixed(1)}ms | probe p99=${probeP99Ms.toFixed(1)}ms | `
      + `over ${MEASURED_RECALLS} recalls / ${PROJECTION_COUNT} candidates; `
      + `roundTrip p99~${percentile(roundTripMs, 99).toFixed(1)}ms`,
    );

    // The contract: with the heavy rerank off the main thread, the event loop
    // stays responsive — p99 stays an order of magnitude under the pre-isolation
    // 3000-9000 ms freezes. Both the perf_hooks histogram and the self-scheduled
    // probe must agree.
    expect(driftP99Ms).toBeLessThanOrEqual(DRIFT_P99_CEILING_MS);
    expect(probeP99Ms).toBeLessThanOrEqual(DRIFT_P99_CEILING_MS);
    // Heaviest real-worker case (seeds 600 projections + embeddings, then 12 warmup
    // + 40 measured cross-thread recalls). Generous explicit timeout so full-suite
    // CPU contention can't starve the seed/recall stream past the default 5000ms.
  }, 30_000);
});

/** Drain microtasks + a few real timer ticks so prior-phase GC settles. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

/** Nearest-rank percentile over a copy of the samples (ms). */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
