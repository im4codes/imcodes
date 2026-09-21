import WebSocket from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROLLED_NODE_OS_MAC } from '../../shared/controlled-node-artifacts.js';
import { CONTROLLED_NODE_LOCAL_DAEMONS_RESCAN_MS } from '../../shared/controlled-node-host-link.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';
import { DAEMON_VERSION } from '../util/version.js';
import {
  AuthenticatedWebSocketClient,
  type AuthenticatedWebSocketFactory,
  type AuthenticatedWebSocketOptions,
} from '../transport/authenticated-websocket.js';
import { discoverLocalDaemonServerIds } from './local-daemon-discovery.js';
import { MachineExecWorker } from './machine-exec-worker.js';
import { ComputerUseWorker } from './computer-use-worker.js';
import {
  downloadControlledNodeMacosRemoteDesktopComponentSet,
  startControlledNodeSelfUpgrade,
} from './self-upgrade.js';
import { promoteMacosRemoteDesktopArtifact, selectMacosRemoteDesktopArtifact } from './macos-remote-desktop-artifact.js';
import { defaultMacosRemoteDesktopArtifactStoreRoot } from './macos-remote-desktop-production.js';
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
  handleMacosOpenFullDiskAccess,
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
  type RemoteDesktopDaemonMessage,
} from '../../shared/remote-desktop.js';
import {
  RemoteDesktopWorkerHost,
  type RemoteDesktopWorkerHostOptions,
} from './remote-desktop-worker-host.js';
import {
  MacosRemoteDesktopWorkerHost,
  type MacosRemoteDesktopWorkerHostOptions,
} from './macos-remote-desktop-worker-host.js';
import { LinuxRemoteDesktopWorkerHost } from './linux-remote-desktop-worker-host.js';
import {
  REMOTE_DESKTOP_SESSION_PROFILE_CAPABILITIES,
  resolveRemoteDesktopSessionProfile,
} from '../../shared/remote-desktop-platform.js';
import { dispatchRemoteDesktopCommand } from './remote-desktop-dispatch.js';
import { isRemoteDesktopFeatureEnabled } from '../../shared/remote-desktop-feature.js';
import { REMOTE_DESKTOP_LOCAL_MANAGEMENT, type RemoteDesktopLocalConnection } from '../../shared/remote-desktop-local-management.js';
import { CLOCK_SYNC_FIELD, ServerClockEstimator } from '../../shared/clock-sync.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
} from '../../shared/remote-desktop-platform.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_PERMISSION_MSG,
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
  REMOTE_DESKTOP_RELAY_CAP_CAPABILITY,
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
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
import { refreshX11DisplayProbe, x11DisplayProbeIsStale } from './linux-x11-display.js';
import {
  linuxDesktopProvisionSupported,
  linuxGraphicalDisplayAvailable,
  provisionLinuxDesktopEnvironment,
  type LinuxDesktopProvisionResult,
} from './linux-desktop-environment.js';
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

/**
 * Rewrite the absolute Server times a remote-desktop command carries onto the
 * local clock. Only the two authority deadlines; everything else is untouched,
 * and without a clock sample nothing changes.
 */
