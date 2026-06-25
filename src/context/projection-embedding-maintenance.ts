/**
 * Projection embedding maintenance — populate persistent per-projection
 * embeddings at WRITE TIME plus a one-time startup BACKFILL.
 *
 * Why: the L3 semantic-recall rerank (memory-search.ts) scores each candidate
 * projection by cosine similarity against a query vector. Historically the
 * candidate vectors were only materialized lazily DURING recall — the very
 * first recall that touched a projection paid `generateEmbedding` (~5-7 ms of
 * CPU inference) per candidate on the hot path. Nothing populated them ahead
 * of time and there was no backfill, so a cold store re-embedded every
 * candidate on every distinct query until enough recalls had warmed it.
 *
 * This module fills `context_processed_local.embedding` proactively:
 *   - `ensureProjectionEmbedding` runs (fire-and-forget) right after a durable
 *     or summary projection is written, so the next recall reads a fast BLOB.
 *   - `backfillProjectionEmbeddings` runs once at daemon startup to backfill
 *     existing rows whose `embedding IS NULL`, in bounded yielding batches.
 *
 * The persisted `embedding_source` MUST be byte-identical to the text the
 * recall reader compares against (memory-search.ts `itemEmbedText`), otherwise
 * recall treats the stored vector as stale and recomputes it — defeating the
 * whole point. We derive that text via the SINGLE shared helper
 * `projectionEmbedSourceText`; producer and consumer share one formula.
 *
 * Everything here is best-effort: a transient SQLite write failure or a
 * missing embedding model must never throw into the write path or the daemon
 * startup sequence.
 */

import type { ContextNamespace, ProcessedContextProjection } from '../../shared/context-types.js';
import { projectionEmbedSourceText } from '../../shared/memory-content-hash.js';
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import type { ProjectionEmbeddingRow, ProjectionMissingEmbeddingRow } from '../store/context-store.js';
import logger from '../util/logger.js';
import { encodeEmbedding, generateEmbedding, isEmbeddingAvailable } from './embedding.js';
import { resolveMemoryConfigForNamespace } from './memory-config-resolver.js';

/** Default rows scanned per backfill batch. Small enough that a single batch
 *  never blocks the loop for long even on a cold model, large enough that the
 *  per-batch `setImmediate` yield isn't the dominant cost. */
const DEFAULT_BACKFILL_BATCH_SIZE = 25;
/** Default cap on backfill batches per run, so a huge store can't pin the CPU
 *  on embedding inference at startup. Remaining rows are filled lazily by
 *  recall (and by the next daemon restart's backfill). */
const DEFAULT_BACKFILL_MAX_BATCHES = 40;

/**
 * Resolve the EXACT embed-source text the recall reader uses for a projection,
 * including the namespace-scoped redaction patterns. Shared derivation lives in
 * `projectionEmbedSourceText` — this only wires in the resolved
 * `extraRedactPatterns`, exactly like memory-search.ts does.
 */
export function deriveProjectionEmbedSourceText(
  namespace: ContextNamespace,
  summary: string,
  content: unknown,
): string {
  const config = resolveMemoryConfigForNamespace(namespace);
  return projectionEmbedSourceText(summary, content, config.extraRedactPatterns);
}

/**
 * Ensure a single projection has a current persisted embedding for the given
 * source text.
 *
 * - Returns `false` (no-op) when a current embedding already exists for this
 *   projection + source, or when the model is unavailable, or on any error.
 * - Returns `true` only when a fresh vector was computed and persisted.
 *
 * Best-effort by contract: never throws. Safe to call as `void ensure...(...)`.
 */
export async function ensureProjectionEmbedding(
  projectionId: string,
  embedSourceText: string,
): Promise<boolean> {
  try {
    // Idempotency / staleness: skip when the stored vector already matches the
    // exact source text the recall reader would compare against.
    const existing = await getContextStoreClient().run<ProjectionEmbeddingRow | undefined>(
      'getProjectionEmbedding',
      [projectionId],
    );
    if (!existing) return false; // projection row gone — nothing to embed.
    if (existing.embedding && existing.embeddingSource === embedSourceText) {
      return false;
    }

    const vec = await generateEmbedding(embedSourceText);
    if (!vec) return false; // model unavailable / transient failure — skip quietly.

    await getContextStoreClient().run<void>(
      'saveProjectionEmbedding',
      [projectionId, encodeEmbedding(vec), embedSourceText],
    );
    return true;
  } catch (error) {
    // A maintenance write must never break the caller (write path / backfill).
    logger.debug(
      { err: error instanceof Error ? error.message : String(error), projectionId },
      'ensureProjectionEmbedding failed (best-effort, ignored)',
    );
    return false;
  }
}

