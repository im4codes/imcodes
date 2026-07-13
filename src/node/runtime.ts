import WebSocket from 'ws';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { AuthenticatedWebSocketClient, type AuthenticatedWebSocketFactory } from '../transport/authenticated-websocket.js';
import { MachineExecWorker } from './machine-exec-worker.js';
import type { ControlledNodeCredential } from './enrollment.js';

/** Server → controlled node: auth succeeded; connection is live (bridge.ts heartbeat path). */
const CONTROLLED_NODE_AUTH_ACK_TYPE = 'heartbeat_ack' as const;

export function controlledNodeWebSocketUrl(serverUrl: string, serverId: string): string {
  const url = new URL(`/api/server/${encodeURIComponent(serverId)}/ws`, serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function isControlledNodeAuthAck(message: Record<string, unknown>): boolean {
  return message.type === CONTROLLED_NODE_AUTH_ACK_TYPE;
}

export interface ControlledNodeRuntimeOptions {
  onAuthenticated?: () => void | Promise<void>;
  onAuthenticationError?: (error: unknown) => void;
}

export function createControlledNodeRuntime(
  credential: ControlledNodeCredential,
  createSocket: AuthenticatedWebSocketFactory = (url) => new WebSocket(url),
  options: ControlledNodeRuntimeOptions = {},
): AuthenticatedWebSocketClient {
  const worker = new MachineExecWorker();
  let authenticationPersisted = false;
  let authenticationPersistenceInFlight = false;
  const reportAuthenticationError = (error: unknown) => {
    try {
      options.onAuthenticationError?.(error);
    } catch {
      // Error reporting must not strand the retry gate or create a rejection.
    }
  };
  const persistAuthentication = () => {
    if (authenticationPersisted || authenticationPersistenceInFlight) return;
    authenticationPersistenceInFlight = true;
    let result: void | Promise<void>;
    try {
      result = options.onAuthenticated?.();
    } catch (error) {
      authenticationPersistenceInFlight = false;
      reportAuthenticationError(error);
      return;
    }
    void Promise.resolve(result).then(
      () => { authenticationPersisted = true; },
      reportAuthenticationError,
    ).finally(() => {
      authenticationPersistenceInFlight = false;
    });
  };
  let client!: AuthenticatedWebSocketClient;
  client = new AuthenticatedWebSocketClient({
    url: controlledNodeWebSocketUrl(credential.serverUrl, credential.serverId),
    auth: { type: 'auth', serverId: credential.serverId, token: credential.token },
    heartbeatMessage: { type: 'heartbeat' },
    heartbeatMs: 5_000,
    silenceTimeoutMs: 30_000,
    createSocket,
    onOpen: () => {
      client.send({ type: 'heartbeat' });
    },
    onClose: () => worker.abortAll(),
    onMessage: async (raw) => {
      let message: Record<string, unknown>;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      if (isControlledNodeAuthAck(message)) persistAuthentication();
      if (message.type !== DAEMON_COMMAND_TYPES.MACHINE_EXEC) return;
      const reply = await worker.handle(message);
      if (reply) client.send({ type: DAEMON_MSG.MACHINE_EXEC_RESULT, ...reply });
    },
  });
  return client;
}
