import type { PushNotificationType } from './push-notifications.js';

export const GLOBAL_TASK_WS_PATH = '/api/global-tasks/ws' as const;
export const GLOBAL_TASK_SNAPSHOT_PATH = '/api/global-tasks' as const;
export const GLOBAL_TASK_TICKET_PATH = '/api/global-tasks/ws-ticket' as const;
export const GLOBAL_TASK_FLEET_SNAPSHOT_MSG = 'task_pair.fleet_snapshot' as const;
export const GLOBAL_TASK_BRAIN_TEXT_MAX_CHARS = 1200 as const;
export const GLOBAL_TASK_AUDIT_SUMMARY_MAX_CHARS = 160 as const;
export const GLOBAL_TASK_NOTIFY_CHANNEL = 'global_task_pair_updates' as const;
export const GLOBAL_TASK_WS_TICKET_TYPE = 'global-tasks-ws-ticket' as const;
export const GLOBAL_TASK_PG_NOTIFY_MAX_BYTES = 4000 as const;
export const GLOBAL_TASK_RECENT_FINISHED_LIMIT = 50 as const;
export const GLOBAL_TASK_TERMINAL_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
export const GLOBAL_TASK_STATS_WINDOW_MS = {
  h24: 24 * 60 * 60 * 1000,
  h48: 48 * 60 * 60 * 1000,
  w1: 7 * 24 * 60 * 60 * 1000,
  m1: 30 * 24 * 60 * 60 * 1000,
} as const;
export const GLOBAL_TASK_STATS_MAX_WINDOW_MS = GLOBAL_TASK_STATS_WINDOW_MS.m1;
export const GLOBAL_TASK_STATS_FUTURE_SKEW_MS = 60 * 1000;

export interface GlobalTaskWindowStats {
  completedCount: number;
  avgDurationMs: number | null;
}

export interface GlobalTaskCompletionStats {
  h24: GlobalTaskWindowStats;
  h48: GlobalTaskWindowStats;
  w1: GlobalTaskWindowStats;
  m1: GlobalTaskWindowStats;
}

export const GLOBAL_TASK_MODE_MSG = {
  SET_FILTER: 'global_tasks.set_filter',
  REFRESH: 'global_tasks.refresh',
  PING: 'ping',
  SNAPSHOT: 'global_tasks.snapshot',
  UPSERT: 'global_tasks.upsert',
  BRAIN_TEXT: 'global_tasks.brain_text',
  NOTIFICATION: 'global_tasks.notification',
  SERVER_STATE: 'global_tasks.server_state',
  PONG: 'pong',
} as const;

export interface GlobalTaskChecklistProgress {
  total: number;
  implemented: number;
  audited: number;
}

export interface GlobalTaskAuditCounts {
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
}

export interface GlobalTaskAuditSummary {
  verb: 'PASS' | 'REWORK';
  round: number;
  counts: GlobalTaskAuditCounts;
  blocking: string[];
  blockingCount: number;
  findingsCount: number;
  summary?: string;
}

export interface GlobalTaskSummaryRow {
  serverId: string;
  serverName: string;
  serverOnline: boolean;
  projectName: string;
  brainSession: string;
  brainLabel: string;
  taskId: string;
  title: string;
  status: string;
  flags: string[];
  round: number;
  checklist: GlobalTaskChecklistProgress;
  executorLabel?: string;
  auditorLabel?: string;
  executorModel?: string;
  auditorModel?: string;
  auditor?: string;
  liveSummary?: string;
  lastAudit?: GlobalTaskAuditSummary;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
  updatedAt: number;
  isTerminal: boolean;
  needsAttention: boolean;
}

export interface GlobalTaskBrainSummary {
  serverId: string;
  serverName: string;
  serverOnline: boolean;
  sessionName: string;
  projectName: string;
  label: string;
  state: string;
  agentType: string;
}

export interface GlobalTaskServerSummary {
  id: string;
  name: string;
  online: boolean;
}

