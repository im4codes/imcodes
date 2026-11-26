/**
 * Memory search module — unified local search across staged events and processed projections.
 * Used by CLI (`imcodes memory`), WS command (`memory.search`), and web UI.
 */
import type { ProjectionClass } from '../../shared/memory-scoring.js';
import { computeRelevanceScore } from '../../shared/memory-scoring.js';
import { getContextModelConfig } from './context-model-config.js';
import { redactSensitiveText } from '../util/redact-secrets.js';
import { resolveMemoryConfigForNamespace } from './memory-config-resolver.js';
import {
  getProjectionEmbeddings,
  saveProjectionEmbedding,
} from '../store/context-store.js';
import {
  computeStats,
  dedupByNormalizedSummary,
  isP2pOrchestrationPrompt,
  isTrivialRecallQuery,
  itemMatchesText,
  itemNamespace,
  searchLocalMemory,
  searchLocalMemoryAuthorized,
  searchLocalMemoryCandidates,
  type AuthorizedMemorySearchQuery,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemorySearchResultItem,
} from './memory-recall-core.js';

export {
  dedupByNormalizedSummary,
  isP2pOrchestrationPrompt,
  isTrivialRecallQuery,
  searchLocalMemory,
  searchLocalMemoryAuthorized,
  type AuthorizedMemorySearchQuery,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemorySearchResultItem,
};

export type MemorySearchFormat = 'json' | 'document' | 'table';

// ── Search implementation ────────────────────────────────────────────────────

/**
 * Semantic search: fetch candidates via substring match, then re-rank by embedding similarity.
 * Falls back to plain searchLocalMemory if embedding model is unavailable.
 */

