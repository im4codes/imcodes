/**
 * Relay TransportProvider callbacks into the unified timeline event system.
 *
 * Transport events are emitted through timelineEmitter (same as CC/Codex/Gemini
 * JSONL watchers), so ChatView renders them without any special handling.
 * Also cached to local JSONL for replay on reconnect/restart.
 */
import type { TransportProvider, ProviderError, ProviderStatusUpdate } from '../agent/transport-provider.js';
import type { MessageDelta, AgentMessage, ToolCallEvent } from '../../shared/agent-message.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { resolveSessionName } from '../agent/session-manager.js';
import { timelineEmitter } from './timeline-emitter.js';
import { appendTransportEvent } from './transport-history.js';
import logger from '../util/logger.js';
import { resolveContextWindow } from '../util/model-context.js';

let sendToServer: ((msg: Record<string, unknown>) => void) | null = null;
const inFlightMessages = new Map<string, { messageId: string; eventId: string; text: string }>();
const pendingStreamUpdates = new Map<string, {
  sessionName: string;
  eventId: string;
  lastEmitAt: number;
  pendingText: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}>();
const STREAM_UPDATE_INTERVAL_MS = 80;

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
    if (!sessionName) { logger.warn({ providerSid }, 'transport-relay: unresolved route for delta — dropped'); return; }

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
    } | undefined;
    const model = typeof message.metadata?.model === 'string' ? message.metadata.model : undefined;
    if (usage || model) {
      timelineEmitter.emit(sessionName, 'usage.update', {
        ...(typeof usage?.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
        ...(typeof usage?.cache_read_input_tokens === 'number' ? { cacheTokens: usage.cache_read_input_tokens } : {}),
        ...(model ? { model } : {}),
        contextWindow: resolveContextWindow(undefined, model),
      }, { source: 'daemon', confidence: 'high' });
    }

    // Emit idle state
    timelineEmitter.emit(sessionName, 'session.state', {
      state: 'idle',
    }, { source: 'daemon', confidence: 'high' });

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
