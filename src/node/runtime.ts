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
  hasRemoteDesktopIndependentRouteGeneration,
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
import {
  REMOTE_DESKTOP_ADAPTER_CAPABILITIES,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY,
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  REMOTE_DESKTOP_NODE_CONTEXT_MSG,
  REMOTE_DESKTOP_PRIVACY_MSG,
  REMOTE_DESKTOP_SHELL_MSG,
  REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
  validateRemoteDesktopNodeAuthorityContext,
  validateRemoteDesktopShellMessage,
  type RemoteDesktopAdapterCapability,
} from '../../shared/remote-desktop-access.js';
import {
  LocalRemoteDesktopConsentProvider,
} from '../daemon/remote-desktop-consent-provider.js';
import {
  RemoteDesktopPrivacyBarrier,
} from './remote-desktop-privacy-ipc.js';
import {
  WorkerConsentUi,
  type WorkerConsentInboundFrame,
} from './remote-desktop-consent-ipc.js';
import type { WorkerPrivacyInboundFrame } from './remote-desktop-privacy-ipc.js';
import {
  RemoteDesktopSignedShellController,
  type RemoteDesktopSignedShellLauncher,
} from './remote-desktop-shell-launch.js';

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
    /** Explicit adapter support; absence means no decision-11 capability. */
    adapterCapabilities?(): readonly RemoteDesktopAdapterCapability[];
    /**
     * Consent frames share the worker pipe but not the session authentication.
     * Optional so an injected double may omit them; a worker that cannot carry
     * them simply cannot ask, which fails closed at the provider.
     */
    sendConsentFrame?(frame: Record<string, unknown>): Promise<boolean> | boolean;
    sendPrivacyFrame?(frame: Record<string, unknown>): Promise<boolean> | boolean;
    onConsentFrame?(handler: (frame: WorkerConsentInboundFrame) => void): () => void;
    onPrivacyFrame?(handler: (frame: WorkerPrivacyInboundFrame) => void): () => void;
    /** Stronger than capture privacy; never infer it from that base marker. */
    supportsDefaultShieldedRoute?(): boolean;
    handle(message: RemoteDesktopDaemonCommand): Promise<boolean>;
    applyAutoUnlockSecret(secret: string | null): Promise<boolean>;
    autoUnlockConfigured(): Promise<boolean>;
    close(): void;
  };
  /**
   * Separately verified account-shell sidecar. Absence keeps the signed-shell
   * capability unadvertised even when the capture Worker is available.
   */
  remoteDesktopSignedShell?: {
    available(): boolean;
    executablePath: string;
    launcher: RemoteDesktopSignedShellLauncher;
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
  let declaredAdapterCapabilities: readonly RemoteDesktopAdapterCapability[] = [];
  try {
    declaredAdapterCapabilities = remoteDesktopWorker.adapterCapabilities?.() ?? [];
  } catch {
    // A broken feature probe cannot widen the node's advertisement.
  }
  const workerAdapterCapabilities = remoteDesktopEnabled
    ? [...new Set(declaredAdapterCapabilities)].filter((capability) => {
      if (!(REMOTE_DESKTOP_ADAPTER_CAPABILITIES as readonly string[]).includes(capability)) return false;
      if (capability === REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY) {
        return typeof remoteDesktopWorker.sendConsentFrame === 'function'
          && typeof remoteDesktopWorker.onConsentFrame === 'function';
      }
      if (capability === REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY) {
        return typeof remoteDesktopWorker.sendPrivacyFrame === 'function'
          && typeof remoteDesktopWorker.onPrivacyFrame === 'function';
      }
      return true;
    })
    : [];
  let defaultShieldedRouteAvailable = false;
  try {
    defaultShieldedRouteAvailable = remoteDesktopEnabled
      && workerAdapterCapabilities.includes(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY)
      && typeof remoteDesktopWorker.sendPrivacyFrame === 'function'
      && typeof remoteDesktopWorker.onPrivacyFrame === 'function'
      && (remoteDesktopWorker.supportsDefaultShieldedRoute?.() ?? false);
  } catch {
    // A broken stronger-capability probe may only disable transparent recovery.
  }
  let signedShellAvailable = false;
  try {
    signedShellAvailable = remoteDesktopEnabled
      && workerAdapterCapabilities.includes(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY)
      && defaultShieldedRouteAvailable
      && (options.remoteDesktopSignedShell?.available() ?? false);
  } catch {
    // Artifact/signature probes may only remove the local management surface.
  }
  const advertisedAdapterCapabilities = [
    ...workerAdapterCapabilities.filter((capability) => (
      capability !== REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY
    )),
    ...(signedShellAvailable ? [REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY] : []),
  ];
  const missingRemoteDesktopWorkerCanRepair = (options.platform ?? process.platform) === 'win32'
    && (options.arch ?? process.arch) === 'x64'
    && remoteDesktopFeatureEnabled
    && !remoteDesktopWorkerAvailable;
  let upgradeInFlight = false;
  // Attended consent. The UI lives in the signed worker, so the provider can
  // only ask while that worker is usable; `surfaceState()` re-probes per
  // request rather than trusting a value cached at startup.
  const consentUi = new WorkerConsentUi({
    // A worker double without a consent channel yields "cannot ask", which the
    // provider turns into a cancel -- never into an approval.
    send: (frame) => remoteDesktopWorker.sendConsentFrame?.(frame) ?? false,
    subscribe: (handler) => remoteDesktopWorker.onConsentFrame?.(handler) ?? (() => {}),
  }, { now: () => options.now?.() ?? Date.now() });
  // Authority is connection-generation bound: every reconnect invalidates the
  // approvals minted under the previous one.
  let authoritativeHostId = '';
  let daemonGeneration = -1;
  const consentProvider = new LocalRemoteDesktopConsentProvider({
    ui: consentUi,
    daemonGeneration: () => daemonGeneration,
    hostId: () => authoritativeHostId,
    now: () => options.now?.() ?? Date.now(),
    onTeardownFailure: (approvalId) => {
      // A prompt stuck on the local user's screen is its own hazard, even
      // though the decision it carried was already reported.
      incrementCounter('remote_desktop.consent_teardown_failed');
      logger.warn({ approvalId }, 'remote desktop consent prompt teardown failed');
    },
  });

  // Management privacy rides the SAME authenticated node channel as everything
  // else. No second credential or nonce: a barrier that needed its own secret
  // would just be one more thing to steal, and this channel is already the
  // authority boundary for every other privileged operation here.
  const privacyBarrier = new RemoteDesktopPrivacyBarrier({
    transport: {
      send: (frame) => remoteDesktopWorker.sendPrivacyFrame?.(frame) ?? false,
      subscribe: (handler) => remoteDesktopWorker.onPrivacyFrame?.(handler) ?? (() => {}),
    },
    // The endpoint credential identifies the authenticated transport, not the
    // canonical physical host. Privacy/consent both stay closed until the
    // Server supplies the current canonical context explicitly.
    hostId: () => authoritativeHostId,
    daemonGeneration: () => daemonGeneration,
    now: () => options.now?.() ?? Date.now(),
    // A replacement PREPARE follows BEGIN. Native re-emits its complete
    // actual route set after every route change; forward those later proofs so
    // the Server can compare against its durable authoritative snapshot.
    onShieldedUpdate: (ack) => client.send(ack as unknown as Record<string, unknown>),
    onRecoveryRequired: (reason) => {
      incrementCounter('remote_desktop.privacy_recovery_required', { reason });
      logger.warn({ reason }, 'remote desktop privacy recovery required');
    },
  });
  const signedShellController = signedShellAvailable && options.remoteDesktopSignedShell
    ? new RemoteDesktopSignedShellController({
      executablePath: options.remoteDesktopSignedShell.executablePath,
      serverOrigin: credential.serverUrl,
      launcher: options.remoteDesktopSignedShell.launcher,
      expectedContext: () => (
        authoritativeHostId && daemonGeneration >= 0
          ? { hostId: authoritativeHostId, endpointGeneration: daemonGeneration }
          : null
      ),
      now: () => options.now?.() ?? Date.now(),
      onRecoveryRequired: (reason) => {
        const epochId = privacyBarrier.activeEpochId();
        if (!epochId || !authoritativeHostId || daemonGeneration < 0) return;
        const recovery = validateRemoteDesktopShellMessage({
          type: REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED,
          hostId: authoritativeHostId,
          epochId,
          endpointGeneration: daemonGeneration,
          reason,
        });
        if (recovery.ok) client.send(recovery.value as unknown as Record<string, unknown>);
      },
    })
    : null;

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
        // Every decision-11 adapter feature is explicitly declared by the
        // verified implementation. The base capture capability never implies
        // consent, shell, privacy, input, lock-screen, brand or disclosure.
        ...advertisedAdapterCapabilities,
        ...(defaultShieldedRouteAvailable
          ? [REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY]
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
      // Every open prompt dies with the authority it would have been granted
      // under; a reconnect mints a new generation.
      privacyBarrier.onDaemonDisconnected();
      signedShellController?.markLogoutUncertain();
      void signedShellController?.terminate().catch(() => {});
      authoritativeHostId = '';
      daemonGeneration = -1;
      void consentProvider.cancelAll('daemon_generation_changed');
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
      const nodeContext = validateRemoteDesktopNodeAuthorityContext(message);
      if (nodeContext.ok) {
        if (nodeContext.value.type === REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE) {
          const replaced = authoritativeHostId !== ''
            || daemonGeneration !== nodeContext.value.daemonGeneration;
          authoritativeHostId = '';
          daemonGeneration = nodeContext.value.daemonGeneration;
          if (replaced) void consentProvider.cancelAll('daemon_generation_changed');
          return;
        }
        const replaced = authoritativeHostId !== nodeContext.value.hostId
          || daemonGeneration !== nodeContext.value.daemonGeneration;
        authoritativeHostId = nodeContext.value.hostId;
        daemonGeneration = nodeContext.value.daemonGeneration;
        if (replaced) {
          // A context replacement invalidates every prompt opened under the
          // previous canonical host or Server connection generation.
          void consentProvider.cancelAll('daemon_generation_changed');
          // Bootstrap carries only the canonical host and public HTTPS origin.
          // It grants no management authority; after native Owner sign-in the
          // Server dispatches the real one-use context over this node channel.
          void signedShellController?.startBootstrap().catch(() => {});
        }
        return;
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
      if (message.type === REMOTE_DESKTOP_PRIVACY_MSG.BEGIN
        || message.type === REMOTE_DESKTOP_PRIVACY_MSG.END) {
        // Only the management privacy frame is forwarded, and only after the
        // shared validator has proven it carries no account session, token or
        // password -- exact-key validation rejects an implementation that
        // tries to attach one rather than trusting and logging it.
        const ack = message.type === REMOTE_DESKTOP_PRIVACY_MSG.BEGIN
          ? await privacyBarrier.begin(message)
          : await privacyBarrier.end(message);
        // No ack means the barrier could not be proven. Staying silent lets
        // the Server's own deadline fail the epoch closed; inventing an ack
        // would enable secret UI over unshielded pixels.
        if (ack) client.send(ack as unknown as Record<string, unknown>);
        return;
      }
      if (message.type === REMOTE_DESKTOP_SHELL_MSG.LAUNCH
        || message.type === REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED) {
        const shellMessage = validateRemoteDesktopShellMessage(message);
        if (shellMessage.ok
          && shellMessage.value.type === REMOTE_DESKTOP_SHELL_MSG.LAUNCH
          && signedShellController
          && advertisedAdapterCapabilities.includes(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY)) {
          await signedShellController.start(shellMessage.value.context);
        }
        return;
      }
      if (message.type === REMOTE_DESKTOP_CONSENT_MSG.REQUEST) {
        // The provider validates the payload again itself; this branch only
        // decides who answers. Its reply is always a result or an enumerated
        // cancel, so the Server never waits on silence.
        const outcome = await consentProvider.request(message);
        client.send(outcome as unknown as Record<string, unknown>);
        return;
      }
      if (message.type === REMOTE_DESKTOP_CONSENT_MSG.CANCEL) {
        const approvalId = typeof message.approvalId === 'string' ? message.approvalId : '';
        const reason = typeof message.reason === 'string' ? message.reason : '';
        if (approvalId && reason) {
          await consentProvider.cancelPending(approvalId, reason as never);
        }
        return;
      }
      if (isRemoteDesktopMessageType(message.type)) {
        const requiresIndependentRouteGeneration = remoteDesktopEnabled
          && advertisedAdapterCapabilities.includes(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY)
          && (message.type === REMOTE_DESKTOP_MSG.PREPARE || message.type === REMOTE_DESKTOP_MSG.LEASE);
        if (requiresIndependentRouteGeneration
          && !hasRemoteDesktopIndependentRouteGeneration(message)) {
          const messageWithoutRouteGeneration = { ...message };
          delete messageWithoutRouteGeneration.routeGeneration;
          const legacyParsed = validateRemoteDesktopDaemonCommand(messageWithoutRouteGeneration);
          if (legacyParsed.ok
            && (legacyParsed.value.type === REMOTE_DESKTOP_MSG.PREPARE
              || legacyParsed.value.type === REMOTE_DESKTOP_MSG.LEASE)) {
            client.send({
              type: REMOTE_DESKTOP_MSG.TERMINAL,
              requestId: legacyParsed.value.requestId,
              sessionId: legacyParsed.value.sessionId,
              capability: legacyParsed.value.capability,
              reason: REMOTE_DESKTOP_TERMINAL_REASON.CAPABILITY_UNAVAILABLE,
            });
          }
          return;
        }
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
