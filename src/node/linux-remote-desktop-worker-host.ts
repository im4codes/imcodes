import { randomBytes } from 'node:crypto';
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  validateRemoteDesktopDaemonCommand,
  type RemoteDesktopDaemonMessage,
} from '../../shared/remote-desktop.js';
import { RemoteDesktopWorkerHostCore } from './remote-desktop-worker-host-core.js';
import type { ControlledNodeRemoteDesktopWorker } from './runtime.js';
import logger from '../util/logger.js';

/**
 * A real, standalone native worker binary (native/linux-remote-desktop/
 * linux_remote_desktop_worker_main.cc), not downloaded on demand the way
 * Windows' worker is: bundled as a sidecar alongside the controlled node's
 * own executable at build time (build-node-exe.yml's ubuntu-latest job),
 * mirroring the Computer Use helper's own established sidecar convention
 * (see computer-use-runner.ts's `join(dirname(process.execPath),
 * 'computer-use-helper', binary)`) rather than inventing a new one. No
 * download/manifest/signature machinery: the same build that produced this
 * process produced the sidecar sitting next to it.
 */
const WORKER_SIDECAR_RELATIVE_PATH = [
  'remote-desktop-worker',
  'linux-x64',
  'imcodes-linux-remote-desktop-worker',
] as const;

export function resolveLinuxRemoteDesktopWorkerPath(execPath: string = process.execPath): string {
  return join(dirname(execPath), ...WORKER_SIDECAR_RELATIVE_PATH);
}

/**
 * Hosts the real Linux remote-desktop worker process for a controlled node.
 *
 * Reuses RemoteDesktopWorkerHostCore -- the SAME platform-neutral authority/
 * framing state machine Windows' RemoteDesktopWorkerHost and macOS'
 * MacosRemoteDesktopWorkerHost both build on -- rather than reimplementing
 * PREPARE/OFFER/ANSWER tracking, watchdog timers, or line framing here. This
 * host supplies only what the core deliberately has no opinion about: how
 * to find, spawn, and pipe bytes to/from the actual OS process.
 *
 * Deliberately minimal relative to the Windows/macOS hosts for a first,
 * honest slice: no consent frames, no privacy/shielded-route frames, no
 * auto-unlock, no Authenticode-equivalent signature verification (the
 * sidecar is not downloaded, so there is no untrusted-origin boundary to
 * verify across the way a network download would need). One persistent
 * worker process serves however many concurrent sessions PREPARE for,
 * matching linux_remote_desktop_worker_main.cc's own multi-session design
 * on the other end of the pipe.
 */
export class LinuxRemoteDesktopWorkerHost implements ControlledNodeRemoteDesktopWorker {
  private readonly workerPath: string;
  private readonly core: RemoteDesktopWorkerHostCore<Record<string, never>>;
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private connectionGeneration = 0;

  constructor(
    private readonly onMessage: (message: RemoteDesktopDaemonMessage) => void,
    options: { workerPath?: string } = {},
  ) {
    this.workerPath = options.workerPath ?? resolveLinuxRemoteDesktopWorkerPath();
    this.core = new RemoteDesktopWorkerHostCore({
      nonce: randomBytes(16).toString('hex'),
      onWatchdogTimeout: (event) => {
        this.onMessage(event.terminal);
      },
    });
  }

  available(): boolean {
    return existsSync(this.workerPath);
  }

  /**
   * Deliberately empty, even once the worker binary is present.
   *
   * `resolveRemoteDesktopSessionProfile` (shared/remote-desktop-platform.ts)
   * treats a bare REMOTE_DESKTOP_CAPABILITY token as the LEGACY v2 profile
   * and hard-codes it to `platform: 'windows', capture: 'windows_dxgi'` --
   * there is no "legacy Linux" shape, only "legacy Windows". Advertising it
   * from here would make a Linux node's session look like a Windows one to
   * every downstream consumer of `profile.platform`/`profile.capture`.
   *
   * The correct advertisement is the v3 profile (REMOTE_DESKTOP_SESSION_
   * CAPABILITY + REMOTE_DESKTOP_PLATFORM_CAPABILITY.LINUX + a capture
   * capability + the H264 encoder token), but that profile unconditionally
   * also requires REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY: macOS earns
   * that token with a whole separate signed on-screen-notice component
   * (imcodes-remote-desktop-disclosure) telling the person physically at the
   * machine that their screen is being captured, and Linux has no equivalent
   * yet. Advertising readiness without it would enable real capture sessions
   * with no on-screen notice, which the shared profile resolver's own
   * comment calls out as exactly what that requirement exists to prevent.
   *
   * So: `available()` can be true (the worker binary exists, and `handle()`
   * will actually spawn it and speak the real protocol -- this is what the
   * qualification tests exercise), but nothing is advertised to the server
   * or browser as a usable session until the disclosure component exists.
   */
  sessionCapabilities(): readonly string[] {
    return [];
  }

  async handle(message: unknown): Promise<boolean> {
    if (!this.available()) return false;
    const parsed = validateRemoteDesktopDaemonCommand(message);
    if (!parsed.ok) return false;
    const command = parsed.value;
    if (command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      this.core.track(command, {});
    }
    if (!this.ensureSpawned()) return false;
    // child is non-null: ensureSpawned() only returns true after assigning it.
    this.child!.stdin.write(this.core.frameOutbound(command));
    return true;
  }

  onDaemonDisconnected(): void {
    // The worker process and its live sessions outlive one signaling
    // connection; a replacement daemon connection resumes against the same
    // process, the same way Windows' and macOS' hosts keep their worker
    // warm across a reconnect. Nothing to do here yet since this host does
    // not track connection-scoped routes beyond core's own generation.
  }

  close(): void {
    this.core.failAll(REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED, (terminal) => {
      this.onMessage(terminal);
    });
    this.killChild();
  }

  /** Idempotent: returns true if a worker process is already running or was
   * just started successfully. */
  private ensureSpawned(): boolean {
    if (this.child) return true;
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(this.workerPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    } catch (err) {
      logger.warn({ err }, 'linux remote desktop worker spawn failed');
      return false;
    }
    this.connectionGeneration = this.core.beginConnection();
    child.stdout.on('data', (chunk: Buffer) => {
      const result = this.core.pushInbound(chunk.toString('utf8'), this.connectionGeneration);
      if (result.overflow) {
        logger.warn('linux remote desktop worker stdout line overflow, killing worker');
        this.killChild();
        return;
      }
      for (const event of result.events) {
        // 'crash' events carry a nonce-authenticated crash frame this
        // worker does not emit yet (no native crash handler); only
        // 'message' events are possible in practice, but both are handled
        // for forward compatibility with core's own event union.
        if (event.kind === 'message') this.onMessage(event.value);
      }
    });
    child.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'linux remote desktop worker exited');
      this.core.endConnection(this.connectionGeneration);
      if (this.child === child) this.child = null;
    });
    child.on('error', (err) => {
      logger.warn({ err }, 'linux remote desktop worker process error');
    });
    this.child = child;
    return true;
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.core.endConnection(this.connectionGeneration);
    child.kill();
  }
}
