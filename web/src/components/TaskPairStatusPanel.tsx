import { isMobileLayout } from '../mobile-device.js';
import { bindTaskPairPanelFit } from '../task-pair-panel-fit.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent } from '../ws-client.js';
import { TASK_PAIR_TERMINAL_STATUSES, TASK_PAIR_TIMELINE_EVENT, TASK_PAIR_STATUSES, type TaskPairStatus } from '@shared/task-pair.js';
import { formatTaskDuration } from '../util/tool-duration.js';
import { watchProjectionStore } from '../watch-projection.js';
import { TaskPairBrief } from './TaskPairBrief.js';
import {
  cleanLegacyTaskPairPanelKeysOnce,
  isPhoneScreen,
  readServerWideChoice,
  resolveTaskPairPanelCollapsed,
  serverWideStorageKey,
  usesVisitScopedChoice,
  writeServerWideChoice,
} from '../task-pair-panel-state.js';

const MAX_ROWS = 6;

/** Kept for callers and tests: the server-wide flag's key (see task-pair-panel-state.ts). */
export const collapsedStorageKey = serverWideStorageKey;

function status(value: unknown): value is TaskPairStatus {
  return typeof value === 'string' && (TASK_PAIR_STATUSES as readonly string[]).includes(value);
}

type TaskPairConsoleSnapshotDetail = { tasks?: readonly Record<string, unknown>[]; assignments?: readonly Record<string, unknown>[] };

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

/**
 * Pair snapshots can cross.  Once a terminal row has been observed, an older
 * (or even newer but non-terminal) update must not resurrect it or restart its
 * elapsed timer.  An accepted incoming row REPLACES the previous one: it is the
 * daemon's whole row, so a field it no longer carries (a cleared
 * `waitingReason`, a `queuePosition` after the pair left the queue, a
 * participant state) must disappear - merging kept the old value forever.
 */
function mergeSnapshotRow(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) return incoming;
  if (isTerminalRow(previous) && !isTerminalRow(incoming)) return previous;
  if (snapshotTimestamp(incoming) < snapshotTimestamp(previous)) return previous;
  return incoming;
}

function mergeSnapshotRows(
  previous: readonly Record<string, unknown>[] | null,
  incoming: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  if (!previous) return incoming;
  const previousByTask = new Map(previous.map((row) => [String(row.taskId), row]));
  return incoming.map((row) => mergeSnapshotRow(previousByTask.get(String(row.taskId)), row));
}

