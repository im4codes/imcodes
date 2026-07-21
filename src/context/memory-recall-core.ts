/**
 * Worker-safe memory recall core.
 *
 * This module contains the substring (`searchLocalMemory`) recall path, the
 * trivial-query filter, the content-dedup helper, the shared search types, and
 * the semantic rerank scoring loop (`rerankCandidatesBySemantic`). It is split
 * out of `memory-search.ts` so a worker thread can run recall WITHOUT pulling
 * main-thread-only dependencies (the embedding model in `./embedding.js`, the
 * `./memory-config-resolver.js` value graph → `session-store`, or
 * `./context-model-config.js`).
 *
 * Allowed dependencies (worker-safe):
 *   - `../store/context-store.js` (SQLite reads)
 *   - `../../shared/*` pure helpers (scoring, fingerprint, search-text, hash,
 *     embedding cosine similarity, types)
 *   - type-only imports (erased at runtime)
 *
 * MUST NOT import (directly or transitively-at-module-load):
 *   - `./embedding.js` (the model)
 *   - `./memory-config-resolver.js` as a VALUE (type-only is fine — erased)
 *   - `./context-model-config.js`
 *   - `../store/session-store.js`
 */
import type {
  ContextScope,
  ContextNamespace,
  LocalContextEvent,
  ProcessedContextClass,
  ProcessedContextProjection,
  ProcessedContextProjectionStatus,
  ContextMemoryStatsView,
} from '../../shared/context-types.js';
import type { ObservationClass, ObservationState } from '../../shared/memory-observation.js';
import { projectionSemanticContent } from '../../shared/memory-content-hash.js';
import { cosineSimilarity } from '../../shared/embedding-config.js';
import { computeRelevanceScore, type ProjectionClass } from '../../shared/memory-scoring.js';
import { normalizeSummaryForFingerprint } from '../../shared/memory-fingerprint.js';
import { memoryTextMatchesQuery } from '../../shared/memory-search-text.js';
// Type-only import: erased at runtime, so the worker never loads
// memory-config-resolver (which would drag in session-store et al.).
import type { MemoryConfigResolver } from './memory-config-resolver.js';
import {
  listContextEvents,
  listDirtyTargets,
  listContextNamespaces,
  listContextObservations,
  queryProcessedProjections,
  LEGACY_DAEMON_LOCAL_USER_ID,
  type ContextNamespaceRow,
  type ContextObservationRow,
} from '../store/context-store.js';

// ── Query types ──────────────────────────────────────────────────────────────

export interface MemorySearchQuery {
  /** Substring to match in summary/content text. */
  query?: string;
  /** Filter by effective namespace. When provided, namespace fields are matched exactly. */
  namespace?: ContextNamespace;
  /** Filter by scope without requiring an exact namespace match. */
  scope?: ContextScope;
  /** Optional enterprise context used for ranking when search scope is broader than one namespace. */
  currentEnterpriseId?: string;
  /** Filter by canonical repository ID (matches namespace.projectId). */
  repo?: string;
  /** Optional owner/user filter used by authenticated management reads. */
  userId?: string;
  /** Include legacy local personal rows that have no durable owner id. */
  includeLegacyPersonalOwner?: boolean;
  /** Filter by projection class. */
  projectionClass?: ProcessedContextClass;
  /** Include raw unprocessed staged events. */
  includeRaw?: boolean;
  /** Event type filter (only for raw events). */
  eventType?: string;
  /** Time range: only include items created after this timestamp (ms). */
  after?: number;
  /** Time range: only include items created before this timestamp (ms). */
  before?: number;
  /** Maximum number of results to return. */
  limit?: number;
  /** Include archived processed projections. */
  includeArchived?: boolean;
  /** Include first-class observation rows alongside processed projections. */
  includeObservations?: boolean;
  /** Filter observation rows by state. Defaults to candidate/active/promoted for search. */
  observationStates?: readonly ObservationState[];
  /** Filter observation rows by class. */
  observationClass?: ObservationClass;
  /** Result offset for pagination. */
  offset?: number;
  /** Optional project/namespace-aware config resolver for embedding-source redaction. */
  memoryConfigResolver?: MemoryConfigResolver;
  /** Explicit fallback cwd for legacy/local callers without a namespace registration. */
  memoryConfigCwd?: string;
}

