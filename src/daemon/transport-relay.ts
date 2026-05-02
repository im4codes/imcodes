/**
 * Relay TransportProvider callbacks into the unified timeline event system.
 *
 * Transport events are emitted through timelineEmitter (same as CC/Codex/Gemini
 * JSONL watchers), so ChatView renders them without any special handling.
 * Also cached to local JSONL for replay on reconnect/restart.
 */
import type { TransportProvider, ProviderError, ProviderStatusUpdate, ProviderUsageUpdate } from '../agent/transport-provider.js';
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
import { normalizeCodexSdkFileChange, normalizeQwenFileChange } from './file-change-normalizer.js';
import { USAGE_CONTEXT_WINDOW_SOURCES } from '../../shared/usage-context-window.js';
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';

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
const MAX_TRACKED_FILE_TOOLS = 512;

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
      state: 'idle',
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
        tool: effectiveTool.name,
        ...(effectiveTool.input !== undefined ? { input: effectiveTool.input } : {}),
        ...(effectiveTool.detail !== undefined ? { detail: effectiveTool.detail } : {}),
        hidden: true,
      });
      timelineEmitter.emit(sessionName, 'tool.result', {
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
        tool: effectiveTool.name,
        ...(effectiveTool.input !== undefined ? { input: effectiveTool.input } : {}),
        ...(effectiveTool.detail !== undefined ? { detail: effectiveTool.detail } : {}),
      });
    }

    if (tool.status === 'running') {
      timelineEmitter.emit(sessionName, 'tool.call', {
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
        tool: tool.name,
        ...(tool.input !== undefined ? { input: tool.input } : {}),
        ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
      });
      return;
    }

    timelineEmitter.emit(sessionName, 'tool.result', {
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
      ...(tool.status === 'error'
        ? { error: tool.output ?? 'error' }
        : tool.output !== undefined
          ? { output: tool.output }
          : {}),
      ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
    });
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
