/**
 * Model-facing text of daemon-authored pair messages. Short, referencing the
 * registered contracts by id; the marker line template rides along because
 * process sessions have no stable system prompt carrying the contract body.
 */
import { AUDIT_CONVERGENCE_CONTRACT_ID, type AuditSeverity } from '../../../shared/audit-convergence.js';
import {
  TASK_PAIR_ASK_DONT_JUST_REPLY_RULE,
  TASK_PAIR_AUDITOR_PROPOSAL_RULE,
  TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE,
  TASK_PAIR_NO_INTERMEDIATE_BRAIN_UPDATES_RULE,
  TASK_PAIR_VALIDATION_REPORT_RULE,
  TASK_PAIR_BRAIN_REPORTING_RULE,
  TASK_PAIR_BRAIN_REPLY_RESOLUTION_RULE,
  TASK_PAIR_BRIEF_END_TAG,
  TASK_PAIR_CONTRACT_ID,
  TASK_PAIR_CHECKLIST_RULE,
  TASK_PAIR_MARKER_TAG,
  TASK_PAIR_NO_AUDITOR,
  TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE,
  TASK_PAIR_TITLE_RULE,
  TASK_PAIR_TITLE_MARKER_RULE,
  TASK_PAIR_WORKS_DIR,
  TASK_PAIR_WORKSPACE_RULES,
  formatTaskPairSeverityCounts,
  taskPairDeliveryRound,
  type TaskPairFlag,
  type TaskPairSeverityCounts,
  type TaskPairState,
  type TaskPairVerdictJudgement,
} from '../../../shared/task-pair.js';
import type { ResolvedTaskPairMaterial, TaskPairRoundBaseCheck } from './material.js';
import { parseTaskPairChecklist } from '../../../shared/task-pair-checklist.js';

/**
 * Bare, never backtick-wrapped: this is copied verbatim onto its own line by
 * the agent it's shown to (executor/auditor instructions, and Brain copying
 * a QUEUE/DISPATCH example), and `MARKER_LINE_RE` only accepts a bare
 * `<!-- ... -->` line (shared/task-pair.ts) -- a wrapped copy silently fails
 * to parse and the pair hangs (r1 audit regression). The web's font-ligature
 * rendering of `<!--`/`-->` ("←!——…——→") is fixed at the CSS level instead
 * (body { font-variant-ligatures: none }), which covers plain text exactly
 * as well as a code span.
 */
function marker(verb: string, taskId: string, attrs = ''): string {
  return `<!-- ${TASK_PAIR_MARKER_TAG} ${verb} ${taskId}${attrs ? ` ${attrs}` : ''} -->`;
}

function contracts(blocking: readonly AuditSeverity[]): string {
  return `[Contracts: ${TASK_PAIR_CONTRACT_ID}, ${AUDIT_CONVERGENCE_CONTRACT_ID} blocking=${blocking.join(',')}]`;
}

export function buildUntitledTaskTitleRequest(
  taskIds: readonly string[],
  locale?: string,
): string {
  const language = locale ? ` in the owner's UI language (${locale})` : ' in the owner\'s UI language';
  return [
    `[IM.codes task titles] Please assign short, specific titles${language} for: ${taskIds.join(', ')}.`,
    'Reply with one title-only update per non-terminal task, preferably via pair_task_update({taskId,title}). If using a marker, use only <!-- IMCODES_TASK DISPATCH tsk_demo title="Fix login retry" -->; this updates metadata without changing the brief or lifecycle and never reopens a cancelled/done pair.',
    TASK_PAIR_TITLE_RULE,
    TASK_PAIR_TITLE_MARKER_RULE,
    'This is one batched reminder; do not retry immediately. Use pair_task_update with {taskId, title} if preferred.',
  ].join('\n');
}

/** Plain-English statement of the pair's effective blocking set, for briefs and assignment messages. */
function blockingSummaryLine(pair: TaskPairState): string {
  return `Blocking = ${pair.blocking.join(',')}: every finding at these levels must be fixed before PASS.`;
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
    `DONE without a PASS is not complete. Send your validation to auditor ${pair.auditor ?? '(being assigned)'} with send_message, then write ${readyMarker(pair)}. After the auditor's PASS, commit locally in the worktree (never push any branch), report the worktree path and HEAD to Brain, then write DONE; Brain merges into dev and pushes dev.`,
    contracts(pair.blocking),
  ].join('\n');
}

/**
 * State handoff sent after a participant runtime/process restart.  This is
 * intentionally self-contained: a restarted participant must not need the
 * old prompt, cwd, or a Brain round-trip to recover its exact next action.
 */
