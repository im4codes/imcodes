import { TASK_PAIR_STATUSES, TASK_PAIR_STATUS_FAILED, type TaskPairStatus } from '@shared/task-pair.js';
import { readPairScheduling, taskPairWaitKind, TASK_PAIR_WAIT_KINDS, type TaskPairScheduling } from '@shared/task-pair-suspension.js';

export interface TaskPairReference {
  taskId: string;
  title: string;
  status: string;
}

const TASK_PAIR_REFERENCE_STATUS_KEYS = new Set<string>([
  ...TASK_PAIR_STATUSES,
  ...TASK_PAIR_WAIT_KINDS,
  TASK_PAIR_STATUS_FAILED,
]);

/** Resolve a snapshot status to the locale key used by the composer badge. */
export function taskPairReferenceStatusKey(status: string): string {
  return TASK_PAIR_REFERENCE_STATUS_KEYS.has(status)
    ? `taskPair.status.${status}`
    : 'taskPair.card_unknown_status';
}

/** Match a simple trailing `%query` trigger at a word boundary. */
export function matchTaskPairReferenceTrigger(text: string): string | null {
  const match = /(?:^|\s)%([^\s%]*)$/u.exec(text);
  return match ? (match[1] ?? '') : null;
}

/** Extract authoritative pair rows from a bridge snapshot, including terminal rows. */
export function openTaskPairReferences(detail: unknown): TaskPairReference[] {
  if (!detail || typeof detail !== 'object') return [];
  const snapshot = detail as { authoritative?: unknown; tasks?: unknown };
  if (snapshot.authoritative !== true || !Array.isArray(snapshot.tasks)) return [];
  const seen = new Set<string>();
  const rows: TaskPairReference[] = [];
  for (const entry of snapshot.tasks) {
    if (!entry || typeof entry !== 'object') continue;
    const task = entry as { taskId?: unknown; title?: unknown; pair?: { status?: unknown; scheduling?: unknown }; status?: unknown };
    const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    const rawStatus = typeof task.pair?.status === 'string' ? task.pair.status : typeof task.status === 'string' ? task.status : '';
    const scheduling = task.pair?.scheduling && typeof task.pair.scheduling === 'object'
      ? readPairScheduling(task.pair.scheduling as TaskPairScheduling)
      : undefined;
    const status = rawStatus
      ? taskPairWaitKind({ status: rawStatus as TaskPairStatus, scheduling }) ?? rawStatus
      : '';
    if (!taskId || !title || !status || seen.has(taskId)) continue;
    seen.add(taskId);
    rows.push({ taskId, title, status });
  }
  return rows;
}

export function filterTaskPairReferences(rows: readonly TaskPairReference[], query: string): TaskPairReference[] {
  const normalized = query.trim().toLocaleLowerCase();
  return rows.filter((row) => !normalized || row.title.toLocaleLowerCase().includes(normalized));
}

export function replaceTaskPairReferenceTrigger(text: string, title: string): string {
  const stripped = text.replace(/(?:^|\s)%[^\s%]*$/u, (match) => match.startsWith(' ') ? ' ' : '');
  return `${stripped}${stripped && !stripped.endsWith(' ') ? ' ' : ''}%${title} `;
}

