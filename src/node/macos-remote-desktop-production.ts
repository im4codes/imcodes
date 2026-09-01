import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  assertMacosRemoteDesktopStoreTrusted,
  selectMacosRemoteDesktopArtifact,
  type VerifiedMacosRemoteDesktopComponent,
  type VerifiedMacosRemoteDesktopArtifact,
} from './macos-remote-desktop-artifact.js';
import type {
  MacosRemoteDesktopHostCleanupReason,
  MacosRemoteDesktopHostCleanupOutcome,
  MacosRemoteDesktopHostCleanupRequest,
  MacosRemoteDesktopWorkerHostOptions,
} from './macos-remote-desktop-worker-host.js';
import {
  buildMacosRemoteDesktopGlobalLaunchAgentDefinition,
  installMacosRemoteDesktopGlobalLaunchAgent,
  loadMacosRemoteDesktopGlobalLaunchAgent,
  type MacosRemoteDesktopGlobalLaunchAgentDefinition,
  type MacosRemoteDesktopGlobalLaunchAgentLoadReceipt,
  type MacosRemoteDesktopGlobalLaunchAgentRollback,
  type MacosRemoteDesktopLifecycleEvent,
} from './macos-remote-desktop-launch-agent.js';
import { defaultCredentialPath } from './enrollment.js';
import {
  resolveMacosUserSession,
  resolveMacosRemoteDesktopGraphicalSessionAuthority,
  type MacosRemoteDesktopGraphicalSessionAuthority,
  type MacosUserSession,
} from './user-session-launcher.js';
import {
  MacosRemoteDesktopGlobalAgentBootstrapListener,
  type MacosRemoteDesktopBootstrapGrant,
  type MacosRemoteDesktopBootstrapLaunch,
  type MacosRemoteDesktopBootstrapRevocation,
  type MacosRemoteDesktopGlobalAgentBootstrapListenerOptions,
} from './macos-remote-desktop-global-agent-bootstrap.js';
import {
  admitMacosRemoteDesktopGraphicalReadiness,
  MacosRemoteDesktopGraphicalReadinessAdmissionLedger,
  type MacosRemoteDesktopGraphicalReadinessAdmission,
} from './macos-remote-desktop-graphical-readiness.js';
import {
  createMacosRemoteDesktopNativePeerVerificationSeams,
  type MacosRemoteDesktopNativePeerVerificationSeams,
} from './macos-remote-desktop-peer-verifier.js';
import { MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY } from './macos-user-session.js';
import { REMOTE_DESKTOP_MACOS_TEAM_ID } from '../../shared/remote-desktop-worker.js';
import {
  startMacosVirtualDisplayAuthorityHost,
} from './macos-virtual-display-authority-host.js';
import { randomBytes } from 'node:crypto';
import {
  executeMacosRemoteDesktopResponsibleCommand,
  macosRemoteDesktopResponsibleCommandInvocation,
  type MacosRemoteDesktopResponsibleCommandOptions,
  type MacosRemoteDesktopResponsibleCommandResult,
} from './macos-remote-desktop-responsible-spawn.js';

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER_BYTES = 16 * 1024;

/**
 * Generation flag understood by the native command entry point
 * (`kGenerationArgument` in macos_native_command_v1.cc). Sending no generation
 * means "whatever is live", which is exactly what a stale cleanup must not do.
 */
export const MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT = '--generation' as const;

export const MACOS_REMOTE_DESKTOP_NATIVE_COMMAND = Object.freeze({
  readiness: '--imcodes-readiness-v1',
  requestPermissions: '--imcodes-request-permissions-v1',
  releaseInput: '--imcodes-release-input-v1',
  stopCapture: '--imcodes-stop-capture-v1',
} as const);

export const MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION = 1;

export const MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE = Object.freeze({
  ACTIVE_UNLOCKED: 'active_unlocked',
  LOCKED: 'locked',
  SLEEPING: 'sleeping',
  INACTIVE: 'inactive',
} as const);

type MacosRemoteDesktopNativeSessionState = typeof MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE[
  keyof typeof MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE
];

export interface MacosRemoteDesktopNativeReadinessSnapshot {
  version: typeof MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION;
  activeAquaUserUids: readonly number[];
  sessionState: MacosRemoteDesktopNativeSessionState;
  screenRecording: boolean;
  encoder: boolean;
  accessibility: boolean;
  clipboard: boolean;
  disclosure: boolean;
  lifecycleObservation: boolean;
  releaseInput: boolean;
  stopCapture: boolean;
  virtualDisplay: boolean;
}

type NativeReadiness = Awaited<ReturnType<
  MacosRemoteDesktopWorkerHostOptions['inspectReadiness']
>>;

export interface MacosRemoteDesktopAuthorityReadinessOptions {
  /** Existing active-user readiness command. Never called for LoginWindow. */
  inspectAqua(user: MacosUserSession): Promise<NativeReadiness>;
  /** Current one-shot bootstrap grant; required for LoginWindow. */
  grant?: MacosRemoteDesktopBootstrapGrant;
  /** Native post-authentication, post-composition frame; required for LoginWindow. */
  graphicalAttestation?: string;
}

