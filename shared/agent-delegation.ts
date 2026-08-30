import { P2P_ROUTING_FIELDS } from './p2p-routing-fields.js';
import { isSessionAgentType } from './agent-types.js';
import { CODEBUDDY_PROVIDER_IDS } from './codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from './hermes-agent.js';
import { isValidImcodesSessionName } from './session-scope.js';
import { PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS } from './peer-audit.js';

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
export const AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER = '<imcodes-agent-delegation-reply-instruction-v2>' as const;
export const AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER = '<imcodes-delegation-completed-v1>' as const;
export const AGENT_DELEGATION_REPLY_TIMELINE_EVENT = 'delegation.reply' as const;
export const AGENT_DELEGATION_REPLY_VERSION = 'agent_delegation_reply_v1' as const;
export const AGENT_DELEGATION_REPLY_TOTAL_BYTES = 64 * 1024;
export const AGENT_DELEGATION_REPLY_RESULT_BYTES = 48 * 1024;
export const AGENT_DELEGATION_REPLY_TTL_MS = 24 * 60 * 60_000;
export const AGENT_DELEGATION_REPLY_MAX_MESSAGES = 64;
export const AGENT_DELEGATION_ID_MAX_BYTES = 256;
export const AGENT_DELEGATION_REPLY_ERRORS = {
  OVERSIZE: 'oversize',
  MALFORMED: 'malformed',
  INVALID_VERSION: 'invalid_version',
  UNKNOWN_FIELD: 'unknown_field',
  INVALID_DELEGATION_ID: 'invalid_delegation_id',
  INVALID_RESULT: 'invalid_result',
  IDENTITY_MISMATCH: 'identity_mismatch',
  EXPIRED: 'expired',
  ALREADY_REPLIED: 'already_replied',
  NOTIFICATION_UNSUPPORTED: 'notification_unsupported',
  DELIVERY_PENDING: 'delivery_pending',
  RATE_LIMITED: 'rate_limited',
} as const;
export type AgentDelegationReplyError =
  (typeof AGENT_DELEGATION_REPLY_ERRORS)[keyof typeof AGENT_DELEGATION_REPLY_ERRORS];

export interface AgentDelegationReplyEnvelope {
  version: typeof AGENT_DELEGATION_REPLY_VERSION;
  delegationId: string;
  result: string;
}

export interface AgentDelegationReplyAuthority {
  delegationId: string;
  /** Present only for a supervision audit; selects the dedicated reply ingress. */
  audit?: AgentDelegationAuditRequest;
}

export const AGENT_DELEGATION_BLOCKER_REPORT_FIELDS = [
  'taskId',
  'assignmentId',
  'exactError',
  'completedSafeWork',
  'recommendedNextAction',
] as const;

export interface AgentDelegationBlockerContext {
  taskId: string;
  assignmentId: string;
}

export const AGENT_DELEGATION_BLOCKER_ESCALATION_PROMPT =
  'Delegated blocker escalation: if a worker or auditor encounters a blocker, illegal_transition, contract contradiction, needs Brain adjudication, or cannot safely continue, it must immediately use its authenticated reply-capable channel to report taskId, assignmentId, exactError, completedSafeWork, and recommendedNextAction before waiting. A child-only NEEDS_INPUT message is not a report. The daemon only supplies deduplicated heartbeat/continue reminders and never substitutes audit-result chat.' as const;

/**
 * Machine-facing escalation contract for delegated work.
 *
 * A child session must not turn a local NEEDS_INPUT/illegal-transition into a
 * silent wait that is visible only after somebody opens that session. The
 * daemon-authenticated current-session identity is the return authority to the
 * coordinating Brain; this instruction pins both durable ids so a report cannot be detached from
 * the assignment that encountered the blocker.
 */
export function buildAgentDelegationBlockerReportInstruction(
  context: AgentDelegationBlockerContext,
): string {
  const taskId = context.taskId.trim();
  const assignmentId = context.assignmentId.trim();
  if (!taskId || !assignmentId) return '';
  return [
    '[Delegated blocker escalation contract]',
    AGENT_DELEGATION_BLOCKER_ESCALATION_PROMPT,
    'Do not merely print "needs takeover" in this child session and wait; the user must not have to open child sessions to discover blockers.',
    `The report result must be one JSON object with exactly these fields: ${AGENT_DELEGATION_BLOCKER_REPORT_FIELDS.join(', ')}.`,
    `Use taskId=${JSON.stringify(taskId)} and assignmentId=${JSON.stringify(assignmentId)}; exactError must preserve the precise refusal/error, completedSafeWork must list only work safely completed, and recommendedNextAction must request the concrete Brain adjudication or next step.`,
    'For an audit, peer_audit_reply remains the only PASS/REWORK verdict channel; delegation_reply may be used for this blocker report but must never claim a verdict.',
  ].join('\n');
}

