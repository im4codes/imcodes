import { getPersonalCloudMemory } from './api.js';
import type { ContextMemoryRecordView } from '@shared/context-types.js';

const DEFAULT_SUMMARY_SYNC_LIMIT = 8;

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

  const lines = records.map((record, index) => {
    const project = record.projectId ? `[${record.projectId}] ` : '';
    return `${index + 1}. [ref: ${projectionRef(record.id)}] ${project}${record.summary.trim()}\n   ${sourceLookupLine(record.id)}`;
  });
  return [
    t('chat.memory_summary_sync_instruction'),
    '',
    t('chat.memory_summary_sync_heading'),
    lines.join('\n\n'),
  ].join('\n');
}
