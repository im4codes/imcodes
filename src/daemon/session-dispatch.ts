import { createHash } from 'node:crypto';
import { createSendDispatchId, createSendMessageId, type SendDispatchId, type SendMessageId } from '../../shared/send-message-id.js';
import {
  PEER_AUDIT_CONTRACT_VERSION,
  PEER_AUDIT_PREFLIGHT_ERRORS,
  type PeerAuditDispatchReceipt,
} from '../../shared/peer-audit.js';
import {
  AGENT_DELEGATION_CONTEXT_HEADER,
  AGENT_DELEGATION_CONTEXT_OMITTED_MARKER,
  AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER,
  AGENT_DELEGATION_ERROR_CODES,
  buildAgentDelegationReplyInstruction,
  isAgentDelegationForwardedPayloadText,
  isDelegationReplyCapableAgentType,
  stripAgentDelegationControlInstructions,
  type AgentDelegationErrorCode,
  type DelegationContextStatus,
} from '../../shared/agent-delegation.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { redactSensitiveText } from '../../shared/redact-secrets.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import { isValidImcodesSessionName, resolveEffectiveProjectName, resolveRuntimeScope } from '../../shared/session-scope.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
import { getSession as getStoredSession, type SessionRecord } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import { buildTransportQueueSnapshotPayload } from './transport-queue-projection.js';
import { injectPeerAuditBriefIntoProcessSession, type PeerAuditProcessInjectError } from './peer-audit-process-injector.js';
import { timelineEmitter } from './timeline-emitter.js';
import type { TimelineEvent } from './timeline-event.js';

export interface SessionDispatchRuntimeCaller {
  userId: string;
  sessionName: string | null;
  projectName?: string | null;
  projectRoot?: string | null;
}

export interface SessionDispatchMessageOptions {
  dispatchId: SendDispatchId;
  messageId: SendMessageId;
  sharedActor?: SharedActorEnvelope;
}

export type SessionDispatchOptions = SessionDispatchMessageOptions;
export type SessionDispatchMessageResult = 'sent' | 'queued' | void;

type BuildSessionDispatchMessageInput = { message?: string; files?: string[]; replyTo?: string | null; contextTail?: string | null; contextOmitted?: boolean; contextStatus?: DelegationContextStatus };

export function buildSessionDispatchMessage(message: string, options: Omit<BuildSessionDispatchMessageInput, 'message'>): string;
export function buildSessionDispatchMessage(input: BuildSessionDispatchMessageInput): string;
export function buildSessionDispatchMessage(
  messageOrInput: string | BuildSessionDispatchMessageInput,
  maybeOptions: Omit<BuildSessionDispatchMessageInput, 'message'> = {},
): string {
  const message = typeof messageOrInput === 'string' ? messageOrInput : messageOrInput.message ?? '';
  const options = typeof messageOrInput === 'string' ? maybeOptions : messageOrInput;
  const contextStatus: DelegationContextStatus = options.contextStatus ?? (options.contextOmitted ? 'omitted' : 'ok');
  let result = message;
  if (options.contextTail?.trim()) {
    result += `\n\n${AGENT_DELEGATION_CONTEXT_HEADER}\n${options.contextTail.trim()}`;
    if (contextStatus === 'truncated') {
      result += `\n${AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER} Recent context was truncated to fit delegation limits.`;
    }
  } else if (contextStatus === 'truncated') {
    result += `\n\n${AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER} Recent context was truncated and omitted; forwarded clean task only.`;
  } else if (contextStatus === 'omitted') {
    result += `\n\n${AGENT_DELEGATION_CONTEXT_OMITTED_MARKER} Recent context unavailable; forwarded clean task only.`;
  }
  const files = options.files ?? [];
  if (files.length > 0) {
    result += `\n\nReferenced files:\n${files.map((file) => `- ${file}`).join('\n')}`;
  }
  if (options.replyTo && isValidImcodesSessionName(options.replyTo)) {
    result += `\n\n${buildAgentDelegationReplyInstruction(options.replyTo)}`;
  }
  return result;
}


