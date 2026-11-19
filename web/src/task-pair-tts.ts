import {
  TASK_PAIR_BRAIN_NOTICE_EVENT,
  TASK_PAIR_CHECKLIST_AUTO_TICK_VERB,
  TASK_PAIR_CHECK_VERB,
  TASK_PAIR_MATERIAL_EVENT_VERB,
  TASK_PAIR_MCP_DELIVERY_EVENT,
  TASK_PAIR_MCP_DISPATCH_EVENT,
  TASK_PAIR_NEXT_ROUND_VERB,
  TASK_PAIR_NOTICE_VERB,
  TASK_PAIR_RECORDED_EVENT_VERBS,
  TASK_PAIR_STATUSES,
  TASK_PAIR_TITLE_EVENT_VERB,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  type TaskPairStatus,
} from '@shared/task-pair.js';
import { taskPairDisplayTitle } from '@shared/task-pair-display.js';
import { taskPairNotificationKey } from '@shared/task-pair-notification.js';

export type TaskPairTtsTranslate = (key: string, options?: Record<string, unknown>) => string;

export interface TaskPairTtsAnnouncement {
  text: string;
  dedupKey: string;
}

const IGNORED_VERBS = new Set<string>([
  TASK_PAIR_CHECK_VERB,
  'CLAIM',
  TASK_PAIR_TITLE_EVENT_VERB,
  TASK_PAIR_MATERIAL_EVENT_VERB,
  TASK_PAIR_CHECKLIST_AUTO_TICK_VERB,
  TASK_PAIR_MCP_DELIVERY_EVENT,
  TASK_PAIR_MCP_DISPATCH_EVENT,
  TASK_PAIR_BRAIN_NOTICE_EVENT,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  ...TASK_PAIR_RECORDED_EVENT_VERBS,
]);

const VERB_TO_STATUS_KEY: Readonly<Record<string, TaskPairStatus>> = {
  DISPATCH: 'working',
  STARTED: 'working',
  WORKING: 'working',
  QUEUE: 'queued',
  READY_FOR_AUDIT: 'in_audit',
  PASS: 'passed',
  REWORK: 'rework',
  DONE: 'done',
  CANCEL: 'cancelled',
};

function isKnownTaskPairStatus(value: string): value is TaskPairStatus {
  return (TASK_PAIR_STATUSES as readonly string[]).includes(value);
}

/**
 * Format a task-pair lifecycle transition event into a localized spoken
 * announcement (`title + status`) plus a cross-source, round-aware dedup key.
 * Returns `null` for non-lifecycle bookkeeping events or unmapped payloads.
 */
export function formatTaskPairTtsAnnouncement(
  t: TaskPairTtsTranslate,
  payload: Record<string, unknown> | null | undefined,
): TaskPairTtsAnnouncement | null {
  if (!payload || typeof payload !== 'object') return null;

  const verb = typeof payload.verb === 'string' ? payload.verb.trim().toUpperCase() : '';
  const rawStatus = typeof payload.toStatus === 'string' ? payload.toStatus.trim().toLowerCase() : '';
  if (IGNORED_VERBS.has(verb)) return null;
  if (verb === TASK_PAIR_NOTICE_VERB && !rawStatus) return null;

  const round = typeof payload.round === 'number' && Number.isFinite(payload.round) && payload.round > 0
    ? Math.floor(payload.round)
    : 0;

  let statusLabel = '';
  if (verb === 'BLOCKED') {
    statusLabel = t('taskPair.flag.blocked');
  } else if (verb === 'NEEDS_INPUT') {
    statusLabel = t('taskPair.flag.needs_input');
  } else if (rawStatus === 'rework' && round > 0) {
    statusLabel = t('taskPair.status.rework_round', { round });
  } else if (isKnownTaskPairStatus(rawStatus)) {
    statusLabel = t(`taskPair.status.${rawStatus}`);
  } else if (verb === TASK_PAIR_NEXT_ROUND_VERB) {
    statusLabel = t('taskPair.verb.next_round');
  } else if (verb && VERB_TO_STATUS_KEY[verb]) {
    const mappedStatus = VERB_TO_STATUS_KEY[verb];
    statusLabel = mappedStatus === 'rework' && round > 0
      ? t('taskPair.status.rework_round', { round })
      : t(`taskPair.status.${mappedStatus}`);
  } else {
    return null;
  }

  if (!statusLabel || !statusLabel.trim()) return null;

  const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
  const title = taskPairDisplayTitle(payload.title, taskId, payload.brief) ?? t('taskPair.card_untitled');
  const text = t('tts.task_pair_announcement', { title, status: statusLabel }).trim();
  if (!text) return null;

  const baseKey = taskPairNotificationKey(payload)
    ?? (taskId ? `${taskId}\u0000${rawStatus || verb.toLowerCase()}` : `${title}\u0000${rawStatus || verb.toLowerCase()}`);
  const flagSuffix = verb === 'BLOCKED' || verb === 'NEEDS_INPUT' ? `\u0000${verb}` : '';
  const dedupKey = `${baseKey}\u0000r=${round}${flagSuffix}`;

  return { text, dedupKey };
}
