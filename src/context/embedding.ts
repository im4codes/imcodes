/**
 * Local embedding generation using transformers.js (Hugging Face).
 * Runs entirely on CPU — no external API, no cost, ~2-5ms/query (q8).
 *
 * Model and config imported from shared/embedding-config.ts (single source of truth).
 * Lazy-loaded on first call — subsequent calls reuse the pipeline.
 */

import { EMBEDDING_MODEL, EMBEDDING_DTYPE, EMBEDDING_DIM } from '../../shared/embedding-config.js';
import logger from '../util/logger.js';

// Re-export shared constants for backward compatibility with existing imports
export { EMBEDDING_DIM, cosineSimilarity } from '../../shared/embedding-config.js';

function resolveEmbeddingCacheDir(): string {
  return process.env.IMCODES_EMBEDDING_CACHE_DIR?.trim() || '';
}

// Lazy-loaded pipeline singleton
let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;

// ── Float32 ⇄ Buffer helpers ────────────────────────────────────────────────
// Used by the persistent embedding store in context-store.ts to stash the
// L2-normalized query-time output as a BLOB. Every vector is EMBEDDING_DIM
// floats (= 384 × 4 bytes = 1.5 KB).

/** Encode a Float32Array to a little-endian Buffer suitable for SQLite BLOB. */
export function encodeEmbedding(vec: Float32Array): Buffer {
  // Copy because Float32Array's underlying ArrayBuffer may include unrelated
  // bytes when the view was created via .slice() on a larger buffer.
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** Decode a SQLite BLOB back into a Float32Array. Returns null if size mismatches. */
export function decodeEmbedding(buf: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!buf) return null;
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (bytes.length !== EMBEDDING_DIM * 4) return null;
  const out = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

async function getPipeline(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      const cacheDir = resolveEmbeddingCacheDir();
      if (cacheDir) env.cacheDir = cacheDir;
      logger.info({ model: EMBEDDING_MODEL, dtype: EMBEDDING_DTYPE, cacheDir: env.cacheDir }, 'Loading embedding model...');
      const p = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: EMBEDDING_DTYPE,
      });
      logger.info({ model: EMBEDDING_MODEL, dim: EMBEDDING_DIM }, 'Embedding model loaded');
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
 * Returns a Float32Array of EMBEDDING_DIM dimensions, or null if model unavailable.
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const pipe = await getPipeline();
    const result = await pipe(text, { pooling: 'mean', normalize: true });
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
