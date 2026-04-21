import {
  AUDIT_VERDICT_MARKERS,
  SUPERVISION_CONTRACT_IDS,
  TASK_RUN_STATUS_MARKERS,
  classifySupervisionCustomInstructions,
  resolveSupervisionCustomInstructionsDetail,
  type SupervisionCustomInstructionsDetail,
} from '../../shared/supervision-config.js';
import { SUPERVISION_IMCODES_BACKGROUND_DOCS } from './imcodes-workflow-docs.js';
import type { SupervisionBrokerRequest } from './supervision-broker.js';

/**
 * Render the user-provided supervision-rules block for a supervision prompt,
 * labeling it according to where the text actually came from.
 *
 * These are not free-form "custom instructions" the target session can ignore
 * — they are rules the USER set for supervision to enforce. Both the
 * supervisor judge (decision prompt) and the target session (continue prompt)
 * read the same block: the supervisor uses it to judge complete/continue/
 * ask_human, and the target session uses it to understand what supervision
 * is going to hold it accountable for. That symmetry is why decision and
 * continue prompts share this exact heading.
 *
 * Before: the label was hardcoded to "Session-specific supervision
 * instructions from the user:" even when the text was really the user's
 * GLOBAL default (set in the supervisor-defaults panel and applied to
 * every session). That mislabeled the scope AND dropped the
 * "supervision-enforced rule" framing, making it read like a per-session
 * chat hint. Now we pick the heading from the source classification.
 */
function buildCustomInstructionsSection(detail: SupervisionCustomInstructionsDetail | undefined): string {
  if (!detail || !detail.text.trim()) return '';
  const heading = ((): string => {
    switch (detail.source) {
      case 'global':
        return 'Global supervision rules set by the user (supervision enforces these on every session, including this one):';
      case 'session':
        return 'Session-specific supervision rules set by the user (supervision enforces these on this session):';
      case 'merged':
        return 'Supervision rules set by the user (global baseline first, then session-specific additions — supervision enforces all of them):';
      case 'none':
      default:
        return 'Session-specific supervision rules set by the user (supervision enforces these on this session):';
    }
  })();
  return [heading, detail.text].join('\n');
}

function buildImcodesWorkflowBackgroundSection(): string {
  return SUPERVISION_IMCODES_BACKGROUND_DOCS;
}

export function buildSupervisionDecisionPrompt(
  request: SupervisionBrokerRequest,
  contractId: string = SUPERVISION_CONTRACT_IDS.DECISION,
): string {
  return [
    `[Contract: ${contractId}]`,
    'You are a supervision arbiter for a coding session.',
    'Judge the most recent assistant turn for the current task.',
    'Return exactly one JSON object and nothing else.',
    '{"decision":"complete|continue|ask_human","reason":"...","confidence":0.0,"gap":"...","nextAction":"...","extra":{}}',
    'Field contract:',
    '- decision: complete when the task is sufficiently done for the current request; continue only when you can identify a SPECIFIC next step the agent should execute autonomously; ask_human when you need the user to decide, approve, or clarify.',
    '- reason: short human-readable explanation of the decision.',
    '- confidence: number in [0,1].',
    '- gap: REQUIRED when decision is continue — describe the specific missing artifact/state/verification that blocks calling the task complete. Keep it concrete (e.g. "tests for the new guardrail are not written", "staged diff not yet committed to git").',
    '- nextAction: REQUIRED when decision is continue — imperative instruction for the agent\'s next turn. Must be concrete and executable, e.g. "Run `npm test` and fix any failing spec", "Commit staged changes with message X and push to origin/dev". DO NOT write vague fillers like "keep going", "continue", "finish the task", "继续完成任务" — those are rejected and force-escalated to ask_human.',
    '- extra: optional object reserved for future metadata; return {} if you have nothing to add.',
    'Decision rules:',
    '- Prefer ask_human over a vague continue. If you cannot articulate a concrete nextAction, returning ask_human is the correct move — do not stall by emitting filler continues (they are downgraded to ask_human automatically and just waste a round-trip).',
    '- A factual answer to a user question (e.g. "yes, there are 3 uncommitted files") is typically complete for that turn; the user asked a question, the agent answered it. Do not treat state reports as proposed work.',
    '- A user-set supervision rule phrased conditionally ("if asked", "when X") is conditional. Check whether the condition actually fires in the current turn before using it to justify continue.',
    '- When the assistant itself says remaining implementation work (tests, fixes, commit/push) is still pending, choose continue AND spell out what to do in nextAction.',
    buildImcodesWorkflowBackgroundSection(),
    buildCustomInstructionsSection(resolveSupervisionCustomInstructionsDetail(request.snapshot)),
    request.description ? `Context: ${request.description}` : '',
    'Task request:',
    request.taskRequest,
    'Most recent assistant response:',
    request.assistantResponse?.trim() || '(no assistant response captured)',
  ].filter(Boolean).join('\n\n');
}