function isSubSessionRecord(sessionName: string | null | undefined, record?: SessionRecord): boolean {
  return Boolean(
    record?.parentSession
    || record?.userCreated === true && (record.name.startsWith('deck_sub_') || sessionName?.startsWith('deck_sub_'))
    || sessionName?.startsWith('deck_sub_'),
  );
}

function shouldAttachServerMemberActor(callerName: string | null, callerRecord: SessionRecord | undefined, target: SessionRecord): boolean {
  return isSubSessionRecord(callerName, callerRecord) || isSubSessionRecord(target.name, target);
}

function formatServerMemberActorName(callerName: string, callerRecord?: SessionRecord): string {
  const label = callerRecord?.label?.trim();
  if (label) return label;
  return callerRecord?.name || callerName;
}

export function buildServerMemberSharedActorOption(
  caller: SessionDispatchRuntimeCaller,
  callerRecord: SessionRecord | undefined,
  target: SessionRecord,
  actionId: string,
  now: number,
): { sharedActor: SharedActorEnvelope } | Record<string, never> {
  if (!caller.sessionName || !isValidImcodesSessionName(caller.sessionName)) return {};
  if (!shouldAttachServerMemberActor(caller.sessionName, callerRecord, target)) return {};
  const actorDisplayName = formatServerMemberActorName(caller.sessionName, callerRecord);
  const targetSnapshot = target.name.startsWith('deck_sub_')
    ? {
        kind: 'subsession' as const,
        serverId: 'local',
        subSessionId: target.name,
        ...(target.label ? { subSessionDisplayName: target.label } : {}),
      }
    : {
        kind: 'main' as const,
        serverId: 'local',
        sessionName: target.name,
      };
  return {
    sharedActor: {
      actorUserId: caller.userId || caller.sessionName,
      actorDisplayName,
      snapshot: {
        target: targetSnapshot,
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: [],
        primaryShareId: null,
        authorizedAt: now,
      },
      primaryShareId: null,
      effectiveActorRole: 'server-member',
      actionId,
      origin: 'server-member',
      authorizedAt: now,
      queuedAt: now,
    },
  };
}

export async function dispatchSessionMessage(
  target: SessionRecord,
  message: string,
  options: SessionDispatchMessageOptions,
): Promise<SessionDispatchMessageResult> {
  if ((target.runtimeType ?? getSessionRuntimeType(target.agentType)) === 'transport') {
    const runtime = getTransportRuntime(target.name);
    if (!runtime) throw new Error(`no transport runtime for session ${target.name}`);
    const result = options.sharedActor
      ? runtime.send(message, options.messageId, undefined, undefined, { sharedActor: options.sharedActor })
      : runtime.send(message, options.messageId);
    if (result === 'sent') {
      emitStructuredTransportUserMessage(target.name, message, options.messageId, options.sharedActor);
    } else if (result === 'queued') {
      const queuePayload = buildTransportQueueSnapshotPayload(target.name, 'send_tool');
      timelineEmitter.emit(target.name, 'session.state', {
        state: 'queued',
        ...queuePayload,
      }, { source: 'daemon', confidence: 'high' });
    }
    return result;
  }

  const { sendProcessSessionMessageForAutomation } = await import('./command-handler.js');
  await sendProcessSessionMessageForAutomation(target.name, message);
}

/** Resolve a named session and deliver through the runtime-neutral boundary.
 * The selected runtime owns the single user.timeline projection: transport
 * dispatch emits its structured event, while the process sender emits before
 * entering its serialized terminal delivery path. */
