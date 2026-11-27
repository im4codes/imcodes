/**
 * Relay TransportProvider callbacks into the unified timeline event system.
 *
 * Transport events are emitted through timelineEmitter (same as CC/Codex/Gemini
 * JSONL watchers), so ChatView renders them without any special handling.
 * Also cached to local JSONL for replay on reconnect/restart.
 */
import { shouldRetryProviderErrorWithBackoff } from '../../shared/provider-error-classifier.js';
import {
  PROVIDER_ERROR_CODES,
  PROVIDER_CANCEL_ORIGINS,
  SDK_TURN_LOST_RECOVERY_PHASES,
  SDK_TURN_LOST_RECOVERY_REASON,
  SDK_TURN_LOST_RECOVERY_STATUS,
  isSdkTurnLostRecovery,
  sanitizeSdkTurnLostRecoveryMetadata,
  type SdkTurnLostRecoveryMetadata,
  type SdkTurnLostRecoveryPhase,
  type TransportProvider,
  type ToolExecutionGuardDecision,
  type ToolExecutionRequest,
  type ProviderError,
  type ProviderStatusUpdate,
  type ProviderUsageUpdate,
} from '../agent/transport-provider.js';
import type { MessageDelta, AgentMessage, ToolCallEvent } from '../../shared/agent-message.js';
import { readDelegationClaim } from '../../shared/delegation-claim.js';
import { TASK_PAIR_TERMINAL_FLUSH_FIELD } from '../../shared/task-pair.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';
import { resolveSessionName, isEphemeralProviderSid, getTransportRuntime } from '../agent/session-manager.js';
import {
  clearPreEvaluatedParticipantToolDecisions,
  evaluateParticipantToolAccess,
  getParticipantToolTurnEpoch,
  recordPreEvaluatedParticipantToolDecision,
} from './participant-privacy-guard.js';
import { attachDaemonUserNotice, DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';
import { timelineEmitter } from './timeline-emitter.js';
import {
  enforceObservedNativeCollaboration,
  evaluateNativeCollaborationPreExecution,
  isNativeAgentFenceRequired,
} from './native-collaboration-guard.js';
import { readNativeAgentAdmissionMode } from '../../shared/native-collaboration-policy.js';
import { appendTransportEvent } from './transport-history.js';
import { isIncognitoSession } from '../../shared/session-incognito-types.js';
import { onSessionTeardown, withSessionPrivacy } from '../../shared/session-incognito-context.js';
import logger from '../util/logger.js';
import { TrailingThrottle } from '../util/trailing-throttle.js';
import { AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { recordAgyQuotaActivity, refreshAgyQuotaMetadata } from '../agent/agy-usage-quota.js';
import { getSession } from '../store/session-store.js';
import { resolveSessionContextWindow } from './session-context-window.js';
import { TIMELINE_EVENT_FILE_CHANGE } from '../../shared/file-change.js';
import { ASK_QUESTION_WAIT_MS } from '../../shared/ask-question-timing.js';
import {
  canonicalAskQuestionToolName,
  extractAskQuestionsFromToolInput,
  extractAskQuestionsFromToolName,
} from '../../shared/ask-question-normalize.js';
import { normalizeCodexSdkFileChange, normalizeQwenFileChange } from './file-change-normalizer.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import {
  buildSdkSubagentTimelinePayload,
  normalizeSdkSubagentKeyComponent,
  parseSdkSubagentDetail,
} from '../../shared/sdk-subagent-status.js';
import {
  buildCodexLifecycleTerminalMetadata,
  type CodexLifecycleEvidenceSource,
  type ToolTerminalReason,
  type ToolTerminalStatus,
} from '../../shared/session-activity-types.js';

let sendToServer: ((msg: Record<string, unknown>) => void) | null = null;
const inFlightMessages = new Map<string, { messageId: string; eventId: string; text: string }>();
/** Track mid-turn finalized eventIds per session (`delta.final === true` or pre-ask flush) so a later onComplete does not duplicate them. */
const finalizedTurnMessages = new Map<string, Map<string, string>>();
/** Track normalized (`.trimEnd()`) texts finalized immediately before an `ask.question` in the current turn so late transcript-step flushes (e.g. agy-sdk `:step:<n>`) cannot re-emit behind `ask.question`. */
const preAskFinalizedTexts = new Map<string, Set<string>>();
/** Track sessions that surfaced `ask.question` in the current turn so an empty `onComplete('')` cannot emit a trailing blank `assistant.text`. */
const turnSurfacedAskQuestions = new Set<string>();
const FINALIZED_TURN_MESSAGE_LIMIT = 64;

function recordFinalizedTurnMessage(sessionName: string, eventId: string, text: string): void {
  let entries = finalizedTurnMessages.get(sessionName);
  if (!entries) {
    entries = new Map();
    finalizedTurnMessages.set(sessionName, entries);
  }
  if (!entries.has(eventId) && entries.size >= FINALIZED_TURN_MESSAGE_LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(eventId, text);
}

function recordPreAskFinalizedText(sessionName: string, text: string): void {
  const normalized = text.trimEnd();
  if (!normalized.trim()) return;
  let texts = preAskFinalizedTexts.get(sessionName);
  if (!texts) {
    texts = new Set();
    preAskFinalizedTexts.set(sessionName, texts);
  }
  if (!texts.has(normalized) && texts.size >= FINALIZED_TURN_MESSAGE_LIMIT) {
    const oldest = texts.values().next().value;
    if (oldest !== undefined) texts.delete(oldest);
  }
  texts.add(normalized);
}

function clearTurnFinalizationState(sessionName: string): void {
  finalizedTurnMessages.delete(sessionName);
  preAskFinalizedTexts.delete(sessionName);
  turnSurfacedAskQuestions.delete(sessionName);
}

function isMessageAlreadyFinalizedInTurn(sessionName: string, eventId: string, text: string): boolean {
  const normalized = text.trimEnd();
  if (!normalized.trim()) return false;
  const finalizedForTurn = finalizedTurnMessages.get(sessionName);
  const existing = finalizedForTurn?.get(eventId);
  if (existing !== undefined && existing.trimEnd() === normalized) {
    return true;
  }
  return preAskFinalizedTexts.get(sessionName)?.has(normalized) ?? false;
}

/** Flush any in-flight assistant.text ahead of ask.question so timeline order matches generation order. */
function flushPreAskInFlightMessage(sessionName: string): void {
  const previous = inFlightMessages.get(sessionName);
  if (!previous) return;
  clearPendingStreamUpdate(previous.eventId);
  inFlightMessages.delete(sessionName);
  if (!previous.text.trim()) return;
  recordFinalizedTurnMessage(sessionName, previous.eventId, previous.text);
  recordPreAskFinalizedText(sessionName, previous.text);
  timelineEmitter.emit(sessionName, 'assistant.text', {
    text: previous.text,
    streaming: false,
  }, { source: 'daemon', confidence: 'high', eventId: previous.eventId });
  void appendTransportEvent(sessionName, {
    type: 'assistant.text',
    sessionId: sessionName,
    text: previous.text,
  });
}
const STREAM_UPDATE_INTERVAL_MS = 40;
// Third-party reasoning models reached through a cc preset (MiniMax-M3) report
// live thinking progress on nearly every reasoning token — measured at 3–36
// updates/s per session against roughly 1/s from Claude. Each one became an
// `agent.status` frame on the daemon→server link, competing with the 40 ms
// streaming-text frames on that same socket, and on a flapping link the text
// frames are what get dropped (server-link drops timeline events while down,
// while the final assistant text survives via transport history + backfill —
// i.e. exactly "the reply arrives but the streaming disappeared"). Coalesce the
// label churn; status TRANSITIONS still bypass the throttle (see pushNow).
const STATUS_UPDATE_INTERVAL_MS = 250;
const streamTextThrottle = new TrailingThrottle<{ sessionName: string; eventId: string; text: string }>(
  STREAM_UPDATE_INTERVAL_MS,
  ({ sessionName, eventId, text }) => emitStreamingAssistantText(sessionName, eventId, text),
);
const statusThrottle = new TrailingThrottle<{ sessionName: string; payload: Record<string, unknown> }>(
  STATUS_UPDATE_INTERVAL_MS,
  ({ sessionName, payload }) => emitAgentStatus(sessionName, payload),
);
/**
 * Last `agent.status` status name emitted per session, to detect transitions.
 * `null` is a real value (it clears the active status) and is distinct from an
 * absent entry, so the first status of a turn always counts as a transition.
 */
const lastEmittedStatusName = new Map<string, string | null>();
const pendingFileLikeTools = new Map<string, ToolCallEvent>();
const completedFileLikeTools = new Set<string>();
const CHECKLIST_TOOL_NAMES = new Set([
  'todowrite',
  'todo_write',
  'write_todos',
  'update_plan',
  'update_todo_list',
  'set_plan',
]);
// `${sessionName}:${toolUseId}` of AskUserQuestion calls surfaced as ask.question
// cards. Their tool_result (which the SDK re-emits as a generic name:'tool' event,
// marked is_error when the answer came back via canUseTool deny) is suppressed so
// it doesn't render as a stray "< error: <answer>" line in the timeline.
const askQuestionToolIds = new Set<string>();
const fallbackAskToolCallIds = new Set<string>();
const MAX_TRACKED_FILE_TOOLS = 512;

function rememberBoundedSetId(set: Set<string>, key: string): void {
  if (set.size >= MAX_TRACKED_FILE_TOOLS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}

function isEmptyAskInput(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string') return raw.trim().length === 0;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return true;
  return keys.length === 1 && Array.isArray(record.questions) && record.questions.length === 0;
}

function emitGenericToolCall(sessionName: string, tool: ToolCallEvent): void {
  timelineEmitter.emit(sessionName, 'tool.call', {
    toolCallId: tool.id,
    tool: tool.name,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
  }, {
    source: 'daemon',
    confidence: 'high',
    eventId: `transport-tool:${sessionName}:${tool.id}:call`,
  });
  void appendTransportEvent(sessionName, {
    type: 'tool.call',
    sessionId: sessionName,
    toolCallId: tool.id,
    tool: tool.name,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
  });
}
const emittedSdkTurnLostRecoveryPhases = new Set<string>();

const SDK_TURN_LOST_RECOVERY_PHASE_LABELS: Record<SdkTurnLostRecoveryPhase, string> = {
  [SDK_TURN_LOST_RECOVERY_PHASES.DETECTED]: 'Detected lost Codex SDK turn',
  [SDK_TURN_LOST_RECOVERY_PHASES.RECOVERING]: 'Recovering lost Codex SDK turn',
  [SDK_TURN_LOST_RECOVERY_PHASES.RECOVERED]: 'Recovered lost Codex SDK turn',
  [SDK_TURN_LOST_RECOVERY_PHASES.FAILED]: 'Codex turn ended before completion',
};

function sdkTurnLostRecoveryPhaseFromMetadata(
  metadata: SdkTurnLostRecoveryMetadata,
  fallbackPhase: SdkTurnLostRecoveryPhase,
): SdkTurnLostRecoveryPhase {
  return metadata.phase ?? fallbackPhase;
}

export function emitSdkTurnLostRecoveryPhase(
  sessionName: string,
  input: unknown,
  fallbackPhase: SdkTurnLostRecoveryPhase = SDK_TURN_LOST_RECOVERY_PHASES.DETECTED,
  expectedProviderSessionId?: string,
): boolean {
  const metadata = sanitizeSdkTurnLostRecoveryMetadata(input);
  if (!metadata) return false;
  if (expectedProviderSessionId && metadata.providerSessionId && metadata.providerSessionId !== expectedProviderSessionId) {
    logger.warn(
      { sessionName, providerSid: expectedProviderSessionId, recoveryProviderSessionId: metadata.providerSessionId },
      'transport-relay: dropped sdk_turn_lost recovery phase with conflicting provider session metadata',
    );
    return false;
  }
  const providerSessionMatches = !!expectedProviderSessionId
    && metadata.providerSessionId === expectedProviderSessionId;
  if (metadata.sessionName && metadata.sessionName !== sessionName) {
    logger.warn(
      { sessionName, recoverySessionName: metadata.sessionName, recoveryLocalSessionKey: metadata.localSessionKey },
      'transport-relay: dropped sdk_turn_lost recovery phase with conflicting session metadata',
    );
    return false;
  }
  if (!metadata.sessionName && metadata.localSessionKey !== sessionName && !providerSessionMatches) {
    logger.warn(
      { sessionName, recoverySessionName: metadata.sessionName, recoveryLocalSessionKey: metadata.localSessionKey },
      'transport-relay: dropped sdk_turn_lost recovery phase with conflicting session metadata',
    );
    return false;
  }
  const phase = sdkTurnLostRecoveryPhaseFromMetadata(metadata, fallbackPhase);
  const dedupKey = `${sessionName}:${metadata.correlationId}:${phase}`;
  if (emittedSdkTurnLostRecoveryPhases.has(dedupKey)) return true;
  emittedSdkTurnLostRecoveryPhases.add(dedupKey);

  const recovery = {
    ...metadata,
    phase,
  };
  const payload = {
    status: SDK_TURN_LOST_RECOVERY_STATUS,
    label: SDK_TURN_LOST_RECOVERY_PHASE_LABELS[phase],
    phase,
    reason: SDK_TURN_LOST_RECOVERY_REASON,
    correlationId: metadata.correlationId,
    recovery,
  };

  // This status is emitted directly rather than through the coalescing path, so
  // drop any frame still waiting there — otherwise it lands afterwards and
  // reverts the UI to the status this recovery phase just replaced.
  clearPendingStatusUpdate(sessionName);
  timelineEmitter.emit(sessionName, 'agent.status', payload, {
    source: 'daemon',
    confidence: 'high',
    eventId: `transport-recovery:${sessionName}:${metadata.correlationId}:${phase}`,
  });
  void appendTransportEvent(sessionName, {
    type: 'agent.status',
    sessionId: sessionName,
    ...payload,
  });
  return true;
}

function isCompactControlCompletion(message: AgentMessage): boolean {
  return message.kind === 'system'
    && message.role === 'system'
    && message.metadata?.[SESSION_CONTROL_METADATA_COMMAND_FIELD] === 'compact';
}

function rememberCompletedFileLikeTool(key: string): void {
  completedFileLikeTools.add(key);
  if (completedFileLikeTools.size <= MAX_TRACKED_FILE_TOOLS) return;
  const overflow = completedFileLikeTools.size - MAX_TRACKED_FILE_TOOLS;
  let removed = 0;
  for (const existing of completedFileLikeTools) {
    completedFileLikeTools.delete(existing);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function rememberPendingFileLikeTool(key: string, tool: ToolCallEvent): void {
  pendingFileLikeTools.set(key, tool);
  if (pendingFileLikeTools.size <= MAX_TRACKED_FILE_TOOLS) return;
  const oldestKey = pendingFileLikeTools.keys().next().value;
  if (oldestKey) pendingFileLikeTools.delete(oldestKey);
}

function isChecklistTool(tool: ToolCallEvent): boolean {
  const name = tool.name.toLowerCase();
  const detailKind = String(tool.detail?.kind ?? '').toLowerCase();
  return CHECKLIST_TOOL_NAMES.has(name) || detailKind === 'plan';
}

function emitChecklistToolCall(sessionName: string, tool: ToolCallEvent): void {
  timelineEmitter.emit(sessionName, 'tool.call', {
    toolCallId: tool.id,
    tool: tool.name,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
  }, {
    source: 'daemon',
    confidence: 'high',
    eventId: `transport-tool:${sessionName}:${tool.id}:call`,
  });
  void appendTransportEvent(sessionName, {
    type: 'tool.call',
    sessionId: sessionName,
    toolCallId: tool.id,
    tool: tool.name,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
  });
}

function terminalStatusForTool(tool: ToolCallEvent): string {
  return tool.terminalStatus ?? (tool.status === 'error' ? 'errored' : 'succeeded');
}

function terminalReasonForTool(tool: ToolCallEvent): string {
  return tool.terminalReason ?? (tool.status === 'error' ? 'provider_error' : 'provider_result');
}

function terminalMetadataForTool(sessionName: string, tool: ToolCallEvent): Record<string, unknown> {
  const terminalStatus = terminalStatusForTool(tool) as ToolTerminalStatus;
  const terminalReason = terminalReasonForTool(tool) as ToolTerminalReason;
  return { ...buildCodexLifecycleTerminalMetadata({
    sessionId: sessionName,
    terminalStatus,
    terminalReason,
    synthetic: tool.terminalSynthetic ?? false,
    source: (tool.terminalSource ?? 'app_server_jsonrpc') as CodexLifecycleEvidenceSource,
    decisionReason: tool.terminalDecisionReason ?? terminalReason,
    ...(tool.terminalIdempotencyKey !== undefined ? { idempotencyKey: tool.terminalIdempotencyKey } : {}),
    ...(tool.activityGeneration !== undefined ? { activityGeneration: tool.activityGeneration } : {}),
    toolCallId: tool.id,
    ...(tool.turnId !== undefined ? { turnId: tool.turnId } : {}),
    ...(tool.lifecycleItemKind !== undefined ? { itemKind: tool.lifecycleItemKind } : {}),
  }) };
}

function emitToolResult(sessionName: string, tool: ToolCallEvent): void {
  timelineEmitter.emit(sessionName, 'tool.result', {
    toolCallId: tool.id,
    ...terminalMetadataForTool(sessionName, tool),
    ...(tool.status === 'error'
      ? { error: tool.output ?? 'error' }
      : tool.output !== undefined
        ? { output: tool.output }
        : {}),
    ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
  }, {
    source: 'daemon',
    confidence: 'high',
    eventId: `transport-tool:${sessionName}:${tool.id}:result`,
  });
  void appendTransportEvent(sessionName, {
    type: 'tool.result',
    sessionId: sessionName,
    toolCallId: tool.id,
    ...terminalMetadataForTool(sessionName, tool),
    ...(tool.status === 'error'
      ? { error: tool.output ?? 'error' }
      : tool.output !== undefined
        ? { output: tool.output }
        : {}),
    ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
  });
}

function runWithRelaySessionPrivacy<T>(sessionName: string, fn: () => T): T {
  return withSessionPrivacy(sessionName, isIncognitoSession(getSession(sessionName)), fn);
}

/** Forget per-session streaming/status/in-flight relay state when a session stops or is replaced. */
export function forgetTransportRelaySession(sessionName: string): void {
  const tracked = inFlightMessages.get(sessionName);
  if (tracked) {
    clearPendingStreamUpdate(tracked.eventId);
    inFlightMessages.delete(sessionName);
  }
  clearTurnFinalizationState(sessionName);
  clearPendingStatusUpdate(sessionName);
  const prefix = `${sessionName}:`;
  for (const key of pendingFileLikeTools.keys()) {
    if (key.startsWith(prefix)) pendingFileLikeTools.delete(key);
  }
  for (const key of completedFileLikeTools) {
    if (key.startsWith(prefix)) completedFileLikeTools.delete(key);
  }
  for (const key of askQuestionToolIds) {
    if (key.startsWith(prefix)) askQuestionToolIds.delete(key);
  }
  for (const key of emittedSdkTurnLostRecoveryPhases) {
    if (key.startsWith(prefix)) emittedSdkTurnLostRecoveryPhases.delete(key);
  }
}

onSessionTeardown(forgetTransportRelaySession);

function emitStreamingAssistantText(sessionName: string, eventId: string, text: string): void {
  runWithRelaySessionPrivacy(sessionName, () => {
    timelineEmitter.emit(sessionName, 'assistant.text', {
      text,
      streaming: true,
    }, { source: 'daemon', confidence: 'high', eventId });
  });
}

function emitAgentStatus(sessionName: string, payload: Record<string, unknown>): void {
  runWithRelaySessionPrivacy(sessionName, () => {
    timelineEmitter.emit(sessionName, 'agent.status', payload, { source: 'daemon', confidence: 'high' });
  });
}

function clearPendingStreamUpdate(eventId: string): void {
  streamTextThrottle.clear(eventId);
}

/**
 * Drop a session's coalesced status frame and its transition memo. Called when
 * a turn settles so the next turn's first status is treated as a transition and
 * goes out immediately instead of waiting on a stale window.
 */
function clearPendingStatusUpdate(sessionName: string): void {
  statusThrottle.clear(sessionName);
  lastEmittedStatusName.delete(sessionName);
}

function normalizeUsageUpdatePayload(
  sessionName: string,
  usage: ProviderUsageUpdate['usage'] | undefined,
  model: string | undefined,
): Record<string, unknown> | null {
  if (!usage && !model) return null;
  const { contextWindow, effectiveModel, source: contextWindowSource } = resolveSessionContextWindow(
    sessionName,
    usage?.model_context_window,
    model,
  );
  const inputTokens = typeof usage?.input_tokens === 'number'
    ? usage.input_tokens + (usage.cache_creation_input_tokens ?? 0)
    : undefined;
  // Round-2 audit (0699ea64-3e6 finding A3): `output_tokens` was being silently
  // dropped here, leaving every transport-SDK turn at output_tokens=0 in
  // context_turn_usage. Map it through so analytics aren't all-zero for SDK
  // sessions (codex-sdk, claude-code-sdk via onComplete metadata, cursor, ...).
  const outputTokens = typeof usage?.output_tokens === 'number' && usage.output_tokens >= 0
    ? usage.output_tokens
    : undefined;
  const cacheTokens = typeof usage?.cache_read_input_tokens === 'number'
    ? usage.cache_read_input_tokens
    : typeof usage?.cached_input_tokens === 'number'
      ? usage.cached_input_tokens
      : undefined;
  const payload: Record<string, unknown> = {
    ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
    ...(typeof cacheTokens === 'number' ? { cacheTokens } : {}),
    ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    contextWindow,
    ...(contextWindowSource ? { contextWindowSource } : {}),
  };
  return payload;
}

function emitThrottledStreamingAssistantText(sessionName: string, eventId: string, text: string): void {
  streamTextThrottle.push(eventId, { sessionName, eventId, text });
}

/**
 * Emit `agent.status`, coalescing high-frequency label churn within one status.
 * A change of the status NAME is a real state transition and bypasses the
 * throttle so it can never be delayed behind, or reordered after, a coalesced
 * frame from the status it replaced.
 */
function emitThrottledAgentStatus(sessionName: string, payload: Record<string, unknown>, statusName: string | null): void {
  const value = { sessionName, payload };
  // An absent entry reads as `undefined`, which differs from every `string | null`
  // status — so the first status after a reset always takes the transition path.
  if (lastEmittedStatusName.get(sessionName) !== statusName) {
    lastEmittedStatusName.set(sessionName, statusName);
    statusThrottle.pushNow(sessionName, value);
    return;
  }
  statusThrottle.push(sessionName, value);
}

/** Set the send function (called once during server-link setup) */
export function setTransportRelaySend(fn: (msg: Record<string, unknown>) => void): void {
  sendToServer = fn;
}

/** Decides, per session, whether a tool call may run. Installed once by the daemon lifecycle (the relay itself knows nothing about pairs). */
export type TransportToolExecutionEvaluator = (
  sessionName: string,
  request: ToolExecutionRequest,
) => ToolExecutionGuardDecision | Promise<ToolExecutionGuardDecision>;
let toolExecutionEvaluator: TransportToolExecutionEvaluator | undefined;
export function setTransportToolExecutionEvaluator(evaluator: TransportToolExecutionEvaluator | undefined): void {
  toolExecutionEvaluator = evaluator;
}

/** Wire up a provider's callbacks to emit standard timeline events.
 *  Provider callbacks use providerSessionId; we resolve to IM.codes sessionName
 *  via the routing map before emitting. Unresolved routes are dropped + warned. */
export function wireProviderToRelay(provider: TransportProvider): void {
  // Supervision-authority gate for `pre_execution_gate` providers, asked
  // before a native agent tool runs. Unresolved/ephemeral routes (broker,
  // compressor) serve no IM.codes session and keep provider defaults.
  provider.setNativeCollaborationGate?.((providerSid, request) => {
    const sessionName = resolveSessionName(providerSid);
    return sessionName ? evaluateNativeCollaborationPreExecution(sessionName, request) : { allow: true };
  });
  // Pre-execution veto for shell and file-access tools where the provider has a real pre-tool
  // hook or permission gate. Fail closed if evaluator throws during a participant turn.
  const isParticipantRoute = (providerSid: string): boolean => {
    const sessionName = resolveSessionName(providerSid);
    return Boolean(sessionName && getTransportRuntime(sessionName)?.requiresSharedMachineAuthority());
  };
  provider.setParticipantTurnResolver?.(isParticipantRoute);
  interface RelayToolBinding {
    sessionName: string;
    providerSid: string;
    dispatchId: number | null;
    turnEpoch: number;
  }
  const captureRelayToolBinding = (sessionName: string, providerSid: string): RelayToolBinding => {
    const runtime = getTransportRuntime(sessionName) as {
      getParticipantToolBinding?: () => { providerSessionId: string | null; dispatchId: number | null };
    } | undefined;
    const runtimeBinding = runtime?.getParticipantToolBinding?.();
    return {
      sessionName,
      providerSid,
      dispatchId: runtimeBinding ? runtimeBinding.dispatchId : null,
      turnEpoch: getParticipantToolTurnEpoch(sessionName),
    };
  };
  const isRelayToolBindingCurrent = (captured: RelayToolBinding): boolean => {
    if (resolveSessionName(captured.providerSid) !== captured.sessionName) return false;
    if (getParticipantToolTurnEpoch(captured.sessionName) !== captured.turnEpoch) return false;
    const runtime = getTransportRuntime(captured.sessionName) as {
      requiresSharedMachineAuthority?: () => boolean;
      getParticipantToolBinding?: () => { providerSessionId: string | null; dispatchId: number | null };
    } | undefined;
    if (!runtime?.requiresSharedMachineAuthority?.()) return false;
    const currentBinding = runtime.getParticipantToolBinding?.();
    if (currentBinding) {
      if (currentBinding.providerSessionId !== null && currentBinding.providerSessionId !== captured.providerSid) {
        return false;
      }
      if (currentBinding.dispatchId !== captured.dispatchId) {
        return false;
      }
    }
    return true;
  };
  const recordBoundGuardDecision = (
    captured: RelayToolBinding,
    request: ToolExecutionRequest,
    decision: ToolExecutionGuardDecision,
  ): ToolExecutionGuardDecision => {
    if (!isRelayToolBindingCurrent(captured)) {
      return { allow: false, reason: 'Sensitive path policy: stale turn binding' };
    }
    if (request.input !== undefined && request.toolUseId) {
      recordPreEvaluatedParticipantToolDecision({
        sessionName: captured.sessionName,
        providerSessionId: captured.providerSid,
        dispatchId: captured.dispatchId,
        expectedTurnEpoch: captured.turnEpoch,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        decision,
      });
    }
    return decision;
  };
  provider.setToolExecutionGuard?.((providerSid, request) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) return { allow: true };
    const participantTurn = isParticipantRoute(providerSid);
    if (!participantTurn) {
      clearPreEvaluatedParticipantToolDecisions(sessionName);
      if (!toolExecutionEvaluator) return { allow: true };
      return toolExecutionEvaluator(sessionName, request);
    }
    const captured = captureRelayToolBinding(sessionName, providerSid);
    const failClosed = (err: unknown): ToolExecutionGuardDecision => {
      logger.warn({ sessionName, tool: request.toolName, err }, 'transport-relay: participant tool guard threw; failing closed');
      return {
        allow: false,
        reason: 'Sensitive path policy: verification failed',
      };
    };
    try {
      const guardedRequest: ToolExecutionRequest = toolExecutionEvaluator
        ? {
            ...request,
            providerSessionId: providerSid,
            dispatchId: captured.dispatchId,
          }
        : request;
      const decision = toolExecutionEvaluator
        ? toolExecutionEvaluator(sessionName, guardedRequest)
        : evaluateParticipantToolAccess(request, {
            cwd: request.cwd ?? getSession(sessionName)?.projectDir,
            sessionName,
            providerSessionId: providerSid,
            dispatchId: captured.dispatchId,
          });
      if (decision && typeof (decision as PromiseLike<ToolExecutionGuardDecision>).then === 'function') {
        return (decision as Promise<ToolExecutionGuardDecision>)
          .then((resolved) => recordBoundGuardDecision(captured, request, resolved))
          .catch(failClosed);
      }
      return recordBoundGuardDecision(captured, request, decision as ToolExecutionGuardDecision);
    } catch (err) {
      return failClosed(err);
    }
  });
  // Per-session fence resolver for `session_fence` providers, asked on the
  // path that launches, loads or sends. A provider that launches before the
  // route is registered passes the IM.codes session name itself.
  provider.setNativeAgentFenceResolver?.((providerSid, sessionName) => (
    isNativeAgentFenceRequired(sessionName ?? resolveSessionName(providerSid))
  ));

  provider.onDelta((providerSid: string, delta: MessageDelta) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      // Out-of-band callers (supervision-broker, summary-compressor) drive
      // the provider directly with their own per-call listeners; their
      // deltas aren't meant for the relay. Drop silently — logging per
      // delta produced hundreds of warns/min on a busy daemon.
      if (isEphemeralProviderSid(providerSid)) return;
      logger.warn({ providerSid }, 'transport-relay: unresolved route for delta — dropped');
      return;
    }
    runWithRelaySessionPrivacy(sessionName, () => {
    // Provider may send cumulative deltas (full text so far) or incremental.
    // Use delta.delta as the display text directly — the provider's internal
    // accumulator handles cumulative vs incremental differences.
    const stableEventId = `transport:${sessionName}:${delta.messageId}`;
    const previous = inFlightMessages.get(sessionName);
    if (previous && previous.messageId !== delta.messageId) {
      clearPendingStreamUpdate(previous.eventId);
      // A new message started mid-turn (codex emits multiple agentMessage items
      // per turn, one per tool round). FINALIZE the previous message now —
      // emit it as streaming:false so it is written to the timeline store.
      // Without this, only the LAST message of the turn (finalized by
      // onComplete) is persisted; every earlier message stays streaming:true,
      // never hits disk, and vanishes on refresh/reconnect — the user sees a
      // push notification and live ctx updates but a blank/partial timeline.
      if (previous.text) {
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: previous.text,
          streaming: false,
        }, { source: 'daemon', confidence: 'high', eventId: previous.eventId });
        void appendTransportEvent(sessionName, {
          type: 'assistant.text',
          sessionId: sessionName,
          text: previous.text,
        });
      }
    }
    if (delta.final === true) {
      inFlightMessages.delete(sessionName);
      clearPendingStreamUpdate(stableEventId);
      if (delta.delta) {
        const alreadyFinalized = isMessageAlreadyFinalizedInTurn(sessionName, stableEventId, delta.delta);
        recordFinalizedTurnMessage(sessionName, stableEventId, delta.delta);
        if (!alreadyFinalized) {
          timelineEmitter.emit(sessionName, 'assistant.text', {
            text: delta.delta,
            streaming: false,
          }, { source: 'daemon', confidence: 'high', eventId: stableEventId });
          void appendTransportEvent(sessionName, {
            type: 'assistant.text',
            sessionId: sessionName,
            text: delta.delta,
          });
        }
      }
      return;
    }
    inFlightMessages.set(sessionName, {
      messageId: delta.messageId,
      eventId: stableEventId,
      text: delta.delta,
    });

    emitThrottledStreamingAssistantText(sessionName, stableEventId, delta.delta);
    });
  });

  provider.onComplete((providerSid: string, message: AgentMessage) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for complete — dropped');
      return;
    }
    runWithRelaySessionPrivacy(sessionName, () => {
    if (isCompactControlCompletion(message)) {
      const tracked = inFlightMessages.get(sessionName);
      if (tracked) {
        inFlightMessages.delete(sessionName);
        clearPendingStreamUpdate(tracked.eventId);
      }
      clearTurnFinalizationState(sessionName);
      return;
    }
    const finalText = message.content;

    // Replace streaming event with final version (same eventId → in-place update)
    const tracked = inFlightMessages.get(sessionName);
    const finalizedForTurn = finalizedTurnMessages.get(sessionName);
    const stableEventId = tracked?.messageId === message.id
      ? tracked.eventId
      : `transport:${sessionName}:${message.id}`;
    inFlightMessages.delete(sessionName);
    clearPendingStreamUpdate(stableEventId);
    // Discard rather than flush: TransportSessionRuntime emits the turn's
    // terminal state separately, and a coalesced "Thinking (N tokens)" landing
    // after it would pin the UI to a status the turn already left.
    clearPendingStatusUpdate(sessionName);
    // Authoritative delegation projection for this turn, forwarded verbatim.
    // The UI renders assigned/queued/recovered from THIS fact or not at all;
    // reading it back off metadata keeps the daemon the single source and
    // leaves the assistant's prose untouched.
    const delegationClaim = readDelegationClaim(message.metadata);
    const alreadyFinalizedSameMessage = Boolean(
      isMessageAlreadyFinalizedInTurn(sessionName, stableEventId, finalText)
      && !delegationClaim,
    );
    const emptyAfterMidTurnFinal = Boolean(
      (
        (finalizedForTurn && finalizedForTurn.size > 0)
        || turnSurfacedAskQuestions.has(sessionName)
      )
      && !tracked
      && !finalText.trim()
      && !delegationClaim,
    );
    clearTurnFinalizationState(sessionName);
    if (!alreadyFinalizedSameMessage && !emptyAfterMidTurnFinal) {
      timelineEmitter.emit(sessionName, 'assistant.text', {
        text: finalText,
        streaming: false,
        ...(delegationClaim ? { delegationClaim } : {}),
      }, { source: 'daemon', confidence: 'high', eventId: stableEventId });
    }

    const usage = message.metadata?.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cached_input_tokens?: number;
      model_context_window?: number;
    } | undefined;
    const model = typeof message.metadata?.model === 'string' ? message.metadata.model : undefined;
    const usagePayload = normalizeUsageUpdatePayload(sessionName, usage, model);
    if (usagePayload) {
      timelineEmitter.emit(sessionName, 'usage.update', usagePayload, {
        source: 'daemon',
        confidence: 'high',
        eventId: `${stableEventId}:usage`,
      });
    }

    // TransportSessionRuntime owns lifecycle state transitions. Emitting idle here
    // races the runtime's drain/idle transitions and can desynchronize queue state.

    // Cache final text for replay
    if (!alreadyFinalizedSameMessage && !emptyAfterMidTurnFinal) {
      void appendTransportEvent(sessionName, {
        type: 'assistant.text',
        sessionId: sessionName,
        text: finalText,
      });
    }

    if (provider.id === AGY_SDK_PROVIDER_ID) {
      recordAgyQuotaActivity();
      void refreshAgyQuotaMetadata().catch(() => {});
    }
    });
  });

  provider.onError((providerSid: string, error: ProviderError) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for error — dropped');
      return;
    }
    runWithRelaySessionPrivacy(sessionName, () => {
    const tracked = inFlightMessages.get(sessionName);
    inFlightMessages.delete(sessionName);
    clearTurnFinalizationState(sessionName);
    if (tracked) clearPendingStreamUpdate(tracked.eventId);
    clearPendingStatusUpdate(sessionName);

    if (isSdkTurnLostRecovery(error)) {
      const details = sanitizeSdkTurnLostRecoveryMetadata(error.details);
      if (details) {
        emitSdkTurnLostRecoveryPhase(
          sessionName,
          details,
          error.recoverable ? SDK_TURN_LOST_RECOVERY_PHASES.DETECTED : SDK_TURN_LOST_RECOVERY_PHASES.FAILED,
          providerSid,
        );
      }
      return;
    }

    if (error.code === PROVIDER_ERROR_CODES.CANCELLED) {
      const errorDetails = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : null;
      const staleWatchdogRecovery = errorDetails?.cancelOrigin === PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG;
      const runtime = getTransportRuntime(sessionName);
      const isQueueDispatch = Boolean(runtime?.isStoppingForQueue);
      const terminalNotice = staleWatchdogRecovery
        ? '⚠️ OpenCode was unresponsive and was automatically recovered.'
        : isQueueDispatch
          ? '⚠️ Stopped previous turn — sending queued message(s)'
          : '⚠️ Turn cancelled';
      // Preserve the partial streamed content up to the stop point and persist it.
      // Previously this replaced the in-place streaming event (same eventId) with
      // ONLY the cancel notice, so pressing Esc/Stop mid-stream made the visible
      // assistant text "suddenly lose a big chunk" and the partial never hit disk.
      // Mirror the error branch below: keep `tracked.text` + a terminal marker, and
      // append the transport event so the partial survives refresh/reconnect (落盘).
      const cleanErrorMessage = error.message && error.message !== 'Turn cancelled' && !error.message.startsWith('Turn cancelled:')
        ? `⚠️ Turn cancelled: ${error.message}`
        : terminalNotice;
      const cancelledText = tracked?.text
        ? `${tracked.text}\n\n${terminalNotice}`
        : staleWatchdogRecovery
          ? terminalNotice
          : isQueueDispatch
            ? terminalNotice
            : cleanErrorMessage;
      const noticeMetadata = isQueueDispatch && !tracked?.text
        ? attachDaemonUserNotice(DAEMON_USER_NOTICE_CODE.TURN_STOPPED_FOR_QUEUE, cancelledText)
        : {};
      timelineEmitter.emit(sessionName, 'assistant.text', {
        text: cancelledText,
        streaming: false,
        // Cancelled output is deliberately interrupted — keep it out of memory,
        // but still display + persist it. (Display/replay are unaffected by this flag.)
        memoryExcluded: true,
        [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true,
        providerErrorCode: error.code,
        providerErrorRecoverable: error.recoverable,
        ...noticeMetadata,
        ...(staleWatchdogRecovery ? {
          automation: true,
          providerCancelOrigin: PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG,
        } : {}),
      }, {
        source: 'daemon',
        confidence: 'high',
        ...(tracked ? { eventId: tracked.eventId } : {}),
      });
      if (tracked?.text) {
        void appendTransportEvent(sessionName, {
          type: 'assistant.text',
          sessionId: sessionName,
          text: cancelledText,
          // Keep interrupted output visible/replayable, but never feed the
          // cancellation diagnostic back into memory or the next provider
          // context after a reconnect.
          memoryExcluded: true,
          [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true,
        });
      }
      if (staleWatchdogRecovery && !tracked?.text) {
        void appendTransportEvent(sessionName, {
          type: 'assistant.text',
          sessionId: sessionName,
          text: cancelledText,
          memoryExcluded: true,
        });
      }
      return;
    }

    // A transient failure (model at capacity, overloaded, 429, 5xx, dropped connection) is retried by the runtime every <=15 s
    // until it goes through. Each attempt must NOT add an error bubble or a persisted session.error row (that would be ~240 per
    // hour per session): the one user-visible signal is the episode notice (session.state.capacityRetry), and the runtime logs
    // once per episode. A partial streamed bubble is still finalized so it does not hang as "streaming"; the retry regenerates it.
    if (shouldRetryProviderErrorWithBackoff(error)) {
      if (tracked?.text) {
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: tracked.text,
          streaming: false,
          memoryExcluded: true,
          [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true,
          providerErrorCode: error.code,
          providerErrorRecoverable: true,
        }, {
          source: 'daemon',
          confidence: 'high',
          eventId: tracked.eventId,
        });
      }
      return;
    }

    const trackedAlreadyContainsError = !!tracked?.text
      && tracked.text.toLocaleLowerCase().includes(error.message.trim().toLocaleLowerCase());
    const errorText = tracked?.text
      ? (trackedAlreadyContainsError ? tracked.text : `${tracked.text}\n\n⚠️ Error: ${error.message}`)
      : `⚠️ Error: ${error.message}`;

    timelineEmitter.emit(sessionName, 'assistant.text', {
      text: errorText,
      streaming: false,
      providerErrorCode: error.code,
      providerErrorRecoverable: error.recoverable,
      ...(tracked ? { [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true } : {}),
      // Provider failures are diagnostic UI output, not assistant content.
      // Mark both empty and partial error bubbles so live ingestion and
      // history backfill cannot carry the failure into a later prompt.
      memoryExcluded: true,
    }, {
      source: 'daemon',
      confidence: 'high',
      ...(tracked ? { eventId: tracked.eventId } : {}),
    });

    // TransportSessionRuntime is the sole lifecycle owner. It transitions
    // recoverable failures back to idle and unrecoverable failures to error.
    // Emitting another session.state here produced duplicate error rows and,
    // for transient disconnects, briefly re-poisoned an otherwise usable
    // session until the user pressed Stop.

    void appendTransportEvent(sessionName, {
      type: 'session.error',
      sessionId: sessionName,
      error: error.message,
      code: error.code,
    });
    });
  });

  provider.onToolCall?.((providerSid: string, tool: ToolCallEvent) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) return;
    runWithRelaySessionPrivacy(sessionName, () => {
    // Suppress the tool_result of an AskUserQuestion we already surfaced as a
    // card. The SDK re-emits it as a generic name:'tool' event (is_error when the
    // answer was delivered via canUseTool deny) — rendering it would show a
    // confusing "< error: <answer>" line. The card + the model's continuation
    // already convey the outcome.
    const canonicalAskTool = canonicalAskQuestionToolName(tool.name);
    const askResultKey = `${sessionName}:${tool.id}`;
    if (!canonicalAskTool && askQuestionToolIds.has(askResultKey)) {
      if (tool.status !== 'running') askQuestionToolIds.delete(askResultKey);
      return;
    }

    // AskUserQuestion / ask_question are interactive tools: surface them as an
    // `ask.question` event so the web renders the question/options dialog (same
    // payload shape the process/JSONL path emits) instead of a raw tool-call
    // line. The chosen answer comes back via `ask.answer` and is delivered to
    // the provider as the next user turn (see handleAskAnswer).
    if (canonicalAskTool) {
      if (askQuestionToolIds.has(askResultKey)) {
        return;
      }
      const questionsFromInput = extractAskQuestionsFromToolInput(tool.input);
      const questions = questionsFromInput.length > 0
        ? questionsFromInput
        : extractAskQuestionsFromToolName(tool.name);
      // AskUserQuestion streams input incrementally and only populates
      // questions at completion; Antigravity's ask_question can emit populated
      // parameters while still running/waiting for input.
      const readyToSurface = tool.status !== 'running'
        || (canonicalAskTool === 'ask_question' && questions.length > 0);
      if (readyToSurface && questions.length > 0) {
        flushPreAskInFlightMessage(sessionName);
        turnSurfacedAskQuestions.add(sessionName);
        rememberBoundedSetId(askQuestionToolIds, askResultKey);
        timelineEmitter.emit(sessionName, 'ask.question', {
          toolUseId: tool.id,
          questions,
          waitMs: ASK_QUESTION_WAIT_MS,
        }, {
          source: 'daemon',
          confidence: 'high',
          eventId: `transport-ask:${sessionName}:${tool.id}`,
        });
        return;
      }
      // Preserve existing AskUserQuestion suppression for running/empty `{}` calls,
      // and avoid flashing raw ask_question at running before input streams in.
      if (canonicalAskTool === 'AskUserQuestion') {
        if (tool.status === 'running' || isEmptyAskInput(tool.input)) {
          return;
        }
      } else if (tool.status === 'running' && isEmptyAskInput(tool.input)) {
        return;
      }
      // Un-surfaced call with malformed/invalid/completed-empty input falls back
      // to generic tool.call / tool.result so the timeline never drops the tool.
      if (tool.status === 'running') {
        rememberBoundedSetId(fallbackAskToolCallIds, askResultKey);
      } else if (!fallbackAskToolCallIds.delete(askResultKey)) {
        emitGenericToolCall(sessionName, tool);
      }
    }

    const sdkDetail = parseSdkSubagentDetail(tool.detail);
    if (sdkDetail.kind === 'malformed-sdk') {
      logger.warn({ toolId: tool.id, reason: sdkDetail.reason }, 'transport-relay: dropping malformed sdk sub-agent detail');
      return;
    }

    // Post-start advisory evidence for providers without a pre-execution gate;
    // native-agent calls remain allowed and the tool event is projected
    // unchanged.
    try {
      enforceObservedNativeCollaboration(sessionName, provider.id, tool, {
        admissionMode: readNativeAgentAdmissionMode(provider.capabilities?.nativeAgentAdmission),
      });
    } catch (error) {
      logger.warn({ error, sessionName, toolId: tool.id }, 'transport-relay: native collaboration enforcement failed');
    }
    if (sdkDetail.kind === 'ok') {
      const sdkPayload = buildSdkSubagentTimelinePayload({
        ...tool,
        detail: sdkDetail.detail,
      }, {
        allowRaw: Boolean(sdkDetail.detail.meta.diagnosticCode),
        sessionId: sessionName,
      });
      if (!sdkPayload) return;
      const eventToolId = normalizeSdkSubagentKeyComponent(tool.id || sdkDetail.detail.meta.canonicalKey);
      // Agents replay uses main timeline (via timelineEmitter), NOT transport JSONL.
      // SDK tool.call/tool.result are hidden from transport history (transport-history only
      // keeps user.message / assistant.text / tool.result for normal tools).  Do NOT
      // appendTransportEvent here — it would write dead entries that shouldKeepTransportHistoryEvent
      // would immediately discard, wasting memory and polluting the transport log.
      if (tool.status === 'running') {
        timelineEmitter.emit(sessionName, 'tool.call', sdkPayload.payload, {
          source: 'daemon',
          confidence: 'high',
          eventId: `transport-tool:${sessionName}:${eventToolId}:call`,
          hidden: true,
        });
        return;
      }

      timelineEmitter.emit(sessionName, 'tool.result', sdkPayload.payload, {
        source: 'daemon',
        confidence: 'high',
        eventId: `transport-tool:${sessionName}:${eventToolId}:result`,
        hidden: true,
      });
      return;
    }

    if (isChecklistTool(tool)) {
      // Plan/checklist snapshots are state, not file edits. In particular,
      // Codex SDK can surface a `todo_list` item only at completion; if we let
      // `update_plan` flow into the generic file-like deferral path (because
      // its name contains "update"), the web receives only tool.result and the
      // pinned checklist has no tool.call to render.
      emitChecklistToolCall(sessionName, tool);
      if (tool.status !== 'running') emitToolResult(sessionName, tool);
      return;
    }

    const fileChangeKey = `${sessionName}:${tool.id}`;

    const initialToolKind = String(tool.detail?.kind ?? '').toLowerCase();
    const looksLikeStructuredFileTool = initialToolKind === 'filechange'
      || /(?:write|edit|update|create|rename|delete|patch|save)/i.test(tool.name);
    if (tool.status === 'running' && looksLikeStructuredFileTool) {
      rememberPendingFileLikeTool(fileChangeKey, tool);
      return;
    }

    const pending = pendingFileLikeTools.get(fileChangeKey);
    if (tool.status !== 'running') pendingFileLikeTools.delete(fileChangeKey);
    const effectiveTool: ToolCallEvent = pending ? {
      ...pending,
      ...tool,
      input: tool.input ?? pending.input,
      detail: tool.detail ?? pending.detail,
      output: tool.output ?? pending.output,
    } : tool;
    const effectiveToolKind = String(effectiveTool.detail?.kind ?? '').toLowerCase();

    const codexBatch = tool.status !== 'error' && effectiveToolKind === 'filechange'
      ? normalizeCodexSdkFileChange({
        toolCallId: effectiveTool.id,
        detail: effectiveTool.detail,
        raw: effectiveTool.detail?.raw ?? effectiveTool.input,
      })
      : null;
    const qwenBatch = tool.status !== 'error' && !codexBatch && looksLikeStructuredFileTool
      ? normalizeQwenFileChange({
        toolName: effectiveTool.name,
        toolCallId: effectiveTool.id,
        input: effectiveTool.input,
        raw: effectiveTool.detail?.raw ?? effectiveTool.detail,
      })
      : null;
    const fileChangeBatch = codexBatch ?? qwenBatch;

    if (looksLikeStructuredFileTool && completedFileLikeTools.has(fileChangeKey)) {
      return;
    }
    if (looksLikeStructuredFileTool && tool.status !== 'running') {
      rememberCompletedFileLikeTool(fileChangeKey);
    }

    if (fileChangeBatch) {
      timelineEmitter.emit(sessionName, 'tool.call', {
        toolCallId: effectiveTool.id,
        tool: effectiveTool.name,
        ...(effectiveTool.input !== undefined ? { input: effectiveTool.input } : {}),
        ...(effectiveTool.detail !== undefined ? { detail: effectiveTool.detail } : {}),
      }, {
        source: 'daemon',
        confidence: 'high',
        eventId: `transport-tool:${sessionName}:${effectiveTool.id}:call`,
        hidden: true,
      });
      void appendTransportEvent(sessionName, {
        type: 'tool.call',
        sessionId: sessionName,
        toolCallId: effectiveTool.id,
        tool: effectiveTool.name,
        ...(effectiveTool.input !== undefined ? { input: effectiveTool.input } : {}),
        ...(effectiveTool.detail !== undefined ? { detail: effectiveTool.detail } : {}),
        hidden: true,
      });
      timelineEmitter.emit(sessionName, 'tool.result', {
        toolCallId: effectiveTool.id,
        ...terminalMetadataForTool(sessionName, effectiveTool),
        ...(effectiveTool.status === 'error'
          ? { error: effectiveTool.output ?? 'error' }
          : effectiveTool.output !== undefined
            ? { output: effectiveTool.output }
            : {}),
        ...(effectiveTool.detail !== undefined ? { detail: effectiveTool.detail } : {}),
      }, {
        source: 'daemon',
        confidence: 'high',
        eventId: `transport-tool:${sessionName}:${effectiveTool.id}:result`,
        hidden: true,
      });
      void appendTransportEvent(sessionName, {
        type: 'tool.result',
        sessionId: sessionName,
        toolCallId: effectiveTool.id,
        ...terminalMetadataForTool(sessionName, effectiveTool),
        tool: effectiveTool.name,
        ...(effectiveTool.detail !== undefined ? { detail: effectiveTool.detail } : {}),
        ...(effectiveTool.status === 'error'
          ? { error: effectiveTool.output ?? 'error' }
          : effectiveTool.output !== undefined
            ? { output: effectiveTool.output }
            : {}),
        hidden: true,
      });
      timelineEmitter.emit(sessionName, TIMELINE_EVENT_FILE_CHANGE, { batch: fileChangeBatch }, {
        source: 'daemon',
        confidence: 'high',
        eventId: `transport-file-change:${sessionName}:${effectiveTool.id}`,
      });
      return;
    }

    if (pending && looksLikeStructuredFileTool) {
      emitGenericToolCall(sessionName, effectiveTool);
    }

    if (tool.status === 'running') {
      emitGenericToolCall(sessionName, tool);
      return;
    }

    emitToolResult(sessionName, tool);
    });
  });

  provider.onStatus?.((providerSid: string, status: ProviderStatusUpdate) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for status — dropped');
      return;
    }
    runWithRelaySessionPrivacy(sessionName, () => {
      emitThrottledAgentStatus(sessionName, {
        status: status.status,
        ...(status.label !== undefined ? { label: status.label } : {}),
      }, status.status);
    });
  });

  provider.onUsage?.((providerSid: string, update: ProviderUsageUpdate) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for usage — dropped');
      return;
    }
    runWithRelaySessionPrivacy(sessionName, () => {
    const usagePayload = normalizeUsageUpdatePayload(sessionName, update.usage, update.model);
    if (usagePayload) {
      const tracked = inFlightMessages.get(sessionName);
      const finalized = update.finalized === true;
      const providerMessageId = typeof update.messageId === 'string' && update.messageId
        ? update.messageId
        : undefined;
      const usageEventId = providerMessageId
        ? `transport:${sessionName}:${providerMessageId}:usage`
        : `${tracked?.eventId ?? `transport:${sessionName}:usage`}:usage`;
      timelineEmitter.emit(sessionName, 'usage.update', {
        ...usagePayload,
        // A full Claude assistant/result frame can arrive after the terminal
        // stream boundary. Its cache split is newer and more authoritative
        // than the aggregate getContextUsage() snapshot already persisted by
        // onComplete, so emit it as a terminal replacement with the same id.
        // Ordinary live-meter updates remain streaming-only and disk-free.
        streaming: !finalized,
      }, { source: 'daemon', confidence: 'high', eventId: usageEventId });
    }
    });
  });

  provider.onApprovalRequest?.((providerSid: string, request) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for approval — dropped');
      return;
    }
    const runtime = getTransportRuntime(sessionName);
    if (runtime?.requiresSharedMachineAuthority()) {
      const captured = captureRelayToolBinding(sessionName, providerSid);
      const requestInfo: ToolExecutionRequest = {
        toolName: request.tool ?? '',
        input: undefined,
        description: request.description,
        inputPreview: request.inputPreview,
        cwd: getSession(sessionName)?.projectDir,
        ...(request.providerToolUseId ? { toolUseId: request.providerToolUseId } : {}),
        providerSessionId: providerSid,
        dispatchId: captured.dispatchId,
      };
      void Promise.resolve(
        toolExecutionEvaluator
          ? toolExecutionEvaluator(sessionName, requestInfo)
          : evaluateParticipantToolAccess(requestInfo, {
              cwd: requestInfo.cwd,
              sessionName,
              providerSessionId: providerSid,
              dispatchId: captured.dispatchId,
            }),
      ).then((decision) => {
        if (!isRelayToolBindingCurrent(captured)) return;
        if (!decision.allow) {
          logger.warn(
            { sessionName, providerSid, requestId: request.id, tool: request.tool },
            'transport-relay: suppressed sensitive-path approval during shared-participant turn',
          );
          if (!toolExecutionEvaluator) {
            emitAgentStatus(sessionName, {
              status: 'running',
              label: 'Blocked sensitive path tool access',
            });
          }
          return;
        }
        runWithRelaySessionPrivacy(sessionName, () => {
          const payload = {
            type: TRANSPORT_EVENT.CHAT_APPROVAL,
            sessionId: sessionName,
            requestId: request.id,
            description: request.description,
            ...(request.tool ? { tool: request.tool } : {}),
            ...(request.provider ? { provider: request.provider } : {}),
            ...(typeof request.providerGeneration === 'number' ? { providerGeneration: request.providerGeneration } : {}),
            ...(request.providerToolUseId ? { providerToolUseId: request.providerToolUseId } : {}),
            ...(request.inputPreview ? { inputPreview: request.inputPreview } : {}),
          } as const;
          sendToServer?.(payload);
          void appendTransportEvent(sessionName, payload);
        });
      });
      return;
    }
    if (runtime && !runtime.requiresSharedMachineAuthority()) {
      clearPreEvaluatedParticipantToolDecisions(sessionName);
    }
    runWithRelaySessionPrivacy(sessionName, () => {
    const payload = {
      type: TRANSPORT_EVENT.CHAT_APPROVAL,
      sessionId: sessionName,
      requestId: request.id,
      description: request.description,
      ...(request.tool ? { tool: request.tool } : {}),
      ...(request.provider ? { provider: request.provider } : {}),
      ...(typeof request.providerGeneration === 'number' ? { providerGeneration: request.providerGeneration } : {}),
      ...(request.providerToolUseId ? { providerToolUseId: request.providerToolUseId } : {}),
      ...(request.inputPreview ? { inputPreview: request.inputPreview } : {}),
    } as const;
    sendToServer?.(payload);
    void appendTransportEvent(sessionName, payload);
    });
  });
}

