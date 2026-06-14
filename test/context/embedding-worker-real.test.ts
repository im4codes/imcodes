import { afterAll, describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIM,
  cosineSimilarity,
  generateEmbedding,
  generateEmbeddings,
  isEmbeddingAvailable,
  __setEmbeddingEngineKindForTests,
} from '../../src/context/embedding.js';

// Real-model integration for the WORKER engine (the production path). Gated
// behind the same flag as embedding-real.test.ts so CI doesn't download the
// model. Validates that inference runs off the main thread end-to-end:
// host WorkerEmbeddingEngine -> embedding-worker.ts -> transformers.js.
const RUN_REAL = process.env.RUN_REAL_EMBEDDING_TESTS === '1';
const describeReal = RUN_REAL ? describe : describe.skip;

describeReal('embedding worker engine (real model, off main thread)', () => {
  afterAll(() => { __setEmbeddingEngineKindForTests(null); });

  it('loads the model in a worker and returns 384-dim vectors', async () => {
    __setEmbeddingEngineKindForTests('worker');
    expect(await isEmbeddingAvailable()).toBe(true);

    const vec = await generateEmbedding('fix garbled download filename');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec?.length).toBe(EMBEDDING_DIM);
  }, 120000);

  it('batches via the worker and preserves semantic ranking', async () => {
    __setEmbeddingEngineKindForTests('worker');
    const [query, related, unrelated] = await generateEmbeddings([
      'fix garbled download filename',
      '修复下载文件名乱码问题',
      '今天天气很好，适合出去散步',
    ]);
    expect(query).toBeInstanceOf(Float32Array);
    expect(related).toBeInstanceOf(Float32Array);
    expect(unrelated).toBeInstanceOf(Float32Array);
    expect(cosineSimilarity(query!, related!)).toBeGreaterThan(cosineSimilarity(query!, unrelated!));
  }, 120000);
});