export interface GlobalTaskBrainTextEvent {
  serverId: string;
  serverName: string;
  sessionName: string;
  projectName?: string;
  eventId: string;
  text: string;
  ts: number;
}

export interface GlobalTaskNotificationEvent {
  eventId: string;
  title: string;
  body: string;
  notificationType?: PushNotificationType;
  serverId?: string;
  session?: string;
  taskId?: string;
  eventType?: string;
  ts: number;
}

export interface GlobalTaskSnapshotResponse {
  tasks: GlobalTaskSummaryRow[];
  brains: GlobalTaskBrainSummary[];
  servers: GlobalTaskServerSummary[];
  stats?: GlobalTaskCompletionStats;
  ts: number;
}

export interface GlobalTaskFleetSnapshotPair {
  taskId: string;
  brain: string;
  projectName: string;
  title: string;
  status: string;
  flags: string[];
  round: number;
  checklist: GlobalTaskChecklistProgress;
  executorLabel?: string;
  auditorLabel?: string;
  executorModel?: string;
  auditorModel?: string;
  auditor?: string;
  liveSummary?: string;
  lastAudit?: GlobalTaskAuditSummary;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface GlobalTaskFleetSnapshotFrame {
  type: typeof GLOBAL_TASK_FLEET_SNAPSHOT_MSG;
  pairs: GlobalTaskFleetSnapshotPair[];
}

export type GlobalTaskClientFrame =
  | { type: typeof GLOBAL_TASK_MODE_MSG.SET_FILTER; mutedServerIds: string[] }
  | { type: typeof GLOBAL_TASK_MODE_MSG.REFRESH }
  | { type: typeof GLOBAL_TASK_MODE_MSG.PING };

export type GlobalTaskServerFrame =
  | ({ type: typeof GLOBAL_TASK_MODE_MSG.SNAPSHOT } & GlobalTaskSnapshotResponse)
  | { type: typeof GLOBAL_TASK_MODE_MSG.UPSERT; task: GlobalTaskSummaryRow }
  | { type: typeof GLOBAL_TASK_MODE_MSG.BRAIN_TEXT; event: GlobalTaskBrainTextEvent }
  | { type: typeof GLOBAL_TASK_MODE_MSG.NOTIFICATION; event: GlobalTaskNotificationEvent }
  | { type: typeof GLOBAL_TASK_MODE_MSG.SERVER_STATE; serverId: string; online: boolean }
  | { type: typeof GLOBAL_TASK_MODE_MSG.PONG };

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
const ATTENTION_FLAGS = new Set(['blocked', 'needs_input', 'executor_silent', 'auditor_silent']);
const utf8Encoder = new TextEncoder();

export function isGlobalTaskTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isNoAuditorSentinel(value: string | null | undefined): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === 'none' || trimmed === '__none__';
}

/**
 * Returns true for active (non-terminal) tasks regardless of age, and for
 * terminal tasks updated within the global sync window (<= 2 days).
 */
export function isGlobalTaskWithinSyncWindow(
  task: { isTerminal?: boolean; status?: string; updatedAt?: number },
  now: number = Date.now(),
): boolean {
  const terminal = task.isTerminal === true
    || (typeof task.status === 'string' && isGlobalTaskTerminalStatus(task.status));
  if (!terminal) return true;
  const updatedAt = typeof task.updatedAt === 'number' && Number.isFinite(task.updatedAt) ? task.updatedAt : 0;
  return updatedAt >= now - GLOBAL_TASK_TERMINAL_WINDOW_MS;
}

export function emptyGlobalTaskCompletionStats(): GlobalTaskCompletionStats {
  return {
    h24: { completedCount: 0, avgDurationMs: null },
    h48: { completedCount: 0, avgDurationMs: null },
    w1: { completedCount: 0, avgDurationMs: null },
    m1: { completedCount: 0, avgDurationMs: null },
  };
}

