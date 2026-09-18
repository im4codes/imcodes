import { randomBytes } from 'node:crypto';
import type { MacosRemoteDesktopUnlockSecretStore } from './macos-remote-desktop-unlock-secret.js';
import type { Socket } from 'node:net';
import type {
  MacosVirtualDisplayProxyLease,
  MacosVirtualDisplayProxySeams,
} from './macos-virtual-display-proxy.js';
import { probeVirtualDisplayCreateReadiness } from './macos-virtual-display-authority-host.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  validateRemoteDesktopDaemonCommand,
  type RemoteDesktopDaemonCommand,
  type RemoteDesktopDaemonMessage,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  type RemoteDesktopAdapterCapability,
  type RemoteDesktopRouteGeneration,
} from '../../shared/remote-desktop-access.js';
import { isRemoteDesktopId } from '../../shared/remote-desktop-contract-primitives.js';
import {
  WORKER_PRIVACY_FRAME,
  type WorkerPrivacyInboundFrame,
  type WorkerPrivacyReleasedFrame,
  type WorkerPrivacyShieldedFrame,
} from './remote-desktop-privacy-ipc.js';
import type { VerifiedMacosRemoteDesktopArtifact } from './macos-remote-desktop-artifact.js';
import {
  MacosRemoteDesktopIpcAuthorityHost,
  macosRemoteDesktopIpcPrincipalBinding,
  type MacosRemoteDesktopAcceptedPrivacyReply,
  type MacosRemoteDesktopExpectedCodeIdentity,
  type MacosRemoteDesktopIpcLaunch,
  type MacosRemoteDesktopIpcPrincipalBinding,
  type MacosRemoteDesktopIpcSession,
} from './macos-remote-desktop-ipc.js';
import {
  MacosRemoteDesktopIpcServer,
  type MacosRemoteDesktopIpcServerOptions,
  type MacosRemoteDesktopObservedGraphicalPeer,
  type MacosRemoteDesktopVerifiedCodeIdentity,
} from './macos-remote-desktop-ipc-server.js';
import {
  createMacosRemoteDesktopNativePeerVerificationSeams,
  type MacosRemoteDesktopNativePeerVerificationSeams,
} from './macos-remote-desktop-peer-verifier.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS,
  MacosRemoteDesktopLaunchAgentSupervisor,
  type MacosRemoteDesktopLaunchAgentSnapshot,
  type MacosRemoteDesktopLaunchAgentSupervisorDependencies,
  type MacosRemoteDesktopLifecycleEvent,
  type MacosRemoteDesktopLifecycleSource,
} from './macos-remote-desktop-launch-agent.js';
import {
  MACOS_REMOTE_DESKTOP_READINESS_MODE,
  resolveMacosRemoteDesktopRuntimeProfile,
  type MacosRemoteDesktopReadinessInput,
  type MacosRemoteDesktopRuntimeProfile,
} from './macos-remote-desktop-readiness.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY,
  MACOS_REMOTE_DESKTOP_WORKER_IDENTITY,
} from './macos-user-session.js';
import {
  RemoteDesktopWorkerHostCore,
} from './remote-desktop-worker-host-core.js';
import {
  assertMacosUserSession,
  type MacosRemoteDesktopGraphicalSessionAuthority,
  type MacosUserSession,
} from './user-session-launcher.js';

const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 15_000;
// Was 1_000. Each poll is not a cheap in-process check: inspectReadiness
// spawns a real --imcodes-readiness-v1 subprocess that opens a fresh
// connection to com.apple.coremedia.videoencoder to probe encoder
// readiness (see LocalReadiness / inspectLocalReadiness). At the 1s default
// this authenticates ~3,600 fresh videoencoder connections per hour for the
// entire lifetime of every authenticated session, indefinitely -- observed
// in production as a sustained ~1/s subprocess-spawn rate that never let up.
// Real screen-recording apps on the same machine (a third-party remote-
// desktop tool) kept working fine throughout, which rules out genuine
// system-wide hardware/encoder exhaustion and points at this host's own
// connection rate specifically -- consistent with the coremedia XPC service
// applying its own throttling to a client that reconnects this often,
// independent of anything actually wrong with the hardware. 20s keeps
// readiness changes (permission revoked, display unplugged, etc.) visible
// within a reasonable window while cutting the connection rate by 20x.
const DEFAULT_READINESS_POLL_MS = 20_000;
/**
 * How long a PREPARE waits for a worker generation that is still launching.
 *
 * A macOS worker serves its session and then exits; its replacement needs a
 * few seconds to launch, authenticate and be admitted. Measured on node
 * mini-2: a reconnect 1.5 s after a stop arrived 7 ms after the replacement's
 * agent launched. Refused as worker_failed, it was retried five seconds later
 * and failed again on that same fresh worker (exit EX_PROTOCOL), and only a
 * third attempt connected -- while reconnects arriving after the replacement
 * was up connected at once. Well inside the Server's negotiation deadline.
 */
const REPLACEMENT_WORKER_WAIT_MS = 15_000;
const REPLACEMENT_WORKER_POLL_MS = 100;
const MIN_AUTHENTICATION_TIMEOUT_MS = 10;
const MAX_AUTHENTICATION_TIMEOUT_MS = 120_000;
const MIN_READINESS_POLL_MS = 100;
const MAX_READINESS_POLL_MS = 60_000;

type LocalReadiness = Pick<
  MacosRemoteDesktopReadinessInput,
  'screenRecording' | 'encoder' | 'accessibility' | 'clipboard' | 'disclosure'
>;

interface MacosRemoteDesktopIpcTransport {
  start(): Promise<MacosRemoteDesktopIpcLaunch>;
  sendCommand(command: RemoteDesktopDaemonCommand): Promise<void>;
  stop(): Promise<void>;
  /**
   * Fails every display request in flight.
   *
   * Called when authority ends, not merely relied on through the lease getter:
   * a getter that starts returning null leaves already-dispatched requests
   * waiting for an answer that can no longer come.
   */
  revokeVirtualDisplayChannel?(): number;
  /**
   * Writes one privacy request to the authenticated worker. Absent means this
   * transport cannot shield a worker, which fails every privacy request that
   * needs one closed.
   */
  sendPrivacyRequest?(requestId: number, shield: boolean): Promise<void>;
}

interface MacosRemoteDesktopLaunchSupervisor {
  start(): Promise<MacosRemoteDesktopLaunchAgentSnapshot>;
  stop(): Promise<void>;
}

/** One generation-bound local cleanup request. */
export interface MacosRemoteDesktopHostCleanupRequest {
  reason: MacosRemoteDesktopHostCleanupReason;
  /**
   * The exact worker generation this cleanup belongs to. Never 0: generation 0
   * means "whatever is live", so a delayed cleanup issued for generation N
   * would be applied to its successor.
   */
  workerGeneration: number;
}

/** Settlement of one cleanup, derived from real completion, not dispatch. */
export const MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OUTCOME_REASON = Object.freeze({
  NO_ACTIVE_GENERATION: 'no_active_generation',
} as const);

export const MACOS_REMOTE_DESKTOP_HOST_CLEANUP_NOTICE_KIND = Object.freeze({
  NO_ACTIVE_GENERATION: 'cleanup_no_active_generation',
  EXPECTED_WORKER_EXIT: 'expected_worker_exit',
} as const);

export const MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OPERATION = Object.freeze({
  RELEASE_INPUT: 'release_input',
  STOP_CAPTURE: 'stop_capture',
} as const);

export interface MacosRemoteDesktopHostCleanupOutcome {
  ok: boolean;
  /**
   * The exact generation-bound control endpoint reported that this generation
   * was no longer active. The host owns the lifecycle evidence and therefore
   * decides whether this is an idempotent late cleanup or a real failure.
   */
  reason?: typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OUTCOME_REASON.NO_ACTIVE_GENERATION;
  error?: unknown;
}

export interface MacosRemoteDesktopHostCleanupNotice {
  kind: typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_NOTICE_KIND[
    keyof typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_NOTICE_KIND
  ];
  workerGeneration: number;
  operation?: typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OPERATION[
    keyof typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OPERATION
  ];
  lifecycleReason?: MacosRemoteDesktopHostCleanupReason;
}

/**
 * Upper bound on how long teardown waits for local cleanup to settle.
 *
 * Teardown must not be able to hang on a wedged worker or control socket, but
 * it also must not race ahead of release/stop. Bounded wait, then fail closed
 * and tear down anyway with the failure reported.
 */
export const MACOS_REMOTE_DESKTOP_HOST_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Upper bound on one worker privacy reply. Below the barrier's own ack
 * deadline, so a wedged worker fails the request closed while the Server epoch
 * is still waiting rather than after it gave up.
 */
export const MACOS_REMOTE_DESKTOP_PRIVACY_REPLY_TIMEOUT_MS = 10_000;

