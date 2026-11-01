import { TASK_PAIR_TERMINAL_STATUSES } from '@shared/task-pair.js';

export interface TaskPairReference {
  taskId: string;
  title: string;
  status: string;
}

/** Match a simple trailing `%query` trigger at a word boundary. */
export function matchTaskPairReferenceTrigger(text: string): string | null {
  const match = /(?:^|\s)%([^\s%]*)$/u.exec(text);
  return match ? (match[1] ?? '') : null;
}

/** Extract only authoritative, non-terminal pair rows from a bridge snapshot. */
export function openTaskPairReferences(detail: unknown): TaskPairReference[] {
  if (!detail || typeof detail !== 'object') return [];
  const snapshot = detail as { authoritative?: unknown; tasks?: unknown };
  if (snapshot.authoritative !== true || !Array.isArray(snapshot.tasks)) return [];
  const seen = new Set<string>();
  const rows: TaskPairReference[] = [];
  for (const entry of snapshot.tasks) {
    if (!entry || typeof entry !== 'object') continue;
    const task = entry as { taskId?: unknown; title?: unknown; pair?: { status?: unknown }; status?: unknown };
    const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    const status = typeof task.pair?.status === 'string' ? task.pair.status : typeof task.status === 'string' ? task.status : '';
    if (!taskId || !title || !status || TASK_PAIR_TERMINAL_STATUSES.includes(status as typeof TASK_PAIR_TERMINAL_STATUSES[number]) || seen.has(taskId)) continue;
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