export function buildSupervisionDecisionRepairPrompt(
  request: SupervisionBrokerRequest,
  previousOutput: string,
  contractId: string = SUPERVISION_CONTRACT_IDS.DECISION_REPAIR,
): string {
  return [
    `[Contract: ${contractId}]`,
    'Your previous response was invalid.',
    'Return exactly one valid JSON object and nothing else.',
    '{"decision":"complete|continue|ask_human","reason":"...","confidence":0.0,"gap":"...","nextAction":"...","extra":{}}',
    'When decision is continue, BOTH gap and nextAction are required; nextAction must be a concrete imperative instruction, not a filler like "keep going" / "继续完成任务". If you cannot name a concrete next action, return ask_human instead — a vague continue is always downgraded to ask_human anyway.',
    'If the assistant response mentions remaining implementation work like tests, fixes, verification, commit/push, or another concrete next engineering step, return continue with a nextAction that names the exact command or deliverable.',
    buildImcodesWorkflowBackgroundSection(),
    buildCustomInstructionsSection(resolveSupervisionCustomInstructionsDetail(request.snapshot)),
    'Previous invalid output:',
    previousOutput,
    'Task request:',
    request.taskRequest,
    'Most recent assistant response:',
    request.assistantResponse?.trim() || '(no assistant response captured)',
  ].join('\n\n');
}

/**
 * Narrow input shape for the continue-prompt builder. Legacy call sites may
 * still pass a bare reason string; new callers — supervision-automation's
 * dispatcher — pass the full object so the target agent receives the
 * supervisor's concrete imperative `nextAction` as the lead of the prompt,
 * which is how the "agent has nothing to do → rewrites the same reply →
 * supervision loop" pattern gets broken.
 */
export interface SupervisionContinueInstructions {
  reason: string;
  nextAction?: string;
  gap?: string;
}

export function buildSupervisionContinuePrompt(
  taskRequest: string,
  assistantResponse: string | undefined,
  /**
   * Either a legacy reason string or a structured decision-derived object.
   * Structured form is preferred — `nextAction` is rendered as the top-most
   * imperative line in the outgoing prompt.
   */
  instructions: string | SupervisionContinueInstructions,
  /**
   * Pre-classified supervision rules. A plain `string` is accepted for
   * backward compatibility — it will be treated as session-specific, matching
   * the historical label. Callers with access to the snapshot should pass the
   * detail form (or use `resolveSupervisionCustomInstructionsDetail`) so the
   * heading reflects the real origin (global / session / merged).
   */
  customInstructions?: string | SupervisionCustomInstructionsDetail,
  contractId: string = SUPERVISION_CONTRACT_IDS.CONTINUE,
): string {
  // Continue prompt goes to the TARGET session's chat (user-visible), not to
  // the supervisor judge. It must stay a lightweight nudge — the IM.codes
  // capability background is NOT injected here, because:
  //   1. The target session already has `customInstructions` in its own
  //      system prompt / session config, and its chat history retains the
  //      original user request and last assistant turn.
  //   2. The capability docs are authored to help the SUPERVISOR classify
  //      workflows (OpenSpec / P2P / imcodes send) as autonomous work, not
  //      to re-teach the target agent what tools it already has.
  // Previously this function appended buildImcodesWorkflowBackgroundSection()
  // here; that dumped ~80 lines of operator-facing docs into every continue
  // turn, leaking into user-visible chat and polluting downstream P2P runs
  // that harvested the latest message as `userText`.
  //
  // The taskRequest + assistantResponse restatements are kept because some
  // transport providers rehydrate conversation state per-turn from the
  // payload rather than from server-side history; dropping them risks the
  // agent losing task framing mid-run. They're cheap (a few KB) compared to
  // the background block we removed.
  // Normalize the structured/legacy instructions into a single shape so the
  // render can pull reason / nextAction / gap uniformly.
  const parsed: SupervisionContinueInstructions = typeof instructions === 'string'
    ? { reason: instructions }
    : instructions;
  const reason = parsed.reason;
  const nextAction = parsed.nextAction?.trim();
  const gap = parsed.gap?.trim();
  // Normalize: a bare string keeps the old "session-specific" label; a
  // detail object drives the correct heading per its `source` tag. Both
  // empty → section is omitted entirely.
  const detail: SupervisionCustomInstructionsDetail | undefined =
    typeof customInstructions === 'string'
      ? classifySupervisionCustomInstructions(undefined, customInstructions, undefined)
      : customInstructions;
  return [
    `[Contract: ${contractId}]`,
    'Continue working on the same task.',
    // Lead with the imperative nextAction when available. This is the fix
    // for the "supervision keeps tugging back and forth" loop: when the
    // supervisor named a concrete next step, the target reads it here
    // first and has something actionable to execute. Without this, the
    // agent only saw "Supervisor reason: ..." and had to infer what to do
    // — which often meant rewriting the same answer.
    nextAction ? `Next action required: ${nextAction}` : null,
    gap ? `What's missing: ${gap}` : null,
    `Supervisor reason: ${reason}`,
    'Do not restart from scratch or restate completed work.',
    'Focus only on the remaining steps needed to finish the task.',
    'If you are truly blocked or need clarification, say that explicitly.',
    buildCustomInstructionsSection(detail) || null,
    '',
    'Original task request:',
    taskRequest,
    '',
    'Most recent assistant response:',
    assistantResponse?.trim() || '(no assistant response captured)',
  ].filter((line): line is string => line !== null).join('\n');
}