export type MacosRemoteDesktopNativeCommandExecutor = (
  user: MacosUserSession,
  component: VerifiedMacosRemoteDesktopComponent,
  args: readonly string[],
) => Promise<string>;

export type MacosRemoteDesktopNativeCleanupLauncher = (
  user: MacosUserSession,
  component: VerifiedMacosRemoteDesktopComponent,
  args: readonly string[],
) => Promise<void>;

export type MacosRemoteDesktopResponsibleCommandRunner = (
  options: MacosRemoteDesktopResponsibleCommandOptions,
) => Promise<MacosRemoteDesktopResponsibleCommandResult>;

export interface MacosRemoteDesktopProductionDependencies {
  platform?: NodeJS.Platform;
  arch?: string;
  runtimeRoot?: string;
  storeRoot?: string;
  selectArtifact?: typeof selectMacosRemoteDesktopArtifact;
  resolveUserSession?: typeof resolveMacosUserSession;
  responsibleAppPath?: string;
  executeResponsibleCommand?: MacosRemoteDesktopResponsibleCommandRunner;
  executeNativeCommand?: MacosRemoteDesktopNativeCommandExecutor;
  launchNativeCleanup?: MacosRemoteDesktopNativeCleanupLauncher;
  createGlobalBootstrapListener?: typeof createMacosRemoteDesktopProductionGlobalBootstrapListener;
  installGlobalLaunchAgent?: (
    definition: MacosRemoteDesktopGlobalLaunchAgentDefinition,
  ) => Promise<MacosRemoteDesktopGlobalLaunchAgentRollback>;
  loadGlobalLaunchAgent?: (
    definition: MacosRemoteDesktopGlobalLaunchAgentDefinition,
  ) => Promise<MacosRemoteDesktopGlobalLaunchAgentLoadReceipt>;
  createPeerVerificationSeams?: typeof createMacosRemoteDesktopNativePeerVerificationSeams;
  bootstrapSocketPath?: string;
  bootstrapHandshakeTimeoutMs?: number;
  graphicalAuthorityTimeoutMs?: number;
  prepareBootstrapSocketPath?: MacosRemoteDesktopGlobalAgentBootstrapListenerOptions['prepareSocketPath'];
  secureBootstrapSocketPath?: MacosRemoteDesktopGlobalAgentBootstrapListenerOptions['secureSocketPath'];
  onBackgroundError?: (error: unknown) => void;
}

export interface MacosRemoteDesktopProductionGlobalBootstrapOptions {
  artifact: VerifiedMacosRemoteDesktopArtifact;
  createLaunch(
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
  ): Promise<MacosRemoteDesktopBootstrapLaunch>;
  revoke(revocation: MacosRemoteDesktopBootstrapRevocation): void | Promise<void>;
  onGrantIssued?(
    grant: MacosRemoteDesktopBootstrapGrant,
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
  ): void | Promise<void>;
  resolveAquaUser?: () => Promise<MacosUserSession>;
  createPeerVerificationSeams?: typeof createMacosRemoteDesktopNativePeerVerificationSeams;
  socketPath?: string;
  runtimeRoot?: string;
  handshakeTimeoutMs?: number;
  prepareSocketPath?: MacosRemoteDesktopGlobalAgentBootstrapListenerOptions['prepareSocketPath'];
  secureSocketPath?: MacosRemoteDesktopGlobalAgentBootstrapListenerOptions['secureSocketPath'];
  onBackgroundError?: (error: unknown) => void;
}

const UNAVAILABLE_READINESS: NativeReadiness = Object.freeze({
  screenRecording: false,
  encoder: false,
  accessibility: false,
  clipboard: false,
  disclosure: false,
});

/**
 * Explicitly select the readiness authority for one graphical principal.
 *
 * Aqua preserves the existing active-user command. LoginWindow has no active
 * user and therefore cannot call that command (or synthesize a MacosUserSession
 * merely to satisfy its signature); it is admitted only from the current
 * bootstrap grant plus the native authenticated composition attestation.
 */
export async function inspectMacosRemoteDesktopAuthorityReadiness(
  authority: MacosRemoteDesktopGraphicalSessionAuthority,
  options: MacosRemoteDesktopAuthorityReadinessOptions,
): Promise<NativeReadiness> {
  if (authority.kind === 'aqua_user') {
    return await options.inspectAqua(authority.user);
  }
  if (!options.grant || options.graphicalAttestation === undefined) {
    return UNAVAILABLE_READINESS;
  }
  const admission = admitMacosRemoteDesktopGraphicalReadiness(
    authority,
    options.grant,
    options.graphicalAttestation,
  );
  if (!admission) return UNAVAILABLE_READINESS;
  return Object.freeze({
    screenRecording: admission.screenRecording,
    encoder: admission.encoder,
    accessibility: admission.accessibility,
    clipboard: admission.clipboard,
    disclosure: admission.disclosure,
    virtualDisplay: admission.virtualDisplay,
  });
}

