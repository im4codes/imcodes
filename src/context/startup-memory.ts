import type { ContextNamespace } from '../../shared/context-types.js';
import type { MemorySearchResultItem } from './memory-search.js';
import { searchLocalMemory } from './memory-search.js';
import { normalizeSummaryForFingerprint } from '../../shared/memory-fingerprint.js';

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

  // ID-based dedup was failing against duplicates produced by the old
  // writeProcessedProjection path that generated fresh UUIDs on every turn
  // for identical summary text. Pair it with a content fingerprint so
  // startup memory never dumps three copies of the same durable summary
  // into the session opener.
  const fingerprintOf = (item: MemorySearchResultItem): string => {
    const projectionClass = item.projectionClass ?? 'recent_summary';
    return `${projectionClass}\u0000${normalizeSummaryForFingerprint(item.summary ?? '')}`;
  };

  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const dedupedDurable: MemorySearchResultItem[] = [];
  for (const item of durable) {
    if (seenIds.has(item.id)) continue;
    const fp = fingerprintOf(item);
    if (seenFingerprints.has(fp)) continue;
    seenIds.add(item.id);
    seenFingerprints.add(fp);
    dedupedDurable.push(item);
  }

  const selectedDurable = dedupedDurable.slice(0, Math.min(durableLimit, totalLimit));
  const remaining = Math.max(0, totalLimit - selectedDurable.length);
  const selectedRecent: MemorySearchResultItem[] = [];
  for (const item of recent) {
    if (seenIds.has(item.id)) continue;
    const fp = fingerprintOf(item);
    if (seenFingerprints.has(fp)) continue;
    seenIds.add(item.id);
    seenFingerprints.add(fp);
    selectedRecent.push(item);
    if (selectedRecent.length >= remaining) break;
  }

  return [...selectedDurable, ...selectedRecent];
}