export async function searchLocalMemorySemantic(query: MemorySearchQuery): Promise<MemorySearchResult> {
  // Skip recall entirely for trivial queries (single-word "continue", "好", etc.)
  // These pollute context with irrelevant top-match-by-default results.
  if (isTrivialRecallQuery(query.query)) {
    const emptyStats = computeStats([]);
    return {
      items: [],
      stats: {
        ...emptyStats,
        matchedRecords: 0,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    };
  }
  // First, get candidates with relaxed text match (or no query filter for broader recall)
  const broadQuery = { ...query, query: undefined, limit: Math.max((query.limit ?? 5) * 4, 40) };
  const candidates = searchLocalMemoryCandidates(broadQuery);
  if (candidates.items.length === 0 || !query.query) return searchLocalMemory(query);

  try {
    const { generateEmbedding, cosineSimilarity, encodeEmbedding, decodeEmbedding } = await import('./embedding.js');
    const queryEmb = await generateEmbedding(query.query);
    if (!queryEmb) return searchLocalMemory(query); // model unavailable, fallback

    // Persistent embedding store: avoid recomputing the same Float32Array for
    // every candidate on every recall. The server already does this via
    // pgvector; the daemon mirrors that for local SQLite by stashing the
    // BLOB in context_processed_local.embedding.
    //
    // Batch-read stored embeddings for all "processed" candidates in one
    // query, then only invoke the model on rows that are missing or stale
    // (summary text changed since the stored vector was computed).
    const processedIds = candidates.items
      .filter((item) => item.type === 'processed')
      .map((item) => item.id);
    const storedEmbeddings = processedIds.length > 0
      ? getProjectionEmbeddings(processedIds)
      : new Map<string, ReturnType<typeof getProjectionEmbeddings> extends Map<string, infer V> ? V : never>();

    const itemEmbedText = (item: MemorySearchResultItem): string => {
      const namespace = itemNamespace(item);
      const config = query.memoryConfigResolver?.(namespace)
        ?? resolveMemoryConfigForNamespace(namespace, { fallbackCwd: query.memoryConfigCwd });
      return redactSensitiveText(`${item.summary} ${item.content ?? ''}`, config.extraRedactPatterns).slice(0, 500);
    };

    // Score each candidate by cosine similarity
    const scored: Array<{ item: MemorySearchResultItem; score: number }> = [];
    const currentProjectId = query.namespace?.projectId ?? query.repo ?? '__unknown_current_project__';
    const currentEnterpriseId = query.currentEnterpriseId ?? query.namespace?.enterpriseId;
    const scoringWeights = getContextModelConfig().memoryScoringWeights;
    for (const item of candidates.items) {
      const text = itemEmbedText(item);
      let itemEmb: Float32Array | null = null;

      // 1) Fast path: decode the stored BLOB if the source text still matches.
      if (item.type === 'processed') {
        const stored = storedEmbeddings.get(item.id);
        if (stored?.embedding && stored.embeddingSource === text) {
          itemEmb = decodeEmbedding(stored.embedding);
        }
      }

      // 2) Slow path: recompute and persist so the next recall is fast.
      if (!itemEmb) {
        itemEmb = await generateEmbedding(text);
        if (itemEmb && item.type === 'processed') {
          // Persist is best-effort — a transient SQLite write failure must
          // not break the in-progress recall.
          try {
            saveProjectionEmbedding(item.id, encodeEmbedding(itemEmb), text);
          } catch { /* ignore */ }
        }
      }

      if (itemEmb) {
        const similarity = cosineSimilarity(queryEmb, itemEmb);
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
        const matchKind = itemMatchesText(item, query.query) ? 'exact' : 'semantic';
        scored.push({
          item: {
            ...item,
            relevanceScore,
            matchKind,
          },
          score: relevanceScore + (matchKind === 'exact' ? 100 : 0),
        });
      } else {
        const matchKind = itemMatchesText(item, query.query) ? 'exact' : undefined;
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
    const limit = query.limit ?? 5;
    const topItems = dedupedByContent.slice(0, limit).map((s) => s.item);

    return {
      items: topItems,
      stats: candidates.stats,
    };
  } catch {
    // Embedding failed — fall back to plain search
    return searchLocalMemory(query);
  }
}

// ── Output formatting ────────────────────────────────────────────────────────

export function formatSearchResults(result: MemorySearchResult, format: MemorySearchFormat): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }
  if (format === 'document') {
    return formatAsDocument(result);
  }
  return formatAsTable(result);
}

function formatAsDocument(result: MemorySearchResult): string {
  const lines: string[] = [];
  lines.push(`# Memory Search Results`);
  lines.push(`> ${result.stats.matchedRecords} matches | ${result.stats.totalRecords} total | ${result.stats.recentSummaryCount} summaries | ${result.stats.durableCandidateCount} durable`);
  lines.push('');
  for (const item of result.items) {
    lines.push(`## ${item.projectId}`);
    lines.push(`**Type:** ${item.type} | **Class:** ${item.projectionClass ?? item.eventType ?? 'raw'} | **Date:** ${new Date(item.createdAt).toISOString()}`);
    lines.push('');
    lines.push(item.summary);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

function formatAsTable(result: MemorySearchResult): string {
  const lines: string[] = [];
  lines.push(`Matched: ${result.stats.matchedRecords}  Total: ${result.stats.totalRecords}  Summaries: ${result.stats.recentSummaryCount}  Durable: ${result.stats.durableCandidateCount}  Projects: ${result.stats.projectCount}`);
  lines.push('');
  const header = 'TYPE        CLASS                    PROJECT                              AGE        SUMMARY';
  lines.push(header);
  lines.push('─'.repeat(header.length));
  for (const item of result.items) {
    const type = item.type.padEnd(11);
    const cls = (item.projectionClass ?? item.eventType ?? '-').padEnd(24);
    const proj = item.projectId.slice(0, 36).padEnd(36);
    const age = formatAge(item.updatedAt ?? item.createdAt).padEnd(10);
    const summary = item.summary.split('\n')[0].slice(0, 80);
    lines.push(`${type} ${cls} ${proj} ${age} ${summary}`);
  }
  return lines.join('\n');
}

function formatAge(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
