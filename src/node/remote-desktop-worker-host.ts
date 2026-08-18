import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  validateRemoteDesktopDaemonCommand,
  validateRemoteDesktopDaemonMessage,
  type RemoteDesktopDaemonMessage,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  validateRemoteDesktopVirtualDisplayPackageManifest,
  validateRemoteDesktopWorkerCrash,
  validateRemoteDesktopWorkerHello,
  validateRemoteDesktopWorkerManifest,
  upgradeLegacyRemoteDesktopWorkerManifest,
  type RemoteDesktopWorkerCrash,
  type RemoteDesktopWorkerManifest,
} from '../../shared/remote-desktop-worker.js';
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
const VIRTUAL_DISPLAY_SHUTDOWN_GRACE_MS = 1_000;
const MAX_LINE_BYTES = 512 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

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

interface TrackedAuthority {
  requestId: string;
  sessionId: string;
  capability: Buffer;
  prepare: RemoteDesktopPrepare;
  virtualRetryAttempted: boolean;
  usesVirtualDisplay: boolean;
  secureConsoleRetryAttempted: boolean;
}

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
  launch?: (executable: string, argsLine: string, forceSecureConsole?: boolean) => void;
  connectTimeoutMs?: number;
  virtualDisplayStartupMs?: number;
  virtualDisplayActivationMs?: number;
  virtualDisplayShutdownGraceMs?: number;
  launchVirtualDisplay?: (executable: string) => VirtualDisplayControllerProcess;
  activateVirtualDisplay?: (executable: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  onWorkerCrash?: (crash: RemoteDesktopWorkerCrash) => void;
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
  private readonly tracked = new Map<string, TrackedAuthority>();
  private readonly recoverableSocketLosses = new WeakMap<net.Socket, Set<string>>();
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private startPromise: Promise<void> | null = null;
  private virtualDisplayController: VirtualDisplayControllerProcess | null = null;
  private virtualDisplayStartPromise: Promise<void> | null = null;
  private virtualDisplayGeneration = 0;
  private buffer = '';
  private closing = false;

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
  }

  available(): boolean {
    return this.platform === 'win32' && this.artifact !== null
      && SHA256_RE.test(this.trustedSignerSha256);
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
    argsLine: string,
    allowSecureDesktopFallback = true,
    forceSecureConsole = false,
  ): Promise<void> {
    const artifact = await this.verifiedArtifactForLaunch();
    if (this.options.launch) {
      this.options.launch(artifact.executablePath, argsLine, forceSecureConsole);
    } else {
      launchWindowsRemoteDesktopCommand(
        artifact.executablePath,
        argsLine,
        spawn,
        allowSecureDesktopFallback,
        forceSecureConsole,
      );
    }
  }

  async handle(message: unknown): Promise<boolean> {
    const parsed = validateRemoteDesktopDaemonCommand(message);
    if (!parsed.ok || !this.available()) return false;
    let recoverIdlePrepare = false;
    if (parsed.value.type === REMOTE_DESKTOP_MSG.PREPARE) {
      recoverIdlePrepare = this.tracked.size === 0;
      if ((parsed.value.reconnectAttempt ?? 0) > 0 && this.tracked.size === 0) {
        await this.recycleIdleWorkerForReconnect();
      }
      await this.ensureStarted();
      this.track(parsed.value);
    } else if (!this.socket || this.socket.destroyed) {
      return false;
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) return false;
    let sent = await this.writeToWorker(
      socket,
      parsed.value,
      recoverIdlePrepare && parsed.value.type === REMOTE_DESKTOP_MSG.PREPARE
        ? parsed.value.sessionId
        : undefined,
    );
    if (!sent && recoverIdlePrepare && parsed.value.type === REMOTE_DESKTOP_MSG.PREPARE
      && this.tracked.has(parsed.value.sessionId)) {
      // A warm idle worker can exit between sessions while the service-side
      // pipe has not observed the close yet. Do not surface that stale-pipe
      // race as worker_failed: no other authority is alive, so cold-start one
      // verified replacement and retry this PREPARE exactly once.
      this.untrack(parsed.value.sessionId);
      await this.ensureStarted();
      this.track(parsed.value);
      const replacement = this.socket;
      if (!replacement || replacement.destroyed) {
        this.untrack(parsed.value.sessionId);
        throw new Error('remote_desktop_worker_recovery_failed');
      }
      sent = await this.writeToWorker(replacement, parsed.value);
    }
    if (!sent) {
      return true;
    }
    if (sent && (parsed.value.type === REMOTE_DESKTOP_MSG.STOP
      || parsed.value.type === REMOTE_DESKTOP_MSG.CANCEL)) {
      this.untrack(parsed.value.sessionId);
    }
    return sent;
  }

  private async writeToWorker(
    socket: net.Socket,
    message: unknown,
    recoverIdleSessionId?: string,
  ): Promise<boolean> {
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
      const onLost = () => finish(false);
      socket.once('error', onLost);
      socket.once('close', onLost);
      try {
        socket.write(`${JSON.stringify(message)}\n`, (error) => finish(!error));
      } catch {
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
    this.onSocketLost(socket);
    socket.destroy();
    this.recoverableSocketLosses.delete(socket);
    return false;
  }

  private async recycleIdleWorkerForReconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed || this.tracked.size > 0) return;
    // A browser reconnect follows a failed negotiation or receive-progress
    // path. With no other authority alive, recycle the process-local WebRTC /
    // DXGI state instead of repeatedly retrying a poisoned warm worker. Pipe
    // closure makes the immutable worker perform its normal release/cleanup.
    await new Promise<void>((resolveClosed) => {
      socket.once('close', resolveClosed);
      socket.destroy();
    });
  }

  close(): void {
    this.closing = true;
    this.failTracked(REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED);
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.startPromise = null;
    this.stopVirtualDisplayController();
    this.buffer = '';
    this.closing = false;
  }

  private track(prepare: RemoteDesktopPrepare): void {
    this.tracked.set(prepare.sessionId, {
      requestId: prepare.requestId,
      sessionId: prepare.sessionId,
      capability: Buffer.from(prepare.capability, 'utf8'),
      prepare,
      virtualRetryAttempted: false,
      usesVirtualDisplay: this.virtualDisplayController !== null,
      secureConsoleRetryAttempted: false,
    });
  }

  private async ensureStarted(forceSecureConsole = false): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.startPromise) return await this.startPromise;
    if (!this.artifact) throw new Error('remote_desktop_worker_unavailable');
    this.startPromise = new Promise<void>((resolveStarted, rejectStarted) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (error) {
          this.server?.close();
          this.server = null;
          this.startPromise = null;
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
          const argsLine = [
            '--pipe', this.pipePath,
            '--nonce', this.nonce,
          ].map(quoteWindowsArgument).join(' ');
            await this.launchVerified(argsLine, true, forceSecureConsole);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
    });
    return await this.startPromise;
  }

  private accept(socket: net.Socket, ready: () => void): void {
    socket.setEncoding('utf8');
    socket.setTimeout(HELLO_TIMEOUT_MS, () => socket.destroy());
    let helloBuffer = '';
    const onHello = (chunk: string | Buffer) => {
      helloBuffer += String(chunk);
      if (Buffer.byteLength(helloBuffer, 'utf8') > MAX_LINE_BYTES) {
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
      const remainder = helloBuffer.slice(newline + 1);
      socket.off('data', onHello);
      socket.setTimeout(0);
      if (this.socket && !this.socket.destroyed) this.socket.destroy();
      this.socket = socket;
      this.buffer = '';
      socket.on('data', (data) => this.onData(String(data)));
      socket.on('close', () => this.onSocketLost(socket));
      socket.on('error', () => this.onSocketLost(socket));
      if (remainder) this.onData(remainder);
      ready();
    };
    socket.on('data', onHello);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
      this.socket?.destroy();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (validateRemoteDesktopWorkerCrash(value, this.nonce)) {
        // The worker faulted and is already gone. Surface it before the socket
        // loss turns into an anonymous `worker_failed`; the frame carries no
        // session, capability, media, or input data.
        this.options.onWorkerCrash?.(value);
        continue;
      }
      const parsed = validateRemoteDesktopDaemonMessage(value);
      if (!parsed.ok) continue;
      const tracked = this.tracked.get(parsed.value.sessionId);
      const capability = Buffer.from(parsed.value.capability, 'utf8');
      if (!tracked || capability.length !== tracked.capability.length
        || !timingSafeEqual(capability, tracked.capability)) continue;
      if (parsed.value.type === REMOTE_DESKTOP_MSG.TERMINAL) {
        // `media_unavailable` also covers transient DXGI/DWM failures while a
        // physical output is switching. Only the worker's explicit initial
        // no-display result is allowed to add a third, virtual display.
        if (parsed.value.reason === REMOTE_DESKTOP_TERMINAL_REASON.HEADLESS_DISPLAY
          && !tracked.virtualRetryAttempted) {
          tracked.virtualRetryAttempted = true;
          void this.retryWithVirtualDisplay(parsed.value, tracked);
          continue;
        }
        // The worker owns the only authoritative view of the input desktop. A
        // protected-desktop answer to PREPARE means this worker was launched
        // onto the wrong one — a session locked, or a lingering LogonUI made a
        // logged-in machine look like the sign-in screen. Replace it once with
        // a worker on the privileged desktop instead of failing the session.
        if (parsed.value.reason === REMOTE_DESKTOP_TERMINAL_REASON.PROTECTED_DESKTOP
          && !tracked.secureConsoleRetryAttempted) {
          tracked.secureConsoleRetryAttempted = true;
          void this.retryOnSecureConsole(parsed.value, tracked);
          continue;
        }
        this.untrack(parsed.value.sessionId);
      }
      this.onMessage(parsed.value);
    }
  }

  private onSocketLost(socket: net.Socket): void {
    const recoverableSessions = this.recoverableSocketLosses.get(socket);
    const recoverable = recoverableSessions?.size === 1
      && this.tracked.size === 1
      && this.tracked.has([...recoverableSessions][0]!);
    this.recoverableSocketLosses.delete(socket);
    if (this.socket !== socket) return;
    this.socket = null;
    this.buffer = '';
    this.server?.close();
    this.server = null;
    this.startPromise = null;
    if (!this.closing && !recoverable) {
      // If the worker crashed before its normal release-all path, launch the
      // immutable verified binary once in release-only mode on the same active
      // desktop. This command carries no credential, authority, or key history.
      if (this.tracked.size > 0 && this.artifact) {
        void this.launchVerified('--release-all-input', false).catch(() => {
          // The Server is still notified and the short lease still expires;
          // this best-effort recovery cannot restore a dead worker.
        });
      }
      this.failTracked(REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED);
    }
  }

  private failTracked(reason: typeof REMOTE_DESKTOP_TERMINAL_REASON[keyof typeof REMOTE_DESKTOP_TERMINAL_REASON]): void {
    for (const authority of this.tracked.values()) {
      this.onMessage({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        requestId: authority.requestId,
        sessionId: authority.sessionId,
        capability: authority.capability.toString('utf8'),
        reason,
      });
      authority.capability.fill(0);
    }
    this.tracked.clear();
    this.stopVirtualDisplayController();
  }

  private untrack(sessionId: string): void {
    const authority = this.tracked.get(sessionId);
    authority?.capability.fill(0);
    this.tracked.delete(sessionId);
    this.stopVirtualDisplayIfUnused();
  }

  private async retryOnSecureConsole(
    terminal: RemoteDesktopDaemonMessage,
    tracked: TrackedAuthority,
  ): Promise<void> {
    try {
      // Drop the misplaced worker first: its pipe is the only handle the
      // replacement can reuse, and a stale one would keep answering. The
      // authority is only detached from the map here — untrack() would wipe
      // the capability this same session still has to authenticate with.
      this.tracked.delete(tracked.sessionId);
      await this.recycleIdleWorkerForReconnect();
      await this.ensureStarted(true);
      this.tracked.set(tracked.sessionId, tracked);
      const socket = this.socket;
      if (!socket || socket.destroyed) throw new Error('secure_console_retry_unavailable');
      const sent = await this.writeToWorker(socket, tracked.prepare);
      if (!sent) throw new Error('secure_console_retry_send_failed');
    } catch {
      this.tracked.set(tracked.sessionId, tracked);
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
      if (this.tracked.get(tracked.sessionId) !== tracked
        || !this.socket || this.socket.destroyed) {
        this.stopVirtualDisplayIfUnused();
        return;
      }
      tracked.usesVirtualDisplay = true;
      const sent = await this.writeToWorker(this.socket, tracked.prepare);
      if (!sent) throw new Error('virtual_display_retry_send_failed');
    } catch {
      if (this.tracked.get(tracked.sessionId) !== tracked) return;
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
    if ([...this.tracked.values()].some((entry) => entry.usesVirtualDisplay)) return;
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
