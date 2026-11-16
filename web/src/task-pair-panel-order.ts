import type { TimelineEvent } from './ws-client.js';
import { TASK_PAIR_TERMINAL_STATUSES, TASK_PAIR_TIMELINE_EVENT, TASK_PAIR_STATUSES, type TaskPairStatus } from '@shared/task-pair.js';
import { taskPairWaitKind, readPairScheduling, TASK_PAIR_WAIT_KINDS, type TaskPairScheduling } from '@shared/task-pair-suspension.js';

export const TASK_PAIR_PANEL_MAX_RECENT_ROWS = 6;

export type TaskPairConsoleSnapshotDetail = {
  authoritative?: unknown;
  serverId?: string;
  scopeKey?: string;
  authorityScopeKey?: string;
  tasks?: readonly Record<string, unknown>[];
  taskTitles?: Record<string, string>;
  assignments?: readonly Record<string, unknown>[];
  scopeReset?: boolean;
  authorityUnavailable?: boolean;
  op?: string;
  task?: unknown;
};

export type TaskPairPanelRow = {
  payload: Record<string, unknown>;
  startedAt: number;
  updatedAt: number;
};

export type TaskPairPanelGroupKey =
  | 'working'
  | 'audit'
  | 'rework'
  | 'queued'
  | 'awaiting_brain_decision'
  | typeof TASK_PAIR_WAIT_KINDS[number]
  | 'recent';

export type TaskPairPanelGroup = {
  key: TaskPairPanelGroupKey;
  rows: TaskPairPanelRow[];
};

const GROUP_ORDER: readonly TaskPairPanelGroupKey[] = [
  'working',
  'audit',
  'rework',
  'queued',
  'awaiting_brain_decision',
  ...TASK_PAIR_WAIT_KINDS,
  'recent',
];

export function isValidTaskPairStatus(value: unknown): value is TaskPairStatus {
  return typeof value === 'string' && (TASK_PAIR_STATUSES as readonly string[]).includes(value);
}

export function matchesSnapshotServer(
  snapshot: { serverId?: unknown } | null | undefined,
  serverId?: string | null,
): boolean {
  return !(typeof snapshot?.serverId === 'string' && snapshot.serverId && serverId && snapshot.serverId !== serverId);
}

export function isAcceptedPanelSnapshot(
  snapshot: { authoritative?: unknown; serverId?: unknown } | null | undefined,
  serverId?: string | null,
): boolean {
  if (!snapshot || snapshot.authoritative === false) return false;
  return matchesSnapshotServer(snapshot, serverId);
}

function finiteTimestamp(value: unknown, fallback?: number): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function snapshotTimestamp(row: Record<string, unknown>): number {
  const value = Number(row.updatedAt);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isTerminalRow(row: Record<string, unknown> | undefined): boolean {
  return Boolean(row && TASK_PAIR_TERMINAL_STATUSES.includes(row.toStatus as TaskPairStatus));
}

function mergeSnapshotRow(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) return incoming;
  if (isTerminalRow(previous) && !isTerminalRow(incoming)) return previous;
  if (snapshotTimestamp(incoming) < snapshotTimestamp(previous)) return previous;
  return incoming;
}

export function mergeSnapshotRows(
  previous: readonly Record<string, unknown>[] | null,
  incoming: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  if (!previous) return incoming;
  const previousByTask = new Map(previous.map((row) => [String(row.taskId), row]));
  return incoming.map((row) => mergeSnapshotRow(previousByTask.get(String(row.taskId)), row));
}

export function normalizeTaskPairSnapshot(
  detail: TaskPairConsoleSnapshotDetail,
): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(detail.tasks)) return null;
  const byTask = new Map<string, Record<string, unknown>[]>();
  for (const assignment of detail.assignments ?? []) {
    const id = typeof assignment.taskId === 'string' ? assignment.taskId : '';
    if (id) byTask.set(id, [...(byTask.get(id) ?? []), assignment]);
  }
  return detail.tasks.map((task) => {
    const pair = (task.pair ?? {}) as Record<string, unknown>;
    const roles = byTask.get(String(task.taskId)) ?? [];
    const executor = roles.find((role) => role.role === 'implementer');
    const auditor = roles.find((role) => role.role === 'auditor');
    const toStatus = pair.status ?? task.status;
    const startedAt = finiteTimestamp(pair.startedAt ?? pair.createdAt);
    const updatedAt = finiteTimestamp(pair.updatedAt ?? task.updatedAt, startedAt);
    const endedAt = TASK_PAIR_TERMINAL_STATUSES.includes(toStatus as TaskPairStatus)
      ? finiteTimestamp(pair.endedAt ?? task.updatedAt, updatedAt)
      : undefined;
    return {
      ...pair,
      scheduling: readPairScheduling(pair.scheduling as TaskPairScheduling | undefined),
      taskId: task.taskId,
      title: task.title,
      brief: typeof task.brief === 'string' && task.brief.trim() ? task.brief : pair.brief,
      toStatus,
      ...(startedAt !== undefined ? { startedAt } : {}),
      updatedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      queuePosition: pair.queuePosition,
      executor: pair.executor,
      auditor: pair.auditor,
      executorLabel: executor?.ownerSessionLabel ?? pair.executorLabel,
      auditorLabel: auditor?.ownerSessionLabel ?? pair.auditorLabel,
      executorModel: executor?.observedModel ?? pair.executorModel,
      executorThinking: executor?.observedThinking ?? pair.executorThinking,
      auditorModel: auditor?.observedModel ?? pair.auditorModel,
      auditorThinking: auditor?.observedThinking ?? pair.auditorThinking,
      executorState: executor?.sessionState ?? pair.executorState,
      auditorState: auditor?.sessionState ?? pair.auditorState,
    };
  });
}

