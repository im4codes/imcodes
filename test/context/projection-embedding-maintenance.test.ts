import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { EMBEDDING_DIM } from '../../shared/embedding-config.js';
import { projectionEmbedSourceText } from '../../shared/memory-content-hash.js';
import {
  cleanupIsolatedSharedContextDb,
  createIsolatedSharedContextDb,
} from '../util/shared-context-db.js';
import {
  getProjectionEmbedding,
  listProjectionsMissingEmbedding,
  writeProcessedProjection,
} from '../../src/store/context-store.js';

// Mock ONLY the model inference + availability probe so the suite runs in CI
// without the real transformers.js model. Keep the REAL encode/decode helpers
// so the persisted BLOB has the correct on-disk shape and the idempotency
// staleness round-trip is exercised against real persistence.
const generateEmbeddingMock = vi.hoisted(() => vi.fn());
const isEmbeddingAvailableMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/context/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/context/embedding.js')>();
  return {
    ...actual,
    generateEmbedding: generateEmbeddingMock,
    isEmbeddingAvailable: isEmbeddingAvailableMock,
  };
});

// Imported AFTER the mock so the module under test binds the mocked embedding fns.
const {
  ensureProjectionEmbedding,
  ensureProjectionEmbeddingForProjection,
  backfillProjectionEmbeddings,
  deriveProjectionEmbedSourceText,
} = await import('../../src/context/projection-embedding-maintenance.js');

function deterministicVector(seed: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] = ((seed + i) % 7) / 7;
  return vec;
}

const namespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };

function writeProjection(id: string, summary: string, content: Record<string, unknown>): void {
  writeProcessedProjection({
    id,
    namespace,
    class: 'recent_summary',
    origin: 'chat_compacted',
    sourceEventIds: [`evt-${id}`],
    summary,
    content,
    createdAt: 1_000,
    updatedAt: 1_000,
  });
}