export const AGENT_DELEGATION_PURPOSES = {
  SUPERVISION_AUDIT: 'supervision_audit',
} as const;
export type AgentDelegationPurpose =
  (typeof AGENT_DELEGATION_PURPOSES)[keyof typeof AGENT_DELEGATION_PURPOSES];

export interface AgentDelegationAuditRequest {
  kind: typeof AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT;
  attemptId: string;
  /** Only an explicit user requirement may disable same-family degradation. */
  strictCrossVendor?: boolean;
  /**
   * The session being audited. REQUIRED for a supervision audit.
   *
   * Audited identity is STATED, never inferred. It is not the caller (the
   * Supervisor Brain dispatches audits it is not the subject of), not the
   * target (the auditor), not the task owner, and not a candidate ordering.
   * Every one of those inferences has been wrong in practice, so the field is
   * required and the daemon fails closed when it is absent.
   */
  auditedSessionName: string;
  /** Durable registry bindings added by the daemon after assignment creation. */
  taskId?: string;
  assignmentId?: string;
  revision?: string;
}

/**
 * Build the supervision-audit envelope.
 *
 * The ONE place the envelope is constructed, so a required field cannot be
 * forgotten at one call site and present at another. Callers pass the audited
 * session explicitly; nothing here defaults or infers it.
 */
export function buildAgentDelegationAuditEnvelope(input: {
  attemptId: string;
  auditedSessionName: string;
  strictCrossVendor?: boolean;
}): AgentDelegationAuditRequest {
  // Runtime guard, not belt-and-braces. The type alone does NOT make omission
  // impossible: the root tsconfig excludes `test/`, and vitest strips types
  // without checking them, so an untypechecked caller can pass undefined here.
  // JSON.stringify would then silently drop the key and emit an envelope the
  // parser is guaranteed to reject -- a re-audit loop that dies quietly. Fail
  // loudly at construction instead of shipping a poisoned prompt.
  if (typeof input.auditedSessionName !== 'string' || !input.auditedSessionName.trim()) {
    throw new Error('supervision audit envelope requires a non-empty auditedSessionName');
  }
  return {
    kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
    attemptId: input.attemptId,
    auditedSessionName: input.auditedSessionName,
    ...(input.strictCrossVendor === true ? { strictCrossVendor: true } : {}),
  };
}

export const AGENT_DELEGATION_REPLY_STATUSES = {
  PENDING: 'pending',
  RECEIVED: 'received',
  DELIVERED: 'delivered',
  EXPIRED: 'expired',
} as const;
export type AgentDelegationReplyStatus =
  (typeof AGENT_DELEGATION_REPLY_STATUSES)[keyof typeof AGENT_DELEGATION_REPLY_STATUSES];

export const AGENT_DELEGATION_NOTIFICATION_RESULTS = {
  DELIVERED: 'delivered',
  STALE: 'stale',
  UNSUPPORTED: 'unsupported',
} as const;
export type AgentDelegationNotificationResult =
  (typeof AGENT_DELEGATION_NOTIFICATION_RESULTS)[keyof typeof AGENT_DELEGATION_NOTIFICATION_RESULTS];

export const AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES = {
  NATIVE: 'native',
  UNSUPPORTED: 'unsupported',
} as const;
export type AgentDelegationActiveNotificationMode =
  (typeof AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES)[keyof typeof AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES];
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
  'opencode-sdk',
  'opencode',
  'gemini-sdk',
  'grok-sdk',
  'gemini',
  'qwen',
  'openclaw',
  'kimi-sdk',
  HERMES_AGENT_PROVIDER_ID,
  'deepseek-harness',
  'pi',
  CODEBUDDY_PROVIDER_IDS.CHINA,
  CODEBUDDY_PROVIDER_IDS.INTERNATIONAL,
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

/**
 * Derived from `P2P_ROUTING_FIELDS` so the delegation rejection and the share
 * scope check cannot drift. `p2pExcludeSameType` is delegation-only — it tunes
 * a fan-out rather than naming a target — so it is appended here rather than
 * added to the routing list the share checker sweeps.
 */
