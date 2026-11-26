import type { ProcessedContextClass, ProcessedContextProjectionStatus } from './context-types.js';

export interface RelatedPastWorkRenderableItem {
  projectId: string;
  summary: string;
  /** Compact handle (e.g. `proj:k3m7q2xw9pz4a`) the agent can redeem via
   *  get_memory_sources when a summary alone isn't enough. Omitted for records
   *  that aren't addressable (raw events). */
  ref?: string;
  projectionClass?: ProcessedContextClass;
  hitCount?: number;
  lastUsedAt?: number;
  status?: ProcessedContextProjectionStatus;
  relevanceScore?: number;
}

export const RELATED_PAST_WORK_HEADER = '[Related past work]';
export const STARTUP_PROJECT_MEMORY_HEADER = '# Recent project memory (reference only)';
export const STARTUP_SKILL_INDEX_HEADER = '# Available skills (read on demand)';

const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+/;

/**
 * Condense a stored summary into one injected line.
 *
 * Taking `split('\n')[0]` verbatim produced lines that were nothing but a
 * markdown heading — a whole recall block reading `- [recent] ## Problem` tells
 * the agent nothing about whether the memory is relevant. Keep the heading as a
 * label and pull the first real content line up next to it, so the line reads
 * `Problem: uploads fail when the disk is full`.
 */
export function formatRelatedPastWorkSummary(summary: string, maxLength = 200): string {
  const lines = summary.split('\n').map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0];
  if (!firstLine) return '';
  let label = '';
  let rest = lines;
  if (MARKDOWN_HEADING.test(firstLine)) {
    label = firstLine.replace(MARKDOWN_HEADING, '').replace(/\s*:\s*$/, '');
    rest = lines.slice(1);
  }
  const body = rest.find((line) => !MARKDOWN_HEADING.test(line)) ?? '';
  const text = label && body ? `${label}: ${body}` : (body || label || firstLine);
  return text.slice(0, maxLength);
}

/** `(proj:abc…) ` prefix, or '' when the record has no redeemable handle. */
function formatRefPrefix(ref: string | undefined): string {
  return ref ? `(${ref}) ` : '';
}

export function formatRelatedPastWorkLine(item: Pick<RelatedPastWorkRenderableItem, 'projectId' | 'summary' | 'ref'>): string {
  return `- [${item.projectId}] ${formatRefPrefix(item.ref)}${formatRelatedPastWorkSummary(item.summary)}`;
}

export function buildRelatedPastWorkText(items: ReadonlyArray<Pick<RelatedPastWorkRenderableItem, 'projectId' | 'summary' | 'ref'>>): string {
  return `${RELATED_PAST_WORK_HEADER}\n<related-past-work advisory="true">\n${items.map((item) => formatRelatedPastWorkLine(item)).join('\n')}\n</related-past-work>`;
}

export function buildStartupProjectMemoryText(items: ReadonlyArray<Pick<RelatedPastWorkRenderableItem, 'summary' | 'projectionClass' | 'ref'>>): string {
  const lines = items.map((item) => {
    const label = item.projectionClass === 'durable_memory_candidate' ? 'important' : 'recent';
    return `- [${label}] ${formatRefPrefix(item.ref)}${formatRelatedPastWorkSummary(item.summary, 300)}`;
  });
  return `${STARTUP_PROJECT_MEMORY_HEADER}\n<recent-project-memory advisory="true">\n${lines.join('\n')}\n</recent-project-memory>`;
}
