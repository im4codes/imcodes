import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { searchLocalMemorySemantic } from '../../src/context/memory-search.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { queryProcessedProjections, recordMemoryHits, writeProcessedProjection } from '../../src/store/context-store.js';

const generateEmbeddingMock = vi.hoisted(() => vi.fn());
const cosineSimilarityMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/context/embedding.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  cosineSimilarity: cosineSimilarityMock,
}));

describe('memory-search semantic ranking', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let targetA: ContextTargetRef;
  let targetB: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-search-semantic');
    namespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
    targetA = { namespace, kind: 'session', sessionName: 'deck_repo_a' };
    targetB = { namespace, kind: 'session', sessionName: 'deck_repo_b' };
    vi.clearAllMocks();
    cosineSimilarityMock.mockImplementation((_query: Float32Array, emb: Float32Array) => emb[0] ?? 0);
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('reranks semantic candidates with shared composite scoring instead of raw similarity only', async () => {
    const coordinator = new MaterializationCoordinator({
      compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    coordinator.ingestEvent({ target: targetA, eventType: 'user.turn', content: 'fix download filename bug', createdAt: 100 });
    coordinator.ingestEvent({ target: targetA, eventType: 'assistant.text', content: 'resolved filename encoding for downloads', createdAt: 101 });
    await coordinator.materializeTarget(targetA, 'manual', 500);

    coordinator.ingestEvent({ target: targetB, eventType: 'user.turn', content: 'fix websocket reconnect bug', createdAt: 200 });
    coordinator.ingestEvent({ target: targetB, eventType: 'assistant.text', content: 'resolved websocket reconnect race condition', createdAt: 201 });
    await coordinator.materializeTarget(targetB, 'manual', 600);

    const projections = queryProcessedProjections({ projectId: namespace.projectId, limit: 10 });
    const downloadProjection = projections.find((p) => p.summary.includes('download'));
    const websocketProjection = projections.find((p) => p.summary.includes('websocket'));
    expect(downloadProjection).toBeDefined();
    expect(websocketProjection).toBeDefined();

    recordMemoryHits([downloadProjection!.id, downloadProjection!.id, downloadProjection!.id, downloadProjection!.id, downloadProjection!.id]);

    generateEmbeddingMock.mockImplementation(async (text: string) => {
      if (text === 'bug') return new Float32Array([1]);
      if (text.includes('download')) return new Float32Array([0.7]);
      if (text.includes('websocket')) return new Float32Array([0.78]);
      return null;
    });

    const result = await searchLocalMemorySemantic({
      query: 'download bug',
      repo: namespace.projectId,
      limit: 2,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].summary.toLowerCase()).toContain('download');
    expect(new Set(result.items.map((item) => item.id)).size).toBe(2);
  });

  it('does not increment hitCount when semantic search is used for browsing', async () => {
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'Search-only memory entry',
      content: {},
    });

    generateEmbeddingMock.mockImplementation(async (text: string) => {
      if (text === 'search memory') return new Float32Array([1]);
      if (text.includes('Search-only memory entry')) return new Float32Array([0.9]);
      return null;
    });

    const before = queryProcessedProjections({ projectId: namespace.projectId, limit: 10 });
    expect(before[0]?.hitCount ?? 0).toBe(0);
    expect(before[0]?.lastUsedAt).toBeUndefined();

    await searchLocalMemorySemantic({
      query: 'search memory',
      namespace,
      limit: 5,
    });
    await searchLocalMemorySemantic({
      query: 'search memory',
      namespace,
      limit: 5,
    });

    const after = queryProcessedProjections({ projectId: namespace.projectId, limit: 10 });
    expect(after[0]?.hitCount ?? 0).toBe(0);
    expect(after[0]?.lastUsedAt).toBeUndefined();
  });


  it('passes current enterprise context into scoring so same-enterprise recall beats unrelated recall', async () => {
    writeProcessedProjection({
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo-a',
        enterpriseId: 'ent-1',
        workspaceId: 'ws-1',
      },
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'Same enterprise fix',
      content: {},
    });
    writeProcessedProjection({
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/other/repo-b',
        enterpriseId: 'ent-2',
        workspaceId: 'ws-2',
      },
      class: 'recent_summary',
      sourceEventIds: ['evt-2'],
      summary: 'Different enterprise fix',
      content: {},
    });

    generateEmbeddingMock.mockImplementation(async (text: string) => {
      if (text === 'enterprise bug') return new Float32Array([1]);
      if (text.includes('Same enterprise')) return new Float32Array([0.5]);
      if (text.includes('Different enterprise')) return new Float32Array([0.5]);
      return null;
    });

    const result = await searchLocalMemorySemantic({
      query: 'enterprise bug',
      currentEnterpriseId: 'ent-1',
      limit: 2,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.summary).toContain('Same enterprise');
  });
});
