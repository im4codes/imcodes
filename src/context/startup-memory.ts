import type { ContextNamespace } from '../../shared/context-types.js';
import type { MemorySearchResultItem } from './memory-search.js';
import { searchLocalMemory } from './memory-search.js';

export const STARTUP_MEMORY_DURABLE_LIMIT = 7;
export const STARTUP_MEMORY_RECENT_LIMIT = 8;
export const STARTUP_MEMORY_TOTAL_LIMIT = 15;

export interface StartupMemorySelectionOptions {
  durableLimit?: number;
  recentLimit?: number;
  totalLimit?: number;
}

export function selectStartupMemoryItems(
  namespace: ContextNamespace,
  options: StartupMemorySelectionOptions = {},
): MemorySearchResultItem[] {
  const durableLimit = options.durableLimit ?? STARTUP_MEMORY_DURABLE_LIMIT;
  const recentLimit = options.recentLimit ?? STARTUP_MEMORY_RECENT_LIMIT;
  const totalLimit = options.totalLimit ?? STARTUP_MEMORY_TOTAL_LIMIT;

  // Startup bootstrap is project-scoped memory loading, NOT a query-driven
  // recall. Any memory that belongs to the project's timeline is valid
  // context for session startup, including entries whose source turn was a
  // templated workflow prompt — the user still worked on this project and
  // the resulting summary is part of the project's history. Template-prompt
  // filtering is applied only on the recall/search paths.

  const durable = searchLocalMemory({
    namespace,
    projectionClass: 'durable_memory_candidate',
    limit: durableLimit,
  }).items.filter((item): item is MemorySearchResultItem => item.type === 'processed');

  const recent = searchLocalMemory({
    namespace,
    projectionClass: 'recent_summary',
    limit: Math.max(recentLimit, totalLimit),
  }).items.filter((item): item is MemorySearchResultItem => item.type === 'processed');

  const deduped: MemorySearchResultItem[] = [];
  const seen = new Set<string>();
  for (const item of durable) {
    const key = getStartupMemoryDedupKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= totalLimit || deduped.length >= durableLimit) break;
  }
  for (const item of recent) {
    const key = getStartupMemoryDedupKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= totalLimit) break;
  }
  return deduped;
}

function getStartupMemoryDedupKey(item: MemorySearchResultItem): string {
  if (item.sourceEventIds && item.sourceEventIds.length > 0) {
    return `events:${[...item.sourceEventIds].sort().join(',')}`;
  }
  return `summary:${item.summary.trim().toLowerCase()}`;
}
