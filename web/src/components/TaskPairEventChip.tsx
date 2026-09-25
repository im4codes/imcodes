import { useTranslation } from 'react-i18next';
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
export function TaskPairEventChip({ eventId, payload }: { eventId: string; payload: Record<string, unknown> }) {
  const { t } = useTranslation();
  const event = payload as Partial<TaskPairEventPayload>;
  const taskId = typeof event.taskId === 'string' ? event.taskId : '—';
  const writer = typeof event.writer === 'string' ? event.writer : '';
  const verb = t(`taskPair.verb.${verbKey(event.verb)}`);
  const status = isStatus(event.toStatus) ? t(`taskPair.status.${event.toStatus}`) : '';
  const counts = event.severityCounts
    ? AUDIT_SEVERITY_LEVELS
      .filter((level) => (event.severityCounts?.[level] ?? 0) > 0)
      .map((level) => t('taskPair.severity', { level, count: event.severityCounts?.[level] }))
      .join(' · ')
    : '';
  const held = event.verdictJudgement === 'inconsistent' || event.verdictJudgement === 'missing_severity';
  // One colour per status (styles.css `.task-pair-chip--<status>`).
  const statusClass = isStatus(event.toStatus) ? ` task-pair-chip--${event.toStatus}` : '';
  return (
    <div
      class={`chat-event chat-system task-pair-chip${statusClass}${event.unusual ? ' task-pair-chip--unusual' : ''}${held ? ' task-pair-chip--held' : ''}`}
      data-task-status={isStatus(event.toStatus) ? event.toStatus : undefined}
      data-event-id={eventId}
      data-task-id={taskId}
    >
      <span class="task-pair-chip-task">{event.title ? `${taskId} · ${event.title}` : taskId}</span>
      <span class="task-pair-chip-text">
        {event.verb === TASK_PAIR_WORKSPACE_EVENT_VERB
          ? workspaceText(t, event)
          : t('taskPair.chip', { writer: writer === 'daemon' ? t('taskPair.daemon') : writer, verb })}
      </span>
      {status && <span class={`task-pair-chip-status status-${String(event.toStatus)}`}>{status}</span>}
      {counts && <span class="task-pair-chip-counts">{counts}</span>}
      {held && <span class="task-pair-chip-held">{t('taskPair.verdict_held')}</span>}
      {event.unusual && <span class="task-pair-chip-unusual">{t('taskPair.unusual')}</span>}
    </div>
  );
}
