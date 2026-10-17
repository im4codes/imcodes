import type { MemorySearchResultItem } from '../context/memory-search.js';
import type {
  MemoryContextTimelinePayload,
  MemoryContextTimelineItem,
  MemoryContextTimelinePreferenceItem,
  MemoryContextTimelineStatus,
} from '../shared/timeline/types.js';
import { buildRelatedPastWorkText } from '../../shared/memory-recall-format.js';
import { attachMemoryShortRefs } from '../context/memory-recall-refs.js';
import type {
  ContextAuthorityDecision,
  MemoryRecallInjectionSurface,
  MemoryRecallRuntimeFamily,
  MemoryRecallSourceKind,
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
    sourceKind?: MemoryRecallSourceKind;
    preferenceItems?: MemoryContextTimelinePreferenceItem[];
  },
): Omit<MemoryContextTimelinePayload, 'relatedToEventId'> | null {
  const preferenceItems = (options?.preferenceItems ?? [])
    .map((item) => ({ ...item, text: item.text.trim() }))
    .filter((item) => item.text);
  if (items.length === 0 && preferenceItems.length === 0) return null;
  // Register once, then reuse the exact same handles in both the agent-facing
  // injected text and the user-facing timeline payload. Mapping first used to
  // drop `type`, which made observation evidence look like a projection in the
  // reconstructed injectedText and left the web card with no ref at all.
  const referencedItems = attachMemoryShortRefs(items);
  const timelineItems: MemoryContextTimelineItem[] = referencedItems.map((item) => {
    const sourceSessionName = 'sourceSessionName' in item
      ? item.sourceSessionName?.trim()
      : undefined;
    return {
      id: item.id,
      ...(item.ref ? { ref: item.ref } : {}),
      projectId: item.projectId,
      ...(sourceSessionName ? { sourceSessionName } : {}),
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
    };
  });
  const injectedText = options?.injectedText
    ?? (referencedItems.length > 0 ? buildRelatedPastWorkText(referencedItems) : undefined);
  return {
    ...(query ? { query } : {}),
    ...(injectedText ? { injectedText } : {}),
    items: timelineItems,
    ...(preferenceItems.length > 0 ? { preferenceItems } : {}),
    reason,
    ...(options?.runtimeFamily ? { runtimeFamily: options.runtimeFamily } : {}),
    ...(options?.injectionSurface ? { injectionSurface: options.injectionSurface } : {}),
    ...(options?.authoritySource ? { authoritySource: options.authoritySource } : {}),
    ...(options?.sourceKind ? { sourceKind: options.sourceKind } : {}),
  };
}

export function buildMemoryContextStatusPayload(
  query: string | undefined,
  status: MemoryContextTimelineStatus,
  reason: MemoryContextTimelinePayload['reason'] = 'message',
  options?: {
    runtimeFamily?: MemoryRecallRuntimeFamily;
    injectionSurface?: MemoryRecallInjectionSurface;
    authoritySource?: ContextAuthorityDecision['authoritySource'];
    sourceKind?: MemoryRecallSourceKind;
    matchedCount?: number;
    dedupedCount?: number;
  },
): Omit<MemoryContextTimelinePayload, 'relatedToEventId'> {
  return {
    ...(query ? { query } : {}),
    items: [],
    reason,
    status,
    ...(typeof options?.matchedCount === 'number' ? { matchedCount: options.matchedCount } : {}),
    ...(typeof options?.dedupedCount === 'number' ? { dedupedCount: options.dedupedCount } : {}),
    ...(options?.runtimeFamily ? { runtimeFamily: options.runtimeFamily } : {}),
    ...(options?.injectionSurface ? { injectionSurface: options.injectionSurface } : {}),
    ...(options?.authoritySource ? { authoritySource: options.authoritySource } : {}),
    ...(options?.sourceKind ? { sourceKind: options.sourceKind } : {}),
  };
}