export interface MacosRemoteDesktopWorkerHostOptions {
  /**
   * Root-only store for the sign-in secret that unlocks a locked Mac. Absent
   * means this host offers no auto-unlock.
   */
  unlockSecretStore?: MacosRemoteDesktopUnlockSecretStore;
  /** Advertise the management-privacy shield (defaults to its qualification flag). */
  capturePrivacy?: boolean;
  /** Must resolve through the verified current/LKG artifact selector, never an unverified path. */
  resolveVerifiedArtifact(): Promise<VerifiedMacosRemoteDesktopArtifact | null>;
  /** Must resolve the exact active Aqua user and reject root/headless/session mismatch. */
  resolveUserSession(): Promise<MacosUserSession>;
  /**
   * Global-LaunchAgent path. When present, this explicit kernel-bound
   * principal replaces user discovery and may represent LoginWindow without a
   * fabricated username, HOME or TMPDIR.
   */
  resolveGraphicalSessionAuthority?(): Promise<MacosRemoteDesktopGraphicalSessionAuthority>;
  /**
   * Asks the machine to raise its own permission dialog, and reports only
   * whether the ASK was dispatched. Deliberately not a readiness answer: the
   * person at the keyboard decides, and the outcome shows up as a readiness
   * change whenever readiness is next read.
   */
  requestPermissions?(): Promise<boolean>;
  /** Reads effective TCC/encoder/disclosure readiness without prompting or OS inference. */
  inspectReadiness(
    artifact: VerifiedMacosRemoteDesktopArtifact,
    user: MacosUserSession,
  ): Promise<LocalReadiness>;
  /** Required for LoginWindow; may also specialize global Aqua readiness. */
  inspectGraphicalReadiness?(
    artifact: VerifiedMacosRemoteDesktopArtifact,
    principal: MacosRemoteDesktopGraphicalSessionAuthority,
    graphicalAttestation?: string,
  ): Promise<LocalReadiness>;
  /**
   * Delivers the freshly minted generation/nonce/socket to the authenticated
   * global bootstrap. It must complete before this host waits for the worker
   * hello, otherwise the two handshakes would deadlock.
   */
  onGraphicalIpcLaunch?(
    principal: MacosRemoteDesktopGraphicalSessionAuthority,
    launch: MacosRemoteDesktopIpcLaunch,
  ): void | Promise<void>;
  /**
   * Independent authenticated observation of the connected graphical peer.
   * Required for the explicit global-principal path; never derive it from the
   * expected principal passed to `onGraphicalIpcLaunch`.
   */
  inspectPeerGraphicalSession?(
    socket: Socket,
  ): Promise<MacosRemoteDesktopObservedGraphicalPeer>;
  /** Optional test seam; production derives both checks from the verified LaunchAgent executable. */
  inspectPeerUid?(socket: Socket): Promise<number>;
  /** Optional test seam; production derives both checks from the verified LaunchAgent executable. */
  verifyPeerCodeIdentity?(
    socket: Socket,
    expected: MacosRemoteDesktopExpectedCodeIdentity,
  ): Promise<MacosRemoteDesktopVerifiedCodeIdentity>;
  createPeerVerificationSeams?: (
    options: Parameters<typeof createMacosRemoteDesktopNativePeerVerificationSeams>[0],
  ) => MacosRemoteDesktopNativePeerVerificationSeams;
  /**
   * Starts this daemon's virtual-display authority for one verified artifact.
   *
   * A FACTORY, not a ready-made object, because the grant must be built from
   * the artifact this generation actually launched -- binding a helper to a set
   * that was never verified is the one thing the whole chain exists to prevent.
   *
   * `onAuthorityLost` is invoked when the agent lease ends. The host wires it
   * to the IPC server's revoke so requests in flight fail rather than wait on
   * an answer that can no longer come.
   *
   * Absent means no display authority at all, which is a refusal the worker is
   * told about, not a silent fallback.
   */
  startVirtualDisplayAuthority?: (
    context: {
      /** The exact verified set this generation launched from. */
      readonly artifact: VerifiedMacosRemoteDesktopArtifact;
      /** The Aqua user the worker runs as. */
      readonly user: MacosUserSession;
      /** Derived from the same artifact the IPC server authenticates against. */
      readonly identity: MacosRemoteDesktopExpectedCodeIdentity;
      /**
       * The SAME verifier the IPC server uses.
       *
       * Handed over rather than reconstructed so the agent and the worker are
       * admitted by one identity check. Two independently built verifiers are
       * two things to keep in step, and the weaker one decides.
       */
      readonly verification?: MacosRemoteDesktopNativePeerVerificationSeams;
    },
    hooks: { onAuthorityLost: () => void },
  ) => Promise<{
    lease: () => MacosVirtualDisplayProxyLease | null;
    seams: MacosVirtualDisplayProxySeams;
    close: () => Promise<void>;
  } | null>;
  /** Exact daemon runtime target supplied by the platform selector. */
  runtime?: { platform: NodeJS.Platform; arch: string };
  lifecycleSource?: MacosRemoteDesktopLifecycleSource;
  /**
   * Local cleanup, bound to the exact worker generation it was issued for and
   * awaitable. Both properties changed shape deliberately: a `void` return let
   * teardown stop the LaunchAgent and remove its control socket before the
   * freshly spawned cleanup process had connected, and an unbound request could
   * be delivered to a successor generation.
   */
  releaseInput?: (
    request: MacosRemoteDesktopHostCleanupRequest,
  ) => Promise<MacosRemoteDesktopHostCleanupOutcome> | MacosRemoteDesktopHostCleanupOutcome;
  stopCapture?: (
    request: MacosRemoteDesktopHostCleanupRequest,
  ) => Promise<MacosRemoteDesktopHostCleanupOutcome> | MacosRemoteDesktopHostCleanupOutcome;
  runtimeRoot?: string;
  authenticationTimeoutMs?: number;
  /** Re-probes effective TCC/disclosure state while a generation is active. */
  readinessPollMs?: number;
  prepareReadyTimeoutMs?: number;
  offerAnswerTimeoutMs?: number;
  /** Bound on one worker privacy reply; see MACOS_REMOTE_DESKTOP_PRIVACY_REPLY_TIMEOUT_MS. */
  privacyReplyTimeoutMs?: number;
  createIpcServer?: (options: MacosRemoteDesktopIpcServerOptions) => MacosRemoteDesktopIpcTransport;
  /** Where the per-user agent is run from; see the supervisor dependency. */
  resolveLaunchAgentExecutable?: MacosRemoteDesktopLaunchAgentSupervisorDependencies['resolveLauncherExecutable'];
  createLaunchAgentSupervisor?: (
    dependencies: MacosRemoteDesktopLaunchAgentSupervisorDependencies,
  ) => MacosRemoteDesktopLaunchSupervisor;
  /** Refreshes the next controlled-node auth frame when local readiness narrows. */
  onProfileChanged?: () => void;
  /** Structured, non-failure lifecycle evidence; never contains native output. */
  onLifecycleNotice?: (notice: MacosRemoteDesktopHostCleanupNotice) => void;
  onBackgroundError?: (error: unknown) => void;
}

export const MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON = Object.freeze({
  DAEMON_DISCONNECTED: 'daemon_disconnected',
  READINESS_CHANGED: 'readiness_changed',
} as const);

export type MacosRemoteDesktopHostCleanupReason = MacosRemoteDesktopLifecycleEvent
  | 'close'
  | typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.DAEMON_DISCONNECTED
  | typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED;

interface MacosPrivacyState {
  epochId: string;
  revision: number;
  /** True once SHIELDED was emitted for exactly this epoch/revision. */
  confirmed: boolean;
  /** The last workerGeneration reported in SHIELDED for this epoch. */
  shieldedGeneration: number;
  routesKey: string | null;
}

interface PendingPrivacyReply {
  workerGeneration: number;
  resolve(reply: MacosRemoteDesktopAcceptedPrivacyReply | null): void;
  timer: NodeJS.Timeout;
}

function routesKey(routes: readonly RemoteDesktopRouteGeneration[]): string {
  return routes
    .map((route) => `${route.routeId}\0${route.routeGeneration}`)
    .sort()
    .join('\n');
}

const EMPTY_PROFILE: MacosRemoteDesktopRuntimeProfile = Object.freeze({
  mode: MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE,
  sessionCapabilities: Object.freeze([]),
  adapterCapabilities: Object.freeze([]),
});

function authenticationTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_AUTHENTICATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout)
    || timeout < MIN_AUTHENTICATION_TIMEOUT_MS
    || timeout > MAX_AUTHENTICATION_TIMEOUT_MS) {
    throw new Error('macos_remote_desktop_worker_host_invalid_timeout');
  }
  return timeout;
}

function readinessPollMs(value: number | undefined): number {
  const interval = value ?? DEFAULT_READINESS_POLL_MS;
  if (!Number.isSafeInteger(interval)
    || interval < MIN_READINESS_POLL_MS
    || interval > MAX_READINESS_POLL_MS) {
    throw new Error('macos_remote_desktop_worker_host_invalid_readiness_poll');
  }
  return interval;
}

/**
 * The identity the per-session IPC socket must admit: the WORKER's. See
 * MACOS_REMOTE_DESKTOP_WORKER_IDENTITY for why it is not the agent's.
 */
function expectedWorkerIdentity(
  artifact: VerifiedMacosRemoteDesktopArtifact,
): MacosRemoteDesktopExpectedCodeIdentity {
  const manifest = artifact.manifest;
  const identity = manifest.codeSignature.bundles.worker;
  const component = artifact.components.worker;
  if (identity.bundleIdentifier !== MACOS_REMOTE_DESKTOP_WORKER_IDENTITY.bundleIdentifier
    || component.bundleIdentifier !== identity.bundleIdentifier
    || component.designatedRequirement !== identity.designatedRequirement) {
    throw new Error('macos_remote_desktop_worker_host_invalid_artifact');
  }
  return Object.freeze({
    bundleIdentifier: MACOS_REMOTE_DESKTOP_WORKER_IDENTITY.bundleIdentifier,
    teamId: manifest.codeSignature.teamId,
    designatedRequirement: identity.designatedRequirement,
  });
}