export function buildParticipantRecoveryMessage(
  pair: TaskPairState,
  role: 'executor' | 'auditor',
  lastInstruction?: string,
): string {
  const workspace = pair.workspace;
  const location = workspace
    ? `Workspace: ${workspace.path} (absolute and authoritative; never use cwd or the project main checkout).`
      + ` Base: ${workspace.base ?? pair.material?.base ?? '(not recorded)'}.`
      + ` Latest head: ${workspace.lastHead ?? pair.material?.head ?? '(not recorded)'}.`
    : `Workspace: (not recorded; use the path named by the next READY_FOR_AUDIT, never cwd or the project main checkout).`;
  const incomplete = pair.brief
    ? parseTaskPairChecklist(pair.brief).filter((item) => !item.implemented).map((item) => `${item.index}. ${item.text}`)
    : [];
  const next = role === 'auditor'
    ? pair.status === 'in_audit'
      ? `Next: audit the executor material for round ${pair.round} and return PASS/REWORK.`
      : `Next: wait for the executor's READY_FOR_AUDIT for round ${pair.round}.`
    : pair.status === 'in_audit'
      ? `Next: if validation is complete, send the exact report to ${pair.auditor ?? 'the auditor'} and write READY_FOR_AUDIT for round ${pair.round}.`
      : pair.status === 'passed'
        ? `Next: commit locally, report the worktree and HEAD to Brain, then write DONE.`
        : `Next: continue the task and report material progress; do not wait for legacy supervision artifacts.`;
  const ready = workspace?.kind === 'worktree'
    ? `<!-- IMCODES_TASK READY_FOR_AUDIT ${pair.taskId} worktree=${workspace.path} head=${workspace.lastHead ?? pair.material?.head ?? '<commit>'} base=${workspace.base ?? pair.material?.base ?? '<commit>'} -->`
    : `<!-- IMCODES_TASK READY_FOR_AUDIT ${pair.taskId} path=${workspace?.path ?? '<task-directory>'} -->`;
  return [
    header(pair),
    `Participant recovery state (role=${role}, status=${pair.status}, round=${pair.round}${taskPairDeliveryRound(pair) > 1 ? `, delivery round=${taskPairDeliveryRound(pair)}` : ''}).`,
    location,
    incomplete.length > 0 ? `Unfinished checklist items: ${incomplete.join(' | ')}` : 'Unfinished checklist items: none recorded.',
    next,
    `If this is an audit-ready turn, use this exact marker format: ${ready}`,
    ...(lastInstruction ? [`Last daemon instruction before restart: ${lastInstruction}`] : []),
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

export function buildBrainReopenNoticeMessage(pair: TaskPairState, reason?: string): string {
  return [
    header(pair),
    `Brain reopened this pair and invalidated its previous PASS for the current head. The pair is now ${pair.status}; do not write DONE for the old passed head.`,
    ...(reason ? [`Reason: ${reason}`] : []),
    `Executor: ${pair.executor ?? '-'}, auditor: ${pair.auditor ?? '-'}. A fresh READY_FOR_AUDIT with a new head is required before the next PASS.`,
    contracts(pair.blocking),
  ].join('\n');
}

/** What Brain's NEXT_ROUND tells both participants: same pair, new delivery round, what it builds on. */
export function buildNextRoundNoticeMessage(pair: TaskPairState, note?: string): string {
  const round = taskPairDeliveryRound(pair);
  const base = pair.roundBase;
  return [
    header(pair),
    `Brain opened delivery round ${round} of this pair after the previous round's PASS. The pair is ${pair.status} again with the same workspace, executor ${pair.executor ?? '-'} and auditor ${pair.auditor ?? '-'}.`,
    ...(note ? [`Round ${round}: ${note}`] : []),
    base
      ? `Base for round ${round}: ${base.commit} (${base.source === 'brain' ? 'named by Brain' : "the previous round's PASSed head"}). Build on top of that commit; if it is not in your worktree yet, fetch it first.`
      : `No base commit is recorded for round ${round}; continue in the pair workspace.`,
    `Executor: do the round's work, commit locally, send your validation to the auditor, then write ${readyMarker(pair)} (a base= other than the round base is rejected; omit it and the daemon fills it in). Do not write DONE for the previous round's head.`,
    `Auditor: wait for the executor's READY_FOR_AUDIT for round ${round}; PASS/REWORK applies to that round's material only.`,
    contracts(pair.blocking),
  ].join('\n');
}

/** The auditor-facing line about the round base, or undefined for an ordinary first round. */
export function buildRoundBaseAuditLine(pair: TaskPairState, check: TaskPairRoundBaseCheck): string | undefined {
  if (check.status === 'none') return undefined;
  const round = taskPairDeliveryRound(pair);
  switch (check.status) {
    case 'ok': return `Delivery round ${round}: head ${check.head} descends from the round base ${check.base} (verified by the daemon).`;
    case 'same_as_base': return `Delivery round ${round}: head ${check.head} IS the round base ${check.base}: the executor made no new commit in this round. Judge whether that is intended.`;
    case 'unverifiable': return `Delivery round ${round}: the round base ${check.base} could not be verified against the head${check.head ? ` ${check.head}` : ''} (commit not present in the worktree, or no git). Check the ancestry yourself.`;
    default: return undefined;
  }
}

export function buildRoundBaseMismatchExecutorMessage(pair: TaskPairState, head: string, base: string): string {
  return [
    header(pair),
    `READY_FOR_AUDIT for delivery round ${taskPairDeliveryRound(pair)} was not relayed: head ${head} does not descend from the round base ${base}.`,
    `Rebase or merge your work onto ${base} (or ask Brain for NEXT_ROUND base=<commit> if the base is wrong), commit, and resend ${readyMarker(pair)} with the new head. PASS is held for this round until then.`,
  ].join('\n');
}

export function buildRoundBaseMismatchAuditorMessage(pair: TaskPairState, head: string, base: string): string {
  return [
    header(pair),
    `Delivery round ${taskPairDeliveryRound(pair)} material is not ready: head ${head} does not descend from the round base ${base}. The executor was asked to rebase and resend; wait for the resent audit request. PASS is held by the daemon until then (REWORK still applies).`,
  ].join('\n');
}

export function buildAuditorProposalNudgeMessage(pair: TaskPairState): string {
  return [
    header(pair),
    'Your REWORK did not include a concrete proposal in the findings.',
    TASK_PAIR_AUDITOR_PROPOSAL_RULE,
    `Keep the existing blocking set and resend the verdict; this reminder is capped to once for round ${pair.round}.`,
    contracts(pair.blocking),
  ].join('\n');
}

export function buildConvergenceCheckpointMessage(pair: TaskPairState): string {
  return [
    header(pair),
    TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE,
    `This is the round ${pair.round} checkpoint; do not send a status update if the pair is converging.`,
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
  no_pool_configured: 'this project has no execution pool configured and no model was named for this role',
  brain_reminder_due: 'the Brain has not yet handled this pair',
};

export function buildBrainNoticeMessage(pair: TaskPairState, flag: TaskPairFlag, detail?: string): string {
  // A passed pair only needs the executor's local commit and DONE: another
  // executor can finish it, while DONE force=true would close it uncommitted.
  const resolve = flag === 'executor_silent' && pair.status === 'passed'
    ? `The audit already passed; only a local worktree commit and DONE remain (never push any branch). Report the worktree path and HEAD to Brain; Brain merges into dev and pushes dev. Wait for the executor, or hand it to another session with ${marker('REASSIGN', pair.taskId, 'executor=<session>')}. Use ${marker('DONE', pair.taskId, 'force=true')} only once the work is committed.`
    : `Resolve with a marker, e.g. ${marker('REASSIGN', pair.taskId, 'auditor=<session>')}, ${marker('DONE', pair.taskId, 'force=true')}, or ${marker('CANCEL', pair.taskId)}.`;
  // BLOCKED/NEEDS_INPUT is sent as an immediate `brain_notice` intent (no
  // explicit detail argument, unlike the heartbeat escalation path) -- fall
  // back to the pair's own recorded note so Brain still sees why.
  const resolvedDetail = detail ?? ((flag === 'blocked' || flag === 'needs_input') ? pair.blockedNote : undefined);
  return [
    header(pair),
    `Needs your decision: ${FLAG_EXPLANATIONS[flag] ?? flag}. Executor ${pair.executor ?? '-'}, auditor ${pair.auditor ?? '-'}, status ${pair.status}, round ${pair.round}.`,
    ...(resolvedDetail ? [`Why: ${resolvedDetail}.`] : []),
    TASK_PAIR_BRAIN_REPLY_RESOLUTION_RULE,
    resolve,
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
  ].join('\n');
}

/**
 * A flag-driven notice explains itself from {@link FLAG_EXPLANATIONS}; a
 * plain-line notice (e.g. a queued pair with no brief -- there is no real
 * flag on the pair for that, just a one-off reminder text) carries its own
 * `text` and a delivery `reason` instead.
 */
export type PendingBrainFlagNotice = { pair: TaskPairState; flag: TaskPairFlag; detail?: string };
export type PendingBrainLineNotice = { pair: TaskPairState; text: string; reason: string };
export type PendingBrainNotice = PendingBrainFlagNotice | PendingBrainLineNotice;

/**
 * One heartbeat can find several of a Brain's pairs needing the same kind of
 * decision at once (an auditor pool outage, several imports missing an
 * auditor). One combined message, not one per pair -- the single-pair case
 * still uses {@link buildBrainNoticeMessage} unchanged.
 */
export function buildAggregatedBrainNoticeMessage(notices: readonly PendingBrainFlagNotice[]): string {
  const lines = notices.map(({ pair, flag, detail }) => (
    `- ${pair.taskId}${pair.title ? ` "${pair.title}"` : ''}: ${detail ?? FLAG_EXPLANATIONS[flag] ?? flag}. Executor ${pair.executor ?? '-'}, auditor ${pair.auditor ?? '-'}, status ${pair.status}.`
  ));
  return [
    `[IM.codes task pairs] Needs your decision on ${notices.length} pairs:`,
    ...lines,
    TASK_PAIR_BRAIN_REPLY_RESOLUTION_RULE,
    `Resolve each with a marker, e.g. ${marker('REASSIGN', '<taskId>', 'auditor=<session>')}, ${marker('DONE', '<taskId>', 'force=true')}, or ${marker('CANCEL', '<taskId>')}. No further reminders until each pair's state changes.`,
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
  ].join('\n');
}

/**
 * One concise, deduplicated heartbeat for a project's Brain.  Participant
 * nudges continue to use their per-pair delivery keys; this digest is only for
 * actionable work that needs the Brain's decision or integration.
 */
export function buildBrainHeartbeatMessage(pairs: readonly TaskPairState[]): string {
  const lines = pairs.map((pair) => {
    const reason = pair.status === 'passed'
      ? 'audit passed; commit locally and DONE'
      : pair.status === 'awaiting_brain_decision'
        ? 'executor reported completion without an auditor; decide with DONE <taskId> force=true or CANCEL <taskId>'
      : pair.flags.length > 0
        ? pair.flags.join(', ')
        : pair.status;
    return `- ${pair.taskId}${pair.title ? ` "${pair.title}"` : ''}: ${reason} (executor ${pair.executor ?? '-'}, auditor ${pair.auditor ?? '-'})`;
  });
  return [
    `[IM.codes task pairs] Brain heartbeat: ${pairs.length} pair(s) need action.`,
    ...lines,
    TASK_PAIR_BRAIN_REPLY_RESOLUTION_RULE,
    `Resolve with the task marker for each pair (for example <!-- IMCODES_TASK DONE <taskId> force=true -->, REASSIGN, or CANCEL).`,
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

/**
 * Several queued pairs found brief-less in the same heartbeat (typically a
 * legacy import that skipped straight-forward status mapping): their ids,
 * plus ONE example of the fix-up marker -- not the same marker repeated once
 * per pair, which is what actually spammed 215 (owner report).
 */
export function buildNoBriefDigestMessage(taskIds: readonly string[]): string {
  return [
    `[IM.codes task pairs] ${taskIds.length} pairs are queued without a brief: ${taskIds.join(', ')}.`,
    TASK_PAIR_TITLE_RULE,
    `Give one a brief with ${marker('QUEUE', '<taskId>', 'title="..."')}, then its brief, then ${buildBriefEndHint('<taskId>')}; or dispatch it yourself with ${marker('DISPATCH', '<taskId>', 'executor=<session> auditor=<session>')}. No further reminders until each pair's state changes.`,
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
  ].join('\n');
}

/**
 * One combined, rate-limited notice per project: no execution pool is
 * configured and one or more pairs have a role with no named model either,
 * so nothing was picked or provisioned for it (owner rule: no built-in
 * default). Every such pair is listed together, not one message per pair.
 */
export function buildNoPoolAskMessage(project: string, pairs: readonly Pick<TaskPairState, 'taskId' | 'title' | 'executor' | 'executorModel' | 'auditor' | 'auditorModel'>[]): string {
  const lines = pairs.map((pair) => {
    const needs: string[] = [];
    if (!pair.executor && !pair.executorModel) needs.push('an executor model');
    if (!pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR && !pair.auditorModel) needs.push('an auditor model');
    return `- ${pair.taskId}${pair.title ? ` "${pair.title}"` : ''}: needs ${needs.join(' and ') || 'a model'}.`;
  });
  return [
    `[IM.codes task pairs] project ${project} has no execution pool: ask the user which executor/auditor models to use (Settings → execution pool, or name executormodel=/auditormodel= on the task). ${pairs.length} pair(s) are waiting:`,
    TASK_PAIR_TITLE_RULE,
    ...lines,
    'Each starts automatically once a pool is configured or the missing model is named on it -- no further reminders until then.',
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
  ].join('\n');
}

/** One queued pair with no brief: how Brain can give it one. */
export function buildNoBriefLine(taskId: string): string {
  return `${TASK_PAIR_TITLE_RULE} queued without a brief: give it one with ${marker('QUEUE', taskId, 'title="..."')}, then its brief, then ${buildBriefEndHint(taskId)}; or dispatch it yourself with ${marker('DISPATCH', taskId, 'title="..." executor=<session> auditor=<session>')}.`;
}

/**
 * Legacy tasks skipped on import (never turned into a pair): their only
 * objective is the old send_message wrapper's placeholder, so there is no
 * real brief to give them. Brain gets one digest, not one per task.
 */
export function buildLegacyPlaceholderDigestMessage(taskIds: readonly string[]): string {
  return [
    `[IM.codes task pairs] ${taskIds.length} legacy task(s) were not imported as pairs: their only objective is the old wrapper's placeholder, so there is no real brief to recover: ${taskIds.join(', ')}.`,
    TASK_PAIR_TITLE_RULE,
    `Give one a real brief and dispatch it yourself, e.g. ${marker('QUEUE', '<taskId>', 'title="..."')}, then its brief, then ${buildBriefEndHint('<taskId>')}; or ${marker('DISPATCH', '<taskId>', 'title="..." executor=<session> auditor=<session>')} if you already know who should do it.`,
  ].join('\n');
}

/** To the executor of a pair that was imported as passed without any audit. */
export function buildLegacyImportCorrectionMessage(pair: TaskPairState): string {
  const auditor = pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? `auditor ${pair.auditor}` : 'the auditor being assigned';
  return [
    header(pair),
    'Correction: this task was imported from the old supervision engine as passed, but it never had an audit PASS. Disregard any earlier "PASS received: local commit" message for it and do not commit it yet.',
    `Send your validation to ${auditor} with send_message, then write ${readyMarker(pair)}. After the auditor's PASS, commit locally in the worktree (never push any branch), report the worktree path and HEAD to Brain, then write DONE; Brain merges into dev and pushes dev.`,
    contracts(pair.blocking),
  ].join('\n');
}

/** One line to Brain listing the imports corrected on this pass. */
export function buildLegacyImportCorrectionBrainLine(taskIds: readonly string[]): string {
  return `[IM.codes task pairs] ${taskIds.length} imported legacy task(s) were marked passed without any audit PASS and are now back in audit: ${taskIds.join(', ')}. Each gets an auditor from the pool within your concurrency limit; no action needed.`;
}

/** Bare, never backtick-wrapped: see {@link marker}. */
export interface DiskPressureNoticeInput {
  level: 'low' | 'critical';
  freeBeforeBytes: number;
  freeAfterBytes: number;
  totalBytes: number;
  strippedPairs: number;
}

const GIB = 1024 ** 3;

/** One notice per crossing of a disk-space threshold on the worktree volume. */
export function buildDiskPressureMessage(input: DiskPressureNoticeInput): string {
  const gib = (bytes: number) => (bytes / GIB).toFixed(1);
  const percent = (bytes: number) => ((bytes / input.totalBytes) * 100).toFixed(1);
  return [
    `[IM.codes task pairs] Disk space on the worktree volume is ${input.level === 'critical' ? 'critically low' : 'low'}: ${gib(input.freeBeforeBytes)} GiB free (${percent(input.freeBeforeBytes)}%).`,
    input.strippedPairs > 0
      ? `Stripped rebuildable ignored directories (node_modules, build outputs) from ${input.strippedPairs} finished pair(s), oldest first: now ${gib(input.freeAfterBytes)} GiB free (${percent(input.freeAfterBytes)}%). Commits, tracked files and uncommitted work were not touched.`
      : `No finished pair had anything left to strip; ${gib(input.freeAfterBytes)} GiB free (${percent(input.freeAfterBytes)}%).`,
    "An open pair's files are never removed by the daemon. If space stays low, finish or cancel pairs that are done, or have their executors delete their own node_modules. A reopened pair's executor reinstalls what it needs.",
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
    lines.push(`Audit pending for executor ${pair.executor}. Judge the executor's workspace and their reported validation, reply to them with every finding tagged [P0]..[P4], then write ${marker('PASS', pair.taskId, `blocking=${pair.blocking.join(',')}`)} or ${marker('REWORK', pair.taskId, `blocking=${pair.blocking.join(',')} p0=<n> ...`)}.`);
    lines.push(TASK_PAIR_AUDITOR_PROPOSAL_RULE);
    lines.push(TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE);
    const where = materialLine(pair.material);
    if (where) lines.push(where);
    lines.push(`${NO_LEGACY_ARTIFACTS} If the material cannot be reached, write ${marker('NEEDS_INPUT', pair.taskId, 'note="..."')} and wait; that is never a P0.`);
    if (pair.round > 1 && pair.lastVerdict?.verb === 'REWORK') {
      lines.push(`Re-audit (round ${pair.round}): check only closure of the previous blocking classes (${formatTaskPairSeverityCounts(pair.lastVerdict.counts)}) plus regressions; do not raise new non-blocking items to REWORK.`);
    }
  } else {
    const next = pair.status === 'passed'
      ? `PASS received: commit locally in the worktree (never push any branch), report the worktree path and HEAD to Brain, then write ${marker('DONE', pair.taskId)}; Brain merges into dev and pushes dev.`
      : pair.status === 'awaiting_audit'
        ? `DONE without a PASS is not complete: send your validation to auditor ${pair.auditor}, then write ${readyMarker(pair)}.`
        : pair.status === 'rework'
          ? `Address the auditor's blocking findings for their whole class, resend, then write ${marker('READY_FOR_AUDIT', pair.taskId)}.`
          : pair.auditor === 'none'
            ? `Continue the task; commit locally in the worktree (never push any branch), report the worktree path and HEAD to Brain, then write ${marker('DONE', pair.taskId)}; Brain merges into dev and pushes dev.`
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
    TASK_PAIR_AUDITOR_PROPOSAL_RULE,
    TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE,
    TASK_PAIR_VALIDATION_REPORT_RULE,
    TASK_PAIR_NO_INTERMEDIATE_BRAIN_UPDATES_RULE,
    blockingSummaryLine(pair),
    ...(where ? [where] : []),
    `${NO_LEGACY_ARTIFACTS} If the material cannot be reached, write ${marker('NEEDS_INPUT', pair.taskId, 'note="..."')} and wait; that is never a P0.`,
    contracts(pair.blocking),
  ].join('\n');
}

/** An audit round opened: exactly where the material is, resolved by the daemon. */
/** How to review a non-git pair: the clone's comparison and per-file diff (cow), or the listed files in the project itself (in-place). */
function nonGitReviewLines(material: ResolvedTaskPairMaterial): string[] {
  if (material.nonGit?.mode === 'cow') {
    const review = material.review;
    const list = review?.changes.length ? review.changes.map((change) => `${change.kind} ${change.path}`).join('; ') : 'none: the clone is unchanged';
    return [
      `Material: copy-on-write CLONE ${material.path} of the project ${material.nonGit.projectRoot} (not a git repository: there is no HEAD or base). Changed files, computed by the daemon by comparing the clone with the manifest taken when it was cloned: ${list}.`,
      ...(review?.summaries.length ? [`Not shown as text: ${review.summaries.join('; ')}.`] : []),
      ...(review?.diff ? [`Per-file diff, clone vs the project original${review.diffTruncated ? ` (cut; the whole diff is in ${review.diffFile})` : review.diffFile ? ` (also in ${review.diffFile})` : ''}:`, '```diff', review.diff.replace(/```/g, "'''"), '```'] : []),
    ];
  }
  if (material.nonGit?.mode === 'in_place') {
    return [
      `Material: the project directory ${material.nonGit.projectRoot}, edited IN PLACE (it is not a git repository and could not be cloned, so there is no HEAD, base or diff). Review the changed files where they are.`,
      material.files ? `Changed files stated by the executor: ${material.files}.` : 'The executor did not list the changed files: ask for the list before judging.',
    ];
  }
  return [];
}

export function buildAuditRequestMessage(pair: TaskPairState, material: ResolvedTaskPairMaterial, warning?: string): string {
  if (material.nonGit) {
    return [
      header(pair),
      TASK_PAIR_TITLE_RULE,
      `Audit request, round ${Math.max(1, pair.round)}, from executor ${pair.executor} (blocking=${pair.blocking.join(',')}).`,
      ...nonGitReviewLines(material),
      ...(warning ? [warning] : []),
      `Their validation (full suites for code) comes from them via send_message. Judge by ${AUDIT_CONVERGENCE_CONTRACT_ID}, reply to the executor with every finding tagged [P0]..[P4], then write ${marker('PASS', pair.taskId, `blocking=${pair.blocking.join(',')}`)} or ${marker('REWORK', pair.taskId, `blocking=${pair.blocking.join(',')} p0=<n> ...`)}.`,
      TASK_PAIR_AUDITOR_PROPOSAL_RULE,
      TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE,
      TASK_PAIR_VALIDATION_REPORT_RULE,
      TASK_PAIR_NO_INTERMEDIATE_BRAIN_UPDATES_RULE,
      `${NO_LEGACY_ARTIFACTS} If the material cannot be reached (executor limited/offline, workspace unreadable), write ${marker('NEEDS_INPUT', pair.taskId, 'note="..."')} and wait; that is never a P0 or REWORK.`,
      contracts(pair.blocking),
    ].join('\n');
  }
  const where = materialLine(material)
    ?? `Material: the executor did not name a workspace and none could be resolved; ask ${pair.executor} for its worktree path and head, or its task-directory path.`;
  return [
    header(pair),
    TASK_PAIR_TITLE_RULE,
    `Audit request, round ${Math.max(1, pair.round)}, from executor ${pair.executor} (blocking=${pair.blocking.join(',')}).`,
    `${where}${material.source === 'workspace' ? ' (resolved by the daemon from the executor session)' : ''}`,
    ...(warning ? [warning] : []),
    `Their validation (full suites for code) comes from them via send_message. Judge by ${AUDIT_CONVERGENCE_CONTRACT_ID}, reply to the executor with every finding tagged [P0]..[P4], then write ${marker('PASS', pair.taskId, `blocking=${pair.blocking.join(',')}`)} or ${marker('REWORK', pair.taskId, `blocking=${pair.blocking.join(',')} p0=<n> ...`)}.`,
    TASK_PAIR_AUDITOR_PROPOSAL_RULE,
    TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE,
    TASK_PAIR_VALIDATION_REPORT_RULE,
    TASK_PAIR_NO_INTERMEDIATE_BRAIN_UPDATES_RULE,
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
    TASK_PAIR_TITLE_RULE,
    ...(pair.brief ? [pair.brief] : []),
    TASK_PAIR_CHECKLIST_RULE,
    `You are the executor of this task pair, with ${auditor}. Write ${marker('STARTED', pair.taskId)} when you begin.`,
    blockingSummaryLine(pair),
    workplaceLine(pair),
    pair.auditor === TASK_PAIR_NO_AUDITOR
      ? `No audit window for this pair -- do proportionate self-validation instead (full suites for code), then commit locally in the worktree (never push any branch). Report straight to Brain in the same closing reply as your ${marker('DONE', pair.taskId)}: what changed, your worktree path and HEAD (or file paths for non-code work), and your validation result. Brain merges commits into dev and pushes dev; the daemon relays that reply to Brain as the completion notice, so write it as if Brain will read only that.`
      : `When done, send the auditor your validation (full suites for code) with send_message and write ${readyMarker(pair)}; the daemon relays that to the auditor. ${afterPassLine(pair)}`,
    TASK_PAIR_WORKSPACE_RULES,
    TASK_PAIR_VALIDATION_REPORT_RULE,
    TASK_PAIR_NO_INTERMEDIATE_BRAIN_UPDATES_RULE,
    NO_LEGACY_ARTIFACTS,
    TASK_PAIR_ASK_DONT_JUST_REPLY_RULE,
    TASK_PAIR_AUDITOR_PROPOSAL_RULE,
    TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE,
    contracts(pair.blocking),
  ].join('\n');
}

/** Brain, once per pair: which way a non-git project is handled, and why not the ones before it. */
export function buildNonGitModeLine(pair: TaskPairState, nonGit: NonNullable<NonNullable<TaskPairState['workspace']>['nonGit']>): string | undefined {
  const header0 = header(pair);
  if (nonGit.mode === 'git_init' || nonGit.mode === 'plain_dir') return undefined; // git_init: the repo-created notice is sent once, when it is made; plain_dir: the container notice
  const why = nonGit.fallbackReason ? ` (a local git repo was not used: ${nonGit.fallbackReason})` : '';
  if (nonGit.mode === 'cow') {
    const clone = nonGit.clone;
    return `${header0} Non-git project ${nonGit.projectRoot}${why}: the pair works on a copy-on-write clone${clone ? ` (${clone.files} files, ${Math.round(clone.logicalBytes / 1024 / 1024)} MiB logical, cloned in ${clone.ms} ms${clone.extraDiskBytes !== undefined ? `, extra disk used about ${Math.round(clone.extraDiskBytes / 1024)} KiB` : ''})` : ''}. Changes are copied back to the project at DONE; conflicts are refused and reported, overwritten files are backed up.`;
  }
  return `${header0} Non-git project ${nonGit.projectRoot}${why}: NO isolated copy could be made, so the pair edits the project directory in place (no undo). Pairs on this project run one at a time; pass parallel=true on DISPATCH to override.`;
}

/** Brain: how bringing a non-git pair's work into the project went. */
export function buildNonGitFinishLine(pair: TaskPairState, mode: 'git_init' | 'cow', outcome: { status: 'applied' | 'noop' | 'conflict' | 'failed'; files: string[]; detail?: string }): string {
  const root = pair.workspace?.nonGit?.projectRoot ?? 'the project';
  const shown = outcome.files.slice(0, 12).join(', ') + (outcome.files.length > 12 ? `, +${outcome.files.length - 12} more` : '');
  const how = mode === 'git_init' ? 'merge of the pair branch into the project' : 'copy-back of the clone into the project';
  if (outcome.status === 'applied') return `${header(pair)} DONE: ${how} succeeded${outcome.detail ? ` (${outcome.detail})` : ''}: ${outcome.files.length} file(s) in ${root}${shown ? `: ${shown}` : ''}.${mode === 'cow' ? ' Every overwritten or deleted project file is backed up in the task directory and can be restored.' : ''}`;
  if (outcome.status === 'noop') return `${header(pair)} DONE: nothing to bring into ${root}${outcome.detail ? ` (${outcome.detail})` : ''}.`;
  if (outcome.status === 'conflict') {
    return `${header(pair)} DONE, but the ${how} was REFUSED and nothing was written: ${mode === 'git_init' ? 'the project has uncommitted edits in (or staged changes touching) files the pair changed, or the commits conflict' : 'these project files changed since the clone was made, or are in the way'}: ${shown}. Nothing in ${root} was overwritten. Resolve it (commit or move your edits, or redo the change on the current files); the daemon retries hourly and tells you when it lands. The pair's work is kept in ${pair.workspace?.path}.`;
  }
  return `${header(pair)} DONE, but the ${how} FAILED${outcome.detail ? `: ${outcome.detail}` : ''}. The pair's work is kept in ${pair.workspace?.path}; the daemon retries hourly.`;
}

/** What happens after PASS, for the executor's closing instruction. */
function afterPassLine(pair: TaskPairState): string {
  const nonGit = pair.workspace?.nonGit;
  const done = marker('DONE', pair.taskId);
  if (nonGit?.mode === 'git_init') return `After their PASS, commit locally in the worktree (never push any branch) and write ${done}; the daemon merges your branch into the project (refusing any file with uncommitted user edits) and tells Brain.`;
  if (nonGit?.mode === 'cow') return `After their PASS, write ${done}; the daemon copies your changed files back into the project (conflicts refused and reported, overwritten files backed up).`;
  if (nonGit?.mode === 'in_place') return `After their PASS, write ${done}; your edits are already in the project, so report the changed files to Brain in the same reply.`;
  return `After their PASS, commit locally in the worktree (never push any branch), report the worktree path and HEAD to Brain, and write ${done}; Brain merges into dev and pushes dev.`;
}

/**
 * Where the executor works: the workspace the daemon created for the pair (a
 * worktree or a task directory), or, if none could be created, its own.
 */
function workplaceLine(pair: TaskPairState): string {
  const workspace = pair.workspace;
  const nonGit = workspace?.status === 'active' ? workspace.nonGit : undefined;
  if (workspace && nonGit?.mode === 'cow') {
    return `Work in the copy-on-write CLONE of the project the daemon made for this pair: ${workspace.path} (the project ${nonGit.projectRoot} is not a git repository, so there is no git here). Heavy directories such as node_modules were not cloned: install or link what you need. The project itself is not touched while you work: the daemon finds your changed files by comparing the clone with the manifest it took, sends the auditor a per-file diff against the original, and after PASS copies your changes back at DONE (any file the project changed meanwhile is refused and reported, never overwritten; overwritten files are backed up). Write READY_FOR_AUDIT with path=${workspace.path}. This absolute path is authoritative; never use cwd or write into ${nonGit.projectRoot}.`;
  }
  if (workspace && nonGit?.mode === 'in_place') {
    return `Work DIRECTLY in the project directory: ${nonGit.projectRoot}. It is not a git repository and this machine could not make it one or clone it (${nonGit.fallbackReason ?? 'no reason recorded'}), so there is no isolated copy and no undo: make deliberate edits and keep a list of every file you change. ${workspace.path} is only for scratch, evidence and deliverables. Write READY_FOR_AUDIT with path=${nonGit.projectRoot} files=<comma separated changed files>. Pairs on this project run one at a time unless Brain passed parallel=true.`;
  }
  if (workspace && workspace.status === 'active') {
    const latestHead = workspace.lastHead ?? pair.material?.head;
    const where = workspace.branch ? `on branch ${workspace.branch}` : 'detached';
    const revision = workspace.kind === 'worktree'
      ? `${where}, base ${workspace.base ?? pair.material?.base ?? 'unknown'}; latest head ${latestHead ?? 'unknown'}`
      : `base ${workspace.base ?? pair.material?.base ?? 'unknown'}; latest head ${latestHead ?? 'unknown'}`;
    const line = workspace.kind === 'dir'
      ? `Work in the task directory the daemon created for this pair: ${workspace.path} (${revision}). This absolute path is authoritative; never use cwd or the project main checkout. Write your results there.`
      : `Work in the worktree the daemon created for this pair: ${workspace.path} (${revision}; ${workspace.branch ? 'keep committing on that branch' : 'make a local branch there if useful'}, commit locally, never push any branch, report the worktree path plus HEAD, and let Brain merge into dev and push dev). This absolute path is authoritative; never use cwd or the project main checkout.`;
    const moved = workspace.previousPaths?.length
      ? ` The previous executor's worktree was moved here from ${workspace.previousPaths[workspace.previousPaths.length - 1]}; that old path no longer exists, and any material naming it now resolves to this path.`
      : '';
    const initNote = nonGit?.mode === 'git_init'
      ? ` ${nonGit.projectRoot} was not a git repository: IM.codes made it a LOCAL git repo (no remote, never push). Do not commit in ${nonGit.projectRoot} yourself; after PASS and DONE the daemon merges your branch into the project (it refuses any file the user has uncommitted edits in and tells Brain).`
      : '';
    return line + initNote + moved + duplicateWorktreeWarning(workspace);
  }
  return `No workspace could be created for this pair: use your own git worktree under ~/.imcodes/worktrees for code in a git project, else a task directory under ~/.imcodes/${TASK_PAIR_WORKS_DIR}/<project>/${pair.taskId}/, and name it on READY_FOR_AUDIT.`;
}

/** Compact age for a wait reason: 45s, 12m, 3h. */
function formatWaitAge(ageMs: number): string {
  const age = Math.max(0, ageMs);
  return age < 60_000 ? `${Math.floor(age / 1_000)}s`
    : age < 3_600_000 ? `${Math.floor(age / 60_000)}m`
      : `${Math.floor(age / 3_600_000)}h`;
}

/**
 * The queue wait reason for a pair whose named session is held by another open
 * pair. The one wording: the scheduler's queue run and the participant-conflict
 * note on arrival both use it, so the reason cannot drift between them.
 */
export function buildHeldWaitReason(
  session: string,
  holder: { taskId: string; status: string; updatedAt: number } | undefined,
  now: number,
): string {
  return `waiting for ${session} (busy in ${holder?.taskId ?? 'another open pair'}${holder ? `, status ${holder.status}, age ${formatWaitAge(now - holder.updatedAt)}` : ''})`;
}

/** The participant that ran (or tried) a git write in the main checkout. */
export function buildMainCheckoutWriteParticipantNotice(
  hit: { taskId: string; verb: string; dir: string; root: string; command: string },
  blocked: boolean,
  workspace: string | undefined,
): string {
  return `[IM.codes task ${hit.taskId}] ${blocked ? 'REFUSED' : 'WARNING'}: \`git ${hit.verb}\` in the project's main checkout (${hit.dir}) while you hold this pair. ${blocked ? 'It did not run.' : 'It already ran: undo it now (tell Brain what changed) and do not repeat it.'} `
    + `The main checkout is Brain's integration space and the owner's checkout; a pair works only in its own workspace${workspace ? `: ${workspace}` : ''}. Read-only git there (status, log, diff, show) is fine. Command: ${hit.command}`;
}

/** Brain: a pair participant wrote git state in the main checkout. */
export function buildMainCheckoutWriteBrainLine(
  hit: { taskId: string; session: string; role: string; verb: string; dir: string; command: string },
  blocked: boolean,
): string {
  return `[IM.codes task ${hit.taskId}] ${hit.role} ${hit.session} ran \`git ${hit.verb}\` in the main checkout (${hit.dir}): ${blocked ? 'refused before it ran' : 'it ran; check the checkout (git status / reflog) before you merge'}. The participant was told at once. Command: ${hit.command}`;
}

/** Warning for a workspace that has other worktrees for the same task next to it. */
function duplicateWorktreeWarning(workspace: NonNullable<TaskPairState['workspace']>): string {
  if (!workspace.duplicatePaths?.length) return '';
  return ` WARNING: another worktree for this task exists at ${workspace.duplicatePaths.join(', ')}. It is NOT this pair's workspace: do not work, commit or audit there; if it holds changes you need, copy them into ${workspace.path} (read-only look with git -C is fine).`;
}

/** Executor/auditor: the worktree moved under the new executor (heartbeat-time move; a brief carries the path itself). */
export function buildWorkspaceMovedNotice(pair: TaskPairState, from: string, to: string, adopted: boolean): string {
  const head = pair.workspace?.lastHead ?? pair.material?.head;
  return `${header(pair)} The pair's worktree ${adopted ? 'is now' : 'was moved to'} ${to}${adopted ? ` (the previous location ${from} is gone)` : ` from ${from}`}. That is the single authoritative workspace${head ? ` (latest head ${head})` : ''}: branch, commits and uncommitted work are unchanged. Use ${to} from now on; any material naming the old path resolves to the new one.${pair.workspace ? duplicateWorktreeWarning(pair.workspace) : ''}`;
}

/** Brain (and the executor): another worktree for the same task exists next to the authoritative one. */
export function buildWorkspaceDuplicateNotice(pair: TaskPairState): string {
  const workspace = pair.workspace;
  return `${header(pair)} ${workspace ? `The authoritative worktree is ${workspace.path}.` : ''}${workspace ? duplicateWorktreeWarning(workspace) : ''} The daemon registered it and does not touch it; ask the executor to copy anything needed into the authoritative worktree, and remove the duplicate yourself once it holds nothing unsaved.`;
}

/** Brain: moving the worktree under the new executor failed; the old path stays authoritative. */
export function buildWorkspaceMoveFailedLine(pair: TaskPairState, detail: string): string {
  return `${header(pair)} The daemon could not move the worktree ${pair.workspace?.path ?? ''} under executor ${pair.executor ?? ''}: ${detail}. The recorded path stays authoritative and unchanged; the executor can keep using it.`;
}

/** Brain: a finished pair's worktree still held unsaved work at removal time, so it was kept. */
export function buildWorkspaceKeptLine(pair: TaskPairState, reason: string): string {
  const why = reason === 'unapplied' ? 'holds work that never reached the project (see the merge / copy-back notice)' : reason === 'unpushed' ? 'has commits not yet integrated into any branch' : reason === 'dirty' ? 'has uncommitted changes' : reason === 'untracked' ? 'has untracked files' : `could not be checked (${reason})`;
  return `${header(pair)} The pair ended 7 days ago but its worktree ${pair.workspace?.path ?? ''} ${why}, so it was kept instead of deleted. Have ${pair.executor ?? 'the executor'} commit locally what should survive and report its worktree plus HEAD; it is removed once clean or integrated into any branch.`;
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
  const nonGit = pair.workspace?.nonGit;
  if (nonGit?.mode === 'cow' && pair.workspace) return marker('READY_FOR_AUDIT', pair.taskId, `path=${pair.workspace.path}`);
  if (nonGit?.mode === 'in_place') return marker('READY_FOR_AUDIT', pair.taskId, `path=${nonGit.projectRoot} files=<comma separated changed files>`);
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
    TASK_PAIR_TITLE_RULE,
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
    TASK_PAIR_TITLE_RULE,
    `[IM.codes task ${pair.taskId} · auditor: ${pair.auditor ?? 'none'}] Write ${marker('STARTED', pair.taskId)} when you begin and finish with ${readyMarker(pair)}; follow ${TASK_PAIR_CONTRACT_ID} and ${AUDIT_CONVERGENCE_CONTRACT_ID} (blocking=${pair.blocking.join(',')}). ${workplaceLine(pair)} ${TASK_PAIR_WORKSPACE_RULES} ${NO_LEGACY_ARTIFACTS}`,
    TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE,
    TASK_PAIR_BRAIN_REPORTING_RULE,
    TASK_PAIR_CHECKLIST_RULE,
    ...(pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? [TASK_PAIR_AUDITOR_PROPOSAL_RULE] : []),
  ].join('\n');
}

export function buildAuditorAssignmentMessage(pair: TaskPairState): string {
  return [
    header(pair),
    TASK_PAIR_TITLE_RULE,
    `You are the auditor of this task for executor ${pair.executor}. On READY_FOR_AUDIT the daemon relays their workspace (worktree and head, or task-directory path), and they send you their validation; judge that by ${AUDIT_CONVERGENCE_CONTRACT_ID} (blocking=${pair.blocking.join(',')}) and write PASS or REWORK with severity counts.`,
    TASK_PAIR_AUDITOR_PROPOSAL_RULE,
    TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE,
    TASK_PAIR_VALIDATION_REPORT_RULE,
    TASK_PAIR_NO_INTERMEDIATE_BRAIN_UPDATES_RULE,
    TASK_PAIR_CHECKLIST_RULE,
    blockingSummaryLine(pair),
    NO_LEGACY_ARTIFACTS,
    TASK_PAIR_ASK_DONT_JUST_REPLY_RULE,
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
  return `${header(pair)} Executor ${pair.executor ?? '(unknown)'} reported DONE; no auditor was assigned. The pair is open and awaiting your decision. Accept with DONE ${pair.taskId} force=true, cancel with CANCEL ${pair.taskId}, or dispatch/brief/message more work to return it to working.${
    summary ? `\n\n${summary}` : ' (no summary text in the closing reply)'
  }`;
}

/**
 * Relayed to Brain the moment an audited pair PASSes (or, as a backstop if
 * that notice was somehow missed, again when it reaches DONE): owner report,
 * two PASSed pairs sat unintegrated for hours because Brain relied on the
 * executor remembering to say so. Exactly one per pair per round; whichever
 * transition catches it first (see service.ts's dedup).
 */
export function buildPassDoneNoticeMessage(pair: TaskPairState): string {
  const verdict = pair.lastVerdict;
  const verdictLine = verdict
    ? `Auditor ${pair.auditor} verdict: ${verdict.verb} (${formatTaskPairSeverityCounts(verdict.counts)}; blocking=${pair.blocking.join(',')}).`
    : `Auditor ${pair.auditor} verdict: PASS.`;
  const where = materialLine(pair.material);
  return [
    header(pair),
    `Audited pair ${pair.status === 'done' ? 'done' : 'passed'}: executor ${pair.executor ?? '-'}.`,
    verdictLine,
    ...(pair.workspace?.path ? [`Worktree: ${pair.workspace.path}.${pair.workspace.lastHead ? ` Head: ${pair.workspace.lastHead}.` : ''}`] : []),
    ...(where ? [where] : []),
    'Brain merges the reported commit into dev and pushes dev; the executor never pushes any branch.',
    ...(pair.status === 'passed' ? [`More rounds planned? Write ${marker('NEXT_ROUND', pair.taskId, '[base=<commit>] [note="..."]')} on this pair instead of letting it be DONE: it returns to working with the same workspace and participants. A DONE pair cannot open another round.`] : []),
  ].join('\n');
}

function formatDriftAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1).replace(/\.0$/u, '')} h` : `${Math.round(hours / 24)} d`;
}

export interface IntegrationDriftLine {
  taskId: string;
  head: string;
  worktree: string;
  ageMs: number;
  ref: string;
  missing: number;
}

/**
 * The unintegrated-DONE reminder: ONE message per Brain, ONE line per finished pair whose final head is not in the integration
 * branch (taskId, head, worktree, age). Brain merges every PASSed pair (owner rule); dismiss one it will not merge.
 */
export function buildIntegrationDriftDigest(lines: readonly IntegrationDriftLine[]): string {
  const ref = lines[0]?.ref || 'the integration branch';
  const body = lines.map((line) => `- ${line.taskId}: head ${line.head.slice(0, 12)} (${line.missing} commit${line.missing === 1 ? '' : 's'} not in ${line.ref || ref}), worktree ${line.worktree}, finished ${formatDriftAge(line.ageMs)} ago`).join('\n');
  const example = lines[0]?.taskId ?? '<taskId>';
  return `Finished pair${lines.length === 1 ? '' : 's'} not yet merged into ${ref} (cherry-picked equivalents count as merged):\n${body}\n`
    + `Merge ${lines.length === 1 ? 'it' : 'them'} (cherry-pick the PASSed head, then push dev). A pair you will not merge: ${marker('DONE', example, 'integration=dismiss')} (or CANCEL ${example}) stops these reminders.`;
}

const STALE_STAGE_LABEL = { ready: 'READY_FOR_AUDIT', pass: 'PASS' } as const;
const STALE_STAGE_DEADLINE = { ready: 'before audit', pass: 'before the final round' } as const;

export interface StaleBaseOverlapFile { path: string; kind: 'modified' | 'deleted' | 'added'; subjects: string[] }

/** What the stale-base warning reports: how far behind the base is, and/or the files the integration ref changed that the pair changed too. */
export interface StaleBaseReport {
  ref: string;
  behind: number;
  ageMs: number;
  /** The base is more than the commit/age limit behind. */
  stale: boolean;
  overlap?: { total: number; files: StaleBaseOverlapFile[] };
}

function describeStaleBase(head: string, stale: StaleBaseReport): string {
  const parts: string[] = [];
  if (stale.stale) parts.push(`head ${head.slice(0, 12)} builds on a base ${stale.behind} commit${stale.behind === 1 ? '' : 's'} (${formatDriftAge(stale.ageMs)}) behind ${stale.ref}`);
  if (stale.overlap) {
    const { files, total } = stale.overlap;
    const listed = files.map((file) => {
      const kind = file.kind === 'modified' ? '' : ` [${file.kind} in ${stale.ref}]`;
      const why = file.subjects.length ? ` <- ${file.subjects.map((subject) => `"${subject.length > 80 ? `${subject.slice(0, 77)}...` : subject}"`).join('; ')}` : '';
      return `${file.path}${kind}${why}`;
    });
    parts.push(`${stale.ref} changed ${total} of the files head ${head.slice(0, 12)} changed since its base (${stale.behind} commit${stale.behind === 1 ? '' : 's'} behind): ${listed.join(' | ')}${total > files.length ? ` | +${total - files.length} more` : ''}`);
  }
  return parts.join('. ');
}

export function buildStaleBaseExecutorNotice(pair: TaskPairState, head: string, stale: StaleBaseReport, stage: 'ready' | 'pass'): string {
  return `${header(pair)} At ${STALE_STAGE_LABEL[stage]}: ${describeStaleBase(head, stale)}. Rebase onto ${stale.ref} ${STALE_STAGE_DEADLINE[stage]}, re-run the affected tests and send a new READY_FOR_AUDIT with the new head. This is a warning, not a gate.`;
}

export function buildStaleBaseBrainLine(pair: TaskPairState, head: string, stale: StaleBaseReport, stage: 'ready' | 'pass'): string {
  return `${header(pair)} At ${STALE_STAGE_LABEL[stage]}: ${describeStaleBase(head, stale)}; executor ${pair.executor ?? '-'} was told to rebase ${STALE_STAGE_DEADLINE[stage]} (a warning, not a gate).`;
}
