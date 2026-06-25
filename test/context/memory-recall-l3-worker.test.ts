import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import {
  EMBEDDING_DIM,
  encodeEmbedding,
} from '../../src/context/embedding.js';
import {
  writeProcessedProjection,
  saveProjectionEmbedding,
} from '../../src/store/context-store.js';
import { composeEmbedSourceText } from '../../shared/memory-content-hash.js';
import {
  searchLocalMemory,
  searchLocalMemorySemantic,
  type MemorySearchQuery,
} from '../../src/context/memory-search.js';
import { selectStartupMemoryItems } from '../../src/context/startup-memory.js';
import {
  searchLocalMemoryAuthorizedForManagement,
  searchLocalMemorySemanticForManagement,
  searchLocalMemorySemanticViaWorker,
  searchLocalMemoryViaWorker,
  selectStartupMemoryViaWorker,
} from '../../src/context/memory-recall-client.js';
import { ContextStoreError } from '../../src/store/context-store-worker-client.js';
import { resolveMemoryConfigForNamespace } from '../../src/context/memory-config-resolver.js';
import { ContextStoreWorkerClient, resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { getContextStoreClient } from '../../src/store/context-store-worker-client.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const NAMESPACE: ContextNamespace = {
  scope: 'project_shared',
  projectId: 'github.com/acme/repo',
  enterpriseId: 'ent-1',
};

const SUMMARIES = [
  'Refactored the authentication middleware to use JWT rotation',
  'Fixed garbled download filename encoding on Windows',
  'Database migration adds an index on processed projections',
  'Implemented worker isolation for the context store SQLite access',
  'Discussed the weekend hiking trip and weather forecast',
  'Tuned the WAL checkpoint thresholds for the large-DB host',
  'Added i18n locale strings for the session controls panel',
  'Investigated proof-stale caused by main-thread event-loop freezes',
];

