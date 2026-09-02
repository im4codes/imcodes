import type { ComponentChildren, RefObject } from 'preact';
import { useMemo, useRef, useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  SUPERVISION_CONSOLE_TABS,
  supervisionConsoleStatusGroup,
  supervisionConsoleTabForTask,
  type SupervisionConsoleTab,
  type SupervisionConsoleSessionState,
  type SupervisionTaskConsoleAssignmentRow,
  type SupervisionTaskConsoleTaskRow,
  supervisionConsoleCardActivity,
} from '@shared/supervision-task-console.js';
import { isSupervisionTaskLifecycleStatus } from '@shared/supervision-config.js';
import type { WsClient } from '../ws-client.js';
import { useSupervisionTaskConsole } from '../hooks/useSupervisionTaskConsole.js';
import {
  loadSupervisionTaskConsolePreferences,
  saveSupervisionTaskConsolePreferences,
  type SupervisionTaskConsoleWidthBounds,
} from '../supervision-task-console-preferences.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  type SupervisionTaskConsoleEventEvidence,
  type SupervisionTaskConsoleReducerState,
} from '../supervision-task-console-reducer.js';
import {
  canViewSupervisionTaskConsole,
  type SupervisionTaskConsoleVisibilityInput,
} from '../supervision-task-console-visibility.js';

const DESKTOP_MIN_WIDTH = 720;
const DESKTOP_DEFAULT_WIDTH = 720;
const DESKTOP_MAX_WIDTH = 1440;
const DESKTOP_VIEWPORT_CAP = 0.92;
const HISTORY_PAGE_SIZE = 10;
const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function supervisionConsoleMaxWidth(viewportWidth: number): number {
  return Math.max(320, Math.min(DESKTOP_MAX_WIDTH, Math.floor(viewportWidth * DESKTOP_VIEWPORT_CAP)));
}

export function supervisionTaskConsolePreferenceBounds(
  viewportWidth = Number.POSITIVE_INFINITY,
): SupervisionTaskConsoleWidthBounds {
  const maxWidth = supervisionConsoleMaxWidth(viewportWidth);
  return {
    minWidth: Math.min(DESKTOP_MIN_WIDTH, maxWidth),
    maxWidth,
    defaultWidth: Math.min(DESKTOP_DEFAULT_WIDTH, maxWidth),
  };
}

export function clampSupervisionConsoleWidth(next: number, viewportWidth: number): number {
  const bounds = supervisionTaskConsolePreferenceBounds(viewportWidth);
  return Math.max(bounds.minWidth, Math.min(bounds.maxWidth, Math.round(next)));
}

