import { randomBytes } from 'node:crypto';
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
} from '../../shared/remote-desktop-access.js';
import type { VerifiedMacosRemoteDesktopArtifact } from './macos-remote-desktop-artifact.js';
import {
  MacosRemoteDesktopIpcAuthorityHost,
  macosRemoteDesktopIpcPrincipalBinding,
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
import { MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY } from './macos-user-session.js';
import {
  RemoteDesktopWorkerHostCore,
} from './remote-desktop-worker-host-core.js';
import {
  assertMacosUserSession,
  type MacosRemoteDesktopGraphicalSessionAuthority,
  type MacosUserSession,
} from './user-session-launcher.js';

const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 15_000;
const DEFAULT_READINESS_POLL_MS = 1_000;
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
export interface MacosRemoteDesktopHostCleanupOutcome {
  ok: boolean;
  error?: unknown;
}

/**
 * Upper bound on how long teardown waits for local cleanup to settle.
 *
 * Teardown must not be able to hang on a wedged worker or control socket, but
 * it also must not race ahead of release/stop. Bounded wait, then fail closed
 * and tear down anyway with the failure reported.
 */
export const MACOS_REMOTE_DESKTOP_HOST_CLEANUP_TIMEOUT_MS = 5_000;

export interface MacosRemoteDesktopWorkerHostOptions {
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
  createIpcServer?: (options: MacosRemoteDesktopIpcServerOptions) => MacosRemoteDesktopIpcTransport;
  createLaunchAgentSupervisor?: (
    dependencies: MacosRemoteDesktopLaunchAgentSupervisorDependencies,
  ) => MacosRemoteDesktopLaunchSupervisor;
  /** Refreshes the next controlled-node auth frame when local readiness narrows. */
  onProfileChanged?: () => void;
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
  private lifecycleGeneration = 0;
  private connectionGeneration = 0;
  private activeWorkerGeneration = 0;
  private serviceGeneration = 0;
  private authenticated = false;
  private closed = false;
  private activeArtifact: VerifiedMacosRemoteDesktopArtifact | null = null;
  private activeUser: MacosUserSession | null = null;
  private activePrincipal: MacosRemoteDesktopGraphicalSessionAuthority | null = null;
  private readinessTimer: NodeJS.Timeout | null = null;

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
    });
  }

  /** Verify, launch, authenticate, and only then expose capabilities. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('macos_remote_desktop_worker_host_closed'));
    if (this.authenticated) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const generation = ++this.lifecycleGeneration;
    const start = this.startGeneration(generation);
    const memo = start.finally(() => {
      if (this.startPromise === memo) this.startPromise = null;
    });
    this.startPromise = memo;
    return memo;
  }

  available(): boolean {
    return !this.closed && this.authenticated
      && this.profile.mode !== MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE;
  }

  sessionCapabilities(): readonly string[] {
    return this.available() ? this.profile.sessionCapabilities : Object.freeze([]);
  }

  adapterCapabilities(): readonly RemoteDesktopAdapterCapability[] {
    return this.available() ? this.profile.adapterCapabilities : Object.freeze([]);
  }

  async handle(message: unknown): Promise<boolean> {
    const parsed = validateRemoteDesktopDaemonCommand(message);
    if (!parsed.ok || !this.available()) return false;
    const generation = this.lifecycleGeneration;
    const command = parsed.value;
    if (command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      if (!await this.revalidateReadinessForPrepare(command.mode, generation)) return false;
      const finishPreparing = this.core.beginPreparing(command.sessionId);
      try {
        this.core.track(command, null);
        const sent = await this.sendCurrent(command, generation);
        if (!sent) this.core.untrack(command.sessionId);
        else this.core.armPrepareReadyTimer(command.sessionId, {
          connectionGeneration: this.connectionGeneration,
          workerPid: null,
        });
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
    if (!this.core.has(command.sessionId)) return false;
    if (command.type === REMOTE_DESKTOP_MSG.OFFER) {
      this.core.markOfferPending(command.sessionId, {
        connectionGeneration: this.connectionGeneration,
        workerPid: null,
      });
    }
    const sent = await this.sendCurrent(command, generation);
    if (sent && (command.type === REMOTE_DESKTOP_MSG.STOP
      || command.type === REMOTE_DESKTOP_MSG.CANCEL)) {
      this.core.untrack(command.sessionId);
    }
    return sent;
  }

  /**
   * A Server-link generation ended, but the verified local sidecar may remain
   * warm. Retire every route and emitted input without destroying the adapter
   * profile needed by the reconnecting authenticated socket.
   */
  onDaemonDisconnected(): void {
    if (this.closed || !this.authenticated) return;
    // No teardown here by design: the sidecar stays warm for the reconnecting
    // socket, so nothing can race the cleanup to the control socket. The
    // promise is still bounded and self-reporting inside runLocalCleanup.
    void this.runLocalCleanup(MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.DAEMON_DISCONNECTED);
    this.failTrackedRoutes();
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
          artifactVerified: true,
          activeUserQualified: true,
          ...localReadiness,
          virtualDisplay: false,
        });
        if (preflightProfile.mode === MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE
          || !this.isCurrent(generation)) return;
      }
      if (this.options.lifecycleSource && this.unsubscribeLifecycle === null) {
        this.unsubscribeLifecycle = this.options.lifecycleSource.subscribe((event) => {
          this.handleLifecycleEvent(event);
        });
      }

      const authority = new MacosRemoteDesktopIpcAuthorityHost({
        ...(principal ? { principal } : { user: user! }),
        expectedCodeIdentity: identity,
        runtimeRoot: this.options.runtimeRoot,
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
        expectedCodeIdentity: identity,
        runtimeRoot: this.options.runtimeRoot,
        inspectPeerUid: peerSeams.inspectPeerUid,
        verifyPeerCodeIdentity: peerSeams.verifyPeerCodeIdentity,
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
        // Injected, so a display request reaches the agent instead of being
        // answered `agent_unavailable` by a server with no lease to ask.
        virtualDisplayLease: () => this.virtualDisplayAuthority?.lease() ?? null,
        virtualDisplaySeams: {
          exchange: async (lease, line, timeoutMs) => await (
            this.virtualDisplayAuthority?.seams.exchange(lease, line, timeoutMs)
            ?? Promise.resolve(null)
          ),
        },
        onDisconnect: (reason, error) => {
          if (!this.isCurrent(generation)) return;
          if (error) this.options.onBackgroundError?.(error);
          const restart = this.authenticated && (
            reason === 'peer_disconnected'
            || reason === 'write_failed'
            || reason === 'callback_failed'
          );
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
          markAuthorityUnavailable: () => this.clearAdvertisedProfile(),
          releaseInput: () => ({ ok: true }),
          stopCapture: () => ({ ok: true }),
          invalidateRoutes: () => this.failTrackedRoutes(),
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
      this.authenticated = true;
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
        artifactVerified: true,
        activeUserQualified: true,
        ...localReadiness,
        virtualDisplay: this.displayReadiness,
      });
      if (profile.mode === MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE) return;
      this.setAdvertisedProfile(profile);
      this.scheduleReadinessPoll(generation);
    } catch (error) {
      this.cancelPendingAuthentication(generation);
      if (this.isCurrent(generation)) {
        this.options.onBackgroundError?.(error);
        this.invalidateAuthority();
        await this.shutdownResources();
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
    // Never widen a profile after the Server authenticated this connection.
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
        this.core.untrack(event.value.sessionId);
      }
    }
  }

  private handleLifecycleEvent(event: MacosRemoteDesktopLifecycleEvent): void {
    if (this.closed) return;
    if (event.type === 'agent_crash'
      && event.workerGeneration !== this.activeWorkerGeneration) return;
    if (event.type === 'service_generation') {
      if (event.serviceGeneration <= this.serviceGeneration) return;
      this.serviceGeneration = event.serviceGeneration;
    }
    const generation = this.lifecycleGeneration;
    const cleanupSettled = this.runLocalCleanup(event);
    const restart = event.type === 'wake'
      || event.type === 'unlock'
      || event.type === 'fast_user_switch'
      || event.type === 'agent_crash'
      || event.type === 'service_generation';
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
    const cleanups = [this.options.releaseInput, this.options.stopCapture]
      .filter((entry): entry is NonNullable<typeof entry> => typeof entry === 'function');
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
    const settled = Promise.allSettled(cleanups.map(async (cleanup) => {
      try {
        const outcome = await cleanup(request);
        if (!outcome?.ok) {
          this.options.onBackgroundError?.(
            outcome?.error ?? new Error('macos_remote_desktop_host_cleanup_failed'),
          );
        }
      } catch (error) {
        // A synchronous throw and a rejected promise are the same failure to a
        // caller; both must surface, or a cleanup that never ran would look
        // indistinguishable from one that succeeded.
        this.options.onBackgroundError?.(error);
      }
    })).then(() => undefined);
    return this.withCleanupBound(settled);
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
  ): void {
    if (!this.isCurrent(generation)) return;
    this.cancelPendingAuthentication(generation);
    ++this.lifecycleGeneration;
    // Route authority is revoked SYNCHRONOUSLY, before any await: no peer may
    // keep acting on this generation while cleanup is still draining. The
    // worker itself is kept alive until cleanup settles.
    this.invalidateAuthority();
    const teardown = this.shutdownResources(cleanupSettled);
    if (restart && !this.closed) {
      void teardown.then(() => this.start()).catch((error) => {
        this.options.onBackgroundError?.(error);
      });
    }
  }

  private invalidateAuthority(): void {
    this.clearAdvertisedProfile();
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

  private clearAdvertisedProfile(): void {
    this.clearReadinessPoll();
    this.authenticated = false;
    this.setAdvertisedProfile(EMPTY_PROFILE);
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
}
