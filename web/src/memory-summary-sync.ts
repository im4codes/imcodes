import { getPersonalCloudMemory } from './api.js';
import { MEMORY_WS } from '@shared/memory-ws.js';
import type { ContextMemoryRecordView } from '@shared/context-types.js';
import type { ServerMessage } from './ws-client.js';

const DEFAULT_SUMMARY_SYNC_LIMIT = 10;
const SUMMARY_SYNC_MAX_RECORD_CHARS = 1_200;
// Total char budget for the synced "recent summaries" block. At 1_200/record
// this fits up to ~6 full recent summaries before truncating.
const SUMMARY_SYNC_MAX_TOTAL_SUMMARY_CHARS = 7_200;
const SUMMARY_SYNC_TRUNCATED_NOTE = '[truncated for token budget; use get_memory_sources with the sourceLookup below for exact details]';
const LOCAL_MEMORY_SUMMARY_TIMEOUT_MS = 8_000;

type Translate = (key: string, options?: Record<string, unknown>) => string;
type MemorySummarySourceInput = {
  projectId: string;
  projectionClass: 'recent_summary';
  limit: number;
};
type MemorySummarySource = (input: MemorySummarySourceInput) => Promise<{ records: ContextMemoryRecordView[] } | null | undefined>;

export type MemorySummaryWsClient = {
  send: (msg: object) => void;
  onMessage: (handler: (msg: ServerMessage) => void) => () => void;
};

export type MemorySummarySyncOptions = {
  sources?: MemorySummarySource[];
  includeCloudFallback?: boolean;
};

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

function mergeMemoryRecordsByPriority(recordGroups: ContextMemoryRecordView[][]): ContextMemoryRecordView[] {
  const merged: ContextMemoryRecordView[] = [];
  const seen = new Set<string>();
  for (const records of recordGroups) {
    for (const record of records) {
      const summary = record.summary.trim();
      const key = record.id
        ? `id:${record.id}`
        : `summary:${record.projectId}:${record.projectionClass}:${summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
  }
  return merged;
}

function cloudMemorySummarySource(input: MemorySummarySourceInput) {
  return getPersonalCloudMemory(input);
}

export function localPersonalMemorySummarySource(
  ws: MemorySummaryWsClient,
  timeoutMs = LOCAL_MEMORY_SUMMARY_TIMEOUT_MS,
): MemorySummarySource {
  return (input) => new Promise((resolve, reject) => {
    const requestId = globalThis.crypto?.randomUUID?.()
      ?? `memory-summary-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;
    let cleanup = () => {};

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const off = ws.onMessage((msg) => {
      if (msg.type !== MEMORY_WS.PERSONAL_RESPONSE || msg.requestId !== requestId) return;
      finish(() => {
        if (msg.errorCode) {
          reject(new Error(msg.error || msg.errorCode));
          return;
        }
        resolve({ records: msg.records ?? [] });
      });
    });
    const timer = setTimeout(() => {
      finish(() => reject(new Error('local memory summary query timed out')));
    }, timeoutMs);
    cleanup = () => {
      clearTimeout(timer);
      off();
    };

    try {
      ws.send({
        type: MEMORY_WS.PERSONAL_QUERY,
        requestId,
        canonicalRepoId: input.projectId,
        projectId: input.projectId,
        projectionClass: input.projectionClass,
        limit: input.limit,
      });
    } catch (error) {
      finish(() => reject(error));
    }
  });
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
  options?: MemorySummarySyncOptions,
): Promise<string | null> {
  const scopedProjectId = cleanProjectId(projectId);
  if (!scopedProjectId) return null;

  const suppliedSources = options?.sources ?? [];
  const sources = options?.includeCloudFallback === false
    ? suppliedSources
    : [cloudMemorySummarySource, ...suppliedSources];
  const recordGroups: ContextMemoryRecordView[][] = [];
  for (const source of sources) {
    try {
      const scoped = await source({ projectId: scopedProjectId, projectionClass: 'recent_summary', limit });
      const sourceRecords = newestRecords(scoped?.records ?? [], scopedProjectId, limit);
      if (sourceRecords.length) recordGroups.push(sourceRecords);
    } catch {
      // Keep context sync opportunistic: try the next source before giving up.
    }
  }
  const records = newestRecords(mergeMemoryRecordsByPriority(recordGroups), scopedProjectId, limit);
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
