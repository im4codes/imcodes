import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent, WsClient } from '../ws-client.js';
import { TASK_PAIR_TIMELINE_EVENT, TASK_PAIR_STATUSES, TASK_PAIR_MAX_CONCURRENCY_CAP, TASK_PAIR_MAX_CONCURRENCY_RESULT, type TaskPairStatus } from '@shared/task-pair.js';
import { parseTaskPairChecklist, taskPairChecklistCounts } from '@shared/task-pair-checklist.js';
import { DAEMON_COMMAND_TYPES } from '@shared/daemon-command-types.js';
import { formatElapsedDuration } from '../util/tool-duration.js';
import { watchProjectionStore } from '../watch-projection.js';
import { ChatMarkdown } from './ChatMarkdown.js';
import { fetchTimelineHistoryHttp } from '../api.js';

const STORAGE_KEY = 'imcodes.task-pair-status-panel.collapsed';
const MAX_ROWS = 6;
const CONCURRENCY_DEBOUNCE_MS = 400;

function collapsedStorageKey(serverId?: string | null): string {
  return serverId ? `${STORAGE_KEY}:${serverId}` : STORAGE_KEY;
}

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

export function TaskPairStatusPanel({ events, sessions, ws, brain, serverId }: { events: readonly TimelineEvent[]; sessions?: readonly SessionLabelEntry[]; ws?: WsClient | null; brain?: string; serverId?: string | null }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem(collapsedStorageKey(serverId)) === '1'; } catch { return false; }
  });
  const [concurrency, setConcurrency] = useState<{ maxConcurrency: number; fixedOverride: boolean } | null>(null);
  const pendingConcurrencyCommandId = useRef<string>();
  const debounceTimer = useRef<number>();
  useEffect(() => {
    if (!ws || !brain || typeof ws.onMessage !== 'function' || typeof ws.send !== 'function') { setConcurrency(null); return; }
    const unsubscribe = ws.onMessage((msg) => {
      const reply = msg as { type?: string; commandId?: string; ok?: boolean; maxConcurrency?: number; fixedOverride?: boolean };
      if (reply.type !== TASK_PAIR_MAX_CONCURRENCY_RESULT || reply.commandId !== pendingConcurrencyCommandId.current) return;
      if (reply.ok && typeof reply.maxConcurrency === 'number') setConcurrency({ maxConcurrency: Math.min(TASK_PAIR_MAX_CONCURRENCY_CAP, Math.max(1, reply.maxConcurrency)), fixedOverride: !!reply.fixedOverride });
      else {
        const refreshId = `pair_concurrency_get_${crypto.randomUUID()}`;
        pendingConcurrencyCommandId.current = refreshId;
        ws.send({ type: DAEMON_COMMAND_TYPES.TASK_PAIR_GET_MAX_CONCURRENCY, commandId: refreshId, brain });
      }
    });
    const commandId = `pair_concurrency_get_${crypto.randomUUID()}`;
    pendingConcurrencyCommandId.current = commandId;
    ws.send({ type: DAEMON_COMMAND_TYPES.TASK_PAIR_GET_MAX_CONCURRENCY, commandId, brain });
    return () => { unsubscribe(); if (debounceTimer.current) window.clearTimeout(debounceTimer.current); };
  }, [ws, brain]);
  const adjustConcurrency = (requested: number) => {
    if (!ws || !brain || !concurrency || concurrency.fixedOverride) return;
    const next = Math.min(TASK_PAIR_MAX_CONCURRENCY_CAP, Math.max(1, Math.floor(requested)));
    setConcurrency({ ...concurrency, maxConcurrency: next });
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      const commandId = `pair_concurrency_set_${crypto.randomUUID()}`;
      pendingConcurrencyCommandId.current = commandId;
      ws.send({ type: DAEMON_COMMAND_TYPES.TASK_PAIR_SET_MAX_CONCURRENCY, commandId, brain, maxConcurrency: next });
    }, CONCURRENCY_DEBOUNCE_MS);
  };
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState('');
  const [expandedBriefs, setExpandedBriefs] = useState<ReadonlySet<string>>(() => new Set());
  const [loadedBriefs, setLoadedBriefs] = useState<Readonly<Record<string, string>>>(() => ({}));
  const [loadingBriefs, setLoadingBriefs] = useState<ReadonlySet<string>>(() => new Set());
  const [briefLoadErrors, setBriefLoadErrors] = useState<ReadonlySet<string>>(() => new Set());
  const toggleBrief = (taskId: string) => setExpandedBriefs((current) => { const next = new Set(current); if (next.has(taskId)) next.delete(taskId); else next.add(taskId); return next; });
  const openBrief = async (taskId: string, inlineBrief: string | undefined, updatedAt: number) => {
    if (expandedBriefs.has(taskId)) { toggleBrief(taskId); return; }
    if (inlineBrief !== undefined) { toggleBrief(taskId); return; }
    if (!serverId || !brain || loadingBriefs.has(taskId)) return;
    setLoadingBriefs((current) => new Set(current).add(taskId));
    setBriefLoadErrors((current) => { const next = new Set(current); next.delete(taskId); return next; });
    try {
      const history = await fetchTimelineHistoryHttp(serverId, brain, { afterTs: Math.max(0, updatedAt - 1), beforeTs: updatedAt + 1, limit: 500 });
      const matching = history?.events.find((event) => {
        const candidate = event as { type?: string; payload?: { taskId?: string; brief?: string } };
        return candidate.type === TASK_PAIR_TIMELINE_EVENT && candidate.payload?.taskId === taskId && typeof candidate.payload.brief === 'string';
      }) as { payload?: { brief?: string } } | undefined;
      if (typeof matching?.payload?.brief !== 'string') throw new Error('brief_missing');
      setLoadedBriefs((current) => ({ ...current, [taskId]: matching.payload!.brief! }));
      toggleBrief(taskId);
    } catch {
      setBriefLoadErrors((current) => new Set(current).add(taskId));
    } finally {
      setLoadingBriefs((current) => { const next = new Set(current); next.delete(taskId); return next; });
    }
  };
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
  const toggle = () => setCollapsed((value) => { const next = !value; try { window.localStorage.setItem(collapsedStorageKey(serverId), next ? '1' : '0'); } catch {} return next; });
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
    <div class="task-pair-status-header"><button type="button" class="task-pair-status-toggle" aria-expanded={!collapsed} onClick={toggle}>
      <strong>{t('taskPair.panel_title')}</strong>
      <span class="task-pair-status-summary">
        <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--working">{t('taskPair.panel_count_working', { count: counts.working })}</span>
        <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--in_audit">{t('taskPair.panel_count_audit', { count: counts.audit })}</span>
        <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--queued">{t('taskPair.panel_count_queued', { count: counts.queued })}</span>
      </span>
    </button>
    {concurrency && <div class="task-pair-status-concurrency" data-testid="task-pair-status-concurrency" title={concurrency.fixedOverride ? t('taskPair.panel_concurrency_fixed_tooltip') : t('taskPair.panel_concurrency_tooltip')}>
      <button type="button" aria-label={t('taskPair.panel_concurrency_decrease')} disabled={concurrency.fixedOverride || concurrency.maxConcurrency <= 1} onClick={() => adjustConcurrency(concurrency.maxConcurrency - 1)}>−</button>
      {editingConcurrency && !concurrency.fixedOverride ? <input aria-label={t('taskPair.panel_concurrency')} type="number" min="1" max={TASK_PAIR_MAX_CONCURRENCY_CAP} value={concurrencyInput} onInput={(event) => setConcurrencyInput((event.target as HTMLInputElement).value)} onChange={(event) => setConcurrencyInput((event.target as HTMLInputElement).value)} onBlur={(event) => { const value = Number((event.target as HTMLInputElement).value); if (Number.isFinite(value)) adjustConcurrency(value); setEditingConcurrency(false); }} onKeyDown={(event) => { if (event.key === 'Enter') { const value = Number((event.target as HTMLInputElement).value); if (Number.isFinite(value)) adjustConcurrency(value); setEditingConcurrency(false); } if (event.key === 'Escape') setEditingConcurrency(false); }} autoFocus /> : <button type="button" class="task-pair-status-concurrency-value" disabled={concurrency.fixedOverride} onClick={() => { setConcurrencyInput(String(concurrency.maxConcurrency)); setEditingConcurrency(true); }}>{t('taskPair.panel_concurrency', { max: concurrency.maxConcurrency })}</button>}
      <button type="button" aria-label={t('taskPair.panel_concurrency_increase')} disabled={concurrency.fixedOverride || concurrency.maxConcurrency >= TASK_PAIR_MAX_CONCURRENCY_CAP} onClick={() => adjustConcurrency(concurrency.maxConcurrency + 1)}>+</button>
      {concurrency.fixedOverride && <small class="task-pair-status-concurrency-fixed">{t('taskPair.panel_concurrency_fixed_note')}</small>}
    </div>}</div>
    {!collapsed && <div class="task-pair-status-rows">
      {groups.map((group) => {
        const heading = <h4>{t(`taskPair.panel_group_${group.key}`)} <small>({group.rows.length})</small></h4>;
        const content = group.rows.map((row, index) => { const payload = row.payload; const queued = group.key === 'queued'; const elapsedSeconds = Math.max(0, Math.floor((now - row.startedAt) / 1000)); const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title : t('taskPair.panel_untitled'); const taskStatus = String(payload.toStatus); const taskId = String(payload.taskId); const inlineBrief = typeof payload.brief === 'string' ? payload.brief : undefined; const brief = inlineBrief ?? loadedBriefs[taskId] ?? ''; const briefAvailable = payload.briefAvailable === true || inlineBrief !== undefined; const checklist = brief ? taskPairChecklistCounts(brief) : (payload.checklist as { total: number; implemented: number; audited: number } | undefined) ?? taskPairChecklistCounts(brief); const isExpanded = expandedBriefs.has(taskId); return <div class={`task-pair-status-row task-pair-chip--${taskStatus}`} data-status={taskStatus} key={taskId}>
          <div class="task-pair-status-row-head">
            <span class={`task-pair-status-badge task-pair-chip--${taskStatus}`}>
              <span class="task-pair-status-badge-dot" aria-hidden="true" />
              {taskStatus === 'rework' ? t('taskPair.status.rework_round', { round: payload.round ?? 1 }) : t(`taskPair.status.${taskStatus}`)}
            </span>
            {!queued && <span class="task-pair-status-round-badge">{t('taskPair.panel_round', { round: payload.round ?? 0 })}</span>}
            {!queued && <span class="task-pair-status-round-badge task-pair-status-blocking-badge">{t('taskPair.blocking', { levels: Array.isArray(payload.blocking) ? payload.blocking.join(',') : 'P0' })}</span>}
            {queued && payload.urgent === true && <span class="task-pair-status-urgent">!</span>}
          </div>
          <strong class="task-pair-status-row-title">{queued && <em>#{Number(payload.queuePosition ?? index + 1)} </em>}{title}</strong>
          <small class="task-pair-status-row-meta"><span class="task-pair-status-row-meta-icon" aria-hidden="true">⏱</span>{t('taskPair.panel_started', { time: new Date(row.startedAt).toLocaleTimeString() })} · {queued ? t('taskPair.panel_queued', { duration: formatElapsedDuration(elapsedSeconds, durationUnits) }) : t('taskPair.panel_elapsed', { duration: formatElapsedDuration(elapsedSeconds, durationUnits) })}</small>
          <div class="task-pair-status-row-roles">
            <span class="task-pair-role-chip"><span class={`task-pair-status-dot ${payload.executorState === 'running' ? 'is-running' : ''}`} />{session(payload.executor, payload.executorLabel, payload.executorModel, 'executor') ?? <small>{t('taskPair.panel_unassigned')}</small>}</span>
            {payload.auditor === 'none'
              ? <span class="task-pair-role-chip task-pair-role-chip--muted">{t('taskPair.panel_no_audit')}</span>
              : <span class="task-pair-role-chip"><span class={`task-pair-status-dot ${payload.auditorState === 'running' ? 'is-running' : ''}`} />{session(payload.auditor, payload.auditorLabel, payload.auditorModel, 'auditor') ?? <small>{t('taskPair.panel_unassigned')}</small>}</span>}
          </div>
          {briefAvailable && <div class="task-pair-status-brief-bar">{checklist.total > 0 && <span class="task-pair-status-checklist-progress">{t('taskPair.checklist_progress', checklist)}</span>}<button type="button" class="task-pair-status-brief-toggle" aria-expanded={isExpanded} disabled={loadingBriefs.has(taskId)} onClick={() => void openBrief(taskId, inlineBrief ?? loadedBriefs[taskId], row.updatedAt)}>{loadingBriefs.has(taskId) ? t('taskPair.panel_loading_brief') : t(isExpanded ? 'taskPair.panel_hide_brief' : 'taskPair.panel_show_brief')}</button>{briefLoadErrors.has(taskId) && <small role="status">{t('taskPair.panel_brief_load_failed')}</small>}</div>}
          {!!brief && isExpanded && <div class="task-pair-status-brief"><ChatMarkdown text={brief} />{checklist.total > 0 && <div class="task-pair-status-checklist">{parseTaskPairChecklist(brief).map((item) => <div class="task-pair-status-checklist-row" key={item.index}><input type="checkbox" checked={item.implemented} readOnly aria-label={t('taskPair.implemented')} /><input type="checkbox" checked={item.audited} readOnly aria-label={t('taskPair.audited')} /><span>{item.text}</span></div>)}</div>}</div>}
        </div>; });
        return group.key === 'recent'
          ? <details class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}><summary>{heading}</summary>{content}</details>
          : <section class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}>{heading}{content}</section>;
      })}
    </div>}
  </aside>;
}