function normalizeSnapshot(detail: TaskPairConsoleSnapshotDetail): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(detail.tasks)) return null;
  const byTask = new Map<string, Record<string, unknown>[]>();
  for (const assignment of detail.assignments ?? []) { const id = typeof assignment.taskId === 'string' ? assignment.taskId : ''; if (id) byTask.set(id, [...(byTask.get(id) ?? []), assignment]); }
  return detail.tasks.map((task) => {
    const pair = (task.pair ?? {}) as Record<string, unknown>; const roles = byTask.get(String(task.taskId)) ?? [];
    const executor = roles.find((role) => role.role === 'implementer'); const auditor = roles.find((role) => role.role === 'auditor');
    const toStatus = pair.status ?? task.status;
    const startedAt = finiteTimestamp(pair.startedAt ?? pair.createdAt);
    const updatedAt = finiteTimestamp(pair.updatedAt ?? task.updatedAt, startedAt);
    const endedAt = TASK_PAIR_TERMINAL_STATUSES.includes(toStatus as TaskPairStatus)
      ? finiteTimestamp(pair.endedAt ?? task.updatedAt, updatedAt)
      : undefined;
    return {
      ...pair,
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

type SessionLabelEntry = { name: string; label?: string | null; activeModel?: string | null; requestedModel?: string | null; effort?: string | null };

function hasPairActivity(events: readonly TimelineEvent[]): boolean {
  if (events.some((event) => event.type === TASK_PAIR_TIMELINE_EVENT)) return true;
  const snapshot = (window as Window & { __imcodesTaskPairSnapshot?: { tasks?: readonly unknown[]; authorityUnavailable?: boolean } }).__imcodesTaskPairSnapshot;
  return Boolean(snapshot?.authorityUnavailable) || (Array.isArray(snapshot?.tasks) && snapshot.tasks.length > 0);
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

function resolveSessionThinking(
  id: string,
  payloadThinking: unknown,
  sessions: readonly SessionLabelEntry[] | undefined,
): string | undefined {
  if (typeof payloadThinking === 'string' && payloadThinking.trim()) return payloadThinking.trim();
  const session = sessions?.find((entry) => entry.name === id);
  return session?.effort?.trim() || undefined;
}

export function TaskPairStatusPanel({ events, sessions, serverId, scopeSessionId }: { events: readonly TimelineEvent[]; sessions?: readonly SessionLabelEntry[]; serverId?: string | null; scopeSessionId?: string | null }) {
  const { t } = useTranslation();
  const [isMobile, setIsMobile] = useState(isMobileLayout);
  // A phone sub-session shows its panel CLOSED every time it is opened and keeps the user's own choice in this component's memory only
  // (it lives while the view stays mounted, through resizes, and is gone when the user leaves): nothing is stored. The main chat and
  // the desktop keep the stored server-wide flag. See task-pair-panel-state.ts.
  const phoneNow = () => isPhoneScreen({ mobile: isMobileLayout(), screenWidth: window.screen?.width, screenHeight: window.screen?.height, innerWidth: window.innerWidth });
  const [phone, setPhone] = useState(phoneNow);
  const visitScoped = usesVisitScopedChoice({ phone, scopeSessionId });
  const [choice, setChoice] = useState<boolean | undefined>(() => (usesVisitScopedChoice({ phone: phoneNow(), scopeSessionId }) ? undefined : readServerWideChoice({ serverId, mobile: isMobileLayout() })));
  cleanLegacyTaskPairPanelKeysOnce();
  // The mobile panel is measured against the visible chat area; when too little
  // room is left (landscape phone, keyboard open) the collapsed strip is shown
  // instead, without touching the user's choice.
  const [cramped, setCramped] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const persistCollapsed = useCallback((next: boolean) => {
    setChoice(next);
    if (!visitScoped) writeServerWideChoice({ serverId, mobile: isMobile, collapsed: next });
  }, [serverId, isMobile, visitScoped]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!isMobile || !panel) { setCramped(false); return undefined; }
    return bindTaskPairPanelFit(panel, setCramped);
  }, [isMobile]);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 720px)');
    if (!media) return undefined;
    // Only the layout class is tracked here; the choice is re-read by the effect below when the layout (or the panel's scope) changes.
    const onChange = () => { setIsMobile(isMobileLayout()); setPhone(phoneNow()); };
    media.addEventListener?.('change', onChange);
    window.addEventListener('resize', onChange);
    return () => { media.removeEventListener?.('change', onChange); window.removeEventListener('resize', onChange); };
  }, []);
  // The choice is re-resolved only when what it belongs to changes: another server or sub-session, or the layout class. A phone
  // sub-session starts closed again for a different session; a resize within the same view never reaches this.
  const scopeKey = `${serverId ?? ''}|${scopeSessionId ?? ''}|${isMobile ? 'm' : 'd'}|${visitScoped ? 'v' : 's'}`;
  const lastScopeKey = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeKey.current === scopeKey) return;
    lastScopeKey.current = scopeKey;
    setChoice(visitScoped ? undefined : readServerWideChoice({ serverId, mobile: isMobile }));
  }, [scopeKey, serverId, isMobile, visitScoped]);
  const [snapshotRows, setSnapshotRows] = useState<readonly Record<string, unknown>[] | null>(() => {
    const detail = (window as Window & { __imcodesTaskPairSnapshot?: { tasks?: readonly Record<string, unknown>[]; assignments?: readonly Record<string, unknown>[] } }).__imcodesTaskPairSnapshot;
    return detail ? normalizeSnapshot(detail) : null;
  });
  useEffect(() => {
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent).detail as { tasks?: readonly Record<string, unknown>[]; assignments?: readonly Record<string, unknown>[]; scopeReset?: boolean } | undefined;
      if (!detail) return;
      if (detail.scopeReset) {
        (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = undefined;
        setSnapshotRows(null);
        return;
      }
      if (Array.isArray(detail.tasks)) {
        const normalized = normalizeSnapshot(detail);
        if (normalized) setSnapshotRows((current) => mergeSnapshotRows(current, normalized));
      }
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
  if (snapshotRows) for (const payload of snapshotRows) if (typeof payload.taskId === 'string') latest.set(payload.taskId, { payload, startedAt: Number(payload.startedAt), updatedAt: Number(payload.updatedAt) });
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
  const allRows = [...latest.values()].filter((row) => {
    if (!status(row.payload.toStatus)) return false;
    if (!scopeSessionId) return true;
    return String(row.payload.executor ?? '') === scopeSessionId || String(row.payload.auditor ?? '') === scopeSessionId;
  });
  const groupFor = (value: TaskPairStatus) => value === 'queued' ? 'queued' : value === 'awaiting_brain_decision' ? 'awaiting_brain_decision' : value === 'rework' ? 'rework' : value === 'in_audit' || value === 'awaiting_audit' ? 'audit' : value === 'done' || value === 'cancelled' || value === 'passed' ? 'recent' : 'working';
  const groups = (['working', 'audit', 'rework', 'queued', 'awaiting_brain_decision', 'recent'] as const).map((key) => {
    const rows = allRows.filter((row) => groupFor(row.payload.toStatus as TaskPairStatus) === key);
    if (key === 'queued') rows.sort((a, b) => Number(a.payload.queuePosition ?? Number.MAX_SAFE_INTEGER) - Number(b.payload.queuePosition ?? Number.MAX_SAFE_INTEGER));
    return { key, rows: key === 'recent' ? rows.slice(-MAX_ROWS) : rows };
  }).filter((group) => group.rows.length > 0);
  const scopedDefaultTaskId = scopeSessionId
    ? (allRows.find((row) => ['working', 'in_audit', 'awaiting_audit', 'rework'].includes(String(row.payload.toStatus)))?.payload.taskId ?? allRows[0]?.payload.taskId)
    : undefined;
  const counts = allRows.reduce<{ working: number; audit: number; queued: number; awaitingBrain: number }>((result, row) => {
    const value = row.payload.toStatus;
    if (value === 'working' || value === 'rework') result.working += 1;
    else if (value === 'in_audit' || value === 'awaiting_audit') result.audit += 1;
    else if (value === 'awaiting_brain_decision') result.awaitingBrain += 1;
    else if (value === 'queued') result.queued += 1;
    return result;
  }, { working: 0, audit: 0, queued: 0, awaitingBrain: 0 });
  if (latest.size === 0 || allRows.length === 0) return null;
  // What is shown: the user's own choice if there is one, else the default (a phone sub-session: closed); too little room on a phone
  // shows the strip without touching the choice.
  const collapsed = resolveTaskPairPanelCollapsed({ choice, mobile: isMobile, phone, scopeSessionId }) || (isMobile && cramped);
  const toggle = () => persistCollapsed(!collapsed);
  const toggleWithKeyboard = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  };
  const projectionSessions = watchProjectionStore.getSnapshot().sessions;
  const session = (id: unknown, label: unknown, model: unknown, thinking: unknown, role: 'executor' | 'auditor') => {
    // 'none' is a real, deliberate value (auditor=none): there is no session
    // to open, so it must not render as a dangling clickable placeholder.
    if (typeof id !== 'string' || !id || id === 'none') return null;
    const text = resolveSessionLabel(id, label, sessions, projectionSessions) || t(`taskPair.panel_${role}`);
    const resolvedModel = resolveSessionModel(id, model, sessions, projectionSessions);
    const resolvedThinking = resolveSessionThinking(id, thinking, sessions);
    return <button type="button" class="task-pair-status-session" data-session-name={id} onClick={() => window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session: id } }))}>
      <span class="task-pair-status-session-main"><span class="task-pair-status-session-label">{text}</span>{resolvedModel && <span class="task-pair-status-session-model">{t('taskPair.panel_model_separator')}{resolvedModel}</span>}{resolvedModel && <span aria-hidden="true" style={{ display: 'none' }}>{text}{t('taskPair.panel_model_separator')}{resolvedModel}</span>}</span>
      <span class="task-pair-status-session-thinking">{t('taskPair.card_thinking', { value: resolvedThinking ?? t('taskPair.card_thinking_unknown') })}</span>
    </button>;
  };
  const unassigned = (model: unknown, thinking: unknown) => <small>{t('taskPair.panel_unassigned')}{typeof model === 'string' && model.trim() ? `${t('taskPair.panel_model_separator')}${model.trim()}` : ''}{t('taskPair.card_thinking', { value: typeof thinking === 'string' && thinking.trim() ? thinking.trim() : t('taskPair.card_thinking_unknown') })}</small>;
  const durationUnits = {
    hour: t('taskPair.panel_duration_hour'),
    day: t('taskPair.panel_duration_day'),
    minute: t('taskPair.panel_duration_minute'),
    second: t('taskPair.panel_duration_second'),
    separator: t('taskPair.panel_duration_separator'),
  };
  const toggleLabel = `${t(collapsed ? 'taskPair.panel_expand' : 'taskPair.panel_collapse')} — ${t('taskPair.panel_title')}`;
  const toggleContent = collapsed ? <span class={`task-pair-status-icons${isMobile ? ' task-pair-status-mobile-content' : ''}`} role="group" aria-label={t('taskPair.panel_title')}>
    {isMobile && <span class="task-pair-status-mobile-label">{t('taskPair.panel_title')}</span>}
    <span class={`task-pair-status-icon task-pair-status-icon--working${counts.working === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_working')} aria-label={t('taskPair.panel_icon_working')}><span aria-hidden="true">▶</span><b>{counts.working}</b></span>
    <span class={`task-pair-status-icon task-pair-status-icon--audit${counts.audit === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_audit')} aria-label={t('taskPair.panel_icon_audit')}><span aria-hidden="true">◉</span><b>{counts.audit}</b></span>
    <span class={`task-pair-status-icon task-pair-status-icon--queued${counts.queued === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_queued')} aria-label={t('taskPair.panel_icon_queued')}><span aria-hidden="true">⏳</span><b>{counts.queued}</b></span>
    <span class={`task-pair-status-icon task-pair-status-icon--awaiting${counts.awaitingBrain === 0 ? ' is-zero' : ' is-highlighted'}`} title={t('taskPair.panel_icon_awaiting_brain')} aria-label={t('taskPair.panel_icon_awaiting_brain')}><span aria-hidden="true">🧠</span><b>{counts.awaitingBrain}</b></span>
    {!isMobile && <span class="task-pair-status-collapse-icon" aria-hidden="true">⌄</span>}
  </span> : <><strong>{t('taskPair.panel_title')}</strong>
    <span class="task-pair-status-summary">
      <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--working">{t('taskPair.panel_count_working', { count: counts.working })}</span>
      <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--in_audit">{t('taskPair.panel_count_audit', { count: counts.audit })}</span>
      <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--queued">{t('taskPair.panel_count_queued', { count: counts.queued })}</span>
      <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--awaiting_brain_decision">{t('taskPair.status.awaiting_brain_decision')} ({counts.awaitingBrain})</span>
    </span><span class="task-pair-status-collapse-icon" aria-hidden="true">⌃</span></>;
  return <aside ref={panelRef} class={`task-pair-status-panel${collapsed ? ' is-collapsed' : ''}${isMobile ? ' is-mobile' : ' is-desktop'}`} data-testid="task-pair-status-panel">
    {isMobile && collapsed ? <div class="task-pair-status-toggle task-pair-status-compact" role="button" tabIndex={0} aria-expanded={false} aria-label={toggleLabel} title={t('taskPair.panel_expand')} onClick={toggle} onKeyDown={toggleWithKeyboard}>
      {toggleContent}
    </div> : <button type="button" class="task-pair-status-toggle" aria-expanded={!collapsed} aria-label={toggleLabel} title={t(collapsed ? 'taskPair.panel_expand' : 'taskPair.panel_collapse')} onClick={toggle}>
      {toggleContent}
    </button>}
    {!collapsed && <div class="task-pair-status-rows" data-testid="task-pair-status-rows">
      {(() => { let sequence = 0; return groups.map((group) => {
        const heading = <h4>{group.key === 'awaiting_brain_decision' ? t('taskPair.status.awaiting_brain_decision') : t(`taskPair.panel_group_${group.key}`)} <small>({group.rows.length})</small></h4>;
        const content = group.rows.map((row, index) => { const payload = row.payload; const sequenceNumber = ++sequence; const queued = group.key === 'queued'; const terminal = TASK_PAIR_TERMINAL_STATUSES.includes(payload.toStatus as TaskPairStatus); const duration = formatTaskDuration({ startedAt: row.startedAt, finishedAt: payload.finishedAt, endedAt: payload.endedAt, updatedAt: row.updatedAt, now, durationMs: payload.durationMs, terminal }, durationUnits); const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title : t('taskPair.panel_untitled'); const taskStatus = String(payload.toStatus); const reworkCount = Math.max(1, reworkCounts.get(String(payload.taskId)) ?? 0); const auditRound = Number(payload.round ?? 0); const deliveryRound = Math.max(1, Number(payload.deliveryRound ?? 1)); return <div class={`task-pair-status-row task-pair-chip--${taskStatus}`} data-status={taskStatus} key={String(payload.taskId)}>
          <span class="task-pair-status-sequence" aria-label={`#${sequenceNumber}`}>{sequenceNumber}</span>
          <div class="task-pair-status-row-head">
            <span class={`task-pair-status-badge task-pair-chip--${taskStatus}`}>
              <span class="task-pair-status-badge-dot" aria-hidden="true" />
              {taskStatus === 'rework' ? t('taskPair.panel_rework_count', { count: reworkCount }) : taskStatus === 'working' && deliveryRound > 1 ? t('taskPair.panel_round_in_progress', { round: deliveryRound }) : t(`taskPair.status.${taskStatus}`)}
            </span>
            {!queued && auditRound > 0 && <span class="task-pair-status-round-badge">{deliveryRound > 1 ? t('taskPair.panel_round_of', { delivery: deliveryRound, audit: auditRound }) : t('taskPair.panel_round', { round: auditRound })}</span>}
            {!queued && <span class="task-pair-status-round-badge task-pair-status-blocking-badge">{t('taskPair.blocking', { levels: Array.isArray(payload.blocking) ? payload.blocking.join(',') : 'P0' })}</span>}
            {queued && payload.urgent === true && <span class="task-pair-status-urgent">!</span>}
          </div>
          <strong class="task-pair-status-row-title">{queued && <em>#{Number(payload.queuePosition ?? index + 1)} </em>}{title}</strong>
          <TaskPairBrief brief={typeof payload.brief === 'string' ? payload.brief : undefined} briefRevision={typeof payload.briefRevision === 'string' ? payload.briefRevision : undefined} checklist={payload.checklist as { total: number; implemented: number; audited: number } | undefined} taskId={String(payload.taskId)} defaultOpen={String(payload.taskId) === String(scopedDefaultTaskId)} />
          {duration !== undefined && <small class="task-pair-status-row-meta"><span class="task-pair-status-row-meta-icon" aria-hidden="true">⏱</span>{Number.isFinite(row.startedAt) && <>{t('taskPair.panel_started', { time: new Date(row.startedAt).toLocaleTimeString() })} · </>}{queued ? t('taskPair.panel_queued', { duration }) : t('taskPair.panel_elapsed', { duration })}</small>}
          <div class="task-pair-status-row-roles">
            <span class="task-pair-role-chip"><span class={`task-pair-status-dot ${payload.executorState === 'running' ? 'is-running' : ''}`} />{session(payload.executor, payload.executorLabel, payload.executorModel, payload.executorThinking, 'executor') ?? unassigned(payload.executorModel, payload.executorThinking)}</span>
            {payload.auditor === 'none'
              ? <span class="task-pair-role-chip task-pair-role-chip--muted">{t('taskPair.panel_no_audit')}</span>
              : <span class="task-pair-role-chip"><span class={`task-pair-status-dot ${payload.auditorState === 'running' ? 'is-running' : ''}`} />{session(payload.auditor, payload.auditorLabel, payload.auditorModel, payload.auditorThinking, 'auditor') ?? unassigned(payload.auditorModel, payload.auditorThinking)}</span>}
          </div>
        </div>; });
        return group.key === 'recent'
          ? <details class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}><summary>{heading}</summary>{content}</details>
          : <section class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}>{heading}{content}</section>;
      }); })()}
    </div>}
  </aside>;
}

