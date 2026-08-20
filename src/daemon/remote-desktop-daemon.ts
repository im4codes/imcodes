import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  REMOTE_DESKTOP_CAPABILITY,
  isRemoteDesktopMessageType,
} from '../../shared/remote-desktop.js';
import { isRemoteDesktopFeatureEnabled } from '../../shared/remote-desktop-feature.js';
import {
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
} from '../../shared/remote-desktop-worker.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_ERROR,
  REMOTE_DESKTOP_INSTALL_MSG,
  REMOTE_DESKTOP_INSTALL_STATE,
  type RemoteDesktopInstallError,
  type RemoteDesktopInstallState,
} from '../../shared/remote-desktop-install.js';
import {
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_OS_WIN,
} from '../../shared/controlled-node-artifacts.js';
import {
  REMOTE_DESKTOP_LOGIN_SCREEN_ERROR,
  REMOTE_DESKTOP_LOGIN_SCREEN_MSG,
  REMOTE_DESKTOP_LOGIN_SCREEN_STATE,
  readRemoteDesktopLoginScreenTicket,
  type RemoteDesktopLoginScreenError,
  type RemoteDesktopLoginScreenState,
} from '../../shared/remote-desktop-login-screen.js';
import { dispatchRemoteDesktopCommand } from '../node/remote-desktop-dispatch.js';
import { installLoginScreenControl } from './remote-desktop-login-screen.js';
import {
  REMOTE_DESKTOP_COMPILED_SIGNER_SHA256,
  RemoteDesktopWorkerHost,
  verifyRemoteDesktopWorkerArtifact,
  type RemoteDesktopWorkerHostOptions,
  type VerifiedRemoteDesktopWorkerArtifact,
} from '../node/remote-desktop-worker-host.js';
import { launchWindowsWorkerInCurrentSession } from '../node/windows-user-session.js';
import type { RemoteDesktopCommandTarget } from '../node/remote-desktop-dispatch.js';
import { downloadControlledNodeRemoteDesktopWorker } from '../node/self-upgrade.js';
import { loadDaemonCredential, type DaemonCredential } from './machine-mcp-deps.js';
import logger from '../util/logger.js';

const execFileAsync = promisify(execFile);
const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Where a normal daemon keeps the worker bundle.
 *
 * Deliberately NOT one of the paths `resolveRemoteDesktopWorkerArtifact()`
 * searches: those are consulted by the controlled node too, which runs as
 * SYSTEM, and a per-user-writable directory has no business in a SYSTEM
 * process's search order. The daemon runs as the user who owns this directory,
 * so it passes the artifact in explicitly instead.
 */
export function daemonRemoteDesktopRoot(home = homedir()): string {
  return join(home, '.imcodes');
}

function workerExecutablePath(root: string): string {
  return join(root, 'remote-desktop-worker', 'win32-x64', REMOTE_DESKTOP_WORKER_FILENAME);
}

/** The part of the native worker host this class depends on. */
export interface RemoteDesktopWorkerLike extends RemoteDesktopCommandTarget {
  close(): void;
}

export interface DaemonRemoteDesktopDeps {
  /** Send a message to the server (relayed on to the browser). */
  send(message: Record<string, unknown>): void;
  /** Re-advertise capabilities after the install state changes. */
  onCapabilityChange?(): void;
  platform?: NodeJS.Platform;
  arch?: string;
  root?: string;
  /** Compiled release trust anchor; empty in a build that has none. */
  trustedSignerSha256?: string;
  loadCredential?: () => Promise<DaemonCredential | null>;
  downloadWorker?: typeof downloadControlledNodeRemoteDesktopWorker;
  fetchImpl?: typeof fetch;
  /** Extract the signed virtual-display archive next to the worker. */
  extractVirtualDisplay?: (archivePath: string, destination: string) => Promise<void>;
  resolveArtifact?: (
    executablePath: string,
    trustedSignerSha256: string,
  ) => VerifiedRemoteDesktopWorkerArtifact | null;
  /** The publisher the installed bundle declares for itself. */
  readInstalledSigner?: (executablePath: string) => string;
  createHost?: (
    artifact: VerifiedRemoteDesktopWorkerArtifact,
    onMessage: (message: Record<string, unknown>) => void,
  ) => RemoteDesktopWorkerLike;
  installLoginScreen?: typeof installLoginScreenControl;
}