function expectedIdentity(
  artifact: VerifiedMacosRemoteDesktopArtifact,
  runtime: { platform: NodeJS.Platform; arch: string },
): MacosRemoteDesktopExpectedCodeIdentity {
  const manifest = artifact.manifest;
  const identity = manifest.codeSignature.bundles.launchAgent;
  const component = artifact.components.launchAgent;
  if (runtime.platform !== 'darwin'
    || (runtime.arch !== 'arm64' && runtime.arch !== 'x64')
    || manifest.os !== runtime.platform
    || manifest.arch !== runtime.arch
    || identity.bundleIdentifier !== MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier
    || component.bundleIdentifier !== identity.bundleIdentifier
    || component.designatedRequirement !== identity.designatedRequirement) {
    throw new Error('macos_remote_desktop_worker_host_invalid_artifact');
  }
  return Object.freeze({
    bundleIdentifier: identity.bundleIdentifier,
    teamId: manifest.codeSignature.teamId,
    designatedRequirement: identity.designatedRequirement,
  });
}

function waitForAuthentication(
  promise: Promise<MacosRemoteDesktopIpcLaunch>,
  timeoutMs: number,
): Promise<MacosRemoteDesktopIpcLaunch> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('macos_remote_desktop_worker_host_authentication_timeout'));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (launch) => {
        clearTimeout(timer);
        resolve(launch);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Root-daemon orchestration for one authenticated macOS GUI worker generation.
 * The node credential is intentionally absent from this API and never crosses
 * the per-user IPC boundary; only bounded route commands reach the worker.
 */
export class MacosRemoteDesktopWorkerHost {
  private readonly core: RemoteDesktopWorkerHostCore<null>;
  private profile = EMPTY_PROFILE;
  private authority: MacosRemoteDesktopIpcAuthorityHost | null = null;
  private ipcServer: MacosRemoteDesktopIpcTransport | null = null;
  private displayReadiness = false;
  /** Strictly increasing, so an answer can never be replayed as fresh. */
  private displayNonce = 0;
  private virtualDisplayAuthority: {
    lease: () => MacosVirtualDisplayProxyLease | null;
    seams: MacosVirtualDisplayProxySeams;
    close: () => Promise<void>;
  } | null = null;
  private supervisor: MacosRemoteDesktopLaunchSupervisor | null = null;
  private unsubscribeLifecycle: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private pendingAuthentication: {
    generation: number;
    reject(error: unknown): void;
  } | null = null;
  private teardownPromise: Promise<void> = Promise.resolve();
  /**
   * Automatic-restart timestamps, one host-lifetime window -- NOT the
   * per-generation supervisor's own crash counter. A fresh
   * `MacosRemoteDesktopLaunchAgentSupervisor` is constructed on every
   * `start()`, including every restart this class itself issues below, so its
   * internal `crashTimes` resets on each cycle and its breaker never
   * accumulates enough history to trip. A resident agent whose worker keeps
   * dying immediately (observed: a CoreMedia/VideoToolbox setup failure that
   * exits the worker in well under a second, over and over) produced an
   * unthrottled restart every ~1.3s here, forever, with launchctl
   * bootstrap/kickstart the whole time it ran -- this is the guard that
   * should have stopped it.
   *
   * Shared across BOTH automatic-restart triggers this host has -- the
   * lifecycle-event 'agent_crash' path AND the IPC socket's own `onDisconnect`
   * restart (reason 'peer_disconnected' / 'write_failed' / 'callback_failed').
   * The second one was found live on node mini-2, still completely
   * unthrottled after the first fix: an authenticated worker that fails
   * during its OWN encoder/CoreMedia setup (after authenticating, so
   * `restart` below was already true) disconnects with `peer_disconnected`,
   * which is not `agent_crash` and so never touched the original,
   * narrower-named counter -- three fresh worker processes were observed
   * spawning within about one second before the underlying failure finally
   * surfaced to the browser as `worker_failed`. Both triggers mean the exact
   * same thing to an operator -- "this host just auto-restarted a worker
   * that failed on its own, not by user or system request" -- so they share
   * one budget rather than each getting their own 3-per-60s allowance.
   */
  private readonly autoRestartTimes: number[] = [];
  private lifecycleGeneration = 0;
  private connectionGeneration = 0;
  private activeWorkerGeneration = 0;
  /** Never decreases: see `workerGenerationFloor`. */
  private highestWorkerGeneration = 0;
  /** Generations whose termination was observed, not inferred from cleanup text. */
  private readonly terminatedWorkerGenerations = new Set<number>();
  /** Routes whose STOP/CANCEL was sent but whose terminal proof has not arrived. */
  private readonly stoppingSessions = new Set<string>();
  /** Preserve the last good profile only across one proven normal replacement. */
  private preserveProfileForNextStart = false;
  private retainedProfileStartGeneration: number | null = null;
  private serviceGeneration = 0;
  private authenticated = false;
  private closed = false;
  private activeArtifact: VerifiedMacosRemoteDesktopArtifact | null = null;
  private activeUser: MacosUserSession | null = null;
  private activePrincipal: MacosRemoteDesktopGraphicalSessionAuthority | null = null;
  private readinessTimer: NodeJS.Timeout | null = null;
  /**
   * Management-privacy epoch. Set the moment a SHIELD arrives, cleared only
   * after RELEASED was emitted: while it exists every worker this host admits
   * is shielded before it receives any command.
   */
  private privacy: MacosPrivacyState | null = null;
  private readonly privacySubscribers = new Set<(frame: WorkerPrivacyInboundFrame) => void>();
  /** Privacy operations and worker admission run strictly one after another. */
  private privacyTail: Promise<unknown> = Promise.resolve();
  private nextPrivacyRequestId = 0;
  private readonly pendingPrivacyReplies = new Map<number, PendingPrivacyReply>();
  /**
   * Host-monotonic frame generation. A worker counts real frames from zero,
   * so each worker generation is offset by a base above everything already
   * reported; the value never goes backwards across worker restarts.
   */
  private privacyFrameBase: { workerGeneration: number; base: number } | null = null;
  private lastPrivacyFrameGeneration = 0;

  constructor(
    private readonly onMessage: (message: RemoteDesktopDaemonMessage) => void,
    private readonly options: MacosRemoteDesktopWorkerHostOptions,
  ) {
    this.core = new RemoteDesktopWorkerHostCore({
      nonce: randomBytes(32).toString('base64url'),
      prepareReadyTimeoutMs: options.prepareReadyTimeoutMs,
      offerAnswerTimeoutMs: options.offerAnswerTimeoutMs,
      onWatchdogTimeout: (event) => {
        this.emit(event.terminal);
        this.invalidateAuthority();
        void this.shutdownResources();
      },
      // A removed route changes the set a shielded epoch must report.
      onAuthorityRemoved: () => this.emitShieldedUpdate(),
    });
  }

  /** Verify, launch, authenticate, and only then expose capabilities. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('macos_remote_desktop_worker_host_closed'));
    if (this.authenticated) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const generation = ++this.lifecycleGeneration;
    if (this.preserveProfileForNextStart) {
      this.preserveProfileForNextStart = false;
      this.retainedProfileStartGeneration = generation;
    }
    const start = this.startGeneration(generation);
    const memo = start.finally(() => {
      if (this.startPromise === memo) this.startPromise = null;
    });
    this.startPromise = memo;
    return memo;
  }

  available(): boolean {
    const replacementRetainsProfile = this.preserveProfileForNextStart
      || this.retainedProfileStartGeneration !== null;
    return !this.closed
      && (this.authenticated || replacementRetainsProfile)
      && this.profile.mode !== MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE;
  }

  /** Whether this host can keep a sign-in secret at all. */
  supportsAutoUnlock(): boolean {
    return this.options.unlockSecretStore !== undefined;
  }

  /**
   * Stores (or with null, clears) the sign-in secret. It stays with this root
   * process; a worker receives it only for an unlock the controller requested.
   */
  async applyAutoUnlockSecret(secret: string | null): Promise<boolean> {
    const store = this.options.unlockSecretStore;
    if (!store) return false;
    return secret === null ? await store.clear() : await store.store(secret);
  }

  /** Whether a sign-in secret is stored, without handing its value anywhere. */
  async autoUnlockConfigured(): Promise<boolean> {
    return await this.options.unlockSecretStore?.configured() ?? false;
  }

  sessionCapabilities(): readonly string[] {
    return this.available() ? this.profile.sessionCapabilities : Object.freeze([]);
  }

  /**
   * The macOS worker remembers the shield across session starts and applies it
   * to every source it creates later, and this host shields every newly
   * admitted worker before forwarding its first command.
   */
  supportsDefaultShieldedRoute(): boolean {
    return true;
  }

  onPrivacyFrame(handler: (frame: WorkerPrivacyInboundFrame) => void): () => void {
    this.privacySubscribers.add(handler);
    return () => { this.privacySubscribers.delete(handler); };
  }

  /**
   * SHIELD/RELEASE from the privacy barrier. Resolves only after the matching
   * SHIELDED/RELEASED was emitted, or false when it could not be proven -- in
   * which case nothing is emitted and the barrier fails closed.
   */
  sendPrivacyFrame(frame: Record<string, unknown>): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (frame.type === WORKER_PRIVACY_FRAME.SHIELD) return this.shield(frame);
    if (frame.type === WORKER_PRIVACY_FRAME.RELEASE) return this.release(frame);
    return Promise.resolve(false);
  }

  adapterCapabilities(): readonly RemoteDesktopAdapterCapability[] {
    return this.available() ? this.profile.adapterCapabilities : Object.freeze([]);
  }

  async handle(message: unknown): Promise<boolean> {
    const parsed = validateRemoteDesktopDaemonCommand(message);
    if (!parsed.ok || !this.available()) return false;
    const command = parsed.value;
    if (command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      // Marked BEFORE the readiness re-check. That check launches a native
      // process and takes seconds, and the browser sends its OFFER the moment it
      // is authorized; arriving while no preparing marker existed, the OFFER
      // found no session and was answered worker_failed. The Windows host
      // already marks first.
      const finishPreparing = this.core.beginPreparing(command.sessionId);
      // A route arriving while the replacement generation is still launching
      // waits for it rather than being refused (see REPLACEMENT_WORKER_WAIT_MS).
      if (!this.authenticated && !await this.waitForReplacementWorker()) {
        finishPreparing();
        return false;
      }
      const generation = this.lifecycleGeneration;
      if (!await this.revalidateReadinessForPrepare(command.mode, generation)) {
        finishPreparing();
        return false;
      }
      try {
        // TERMINAL proves only that the previous session ended. A worker may
        // accept another route without restarting, so admitting a new
        // authority on the same generation revokes that old proof before the
        // command can be tracked or sent. Both expected-exit classification
        // and cleanup downgrade consult this one proof set.
        this.markWorkerActive(this.activeWorkerGeneration);
        this.core.track(command, null);
        const sent = await this.sendCurrent(command, generation);
        if (!sent) this.core.untrack(command.sessionId);
        else {
          this.core.armPrepareReadyTimer(command.sessionId, {
            connectionGeneration: this.connectionGeneration,
            workerPid: null,
          });
          // The worker applies its remembered shield to the new source; the
          // epoch's complete route set grew by this route.
          this.emitShieldedUpdate();
        }
        return sent;
      } catch (error) {
        this.core.untrack(command.sessionId);
        throw error;
      } finally {
        finishPreparing();
      }
    }

    if (command.type !== REMOTE_DESKTOP_MSG.STOP
      && command.type !== REMOTE_DESKTOP_MSG.CANCEL) {
      await this.core.waitForPreparing(command.sessionId);
    }
    const generation = this.lifecycleGeneration;
    if (!this.core.has(command.sessionId)) return false;
    if (this.stoppingSessions.has(command.sessionId)
      && command.type !== REMOTE_DESKTOP_MSG.STOP
      && command.type !== REMOTE_DESKTOP_MSG.CANCEL) return false;
    if (command.type === REMOTE_DESKTOP_MSG.OFFER) {
      this.core.markOfferPending(command.sessionId, {
        connectionGeneration: this.connectionGeneration,
        workerPid: null,
      });
    }
    const sent = await this.sendCurrent(command, generation);
    if (sent && (command.type === REMOTE_DESKTOP_MSG.STOP
      || command.type === REMOTE_DESKTOP_MSG.CANCEL)) {
      // Keep the bounded route authority only long enough to authenticate the
      // worker's TERMINAL. Untracking here discarded that proof, making every
      // subsequent normal peer exit indistinguishable from a crash.
      this.stoppingSessions.add(command.sessionId);
    }
    return sent;
  }

  /**
   * Resolves true once a worker generation is authenticated, or false when none
   * is coming: the host closed, withdrew its profile, or the bound elapsed.
   */
  private async waitForReplacementWorker(): Promise<boolean> {
    const deadline = Date.now() + REPLACEMENT_WORKER_WAIT_MS;
    while (!this.authenticated) {
      if (this.closed || !this.available() || Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, REPLACEMENT_WORKER_POLL_MS));
    }
    return !this.closed;
  }

  /**
   * A Server-link generation ended, but the verified local sidecar may remain
   * warm. Retire every route and emitted input without destroying the adapter
   * profile needed by the reconnecting authenticated socket.
   */
  onDaemonDisconnected(): void {
    if (this.closed || !this.authenticated) return;
    // Nothing open: leave the warm worker alone. Sending it stop-capture with
    // no session running stopped its session object for good, so the next
    // PREPARE was refused -- and every capability change reconnects the link,
    // so every session after the first failed.
    if (this.core.authorities().size === 0) return;
    // Routes were open: capture and input are released, and that worker's
    // session cannot be started again, so a fresh generation replaces it.
    const cleanupSettled = this.runLocalCleanup(MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.DAEMON_DISCONNECTED);
    this.failTrackedRoutes();
    this.invalidateForLifecycle(this.lifecycleGeneration, true, cleanupSettled);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPendingAuthentication(this.lifecycleGeneration);
    ++this.lifecycleGeneration;
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = null;
    const cleanupSettled = this.runLocalCleanup('close');
    // Authority is revoked immediately; the worker survives until release/stop
    // settle (bounded) so close() cannot amputate an in-flight cleanup.
    this.invalidateAuthority();
    void this.shutdownResources(cleanupSettled);
  }

  private async startGeneration(generation: number): Promise<void> {
    try {
      await this.teardownPromise;
      if (!this.isCurrent(generation)) return;
      const artifact = await this.options.resolveVerifiedArtifact();
      if (!artifact || !this.isCurrent(generation)) return;
      const identity = expectedIdentity(artifact, this.options.runtime ?? {
        platform: process.platform,
        arch: process.arch,
      });
      const principal = this.options.resolveGraphicalSessionAuthority
        ? await this.options.resolveGraphicalSessionAuthority()
        : null;
      const principalBinding = principal
        ? macosRemoteDesktopIpcPrincipalBinding(principal)
        : null;
      const user = principal
        ? principal.kind === 'aqua_user' ? principal.user : null
        : await this.options.resolveUserSession();
      if (user) assertMacosUserSession(user);
      if (!this.isCurrent(generation)) return;
      const explicitPeerSeams = this.options.inspectPeerUid && this.options.verifyPeerCodeIdentity
        ? {
          inspectPeerUid: this.options.inspectPeerUid,
          verifyPeerCodeIdentity: this.options.verifyPeerCodeIdentity,
        }
        : null;
      if ((this.options.inspectPeerUid === undefined)
        !== (this.options.verifyPeerCodeIdentity === undefined)) {
        throw new Error('macos_remote_desktop_worker_host_incomplete_peer_verifier');
      }
      if (principal && !this.options.inspectPeerGraphicalSession) {
        throw new Error('macos_remote_desktop_worker_host_graphical_peer_observer_unavailable');
      }
      const peerSeams = explicitPeerSeams
        ?? (this.options.createPeerVerificationSeams
          ?? createMacosRemoteDesktopNativePeerVerificationSeams)({
          executablePath: artifact.components.launchAgent.executablePath,
          expectedUid: principalBinding?.uid ?? user!.uid,
          ...(principalBinding
            ? { expectedAuditSessionId: principalBinding.auditSessionId }
            : {}),
          expectedCodeIdentity: identity,
        });
      // Per-user sessions: the resident agent spawns the worker, and the worker
      // is the peer on the IPC socket. The global-bootstrap path (off by
      // default, kept for later LoginWindow work) keeps its original contract.
      const workerIdentity = principal ? identity : expectedWorkerIdentity(artifact);
      const ipcPeerSeams = principal ? peerSeams : explicitPeerSeams
        ?? (this.options.createPeerVerificationSeams
          ?? createMacosRemoteDesktopNativePeerVerificationSeams)({
          executablePath: artifact.components.launchAgent.executablePath,
          expectedUid: principalBinding?.uid ?? user!.uid,
          ...(principalBinding
            ? { expectedAuditSessionId: principalBinding.auditSessionId }
            : {}),
          expectedCodeIdentity: workerIdentity,
        });
      // PHASE 1 -- PREFLIGHT. Only the items that are independent of the
      // resident agent: TCC, encoder, disclosure, the verified artifact and the
      // qualified user. Display control is deliberately absent, because the
      // only thing that can answer it truthfully is an agent that does not
      // exist yet. This profile is a fail-fast gate; it is NEVER advertised.
      let localReadiness = principal?.kind === 'loginwindow_bootstrap'
        ? null
        : await this.inspectLocalReadiness(artifact, principal, user);
      if (localReadiness) {
        const preflightProfile = resolveMacosRemoteDesktopRuntimeProfile({
          capturePrivacy: this.options.capturePrivacy,
          artifactVerified: true,
          activeUserQualified: true,
          ...localReadiness,
          virtualDisplay: false,
        });
        if (preflightProfile.mode === MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE) {
          // Said out loud. Returning here is correct -- nothing can be offered --
          // but it returned silently, so a Mac whose worker could not see an
          // encoder or its disclosure surface looked exactly like one that was
          // still starting: no error, no capability, a reinstall every retry.
          // Booleans only; readiness carries no identity or secret.
          this.options.onBackgroundError?.(new Error(
            `macos_remote_desktop_preflight_unavailable:${Object.entries(localReadiness)
              .map(([key, value]) => `${key}=${String(value)}`).join(',')}`,
          ));
          return;
        }
        if (!this.isCurrent(generation)) return;
      }
      if (this.options.lifecycleSource && this.unsubscribeLifecycle === null) {
        this.unsubscribeLifecycle = this.options.lifecycleSource.subscribe((event) => {
          this.handleLifecycleEvent(event);
        });
      }

      const authority = new MacosRemoteDesktopIpcAuthorityHost({
        ...(principal ? { principal } : { user: user! }),
        expectedCodeIdentity: workerIdentity,
        runtimeRoot: this.options.runtimeRoot,
        workerGenerationFloor: this.highestWorkerGeneration,
      });
      let resolveAuthenticated!: (launch: MacosRemoteDesktopIpcLaunch) => void;
      let rejectAuthenticated!: (error: unknown) => void;
      const authenticated = new Promise<MacosRemoteDesktopIpcLaunch>((resolve, reject) => {
        resolveAuthenticated = resolve;
        rejectAuthenticated = reject;
      });
      const authenticationWait = waitForAuthentication(
        authenticated,
        authenticationTimeout(this.options.authenticationTimeoutMs),
      );
      // LaunchAgent setup can fail or outlive the authentication deadline
      // before this generation reaches the explicit await below. Attach a
      // rejection observer immediately so a bounded auth failure never becomes
      // an unhandled rejection while the supervisor is still transitioning.
      void authenticationWait.catch(() => undefined);
      this.pendingAuthentication = { generation, reject: rejectAuthenticated };
      const commonServerOptions = {
        authority,
        expectedCodeIdentity: workerIdentity,
        runtimeRoot: this.options.runtimeRoot,
        inspectPeerUid: ipcPeerSeams.inspectPeerUid,
        verifyPeerCodeIdentity: ipcPeerSeams.verifyPeerCodeIdentity,
        onPeerAuthenticated: (launch, session) => {
          if (!this.isCurrent(generation)) return;
          if (principalBinding
            && !this.sessionMatchesGraphicalLaunch(session, launch, principalBinding)) {
            rejectAuthenticated(new Error(
              'macos_remote_desktop_worker_host_graphical_principal_mismatch',
            ));
            return;
          }
          this.connectionGeneration = this.core.beginConnection();
          resolveAuthenticated(launch);
        },
        onGraphicalReadinessAttestation: principal?.kind === 'loginwindow_bootstrap'
          ? async (encoded: string) => {
            if (!this.options.inspectGraphicalReadiness) {
              throw new Error('macos_remote_desktop_loginwindow_readiness_unavailable');
            }
            localReadiness = await this.options.inspectGraphicalReadiness(
              artifact,
              principal,
              encoded,
            );
          }
          : undefined,
        onWorkerMessage: (message) => this.onWorkerMessage(message, generation),
        onPrivacyReply: (reply) => this.onPrivacyReply(reply, generation),
        // Injected, so a display request reaches the agent instead of being
        // answered `agent_unavailable` by a server with no lease to ask.
        virtualDisplayLease: () => this.virtualDisplayAuthority?.lease() ?? null,
        unlockSecret: this.options.unlockSecretStore,
        virtualDisplaySeams: {
          exchange: async (lease, line, timeoutMs) => await (
            this.virtualDisplayAuthority?.seams.exchange(lease, line, timeoutMs)
            ?? Promise.resolve(null)
          ),
        },
        onDisconnect: (reason, error) => {
          if (!this.isCurrent(generation)) return;
          const workerGeneration = this.activeWorkerGeneration;
          const expectedWorkerExit = reason === 'peer_disconnected'
            && workerGeneration > 0
            && this.hasWorkerTerminationProof(workerGeneration);
          if (expectedWorkerExit) {
            this.options.onLifecycleNotice?.({
              kind: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_NOTICE_KIND.EXPECTED_WORKER_EXIT,
              workerGeneration,
            });
            this.invalidateForLifecycle(generation, true, Promise.resolve(), true);
            return;
          }
          this.options.onBackgroundError?.(error ?? new Error(`macos_remote_desktop_worker_disconnected:${reason}`));
          // Reached only when hasWorkerTerminationProof() above was false --
          // i.e. no TERMINAL ever arrived for this generation. The native
          // worker's own SignalTerminal() is a no-op without a bound
          // authority (see WorkerTransportSink::SignalTerminal), so a worker
          // that authenticated but never received a real PREPARE (no browser
          // peer ever asked for it) closes silently: this is that generation's
          // own "connection_never_established" watchdog cleanly retiring
          // itself, not a session getting interrupted. Restarting it
          // immediately respawns a fresh worker -- and its disclosure
          // overlay, unconditionally visible from the instant the process
          // starts -- purely to idle for another 60s and repeat: an endless,
          // user-visible "1 viewing" flash with nobody ever connected. A
          // generation that DID carry a real tracked session still restarts
          // immediately, exactly as before.
          const failureTriggeredRestart = this.authenticated && this.core.authorities().size > 0 && (
            reason === 'peer_disconnected'
            || reason === 'write_failed'
            || reason === 'callback_failed'
          );
          // Live evidence on node mini-2: a worker that authenticates fine and
          // only THEN fails during its own encoder/CoreMedia setup disconnects
          // with `peer_disconnected` -- `failureTriggeredRestart` above is
          // true, same as a real session's peer going away, and nothing here
          // previously bounded how many times that can repeat. Three fresh
          // worker processes were observed spawning within about a second
          // before the browser ever saw a terminal frame. Same shared budget
          // as the 'agent_crash' path (see `autoRestartTimes`) -- both mean
          // "this host just auto-restarted a worker that failed on its own."
          const restart = failureTriggeredRestart && this.allowAutomaticRestart();
          if (failureTriggeredRestart && !restart) {
            this.options.onBackgroundError?.(
              new Error('macos_remote_desktop_worker_host_disconnect_restart_loop'),
            );
          }
          this.invalidateForLifecycle(generation, restart);
        },
      } satisfies Omit<MacosRemoteDesktopIpcServerOptions,
        'principal' | 'user' | 'inspectPeerGraphicalSession'>;
      const serverOptions: MacosRemoteDesktopIpcServerOptions = principal
        ? {
          ...commonServerOptions,
          principal,
          inspectPeerGraphicalSession: this.options.inspectPeerGraphicalSession!,
        }
        : { ...commonServerOptions, user: user! };
      const server = (this.options.createIpcServer
        ?? ((options) => new MacosRemoteDesktopIpcServer(options)))(serverOptions);
      this.authority = authority;
      this.ipcServer = server;
      // Started BEFORE the worker is launched, so the agent's lease and grant
      // exist by the time a worker can ask anything. Failing to start it is not
      // fatal to the session: capture and input still work, and display
      // requests refuse rather than the whole generation dying.
      if (this.options.startVirtualDisplayAuthority && user) {
        try {
          this.virtualDisplayAuthority =
            await this.options.startVirtualDisplayAuthority({
              artifact,
              user,
              identity,
              // Only the full native seams can verify the AGENT; the narrow
              // test seams verify a worker socket and have no `verifyPeer`.
              // Absent means production refuses to start authority rather than
              // admitting an agent nobody checked.
              //
              // The predicate is `typeof === 'function'`, matching the
              // listener's own check exactly. `'verifyPeer' in seams` would
              // admit `{ verifyPeer: undefined }`, which the listener then
              // rejects -- two gates disagreeing about the same word is how a
              // narrow seam reaches production and dies one layer later.
              verification: typeof (peerSeams as Partial<
                MacosRemoteDesktopNativePeerVerificationSeams>).verifyPeer === 'function'
                ? peerSeams as MacosRemoteDesktopNativePeerVerificationSeams
                : undefined,
            }, {
              onAuthorityLost: () => {
                // Production call, not just a getter that starts returning
                // null: requests already dispatched must be failed, not left
                // waiting on a principal that is gone.
                this.ipcServer?.revokeVirtualDisplayChannel?.();
              },
            });
        } catch (error) {
          this.virtualDisplayAuthority = null;
          this.options.onBackgroundError?.(
            error instanceof Error ? error : new Error(String(error)));
        }
        if (!this.isCurrent(generation)) return;
      }
      const launch = await server.start();
      this.highestWorkerGeneration = Math.max(this.highestWorkerGeneration, launch.workerGeneration);
      if (!this.isCurrent(generation)) return;
      this.activeWorkerGeneration = launch.workerGeneration;

      if (principal) {
        if (!this.options.onGraphicalIpcLaunch) {
          throw new Error('macos_remote_desktop_worker_host_graphical_launch_unavailable');
        }
        await this.options.onGraphicalIpcLaunch(principal, launch);
      } else {
        const supervisor = (this.options.createLaunchAgentSupervisor
          ?? ((dependencies) => new MacosRemoteDesktopLaunchAgentSupervisor(dependencies)))({
          artifact,
          resolveUserSession: async () => user!,
          beginIpcLaunch: () => launch,
          // Server owns this generation. Supervisor invalidation only retires
          // route/UI state; host lifecycle cleanup revokes the IPC authority.
          markAuthorityUnavailable: () => this.clearAdvertisedProfile(
            this.retainedProfileStartGeneration === generation,
          ),
          releaseInput: () => ({ ok: true }),
          stopCapture: () => ({ ok: true }),
          invalidateRoutes: () => this.failTrackedRoutes(),
          ...(this.options.resolveLaunchAgentExecutable
            ? { resolveLauncherExecutable: this.options.resolveLaunchAgentExecutable }
            : {}),
          onBackgroundError: this.options.onBackgroundError,
        });
        this.supervisor = supervisor;
        const snapshot = await supervisor.start();
        if (snapshot.workerGeneration !== launch.workerGeneration
          || snapshot.socketPath !== launch.socketPath) {
          throw new Error('macos_remote_desktop_worker_host_generation_mismatch');
        }
      }
      const peerLaunch = await authenticationWait;
      if (this.pendingAuthentication?.generation === generation) {
        this.pendingAuthentication = null;
      }
      if (!this.isCurrent(generation)
        || peerLaunch.workerGeneration !== launch.workerGeneration
        || peerLaunch.socketPath !== launch.socketPath) return;
      if (!localReadiness) {
        throw new Error('macos_remote_desktop_loginwindow_readiness_unavailable');
      }
      this.activeArtifact = artifact;
      this.activeUser = user;
      this.activePrincipal = principal;
      // Re-assert the live worker generation. It is first set before the
      // supervisor starts, but `markAuthorityUnavailable` runs during that
      // start and clears the advertised profile -- which also zeroed this
      // field, leaving the steady state at 0. Anything keyed on the live
      // generation (agent_crash filtering, generation-bound cleanup) silently
      // degraded to "whatever is live" as a result.
      this.activeWorkerGeneration = peerLaunch.workerGeneration;
      // Admission runs in the privacy queue: while an epoch is shielded the new
      // worker is shielded BEFORE it becomes authenticated, and nothing is
      // forwarded to a worker that is not authenticated. A SHIELD/RELEASE that
      // arrives meanwhile is ordered strictly before or after this admission.
      const admitted = await this.enqueuePrivacy(async () => {
        if (!this.isCurrent(generation)) return false;
        if (this.privacy) {
          const reply = await this.requestPrivacy(
            server, peerLaunch.workerGeneration, true, generation,
          );
          if (!reply || !reply.shielded || !reply.inputReleased
            || !this.isCurrent(generation)) return false;
          this.privacyFrameGeneration(reply.workerGeneration, reply.realFrameGeneration);
        }
        this.authenticated = true;
        return true;
      });
      if (!this.isCurrent(generation)) return;
      if (!admitted) {
        throw new Error('macos_remote_desktop_worker_host_privacy_shield_failed');
      }
      // PHASE 2 -- ask the live agent, on the lease it is already holding.
      //
      // This is the only point at which display control can be answered
      // honestly: the listener is up, the agent has authenticated and been
      // granted, and the question is a zero-mutation status round trip on that
      // same lease. The preflight profile above is discarded rather than
      // widened, so nothing is ever advertised before its evidence exists.
      this.displayReadiness = await this.probeVirtualDisplayReadiness();
      if (!this.isCurrent(generation)) return;
      const profile = resolveMacosRemoteDesktopRuntimeProfile({
          capturePrivacy: this.options.capturePrivacy,
        artifactVerified: true,
        activeUserQualified: true,
        ...localReadiness,
        virtualDisplay: this.displayReadiness,
      });
      if (profile.mode === MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE) {
        // An authenticated worker that still offers nothing. Said, not silent:
        // the worker is running and the button never appears.
        this.options.onBackgroundError?.(new Error(
          `macos_remote_desktop_profile_unavailable:${Object.entries(localReadiness)
            .map(([key, value]) => `${key}=${String(value)}`).join(',')},virtualDisplay=${String(this.displayReadiness)}`,
        ));
        return;
      }
      if (this.retainedProfileStartGeneration === generation) {
        this.retainedProfileStartGeneration = null;
      }
      this.setAdvertisedProfile(profile);
      this.scheduleReadinessPoll(generation);
    } catch (error) {
      this.cancelPendingAuthentication(generation);
      if (this.isCurrent(generation)) {
        this.options.onBackgroundError?.(error);
        this.invalidateAuthority();
        await this.shutdownResources();
      }
    } finally {
      // A retained profile bridges only one proven normal replacement. If the
      // replacement cannot authenticate and publish, withdraw it rather than
      // advertising stale capability forever.
      if (this.retainedProfileStartGeneration === generation) {
        this.retainedProfileStartGeneration = null;
        this.clearAdvertisedProfile();
      }
    }
  }

  private async sendCurrent(
    command: RemoteDesktopDaemonCommand,
    generation: number,
  ): Promise<boolean> {
    const server = this.ipcServer;
    if (!server || !this.isCurrent(generation) || !this.authenticated) return false;
    await server.sendCommand(command);
    return this.isCurrent(generation) && this.authenticated;
  }

  private sessionMatchesGraphicalLaunch(
    session: MacosRemoteDesktopIpcSession,
    launch: MacosRemoteDesktopIpcLaunch,
    expected: MacosRemoteDesktopIpcPrincipalBinding,
  ): boolean {
    return session.workerGeneration === launch.workerGeneration
      && session.socketPath === launch.socketPath
      && session.launchNonce === launch.challenge
      && session.principal.kind === expected.kind
      && session.principal.sessionType === expected.sessionType
      && session.principal.uid === expected.uid
      && session.principal.auditSessionId === expected.auditSessionId
      && session.principal.pidVersion === expected.pidVersion;
  }

  private async inspectLocalReadiness(
    artifact: VerifiedMacosRemoteDesktopArtifact,
    principal: MacosRemoteDesktopGraphicalSessionAuthority | null,
    user: MacosUserSession | null,
  ): Promise<LocalReadiness> {
    if (principal && this.options.inspectGraphicalReadiness) {
      return await this.options.inspectGraphicalReadiness(artifact, principal);
    }
    if (user) return await this.options.inspectReadiness(artifact, user);
    throw new Error('macos_remote_desktop_loginwindow_readiness_unavailable');
  }

  /**
   * Route admission re-probes the local disclosure/TCC boundary. A generation
   * may narrow from Control to View, but it never widens after its Server auth
   * advertisement. Losing any mandatory surface retires the generation.
   */
  private async revalidateReadinessForPrepare(
    mode: typeof REMOTE_DESKTOP_ACCESS_MODE[keyof typeof REMOTE_DESKTOP_ACCESS_MODE],
    generation: number,
  ): Promise<boolean> {
    const artifact = this.activeArtifact;
    const user = this.activeUser;
    const principal = this.activePrincipal;
    if (!artifact || (!user && !principal)
      || !this.isCurrent(generation) || !this.authenticated) return false;

    let next: MacosRemoteDesktopRuntimeProfile;
    try {
      const localReadiness = await this.inspectLocalReadiness(artifact, principal, user);
      // The same two phases on every refresh. Recomputing from the preflight
      // items alone would drop display control on the first poll after it was
      // advertised, and a profile that narrows is treated as a readiness loss
      // -- so the session would tear itself down seconds after starting.
      this.displayReadiness = await this.probeVirtualDisplayReadiness();
      next = resolveMacosRemoteDesktopRuntimeProfile({
          capturePrivacy: this.options.capturePrivacy,
        artifactVerified: true,
        activeUserQualified: true,
        ...localReadiness,
        virtualDisplay: this.displayReadiness,
      });
    } catch (error) {
      this.options.onBackgroundError?.(error);
      next = EMPTY_PROFILE;
    }
    if (!this.isCurrent(generation) || !this.authenticated) return false;
    const current = this.profile;
    const currentCanControl = current.adapterCapabilities.includes(REMOTE_DESKTOP_INPUT_CAPABILITY);
    const nextCanControl = next.adapterCapabilities.includes(REMOTE_DESKTOP_INPUT_CAPABILITY);
    // Never widen a profile after the Server authenticated this connection --
    // but a grant that arrives while nobody is connected must not stay
    // invisible either. Accessibility granted a few seconds after Screen
    // Recording left the Mac view-only until the node happened to restart. With
    // no route open, retiring this generation and starting a fresh one
    // advertises the wider profile on a new authentication instead of widening
    // the old one.
    if (!currentCanControl && nextCanControl && this.core.authorities().size === 0) {
      this.invalidateForLifecycle(generation, true);
      return false;
    }
    const effective = !currentCanControl && nextCanControl ? current : next;
    const changed = current.mode !== effective.mode
      || current.sessionCapabilities.join('\0') !== effective.sessionCapabilities.join('\0')
      || current.adapterCapabilities.join('\0') !== effective.adapterCapabilities.join('\0');
    if (next.mode === MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE
      || (changed && !(nextCanControl && !currentCanControl))) {
      const cleanupSettled = this.runLocalCleanup(
        MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED,
      );
      this.invalidateForLifecycle(generation, true, cleanupSettled);
      return false;
    }
    if (mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL
      && !this.profile.adapterCapabilities.includes(REMOTE_DESKTOP_INPUT_CAPABILITY)) {
      return false;
    }
    return true;
  }

  private scheduleReadinessPoll(generation: number): void {
    this.clearReadinessPoll();
    const timer = setTimeout(() => {
      if (this.readinessTimer === timer) this.readinessTimer = null;
      void this.pollReadiness(generation);
    }, readinessPollMs(this.options.readinessPollMs));
    timer.unref?.();
    this.readinessTimer = timer;
  }

  private async pollReadiness(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || !this.authenticated) return;
    const ready = await this.revalidateReadinessForPrepare(
      REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      generation,
    );
    if (ready && this.isCurrent(generation) && this.authenticated) {
      this.scheduleReadinessPoll(generation);
    }
  }

  private clearReadinessPoll(): void {
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
  }

  private onWorkerMessage(message: RemoteDesktopDaemonMessage, generation: number): void {
    if (!this.isCurrent(generation) || !this.authenticated || this.connectionGeneration === 0) return;
    const result = this.core.pushInbound(
      this.core.frameOutbound(message),
      this.connectionGeneration,
    );
    if (result.overflow) {
      this.invalidateForLifecycle(generation);
      return;
    }
    for (const event of result.events) {
      if (event.kind !== 'message') continue;
      this.emit(event.value);
      if (event.value.type === REMOTE_DESKTOP_MSG.TERMINAL) {
        this.markWorkerTerminated(this.activeWorkerGeneration);
        this.stoppingSessions.delete(event.value.sessionId);
        this.core.untrack(event.value.sessionId);
      }
    }
  }

  /**
   * Bounds how many automatic, failure-triggered restarts this host will
   * issue in a rolling window -- 'agent_crash' lifecycle events AND
   * `onDisconnect`'s own 'peer_disconnected'/'write_failed'/'callback_failed'
   * restart, both funneled through this one shared budget (see
   * `autoRestartTimes`'s own doc comment for why). Mirrors
   * `MacosRemoteDesktopLaunchAgentSupervisor`'s own (per-instance, and so
   * ineffective here) breaker. Every call records an attempt; only the
   * return value says whether it may proceed.
   */
  private allowAutomaticRestart(): boolean {
    const now = Date.now();
    const windowMs = MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS.defaultCrashWindowMs;
    while (this.autoRestartTimes.length > 0 && now - this.autoRestartTimes[0]! > windowMs) {
      this.autoRestartTimes.shift();
    }
    this.autoRestartTimes.push(now);
    return this.autoRestartTimes.length <= MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_LIMITS.defaultMaxCrashRestarts;
  }

  private handleLifecycleEvent(event: MacosRemoteDesktopLifecycleEvent): void {
    if (this.closed) return;
    // Every one of these tears the generation down. Named, because a Mac that
    // restarted its worker every twenty seconds logged only the cleanup that
    // followed, never what started it.
    this.options.onBackgroundError?.(new Error(`macos_remote_desktop_lifecycle_event:${event.type}`));
    if (event.type === 'agent_crash'
      && event.workerGeneration !== this.activeWorkerGeneration) return;
    if (event.type === 'agent_crash') {
      this.markWorkerTerminated(event.workerGeneration);
    }
    if (event.type === 'service_generation') {
      if (event.serviceGeneration <= this.serviceGeneration) return;
      this.serviceGeneration = event.serviceGeneration;
    }
    const crashLoop = event.type === 'agent_crash' && !this.allowAutomaticRestart();
    if (crashLoop) {
      this.options.onBackgroundError?.(
        new Error('macos_remote_desktop_worker_host_agent_crash_loop'),
      );
    }
    const generation = this.lifecycleGeneration;
    const cleanupSettled = this.runLocalCleanup(event);
    const restart = !crashLoop && (event.type === 'wake'
      || event.type === 'unlock'
      || event.type === 'fast_user_switch'
      || event.type === 'agent_crash'
      || event.type === 'service_generation');
    this.invalidateForLifecycle(generation, restart, cleanupSettled);
  }

  /**
   * Issue release/stop for the CURRENT worker generation and resolve only once
   * both have settled, or the bound elapses.
   *
   * Returns a promise teardown must await before stopping the supervisor and
   * control socket. Never rejects: a cleanup failure is reported and teardown
   * still proceeds, because refusing to tear down would strand the session.
   */
  private runLocalCleanup(event: MacosRemoteDesktopHostCleanupReason): Promise<void> {
    const workerGeneration = this.activeWorkerGeneration;
    type CleanupOperation = typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OPERATION[
      keyof typeof MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OPERATION
    ];
    type Cleanup = NonNullable<MacosRemoteDesktopWorkerHostOptions['releaseInput']>;
    const cleanupCandidates: Array<readonly [CleanupOperation, Cleanup | undefined]> = [
      [MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OPERATION.RELEASE_INPUT, this.options.releaseInput],
      [MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OPERATION.STOP_CAPTURE, this.options.stopCapture],
    ];
    const cleanups = cleanupCandidates.filter(
      (entry): entry is readonly [CleanupOperation, Cleanup] => typeof entry[1] === 'function',
    );
    if (cleanups.length === 0) return Promise.resolve();
    if (!Number.isSafeInteger(workerGeneration) || workerGeneration <= 0) {
      // No live generation to bind to. Dispatching anyway would send the
      // "whatever is live" generation and could act on a successor.
      this.options.onBackgroundError?.(
        new Error('macos_remote_desktop_host_cleanup_without_worker_generation'),
      );
      return Promise.resolve();
    }
    const request: MacosRemoteDesktopHostCleanupRequest = { reason: event, workerGeneration };
    // Freeze this before lifecycle invalidation clears routes. Reading the
    // authority count after async cleanup settles would always observe zero
    // and could launder a failure that was dispatched while session B lived.
    const terminationProvenBeforeCleanup = this.hasWorkerTerminationProof(workerGeneration);
    const settled = Promise.all(cleanups.map(([operation, cleanup]) => {
      try {
        return Promise.resolve(cleanup(request)).then((outcome) => ({
          operation,
          outcome: outcome ?? {
            ok: false,
            error: new Error('macos_remote_desktop_host_cleanup_failed'),
          },
          reported: false,
        }), (error: unknown) => ({
          operation,
          outcome: { ok: false, error },
          reported: false,
        }));
      } catch (error) {
        // Preserve synchronous fault visibility for lifecycle invalidation.
        this.options.onBackgroundError?.(error);
        return Promise.resolve({
          operation,
          outcome: { ok: false, error },
          reported: true,
        });
      }
    })).then((results) => {
      // A successful exact-generation stop is itself termination proof. Apply
      // it before classifying a concurrently completed release result.
      const stoppedExactGeneration = results.some(({ operation, outcome }) => (
        operation === MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OPERATION.STOP_CAPTURE && outcome.ok
      ));
      if (stoppedExactGeneration) {
        this.markWorkerTerminated(workerGeneration);
      }
      const terminationProven = terminationProvenBeforeCleanup || stoppedExactGeneration;
      for (const { operation, outcome, reported } of results) {
        if (outcome.ok || reported) continue;
        if ('reason' in outcome
          && outcome.reason === MACOS_REMOTE_DESKTOP_HOST_CLEANUP_OUTCOME_REASON.NO_ACTIVE_GENERATION
          && terminationProven) {
          this.options.onLifecycleNotice?.({
            kind: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_NOTICE_KIND.NO_ACTIVE_GENERATION,
            workerGeneration,
            operation,
            lifecycleReason: event,
          });
          continue;
        }
        this.options.onBackgroundError?.(
          outcome.error ?? new Error('macos_remote_desktop_host_cleanup_failed'),
        );
      }
    });
    return this.withCleanupBound(settled);
  }

  private markWorkerTerminated(workerGeneration: number): void {
    if (!Number.isSafeInteger(workerGeneration) || workerGeneration <= 0) return;
    this.terminatedWorkerGenerations.add(workerGeneration);
    // Generation numbers are monotonic. A small tail covers delayed/duplicate
    // cleanup without allowing process-lifetime growth.
    const floor = Math.max(1, workerGeneration - 8);
    for (const known of this.terminatedWorkerGenerations) {
      if (known < floor) this.terminatedWorkerGenerations.delete(known);
    }
  }

  private markWorkerActive(workerGeneration: number): void {
    if (!Number.isSafeInteger(workerGeneration) || workerGeneration <= 0) return;
    this.terminatedWorkerGenerations.delete(workerGeneration);
  }

  private hasWorkerTerminationProof(workerGeneration: number): boolean {
    // A TERMINAL is session-scoped. It proves the whole worker generation has
    // ended only while no other route authority on that generation remains.
    // This one gate is shared by cleanup downgrade and expected peer exit.
    return this.terminatedWorkerGenerations.has(workerGeneration)
      && this.core.authorities().size === 0;
  }

  /** Bounded wait; a wedged worker must not be able to block teardown. */
  private withCleanupBound(settled: Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.options.onBackgroundError?.(
          new Error('macos_remote_desktop_host_cleanup_timeout'),
        );
        resolve();
      }, MACOS_REMOTE_DESKTOP_HOST_CLEANUP_TIMEOUT_MS);
      timer.unref?.();
      void settled.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private invalidateForLifecycle(
    generation: number,
    restart = false,
    cleanupSettled: Promise<void> = Promise.resolve(),
    preserveAdvertisedProfile = false,
  ): void {
    if (!this.isCurrent(generation)) return;
    this.cancelPendingAuthentication(generation);
    ++this.lifecycleGeneration;
    // Route authority is revoked SYNCHRONOUSLY, before any await: no peer may
    // keep acting on this generation while cleanup is still draining. The
    // worker itself is kept alive until cleanup settles.
    if (preserveAdvertisedProfile) this.preserveProfileForNextStart = true;
    else {
      this.preserveProfileForNextStart = false;
      this.retainedProfileStartGeneration = null;
    }
    this.invalidateAuthority(preserveAdvertisedProfile);
    const teardown = this.shutdownResources(cleanupSettled);
    if (restart && !this.closed) {
      void teardown.then(() => this.start()).catch((error) => {
        this.options.onBackgroundError?.(error);
      });
    }
  }

  private invalidateAuthority(preserveAdvertisedProfile = false): void {
    // Requests addressed to this worker can no longer be answered by it.
    this.failPendingPrivacyReplies();
    this.clearAdvertisedProfile(preserveAdvertisedProfile);
    if (this.connectionGeneration !== 0) {
      this.core.endConnection(this.connectionGeneration);
      this.connectionGeneration = 0;
    }
    this.failTrackedRoutes();
  }

  private cancelPendingAuthentication(generation: number): void {
    const pending = this.pendingAuthentication;
    if (!pending || pending.generation !== generation) return;
    this.pendingAuthentication = null;
    pending.reject(new Error('macos_remote_desktop_worker_host_generation_invalidated'));
  }

  /**
   * One zero-mutation display question, on the agent lease this host holds.
   *
   * False whenever there is no lease, which is the honest answer: display
   * control that cannot be asked about cannot be advertised.
   */
  private async probeVirtualDisplayReadiness(): Promise<boolean> {
    const authority = this.virtualDisplayAuthority;
    if (!authority) return false;
    this.displayNonce += 1;
    try {
      return await probeVirtualDisplayCreateReadiness(authority, this.displayNonce);
    } catch (error) {
      this.options.onBackgroundError?.(
        error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private clearAdvertisedProfile(preserveAdvertisedProfile = false): void {
    this.clearReadinessPoll();
    this.authenticated = false;
    if (!preserveAdvertisedProfile) this.setAdvertisedProfile(EMPTY_PROFILE);
    this.activeArtifact = null;
    this.activeUser = null;
    this.activePrincipal = null;
    this.activeWorkerGeneration = 0;
  }

  private setAdvertisedProfile(profile: MacosRemoteDesktopRuntimeProfile): void {
    const changed = this.profile.mode !== profile.mode
      || this.profile.sessionCapabilities.join('\0') !== profile.sessionCapabilities.join('\0')
      || this.profile.adapterCapabilities.join('\0') !== profile.adapterCapabilities.join('\0');
    this.profile = profile;
    if (!changed) return;
    try {
      this.options.onProfileChanged?.();
    } catch (error) {
      this.options.onBackgroundError?.(error);
    }
  }

  private failTrackedRoutes(): void {
    this.core.failAll(REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED, (message) => {
      this.emit(message);
    });
    this.stoppingSessions.clear();
  }

  private emit(message: RemoteDesktopDaemonMessage): void {
    try {
      this.onMessage(message);
    } catch {
      // Message observers cannot restore retired worker authority.
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.closed && generation === this.lifecycleGeneration;
  }

  private shutdownResources(cleanupSettled: Promise<void> = Promise.resolve()): Promise<void> {
    const supervisor = this.supervisor;
    const server = this.ipcServer;
    const authority = this.authority;
    const displayAuthority = this.virtualDisplayAuthority;
    this.supervisor = null;
    this.ipcServer = null;
    this.authority = null;
    this.virtualDisplayAuthority = null;
    // Display authority ends with the generation that established it. The
    // listener is unlinked too, so a later agent cannot dial a rendezvous this
    // daemon no longer answers for.
    if (displayAuthority) {
      server?.revokeVirtualDisplayChannel?.();
      void displayAuthority.close().catch((error: unknown) => {
        this.options.onBackgroundError?.(
          error instanceof Error ? error : new Error(String(error)));
      });
    }
    // Revoke the opaque IPC session and every route synchronously. The socket
    // transport also cleans its generation while stopping, but host authority
    // must not depend on an asynchronous or injected transport implementation.
    authority?.cleanup();
    const operation = this.teardownPromise.then(async () => {
      // Cleanup first: stopping the supervisor kills the LaunchAgent and
      // removes the control socket, so a release/stop that has not connected
      // yet would silently never run.
      await cleanupSettled;
      await Promise.allSettled([
        supervisor?.stop(),
        server?.stop(),
      ]);
    });
    this.teardownPromise = operation;
    return operation;
  }

  private enqueuePrivacy<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.privacyTail.then(operation, operation);
    this.privacyTail = run.catch(() => undefined);
    return run;
  }

  private shield(frame: Record<string, unknown>): Promise<boolean> {
    const { epochId, revision } = frame;
    if (typeof epochId !== 'string' || !isRemoteDesktopId(epochId)
      || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      return Promise.resolve(false);
    }
    const previous = this.privacy;
    if (previous && previous.epochId === epochId && revision < previous.revision) {
      return Promise.resolve(false);
    }
    // Recorded before any await: a worker admitted from here on is shielded
    // first, even if this request is still waiting for its reply.
    const state: MacosPrivacyState = {
      epochId,
      revision,
      confirmed: false,
      shieldedGeneration: previous?.shieldedGeneration ?? 0,
      routesKey: null,
    };
    this.privacy = state;
    return this.enqueuePrivacy(async () => {
      if (this.privacy !== state) return false;
      const target = this.privacyTarget();
      let workerGeneration = this.lastPrivacyFrameGeneration;
      let inputReleased = true;
      if (target) {
        const reply = await this.requestPrivacy(
          target.server, target.workerGeneration, true, target.lifecycleGeneration,
        );
        if (!reply || !reply.shielded || this.privacy !== state || this.closed) return false;
        workerGeneration = this.privacyFrameGeneration(
          reply.workerGeneration, reply.realFrameGeneration,
        );
        inputReleased = reply.inputReleased;
      }
      const routes = this.privacyRoutes();
      state.confirmed = true;
      state.shieldedGeneration = workerGeneration;
      state.routesKey = routesKey(routes);
      this.emitPrivacy({
        type: WORKER_PRIVACY_FRAME.SHIELDED,
        epochId: state.epochId,
        revision: state.revision,
        workerGeneration,
        inputReleased,
        routes,
      });
      return true;
    });
  }

  private release(frame: Record<string, unknown>): Promise<boolean> {
    const state = this.privacy;
    if (!state || !state.confirmed
      || frame.epochId !== state.epochId || frame.revision !== state.revision) {
      return Promise.resolve(false);
    }
    return this.enqueuePrivacy(async () => {
      if (this.privacy !== state) return false;
      const target = this.privacyTarget();
      let fresh: number;
      if (target) {
        const reply = await this.requestPrivacy(
          target.server, target.workerGeneration, false, target.lifecycleGeneration,
        );
        if (!reply || reply.shielded || !reply.inputReleased
          || this.privacy !== state || this.closed) return false;
        fresh = this.privacyFrameGeneration(reply.workerGeneration, reply.realFrameGeneration);
      } else {
        // No worker, so no pixel was captured under the shield; the proof
        // generation still has to move past everything already reported.
        fresh = this.lastPrivacyFrameGeneration + 1;
        this.lastPrivacyFrameGeneration = fresh;
      }
      // Equal means a frame the host had already reported under the shield.
      if (fresh <= state.shieldedGeneration) return false;
      this.emitPrivacy({
        type: WORKER_PRIVACY_FRAME.RELEASED,
        epochId: state.epochId,
        secretCleanupComplete: true,
        freshFrameWorkerGeneration: fresh,
      });
      this.privacy = null;
      return true;
    });
  }

  /** The authenticated worker a privacy request can reach right now, if any. */
  private privacyTarget(): {
    server: MacosRemoteDesktopIpcTransport;
    workerGeneration: number;
    lifecycleGeneration: number;
  } | null {
    const server = this.ipcServer;
    if (!server || this.closed || !this.authenticated
      || this.activeWorkerGeneration <= 0) return null;
    return {
      server,
      workerGeneration: this.activeWorkerGeneration,
      lifecycleGeneration: this.lifecycleGeneration,
    };
  }

  private requestPrivacy(
    server: MacosRemoteDesktopIpcTransport,
    workerGeneration: number,
    shield: boolean,
    lifecycleGeneration: number,
  ): Promise<MacosRemoteDesktopAcceptedPrivacyReply | null> {
    if (!server.sendPrivacyRequest || !this.isCurrent(lifecycleGeneration)) {
      return Promise.resolve(null);
    }
    const requestId = ++this.nextPrivacyRequestId;
    const reply = new Promise<MacosRemoteDesktopAcceptedPrivacyReply | null>((resolve) => {
      const timer = setTimeout(
        () => this.settlePrivacyReply(requestId, null),
        this.options.privacyReplyTimeoutMs ?? MACOS_REMOTE_DESKTOP_PRIVACY_REPLY_TIMEOUT_MS,
      );
      timer.unref?.();
      this.pendingPrivacyReplies.set(requestId, { workerGeneration, resolve, timer });
    });
    void server.sendPrivacyRequest(requestId, shield).catch((error: unknown) => {
      this.options.onBackgroundError?.(error);
      this.settlePrivacyReply(requestId, null);
    });
    return reply;
  }

  private onPrivacyReply(reply: MacosRemoteDesktopAcceptedPrivacyReply, generation: number): void {
    if (!this.isCurrent(generation)) return;
    const pending = this.pendingPrivacyReplies.get(reply.requestId);
    // An unsolicited, repeated or foreign-generation reply proves nothing.
    if (!pending || pending.workerGeneration !== reply.workerGeneration) return;
    this.settlePrivacyReply(reply.requestId, reply);
  }

  private settlePrivacyReply(
    requestId: number,
    reply: MacosRemoteDesktopAcceptedPrivacyReply | null,
  ): void {
    const pending = this.pendingPrivacyReplies.get(requestId);
    if (!pending) return;
    this.pendingPrivacyReplies.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

  private failPendingPrivacyReplies(): void {
    for (const requestId of [...this.pendingPrivacyReplies.keys()]) {
      this.settlePrivacyReply(requestId, null);
    }
  }

  /** Host-monotonic value for a worker-reported real frame count. */
  private privacyFrameGeneration(workerGeneration: number, realFrameGeneration: number): number {
    if (this.privacyFrameBase?.workerGeneration !== workerGeneration) {
      this.privacyFrameBase = {
        workerGeneration,
        base: this.lastPrivacyFrameGeneration + 1,
      };
    }
    const value = this.privacyFrameBase.base + realFrameGeneration;
    this.lastPrivacyFrameGeneration = Math.max(this.lastPrivacyFrameGeneration, value);
    return value;
  }

  /** Every route the authenticated worker is feeding; none without a worker. */
  private privacyRoutes(): RemoteDesktopRouteGeneration[] {
    if (!this.privacyTarget()) return [];
    const routes: RemoteDesktopRouteGeneration[] = [];
    for (const authority of this.core.authorities().values()) {
      const routeGeneration = authority.prepare.routeGeneration;
      if (routeGeneration === undefined) continue;
      routes.push({ routeId: authority.sessionId, routeGeneration });
    }
    return routes;
  }

  /**
   * Re-reports a confirmed epoch after its route set changed. Never before the
   * epoch is confirmed: an update carrying the expected routes would otherwise
   * be read as proof of a shield the worker has not acknowledged yet.
   */
  private emitShieldedUpdate(): void {
    const state = this.privacy;
    if (!state?.confirmed) return;
    const routes = this.privacyRoutes();
    const key = routesKey(routes);
    if (key === state.routesKey) return;
    state.routesKey = key;
    state.shieldedGeneration = Math.max(state.shieldedGeneration, this.lastPrivacyFrameGeneration);
    this.emitPrivacy({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: state.epochId,
      revision: state.revision,
      workerGeneration: state.shieldedGeneration,
      inputReleased: true,
      routes,
    });
  }

  private emitPrivacy(frame: WorkerPrivacyShieldedFrame | WorkerPrivacyReleasedFrame): void {
    for (const subscriber of [...this.privacySubscribers]) {
      try { subscriber(frame); } catch { /* isolate subscribers */ }
    }
  }

}