/**
 * Convenience wrapper for write-time callers that already hold the freshly
 * written projection. Derives the recall-identical embed-source text from the
 * projection's namespace + summary + content and persists the embedding.
 *
 * Fire-and-forget friendly: `void ensureProjectionEmbeddingForProjection(p)`.
 */
export async function ensureProjectionEmbeddingForProjection(
  projection: Pick<ProcessedContextProjection, 'id' | 'namespace' | 'summary' | 'content'>,
): Promise<boolean> {
  let embedText: string;
  try {
    embedText = deriveProjectionEmbedSourceText(projection.namespace, projection.summary, projection.content);
  } catch (error) {
    logger.debug(
      { err: error instanceof Error ? error.message : String(error), projectionId: projection.id },
      'ensureProjectionEmbeddingForProjection: embed-text derivation failed (ignored)',
    );
    return false;
  }
  return ensureProjectionEmbedding(projection.id, embedText);
}

export interface BackfillProjectionEmbeddingsResult {
  /** Rows that got a freshly computed embedding this run. */
  filled: number;
  /** Rows scanned (candidates considered) this run. */
  scanned: number;
  /** Rows still missing an embedding after this run (bounded probe). */
  remaining: number;
}

/**
 * One-time-ish backfill: walk projections whose `embedding IS NULL` (newest
 * first) and compute + persist their vectors in bounded, yielding batches so
 * the loop is never hogged. Stops early if the embedding model is unavailable.
 *
 * Bounded by `maxBatches` so a large cold store can't pin the CPU at startup;
 * whatever is left over is filled lazily by recall and the next restart.
 */
export async function backfillProjectionEmbeddings(
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<BackfillProjectionEmbeddingsResult> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE);
  const maxBatches = Math.max(1, opts.maxBatches ?? DEFAULT_BACKFILL_MAX_BATCHES);

  let filled = 0;
  let scanned = 0;

  try {
    // Skip the whole walk when the model can't run — avoids scanning the table
    // only to no-op every row.
    if (!(await isEmbeddingAvailable())) {
      return { filled, scanned, remaining: await safeCountMissing() };
    }

    for (let batch = 0; batch < maxBatches; batch++) {
      let rows: ProjectionMissingEmbeddingRow[];
      try {
        // Always re-query: each fill flips a row's `embedding` non-NULL, so the
        // newest-first window naturally advances to the next NULL rows.
        rows = await getContextStoreClient().run<ProjectionMissingEmbeddingRow[]>(
          'listProjectionsMissingEmbedding',
          [batchSize],
        );
      } catch (error) {
        logger.debug(
          { err: error instanceof Error ? error.message : String(error) },
          'backfillProjectionEmbeddings: listing missing rows failed (ignored)',
        );
        break;
      }
      if (rows.length === 0) break; // nothing left to fill.

      let filledThisBatch = 0;
      for (const row of rows) {
        scanned += 1;
        const did = await ensureProjectionEmbeddingForProjection(row);
        if (did) filledThisBatch += 1;
      }
      filled += filledThisBatch;

      // A batch that flips zero rows means the model just went unavailable
      // (every generateEmbedding returned null) — the same NULL rows would be
      // re-fetched forever otherwise. Stop now.
      if (filledThisBatch === 0) break;
      if (rows.length < batchSize) break; // last (partial) batch consumed.

      // Yield to the event loop so the daemon stays responsive between batches.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  } catch (error) {
    logger.debug(
      { err: error instanceof Error ? error.message : String(error) },
      'backfillProjectionEmbeddings failed (best-effort, ignored)',
    );
  }

  return { filled, scanned, remaining: await safeCountMissing() };
}

/** Best-effort count of rows still lacking an embedding. Returns 0 on error so
 *  a transient SQLite failure never propagates out of the best-effort backfill. */
async function safeCountMissing(): Promise<number> {
  try {
    return await getContextStoreClient().run<number>('countProjectionsMissingEmbedding', []);
  } catch {
    return 0;
  }
}
