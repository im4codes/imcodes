import WebSocket from 'ws';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';
import { DAEMON_VERSION } from '../util/version.js';
import { AuthenticatedWebSocketClient, type AuthenticatedWebSocketFactory } from '../transport/authenticated-websocket.js';
import { MachineExecWorker } from './machine-exec-worker.js';
import { ComputerUseWorker } from './computer-use-worker.js';
import { startControlledNodeSelfUpgrade } from './self-upgrade.js';
import type { ControlledNodeCredential } from './enrollment.js';
import {
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
  validateControlledFileTransferRequest,
  validateControlledFileTransferResponse,
} from '../../shared/transport/file-transfer.js';
import {
  handleFileDownload,
  handleFileDownloadStream,
  handleFilePathHandle,
  handleFileUploadFetch,
  handleFileDelete,
  type FileTransferSender,
} from '../daemon/file-transfer-handler.js';
import {
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_ERROR,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
  refreshMachineDirectUploadAuthority,
  refreshMachineDirectFetchAuthority,
  validateMachineDirectFetchRequest,
  validateMachineDirectUploadRequest,
} from '../../shared/machine-direct-file-transfer.js';
import { receiveMachineDirectUpload, sendMachineDirectFetch } from '../daemon/machine-direct-transfer.js';
import {
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  isRemoteDesktopMessageType,
  validateRemoteDesktopDaemonCommand,
  type RemoteDesktopDaemonCommand,
} from '../../shared/remote-desktop.js';
import { RemoteDesktopWorkerHost } from './remote-desktop-worker-host.js';
import { isRemoteDesktopFeatureEnabled } from '../../shared/remote-desktop-feature.js';
import { CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY } from '../../shared/controlled-node-service.js';
import { cleanupLegacyWindowsUpgradeRescue } from './legacy-upgrade-rescue.js';

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
  /** Called for every authenticated server heartbeat acknowledgement. */
  onHeartbeatAck?: () => void | Promise<void>;
  remoteDesktopWorker?: {
    available(): boolean;
    handle(message: RemoteDesktopDaemonCommand): Promise<boolean>;
    close(): void;
  };
  cleanupLegacyUpgradeRescue?: () => Promise<void>;
}