export async function dispatchSessionMessageByName(
  sessionName: string,
  message: string,
  deps: {
    getSession?: (name: string) => SessionRecord | undefined;
    dispatchMessage?: typeof dispatchSessionMessage;
  } = {},
): Promise<SessionDispatchMessageResult> {
  const target = (deps.getSession ?? getStoredSession)(sessionName);
  if (!target) throw new Error(`session not found: ${sessionName}`);
  return (deps.dispatchMessage ?? dispatchSessionMessage)(target, message, {
    dispatchId: createSendDispatchId(),
    messageId: createSendMessageId(),
  });
}

export type PeerAuditDispatchResult =
  | { ok: true; receipt: PeerAuditDispatchReceipt }
  | { ok: false; error: PeerAuditProcessInjectError };

/**
 * Peer-audit-only dispatch. This deliberately does not share the manual
 * delegation wrapper, visible user timeline event, or process terminal-key
 * fallback. The receipt is captured before any wrapper can discard the
 * transport sent/queued disposition.
 */
export async function dispatchPeerAuditMessage(input: {
  target: SessionRecord;
  brief: string;
  attemptId: string;
  /**
   * Effect-revision barrier for the unrevocable process path, evaluated at the
   * final boundary under the send lock. Omitted means "no revision to check".
   */
  isEffectCurrent?: () => boolean;
}): Promise<PeerAuditDispatchResult> {
  const { target } = input;
  if (!target.sessionInstanceId || !target.runtimeEpoch) {
    return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE };
  }
  const dispatchId = createSendDispatchId();
  const messageId = createSendMessageId();

  if ((target.runtimeType ?? getSessionRuntimeType(target.agentType)) === 'transport') {
    const runtime = getTransportRuntime(target.name);
    if (!runtime) return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE };
    const disposition = runtime.send(input.brief, messageId, undefined, undefined, {
      peerAudit: {
        contractVersion: PEER_AUDIT_CONTRACT_VERSION,
        attemptHash: createHash('sha256').update(input.attemptId).digest('base64url'),
      },
    });
    const queueEpoch = disposition === 'queued'
      ? buildTransportQueueSnapshotPayload(target.name, 'peer_audit').queueEpoch
      : undefined;
    return {
      ok: true,
      receipt: {
        disposition,
        dispatchId,
        messageId,
        targetSessionInstanceId: target.sessionInstanceId,
        targetRuntimeEpoch: target.runtimeEpoch,
        ...(queueEpoch ? { queueEpoch } : {}),
      },
    };
  }

  // A process runtime cannot revoke a terminal injection after acceptance, so
  // the idle/identity/effect check and the write must be one atomic critical
  // section against authoritative state — never this pre-lock snapshot. The
  // injector also keeps the capability-bearing brief out of the timeline,
  // history, and memory, and never falls back to an ordinary send.
  const injected = await injectPeerAuditBriefIntoProcessSession({
    targetSessionName: target.name,
    expectedSessionInstanceId: target.sessionInstanceId,
    expectedRuntimeEpoch: target.runtimeEpoch,
    brief: input.brief,
    ...(input.isEffectCurrent ? { isEffectCurrent: input.isEffectCurrent } : {}),
  });
  if (!injected.ok) return injected;
  return {
    ok: true,
    receipt: {
      disposition: 'sent_unrevocable',
      dispatchId,
      messageId,
      targetSessionInstanceId: target.sessionInstanceId,
      targetRuntimeEpoch: target.runtimeEpoch,
    },
  };
}

/** Exact queued-message cancellation for a revocable transport peer audit. */
export function cancelQueuedPeerAuditMessage(targetSessionName: string, messageId: string): boolean {
  return Boolean(getTransportRuntime(targetSessionName)?.removePendingMessage(messageId));
}

function emitStructuredTransportUserMessage(
  sessionName: string,
  message: string,
  messageId: SendMessageId,
  sharedActor?: SharedActorEnvelope,
): void {
  timelineEmitter.emit(
    sessionName,
    'user.message',
    {
      text: message,
      allowDuplicate: true,
      commandId: messageId,
      clientMessageId: messageId,
      ...(sharedActor ? { sharedActor } : {}),
    },
    { source: 'daemon', confidence: 'high', eventId: `transport-user:${messageId}` },
  );
}

