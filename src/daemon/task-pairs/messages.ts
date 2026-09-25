/**
 * Model-facing text of daemon-authored pair messages. Short, referencing the
 * registered contracts by id; the marker line template rides along because
 * process sessions have no stable system prompt carrying the contract body.
 */
import { AUDIT_CONVERGENCE_CONTRACT_ID, type AuditSeverity } from '../../../shared/audit-convergence.js';
import {
  TASK_PAIR_BRIEF_END_TAG,
  TASK_PAIR_CONTRACT_ID,
  TASK_PAIR_MARKER_TAG,
  formatTaskPairSeverityCounts,
  type TaskPairFlag,
  type TaskPairSeverityCounts,
  type TaskPairState,
  type TaskPairVerdictJudgement,
} from '../../../shared/task-pair.js';

function marker(verb: string, taskId: string, attrs = ''): string {
  return `<!-- ${TASK_PAIR_MARKER_TAG} ${verb} ${taskId}${attrs ? ` ${attrs}` : ''} -->`;
}

function contracts(blocking: readonly AuditSeverity[]): string {
  return `[Contracts: ${TASK_PAIR_CONTRACT_ID}, ${AUDIT_CONVERGENCE_CONTRACT_ID} blocking=${blocking.join(',')}]`;
}

function header(pair: TaskPairState): string {
  return `[IM.codes task ${pair.taskId}${pair.title ? ` "${pair.title}"` : ''}]`;
}

export function buildCorrectionMessage(pair: TaskPairState, judgement: TaskPairVerdictJudgement): string {
  const blocking = pair.blocking.join(',');
  const why = judgement === 'missing_severity'
    ? `your REWORK carries no severity. State the blocking set and a count per level`
    : pair.lastVerdict?.verb === 'PASS'
      ? `a PASS cannot carry a finding at a blocking severity (${blocking}). Issue REWORK, or re-rate the finding`
      : `a REWORK needs at least one finding at a blocking severity (${blocking}). Re-issue as PASS with the non-blocking items as follow-ups, or tag the blocking finding`;
  return [
    header(pair),
    `Your verdict was recorded but not applied: under ${AUDIT_CONVERGENCE_CONTRACT_ID} with blocking=${blocking}, ${why}.`,
    `Write it on its own line, e.g. ${marker('REWORK', pair.taskId, `blocking=${blocking} p0=1`)} or ${marker('PASS', pair.taskId, `blocking=${blocking}`)}`,
    contracts(pair.blocking),
  ].join('\n');
}

export function buildDoneReminderMessage(pair: TaskPairState): string {
  return [
    header(pair),
    `DONE without a PASS is not complete. Send your materials to auditor ${pair.auditor ?? '(being assigned)'} with send_message, then write ${marker('READY_FOR_AUDIT', pair.taskId)}. After the auditor's PASS, commit/push and write DONE.`,
    contracts(pair.blocking),
  ].join('\n');
}

export function buildReworkNoticeMessage(pair: TaskPairState, counts: TaskPairSeverityCounts): string {
  return [
    header(pair),
    `Auditor ${pair.auditor} returned REWORK (${formatTaskPairSeverityCounts(counts)}; blocking=${pair.blocking.join(',')}). Their findings are in their reply to you.`,
    'Fix every blocking finding for its whole class (every affected instance, with a counterexample test), not as a point patch. Non-blocking findings are follow-ups.',
    `Then resend to the auditor and write ${marker('READY_FOR_AUDIT', pair.taskId)}; the re-audit checks only the prior blocking classes plus regressions.`,
    contracts(pair.blocking),
  ].join('\n');
}

const FLAG_EXPLANATIONS: Partial<Record<TaskPairFlag, string>> = {
  verdict_inconsistent: 'the auditor keeps issuing verdicts inconsistent with the severity rules',
  awaiting_audit_ignored: 'the executor keeps writing DONE without getting a PASS',
  replacement_churn: 'the executor keeps reporting the auditor as blocked',
  markers_unresolved: 'markers with task id "-" cannot be matched to one task',
  executor_silent: 'the executor has been silent for 3 heartbeats or hit a usage limit',
  needs_auditor: 'no auditor could be found or provisioned from the pool',
  economy_unreviewed: 'economy-pool work was passed by an auditor outside the primary pool',
  waiting_for_capacity: 'no allowlisted pool session is free to take the next queued task',
};

export function buildBrainNoticeMessage(pair: TaskPairState, flag: TaskPairFlag): string {
  return [
    header(pair),
    `Needs your decision: ${FLAG_EXPLANATIONS[flag] ?? flag}. Executor ${pair.executor ?? '-'}, auditor ${pair.auditor ?? '-'}, status ${pair.status}, round ${pair.round}.`,
    `Resolve with a marker, e.g. ${marker('REASSIGN', pair.taskId, 'auditor=<session>')}, ${marker('DONE', pair.taskId, 'force=true')}, or ${marker('CANCEL', pair.taskId)}.`,
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
  ].join('\n');
}

