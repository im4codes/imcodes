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
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
  validateControlledFileTransferRequest,
  validateControlledFileTransferResponse,
} from '../../shared/transport/file-transfer.js';
import {
  handleFileDownload,
  handleFileDownloadStream,
  handleFileDirectoryList,
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
import { dispatchRemoteDesktopCommand } from './remote-desktop-dispatch.js';
import { isRemoteDesktopFeatureEnabled } from '../../shared/remote-desktop-feature.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_MSG,
} from '../../shared/remote-desktop-install.js';
import { CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY } from '../../shared/controlled-node-service.js';
import { cleanupLegacyWindowsUpgradeRescue } from './legacy-upgrade-rescue.js';
import {
  CONTROLLED_NODE_AUTO_UNLOCK_ACTION,
  CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY,
  CONTROLLED_NODE_AUTO_UNLOCK_ERROR,
  validateControlledNodeAutoUnlockCommand,
  type ControlledNodeAutoUnlockError,
} from '../../shared/controlled-node-auto-unlock.js';
import { incrementCounter } from '../util/metrics.js';
import logger from '../util/logger.js';

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
    applyAutoUnlockSecret(secret: string | null): Promise<boolean>;
    autoUnlockConfigured(): Promise<boolean>;
    close(): void;
  };
  cleanupLegacyUpgradeRescue?: () => Promise<void>;
  /**
   * First-install repair seam. The downloadable node executable is a single
   * file, so a freshly enrolled Windows node may initially have no native
   * worker beside it even when its main version already matches the Server.
   */
  repairMissingRemoteDesktopWorker?: (targetVersion: string) => ReturnType<typeof startControlledNodeSelfUpgrade>;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
}

