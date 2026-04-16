import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cosineSimilarity, EMBEDDING_DIM } from '../../src/context/embedding.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a fake normalized embedding vector. */
function fakeEmbedding(seed: number, dim = EMBEDDING_DIM): Float32Array {
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.sin(seed * (i + 1) * 0.1);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ── Cosine similarity tests ─────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('identical vectors have similarity ~1.0', () => {
    const v = fakeEmbedding(7);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 4);
  });

  it('orthogonal-ish vectors have low similarity', () => {
    const a = fakeEmbedding(1);
    const b = fakeEmbedding(100);
    expect(cosineSimilarity(a, b)).toBeLessThan(0.5);
  });

  it('similar seeds produce higher similarity than distant seeds', () => {
    const base = fakeEmbedding(10);
    const near = fakeEmbedding(11);
    const far = fakeEmbedding(500);
    expect(cosineSimilarity(base, near)).toBeGreaterThan(cosineSimilarity(base, far));
  });

  it('similarity is symmetric', () => {
    const a = fakeEmbedding(3);
    const b = fakeEmbedding(77);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it('all values in [-1, 1] range', () => {
    for (let i = 0; i < 20; i++) {
      const a = fakeEmbedding(i);
      const b = fakeEmbedding(i * 7 + 3);
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeGreaterThanOrEqual(-1.001);
      expect(sim).toBeLessThanOrEqual(1.001);
    }
  });
});

// ── Semantic ranking tests (using controlled vectors) ───────────────────────

describe('Semantic ranking with controlled embeddings', () => {
  it('can rank memories by cosine similarity to a query', () => {
    const query = fakeEmbedding(50);
    const memories = [
      { id: 'near', embedding: fakeEmbedding(51) },    // closest
      { id: 'mid', embedding: fakeEmbedding(80) },     // medium
      { id: 'far', embedding: fakeEmbedding(200) },    // far
    ];

    const ranked = memories
      .map((m) => ({ id: m.id, score: cosineSimilarity(query, m.embedding) }))
      .sort((a, b) => b.score - a.score);

    expect(ranked[0].id).toBe('near');
    expect(ranked[ranked.length - 1].id).toBe('far');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });

  it('re-ranking changes order vs timestamp-based order', () => {
    const query = fakeEmbedding(50);
    // Memories sorted by timestamp (newest first) — but semantically the oldest is most relevant
    const memories = [
      { id: 'newest', createdAt: 300, embedding: fakeEmbedding(200) },  // new but irrelevant
      { id: 'middle', createdAt: 200, embedding: fakeEmbedding(80) },   // medium
      { id: 'oldest', createdAt: 100, embedding: fakeEmbedding(51) },   // old but most relevant
    ];

    // Timestamp order
    const byTime = [...memories].sort((a, b) => b.createdAt - a.createdAt);
    expect(byTime[0].id).toBe('newest');

    // Semantic order
    const bySemantic = [...memories]
      .map((m) => ({ ...m, score: cosineSimilarity(query, m.embedding) }))
      .sort((a, b) => b.score - a.score);
    expect(bySemantic[0].id).toBe('oldest'); // semantic winner beats timestamp
  });

  it('semantically similar but substring-different texts can be matched', () => {
    // Simulate: "fixed the file download bug" and "repaired file transfer issue"
    // These share no substrings but are semantically similar
    // With real embeddings they'd be close; here we simulate with close seeds
    const downloadBugEmb = fakeEmbedding(42);
    const transferIssueEmb = fakeEmbedding(43); // close seed = similar
    const cookingRecipeEmb = fakeEmbedding(999); // unrelated

    const query = downloadBugEmb;
    const simTransfer = cosineSimilarity(query, transferIssueEmb);
    const simCooking = cosineSimilarity(query, cookingRecipeEmb);

    // "transfer issue" (semantically similar) ranks above "cooking recipe" (unrelated)
    expect(simTransfer).toBeGreaterThan(simCooking);
  });
});

// ── EMBEDDING_DIM constant ──────────────────────────────────────────────────

describe('EMBEDDING_DIM', () => {
  it('is 384 for all-MiniLM-L6-v2', () => {
    expect(EMBEDDING_DIM).toBe(384);
  });
});
