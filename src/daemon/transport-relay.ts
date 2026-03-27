/**
 * Relay TransportProvider callbacks into the unified timeline event system.
 *
 * Transport events are emitted through timelineEmitter (same as CC/Codex/Gemini
 * JSONL watchers), so ChatView renders them without any special handling.
 * Also cached to local JSONL for replay on reconnect/restart.
 */
import type { TransportProvider, ProviderError } from '../agent/transport-provider.js';
import type { MessageDelta, AgentMessage } from '../../shared/agent-message.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { resolveSessionName } from '../agent/session-manager.js';
import { timelineEmitter } from './timeline-emitter.js';
import { appendTransportEvent } from './transport-history.js';
import logger from '../util/logger.js';

let sendToServer: ((msg: Record<string, unknown>) => void) | null = null;

/** Set the send function (called once during server-link setup) */
export function setTransportRelaySend(fn: (msg: Record<string, unknown>) => void): void {
  sendToServer = fn;
}

/** Per-session text accumulator for streaming deltas → assistant.text events. */
const accumulators = new Map<string, { messageId: string; text: string }>();

/** Wire up a provider's callbacks to emit standard timeline events.
 *  Provider callbacks use providerSessionId; we resolve to IM.codes sessionName
 *  via the routing map before emitting. Unresolved routes are dropped + warned. */
export function wireProviderToRelay(provider: TransportProvider): void {
  provider.onDelta((providerSid: string, delta: MessageDelta) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) return;

    // Provider may send cumulative deltas (full text so far) or incremental.
    // Use delta.delta as the display text directly — the provider's internal
    // accumulator handles cumulative vs incremental differences.
    const accKey = `${sessionName}:${delta.messageId}`;
    accumulators.set(accKey, { messageId: delta.messageId, text: delta.delta });

    // Emit streaming event via timelineEmitter — use stable eventId so frontend
    // replaces in place (typewriter effect).
    const stableEventId = `transport:${sessionName}:${delta.messageId}`;
    timelineEmitter.emit(sessionName, 'assistant.text', {
      text: delta.delta,
      streaming: true,
    }, { source: 'daemon', confidence: 'high', eventId: stableEventId });
  });

  provider.onComplete((providerSid: string, message: AgentMessage) => {
    const sessionName = resolveSessionName(providerSid);
    if (!sessionName) {
      logger.debug({ providerSid }, 'transport-relay: unresolved route for complete — dropped');
      return;
    }

    const accKey = `${sessionName}:${message.id}`;
    // Use message.content as authoritative final text (provider accumulated internally)
    const finalText = message.content;
    accumulators.delete(accKey);

    // Replace streaming event with final version (same eventId → in-place update)
    const stableEventId = `transport:${sessionName}:${message.id}`;
    timelineEmitter.emit(sessionName, 'assistant.text', {
      text: finalText,
      streaming: false,
    }, { source: 'daemon', confidence: 'high', eventId: stableEventId });

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

    // Show error as a visible message in the chat so the user knows what happened
    timelineEmitter.emit(sessionName, 'assistant.text', {
      text: `⚠️ Error: ${error.message}`,
      streaming: false,
    }, { source: 'daemon', confidence: 'high' });

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
}

/** Emit user.message through timeline when user sends to a transport session. */
export function emitTransportUserMessage(sessionId: string, text: string): void {
  timelineEmitter.emit(sessionId, 'user.message', { text }, { source: 'daemon', confidence: 'high' });
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
    const { listProviderSessions } = await import('./command-handler.js');
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