export function SupervisionTaskConsoleToggle(props: {
  visibility: SupervisionTaskConsoleVisibilityInput;
  open: boolean;
  onToggle: () => void;
  triggerRef?: RefObject<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  if (!canViewSupervisionTaskConsole(props.visibility)) return null;
  return (
    <button
      type="button"
      ref={props.triggerRef}
      class={`view-toggle supervision-task-console-toggle${props.open ? ' is-active' : ''}`}
      aria-pressed={props.open}
      aria-label={t('supervision_task_console.toggle')}
      title={t('supervision_task_console.toggle')}
      onClick={props.onToggle}
    >
      <span aria-hidden="true">▥</span>
    </button>
  );
}

function displayStatusKey(status: unknown): string {
  return isSupervisionTaskLifecycleStatus(status)
    ? `supervision_task_console.status.${status}`
    : 'supervision_task_console.unsupported';
}

function safeTimestamp(timestamp: number | undefined, language: string): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '—';
  try {
    return new Intl.DateTimeFormat(language, {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return '—';
  }
}

function valueOrDash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function Field(props: { label: string; value: string | number | null | undefined }) {
  return <div class="supervision-task-console-field"><dt>{props.label}</dt><dd>{valueOrDash(props.value)}</dd></div>;
}

function isAuditAssignment(assignment: SupervisionTaskConsoleAssignmentRow): boolean {
  return assignment.role === 'auditor';
}

function isImplementerAssignment(assignment: SupervisionTaskConsoleAssignmentRow): boolean {
  return assignment.role === 'implementer';
}

function taskRoleAssignments(
  assignments: readonly SupervisionTaskConsoleAssignmentRow[],
): SupervisionTaskConsoleAssignmentRow[] {
  return assignments.filter((assignment) => (
    isImplementerAssignment(assignment) || isAuditAssignment(assignment)
  ));
}

function stateRank(state: SupervisionConsoleSessionState | undefined): number {
  switch (state) {
    case 'needs_input': return 0;
    case 'running': return 1;
    case 'idle': return 4;
    case 'offline': return 6;
    default: return 5;
  }
}

function taskPriority(
  task: SupervisionTaskConsoleTaskRow,
  assignments: readonly SupervisionTaskConsoleAssignmentRow[],
): number {
  const roleAssignments = taskRoleAssignments(assignments);
  const tab = supervisionConsoleTabForTask(task, assignments);
  if (task.status === 'blocked' || task.blocker) return 0;
  if (tab !== 'active') {
    const group = supervisionConsoleStatusGroup(task.status);
    return group === 'audit' || group === 'rework' || group === 'integration' ? 3 : 5;
  }
  if (roleAssignments.some((assignment) => assignment.sessionState === 'needs_input')) return 0;
  if (roleAssignments.some((assignment) => isImplementerAssignment(assignment) && assignment.sessionState === 'running')) return 1;
  if (roleAssignments.some((assignment) => isAuditAssignment(assignment) && assignment.sessionState === 'running')) return 2;
  const group = supervisionConsoleStatusGroup(task.status);
  if (group === 'audit' || group === 'rework' || group === 'integration') return 3;
  const bestSession = roleAssignments.reduce((best, assignment) => Math.min(best, stateRank(assignment.sessionState)), 9);
  if (bestSession === 4) return 4;
  return 5;
}

function authoritativeActivityAt(
  task: SupervisionTaskConsoleTaskRow,
  assignments: readonly SupervisionTaskConsoleAssignmentRow[],
): number {
  if (supervisionConsoleTabForTask(task, assignments) !== 'active') return task.updatedAt;
  const roleAssignments = taskRoleAssignments(assignments);
  if (roleAssignments.length === 0) return task.updatedAt;
  return Math.max(...roleAssignments.map((assignment) => (
    assignment.sessionStateObservedAt ?? assignment.updatedAt
  )));
}

/** Stable product sort: authority state first, authoritative activity time second. */
export function sortSupervisionConsoleTasks(
  tasks: readonly SupervisionTaskConsoleTaskRow[],
  assignmentsByTask: ReadonlyMap<string, readonly SupervisionTaskConsoleAssignmentRow[]>,
): SupervisionTaskConsoleTaskRow[] {
  return [...tasks].sort((left, right) => {
    const leftAssignments = assignmentsByTask.get(left.taskId) ?? [];
    const rightAssignments = assignmentsByTask.get(right.taskId) ?? [];
    const priority = taskPriority(left, leftAssignments) - taskPriority(right, rightAssignments);
    return priority
      || authoritativeActivityAt(right, rightAssignments) - authoritativeActivityAt(left, leftAssignments)
      || left.taskId.localeCompare(right.taskId);
  });
}

function SessionButton(props: {
  assignment: SupervisionTaskConsoleAssignmentRow;
  taskStatus: SupervisionTaskConsoleTaskRow['status'];
  taskTab: SupervisionConsoleTab;
  lane: 'implementer' | 'auditor';
  onNavigateSession: (sessionName: string) => void;
}) {
  const { t } = useTranslation();
  const { assignment } = props;
  const name = assignment.ownerSessionName;
  const state = assignment.sessionState ?? 'unknown';
  // Four separate facts, never folded together:
  //  1. task lifecycle  -> rendered by the card's status pill
  //  2. assignment work state -> assignment.status, shown here in its own right
  //  3. execution health -> server-derived; the browser must not infer liveness
  //  4. external CI wait -> its own flag
  // Previously this slot printed the TASK status whenever the tab was not
  // active, which made a terminal assignment under a live task indistinguishable
  // from a running one.
  const showRuntimeState = props.taskTab === 'active';
  const workStateLabel = t(displayStatusKey(assignment.status));
  const healthLabel = t(`supervision_task_console.execution_health.${assignment.executionHealth ?? 'unknown'}`);
  const stateLabel = showRuntimeState
    ? t(`supervision_task_console.session_state.${state}`)
    : workStateLabel;
  if (!name) return null;
  return (
    <button
      type="button"
      class={`supervision-task-console-session ${showRuntimeState ? `session-${state}` : `task-${props.taskTab}`} lane-${props.lane}`}
      data-session-state={showRuntimeState ? state : undefined}
      data-task-tab={props.taskTab}
      aria-label={`${t(`supervision_task_console.${props.lane}`)}: ${assignment.ownerSessionLabel || name}, ${stateLabel}`}
      onClick={(event) => { event.stopPropagation(); props.onNavigateSession(name); }}
    >
      <span class="supervision-task-console-session-icon" aria-hidden="true" />
      <span class="supervision-task-console-session-copy">
        <strong>{assignment.ownerSessionLabel || name}</strong>
        {assignment.ownerSessionLabel && <small>{name}</small>}
        <small>{assignment.observedProvider || assignment.ownerAgentType || '—'} · {assignment.observedModel || '—'}</small>
        {props.lane === 'auditor' && (assignment.auditAttemptId || assignment.auditVerdict) && <small>{assignment.auditAttemptId || '—'} · {assignment.auditVerdict || '—'}</small>}
      </span>
      <span class="supervision-task-console-session-state">{stateLabel}{showRuntimeState ? ` · ${assignment.sessionStateSource ?? 'registry'}` : ''}</span>
      <span
        class={`supervision-task-console-session-health health-${assignment.executionHealth ?? 'unknown'}`}
        data-execution-health={assignment.executionHealth ?? 'unknown'}
      >{t('supervision_task_console.work_state')}: {workStateLabel} · {healthLabel}</span>
      {assignment.awaitingExternalCi === true && (
        <span class="supervision-task-console-session-ci" data-awaiting-external-ci="true">
          {t('supervision_task_console.awaiting_external_ci')}
        </span>
      )}
    </button>
  );
}

function TaskCard(props: {
  task: SupervisionTaskConsoleTaskRow;
  assignments: readonly SupervisionTaskConsoleAssignmentRow[];
  events: readonly SupervisionTaskConsoleEventEvidence[];
  expanded: boolean;
  onToggle: () => void;
  onNavigateSession: (sessionName: string) => void;
  language: string;
}) {
  const { t } = useTranslation();
  const implementer = props.assignments.find(isImplementerAssignment);
  const auditor = props.assignments.find(isAuditAssignment);
  const taskTab = supervisionConsoleTabForTask(props.task, props.assignments);
  // Derived by the shared canonical function, not locally: the browser renders
  // truth, it does not compute it. Blocker prose no longer masquerades as the
  // blocked status, and two assignments are no longer blended into one value.
  const dominantState = supervisionConsoleCardActivity({
    tab: taskTab,
    taskStatus: props.task.status,
    blocker: props.task.blocker,
    assignments: props.assignments,
  });
  const activityAt = authoritativeActivityAt(props.task, props.assignments);
  const activityAssignment = taskTab === 'active'
    ? taskRoleAssignments(props.assignments).sort((left, right) =>
      (right.sessionStateObservedAt ?? right.updatedAt) - (left.sessionStateObservedAt ?? left.updatedAt))[0]
    : undefined;
  const activitySource = activityAssignment?.sessionStateSource ?? 'registry';
  const progress = props.task.progress && props.task.progress.total > 0
    ? Math.min(100, Math.max(0, (props.task.progress.completed / props.task.progress.total) * 100))
    : null;
  return (
    <article
      class={`supervision-task-console-task activity-${dominantState}`}
      data-status={props.task.status}
      data-activity-state={dominantState}
      data-event-id={props.task.lastEventId}
      data-testid={`task-card-${props.task.taskId}`}
    >
      <span key={props.task.lastEventId} class="supervision-task-console-transition" aria-hidden="true" />
      <div class="supervision-task-console-task-head">
        <button
          type="button"
          class="supervision-task-console-task-summary"
          aria-expanded={props.expanded}
          aria-controls={`task-console-details-${props.task.taskId}`}
          onClick={props.onToggle}
        >
          <span class="supervision-task-console-task-title"><strong>{props.task.title}</strong></span>
          <span class={`supervision-task-console-status status-${props.task.status}`}>{t(displayStatusKey(props.task.status))}</span>
          <span aria-hidden="true" class="supervision-task-console-chevron">{props.expanded ? '⌃' : '⌄'}</span>
        </button>
        <div class="supervision-task-console-role-tracks">
          {implementer && <SessionButton assignment={implementer} taskStatus={props.task.status} taskTab={taskTab} lane="implementer" onNavigateSession={props.onNavigateSession} />}
          {auditor && <SessionButton assignment={auditor} taskStatus={props.task.status} taskTab={taskTab} lane="auditor" onNavigateSession={props.onNavigateSession} />}
        </div>
      </div>
      <div class={`supervision-task-console-stage-track phase-${props.task.phase}`} aria-label={t(displayStatusKey(props.task.status))}>
        <span /><span /><span /><span />
      </div>
      {progress !== null && props.task.progress && (
        <div class="supervision-task-console-progress" aria-label={t('supervision_task_console.progress', { ...props.task.progress })}>
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      <div class="supervision-task-console-task-meta">
        {props.task.blocker && <span class="is-blocker">{props.task.blocker}</span>}
        {props.task.currentAction && <span>{t('supervision_task_console.current_action')}: {props.task.currentAction}</span>}
        {props.task.nextAction && <span>{t('supervision_task_console.next_action')}: {props.task.nextAction}</span>}
        <span>{t('supervision_task_console.recent_activity')}: {safeTimestamp(activityAt, props.language)} · {activitySource}</span>
      </div>
      {props.expanded && (
        <div id={`task-console-details-${props.task.taskId}`} class="supervision-task-console-task-details">
          <dl class="supervision-task-console-fields">
            <div class="supervision-task-console-field">
              <dt>{t('supervision_task_console.task_id')}</dt>
              <dd><button type="button" class="supervision-task-console-copy-id" onClick={() => { void navigator.clipboard?.writeText(props.task.taskId); }}>{props.task.taskId}<span>{t('supervision_task_console.copy_task_id')}</span></button></dd>
            </div>
            <Field label={t('supervision_task_console.top_level_task')} value={props.task.topLevelTaskId} />
            <Field label={t('supervision_task_console.current_action')} value={props.task.currentAction} />
            <Field label={t('supervision_task_console.next_action')} value={props.task.nextAction} />
            <Field label={t('supervision_task_console.validation')} value={t(`supervision_task_console.validation_state.${props.task.validationState}`)} />
            <Field label={t('supervision_task_console.audit_attempt')} value={props.task.auditAttemptId || auditor?.auditAttemptId} />
            <Field label={t('supervision_task_console.audit_verdict')} value={props.task.auditVerdict || auditor?.auditVerdict} />
            <Field label={t('supervision_task_console.blocker')} value={props.task.blocker} />
            <Field label={t('supervision_task_console.recovery')} value={props.task.recoveryState} />
            <Field label={t('supervision_task_console.updated')} value={safeTimestamp(props.task.updatedAt, props.language)} />
          </dl>
          <section aria-label={t('supervision_task_console.events')}>
            <h4>{t('supervision_task_console.events')}</h4>
            {props.events.length ? (
              <ol class="supervision-task-console-events">{props.events.map((event) => (
                <li key={`${event.projectionVersion}:${event.eventId}`}><span>{t(`supervision_task_console.event_op.${event.op}`)}</span><small>{t('supervision_task_console.event', { id: event.eventId })}</small></li>
              ))}</ol>
            ) : <p class="supervision-task-console-muted">{t('supervision_task_console.no_events')}</p>}
          </section>
        </div>
      )}
    </article>
  );
}

export function SupervisionTaskConsoleView(props: {
  state: SupervisionTaskConsoleReducerState;
  mobile: boolean;
  readOnly?: boolean;
  mutationControls?: ComponentChildren;
  now?: number;
  width?: number;
  maxWidth?: number;
  onResizeStart?: (event: PointerEvent) => void;
  onResizeKeyDown?: (event: KeyboardEvent) => void;
  onClose: () => void;
  onNavigateSession: (sessionName: string) => void;
  returnFocusRef?: RefObject<HTMLButtonElement>;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [activeTab, setActiveTab] = useState<SupervisionConsoleTab>('active');
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const pendingTabRef = useRef<HTMLButtonElement>(null);
  const historyTabRef = useRef<HTMLButtonElement>(null);
  const language = i18n.resolvedLanguage || i18n.language || 'en';
  const assignmentsByTask = useMemo(() => {
    const grouped = new Map<string, SupervisionTaskConsoleAssignmentRow[]>();
    for (const assignment of Object.values(props.state.assignments)) {
      const values = grouped.get(assignment.taskId) ?? [];
      values.push(assignment);
      grouped.set(assignment.taskId, values);
    }
    for (const values of grouped.values()) values.sort((left, right) => right.updatedAt - left.updatedAt);
    return grouped;
  }, [props.state.assignments]);
  const allTasks = useMemo(() => Object.values(props.state.tasks).filter((task) => isSupervisionTaskLifecycleStatus(task.status)), [props.state.tasks]);
  const historyTasks = useMemo(() => allTasks
    .filter((task) => supervisionConsoleTabForTask(task, assignmentsByTask.get(task.taskId) ?? []) === 'history')
    .sort((left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId)), [allTasks]);
  const activeTasks = useMemo(() => sortSupervisionConsoleTasks(
    allTasks.filter((task) => supervisionConsoleTabForTask(task, assignmentsByTask.get(task.taskId) ?? []) === 'active'),
    assignmentsByTask,
  ), [allTasks, assignmentsByTask]);
  const pendingTasks = useMemo(() => sortSupervisionConsoleTasks(
    allTasks.filter((task) => supervisionConsoleTabForTask(task, assignmentsByTask.get(task.taskId) ?? []) === 'pending'),
    assignmentsByTask,
  ), [allTasks, assignmentsByTask]);

  useEffect(() => { if (props.mobile) closeRef.current?.focus(); }, [props.mobile]);

  const closeAndReturnFocus = () => {
    props.onClose();
    if (props.mobile) queueMicrotask(() => props.returnFocusRef?.current?.focus());
  };
  const onPanelKeyDown = (event: KeyboardEvent) => {
    if (!props.mobile) return;
    if (event.key === 'Escape') { event.preventDefault(); closeAndReturnFocus(); return; }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
    const [first] = focusable;
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !panel.contains(active))) { event.preventDefault(); first.focus(); }
  };
  const tabRef = (tab: SupervisionConsoleTab) => (
    tab === 'active' ? activeTabRef : tab === 'pending' ? pendingTabRef : historyTabRef
  );
  const onTabKeyDown = (event: KeyboardEvent, current: SupervisionConsoleTab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = SUPERVISION_CONSOLE_TABS.indexOf(current);
    const next = event.key === 'Home'
      ? SUPERVISION_CONSOLE_TABS[0]
      : event.key === 'End'
        ? SUPERVISION_CONSOLE_TABS[SUPERVISION_CONSOLE_TABS.length - 1]
        : SUPERVISION_CONSOLE_TABS[
          (currentIndex + (event.key === 'ArrowLeft' ? -1 : 1) + SUPERVISION_CONSOLE_TABS.length)
          % SUPERVISION_CONSOLE_TABS.length
        ];
    setActiveTab(next);
    tabRef(next).current?.focus();
  };
  const bodyState = props.state.phase === SUPERVISION_TASK_CONSOLE_PHASE.ERROR ? 'error'
    : props.state.phase === SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING && props.state.resyncReason === 'status_contract_mismatch' ? 'unsupported'
      : props.state.phase === SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING ? 'recovery'
        : props.state.phase !== SUPERVISION_TASK_CONSOLE_PHASE.READY ? 'loading'
          : allTasks.length === 0 ? 'empty' : 'ready';
  const visibleTasks = activeTab === 'active'
    ? activeTasks
    : activeTab === 'pending'
      ? pendingTasks
      : historyTasks.slice(0, historyLimit);

  return (
    <aside
      ref={panelRef}
      class={`supervision-task-console${props.mobile ? ' is-mobile' : ' is-desktop'}`}
      role={props.mobile ? 'dialog' : 'complementary'}
      aria-modal={props.mobile ? 'true' : undefined}
      aria-label={t('supervision_task_console.title')}
      data-read-only={props.readOnly ? 'true' : 'false'}
      onKeyDown={onPanelKeyDown}
      style={!props.mobile && props.width ? { width: `${props.width}px` } : undefined}
    >
      {!props.mobile && <div
        class="supervision-task-console-resize" role="separator" tabIndex={0} aria-orientation="vertical"
        aria-label={t('supervision_task_console.resize')}
        aria-valuemin={Math.min(DESKTOP_MIN_WIDTH, props.maxWidth ?? DESKTOP_MAX_WIDTH)}
        aria-valuemax={props.maxWidth ?? DESKTOP_MAX_WIDTH} aria-valuenow={props.width}
        onPointerDown={props.onResizeStart} onKeyDown={props.onResizeKeyDown}
      />}
      <header class="supervision-task-console-header">
        <div><span class="supervision-task-console-kicker">{t('supervision_task_console.kicker')}</span><h2>{t('supervision_task_console.title')}</h2></div>
        <button ref={closeRef} type="button" class="supervision-task-console-close" onClick={closeAndReturnFocus} aria-label={t('common.close')}>×</button>
      </header>
      {!props.readOnly && props.mutationControls}
      <div class="supervision-task-console-cursor" aria-live="polite"><span>{t('supervision_task_console.projection', { version: props.state.projectionVersion })}</span><span>{t('supervision_task_console.event', { id: props.state.lastDurableEventId ?? '—' })}</span></div>
      {bodyState === 'ready' && <div class="supervision-task-console-tabs" role="tablist" aria-label={t('supervision_task_console.tabs_label')}>
        <button ref={activeTabRef} type="button" role="tab" id="task-console-tab-active" aria-selected={activeTab === 'active'} aria-controls="task-console-panel-active" tabIndex={activeTab === 'active' ? 0 : -1} onKeyDown={(event) => onTabKeyDown(event, 'active')} onClick={() => setActiveTab('active')}>{t('supervision_task_console.tab_active')} <span>{activeTasks.length}</span></button>
        <button ref={pendingTabRef} type="button" role="tab" id="task-console-tab-pending" aria-selected={activeTab === 'pending'} aria-controls="task-console-panel-pending" tabIndex={activeTab === 'pending' ? 0 : -1} onKeyDown={(event) => onTabKeyDown(event, 'pending')} onClick={() => setActiveTab('pending')}>{t('supervision_task_console.tab_pending')} <span>{pendingTasks.length}</span></button>
        <button ref={historyTabRef} type="button" role="tab" id="task-console-tab-history" aria-selected={activeTab === 'history'} aria-controls="task-console-panel-history" tabIndex={activeTab === 'history' ? 0 : -1} onKeyDown={(event) => onTabKeyDown(event, 'history')} onClick={() => setActiveTab('history')}>{t('supervision_task_console.tab_history')} <span>{historyTasks.length}</span></button>
      </div>}
      <div class="supervision-task-console-body" data-state={bodyState}>
        {bodyState === 'loading' && <div class="supervision-task-console-state"><span class="spinner" />{t('supervision_task_console.loading')}</div>}
        {bodyState === 'recovery' && <div class="supervision-task-console-state is-recovery" role="status">{t('supervision_task_console.recovering')}</div>}
        {bodyState === 'unsupported' && <div class="supervision-task-console-state is-error" role="alert">{t('supervision_task_console.unsupported')}</div>}
        {bodyState === 'error' && <div class="supervision-task-console-state is-error" role="alert">{t('supervision_task_console.error')}</div>}
        {bodyState === 'empty' && <div class="supervision-task-console-state">{t('supervision_task_console.empty')}</div>}
        {bodyState === 'ready' && <section
          id={`task-console-panel-${activeTab}`} role="tabpanel" aria-labelledby={`task-console-tab-${activeTab}`}
          class="supervision-task-console-grid" data-tab={activeTab} tabIndex={0}
        >
          {visibleTasks.map((task) => <TaskCard
            key={task.taskId} task={task} assignments={assignmentsByTask.get(task.taskId) ?? []}
            events={props.state.eventsByTask[task.taskId] ?? []} expanded={expanded.has(task.taskId)}
            onToggle={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(task.taskId)) next.delete(task.taskId); else next.add(task.taskId); return next; })}
            onNavigateSession={props.onNavigateSession} language={language}
          />)}
          {!visibleTasks.length && <div class="supervision-task-console-state">{t(activeTab === 'active'
            ? 'supervision_task_console.no_active'
            : activeTab === 'pending'
              ? 'supervision_task_console.no_pending'
              : 'supervision_task_console.no_history')}</div>}
          {activeTab === 'history' && historyLimit < historyTasks.length && <button type="button" class="supervision-task-console-show-more" onClick={() => setHistoryLimit((value) => value + HISTORY_PAGE_SIZE)}>{t('supervision_task_console.show_more')}</button>}
        </section>}
        {bodyState === 'ready' && allTasks.length !== Object.keys(props.state.tasks).length && <div class="supervision-task-console-state is-error" role="alert">{t('supervision_task_console.unsupported')}</div>}
      </div>
    </aside>
  );
}

