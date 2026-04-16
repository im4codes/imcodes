import {
  AUDIT_VERDICT_MARKERS,
  SUPERVISION_CONTRACT_IDS,
  TASK_RUN_STATUS_MARKERS,
} from '../../shared/supervision-config.js';
import type { SupervisionBrokerRequest } from './supervision-broker.js';

export function buildSupervisionDecisionPrompt(
  request: SupervisionBrokerRequest,
  contractId: string = SUPERVISION_CONTRACT_IDS.DECISION,
): string {
  return [
    `[Contract: ${contractId}]`,
    'You are a supervision arbiter for a coding session.',
    'Return exactly one JSON object and nothing else.',
    '{"decision":"approve|deny|ask_human","reason":"...","confidence":0.0}',
    'Approve only when continuing is reasonable and low-risk for the stated task.',
    'Deny when the requested continuation is clearly unsafe or out of scope.',
    'Use ask_human when uncertain.',
    request.description ? `Context: ${request.description}` : '',
    'Request:',
    request.prompt,
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
    '{"decision":"approve|deny|ask_human","reason":"...","confidence":0.0}',
    'Previous invalid output:',
    previousOutput,
    'Original request:',
    request.prompt,
  ].join('\n\n');
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
    'Apply the required fixes and finish the task again.',
    'End the next terminal response with exactly one valid task-run marker.',
  ].join('\n');
}