export interface GlobalTaskStatsSample {
  status: string;
  startedAt?: number | null;
  endedAt?: number | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

function validPositiveStatTs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Aggregate 24h / 48h / 1w / 1m completion counts and average durations
 * for finished (`status === 'done'`) tasks, using endedAt->updatedAt and
 * startedAt->createdAt fallbacks while ignoring cancelled and reversed rows.
 */
export function computeGlobalTaskCompletionStats(
  rows: readonly GlobalTaskStatsSample[],
  nowMs: number,
): GlobalTaskCompletionStats {
  if (!Number.isFinite(nowMs) || nowMs <= 0) {
    return emptyGlobalTaskCompletionStats();
  }
  const maxEndTs = nowMs + GLOBAL_TASK_STATS_FUTURE_SKEW_MS;
  const keys = ['h24', 'h48', 'w1', 'm1'] as const;
  const sums: Record<(typeof keys)[number], number> = { h24: 0, h48: 0, w1: 0, m1: 0 };
  const durCounts: Record<(typeof keys)[number], number> = { h24: 0, h48: 0, w1: 0, m1: 0 };
  const counts: Record<(typeof keys)[number], number> = { h24: 0, h48: 0, w1: 0, m1: 0 };

  for (const row of rows) {
    if (row.status !== 'done') continue;
    const endTs = validPositiveStatTs(row.endedAt) ?? validPositiveStatTs(row.updatedAt);
    if (endTs === null || endTs > maxEndTs || endTs < nowMs - GLOBAL_TASK_STATS_MAX_WINDOW_MS) continue;
    const startTs = validPositiveStatTs(row.startedAt) ?? validPositiveStatTs(row.createdAt);
    const duration = startTs !== null && endTs >= startTs ? endTs - startTs : null;

    for (const key of keys) {
      if (endTs >= nowMs - GLOBAL_TASK_STATS_WINDOW_MS[key]) {
        counts[key] += 1;
        if (duration !== null) {
          sums[key] += duration;
          durCounts[key] += 1;
        }
      }
    }
  }

  return {
    h24: {
      completedCount: counts.h24,
      avgDurationMs: durCounts.h24 > 0 ? Math.round(sums.h24 / durCounts.h24) : null,
    },
    h48: {
      completedCount: counts.h48,
      avgDurationMs: durCounts.h48 > 0 ? Math.round(sums.h48 / durCounts.h48) : null,
    },
    w1: {
      completedCount: counts.w1,
      avgDurationMs: durCounts.w1 > 0 ? Math.round(sums.w1 / durCounts.w1) : null,
    },
    m1: {
      completedCount: counts.m1,
      avgDurationMs: durCounts.m1 > 0 ? Math.round(sums.m1 / durCounts.m1) : null,
    },
  };
}

export function isGlobalTaskAttentionNeeded(status: string, flags: readonly string[]): boolean {
  if (status === 'awaiting_brain_decision') return true;
  for (const flag of flags) {
    if (ATTENTION_FLAGS.has(flag)) return true;
  }
  return false;
}

export function normalizeGlobalChecklist(
  checklist?: Partial<GlobalTaskChecklistProgress> | null,
): GlobalTaskChecklistProgress {
  const total = Math.max(0, Math.floor(Number(checklist?.total ?? 0) || 0));
  const implemented = Math.max(0, Math.floor(Number(checklist?.implemented ?? 0) || 0));
  const audited = Math.max(0, Math.floor(Number(checklist?.audited ?? 0) || 0));
  return { total, implemented, audited };
}

const VALID_AUDIT_BLOCKING = new Set(['P0', 'P1', 'P2', 'P3', 'P4']);

export function normalizeGlobalTaskAuditSummary(raw: unknown): GlobalTaskAuditSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const verb = rec.verb === 'PASS' || rec.verb === 'REWORK' ? rec.verb : undefined;
  if (!verb) return undefined;
  const countsObj = rec.counts && typeof rec.counts === 'object' ? (rec.counts as Record<string, unknown>) : {};
  const counts: GlobalTaskAuditCounts = {
    p0: Math.max(0, Math.floor(Number(countsObj.p0 ?? 0) || 0)),
    p1: Math.max(0, Math.floor(Number(countsObj.p1 ?? 0) || 0)),
    p2: Math.max(0, Math.floor(Number(countsObj.p2 ?? 0) || 0)),
    p3: Math.max(0, Math.floor(Number(countsObj.p3 ?? 0) || 0)),
    p4: Math.max(0, Math.floor(Number(countsObj.p4 ?? 0) || 0)),
  };
  const blockingRaw = Array.isArray(rec.blocking)
    ? rec.blocking
        .map((item) => (typeof item === 'string' ? item.trim().toUpperCase() : ''))
        .filter((item) => VALID_AUDIT_BLOCKING.has(item))
    : [];
  const blocking = blockingRaw.length > 0 ? [...new Set(blockingRaw)] : ['P0'];
  const computedBlockingCount = blocking.reduce((sum, lvl) => {
    const key = lvl.toLowerCase() as keyof GlobalTaskAuditCounts;
    return sum + (counts[key] ?? 0);
  }, 0);
  const countSum = counts.p0 + counts.p1 + counts.p2 + counts.p3 + counts.p4;
  const rawBlockingCount = typeof rec.blockingCount === 'number' && Number.isFinite(rec.blockingCount) && rec.blockingCount >= 0
    ? Math.floor(rec.blockingCount)
    : computedBlockingCount;
  const rawFindingsCount = typeof rec.findingsCount === 'number' && Number.isFinite(rec.findingsCount) && rec.findingsCount >= 0
    ? Math.floor(rec.findingsCount)
    : countSum;
  const summary = typeof rec.summary === 'string' && rec.summary.trim()
    ? truncateGlobalBrainText(rec.summary.replace(/\s+/gu, ' ').trim(), GLOBAL_TASK_AUDIT_SUMMARY_MAX_CHARS)
    : '';
  return {
    verb,
    round: Math.max(0, Math.floor(Number(rec.round ?? 0) || 0)),
    counts,
    blocking,
    blockingCount: rawBlockingCount,
    findingsCount: Math.max(rawFindingsCount, countSum > 0 && rawFindingsCount === 0 ? countSum : rawFindingsCount),
    ...(summary ? { summary } : {}),
  };
}

