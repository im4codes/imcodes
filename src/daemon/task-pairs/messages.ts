/**
 * Model-facing text of daemon-authored pair messages. Short, referencing the
 * registered contracts by id; the marker line template rides along because
 * process sessions have no stable system prompt carrying the contract body.
 */
import { AUDIT_CONVERGENCE_CONTRACT_ID, type AuditSeverity } from '../../../shared/audit-convergence.js';
import {
  TASK_PAIR_BRAIN_REPORTING_RULE,
  TASK_PAIR_BRIEF_END_TAG,
  TASK_PAIR_CONTRACT_ID,
  TASK_PAIR_MARKER_TAG,
  TASK_PAIR_NO_AUDITOR,
  TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE,
  TASK_PAIR_WORKS_DIR,
  TASK_PAIR_WORKSPACE_RULES,
  formatTaskPairSeverityCounts,
  type TaskPairFlag,
  type TaskPairSeverityCounts,
  type TaskPairState,
  type TaskPairVerdictJudgement,
} from '../../../shared/task-pair.js';
import type { ResolvedTaskPairMaterial } from './material.js';

function marker(verb: string, taskId: string, attrs = ''): string {
  return `<!-- ${TASK_PAIR_MARKER_TAG} ${verb} ${taskId}${attrs ? ` ${attrs}` : ''} -->`;
}

function contracts(blocking: readonly AuditSeverity[]): string {
  return `[Contracts: ${TASK_PAIR_CONTRACT_ID}, ${AUDIT_CONVERGENCE_CONTRACT_ID} blocking=${blocking.join(',')}]`;
}

/**
 * Said in every executor/auditor instruction: agents that worked under the old
 * supervision engine otherwise wait for artifacts a pair never has.
 */
export const NO_LEGACY_ARTIFACTS = 'This pair has no assignmentId, auditAttemptId, auditRevision, immutable bundle or scopeFiles; do not wait for or ask for them.';

function materialLine(material: ResolvedTaskPairMaterial | TaskPairState['material'] | undefined): string | undefined {
  if (material?.path && !material.worktree && !material.head) {
    return `Material: task directory ${material.path}. Read the files there directly; there is no git HEAD.`;
  }
  if (!material || (!material.worktree && !material.head)) return undefined;
  const base = material.base ?? '<base: ask the executor, or use the merge base with the target branch>';
  const where = material.worktree ?? '<executor worktree>';
  const head = material.head ?? 'HEAD';
  return `Material: worktree ${where} · head ${head}${material.base ? ` · base ${material.base}` : ''}. Read it directly: git -C ${where} diff ${base}..${head} (uncommitted work: git -C ${where} diff).`;
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
    `DONE without a PASS is not complete. Send your validation to auditor ${pair.auditor ?? '(being assigned)'} with send_message, then write ${readyMarker(pair)}. After the auditor's PASS, commit/push and write DONE.`,
    contracts(pair.blocking),
  ].join('\n');
}

export function buildReworkNoticeMessage(pair: TaskPairState, counts: TaskPairSeverityCounts): string {
  return [
    header(pair),
    `Auditor ${pair.auditor} returned REWORK (${formatTaskPairSeverityCounts(counts)}; blocking=${pair.blocking.join(',')}). Their findings are in their reply to you.`,
    'Fix every blocking finding for its whole class (every affected instance, with a counterexample test), not as a point patch. Non-blocking findings are follow-ups.',
    `Then resend your validation to the auditor and write ${readyMarker(pair)} with the new head; the re-audit checks only the prior blocking classes plus regressions.`,
    contracts(pair.blocking),
  ].join('\n');
}

const FLAG_EXPLANATIONS: Partial<Record<TaskPairFlag, string>> = {
  verdict_inconsistent: 'the auditor keeps issuing verdicts inconsistent with the severity rules',
  awaiting_audit_ignored: 'the executor keeps writing DONE without getting a PASS',
  replacement_churn: 'the executor keeps reporting the auditor as blocked',
  markers_unresolved: 'markers with task id "-" cannot be matched to one task',
  executor_silent: 'the executor has been silent for 3 heartbeats',
  needs_auditor: 'no auditor could be found or provisioned from the pool',
  economy_unreviewed: 'economy-pool work was passed by an auditor outside the primary pool',
  waiting_for_capacity: 'no allowlisted pool session is free to take the next queued task',
  all_providers_limited: 'every eligible session across every provider family is currently limited',
  auditor_capacity_hold: 'the auditor keeps hitting a provider capacity error and is being retried on the same session, never switched',
  blocked: 'a participant reported being blocked',
  needs_input: 'a participant is waiting on input',
};