/**
 * Emit and persist a transport user.message as one projection.
 *
 * `extra` carries the stable client/command identity used by the queue UI. It
 * must be written to the JSONL fallback as well as the primary timeline;
 * otherwise a reload can render the already-delivered text from chat.history
 * while still rendering the same id from a stale queue snapshot.
 */
export function emitTransportUserMessage(
  sessionId: string,
  text: string,
  extra: Record<string, unknown> = {},
  eventId?: string,
): void {
  runWithRelaySessionPrivacy(sessionId, () => {
    preAskFinalizedTexts.delete(sessionId);
    turnSurfacedAskQuestions.delete(sessionId);
    const payload = { text, allowDuplicate: true, ...extra };
    const emitted = timelineEmitter.emit(
      sessionId,
      'user.message',
      payload,
      { source: 'daemon', confidence: 'high', ...(eventId ? { eventId } : {}) },
    );
    persistTransportUserMessage(sessionId, text, payload, emitted?.eventId || eventId);
  });
}

/** Persist the fallback copy for a user.message already emitted elsewhere. */
export function persistTransportUserMessage(
  sessionId: string,
  text: string,
  extra: Record<string, unknown> = {},
  eventId?: string,
): void {
  runWithRelaySessionPrivacy(sessionId, () => {
    void appendTransportEvent(sessionId, {
      type: 'user.message',
      sessionId,
      text,
      ...extra,
      ...(eventId ? { eventId } : {}),
    });
  });
}