export interface MemorySearchResultItem {
  type: 'raw' | 'processed' | 'observation';
  id: string;
  projectId: string;
  scope: string;
  enterpriseId?: string;
  workspaceId?: string;
  userId?: string;
  eventType?: string;
  projectionClass?: ProcessedContextClass;
  /** Session whose timeline produced this projection, when provenance is known. */
  sourceSessionName?: string;
  summary: string;
  content?: string;
  createdAt: number;
  updatedAt?: number;
  hitCount?: number;
  lastUsedAt?: number;
  status?: ProcessedContextProjectionStatus;
  observationClass?: ObservationClass;
  observationState?: ObservationState;
  matchKind?: 'exact' | 'semantic' | 'trigram';
  sourceEventCount?: number;
  sourceEventIds?: string[];
  processingModel?: string;
  relevanceScore?: number;
}


export interface MemorySearchResult {
  items: MemorySearchResultItem[];
  stats: ContextMemoryStatsView;
}

export interface AuthorizedMemorySearchQuery extends Omit<MemorySearchQuery, 'namespace' | 'repo' | 'includeRaw'> {
  /** Exact namespaces the management caller is authorized to search. */
  authorizedNamespaces: readonly ContextNamespace[];
}


// ── Authorized management read (worker-safe R5 path) ─────────────────────────

export function searchLocalMemoryAuthorized(query: AuthorizedMemorySearchQuery): MemorySearchResult {
  const allItems: MemorySearchResultItem[] = [];
  const seenProjectionIds = new Set<string>();
  const seenObservationIds = new Set<string>();
  const requestedWindow = Math.max((query.limit ?? 50) + (query.offset ?? 0), query.limit ?? 50, 50);

  for (const namespace of query.authorizedNamespaces) {
    const projections = queryProcessedProjections({
      scope: namespace.scope,
      enterpriseId: namespace.enterpriseId,
      workspaceId: namespace.workspaceId,
      userId: namespace.userId,
      projectId: namespace.projectId,
      includeLegacyPersonalOwner: query.includeLegacyPersonalOwner,
      projectionClass: query.projectionClass,
      query: query.query,
      includeArchived: query.includeArchived,
      limit: requestedWindow,
    });
    for (const projection of projections) {
      if (seenProjectionIds.has(projection.id)) continue;
      seenProjectionIds.add(projection.id);
      const item = projectionToItem(projection);
      if (matchesQuery(item, query)) {
        allItems.push(withMatchKind(item, query));
      }
    }
    if (!query.projectionClass) {
      for (const item of collectObservationItems({ ...query, namespace })) {
        if (seenObservationIds.has(item.id)) continue;
        seenObservationIds.add(item.id);
        if (matchesQuery(item, { ...query, namespace })) {
          allItems.push(withMatchKind(item, query));
        }
      }
    }
  }

  allItems.sort(compareSearchItems);
  const stats = computeStats(allItems);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  const paginated = allItems.slice(offset, offset + limit);

  return {
    items: paginated,
    stats: {
      ...stats,
      matchedRecords: allItems.length,
      stagedEventCount: 0,
      dirtyTargetCount: listDirtyTargets().length,
      pendingJobCount: 0,
    },
  };
}

// ── Trivial-query filter ───────────────────────────────────────────────────────

/**
 * Detects P2P orchestration prompts — multi-agent discussion scaffolding
 * generated by the P2P system, not real user queries. These carry stable
 * markers injected by the orchestrator and should NEVER drive memory recall:
 * they pollute context with irrelevant historical matches while producing
 * no useful retrieval signal.
 */
