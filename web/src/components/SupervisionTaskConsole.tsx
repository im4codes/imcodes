import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  SUPERVISION_CONSOLE_STATUS_GROUPS,
  supervisionConsoleStatusGroup,
  type SupervisionConsoleStatusGroup,
  type SupervisionTaskConsoleAssignmentRow,
  type SupervisionTaskConsoleTaskRow,
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

export const SUPERVISION_TASK_CONSOLE_STALE_HEARTBEAT_MS = 2 * 60_000;
const DESKTOP_MIN_WIDTH = 320;
const DESKTOP_DEFAULT_WIDTH = 420;
const DESKTOP_MAX_WIDTH = 720;

export function supervisionConsoleMaxWidth(viewportWidth: number): number {
  return Math.max(DESKTOP_MIN_WIDTH, Math.min(DESKTOP_MAX_WIDTH, Math.floor(viewportWidth * 0.65)));
}

export function supervisionTaskConsolePreferenceBounds(
  viewportWidth = Number.POSITIVE_INFINITY,
): SupervisionTaskConsoleWidthBounds {
  return {
    minWidth: DESKTOP_MIN_WIDTH,
    maxWidth: supervisionConsoleMaxWidth(viewportWidth),
    defaultWidth: DESKTOP_DEFAULT_WIDTH,
  };
}

/** Apply the fixed desktop range and the shared 65vw split cap. */
export function clampSupervisionConsoleWidth(next: number, viewportWidth: number): number {
  const max = supervisionConsoleMaxWidth(viewportWidth);
  return Math.max(DESKTOP_MIN_WIDTH, Math.min(max, Math.round(next)));
}
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

function displayGroupKey(group: SupervisionConsoleStatusGroup): string {
  return `supervision_task_console.group.${group}`;
}

function staleHeartbeat(timestamp: number | undefined, now: number): boolean {
  return timestamp === undefined || now - timestamp > SUPERVISION_TASK_CONSOLE_STALE_HEARTBEAT_MS;
}

function safeTimestamp(timestamp: number | undefined, language: string): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '—';
  try {
    return new Intl.DateTimeFormat(language, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return '—';
  }
}

function valueOrDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function Field(props: { label: string; value: string | number | null | undefined; class?: string }) {
  return (
    <div class={`supervision-task-console-field${props.class ? ` ${props.class}` : ''}`}>
      <dt>{props.label}</dt>
      <dd>{valueOrDash(props.value)}</dd>
    </div>
  );
}

function AssignmentCard(props: {
  assignment: SupervisionTaskConsoleAssignmentRow;
  now: number;
  language: string;
  onNavigateSession: (sessionName: string) => void;
}) {
  const { t } = useTranslation();
  const { assignment } = props;
  const ownerName = assignment.ownerSessionName;
  const heartbeatStale = staleHeartbeat(assignment.heartbeatAt, props.now);
  return (
    <article class="supervision-task-console-assignment" data-testid={`task-assignment-${assignment.assignmentId}`}>
      <header>
        <span class="supervision-task-console-role">{assignment.role || t('supervision_task_console.unknown')}</span>
        <span class={`supervision-task-console-heartbeat${heartbeatStale ? ' is-stale' : ''}`}>
          {heartbeatStale ? t('supervision_task_console.heartbeat_stale') : t('supervision_task_console.heartbeat_live')}
        </span>
      </header>
      {ownerName ? (
        <button
          type="button"
          class="supervision-task-console-owner"
          onClick={() => props.onNavigateSession(ownerName)}
        >
          {assignment.ownerSessionLabel || ownerName}
          {assignment.ownerSessionLabel && <small>{ownerName}</small>}
        </button>
      ) : <span class="supervision-task-console-owner is-missing">{t('supervision_task_console.unassigned')}</span>}
      <dl class="supervision-task-console-fields">
        <Field label={t('supervision_task_console.provider')} value={assignment.observedProvider} />
        <Field label={t('supervision_task_console.model')} value={assignment.observedModel} />
        <Field label={t('supervision_task_console.pool')} value={assignment.poolKind ? t(`supervision_task_console.pool_kind.${assignment.poolKind}`) : assignment.poolId} />
        <Field label={t('supervision_task_console.current_action')} value={assignment.currentAction} />
        <Field label={t('supervision_task_console.next_action')} value={assignment.nextAction} />
        <Field label={t('supervision_task_console.validation')} value={t(`supervision_task_console.validation_state.${assignment.validationState}`)} />
        <Field label={t('supervision_task_console.audit_attempt')} value={assignment.auditAttemptId} />
        <Field label={t('supervision_task_console.audit_round')} value={assignment.auditRound} />
        <Field label={t('supervision_task_console.audit_verdict')} value={assignment.auditVerdict} />
        <Field label={t('supervision_task_console.blocker')} value={assignment.blocker} />
        <Field label={t('supervision_task_console.recovery')} value={assignment.recoveryState} />
        <Field label={t('supervision_task_console.recovery_reason')} value={assignment.recoveryReason} />
        <Field label={t('supervision_task_console.workspace')} value={assignment.workspaceId} />
        <Field label={t('supervision_task_console.snapshot')} value={assignment.snapshotId} />
        <Field label={t('supervision_task_console.checkpoint')} value={assignment.checkpointId} />
        <Field label={t('supervision_task_console.heartbeat')} value={safeTimestamp(assignment.heartbeatAt, props.language)} />
        <Field label={t('supervision_task_console.updated')} value={safeTimestamp(assignment.updatedAt, props.language)} />
        <Field label={t('supervision_task_console.last_event')} value={assignment.lastEventId} />
      </dl>
    </article>
  );
}