export function SupervisionTaskConsole(props: {
  ws: WsClient | null;
  connected: boolean;
  projectName: string;
  coordinatorSessionName: string;
  mobile: boolean;
  readOnly: boolean;
  onClose: () => void;
  onNavigateSession: (sessionName: string) => void;
  returnFocusRef?: RefObject<HTMLButtonElement>;
}) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [width, setWidth] = useState(() => loadSupervisionTaskConsolePreferences(supervisionTaskConsolePreferenceBounds(window.innerWidth)).width);
  const state = useSupervisionTaskConsole({ ws: props.ws, connected: props.connected, scope: { projectName: props.projectName, coordinatorSessionName: props.coordinatorSessionName } });
  useEffect(() => {
    const handleViewportResize = () => { setViewportWidth(window.innerWidth); setWidth((current) => clampSupervisionConsoleWidth(current, window.innerWidth)); };
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, []);
  const persistWidth = (next: number) => {
    const bounds = supervisionTaskConsolePreferenceBounds(window.innerWidth);
    const clamped = clampSupervisionConsoleWidth(next, window.innerWidth);
    const current = loadSupervisionTaskConsolePreferences(bounds);
    saveSupervisionTaskConsolePreferences({ ...current, width: clamped }, bounds);
    setWidth(clamped);
  };
  const startResize = (event: PointerEvent) => {
    if (props.mobile || event.button !== 0) return;
    const startX = event.clientX; const startWidth = width; const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => { if (moveEvent.pointerId === event.pointerId) persistWidth(startWidth + startX - moveEvent.clientX); };
    const stop = (stopEvent: PointerEvent) => { if (stopEvent.pointerId !== event.pointerId) return; target.releasePointerCapture?.(event.pointerId); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', stop); document.removeEventListener('pointercancel', stop); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', stop); document.addEventListener('pointercancel', stop);
  };
  const resizeWithKeyboard = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); persistWidth(width + (event.key === 'ArrowLeft' ? 24 : -24));
  };
  return <SupervisionTaskConsoleView
    state={state} mobile={props.mobile} readOnly={props.readOnly} width={width}
    maxWidth={supervisionConsoleMaxWidth(viewportWidth)} onResizeStart={startResize}
    onResizeKeyDown={resizeWithKeyboard} onClose={props.onClose}
    onNavigateSession={props.onNavigateSession} returnFocusRef={props.returnFocusRef}
  />;
}
