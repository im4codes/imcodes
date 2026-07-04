/**
 * Relay TransportProvider callbacks into the unified timeline event system.
 *
 * Transport events are emitted through timelineEmitter (same as CC/Codex/Gemini
 * JSONL watchers), so ChatView renders them without any special handling.
 * Also cached to local JSONL for replay on reconnect/restart.
 */
import {
  PROVIDER_ERROR_CODES,
  SDK_TURN_LOST_RECOVERY_PHASES,
  SDK_TURN_LOST_RECOVERY_REASON,
  SDK_TURN_LOST_RECOVERY_STATUS,
  isSdkTurnLostRecovery,
  sanitizeSdkTurnLostRecoveryMetadata,
  type SdkTurnLostRecoveryMetadata,
  type SdkTurnLostRecoveryPhase,
  type TransportProvider,
  type ProviderError,
  type ProviderStatusUpdate,
  type ProviderUsageUpdate,
} from '../agent/transport-provider.js';
import type { MessageDelta, AgentMessage, ToolCallEvent } from '../../shared/agent-message.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';
import { resolveSessionName, isEphemeralProviderSid } from '../agent/session-manager.js';
import { timelineEmitter } from './timeline-emitter.js';
import { appendTransportEvent } from './transport-history.js';
import logger from '../util/logger.js';
import { resolveContextWindow } from '../util/model-context.js';
import { getSession } from '../store/session-store.js';
import { getCachedPresetContextWindow } from './cc-presets.js';
import { TIMELINE_EVENT_FILE_CHANGE } from '../../shared/file-change.js';
import { ASK_QUESTION_WAIT_MS } from '../../shared/ask-question-timing.js';
import { normalizeCodexSdkFileChange, normalizeQwenFileChange } from './file-change-normalizer.js';
import { USAGE_CONTEXT_WINDOW_SOURCES } from '../../shared/usage-context-window.js';
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';
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
const pendingStreamUpdates = new Map<string, {
  sessionName: string;
  eventId: string;
  lastEmitAt: number;
  pendingText: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}>();
const STREAM_UPDATE_INTERVAL_MS = 40;
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
const MAX_TRACKED_FILE_TOOLS = 512;
const emittedSdkTurnLostRecoveryPhases = new Set<string>();