export interface DelegatedSessionDispatchDeps {
  listSessions: () => SessionRecord[];
  getSession?: (name: string) => SessionRecord | undefined;
  dispatchMessage?: (target: SessionRecord, message: string, options: SessionDispatchMessageOptions) => Promise<SessionDispatchMessageResult>;
  readTimeline?: (sessionName: string, limit: number) => TimelineEvent[] | Promise<TimelineEvent[]>;
  now?: () => number;
}

export type DelegatedSessionDispatchResult =
  | { status: 'accepted'; dispatchId: SendDispatchId; messageId: SendMessageId; target: string; contextStatus: DelegationContextStatus; contextOmitted?: boolean }
  | { status: 'error'; error: AgentDelegationErrorCode; detail?: string };

export interface DelegationContextTailResult {
  text: string;
  status: DelegationContextStatus;
}

export const DELEGATION_CONTEXT_TURN_CAP = 12;
export const DELEGATION_CONTEXT_BYTE_CAP = 16 * 1024;
const DELEGATION_CONTEXT_READ_LIMIT = 96;

export function resolveExactDelegationTarget(input: { caller: SessionDispatchRuntimeCaller; targetSession: string; allSessions: SessionRecord[] }):
  | { ok: true; target: SessionRecord }
  | { ok: false; error: AgentDelegationErrorCode; detail?: string } {
  const { caller, targetSession, allSessions } = input;
  if (!caller.sessionName) return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_FORBIDDEN, detail: 'missing caller session' };
  if (targetSession === caller.sessionName) return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_SELF_TARGET };
  const target = allSessions.find((session) => session.name === targetSession);
  if (!target) return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_UNAVAILABLE, detail: 'target not found' };
  const callerProject = resolveRuntimeScope({ ...caller, projectName: caller.projectName ?? null, projectRoot: caller.projectRoot ?? null }, allSessions).projectName;
  const targetProject = resolveEffectiveProjectName(target, allSessions);
  if (!callerProject || targetProject !== callerProject) return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_FORBIDDEN, detail: 'target outside caller project' };
  if (target.state === 'stopped' || target.state === 'error') return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_UNAVAILABLE, detail: `target state ${target.state}` };
  if (target.executionCloneMetadata?.kind === EXECUTION_CLONE_KIND) return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_FORBIDDEN, detail: 'execution clone target' };
  if (!isDelegationReplyCapableAgentType(target.agentType)) return { ok: false, error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_NOT_REPLY_CAPABLE, detail: `agent type ${target.agentType}` };
  return { ok: true, target };
}

