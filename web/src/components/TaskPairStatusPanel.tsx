import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent } from '../ws-client.js';
import { TASK_PAIR_TIMELINE_EVENT, TASK_PAIR_STATUSES, type TaskPairStatus } from '@shared/task-pair.js';
import { formatElapsedDuration } from '../util/tool-duration.js';
import { watchProjectionStore } from '../watch-projection.js';

const STORAGE_KEY = 'imcodes.task-pair-status-panel.collapsed';
const MAX_ROWS = 6;

function status(value: unknown): value is TaskPairStatus {
  return typeof value === 'string' && (TASK_PAIR_STATUSES as readonly string[]).includes(value);
}

function normalizeSnapshot(detail: { tasks?: readonly Record<string, unknown>[]; assignments?: readonly Record<string, unknown>[] }): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(detail.tasks)) return null;
  const byTask = new Map<string, Record<string, unknown>[]>();
  for (const assignment of detail.assignments ?? []) { const id = typeof assignment.taskId === 'string' ? assignment.taskId : ''; if (id) byTask.set(id, [...(byTask.get(id) ?? []), assignment]); }
  return detail.tasks.map((task) => {
    const pair = (task.pair ?? {}) as Record<string, unknown>; const roles = byTask.get(String(task.taskId)) ?? [];
    const executor = roles.find((role) => role.role === 'implementer'); const auditor = roles.find((role) => role.role === 'auditor');
    return { ...pair, taskId: task.taskId, title: task.title, toStatus: pair.status ?? task.status, startedAt: pair.createdAt ?? task.updatedAt, queuePosition: pair.queuePosition, executor: pair.executor, auditor: pair.auditor, executorLabel: executor?.ownerSessionLabel ?? pair.executorLabel, auditorLabel: auditor?.ownerSessionLabel ?? pair.auditorLabel, executorModel: executor?.observedModel ?? pair.executorModel, auditorModel: auditor?.observedModel ?? pair.auditorModel, executorState: executor?.sessionState ?? pair.executorState, auditorState: auditor?.sessionState ?? pair.auditorState };
  });
}

type SessionLabelEntry = { name: string; label?: string | null; activeModel?: string | null; requestedModel?: string | null };

function resolveSessionLabel(
  id: string,
  payloadLabel: unknown,
  sessions: readonly SessionLabelEntry[] | undefined,
  projectionSessions: readonly { sessionName: string; title: string }[],
): string {
  if (typeof payloadLabel === 'string' && payloadLabel.trim()) return payloadLabel.trim();
  const session = sessions?.find((entry) => entry.name === id);
  if (session?.label?.trim()) return session.label.trim();
  const projected = projectionSessions.find((entry) => entry.sessionName === id);
  if (projected?.title.trim()) return projected.title.trim();
  return '';
}

function resolveSessionModel(
  id: string,
  payloadModel: unknown,
  sessions: readonly SessionLabelEntry[] | undefined,
  projectionSessions: readonly { sessionName: string; title: string; activeModel?: string | null; requestedModel?: string | null }[],
): string | undefined {
  if (typeof payloadModel === 'string' && payloadModel.trim()) return payloadModel.trim();
  const session = sessions?.find((entry) => entry.name === id);
  if (session?.activeModel?.trim() || session?.requestedModel?.trim()) return session.activeModel?.trim() || session.requestedModel?.trim() || undefined;
  const projected = projectionSessions.find((entry) => entry.sessionName === id);
  return projected?.activeModel?.trim() || projected?.requestedModel?.trim() || undefined;
}