/**
 * Remote desktop on a normal (FULL) daemon.
 *
 * A controlled node ships the native worker with its runtime; a daemon is
 * installed from npm and has none, so it advertises that it *could* serve
 * remote control, downloads the same signed bundle when asked, and only then
 * advertises the capability itself. Everything downstream — signalling,
 * authority, media, input — is the controlled node's code path unchanged.
 */
export class DaemonRemoteDesktop {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly root: string;
  private readonly trustedSignerSha256: string;
  /** The anchor that actually validated the installed bundle. */
  private artifactSigner = '';
  private host: RemoteDesktopWorkerLike | null = null;
  private artifact: VerifiedRemoteDesktopWorkerArtifact | null = null;
  private installing: Promise<void> | null = null;
  private installingLoginScreen: Promise<void> | null = null;

  constructor(private readonly deps: DaemonRemoteDesktopDeps) {
    this.platform = deps.platform ?? process.platform;
    this.arch = deps.arch ?? process.arch;
    this.root = deps.root ?? daemonRemoteDesktopRoot();
    this.trustedSignerSha256 = deps.trustedSignerSha256 ?? REMOTE_DESKTOP_COMPILED_SIGNER_SHA256;
    this.artifact = this.supported() ? this.resolveArtifact() : null;
  }

  /** Whether this host could serve remote control at all. */
  supported(): boolean {
    return this.platform === 'win32'
      && this.arch === 'x64'
      && isRemoteDesktopFeatureEnabled(
        process.env.IMCODES_REMOTE_DESKTOP_ENABLED,
        process.env.NODE_ENV,
      );
  }

  /** Whether a verified worker is installed right now. */
  available(): boolean {
    return this.artifact !== null;
  }

  /**
   * Capabilities to advertise in `daemon.hello`. `INSTALLABLE` is advertised
   * whenever the platform supports remote control, so the browser can tell
   * "this machine cannot do it" apart from "this machine needs one download".
   */
  capabilities(): readonly string[] {
    if (!this.supported()) return [];
    return this.available()
      ? [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY, REMOTE_DESKTOP_CAPABILITY]
      : [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY];
  }

  installState(): RemoteDesktopInstallState {
    if (!this.supported()) return REMOTE_DESKTOP_INSTALL_STATE.UNSUPPORTED;
    if (this.installing) return REMOTE_DESKTOP_INSTALL_STATE.DOWNLOADING;
    return this.available()
      ? REMOTE_DESKTOP_INSTALL_STATE.INSTALLED
      : REMOTE_DESKTOP_INSTALL_STATE.MISSING;
  }

  /** Consume a remote-desktop message. Returns false when it is not ours. */
  async handle(message: Record<string, unknown>): Promise<boolean> {
    if (message.type === REMOTE_DESKTOP_INSTALL_MSG.REQUEST) {
      await this.install();
      return true;
    }
    if (message.type === REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST) {
      await this.installLoginScreen(readRemoteDesktopLoginScreenTicket(message));
      return true;
    }
    if (typeof message.type !== 'string' || !isRemoteDesktopMessageType(message.type)) return false;
    const host = this.host ?? this.startHost();
    await dispatchRemoteDesktopCommand({
      message,
      enabled: host !== null,
      // `enabled: false` short-circuits before the target is consulted, so the
      // placeholder below is never reached with a missing worker.
      target: host ?? { handle: async () => false },
      send: (reply) => this.deps.send(reply),
    });
    return true;
  }

  /**
   * Download and install the worker bundle. Concurrent requests join the
   * in-flight install rather than racing a second download into the same
   * directory, which would break the exact-entry verification.
   */
  async install(): Promise<void> {
    if (!this.supported()) {
      this.publish(
        REMOTE_DESKTOP_INSTALL_STATE.UNSUPPORTED,
        REMOTE_DESKTOP_INSTALL_ERROR.UNSUPPORTED_PLATFORM,
      );
      return;
    }
    if (this.available()) {
      this.publish(REMOTE_DESKTOP_INSTALL_STATE.INSTALLED);
      return;
    }
    if (this.installing) return this.installing;
    this.publish(REMOTE_DESKTOP_INSTALL_STATE.DOWNLOADING);
    this.installing = this.runInstall().finally(() => { this.installing = null; });
    return this.installing;
  }

