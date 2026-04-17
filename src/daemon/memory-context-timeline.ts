import type { MemorySearchResultItem } from '../context/memory-search.js';
import type { MemoryContextTimelinePayload, MemoryContextTimelineItem } from '../shared/timeline/types.js';
import { buildRelatedPastWorkText } from '../../shared/memory-recall-format.js';
import type {
  ContextAuthorityDecision,
  MemoryRecallInjectionSurface,
  MemoryRecallRuntimeFamily,
  TransportMemoryRecallItem,
} from '../../shared/context-types.js';

export function buildMemoryContextTimelinePayload(
  query: string | undefined,
  items: Array<MemorySearchResultItem | TransportMemoryRecallItem>,
  reason: MemoryContextTimelinePayload['reason'] = 'message',
  options?: {
    runtimeFamily?: MemoryRecallRuntimeFamily;
    injectionSurface?: MemoryRecallInjectionSurface;
    injectedText?: string;
    authoritySource?: ContextAuthorityDecision['authoritySource'];
    sourceKind?: 'local_processed' | 'remote_processed';
  },
): Omit<MemoryContextTimelinePayload, 'relatedToEventId'> | null {
  if (items.length === 0) return null;
  const timelineItems: MemoryContextTimelineItem[] = items.map((item) => ({
    id: item.id,
    projectId: item.projectId,
    ...('scope' in item && item.scope ? { scope: item.scope } : {}),
    ...('enterpriseId' in item && item.enterpriseId ? { enterpriseId: item.enterpriseId } : {}),
    ...('workspaceId' in item && item.workspaceId ? { workspaceId: item.workspaceId } : {}),
    ...('userId' in item && item.userId ? { userId: item.userId } : {}),
    summary: item.summary,
    projectionClass: item.projectionClass,
    hitCount: item.hitCount,
    lastUsedAt: item.lastUsedAt,
    status: item.status,
    relevanceScore: item.relevanceScore,
  }));
  return {
    ...(query ? { query } : {}),
    injectedText: options?.injectedText ?? buildRelatedPastWorkText(timelineItems),
    items: timelineItems,
    reason,
    ...(options?.runtimeFamily ? { runtimeFamily: options.runtimeFamily } : {}),
    ...(options?.injectionSurface ? { injectionSurface: options.injectionSurface } : {}),
    ...(options?.authoritySource ? { authoritySource: options.authoritySource } : {}),
    ...(options?.sourceKind ? { sourceKind: options.sourceKind } : {}),
  };
}
