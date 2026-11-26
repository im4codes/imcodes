import { sendSessionViaHttp } from './api.js';
import type { WsClient } from './ws-client.js';

export type SessionSendClient = Pick<WsClient, 'sendSessionCommand'>
  & Partial<Pick<WsClient, 'sendSessionCommandUrgent'>>;

/**
 * Send a `session.send` command over the active WebSocket using the urgent
 * path (`readyState === WebSocket.OPEN`) so probing or disconnected sockets
 * throw instead of silently dropping the frame, falling back to the HTTP
 * send endpoint whenever `serverId` is available.
 */
export function dispatchSessionSend(
  ws: SessionSendClient | null | undefined,
  serverId: string | null | undefined,
  payload: Record<string, unknown>,
  onHttpFailure?: (err: unknown) => void,
): 'ws' | 'http' {
  if (ws) {
    try {
      if (typeof ws.sendSessionCommandUrgent === 'function') {
        ws.sendSessionCommandUrgent('send', payload);
      } else {
        ws.sendSessionCommand('send', payload);
      }
      return 'ws';
    } catch (err) {
      if (!serverId) throw err;
      void sendSessionViaHttp(serverId, payload).catch((httpErr) => {
        onHttpFailure?.(httpErr);
      });
      return 'http';
    }
  }
  if (!serverId) {
    throw new Error('WebSocket not connected');
  }
  void sendSessionViaHttp(serverId, payload).catch((httpErr) => {
    onHttpFailure?.(httpErr);
  });
  return 'http';
}
