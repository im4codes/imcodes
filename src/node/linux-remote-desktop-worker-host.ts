import { randomBytes } from 'node:crypto';
import { type ChildProcessByStdio, spawn, execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} from '../../shared/remote-desktop-platform.js';
import {
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  type RemoteDesktopAdapterCapability,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
  REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR,
  REMOTE_DESKTOP_WORKER_SIDECAR_DIR,
} from '../../shared/remote-desktop-worker.js';
import { RemoteDesktopWorkerHostCore } from './remote-desktop-worker-host-core.js';
import {
  activeLocalRemoteDesktopConnections,
  stopAllLocalRemoteDesktopConnections,
  stopLocalRemoteDesktopConnection,
} from './remote-desktop-local-worker-control.js';
import { REMOTE_DESKTOP_LOCAL_WORKER_MSG } from '../../shared/remote-desktop-local-management.js';
import type { ControlledNodeRemoteDesktopWorker } from './runtime.js';
import logger from '../util/logger.js';
import {
  X11_SOCKET_DIR,
  accessibleX11DisplayNumbers,
  listX11DisplayNumbers,
} from './linux-x11-display.js';

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
  REMOTE_DESKTOP_WORKER_SIDECAR_DIR,
  REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR,
  REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
] as const;

export function resolveLinuxRemoteDesktopWorkerPath(execPath: string = process.execPath): string {
  return join(dirname(execPath), ...WORKER_SIDECAR_RELATIVE_PATH);
}

/**
 * Checks whether the worker binary can resolve all its dynamic shared library dependencies.
 * If dynamic libraries (e.g. libXtst.so.6, libXrandr.so.2) are missing, ld-linux cannot link
 * the worker executable and spawning it would immediately crash with exit status 127.
 */
