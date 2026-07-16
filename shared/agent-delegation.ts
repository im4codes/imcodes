import { isSessionAgentType } from './agent-types.js';
import { isValidImcodesSessionName } from './session-scope.js';

export const AGENT_DELEGATION_TARGET_FIELD = 'delegateTarget' as const;

export interface AgentDelegationTargetPayload {
  session: string;
}

export const AGENT_DELEGATION_ERROR_CODES = {
  MIXED_DELEGATION_P2P_FIELDS: 'mixed_delegation_p2p_fields',
  INVALID_DELEGATION_TARGET: 'invalid_delegation_target',
  DELEGATION_SELF_TARGET: 'delegation_self_target',
  DELEGATION_TARGET_UNAVAILABLE: 'delegation_target_unavailable',
  DELEGATION_TARGET_FORBIDDEN: 'delegation_target_forbidden',
  DELEGATION_TARGET_NOT_REPLY_CAPABLE: 'delegation_target_not_reply_capable',
  DELEGATION_EMPTY_TASK: 'delegation_empty_task',
  DELEGATION_UNSUPPORTED_INPUT: 'delegation_unsupported_input',
} as const;

export type AgentDelegationErrorCode = (typeof AGENT_DELEGATION_ERROR_CODES)[keyof typeof AGENT_DELEGATION_ERROR_CODES];

export const MIXED_DELEGATION_P2P_FIELDS = AGENT_DELEGATION_ERROR_CODES.MIXED_DELEGATION_P2P_FIELDS;
export const INVALID_DELEGATION_TARGET = AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET;
export const DELEGATION_SELF_TARGET = AGENT_DELEGATION_ERROR_CODES.DELEGATION_SELF_TARGET;
export const DELEGATION_TARGET_UNAVAILABLE = AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_UNAVAILABLE;
export const DELEGATION_TARGET_FORBIDDEN = AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_FORBIDDEN;
export const DELEGATION_TARGET_NOT_REPLY_CAPABLE = AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_NOT_REPLY_CAPABLE;
export const DELEGATION_EMPTY_TASK = AGENT_DELEGATION_ERROR_CODES.DELEGATION_EMPTY_TASK;
export const DELEGATION_UNSUPPORTED_INPUT = AGENT_DELEGATION_ERROR_CODES.DELEGATION_UNSUPPORTED_INPUT;

export const AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER = '<imcodes-agent-delegation-reply-instruction-v1>' as const;
export const AGENT_DELEGATION_CONTEXT_HEADER = 'Recent context from the origin session (sanitized, bounded):' as const;
export const AGENT_DELEGATION_CONTEXT_OMITTED_MARKER = '[delegation-context-omitted]' as const;
export const AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER = '[delegation-context-truncated]' as const;

export type DelegationContextStatus = 'ok' | 'truncated' | 'omitted';

export const DELEGATION_REPLY_CAPABLE_AGENT_TYPES = [
  'claude-code-sdk',
  'claude-code',
  'codex-sdk',
  'codex',
  'copilot-sdk',
  'cursor-headless',
  'opencode',
  'gemini-sdk',
  'grok-sdk',
  'gemini',
  'qwen',
  'openclaw',
  'kimi-sdk',
] as const;
export type DelegationReplyCapableAgentType = typeof DELEGATION_REPLY_CAPABLE_AGENT_TYPES[number];

// Back-compat export: older imports used the "PROCESS" name before SDK
// transport sessions became valid delegation targets.
export const DELEGATION_REPLY_CAPABLE_PROCESS_AGENT_TYPES = DELEGATION_REPLY_CAPABLE_AGENT_TYPES;
export type DelegationReplyCapableProcessAgentType = DelegationReplyCapableAgentType;

export function isDelegationReplyCapableAgentType(agentType: string | null | undefined): agentType is DelegationReplyCapableAgentType {
  return typeof agentType === 'string'
    && (DELEGATION_REPLY_CAPABLE_AGENT_TYPES as readonly string[]).includes(agentType);
}

