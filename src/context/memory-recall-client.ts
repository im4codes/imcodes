/**
 * Main-thread bridge to the L3 worker recall RPCs.
 *
 * The two-hop semantic dataflow (design Decision 1): the main thread embeds the
 * query via the EXISTING embedding worker and resolves redaction patterns +
 * scoring weights (all main-thread-only), then hands the cloneable payload to
 * the context-store worker's `searchLocalMemorySemanticBounded` RPC, which
 * reranks against persisted candidate vectors and returns <=limit items. The
 * `MemoryConfigResolver` closure is stripped before the RPC (non-cloneable).
 *
 * Returns `null` when the worker path is unavailable (model missing, worker not
 * warm, timeout, or error) so the caller can fall back to the in-process
 * `searchLocalMemorySemantic` during the migration — recall never blocks or
 * throws on the front-of-turn path.
 */
import { ContextStoreError, getContextStoreClient } from '../store/context-store-worker-client.js';
import { CONTEXT_STORE_RPC_ERROR, CONTEXT_STORE_RPC_TIMEOUT_MS } from '../../shared/context-store-rpc.js';
import {
  isTrivialRecallQuery,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemorySearchResultItem,
  type AuthorizedMemorySearchQuery,
} from './memory-recall-core.js';
import { resolveMemoryConfigForNamespace } from './memory-config-resolver.js';
import { getContextModelConfig } from './context-model-config.js';
import { selectStartupMemoryItems, type StartupMemorySelectionOptions } from './startup-memory.js';
import { searchLocalMemorySemantic } from './memory-search.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MEMORY_MCP_DEGRADED_REASON } from '../../shared/memory-ws.js';

/** Strip the non-cloneable resolver closure so the query can cross the worker
 *  boundary via structured clone. */
function toCloneableQuery(query: MemorySearchQuery): MemorySearchQuery {
  const { memoryConfigResolver: _omit, ...rest } = query;
  return rest;
}

function toCloneableAuthorizedQuery(query: AuthorizedMemorySearchQuery): AuthorizedMemorySearchQuery {
  const { memoryConfigResolver: _omit, authorizedNamespaces, ...rest } = query;
  return { ...rest, authorizedNamespaces: [...authorizedNamespaces] };
}

async function prepareSemanticManagementArgs(query: MemorySearchQuery): Promise<[MemorySearchQuery, Float32Array, RegExp[], ReturnType<typeof getContextModelConfig>['memoryScoringWeights']]> {
  const { generateEmbedding } = await import('./embedding.js');
  const queryEmbedding = await generateEmbedding(query.query ?? '');
  if (!queryEmbedding) {
    const error = new ContextStoreError(
      CONTEXT_STORE_RPC_ERROR.unavailable,
      'semantic memory query embedding unavailable',
    );
    (error as ContextStoreError & { degradedReason?: string }).degradedReason =
      MEMORY_MCP_DEGRADED_REASON.SEMANTIC_EMBEDDING_UNAVAILABLE;
    throw error;
  }
  const namespace = query.namespace;
  const config = namespace
    ? (query.memoryConfigResolver?.(namespace)
      ?? resolveMemoryConfigForNamespace(namespace, { fallbackCwd: query.memoryConfigCwd }))
    : undefined;
  const redactPatterns = config?.extraRedactPatterns ?? [];
  const scoringWeights = getContextModelConfig().memoryScoringWeights;
  return [toCloneableQuery(query), queryEmbedding, redactPatterns, scoringWeights];
}

/**
 * Run front-of-turn semantic recall through the context-store worker. Returns
 * `null` to signal "fall back to the in-process path" (model unavailable /
 * worker not warm / timeout / error) — callers must handle null.
 */
export async function searchLocalMemorySemanticViaWorker(
  query: MemorySearchQuery,
): Promise<MemorySearchResult | null> {
  if (!query.query || isTrivialRecallQuery(query.query)) return null;

  const client = getContextStoreClient();
  if (!client.isReady) return null; // not warm yet → caller uses the fallback path

  // Hop 1: embed the query on the main thread (existing embedding worker).
  const { generateEmbedding } = await import('./embedding.js');
  const queryEmbedding = await generateEmbedding(query.query);
  if (!queryEmbedding) return null; // model unavailable → fall back

  // Resolve main-thread-only inputs and pass them as cloneable RPC args.
  const namespace = query.namespace;
  const config = namespace
    ? (query.memoryConfigResolver?.(namespace)
      ?? resolveMemoryConfigForNamespace(namespace, { fallbackCwd: query.memoryConfigCwd }))
    : undefined;
  const redactPatterns = config?.extraRedactPatterns ?? [];
  const scoringWeights = getContextModelConfig().memoryScoringWeights;

  const timeoutMs = Math.min(getRecallBudgetMs(), CONTEXT_STORE_RPC_TIMEOUT_MS.r1FrontOfTurnMax);
  try {
    // Hop 2: the worker reranks against persisted vectors and returns <=limit.
    return await client.call<MemorySearchResult>(
      'searchLocalMemorySemanticBounded',
      [toCloneableQuery(query), queryEmbedding, redactPatterns, scoringWeights],
      { priority: 'high', timeoutMs },
    );
  } catch {
    return null; // timeout / worker error → caller falls back, never throws
  }
}

/** Run front-of-turn substring recall through the worker. Returns `null` on
 *  worker-not-warm / error so the caller can fall back. */