/**
 * Production injection for the global LaunchAgent rendezvous.
 *
 * The hello supplies only the uid/asid expectations passed to the native
 * verifier. They become authority only when getpeereid/audit-token and the
 * pinned code requirement return the same values. Session type is then turned
 * into the explicit Aqua-user/LoginWindow-bootstrap union.
 */
export function createMacosRemoteDesktopProductionGlobalBootstrapListener(
  options: MacosRemoteDesktopProductionGlobalBootstrapOptions,
): MacosRemoteDesktopGlobalAgentBootstrapListener {
  const identity = options.artifact.manifest.codeSignature.bundles.launchAgent;
  const component = options.artifact.components.launchAgent;
  const expectedRequirement = [
    `identifier "${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier}"`,
    'and anchor apple generic',
    `and certificate leaf[subject.OU] = "${REMOTE_DESKTOP_MACOS_TEAM_ID}"`,
  ].join(' ');
  if (options.artifact.manifest.codeSignature.teamId !== REMOTE_DESKTOP_MACOS_TEAM_ID
    || identity.bundleIdentifier !== MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier
    || identity.designatedRequirement !== expectedRequirement
    || component.bundleIdentifier !== identity.bundleIdentifier
    || component.designatedRequirement !== identity.designatedRequirement) {
    throw new Error('macos_remote_desktop_bootstrap_invalid_artifact');
  }
  const createVerification = options.createPeerVerificationSeams
    ?? createMacosRemoteDesktopNativePeerVerificationSeams;
  return new MacosRemoteDesktopGlobalAgentBootstrapListener({
    socketPath: options.socketPath,
    runtimeRoot: options.runtimeRoot,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    prepareSocketPath: options.prepareSocketPath,
    secureSocketPath: options.secureSocketPath,
    onBackgroundError: options.onBackgroundError,
    revoke: options.revoke,
    onGrantIssued: options.onGrantIssued,
    createLaunch: options.createLaunch,
    verifyPeer: async (socket, expected) => {
      const seams: MacosRemoteDesktopNativePeerVerificationSeams = createVerification({
        executablePath: component.executablePath,
        expectedUid: expected.uid,
        expectedAuditSessionId: expected.auditSessionId,
        expectedCodeIdentity: {
          bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
          teamId: REMOTE_DESKTOP_MACOS_TEAM_ID,
          designatedRequirement: expectedRequirement,
        },
      });
      if (typeof seams.verifyPeer !== 'function') {
        throw new Error('macos_remote_desktop_bootstrap_peer_verifier_unavailable');
      }
      return await seams.verifyPeer(socket);
    },
    resolveAuthority: async (peer, hello) =>
      await resolveMacosRemoteDesktopGraphicalSessionAuthority(peer, hello, {
        resolveAquaUser: options.resolveAquaUser,
      }),
  });
}

const DEFAULT_GRAPHICAL_AUTHORITY_TIMEOUT_MS = 15_000;

interface PendingValue<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function pendingValue<T>(): PendingValue<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function withProductionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function sameGraphicalAuthority(
  left: MacosRemoteDesktopGraphicalSessionAuthority,
  right: MacosRemoteDesktopGraphicalSessionAuthority,
): boolean {
  const leftUid = left.kind === 'aqua_user' ? left.user.uid : left.uid;
  const rightUid = right.kind === 'aqua_user' ? right.user.uid : right.uid;
  return left === right
    && left.kind === right.kind
    && left.sessionType === right.sessionType
    && leftUid === rightUid
    && left.auditSessionId === right.auditSessionId
    && left.pidVersion === right.pidVersion;
}

/**
 * Joins the machine-wide LaunchAgent bootstrap to Cx7's worker-host callbacks.
 *
 * The listener observes the principal first and publishes it to the host. The
 * host then starts the exact per-session IPC server and returns its launch via
 * `onGraphicalIpcLaunch`; only then may the listener's ledger mint a grant.
 * The exact grant object is retained until revocation and is the sole
 * authority accepted by LoginWindow readiness.
 */
