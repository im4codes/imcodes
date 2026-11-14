import { TASK_PAIR_TERMINAL_STATUSES, TASK_PAIR_OPEN_STATUSES, TASK_PAIR_NO_AUDITOR, type TaskPairStatus, type TaskPairState } from './task-pair.js';
import { isUsableTaskPairTitle } from './supervision-task-identity.js';
/** Scheduling is independent of lifecycle/audit state. Unknown legacy rows run normally. */
export const TASK_PAIR_SCHEDULING_FIELD = 'scheduling' as const;
export const TASK_PAIR_WAIT_KINDS = ['paused', 'waiting_dependencies', 'resuming'] as const;
export const TASK_PAIR_PAUSE_MODES = ['manual', 'dependencies'] as const;
export const TASK_PAIR_MAX_DEPENDENCIES = 32;
export const TASK_PAIR_DEPENDENCY_GRAPH_LIMIT = 4096;
export const TASK_PAIR_RESUME_REASON = 'suspension-resume' as const;
export const TASK_PAIR_DEPENDENCY_FAILURE_REASON = 'dependency-failed' as const;
export const TASK_PAIR_WAKE_BINDING_TAG = ':wake-v1:' as const;
export interface TaskPairScheduling {
  epoch: number;
  manual: boolean;
  dependsOn: string[];
  since: number;
  writer: string;
  note?: string;
  resumePending?: boolean;
  admitted?: boolean;
  resumedAt?: number;
  resumeRetryAt?: number;
  failureNotified?: boolean;
  dependencyTitles?: Record<string, string>;
  /** Wire-only count remains safe when an older server removes private details. */
  dependencyCount?: number;
  details?: { brief: { dependsOn: string[]; note?: string; dependencyTitles?: Record<string, string> } };
}
export function isTaskPairSuspended(pair: { scheduling?: TaskPairScheduling; status?: TaskPairStatus }): boolean {
  if (pair.status && TASK_PAIR_TERMINAL_STATUSES.includes(pair.status)) return false;
  const s = pair.scheduling;
  return !!s && (s.manual || (s.dependencyCount ?? s.dependsOn.length) > 0 || s.resumePending === true);
}
export function taskPairWaitKind(pair: { scheduling?: TaskPairScheduling; status?: TaskPairStatus }): 'paused' | 'waiting_dependencies' | 'resuming' | undefined {
  if (pair.status && TASK_PAIR_TERMINAL_STATUSES.includes(pair.status)) return undefined;
  const s = pair.scheduling;
  return s?.manual ? 'paused' : (s?.dependencyCount ?? s?.dependsOn.length) ? 'waiting_dependencies' : s?.resumePending ? 'resuming' : undefined;
}
export interface TaskPairWakeBinding { project: string; taskId: string; epoch: number }

/** Existing old share redactors recursively strip `brief`, protecting notes/ids during server version skew. */
function normalizeDependencyTitles(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const normalized: Record<string, string> = {};
  for (const [taskId, title] of Object.entries(raw)) {
    const cleanId = taskId.trim();
    if (!cleanId || !isUsableTaskPairTitle(title, cleanId)) continue;
    normalized[cleanId] = title.trim();
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function projectPairScheduling(
  s: TaskPairScheduling,
  dependencyTitles?: Record<string, string>,
): TaskPairScheduling {
  const titles = normalizeDependencyTitles(dependencyTitles) ?? normalizeDependencyTitles(s.dependencyTitles);
  return {
    ...s,
    dependsOn: [],
    note: undefined,
    dependencyTitles: undefined,
    dependencyCount: s.dependsOn.length,
    details: {
      brief: {
        dependsOn: s.dependsOn,
        ...(s.note ? { note: s.note } : {}),
        ...(titles ? { dependencyTitles: titles } : {}),
      },
    },
  };
}
export function readPairScheduling(s: TaskPairScheduling | undefined): TaskPairScheduling | undefined {
  return s?.details?.brief ? { ...s, ...s.details.brief } : s;
}

/** Paused work retains session/resource ownership, but not a quiescent execution slot. */
export function taskPairHoldsExecutionSlot(pair: Pick<TaskPairState, 'status' | 'scheduling' | 'executor' | 'auditor'>, busy: (name: string) => boolean): boolean {
  if (!TASK_PAIR_OPEN_STATUSES.includes(pair.status)) return false;
  if (!isTaskPairSuspended(pair) || pair.scheduling?.admitted) return true;
  return [pair.executor, pair.auditor].some((name) => !!name && name !== TASK_PAIR_NO_AUDITOR && busy(name));
}
