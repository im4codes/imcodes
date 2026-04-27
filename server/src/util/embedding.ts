/**
 * Server-side embedding generation.
 *
 * As of the worker-pool refactor, this module is a thin wrapper around
 * `EmbeddingPool` (`./embedding-pool.ts`), which runs the actual
 * `@huggingface/transformers` pipeline inside a `worker_threads` worker.
 * That keeps the model load (~1.4 s first time) and inference (~5 ms /
 * call) off the main event loop so request handling, WebSocket IO, and
 * cron jobs are never starved.
 *
 * Public API is unchanged from the pre-worker version — every existing
 * caller (`storeProjectionEmbedding`, `backfillEmbeddings`, the
 * `searchSemanticMemoryView` query path, the `/api/embedding` route)
 * gets the worker behavior automatically.
 */

import { EMBEDDING_MODEL, embeddingToSql } from '../../../shared/embedding-config.js';
import logger from './logger.js';
import { getEmbeddingPool } from './embedding-pool.js';
import type { Database } from '../db/client.js';

export { EMBEDDING_DIM, cosineSimilarity, embeddingToSql, sqlToEmbedding } from '../../../shared/embedding-config.js';

/**
 * Generate a normalized embedding vector for a text string.
 * Returns a Float32Array of EMBEDDING_DIM dimensions, or null if the
 * worker pool is permanently unavailable on this host (e.g. transformers
 * not installed, onnxruntime native binding can't load).
 *
 * Transient errors (per-request timeout, worker crash) are swallowed and
 * surface as null too — callers treat null as "best-effort skipped".
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  const pool = getEmbeddingPool();
  if (!pool.isAvailable()) return null;
  try {
    return await pool.embed(text);
  } catch (err) {
    logger.warn({ err }, 'generateEmbedding: pool rejected request');
    return null;
  }
}

/**
 * Check if the embedding worker is available.
 * Returns false once the pool has hit a sticky failure.
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  const pool = getEmbeddingPool();
  if (!pool.isAvailable()) return false;
  // Probe with a tiny payload — if the worker is alive but the model
  // hasn't loaded yet, this triggers the lazy load. A failure here
  // sticky-disables the pool and we return false.
  try {
    const v = await pool.embed('ping');
    return v !== null;
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
