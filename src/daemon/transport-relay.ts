/**
 * Relay TransportEvents from provider callbacks to the server-link WebSocket,
 * which forwards them to WsBridge for browser delivery.
 * Also writes events to local JSONL cache for replay on reconnect.
 */
import type { TransportProvider, ProviderError } from '../agent/transport-provider.js';
import type { MessageDelta, AgentMessage } from '../../shared/agent-message.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';
import { appendTransportEvent } from './transport-history.js';
import logger from '../util/logger.js';

let sendToServer: ((msg: Record<string, unknown>) => void) | null = null;

/** Set the send function (called once during server-link setup) */
export function setTransportRelaySend(fn: (msg: Record<string, unknown>) => void): void {
  sendToServer = fn;
}

/** Send to server + cache locally. */
function relayAndCache(sessionId: string, msg: Record<string, unknown>): void {
  sendToServer?.(msg);
  void appendTransportEvent(sessionId, msg);
}

/** Wire up a provider's callbacks to relay events to the server */
export function wireProviderToRelay(provider: TransportProvider): void {
  provider.onDelta((sessionId: string, delta: MessageDelta) => {
    relayAndCache(sessionId, {
      type: TRANSPORT_EVENT.CHAT_DELTA,
      sessionId,
      messageId: delta.messageId,
      delta: delta.delta,
      deltaType: delta.type,
    });
  });

  provider.onComplete((sessionId: string, message: AgentMessage) => {
    relayAndCache(sessionId, {
      type: TRANSPORT_EVENT.CHAT_COMPLETE,
      sessionId,
      messageId: message.id,
    });
  });

  provider.onError((sessionId: string, error: ProviderError) => {
    relayAndCache(sessionId, {
      type: TRANSPORT_EVENT.CHAT_ERROR,
      sessionId,
      error: error.message,
      code: error.code,
    });
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
