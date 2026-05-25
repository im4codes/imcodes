import { getPersonalCloudMemory } from './api.js';
import type { ContextMemoryRecordView } from '@shared/context-types.js';

const DEFAULT_SUMMARY_SYNC_LIMIT = 8;

type Translate = (key: string, options?: Record<string, unknown>) => string;

function cleanProjectId(projectId: string | null | undefined): string | undefined {
  const trimmed = projectId?.trim();
  return trimmed || undefined;
}

function newestRecords(records: ContextMemoryRecordView[], limit: number): ContextMemoryRecordView[] {
  return [...records]
    .filter((record) => record.projectionClass === 'recent_summary' && record.summary.trim().length > 0)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limit);
}

export async function buildMemorySummarySyncMessage(
  t: Translate,
  projectId?: string | null,
  limit = DEFAULT_SUMMARY_SYNC_LIMIT,
): Promise<string | null> {
  const scopedProjectId = cleanProjectId(projectId);
  const scoped = scopedProjectId
    ? await getPersonalCloudMemory({ projectId: scopedProjectId, projectionClass: 'recent_summary', limit })
    : null;
  const fallback = !scoped || scoped.records.length === 0
    ? await getPersonalCloudMemory({ projectionClass: 'recent_summary', limit })
    : null;
  const records = newestRecords(scoped?.records.length ? scoped.records : (fallback?.records ?? []), limit);
  if (records.length === 0) return null;

  const lines = records.map((record, index) => {
    const project = record.projectId ? `[${record.projectId}] ` : '';
    return `${index + 1}. ${project}${record.summary.trim()}`;
  });
  return [
    t('chat.memory_summary_sync_instruction'),
    '',
    t('chat.memory_summary_sync_heading'),
    lines.join('\n\n'),
  ].join('\n');
}
