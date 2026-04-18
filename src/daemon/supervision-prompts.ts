import {
  AUDIT_VERDICT_MARKERS,
  SUPERVISION_CONTRACT_IDS,
  TASK_RUN_STATUS_MARKERS,
} from '../../shared/supervision-config.js';
import type { SupervisionBrokerRequest } from './supervision-broker.js';

function buildCustomInstructionsSection(customInstructions: string | undefined): string {
  const trimmed = customInstructions?.trim();
  if (!trimmed) return '';
  return [
    'Session-specific supervision instructions from the user:',
    trimmed,
  ].join('\n');
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
    '{"decision":"complete|continue|ask_human","reason":"...","confidence":0.0}',
    'Use complete only when the task is sufficiently done for the current request.',
    'Use continue only when the task is not done yet and the agent should keep working autonomously.',
    'Use ask_human when the agent needs clarification, approval, or manual intervention.',
    'Important completion guardrails:',
    '- If the assistant says tests, validation, fixes, commit/push, or other implementation work still needs to be done, choose continue.',
    '- If the assistant proposes a concrete next engineering step such as adding tests, fixing issues, verifying results, committing, or pushing, treat that as not complete yet.',
    '- Do not choose complete when the assistant itself indicates remaining work, TODOs, missing validation, or a follow-up implementation step.',
    buildCustomInstructionsSection(request.snapshot?.customInstructions),
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
    '{"decision":"complete|continue|ask_human","reason":"...","confidence":0.0}',
    'If the assistant response mentions remaining implementation work like tests, fixes, verification, commit/push, or another concrete next engineering step, return continue instead of complete.',
    buildCustomInstructionsSection(request.snapshot?.customInstructions),
    'Previous invalid output:',
    previousOutput,
    'Task request:',
    request.taskRequest,
    'Most recent assistant response:',
    request.assistantResponse?.trim() || '(no assistant response captured)',
  ].join('\n\n');
}

export function buildSupervisionContinuePrompt(
  taskRequest: string,
  assistantResponse: string | undefined,
  reason: string,
  customInstructions?: string,
  contractId: string = SUPERVISION_CONTRACT_IDS.CONTINUE,
): string {
  return [
    `[Contract: ${contractId}]`,
    'Continue working on the same task.',
    `Supervisor reason: ${reason}`,
    'Do not restart from scratch or restate completed work.',
    'Focus only on the remaining steps needed to finish the task.',
    'If you are truly blocked or need clarification, say that explicitly.',
    buildCustomInstructionsSection(customInstructions),
    '',
    'Original task request:',
    taskRequest,
    '',
    'Most recent assistant response:',
    assistantResponse?.trim() || '(no assistant response captured)',
  ].join('\n');
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