export function translateServerDeadlines<T extends Record<string, unknown>>(
  message: T,
  clock: Pick<ServerClockEstimator, 'synchronized' | 'serverToLocal'>,
): T {
  if (!clock.synchronized) return message;
  let translated: Record<string, unknown> | null = null;
  for (const key of ['expiresAt', 'leaseExpiresAt'] as const) {
    const value = message[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue;
    translated ??= { ...message };
    translated[key] = clock.serverToLocal(value);
  }
  return (translated ?? message) as T;
}

export function isControlledNodeAuthAck(message: Record<string, unknown>): boolean {
  return message.type === CONTROLLED_NODE_AUTH_ACK_TYPE;
}

export interface ControlledNodeRemoteDesktopWorker {
  available(): boolean;
  sessionCapabilities?(): readonly string[];
  adapterCapabilities?(): readonly RemoteDesktopAdapterCapability[];
  sendConsentFrame?(frame: Record<string, unknown>): Promise<boolean> | boolean;
  sendPrivacyFrame?(frame: Record<string, unknown>): Promise<boolean> | boolean;
  onConsentFrame?(handler: (frame: WorkerConsentInboundFrame) => void): () => void;
  onPrivacyFrame?(handler: (frame: WorkerPrivacyInboundFrame) => void): () => void;
  supportsDefaultShieldedRoute?(): boolean;
  handle(message: RemoteDesktopDaemonCommand): Promise<boolean>;
  activeConnections?(): readonly RemoteDesktopLocalConnection[];
  stopConnection?(publicId: string): Promise<boolean>;
  stopAllConnections?(): Promise<void>;
  setAccessPaused?(paused: boolean): Promise<void> | void;
  applyAutoUnlockSecret?(secret: string | null): Promise<boolean>;
  /** macOS: whether this host has somewhere to keep a sign-in secret. */
  supportsAutoUnlock?(): boolean;
  autoUnlockConfigured?(): Promise<boolean>;
  /** Retire connection-scoped routes while keeping a verified sidecar warm. */
  onDaemonDisconnected?(): void;
  close(): void;
}

export interface PlatformRemoteDesktopWorkerSelection {
  worker: ControlledNodeRemoteDesktopWorker;
  /** Only macOS needs an authenticated GUI-sidecar before capability sampling. */
  startup?: () => Promise<void>;
}

class UnavailableRemoteDesktopWorkerHost implements ControlledNodeRemoteDesktopWorker {
  available(): boolean { return false; }
  sessionCapabilities(): readonly string[] { return []; }
  adapterCapabilities(): readonly RemoteDesktopAdapterCapability[] { return []; }
  async handle(): Promise<boolean> { return false; }
  activeConnections(): readonly RemoteDesktopLocalConnection[] { return []; }
  async stopConnection(): Promise<boolean> { return false; }
  async stopAllConnections(): Promise<void> {}
  close(): void {}
}

/**
 * Platform-discriminated production boundary. macOS is selectable only when
 * the caller supplies native peer-identity/readiness dependencies; without
 * those non-inferable proofs the daemon remains unavailable rather than
 * falling back to the Windows host.
 */
export function createPlatformRemoteDesktopWorkerHost(input: {
  platform: NodeJS.Platform;
  arch: string;
  onMessage(message: RemoteDesktopDaemonMessage): void;
  windows?: RemoteDesktopWorkerHostOptions;
  macos?: MacosRemoteDesktopWorkerHostOptions;
}): PlatformRemoteDesktopWorkerSelection {
  if (input.platform === 'win32') {
    const worker = new RemoteDesktopWorkerHost(input.onMessage, input.windows);
    return worker.available()
      ? { worker, startup: () => worker.start() }
      : { worker };
  }
  if (input.platform === 'darwin'
    && (input.arch === 'arm64' || input.arch === 'x64')
    && input.macos) {
    const worker = new MacosRemoteDesktopWorkerHost(input.onMessage, {
      ...input.macos,
      runtime: { platform: input.platform, arch: input.arch },
    });
    return { worker, startup: () => worker.start() };
  }
  if (input.platform === 'linux' && input.arch === 'x64') {
    const worker = new LinuxRemoteDesktopWorkerHost(input.onMessage);
    return worker.available()
      ? { worker, startup: () => worker.start() }
      : { worker };
  }
  return { worker: new UnavailableRemoteDesktopWorkerHost() };
}

class StartupGatedAuthenticatedWebSocketClient extends AuthenticatedWebSocketClient {
  private startRequested = false;
  private cancelled = false;

  constructor(
    options: AuthenticatedWebSocketOptions,
    private readonly prepare: () => Promise<void>,
    private readonly onCancelled: () => void,
  ) {
    super(options);
  }

  override start(): void {
    if (this.startRequested || this.cancelled) return;
    this.startRequested = true;
    const connect = (): void => {
      if (!this.cancelled) super.start();
    };
    void this.prepare().then(connect, connect);
  }

  override stop(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.onCancelled();
    super.stop();
  }
}

class FinalizingAuthenticatedWebSocketClient extends AuthenticatedWebSocketClient {
  private finalized = false;

  constructor(
    options: AuthenticatedWebSocketOptions,
    private readonly finalize: () => void,
  ) {
    super(options);
  }

  override stop(): void {
    if (!this.finalized) {
      this.finalized = true;
      this.finalize();
    }
    super.stop();
  }
}

export interface ControlledNodeRuntimeOptions {
  /**
   * Injected so the install path can be exercised without a server, a notary
   * and four signed binaries. The default implementation downloads this
   * release's component set and promotes it.
   */
  installMacosRemoteDesktopComponents?: () => Promise<boolean>;
  /** Test seam: the Server clock estimate used to translate deadlines. */
  serverClock?: ServerClockEstimator;
  /** Test seam: whether the store already holds a verified set for this release. */
  macosRemoteDesktopComponentsInstalled?: () => Promise<boolean>;
  /** Injected for the same reason: raising a real TCC prompt needs a real Mac. */
  requestMacosRemoteDesktopPermissions?: () => Promise<boolean>;
  onAuthenticated?: () => void | Promise<void>;
  onAuthenticationError?: (error: unknown) => void;
  /** Called for every authenticated server heartbeat acknowledgement. */
  onHeartbeatAck?: () => void | Promise<void>;
  /**
   * Test seam: the daemons bound on this computer (serverIds only). Defaults to
   * reading each user's `.imcodes/server.json`; see local-daemon-discovery.ts.
   */
  discoverLocalDaemons?: () => Promise<string[]>;
  remoteDesktopWorker?: ControlledNodeRemoteDesktopWorker;
  /**
   * Native macOS production dependencies. Omission is deliberately unavailable:
   * uid/code-signing/TCC/disclosure evidence cannot be inferred in TypeScript.
  */
  macosRemoteDesktopWorker?: MacosRemoteDesktopWorkerHostOptions;
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
  /** Test seam for a Linux box with no graphical session (see linux-desktop-environment.ts). */
  linuxDesktop?: {
    displayAvailable(): boolean;
    provisionSupported(): boolean;
    provision(): Promise<LinuxDesktopProvisionResult>;
  };
  /** Test seam for the normal Server-requested upgrade path. */
  startSelfUpgrade?: typeof startControlledNodeSelfUpgrade;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  /** Persisted before construction; the runtime owns enforcement, not storage. */
  remoteDesktopAccessPaused?: boolean;
}

export interface ControlledNodeRuntimeClient extends AuthenticatedWebSocketClient {
  remoteDesktopAccessStatus(): { paused: boolean; connections: readonly RemoteDesktopLocalConnection[] };
  setRemoteDesktopAccessPaused(paused: boolean): Promise<void>;
  stopAllRemoteDesktopConnections(): Promise<void>;
  stopRemoteDesktopConnection(publicId: string): Promise<boolean>;
}

const REMOTE_DESKTOP_WORKER_REPAIR_RETRY_MS = 5 * 60_000;
const MACOS_REMOTE_DESKTOP_INSTALL_RETRY_MS = 5 * 60_000;
/**
 * How soon components that ARE installed but did not start are started again.
 * Much shorter than the install back-off because the usual cause is a state a
 * person changes in seconds -- the screen was locked when the node started --
 * and nothing else would ever run start-up again.
 */
const MACOS_REMOTE_DESKTOP_START_RETRY_MS = 30_000;
export const CONTROLLED_NODE_UPGRADE_HANDOFF_TIMEOUT_MS = 60_000;
// Server-side version convergence is deliberately scheduled five seconds after
// authentication. Wait through that window before attempting a same-version
// repair so an actually stale node performs one atomic upgrade, not two.
const REMOTE_DESKTOP_WORKER_REPAIR_AUTH_GRACE_MS = 10_000;

export function createControlledNodeRuntime(
  credential: ControlledNodeCredential,
  createSocket: AuthenticatedWebSocketFactory = (url) => new WebSocket(url),
  options: ControlledNodeRuntimeOptions = {},
): ControlledNodeRuntimeClient {
  const worker = new MachineExecWorker();
  const computerUseWorker = new ComputerUseWorker(credential);
  let client!: AuthenticatedWebSocketClient;
  let onMacosRemoteDesktopProfileChanged = (): void => undefined;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformWorker = options.remoteDesktopWorker
    ? { worker: options.remoteDesktopWorker }
    : createPlatformRemoteDesktopWorkerHost({
      platform,
      arch,
      onMessage: (message) => {
        logger.debug({
          type: (message as { type?: unknown }).type,
          reason: (message as { reason?: unknown }).reason,
        }, 'remote-desktop worker message forwarded');
        client.send(message);
      },
      macos: options.macosRemoteDesktopWorker ? {
        ...options.macosRemoteDesktopWorker,
        onLifecycleNotice: (notice) => {
          options.macosRemoteDesktopWorker?.onLifecycleNotice?.(notice);
          logger.info(notice, 'macOS remote-desktop lifecycle transition');
        },
        onProfileChanged: () => {
          options.macosRemoteDesktopWorker?.onProfileChanged?.();
          onMacosRemoteDesktopProfileChanged();
        },
      } : undefined,
      windows: {
        platform,
        onWorkerCrash: (crash) => {
      // A native fault would otherwise reach the browser as a bare
      // `worker_failed`, indistinguishable from an ordinary disconnect.
          incrementCounter('remote_desktop.worker_crash', {
            exception: `0x${crash.exceptionCode.toString(16)}`,
            module: crash.module,
          });
          logger.warn({
            pid: crash.pid,
            exceptionCode: `0x${crash.exceptionCode.toString(16)}`,
            module: crash.module,
            moduleOffset: crash.moduleOffset,
          }, 'remote desktop worker crashed');
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
      },
    });
  const remoteDesktopWorker = platformWorker.worker;
  const remoteDesktopWorkerStartup = platformWorker.startup;
  const remoteDesktopFeatureEnabled = isRemoteDesktopFeatureEnabled(
    process.env.IMCODES_REMOTE_DESKTOP_ENABLED,
    process.env.NODE_ENV,
  );
  let remoteDesktopWorkerAvailable = false;
  let workerAdapterCapabilities: readonly RemoteDesktopAdapterCapability[] = [];
  let workerSessionCapabilities: readonly string[] = [];
  let remoteDesktopEnabled = false;
  let remoteDesktopAccessPaused = options.remoteDesktopAccessPaused === true;
  let remoteDesktopAutoUnlockAvailable = false;
  let defaultShieldedRouteAvailable = false;
  let signedShellAvailable = false;
  let advertisedAdapterCapabilities: readonly RemoteDesktopAdapterCapability[] = [];
  /**
   * A macOS worker that is running and authenticated but lacks Screen
   * Recording advertises its capture-less profile, and nothing more. That set
   * cannot open a session -- no capture capability, and `remoteDesktopEnabled`
   * stays false -- but it is exactly what the browser reads as "one grant away"
   * and turns into the 申请权限 button. Advertising nothing in this state is what
   * left a Mac with a working worker showing no remote-desktop button at all.
   */
  let permissionRequiredCapabilities: readonly string[] = [];
  /**
   * Linux: the worker is installed but the box has no X server at all (a
   * plain server). Advertising remote desktop there only fails at session
   * start, so the node instead offers the install that sets up a basic
   * desktop, and runs it when the owner clicks 启用远程控制.
   */
  const linuxDesktop = options.linuxDesktop ?? {
    displayAvailable: () => linuxGraphicalDisplayAvailable(),
    provisionSupported: () => linuxDesktopProvisionSupported(),
    provision: () => provisionLinuxDesktopEnvironment(),
  };
  let linuxDesktopMissing = false;
  let linuxDesktopProvisionInFlight = false;
  /**
   * A display socket is not a usable display (a Wayland desktop's or login
   * greeter's Xwayland rejects the worker), so on Linux the node probes each
   * socket and re-publishes when the set of openable displays changes. The
   * injected test seam is hermetic and never probes the real machine.
   */
  const linuxDisplayProbeEnabled = platform === 'linux' && !options.linuxDesktop;
  const refreshLinuxDisplayProbe = (): void => {
    if (!linuxDisplayProbeEnabled || !x11DisplayProbeIsStale()) return;
    void refreshX11DisplayProbe().then((changed) => {
      if (!changed) return;
      refreshRemoteDesktopCapabilityState();
      republishCapabilitiesIfChanged();
    }).catch((error) => {
      logger.warn({ err: error }, 'linux X11 display probe failed');
    });
  };
  /**
   * Set once this node's worker has become available at least once.
   *
   * The 30s retry below exists to recover a start that FAILED (the usual cause
   * is a state a person changes in seconds, like an unlocked screen) -- not to
   * keep an already-proven-healthy worker perpetually alive. Once it has
   * authenticated at least one generation, a later idle worker closing itself
   * (nobody ever asked for it) is not a failure to retry: forcing it back up
   * every 30s only respawns a fresh disclosure overlay -- unconditionally
   * visible the instant its process starts, real peer or not -- to idle for a
   * minute and repeat, an endless user-visible "1 viewing" flash. A real,
   * later PREPARE still starts the worker on demand (see the lazy-start guard
   * around `dispatchRemoteDesktopCommand` below).
   *
   * Declared here (not lower, where it used to live) so `refreshRemote
   * DesktopCapabilityState` below can read it on its very first call.
   */
  let macosRemoteDesktopEverAvailable = false;
  /**
   * macOS only: the component set's own on-disk installed-and-verified state
   * for this exact release (see `isInstalledForThisRelease` inside
   * `installMacosRemoteDesktopComponents`, which is what actually sets this).
   * Independent of `macosRemoteDesktopEverAvailable`: a machine can be fully
   * installed while its worker has not yet live-started even once this run
   * (the code above's own locked-screen example), and this signal still
   * proves it in that gap.
   */
  let macosRemoteDesktopInstalledForRelease = false;
  /**
   * macOS only: the session/adapter capabilities a live connection most
   * recently proved this machine can actually serve. `available()` on
   * `src/node/macos-remote-desktop-worker-host.ts` is keyed to
   * `authenticated` -- true only while a worker's control socket happens to
   * be connected RIGHT NOW, false the instant it disconnects, including the
   * ordinary, expected gap between one worker generation closing and the
   * next one authenticating (`onDisconnect`'s own restart there, unrelated to
   * and not changed by this fix). Without this cache, that transient,
   * entirely normal gap made a fully-installed, actively-used machine
   * advertise itself as "please install remote desktop" every time the
   * capability snapshot was read during it -- confirmed live on two
   * real machines (m3, mini-2), each flipping to that wrong state on a
   * ~60s cycle. `ready` and `installable` must reflect whether this
   * machine's component set is installed and has been proven to work, not
   * whether a worker process happens to be connected at this exact instant.
   */
  let macosRemoteDesktopProvenSessionCapabilities: readonly string[] = [];
  let macosRemoteDesktopProvenAdapterCapabilities: readonly RemoteDesktopAdapterCapability[] = [];

  const refreshRemoteDesktopCapabilityState = (): void => {
    refreshLinuxDisplayProbe();
    let remoteDesktopWorkerAvailableNow = false;
    try {
      remoteDesktopWorkerAvailableNow = remoteDesktopWorker.available();
    } catch {
      remoteDesktopWorkerAvailableNow = false;
    }
    let declaredAdapterCapabilities: readonly RemoteDesktopAdapterCapability[] = [];
    try {
      declaredAdapterCapabilities = remoteDesktopWorker.adapterCapabilities?.() ?? [];
    } catch {
      // A broken feature probe cannot widen the node's advertisement.
    }
    const filteredAdapterCapabilities = remoteDesktopWorkerAvailableNow && remoteDesktopFeatureEnabled
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
    let declaredSessionCapabilities: readonly string[] = [REMOTE_DESKTOP_CAPABILITY];
    try {
      declaredSessionCapabilities = remoteDesktopWorker.sessionCapabilities?.()
        ?? [REMOTE_DESKTOP_CAPABILITY];
    } catch {
      declaredSessionCapabilities = [];
    }
    const filteredSessionCapabilities = remoteDesktopWorkerAvailableNow && remoteDesktopFeatureEnabled
      ? [...new Set(declaredSessionCapabilities)].filter((capability) => (
        capability === REMOTE_DESKTOP_CAPABILITY
        || (REMOTE_DESKTOP_SESSION_PROFILE_CAPABILITIES as readonly string[]).includes(capability)
      ))
      : [];
    if (remoteDesktopWorkerAvailableNow && filteredSessionCapabilities.length > 0) {
      // Remember exactly what a live connection just proved this machine can
      // do, so the ordinary gap before the next worker generation
      // authenticates (see macos-remote-desktop-worker-host.ts's own
      // onDisconnect restart -- unrelated to and unchanged by this fix) has
      // something real to fall back to instead of nothing.
      macosRemoteDesktopProvenSessionCapabilities = filteredSessionCapabilities;
      macosRemoteDesktopProvenAdapterCapabilities = filteredAdapterCapabilities;
    }
    // macOS only: a worker proven to work at least once this run, or whose
    // component set is independently verified installed for this release
    // (macosRemoteDesktopInstalledForRelease covers the gap before that first
    // proof -- e.g. a locked screen at daemon start), is READY even while
    // genuinely disconnected between generations. That gap is the worker's
    // own connection lifecycle, not this machine's install state, and the
    // two must not be conflated -- every other platform's `available()`
    // already means exactly "ready" with nothing to fall back to, so this
    // only ever widens macOS, and only when there is a real proven profile to
    // widen it with.
    const macosProvenReady = platform === 'darwin'
      && (macosRemoteDesktopEverAvailable || macosRemoteDesktopInstalledForRelease)
      && macosRemoteDesktopProvenSessionCapabilities.length > 0;
    remoteDesktopWorkerAvailable = remoteDesktopWorkerAvailableNow || macosProvenReady;
    workerAdapterCapabilities = remoteDesktopWorkerAvailable && remoteDesktopFeatureEnabled
      ? (remoteDesktopWorkerAvailableNow ? filteredAdapterCapabilities : macosRemoteDesktopProvenAdapterCapabilities)
      : [];
    workerSessionCapabilities = remoteDesktopWorkerAvailable && remoteDesktopFeatureEnabled
      ? (remoteDesktopWorkerAvailableNow ? filteredSessionCapabilities : macosRemoteDesktopProvenSessionCapabilities)
      : [];
    const profile = resolveRemoteDesktopSessionProfile([
      ...workerSessionCapabilities,
      ...workerAdapterCapabilities,
    ]);
    remoteDesktopEnabled = remoteDesktopWorkerAvailable
      && remoteDesktopFeatureEnabled
      && profile !== null;
    linuxDesktopMissing = platform === 'linux'
      && remoteDesktopEnabled
      && !linuxDesktop.displayAvailable();
    if (linuxDesktopMissing) remoteDesktopEnabled = false;
    const captureCapabilities = Object.values(REMOTE_DESKTOP_CAPTURE_CAPABILITY) as readonly string[];
    permissionRequiredCapabilities = remoteDesktopWorkerAvailable
      && remoteDesktopFeatureEnabled
      && profile === null
      && workerSessionCapabilities.includes(REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS)
      && !workerSessionCapabilities.some((capability) => captureCapabilities.includes(capability))
      ? [
        ...workerSessionCapabilities,
        ...workerAdapterCapabilities.filter((capability) => capability === REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY),
      ]
      : [];
    const enabledAdapters = remoteDesktopEnabled ? workerAdapterCapabilities : [];
    // Windows keeps the secret in its SYSTEM worker; macOS in the root node, so
    // it additionally needs a host that actually has a store to keep it in.
    remoteDesktopAutoUnlockAvailable = remoteDesktopEnabled
      && (profile?.platform === 'windows'
        || (profile?.platform === 'macos'
          && (remoteDesktopWorker.supportsAutoUnlock?.() ?? false)));
    try {
      defaultShieldedRouteAvailable = remoteDesktopEnabled
        && enabledAdapters.includes(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY)
        && typeof remoteDesktopWorker.sendPrivacyFrame === 'function'
        && typeof remoteDesktopWorker.onPrivacyFrame === 'function'
        && (remoteDesktopWorker.supportsDefaultShieldedRoute?.() ?? false);
    } catch {
      defaultShieldedRouteAvailable = false;
    }
    try {
      // The signed account shell is a Windows sidecar. A macOS profile that
      // claimed it would be refused whole by the shared profile resolver.
      signedShellAvailable = remoteDesktopEnabled
        && profile?.platform !== 'macos'
        && enabledAdapters.includes(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY)
        && defaultShieldedRouteAvailable
        && (options.remoteDesktopSignedShell?.available() ?? false);
    } catch {
      signedShellAvailable = false;
    }
    advertisedAdapterCapabilities = [
      ...enabledAdapters.filter((capability) => (
        capability !== REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY
      )),
      ...(signedShellAvailable ? [REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY] : []),
    ];
  };
  refreshRemoteDesktopCapabilityState();
  const missingRemoteDesktopWorkerCanRepair = (platform === 'win32' || platform === 'linux')
    && arch === 'x64'
    && remoteDesktopFeatureEnabled
    && !remoteDesktopWorkerAvailable;
  // macOS advertises the same intent under its own name and installs by a
  // different mechanism: the components are published into a store with
  // rollback and a last-known-good selector, so nothing replaces the running
  // executable and the process does not restart. Recomputed rather than
  // captured, because a successful install must stop offering itself without
  // waiting for a reconnect.
  const macosRemoteDesktopComponentsInstallable = (): boolean => platform === 'darwin'
    && (arch === 'arm64' || arch === 'x64')
    && remoteDesktopFeatureEnabled
    && !remoteDesktopWorkerAvailable;
  // What `installMacosRemoteDesktopComponents` itself gates on, which is
  // deliberately wider than `macosRemoteDesktopComponentsInstallable` above:
  // that function ALSO drives the browser's "Install" affordance and the
  // manual-request fallback to Windows-style repair, so it stops once a
  // worker exists. But `installMacosRemoteDesktopComponents` already makes
  // its own safe, idempotent, version-aware decision of whether anything
  // needs to change -- `isInstalledForThisRelease` below no-ops when the
  // installed release's workerVersion already matches this daemon's. Reusing
  // the narrower check as this function's OWN entry gate meant a Mac that
  // received its first release ever could not receive a second one: once any
  // worker was installed, `remoteDesktopWorkerAvailable` stayed true forever,
  // this function returned false before it ever asked the store a question,
  // and every later daemon version -- including one carrying a real fix for
  // this exact adapter -- went undelivered, silently, on every reconnect.
  const macosRemoteDesktopUpdateCheckEligible = (): boolean => platform === 'darwin'
    && (arch === 'arm64' || arch === 'x64')
    && remoteDesktopFeatureEnabled;
  let macosRemoteDesktopInstallInFlight = false;
  let macosRemoteDesktopInstallNextAttemptAt = 0;
  let macosRemoteDesktopStartNextAttemptAt = 0;
  // macosRemoteDesktopEverAvailable now declared above, alongside
  // refreshRemoteDesktopCapabilityState, which reads it on its first call.
  let upgradeInFlight = false;
  let upgradeHandoffDeadlineAt: number | null = null;
  const armUpgradeHandoffWatchdog = (): void => {
    if (platform !== 'win32') return;
    upgradeHandoffDeadlineAt = (options.now?.() ?? Date.now())
      + CONTROLLED_NODE_UPGRADE_HANDOFF_TIMEOUT_MS;
  };
  const clearUpgradeGate = (): void => {
    upgradeInFlight = false;
    upgradeHandoffDeadlineAt = null;
  };
  const reportStalledUpgradeHandoff = (): void => {
    if (!upgradeInFlight || upgradeHandoffDeadlineAt === null) return;
    if ((options.now?.() ?? Date.now()) < upgradeHandoffDeadlineAt) return;
    if (!client.send({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS,
    })) return;
    // One generation emits this recovery edge once. Keep the upgrade gate
    // claimed until the Server's signed rescue restarts the process.
    upgradeHandoffDeadlineAt = null;
    logger.warn('controlled node upgrade handoff timed out; requesting signed rescue');
  };
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
  let signedShellController: RemoteDesktopSignedShellController | null = null;
  const ensureSignedShellController = (): void => {
    if (signedShellController || !signedShellAvailable || !options.remoteDesktopSignedShell) return;
    signedShellController = new RemoteDesktopSignedShellController({
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
    });
  };
  ensureSignedShellController();

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
  const componentArch = arch === 'arm64' ? 'arm64' : 'x64';
  const storeRoot = defaultMacosRemoteDesktopArtifactStoreRoot(componentArch);
  /** Whether the store's selected macOS component set is THIS release's. */
  const isInstalledForThisRelease = options.macosRemoteDesktopComponentsInstalled
    ?? (options.installMacosRemoteDesktopComponents ? async () => false : async () => {
      const selected = await selectMacosRemoteDesktopArtifact(storeRoot, 'current', {
        runtime: { platform, arch: componentArch },
      }).catch(() => null);
      return selected?.manifest.workerVersion === DAEMON_VERSION;
    });
  /**
   * Fetch this release's macOS component set and publish it.
   *
   * Unlike the Windows repair below, nothing restarts: the components live in
   * their own store and the running executable is untouched. Promotion is
   * transactional -- it verifies the staged set with the same Apple checks the
   * daemon applies on a user's Mac, and a failure leaves the previous
   * selectors exactly as they were.
   *
   * The staging directory is temporary and removed either way. A half-written
   * set left beside the store is a set some later code might mistake for a
   * release.
   */
  const installMacosRemoteDesktopComponents = async (force = false): Promise<boolean> => {
    if (macosRemoteDesktopInstallInFlight || !macosRemoteDesktopUpdateCheckEligible()) return false;
    // A failed automatic attempt waits before trying again. Without this every
    // reconnect re-downloads, and a server that cannot serve the set turns a
    // flapping link into a request loop. An explicit click ignores the delay:
    // the person asking has new information the node does not.
    const now = options.now?.() ?? Date.now();
    // Already installed for THIS release: fetching it again cannot help. The
    // components are present and not running, which is a start-up failure --
    // most often a screen that was locked when the node started. Start-up ran
    // once and never again, so the Mac stayed unoffered after it was unlocked,
    // while the node re-downloaded the release every window and flipped the
    // selector back over whatever set was installed.
    if (force || now >= macosRemoteDesktopStartNextAttemptAt) {
      // Claimed before the check: verifying the store is not free, and this
      // runs on every heartbeat.
      macosRemoteDesktopStartNextAttemptAt = now + MACOS_REMOTE_DESKTOP_START_RETRY_MS;
      macosRemoteDesktopInstallInFlight = true;
      let installedForThisRelease = false;
      try {
        installedForThisRelease = await isInstalledForThisRelease();
        // The capability computation's own persistent, connection-lifecycle-
        // independent "is this machine set up" signal -- see
        // macosRemoteDesktopInstalledForRelease's own doc comment.
        macosRemoteDesktopInstalledForRelease = installedForThisRelease;
        if (installedForThisRelease) {
          // Retry the START itself only until it first succeeds (or on an
          // explicit force). After that this worker has proven it CAN come up;
          // an idle close from here on is real demand disappearing, not a
          // start-up failure, and forcing it back up every retry window would
          // only be an endless respawn -- see macosRemoteDesktopEverAvailable.
          if (force || !macosRemoteDesktopEverAvailable) {
            try {
              await remoteDesktopWorkerStartup?.();
            } catch (error) {
              logger.warn({ err: error }, 'installed macOS remote-desktop components did not start');
            }
            try {
              macosRemoteDesktopEverAvailable = macosRemoteDesktopEverAvailable
                || remoteDesktopWorker.available();
            } catch {
              // Leave the flag as-is; a broken availability probe is not proof
              // of either state.
            }
          }
          republishCapabilitiesIfChanged();
        }
      } finally {
        macosRemoteDesktopInstallInFlight = false;
      }
      if (installedForThisRelease) return false;
    } else {
      return false;
    }
    if (!force && now < macosRemoteDesktopInstallNextAttemptAt) return false;
    macosRemoteDesktopInstallNextAttemptAt = now + MACOS_REMOTE_DESKTOP_INSTALL_RETRY_MS;
    macosRemoteDesktopInstallInFlight = true;
    const install = options.installMacosRemoteDesktopComponents ?? (async () => {
      const staging = await mkdtemp(join(tmpdir(), 'imcodes-macos-rd-install-'));
      try {
        const downloaded = await downloadControlledNodeMacosRemoteDesktopComponentSet({
          credential,
          target: { os: CONTROLLED_NODE_OS_MAC, arch: componentArch },
          dir: staging,
          fetchImpl: fetch,
          expectedVersion: DAEMON_VERSION,
        });
        if (!downloaded) {
          // The server has no signed macOS component set for THIS daemon
          // version (403/404/503). On a matched release this never happens; on
          // a node whose version has drifted from the server image's bundled
          // set it happens every retry. It used to return silently, so a Mac
          // that could never install its worker -- and therefore never raised
          // the permission prompt -- left no trace at all. Say so, throttled by
          // the install retry window above.
          logger.warn(
            { expectedVersion: DAEMON_VERSION, arch: componentArch },
            'macOS remote-desktop component set unavailable for this daemon version; '
            + 'the server has no matching signed set, so the worker cannot install '
            + '(auto-install will retry)',
          );
          return false;
        }
        await promoteMacosRemoteDesktopArtifact({
          artifactDirectory: downloaded.componentDirectory,
          manifestPath: downloaded.manifestPath,
          storeRoot,
          expectedWorkerVersion: DAEMON_VERSION,
        });
        return true;
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
    try {
      const installed = await install();
      if (installed) {
        logger.info('installed the macOS remote-desktop component set');
        macosRemoteDesktopInstalledForRelease = true;
        // START what was just installed. The adapter's startup runs once,
        // before the socket connects -- on a machine installing for the first
        // time that is exactly when there is nothing to start, so it failed,
        // and nothing ever ran it again. The components then sat verified in
        // the store while the node kept reporting them missing and fetching
        // them again every retry window, with the button in the browser
        // unchanged no matter how often it was pressed.
        try {
          await remoteDesktopWorkerStartup?.();
        } catch (error) {
          logger.warn({ err: error }, 'installed macOS remote-desktop components did not start');
        }
        try {
          macosRemoteDesktopEverAvailable = macosRemoteDesktopEverAvailable
            || remoteDesktopWorker.available();
        } catch {
          // Leave the flag as-is; a broken availability probe is not proof of
          // either state.
        }
        // Re-read rather than assume: starting does not imply readiness, and
        // screen recording may not be granted yet.
        republishCapabilitiesIfChanged();
      }
      return installed;
    } catch (error) {
      logger.warn({ err: error }, 'macOS remote-desktop component install failed');
      return false;
    } finally {
      macosRemoteDesktopInstallInFlight = false;
    }
  };
  const linuxDesktopInstallable = (): boolean => linuxDesktopMissing && linuxDesktop.provisionSupported();
  const provisionLinuxDesktop = async (): Promise<void> => {
    if (linuxDesktopProvisionInFlight) return;
    linuxDesktopProvisionInFlight = true;
    logger.info('installing a basic desktop environment for remote desktop on this headless Linux box');
    try {
      const result = await linuxDesktop.provision();
      if (result.ok) {
        logger.info({ user: result.user }, 'basic desktop environment installed');
      } else {
        logger.warn({ reason: result.reason, detail: result.detail }, 'basic desktop environment install failed');
      }
    } catch (error) {
      logger.warn({ err: error }, 'basic desktop environment install failed');
    } finally {
      linuxDesktopProvisionInFlight = false;
      // A display that came up turns this into an ordinary enabled remote
      // desktop; one that did not keeps offering the (idempotent) install.
      refreshRemoteDesktopCapabilityState();
      republishCapabilitiesIfChanged();
    }
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
        armUpgradeHandoffWatchdog();
        // Keep the gate claimed. The detached upgrade task replaces the
        // artifact set and restarts this process; clearing it here could admit
        // a second task during that handoff window.
        return;
      }
      clearUpgradeGate();
      logger.warn({ reason: result.reason }, 'could not stage missing remote desktop worker repair');
    }, (error) => {
      clearUpgradeGate();
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
  const authFrame: Record<string, unknown> & { capabilities: string[] } = {
    type: 'auth',
    serverId: credential.serverId,
    token: credential.token,
    daemonVersion: DAEMON_VERSION,
    // The architecture this process is ACTUALLY running as, which the row
    // recorded at enrollment may not be. The macOS executable is universal,
    // so enrollment recorded whichever slice ran the installer -- under
    // Rosetta that is `x64` on an Apple Silicon Mac, and nothing corrected it
    // afterwards, leaving the machine mislabelled everywhere it was shown.
    runtimeArch: arch,
    capabilities: [],
  };
  const refreshAuthCapabilities = (): void => {
    authFrame.capabilities = [
      FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
      FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
      FILE_TRANSFER_DIRECTORY_CAPABILITY,
      MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
      MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
      CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY,
      ...(remoteDesktopEnabled && !remoteDesktopAccessPaused
        ? [
          ...workerSessionCapabilities,
          ...(remoteDesktopAutoUnlockAvailable ? [CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY] : []),
          // Workers shipped with this node accept PREPARE's relay ceiling.
          REMOTE_DESKTOP_RELAY_CAP_CAPABILITY,
        ]
        : remoteDesktopAccessPaused ? [] : permissionRequiredCapabilities),
      ...(remoteDesktopAccessPaused
        ? [REMOTE_DESKTOP_LOCAL_MANAGEMENT.PAUSED_CAPABILITY]
        : []),
      ...(missingRemoteDesktopWorkerCanRepair || linuxDesktopInstallable()
        ? [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]
        : []),
      ...(macosRemoteDesktopComponentsInstallable()
        ? [REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY]
        : []),
      ...advertisedAdapterCapabilities,
      ...(defaultShieldedRouteAvailable
        ? [REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY]
        : []),
    ];
  };
  /**
   * What the CURRENT connection authenticated with. Capabilities reach the
   * server only in the auth frame, so anything that changes them afterwards
   * has to start a new connection or it is never seen.
   */
  let authenticatedCapabilities = '';
  const serverClock = options.serverClock ?? new ServerClockEstimator();
  const republishCapabilitiesIfChanged = (): void => {
    refreshRemoteDesktopCapabilityState();
    refreshAuthCapabilities();
    // Only on a real change. A readiness poll that finds nothing new must not
    // cost a reconnect, and the reconnect itself re-samples and records the
    // new set, so this cannot loop.
    if (JSON.stringify(authFrame.capabilities) === authenticatedCapabilities) return;
    // Named, because this is the only moment the server -- and so the browser
    // -- learns what remote desktop this node can do. When a working worker
    // never turned into a button, there was no line anywhere saying what had
    // been offered.
    logger.info({
      remoteDesktopAvailable: remoteDesktopWorkerAvailable,
      capabilities: (authFrame.capabilities ?? []).filter((capability) => capability.startsWith('remote')),
    }, 'remote-desktop capabilities changed; reconnecting to publish them');
    client.reconnect();
  };
  onMacosRemoteDesktopProfileChanged = () => {
    // A permission granted at the machine surfaces here, through the
    // adapter's readiness poll. Refreshing only the local frame meant the grant
    // was invisible to the server -- and so to the browser -- until something
    // else happened to reconnect.
    republishCapabilitiesIfChanged();
  };
  // Tell the server which daemons are bound on this computer, so the daemon's
  // remote-desktop button can open this node. Rescanned on a slow clock to catch
  // a daemon installed after this node; sent only when the answer changes, and
  // always once more after a reconnect (the server may have restarted).
  let localDaemonsReported: string | null = null;
  let localDaemonsScannedAt = Number.NEGATIVE_INFINITY;
  let localDaemonsScanInFlight = false;
  const reportLocalDaemonsIfDue = (): void => {
    const now = Date.now();
    if (localDaemonsScanInFlight
      || now - localDaemonsScannedAt < CONTROLLED_NODE_LOCAL_DAEMONS_RESCAN_MS) return;
    localDaemonsScannedAt = now;
    localDaemonsScanInFlight = true;
    const discover = options.discoverLocalDaemons ?? (() => discoverLocalDaemonServerIds());
    void discover()
      .then((serverIds) => {
        const key = JSON.stringify(serverIds);
        if (serverIds.length === 0 || key === localDaemonsReported) return;
        if (client.send({ type: DAEMON_MSG.CONTROLLED_NODE_LOCAL_DAEMONS, serverIds })) {
          localDaemonsReported = key;
        }
      })
      .catch(() => {})
      .finally(() => { localDaemonsScanInFlight = false; });
  };
  refreshAuthCapabilities();

  // Remote-desktop commands for one session are dispatched strictly in order.
  // A PREPARE can wait below for a macOS worker to (re)start; its OFFER and
  // ICE arrive on the same socket a moment later and used to be dispatched
  // meanwhile, found no live worker and were answered worker_failed -- failing
  // the browser's attempt -- while the held PREPARE still reached the new
  // worker afterwards and left it holding a session nobody would ever offer
  // to. A Mac worker serves one session, so the browser's retry was then
  // refused by that worker too (measured on node mini-2: every reconnect
  // within a couple of seconds of a stop took three attempts and ~20 s).
  // Different sessions stay independent of each other.
  const remoteDesktopSessionOrder = new Map<string, Promise<void>>();
  const inRemoteDesktopSessionOrder = (
    sessionId: string | undefined,
    task: () => Promise<void>,
  ): Promise<void> => {
    if (!sessionId) return task();
    const previous = remoteDesktopSessionOrder.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    remoteDesktopSessionOrder.set(sessionId, tail);
    void tail.then(() => {
      if (remoteDesktopSessionOrder.get(sessionId) === tail) remoteDesktopSessionOrder.delete(sessionId);
    });
    return run;
  };
  const clientOptions: AuthenticatedWebSocketOptions = {
    url: controlledNodeWebSocketUrl(credential.serverUrl, credential.serverId),
    auth: authFrame,
    heartbeatMessage: () => ({
      type: 'heartbeat',
      daemonVersion: DAEMON_VERSION,
      [CLOCK_SYNC_FIELD.SENT_AT]: Date.now(),
    }),
    heartbeatMs: 5_000,
    silenceTimeoutMs: 30_000,
    onDiagnostic: (event) => {
      if (event.type === 'socket_opened') {
        logger.info({ lifecycle: event.type }, 'controlled-node transport connected');
      } else if (event.type === 'reconnect_scheduled') {
        logger.info({ lifecycle: event.type, delayMs: event.delayMs }, 'controlled-node transport reconnect scheduled');
      } else {
        // Deliberately exclude URL, auth frames and message bodies. This is
        // safe to collect from an affected laptop without exposing secrets.
        logger.warn({ lifecycle: event.type, reason: event.reason }, 'controlled-node transport disconnected');
      }
    },
    createSocket: (url) => {
      // Auth is connection-generation scoped. Re-sample immediately before
      // each socket so a readiness downgrade cannot reconnect as stale Control.
      refreshRemoteDesktopCapabilityState();
      ensureSignedShellController();
      refreshAuthCapabilities();
      authenticatedCapabilities = JSON.stringify(authFrame.capabilities);
      return createSocket(url);
    },
    onOpen: () => {
      client.send({ type: 'heartbeat', daemonVersion: DAEMON_VERSION, [CLOCK_SYNC_FIELD.SENT_AT]: Date.now() });
      localDaemonsReported = null;
      localDaemonsScannedAt = Number.NEGATIVE_INFINITY;
    },
    onClose: () => {
      worker.abortAll();
      // Remote desktop authority is connection-generation-bound. Unlike the
      // warm Computer Use helper, every peer must die on Server-link loss.
      if (remoteDesktopWorker.onDaemonDisconnected) {
        remoteDesktopWorker.onDaemonDisconnected();
      } else {
        remoteDesktopWorker.close();
      }
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
        // Every ack from a clock-aware Server is one round-trip sample. Older
        // Servers send neither field and the offset stays 0 (local clock).
        serverClock.addSample(message[CLOCK_SYNC_FIELD.SENT_AT], message[CLOCK_SYNC_FIELD.SERVER_TIME], Date.now());
        reportStalledUpgradeHandoff();
        persistAuthentication();
        reportLocalDaemonsIfDue();
        if (remoteDesktopWorkerRepairEligibleAt === null) {
          remoteDesktopWorkerRepairEligibleAt = (options.now?.() ?? Date.now())
            + REMOTE_DESKTOP_WORKER_REPAIR_AUTH_GRACE_MS;
        }
        repairMissingRemoteDesktopWorker();
        // macOS installs itself. The components are part of this release, the
        // node already knows it has none, and making a human click a button to
        // fetch them is asking them to do what the node can do unprompted. The
        // manual request remains as a retry for when this fails.
        void installMacosRemoteDesktopComponents();
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
        const startSelfUpgrade = options.startSelfUpgrade ?? startControlledNodeSelfUpgrade;
        void startSelfUpgrade(credential, targetVersion).then((result) => {
          if (result.ok) {
            client.send({ type: DAEMON_MSG.UPGRADING, targetVersion: result.targetVersion, artifactSha256: result.artifactSha256 });
            armUpgradeHandoffWatchdog();
            return;
          }
          clearUpgradeGate();
          client.send({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: result.reason ?? 'controlled_node_upgrade_failed' });
        }, (error) => {
          clearUpgradeGate();
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
      if (message.type === REMOTE_DESKTOP_PERMISSION_MSG.REQUEST) {
        // No caller-controlled fields, for the same reason the install request
        // has none: there is exactly one thing to ask for, and a parameterised
        // version is a way to make a controlled node launch something chosen
        // from a browser.
        if (Object.keys(message).length !== 1) return;
        const request = options.requestMacosRemoteDesktopPermissions
          ?? options.macosRemoteDesktopWorker?.requestPermissions;
        if (!request) {
          logger.warn('no macOS remote-desktop adapter to raise a permission prompt');
          return;
        }
        void Promise.resolve(request()).then((asked) => {
          // BOTH outcomes are logged. Only logging success meant a refusal --
          // including "the components exist but cannot be executed" -- left no
          // trace at all, which is exactly how this went unexplained while the
          // operator clicked the button again.
          if (asked) {
            logger.info('asked the machine to raise its remote-desktop permission prompt');
          } else {
            logger.warn('the macOS adapter declined to raise the permission prompt');
          }
        }, (error) => {
          logger.warn({ err: error }, 'could not raise the remote-desktop permission prompt');
        });
        return;
      }
      if (message.type === REMOTE_DESKTOP_INSTALL_MSG.REQUEST) {
        // The request deliberately has no caller-controlled fields. Exactness
        // prevents this from becoming a generic upgrade endpoint.
        if (Object.keys(message).length !== 1) return;
        if (macosRemoteDesktopComponentsInstallable()) {
          void installMacosRemoteDesktopComponents(true);
          return;
        }
        if (linuxDesktopInstallable()) {
          void provisionLinuxDesktop();
          return;
        }
        repairMissingRemoteDesktopWorker(true);
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
        // Server-stamped deadlines onto this host's clock BEFORE anything
        // compares them: the worker host, the IPC authority and the native
        // worker all check them against local time.
        message = translateServerDeadlines(message, serverClock);
        // One line per command -- type and route only, never SDP, candidates or
        // capabilities. A session that sat on "connecting" forever left no
        // trace of whether its prepare ever reached this node.
        logger.info({
          type: message.type,
          sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
          remoteDesktopEnabled,
        }, 'remote-desktop command received');
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
        const command: Record<string, unknown> = message;
        await inRemoteDesktopSessionOrder(
          typeof command.sessionId === 'string' ? command.sessionId : undefined,
          async () => {
            // A macOS worker that idled itself down after nobody used it (see
            // macosRemoteDesktopEverAvailable above) is no longer kept warm by the
            // heartbeat poller on purpose. A real PREPARE is real demand arriving
            // right now, so start it lazily, on this request, instead of forcing
            // dispatch to answer worker_failed for a worker that would have
            // started fine a moment later. Best-effort: dispatch below still
            // answers a bounded terminal frame if this does not bring it up.
            if (command.type === REMOTE_DESKTOP_MSG.PREPARE && remoteDesktopWorkerStartup) {
              let currentlyAvailable = false;
              try {
                currentlyAvailable = remoteDesktopWorker.available();
              } catch {
                currentlyAvailable = false;
              }
              if (!currentlyAvailable) {
                try {
                  await remoteDesktopWorkerStartup();
                } catch (error) {
                  logger.warn({ err: error }, 'remote-desktop worker did not start for an incoming PREPARE');
                }
              }
            }
            await dispatchRemoteDesktopCommand({
              message: command,
              enabled: remoteDesktopEnabled && !remoteDesktopAccessPaused,
              target: remoteDesktopWorker,
              send: (reply) => {
                logger.info({
                  type: (reply as { type?: unknown }).type,
                  reason: (reply as { reason?: unknown }).reason,
                }, 'remote-desktop reply sent');
                client.send(reply);
              },
            });
          },
        );
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
        || message.type === FILE_TRANSFER_MSG.DELETE
        || message.type === FILE_TRANSFER_MSG.MACOS_OPEN_FULL_DISK_ACCESS) {
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
        } else if (parsed.value.type === FILE_TRANSFER_MSG.MACOS_OPEN_FULL_DISK_ACCESS) {
          await handleMacosOpenFullDiskAccess(parsed.value as unknown as Record<string, unknown>, fileSender);
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
          if (!remoteDesktopAutoUnlockAvailable
            || !remoteDesktopWorker.available()
            || typeof remoteDesktopWorker.applyAutoUnlockSecret !== 'function') {
            error = CONTROLLED_NODE_AUTO_UNLOCK_ERROR.UNSUPPORTED_PLATFORM;
          } else {
            ok = await remoteDesktopWorker.applyAutoUnlockSecret!(
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
          : await remoteDesktopWorker.autoUnlockConfigured?.().catch(() => false) ?? false;
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
  };
  if (remoteDesktopWorkerStartup) {
    client = new StartupGatedAuthenticatedWebSocketClient(clientOptions, async () => {
      // Only a set installed for THIS release is started here. Right after an
      // upgrade the store still selects the previous release until this node
      // installs the new one, and a worker started from it kept serving until
      // its first session ended -- so every upgrade brought a fixed worker bug
      // back for one session (node m3). Installing starts the new set itself.
      if (platform !== 'darwin' || await isInstalledForThisRelease().catch(() => false)) {
        try {
          await remoteDesktopWorkerStartup();
          await remoteDesktopWorker.setAccessPaused?.(remoteDesktopAccessPaused);
        } catch (error) {
          reportAuthenticationError(error);
        }
      }
      // This gated startup runs exactly once, before the first socket -- the
      // only call site that starts the macOS worker outside
      // installMacosRemoteDesktopComponents's own throttled retry. Record a
      // success here too, or the very first heartbeat after this one still
      // finds macosRemoteDesktopEverAvailable false and restarts the worker a
      // second time immediately, defeating the guard below entirely.
      try {
        macosRemoteDesktopEverAvailable = macosRemoteDesktopEverAvailable
          || remoteDesktopWorker.available();
      } catch {
        // Leave the flag as-is; a broken availability probe is not proof of
        // either state.
      }
      refreshRemoteDesktopCapabilityState();
      ensureSignedShellController();
      refreshAuthCapabilities();
    }, () => remoteDesktopWorker.close());
  } else if (remoteDesktopWorker.onDaemonDisconnected) {
    client = new FinalizingAuthenticatedWebSocketClient(
      clientOptions,
      () => remoteDesktopWorker.close(),
    );
  } else {
    client = new AuthenticatedWebSocketClient(clientOptions);
  }
  const runtimeClient = client as ControlledNodeRuntimeClient;
  runtimeClient.remoteDesktopAccessStatus = () => ({
    paused: remoteDesktopAccessPaused,
    connections: remoteDesktopWorker.activeConnections?.() ?? [],
  });
  runtimeClient.stopAllRemoteDesktopConnections = async () => {
    await remoteDesktopWorker.stopAllConnections?.();
  };
  runtimeClient.stopRemoteDesktopConnection = async (publicId: string) => (
    await remoteDesktopWorker.stopConnection?.(publicId) ?? false
  );
  runtimeClient.setRemoteDesktopAccessPaused = async (paused: boolean) => {
    if (remoteDesktopAccessPaused === paused) return;
    remoteDesktopAccessPaused = paused;
    if (paused) await remoteDesktopWorker.stopAllConnections?.();
    await remoteDesktopWorker.setAccessPaused?.(paused);
    republishCapabilitiesIfChanged();
  };
  return runtimeClient;
}
