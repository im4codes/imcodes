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

  const durable = searchLocalMemory({
    namespace,
    projectionClass: 'durable_memory_candidate',
    limit: durableLimit,
  }).items.filter((item): item is MemorySearchResultItem => item.type === 'processed');

  const recent = searchLocalMemory({
    namespace,
    projectionClass: 'recent_summary',
    limit: recentLimit,
  }).items.filter((item): item is MemorySearchResultItem => item.type === 'processed');

  const deduped: MemorySearchResultItem[] = [];
  const seen = new Set<string>();
  for (const item of [...durable, ...recent]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
    if (deduped.length >= totalLimit) break;
  }
  return deduped;
}
