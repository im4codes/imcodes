import type { MemorySearchResultItem } from '../context/memory-search.js';
import type { MemoryContextTimelinePayload, MemoryContextTimelineItem } from '../shared/timeline/types.js';
import { buildRelatedPastWorkText } from '../../shared/memory-recall-format.js';

export function buildMemoryContextTimelinePayload(
  query: string | undefined,
  items: MemorySearchResultItem[],
  reason: MemoryContextTimelinePayload['reason'] = 'message',
): Omit<MemoryContextTimelinePayload, 'relatedToEventId'> | null {
  if (items.length === 0) return null;
  const timelineItems: MemoryContextTimelineItem[] = items.map((item) => ({
    id: item.id,
    projectId: item.projectId,
    summary: item.summary,
    projectionClass: item.projectionClass,
    hitCount: item.hitCount,
    lastUsedAt: item.lastUsedAt,
    status: item.status,
    relevanceScore: item.relevanceScore,
  }));
  return {
    ...(query ? { query } : {}),
    injectedText: buildRelatedPastWorkText(timelineItems),
    items: timelineItems,
    reason,
  };
}