export const AGENT_DELEGATION_MIXED_P2P_FIELDS = [
  ...P2P_ROUTING_FIELDS,
  'p2pExcludeSameType',
] as const;

export type AgentDelegationMixedP2pField = typeof AGENT_DELEGATION_MIXED_P2P_FIELDS[number] | `p2p${string}`;

const P2P_CONTROL_TOKEN_RE = /@@(?:discuss|all|p2p-config)\([^\n\r]*\)/gi;
const IMCODES_NO_REPLY_LINE_RE = /^.*\bimcodes\s+send\s+--no-reply\b.*$/gim;
const REPLY_INSTRUCTION_LINE_RE = /^.*After completing the above task, send your response using:.*$/gim;
const MARKED_REPLY_BLOCK_RE = new RegExp(
  `^.*(?:${escapeRegExp(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER)}|${escapeRegExp(AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER)}).*(?:\\r?\\n[^\\r\\n]*)?`,
  'gim',
);
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

export function buildAgentDelegationReplyInstruction(
  replyToSession: string,
  authority?: AgentDelegationReplyAuthority,
): string {
  if (!isCanonicalAgentDelegationSessionName(replyToSession)) return '';
  if (authority) {
    if (!isAgentDelegationOpaqueId(authority.delegationId)) return '';
    if (authority.audit?.kind === AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT) {
      return [
        `${AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER} ${JSON.stringify({ delegationId: authority.delegationId })}`,
        'This is a supervision audit receipt channel. Do not use delegation_reply for this audit.',
        'Use the peer_audit_reply tool with these exact fields:',
        `{ "taskId": ${JSON.stringify(authority.audit.taskId ?? '')}, "assignmentId": ${JSON.stringify(authority.audit.assignmentId ?? '')}, "attemptId": ${JSON.stringify(authority.audit.attemptId)}, "revision": ${JSON.stringify(authority.audit.revision ?? '')}, "receiptKind": "progress|final", "verdict": "PASS|REWORK (final only)", "findings": "<bounded findings>", "validations": [{ "kind": "test", "label": "<check>", "outcome": "passed|failed|unavailable", "summary": "<exact result or reason>" }] }`,
        'Receipts are authenticated by the daemon-bound current session and registry assignment; no token is supplied. Progress and corrected final receipts append to the same attempt. After the accepted final receipt, finish this exact auditor assignment so the overall gate can advance.',
      ].join('\n');
    }
    return [
      `${AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER} ${JSON.stringify(authority)}`,
      `Use the delegation_reply tool with delegationId plus result: "<your response>" whenever you need to reply. The daemon authenticates the current session and accepts multiple append-only replies for the same delegation; each reply is routed directly to ${JSON.stringify(replyToSession)}. Do not use send_message or imcodes send for these replies.`,
    ].join('\n');
  }
  return `${AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER}\nAfter completing the above task, send your response using: imcodes send ${JSON.stringify(replyToSession)} ${JSON.stringify('Task: <brief summary of the request>\nResult: <your response>')}`;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function agentDelegationByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isAgentDelegationOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && agentDelegationByteLength(value) <= AGENT_DELEGATION_ID_MAX_BYTES
    && BASE64URL_RE.test(value);
}

export function extractAgentDelegationReplyAuthorityFromInstruction(
  text: string,
): AgentDelegationReplyAuthority | undefined {
  for (const line of text.split(/\r?\n/)) {
    const markerIndex = line.indexOf(AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER);
    if (markerIndex < 0) continue;
    const raw = line.slice(markerIndex + AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER.length).trim();
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      const record = parsed as Record<string, unknown>;
      const keys = Object.keys(record);
      if ((keys.length !== 1 && keys.length !== 2)
        || !Object.prototype.hasOwnProperty.call(record, 'delegationId')
        || !isAgentDelegationOpaqueId(record.delegationId)
        || (keys.length === 2 && !Object.prototype.hasOwnProperty.call(record, 'replyCapability'))) return undefined;
      // replyCapability is accepted only as a historical marker field and is
      // intentionally discarded.
      return { delegationId: record.delegationId };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function decodeAgentDelegationReplyEnvelope(
  raw: unknown,
): { ok: true; value: AgentDelegationReplyEnvelope } | { ok: false; error: AgentDelegationReplyError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.MALFORMED };
  }
  const record = raw as Record<string, unknown>;
  const allowed = new Set(['version', 'delegationId', 'replyCapability', 'result']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.UNKNOWN_FIELD };
  }
  if (record.version !== AGENT_DELEGATION_REPLY_VERSION) {
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.INVALID_VERSION };
  }
  if (!isAgentDelegationOpaqueId(record.delegationId)) {
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.INVALID_DELEGATION_ID };
  }
  if (typeof record.result !== 'string'
    || !record.result.trim()
    || agentDelegationByteLength(record.result) > AGENT_DELEGATION_REPLY_RESULT_BYTES) {
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.INVALID_RESULT };
  }
  const value: AgentDelegationReplyEnvelope = {
    version: AGENT_DELEGATION_REPLY_VERSION,
    delegationId: record.delegationId,
    result: record.result,
  };
  if (agentDelegationByteLength(JSON.stringify(value)) > AGENT_DELEGATION_REPLY_TOTAL_BYTES) {
    return { ok: false, error: AGENT_DELEGATION_REPLY_ERRORS.OVERSIZE };
  }
  return { ok: true, value };
}