export function buildBrainNoticeMessage(pair: TaskPairState, flag: TaskPairFlag, detail?: string): string {
  // A passed pair only needs the executor's commit/push and DONE: another
  // executor can finish it, while DONE force=true would close it uncommitted.
  const resolve = flag === 'executor_silent' && pair.status === 'passed'
    ? `The audit already passed; only commit/push and DONE remain. Wait for the executor, or hand it to another session with ${marker('REASSIGN', pair.taskId, 'executor=<session>')}. Use ${marker('DONE', pair.taskId, 'force=true')} only once the work is committed.`
    : `Resolve with a marker, e.g. ${marker('REASSIGN', pair.taskId, 'auditor=<session>')}, ${marker('DONE', pair.taskId, 'force=true')}, or ${marker('CANCEL', pair.taskId)}.`;
  return [
    header(pair),
    `Needs your decision: ${FLAG_EXPLANATIONS[flag] ?? flag}. Executor ${pair.executor ?? '-'}, auditor ${pair.auditor ?? '-'}, status ${pair.status}, round ${pair.round}.`,
    ...(detail ? [`Why: ${detail}.`] : []),
    resolve,
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
  ].join('\n');
}

export interface PendingBrainNotice {
  pair: TaskPairState;
  flag: TaskPairFlag;
  detail?: string;
}

/**
 * One heartbeat can find several of a Brain's pairs needing a decision at
 * once (an auditor pool outage, several imports missing an auditor). One
 * combined message, not one per pair -- the single-pair case still uses
 * {@link buildBrainNoticeMessage} unchanged.
 */
export function buildAggregatedBrainNoticeMessage(notices: readonly PendingBrainNotice[]): string {
  const lines = notices.map(({ pair, flag, detail }) => (
    `- ${pair.taskId}${pair.title ? ` "${pair.title}"` : ''}: ${detail ?? FLAG_EXPLANATIONS[flag] ?? flag}. Executor ${pair.executor ?? '-'}, auditor ${pair.auditor ?? '-'}, status ${pair.status}.`
  ));
  return [
    `[IM.codes task pairs] Needs your decision on ${notices.length} pairs:`,
    ...lines,
    `Resolve each with a marker, e.g. ${marker('REASSIGN', '<taskId>', 'auditor=<session>')}, ${marker('DONE', '<taskId>', 'force=true')}, or ${marker('CANCEL', '<taskId>')}. No further reminders until each pair's state changes.`,
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
  ].join('\n');
}

/**
 * One combined, rate-limited notice for queued pairs that have been unable
 * to start for a long time (owner correction: an ordinary, self-resolving
 * queue miss gets no per-pair notice at all; see scheduler.ts#checkQueueStalls).
 */
export function buildQueueStallNoticeMessage(pairs: readonly Pick<TaskPairState, 'taskId' | 'title' | 'executor' | 'auditor' | 'updatedAt'>[], now: number): string {
  const lines = pairs.map((pair) => {
    const minutes = Math.max(1, Math.round((now - pair.updatedAt) / 60_000));
    const waitingFor = !pair.executor ? 'an executor' : (!pair.auditor || pair.auditor === TASK_PAIR_NO_AUDITOR) ? 'an auditor' : 'a session';
    return `- ${pair.taskId}${pair.title ? ` "${pair.title}"` : ''}: waiting ~${minutes}m for ${waitingFor} from the pool.`;
  });
  return [
    `[IM.codes task pairs] ${pairs.length} queued pair(s) have been unable to start for a while:`,
    ...lines,
    'Check Settings → execution pool (pool roles, capacity) if this persists, or name a session/model on the pair directly with REASSIGN.',
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
  ].join('\n');
}

/** To the executor of a pair that was imported as passed without any audit. */
export function buildLegacyImportCorrectionMessage(pair: TaskPairState): string {
  const auditor = pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? `auditor ${pair.auditor}` : 'the auditor being assigned';
  return [
    header(pair),
    'Correction: this task was imported from the old supervision engine as passed, but it never had an audit PASS. Disregard any earlier "PASS received: commit/push" message for it and do not commit/push it yet.',
    `Send your validation to ${auditor} with send_message, then write ${readyMarker(pair)}. After the auditor's PASS, commit/push and write DONE.`,
    contracts(pair.blocking),
  ].join('\n');
}

/** One line to Brain listing the imports corrected on this pass. */
export function buildLegacyImportCorrectionBrainLine(taskIds: readonly string[]): string {
  return `[IM.codes task pairs] ${taskIds.length} imported legacy task(s) were marked passed without any audit PASS and are now back in audit: ${taskIds.join(', ')}. Each gets an auditor from the pool within your concurrency limit; no action needed.`;
}