export function checkLinuxWorkerLibraries(
  workerPath: string,
  execSync: (cmd: string, args: readonly string[], opts: ExecFileSyncOptions) => Buffer | string = execFileSync,
): boolean {
  if (!existsSync(workerPath)) return false;
  try {
    const output = execSync(workerPath, [], {
      env: { ...process.env, LD_TRACE_LOADED_OBJECTS: '1' },
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
    return !output.includes('not found');
  } catch {
    try {
      const output = execSync('ldd', [workerPath], {
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf8');
      return !output.includes('not found');
    } catch {
      return false;
    }
  }
}

export interface LinuxRemoteDesktopWorkerHostOptions {
  trafficStorePath?: string;
  workerPath?: string;
  checkLibraries?: (workerPath: string) => boolean;
}

/**
 * scripts/install-linux-desktop-environment.sh's own default (--display
 * defaults to ":99"), used when nothing higher-priority is live or when no
 * managed marker / lower physical display is available.
 */
const DEFAULT_X11_DISPLAY_NUMBER = 99;
const DEFAULT_X11_DISPLAY = `:${DEFAULT_X11_DISPLAY_NUMBER}`;
const PHYSICAL_X11_DISPLAY_THRESHOLD = 10;

export const LINUX_DESKTOP_DISPLAY_MARKER_PATH = '/usr/local/lib/imcodes/desktop-display';
export const LINUX_DESKTOP_SESSION_SCRIPT_PATH = '/usr/local/lib/imcodes/imcodes-desktop-session.sh';
export const LINUX_DESKTOP_SESSION_SERVICE_PATH = '/etc/systemd/system/imcodes-desktop-session.service';
export const LINUX_PASSWD_PATH = '/etc/passwd';
export const LINUX_RUNTIME_ROOT_DIR = '/run';
export const LINUX_RUN_USER_DIR = '/run/user';

export interface ResolveWorkerDisplayOptions {
  displayMarkerPath?: string | null;
  sessionScriptPath?: string | null;
}

export interface LinuxRuntimePathStat {
  uid: number;
  gid: number;
  isDirectory: boolean;
  isSocket: boolean;
}

export interface ResolveWorkerAudioOptions extends ResolveWorkerDisplayOptions {
  sessionServicePath?: string | null;
  runtimeRootDir?: string | null;
  passwdPath?: string | null;
  runUserDir?: string | null;
  stat?: (path: string) => LinuxRuntimePathStat | null;
  currentUid?: number;
}

/**
 * Reads the IM.codes-managed desktop display number from the explicit marker
 * file first, falling back to `export DISPLAY=":N"` in the legacy desktop
 * session script so hosts upgraded in place work without re-running the
 * desktop installer. Never throws on missing, unreadable, or malformed files.
 */
export function readManagedLinuxDesktopDisplayNumber(
  options: ResolveWorkerDisplayOptions = {},
): number | undefined {
  const markerPath = options.displayMarkerPath === undefined
    ? LINUX_DESKTOP_DISPLAY_MARKER_PATH
    : options.displayMarkerPath;
  if (markerPath) {
    try {
      const raw = readFileSync(markerPath, 'utf8').trim();
      const match = /^:(\d+)$/.exec(raw);
      if (match) return Number(match[1]);
    } catch {
      // Missing, unreadable, or non-regular marker: fall through to session script.
    }
  }

  const scriptPath = options.sessionScriptPath === undefined
    ? LINUX_DESKTOP_SESSION_SCRIPT_PATH
    : options.sessionScriptPath;
  if (scriptPath) {
    try {
      const script = readFileSync(scriptPath, 'utf8');
      const match = /^export DISPLAY=":(\d+)"\s*$/m.exec(script);
      if (match) return Number(match[1]);
    } catch {
      // Missing or unreadable session script: fall through to display heuristics.
    }
  }

  return undefined;
}

/**
 * The controlled-node service (imcodes-node.service) that spawns this
 * worker is a plain systemd unit with no `Environment=DISPLAY=...` line --
 * unlike scripts/install-linux-desktop-environment.sh's own x11vnc unit,
 * which sets DISPLAY on itself for exactly this reason. Without it, the
 * worker's XOpenDisplay(nullptr) call (linux_x11_backend.cc) reads an unset
 * $DISPLAY and fails outright, even with a real Xvfb already running --
 * observed in production as a session that never leaves its first
 * connecting step, no matter how healthy the advertised capability set is.
 *
 * Never overrides an operator's own explicit DISPLAY (respects whatever the
 * process environment already provides). Otherwise prefers:
 * 1. Accessible IM.codes-managed desktop display (desktop-display / session script),
 * 2. Lowest accessible physical X11 display (< 10),
 * 3. Accessible default managed display (:99), avoids picking arbitrary demo Xvfbs (:97/:98),
 * 4. Lowest remaining accessible display (`usable[0]`).
 * Falls back to `numbers[0] ?? ':99'` when no accessible display is probed yet.
 */
export function resolveWorkerDisplayEnv(
  env: NodeJS.ProcessEnv = process.env,
  socketDir: string = X11_SOCKET_DIR,
  accessible: readonly number[] | undefined = accessibleX11DisplayNumbers(socketDir),
  managedOptions?: ResolveWorkerDisplayOptions,
): NodeJS.ProcessEnv {
  if (typeof env.DISPLAY === 'string' && env.DISPLAY.length > 0) return env;
  const numbers = listX11DisplayNumbers(socketDir);
  // Prefer a display the worker can really open. The lowest-numbered socket
  // is often the login greeter's Xwayland, which rejects it; picking that
  // leaves a session stuck connecting even though a working virtual display
  // is running. With nothing probed yet, or nothing openable, keep the
  // previous lowest-socket choice so this is never worse than before.
  const usable = accessible === undefined ? [] : numbers.filter((number) => accessible.includes(number));
  let chosen: number | undefined;
  if (usable.length > 0) {
    // Only touch real /usr/local/lib/imcodes/* paths when scanning the host X11 socket dir
    // (or when explicitly requested), keeping temp-dir unit tests isolated from host state.
    const managedDisplayNumber =
      managedOptions !== undefined
        ? readManagedLinuxDesktopDisplayNumber({
            displayMarkerPath: managedOptions.displayMarkerPath !== undefined
              ? managedOptions.displayMarkerPath
              : (socketDir === X11_SOCKET_DIR ? undefined : null),
            sessionScriptPath: managedOptions.sessionScriptPath !== undefined
              ? managedOptions.sessionScriptPath
              : (socketDir === X11_SOCKET_DIR ? undefined : null),
          })
        : socketDir === X11_SOCKET_DIR
          ? readManagedLinuxDesktopDisplayNumber()
          : undefined;
    if (managedDisplayNumber !== undefined && usable.includes(managedDisplayNumber)) {
      chosen = managedDisplayNumber;
    } else {
      const physical = usable.find((number) => number < PHYSICAL_X11_DISPLAY_THRESHOLD);
      if (physical !== undefined) {
        chosen = physical;
      } else if (usable.includes(DEFAULT_X11_DISPLAY_NUMBER)) {
        chosen = DEFAULT_X11_DISPLAY_NUMBER;
      } else {
        chosen = usable[0];
      }
    }
  } else {
    chosen = numbers[0];
  }
  const display = chosen !== undefined ? `:${chosen}` : DEFAULT_X11_DISPLAY;
  return { ...env, DISPLAY: display };
}

function defaultRuntimePathStat(path: string): LinuxRuntimePathStat | null {
  try {
    const info = statSync(path);
    return {
      uid: info.uid,
      gid: info.gid,
      isDirectory: info.isDirectory(),
      isSocket: info.isSocket(),
    };
  } catch {
    return null;
  }
}

interface ParsedManagedDesktopUnit {
  user: string;
  runtimeDirName: string;
}

function parseManagedDesktopServiceUnit(unitContent: string): ParsedManagedDesktopUnit | null {
  let user: string | undefined;
  let runtimeDirName = 'imcodes-desktop';
  let inService = false;
  for (const rawLine of unitContent.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      inService = line === '[Service]';
      continue;
    }
    if (!inService) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'User' && value.length > 0) {
      user = value;
    } else if (key === 'RuntimeDirectory' && value.length > 0) {
      const firstToken = value.split(/\s+/u)[0];
      if (!firstToken || firstToken.includes('/') || firstToken.includes('..')) {
        return null;
      }
      runtimeDirName = firstToken;
    }
  }
  if (!user || user === 'root') return null;
  return { user, runtimeDirName };
}

interface PasswdUserEntry {
  uid: number;
  gid: number;
  home: string;
}

function lookupPasswdUser(passwdContent: string, userName: string): PasswdUserEntry | null {
  for (const rawLine of passwdContent.split(/\r?\n/u)) {
    if (!rawLine || rawLine.startsWith('#')) continue;
    const fields = rawLine.split(':');
    if (fields.length < 6 || fields[0] !== userName) continue;
    const uid = Number(fields[2]);
    const gid = Number(fields[3]);
    const home = fields[5];
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0 || !home) {
      return null;
    }
    return { uid, gid, home };
  }
  return null;
}

/**
 * Resolves managed desktop audio runtime directory & user identity for the
 * worker's PulseAudio/PipeWire capture helper without overriding explicit
 * operator configuration. When the managed display and systemd service user
 * match, emits stable expected identity & socket paths even if the desktop
 * runtime directory/socket has not been created yet so the native helper
 * verifies ownership on every start/retry. When no match can be established or
 * existing socket ownership disagrees, emits `IMCODES_RD_AUDIO_POLICY=disabled`
 * so the helper exits before any implicit PulseAudio discovery while video
 * continues unaffected.
 */
export function resolveWorkerAudioEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveWorkerAudioOptions = {},
): NodeJS.ProcessEnv {
  const hasExplicitPulseServer = typeof env.PULSE_SERVER === 'string' && env.PULSE_SERVER.length > 0;
  const hasExplicitPolicy = typeof env.IMCODES_RD_AUDIO_POLICY === 'string' && env.IMCODES_RD_AUDIO_POLICY.length > 0;
  const hasExplicitAudioIdentity = typeof env.IMCODES_RD_AUDIO_UID === 'string' && env.IMCODES_RD_AUDIO_UID.length > 0;
  if (hasExplicitPulseServer || hasExplicitPolicy || hasExplicitAudioIdentity) {
    return env;
  }

  const statFn = options.stat ?? defaultRuntimePathStat;
  const currentUid = options.currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);

  const displayMatch = /^:(\d+)(?:\.\d+)?$/u.exec(env.DISPLAY ?? '');
  const chosenDisplayNumber = displayMatch ? Number(displayMatch[1]) : undefined;
  const managedDisplayNumber = readManagedLinuxDesktopDisplayNumber(options);

  const servicePath = options.sessionServicePath === undefined
    ? LINUX_DESKTOP_SESSION_SERVICE_PATH
    : options.sessionServicePath;
  const runtimeRootDir = options.runtimeRootDir === undefined
    ? LINUX_RUNTIME_ROOT_DIR
    : options.runtimeRootDir;
  const passwdPath = options.passwdPath === undefined
    ? LINUX_PASSWD_PATH
    : options.passwdPath;

  if (
    chosenDisplayNumber !== undefined &&
    managedDisplayNumber !== undefined &&
    chosenDisplayNumber === managedDisplayNumber &&
    servicePath &&
    runtimeRootDir &&
    passwdPath
  ) {
    try {
      const unitContent = readFileSync(servicePath, 'utf8');
      const parsedUnit = parseManagedDesktopServiceUnit(unitContent);
      if (parsedUnit) {
        const passwdContent = readFileSync(passwdPath, 'utf8');
        const userEntry = lookupPasswdUser(passwdContent, parsedUnit.user);
        if (userEntry && (currentUid === undefined || currentUid === 0 || currentUid === userEntry.uid)) {
          const runtimeDir = join(runtimeRootDir, parsedUnit.runtimeDirName);
          const pulseSocket = join(runtimeDir, 'pulse', 'native');
          const runtimeStat = statFn(runtimeDir);
          const socketStat = statFn(pulseSocket);
          const runtimeBad = runtimeStat !== null && (!runtimeStat.isDirectory || runtimeStat.uid !== userEntry.uid);
          const socketBad = socketStat !== null && (!socketStat.isSocket || socketStat.uid !== userEntry.uid);
          if (runtimeBad || socketBad) {
            return { ...env, IMCODES_RD_AUDIO_POLICY: 'disabled' };
          }
          return {
            ...env,
            IMCODES_RD_AUDIO_POLICY: 'managed',
            XDG_RUNTIME_DIR: runtimeDir,
            PULSE_SERVER: `unix:${pulseSocket}`,
            IMCODES_RD_AUDIO_RUNTIME_DIR: runtimeDir,
            IMCODES_RD_AUDIO_SOCKET: pulseSocket,
            IMCODES_RD_AUDIO_UID: String(userEntry.uid),
            IMCODES_RD_AUDIO_GID: String(userEntry.gid),
            IMCODES_RD_AUDIO_HOME: userEntry.home,
          };
        }
      }
    } catch {
      // Missing/unreadable unit or passwd file: fall through to non-root user check or disabled fallback.
    }
  }

  const runUserDir = options.runUserDir === undefined ? LINUX_RUN_USER_DIR : options.runUserDir;
  if (runUserDir && currentUid !== undefined && currentUid > 0) {
    const userRuntimeDir = join(runUserDir, String(currentUid));
    const userRuntimeStat = statFn(userRuntimeDir);
    const userPulseSocket = join(userRuntimeDir, 'pulse', 'native');
    const userSocketStat = statFn(userPulseSocket);
    if (
      userRuntimeStat?.isDirectory &&
      userRuntimeStat.uid === currentUid &&
      userSocketStat?.isSocket &&
      userSocketStat.uid === currentUid
    ) {
      return {
        ...env,
        IMCODES_RD_AUDIO_POLICY: 'user',
        XDG_RUNTIME_DIR: userRuntimeDir,
        PULSE_SERVER: `unix:${userPulseSocket}`,
        IMCODES_RD_AUDIO_RUNTIME_DIR: userRuntimeDir,
        IMCODES_RD_AUDIO_SOCKET: userPulseSocket,
      };
    }
  }

  return { ...env, IMCODES_RD_AUDIO_POLICY: 'disabled' };
}