class MacosRemoteDesktopProductionBootstrapCoordinator {
  private listener: MacosRemoteDesktopGlobalAgentBootstrapListener | null = null;
  private loadReceipt: MacosRemoteDesktopGlobalLaunchAgentLoadReceipt | null = null;
  private readonly queuedAuthorities: MacosRemoteDesktopGraphicalSessionAuthority[] = [];
  private authorityWaiter: PendingValue<MacosRemoteDesktopGraphicalSessionAuthority> | null = null;
  private readonly pendingLaunches = new WeakMap<object, PendingValue<MacosRemoteDesktopBootstrapLaunch>>();
  private readonly issuedLaunches = new WeakMap<object, MacosRemoteDesktopBootstrapLaunch>();
  private activeArtifact: VerifiedMacosRemoteDesktopArtifact | null = null;
  private activeAuthority: MacosRemoteDesktopGraphicalSessionAuthority | null = null;
  private activeGrant: MacosRemoteDesktopBootstrapGrant | null = null;
  private activeAdmission: MacosRemoteDesktopGraphicalReadinessAdmission | null = null;
  private readonly readinessLedger =
    new MacosRemoteDesktopGraphicalReadinessAdmissionLedger();
  private workerVerification: MacosRemoteDesktopNativePeerVerificationSeams | null = null;
  private readonly lifecycleListeners = new Set<(event: MacosRemoteDesktopLifecycleEvent) => void>();
  private startPromise: Promise<boolean> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: MacosRemoteDesktopProductionDependencies) {}

  readonly lifecycleSource = {
    subscribe: (listener: (event: MacosRemoteDesktopLifecycleEvent) => void): (() => void) => {
      this.lifecycleListeners.add(listener);
      return () => {
        this.lifecycleListeners.delete(listener);
        if (this.lifecycleListeners.size === 0) void this.stop();
      };
    },
  };

  start(artifact: VerifiedMacosRemoteDesktopArtifact): Promise<boolean> {
    if (this.activeArtifact === artifact && this.listener) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;
    const start = this.startInternal(artifact).finally(() => {
      if (this.startPromise === start) this.startPromise = null;
    });
    this.startPromise = start;
    return start;
  }

  async nextAuthority(): Promise<MacosRemoteDesktopGraphicalSessionAuthority> {
    const queued = this.queuedAuthorities.shift();
    if (queued) return queued;
    if (this.authorityWaiter) {
      throw new Error('macos_remote_desktop_graphical_authority_wait_in_progress');
    }
    const waiter = pendingValue<MacosRemoteDesktopGraphicalSessionAuthority>();
    this.authorityWaiter = waiter;
    try {
      return await withProductionTimeout(
        waiter.promise,
        this.authorityTimeoutMs(),
        'macos_remote_desktop_graphical_authority_timeout',
      );
    } finally {
      if (this.authorityWaiter === waiter) this.authorityWaiter = null;
    }
  }

  async bindLaunch(
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
    launch: MacosRemoteDesktopBootstrapLaunch,
  ): Promise<void> {
    const pending = this.pendingLaunches.get(authority);
    if (!pending || this.activeArtifact === null) {
      throw new Error('macos_remote_desktop_graphical_launch_without_bootstrap');
    }
    this.pendingLaunches.delete(authority);
    this.issuedLaunches.set(authority, Object.freeze({ ...launch }));
    pending.resolve(launch);
  }

  createWorkerVerification(
    options: Parameters<typeof createMacosRemoteDesktopNativePeerVerificationSeams>[0],
  ): MacosRemoteDesktopNativePeerVerificationSeams {
    const verification = (this.dependencies.createPeerVerificationSeams
      ?? createMacosRemoteDesktopNativePeerVerificationSeams)(options);
    this.workerVerification = verification;
    return verification;
  }

  async inspectWorkerGraphicalSession(socket: Socket): Promise<{
    kind: 'aqua_user' | 'loginwindow_bootstrap';
    sessionType: 'Aqua' | 'LoginWindow';
  }> {
    const verified = await this.workerVerification?.verifyPeer?.(socket);
    if (!verified) {
      throw new Error('macos_remote_desktop_graphical_peer_observer_unavailable');
    }
    return Object.freeze({
      kind: verified.sessionType === 'Aqua' ? 'aqua_user' : 'loginwindow_bootstrap',
      sessionType: verified.sessionType,
    });
  }

  async inspectReadiness(
    artifact: VerifiedMacosRemoteDesktopArtifact,
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
    encoded: string | undefined,
    inspectAqua: (user: MacosUserSession) => Promise<NativeReadiness>,
  ): Promise<NativeReadiness> {
    if (artifact !== this.activeArtifact) return UNAVAILABLE_READINESS;
    if (authority.kind === 'aqua_user') {
      return encoded === undefined
        ? await inspectAqua(authority.user)
        : UNAVAILABLE_READINESS;
    }
    const grant = this.activeGrant;
    if (!grant || !this.activeAuthority
      || !sameGraphicalAuthority(authority, this.activeAuthority)) {
      return UNAVAILABLE_READINESS;
    }
    if (encoded === undefined) {
      const admission = this.activeAdmission;
      if (!admission
        || !this.readinessLedger.isCurrent(admission, authority, grant)) {
        return UNAVAILABLE_READINESS;
      }
      return this.readinessFromAdmission(admission);
    }
    if (this.activeAdmission) return UNAVAILABLE_READINESS;
    const result = this.readinessLedger.admit(authority, grant, encoded);
    if (!result.ok) return UNAVAILABLE_READINESS;
    const admission = result.admission;
    this.activeAdmission = admission;
    return this.readinessFromAdmission(admission);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stop = this.stopInternal().finally(() => {
      if (this.stopPromise === stop) this.stopPromise = null;
    });
    this.stopPromise = stop;
    return stop;
  }

  private authorityTimeoutMs(): number {
    const value = this.dependencies.graphicalAuthorityTimeoutMs
      ?? DEFAULT_GRAPHICAL_AUTHORITY_TIMEOUT_MS;
    if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
      throw new Error('macos_remote_desktop_graphical_authority_timeout_invalid');
    }
    return value;
  }

  private async startInternal(artifact: VerifiedMacosRemoteDesktopArtifact): Promise<boolean> {
    await this.stop();
    const createListener = this.dependencies.createGlobalBootstrapListener
      ?? createMacosRemoteDesktopProductionGlobalBootstrapListener;
    let installRollback: MacosRemoteDesktopGlobalLaunchAgentRollback | null = null;
    let listener: MacosRemoteDesktopGlobalAgentBootstrapListener | null = null;
    try {
      const definition = buildMacosRemoteDesktopGlobalLaunchAgentDefinition(artifact);
      listener = createListener({
        artifact,
        socketPath: this.dependencies.bootstrapSocketPath,
        runtimeRoot: this.dependencies.runtimeRoot,
        handshakeTimeoutMs: this.dependencies.bootstrapHandshakeTimeoutMs,
        prepareSocketPath: this.dependencies.prepareBootstrapSocketPath,
        secureSocketPath: this.dependencies.secureBootstrapSocketPath,
        resolveAquaUser: this.dependencies.resolveUserSession,
        createPeerVerificationSeams: this.dependencies.createPeerVerificationSeams,
        onBackgroundError: this.dependencies.onBackgroundError,
        createLaunch: async (authority) => await this.createLaunch(authority),
        onGrantIssued: async (grant, authority) => this.recordGrant(grant, authority),
        revoke: async (revocation) => this.revoke(revocation),
      });
      // Publish only after the artifact has passed definition validation, but
      // before listen: a resident KeepAlive agent may connect immediately.
      this.activeArtifact = artifact;
      await listener.start();
      installRollback = await (this.dependencies.installGlobalLaunchAgent
        ?? ((next) => installMacosRemoteDesktopGlobalLaunchAgent(next)))(definition);
      this.loadReceipt = await (this.dependencies.loadGlobalLaunchAgent
        ?? ((next) => loadMacosRemoteDesktopGlobalLaunchAgent(next, {
          resolveAquaUser: this.dependencies.resolveUserSession,
        })))(definition);
      this.listener = listener;
      this.activeArtifact = artifact;
      return true;
    } catch (error) {
      await this.loadReceipt?.unload().catch((cleanupError) => {
        this.dependencies.onBackgroundError?.(cleanupError);
      });
      this.loadReceipt = null;
      await listener?.stop().catch((cleanupError) => {
        this.dependencies.onBackgroundError?.(cleanupError);
      });
      await installRollback?.rollback().catch((cleanupError) => {
        this.dependencies.onBackgroundError?.(cleanupError);
      });
      this.activeArtifact = null;
      this.dependencies.onBackgroundError?.(error);
      return false;
    }
  }

  private async createLaunch(
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
  ): Promise<MacosRemoteDesktopBootstrapLaunch> {
    if (this.pendingLaunches.has(authority)) {
      throw new Error('macos_remote_desktop_duplicate_graphical_launch');
    }
    const pending = pendingValue<MacosRemoteDesktopBootstrapLaunch>();
    this.pendingLaunches.set(authority, pending);
    const successor = this.activeAuthority !== null
      && !sameGraphicalAuthority(authority, this.activeAuthority);
    const waiter = this.authorityWaiter;
    if (waiter) {
      this.authorityWaiter = null;
      waiter.resolve(authority);
    } else {
      this.queuedAuthorities.push(authority);
    }
    if (successor) {
      for (const listener of [...this.lifecycleListeners]) {
        listener({ type: 'fast_user_switch' });
      }
    }
    try {
      return await withProductionTimeout(
        pending.promise,
        this.authorityTimeoutMs(),
        'macos_remote_desktop_graphical_launch_timeout',
      );
    } finally {
      this.pendingLaunches.delete(authority);
    }
  }

  private recordGrant(
    grant: MacosRemoteDesktopBootstrapGrant,
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
  ): void {
    const launch = this.issuedLaunches.get(authority);
    if (!launch
      || grant.workerGeneration !== launch.workerGeneration
      || grant.socketPath !== launch.socketPath
      || grant.challenge !== launch.challenge) {
      throw new Error('macos_remote_desktop_bootstrap_grant_launch_mismatch');
    }
    this.revokeAdmission();
    this.activeAuthority = authority;
    this.activeGrant = grant;
  }

  private revoke(revocation: MacosRemoteDesktopBootstrapRevocation): void {
    const grant = this.activeGrant;
    if (!grant
      || grant.uid !== revocation.uid
      || grant.auditSessionId !== revocation.auditSessionId
      || grant.workerGeneration !== revocation.workerGeneration
      || grant.socketPath !== revocation.socketPath) return;
    this.revokeAdmission();
    this.activeGrant = null;
    this.activeAuthority = null;
    this.workerVerification = null;
  }

  private readinessFromAdmission(
    admission: MacosRemoteDesktopGraphicalReadinessAdmission,
  ): NativeReadiness {
    return Object.freeze({
      screenRecording: admission.screenRecording,
      encoder: admission.encoder,
      accessibility: admission.accessibility,
      clipboard: admission.clipboard,
      disclosure: admission.disclosure,
      virtualDisplay: admission.virtualDisplay,
    });
  }

  private revokeAdmission(): void {
    if (!this.activeAdmission) return;
    this.readinessLedger.revoke(this.activeAdmission);
    this.activeAdmission = null;
  }

  private async stopInternal(): Promise<void> {
    this.authorityWaiter?.reject(new Error('macos_remote_desktop_bootstrap_stopped'));
    this.authorityWaiter = null;
    this.queuedAuthorities.length = 0;
    this.revokeAdmission();
    const listener = this.listener;
    this.listener = null;
    if (listener) await listener.stop();
    const receipt = this.loadReceipt;
    this.loadReceipt = null;
    if (receipt?.loaded) await receipt.unload();
    this.activeGrant = null;
    this.activeAuthority = null;
    this.activeArtifact = null;
    this.workerVerification = null;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function safeUid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Parse the active-user native readiness contract without requesting TCC or
 * inferring state from the operating system. Unknown versions, fields or
 * values fail closed so a newer native worker cannot accidentally widen an
 * older daemon's advertisement.
 */
export function parseMacosRemoteDesktopNativeReadiness(
  encoded: string,
): MacosRemoteDesktopNativeReadinessSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error('macos_remote_desktop_native_readiness_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('macos_remote_desktop_native_readiness_invalid');
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    'version',
    'activeAquaUserUids',
    'sessionState',
    'screenRecording',
    'encoder',
    'accessibility',
    'clipboard',
    'disclosure',
    'lifecycleObservation',
    'releaseInput',
    'stopCapture',
    'virtualDisplay',
  ])
    || record.version !== MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION
    || !Array.isArray(record.activeAquaUserUids)
    || record.activeAquaUserUids.some((uid) => !safeUid(uid))
    || new Set(record.activeAquaUserUids).size !== record.activeAquaUserUids.length
    || !Object.values(MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE).includes(
      record.sessionState as MacosRemoteDesktopNativeSessionState,
    )
    || [
      record.screenRecording,
      record.encoder,
      record.accessibility,
      record.clipboard,
      record.disclosure,
      record.lifecycleObservation,
      record.releaseInput,
      record.stopCapture,
      record.virtualDisplay,
    ].some((field) => typeof field !== 'boolean')) {
    throw new Error('macos_remote_desktop_native_readiness_invalid');
  }
  return Object.freeze({
    version: MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION,
    activeAquaUserUids: Object.freeze([...(record.activeAquaUserUids as number[])]),
    sessionState: record.sessionState as MacosRemoteDesktopNativeSessionState,
    screenRecording: record.screenRecording as boolean,
    encoder: record.encoder as boolean,
    accessibility: record.accessibility as boolean,
    clipboard: record.clipboard as boolean,
    disclosure: record.disclosure as boolean,
    lifecycleObservation: record.lifecycleObservation as boolean,
    releaseInput: record.releaseInput as boolean,
    stopCapture: record.stopCapture as boolean,
    virtualDisplay: record.virtualDisplay as boolean,
  });
}