describe('L3 worker recall parity', () => {
  let tempDir: string;
  let client: ContextStoreWorkerClient;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('l3-parity');
    setContextModelRuntimeConfig(null);
    resetContextStoreClientForTests();
    client = getContextStoreClient(); // the bridge uses the singleton
  });

  afterEach(async () => {
    resetContextStoreClientForTests();
    setContextModelRuntimeConfig(null);
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  function seedWarm(): void {
    const patterns = resolveMemoryConfigForNamespace(NAMESPACE).extraRedactPatterns ?? [];
    for (let i = 0; i < SUMMARIES.length; i++) {
      writeProcessedProjection({
        namespace: NAMESPACE,
        class: i % 2 === 0 ? 'recent_summary' : 'durable_memory_candidate',
        origin: 'chat_compacted',
        sourceEventIds: [`evt-${i}`],
        summary: SUMMARIES[i],
        content: { trigger: 'idle', index: i },
        createdAt: 1000 + i,
        updatedAt: 2000 + i,
      });
    }
    // Seed embeddings from the ACTUAL item content so the embed-source matches
    // what both the in-process reader and the worker compute (warm cache).
    const all = searchLocalMemory({ namespace: NAMESPACE, limit: 100 });
    for (const item of all.items) {
      if (item.type !== 'processed') continue;
      const source = composeEmbedSourceText(item.summary, item.content ?? '', patterns);
      saveProjectionEmbedding(item.id, encodeEmbedding(fakeEmbed(source)), source);
    }
  }

  it('uses a 384-dim embedding (decode contract)', () => {
    expect(EMBEDDING_DIM).toBe(384);
  });

  it('warm-cache semantic top-N is identical to the in-process path', async () => {
    seedWarm();
    await client.whenReady();

    const query: MemorySearchQuery = {
      namespace: NAMESPACE,
      query: 'worker isolation for the context store',
      limit: 5,
    };
    const main = await searchLocalMemorySemantic(query);
    const worker = await searchLocalMemorySemanticViaWorker(query);

    expect(worker).not.toBeNull();
    expect(worker!.items.length).toBeLessThanOrEqual(5);
    // Structural parity: same ids in the same order.
    expect(worker!.items.map((i) => i.id)).toEqual(main.items.map((i) => i.id));
    // And the same match kinds / relevance ordering.
    expect(worker!.items.map((i) => i.matchKind)).toEqual(main.items.map((i) => i.matchKind));
  }, 20_000);

  it('parity holds for several distinct queries', async () => {
    seedWarm();
    await client.whenReady();
    for (const q of ['authentication JWT', 'download filename Windows', 'hiking weather', 'WAL checkpoint large host']) {
      const query: MemorySearchQuery = { namespace: NAMESPACE, query: q, limit: 4 };
      const main = await searchLocalMemorySemantic(query);
      const worker = await searchLocalMemorySemanticViaWorker(query);
      expect(worker, `query=${q}`).not.toBeNull();
      expect(worker!.items.map((i) => i.id), `query=${q}`).toEqual(main.items.map((i) => i.id));
    }
  }, 20_000);

  it('cold cache: worker returns bounded results via text fallback (no crash, no embed)', async () => {
    // Seed projections WITHOUT embeddings (cold cache).
    for (let i = 0; i < SUMMARIES.length; i++) {
      writeProcessedProjection({
        namespace: NAMESPACE,
        class: 'recent_summary',
        origin: 'chat_compacted',
        sourceEventIds: [`cold-${i}`],
        summary: SUMMARIES[i],
        content: {},
        createdAt: 1000 + i,
        updatedAt: 2000 + i,
      });
    }
    await client.whenReady();
    const query: MemorySearchQuery = { namespace: NAMESPACE, query: 'worker isolation context store', limit: 5 };
    const worker = await searchLocalMemorySemanticViaWorker(query);
    expect(worker).not.toBeNull();
    expect(worker!.items.length).toBeGreaterThan(0);
    expect(worker!.items.length).toBeLessThanOrEqual(5);
    // The exact text match must surface (the +100 exact bonus in the fallback).
    expect(worker!.items.some((i) => i.summary.includes('worker isolation'))).toBe(true);
  }, 20_000);


  it('R5 authorized quick-search keeps the namespace allowlist on the worker path', async () => {
    const authorizedPersonal: ContextNamespace = {
      scope: 'personal',
      projectId: NAMESPACE.projectId,
      userId: 'user-1',
    };
    const authorizedProject: ContextNamespace = {
      scope: 'project_shared',
      projectId: NAMESPACE.projectId,
      workspaceId: 'ws-1',
      enterpriseId: 'ent-1',
    };
    writeProcessedProjection({
      namespace: authorizedPersonal,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['authorized-personal'],
      summary: 'Authorized personal namespace sentinel',
      content: {},
      createdAt: 100,
      updatedAt: 400,
    });
    writeProcessedProjection({
      namespace: authorizedProject,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['authorized-project'],
      summary: 'Authorized project namespace sentinel',
      content: {},
      createdAt: 90,
      updatedAt: 300,
    });
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: NAMESPACE.projectId, userId: 'user-2' },
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['unauthorized-personal'],
      summary: 'Unauthorized other-user namespace sentinel',
      content: {},
      createdAt: 80,
      updatedAt: 500,
    });
    writeProcessedProjection({
      namespace: { scope: 'project_shared', projectId: NAMESPACE.projectId, workspaceId: 'ws-2', enterpriseId: 'ent-1' },
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['unauthorized-project'],
      summary: 'Unauthorized other-workspace namespace sentinel',
      content: {},
      createdAt: 70,
      updatedAt: 450,
    });

    await client.whenReady();
    const callSpy = vi.spyOn(client, 'call');
    const memoryConfigResolver = vi.fn();
    const authorizedNamespaces = [authorizedPersonal, authorizedProject];
    const result = await searchLocalMemoryAuthorizedForManagement({
      query: 'namespace sentinel',
      authorizedNamespaces,
      memoryConfigResolver,
      limit: 10,
    });

    expect(result.items.map((item) => item.summary)).toEqual([
      'Authorized personal namespace sentinel',
      'Authorized project namespace sentinel',
    ]);
    expect(result.items.some((item) => item.summary.includes('Unauthorized'))).toBe(false);

    const workerCall = callSpy.mock.calls.find((call) => call[0] === 'searchLocalMemoryAuthorizedBounded');
    expect(workerCall).toBeTruthy();
    const sentQuery = workerCall![1][0] as {
      authorizedNamespaces: ContextNamespace[];
      memoryConfigResolver?: unknown;
    };
    expect(sentQuery.authorizedNamespaces).toEqual(authorizedNamespaces);
    expect(sentQuery.authorizedNamespaces).not.toBe(authorizedNamespaces);
    expect(sentQuery).not.toHaveProperty('memoryConfigResolver');
    expect(memoryConfigResolver).not.toHaveBeenCalled();
  }, 20_000);

  it('R5 management semantic facade preserves non-lexical semantic hits on normal priority with 5s timeout', async () => {
    const semanticNeedle = 'non lexical semantic bridge query';
    const matching = writeProcessedProjection({
      namespace: NAMESPACE,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['semantic-management-a'],
      summary: 'Refactored billing retry scheduler internals',
      content: { note: 'no shared query terms here' },
      createdAt: 100,
      updatedAt: 200,
    });
    writeProcessedProjection({
      namespace: NAMESPACE,
      class: 'recent_summary',
      origin: 'chat_compacted',
      sourceEventIds: ['semantic-management-b'],
      summary: 'Updated project onboarding checklist',
      content: {},
      createdAt: 101,
      updatedAt: 201,
    });
    const patterns = resolveMemoryConfigForNamespace(NAMESPACE).extraRedactPatterns ?? [];
    const matchingCandidate = searchLocalMemory({ namespace: NAMESPACE, limit: 10 }).items.find((item) => item.id === matching.id);
    expect(matchingCandidate).toBeTruthy();
    const source = composeEmbedSourceText(matchingCandidate!.summary, matchingCandidate!.content ?? '', patterns);
    // Persist an embedding that is semantically identical to the query even
    // though the summary/content share no lexical terms with it. A substring
    // bounded query would not be able to surface this projection.
    saveProjectionEmbedding(matching.id, encodeEmbedding(fakeEmbed(semanticNeedle)), source);

    await client.whenReady();
    const callSpy = vi.spyOn(client, 'call');
    const result = await searchLocalMemorySemanticForManagement({
      namespace: NAMESPACE,
      query: semanticNeedle,
      limit: 1,
    });

    expect(result.items.map((item) => item.id)).toEqual([matching.id]);
    expect(result.items[0]?.matchKind).toBe('semantic');
    expect(callSpy).toHaveBeenCalledWith(
      'searchLocalMemorySemanticBounded',
      expect.any(Array),
      { priority: 'normal', timeoutMs: 5000 },
    );
  }, 20_000);

  it('substring L3 (searchLocalMemoryBounded) matches the in-process substring path', async () => {
    seedWarm();
    await client.whenReady();
    const query: MemorySearchQuery = { namespace: NAMESPACE, query: 'migration index', limit: 10 };
    const main = searchLocalMemory(query);
    const worker = await searchLocalMemoryViaWorker(query);
    expect(worker).not.toBeNull();
    expect(worker!.items.map((i) => i.id)).toEqual(main.items.map((i) => i.id));
  }, 20_000);

  it('startup-memory selection via the worker matches the in-process selection', async () => {
    seedWarm();
    await client.whenReady();
    const main = selectStartupMemoryItems(NAMESPACE, { totalLimit: 20 });
    const worker = await selectStartupMemoryViaWorker(NAMESPACE, { totalLimit: 20 });
    expect(worker).not.toBeNull();
    expect(worker!.map((i) => i.id)).toEqual(main.map((i) => i.id));
  }, 20_000);

  it('recall degrades to null (caller falls back) when the worker RPC rejects (transport liveness)', async () => {
    seedWarm();
    // Worker reports ready but the RPC rejects (timeout / overload): the bridge
    // MUST degrade to null so the turn proceeds via the in-process fallback,
    // never throwing or hanging on the front-of-turn path.
    vi.spyOn(client, 'isReady', 'get').mockReturnValue(true);
    vi.spyOn(client, 'call').mockRejectedValue(
      new ContextStoreError('context_store_timeout', 'timed out'),
    );
    const r = await searchLocalMemorySemanticViaWorker({ namespace: NAMESPACE, query: 'worker isolation', limit: 5 });
    expect(r).toBeNull();
  });

  it('bridge returns null before the worker is warm, so callers fall back', async () => {
    seedWarm();
    // Do NOT await whenReady — the worker is still warming.
    const query: MemorySearchQuery = { namespace: NAMESPACE, query: 'worker isolation', limit: 5 };
    const r = await searchLocalMemorySemanticViaWorker(query);
    expect(r).toBeNull();
  });

  it('event-loop stays responsive while an L3 recall is dispatched', async () => {
    seedWarm();
    await client.whenReady();
    const query: MemorySearchQuery = { namespace: NAMESPACE, query: 'worker isolation', limit: 5 };

    const start = Date.now();
    let immediateDelay = -1;
    const recall = searchLocalMemorySemanticViaWorker(query);
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        immediateDelay = Date.now() - start;
        resolve();
      });
    });
    await recall;
    // The heavy work runs in the worker; the main event loop is not blocked.
    expect(immediateDelay).toBeGreaterThanOrEqual(0);
    expect(immediateDelay).toBeLessThan(100);
  }, 20_000);
});
