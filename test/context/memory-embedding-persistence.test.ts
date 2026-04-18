import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeProcessedProjection, getProjectionEmbedding, saveProjectionEmbedding, getProjectionEmbeddings } from '../../src/store/context-store.js';
import { encodeEmbedding, decodeEmbedding } from '../../src/context/embedding.js';
import { EMBEDDING_DIM } from '../../shared/embedding-config.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

function makeDeterministicVec(seed: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  let s = seed;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // Little congruential PRNG — stable per seed, spans [-1, 1], fine for
    // BLOB round-trip tests.
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    vec[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return vec;
}

describe('persistent per-projection embeddings', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('embedding-persist');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('encodes and decodes a Float32Array round-trip without loss', () => {
    const vec = makeDeterministicVec(42);
    const buf = encodeEmbedding(vec);
    expect(buf.length).toBe(EMBEDDING_DIM * 4);
    const decoded = decodeEmbedding(buf);
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expect(decoded![i]).toBeCloseTo(vec[i], 6);
    }
  });

  it('decodeEmbedding returns null for a corrupt blob', () => {
    expect(decodeEmbedding(null)).toBeNull();
    expect(decodeEmbedding(Buffer.alloc(17))).toBeNull(); // wrong size
  });

  it('getProjectionEmbedding returns null embedding for newly-written rows', () => {
    const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/fresh' };
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'brand new summary',
      content: {},
    });
    const row = getProjectionEmbedding(projection.id);
    expect(row).toBeDefined();
    expect(row!.embedding).toBeNull();
    expect(row!.embeddingSource).toBeNull();
    expect(row!.summary).toBe('brand new summary');
  });

  it('saveProjectionEmbedding persists the blob and source text', () => {
    const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/persist' };
    const projection = writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-1'],
      summary: 'summary to embed',
      content: {},
    });
    const vec = makeDeterministicVec(7);
    const source = `${projection.summary} ${JSON.stringify({})}`;
    saveProjectionEmbedding(projection.id, encodeEmbedding(vec), source);

    const row = getProjectionEmbedding(projection.id);
    expect(row).toBeDefined();
    expect(row!.embedding).toBeInstanceOf(Buffer);
    expect(row!.embedding!.length).toBe(EMBEDDING_DIM * 4);
    expect(row!.embeddingSource).toBe(source);

    const decoded = decodeEmbedding(row!.embedding);
    expect(decoded).not.toBeNull();
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expect(decoded![i]).toBeCloseTo(vec[i], 6);
    }
  });

  it('getProjectionEmbeddings batch-reads into a map keyed by id', () => {
    const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/batch' };
    const a = writeProcessedProjection({
      namespace, class: 'recent_summary', sourceEventIds: ['a'], summary: 'a', content: {},
    });
    const b = writeProcessedProjection({
      namespace, class: 'recent_summary', sourceEventIds: ['b'], summary: 'b', content: {},
    });
    const c = writeProcessedProjection({
      namespace, class: 'recent_summary', sourceEventIds: ['c'], summary: 'c', content: {},
    });

    saveProjectionEmbedding(a.id, encodeEmbedding(makeDeterministicVec(1)), 'a ');
    saveProjectionEmbedding(b.id, encodeEmbedding(makeDeterministicVec(2)), 'b ');
    // c left without an embedding

    const map = getProjectionEmbeddings([a.id, b.id, c.id, 'missing-id']);
    expect(map.size).toBe(3);
    expect(map.get(a.id)!.embedding).not.toBeNull();
    expect(map.get(b.id)!.embedding).not.toBeNull();
    expect(map.get(c.id)!.embedding).toBeNull();
    expect(map.has('missing-id')).toBe(false);
  });

  it('reusing writeProcessedProjection for the same summary keeps the stored embedding usable', () => {
    // The reuse path UPDATEs summary/content/source_event_ids/updated_at on
    // the existing row but must leave embedding + embedding_source untouched
    // when the summary text is unchanged — the stored vector is still valid.
    const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/reuse' };
    const summary = 'key decisions: cache embedding on write';
    const first = writeProcessedProjection({
      namespace, class: 'durable_memory_candidate',
      sourceEventIds: ['turn-1'], summary, content: { turn: 1 },
    });
    const vec = makeDeterministicVec(99);
    saveProjectionEmbedding(first.id, encodeEmbedding(vec), `${summary} ${JSON.stringify({ turn: 1 })}`.slice(0, 500));

    const second = writeProcessedProjection({
      namespace, class: 'durable_memory_candidate',
      sourceEventIds: ['turn-2'], summary, content: { turn: 2 },
    });
    expect(second.id).toBe(first.id);

    // Stored embedding survives the UPDATE: the blob bytes are still there.
    const row = getProjectionEmbedding(first.id);
    expect(row!.embedding).not.toBeNull();
    // embeddingSource is the text that WAS embedded. The UPDATE changed the
    // content but not the summary. The recall path compares its newly-computed
    // text against embeddingSource to detect staleness — so the source here
    // still reflects the turn-1 content and a staleness check will recompute
    // on first recall. That's correct behaviour: the content JSON changed,
    // so the (summary + content) text differs.
    expect(row!.embeddingSource).toContain('turn');
  });
});