export function defaultMacosRemoteDesktopArtifactStoreRoot(arch: 'arm64' | 'x64'): string {
  return join(
    dirname(defaultCredentialPath('darwin')),
    'remote-desktop-worker',
    `darwin-${arch}`,
  );
}

export function macosRemoteDesktopNativeCommandInvocation(
  user: MacosUserSession,
  appPath: string,
  args: readonly string[],
  output: Readonly<{ stdout: string; stderr: string }>,
) {
  return macosRemoteDesktopResponsibleCommandInvocation(user, appPath, args, output);
}

async function defaultExecuteNativeCommand(
  user: MacosUserSession,
  component: VerifiedMacosRemoteDesktopComponent,
  args: readonly string[],
  appPath?: string,
  executeResponsibleCommand: MacosRemoteDesktopResponsibleCommandRunner =
    executeMacosRemoteDesktopResponsibleCommand,
): Promise<string> {
  const result = await executeResponsibleCommand({
    user,
    component,
    args,
    appPath,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxBufferBytes: COMMAND_MAX_BUFFER_BYTES,
  }).catch(() => {
    throw new Error('macos_remote_desktop_native_command_failed');
  });
  if (result.stderr.trim()) throw new Error('macos_remote_desktop_native_command_failed');
  return result.stdout.trim();
}

