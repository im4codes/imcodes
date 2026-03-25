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

/** Wire up a provider's callbacks to emit standard timeline events. */
export function wireProviderToRelay(provider: TransportProvider): void {
  provider.onDelta((sessionId: string, delta: MessageDelta) => {
    // Accumulate text and emit with stable eventId — ChatView replaces same-ID events
    let acc = accumulators.get(`${sessionId}:${delta.messageId}`);
    if (!acc) {
      acc = { messageId: delta.messageId, text: '' };
      accumulators.set(`${sessionId}:${delta.messageId}`, acc);
    }
    acc.text += delta.delta;

    // Emit with stable eventId so ChatView replaces the previous version (typewriter effect)
    const stableEventId = `transport:${sessionId}:${delta.messageId}`;
    timelineEmitter.emit(sessionId, 'assistant.text', {
      text: acc.text,
      streaming: true,
    }, { source: 'daemon', confidence: 'high', eventId: stableEventId });
  });

  provider.onComplete((sessionId: string, message: AgentMessage) => {
    const key = `${sessionId}:${message.id}`;
    const acc = accumulators.get(key);
    const finalText = acc?.text ?? message.content;
    accumulators.delete(key);

    // Replace the streaming event with final version (same eventId → in-place update in ChatView)
    const stableEventId = `transport:${sessionId}:${message.id}`;
    timelineEmitter.emit(sessionId, 'assistant.text', {
      text: finalText,
      streaming: false,
    }, { source: 'daemon', confidence: 'high', eventId: stableEventId });

    // Emit idle state
    timelineEmitter.emit(sessionId, 'session.state', {
      state: 'idle',
    }, { source: 'daemon', confidence: 'high' });

    // Cache final text for replay
    void appendTransportEvent(sessionId, {
      type: 'assistant.text',
      sessionId,
      text: finalText,
    });
  });

  provider.onError((sessionId: string, error: ProviderError) => {
    // Emit as session error — ChatView renders these
    timelineEmitter.emit(sessionId, 'session.state', {
      state: 'idle',
      error: error.message,
    }, { source: 'daemon', confidence: 'high' });

    // Cache for replay
    void appendTransportEvent(sessionId, {
      type: 'session.error',
      sessionId,
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

/** Broadcast provider status change to all browsers */
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
}