export function isP2pOrchestrationPrompt(text: string): boolean {
  // Stable markers emitted by P2P round prompts — see p2p-orchestrator / p2p-modes.
  // Any one of these is sufficient to identify the prompt as orchestration.
  if (/\[P2P Discussion Task\s+—\s+run\s+[a-f0-9-]+\]/i.test(text)) return true;
  if (/\[Round\s+\d+\/\d+\s+—/i.test(text)) return true;
  if (/Your identity for this discussion run is/i.test(text)) return true;
  if (/\.imc\/discussions\/[a-f0-9-]+\.md/i.test(text)) return true;
  return false;
}

/**
 * Returns true when the query text is too trivial to drive meaningful recall.
 * Language-agnostic: counts tokens (whitespace + punctuation separated) and
 * total non-whitespace characters. Covers short continuation words in any
 * language ("continue", "继续", "好", "ok", "next", single emoji, etc.) without
 * maintaining a blacklist. Also filters P2P orchestration prompts.
 */
export function isTrivialRecallQuery(text: string | undefined | null): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  // P2P orchestration prompts are long but semantically empty for user-memory
  // recall — they're agent-to-agent scaffolding, not user intent.
  if (isP2pOrchestrationPrompt(trimmed)) return true;
  // Count semantic units: space-separated tokens + individual CJK characters.
  // CJK has no word boundaries, so each ideograph counts as its own unit.
  // This avoids language-specific blacklists.
  let unitCount = 0;
  // Non-CJK tokens (Latin, Cyrillic, etc. — split on whitespace + punctuation)
  const nonCjk = trimmed.replace(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu, ' ');
  unitCount += nonCjk.split(/[\s\p{P}]+/u).filter(Boolean).length;
  // CJK: each ideograph/hangul/kana counts as a unit
  const cjkMatches = trimmed.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu);
  unitCount += cjkMatches?.length ?? 0;
  // Single unit (one word or one CJK char) is always trivial
  if (unitCount < 2) return true;
  // Require at least 4 non-whitespace/punctuation characters.
  // Catches "好的" (2 CJK, 2 chars) but allows "fix bug" (2 words, 6 chars)
  // and "enterprise bug" (2 words, 13 chars).
  const contentChars = trimmed.replace(/[\s\p{P}]/gu, '').length;
  if (contentChars < 4) return true;
  return false;
}

/** Collapse content-equivalent scored items so three identical "Key decisions"
 *  summaries stored at different turns don't all surface as separate cards.
 *  Preserves the original rank order — the first occurrence of each
 *  fingerprint wins, so the highest-scoring duplicate is the one retained.
 *  Scoped by projectionClass to keep recent_summary and durable_memory_candidate
 *  entries independent even when they happen to share text. */