export interface AgentDelegationOrchestrationPromptInput {
  targetSession: string;
  targetLabel?: string | null;
  task: string;
  uiLocale?: string | null;
  /** Quick Audit only: keep repair -> re-audit -> PASS instructions in the orchestrator turn. */
  auditCycle?: boolean;
}

type AgentDelegationUiLocale = 'en' | 'zh-CN' | 'zh-TW' | 'es' | 'ru' | 'ja' | 'ko';

function normalizeAgentDelegationUiLocale(value: string | null | undefined): AgentDelegationUiLocale {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'zh-cn' || normalized?.startsWith('zh-hans')) return 'zh-CN';
  if (normalized === 'zh-tw' || normalized?.startsWith('zh-hant')) return 'zh-TW';
  if (normalized?.startsWith('es')) return 'es';
  if (normalized?.startsWith('ru')) return 'ru';
  if (normalized?.startsWith('ja')) return 'ja';
  if (normalized?.startsWith('ko')) return 'ko';
  return 'en';
}

const AGENT_DELEGATION_ORCHESTRATION_COPY: Record<AgentDelegationUiLocale, {
  orchestrator: string;
  targetLabel: string;
  targetId: (target: string) => string;
  task: string;
  prepare: string;
  send: (target: string) => string;
  fallback: string;
  wait: string;
  auditCycle: string[];
}> = {
  en: {
    orchestrator: 'You are the current session orchestrator for an agent delegation.', targetLabel: 'Target label',
    targetId: (target) => `Target ID (pass directly to send_message; do not look it up): ${target}`, task: 'Task',
    prepare: 'Prepare one concise, self-contained brief from the current context (goal, scope, relevant paths/state, decisions, validation, acceptance criteria, and risks). Do not forward the raw task alone.',
    send: (target) => `Send it exactly once with send_message(target=${JSON.stringify(target)}, reply=true). Do not call send_list_targets. If send_message is unavailable, use:`,
    fallback: 'Task: <self-contained brief>\nContext: <relevant current-session facts>\nAcceptance criteria: <how to verify>\nReply: send the result back to this session when done',
    wait: 'After sending, do not poll session state, logs, or transcripts; wait for reply notifications. Do not perform the delegated work unless needed only to prepare or verify the brief.',
    auditCycle: ['Quick Audit cycle after each delegated reply:', '- Outcome markers (emit neither before the reply): {PASS} or {REWORK}.', '- PASS: report the evidence, end with {PASS}, then continue any remaining delivery/finalization requested by the task.', '- REWORK is not a stopping response: do not merely output REWORK and wait. Apply the findings, run the relevant validation, prepare the next audit brief yourself, then send one fresh reply-enabled audit to the same Target ID.', '- Repeat repair -> re-audit autonomously until PASS. Only when an exact blocker or safety limit prevents another cycle, report it and end with the REWORK marker.', '- Never finalize the repository or delivery from a REWORK verdict.'],
  },
  'zh-CN': {
    orchestrator: '你是当前会话的代理委派编排者。', targetLabel: '目标显示名',
    targetId: (target) => `目标 ID（直接传给 send_message，不要再查询）：${target}`, task: '任务',
    prepare: '根据当前上下文准备一份简短、自包含的说明，包含目标、范围、相关路径/状态、决策、验证、验收标准和风险；不要只转发原始任务。',
    send: (target) => `只发送一次：send_message(target=${JSON.stringify(target)}, reply=true)。不要调用 send_list_targets。若 send_message 不可用，则使用：`,
    fallback: '任务：<自包含说明>\n上下文：<当前会话事实>\n验收标准：<如何验证>\n回执：完成后把结果发回本会话',
    wait: '发送后不要轮询会话状态、日志或记录；等待回执通知。除准备或核对说明外，不要代替受委派者执行审计。',
    auditCycle: ['每次委派回执后的快审循环：', '- 回执前不要输出结果标记；回执后只选 {PASS} 或 {REWORK}。', '- PASS：汇报证据，以 {PASS} 结束，再继续任务明确要求的剩余交付。', '- REWORK 不是停止：立即修复、验证，再向同一目标 ID 发送一次新的可回执复审。', '- 自主循环“修复→复审”直至 PASS；只有明确阻断或安全上限才可用 REWORK 停止。', '- REWORK 时绝不能做仓库或交付收尾。'],
  },
  'zh-TW': {
    orchestrator: '你是目前工作階段的代理委派編排者。', targetLabel: '目標顯示名',
    targetId: (target) => `目標 ID（直接傳給 send_message，不要再查詢）：${target}`, task: '任務',
    prepare: '依目前脈絡準備一份簡短、自包含的說明，包含目標、範圍、相關路徑/狀態、決策、驗證、驗收標準與風險；不要只轉發原始任務。',
    send: (target) => `只傳送一次：send_message(target=${JSON.stringify(target)}, reply=true)。不要呼叫 send_list_targets。若 send_message 不可用，則使用：`,
    fallback: '任務：<自包含說明>\n脈絡：<目前工作階段事實>\n驗收標準：<如何驗證>\n回覆：完成後把結果傳回本工作階段',
    wait: '傳送後不要輪詢工作階段狀態、日誌或記錄；等待回覆通知。除準備或核對說明外，不要代替受委派者執行審計。',
    auditCycle: ['每次委派回覆後的快審循環：', '- 回覆前不要輸出結果標記；回覆後只選 {PASS} 或 {REWORK}。', '- PASS：回報證據，以 {PASS} 結束，再繼續任務明確要求的剩餘交付。', '- REWORK 不是停止：立即修復、驗證，再向同一目標 ID 傳送一次新的可回覆複審。', '- 自主循環「修復→複審」直到 PASS；只有明確阻斷或安全上限才可用 REWORK 停止。', '- REWORK 時絕不能做儲存庫或交付收尾。'],
  },
  es: {
    orchestrator: 'Eres el orquestador de delegación de la sesión actual.', targetLabel: 'Etiqueta del destino',
    targetId: (target) => `ID de destino (pásalo directamente a send_message; no lo busques): ${target}`, task: 'Tarea',
    prepare: 'Prepara un resumen breve y autónomo del contexto actual: objetivo, alcance, rutas/estado, decisiones, validación, criterios de aceptación y riesgos. No reenvíes solo la tarea original.',
    send: (target) => `Envíalo una sola vez con send_message(target=${JSON.stringify(target)}, reply=true). No llames a send_list_targets. Si send_message no está disponible, usa:`,
    fallback: 'Tarea: <resumen autónomo>\nContexto: <hechos actuales>\nCriterios de aceptación: <cómo verificar>\nRespuesta: devuelve el resultado a esta sesión',
    wait: 'Después de enviarlo, no consultes estado, registros ni transcripciones; espera la notificación. No hagas el trabajo delegado salvo para preparar o verificar el resumen.',
    auditCycle: ['Ciclo de auditoría rápida tras cada respuesta:', '- Antes de la respuesta no emitas marcadores; después usa solo {PASS} o {REWORK}.', '- PASS: informa la evidencia, termina con {PASS} y continúa la entrega restante solicitada.', '- REWORK no detiene el flujo: corrige, valida y envía una nueva auditoría con respuesta al mismo ID.', '- Repite corrección y auditoría hasta PASS; solo un bloqueo exacto o límite de seguridad permite parar con REWORK.', '- Nunca finalices repositorio o entrega desde REWORK.'],
  },
  ru: {
    orchestrator: 'Вы координируете делегирование из текущей сессии.', targetLabel: 'Метка цели',
    targetId: (target) => `ID цели (передайте прямо в send_message; не ищите его): ${target}`, task: 'Задача',
    prepare: 'Подготовьте краткое самодостаточное описание текущего контекста: цель, область, пути/состояние, решения, проверки, критерии приёмки и риски. Не пересылайте только исходную задачу.',
    send: (target) => `Отправьте ровно один раз через send_message(target=${JSON.stringify(target)}, reply=true). Не вызывайте send_list_targets. Если send_message недоступен, используйте:`,
    fallback: 'Задача: <самодостаточное описание>\nКонтекст: <актуальные факты>\nКритерии: <как проверить>\nОтвет: верните результат в эту сессию',
    wait: 'После отправки не опрашивайте состояние, журналы или историю; ждите уведомления. Не выполняйте делегированную проверку, кроме подготовки описания.',
    auditCycle: ['Цикл быстрой проверки после каждого ответа:', '- До ответа не выводите маркеры; после него выберите только {PASS} или {REWORK}.', '- PASS: сообщите доказательства, завершите {PASS} и продолжите явно требуемую доставку.', '- REWORK не останавливает работу: исправьте, проверьте и отправьте новую проверку с ответом тому же ID.', '- Повторяйте исправление и проверку до PASS; остановка с REWORK допустима лишь при точной блокировке или лимите безопасности.', '- При REWORK нельзя завершать репозиторий или доставку.'],
  },
  ja: {
    orchestrator: '現在のセッションから代理委任を編成します。', targetLabel: '対象ラベル',
    targetId: (target) => `対象 ID（send_message に直接渡し、再検索しない）：${target}`, task: 'タスク',
    prepare: '現在の文脈から、目標、範囲、関連パス/状態、判断、検証、受入条件、リスクを含む簡潔で自己完結した説明を作成してください。元のタスクだけを転送しないでください。',
    send: (target) => `send_message(target=${JSON.stringify(target)}, reply=true) で1回だけ送信してください。send_list_targets は呼び出さないでください。send_message が使えない場合：`,
    fallback: 'タスク：<自己完結した説明>\n文脈：<現在の事実>\n受入条件：<検証方法>\n返信：完了後に結果をこのセッションへ返す',
    wait: '送信後はセッション状態、ログ、履歴をポーリングせず、返信通知を待ってください。説明の準備・確認以外で委任作業を代行しないでください。',
    auditCycle: ['各返信後のクイック監査サイクル：', '- 返信前は結果マーカーを出さず、返信後は {PASS} または {REWORK} の一方だけを使います。', '- PASS：証拠を報告し {PASS} で終え、明示された残りの引き渡しを続けます。', '- REWORK は停止ではありません。直ちに修正・検証し、同じ対象 ID へ新しい返信可能な再監査を送ります。', '- PASS まで修正と再監査を繰り返します。明確な障害か安全上限だけが REWORK での停止を許します。', '- REWORK からリポジトリや引き渡しを完了しないでください。'],
  },
  ko: {
    orchestrator: '현재 세션의 에이전트 위임을 조정합니다.', targetLabel: '대상 라벨',
    targetId: (target) => `대상 ID(send_message에 직접 전달하고 다시 조회하지 않음): ${target}`, task: '작업',
    prepare: '현재 문맥에서 목표, 범위, 관련 경로/상태, 결정, 검증, 수락 기준, 위험을 포함한 짧고 독립적인 설명을 준비하세요. 원래 작업만 전달하지 마세요.',
    send: (target) => `send_message(target=${JSON.stringify(target)}, reply=true)로 한 번만 보내세요. send_list_targets를 호출하지 마세요. send_message를 사용할 수 없으면 다음을 사용하세요:`,
    fallback: '작업: <독립적인 설명>\n문맥: <현재 사실>\n수락 기준: <검증 방법>\n회신: 완료 후 결과를 이 세션으로 반환',
    wait: '전송 후 세션 상태, 로그, 기록을 폴링하지 말고 회신 알림을 기다리세요. 설명 준비·검증 외에는 위임된 감사를 대신 수행하지 마세요.',
    auditCycle: ['각 회신 후 빠른 감사 순환:', '- 회신 전에는 결과 마커를 내보내지 말고, 회신 후 {PASS} 또는 {REWORK} 중 하나만 사용하세요.', '- PASS: 증거를 보고하고 {PASS}로 끝낸 뒤 명시된 남은 전달 작업을 계속하세요.', '- REWORK는 중단이 아닙니다. 즉시 수정·검증하고 같은 대상 ID로 새 회신 가능 재감사를 보내세요.', '- PASS까지 수정과 재감사를 반복하세요. 명확한 차단이나 안전 한도만 REWORK로 중단할 수 있습니다.', '- REWORK에서 저장소나 전달을 마무리하지 마세요.'],
  },
};