const REMOTE_DESKTOP_WORKER_REPAIR_RETRY_MS = 5 * 60_000;
// Server-side version convergence is deliberately scheduled five seconds after
// authentication. Wait through that window before attempting a same-version
// repair so an actually stale node performs one atomic upgrade, not two.
const REMOTE_DESKTOP_WORKER_REPAIR_AUTH_GRACE_MS = 10_000;

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
  }, {
    onWorkerCrash: (crash) => {
      // A native fault would otherwise reach the browser as a bare
      // `worker_failed`, indistinguishable from an ordinary disconnect.
      incrementCounter('remote_desktop.worker_crash', {
        exception: `0x${crash.exceptionCode.toString(16)}`,
        module: crash.module,
      });
      logger.warn(
        {
          pid: crash.pid,
          exceptionCode: `0x${crash.exceptionCode.toString(16)}`,
          module: crash.module,
          moduleOffset: crash.moduleOffset,
        },
        'remote desktop worker crashed',
      );
    },
    onPrepareTimeout: () => {
      // No session/capability/desktop detail is logged. This exists to
      // distinguish a native pre-offer wedge from ordinary ICE negotiation
      // failures while the host recycles the authenticated worker.
      incrementCounter('remote_desktop.prepare_timeout');
      logger.warn('remote desktop worker did not complete prepare; recycling');
    },
    onOfferTimeout: () => {
      incrementCounter('remote_desktop.offer_timeout');
      logger.warn('remote desktop worker did not answer offer; recycling');
    },
  });
  const remoteDesktopFeatureEnabled = isRemoteDesktopFeatureEnabled(
    process.env.IMCODES_REMOTE_DESKTOP_ENABLED,
    process.env.NODE_ENV,
  );
  const remoteDesktopWorkerAvailable = remoteDesktopWorker.available();
  const remoteDesktopEnabled = remoteDesktopWorkerAvailable && remoteDesktopFeatureEnabled;
  const missingRemoteDesktopWorkerCanRepair = (options.platform ?? process.platform) === 'win32'
    && (options.arch ?? process.arch) === 'x64'
    && remoteDesktopFeatureEnabled
    && !remoteDesktopWorkerAvailable;
  let upgradeInFlight = false;
  let remoteDesktopWorkerRepairEligibleAt: number | null = null;
  let remoteDesktopWorkerRepairNextAttemptAt = 0;
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
  const repairMissingRemoteDesktopWorker = (force = false) => {
    if (!missingRemoteDesktopWorkerCanRepair || upgradeInFlight) return false;
    const now = options.now?.() ?? Date.now();
    if (!force && (remoteDesktopWorkerRepairEligibleAt === null
      || now < remoteDesktopWorkerRepairEligibleAt)) return false;
    if (!force && now < remoteDesktopWorkerRepairNextAttemptAt) return false;
    // Claim the shared upgrade gate synchronously so a simultaneous Server
    // version upgrade and this same-version repair cannot stage two tasks.
    upgradeInFlight = true;
    remoteDesktopWorkerRepairNextAttemptAt = now + REMOTE_DESKTOP_WORKER_REPAIR_RETRY_MS;
    const repair = options.repairMissingRemoteDesktopWorker
      ?? ((targetVersion: string) => startControlledNodeSelfUpgrade(credential, targetVersion));
    void repair(DAEMON_VERSION).then((result) => {
      if (result.ok) {
        client.send({
          type: DAEMON_MSG.UPGRADING,
          targetVersion: DAEMON_VERSION,
          ...(result.artifactSha256 ? { artifactSha256: result.artifactSha256 } : {}),
        });
        logger.info('staged same-version controlled-node repair for missing remote desktop worker');
        // Keep the gate claimed. The detached upgrade task replaces the
        // artifact set and restarts this process; clearing it here could admit
        // a second task during that handoff window.
        return;
      }
      upgradeInFlight = false;
      logger.warn({ reason: result.reason }, 'could not stage missing remote desktop worker repair');
    }, (error) => {
      upgradeInFlight = false;
      logger.warn({ err: error }, 'missing remote desktop worker repair failed; will retry');
    });
    return true;
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
        FILE_TRANSFER_DIRECTORY_CAPABILITY,
        MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
        MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
        CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY,
        // Auto unlock rides on the same worker: without it there is nothing
        // that can hold a secret or type at the sign-in desktop, so a node
        // that cannot run the worker must not offer the option at all.
        ...(remoteDesktopEnabled
          ? [REMOTE_DESKTOP_CAPABILITY, CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY]
          : []),
        ...(missingRemoteDesktopWorkerCanRepair
          ? [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]
          : []),
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
        if (remoteDesktopWorkerRepairEligibleAt === null) {
          remoteDesktopWorkerRepairEligibleAt = (options.now?.() ?? Date.now())
            + REMOTE_DESKTOP_WORKER_REPAIR_AUTH_GRACE_MS;
        }
        repairMissingRemoteDesktopWorker();
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
      if (message.type === REMOTE_DESKTOP_INSTALL_MSG.REQUEST) {
        // The request deliberately has no caller-controlled fields. Exactness
        // prevents this from becoming a generic upgrade endpoint.
        if (Object.keys(message).length === 1) repairMissingRemoteDesktopWorker(true);
        return;
      }
      if (isRemoteDesktopMessageType(message.type)) {
        await dispatchRemoteDesktopCommand({
          message,
          enabled: remoteDesktopEnabled,
          target: remoteDesktopWorker,
          send: (reply) => client.send(reply),
        });
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
        || message.type === FILE_TRANSFER_MSG.DIRECTORY_LIST
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
        } else if (parsed.value.type === FILE_TRANSFER_MSG.DIRECTORY_LIST) {
          await handleFileDirectoryList(parsed.value as unknown as Record<string, unknown>, fileSender);
        } else {
          await handleFilePathHandle(parsed.value as unknown as Record<string, unknown>, fileSender);
        }
        return;
      }
      if (message.type === DAEMON_COMMAND_TYPES.CONTROLLED_NODE_AUTO_UNLOCK) {
        const command = validateControlledNodeAutoUnlockCommand(
          message,
          DAEMON_COMMAND_TYPES.CONTROLLED_NODE_AUTO_UNLOCK,
        );
        if (!command) return;
        // The secret exists in this process only for the length of this call
        // and only to reach the worker's stdin; nothing here logs or keeps it.
        let ok = false;
        let error: ControlledNodeAutoUnlockError | undefined;
        try {
          if (!remoteDesktopWorker.available()) {
            error = CONTROLLED_NODE_AUTO_UNLOCK_ERROR.UNSUPPORTED_PLATFORM;
          } else {
            ok = await remoteDesktopWorker.applyAutoUnlockSecret(
              command.action === CONTROLLED_NODE_AUTO_UNLOCK_ACTION.SET
                ? command.secret ?? ''
                : null,
            );
            if (!ok) error = CONTROLLED_NODE_AUTO_UNLOCK_ERROR.STORE_FAILED;
          }
        } catch {
          error = CONTROLLED_NODE_AUTO_UNLOCK_ERROR.STORE_FAILED;
        }
        const configured = ok
          ? command.action === CONTROLLED_NODE_AUTO_UNLOCK_ACTION.SET
          : await remoteDesktopWorker.autoUnlockConfigured().catch(() => false);
        client.send({
          type: DAEMON_MSG.CONTROLLED_NODE_AUTO_UNLOCK_RESULT,
          requestId: command.requestId,
          ok,
          configured,
          ...(error === undefined ? {} : { error }),
        });
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
