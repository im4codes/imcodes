import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  validateRemoteDesktopDaemonCommand,
  type RemoteDesktopDaemonMessage,
  type RemoteDesktopDaemonCommand,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
  type RemoteDesktopAdapterCapability,
} from '../../shared/remote-desktop-access.js';
import {
  WORKER_CONSENT_FRAME,
  type WorkerConsentInboundFrame,
} from './remote-desktop-consent-ipc.js';
import {
  WORKER_PRIVACY_FRAME,
  type WorkerPrivacyInboundFrame,
} from './remote-desktop-privacy-ipc.js';
import {
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  validateRemoteDesktopVirtualDisplayPackageManifest,
  validateRemoteDesktopWorkerHello,
  validateRemoteDesktopWorkerManifest,
  upgradeLegacyRemoteDesktopWorkerManifest,
  type RemoteDesktopWorkerCrash,
  type RemoteDesktopWorkerManifest,
} from '../../shared/remote-desktop-worker.js';
import {
  REMOTE_DESKTOP_WORKER_MAX_LINE_BYTES,
  REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE,
  RemoteDesktopWorkerHostCore,
  type RemoteDesktopTrackedAuthority,
} from './remote-desktop-worker-host-core.js';
import {
  REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT,
  RemoteDesktopWorkerDiagnostics,
  type RemoteDesktopWorkerDiagnosticEvent,
  REMOTE_DESKTOP_WORKER_DECLARED_TERMINAL_CLEANUP_REASON,
} from './remote-desktop-worker-diagnostics.js';
import { DAEMON_VERSION } from '../util/version.js';
import {
  allowWindowsNamedPipeClients,
  launchWindowsActiveUserCommand,
  launchWindowsRemoteDesktopCommand,
  quoteWindowsArgument,
} from './windows-user-session.js';
import {
  WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
  verifyWindowsAuthenticodeSigners,
} from './windows-artifact-trust.js';
export { verifyWindowsAuthenticodeSigners } from './windows-artifact-trust.js';

