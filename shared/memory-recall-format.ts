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
export const STARTUP_PROJECT_MEMORY_HEADER = '# Recent project memory (reference only)';
export const STARTUP_SKILL_INDEX_HEADER = '# Available skills (read on demand)';

export function formatRelatedPastWorkSummary(summary: string, maxLength = 200): string {
  return summary.split('\n')[0]?.slice(0, maxLength) ?? '';
}

export function formatRelatedPastWorkLine(item: Pick<RelatedPastWorkRenderableItem, 'projectId' | 'summary'>): string {
  return `- [${item.projectId}] ${formatRelatedPastWorkSummary(item.summary)}`;
}

export function buildRelatedPastWorkText(items: ReadonlyArray<Pick<RelatedPastWorkRenderableItem, 'projectId' | 'summary'>>): string {
  return `${RELATED_PAST_WORK_HEADER}\n<related-past-work advisory="true">\n${items.map((item) => formatRelatedPastWorkLine(item)).join('\n')}\n</related-past-work>`;
}

export function buildStartupProjectMemoryText(items: ReadonlyArray<Pick<RelatedPastWorkRenderableItem, 'summary' | 'projectionClass'>>): string {
  const lines = items.map((item) => {
    const label = item.projectionClass === 'durable_memory_candidate' ? 'important' : 'recent';
    return `- [${label}] ${formatRelatedPastWorkSummary(item.summary, 300)}`;
  });
  return `${STARTUP_PROJECT_MEMORY_HEADER}\n<recent-project-memory advisory="true">\n${lines.join('\n')}\n</recent-project-memory>`;
}
