/**
 * Local embedding generation using transformers.js (Hugging Face).
 * Runs entirely on CPU — no external API, no cost, ~50ms/query.
 *
 * Model: all-MiniLM-L6-v2 (384-dim, ~23MB, multilingual-capable)
 * Lazy-loaded on first call — subsequent calls reuse the pipeline.
 */

import logger from '../util/logger.js';

// Lazy-loaded pipeline singleton
let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

async function getPipeline(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      logger.info({ model: MODEL_NAME }, 'Loading embedding model...');
      const p = await pipeline('feature-extraction', MODEL_NAME, {
        dtype: 'fp32',
      });
      logger.info({ model: MODEL_NAME }, 'Embedding model loaded');
      pipelineInstance = p;
      return p;
    } catch (err) {
      loadingPromise = null;
      logger.warn({ err }, 'Failed to load embedding model — semantic search disabled');
      throw err;
    }
  })();

  return loadingPromise;
}

/**
 * Generate a normalized embedding vector for a text string.
 * Returns a Float32Array of 384 dimensions, or null if model unavailable.
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const pipe = await getPipeline();
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    // result.data is a Float32Array
    return result.data as Float32Array;
  } catch {
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in batch.
 * More efficient than calling generateEmbedding() in a loop.
 */
export async function generateEmbeddings(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  try {
    const pipe = await getPipeline();
    const results: (Float32Array | null)[] = [];
    // Process one at a time to avoid OOM on large batches
    for (const text of texts) {
      try {
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        results.push(result.data as Float32Array);
      } catch {
        results.push(null);
      }
    }
    return results;
  } catch {
    return texts.map(() => null);
  }
}

/** Embedding vector dimension for the current model. */
export const EMBEDDING_DIM = 384;

/**
 * Cosine similarity between two normalized vectors.
 * Since vectors are already normalized, dot product = cosine similarity.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Check if the embedding model is available (loaded or loadable).
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    await getPipeline();
    return true;
  } catch {
    return false;
  }
}