/** Avoid mounting responsive panel effects in ordinary chats until pair data exists. */
export function TaskPairStatusPanelHost(props: { events: readonly TimelineEvent[]; sessions?: readonly SessionLabelEntry[]; serverId?: string | null; scopeSessionId?: string | null; mobileAnchor?: Element | null; mobileAnchorRef?: { current: Element | null } }) {
  const initialSnapshot = (window as Window & { __imcodesTaskPairSnapshot?: { authorityUnavailable?: boolean } }).__imcodesTaskPairSnapshot;
  const [active, setActive] = useState(() => hasPairActivity(props.events));
  const [authorityUnavailable, setAuthorityUnavailable] = useState(() => Boolean(initialSnapshot?.authorityUnavailable));
  const [resolvedMobileAnchor, setResolvedMobileAnchor] = useState<Element | null>(() => props.mobileAnchor ?? props.mobileAnchorRef?.current ?? null);
  useLayoutEffect(() => {
    const anchor = props.mobileAnchor ?? props.mobileAnchorRef?.current ?? null;
    if (anchor !== resolvedMobileAnchor) setResolvedMobileAnchor(anchor);
  }, [active, props.mobileAnchor, props.mobileAnchorRef, resolvedMobileAnchor]);
  useEffect(() => {
    if (!active && hasPairActivity(props.events)) {
      setActive(true);
    }
  }, [active, props.events]);
  useEffect(() => {
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent).detail as { tasks?: readonly unknown[]; scopeReset?: boolean; authorityUnavailable?: boolean; op?: string; task?: unknown } | undefined;
      if (detail?.scopeReset) {
        setActive(true);
        setAuthorityUnavailable(true);
        return;
      }
      if ((Array.isArray(detail?.tasks) && detail.tasks.length > 0) || detail?.op === 'task_upsert' || detail?.task) {
        if (Array.isArray(detail?.tasks)) (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = detail;
        setActive(true);
      }
      if (detail && 'authorityUnavailable' in detail) {
        setAuthorityUnavailable(Boolean(detail.authorityUnavailable));
        setActive(true);
      } else if (detail && Array.isArray(detail.tasks)) {
        setAuthorityUnavailable(false);
      }
    };
    window.addEventListener('supervision:task-pairs', onSnapshot);
    return () => window.removeEventListener('supervision:task-pairs', onSnapshot);
  }, []);
  if (!active) return null;
  // Owner rule: load silently, never cover the chat. While the authoritative
  // snapshot for a new scope is pending (or unavailable), render nothing: stale
  // rows from the previous scope must not show, and no full-size placeholder
  // box may cover the conversation. The panel reappears with fresh data.
  if (authorityUnavailable) return null;
  const { mobileAnchor, mobileAnchorRef, ...panelProps } = props;
  const panel = <TaskPairStatusPanel {...panelProps} />;
  // The titlebar is the only safe host: keeping the panel in normal flow makes
  // both mobile and desktop controls reserve space instead of being covered by
  // a chat-main overlay. Expanded rows still open below the titlebar.
  return resolvedMobileAnchor ? createPortal(panel, resolvedMobileAnchor) : panel;
}
