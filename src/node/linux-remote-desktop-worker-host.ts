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
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} from '../../shared/remote-desktop-platform.js';
import {
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  type RemoteDesktopAdapterCapability,
} from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_LINUX_WORKER_FILENAME } from '../../shared/remote-desktop-worker.js';
import { RemoteDesktopWorkerHostCore } from './remote-desktop-worker-host-core.js';
import type { ControlledNodeRemoteDesktopWorker } from './runtime.js';
import logger from '../util/logger.js';

/**
 * A real, standalone native worker binary (native/linux-remote-desktop/
 * linux_remote_desktop_worker_main.cc), living at a sidecar path next to the
 * controlled node's own executable -- mirroring the Computer Use helper's
 * established sidecar convention (see computer-use-runner.ts's
 * `join(dirname(process.execPath), 'computer-use-helper', binary)`) rather
 * than inventing a new one. Two ways it gets there, same path either way:
 * build-node-exe.yml's ubuntu-latest job bundles it directly for a fresh
 * install, and downloadControlledNodeLinuxRemoteDesktopWorker (src/node/
 * self-upgrade.ts) fetches and hash-verifies it against the manifest server/
 * src/routes/enroll.ts serves, for a controlled node whose main executable
 * self-upgraded without this sidecar (it is not part of the main executable's
 * own artifact, so replacing just that file never brings this along).
 */
const WORKER_SIDECAR_RELATIVE_PATH = [
  'remote-desktop-worker',
  'linux-x64',
  REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
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
   * The v3 profile, once the worker binary is present -- NOT the bare
   * legacy REMOTE_DESKTOP_CAPABILITY token. resolveRemoteDesktopSessionProfile
   * (shared/remote-desktop-platform.ts) treats a bare legacy token as the
   * LEGACY v2 profile and hard-codes it to `platform: 'windows', capture:
   * 'windows_dxgi'` -- there is no "legacy Linux" shape, only "legacy
   * Windows". Advertising the bare token here would make a Linux node's
   * session look like a Windows one to every downstream consumer of
   * `profile.platform`/`profile.capture`.
   *
   * REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY is NOT included here even
   * though it is real (see adapterCapabilities() below) -- runtime.ts's
   * refreshRemoteDesktopCapabilityState() filters this method's return
   * value against REMOTE_DESKTOP_SESSION_PROFILE_CAPABILITIES only, which
   * does not contain the adapter-capability tokens (LOCAL_DISCLOSURE,
   * LOCAL_CONSENT, CAPTURE_PRIVACY, INPUT, LOCK_SCREEN, CANONICAL_BRANDING).
   * Putting it here silently dropped it before it ever reached
   * resolveRemoteDesktopSessionProfile, which requires it for the v3
   * profile to resolve at all -- observed in production as a worker that
   * was present, running, and fully wired, still advertising zero remote-
   * desktop capabilities, because the one token profile resolution needs
   * was filtered out one layer up. Windows' RemoteDesktopWorkerHost gets
   * this right by advertising LOCAL_DISCLOSURE (among others) from its own
   * adapterCapabilities(), never from sessionCapabilities() -- mirrored
   * below instead of inventing a different split for Linux.
   *
   * REMOTE_DESKTOP_CAPTURE_CAPABILITY.LINUX_X11, not the portal/PipeWire
   * token: PortalCaptureAdapter (linux_platform_adapters.cc) exists but its
   * own readiness probe always reports unavailable ("portal stream
   * negotiation not implemented in this slice") -- X11 direct capture is
   * the only backend that has ever actually passed a real session end to
   * end (the qualification tests this file's own header describes). VNC is
   * a last-resort fallback for machines with no X11 access at all
   * (linux_capture_selection.h) and is not advertised as the platform
   * capability either, for the same reason: it is not the primary path.
   *
   * No REMOTE_DESKTOP_INPUT_CAPABILITY: the data-channel wire protocol for
   * pointer/keyboard/clipboard messages is not wired to the input adapters
   * yet (linux_remote_desktop_session.h's own "DELIBERATELY NOT YET DONE"
   * note) -- this is honestly a View-only session today.
   */
  sessionCapabilities(): readonly string[] {
    if (!this.available()) return [];
    return [
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.LINUX,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.LINUX_X11,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
    ];
  }

  /**
   * The real on-screen disclosure banner (X11DisclosureAdapter,
   * linux_x11_backend.h -- see the long comment on sessionCapabilities()
   * above for why this lives here and not there). Windows' equivalent host
   * advertises its adapter set the same way, from this method alone.
   */
  adapterCapabilities(): readonly RemoteDesktopAdapterCapability[] {
    if (!this.available()) return [];
    return [REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY];
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