// Cold launch performs a fail-closed Authenticode check before CreateProcess.
// Keep this below the end-to-end negotiation deadline while allowing slow
// revocation/provider checks on older Windows hosts to finish.
const CONNECT_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 2_000;
// PREPARE creates the capture source before the native worker can read an
// OFFER. A broken D3D/DXGI call can block that signaling-thread operation
// forever, which used to leave a live worker and a browser permanently at
// "handshaking". Normal first-frame admission is bounded to three seconds per
// display, so this leaves ample headroom without consuming the browser's
// 45-second negotiation budget.
// Once PREPARE is ready the native signaling thread must consume the browser
// OFFER and emit an ANSWER. Bound that separate stage as well: otherwise a
// wedged SetRemoteDescription leaves the UI at the same generic "handshake"
// step until the Server's much later negotiation deadline.
const VIRTUAL_DISPLAY_SHUTDOWN_GRACE_MS = 1_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PIPE_DIAGNOSTIC_ERROR_CODES = new Set([
  'EACCES',
  'ECONNABORTED',
  'ECONNRESET',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

const WORKER_LAUNCH_MODE = {
  SESSION: 'session',
  CONSENT_ONLY: 'consent_only',
  PRIVACY_ONLY: 'privacy_only',
} as const;

type WorkerLaunchMode = typeof WORKER_LAUNCH_MODE[keyof typeof WORKER_LAUNCH_MODE];

export const REMOTE_DESKTOP_COMPILED_SIGNER_SHA256 = WINDOWS_COMPILED_RELEASE_SIGNER_SHA256;

export interface VerifiedRemoteDesktopWorkerArtifact {
  executablePath: string;
  manifestPath: string;
  virtualDisplayDirectory: string;
  manifest: RemoteDesktopWorkerManifest;
}

function candidateExecutables(execPath = process.execPath): string[] {
  const explicit = process.env.IMCODES_REMOTE_DESKTOP_WORKER_EXE?.trim();
  const executableDir = dirname(resolve(execPath));
  return [...new Set([
    explicit,
    join(executableDir, 'remote-desktop-worker', 'win32-x64', REMOTE_DESKTOP_WORKER_FILENAME),
    join(executableDir, REMOTE_DESKTOP_WORKER_FILENAME),
    resolve(process.cwd(), 'dist', 'remote-desktop-worker', 'win32-x64', REMOTE_DESKTOP_WORKER_FILENAME),
  ].filter((value): value is string => Boolean(value)))];
}

export function verifyRemoteDesktopWorkerArtifact(
  executablePath: string,
  trustedSignerSha256 = REMOTE_DESKTOP_COMPILED_SIGNER_SHA256,
  expectedWorkerVersion = DAEMON_VERSION,
): VerifiedRemoteDesktopWorkerArtifact | null {
  try {
    if (!SHA256_RE.test(trustedSignerSha256)) return null;
    const manifestPath = `${executablePath}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
    const platformDirectory = dirname(executablePath);
    const virtualDisplayArchivePath = join(
      platformDirectory,
      REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
    );
    const virtualDisplayDirectory = join(platformDirectory, 'virtual-display');
    const virtualDisplayManifestPath = join(
      virtualDisplayDirectory,
      REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
    );
    const expectedPlatformEntries = new Set([
      REMOTE_DESKTOP_WORKER_FILENAME,
      `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`,
      REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
      'virtual-display',
    ]);
    const platformEntries = readdirSync(platformDirectory, { withFileTypes: true });
    if (platformEntries.length !== expectedPlatformEntries.size
      || platformEntries.some((entry) => !expectedPlatformEntries.has(entry.name))) return null;
    const executableStat = lstatSync(executablePath);
    const manifestStat = lstatSync(manifestPath);
    const virtualDisplayArchiveStat = lstatSync(virtualDisplayArchivePath);
    const virtualDisplayDirectoryStat = lstatSync(virtualDisplayDirectory);
    const virtualDisplayManifestStat = lstatSync(virtualDisplayManifestPath);
    if (!executableStat.isFile() || executableStat.isSymbolicLink()
      || !manifestStat.isFile() || manifestStat.isSymbolicLink()) return null;
    const rawManifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const manifest = validateRemoteDesktopWorkerManifest(rawManifest)
      ?? upgradeLegacyRemoteDesktopWorkerManifest(rawManifest, expectedWorkerVersion);
    if (!manifest || executableStat.size !== manifest.size
      || manifest.authenticodeSignerSha256 !== trustedSignerSha256) return null;
    const digest = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
    if (digest !== manifest.sha256) return null;
    if (!virtualDisplayArchiveStat.isFile() || virtualDisplayArchiveStat.isSymbolicLink()
      || virtualDisplayArchiveStat.size !== manifest.virtualDisplay.size
      || createHash('sha256').update(readFileSync(virtualDisplayArchivePath)).digest('hex')
        !== manifest.virtualDisplay.sha256
      || !virtualDisplayDirectoryStat.isDirectory() || virtualDisplayDirectoryStat.isSymbolicLink()
      || !virtualDisplayManifestStat.isFile() || virtualDisplayManifestStat.isSymbolicLink()) return null;
    const virtualDisplayManifest = validateRemoteDesktopVirtualDisplayPackageManifest(
      JSON.parse(readFileSync(virtualDisplayManifestPath, 'utf8')),
    );
    const expectedVirtualDisplayEntries = new Set<string>([
      REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
      ...(virtualDisplayManifest?.files.map((file) => file.name) ?? []),
    ]);
    const virtualDisplayEntries = readdirSync(virtualDisplayDirectory, { withFileTypes: true });
    if (!virtualDisplayManifest
      || virtualDisplayEntries.length !== expectedVirtualDisplayEntries.size
      || virtualDisplayEntries.some((entry) => !entry.isFile()
        || !expectedVirtualDisplayEntries.has(entry.name))
      || virtualDisplayManifest.dllSignerSha256 !== trustedSignerSha256
      || virtualDisplayManifest.catalogSignerSha256 !== trustedSignerSha256) return null;
    for (const file of virtualDisplayManifest.files) {
      const path = join(virtualDisplayDirectory, file.name);
      const fileStat = lstatSync(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== file.size
        || createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) return null;
    }
    return { executablePath, manifestPath, virtualDisplayDirectory, manifest };
  } catch {
    return null;
  }
}

export async function verifyRemoteDesktopWorkerArtifactForLaunch(
  artifact: VerifiedRemoteDesktopWorkerArtifact,
  trustedSignerSha256 = REMOTE_DESKTOP_COMPILED_SIGNER_SHA256,
  verifySigners: typeof verifyWindowsAuthenticodeSigners = verifyWindowsAuthenticodeSigners,
): Promise<VerifiedRemoteDesktopWorkerArtifact | null> {
  const current = verifyRemoteDesktopWorkerArtifact(
    artifact.executablePath,
    trustedSignerSha256,
  );
  if (!current) return null;
  const authentic = await verifySigners([
    current.executablePath,
    join(current.virtualDisplayDirectory, 'imcodes-virtual-display.dll'),
    join(current.virtualDisplayDirectory, 'imcodes-virtual-display.cat'),
  ], trustedSignerSha256);
  return authentic ? current : null;
}

export function resolveRemoteDesktopWorkerArtifact(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
  execPath = process.execPath,
  trustedSignerSha256 = REMOTE_DESKTOP_COMPILED_SIGNER_SHA256,
): VerifiedRemoteDesktopWorkerArtifact | null {
  if (platform !== 'win32' || arch !== 'x64') return null;
  for (const candidate of candidateExecutables(execPath)) {
    if (!existsSync(candidate)) continue;
    const verified = verifyRemoteDesktopWorkerArtifact(candidate, trustedSignerSha256);
    if (verified) return verified;
  }
  return null;
}

export function remoteDesktopWorkerPipePath(
  suffix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? `\\\\.\\pipe\\imcodes-remote-desktop-${suffix}`
    : join(tmpdir(), `imcodes-rd-${suffix}.sock`);
}

interface WindowsTrackedAuthorityState {
  virtualRetryAttempted: boolean;
  usesVirtualDisplay: boolean;
  secureConsoleRetryAttempted: boolean;
  correlationId: string;
  startedAt: number;
}

type TrackedAuthority = RemoteDesktopTrackedAuthority<WindowsTrackedAuthorityState>;

interface VirtualDisplayControllerProcess {
  readonly exitCode: number | null;
  readonly stdin: { end(): void };
  kill?(): boolean;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
}

export interface RemoteDesktopWorkerHostOptions {
  platform?: NodeJS.Platform;
  artifact?: VerifiedRemoteDesktopWorkerArtifact | null;
  pipePath?: string;
  trustedSignerSha256?: string;
  verifyArtifactForLaunch?: (
    artifact: VerifiedRemoteDesktopWorkerArtifact,
    trustedSignerSha256: string,
  ) => Promise<VerifiedRemoteDesktopWorkerArtifact | null>;
  allowPipeClients?: (path: string) => void | Promise<void>;
  /**
   * `args` is the same command line as `argsLine`, unserialised. A launcher that
   * spawns the worker directly should use it rather than re-parsing the string
   * this host just quoted.
   */
  launch?: (
    executable: string,
    argsLine: string,
    forceSecureConsole?: boolean,
    args?: readonly string[],
  ) => void;
  connectTimeoutMs?: number;
  virtualDisplayStartupMs?: number;
  virtualDisplayActivationMs?: number;
  virtualDisplayShutdownGraceMs?: number;
  /** Bound a native PREPARE that otherwise prevents the pipe from reading OFFER. */
  prepareReadyTimeoutMs?: number;
  /** Bound OFFER -> ANSWER after PREPARE has acknowledged readiness. */
  offerAnswerTimeoutMs?: number;
  /** Injectable only so the watchdog's process boundary is verifiable in tests. */
  terminateProcess?: (pid: number) => void;
  /** Emits only a redacted lifecycle signal; the authority never leaves this host. */
  onPrepareTimeout?: () => void;
  /** Emits only a redacted lifecycle signal. */
  onOfferTimeout?: () => void;
  launchVirtualDisplay?: (executable: string) => VirtualDisplayControllerProcess;
  activateVirtualDisplay?: (executable: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  onWorkerCrash?: (crash: RemoteDesktopWorkerCrash) => void;
  /** Closed-schema, payload-free lifecycle evidence. */
  onLifecycleEvent?: (event: RemoteDesktopWorkerDiagnosticEvent) => void;
  now?: () => number;
  spawnUnlockSecret?: typeof spawn;
}

/**
 * Session-0 control-plane host for the immutable active-user native worker.
 * Only validated bounded signaling/lease envelopes cross this pipe; the node
 * credential, database role, media, and input never do.
 */
export class RemoteDesktopWorkerHost {
  private readonly artifact: VerifiedRemoteDesktopWorkerArtifact | null;
  private readonly platform: NodeJS.Platform;
  private readonly trustedSignerSha256: string;
  private readonly nonce = randomBytes(32).toString('base64url');
  private readonly pipePath: string;
  private readonly core: RemoteDesktopWorkerHostCore<WindowsTrackedAuthorityState>;
  private readonly recoverableSocketLosses = new WeakMap<net.Socket, Set<string>>();
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private startPromise: Promise<void> | null = null;
  /** Identity of the in-flight start, so only it can retire its own memo. */
  private startToken: object | null = null;
  /** Accepted connections that have not completed the handshake yet. */
  private readonly pendingHelloSockets = new Set<net.Socket>();
  /** Which start produced a promoted socket, so its loss retires only its own. */
  private readonly socketStartToken = new WeakMap<net.Socket, object>();
  /** Launch mode belongs to the authenticated start generation, not the path. */
  private readonly launchModeByToken = new WeakMap<object, WorkerLaunchMode>();
  private readonly launchCorrelationByToken = new WeakMap<object, string>();
  private readonly launchStartedAtByToken = new WeakMap<object, number>();
  /** Authenticated worker pid for the socket; never inferred from its path. */
  private readonly workerConnectionBySocket = new WeakMap<net.Socket, {
    generation: number;
    workerPid: number;
    correlationId: string;
    startedAt: number;
  }>();
  private readonly diagnosedClosedSockets = new WeakSet<net.Socket>();
  private readonly erroredSockets = new WeakSet<net.Socket>();
  private readonly lifecycleEvent?: (event: RemoteDesktopWorkerDiagnosticEvent) => void;
  private virtualDisplayController: VirtualDisplayControllerProcess | null = null;
  private virtualDisplayStartPromise: Promise<void> | null = null;
  private virtualDisplayGeneration = 0;
  private closing = false;
  private workerSecureConsole = false;
  private workerLaunchMode: WorkerLaunchMode | null = null;

  constructor(
    private readonly onMessage: (message: RemoteDesktopDaemonMessage) => void,
    private readonly options: RemoteDesktopWorkerHostOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.trustedSignerSha256 = options.trustedSignerSha256
      ?? REMOTE_DESKTOP_COMPILED_SIGNER_SHA256;
    this.artifact = options.artifact === undefined
      ? resolveRemoteDesktopWorkerArtifact(
        this.platform,
        process.arch,
        process.execPath,
        this.trustedSignerSha256,
      )
      : options.artifact;
    this.pipePath = options.pipePath ?? remoteDesktopWorkerPipePath(
      `${process.pid}-${randomBytes(12).toString('hex')}`,
      this.platform,
    );
    const diagnostics = process.platform === 'win32'
      ? new RemoteDesktopWorkerDiagnostics()
      : null;
    this.lifecycleEvent = options.onLifecycleEvent
      ?? (diagnostics ? (event) => diagnostics.write(event) : undefined);
    this.core = new RemoteDesktopWorkerHostCore({
      nonce: this.nonce,
      prepareReadyTimeoutMs: options.prepareReadyTimeoutMs,
      offerAnswerTimeoutMs: options.offerAnswerTimeoutMs,
      onPrepareReady: (authority, connectionGeneration) => {
        this.emitAuthorityLifecycle(
          REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PREPARE_READY,
          authority,
          connectionGeneration,
          this.workerPidForGeneration(connectionGeneration),
        );
      },
      onOfferSent: (authority, connectionGeneration) => {
        this.emitAuthorityLifecycle(
          REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.OFFER_SENT,
          authority,
          connectionGeneration,
          this.workerPidForGeneration(connectionGeneration),
        );
      },
      onAnswer: (authority, connectionGeneration) => {
        this.emitAuthorityLifecycle(
          REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.ANSWER,
          authority,
          connectionGeneration,
          this.workerPidForGeneration(connectionGeneration),
        );
      },
      onAuthorityRemoved: () => this.stopVirtualDisplayIfUnused(),
      onWatchdogTimeout: (event) => {
        this.emitAuthorityLifecycle(
          event.stage === REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE.PREPARE_READY
            ? REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PREPARE_TIMEOUT
            : REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.OFFER_TIMEOUT,
          event.authority,
          event.connectionGeneration,
          event.workerPid,
        );
        this.emitAuthorityLifecycle(
          REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.CLEANUP,
          event.authority,
          event.connectionGeneration,
          event.workerPid,
          { cleanupReason: 'watchdog_timeout' },
        );
        try {
          if (event.stage === REMOTE_DESKTOP_WORKER_WATCHDOG_STAGE.PREPARE_READY) {
            this.options.onPrepareTimeout?.();
          } else {
            this.options.onOfferTimeout?.();
          }
        } catch { /* diagnostics never affect recovery */ }
        try {
          if (event.workerPid && event.workerPid > 0) {
            (this.options.terminateProcess ?? ((pid: number) => process.kill(pid)))(event.workerPid);
          }
        } catch {
          // The authenticated process may already have exited. Destroying its
          // exact connection still retires the poisoned worker generation.
        }
        const socket = this.socket;
        const connection = socket ? this.workerConnectionBySocket.get(socket) : undefined;
        if (socket && !socket.destroyed
          && connection?.generation === event.connectionGeneration) socket.destroy();
        this.onMessage(event.terminal);
      },
    });
  }

  /** Compatibility inspection seam for existing white-box tests only. */
  private get tracked(): ReadonlyMap<string, TrackedAuthority> {
    return this.core.authorities();
  }

  available(): boolean {
    return this.platform === 'win32' && this.artifact !== null
      && SHA256_RE.test(this.trustedSignerSha256);
  }

  /** The shipped Windows host remains on the byte-compatible v2 profile. */
  sessionCapabilities(): readonly string[] {
    return [REMOTE_DESKTOP_CAPABILITY];
  }

  /**
   * Capabilities implemented by the verified worker artifact in this build.
   * Keep this declaration independent from `available()`: callers still gate
   * the returned matrix on artifact verification and the remote-desktop kill
   * switch. Local consent is independent because this build can launch the
   * signed worker in prompt-only mode before PREPARE without initializing
   * capture, input or WebRTC. The signed account shell is a separately signed
   * sidecar and is therefore advertised by runtime only after its independent
   * artifact/launcher trust probe; it never belongs to the Worker matrix.
   */
  adapterCapabilities(): readonly RemoteDesktopAdapterCapability[] {
    return [
      REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
      REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    ];
  }

  /**
   * The verified Windows Worker can start in privacy-only mode before PREPARE,
   * retain the host-wide epoch while it is promoted in place, default-shield
   * every subsequently created source, and acknowledge only the exact durable
   * route-id/route-generation snapshot received in BEGIN.
   */
  supportsDefaultShieldedRoute(): boolean {
    return true;
  }

  private async verifiedArtifactForLaunch(): Promise<VerifiedRemoteDesktopWorkerArtifact> {
    const artifact = this.artifact;
    if (!artifact) throw new Error('remote_desktop_worker_unavailable');
    const verified = await (this.options.verifyArtifactForLaunch
      ?? verifyRemoteDesktopWorkerArtifactForLaunch)(artifact, this.trustedSignerSha256);
    if (!verified) throw new Error('remote_desktop_worker_authenticity_failed');
    return verified;
  }

  private async launchVerified(
    args: readonly string[],
    allowSecureDesktopFallback = true,
    forceSecureConsole = false,
    correlationId = this.newCorrelationId(),
    launchMode: WorkerLaunchMode = WORKER_LAUNCH_MODE.SESSION,
    startedAt = this.now(),
  ): Promise<void> {
    const artifact = await this.verifiedArtifactForLaunch();
    const argsLine = args.map(quoteWindowsArgument).join(' ');
    if (this.options.launch) {
      this.options.launch(artifact.executablePath, argsLine, forceSecureConsole, args);
    } else {
      launchWindowsRemoteDesktopCommand(
        artifact.executablePath,
        argsLine,
        spawn,
        allowSecureDesktopFallback,
        forceSecureConsole,
      );
    }
    this.emitLifecycle({
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.SPAWN_VERIFIED,
      correlationId,
      elapsedMs: this.elapsedSince(startedAt),
      launchMode,
      stdio: 'ignored',
    });
  }

  /**
   * Store or clear the node's sign-in secret by running the verified worker in
   * its one-shot mode. The secret is written to the child's stdin, never to a
   * command line: argv is readable by any local process through WMI. It is not
   * retained here, not logged, and the worker is the only thing that can read
   * the encrypted result back.
   */
  async applyAutoUnlockSecret(secret: string | null): Promise<boolean> {
    if (!this.available()) throw new Error('remote_desktop_worker_unavailable');
    const artifact = await this.verifiedArtifactForLaunch();
    const mode = secret === null ? '--clear-unlock-secret' : '--set-unlock-secret';
    const child = (this.options.spawnUnlockSecret ?? spawn)(
      artifact.executablePath,
      [mode],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once('error', () => resolveExit(null));
      child.once('exit', (code) => resolveExit(code));
      if (secret !== null) child.stdin?.end(Buffer.from(secret, 'utf8'));
      else child.stdin?.end();
    });
    return exitCode === 0;
  }

  /** Whether a sign-in secret is stored, without ever reading its value. */
  async autoUnlockConfigured(): Promise<boolean> {
    if (!this.available()) return false;
    const artifact = await this.verifiedArtifactForLaunch();
    const child = (this.options.spawnUnlockSecret ?? spawn)(
      artifact.executablePath,
      ['--unlock-secret-state'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once('error', () => resolveExit(null));
      child.once('exit', (code) => resolveExit(code));
    });
    return exitCode === 0;
  }

  async handle(message: unknown): Promise<boolean> {
    const parsed = validateRemoteDesktopDaemonCommand(message);
    if (!parsed.ok || !this.available()) return false;
    const command = parsed.value;
    if (command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      const finishPreparing = this.core.beginPreparing(command.sessionId);
      try {
        return await this.handleValidated(command);
      } finally {
        finishPreparing();
      }
    }
    if (command.type !== REMOTE_DESKTOP_MSG.STOP
      && command.type !== REMOTE_DESKTOP_MSG.CANCEL) {
      // The Server sends signaling as soon as PREPARE is admitted. A verified
      // Windows cold start can take seconds, and several callers can enter
      // handle() concurrently. Waiting for the PREPARE write (not merely the
      // shared start promise) preserves the worker protocol's required order.
      await this.core.waitForPreparing(command.sessionId);
    }
    return this.handleValidated(command);
  }

  private async handleValidated(command: RemoteDesktopDaemonCommand): Promise<boolean> {
    let recoverIdlePrepare = false;
    if (command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      recoverIdlePrepare = this.core.size === 0 && !this.core.isPrivacyEpochArmed;
      // Tracked before the start, not after: the offer that follows this
      // PREPARE arrives while the cold start is still running, and it can only
      // be told to wait for that start if the session it names is already
      // known here.
      const diagnosticAuthority = this.track(command);
      try {
        if (recoverIdlePrepare) {
          // A completed peer leaves process-local ICE, encoder and DXGI
          // teardown behind the pipe becoming idle. Reusing that process made
          // the first session work and a later attempt remain in negotiation
          // until the Server's 45-second timeout. The authority is tracked
          // first so its immediately-following OFFER waits for this recycle.
          await this.recycleWorkerSocket(command.sessionId);
        }
        await this.ensureStarted(
          WORKER_LAUNCH_MODE.SESSION,
          false,
          diagnosticAuthority.metadata.correlationId,
          diagnosticAuthority.metadata.startedAt,
        );
      } catch (error) {
        this.untrack(command.sessionId);
        throw error;
      }
      if (recoverIdlePrepare && (!this.socket || this.socket.destroyed)) {
        // The same stale-idle race as a failed write, one step earlier: a warm
        // worker exits on its own between sessions, the pipe still looked alive
        // when it was checked, and the close landed before it could be used.
        // Returning here would surface that as `worker_failed` on the first
        // connect after any quiet period — the session is already tracked, so
        // cold-start one verified replacement instead.
        this.untrackForInternalRecovery(command.sessionId);
        await this.ensureStarted(
          WORKER_LAUNCH_MODE.SESSION,
          false,
          diagnosticAuthority.metadata.correlationId,
          diagnosticAuthority.metadata.startedAt,
        );
        this.track(command, diagnosticAuthority.metadata);
        if (!this.socket || this.socket.destroyed) {
          // The replacement did not come up. Drop the authority before giving
          // up: a tracked session nobody will ever stop again would make every
          // later PREPARE look like a busy host, disabling this very recovery
          // for good and leaving its capability unwiped.
          this.untrack(command.sessionId);
          throw new Error('remote_desktop_worker_recovery_failed');
        }
      }
    } else if (!this.socket || this.socket.destroyed) {
      // The rest of a session's negotiation — its offer, its ICE — arrives
      // within a second of the PREPARE that admitted it, while the cold start
      // that PREPARE began is still running: verifying the signed artifact
      // alone takes seconds on a real node before the worker is even spawned.
      // Declining here is reported as `worker_failed`, which ends a session
      // that was about to work and is exactly what made a first connect after
      // any quiet period fail. Wait for the start this session already owns.
      const diagnosticAuthority = this.core.get(command.sessionId);
      if (!diagnosticAuthority) return false;
      await this.ensureStarted(
        WORKER_LAUNCH_MODE.SESSION,
        false,
        diagnosticAuthority.metadata.correlationId,
        diagnosticAuthority.metadata.startedAt,
      );
      if (!this.socket || this.socket.destroyed) return false;
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) return false;
    let sent = await this.writeToWorker(
      socket,
      command,
      recoverIdlePrepare && command.type === REMOTE_DESKTOP_MSG.PREPARE
        ? command.sessionId
        : undefined,
    );
    if (!sent && recoverIdlePrepare && command.type === REMOTE_DESKTOP_MSG.PREPARE
      && this.core.has(command.sessionId)) {
      // A warm idle worker can exit between sessions while the service-side
      // pipe has not observed the close yet. Do not surface that stale-pipe
      // race as worker_failed: no other authority is alive, so cold-start one
      // verified replacement and retry this PREPARE exactly once.
      const diagnosticAuthority = this.core.get(command.sessionId)!;
      this.untrackForInternalRecovery(command.sessionId);
      await this.ensureStarted(
        WORKER_LAUNCH_MODE.SESSION,
        false,
        diagnosticAuthority.metadata.correlationId,
        diagnosticAuthority.metadata.startedAt,
      );
      this.track(command, diagnosticAuthority.metadata);
      const replacement = this.socket;
      if (!replacement || replacement.destroyed) {
        this.untrack(command.sessionId);
        throw new Error('remote_desktop_worker_recovery_failed');
      }
      sent = await this.writeToWorker(replacement, command);
    }
    if (!sent) {
      return true;
    }
    if (command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      this.armPrepareReadyTimer(command.sessionId, this.socket);
    } else if (command.type === REMOTE_DESKTOP_MSG.OFFER) {
      this.markOfferPending(command.sessionId, this.socket);
    }
    if (sent && (command.type === REMOTE_DESKTOP_MSG.STOP
      || command.type === REMOTE_DESKTOP_MSG.CANCEL)) {
      this.untrack(command.sessionId, command.type === REMOTE_DESKTOP_MSG.STOP
        ? 'controller_stop'
        : 'controller_cancel');
    }
    if (sent && command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      const authority = this.core.get(command.sessionId);
      const connection = this.socket
        ? this.workerConnectionBySocket.get(this.socket)
        : undefined;
      if (authority) {
        this.emitAuthorityLifecycle(
          REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PREPARE_SENT,
          authority,
          connection?.generation,
          connection?.workerPid,
        );
      }
    }
    return sent;
  }

  /**
   * Hand a consent frame to the worker. When no session worker exists, launch
   * the same verified binary in prompt-only mode. That process never creates
   * capture/input/media authority and accepts only consent frames natively.
   */
  async sendConsentFrame(frame: Record<string, unknown>): Promise<boolean> {
    if (frame.type === WORKER_CONSENT_FRAME.DISMISS
      && (!this.socket || this.socket.destroyed)) return false;
    try {
      await this.ensureStarted(WORKER_LAUNCH_MODE.CONSENT_ONLY);
    } catch {
      return false;
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) return false;
    return this.writeToWorker(socket, frame);
  }

  /**
   * Privacy must never use the consent-only process. A BEGIN cold-starts a
   * distinct persistent privacy-capable Worker before PREPARE; it has no
   * session authority until a validated PREPARE arrives, then is promoted in
   * place so its host-wide epoch survives until the first opaque source.
   */
  async sendPrivacyFrame(frame: Record<string, unknown>): Promise<boolean> {
    if (frame.type !== WORKER_PRIVACY_FRAME.SHIELD
      && frame.type !== WORKER_PRIVACY_FRAME.RELEASE) return false;
    if (frame.type === WORKER_PRIVACY_FRAME.RELEASE
      && (!this.socket || this.socket.destroyed)) return false;
    try {
      await this.ensureStarted(WORKER_LAUNCH_MODE.PRIVACY_ONLY);
    } catch {
      return false;
    }
    const socket = this.socket;
    if (!socket || socket.destroyed
      || this.workerLaunchMode === WORKER_LAUNCH_MODE.CONSENT_ONLY) {
      return false;
    }
    const sent = await this.writeToWorker(socket, frame);
    if (sent && frame.type === WORKER_PRIVACY_FRAME.SHIELD) this.core.markPrivacyShielded();
    return sent;
  }

  onPrivacyFrame(handler: (frame: WorkerPrivacyInboundFrame) => void): () => void {
    return this.core.onPrivacyFrame(handler);
  }

  onConsentFrame(handler: (frame: WorkerConsentInboundFrame) => void): () => void {
    return this.core.onConsentFrame(handler);
  }

  private async writeToWorker(
    socket: net.Socket,
    message: unknown,
    recoverIdleSessionId?: string,
  ): Promise<boolean> {
    let failureCode: string | null = null;
    if (recoverIdleSessionId) {
      const sessions = this.recoverableSocketLosses.get(socket) ?? new Set<string>();
      sessions.add(recoverIdleSessionId);
      this.recoverableSocketLosses.set(socket, sessions);
    }
    const sent = await new Promise<boolean>((resolveSent) => {
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        socket.off('error', onLost);
        socket.off('close', onLost);
        resolveSent(success);
      };
      const onLost = (error?: Error) => {
        if (error) failureCode = this.safeErrorCode(error);
        finish(false);
      };
      socket.once('error', onLost);
      socket.once('close', onLost);
      try {
        socket.write(this.core.frameOutbound(message), (error) => {
          if (error) failureCode = this.safeErrorCode(error);
          finish(!error);
        });
      } catch (error) {
        failureCode = error instanceof Error ? this.safeErrorCode(error) : 'UNKNOWN';
        finish(false);
      }
    });
    if (sent) {
      const sessions = this.recoverableSocketLosses.get(socket);
      sessions?.delete(recoverIdleSessionId ?? '');
      if (sessions?.size === 0) this.recoverableSocketLosses.delete(socket);
      return true;
    }
    // A failed named-pipe write is terminal for this worker connection. Do
    // not leave the resolved start promise and a poisoned socket in place:
    // every later session would otherwise reuse it and immediately return
    // worker_failed until the whole node process was restarted.
    const connection = this.workerConnectionBySocket.get(socket);
    if (connection) {
      this.emitLifecycle({
        event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PIPE_ERROR,
        correlationId: connection.correlationId,
        workerGeneration: connection.generation,
        workerPid: connection.workerPid,
        elapsedMs: this.elapsedSince(connection.startedAt),
        errorCode: failureCode ?? 'WRITE_FAILED',
      });
    }
    this.erroredSockets.add(socket);
    this.onSocketLost(socket);
    socket.destroy();
    this.recoverableSocketLosses.delete(socket);
    return false;
  }

  private async recycleWorkerSocket(recoveringSessionId?: string): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    if (recoveringSessionId === undefined) {
      if (this.core.size > 0) return;
    } else if (this.core.size !== 1 || !this.core.has(recoveringSessionId)) {
      return;
    }
    // A browser reconnect follows a failed negotiation or receive-progress
    // path, and an independent new session must not inherit its predecessor's
    // process-local WebRTC / DXGI state either. Mark this deliberate socket
    // loss recoverable before closing it, otherwise onSocketLost would fail
    // the authority which is already tracked to serialize its following OFFER.
    if (recoveringSessionId !== undefined) {
      const recoverable = this.recoverableSocketLosses.get(socket) ?? new Set<string>();
      recoverable.add(recoveringSessionId);
      this.recoverableSocketLosses.set(socket, recoverable);
    }
    await new Promise<void>((resolveClosed) => {
      socket.once('close', resolveClosed);
      socket.destroy();
    });
  }

  close(): void {
    this.closing = true;
    this.failTracked(REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED);
    const socket = this.socket;
    socket?.destroy();
    this.socket = null;
    this.workerLaunchMode = null;
    // Explicit host teardown is not a socket-generation callback. It must
    // retire partial framing and the privacy epoch even when no current socket
    // exists or its generation bookkeeping has already moved on.
    this.core.resetConnection();
    this.server?.close();
    this.server = null;
    this.startPromise = null;
    this.stopVirtualDisplayController();
    this.closing = false;
  }

  private track(
    prepare: RemoteDesktopPrepare,
    diagnosticContext?: Pick<WindowsTrackedAuthorityState, 'correlationId' | 'startedAt'>,
  ): TrackedAuthority {
    return this.core.track(prepare, {
      virtualRetryAttempted: false,
      usesVirtualDisplay: this.virtualDisplayController !== null,
      secureConsoleRetryAttempted: false,
      correlationId: diagnosticContext?.correlationId
        ?? this.correlationIdFor(prepare),
      startedAt: diagnosticContext?.startedAt ?? this.now(),
    });
  }

  /**
   * The native process emits MODE_STATE once PREPARE has actually completed.
   * Until then its pipe reader may be blocked inside D3D/DXGI initialization,
   * so neither OFFER nor STOP can make progress. Kill only the authenticated
   * worker process and report a normal worker_failed terminal: the panel's
   * existing bounded retry starts a fresh worker/pipe generation.
   */
  private armPrepareReadyTimer(sessionId: string, socket: net.Socket | null): void {
    if (!socket || socket.destroyed) return;
    const connection = this.workerConnectionBySocket.get(socket);
    if (!connection) return;
    this.core.armPrepareReadyTimer(sessionId, {
      connectionGeneration: connection.generation,
      workerPid: connection.workerPid,
    });
  }

  private clearTrackedTimers(tracked: TrackedAuthority): void {
    this.core.clearTrackedTimers(tracked);
  }

  private markOfferPending(sessionId: string, socket: net.Socket | null): void {
    if (!socket || socket.destroyed) return;
    const connection = this.workerConnectionBySocket.get(socket);
    if (!connection) return;
    this.core.markOfferPending(sessionId, {
      connectionGeneration: connection.generation,
      workerPid: connection.workerPid,
    });
  }

  /**
   * At most one cold start runs at a time.
   *
   * The memo is the mutex: the check below and the assignment that follows it
   * happen with no await in between, so two inbound messages arriving together
   * cannot each tear down the listener and launch a worker. A settled attempt
   * whose pipe is already gone is retired only by the caller that awaited that
   * exact attempt, so retiring it can never clobber a fresh start someone else
   * has begun.
   */
  private async ensureStarted(
    requestedMode: WorkerLaunchMode,
    forceSecureConsole = false,
    correlationId = this.newCorrelationId(),
    startedAt = this.now(),
  ): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      if (this.canReuseWorker(requestedMode)) return;
      await this.recycleWorkerSocket();
    }
    const inFlight = this.startPromise;
    if (inFlight) {
      try {
        await inFlight;
      } finally {
        if (this.startPromise === inFlight
          && !(this.socket && !this.socket.destroyed)) {
          // Settled, with no live pipe behind it. Keeping it would make every
          // later start a silent no-op that reports success with no worker.
          this.startPromise = null;
        }
      }
      if (this.socket && !this.socket.destroyed) {
        if (this.canReuseWorker(requestedMode)) return;
        await this.recycleWorkerSocket();
      }
    }
    const attempt = this.startPromise
      ?? this.beginWorkerStart(
        requestedMode,
        forceSecureConsole,
        correlationId,
        startedAt,
      );
    this.startPromise = attempt;
    await attempt;
  }

  private canReuseWorker(requestedMode: WorkerLaunchMode): boolean {
    if (this.workerLaunchMode === WORKER_LAUNCH_MODE.SESSION) return true;
    if (requestedMode === WORKER_LAUNCH_MODE.CONSENT_ONLY) return true;
    if (this.workerLaunchMode === WORKER_LAUNCH_MODE.PRIVACY_ONLY) {
      if (requestedMode === WORKER_LAUNCH_MODE.SESSION) {
        // Promotion changes only the host's routing state. Native already has
        // the session parser, but no capture/input authority exists until the
        // validated PREPARE that follows this transition.
        this.workerLaunchMode = WORKER_LAUNCH_MODE.SESSION;
      }
      return true;
    }
    return false;
  }

  private beginWorkerStart(
    launchMode: WorkerLaunchMode,
    forceSecureConsole: boolean,
    correlationId: string,
    startedAt: number,
  ): Promise<void> {
    if (!this.artifact) {
      return Promise.reject(new Error('remote_desktop_worker_unavailable'));
    }
    // A previous start may still own the listening pipe: hand it back before
    // listening again, or the cold start fails on its own leftovers. Closing
    // the listener is not awaited — that callback waits for every accepted
    // connection to end, and a client that never finishes the handshake would
    // hold this start hostage before its own deadline is even armed. Those
    // half-open connections are dropped here instead.
    if (this.server) {
      const previous = this.server;
      this.server = null;
      previous.close();
      for (const pending of this.pendingHelloSockets) pending.destroy();
      this.pendingHelloSockets.clear();
    }
    if (!(this.platform === 'win32' && this.pipePath.startsWith('\\\\.\\pipe\\'))) {
      // Windows named pipes disappear with their handle; a unix socket path
      // does not, and the stale file would refuse the new listener. Removed
      // synchronously so this whole start stays free of await points.
      try { rmSync(this.pipePath, { force: true }); } catch { /* fresh path */ }
    }
    // Identity for this attempt, so a failure can only retire its own memo and
    // never a start that has since replaced it.
    const token = {};
    this.startToken = token;
    this.launchModeByToken.set(token, launchMode);
    this.launchCorrelationByToken.set(token, correlationId);
    this.launchStartedAtByToken.set(token, startedAt);
    return new Promise<void>((resolveStarted, rejectStarted) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (error) {
          this.server?.close();
          this.server = null;
          if (this.startToken === token) {
            this.startPromise = null;
            this.startToken = null;
          }
          rejectStarted(error);
        } else {
          resolveStarted();
        }
      };
      const server = net.createServer((socket) => this.accept(socket, () => finish()));
      this.server = server;
      const connectTimer = setTimeout(
        () => finish(new Error('remote_desktop_worker_connect_timeout')),
        this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      );
      connectTimer.unref?.();
      server.once('error', (error) => finish(error));
      const windowsPipe = this.platform === 'win32'
        && this.pipePath.startsWith('\\\\.\\pipe\\');
      server.listen({ path: this.pipePath }, () => {
        void (async () => {
          try {
          if (windowsPipe) {
              await (this.options.allowPipeClients
                ?? allowWindowsNamedPipeClients)(this.pipePath);
          }
            await this.launchVerified(
              [
                '--pipe', this.pipePath, '--nonce', this.nonce,
                ...(launchMode === WORKER_LAUNCH_MODE.CONSENT_ONLY
                  ? ['--consent-only']
                  : launchMode === WORKER_LAUNCH_MODE.PRIVACY_ONLY
                    ? ['--privacy-only']
                    : []),
              ],
              launchMode !== WORKER_LAUNCH_MODE.CONSENT_ONLY,
              forceSecureConsole,
              correlationId,
              launchMode,
              startedAt,
            );
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
    });
  }

  private accept(socket: net.Socket, ready: () => void): void {
    socket.setEncoding('utf8');
    socket.setTimeout(HELLO_TIMEOUT_MS, () => socket.destroy());
    // The idle timeout above restarts on every byte, and the pipe admits any
    // authenticated local process, so a client that trickles data could hold an
    // accepted connection for as long as it liked — keeping the listener's
    // connection count above zero and this host's handshake budget open. Bound
    // the whole handshake, not just the gaps in it.
    this.pendingHelloSockets.add(socket);
    const handshakeDeadline = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    handshakeDeadline.unref?.();
    const finishHandshake = () => {
      clearTimeout(handshakeDeadline);
      this.pendingHelloSockets.delete(socket);
    };
    socket.once('close', finishHandshake);
    let helloBuffer = '';
    const onHello = (chunk: string | Buffer) => {
      helloBuffer += String(chunk);
      if (Buffer.byteLength(helloBuffer, 'utf8') > REMOTE_DESKTOP_WORKER_MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = helloBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = helloBuffer.slice(0, newline).trim();
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch {
        socket.destroy();
        return;
      }
      if (!validateRemoteDesktopWorkerHello(parsed, this.nonce)) {
        socket.destroy();
        return;
      }
      // Which desktop this worker actually owns decides where its replacement
      // has to go if the desktop switches under it.
      this.workerSecureConsole = parsed.secureConsole === true;
      const remainder = helloBuffer.slice(newline + 1);
      socket.off('data', onHello);
      socket.setTimeout(0);
      finishHandshake();
      if (this.socket && !this.socket.destroyed) this.socket.destroy();
      this.socket = socket;
      if (this.startToken) {
        this.socketStartToken.set(socket, this.startToken);
        this.workerLaunchMode = this.launchModeByToken.get(this.startToken) ?? null;
      }
      const generation = this.core.beginConnection();
      const correlationId = this.startToken
        ? this.launchCorrelationByToken.get(this.startToken) ?? this.newCorrelationId()
        : this.newCorrelationId();
      const startedAt = this.startToken
        ? this.launchStartedAtByToken.get(this.startToken) ?? this.now()
        : this.now();
      this.workerConnectionBySocket.set(socket, {
        generation,
        workerPid: parsed.pid,
        correlationId,
        startedAt,
      });
      socket.on('data', (data) => this.onData(String(data), socket, generation));
      socket.on('close', (hadError) => {
        this.emitPipeClosed(socket, hadError);
        this.onSocketLost(socket);
      });
      socket.on('error', (error) => {
        this.erroredSockets.add(socket);
        const connection = this.workerConnectionBySocket.get(socket);
        if (connection) {
          this.emitLifecycle({
            event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PIPE_ERROR,
            correlationId: connection.correlationId,
            workerGeneration: connection.generation,
            workerPid: connection.workerPid,
            elapsedMs: this.elapsedSince(connection.startedAt),
            errorCode: this.safeErrorCode(error),
          });
        }
        this.onSocketLost(socket);
      });
      if (remainder) this.onData(remainder, socket, generation);
      ready();
    };
    socket.on('data', onHello);
  }

  private onData(chunk: string, socket: net.Socket, generation: number): void {
    const inbound = this.core.pushInbound(chunk, generation);
    if (inbound.overflow) {
      socket.destroy();
      return;
    }
    for (const event of inbound.events) {
      if (event.kind === 'crash') {
        // The worker faulted and is already gone. Surface it before the socket
        // loss turns into an anonymous `worker_failed`; the frame carries no
        // session, capability, media, or input data.
        const connection = this.workerConnectionBySocket.get(socket);
        if (connection) {
          this.emitLifecycle({
            event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.CRASH_FRAME,
            correlationId: connection.correlationId,
            workerGeneration: connection.generation,
            workerPid: connection.workerPid,
            elapsedMs: this.elapsedSince(connection.startedAt),
          });
        }
        this.options.onWorkerCrash?.(event.value);
        continue;
      }
      const tracked = event.authority;
      if (event.value.type === REMOTE_DESKTOP_MSG.TERMINAL) {
        // `media_unavailable` also covers transient DXGI/DWM failures while a
        // physical output is switching. Only the worker's explicit initial
        // no-display result is allowed to add a third, virtual display.
        if (event.value.reason === REMOTE_DESKTOP_TERMINAL_REASON.HEADLESS_DISPLAY
          && !tracked.metadata.virtualRetryAttempted) {
          tracked.metadata.virtualRetryAttempted = true;
          void this.retryWithVirtualDisplay(event.value, tracked);
          continue;
        }
        // The worker owns the only authoritative view of the input desktop. A
        // protected-desktop answer to PREPARE means this worker was launched
        // onto the wrong one — a session locked, or a lingering LogonUI made a
        // logged-in machine look like the sign-in screen. Replace it once with
        // a worker on the privileged desktop instead of failing the session.
        if (event.value.reason === REMOTE_DESKTOP_TERMINAL_REASON.PROTECTED_DESKTOP
          && !tracked.metadata.secureConsoleRetryAttempted) {
          tracked.metadata.secureConsoleRetryAttempted = true;
          void this.retryOnOtherDesktop(event.value, tracked);
          continue;
        }
        this.untrack(event.value.sessionId, REMOTE_DESKTOP_WORKER_DECLARED_TERMINAL_CLEANUP_REASON);
      }
      this.onMessage(event.value);
    }
  }

  private onSocketLost(socket: net.Socket): void {
    this.emitPipeClosed(socket, this.erroredSockets.has(socket));
    const recoverableSessions = this.recoverableSocketLosses.get(socket);
    const recoverable = recoverableSessions?.size === 1
      && this.core.size === 1
      && this.core.has([...recoverableSessions][0]!);
    this.recoverableSocketLosses.delete(socket);
    const token = this.socketStartToken.get(socket);
    this.socketStartToken.delete(socket);
    const connection = this.workerConnectionBySocket.get(socket);
    this.workerConnectionBySocket.delete(socket);
    if (this.socket !== socket) return;
    this.socket = null;
    this.workerLaunchMode = null;
    if (connection) this.core.endConnection(connection.generation);
    if (token !== undefined && this.startToken !== token) {
      // A newer start already owns the listener and the memo. This loss belongs
      // to the generation before it, so tearing those down here would close a
      // listener the replacement is still waiting on.
      this.pendingHelloSockets.delete(socket);
    } else {
      this.server?.close();
      this.server = null;
      this.startPromise = null;
      this.startToken = null;
    }
    if (!this.closing && !recoverable) {
      // If the worker crashed before its normal release-all path, launch the
      // immutable verified binary once in release-only mode on the same active
      // desktop. This command carries no credential, authority, or key history.
      if (this.core.size > 0 && this.artifact) {
        void this.launchVerified(['--release-all-input'], false).catch(() => {
          // The Server is still notified and the short lease still expires;
          // this best-effort recovery cannot restore a dead worker.
        });
      }
      this.failTracked(REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED);
    }
  }

  private failTracked(reason: typeof REMOTE_DESKTOP_TERMINAL_REASON[keyof typeof REMOTE_DESKTOP_TERMINAL_REASON]): void {
    for (const authority of this.core.authorities().values()) {
      const connection = this.socket
        ? this.workerConnectionBySocket.get(this.socket)
        : undefined;
      this.emitAuthorityLifecycle(
        REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.CLEANUP,
        authority,
        connection?.generation,
        connection?.workerPid,
        { cleanupReason: reason },
      );
    }
    this.core.failAll(reason, this.onMessage);
    this.stopVirtualDisplayController();
  }

  private untrack(sessionId: string, cleanupReason = 'authority_removed'): void {
    const authority = this.core.get(sessionId);
    if (authority) {
      const connection = this.socket
        ? this.workerConnectionBySocket.get(this.socket)
        : undefined;
      this.emitAuthorityLifecycle(
        REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.CLEANUP,
        authority,
        connection?.generation,
        connection?.workerPid,
        { cleanupReason },
      );
      // A worker that DECLARES a terminal is not thereby gone. Observed on a
      // real Windows node: the host logged cleanupReason="worker_terminal" and
      // the worker process then held the session for 60.7 minutes, failing
      // every retry as protocol_error until it happened to exit on its own.
      //
      // The watchdog-timeout path already reaps the pid for exactly this
      // reason. Ending a session must not depend on the worker's goodwill, so
      // the self-declared terminal is reaped the same way. Other cleanup
      // reasons keep the existing behaviour: a controller stop lets the worker
      // exit on its own, and a pipe that already closed proves it is gone.
      if (cleanupReason === REMOTE_DESKTOP_WORKER_DECLARED_TERMINAL_CLEANUP_REASON) {
        this.reapWorkerProcess(connection?.workerPid);
      }
    }
    this.core.untrack(sessionId);
  }

  /**
   * Terminate a worker pid that has outlived its session. Never throws: the
   * process may legitimately have exited between the terminal and this call,
   * and a failed reap must not break session teardown.
   */
  private reapWorkerProcess(workerPid: number | undefined): void {
    if (!workerPid || workerPid <= 0) return;
    try {
      (this.options.terminateProcess ?? ((pid: number) => process.kill(pid)))(workerPid);
    } catch {
      // Already exited, or not ours to signal. Teardown continues either way.
    }
  }

  private untrackForInternalRecovery(sessionId: string): void {
    // The same admitted authority/correlation continues after a stale pipe is
    // replaced. Retire and zeroize its old capability copy without recording
    // a terminal CLEANUP; the replacement attempt will emit the one terminal
    // cleanup when that authority actually ends.
    this.core.untrack(sessionId);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private newCorrelationId(): string {
    return randomBytes(12).toString('hex');
  }

  private correlationIdFor(prepare: RemoteDesktopPrepare): string {
    // Stable for one admitted authority without exposing its request/session
    // identifiers in the LocalSystem log.
    return createHash('sha256')
      .update('remote-desktop-worker-diagnostics-v1\0')
      .update(prepare.requestId)
      .update('\0')
      .update(prepare.sessionId)
      .digest('hex')
      .slice(0, 24);
  }

  private elapsedSince(startedAt: number): number {
    return Math.max(0, Math.floor(this.now() - startedAt));
  }

  private emitLifecycle(event: RemoteDesktopWorkerDiagnosticEvent): void {
    try {
      this.lifecycleEvent?.(event);
    } catch {
      // Diagnostics are evidence only. They must never change worker control.
    }
  }

  private emitAuthorityLifecycle(
    event: RemoteDesktopWorkerDiagnosticEvent['event'],
    authority: TrackedAuthority,
    workerGeneration?: number,
    workerPid?: number | null,
    extra: Pick<RemoteDesktopWorkerDiagnosticEvent, 'cleanupReason'> = {},
  ): void {
    this.emitLifecycle({
      event,
      correlationId: authority.metadata.correlationId,
      elapsedMs: this.elapsedSince(authority.metadata.startedAt),
      ...(workerGeneration === undefined ? {} : { workerGeneration }),
      ...(workerPid === undefined ? {} : { workerPid }),
      ...extra,
    });
  }

  private safeErrorCode(error: Error): string {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' && PIPE_DIAGNOSTIC_ERROR_CODES.has(code.toUpperCase())
      ? code.toUpperCase()
      : 'UNKNOWN';
  }

  private workerPidForGeneration(generation: number): number | undefined {
    const connection = this.socket
      ? this.workerConnectionBySocket.get(this.socket)
      : undefined;
    return connection?.generation === generation ? connection.workerPid : undefined;
  }

  private emitPipeClosed(socket: net.Socket, hadError: boolean): void {
    if (this.diagnosedClosedSockets.has(socket)) return;
    this.diagnosedClosedSockets.add(socket);
    const connection = this.workerConnectionBySocket.get(socket);
    if (!connection) return;
    const common = {
      correlationId: connection.correlationId,
      workerGeneration: connection.generation,
      workerPid: connection.workerPid,
      elapsedMs: this.elapsedSince(connection.startedAt),
    };
    this.emitLifecycle({
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PIPE_CLOSE,
      ...common,
      hadError,
    });
    // The worker is launched through CreateProcessAsUser by an indirect,
    // detached launcher. The authenticated pipe closing is observable, but a
    // reliable exit status is not; keep the unknown values explicit.
    this.emitLifecycle({
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PROCESS_EXIT,
      ...common,
      exitCode: null,
      signal: null,
      observedBy: 'pipe_close',
    });
  }

  private async retryOnOtherDesktop(
    terminal: RemoteDesktopDaemonMessage,
    tracked: TrackedAuthority,
  ): Promise<void> {
    // Go to the desktop this worker was not on. A privileged Winlogon worker
    // reports this when the user signs in, and an ordinary worker reports it
    // when the screen locks; both mean the replacement belongs on the other
    // side, and the default launch decision alone cannot tell them apart.
    const forceSecureConsole = !this.workerSecureConsole;
    try {
      // Drop the misplaced worker first: its pipe is the only handle the
      // replacement can reuse, and a stale one would keep answering. The
      // authority is only detached from the map here — untrack() would wipe
      // the capability this same session still has to authenticate with.
      this.clearTrackedTimers(tracked);
      tracked.prepareReady = false;
      tracked.offerPending = false;
      tracked.offerContext = null;
      this.core.detach(tracked.sessionId);
      await this.recycleWorkerSocket();
      await this.ensureStarted(
        WORKER_LAUNCH_MODE.SESSION,
        forceSecureConsole,
        tracked.metadata.correlationId,
        tracked.metadata.startedAt,
      );
      this.core.restore(tracked);
      const socket = this.socket;
      if (!socket || socket.destroyed) throw new Error('desktop_handover_unavailable');
      const sent = await this.writeToWorker(socket, tracked.prepare);
      if (!sent) throw new Error('desktop_handover_send_failed');
      this.armPrepareReadyTimer(tracked.sessionId, socket);
      // The browser's peer died with the old worker. Its authority, lease and
      // input epoch all survive, so ask for a fresh peer on the same session
      // rather than making the viewer restart the whole grant.
      this.onMessage({
        type: REMOTE_DESKTOP_MSG.RENEGOTIATE,
        requestId: tracked.requestId,
        sessionId: tracked.sessionId,
        capability: tracked.prepare.capability,
      });
    } catch {
      this.core.restore(tracked);
      this.untrack(tracked.sessionId);
      this.onMessage(terminal);
    }
  }

  private async retryWithVirtualDisplay(
    terminal: RemoteDesktopDaemonMessage,
    tracked: TrackedAuthority,
  ): Promise<void> {
    try {
      await this.ensureVirtualDisplayController();
      if (this.core.get(tracked.sessionId) !== tracked
        || !this.socket || this.socket.destroyed) {
        this.stopVirtualDisplayIfUnused();
        return;
      }
      tracked.metadata.usesVirtualDisplay = true;
      tracked.prepareReady = false;
      this.clearTrackedTimers(tracked);
      const sent = await this.writeToWorker(this.socket, tracked.prepare);
      if (!sent) throw new Error('virtual_display_retry_send_failed');
      this.armPrepareReadyTimer(tracked.sessionId, this.socket);
    } catch {
      if (this.core.get(tracked.sessionId) !== tracked) return;
      this.untrack(tracked.sessionId);
      this.onMessage(terminal);
    }
  }

  private async ensureVirtualDisplayController(): Promise<void> {
    if (this.virtualDisplayStartPromise) return await this.virtualDisplayStartPromise;
    if (this.virtualDisplayController?.exitCode === null) return;
    if (!this.artifact?.virtualDisplayDirectory) throw new Error('virtual_display_unavailable');
    const generation = ++this.virtualDisplayGeneration;
    this.virtualDisplayStartPromise = (async () => {
      const artifact = await this.verifiedArtifactForLaunch();
      if (generation !== this.virtualDisplayGeneration) {
        throw new Error('virtual_display_start_cancelled');
      }
      const controller = (this.options.launchVirtualDisplay ?? ((executable: string) => (
        spawn(executable, ['--virtual-display-controller'], {
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        }) as unknown as VirtualDisplayControllerProcess
      )))(artifact.executablePath);
      if (generation !== this.virtualDisplayGeneration) {
        try { controller.stdin.end(); } catch {}
        throw new Error('virtual_display_start_cancelled');
      }
      this.virtualDisplayController = controller;
      let exited = false;
      let exitCode: number | null = null;
      const exit = new Promise<void>((resolveExit) => {
        controller.once('exit', (code) => {
          exited = true;
          exitCode = code;
          if (this.virtualDisplayController === controller) {
            this.virtualDisplayController = null;
          }
          resolveExit();
        });
      });
      const wait = this.options.wait ?? ((milliseconds: number) => new Promise<void>(
        (resolveWait) => setTimeout(resolveWait, milliseconds),
      ));
      await Promise.race([exit, wait(this.options.virtualDisplayStartupMs ?? 5_000)]);
      if (generation !== this.virtualDisplayGeneration) {
        try { controller.stdin.end(); } catch {}
        throw new Error('virtual_display_start_cancelled');
      }
      if (exited) throw new Error(`virtual_display_controller_failed_${exitCode ?? 'unknown'}`);
      const activationArtifact = await this.verifiedArtifactForLaunch();
      if (generation !== this.virtualDisplayGeneration) {
        try { controller.stdin.end(); } catch {}
        throw new Error('virtual_display_start_cancelled');
      }
      (this.options.activateVirtualDisplay ?? ((executable: string) =>
        launchWindowsActiveUserCommand(executable, '--activate-virtual-display')))(activationArtifact.executablePath);
      await Promise.race([
        exit,
        wait(this.options.virtualDisplayActivationMs ?? 2_000),
      ]);
      if (generation !== this.virtualDisplayGeneration) {
        try { controller.stdin.end(); } catch {}
        throw new Error('virtual_display_start_cancelled');
      }
      if (exited) throw new Error(`virtual_display_controller_failed_${exitCode ?? 'unknown'}`);
    })().finally(() => {
      if (generation === this.virtualDisplayGeneration) {
        this.virtualDisplayStartPromise = null;
      }
    });
    return await this.virtualDisplayStartPromise;
  }

  private stopVirtualDisplayIfUnused(): void {
    if ([...this.core.values()].some((entry) => entry.metadata.usesVirtualDisplay)) return;
    this.stopVirtualDisplayController();
  }

  private stopVirtualDisplayController(): void {
    ++this.virtualDisplayGeneration;
    const controller = this.virtualDisplayController;
    this.virtualDisplayController = null;
    this.virtualDisplayStartPromise = null;
    if (!controller) return;
    try { controller.stdin.end(); } catch {}
    // stdin close is the normal SwDevice lifetime signal.  Do not leave an
    // orphaned controller (and its temporary virtual display) behind if a
    // Windows pipe close is lost: it poisons the next capture topology.
    const forceStop = setTimeout(() => {
      if (controller.exitCode === null) controller.kill?.();
    }, this.options.virtualDisplayShutdownGraceMs ?? VIRTUAL_DISPLAY_SHUTDOWN_GRACE_MS);
    forceStop.unref?.();
    controller.once('exit', () => clearTimeout(forceStop));
  }
}
