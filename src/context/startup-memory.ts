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

  const selectedDurable = durable.slice(0, Math.min(durableLimit, totalLimit));
  const remaining = Math.max(0, totalLimit - selectedDurable.length);
  const selectedRecent: MemorySearchResultItem[] = [];
  const seenIds = new Set(selectedDurable.map((item) => item.id));
  for (const item of recent) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    selectedRecent.push(item);
    if (selectedRecent.length >= remaining) break;
  }

  return [...selectedDurable, ...selectedRecent];
}
