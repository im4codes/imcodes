import { MSG_COMMAND_ACK } from '@shared/ack-protocol.js';
import { DAEMON_COMMAND_TYPES } from '@shared/daemon-command-types.js';
import type { WsClient } from './ws-client.js';

export const SESSION_IDENTITY_REFRESH_TIMEOUT_MS = 10_000;

function createCommandId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `identity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Resolve only after the daemon has fetched the saved profiles and applied the
 * effective identity to its live session runtimes. Saving the HTTP profile is
 * not enough: an older daemon or a concurrent periodic sync may otherwise
 * leave a newly sent turn using the previous identity for up to one minute.
 */
export function requestSessionIdentityRefresh(
  ws: Pick<WsClient, 'send' | 'onMessage'>,
  sessionName: string,
  timeoutMs = SESSION_IDENTITY_REFRESH_TIMEOUT_MS,
): Promise<void> {
  const commandId = createCommandId();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error('The daemon did not confirm the identity refresh in time.'));
    }, timeoutMs);
    unsubscribe = ws.onMessage((message) => {
      if (message.type !== MSG_COMMAND_ACK || message.commandId !== commandId || message.session !== sessionName) return;
      if (message.status === 'error') {
        finish(new Error(message.error || 'The daemon could not apply the identity.'));
        return;
      }
      finish();
    });
    try {
      ws.send({
        type: DAEMON_COMMAND_TYPES.SESSION_IDENTITY_REFRESH,
        sessionName,
        commandId,
      });
    } catch (reason) {
      finish(reason instanceof Error ? reason : new Error(String(reason)));
    }
  });
}