/**
 * Truncate Brain assistant text by Unicode code points without splitting surrogate pairs.
 */
export function truncateGlobalBrainText(
  text: string,
  maxChars: number = GLOBAL_TASK_BRAIN_TEXT_MAX_CHARS,
): string {
  if (typeof text !== 'string') return '';
  if (!text.trim()) return '';
  const limit = Math.max(0, Math.floor(maxChars));
  if (limit === 0) return '';
  const codePoints = Array.from(text);
  if (codePoints.length <= limit) return text;
  if (limit === 1) return '…';
  return `${codePoints.slice(0, limit - 1).join('')}…`;
}

/**
 * Serialize a PG NOTIFY payload while guaranteeing total UTF-8 byte length <= maxBytes.
 * Shrinks `payload[textField]` at code-point boundaries if multibyte characters exceed the budget.
 */
export function serializeBoundedPgNotifyPayload<T extends Record<string, unknown>>(
  payload: T,
  textField?: keyof T & string,
  maxBytes: number = GLOBAL_TASK_PG_NOTIFY_MAX_BYTES,
): string {
  const rawJson = JSON.stringify(payload);
  if (utf8Encoder.encode(rawJson).length <= maxBytes || !textField) {
    return rawJson;
  }

  const rawText = typeof payload[textField] === 'string' ? (payload[textField] as string) : '';
  if (!rawText) return rawJson;

  const codePoints = Array.from(rawText);
  let low = 0;
  let high = codePoints.length;
  let best = JSON.stringify({ ...payload, [textField]: '' });

  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidateText = mid === codePoints.length
      ? rawText
      : (mid <= 1 ? '' : `${codePoints.slice(0, mid - 1).join('')}…`);
    const candidateJson = JSON.stringify({ ...payload, [textField]: candidateText });
    if (utf8Encoder.encode(candidateJson).length <= maxBytes) {
      best = candidateJson;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}