const AGENT_DELEGATION_ORCHESTRATION_TASK_BYTES = 4 * 1024;

function truncateAgentDelegationUtf8(value: string, maxBytes: number): string {
  if (agentDelegationByteLength(value) <= maxBytes) return value;
  const suffix = '\n[truncated]';
  const suffixBytes = agentDelegationByteLength(suffix);
  let used = 0;
  let output = '';
  for (const codePoint of value) {
    const bytes = agentDelegationByteLength(codePoint);
    if (used + bytes + suffixBytes > maxBytes) break;
    output += codePoint;
    used += bytes;
  }
  return output + suffix;
}

export const QUICK_AGENT_DELEGATION_PRESETS = ['audit', 'discussion', 'brainstorm', 'custom'] as const;
export type QuickAgentDelegationPreset = typeof QUICK_AGENT_DELEGATION_PRESETS[number];

export function buildQuickAgentDelegationTask(
  preset: QuickAgentDelegationPreset,
  customTask = '',
  uiLocale?: string | null,
): string {
  if (preset === 'custom') return customTask.trim();
  const locale = normalizeAgentDelegationUiLocale(uiLocale);
  const localized = {
    'zh-CN': {
      discussion: '与所选代理讨论本会话最近的工作。根据当前上下文整理目标、范围、近期决策、变更区域、已有验证、待解决问题和风险；请对方挑战方案、指出权衡或遗漏，并回复具体建议。',
      brainstorm: '与所选代理一起构思本会话最近工作的改进与下一步。根据当前上下文整理目标、约束、近期决策、当前实现和未解决问题；请对方给出实用替代方案、边界情况和优先级建议并回执。',
      audit: '请所选代理独立审计本会话最近的工作。根据当前上下文整理目标、范围、近期决策、变更文件或产物、实现状态、已有验证、验收标准和风险；要求检查相关文件并执行适用的非破坏性验证，给出精确证据、不可用检查、按优先级排列的缺陷，以及明确的 PASS 或 REWORK 结论。',
    },
    'zh-TW': {
      discussion: '與所選代理討論本工作階段最近的工作。依目前脈絡整理目標、範圍、近期決策、變更區域、既有驗證、待解問題與風險；請對方挑戰方案、指出權衡或遺漏，並回覆具體建議。',
      brainstorm: '與所選代理一起構思本工作階段最近工作的改進與下一步。依目前脈絡整理目標、限制、近期決策、目前實作與未解問題；請對方提供實用替代方案、邊界情況與優先順序建議並回覆。',
      audit: '請所選代理獨立審計本工作階段最近的工作。依目前脈絡整理目標、範圍、近期決策、變更檔案或產物、實作狀態、既有驗證、驗收標準與風險；要求檢查相關檔案並執行適用的非破壞性驗證，提供精確證據、不可用檢查、依優先級排列的缺陷，以及明確的 PASS 或 REWORK 結論。',
    },
    es: {
      discussion: 'Comenta el trabajo más reciente de esta sesión con el agente seleccionado. Resume objetivo, alcance, decisiones, áreas cambiadas, validación, preguntas y riesgos; pide que cuestione el enfoque y devuelva recomendaciones concretas.',
      brainstorm: 'Genera mejoras y próximos pasos con el agente seleccionado. Resume objetivo, restricciones, decisiones, estado actual y problemas abiertos; pide alternativas prácticas, casos límite e ideas priorizadas.',
      audit: 'Pide al agente seleccionado una auditoría independiente del trabajo reciente. Resume objetivo, alcance, decisiones, archivos, estado, validación, criterios y riesgos; exige comprobaciones no destructivas, evidencia exacta, verificaciones no disponibles, defectos priorizados y un veredicto PASS o REWORK.',
    },
    ru: {
      discussion: 'Обсудите недавнюю работу с выбранным агентом. Кратко изложите цель, область, решения, изменения, проверки, вопросы и риски; попросите оспорить подход и вернуть конкретные рекомендации.',
      brainstorm: 'Продумайте улучшения и следующие шаги с выбранным агентом. Кратко изложите цель, ограничения, решения, состояние и открытые проблемы; запросите практичные альтернативы, крайние случаи и приоритетные идеи.',
      audit: 'Попросите выбранного агента независимо проверить недавнюю работу. Кратко изложите цель, область, решения, файлы, состояние, проверки, критерии и риски; потребуйте неразрушающие проверки, точные доказательства, недоступные проверки, приоритетные дефекты и вердикт PASS или REWORK.',
    },
    ja: {
      discussion: '選択したエージェントとこのセッションの最近の作業を議論します。目標、範囲、判断、変更領域、検証、未解決点、リスクを要約し、方針への反論と具体的な提案を求めてください。',
      brainstorm: '選択したエージェントと改善案・次の手順を検討します。目標、制約、判断、実装状況、未解決問題を要約し、実用的な代案、境界条件、優先案を求めてください。',
      audit: '選択したエージェントに最近の作業の独立監査を依頼します。目標、範囲、判断、変更ファイル、実装状況、検証、受入条件、リスクを要約し、非破壊検証、正確な証拠、実施不能な確認、優先度付き欠陥、明確な PASS または REWORK を求めてください。',
    },
    ko: {
      discussion: '선택한 에이전트와 이 세션의 최근 작업을 논의하세요. 목표, 범위, 결정, 변경 영역, 검증, 미해결 질문, 위험을 요약하고 접근법의 허점과 구체적 권고를 요청하세요.',
      brainstorm: '선택한 에이전트와 개선 및 다음 단계를 구상하세요. 목표, 제약, 결정, 구현 상태, 미해결 문제를 요약하고 실용적 대안, 경계 사례, 우선순위 아이디어를 요청하세요.',
      audit: '선택한 에이전트에게 최근 작업의 독립 감사를 요청하세요. 목표, 범위, 결정, 변경 파일, 구현 상태, 검증, 수락 기준, 위험을 요약하고 비파괴 검증, 정확한 증거, 수행 불가 검사, 우선순위 결함, 명확한 PASS 또는 REWORK를 요구하세요.',
    },
  } as const;
  if (locale !== 'en') return localized[locale][preset];
  if (preset === 'discussion') {
    return [
      'Discuss this session\'s most recent work with the selected delegate.',
      'Build the delegation brief from the current session context: summarize the goal, scope, recent decisions, changed areas, validation already run, open questions, and risks.',
      'Ask the delegate to challenge the approach, identify trade-offs or missing considerations, and reply with concrete recommendations.',
    ].join(' ');
  }
  if (preset === 'brainstorm') {
    return [
      'Brainstorm improvements and next steps for this session\'s most recent work with the selected delegate.',
      'Build the delegation brief from the current session context: summarize the goal, constraints, recent decisions, current implementation state, and unresolved problems.',
      'Ask the delegate for practical alternatives, edge cases, and prioritized ideas, then have it reply to this session.',
    ].join(' ');
  }
  return [
    'Ask the selected delegate to independently audit this session\'s most recent work.',
    'Build the delegation brief from the current session context: summarize the goal, requested scope, recent decisions, changed files or artifacts, implementation state, validation already run, acceptance criteria, and known risks.',
    'The delegate should inspect relevant files and use all applicable non-destructive tests and already-authorized tools or environments, report exact evidence or unavailable checks, prioritize concrete defects and regressions, and reply with a clear PASS or REWORK recommendation.',
  ].join(' ');
}