/** Broadcast provider status change to all browsers. When connected, also push remote sessions. */
export function broadcastProviderStatus(providerId: string, connected: boolean): void {
  if (!sendToServer) {
    logger.warn({ providerId, connected }, 'broadcastProviderStatus: no server link — status NOT sent to browsers');
    return;
  }
  logger.info({ providerId, connected }, 'Broadcasting provider status to browsers');
  sendToServer({
    type: TRANSPORT_MSG.PROVIDER_STATUS,
    providerId,
    connected,
  });

  // Auto-push remote sessions when provider connects
  if (connected) {
    void pushProviderSessions(providerId);
  }
}

/** Fetch remote sessions from a provider and broadcast to browsers + sync to server DB. */
async function pushProviderSessions(providerId: string): Promise<void> {
  try {
    const { listProviderSessions } = await import('./provider-sessions.js');
    const sessions = await listProviderSessions(providerId);
    if (!sendToServer) return;
    // Send via sync_sessions — bridge handles this: caches, persists to DB, broadcasts to browsers
    sendToServer({
      type: 'provider.sync_sessions',
      providerId,
      sessions,
    });
    logger.info({ providerId, count: sessions.length }, 'Pushed provider remote sessions');
  } catch (err) {
    logger.warn({ err, providerId }, 'Failed to push provider sessions on connect');
  }
}

/** @internal Exported for tests only — see test/daemon/transport-relay-usage-payload.test.ts. */
export const __testing__ = {
  normalizeUsageUpdatePayload,
  emitSdkTurnLostRecoveryPhaseForTest: emitSdkTurnLostRecoveryPhase,
  /**
   * Clear all module-global per-session relay state. Tests reuse session names
   * across cases; without this, a prior test's in-flight message leaks and the
   * next test's first delta (different messageId) triggers a finalize emit.
   * Production never needs this — onComplete/onError clear inFlightMessages,
   * and an orphaned leftover finalizing on the next turn is the desired
   * behavior (the orphan message gets persisted).
   */
  resetRelayState(): void {
    streamTextThrottle.clearAll();
    statusThrottle.clearAll();
    lastEmittedStatusName.clear();
    inFlightMessages.clear();
    finalizedTurnMessages.clear();
    preAskFinalizedTexts.clear();
    turnSurfacedAskQuestions.clear();
    pendingFileLikeTools.clear();
    completedFileLikeTools.clear();
    askQuestionToolIds.clear();
    emittedSdkTurnLostRecoveryPhases.clear();
  },
};