export async function buildDelegationContextTail(input: { sessionName: string; readTimeline: (sessionName: string, limit: number) => TimelineEvent[] | Promise<TimelineEvent[]>; turnCap?: number; byteCap?: number }): Promise<DelegationContextTailResult> {
  const turnCap = input.turnCap ?? DELEGATION_CONTEXT_TURN_CAP;
  const byteCap = input.byteCap ?? DELEGATION_CONTEXT_BYTE_CAP;
  let events: TimelineEvent[];
  try {
    events = await input.readTimeline(input.sessionName, DELEGATION_CONTEXT_READ_LIMIT);
  } catch {
    return { text: '', status: 'omitted' };
  }
  const safe: string[] = [];
  for (const event of events) {
    if (event.sessionId !== input.sessionName) continue;
    if (event.type !== 'user.message' && event.type !== 'assistant.text') continue;
    if (event.type === 'assistant.text' && event.payload.streaming === true) continue;
    if ((event.payload as { memoryExcluded?: unknown }).memoryExcluded === true) continue;
    const raw = event.payload.text;
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    if (isAgentDelegationForwardedPayloadText(raw)) continue;
    const cleaned = redactSensitiveText(stripAgentDelegationControlInstructions(raw));
    if (!cleaned) continue;
    safe.push(`${event.type === 'user.message' ? 'User' : 'Assistant'}: ${cleaned}`);
  }
  const turnWindow = safe.slice(-turnCap);
  let truncated = safe.length > turnWindow.length;
  const kept: string[] = [];
  let bytes = 0;
  for (let i = turnWindow.length - 1; i >= 0; i -= 1) {
    const item = turnWindow[i];
    const separatorBytes = kept.length > 0 ? Buffer.byteLength('\n\n', 'utf8') : 0;
    const itemBytes = Buffer.byteLength(item, 'utf8');
    if (bytes + separatorBytes + itemBytes > byteCap) {
      truncated = true;
      const remaining = byteCap - bytes - separatorBytes;
      if (remaining > 32 && kept.length === 0) {
        const truncatedItem = truncateUtf8(item, remaining);
        if (truncatedItem) kept.unshift(truncatedItem);
      }
      break;
    }
    kept.unshift(item);
    bytes += separatorBytes + itemBytes;
  }
  if (kept.length === 0) return { text: '', status: 'ok' };
  return { text: kept.join('\n\n'), status: truncated ? 'truncated' : 'ok' };
}

function truncateUtf8(value: string, byteCap: number): string {
  if (byteCap <= 0) return '';
  const marker = '…';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const limit = Math.max(0, byteCap - markerBytes);
  let bytes = 0;
  let result = '';
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > limit) break;
    result += char;
    bytes += charBytes;
  }
  return result ? `${result}${marker}` : '';
}


export async function dispatchDelegatedSessionSend(input: {
  caller: SessionDispatchRuntimeCaller;
  targetSession: string;
  message: string;
}, deps: DelegatedSessionDispatchDeps): Promise<DelegatedSessionDispatchResult> {
  if (input.message.trim().length === 0) return { status: 'error', error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_EMPTY_TASK };
  const allSessions = deps.listSessions();
  const resolved = resolveExactDelegationTarget({ caller: input.caller, targetSession: input.targetSession, allSessions });
  if (!resolved.ok) return { status: 'error', error: resolved.error, ...(resolved.detail ? { detail: resolved.detail } : {}) };
  const context = deps.readTimeline && input.caller.sessionName
    ? await buildDelegationContextTail({ sessionName: input.caller.sessionName, readTimeline: deps.readTimeline })
    : { text: '', status: 'omitted' as const };
  const dispatchId = createSendDispatchId();
  const messageId = createSendMessageId();
  const callerRecord = input.caller.sessionName ? deps.getSession?.(input.caller.sessionName) : undefined;
  const message = buildSessionDispatchMessage({
    message: input.message.trim(),
    replyTo: input.caller.sessionName,
    contextTail: context.text,
    contextStatus: context.status,
  });
  try {
    await (deps.dispatchMessage ?? dispatchSessionMessage)(resolved.target, message, {
      dispatchId,
      messageId,
      ...buildServerMemberSharedActorOption(input.caller, callerRecord, resolved.target, messageId, deps.now?.() ?? Date.now()),
    });
    if (context.status === 'omitted' && input.caller.sessionName) {
      timelineEmitter.emit(input.caller.sessionName, 'assistant.text', {
        text: `${AGENT_DELEGATION_CONTEXT_OMITTED_MARKER} Delegation context was unavailable; forwarded clean task only.`,
        streaming: false,
        memoryExcluded: true,
      }, { source: 'daemon', confidence: 'medium' });
    }
    return { status: 'accepted', dispatchId, messageId, target: resolved.target.name, contextStatus: context.status, ...(context.status === 'omitted' ? { contextOmitted: true } : {}) };
  } catch (err) {
    return { status: 'error', error: AGENT_DELEGATION_ERROR_CODES.DELEGATION_TARGET_UNAVAILABLE, detail: sanitizeMcpErrorMessage(err) };
  }
}