export function dedupByNormalizedSummary<T extends { item: MemorySearchResultItem }>(scored: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of scored) {
    const summary = entry.item.summary ?? '';
    if (!summary) {
      out.push(entry);
      continue;
    }
    const itemClass = entry.item.projectionClass ?? entry.item.observationClass ?? entry.item.eventType ?? 'recent_summary';
    const key = `${entry.item.type}\u0000${itemClass}\u0000${normalizeSummaryForFingerprint(summary)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ── Semantic rerank (worker-safe scoring loop) ─────────────────────────────────

export interface SemanticRerankParams {
  candidates: MemorySearchResultItem[];
  queryEmbedding: Float32Array;
  queryText: string;                 // for matchKind (itemMatchesText)
  limit: number;
  scoringWeights: Parameters<typeof computeRelevanceScore>[1];
  currentProjectId: string;
  currentEnterpriseId: string | undefined;
}

/** Rerank candidates by semantic similarity. `getItemEmbedding` supplies each
 *  candidate's embedding (main thread: decode-stored-or-recompute; worker:
 *  decode-stored-or-null). The scoring/sort/dedup/slice is IDENTICAL to the
 *  current searchLocalMemorySemantic body so both callers produce the same
 *  top-N.
 *
 *  Core does NOT import the embedding model and does NOT call
 *  `itemEmbedText`/redaction itself — the per-item embedding acquisition is
 *  delegated entirely to the `getItemEmbedding` callback, which returns the
 *  already-resolved Float32Array (or null). */
export async function rerankCandidatesBySemantic(
  params: SemanticRerankParams,
  getItemEmbedding: (item: MemorySearchResultItem) => Float32Array | null | Promise<Float32Array | null>,
): Promise<MemorySearchResultItem[]> {
  const { candidates, queryEmbedding, queryText, limit, scoringWeights, currentProjectId, currentEnterpriseId } = params;

  // Score each candidate by cosine similarity
  const scored: Array<{ item: MemorySearchResultItem; score: number }> = [];
  for (const item of candidates) {
    const itemEmb = await getItemEmbedding(item);

    if (itemEmb) {
      const similarity = cosineSimilarity(queryEmbedding, itemEmb);
      const projectionClass = (item.projectionClass ?? 'recent_summary') as ProjectionClass;
      const relevanceScore = computeRelevanceScore({
        similarity,
        lastUsedAt: item.lastUsedAt ?? item.updatedAt ?? item.createdAt,
        hitCount: item.hitCount ?? 0,
        projectionClass,
        memoryProjectId: item.projectId,
        currentProjectId,
        memoryEnterpriseId: item.enterpriseId,
        currentEnterpriseId,
      }, scoringWeights);
      const matchKind = itemMatchesText(item, queryText) ? 'exact' : 'semantic';
      scored.push({
        item: {
          ...item,
          relevanceScore,
          matchKind,
        },
        score: relevanceScore + (matchKind === 'exact' ? 100 : 0),
      });
    } else {
      const matchKind = itemMatchesText(item, queryText) ? 'exact' : undefined;
      scored.push({ item: matchKind ? { ...item, matchKind } : item, score: matchKind === 'exact' ? 100 : 0 });
    }
  }

  // Sort by semantic similarity
  scored.sort((a, b) => b.score - a.score);
  // Content-level dedup: stored duplicates from before writeProcessedProjection
  // started reusing rows can still surface at recall time with identical
  // summaries and near-identical similarity scores. Keep only the highest-
  // scoring item per normalized summary (within the same projection class)
  // so the user never sees three copies of the same "Key decisions" card.
  const dedupedByContent = dedupByNormalizedSummary(scored);
  return dedupedByContent.slice(0, limit).map((s) => s.item);
}

// ── Substring search implementation ────────────────────────────────────────────

export function searchLocalMemory(query: MemorySearchQuery): MemorySearchResult {
  const allItems: MemorySearchResultItem[] = [];

  // Collect processed projections from local SQLite
  const processedByNs = collectProcessedProjections(query);
  for (const projection of processedByNs) {
    const item = projectionToItem(projection);
    if (matchesQuery(item, query)) {
      allItems.push(withMatchKind(item, query));
    }
  }

  if (query.includeObservations !== false && !query.projectionClass) {
    const observationItems = collectObservationItems(query);
    for (const item of observationItems) {
      if (matchesQuery(item, query)) {
        allItems.push(withMatchKind(item, query));
      }
    }
  }

  // Collect raw events if requested
  if (query.includeRaw) {
    const rawItems = collectRawEvents(query);
    for (const item of rawItems) {
      if (matchesQuery(item, query)) {
        allItems.push(item);
      }
    }
  }

  allItems.sort(compareSearchItems);

  // Compute stats before pagination
  const stats = computeStats(allItems);

  // Apply pagination
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  const paginated = allItems.slice(offset, offset + limit);

  return {
    items: paginated,
    stats: {
      ...stats,
      matchedRecords: allItems.length,
      stagedEventCount: query.includeRaw ? allItems.filter((i) => i.type === 'raw').length : 0,
      dirtyTargetCount: listDirtyTargets().length,
      pendingJobCount: 0,
    },
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

export function collectProcessedProjections(query: MemorySearchQuery): ProcessedContextProjection[] {
  const baseFilters = {
    scope: query.namespace?.scope ?? query.scope,
    enterpriseId: query.namespace?.enterpriseId,
    workspaceId: query.namespace?.workspaceId,
    userId: query.namespace?.userId ?? query.userId,
    projectId: query.namespace?.projectId ?? query.repo,
    includeLegacyPersonalOwner: query.includeLegacyPersonalOwner,
    projectionClass: query.projectionClass,
    query: query.query,
    includeArchived: query.includeArchived,
  };
  const projections = queryProcessedProjections(baseFilters);
  const namespace = query.namespace;
  if (
    !namespace
    || namespace.scope === 'user_private'
    || !namespace.userId?.trim()
    || !namespace.projectId?.trim()
  ) {
    return projections;
  }

  const bridged = queryProcessedProjections({
    ...baseFilters,
    scope: 'user_private',
    enterpriseId: undefined,
    workspaceId: undefined,
    userId: namespace.userId,
    projectId: namespace.projectId,
    includeLegacyPersonalOwner: false,
  });
  if (bridged.length === 0) return projections;

  const seen = new Set(projections.map((projection) => projection.id));
  const out = [...projections];
  for (const projection of bridged) {
    if (seen.has(projection.id)) continue;
    seen.add(projection.id);
    out.push(projection);
  }
  return out;
}

export function collectRawEvents(query: MemorySearchQuery): MemorySearchResultItem[] {
  const items: MemorySearchResultItem[] = [];
  const dirtyTargets = listDirtyTargets();
  for (const dt of dirtyTargets) {
    if (!matchesNamespace(dt.target.namespace, query)) continue;
    const events = listContextEvents(dt.target);
    for (const event of events) {
      if (query.eventType && event.eventType !== query.eventType) continue;
      items.push(eventToItem(event));
    }
  }
  return items;
}

export function observationNamespace(row: ContextNamespaceRow | undefined, fallbackScope: string): ContextNamespace {
  return {
    scope: (row?.scope ?? fallbackScope) as ContextNamespace['scope'],
    projectId: row?.projectId,
    userId: row?.userId,
    workspaceId: row?.workspaceId,
    enterpriseId: row?.orgId,
  };
}

export function observationNamespacesForQuery(query: MemorySearchQuery): Map<string, ContextNamespaceRow> {
  const rows = listContextNamespaces();
  const out = new Map<string, ContextNamespaceRow>();
  for (const row of rows) {
    const namespace = observationNamespace(row, row.scope);
    if (matchesNamespace(namespace, query)) {
      out.set(row.id, row);
      continue;
    }
    const requested = query.namespace;
    // Manual MCP observations are stored as user_private rows. Runtime startup
    // and some legacy recall paths may search the corresponding personal
    // namespace, so allow same-owner, same-project user_private observations
    // to remain discoverable without exposing cross-user or cross-project data.
    if (
      requested
      && row.scope === 'user_private'
      && row.userId
      && row.userId === requested.userId
      && !!requested.projectId
      && row.projectId === requested.projectId
    ) {
      out.set(row.id, row);
    }
  }
  return out;
}

export function collectObservationItems(query: MemorySearchQuery): MemorySearchResultItem[] {
  const namespaceRows = observationNamespacesForQuery(query);
  if (namespaceRows.size === 0) return [];
  const states: readonly ObservationState[] = query.observationStates ?? ['candidate', 'active', 'promoted'];
  const rows = listContextObservations({
    class: query.observationClass,
    state: states,
  });
  const items: MemorySearchResultItem[] = [];
  for (const row of rows) {
    if (row.projectionId) continue;
    const namespaceRow = namespaceRows.get(row.namespaceId);
    if (!namespaceRow) continue;
    items.push(observationToItem(row, namespaceRow));
  }
  return items;
}

export function projectionToItem(projection: ProcessedContextProjection): MemorySearchResultItem {
  const content = projectionSemanticContent(projection.content);
  const contentRecord = content && typeof content === 'object' && !Array.isArray(content)
    ? content as Record<string, unknown>
    : undefined;
  return {
    type: 'processed',
    id: projection.id,
    projectId: projection.namespace.projectId ?? '',
    scope: projection.namespace.scope,
    enterpriseId: projection.namespace.enterpriseId,
    workspaceId: projection.namespace.workspaceId,
    userId: projection.namespace.userId,
    projectionClass: projection.class,
    ...(typeof contentRecord?.sessionName === 'string' && contentRecord.sessionName.trim()
      ? { sourceSessionName: contentRecord.sessionName.trim() }
      : {}),
    summary: projection.summary,
    content: contentRecord ? JSON.stringify(contentRecord) : undefined,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    hitCount: projection.hitCount,
    lastUsedAt: projection.lastUsedAt,
    status: projection.status,
    sourceEventCount: typeof contentRecord?.eventCount === 'number' ? contentRecord.eventCount : undefined,
    sourceEventIds: projection.sourceEventIds,
    processingModel: typeof contentRecord?.primaryContextModel === 'string' ? contentRecord.primaryContextModel : undefined,
  };
}

export function observationText(observation: ContextObservationRow): string {
  const rawText = observation.content.text;
  if (typeof rawText === 'string' && rawText.trim()) return rawText.trim();
  const title = observation.content.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return JSON.stringify(observation.content);
}

export function observationSummary(observation: ContextObservationRow): string {
  const text = observationText(observation).replace(/\s+/g, ' ').trim();
  const title = typeof observation.content.title === 'string' ? observation.content.title.trim() : '';
  const base = title && !text.startsWith(title) ? `${title}: ${text}` : text;
  return base.length > 500 ? `${base.slice(0, 497)}...` : base;
}

export function observationToItem(observation: ContextObservationRow, namespaceRow: ContextNamespaceRow): MemorySearchResultItem {
  return {
    type: 'observation',
    id: observation.id,
    projectId: namespaceRow.projectId ?? '',
    scope: observation.scope,
    enterpriseId: namespaceRow.orgId,
    workspaceId: namespaceRow.workspaceId,
    userId: namespaceRow.userId,
    observationClass: observation.class,
    observationState: observation.state,
    summary: observationSummary(observation),
    content: JSON.stringify(observation.content),
    createdAt: observation.createdAt,
    updatedAt: observation.updatedAt,
    sourceEventCount: observation.sourceEventIds.length || 1,
    sourceEventIds: observation.sourceEventIds,
  };
}

export function eventToItem(event: LocalContextEvent): MemorySearchResultItem {
  return {
    type: 'raw',
    id: event.id,
    projectId: event.target.namespace.projectId ?? '',
    scope: event.target.namespace.scope,
    enterpriseId: event.target.namespace.enterpriseId,
    workspaceId: event.target.namespace.workspaceId,
    userId: event.target.namespace.userId,
    eventType: event.eventType,
    summary: event.content ?? event.eventType,
    createdAt: event.createdAt,
  };
}

export function itemNamespace(item: MemorySearchResultItem): ContextNamespace {
  return {
    scope: item.scope as ContextNamespace['scope'],
    projectId: item.projectId,
    userId: item.userId,
    workspaceId: item.workspaceId,
    enterpriseId: item.enterpriseId,
  };
}

export function matchesQuery(item: MemorySearchResultItem, query: MemorySearchQuery): boolean {
  if (!matchesNamespace(item, query)) return false;
  if (query.projectionClass && item.projectionClass !== query.projectionClass) return false;
  if (query.observationClass && item.observationClass !== query.observationClass) return false;
  if (query.observationStates && item.observationState && !query.observationStates.includes(item.observationState)) return false;
  if (query.eventType && item.type === 'raw' && item.eventType !== query.eventType) return false;
  if (query.after && item.createdAt < query.after) return false;
  if (query.before && item.createdAt > query.before) return false;
  if (query.query && !itemMatchesText(item, query.query)) return false;
  return true;
}

export function itemMatchesText(item: MemorySearchResultItem, query: string | undefined): boolean {
  return memoryTextMatchesQuery(itemHaystack(item), query);
}

export function itemHaystack(item: MemorySearchResultItem): string {
  return [
    item.summary,
    item.content,
    item.projectionClass,
    item.observationClass,
    item.eventType,
    ...(item.sourceEventIds ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ').toLowerCase();
}

export function withMatchKind(item: MemorySearchResultItem, query: MemorySearchQuery): MemorySearchResultItem {
  if (!query.query?.trim()) return item;
  return itemMatchesText(item, query.query) ? { ...item, matchKind: 'exact' } : item;
}

export function compareSearchItems(a: MemorySearchResultItem, b: MemorySearchResultItem): number {
  const matchRank = (item: MemorySearchResultItem) => item.matchKind === 'exact' ? 0 : item.matchKind === 'semantic' ? 1 : item.matchKind === 'trigram' ? 2 : 3;
  const typeRank = (item: MemorySearchResultItem) => item.type === 'observation' ? 0 : item.projectionClass === 'durable_memory_candidate' ? 1 : item.type === 'processed' ? 2 : 3;
  const matchDiff = matchRank(a) - matchRank(b);
  if (matchDiff !== 0) return matchDiff;
  const typeDiff = typeRank(a) - typeRank(b);
  if (typeDiff !== 0) return typeDiff;
  return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
}

export function matchesNamespace(
  item: Pick<MemorySearchResultItem, 'projectId' | 'scope' | 'enterpriseId' | 'workspaceId' | 'userId'>
    | ContextNamespace,
  query: MemorySearchQuery,
): boolean {
  const namespace = query.namespace;
  if (namespace) {
    if (
      item.scope === 'user_private'
      && namespace.scope !== 'user_private'
      && namespace.userId
      && item.userId === namespace.userId
      && !!namespace.projectId
      && item.projectId === namespace.projectId
    ) {
      return true;
    }
    if (item.projectId !== namespace.projectId) return false;
    if (item.scope !== namespace.scope) return false;
    if ((item.enterpriseId ?? undefined) !== (namespace.enterpriseId ?? undefined)) return false;
    if ((item.workspaceId ?? undefined) !== (namespace.workspaceId ?? undefined)) return false;
    if ((item.userId ?? undefined) !== (namespace.userId ?? undefined)) {
      if (!(query.includeLegacyPersonalOwner && namespace.scope === 'personal' && (!item.userId || item.userId === LEGACY_DAEMON_LOCAL_USER_ID))) return false;
    }
    return true;
  }
  if (query.scope && item.scope !== query.scope) return false;
  if (query.repo && item.projectId !== query.repo) return false;
  if (query.userId && item.userId !== query.userId) {
    if (!(query.includeLegacyPersonalOwner && item.scope === 'personal' && (!item.userId || item.userId === LEGACY_DAEMON_LOCAL_USER_ID))) return false;
  }
  return true;
}

export function computeStats(items: MemorySearchResultItem[]): Omit<ContextMemoryStatsView, 'matchedRecords' | 'stagedEventCount' | 'dirtyTargetCount' | 'pendingJobCount'> {
  const projects = new Set<string>();
  let totalRecords = 0;
  let recentSummaryCount = 0;
  let durableCandidateCount = 0;

  for (const item of items) {
    totalRecords++;
    projects.add(item.projectId);
    if (item.projectionClass === 'recent_summary') recentSummaryCount++;
    if (item.projectionClass === 'durable_memory_candidate') durableCandidateCount++;
  }

  return {
    totalRecords,
    recentSummaryCount,
    durableCandidateCount,
    projectCount: projects.size,
  };
}