export function appendTaskRunContract(
  userText: string,
  contractId: string = SUPERVISION_CONTRACT_IDS.TASK_RUN_STATUS,
): string {
  return [
    userText.trim(),
    '',
    `[Contract: ${contractId}]`,
    'Complete the task normally, then end your final response with exactly one terminal marker and nothing after it.',
    `Use ${TASK_RUN_STATUS_MARKERS.COMPLETE} only when the task is complete.`,
    `Use ${TASK_RUN_STATUS_MARKERS.NEEDS_INPUT} only when you need the human to continue.`,
    `Use ${TASK_RUN_STATUS_MARKERS.BLOCKED} only when you are blocked and cannot proceed.`,
    'Never emit more than one task-run marker in the same terminal response.',
  ].join('\n');
}

export function buildOpenSpecAutomationAuditPromptAppend(
  auditMode: string,
  taskRequest: string,
  terminalState: string,
  changeDir: string,
): string {
  return [
    `[Contract: ${SUPERVISION_CONTRACT_IDS.OPENSPEC_IMPLEMENTATION_AUDIT}]`,
    `Selected automation audit mode: ${auditMode}`,
    `Task request: ${taskRequest}`,
    `Task terminal state: ${terminalState}`,
    `OpenSpec change directory: ${changeDir}`,
    'Audit the implementation-only path against the attached proposal, design, tasks, specs, changed files, and validation output.',
    'Do not rerun discussion or proposal phases.',
    `Return exactly one verdict marker: ${AUDIT_VERDICT_MARKERS.PASS} or ${AUDIT_VERDICT_MARKERS.REWORK}.`,
  ].join('\n');
}

export function buildContextualAutomationAuditPromptAppend(
  auditMode: string,
  taskRequest: string,
  terminalState: string,
): string {
  return [
    `[Contract: ${SUPERVISION_CONTRACT_IDS.CONTEXTUAL_AUDIT}]`,
    `Selected automation audit mode: ${auditMode}`,
    `Task request: ${taskRequest}`,
    `Task terminal state: ${terminalState}`,
    'Audit the implementation result against the original request and recent execution summary.',
    `Return exactly one verdict marker: ${AUDIT_VERDICT_MARKERS.PASS} or ${AUDIT_VERDICT_MARKERS.REWORK}.`,
  ].join('\n');
}

export function buildReworkBriefPrompt(
  sessionName: string,
  userText: string,
  lastAssistantText: string | undefined,
  verdictText: string,
): string {
  return [
    `[Contract: ${SUPERVISION_CONTRACT_IDS.REWORK_BRIEF}]`,
    'Audit verdict: REWORK',
    `Session: ${sessionName}`,
    `Request: ${userText}`,
    `Current assistant result: ${lastAssistantText ?? '(none)'}`,
    '',
    'Audit feedback:',
    verdictText,
    '',
    'Apply the required fixes and continue the same task.',
  ].join('\n');
}
