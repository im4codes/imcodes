import { memo } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { TASK_PAIR_TERMINAL_STATUSES, TASK_PAIR_SNAPSHOT_EVENT } from '@shared/task-pair.js';
import { taskPairDisplayTitle } from '@shared/task-pair-display.js';
import type { SupervisionTaskConsoleTaskRow } from '@shared/supervision-task-console.js';
import { openTaskPairReferences, taskPairReferenceStatusKey, type TaskPairReference } from '../util/task-pair-reference.js';

type Snapshot = {
  authoritative?: boolean;
  serverId?: string;
  scopeReset?: boolean;
  authorityUnavailable?: boolean;
  tasks?: readonly (Partial<SupervisionTaskConsoleTaskRow> & { brief?: string })[];
  assignments?: readonly { taskId?: string; ownerSessionName?: string }[];
};

/** Canonical membership only: two agents may deliberately have the same label. */
export function currentSubSessionTask(snapshot: Snapshot | null | undefined, sessionName: string, serverId?: string): TaskPairReference | undefined {
  if (!sessionName || !snapshot?.authoritative || snapshot.scopeReset || snapshot.authorityUnavailable
    || (serverId && snapshot.serverId !== serverId) || !Array.isArray(snapshot.tasks)) return undefined;
  const assigned = new Set((snapshot.assignments ?? []).filter(a => a.ownerSessionName === sessionName).map(a => a.taskId));
  let selected: { reference: TaskPairReference; active: boolean; updated: number } | undefined;
  for (const row of snapshot.tasks) {
    if (!row?.taskId) continue;
    const hasCanonicalRoles = typeof row.pair?.executor === 'string' || typeof row.pair?.auditor === 'string';
    const belongs = hasCanonicalRoles
      ? row.pair?.executor === sessionName || row.pair?.auditor === sessionName
      : row.ownerSessionName === sessionName || assigned.has(row.taskId);
    if (!belongs) continue;
    if (row.pair && TASK_PAIR_TERMINAL_STATUSES.includes(row.pair.status)) continue;
    const title = taskPairDisplayTitle(row.title, row.taskId, row.brief ?? row.pair?.brief);
    if (!title) continue;
    const reference = openTaskPairReferences({ ...snapshot, tasks: [row] })[0];
    if (!reference) continue;
    const active = row.pair?.status !== 'passed';
    const updated = Number(row.pair?.updatedAt ?? row.updatedAt) || 0;
    if (!selected || Number(active) > Number(selected.active) || (active === selected.active && updated > selected.updated)) selected = { reference: { ...reference, title }, active, updated };
  }
  return selected?.reference;
}

const snapshotNow = () => (window as Window & { __imcodesTaskPairSnapshot?: Snapshot }).__imcodesTaskPairSnapshot;

/** Shared by floating, preview-card and pinned sub-session title bars. No new RPC or timer. */
export const SubSessionTaskTitle = memo(function SubSessionTaskTitle({ sessionName, serverId, fallback }: { sessionName: string; serverId?: string; fallback: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<Snapshot | null | undefined>(snapshotNow);
  useEffect(() => {
    setSnapshot(snapshotNow());
    const update = (event: Event) => {
      const detail = (event as CustomEvent<Snapshot>).detail;
      setSnapshot(detail?.scopeReset || detail?.authorityUnavailable ? null : detail);
    };
    window.addEventListener(TASK_PAIR_SNAPSHOT_EVENT, update);
    return () => window.removeEventListener(TASK_PAIR_SNAPSHOT_EVENT, update);
  }, [serverId]);
  const task = currentSubSessionTask(snapshot, sessionName, serverId);
  if (!task) return <>{fallback}</>;
  const state = t(taskPairReferenceStatusKey(task.status));
  return <span class="subsession-task-title" title={`${task.title} · ${state}`}>
    <span class="subsession-task-name">{task.title}</span>
    <span class="subsession-task-state">{state}</span>
  </span>;
});
