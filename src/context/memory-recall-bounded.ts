/**
 * L3 bounded recall orchestration — the worker-side of front-of-turn recall.
 *
 * These functions run INSIDE the context-store worker (imported by
 * `context-store-worker.ts`). They collect candidates, rank/rerank, and return
 * at most `limit` items + bounded stats, so candidate embedding BLOBs and
 * unbounded row sets never cross back to the main thread.
 *
 * The semantic rerank reuses the SAME `rerankCandidatesBySemantic` scoring loop
 * as the main-thread `searchLocalMemorySemantic`, so the warm-cache top-N is
 * identical (structural parity). The ONLY difference: the worker carries no
 * embedding model, so a candidate whose persisted vector is missing/stale gets
 * a text/exact fallback score here (and is lazily filled off-path) instead of
 * being embedded inline.
 *
 * Imports are worker-safe: `memory-recall-core` (pure + store reads),
 * `context-store` (reads), `embedding`'s pure `decodeEmbedding` (no eager model
 * load), and the shared embed-source formula.
 */
import {
  searchLocalMemory,
  rerankCandidatesBySemantic,
  isTrivialRecallQuery,
  computeStats,
  type MemorySearchQuery,
  searchLocalMemoryAuthorized,
  type MemorySearchResult,
  type SemanticRerankParams,
  type AuthorizedMemorySearchQuery,
} from './memory-recall-core.js';
import { getProjectionEmbeddings } from '../store/context-store.js';
import { decodeEmbedding } from './embedding.js';
import { composeEmbedSourceText } from '../../shared/memory-content-hash.js';
import { selectStartupMemoryItems, type StartupMemorySelectionOptions } from './startup-memory.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import type { MemorySearchResultItem } from './memory-recall-core.js';

const UNKNOWN_PROJECT = '__unknown_current_project__';

/** L3 substring recall — returns at most `query.limit` items + bounded stats. */
export function searchLocalMemoryBounded(query: MemorySearchQuery): MemorySearchResult {
  return searchLocalMemory(query);
}


/** R5 authorized management search — normal priority at the caller; worker-side
 *  collection so management/MCP queries do not execute synchronous SQLite on the
 *  daemon main thread. */
export function searchLocalMemoryAuthorizedBounded(query: AuthorizedMemorySearchQuery): MemorySearchResult {
  return searchLocalMemoryAuthorized(query);
}

/** L3 startup-memory selection — project-scoped bounded loading (no embedding;
 *  substring-based). Returns at most `options.totalLimit` items. */
export function selectStartupMemoryBounded(
  namespace: ContextNamespace,
  options: StartupMemorySelectionOptions = {},
): MemorySearchResultItem[] {
  return selectStartupMemoryItems(namespace, options);
}

/**
 * L3 semantic recall. `queryEmbedding` is computed on the main thread (via the
 * existing embedding worker) and passed in; `redactPatterns` and
 * `scoringWeights` are resolved on the main thread too. The worker decodes
 * persisted candidate vectors and reranks — it never calls the embedding model.
 */
export async function searchLocalMemorySemanticBounded(
  query: MemorySearchQuery,
  queryEmbedding: Float32Array,
  redactPatterns: RegExp[],
  scoringWeights: SemanticRerankParams['scoringWeights'],
): Promise<MemorySearchResult> {
  if (isTrivialRecallQuery(query.query)) {
    const emptyStats = computeStats([]);
    return {
      items: [],
      stats: { ...emptyStats, matchedRecords: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 },
    };
  }

  // Broaden to a candidate pool (drop the text filter), mirroring the main path.
  const broadQuery: MemorySearchQuery = {
    ...query,
    query: undefined,
    limit: Math.max((query.limit ?? 5) * 4, 40),
  };
  const candidates = searchLocalMemory(broadQuery);
  if (candidates.items.length === 0 || !query.query) return searchLocalMemory(query);

  const processedIds = candidates.items.filter((i) => i.type === 'processed').map((i) => i.id);
  const stored = processedIds.length > 0 ? getProjectionEmbeddings(processedIds) : null;

  const currentProjectId = query.namespace?.projectId ?? query.repo ?? UNKNOWN_PROJECT;
  const currentEnterpriseId = query.currentEnterpriseId ?? query.namespace?.enterpriseId;

  const topItems = await rerankCandidatesBySemantic(
    {
      candidates: candidates.items,
      queryEmbedding,
      queryText: query.query,
      limit: query.limit ?? 5,
      scoringWeights,
      currentProjectId,
      currentEnterpriseId,
    },
    (item) => {
      // The worker NEVER runs the embedding model. Decode the persisted BLOB
      // only when its source text still matches; otherwise return null so the
      // rerank uses the text/exact fallback for that candidate.
      if (item.type !== 'processed' || !stored) return null;
      const row = stored.get(item.id);
      if (!row?.embedding) return null;
      const text = composeEmbedSourceText(item.summary, item.content ?? '', redactPatterns);
      if (row.embeddingSource !== text) return null;
      return decodeEmbedding(row.embedding);
    },
  );

  return { items: topItems, stats: candidates.stats };
}
