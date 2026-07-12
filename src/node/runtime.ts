import WebSocket from 'ws';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { AuthenticatedWebSocketClient, type AuthenticatedWebSocketFactory } from '../transport/authenticated-websocket.js';
import { MachineExecWorker } from './machine-exec-worker.js';
import type { ControlledNodeCredential } from './enrollment.js';

export function controlledNodeWebSocketUrl(serverUrl: string, serverId: string): string {
  const url = new URL(`/api/server/${encodeURIComponent(serverId)}/ws`, serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function createControlledNodeRuntime(
  credential: ControlledNodeCredential,
  createSocket: AuthenticatedWebSocketFactory = (url) => new WebSocket(url),
): AuthenticatedWebSocketClient {
  const worker = new MachineExecWorker();
  let client!: AuthenticatedWebSocketClient;
  client = new AuthenticatedWebSocketClient({
    url: controlledNodeWebSocketUrl(credential.serverUrl, credential.serverId),
    // The node does NOT declare its own node_role as an authority claim; the
    // server derives the role from the DB (the frame value would be ignored).
    auth: { type: 'auth', serverId: credential.serverId, token: credential.token },
    heartbeatMessage: { type: 'heartbeat' },
    heartbeatMs: 5_000,
    silenceTimeoutMs: 30_000,
    createSocket,
    // On disconnect, abort any in-flight command (kills its process group).
    onClose: () => worker.abortAll(),
    onMessage: async (raw) => {
      let message: Record<string, unknown>;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type !== DAEMON_COMMAND_TYPES.MACHINE_EXEC) return;
      const reply = await worker.handle(message);
      if (reply) client.send({ type: DAEMON_MSG.MACHINE_EXEC_RESULT, ...reply });
    },
  });
  return client;
}
