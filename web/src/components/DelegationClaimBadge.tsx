/**
 * DelegationClaimBadge — renders a turn's delegation AUTHORITY, never its prose.
 *
 * The only input is the structured projection the daemon attaches to a
 * completed assistant message (`shared/delegation-claim.ts`). Nothing here
 * reads, scans or classifies assistant text: a turn is shown as having
 * dispatched work only when the projection carries real dispatch facts, and
 * the rendered summary is bound to the exact authority ids those facts state.
 *
 * Three outcomes, and no fourth:
 *   - no projection            → render nothing at all (older daemons, non-SDK
 *                                runtimes, streaming events)
 *   - zero dispatch facts      → one neutral, factual indicator
 *   - one or more facts        → the count plus each dispatch's own ids
 */

import { useTranslation } from 'react-i18next';
import { readDelegationClaim } from '@shared/delegation-claim.js';
import type { SupervisionExecutionSummary } from '@shared/supervision-execution-summary.js';

export interface DelegationClaimBadgeProps {
  /** Metadata record of a completed assistant message. */
  metadata?: Record<string, unknown>;
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
 * One line, facts only, in the order a reader scans them: who, then what it
 * runs, then which lane. Absent facts are skipped rather than padded, so the
 * line never claims precision it does not have.
 */
export const formatExecutionSummary = (execution: SupervisionExecutionSummary): string => {
  const runtime = [execution.agentType, execution.providerFamily].filter(Boolean).join('/');
  return [
    execution.label && execution.label !== execution.sessionName
      ? `${execution.label} (${execution.sessionName})`
      : execution.sessionName,
    runtime || undefined,
    execution.model,
    execution.pool,
    execution.assignmentStatus,
  ].filter(Boolean).join(' · ');
};

export function DelegationClaimBadge({ metadata }: DelegationClaimBadgeProps) {
  const { t } = useTranslation();
  const claim = readDelegationClaim(metadata);
  if (!claim) return null;

  // Authority comes from the facts, not from the label on them. A projection
  // that claims `substantiated` while carrying zero dispatch facts states
  // nothing a user could act on, so it is presented as no authority.
  const dispatches = Array.isArray(claim.dispatches) ? claim.dispatches : [];
  const substantiated = claim.status === 'substantiated' && dispatches.length > 0;

  if (!substantiated) {
    return (
      <div
        class="delegation-claim delegation-claim-unsubstantiated"
        data-delegation-claim="unsubstantiated"
      >
        {t('delegation.claim.none', 'No authorized dispatch in this turn')}
      </div>
    );
  }

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
        {dispatches.map((dispatch) => (
          <li
            key={dispatch.dispatchId}
            class="delegation-claim-dispatch"
            data-delegation-dispatch={dispatch.dispatchId}
          >
            <span class="delegation-claim-id" data-delegation-field="dispatchId">
              {t('delegation.claim.dispatch_id', 'Dispatch ID')}
              {': '}
              <code>{dispatch.dispatchId}</code>
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
            {executionOf(dispatch) ? (
              <span class="delegation-claim-execution" data-delegation-field="execution">
                {t('delegation.claim.execution', 'Runs on')}
                {': '}
                <code>{formatExecutionSummary(executionOf(dispatch)!)}</code>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
