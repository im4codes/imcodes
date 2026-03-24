/**
 * Relay TransportEvents from provider callbacks to the server-link WebSocket,
 * which forwards them to WsBridge for browser delivery.
 */
import type { TransportProvider, ProviderError } from '../agent/transport-provider.js';
import type { MessageDelta, AgentMessage } from '../../shared/agent-message.js';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '../../shared/transport-events.js';
import logger from '../util/logger.js';

let sendToServer: ((msg: Record<string, unknown>) => void) | null = null;

/** Set the send function (called once during server-link setup) */
export function setTransportRelaySend(fn: (msg: Record<string, unknown>) => void): void {
  sendToServer = fn;
}

/** Wire up a provider's callbacks to relay events to the server */
export function wireProviderToRelay(provider: TransportProvider): void {
  provider.onDelta((sessionId: string, delta: MessageDelta) => {
    sendToServer?.({
      type: TRANSPORT_EVENT.CHAT_DELTA,
      sessionId,
      messageId: delta.messageId,
      delta: delta.delta,
      deltaType: delta.type,
    });
  });

  provider.onComplete((sessionId: string, message: AgentMessage) => {
    sendToServer?.({
      type: TRANSPORT_EVENT.CHAT_COMPLETE,
      sessionId,
      messageId: message.id,
    });
  });

  provider.onError((sessionId: string, error: ProviderError) => {
    sendToServer?.({
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
    logger.debug({ providerId }, 'broadcastProviderStatus: no server link, skipping');
    return;
  }
  sendToServer({
    type: TRANSPORT_MSG.PROVIDER_STATUS,
    providerId,
    connected,
  });
}