export function getTaskPairWaitKind(payload: Record<string, unknown>) {
  return taskPairWaitKind({
    scheduling: payload.scheduling as TaskPairScheduling | undefined,
    status: payload.toStatus as TaskPairStatus,
  });
}

export function groupAndOrderTaskPairRows(
  rows: Iterable<TaskPairPanelRow>,
  scopeSessionId?: string | null,
): { allRows: TaskPairPanelRow[]; groups: TaskPairPanelGroup[]; orderedRows: TaskPairPanelRow[] } {
  const allRows: TaskPairPanelRow[] = [];
  for (const row of rows) {
    if (!isValidTaskPairStatus(row.payload.toStatus)) continue;
    if (
      scopeSessionId
      && String(row.payload.executor ?? '') !== scopeSessionId
      && String(row.payload.auditor ?? '') !== scopeSessionId
    ) {
      continue;
    }
    allRows.push(row);
  }
  const groupFor = (value: TaskPairStatus, payload: Record<string, unknown>): TaskPairPanelGroupKey => (
    getTaskPairWaitKind(payload)
    ?? (value === 'queued'
      ? 'queued'
      : value === 'awaiting_brain_decision'
        ? 'awaiting_brain_decision'
        : value === 'rework'
          ? 'rework'
          : value === 'in_audit' || value === 'awaiting_audit'
            ? 'audit'
            : value === 'done' || value === 'cancelled' || value === 'passed'
              ? 'recent'
              : 'working')
  );
  const groups = GROUP_ORDER
    .map((key) => {
      const grouped = allRows.filter((row) => groupFor(row.payload.toStatus as TaskPairStatus, row.payload) === key);
      if (key === 'queued') {
        grouped.sort(
          (a, b) => Number(a.payload.queuePosition ?? Number.MAX_SAFE_INTEGER)
            - Number(b.payload.queuePosition ?? Number.MAX_SAFE_INTEGER),
        );
      }
      return { key, rows: key === 'recent' ? grouped.slice(-TASK_PAIR_PANEL_MAX_RECENT_ROWS) : grouped };
    })
    .filter((group) => group.rows.length > 0);
  const orderedRows = groups.flatMap((group) => group.rows);
  return { allRows, groups, orderedRows };
}

export function isTaskPairSplittable(payload: Record<string, unknown>): boolean {
  return typeof payload.executor === 'string'
    && Boolean(payload.executor)
    && payload.executor !== 'none'
    && typeof payload.auditor === 'string'
    && Boolean(payload.auditor)
    && payload.auditor !== 'none';
}

export function resolveOrderedTaskPairRows({
  snapshot,
  events,
  serverId,
  scopeSessionId,
}: {
  snapshot?: TaskPairConsoleSnapshotDetail | null;
  events: readonly TimelineEvent[];
  serverId?: string | null;
  scopeSessionId?: string | null;
}): TaskPairPanelRow[] {
  const acceptedSnapshot = snapshot && !snapshot.scopeReset && isAcceptedPanelSnapshot(snapshot, serverId)
    ? snapshot
    : null;
  if (acceptedSnapshot?.authorityUnavailable) return [];

  const latest = new Map<string, TaskPairPanelRow>();
  const normalizedSnapshot = acceptedSnapshot ? normalizeTaskPairSnapshot(acceptedSnapshot) : null;
  if (normalizedSnapshot) {
    for (const payload of normalizedSnapshot) {
      if (typeof payload.taskId === 'string') {
        latest.set(payload.taskId, {
          payload,
          startedAt: Number(payload.startedAt),
          updatedAt: Number(payload.updatedAt),
        });
      }
    }
  } else {
    for (const event of events) {
      if (event.type !== TASK_PAIR_TIMELINE_EVENT) continue;
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.taskId === 'string') {
        const old = latest.get(payload.taskId);
        latest.set(payload.taskId, {
          payload,
          startedAt: old?.startedAt ?? event.ts,
          updatedAt: event.ts,
        });
      }
    }
  }
  return groupAndOrderTaskPairRows(latest.values(), scopeSessionId).orderedRows;
}
