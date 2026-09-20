/**
 * DelegationClaimBadge — renders a turn's delegation AUTHORITY, never its prose.
 *
 * The only input is the structured projection the daemon attaches to a
 * completed assistant message (`shared/delegation-claim.ts`). Nothing here
 * reads, scans or classifies assistant text: a turn is shown as having
 * dispatched work only when the projection carries real dispatch facts, and
 * the rendered summary is bound to the exact authority ids those facts state.
 *
 * Two outcomes, and no third:
 *   - no projection            → render nothing at all (older daemons, non-SDK
 *                                runtimes, streaming events, machine control)
 *   - one or more task facts   → the count plus each dispatch's own ids
 */

import { useTranslation } from 'react-i18next';
import { readDelegationClaim } from '@shared/delegation-claim.js';
import type { SupervisionExecutionSummary } from '@shared/supervision-execution-summary.js';
import { readSupervisionTaskTitle } from '@shared/supervision-task-identity.js';
import {
  resolveCardAssignmentStatus,
  type LiveAssignmentStatus,
} from '../timeline/supervision-assignment-status.js';

export interface DelegationClaimBadgeProps {
  /** Metadata record of a completed assistant message. */
  metadata?: Record<string, unknown>;
  /**
   * Daemon-announced lifecycle status per assignment id (see
   * web/src/timeline/supervision-assignment-status.ts). It supersedes the
   * status frozen into the projection at send time only when it is newer than
   * this card (`messageTs`).
   */
  liveAssignmentStatuses?: ReadonlyMap<string, LiveAssignmentStatus>;
  /** Daemon time of the message that carries this card. */
  messageTs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Locate the metadata record carrying the delegation-claim projection on a
 * timeline event payload.
 *
 * The daemon attaches the projection to the assistant message's `metadata`;
 * depending on how a relay forwards that message the record can arrive either
 * nested under `payload.metadata` or flattened onto the payload itself. Both
 * are checked structurally — by asking `readDelegationClaim` whether a real
 * projection is there — so this never guesses from any other payload content.
 * The returned record is the existing object (not a copy) to keep the memoized
 * assistant block's prop identity stable across re-renders.
 */
export const readDelegationClaimMetadata = (
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!payload) return undefined;
  const nested = payload.metadata;
  if (isRecord(nested) && readDelegationClaim(nested)) return nested;
  return readDelegationClaim(payload) ? payload : undefined;
};


/**
 * The executor stated by this dispatch's own delivery legs.
 *
 * Every leg of one dispatch runs on the same target today, so the first leg
 * that states an executor is the dispatch's executor. A dispatch whose legs
 * state nothing renders no line at all, rather than an empty label.
 */
const executionOf = (dispatch: { deliveries?: { execution?: SupervisionExecutionSummary }[] }) =>
  (dispatch.deliveries ?? []).find((delivery) => delivery.execution)?.execution;

/**
 * The line a reader actually scans: who ran it, on what model, in which lane.
 *
 * Nothing else belongs here. Provider, runtime type and assignment status are
 * real facts, but a person reading a turn is asking those three questions and
 * padding the line with the rest is how the answer stops being findable. The
 * remainder is kept in diagnostics, not dropped. Absent facts are skipped
 * rather than placeheld, so the line never implies precision it lacks.
 */
export const formatExecutionSummary = (
  execution: SupervisionExecutionSummary,
  localizedIdentity?: string,
): string => [
  localizedIdentity ?? (execution.label && execution.label !== execution.sessionName
    ? `${execution.label} (${execution.sessionName})`
    : execution.sessionName),
  execution.model,
  execution.pool,
].filter(Boolean).join(' · ');

/** Everything true but not scanned-for, kept exact for copying. */
export const formatExecutionDiagnostics = (execution: SupervisionExecutionSummary): string => [
  [execution.agentType, execution.providerFamily].filter(Boolean).join('/') || undefined,
  execution.runtimeType,
  execution.assignmentStatus,
  execution.source,
].filter(Boolean).join(' · ');