  private async runInstall(): Promise<void> {
    try {
      const credential = await (this.deps.loadCredential ?? loadDaemonCredential)();
      if (!credential) {
        this.publish(REMOTE_DESKTOP_INSTALL_STATE.FAILED, REMOTE_DESKTOP_INSTALL_ERROR.NOT_BOUND);
        return;
      }
      const downloaded = await (this.deps.downloadWorker ?? downloadControlledNodeRemoteDesktopWorker)({
        credential,
        target: { os: CONTROLLED_NODE_OS_WIN, arch: CONTROLLED_NODE_ARCH_X64 },
        dir: this.root,
        fetchImpl: this.deps.fetchImpl ?? fetch,
      });
      if (!downloaded) {
        this.publish(
          REMOTE_DESKTOP_INSTALL_STATE.FAILED,
          REMOTE_DESKTOP_INSTALL_ERROR.NOT_AVAILABLE,
        );
        return;
      }
      // The controlled node's upgrade script expands this archive; a daemon has
      // no such script, so it does the same step here. The extracted files are
      // then hash- and signer-verified by the shared artifact verifier below,
      // and again by Authenticode at launch.
      await (this.deps.extractVirtualDisplay ?? extractVirtualDisplayArchive)(
        join(downloaded.workerDir, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME),
        join(downloaded.workerDir, 'virtual-display'),
      );
    } catch (err) {
      logger.warn({ err }, 'remote desktop worker install failed');
      this.publish(
        REMOTE_DESKTOP_INSTALL_STATE.FAILED,
        REMOTE_DESKTOP_INSTALL_ERROR.DOWNLOAD_FAILED,
      );
      return;
    }
    // The bundle landed; it is only an install once the shared verifier accepts
    // its hashes, manifest and pinned signer.
    const artifact = this.resolveArtifact();
    if (!artifact) {
      this.publish(
        REMOTE_DESKTOP_INSTALL_STATE.FAILED,
        REMOTE_DESKTOP_INSTALL_ERROR.VERIFICATION_FAILED,
      );
      return;
    }
    this.artifact = artifact;
    this.publish(REMOTE_DESKTOP_INSTALL_STATE.INSTALLED);
    // Only now does this daemon claim it can serve remote control.
    this.deps.onCapabilityChange?.();
  }

  /**
   * Verify what is installed, anchoring on the bundle's own declared signer when
   * this build has no compiled pin.
   *
   * A release SEA pins the publisher at compile time and keeps doing so. A
   * daemon installed from npm has no such pin, and requiring one would only
   * disable the feature: the bundle comes from the very server that already
   * drives this machine's agent sessions, so a compile-time pin adds no boundary
   * that server could not already cross. Every other check still runs — exact
   * directory contents, manifest and per-file hashes, one consistent signer
   * across worker, driver and catalogue, and a real Authenticode verification of
   * all three at launch.
   */
  private resolveArtifact(): VerifiedRemoteDesktopWorkerArtifact | null {
    const executablePath = workerExecutablePath(this.root);
    const signer = SHA256_RE.test(this.trustedSignerSha256)
      ? this.trustedSignerSha256
      : (this.deps.readInstalledSigner ?? installedWorkerSigner)(executablePath);
    if (!SHA256_RE.test(signer)) return null;
    try {
      const artifact = (this.deps.resolveArtifact ?? verifyRemoteDesktopWorkerArtifact)(
        executablePath,
        signer,
      );
      if (artifact) this.artifactSigner = signer;
      return artifact;
    } catch {
      return null;
    }
  }

  private startHost(): RemoteDesktopWorkerLike | null {
    const artifact = this.artifact;
    if (!artifact) return null;
    const onMessage = (message: Record<string, unknown>): void => { this.deps.send(message); };
    this.host = this.deps.createHost
      ? this.deps.createHost(artifact, onMessage)
      : new RemoteDesktopWorkerHost(
        (message) => onMessage(message as unknown as Record<string, unknown>),
        {
          artifact,
          platform: this.platform,
          trustedSignerSha256: this.artifactSigner,
          ...daemonWorkerLaunchOptions(),
        },
      );
    return this.host;
  }