export function buildAgentDelegationOrchestrationPrompt(input: AgentDelegationOrchestrationPromptInput): string {
  const targetSession = input.targetSession.trim();
  const targetLabel = input.targetLabel?.trim();
  const task = truncateAgentDelegationUtf8(
    input.task.trim(),
    AGENT_DELEGATION_ORCHESTRATION_TASK_BYTES,
  );
  const copy = AGENT_DELEGATION_ORCHESTRATION_COPY[normalizeAgentDelegationUiLocale(input.uiLocale)];
  const auditCycle = copy.auditCycle.map((line) => line
    .split('{PASS}').join(PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS)
    .split('{REWORK}').join(PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.REWORK));
  return [
    copy.orchestrator,
    targetLabel && targetLabel !== targetSession ? `${copy.targetLabel}: ${targetLabel}` : null,
    copy.targetId(targetSession),
    `${copy.task}: ${task}`,
    copy.prepare,
    copy.send(targetSession),
    `imcodes send --reply ${JSON.stringify(targetSession)} ${JSON.stringify(copy.fallback)}`,
    copy.wait,
    ...(input.auditCycle ? auditCycle : []),
  ].filter((line): line is string => line !== null).join('\n');
}

export function isAgentDelegationForwardedPayloadText(text: string): boolean {
  return text.includes(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER)
    || text.includes(AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER)
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