const SDK_TURN_LOST_RECOVERY_PHASE_LABELS: Record<SdkTurnLostRecoveryPhase, string> = {
  [SDK_TURN_LOST_RECOVERY_PHASES.DETECTED]: 'Detected lost Codex SDK turn',
  [SDK_TURN_LOST_RECOVERY_PHASES.RECOVERING]: 'Recovering lost Codex SDK turn',
  [SDK_TURN_LOST_RECOVERY_PHASES.RECOVERED]: 'Recovered lost Codex SDK turn',
  [SDK_TURN_LOST_RECOVERY_PHASES.FAILED]: 'Lost Codex SDK turn recovery needs user action',
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
  const explicitSession = metadata.sessionName ?? metadata.localSessionKey;
  if (explicitSession && explicitSession !== sessionName) {
    logger.warn(
      { sessionName, recoverySessionName: metadata.sessionName, recoveryLocalSessionKey: metadata.localSessionKey },
      'transport-relay: dropped sdk_turn_lost recovery phase with conflicting session metadata',
    );
    return false;
  }
  if (expectedProviderSessionId && metadata.providerSessionId && metadata.providerSessionId !== expectedProviderSessionId) {
    logger.warn(
      { sessionName, providerSid: expectedProviderSessionId, recoveryProviderSessionId: metadata.providerSessionId },
      'transport-relay: dropped sdk_turn_lost recovery phase with conflicting provider session metadata',
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

function emitStreamingAssistantText(sessionName: string, eventId: string, text: string): void {
  timelineEmitter.emit(sessionName, 'assistant.text', {
    text,
    streaming: true,
  }, { source: 'daemon', confidence: 'high', eventId });
}

function clearPendingStreamUpdate(eventId: string): void {
  const pending = pendingStreamUpdates.get(eventId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pendingStreamUpdates.delete(eventId);
}

function normalizeUsageUpdatePayload(
  sessionName: string,
  usage: ProviderUsageUpdate['usage'] | undefined,
  model: string | undefined,
): Record<string, unknown> | null {
  if (!usage && !model) return null;
  const session = getSession(sessionName);
  const effectiveModel = resolveEffectiveSessionModel(session, model);
  const presetCtx = session?.presetContextWindow
    ?? (session?.ccPreset ? getCachedPresetContextWindow(session.ccPreset) : undefined);
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
  const explicitContextWindow = typeof usage?.model_context_window === 'number' && Number.isFinite(usage.model_context_window) && usage.model_context_window > 0
    ? usage.model_context_window
    : undefined;
  const contextWindow = resolveContextWindow(
    explicitContextWindow ?? presetCtx,
    effectiveModel,
    1_000_000,
    { preferExplicit: explicitContextWindow !== undefined },
  );
  const contextWindowSource = explicitContextWindow !== undefined && contextWindow === explicitContextWindow
    ? USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER
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

function flushPendingStreamUpdate(eventId: string): void {
  const pending = pendingStreamUpdates.get(eventId);
  if (!pending || pending.pendingText == null) return;
  pending.timer = null;
  pending.lastEmitAt = Date.now();
  const nextText = pending.pendingText;
  pending.pendingText = null;
  emitStreamingAssistantText(pending.sessionName, pending.eventId, nextText);
}

function emitThrottledStreamingAssistantText(sessionName: string, eventId: string, text: string): void {
  const now = Date.now();
  let pending = pendingStreamUpdates.get(eventId);
  if (!pending) {
    pending = {
      sessionName,
      eventId,
      lastEmitAt: 0,
      pendingText: null,
      timer: null,
    };
    pendingStreamUpdates.set(eventId, pending);
  } else {
    pending.sessionName = sessionName;
  }

  if (pending.lastEmitAt === 0 || now - pending.lastEmitAt >= STREAM_UPDATE_INTERVAL_MS) {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.pendingText = null;
    pending.lastEmitAt = now;
    emitStreamingAssistantText(sessionName, eventId, text);
    return;
  }

  pending.pendingText = text;
  if (pending.timer) return;
  pending.timer = setTimeout(() => {
    flushPendingStreamUpdate(eventId);
  }, STREAM_UPDATE_INTERVAL_MS - (now - pending.lastEmitAt));
}

/** Set the send function (called once during server-link setup) */
export function setTransportRelaySend(fn: (msg: Record<string, unknown>) => void): void {
  sendToServer = fn;
}

/** Wire up a provider's callbacks to emit standard timeline events.
 *  Provider callbacks use providerSessionId; we resolve to IM.codes sessionName
 *  via the routing map before emitting. Unresolved routes are dropped + warned. */
export function wireProviderToRelay(provider: TransportProvider): void {
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
    inFlightMessages.set(sessionName, {
      messageId: delta.messageId,
      eventId: stableEventId,
      text: delta.delta,
    });

    emitThrottledStreamingAssistantText(sessionName, stableEventId, delta.delta);
  });

  provider.onComplete((providerSid: string, message: AgentMessage) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for complete — dropped');
      return;
    }
    if (isCompactControlCompletion(message)) {
      const tracked = inFlightMessages.get(sessionName);
      if (tracked) {
        inFlightMessages.delete(sessionName);
        clearPendingStreamUpdate(tracked.eventId);
      }
      return;
    }
    const finalText = message.content;

    // Replace streaming event with final version (same eventId → in-place update)
    const tracked = inFlightMessages.get(sessionName);
    const stableEventId = tracked?.messageId === message.id
      ? tracked.eventId
      : `transport:${sessionName}:${message.id}`;
    inFlightMessages.delete(sessionName);
    clearPendingStreamUpdate(stableEventId);
    timelineEmitter.emit(sessionName, 'assistant.text', {
      text: finalText,
      streaming: false,
    }, { source: 'daemon', confidence: 'high', eventId: stableEventId });

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
      timelineEmitter.emit(sessionName, 'usage.update', usagePayload, { source: 'daemon', confidence: 'high' });
    }

    // TransportSessionRuntime owns lifecycle state transitions. Emitting idle here
    // races the runtime's drain/idle transitions and can desynchronize queue state.

    // Cache final text for replay
    void appendTransportEvent(sessionName, {
      type: 'assistant.text',
      sessionId: sessionName,
      text: finalText,
    });
  });

  provider.onError((providerSid: string, error: ProviderError) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for error — dropped');
      return;
    }

    const tracked = inFlightMessages.get(sessionName);
    inFlightMessages.delete(sessionName);
    if (tracked) clearPendingStreamUpdate(tracked.eventId);

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
      // Preserve the partial streamed content up to the stop point and persist it.
      // Previously this replaced the in-place streaming event (same eventId) with
      // ONLY the cancel notice, so pressing Esc/Stop mid-stream made the visible
      // assistant text "suddenly lose a big chunk" and the partial never hit disk.
      // Mirror the error branch below: keep `tracked.text` + a terminal marker, and
      // append the transport event so the partial survives refresh/reconnect (落盘).
      const cancelledText = tracked?.text
        ? `${tracked.text}\n\n⚠️ Turn cancelled`
        : `⚠️ Turn cancelled: ${error.message}`;
      timelineEmitter.emit(sessionName, 'assistant.text', {
        text: cancelledText,
        streaming: false,
        // Cancelled output is deliberately interrupted — keep it out of memory,
        // but still display + persist it. (Display/replay are unaffected by this flag.)
        memoryExcluded: true,
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
        });
      }
      return;
    }

    const errorText = tracked?.text
      ? `${tracked.text}\n\n⚠️ Error: ${error.message}`
      : `⚠️ Error: ${error.message}`;

    timelineEmitter.emit(sessionName, 'assistant.text', {
      text: errorText,
      streaming: false,
      ...(!tracked?.text ? { memoryExcluded: true } : {}),
    }, {
      source: 'daemon',
      confidence: 'high',
      ...(tracked ? { eventId: tracked.eventId } : {}),
    });

    timelineEmitter.emit(sessionName, 'session.state', {
      state: 'error',
      error: error.message,
    }, { source: 'daemon', confidence: 'high' });

    void appendTransportEvent(sessionName, {
      type: 'session.error',
      sessionId: sessionName,
      error: error.message,
      code: error.code,
    });
  });

  provider.onToolCall?.((providerSid: string, tool: ToolCallEvent) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) return;

    // Suppress the tool_result of an AskUserQuestion we already surfaced as a
    // card. The SDK re-emits it as a generic name:'tool' event (is_error when the
    // answer was delivered via canUseTool deny) — rendering it would show a
    // confusing "< error: <answer>" line. The card + the model's continuation
    // already convey the outcome.
    const askResultKey = `${sessionName}:${tool.id}`;
    if (tool.name !== 'AskUserQuestion' && askQuestionToolIds.has(askResultKey)) {
      if (tool.status !== 'running') askQuestionToolIds.delete(askResultKey);
      return;
    }

    // AskUserQuestion is an interactive tool: surface it as an `ask.question`
    // event so the web renders the question/options dialog (same payload shape
    // the process/JSONL path emits) instead of a raw `> AskUserQuestion {...}`
    // tool-call line. The chosen answer comes back via `ask.answer` and is
    // delivered to the provider as the next user turn (see handleAskAnswer).
    if (tool.name === 'AskUserQuestion') {
      // The tool input (the questions) streams in incrementally, so it is only
      // populated once the call is COMPLETE — emitting at 'running' would surface
      // an empty card. The SDK self-continues without a tool_result, so the
      // completed call is the right (and only) moment to show the question.
      if (tool.status !== 'running') {
        const askInput = (tool.input ?? {}) as Record<string, unknown>;
        const questions = Array.isArray(askInput.questions)
          ? askInput.questions
          : (askInput.question || askInput.options ? [askInput] : []);
        if (questions.length > 0) {
          askQuestionToolIds.add(`${sessionName}:${tool.id}`);
          timelineEmitter.emit(sessionName, 'ask.question', {
            toolUseId: tool.id,
            questions,
            waitMs: ASK_QUESTION_WAIT_MS,
          }, {
            source: 'daemon',
            confidence: 'high',
            eventId: `transport-ask:${sessionName}:${tool.id}`,
          });
        }
      }
      return;
    }

    const sdkDetail = parseSdkSubagentDetail(tool.detail);
    if (sdkDetail.kind === 'malformed-sdk') {
      logger.warn({ toolId: tool.id, reason: sdkDetail.reason }, 'transport-relay: dropping malformed sdk sub-agent detail');
      return;
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
      timelineEmitter.emit(sessionName, 'tool.call', {
        toolCallId: effectiveTool.id,
        tool: effectiveTool.name,
        ...(effectiveTool.input !== undefined ? { input: effectiveTool.input } : {}),
        ...(effectiveTool.detail !== undefined ? { detail: effectiveTool.detail } : {}),
      }, {
        source: 'daemon',
        confidence: 'high',
        eventId: `transport-tool:${sessionName}:${effectiveTool.id}:call`,
      });
      void appendTransportEvent(sessionName, {
        type: 'tool.call',
        sessionId: sessionName,
        toolCallId: effectiveTool.id,
        tool: effectiveTool.name,
        ...(effectiveTool.input !== undefined ? { input: effectiveTool.input } : {}),
        ...(effectiveTool.detail !== undefined ? { detail: effectiveTool.detail } : {}),
      });
    }

    if (tool.status === 'running') {
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
      return;
    }

    emitToolResult(sessionName, tool);
  });

  provider.onStatus?.((providerSid: string, status: ProviderStatusUpdate) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for status — dropped');
      return;
    }

    timelineEmitter.emit(sessionName, 'agent.status', {
      status: status.status,
      ...(status.label !== undefined ? { label: status.label } : {}),
    }, { source: 'daemon', confidence: 'high' });
  });

  provider.onUsage?.((providerSid: string, update: ProviderUsageUpdate) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for usage — dropped');
      return;
    }

    const usagePayload = normalizeUsageUpdatePayload(sessionName, update.usage, update.model);
    if (usagePayload) {
      timelineEmitter.emit(sessionName, 'usage.update', usagePayload, { source: 'daemon', confidence: 'high' });
    }
  });

  provider.onApprovalRequest?.((providerSid: string, request) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for approval — dropped');
      return;
    }

    const payload = {
      type: TRANSPORT_EVENT.CHAT_APPROVAL,
      sessionId: sessionName,
      requestId: request.id,
      description: request.description,
      ...(request.tool ? { tool: request.tool } : {}),
    } as const;
    sendToServer?.(payload);
    void appendTransportEvent(sessionName, payload);
  });
}

/** Emit user.message through timeline when user sends to a transport session. */
export function emitTransportUserMessage(sessionId: string, text: string): void {
  timelineEmitter.emit(sessionId, 'user.message', { text, allowDuplicate: true }, { source: 'daemon', confidence: 'high' });
  void appendTransportEvent(sessionId, {
    type: 'user.message',
    sessionId,
    text,
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
    for (const eventId of [...pendingStreamUpdates.keys()]) clearPendingStreamUpdate(eventId);
    inFlightMessages.clear();
    pendingFileLikeTools.clear();
    completedFileLikeTools.clear();
    askQuestionToolIds.clear();
    emittedSdkTurnLostRecoveryPhases.clear();
  },
};
