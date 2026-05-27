import { getPersonalCloudMemory } from './api.js';
import type { ContextMemoryRecordView } from '@shared/context-types.js';

const DEFAULT_SUMMARY_SYNC_LIMIT = 10;
const SUMMARY_SYNC_MAX_RECORD_CHARS = 1_200;
const SUMMARY_SYNC_MAX_TOTAL_SUMMARY_CHARS = 3_600;
const SUMMARY_SYNC_TRUNCATED_NOTE = '[truncated for token budget; use get_memory_sources with the sourceLookup below for exact details]';

type Translate = (key: string, options?: Record<string, unknown>) => string;

function cleanProjectId(projectId: string | null | undefined): string | undefined {
  const trimmed = projectId?.trim();
  return trimmed || undefined;
}

function newestRecords(records: ContextMemoryRecordView[], projectId: string, limit: number): ContextMemoryRecordView[] {
  return [...records]
    .filter((record) => (
      record.projectId === projectId
      && record.projectionClass === 'recent_summary'
      && record.summary.trim().length > 0
    ))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limit);
}

function projectionRef(projectionId: string): string {
  const compact = projectionId.replace(/[^a-f0-9]/gi, '').slice(0, 10) || projectionId.slice(0, 10);
  return `proj:${compact.toLowerCase()}`;
}

function sourceLookupLine(projectionId: string): string {
  return `sourceLookup: ${JSON.stringify({
    tool: 'get_memory_sources',
    kind: 'projection',
    projectionId,
  })}`;
}

function trimSummaryForSync(summary: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = summary.replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  if (maxChars <= SUMMARY_SYNC_TRUNCATED_NOTE.length + 24) {
    return { text: normalized.slice(0, Math.max(0, maxChars)).trimEnd(), truncated: true };
  }
  const summaryBudget = maxChars - SUMMARY_SYNC_TRUNCATED_NOTE.length - 1;
  return {
    text: `${normalized.slice(0, summaryBudget).trimEnd()}\n${SUMMARY_SYNC_TRUNCATED_NOTE}`,
    truncated: true,
  };
}

export async function buildMemorySummarySyncMessage(
  t: Translate,
  projectId?: string | null,
  limit = DEFAULT_SUMMARY_SYNC_LIMIT,
): Promise<string | null> {
  const scopedProjectId = cleanProjectId(projectId);
  if (!scopedProjectId) return null;
  const scoped = await getPersonalCloudMemory({ projectId: scopedProjectId, projectionClass: 'recent_summary', limit });
  const records = newestRecords(scoped.records, scopedProjectId, limit);
  if (records.length === 0) return null;

  const lines: string[] = [];
  let remainingSummaryChars = SUMMARY_SYNC_MAX_TOTAL_SUMMARY_CHARS;
  let truncated = false;
  for (const record of records) {
    if (remainingSummaryChars <= 0) {
      truncated = true;
      break;
    }
    const maxChars = Math.min(SUMMARY_SYNC_MAX_RECORD_CHARS, remainingSummaryChars);
    if (maxChars <= 80) {
      truncated = true;
      break;
    }
    const trimmed = trimSummaryForSync(record.summary, maxChars);
    remainingSummaryChars -= trimmed.text.length;
    truncated = truncated || trimmed.truncated;
    const project = record.projectId ? `[${record.projectId}] ` : '';
    lines.push(`${lines.length + 1}. [ref: ${projectionRef(record.id)}] ${project}${trimmed.text}\n   ${sourceLookupLine(record.id)}`);
  }
  if (lines.length === 0) return null;

  return [
    t('chat.memory_summary_sync_instruction'),
    '',
    t('chat.memory_summary_sync_heading', {
      count: lines.length,
      limit,
      maxChars: SUMMARY_SYNC_MAX_TOTAL_SUMMARY_CHARS,
      truncated,
    }),
    lines.join('\n\n'),
  ].join('\n');
}