export const AGENT_DELEGATION_FORBIDDEN_COMMAND_FIELDS = [
  'replyTo',
  'origin',
  'originSession',
  'originOverride',
  'context',
  'clientContext',
  'contextTail',
  'delegationContext',
  'files',
  'attachments',
  'quotedMessage',
  'quote',
  'quotes',
  'fileRefs',
  'fileReferences',
  'broadcast',
  'clone',
  'idempotencyKey',
  'delegationId',
  'sharedActor',
  'shareScope',
] as const;

export type AgentDelegationForbiddenCommandField = typeof AGENT_DELEGATION_FORBIDDEN_COMMAND_FIELDS[number];

export const AGENT_DELEGATION_MIXED_P2P_FIELDS = [
  'p2pAtTargets',
  'directTargetSession',
  'directTargetMode',
  'p2pMode',
  'p2pSessionConfig',
  'p2pWorkflowLaunchEnvelope',
  'workflowLaunchEnvelope',
  'p2pRounds',
  'p2pExtraPrompt',
  'p2pLocale',
  'p2pHopTimeoutMs',
  'p2pExcludeSameType',
  'p2pAdvancedPresetKey',
  'p2pAdvancedRounds',
  'p2pAdvancedRunTimeoutMinutes',
  'p2pContextReducer',
  'dedicatedExecutionRouting',
] as const;

export type AgentDelegationMixedP2pField = typeof AGENT_DELEGATION_MIXED_P2P_FIELDS[number] | `p2p${string}`;

const P2P_CONTROL_TOKEN_RE = /@@(?:discuss|all|p2p-config)\([^\n\r]*\)/gi;
const IMCODES_NO_REPLY_LINE_RE = /^.*\bimcodes\s+send\s+--no-reply\b.*$/gim;
const REPLY_INSTRUCTION_LINE_RE = /^.*After completing the above task, send your response using:.*$/gim;
const MARKED_REPLY_BLOCK_RE = new RegExp(`^.*${escapeRegExp(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER)}.*$`, 'gim');
const DELEGATION_CONTROL_LINE_RE = /^.*\b(?:delegateTarget|delegationId|delegationContext|contextTail)\b\s*[:=].*$/gim;
const UNSUPPORTED_CONTROL_TEXT_RE = /^\s*\/(?:stop\b|model\s+\S+|(?:thinking|effort)\s+\S+|clear\b|compact\b|resume\b|restart\b)/i;

export function isCanonicalAgentDelegationSessionName(sessionName: string): boolean {
  return isValidImcodesSessionName(sessionName)
    && sessionName === sessionName.trim()
    && sessionName !== '__all__'
    && !isSessionAgentType(sessionName);
}

export function parseAgentDelegationTargetPayload(value: unknown):
  | { ok: true; payload: AgentDelegationTargetPayload }
  | { ok: false; error: typeof AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET; code: typeof AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET, code: AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== 'session') {
    return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET, code: AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET };
  }
  const session = (value as { session?: unknown }).session;
  if (typeof session !== 'string' || !isCanonicalAgentDelegationSessionName(session)) {
    return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET, code: AGENT_DELEGATION_ERROR_CODES.INVALID_DELEGATION_TARGET };
  }
  return { ok: true, payload: { session } };
}

export function hasAgentDelegationTargetField(value: unknown): value is Record<typeof AGENT_DELEGATION_TARGET_FIELD, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, AGENT_DELEGATION_TARGET_FIELD);
}

export function findForbiddenAgentDelegationCommandFields(value: unknown): AgentDelegationForbiddenCommandField[] {
  if (!hasAgentDelegationTargetField(value)) return [];
  return AGENT_DELEGATION_FORBIDDEN_COMMAND_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(value, field));
}

export function findMixedAgentDelegationP2pFields(value: unknown): string[] {
  if (!hasAgentDelegationTargetField(value) || !value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const fields = new Set<string>();
  for (const field of AGENT_DELEGATION_MIXED_P2P_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) fields.add(field);
  }
  for (const key of Object.keys(record)) {
    if (/^p2p[A-Z0-9_]/.test(key)) fields.add(key);
  }
  return [...fields];
}