export function buildBriefEndHint(taskId: string): string {
  return `<!-- ${TASK_PAIR_BRIEF_END_TAG} ${taskId} -->`;
}

export { marker as formatTaskPairMarker };

export function buildNudgeMessage(pair: TaskPairState, side: 'executor' | 'auditor', unresolvedHint?: string): string {
  const lines = [header(pair)];
  if (side === 'auditor') {
    lines.push(`Audit pending for executor ${pair.executor}. Judge the materials they sent you, reply to them with every finding tagged [P0]..[P4], then write ${marker('PASS', pair.taskId, `blocking=${pair.blocking.join(',')}`)} or ${marker('REWORK', pair.taskId, `blocking=${pair.blocking.join(',')} p0=<n> ...`)}.`);
    if (pair.round > 1 && pair.lastVerdict?.verb === 'REWORK') {
      lines.push(`Re-audit (round ${pair.round}): check only closure of the previous blocking classes (${formatTaskPairSeverityCounts(pair.lastVerdict.counts)}) plus regressions; do not raise new non-blocking items to REWORK.`);
    }
  } else {
    const next = pair.status === 'passed'
      ? `PASS received: commit/push your work, then write ${marker('DONE', pair.taskId)}.`
      : pair.status === 'awaiting_audit'
        ? `DONE without a PASS is not complete: send your materials to auditor ${pair.auditor}, then write ${marker('READY_FOR_AUDIT', pair.taskId)}.`
        : pair.status === 'rework'
          ? `Address the auditor's blocking findings for their whole class, resend, then write ${marker('READY_FOR_AUDIT', pair.taskId)}.`
          : pair.auditor === 'none'
            ? `Continue the task; write ${marker('DONE', pair.taskId)} when finished.`
            : `Continue the task. When ready, send your materials to auditor ${pair.auditor}, then write ${marker('READY_FOR_AUDIT', pair.taskId)}.`;
    lines.push(`Idle with no progress. ${next} If stuck write ${marker('BLOCKED', pair.taskId, 'note="..."')}.`);
  }
  if (unresolvedHint) lines.push(unresolvedHint);
  lines.push(contracts(pair.blocking));
  return lines.join('\n');
}

export function buildAuditorHandoffMessage(pair: TaskPairState): string {
  const previous = pair.lastVerdict ? ` Previous verdict: ${pair.lastVerdict.verb} (${formatTaskPairSeverityCounts(pair.lastVerdict.counts)}).` : '';
  return [
    header(pair),
    `You are now the auditor of this task for executor ${pair.executor} (round ${Math.max(1, pair.round)}; blocking=${pair.blocking.join(',')}).${previous}`,
    `The executor will resend its materials to you. Judge them by ${AUDIT_CONVERGENCE_CONTRACT_ID}, reply to the executor with every finding tagged [P0]..[P4], then write ${marker('PASS', pair.taskId, `blocking=${pair.blocking.join(',')}`)} or ${marker('REWORK', pair.taskId, `blocking=${pair.blocking.join(',')} p0=<n> ...`)}.`,
    contracts(pair.blocking),
  ].join('\n');
}

export function buildExecutorResendMessage(pair: TaskPairState, previousAuditor: string | undefined): string {
  return [
    header(pair),
    `Your auditor changed${previousAuditor ? ` from ${previousAuditor}` : ''} to ${pair.auditor}. Resend your materials to ${pair.auditor} with send_message, then write ${marker('READY_FOR_AUDIT', pair.taskId)} if you have not already.`,
    contracts(pair.blocking),
  ].join('\n');
}

export function buildDispatchTrailer(pair: TaskPairState): string {
  return [
    '',
    `[IM.codes task ${pair.taskId} · auditor: ${pair.auditor ?? 'none'}] Write ${marker('STARTED', pair.taskId)} when you begin; follow ${TASK_PAIR_CONTRACT_ID} and ${AUDIT_CONVERGENCE_CONTRACT_ID} (blocking=${pair.blocking.join(',')}).`,
  ].join('\n');
}

export function buildAuditorAssignmentMessage(pair: TaskPairState): string {
  return [
    header(pair),
    `You are the auditor of this task for executor ${pair.executor}. They will send you their materials; judge them by ${AUDIT_CONVERGENCE_CONTRACT_ID} (blocking=${pair.blocking.join(',')}) and write PASS or REWORK with severity counts.`,
    contracts(pair.blocking),
  ].join('\n');
}

export function buildBrainLine(pair: TaskPairState, text: string): string {
  return `${header(pair)} ${text}`;
}