export function buildBriefEndHint(taskId: string): string {
  return `<!-- ${TASK_PAIR_BRIEF_END_TAG} ${taskId} -->`;
}

export { marker as formatTaskPairMarker };

export function buildNudgeMessage(pair: TaskPairState, side: 'executor' | 'auditor', unresolvedHint?: string): string {
  const lines = [header(pair)];
  if (side === 'auditor') {
    lines.push(`Audit pending for executor ${pair.executor}. Judge the executor's workspace and their reported validation, reply to them with every finding tagged [P0]..[P4], then write ${marker('PASS', pair.taskId, `blocking=${pair.blocking.join(',')}`)} or ${marker('REWORK', pair.taskId, `blocking=${pair.blocking.join(',')} p0=<n> ...`)}.`);
    const where = materialLine(pair.material);
    if (where) lines.push(where);
    lines.push(`${NO_LEGACY_ARTIFACTS} If the material cannot be reached, write ${marker('NEEDS_INPUT', pair.taskId, 'note="..."')} and wait; that is never a P0.`);
    if (pair.round > 1 && pair.lastVerdict?.verb === 'REWORK') {
      lines.push(`Re-audit (round ${pair.round}): check only closure of the previous blocking classes (${formatTaskPairSeverityCounts(pair.lastVerdict.counts)}) plus regressions; do not raise new non-blocking items to REWORK.`);
    }
  } else {
    const next = pair.status === 'passed'
      ? `PASS received: commit/push your work, then write ${marker('DONE', pair.taskId)}.`
      : pair.status === 'awaiting_audit'
        ? `DONE without a PASS is not complete: send your validation to auditor ${pair.auditor}, then write ${readyMarker(pair)}.`
        : pair.status === 'rework'
          ? `Address the auditor's blocking findings for their whole class, resend, then write ${marker('READY_FOR_AUDIT', pair.taskId)}.`
          : pair.auditor === 'none'
            ? `Continue the task; write ${marker('DONE', pair.taskId)} when finished.`
            : `Continue the task. When ready, send your validation to auditor ${pair.auditor}, then write ${readyMarker(pair)}.`;
    lines.push(`Idle with no progress. ${next} If stuck write ${marker('BLOCKED', pair.taskId, 'note="..."')}. ${NO_LEGACY_ARTIFACTS}`);
  }
  if (unresolvedHint) lines.push(unresolvedHint);
  lines.push(contracts(pair.blocking));
  return lines.join('\n');
}

export function buildAuditorHandoffMessage(pair: TaskPairState): string {
  const previous = pair.lastVerdict ? ` Previous verdict: ${pair.lastVerdict.verb} (${formatTaskPairSeverityCounts(pair.lastVerdict.counts)}).` : '';
  const where = materialLine(pair.material);
  return [
    header(pair),
    `You are now the auditor of this task for executor ${pair.executor} (round ${Math.max(1, pair.round)}; blocking=${pair.blocking.join(',')}).${previous}`,
    `The material is the executor's workspace named on READY_FOR_AUDIT (a worktree at a head, or a task-directory path; relayed to you), plus the validation they send you. Judge it by ${AUDIT_CONVERGENCE_CONTRACT_ID}, reply to the executor with every finding tagged [P0]..[P4], then write ${marker('PASS', pair.taskId, `blocking=${pair.blocking.join(',')}`)} or ${marker('REWORK', pair.taskId, `blocking=${pair.blocking.join(',')} p0=<n> ...`)}.`,
    ...(where ? [where] : []),
    `${NO_LEGACY_ARTIFACTS} If the material cannot be reached, write ${marker('NEEDS_INPUT', pair.taskId, 'note="..."')} and wait; that is never a P0.`,
    contracts(pair.blocking),
  ].join('\n');
}

/** An audit round opened: exactly where the material is, resolved by the daemon. */
export function buildAuditRequestMessage(pair: TaskPairState, material: ResolvedTaskPairMaterial): string {
  const where = materialLine(material)
    ?? `Material: the executor did not name a workspace and none could be resolved; ask ${pair.executor} for its worktree path and head, or its task-directory path.`;
  return [
    header(pair),
    `Audit request, round ${Math.max(1, pair.round)}, from executor ${pair.executor} (blocking=${pair.blocking.join(',')}).`,
    `${where}${material.source === 'workspace' ? ' (resolved by the daemon from the executor session)' : ''}`,
    `Their validation (full suites for code) comes from them via send_message. Judge by ${AUDIT_CONVERGENCE_CONTRACT_ID}, reply to the executor with every finding tagged [P0]..[P4], then write ${marker('PASS', pair.taskId, `blocking=${pair.blocking.join(',')}`)} or ${marker('REWORK', pair.taskId, `blocking=${pair.blocking.join(',')} p0=<n> ...`)}.`,
    `${NO_LEGACY_ARTIFACTS} If the material cannot be reached (executor limited/offline, workspace unreadable), write ${marker('NEEDS_INPUT', pair.taskId, 'note="..."')} and wait; that is never a P0 or REWORK.`,
    contracts(pair.blocking),
  ].join('\n');
}