async function defaultLaunchNativeCleanup(
  user: MacosUserSession,
  component: VerifiedMacosRemoteDesktopComponent,
  args: readonly string[],
  appPath?: string,
  executeResponsibleCommand: MacosRemoteDesktopResponsibleCommandRunner =
    executeMacosRemoteDesktopResponsibleCommand,
): Promise<void> {
  const result = await executeResponsibleCommand({
    user,
    component,
    args,
    appPath,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxBufferBytes: COMMAND_MAX_BUFFER_BYTES,
  }).catch(() => {
    throw new Error('macos_remote_desktop_native_cleanup_failed');
  });
  const expected = args[0] === MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.releaseInput
    ? 'macos_remote_desktop_release_input_ok'
    : args[0] === MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.stopCapture
      ? 'macos_remote_desktop_stop_capture_ok'
      : '';
  if (!expected || result.stderr.trim() || result.stdout.trim() !== expected) {
    throw new Error('macos_remote_desktop_native_cleanup_failed');
  }
}

async function selectVerifiedCurrentOrLastKnownGood(
  storeRoot: string,
  platform: NodeJS.Platform,
  arch: string,
  selectArtifact: typeof selectMacosRemoteDesktopArtifact,
  onBackgroundError?: (error: unknown) => void,
): Promise<VerifiedMacosRemoteDesktopArtifact | null> {
  const dependencies = { runtime: { platform, arch } } as const;
  try {
    const current = await selectArtifact(storeRoot, 'current', dependencies);
    if (current) return current;
  } catch (error) {
    onBackgroundError?.(error);
  }
  try {
    return await selectArtifact(storeRoot, 'lastKnownGood', dependencies);
  } catch (error) {
    onBackgroundError?.(error);
    return null;
  }
}

