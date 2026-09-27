import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent } from '../ws-client.js';
import { TASK_PAIR_STATUS_PANEL_STORAGE_KEY, TASK_PAIR_TERMINAL_STATUSES, TASK_PAIR_TIMELINE_EVENT, TASK_PAIR_STATUSES, type TaskPairStatus } from '@shared/task-pair.js';
import { formatElapsedDuration } from '../util/tool-duration.js';
import { watchProjectionStore } from '../watch-projection.js';

const MAX_ROWS = 6;

export function collapsedStorageKey(serverId: string | null | undefined, mobile: boolean): string {
  const scope = serverId ? `:${serverId}` : '';
  return `${TASK_PAIR_STATUS_PANEL_STORAGE_KEY}${scope}:${mobile ? 'mobile' : 'desktop'}`;
}
function mobileLayout(): boolean {
  try { return window.matchMedia?.('(max-width: 720px)').matches ?? false; } catch { return false; }
}

function readCollapsed(serverId: string | null | undefined, mobile: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(collapsedStorageKey(serverId, mobile));
    return stored === null ? mobile : stored === '1';
  } catch { return mobile; }
}

function status(value: unknown): value is TaskPairStatus {
  return typeof value === 'string' && (TASK_PAIR_STATUSES as readonly string[]).includes(value);
}

type TaskPairConsoleSnapshotDetail = { tasks?: readonly Record<string, unknown>[]; assignments?: readonly Record<string, unknown>[] };

function finiteTimestamp(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function mergeDefined(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(incoming)) if (value !== undefined) merged[key] = value;
  return merged;
}

function normalizeSnapshot(detail: TaskPairConsoleSnapshotDetail): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(detail.tasks)) return null;
  const byTask = new Map<string, Record<string, unknown>[]>();
  for (const assignment of detail.assignments ?? []) { const id = typeof assignment.taskId === 'string' ? assignment.taskId : ''; if (id) byTask.set(id, [...(byTask.get(id) ?? []), assignment]); }
  return detail.tasks.map((task) => {
    const pair = (task.pair ?? {}) as Record<string, unknown>; const roles = byTask.get(String(task.taskId)) ?? [];
    const executor = roles.find((role) => role.role === 'implementer'); const auditor = roles.find((role) => role.role === 'auditor');
    const toStatus = pair.status ?? task.status;
    const startedAt = finiteTimestamp(pair.startedAt ?? pair.createdAt ?? task.updatedAt, Date.now());
    const updatedAt = finiteTimestamp(pair.updatedAt ?? task.updatedAt, startedAt);
    const endedAt = TASK_PAIR_TERMINAL_STATUSES.includes(toStatus as TaskPairStatus)
      ? finiteTimestamp(pair.endedAt ?? task.updatedAt, updatedAt)
      : undefined;
    return {
      ...pair,
      taskId: task.taskId,
      title: task.title,
      toStatus,
      startedAt,
      updatedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      queuePosition: pair.queuePosition,
      executor: pair.executor,
      auditor: pair.auditor,
      executorLabel: executor?.ownerSessionLabel ?? pair.executorLabel,
      auditorLabel: auditor?.ownerSessionLabel ?? pair.auditorLabel,
      executorModel: executor?.observedModel ?? pair.executorModel,
      auditorModel: auditor?.observedModel ?? pair.auditorModel,
      executorState: executor?.sessionState ?? pair.executorState,
      auditorState: auditor?.sessionState ?? pair.auditorState,
    };
  });
}

type SessionLabelEntry = { name: string; label?: string | null; activeModel?: string | null; requestedModel?: string | null };

function hasPairActivity(events: readonly TimelineEvent[]): boolean {
  if (events.some((event) => event.type === TASK_PAIR_TIMELINE_EVENT)) return true;
  const snapshot = (window as Window & { __imcodesTaskPairSnapshot?: { tasks?: readonly unknown[] } }).__imcodesTaskPairSnapshot;
  return Array.isArray(snapshot?.tasks) && snapshot.tasks.length > 0;
}

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