/**
 * Full normal worker spawn environment: X11 display resolution plus managed
 * desktop audio runtime directory & identity handoff.
 */
export function resolveWorkerRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  socketDir: string = X11_SOCKET_DIR,
  accessible: readonly number[] | undefined = accessibleX11DisplayNumbers(socketDir),
  displayOptions?: ResolveWorkerDisplayOptions,
  audioOptions?: ResolveWorkerAudioOptions,
): NodeJS.ProcessEnv {
  const displayEnv = resolveWorkerDisplayEnv(env, socketDir, accessible, displayOptions);
  const effectiveAudioOptions: ResolveWorkerAudioOptions = audioOptions ?? (
    socketDir === X11_SOCKET_DIR
      ? displayOptions ?? {}
      : {
          displayMarkerPath: null,
          sessionScriptPath: null,
          sessionServicePath: null,
          runtimeRootDir: null,
          passwdPath: null,
          runUserDir: null,
        }
  );
  return resolveWorkerAudioEnv(displayEnv, effectiveAudioOptions);
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
  private readonly checkLibraries: (workerPath: string) => boolean;
  private readonly core: RemoteDesktopWorkerHostCore<Record<string, never>>;
  private librariesAvailableCache: boolean | null = null;
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private connectionGeneration = 0;

  constructor(
    private readonly onMessage: (message: RemoteDesktopDaemonMessage) => void,
    options: LinuxRemoteDesktopWorkerHostOptions = {},
  ) {
    this.workerPath = options.workerPath ?? resolveLinuxRemoteDesktopWorkerPath();
    this.checkLibraries = options.checkLibraries ?? checkLinuxWorkerLibraries;
    this.core = new RemoteDesktopWorkerHostCore({
      trafficStorePath: options.trafficStorePath,
      nonce: randomBytes(16).toString('hex'),
      onWatchdogTimeout: (event) => {
        this.onMessage(event.terminal);
      },
    });
  }

  available(): boolean {
    return existsSync(this.workerPath);
  }

  librariesAvailable(): boolean {
    if (!this.available()) return false;
    if (this.librariesAvailableCache !== null) {
      return this.librariesAvailableCache;
    }
    this.librariesAvailableCache = this.checkLibraries(this.workerPath);
    return this.librariesAvailableCache;
  }

  /** Restart the sidecar after the refresh coordinator atomically swaps it. */
  reloadFromDisk(): boolean {
    this.close();
    this.librariesAvailableCache = null;
    return this.available();
  }

  /**
   * The v3 profile, once the worker binary is present and all dynamic libraries
   * are resolved -- NOT the bare legacy REMOTE_DESKTOP_CAPABILITY token.
   * If shared libraries are missing, returns empty array so broken worker is
   * never advertised as active.
   */
  sessionCapabilities(): readonly string[] {
    if (!this.available() || !this.librariesAvailable()) return [];
    return [
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.LINUX,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.LINUX_X11,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      // The worker answers copy_selection from the X11 selection and types
      // pasted text through its input adapter (linux_x11_backend.cc).
      REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
    ];
  }

  /**
   * The real on-screen disclosure banner (X11DisclosureAdapter,
   * linux_x11_backend.h -- see the long comment on sessionCapabilities()
   * above for why this lives here and not there). Windows' equivalent host
   * advertises its adapter set the same way, from this method alone.
   *
   * REMOTE_DESKTOP_INPUT_CAPABILITY is now real too:
   * linux_remote_desktop_session.cc registers a real webrtc::
   * DataChannelObserver on every channel the browser opens and dispatches
   * pointer/keyboard messages through the same SessionCore/InputLedger the
   * already-qualified X11InputAdapter sits behind -- this worker is no
   * longer honestly view-only. Display selection/mode/scale and auto-unlock
   * remain unadvertised: Linux has one fixed display and no
   * CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY adapter, so claiming those would
   * be the exact dishonest advertisement this file's own header warns
   * against. The explicit clipboard is advertised with the session tokens.
   */
  adapterCapabilities(): readonly RemoteDesktopAdapterCapability[] {
    if (!this.available() || !this.librariesAvailable()) return [];
    return [REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY, REMOTE_DESKTOP_INPUT_CAPABILITY];
  }

  trafficStatus() { return this.core.traffic.snapshot(); }

  activeConnections() {
    return activeLocalRemoteDesktopConnections(this.core);
  }

  hasTrackedSessions(): boolean {
    return this.core.hasTrackedSessions();
  }

  activeRouteAuthorities() {
    return this.core.activeRouteSummaries();
  }

  async stopConnection(publicId: string): Promise<boolean> {
    return stopLocalRemoteDesktopConnection(this.core, (command) => this.handle(command), publicId);
  }

  async stopAllConnections(): Promise<void> {
    await stopAllLocalRemoteDesktopConnections(this.core, (command) => this.handle(command));
  }

  /** Keep the X11 local affordance alive even before the first PREPARE. */
  async start(): Promise<void> {
    if (!this.librariesAvailable()) {
      logger.info('linux remote desktop worker shared libraries missing, skipping start');
      return;
    }
    this.ensureSpawned();
  }

  setAccessPaused(paused: boolean): void {
    if (!this.child || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({
        type: REMOTE_DESKTOP_LOCAL_WORKER_MSG.ACCESS_STATE,
        paused,
      })}\n`);
    } catch (err) {
      logger.warn({ err }, 'linux remote desktop worker write access state failed');
    }
  }

  async handle(message: unknown): Promise<boolean> {
    if (!this.available() || !this.librariesAvailable()) return false;
    const parsed = validateRemoteDesktopDaemonCommand(message);
    if (!parsed.ok) return false;
    const command = parsed.value;
    if (command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      this.core.track(command, {});
    }
    const outboundCommand = this.core.rewriteCommandForLocalWorker(command);
    if (!this.ensureSpawned()) return false;
    if (!this.child || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(this.core.frameOutbound(outboundCommand));
      return true;
    } catch (err) {
      logger.warn({ err }, 'linux remote desktop worker write command failed');
      return false;
    }
  }

  onDaemonDisconnected(): void {
    if (!this.core.hasTrackedSessions()) return;
    this.core.armDisconnectGrace(() => Date.now(), (expired) => {
      for (const item of expired) {
        if (this.child && this.child.stdin.writable) {
          try {
            this.child.stdin.write(this.core.frameOutbound({
              type: REMOTE_DESKTOP_MSG.STOP,
              requestId: item.requestId,
              sessionId: item.sessionId,
              capability: item.capability,
            }));
          } catch { /* broken pipe during teardown */ }
        }
        this.onMessage(item.terminal);
      }
    });
  }

  onDaemonReconnected(): void {
    this.core.clearDisconnectGrace();
  }

  close(): void {
    this.core.clearDisconnectGrace();
    this.core.failAll(REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED, (terminal) => {
      this.onMessage(terminal);
    });
    this.killChild();
  }

  /** Idempotent: returns true if a worker process is already running or was
   * just started successfully. */
  private ensureSpawned(): boolean {
    if (this.child) return true;
    if (!this.librariesAvailable()) return false;
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(this.workerPath, [], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: resolveWorkerRuntimeEnv(),
      });
    } catch (err) {
      logger.warn({ err }, 'linux remote desktop worker spawn failed');
      return false;
    }
    child.stdin.on('error', (err) => {
      logger.warn({ err }, 'linux remote desktop worker stdin error');
    });
    const connectionGeneration = this.core.beginConnection();
    this.connectionGeneration = connectionGeneration;
    child.stdout.on('data', (chunk: Buffer) => {
      const result = this.core.pushInbound(chunk.toString('utf8'), connectionGeneration);
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
        if (event.kind === 'message') {
          if (event.value.type === REMOTE_DESKTOP_MSG.TERMINAL) {
            this.core.untrack(event.value.sessionId);
          }
          this.onMessage(event.value);
        }
      }
    });
    child.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'linux remote desktop worker exited');
      if (this.core.endConnection(connectionGeneration)) this.core.finishLocalConnections();
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