function verifiedReadiness(
  snapshot: MacosRemoteDesktopNativeReadinessSnapshot,
  user: MacosUserSession,
): NativeReadiness {
  if (snapshot.activeAquaUserUids.length !== 1
    || snapshot.activeAquaUserUids[0] !== user.uid
    || snapshot.sessionState !== MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE.ACTIVE_UNLOCKED
    || !snapshot.lifecycleObservation
    || !snapshot.releaseInput
    || !snapshot.stopCapture) {
    return UNAVAILABLE_READINESS;
  }
  return Object.freeze({
    screenRecording: snapshot.screenRecording,
    encoder: snapshot.encoder,
    accessibility: snapshot.accessibility,
    clipboard: snapshot.clipboard,
    disclosure: snapshot.disclosure,
    virtualDisplay: snapshot.virtualDisplay,
  });
}

/**
 * Construct the stock controlled-node macOS adapter dependencies. The factory
 * performs no IO and returns no adapter on unsupported targets. Artifact,
 * active-Aqua-user and native readiness evidence are resolved only when the
 * platform host starts.
 *
 * The currently shipped native entry point does not yet implement the three
 * machine-readable commands above. That is intentional: command failure maps
 * to an unavailable profile, so wiring this factory cannot advertise guessed
 * TCC, encoder, disclosure, lifecycle or cleanup readiness.
 */
