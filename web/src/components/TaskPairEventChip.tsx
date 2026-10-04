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

type SessionModelEntry = { name: string; activeModel?: string | null; requestedModel?: string | null; effort?: string | null };

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
export function TaskPairEventChip({ eventId, payload, timestamp, sessions }: { eventId: string; payload: Record<string, unknown>; timestamp?: number; sessions?: readonly SessionModelEntry[] }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const event = payload as Partial<TaskPairEventPayload>;
  const taskId = typeof event.taskId === 'string' ? event.taskId : '—';
  const writer = typeof event.writer === 'string' ? event.writer : '';
  const isCancelledEvent = event.toStatus === 'cancelled';
  const cancelActor = typeof event.cancelActor === 'string' && event.cancelActor.trim()
    ? event.cancelActor.trim()
    : event.cancelProvenanceTrusted ? writer : '';
  const cancelSource = typeof event.cancelSource === 'string' && event.cancelSource.trim()
    ? event.cancelSource.trim()
    : event.cancelProvenanceTrusted && typeof event.source === 'string' ? event.source : '';
  const cancelReason = typeof event.cancelReason === 'string' && event.cancelReason.trim()
    ? event.cancelReason.trim()
    : t('taskPair.card_cancel_reason_unknown');
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
  const resolveModel = (id: unknown, payloadModel: unknown): string | undefined => {
    if (typeof payloadModel === 'string' && payloadModel.trim()) return payloadModel.trim();
    if (typeof id !== 'string' || !id) return undefined;
    const session = sessions?.find((entry) => entry.name === id);
    return session?.activeModel?.trim() || session?.requestedModel?.trim() || undefined;
  };
  const resolveThinking = (id: unknown, payloadThinking: unknown): string | undefined => {
    if (typeof payloadThinking === 'string' && payloadThinking.trim()) return payloadThinking.trim();
    if (typeof id !== 'string' || !id) return undefined;
    const session = sessions?.find((entry) => entry.name === id);
    return session?.effort?.trim() || undefined;
  };
  const roleLabel = (id: unknown, label: unknown, modelValue: unknown, thinkingValue: unknown, role: 'executor' | 'auditor') => {
    const session = sessionLabel(id, label);
    const model = resolveModel(id, modelValue);
    const thinking = resolveThinking(id, thinkingValue);
    return <span class="task-pair-card-role"><span class="task-pair-card-role-label">{t(`taskPair.card_${role}`)}</span>{session ?? <span class="task-pair-card-unassigned">{t('taskPair.card_unassigned')}</span>}{session && <span class="task-pair-card-role-model">{t('taskPair.card_model', { value: model ?? t('taskPair.card_model_unknown') })}</span>}{session && <span class="task-pair-card-role-thinking">{t('taskPair.card_thinking', { value: thinking ?? t('taskPair.card_thinking_unknown') })}</span>}</span>;
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
          aria-label={expanded ? t('taskPair.card_collapse') : t('taskPair.card_expand')}
          title={expanded ? t('taskPair.card_collapse') : t('taskPair.card_expand')}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span class="task-pair-card-heading">
            <span class="task-pair-card-kicker">{t('taskPair.card_kicker')}</span>
          </span>
          <span class="task-pair-card-meta">
            <span class={`task-pair-chip-status status-${statusBadgeClass}`}>{status}</span>
            {eventTime && <time class="task-pair-card-time" dateTime={new Date(timestamp!).toISOString()}>{eventTime}</time>}
            <span class={`task-pair-card-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true">⌄</span>
          </span>
          <span class="task-pair-chip-task">
            <strong>{title}</strong>
          </span>
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
          {roleLabel(event.executor, event.executorLabel, event.executorModel, event.executorThinking, 'executor')}
          {roleLabel(event.auditor, event.auditorLabel, event.auditorModel, event.auditorThinking, 'auditor')}
          {isCancelledEvent && <div class="task-pair-card-cancel-meta" data-cancel-provenance="true">
            <span>{t('taskPair.card_cancel_actor', { value: cancelActor || t('taskPair.card_cancel_unknown') })}</span>
            <span>{t('taskPair.card_cancel_source', { value: cancelSource ? t(`taskPair.cancel_source.${cancelSource}`, { defaultValue: cancelSource }) : t('taskPair.card_cancel_unknown') })}</span>
            <span>{t('taskPair.card_cancel_reason', { value: cancelReason })}</span>
          </div>}
        </div>
        {(counts || verdict || held || event.unusual) && <footer class="task-pair-card-flags">
          {counts && <span class="task-pair-chip-counts">{counts}</span>}
          {verdict && <span class="task-pair-chip-verdict">{t('taskPair.card_verdict', { value: verdict })}</span>}
          {held && <span class="task-pair-chip-held">{t('taskPair.verdict_held')}</span>}
          {event.unusual && <span class="task-pair-chip-unusual">{t('taskPair.unusual')}</span>}
        </footer>}
        <details class="task-pair-card-payload">
          <summary class="task-pair-card-payload-label">{t('taskPair.card_payload')}</summary>
          <pre>{payloadJson}</pre>
        </details>
      </>}
    </section>
  );
}