export function hasLegacyP2pControlToken(text: string): boolean {
  P2P_CONTROL_TOKEN_RE.lastIndex = 0;
  return P2P_CONTROL_TOKEN_RE.test(text);
}

export function isDelegationUnsupportedControlText(text: string): boolean {
  return UNSUPPORTED_CONTROL_TEXT_RE.test(text);
}

export function buildAgentDelegationReplyInstruction(replyToSession: string): string {
  if (!isCanonicalAgentDelegationSessionName(replyToSession)) return '';
  return `${AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER}\nAfter completing the above task, send your response using: imcodes send ${JSON.stringify(replyToSession)} ${JSON.stringify('Task: <brief summary of the request>\nResult: <your response>')}`;
}

export interface AgentDelegationOrchestrationPromptInput {
  targetSession: string;
  targetLabel?: string | null;
  task: string;
}

export function buildAgentDelegationOrchestrationPrompt(input: AgentDelegationOrchestrationPromptInput): string {
  const targetSession = input.targetSession.trim();
  const targetLabel = input.targetLabel?.trim();
  const task = input.task.trim();
  const displayTarget = targetLabel && targetLabel !== targetSession
    ? `${targetLabel} (${targetSession})`
    : targetSession;
  return [
    'You are the current session orchestrator for an agent delegation.',
    '',
    `Selected delegate: ${displayTarget}`,
    `Exact delegate target session: ${targetSession}`,
    '',
    'User task to delegate:',
    task,
    '',
    'Before contacting the delegate, organize the relevant current-session context yourself: summarize the goal, constraints, repo paths, recent decisions, current state, and acceptance criteria the delegate needs. Do not send the raw user task by itself.',
    '',
    'Then dispatch a self-contained delegation brief to the selected delegate using the exact target session above, and require a reply. Prefer the available send_message tool with reply enabled when present; otherwise use:',
    `imcodes send --reply ${JSON.stringify(targetSession)} ${JSON.stringify('Task: <self-contained brief>\nContext: <relevant current-session facts>\nAcceptance criteria: <how to verify>\nReply: send the result back to this session when done')}`,
    'A reply-enabled send already routes the delegate response back into this session as a normal incoming message. After dispatch, do not poll the delegate, session status, logs, or transcripts; wait for the reply to arrive.',
    '',
    'If the user selected or mentioned multiple @ delegates, split the work into separate per-delegate briefs, dispatch each one independently with reply required, and track/report each delegate result separately.',
    '',
    'Keep this session responsible for orchestration and final judgment. Do not implement the delegated task yourself unless implementation is needed only to prepare or verify the delegation brief.',
  ].join('\n');
}

export function isAgentDelegationForwardedPayloadText(text: string): boolean {
  return text.includes(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER)
    || text.includes(AGENT_DELEGATION_CONTEXT_HEADER)
    || text.includes(AGENT_DELEGATION_CONTEXT_OMITTED_MARKER)
    || text.includes(AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER);
}

export function isAgentDelegationControlInstructionText(text: string): boolean {
  return isAgentDelegationForwardedPayloadText(text)
    || REPLY_INSTRUCTION_LINE_RE.test(resetRegex(REPLY_INSTRUCTION_LINE_RE, text))
    || IMCODES_NO_REPLY_LINE_RE.test(resetRegex(IMCODES_NO_REPLY_LINE_RE, text))
    || DELEGATION_CONTROL_LINE_RE.test(resetRegex(DELEGATION_CONTROL_LINE_RE, text))
    || hasLegacyP2pControlToken(text);
}

export function stripAgentDelegationControlInstructions(text: string): string {
  return text
    .replace(MARKED_REPLY_BLOCK_RE, '')
    .replace(REPLY_INSTRUCTION_LINE_RE, '')
    .replace(IMCODES_NO_REPLY_LINE_RE, '')
    .replace(DELEGATION_CONTROL_LINE_RE, '')
    .replace(P2P_CONTROL_TOKEN_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resetRegex(regex: RegExp, text: string): string {
  regex.lastIndex = 0;
  return text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