export function createControlledNodeRuntime(
  credential: ControlledNodeCredential,
  createSocket: AuthenticatedWebSocketFactory = (url) => new WebSocket(url),
  options: ControlledNodeRuntimeOptions = {},
): AuthenticatedWebSocketClient {
  const worker = new MachineExecWorker();
  const computerUseWorker = new ComputerUseWorker(credential);
  let client!: AuthenticatedWebSocketClient;
  const remoteDesktopWorker = options.remoteDesktopWorker ?? new RemoteDesktopWorkerHost((message) => {
    client.send(message);
  });
  const remoteDesktopEnabled = remoteDesktopWorker.available()
    && isRemoteDesktopFeatureEnabled(
      process.env.IMCODES_REMOTE_DESKTOP_ENABLED,
      process.env.NODE_ENV,
    );
  let upgradeInFlight = false;
  let authenticationPersisted = false;
  let authenticationPersistenceInFlight = false;
  let legacyUpgradeRescueCleanupStarted = false;
  const activeMachineDirectTransfers = new Set<string>();
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
  const fileSender: FileTransferSender = {
    send(message: unknown): boolean {
      let candidate = message;
      const raw = message && typeof message === 'object' && !Array.isArray(message)
        ? message as Record<string, unknown>
        : null;
      const checked = validateControlledFileTransferResponse(candidate);
      if (!checked.ok && raw?.type === 'file.upload_error' && typeof raw.uploadId === 'string') {
        candidate = { type: 'file.upload_error', uploadId: raw.uploadId, message: 'upload_failed' };
      } else if (!checked.ok && raw?.type === 'file.download_error' && typeof raw.downloadId === 'string') {
        candidate = { type: 'file.download_error', downloadId: raw.downloadId, message: 'download_failed' };
      }
      const normalized = validateControlledFileTransferResponse(candidate);
      return normalized.ok ? client.send(normalized.value) : false;
    },
  };
  client = new AuthenticatedWebSocketClient({
    url: controlledNodeWebSocketUrl(credential.serverUrl, credential.serverId),
    auth: {
      type: 'auth',
      serverId: credential.serverId,
      token: credential.token,
      daemonVersion: DAEMON_VERSION,
      capabilities: [
        FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
        FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
        FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
        MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
        MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
        CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY,
        ...(remoteDesktopEnabled ? [REMOTE_DESKTOP_CAPABILITY] : []),
      ],
    },
    heartbeatMessage: { type: 'heartbeat', daemonVersion: DAEMON_VERSION },
    heartbeatMs: 5_000,
    silenceTimeoutMs: 30_000,
    createSocket,
    onOpen: () => {
      client.send({ type: 'heartbeat', daemonVersion: DAEMON_VERSION });
    },
    onClose: () => {
      worker.abortAll();
      // Remote desktop authority is connection-generation-bound. Unlike the
      // warm Computer Use helper, every peer must die on Server-link loss.
      remoteDesktopWorker.close();
      // Keep Computer Use warm across daemon websocket reconnects. The helper owns
      // long-lived OCU/MCP and fast-click subprocesses after first use; closing it
      // here would make every transient network reconnect pay the cold-start cost.
    },
    onMessage: async (raw) => {
      let message: Record<string, unknown>;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      if (isControlledNodeAuthAck(message)) {
        persistAuthentication();
        try {
          void Promise.resolve(options.onHeartbeatAck?.()).then(async () => {
            if (legacyUpgradeRescueCleanupStarted) return;
            legacyUpgradeRescueCleanupStarted = true;
            try {
              await (options.cleanupLegacyUpgradeRescue ?? cleanupLegacyWindowsUpgradeRescue)();
            } catch (error) {
              legacyUpgradeRescueCleanupStarted = false;
              throw error;
            }
          }).catch(reportAuthenticationError);
        } catch (error) {
          reportAuthenticationError(error);
        }
      }
      if (message.type === DAEMON_COMMAND_TYPES.DAEMON_UPGRADE) {
        if (upgradeInFlight) {
          client.send({
            type: DAEMON_MSG.UPGRADE_BLOCKED,
            reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS,
          });
          return;
        }
        upgradeInFlight = true;
        const targetVersion = message.targetVersion;
        void startControlledNodeSelfUpgrade(credential, targetVersion).then((result) => {
          if (result.ok) {
            client.send({ type: DAEMON_MSG.UPGRADING, targetVersion: result.targetVersion, artifactSha256: result.artifactSha256 });
            return;
          }
          upgradeInFlight = false;
          client.send({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: result.reason ?? 'controlled_node_upgrade_failed' });
        }, (error) => {
          upgradeInFlight = false;
          client.send({
            type: DAEMON_MSG.UPGRADE_BLOCKED,
            reason: error instanceof Error ? error.message : 'controlled_node_upgrade_failed',
          });
        });
        return;
      }
      if (message.type === DAEMON_COMMAND_TYPES.COMPUTER_USE) {
        const reply = await computerUseWorker.handle(message);
        if (reply) client.send({ type: DAEMON_MSG.COMPUTER_USE_RESULT, ...reply });
        return;
      }
      if (isRemoteDesktopMessageType(message.type)) {
        const parsed = validateRemoteDesktopDaemonCommand(message);
        if (!parsed.ok) return;
        if (!remoteDesktopEnabled) {
          if (parsed.value.type !== REMOTE_DESKTOP_MSG.STOP
            && parsed.value.type !== REMOTE_DESKTOP_MSG.CANCEL) {
            client.send({
              type: REMOTE_DESKTOP_MSG.TERMINAL,
              requestId: parsed.value.requestId,
              sessionId: parsed.value.sessionId,
              capability: parsed.value.capability,
              reason: REMOTE_DESKTOP_TERMINAL_REASON.CAPABILITY_UNAVAILABLE,
            });
          }
          return;
        }
        try {
          if (await remoteDesktopWorker.handle(parsed.value)) return;
        } catch {
          // Fall through to a bounded terminal frame. The worker never receives
          // the long-lived node credential and no error detail is reflected.
        }
        if (parsed.value.type !== REMOTE_DESKTOP_MSG.STOP
          && parsed.value.type !== REMOTE_DESKTOP_MSG.CANCEL) {
          client.send({
            type: REMOTE_DESKTOP_MSG.TERMINAL,
            requestId: parsed.value.requestId,
            sessionId: parsed.value.sessionId,
            capability: parsed.value.capability,
            reason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
          });
        }
        return;
      }
      if (message.type === MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST) {
        const parsed = validateMachineDirectUploadRequest(message);
        if (!parsed.ok) return;
        if (activeMachineDirectTransfers.size >= MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_CONCURRENT_RECEIVERS
          || activeMachineDirectTransfers.has(parsed.value.requestId)) {
          client.send({
            type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
            requestId: parsed.value.requestId,
            error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.TRANSFER_FAILED,
          });
          return;
        }
        activeMachineDirectTransfers.add(parsed.value.requestId);
        try {
          // This authenticated Server message is fresh. Re-mint the deadline
          // from the controlled node's clock so Server/target skew cannot turn
          // a valid direct request into an EXPIRED fallback.
          client.send(await receiveMachineDirectUpload(refreshMachineDirectUploadAuthority(parsed.value)));
        } finally {
          activeMachineDirectTransfers.delete(parsed.value.requestId);
        }
        return;
      }
      if (message.type === MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST) {
        const parsed = validateMachineDirectFetchRequest(message);
        if (!parsed.ok) return;
        if (activeMachineDirectTransfers.size >= MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_CONCURRENT_RECEIVERS
          || activeMachineDirectTransfers.has(parsed.value.requestId)) {
          client.send({
            type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_ERROR,
            requestId: parsed.value.requestId,
            error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.TRANSFER_FAILED,
          });
          return;
        }
        activeMachineDirectTransfers.add(parsed.value.requestId);
        try {
          client.send(await sendMachineDirectFetch(refreshMachineDirectFetchAuthority(parsed.value)));
        } finally {
          activeMachineDirectTransfers.delete(parsed.value.requestId);
        }
        return;
      }
      if (message.type === 'file.upload_fetch'
        || message.type === 'file.download'
        || message.type === FILE_TRANSFER_MSG.DOWNLOAD_STREAM
        || message.type === FILE_TRANSFER_MSG.PATH_HANDLE
        || message.type === FILE_TRANSFER_MSG.DELETE) {
        const parsed = validateControlledFileTransferRequest(message);
        if (!parsed.ok) return;
        const relayUrl = parsed.value.type === 'file.upload_fetch'
          ? parsed.value.downloadUrl
          : parsed.value.type === FILE_TRANSFER_MSG.DOWNLOAD_STREAM
            ? parsed.value.uploadUrl
            : undefined;
        if (relayUrl) {
          try {
            if (new URL(relayUrl).origin !== new URL(credential.serverUrl).origin) return;
          } catch {
            return;
          }
        }
        if (parsed.value.type === 'file.upload_fetch') {
          await handleFileUploadFetch(parsed.value as unknown as Record<string, unknown>, fileSender);
        } else if (parsed.value.type === 'file.download') {
          await handleFileDownload(parsed.value as unknown as Record<string, unknown>, fileSender);
        } else if (parsed.value.type === FILE_TRANSFER_MSG.DOWNLOAD_STREAM) {
          await handleFileDownloadStream(parsed.value as unknown as Record<string, unknown>, fileSender);
        } else if (parsed.value.type === FILE_TRANSFER_MSG.DELETE) {
          await handleFileDelete(parsed.value as unknown as Record<string, unknown>, fileSender);
        } else {
          await handleFilePathHandle(parsed.value as unknown as Record<string, unknown>, fileSender);
        }
        return;
      }
      if (message.type !== DAEMON_COMMAND_TYPES.MACHINE_EXEC) return;
      const correlationId = typeof message.correlationId === 'string' ? message.correlationId : '';
      const reply = await worker.handle(message, (chunk) => {
        if (!correlationId) return;
        client.send({ type: DAEMON_MSG.MACHINE_EXEC_CHUNK, correlationId, ...chunk });
      });
      if (reply) client.send({ type: DAEMON_MSG.MACHINE_EXEC_RESULT, ...reply });
    },
  });
  return client;
}