/**
 * Sent to the executor when Brain opens a pair (DISPATCH marker or a plain
 * dispatch) -- every path OTHER than the queue runner's own auto-dispatch
 * (scheduler.ts sends `${pair.brief}${trailer}` directly there). Without the
 * stored brief here too, a DISPATCH on an already-queued pair, a REASSIGN of
 * the executor, or a re-dispatch of a cancelled/done pair left the executor
 * with only the title and boilerplate -- the actual brief Brain wrote never
 * reached them (owner report, tsk_cd_upgrade_starvation: QUEUE with a brief,
 * then REASSIGN, then DISPATCH named windows -- brief never arrived).
 */
export function buildExecutorPairBrief(pair: TaskPairState): string {
  const auditor = pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? `auditor ${pair.auditor}` : pair.auditor === TASK_PAIR_NO_AUDITOR ? 'no auditor' : 'an auditor the daemon is assigning';
  return [
    header(pair),
    ...(pair.brief ? [pair.brief] : []),
    `You are the executor of this task pair, with ${auditor}. Write ${marker('STARTED', pair.taskId)} when you begin.`,
    workplaceLine(pair),
    pair.auditor === TASK_PAIR_NO_AUDITOR
      ? `No audit window for this pair -- do proportionate self-validation instead (full suites for code), then commit/push code yourself if this is code. Report straight to Brain in the same closing reply as your ${marker('DONE', pair.taskId)}: what changed, your worktree/branch/HEAD (or file paths for non-code work), and your validation result. The daemon relays that reply to Brain as the completion notice, so write it as if Brain will read only that.`
      : `When done, send the auditor your validation (full suites for code) with send_message and write ${readyMarker(pair)}; the daemon relays that to the auditor. After their PASS, commit/push code and write ${marker('DONE', pair.taskId)}.`,
    TASK_PAIR_WORKSPACE_RULES,
    NO_LEGACY_ARTIFACTS,
    contracts(pair.blocking),
  ].join('\n');
}

/**
 * Where the executor works: the workspace the daemon created for the pair (a
 * worktree or a task directory), or, if none could be created, its own.
 */
function workplaceLine(pair: TaskPairState): string {
  const workspace = pair.workspace;
  if (workspace && workspace.status === 'active') {
    return workspace.kind === 'dir'
      ? `Work in the task directory the daemon created for this pair: ${workspace.path}. Write your results there.`
      : `Work in the worktree the daemon created for this pair: ${workspace.path} (detached at base ${workspace.base ?? 'HEAD'}; make a branch there, commit and push it).`;
  }
  return `No workspace could be created for this pair: use your own git worktree under ~/.imcodes/worktrees for code in a git project, else a task directory under ~/.imcodes/${TASK_PAIR_WORKS_DIR}/<project>/${pair.taskId}/, and name it on READY_FOR_AUDIT.`;
}

/** Brain: a finished pair's worktree still held unsaved work at removal time, so it was kept. */
export function buildWorkspaceKeptLine(pair: TaskPairState, reason: string): string {
  const why = reason === 'unpushed' ? 'has commits no remote has' : reason === 'dirty' ? 'has uncommitted changes' : reason === 'untracked' ? 'has untracked files' : `could not be checked (${reason})`;
  return `${header(pair)} The pair ended 7 days ago but its worktree ${pair.workspace?.path ?? ''} ${why}, so it was kept instead of deleted. Have ${pair.executor ?? 'the executor'} commit/push what should survive; it is removed once it is clean.`;
}

const OUTPUT_FAILURES: Record<string, string> = {
  no_workspace: 'the pair has no workspace to copy from',
  no_project: 'the project directory is unknown',
  missing: 'the named output does not exist in the workspace',
  outside_workspace: 'the named output is outside the workspace',
  outside_project: 'the destination is outside the project directory',
  exists: 'every destination name is taken',
  copy_failed: 'the copy failed',
};