describe('projection-embedding-maintenance', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('projection-embedding-maintenance');
    vi.clearAllMocks();
    isEmbeddingAvailableMock.mockResolvedValue(true);
    // Default: return a deterministic non-null vector for any text.
    generateEmbeddingMock.mockImplementation(async (_text: string) => deterministicVector(1));
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  describe('ensureProjectionEmbedding', () => {
    it('populates the embedding BLOB and is idempotent (second call no-ops)', async () => {
      writeProjection('p1', 'fix download filename bug', { trigger: 'manual', eventCount: 2 });
      const embedText = deriveProjectionEmbedSourceText(namespace, 'fix download filename bug', { trigger: 'manual', eventCount: 2 });

      const before = getProjectionEmbedding('p1');
      expect(before?.embedding).toBeNull();

      const first = await ensureProjectionEmbedding('p1', embedText);
      expect(first).toBe(true);
      expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);

      const stored = getProjectionEmbedding('p1');
      expect(stored?.embedding).not.toBeNull();
      // Real encodeEmbedding writes EMBEDDING_DIM little-endian floats.
      expect(stored?.embedding?.length).toBe(EMBEDDING_DIM * 4);
      expect(stored?.embeddingSource).toBe(embedText);

      // Second call with the SAME source must no-op (no re-embed).
      const second = await ensureProjectionEmbedding('p1', embedText);
      expect(second).toBe(false);
      expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);
    });

    it('recomputes when the source text changed (staleness)', async () => {
      writeProjection('p1', 'summary v1', { a: 1 });
      await ensureProjectionEmbedding('p1', 'summary v1 source');
      expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);

      // Different source → stale → recompute and re-persist.
      const did = await ensureProjectionEmbedding('p1', 'summary v2 source');
      expect(did).toBe(true);
      expect(generateEmbeddingMock).toHaveBeenCalledTimes(2);
      expect(getProjectionEmbedding('p1')?.embeddingSource).toBe('summary v2 source');
    });

    it('no-ops when the projection row does not exist', async () => {
      const did = await ensureProjectionEmbedding('missing', 'whatever');
      expect(did).toBe(false);
      expect(generateEmbeddingMock).not.toHaveBeenCalled();
    });

    it('degrades gracefully (returns false, no throw) when the model is unavailable', async () => {
      writeProjection('p1', 'summary', { a: 1 });
      generateEmbeddingMock.mockResolvedValue(null); // model unavailable / transient
      const did = await ensureProjectionEmbedding('p1', 'src');
      expect(did).toBe(false);
      expect(getProjectionEmbedding('p1')?.embedding).toBeNull();
    });

    it('never throws even when generateEmbedding rejects', async () => {
      writeProjection('p1', 'summary', { a: 1 });
      generateEmbeddingMock.mockRejectedValue(new Error('boom'));
      await expect(ensureProjectionEmbedding('p1', 'src')).resolves.toBe(false);
      expect(getProjectionEmbedding('p1')?.embedding).toBeNull();
    });
  });

  describe('ensureProjectionEmbeddingForProjection persists recall-identical source', () => {
    it('stores embedding_source byte-identical to the recall reader derivation', async () => {
      const content = { trigger: 'manual', sessionName: 'deck_repo_a', eventCount: 3 };
      writeProjection('p1', 'resolved websocket reconnect race', content);

      const did = await ensureProjectionEmbeddingForProjection({
        id: 'p1', namespace, summary: 'resolved websocket reconnect race', content,
      });
      expect(did).toBe(true);

      // The persisted source MUST equal the shared embed-text derivation that
      // memory-search.ts uses on the recall hot path (empty redact patterns in
      // this isolated test → just `${summary} ${JSON.stringify(content)}`).
      const expected = projectionEmbedSourceText('resolved websocket reconnect race', content, []);
      expect(getProjectionEmbedding('p1')?.embeddingSource).toBe(expected);
    });
  });

  describe('backfillProjectionEmbeddings', () => {
    it('fills NULL-embedding rows in batches and reports counts', async () => {
      generateEmbeddingMock.mockImplementation(async (_text: string) => deterministicVector(2));
      for (let i = 0; i < 5; i++) writeProjection(`p${i}`, `summary ${i}`, { i });

      expect(listProjectionsMissingEmbedding(100).length).toBe(5);

      const result = await backfillProjectionEmbeddings({ batchSize: 2, maxBatches: 10 });
      expect(result.filled).toBe(5);
      expect(result.scanned).toBe(5);
      expect(result.remaining).toBe(0);

      for (let i = 0; i < 5; i++) {
        const row = getProjectionEmbedding(`p${i}`);
        expect(row?.embedding?.length).toBe(EMBEDDING_DIM * 4);
      }
      expect(listProjectionsMissingEmbedding(100).length).toBe(0);
    });

    it('respects maxBatches and leaves the remainder for a later run', async () => {
      generateEmbeddingMock.mockImplementation(async (_text: string) => deterministicVector(3));
      for (let i = 0; i < 6; i++) writeProjection(`p${i}`, `summary ${i}`, { i });

      // batchSize 2 × maxBatches 2 → at most 4 filled this run.
      const result = await backfillProjectionEmbeddings({ batchSize: 2, maxBatches: 2 });
      expect(result.filled).toBe(4);
      expect(result.remaining).toBeGreaterThan(0);
      expect(listProjectionsMissingEmbedding(100).length).toBe(2);

      // A follow-up run fills the rest.
      const result2 = await backfillProjectionEmbeddings({ batchSize: 5, maxBatches: 5 });
      expect(result2.filled).toBe(2);
      expect(listProjectionsMissingEmbedding(100).length).toBe(0);
    });

    it('is a no-op when nothing is missing', async () => {
      const result = await backfillProjectionEmbeddings();
      expect(result.filled).toBe(0);
      expect(result.scanned).toBe(0);
      expect(result.remaining).toBe(0);
    });

    it('degrades gracefully when the embedding model is unavailable (skips scan)', async () => {
      isEmbeddingAvailableMock.mockResolvedValue(false);
      for (let i = 0; i < 3; i++) writeProjection(`p${i}`, `summary ${i}`, { i });

      const result = await backfillProjectionEmbeddings({ batchSize: 2, maxBatches: 5 });
      expect(result.filled).toBe(0);
      expect(result.scanned).toBe(0);
      expect(result.remaining).toBe(3); // rows still unfilled
      expect(generateEmbeddingMock).not.toHaveBeenCalled();
    });

    it('stops early when the model dies mid-run without looping on the same rows', async () => {
      // Available probe passes, but every inference returns null (model died
      // right after the probe). Must stop after the first batch, not spin.
      generateEmbeddingMock.mockResolvedValue(null);
      for (let i = 0; i < 6; i++) writeProjection(`p${i}`, `summary ${i}`, { i });

      const result = await backfillProjectionEmbeddings({ batchSize: 2, maxBatches: 10 });
      expect(result.filled).toBe(0);
      // Only the first batch was scanned before bailing out.
      expect(result.scanned).toBe(2);
      expect(result.remaining).toBe(6);
    });
  });
});