export function DelegationClaimBadge({ metadata, liveAssignmentStatuses, messageTs }: DelegationClaimBadgeProps) {
  const { t } = useTranslation();
  const claim = readDelegationClaim(metadata);
  if (!claim) return null;

  // Authority comes from task facts, not from the label on them. The shared
  // reader already rejects empty, malformed and legacy machine-control-only
  // projections, so there is no neutral or OCU badge to render here.
  const dispatches = Array.isArray(claim.dispatches) ? claim.dispatches : [];
  const substantiated = claim.status === 'substantiated' && dispatches.length > 0;
  if (!substantiated) return null;

  return (
    <div
      class="delegation-claim delegation-claim-substantiated"
      data-delegation-claim="substantiated"
    >
      <span class="delegation-claim-count">
        {t('delegation.claim.dispatch_count', {
          defaultValue: 'Authorized dispatches: {{total}}',
          total: dispatches.length,
        })}
      </span>
      <ul class="delegation-claim-dispatches">
        {dispatches.map((dispatch) => {
          const sentExecution = executionOf(dispatch);
          const assignmentStatus = resolveCardAssignmentStatus({
            sentStatus: sentExecution?.assignmentStatus,
            live: dispatch.assignmentId ? liveAssignmentStatuses?.get(dispatch.assignmentId) : undefined,
            cardTs: messageTs,
          });
          const execution = sentExecution && assignmentStatus && assignmentStatus !== sentExecution.assignmentStatus
            ? { ...sentExecution, assignmentStatus }
            : sentExecution;
          const localizedIdentity = execution?.label && execution.label !== execution.sessionName
            ? t('delegation.claim.execution_identity', {
              defaultValue: '{{label}} ({{sessionName}})',
              label: execution.label,
              sessionName: execution.sessionName,
            })
            : execution?.sessionName;
          return (
          <li
            key={dispatch.dispatchId}
            class="delegation-claim-dispatch"
            data-delegation-dispatch={dispatch.dispatchId}
            {...(assignmentStatus ? { 'data-assignment-status': assignmentStatus } : {})}
          >
            {execution ? (
              <span class="delegation-claim-execution" data-delegation-field="execution">
                {t('delegation.claim.execution', 'Runs on')}
                {': '}
                <code>{formatExecutionSummary(execution, localizedIdentity)}</code>
              </span>
            ) : null}
            {dispatch.taskId || dispatch.assignmentId ? (
              /*
                The formal task identity is always visible, on live and reloaded
                cards alike: the registry title the daemon returned on the
                accepted receipt (bounded again here), and the exact taskId and
                assignmentId a recipient must be able to verify.
              */
              <span class="delegation-claim-task" data-delegation-field="taskIdentity">
                <span class="delegation-claim-task-title" data-delegation-field="taskTitle">
                  {t('delegation.claim.task_title', 'Task')}
                  {': '}
                  {readSupervisionTaskTitle(dispatch.taskTitle)
                    ?? t('delegation.claim.task_title_unavailable', 'Untitled task')}
                </span>
                {dispatch.taskId ? (
                  <span class="delegation-claim-id" data-delegation-field="taskId">
                    {t('delegation.claim.task_id', 'Task ID')}
                    {': '}
                    <code>{dispatch.taskId}</code>
                  </span>
                ) : null}
                {dispatch.assignmentId ? (
                  <span class="delegation-claim-id" data-delegation-field="assignmentId">
                    {t('delegation.claim.assignment_id', 'Assignment ID')}
                    {': '}
                    <code>{dispatch.assignmentId}</code>
                  </span>
                ) : null}
              </span>
            ) : null}
            {/*
              Collapsed, and closed by default. The dispatch id and the executor
              detail answer no question a reader has while reading; they exist
              to be quoted back exactly when something has gone wrong.
            */}
            <details class="delegation-claim-diagnostics" data-delegation-field="diagnostics">
              <summary>{t('delegation.claim.diagnostics', 'Diagnostics')}</summary>
              <span class="delegation-claim-id" data-delegation-field="dispatchId">
                {t('delegation.claim.dispatch_id', 'Dispatch ID')}
                {': '}
                <code>{dispatch.dispatchId}</code>
              </span>
              {execution && formatExecutionDiagnostics(execution) ? (
                <span class="delegation-claim-id" data-delegation-field="executionDetail">
                  <code>{formatExecutionDiagnostics(execution)}</code>
                </span>
              ) : null}
            </details>
          </li>
          );
        })}
      </ul>
    </div>
  );
}