/** Brain: DONE asked to keep a deliverable and it could not be copied. */
export function buildOutputFailedLine(pair: TaskPairState, reason: string): string {
  const output = pair.output ? `${pair.output.path}${pair.output.dest ? ` -> ${pair.output.dest}` : ''}` : '';
  return `${header(pair)} The deliverable ${output} was not copied into the project: ${OUTPUT_FAILURES[reason] ?? reason}. It stays in ${pair.workspace?.path ?? 'the workspace'} for 7 days; copy it yourself or have the executor fix the path.`;
}

function readyMarker(pair: TaskPairState): string {
  return pair.workspace?.kind === 'dir'
    ? marker('READY_FOR_AUDIT', pair.taskId, 'path=<the task directory or the result files>')
    : marker('READY_FOR_AUDIT', pair.taskId, 'worktree=<absolute path> head=<commit> base=<commit>');
}

export function buildExecutorResendMessage(pair: TaskPairState, previousAuditor: string | undefined): string {
  return [
    header(pair),
    `Your auditor changed${previousAuditor ? ` from ${previousAuditor}` : ''} to ${pair.auditor}. Resend your validation to ${pair.auditor} with send_message, then write ${readyMarker(pair)} if you have not already.`,
    contracts(pair.blocking),
  ].join('\n');
}

/** Sent to a new executor taking over an in-progress pair (e.g. the previous executor hit a provider limit). */
export function buildExecutorHandoffMessage(pair: TaskPairState, previousExecutor: string | undefined, reason: string): string {
  const auditor = pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? `, auditor ${pair.auditor}` : '';
  const next = pair.status === 'rework'
    ? `Address the auditor's blocking findings for their whole class, resend, then write ${marker('READY_FOR_AUDIT', pair.taskId)}.`
    : pair.status === 'in_audit' || pair.status === 'awaiting_audit'
      ? `The audit is already underway on your predecessor's material. If you need to change it materially, tell the auditor and write ${marker('READY_FOR_AUDIT', pair.taskId)} again once it is updated.`
      : `Continue the task. When ready, send the auditor your validation (full suites for code) with send_message and write ${readyMarker(pair)}.`;
  return [
    header(pair),
    `You are now the executor of this task${previousExecutor ? `, taking over from ${previousExecutor}` : ''} (${reason}). Round ${Math.max(1, pair.round)}, status ${pair.status}${auditor}.`,
    workplaceLine(pair),
    next,
    TASK_PAIR_WORKSPACE_RULES,
    NO_LEGACY_ARTIFACTS,
    contracts(pair.blocking),
  ].join('\n');
}

export function buildDispatchTrailer(pair: TaskPairState): string {
  return [
    '',
    `[IM.codes task ${pair.taskId} · auditor: ${pair.auditor ?? 'none'}] Write ${marker('STARTED', pair.taskId)} when you begin and finish with ${readyMarker(pair)}; follow ${TASK_PAIR_CONTRACT_ID} and ${AUDIT_CONVERGENCE_CONTRACT_ID} (blocking=${pair.blocking.join(',')}). ${workplaceLine(pair)} ${TASK_PAIR_WORKSPACE_RULES} ${NO_LEGACY_ARTIFACTS}`,
    TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE,
    TASK_PAIR_BRAIN_REPORTING_RULE,
  ].join('\n');
}

export function buildAuditorAssignmentMessage(pair: TaskPairState): string {
  return [
    header(pair),
    `You are the auditor of this task for executor ${pair.executor}. On READY_FOR_AUDIT the daemon relays their workspace (worktree and head, or task-directory path), and they send you their validation; judge that by ${AUDIT_CONVERGENCE_CONTRACT_ID} (blocking=${pair.blocking.join(',')}) and write PASS or REWORK with severity counts.`,
    NO_LEGACY_ARTIFACTS,
    contracts(pair.blocking),
    TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE,
    TASK_PAIR_BRAIN_REPORTING_RULE,
  ].join('\n');
}

export function buildBrainLine(pair: TaskPairState, text: string): string {
  return `${header(pair)} ${text}`;
}

/**
 * Relayed to Brain when the executor writes DONE on a pair with no auditor:
 * there is no PASS to report instead, so this is the only completion notice
 * Brain gets and the daemon sends it without being asked, so Brain never has
 * to poll a no-auditor pair to learn it finished.
 */
export function buildNoAuditorDoneNotice(pair: TaskPairState, executorSummary: string): string {
  const summary = executorSummary.trim();
  return `${header(pair)} DONE from executor ${pair.executor ?? '(unknown)'}, no auditor for this pair.${
    summary ? `\n\n${summary}` : ' (no summary text in the closing reply)'
  }`;
}
