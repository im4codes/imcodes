/**
 * Memory search module — unified local search across staged events and processed projections.
 * Used by CLI (`imcodes memory`), WS command (`memory.search`), and web UI.
 */
import type {
  LocalContextEvent,
  ProcessedContextClass,
  ProcessedContextProjection,
  ContextMemoryStatsView,
} from '../../shared/context-types.js';
import {
  listContextEvents,
  listDirtyTargets,
  queryProcessedProjections,
  recordMemoryHits,
} from '../store/context-store.js';

// ── Query types ──────────────────────────────────────────────────────────────

export interface MemorySearchQuery {
  /** Substring to match in summary/content text. */
  query?: string;
  /** Filter by canonical repository ID (matches namespace.projectId). */
  repo?: string;
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
  /** Result offset for pagination. */
  offset?: number;
}

export type MemorySearchFormat = 'json' | 'document' | 'table';

export interface MemorySearchResultItem {
  type: 'raw' | 'processed';
  id: string;
  projectId: string;
  scope: string;
  eventType?: string;
  projectionClass?: ProcessedContextClass;
  summary: string;
  content?: string;
  createdAt: number;
  updatedAt?: number;
  sourceEventCount?: number;
  processingModel?: string;
}

export interface MemorySearchResult {
  items: MemorySearchResultItem[];
  stats: ContextMemoryStatsView;
}

// ── Search implementation ────────────────────────────────────────────────────

/**
 * Semantic search: fetch candidates via substring match, then re-rank by embedding similarity.
 * Falls back to plain searchLocalMemory if embedding model is unavailable.
 */
export async function searchLocalMemorySemantic(query: MemorySearchQuery): Promise<MemorySearchResult> {
  // First, get candidates with relaxed text match (or no query filter for broader recall)
  const broadQuery = { ...query, limit: Math.max((query.limit ?? 5) * 4, 40) };
  const candidates = searchLocalMemory(broadQuery);
  if (candidates.items.length === 0 || !query.query) return searchLocalMemory(query);

  try {
    const { generateEmbedding, cosineSimilarity } = await import('./embedding.js');
    const queryEmb = await generateEmbedding(query.query);
    if (!queryEmb) return searchLocalMemory(query); // model unavailable, fallback

    // Score each candidate by cosine similarity
    const scored: Array<{ item: MemorySearchResultItem; score: number }> = [];
    for (const item of candidates.items) {
      const text = `${item.summary} ${item.content ?? ''}`.slice(0, 500);
      const itemEmb = await generateEmbedding(text);
      if (itemEmb) {
        scored.push({ item, score: cosineSimilarity(queryEmb, itemEmb) });
      } else {
        scored.push({ item, score: 0 });
      }
    }

    // Sort by semantic similarity
    scored.sort((a, b) => b.score - a.score);
    const limit = query.limit ?? 5;
    const topItems = scored.slice(0, limit).map((s) => s.item);

    // Record hits for recalled items (spaced repetition: each recall resets decay clock)
    const hitIds = topItems.filter((i) => i.type === 'processed').map((i) => i.id);
    if (hitIds.length > 0) {
      try { recordMemoryHits(hitIds); } catch { /* non-fatal */ }
    }

    return {
      items: topItems,
      stats: candidates.stats,
    };
  } catch {
    // Embedding failed — fall back to plain search
    return searchLocalMemory(query);
  }
}

export function searchLocalMemory(query: MemorySearchQuery): MemorySearchResult {
  const allItems: MemorySearchResultItem[] = [];

  // Collect processed projections from local SQLite
  const processedByNs = collectProcessedProjections(query);
  for (const projection of processedByNs) {
    const item = projectionToItem(projection);
    if (matchesQuery(item, query)) {
      allItems.push(item);
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

  // Sort by createdAt descending (newest first)
  allItems.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));

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

// ── Internal helpers ─────────────────────────────────────────────────────────

function collectProcessedProjections(query: MemorySearchQuery): ProcessedContextProjection[] {
  return queryProcessedProjections({
    projectId: query.repo,
    projectionClass: query.projectionClass,
    query: query.query,
  });
}

function collectRawEvents(query: MemorySearchQuery): MemorySearchResultItem[] {
  const items: MemorySearchResultItem[] = [];
  const dirtyTargets = listDirtyTargets();
  for (const dt of dirtyTargets) {
    if (query.repo && dt.target.namespace.projectId !== query.repo) continue;
    const events = listContextEvents(dt.target);
    for (const event of events) {
      if (query.eventType && event.eventType !== query.eventType) continue;
      items.push(eventToItem(event));
    }
  }
  return items;
}

function projectionToItem(projection: ProcessedContextProjection): MemorySearchResultItem {
  const content = projection.content;
  return {
    type: 'processed',
    id: projection.id,
    projectId: projection.namespace.projectId,
    scope: projection.namespace.scope,
    projectionClass: projection.class,
    summary: projection.summary,
    content: typeof content === 'object' ? JSON.stringify(content) : undefined,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    sourceEventCount: typeof content?.eventCount === 'number' ? content.eventCount : undefined,
    processingModel: typeof content?.primaryContextModel === 'string' ? content.primaryContextModel : undefined,
  };
}

function eventToItem(event: LocalContextEvent): MemorySearchResultItem {
  return {
    type: 'raw',
    id: event.id,
    projectId: event.target.namespace.projectId,
    scope: event.target.namespace.scope,
    eventType: event.eventType,
    summary: event.content ?? event.eventType,
    createdAt: event.createdAt,
  };
}

function matchesQuery(item: MemorySearchResultItem, query: MemorySearchQuery): boolean {
  if (query.repo && item.projectId !== query.repo) return false;
  if (query.projectionClass && item.projectionClass !== query.projectionClass) return false;
  if (query.eventType && item.type === 'raw' && item.eventType !== query.eventType) return false;
  if (query.after && item.createdAt < query.after) return false;
  if (query.before && item.createdAt > query.before) return false;
  if (query.query) {
    const needle = query.query.toLowerCase();
    const haystack = `${item.summary} ${item.content ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function computeStats(items: MemorySearchResultItem[]): Omit<ContextMemoryStatsView, 'matchedRecords' | 'stagedEventCount' | 'dirtyTargetCount' | 'pendingJobCount'> {
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