export function TaskPairStatusPanel({ events, sessions, serverId }: { events: readonly TimelineEvent[]; sessions?: readonly SessionLabelEntry[]; serverId?: string | null }) {
  const { t } = useTranslation();
  const [isMobile, setIsMobile] = useState(mobileLayout);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(serverId, mobileLayout()));
  const panelRef = useRef<HTMLElement>(null);
  const persistCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    try { window.localStorage.setItem(collapsedStorageKey(serverId, isMobile), next ? '1' : '0'); } catch {}
  }, [serverId, isMobile]);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 720px)');
    if (!media) return undefined;
    const onChange = () => { setIsMobile(media.matches); setCollapsed(readCollapsed(serverId, media.matches)); };
    media.addEventListener?.('change', onChange);
    window.addEventListener('resize', onChange);
    return () => { media.removeEventListener?.('change', onChange); window.removeEventListener('resize', onChange); };
  }, []);
  useEffect(() => {
    setCollapsed(readCollapsed(serverId, isMobile));
  }, [serverId, isMobile]);
  useEffect(() => {
    if (collapsed) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') persistCollapsed(true); };
    const onPointerDown = (event: PointerEvent) => { if (!panelRef.current?.contains(event.target as Node)) persistCollapsed(true); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('pointerdown', onPointerDown); };
  }, [collapsed, persistCollapsed]);
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
        setSnapshotRows((current) => {
          if (!current) return current;
          const normalized = normalizeSnapshot({ tasks: [detail.task!], assignments: detail.assignments });
          const incoming = normalized?.[0];
          if (!incoming) return current;
          const previous = current.find((row) => row.taskId === incoming.taskId);
          return [...current.filter((row) => row.taskId !== incoming.taskId), mergeDefined(previous, incoming)];
        });
      } else if (detail.op === 'task_remove' && detail.removedId) setSnapshotRows((current) => current?.filter((row) => row.taskId !== detail.removedId) ?? current);
    };
    window.addEventListener('supervision:task-pairs', onSnapshot);
    return () => window.removeEventListener('supervision:task-pairs', onSnapshot);
  }, []);
  const latest = new Map<string, { payload: Record<string, unknown>; startedAt: number; updatedAt: number }>();
  const reworkCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== TASK_PAIR_TIMELINE_EVENT) continue;
    const eventPayload = event.payload as Record<string, unknown>;
    if (typeof eventPayload.taskId === 'string' && eventPayload.verb === 'REWORK') {
      reworkCounts.set(eventPayload.taskId, (reworkCounts.get(eventPayload.taskId) ?? 0) + 1);
    }
  }
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
  const counts = allRows.reduce<{ working: number; audit: number; queued: number; awaitingBrain: number }>((result, row) => {
    const value = row.payload.toStatus;
    if (value === 'working' || value === 'rework') result.working += 1;
    else if (value === 'in_audit' || value === 'awaiting_audit') result.audit += 1;
    else if (value === 'awaiting_brain_decision') result.awaitingBrain += 1;
    else if (value === 'queued') result.queued += 1;
    return result;
  }, { working: 0, audit: 0, queued: 0, awaitingBrain: 0 });
  if (latest.size === 0) return null;
  const toggle = () => persistCollapsed(!collapsed);
  const projectionSessions = watchProjectionStore.getSnapshot().sessions;
  const session = (id: unknown, label: unknown, model: unknown, role: 'executor' | 'auditor') => {
    // 'none' is a real, deliberate value (auditor=none): there is no session
    // to open, so it must not render as a dangling clickable placeholder.
    if (typeof id !== 'string' || !id || id === 'none') return null;
    const text = resolveSessionLabel(id, label, sessions, projectionSessions) || t(`taskPair.panel_${role}`);
    const resolvedModel = resolveSessionModel(id, model, sessions, projectionSessions);
    return <button type="button" class="task-pair-status-session" data-session-name={id} onClick={() => window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session: id } }))}>{resolvedModel ? `${text}${t('taskPair.panel_model_separator')}${resolvedModel}` : text}</button>;
  };
  const unassigned = (model: unknown) => <small>{t('taskPair.panel_unassigned')}{typeof model === 'string' && model.trim() ? `${t('taskPair.panel_model_separator')}${model.trim()}` : ''}</small>;
  const durationUnits = {
    hour: t('taskPair.panel_duration_hour'),
    day: t('taskPair.panel_duration_day'),
    minute: t('taskPair.panel_duration_minute'),
    second: t('taskPair.panel_duration_second'),
    separator: t('taskPair.panel_duration_separator'),
  };
  return <aside ref={panelRef} class={`task-pair-status-panel${collapsed ? ' is-collapsed' : ''}${isMobile ? ' is-mobile' : ' is-desktop'}`} data-testid="task-pair-status-panel">
    <button type="button" class="task-pair-status-toggle" aria-expanded={!collapsed} aria-label={`${t(collapsed ? 'taskPair.panel_expand' : 'taskPair.panel_collapse')} — ${t('taskPair.panel_title')}`} title={t(collapsed ? 'taskPair.panel_expand' : 'taskPair.panel_collapse')} onClick={toggle}>
      {collapsed ? <span class="task-pair-status-icons" role="group" aria-label={t('taskPair.panel_title')}>
        <span class={`task-pair-status-icon task-pair-status-icon--working${counts.working === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_working')} aria-label={t('taskPair.panel_icon_working')}><span aria-hidden="true">▶</span><b>{counts.working}</b></span>
        <span class={`task-pair-status-icon task-pair-status-icon--audit${counts.audit === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_audit')} aria-label={t('taskPair.panel_icon_audit')}><span aria-hidden="true">◉</span><b>{counts.audit}</b></span>
        <span class={`task-pair-status-icon task-pair-status-icon--queued${counts.queued === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_queued')} aria-label={t('taskPair.panel_icon_queued')}><span aria-hidden="true">⏳</span><b>{counts.queued}</b></span>
        <span class={`task-pair-status-icon task-pair-status-icon--awaiting${counts.awaitingBrain === 0 ? ' is-zero' : ' is-highlighted'}`} title={t('taskPair.panel_icon_awaiting_brain')} aria-label={t('taskPair.panel_icon_awaiting_brain')}><span aria-hidden="true">🧠</span><b>{counts.awaitingBrain}</b></span>
        <span class="task-pair-status-collapse-icon" aria-hidden="true">⌄</span>
      </span> : <><strong>{t('taskPair.panel_title')}</strong>
        <span class="task-pair-status-summary">
          <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--working">{t('taskPair.panel_count_working', { count: counts.working })}</span>
          <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--in_audit">{t('taskPair.panel_count_audit', { count: counts.audit })}</span>
          <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--queued">{t('taskPair.panel_count_queued', { count: counts.queued })}</span>
          <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--awaiting_brain_decision">{t('taskPair.status.awaiting_brain_decision')} ({counts.awaitingBrain})</span>
        </span><span class="task-pair-status-collapse-icon" aria-hidden="true">⌃</span></>}
    </button>
    {!collapsed && <div class="task-pair-status-rows">
      {groups.map((group) => {
        const heading = <h4>{t(`taskPair.panel_group_${group.key}`)} <small>({group.rows.length})</small></h4>;
        const content = group.rows.map((row, index) => { const payload = row.payload; const queued = group.key === 'queued'; const terminal = TASK_PAIR_TERMINAL_STATUSES.includes(payload.toStatus as TaskPairStatus); const endedAt = terminal ? finiteTimestamp(payload.endedAt ?? payload.updatedAt, row.startedAt) : now; const elapsedSeconds = Math.max(0, Math.floor((endedAt - row.startedAt) / 1000)); const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title : t('taskPair.panel_untitled'); const taskStatus = String(payload.toStatus); const reworkCount = Math.max(1, reworkCounts.get(String(payload.taskId)) ?? 0); const auditRound = Number(payload.round ?? 0); return <div class={`task-pair-status-row task-pair-chip--${taskStatus}`} data-status={taskStatus} key={String(payload.taskId)}>
          <div class="task-pair-status-row-head">
            <span class={`task-pair-status-badge task-pair-chip--${taskStatus}`}>
              <span class="task-pair-status-badge-dot" aria-hidden="true" />
              {taskStatus === 'rework' ? t('taskPair.panel_rework_count', { count: reworkCount }) : t(`taskPair.status.${taskStatus}`)}
            </span>
            {!queued && auditRound > 0 && <span class="task-pair-status-round-badge">{t('taskPair.panel_round', { round: auditRound })}</span>}
            {!queued && <span class="task-pair-status-round-badge task-pair-status-blocking-badge">{t('taskPair.blocking', { levels: Array.isArray(payload.blocking) ? payload.blocking.join(',') : 'P0' })}</span>}
            {queued && payload.urgent === true && <span class="task-pair-status-urgent">!</span>}
          </div>
          <strong class="task-pair-status-row-title">{queued && <em>#{Number(payload.queuePosition ?? index + 1)} </em>}{title}</strong>
          <small class="task-pair-status-row-meta"><span class="task-pair-status-row-meta-icon" aria-hidden="true">⏱</span>{t('taskPair.panel_started', { time: new Date(row.startedAt).toLocaleTimeString() })} · {queued ? t('taskPair.panel_queued', { duration: formatElapsedDuration(elapsedSeconds, durationUnits) }) : t('taskPair.panel_elapsed', { duration: formatElapsedDuration(elapsedSeconds, durationUnits) })}</small>
          <div class="task-pair-status-row-roles">
            <span class="task-pair-role-chip"><span class={`task-pair-status-dot ${payload.executorState === 'running' ? 'is-running' : ''}`} />{session(payload.executor, payload.executorLabel, payload.executorModel, 'executor') ?? unassigned(payload.executorModel)}</span>
            {payload.auditor === 'none'
              ? <span class="task-pair-role-chip task-pair-role-chip--muted">{t('taskPair.panel_no_audit')}</span>
              : <span class="task-pair-role-chip"><span class={`task-pair-status-dot ${payload.auditorState === 'running' ? 'is-running' : ''}`} />{session(payload.auditor, payload.auditorLabel, payload.auditorModel, 'auditor') ?? unassigned(payload.auditorModel)}</span>}
          </div>
        </div>; });
        return group.key === 'recent'
          ? <details class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}><summary>{heading}</summary>{content}</details>
          : <section class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}>{heading}{content}</section>;
      })}
    </div>}
  </aside>;
}

/** Avoid mounting responsive panel effects in ordinary chats until pair data exists. */
export function TaskPairStatusPanelHost(props: { events: readonly TimelineEvent[]; sessions?: readonly SessionLabelEntry[]; serverId?: string | null }) {
  const [active, setActive] = useState(() => hasPairActivity(props.events));
  useEffect(() => { if (!active && hasPairActivity(props.events)) setActive(true); }, [active, props.events]);
  useEffect(() => {
    if (active) return undefined;
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent).detail as { tasks?: readonly unknown[]; op?: string; task?: unknown } | undefined;
      if ((Array.isArray(detail?.tasks) && detail.tasks.length > 0) || detail?.op === 'task_upsert' || detail?.task) setActive(true);
    };
    window.addEventListener('supervision:task-pairs', onSnapshot);
    return () => window.removeEventListener('supervision:task-pairs', onSnapshot);
  }, [active]);
  return active ? <TaskPairStatusPanel {...props} /> : null;
}