  private publish(state: RemoteDesktopInstallState, error?: RemoteDesktopInstallError): void {
    this.deps.send({
      type: REMOTE_DESKTOP_INSTALL_MSG.STATE,
      state,
      ...(error ? { error } : {}),
    });
  }

  /**
   * Install the controlled node on this machine so it can serve the sign-in and
   * lock screen, which a daemon running as the interactive user cannot.
   *
   * Concurrent requests join the attempt in flight rather than raising a second
   * UAC prompt on the machine's screen.
   */
  async installLoginScreen(ticket: string | null): Promise<void> {
    if (!this.supported()) {
      this.publishLoginScreen(
        REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
        REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.UNSUPPORTED_PLATFORM,
      );
      return;
    }
    if (!ticket) {
      this.publishLoginScreen(
        REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
        REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED,
      );
      return;
    }
    if (this.installingLoginScreen) return this.installingLoginScreen;
    this.installingLoginScreen = this.runLoginScreenInstall(ticket)
      .finally(() => { this.installingLoginScreen = null; });
    return this.installingLoginScreen;
  }

  private async runLoginScreenInstall(ticket: string): Promise<void> {
    let failure: RemoteDesktopLoginScreenError | null;
    try {
      failure = await (this.deps.installLoginScreen ?? installLoginScreenControl)({
        ticket,
        root: this.root,
        loadCredential: this.deps.loadCredential ?? loadDaemonCredential,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        onState: (state) => this.publishLoginScreen(
          state === 'downloading'
            ? REMOTE_DESKTOP_LOGIN_SCREEN_STATE.DOWNLOADING
            : REMOTE_DESKTOP_LOGIN_SCREEN_STATE.ELEVATING,
        ),
      });
    } catch (err) {
      logger.warn({ err }, 'login screen control install failed');
      failure = REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
    }
    this.publishLoginScreen(
      failure ? REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED : REMOTE_DESKTOP_LOGIN_SCREEN_STATE.COMPLETED,
      failure ?? undefined,
    );
  }

  private publishLoginScreen(
    state: RemoteDesktopLoginScreenState,
    error?: RemoteDesktopLoginScreenError,
  ): void {
    this.deps.send({
      type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE,
      state,
      ...(error ? { error } : {}),
    });
  }

  close(): void {
    this.host?.close();
    this.host = null;
  }
}

/**
 * How a daemon starts and reaches its worker, as opposed to a controlled node.
 *
 * Both defaults in the worker host assume the controlled node's shape: it runs
 * as LocalSystem in session 0, so it launches the worker across the session
 * boundary and widens the pipe ACL so the child — running as a different user,
 * in a different session — can connect back. A daemon is already running as the
 * interactive user, in the session being captured. It cannot take the first
 * path (the launcher refuses anything but LocalSystem, and the privilege it
 * needs is not held) and does not need the second (the pipe's default owner ACL
 * already admits this process's own child).
 */
export function daemonWorkerLaunchOptions(
  launchWorker = launchWindowsWorkerInCurrentSession,
): Pick<RemoteDesktopWorkerHostOptions, 'launch' | 'allowPipeClients'> {
  return {
    launch: (executable, _argsLine, _forceSecureConsole, args) => {
      launchWorker(executable, args ?? []);
    },
    allowPipeClients: () => {},
  };
}

/**
 * The publisher the installed bundle declares for itself.
 *
 * This is not proof on its own — it is the value every other check is then held
 * against: the virtual-display package must declare the same signer, and the
 * launch path verifies the real Authenticode signature of the worker, driver and
 * catalogue against it.
 */
function installedWorkerSigner(executablePath: string): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(`${executablePath}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`, 'utf8'),
    );
    const signer = (manifest as { authenticodeSignerSha256?: unknown }).authenticodeSignerSha256;
    return typeof signer === 'string' ? signer.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Expand the signed virtual-display archive. PowerShell is the only unzip this
 * project can rely on, and this path is Windows-only by construction.
 */
async function extractVirtualDisplayArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  await execFileAsync(
    join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      'Expand-Archive -LiteralPath $env:IMCODES_RD_ARCHIVE -DestinationPath $env:IMCODES_RD_DEST -Force',
    ],
    {
      windowsHide: true,
      env: { ...process.env, IMCODES_RD_ARCHIVE: archivePath, IMCODES_RD_DEST: destination },
    },
  );
}