export function TaskPairStatusPanel({ events, sessions }: { events: readonly TimelineEvent[]; sessions?: readonly SessionLabelEntry[] }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  const [snapshotRows, setSnapshotRows] = useState<readonly Record<string, unknown>[] | null>(() => {
    const detail = (window as Window & { __imcodesTaskPairSnapshot?: { tasks?: readonly Record<string, unknown>[]; assignments?: readonly Record<string, unknown>[] } }).__imcodesTaskPairSnapshot;
    return detail ? normalizeSnapshot(detail) : null;
  });
  useEffect(() => {
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent).detail as { tasks?: readonly Record<string, unknown>[]; assignments?: readonly Record<string, unknown>[]; op?: string; task?: Record<string, unknown>; removedId?: string } | undefined;
      if (!detail) return;
      if (Array.isArray(detail.tasks)) {
        setSnapshotRows(normalizeSnapshot(detail));
      } else if (detail.op === 'task_upsert' && detail.task) {
        setSnapshotRows((current) => current ? [...current.filter((row) => row.taskId !== detail.task!.taskId), { ...(detail.task!.pair as Record<string, unknown> ?? {}), taskId: detail.task!.taskId, title: detail.task!.title, toStatus: (detail.task!.pair as Record<string, unknown> | undefined)?.status ?? detail.task!.status, startedAt: (detail.task!.pair as Record<string, unknown> | undefined)?.createdAt ?? detail.task!.updatedAt }] : current);
      } else if (detail.op === 'task_remove' && detail.removedId) setSnapshotRows((current) => current?.filter((row) => row.taskId !== detail.removedId) ?? current);
    };
    window.addEventListener('supervision:task-pairs', onSnapshot);
    return () => window.removeEventListener('supervision:task-pairs', onSnapshot);
  }, []);
  const latest = new Map<string, { payload: Record<string, unknown>; startedAt: number; updatedAt: number }>();
  if (snapshotRows) for (const payload of snapshotRows) if (typeof payload.taskId === 'string') latest.set(payload.taskId, { payload, startedAt: Number(payload.startedAt ?? Date.now()), updatedAt: Number(payload.updatedAt ?? Date.now()) });
  for (const event of events) {
    if (snapshotRows) break;
    if (event.type !== TASK_PAIR_TIMELINE_EVENT) continue;
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.taskId === 'string') {
      const old = latest.get(payload.taskId);
      latest.set(payload.taskId, { payload, startedAt: old?.startedAt ?? event.ts, updatedAt: event.ts });
    }
  }
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const allRows = [...latest.values()].filter((row) => status(row.payload.toStatus));
  const groupFor = (value: TaskPairStatus) => value === 'queued' ? 'queued' : value === 'rework' ? 'rework' : value === 'in_audit' || value === 'awaiting_audit' ? 'audit' : value === 'done' || value === 'cancelled' || value === 'passed' ? 'recent' : 'working';
  const groups = (['working', 'audit', 'rework', 'queued', 'recent'] as const).map((key) => {
    const rows = allRows.filter((row) => groupFor(row.payload.toStatus as TaskPairStatus) === key);
    if (key === 'queued') rows.sort((a, b) => Number(a.payload.queuePosition ?? Number.MAX_SAFE_INTEGER) - Number(b.payload.queuePosition ?? Number.MAX_SAFE_INTEGER));
    return { key, rows: key === 'recent' ? rows.slice(-MAX_ROWS) : rows };
  }).filter((group) => group.rows.length > 0);
  const counts = allRows.reduce<{ working: number; audit: number; queued: number }>((result, row) => {
    const value = row.payload.toStatus;
    if (value === 'working' || value === 'rework') result.working += 1;
    else if (value === 'in_audit' || value === 'awaiting_audit') result.audit += 1;
    else if (value === 'queued') result.queued += 1;
    return result;
  }, { working: 0, audit: 0, queued: 0 });
  if (latest.size === 0) return null;
  const toggle = () => setCollapsed((value) => { const next = !value; try { window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch {} return next; });
  const projectionSessions = watchProjectionStore.getSnapshot().sessions;
  const session = (id: unknown, label: unknown, model: unknown, role: 'executor' | 'auditor') => {
    // 'none' is a real, deliberate value (auditor=none): there is no session
    // to open, so it must not render as a dangling clickable placeholder.
    if (typeof id !== 'string' || !id || id === 'none') return null;
    const text = resolveSessionLabel(id, label, sessions, projectionSessions) || t(`taskPair.panel_${role}`);
    const resolvedModel = resolveSessionModel(id, model, sessions, projectionSessions);
    return <button type="button" class="task-pair-status-session" data-session-name={id} onClick={() => window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session: id } }))}>{resolvedModel ? `${text}${t('taskPair.panel_model_separator')}${resolvedModel}` : text}</button>;
  };
  const durationUnits = {
    hour: t('taskPair.panel_duration_hour'),
    day: t('taskPair.panel_duration_day'),
    minute: t('taskPair.panel_duration_minute'),
    second: t('taskPair.panel_duration_second'),
    separator: t('taskPair.panel_duration_separator'),
  };
  return <aside class={`task-pair-status-panel${collapsed ? ' is-collapsed' : ''}`} data-testid="task-pair-status-panel">
    <button type="button" class="task-pair-status-toggle" aria-expanded={!collapsed} onClick={toggle}>
      <strong>{t('taskPair.panel_title')}</strong>
      <span>{t('taskPair.panel_counts', counts)}</span>
    </button>
    {!collapsed && <div class="task-pair-status-rows">
      {groups.map((group) => {
        const heading = <h4>{t(`taskPair.panel_group_${group.key}`)} <small>({group.rows.length})</small></h4>;
        const content = group.rows.map((row, index) => { const payload = row.payload; const queued = group.key === 'queued'; const elapsedSeconds = Math.max(0, Math.floor((now - row.startedAt) / 1000)); const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title : t('taskPair.panel_untitled'); return <div class="task-pair-status-row" key={String(payload.taskId)}>
          <strong>{queued && <em>#{Number(payload.queuePosition ?? index + 1)} </em>}{title}</strong>
          {queued && payload.urgent === true && <span class="task-pair-status-urgent">!</span>}
          <small>{t('taskPair.panel_started', { time: new Date(row.startedAt).toLocaleTimeString() })} · {queued ? t('taskPair.panel_queued', { duration: formatElapsedDuration(elapsedSeconds, durationUnits) }) : t('taskPair.panel_elapsed', { duration: formatElapsedDuration(elapsedSeconds, durationUnits) })}</small>
          {!queued && <span>{payload.toStatus === 'rework' ? t('taskPair.status.rework_round', { round: payload.round ?? 1 }) : t(`taskPair.status.${payload.toStatus}`)} · {t('taskPair.panel_round', { round: payload.round ?? 0 })}</span>}
          <div><span class={`task-pair-status-dot ${payload.executorState === 'running' ? 'is-running' : ''}`} />{session(payload.executor, payload.executorLabel, payload.executorModel, 'executor') ?? <small>{t('taskPair.panel_unassigned')}</small>}{payload.auditor !== 'none' && <span class={`task-pair-status-dot ${payload.auditorState === 'running' ? 'is-running' : ''}`} />}{payload.auditor === 'none' ? <small>{t('taskPair.panel_no_audit')}</small> : session(payload.auditor, payload.auditorLabel, payload.auditorModel, 'auditor') ?? <small>{t('taskPair.panel_unassigned')}</small>}</div>
        </div>; });
        return group.key === 'recent'
          ? <details class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}><summary>{heading}</summary>{content}</details>
          : <section class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}>{heading}{content}</section>;
      })}
    </div>}
  </aside>;
}