function TaskCard(props: {
  task: SupervisionTaskConsoleTaskRow;
  assignments: readonly SupervisionTaskConsoleAssignmentRow[];
  events: readonly SupervisionTaskConsoleEventEvidence[];
  expanded: boolean;
  onToggle: () => void;
  onNavigateSession: (sessionName: string) => void;
  now: number;
  language: string;
}) {
  const { t } = useTranslation();
  const { task } = props;
  const heartbeatStale = staleHeartbeat(task.heartbeatAt, props.now);
  const progress = task.progress && task.progress.total > 0
    ? Math.min(100, Math.max(0, (task.progress.completed / task.progress.total) * 100))
    : null;
  return (
    <article
      class="supervision-task-console-task"
      data-status={task.status}
      data-event-id={task.lastEventId}
      data-testid={`task-card-${task.taskId}`}
    >
      <span key={task.lastEventId} class="supervision-task-console-transition" aria-hidden="true" />
      <button
        type="button"
        class="supervision-task-console-task-summary"
        aria-expanded={props.expanded}
        aria-controls={`task-console-details-${task.taskId}`}
        onClick={props.onToggle}
      >
        <span class="supervision-task-console-task-title">
          <strong>{task.title}</strong>
          <small>{task.semanticKey || task.taskId}</small>
        </span>
        <span class={`supervision-task-console-status status-${task.status}`}>
          {t(displayStatusKey(task.status))}
        </span>
        <span aria-hidden="true" class="supervision-task-console-chevron">{props.expanded ? '⌃' : '⌄'}</span>
      </button>
      {progress !== null && task.progress && (
        <div class="supervision-task-console-progress" aria-label={t('supervision_task_console.progress', { ...task.progress })}>
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      <div class="supervision-task-console-task-meta">
        <span class={`supervision-task-console-heartbeat${heartbeatStale ? ' is-stale' : ''}`}>
          {heartbeatStale ? t('supervision_task_console.heartbeat_stale') : t('supervision_task_console.heartbeat_live')}
        </span>
        {task.poolKind && <span>{t(`supervision_task_console.pool_kind.${task.poolKind}`)}</span>}
        {task.currentAction && <span>{task.currentAction}</span>}
      </div>
      {props.expanded && (
        <div id={`task-console-details-${task.taskId}`} class="supervision-task-console-task-details">
          <section aria-label={t('supervision_task_console.evidence')}>
            <h4>{t('supervision_task_console.evidence')}</h4>
            {task.ownerSessionName && (
              <button
                type="button"
                class="supervision-task-console-owner"
                onClick={() => props.onNavigateSession(task.ownerSessionName!)}
              >
                {task.ownerSessionName}
              </button>
            )}
            <dl class="supervision-task-console-fields">
              <Field label={t('supervision_task_console.task_id')} value={task.taskId} />
              <Field label={t('supervision_task_console.top_level_task')} value={task.topLevelTaskId} />
              <Field label={t('supervision_task_console.current_action')} value={task.currentAction} />
              <Field label={t('supervision_task_console.next_action')} value={task.nextAction} />
              <Field label={t('supervision_task_console.validation')} value={t(`supervision_task_console.validation_state.${task.validationState}`)} />
              <Field label={t('supervision_task_console.audit_attempt')} value={task.auditAttemptId} />
              <Field label={t('supervision_task_console.audit_round')} value={task.auditRound} />
              <Field label={t('supervision_task_console.audit_verdict')} value={task.auditVerdict} />
              <Field label={t('supervision_task_console.blocker')} value={task.blocker} />
              <Field label={t('supervision_task_console.recovery')} value={task.recoveryState} />
              <Field label={t('supervision_task_console.recovery_reason')} value={task.recoveryReason} />
              <Field label={t('supervision_task_console.workspace')} value={task.workspaceId} />
              <Field label={t('supervision_task_console.snapshot')} value={task.snapshotId} />
              <Field label={t('supervision_task_console.snapshot_state')} value={task.snapshotState} />
              <Field label={t('supervision_task_console.checkpoint')} value={task.checkpointId} />
              <Field label={t('supervision_task_console.updated')} value={safeTimestamp(task.updatedAt, props.language)} />
              <Field label={t('supervision_task_console.last_event')} value={task.lastEventId} />
            </dl>
          </section>
          <section aria-label={t('supervision_task_console.events')}>
            <h4>{t('supervision_task_console.events')}</h4>
            {props.events.length > 0 ? (
              <ol class="supervision-task-console-events">
                {props.events.map((event) => (
                  <li key={`${event.projectionVersion}:${event.eventId}`}>
                    <span>{t(`supervision_task_console.event_op.${event.op}`)}</span>
                    <small>{t('supervision_task_console.event', { id: event.eventId })}</small>
                  </li>
                ))}
              </ol>
            ) : <p class="supervision-task-console-muted">{t('supervision_task_console.no_events')}</p>}
          </section>
          <section aria-label={t('supervision_task_console.assignments')}>
            <h4>{t('supervision_task_console.assignments')}</h4>
            {props.assignments.length > 0 ? props.assignments.map((assignment) => (
              <AssignmentCard
                key={assignment.assignmentId}
                assignment={assignment}
                now={props.now}
                language={props.language}
                onNavigateSession={props.onNavigateSession}
              />
            )) : <p class="supervision-task-console-muted">{t('supervision_task_console.no_assignments')}</p>}
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
  const [liveNow, setLiveNow] = useState(() => Date.now());
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const now = props.now ?? liveNow;
  const language = i18n.resolvedLanguage || i18n.language || 'en';
  const tasks = Object.values(props.state.tasks).sort((left, right) => right.updatedAt - left.updatedAt);
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

  useEffect(() => {
    if (props.mobile) closeRef.current?.focus();
  }, [props.mobile]);

  // Presentation-only clock: projection state remains entirely WebSocket driven.
  useEffect(() => {
    if (props.now !== undefined) return undefined;
    const timer = window.setInterval(() => setLiveNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [props.now]);

  const closeAndReturnFocus = () => {
    props.onClose();
    if (props.mobile) queueMicrotask(() => props.returnFocusRef?.current?.focus());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!props.mobile) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndReturnFocus();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true');
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  const bodyState = props.state.phase === SUPERVISION_TASK_CONSOLE_PHASE.ERROR
    ? 'error'
    : props.state.phase === SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING
        && props.state.resyncReason === 'status_contract_mismatch'
      ? 'unsupported'
    : props.state.phase === SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING
      ? 'recovery'
      : props.state.phase !== SUPERVISION_TASK_CONSOLE_PHASE.READY
        ? 'loading'
        : tasks.length === 0
          ? 'empty'
          : 'ready';

  return (
    <aside
      ref={panelRef}
      class={`supervision-task-console${props.mobile ? ' is-mobile' : ' is-desktop'}`}
      role={props.mobile ? 'dialog' : 'complementary'}
      aria-modal={props.mobile ? 'true' : undefined}
      aria-label={t('supervision_task_console.title')}
      data-read-only={props.readOnly ? 'true' : 'false'}
      onKeyDown={onKeyDown}
      style={!props.mobile && props.width ? { width: `${props.width}px` } : undefined}
    >
      {!props.mobile && (
        <div
          class="supervision-task-console-resize"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('supervision_task_console.resize')}
          aria-valuemin={DESKTOP_MIN_WIDTH}
          aria-valuemax={props.maxWidth ?? DESKTOP_MAX_WIDTH}
          aria-valuenow={props.width}
          onPointerDown={props.onResizeStart}
          onKeyDown={props.onResizeKeyDown}
        />
      )}
      <header class="supervision-task-console-header">
        <div>
          <span class="supervision-task-console-kicker">{t('supervision_task_console.kicker')}</span>
          <h2>{t('supervision_task_console.title')}</h2>
        </div>
        <button ref={closeRef} type="button" class="supervision-task-console-close" onClick={closeAndReturnFocus} aria-label={t('common.close')}>×</button>
      </header>
      {!props.readOnly && props.mutationControls}
      <div class="supervision-task-console-cursor" aria-live="polite">
        <span>{t('supervision_task_console.projection', { version: props.state.projectionVersion })}</span>
        <span>{t('supervision_task_console.event', { id: props.state.lastDurableEventId ?? '—' })}</span>
      </div>

      <div class="supervision-task-console-body" data-state={bodyState}>
        {bodyState === 'loading' && <div class="supervision-task-console-state"><span class="spinner" />{t('supervision_task_console.loading')}</div>}
        {bodyState === 'recovery' && <div class="supervision-task-console-state is-recovery" role="status">{t('supervision_task_console.recovering')}</div>}
        {bodyState === 'unsupported' && <div class="supervision-task-console-state is-error" role="alert">{t('supervision_task_console.unsupported')}</div>}
        {bodyState === 'error' && <div class="supervision-task-console-state is-error" role="alert">{t('supervision_task_console.error')}</div>}
        {bodyState === 'empty' && <div class="supervision-task-console-state">{t('supervision_task_console.empty')}</div>}
        {bodyState === 'ready' && SUPERVISION_CONSOLE_STATUS_GROUPS.map((group) => {
          const groupTasks = tasks.filter((task) => (
            isSupervisionTaskLifecycleStatus(task.status)
              ? supervisionConsoleStatusGroup(task.status) === group
              : false
          ));
          if (groupTasks.length === 0) return null;
          return (
            <section key={group} class={`supervision-task-console-group group-${group}`} aria-label={t(displayGroupKey(group))}>
              <header><h3>{t(displayGroupKey(group))}</h3><span>{groupTasks.length}</span></header>
              {groupTasks.map((task) => (
                <TaskCard
                  key={task.taskId}
                  task={task}
                  assignments={assignmentsByTask.get(task.taskId) ?? []}
                  events={props.state.eventsByTask[task.taskId] ?? []}
                  expanded={expanded.has(task.taskId)}
                  onToggle={() => setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(task.taskId)) next.delete(task.taskId);
                    else next.add(task.taskId);
                    return next;
                  })}
                  onNavigateSession={props.onNavigateSession}
                  now={now}
                  language={language}
                />
              ))}
            </section>
          );
        })}
        {bodyState === 'ready' && tasks.some((task) => !isSupervisionTaskLifecycleStatus(task.status)) && (
          <div class="supervision-task-console-state is-error" role="alert">{t('supervision_task_console.unsupported')}</div>
        )}
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
  const [width, setWidth] = useState(() => loadSupervisionTaskConsolePreferences(
    supervisionTaskConsolePreferenceBounds(window.innerWidth),
  ).width);
  const state = useSupervisionTaskConsole({
    ws: props.ws,
    connected: props.connected,
    scope: {
      projectName: props.projectName,
      coordinatorSessionName: props.coordinatorSessionName,
    },
  });

  useEffect(() => {
    const handleViewportResize = () => {
      setViewportWidth(window.innerWidth);
      setWidth((current) => clampSupervisionConsoleWidth(current, window.innerWidth));
    };
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
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      persistWidth(startWidth + startX - moveEvent.clientX);
    };
    const stop = (stopEvent: PointerEvent) => {
      if (stopEvent.pointerId !== event.pointerId) return;
      target.releasePointerCapture?.(event.pointerId);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
  };

  const resizeWithKeyboard = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? 24 : -24;
    persistWidth(width + delta);
  };

  return (
    <SupervisionTaskConsoleView
      state={state}
      mobile={props.mobile}
      readOnly={props.readOnly}
      width={width}
      maxWidth={supervisionConsoleMaxWidth(viewportWidth)}
      onResizeStart={startResize}
      onResizeKeyDown={resizeWithKeyboard}
      onClose={props.onClose}
      onNavigateSession={props.onNavigateSession}
      returnFocusRef={props.returnFocusRef}
    />
  );
}