export async function searchLocalMemoryViaWorker(
  query: MemorySearchQuery,
): Promise<MemorySearchResult | null> {
  const client = getContextStoreClient();
  if (!client.isReady) return null;
  const timeoutMs = Math.min(getRecallBudgetMs(), CONTEXT_STORE_RPC_TIMEOUT_MS.r1FrontOfTurnMax);
  try {
    return await client.call<MemorySearchResult>(
      'searchLocalMemoryBounded',
      [toCloneableQuery(query)],
      { priority: 'high', timeoutMs },
    );
  } catch {
    return null;
  }
}

/**
 * Run startup-memory selection through the worker (project-scoped substring
 * loading; no embedding). Returns `null` on worker-not-warm / timeout / error
 * so the caller falls back to the in-process selection.
 */
export async function selectStartupMemoryViaWorker(
  namespace: ContextNamespace,
  options: StartupMemorySelectionOptions = {},
): Promise<MemorySearchResultItem[] | null> {
  const client = getContextStoreClient();
  if (!client.isReady) return null;
  const timeoutMs = Math.min(getRecallBudgetMs(), CONTEXT_STORE_RPC_TIMEOUT_MS.r1FrontOfTurnMax);
  try {
    return await client.call<MemorySearchResultItem[]>(
      'selectStartupMemoryBounded',
      [namespace, options],
      { priority: 'high', timeoutMs },
    );
  } catch {
    return null;
  }
}


/** R5 management/MCP substring search through the worker. Unlike R1, this uses
 * normal priority, the 5s management timeout, and propagates unavailable/timeout
 * errors to the caller so management surfaces can return explicit degraded
 * metadata instead of a successful empty result. */
export async function searchLocalMemoryForManagement(
  query: MemorySearchQuery,
): Promise<MemorySearchResult> {
  return getContextStoreClient().run<MemorySearchResult>(
    'searchLocalMemoryBounded',
    [toCloneableQuery(query)],
    { priority: 'normal', timeoutMs: CONTEXT_STORE_RPC_TIMEOUT_MS.r3r5Management },
  );
}

/** R5 management/MCP semantic search through the worker. This is intentionally
 * separate from the R1 front-of-turn facade: it uses normal priority + the 5s
 * management timeout, and it throws on worker/model unavailable so callers can
 * expose explicit degraded metadata instead of silently returning R1-style empty. */
export async function searchLocalMemorySemanticForManagement(
  query: MemorySearchQuery,
): Promise<MemorySearchResult> {
  if (!query.query || isTrivialRecallQuery(query.query)) return emptyMemorySearchResult();
  const args = await prepareSemanticManagementArgs(query);
  return getContextStoreClient().run<MemorySearchResult>(
    'searchLocalMemorySemanticBounded',
    args,
    { priority: 'normal', timeoutMs: CONTEXT_STORE_RPC_TIMEOUT_MS.r3r5Management },
  );
}

/** R5 authorized management quick-search through the worker. */
export async function searchLocalMemoryAuthorizedForManagement(
  query: AuthorizedMemorySearchQuery,
): Promise<MemorySearchResult> {
  return getContextStoreClient().run<MemorySearchResult>(
    'searchLocalMemoryAuthorizedBounded',
    [toCloneableAuthorizedQuery(query)],
    { priority: 'normal', timeoutMs: CONTEXT_STORE_RPC_TIMEOUT_MS.r3r5Management },
  );
}

/** R1 budget for front-of-turn recall (overridable via env without importing
 *  the transport runtime). */
function getRecallBudgetMs(): number {
  const raw = process.env.IMCODES_TRANSPORT_CONTEXT_BUDGET_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return CONTEXT_STORE_RPC_TIMEOUT_MS.r1FrontOfTurnMax;
}

/** A bounded empty recall result (no items, zeroed stats). */
export function emptyMemorySearchResult(): MemorySearchResult {
  return {
    items: [],
    stats: {
      totalRecords: 0,
      matchedRecords: 0,
      recentSummaryCount: 0,
      durableCandidateCount: 0,
      projectCount: 0,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    },
  };
}

/**
 * Front-of-turn semantic recall façade. Runs in the worker (bounded L3 RPC); on
 * worker-not-ready / unavailable it returns:
 *   - PRODUCTION owner mode (`start()` called) -> a bounded EMPTY result, so the
 *     daemon main thread NEVER runs an in-process recall / `ensureDb()` during the
 *     warming / self-heal window (spec "Cold-start recall returns empty ...").
 *   - tests / CLI (`!started`) -> the in-process `searchLocalMemorySemantic`
 *     fallback (the single connection there is safe and is what those paths use).
 * Callers should use THIS instead of `searchLocalMemorySemanticViaWorker(q) ?? searchLocalMemorySemantic(q)`.
 */
export async function searchLocalMemorySemanticFrontOfTurn(
  query: MemorySearchQuery,
): Promise<MemorySearchResult> {
  const viaWorker = await searchLocalMemorySemanticViaWorker(query);
  if (viaWorker) return viaWorker;
  if (getContextStoreClient().isProductionOwner) return emptyMemorySearchResult();
  return searchLocalMemorySemantic(query);
}

/**
 * Startup-memory selection façade with the same production-owner gating: worker
 * when warm, bounded EMPTY (`[]`) in production owner mode when unavailable, and
 * the in-process `selectStartupMemoryItems` only in tests / CLI.
 */
export async function selectStartupMemoryForBootstrap(
  namespace: ContextNamespace,
  options: StartupMemorySelectionOptions = {},
): Promise<MemorySearchResultItem[]> {
  const viaWorker = await selectStartupMemoryViaWorker(namespace, options);
  if (viaWorker) return viaWorker;
  if (getContextStoreClient().isProductionOwner) return [];
  return selectStartupMemoryItems(namespace, options);
}