export function createMacosRemoteDesktopProductionDependencies(
  dependencies: MacosRemoteDesktopProductionDependencies = {},
): MacosRemoteDesktopWorkerHostOptions | undefined {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  if (platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) return undefined;

  const storeRoot = dependencies.storeRoot ?? defaultMacosRemoteDesktopArtifactStoreRoot(arch);
  const selectArtifact = dependencies.selectArtifact ?? selectMacosRemoteDesktopArtifact;
  const resolveUser = dependencies.resolveUserSession ?? resolveMacosUserSession;
  const executeNativeCommand = dependencies.executeNativeCommand
    ?? ((user, component, args) => defaultExecuteNativeCommand(
      user,
      component,
      args,
      dependencies.responsibleAppPath,
      dependencies.executeResponsibleCommand,
    ));
  const launchNativeCleanup = dependencies.launchNativeCleanup
    ?? ((user, component, args) => defaultLaunchNativeCleanup(
      user,
      component,
      args,
      dependencies.responsibleAppPath,
      dependencies.executeResponsibleCommand,
    ));
  let activeArtifact: VerifiedMacosRemoteDesktopArtifact | null = null;
  let activeUser: MacosUserSession | null = null;

  /**
   * Run one cleanup command against an EXACT worker generation and resolve on
   * the native command's exact completion receipt.
   *
   * LaunchServices wait status only proves the app terminated, so the shared
   * responsibility-safe runner captures the helper's bounded stdout/stderr and
   * this seam accepts only the command-specific success receipt. It also sends
   * the generation explicitly: a delayed cleanup for N cannot act on N+1.
   */
  const launchCleanup = async (
    command: string,
    workerGeneration: number,
  ): Promise<MacosRemoteDesktopHostCleanupOutcome> => {
    const artifact = activeArtifact;
    const user = activeUser;
    if (!artifact || !user) {
      return { ok: false, error: new Error('macos_remote_desktop_cleanup_no_active_artifact') };
    }
    if (!Number.isSafeInteger(workerGeneration) || workerGeneration <= 0) {
      return { ok: false, error: new Error('macos_remote_desktop_cleanup_invalid_generation') };
    }
    try {
      await launchNativeCleanup(
        user,
        // The signed app dispatches the bounded --imcodes-* command family to
        // its embedded worker. The old LaunchAgent executable was only a
        // tail-exec wrapper for that same worker on this command path; binding
        // and verifying the worker here covers the executable TCC evaluates.
        artifact.components.worker,
        [command, MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT, String(workerGeneration)],
      );
      return { ok: true };
    } catch (error) {
      dependencies.onBackgroundError?.(error);
      return { ok: false, error };
    }
  };

  // Monotonic across this daemon process. It rotates whenever a new resident
  // agent is admitted, which is what lets an agent refuse a grant minted for a
  // previous incarnation of itself.
  let serviceGeneration = 0;
  const bootstrap = new MacosRemoteDesktopProductionBootstrapCoordinator(dependencies);

  return {
    runtime: { platform, arch },
    runtimeRoot: dependencies.runtimeRoot,
    lifecycleSource: bootstrap.lifecycleSource,
    resolveGraphicalSessionAuthority: async () => await bootstrap.nextAuthority(),
    onGraphicalIpcLaunch: async (authority, launch) => {
      await bootstrap.bindLaunch(authority, launch);
    },
    inspectPeerGraphicalSession: async (socket) =>
      await bootstrap.inspectWorkerGraphicalSession(socket),
    createPeerVerificationSeams: (options) => bootstrap.createWorkerVerification(options),
    /**
     * The stock virtual-display authority.
     *
     * Without this the default runtime supplied no factory at all, so the host
     * held no lease and every display request answered `agent_unavailable` --
     * the whole chain type-checked and was dead.
     *
     * Everything it needs comes from the host's own context: the SAME verified
     * artifact this generation launched from, the Aqua user it runs as, and
     * the SAME identity verifier the IPC server admits the worker with. None
     * of it is re-derived here, so there is no second source that could drift.
     */
    async startVirtualDisplayAuthority(context, hooks) {
      // No agent verifier means nothing could check who dialled the
      // rendezvous. Refused rather than started open.
      if (!context.verification) return null;
      try {
        return await startMacosVirtualDisplayAuthorityHost({
          artifact: context.artifact,
          verification: context.verification,
          nextServiceGeneration: () => {
            serviceGeneration += 1;
            return serviceGeneration;
          },
          // 43 base64url characters, matching the launch-challenge grammar the
          // native grant parser accepts.
          mintChallenge: () => randomBytes(32).toString('base64url'),
          onAuthorityLost: hooks.onAuthorityLost,
          onBackgroundError: dependencies.onBackgroundError,
        });
      } catch (error) {
        dependencies.onBackgroundError?.(error);
        return null;
      }
    },
    async resolveVerifiedArtifact(): Promise<VerifiedMacosRemoteDesktopArtifact | null> {
      const selected = await selectVerifiedCurrentOrLastKnownGood(
        storeRoot,
        platform,
        arch,
        selectArtifact,
        dependencies.onBackgroundError,
      );
      if (!selected || !await bootstrap.start(selected)) {
        activeArtifact = null;
        return null;
      }
      activeArtifact = selected;
      return activeArtifact;
    },
    async resolveUserSession(): Promise<MacosUserSession> {
      activeUser = await resolveUser();
      return activeUser;
    },
    async inspectReadiness(
      artifact: VerifiedMacosRemoteDesktopArtifact,
      user: MacosUserSession,
    ): Promise<NativeReadiness> {
      if (artifact !== activeArtifact || user !== activeUser) return UNAVAILABLE_READINESS;
      try {
        // Nearest boundary to the exec. Selection already validated the store,
        // but the path it returned is only as trustworthy as the store at the
        // moment it is USED -- and readiness is the last thing that happens
        // before this executable is run for real.
        await assertMacosRemoteDesktopStoreTrusted(storeRoot, artifact.releaseName, {
          runtime: { platform, arch },
        });
        const encoded = await executeNativeCommand(
          user,
          artifact.components.worker,
          [MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.readiness],
        );
        return verifiedReadiness(parseMacosRemoteDesktopNativeReadiness(encoded), user);
      } catch (error) {
        dependencies.onBackgroundError?.(error);
        return UNAVAILABLE_READINESS;
      }
    },
    async inspectGraphicalReadiness(
      artifact: VerifiedMacosRemoteDesktopArtifact,
      authority: MacosRemoteDesktopGraphicalSessionAuthority,
      graphicalAttestation?: string,
    ): Promise<NativeReadiness> {
      return await bootstrap.inspectReadiness(
        artifact,
        authority,
        graphicalAttestation,
        async (user) => {
          activeUser = user;
          return await this.inspectReadiness(artifact, user);
        },
      );
    },
    releaseInput(
      request: MacosRemoteDesktopHostCleanupRequest,
    ): Promise<MacosRemoteDesktopHostCleanupOutcome> {
      return launchCleanup(
        MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.releaseInput,
        request.workerGeneration,
      );
    },
    stopCapture(
      request: MacosRemoteDesktopHostCleanupRequest,
    ): Promise<MacosRemoteDesktopHostCleanupOutcome> {
      return launchCleanup(
        MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.stopCapture,
        request.workerGeneration,
      );
    },
    onBackgroundError: dependencies.onBackgroundError,
  };
}
