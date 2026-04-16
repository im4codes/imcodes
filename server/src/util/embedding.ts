/**
 * Server-side embedding generation using transformers.js (Hugging Face).
 * Same model and config as daemon — imported from shared/embedding-config.ts.
 *
 * Lazy-loaded singleton: first call loads the model (~1.4s), subsequent calls ~2-5ms.
 */

import { EMBEDDING_MODEL, EMBEDDING_DTYPE, EMBEDDING_DIM, embeddingToSql } from '../../../shared/embedding-config.js';
import logger from './logger.js';
import type { Database } from '../db/client.js';

export { EMBEDDING_DIM, cosineSimilarity, embeddingToSql, sqlToEmbedding } from '../../../shared/embedding-config.js';

function resolveEmbeddingCacheDir(): string {
  return process.env.IMCODES_EMBEDDING_CACHE_DIR?.trim() || '';
}

// Lazy-loaded pipeline singleton
let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;

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
      logger.warn({ err }, 'Failed to load embedding model — vector search disabled');
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
 * Check if the embedding model is available.
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    await getPipeline();
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate an embedding for a projection summary and store it in shared_context_embeddings.
 * Upserts — safe to call multiple times for the same projection.
 */
export async function storeProjectionEmbedding(db: Database, projectionId: string, summary: string): Promise<void> {
  const embedding = await generateEmbedding(summary);
  if (!embedding) return;

  await db.execute(
    `INSERT INTO shared_context_embeddings (id, source_kind, source_id, embedding_model, embedding, created_at)
     VALUES ($1, 'projection', $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       embedding = excluded.embedding,
       embedding_model = excluded.embedding_model,
       created_at = excluded.created_at`,
    [`emb:${projectionId}`, projectionId, EMBEDDING_MODEL, embeddingToSql(embedding), Date.now()],
  );
}

/**
 * Backfill embeddings for all projections that don't have one yet.
 * Idempotent — safe to call on every server startup.
 */
export async function backfillEmbeddings(db: Database): Promise<number> {
  const missing = await db.query<{ id: string; summary: string }>(
    `SELECT p.id, p.summary
     FROM shared_context_projections p
     LEFT JOIN shared_context_embeddings e ON e.source_id = p.id AND e.source_kind = 'projection'
     WHERE e.id IS NULL AND p.summary IS NOT NULL AND p.summary != ''
     LIMIT 500`,
  );

  if (missing.length === 0) return 0;

  logger.info({ count: missing.length }, 'Backfilling embeddings for projections...');

  let filled = 0;
  for (const row of missing) {
    try {
      await storeProjectionEmbedding(db, row.id, row.summary);
      filled++;
    } catch {
      // Non-fatal — will be retried on next startup
    }
  }

  logger.info({ filled, total: missing.length }, 'Embedding backfill complete');
  return filled;
}
