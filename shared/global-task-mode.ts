import type { PushNotificationType } from './push-notifications.js';

export const GLOBAL_TASK_WS_PATH = '/api/global-tasks/ws' as const;
export const GLOBAL_TASK_SNAPSHOT_PATH = '/api/global-tasks' as const;
export const GLOBAL_TASK_TICKET_PATH = '/api/global-tasks/ws-ticket' as const;
export const GLOBAL_TASK_FLEET_SNAPSHOT_MSG = 'task_pair.fleet_snapshot' as const;
export const GLOBAL_TASK_BRAIN_TEXT_MAX_CHARS = 1200 as const;
export const GLOBAL_TASK_NOTIFY_CHANNEL = 'global_task_pair_updates' as const;
export const GLOBAL_TASK_WS_TICKET_TYPE = 'global-tasks-ws-ticket' as const;
export const GLOBAL_TASK_PG_NOTIFY_MAX_BYTES = 4000 as const;
export const GLOBAL_TASK_RECENT_FINISHED_LIMIT = 50 as const;
export const GLOBAL_TASK_TERMINAL_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

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
  auditor?: string;
  liveSummary?: string;
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
  auditor?: string;
  liveSummary?: string;
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
