import { useTranslation } from 'react-i18next';
import { useState } from 'preact/hooks';
import { AUDIT_SEVERITY_LEVELS } from '@shared/audit-convergence.js';
import {
  TASK_PAIR_STATUSES,
  TASK_PAIR_VERBS,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  type TaskPairEventPayload,
  type TaskPairStatus,
} from '@shared/task-pair.js';

function isStatus(value: unknown): value is TaskPairStatus {
  return typeof value === 'string' && (TASK_PAIR_STATUSES as readonly string[]).includes(value);
}

function verbKey(verb: unknown): string {
  return typeof verb === 'string' && (TASK_PAIR_VERBS as readonly string[]).includes(verb) ? verb.toLowerCase() : 'other';
}

/** Text of a daemon workspace event: where a kept deliverable went, or what happened to the workspace. */
function workspaceText(t: (key: string, options?: Record<string, unknown>) => string, event: Partial<TaskPairEventPayload>): string {
  switch (event.effect) {
    case TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_SAVED:
      return t('taskPair.output_saved', { path: event.outputPath ?? '' });
    case TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_FAILED:
      return t('taskPair.output_failed', { reason: event.outputError ?? '' });
    case TASK_PAIR_WORKSPACE_EFFECTS.KEPT:
      return t('taskPair.workspace_kept');
    default:
      return t('taskPair.workspace_removed');
  }
}

/** Compact chat chip for one task-pair marker event (it replaces the hidden marker line). */
export function TaskPairEventChip({ eventId, payload, timestamp }: { eventId: string; payload: Record<string, unknown>; timestamp?: number }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const event = payload as Partial<TaskPairEventPayload>;
  const taskId = typeof event.taskId === 'string' ? event.taskId : '—';
  const writer = typeof event.writer === 'string' ? event.writer : '';
  const verb = t(`taskPair.verb.${verbKey(event.verb)}`);
  const status = isStatus(event.toStatus) ? t(`taskPair.status.${event.toStatus}`) : t('taskPair.card_unknown_status');
  const counts = event.severityCounts
    ? AUDIT_SEVERITY_LEVELS
      .filter((level) => (event.severityCounts?.[level] ?? 0) > 0)
      .map((level) => t('taskPair.severity', { level, count: event.severityCounts?.[level] }))
      .join(' · ')
    : '';
  const held = event.verdictJudgement === 'inconsistent' || event.verdictJudgement === 'missing_severity';
  const verdict = typeof event.verdictJudgement === 'string' ? event.verdictJudgement : '';
  const payloadForDetails = typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? { ...payload, _eventTimestamp: new Date(timestamp).toISOString() }
    : payload;
  const payloadJson = JSON.stringify(payloadForDetails, null, 2) ?? '{}';
  const eventTime = typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(i18n?.language || undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
    : '';
  const noticeText = typeof (event as Record<string, unknown>).noticeText === 'string'
    ? (event as Record<string, unknown>).noticeText as string
    : '';
  // One colour per status (styles.css `.task-pair-chip--<status>`).
  const statusClass = isStatus(event.toStatus) ? ` task-pair-chip--${event.toStatus}` : '';
  const statusBadgeClass = isStatus(event.toStatus) ? event.toStatus : 'unknown';
  const title = typeof event.title === 'string' && event.title.trim() ? event.title.trim() : t('taskPair.card_untitled');
  const sessionLabel = (id: unknown, label: unknown) => {
    if (typeof id !== 'string' || !id) return null;
    const text = typeof label === 'string' && label ? `${label} (${id})` : id;
    return <button type="button" class="task-pair-chip-session" onClick={(click) => {
      click.stopPropagation();
      window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session: id } }));
    }}>{text}</button>;
  };
  const roleLabel = (id: unknown, label: unknown, role: 'executor' | 'auditor') => {
    const session = sessionLabel(id, label);
    return <span class="task-pair-card-role"><span class="task-pair-card-role-label">{t(`taskPair.card_${role}`)}</span>{session ?? <span class="task-pair-card-unassigned">{t('taskPair.card_unassigned')}</span>}</span>;
  };
  return (
    <section
      class={`chat-event chat-system task-pair-chip task-pair-event-card${expanded ? ' is-expanded' : ''}${statusClass}${event.unusual ? ' task-pair-chip--unusual' : ''}${held ? ' task-pair-chip--held' : ''}`}
      data-task-status={isStatus(event.toStatus) ? event.toStatus : undefined}
      data-event-id={eventId}
      data-task-id={taskId}
    >
      <header class="task-pair-card-head">
        <button
          type="button"
          class="task-pair-card-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span class="task-pair-card-heading">
            <span class="task-pair-card-kicker">{t('taskPair.card_kicker')}</span>
            <span class="task-pair-chip-task">
              <strong>{title}</strong>
            </span>
          </span>
          <span class={`task-pair-chip-status status-${statusBadgeClass}`}>{status}</span>
          {eventTime && <time class="task-pair-card-time" dateTime={new Date(timestamp!).toISOString()}>{t('taskPair.card_time', { value: eventTime })}</time>}
          <span class="task-pair-card-toggle-label">{expanded ? t('taskPair.card_collapse') : t('taskPair.card_expand')}</span>
          <span class={`task-pair-card-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true">⌄</span>
        </button>
      </header>
      {expanded && <>
        <div class="task-pair-card-body">
          <span class="task-pair-chip-text">
            {event.verb === TASK_PAIR_WORKSPACE_EVENT_VERB
              ? workspaceText(t, event)
              : t('taskPair.chip', { writer: writer === 'daemon' ? t('taskPair.daemon') : writer, verb })}
          </span>
          {noticeText && <pre class="task-pair-card-notice">{noticeText}</pre>}
          <span class="task-pair-card-event-meta"><span>{t('taskPair.card_event')}</span>{verb}</span>
          {roleLabel(event.executor, event.executorLabel, 'executor')}
          {roleLabel(event.auditor, event.auditorLabel, 'auditor')}
        </div>
        {(counts || verdict || held || event.unusual) && <footer class="task-pair-card-flags">
          {counts && <span class="task-pair-chip-counts">{counts}</span>}
          {verdict && <span class="task-pair-chip-verdict">{t('taskPair.card_verdict', { value: verdict })}</span>}
          {held && <span class="task-pair-chip-held">{t('taskPair.verdict_held')}</span>}
          {event.unusual && <span class="task-pair-chip-unusual">{t('taskPair.unusual')}</span>}
        </footer>}
        <div class="task-pair-card-payload">
          <span class="task-pair-card-payload-label">{t('taskPair.card_payload')}</span>
          <pre>{payloadJson}</pre>
        </div>
      </>}
    </section>
  );
}
