import type { ProcessedContextClass, ProcessedContextProjectionStatus } from './context-types.js';

export interface RelatedPastWorkRenderableItem {
  projectId: string;
  summary: string;
  projectionClass?: ProcessedContextClass;
  hitCount?: number;
  lastUsedAt?: number;
  status?: ProcessedContextProjectionStatus;
  relevanceScore?: number;
}

export const RELATED_PAST_WORK_HEADER = '[Related past work]';

export function formatRelatedPastWorkSummary(summary: string, maxLength = 200): string {
  return summary.split('\n')[0]?.slice(0, maxLength) ?? '';
}

export function formatRelatedPastWorkLine(item: Pick<RelatedPastWorkRenderableItem, 'projectId' | 'summary'>): string {
  return `- [${item.projectId}] ${formatRelatedPastWorkSummary(item.summary)}`;
}

export function buildRelatedPastWorkText(items: ReadonlyArray<Pick<RelatedPastWorkRenderableItem, 'projectId' | 'summary'>>): string {
  return `${RELATED_PAST_WORK_HEADER}\n<related-past-work advisory="true">\n${items.map((item) => formatRelatedPastWorkLine(item)).join('\n')}\n</related-past-work>`;
}
