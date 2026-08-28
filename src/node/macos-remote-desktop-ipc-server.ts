import { isUtf8 } from 'node:buffer';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  unlink,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import { join, parse, relative, resolve, sep } from 'node:path';
import {
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
} from '../../shared/remote-desktop-worker.js';
import type {
  RemoteDesktopDaemonCommand,
  RemoteDesktopDaemonMessage,
} from '../../shared/remote-desktop.js';
import {
  MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES,
  MACOS_REMOTE_DESKTOP_IPC_MESSAGE,
  MACOS_REMOTE_DESKTOP_RUNTIME_DIRECTORY_MODE,
  MACOS_REMOTE_DESKTOP_SOCKET_MODE,
  MacosRemoteDesktopIpcAuthorityHost,
  macosRemoteDesktopIpcPrincipalBinding,
  macosRemoteDesktopIpcPrincipalPaths,
  type MacosRemoteDesktopExpectedCodeIdentity,
  type MacosRemoteDesktopFilesystemEntry,
  type MacosRemoteDesktopIpcLaunch,
  type MacosRemoteDesktopIpcAuthenticated,
  type MacosRemoteDesktopIpcSession,
  type MacosRemoteDesktopSocketSecurityEvidence,
  type MacosRemoteDesktopVerifiedPeerIdentity,
} from './macos-remote-desktop-ipc.js';
import {
  MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE,
} from './macos-remote-desktop-graphical-readiness.js';
import {
  MACOS_REMOTE_DESKTOP_GRAPHICAL_RUNTIME_ROOT,
  MACOS_REMOTE_DESKTOP_RUNTIME_ROOT,
} from './macos-user-session.js';
import {
  assertMacosUserSession,
  type MacosRemoteDesktopGraphicalSessionAuthority,
  type MacosUserSession,
} from './user-session-launcher.js';
import {
  proxyVirtualDisplayRequest,
  type MacosVirtualDisplayProxyLease,
  type MacosVirtualDisplayProxySeams,
} from './macos-virtual-display-proxy.js';
import {
  MacosVirtualDisplayPendingRegistry,
  type MacosVirtualDisplayChannelIdentity,
} from './macos-virtual-display-pending.js';

export const MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR = Object.freeze({
  ALREADY_STARTED: 'macos_remote_desktop_ipc_server_already_started',
  NOT_CONNECTED: 'macos_remote_desktop_ipc_server_not_connected',
  UNSAFE_RUNTIME_PATH: 'macos_remote_desktop_ipc_server_unsafe_runtime_path',
  SOCKET_IN_USE: 'macos_remote_desktop_ipc_server_socket_in_use',
  INVALID_LIMITS: 'macos_remote_desktop_ipc_server_invalid_limits',
  HANDSHAKE_TIMEOUT: 'macos_remote_desktop_ipc_server_handshake_timeout',
  FRAME_TIMEOUT: 'macos_remote_desktop_ipc_server_frame_timeout',
  CALLBACK_TIMEOUT: 'macos_remote_desktop_ipc_server_callback_timeout',
  WRITE_TIMEOUT: 'macos_remote_desktop_ipc_server_write_timeout',
  INVALID_FRAME: 'macos_remote_desktop_ipc_server_invalid_frame',
  TOO_MANY_FRAMES: 'macos_remote_desktop_ipc_server_too_many_frames',
  BACKPRESSURE: 'macos_remote_desktop_ipc_server_backpressure',
  PEER_REJECTED: 'macos_remote_desktop_ipc_server_peer_rejected',
} as const);

export type MacosRemoteDesktopIpcDisconnectReason =
  | 'authentication_failed'
  | 'callback_failed'
  | 'frame_rejected'
  | 'peer_disconnected'
  | 'server_stopped'
  | 'write_failed';

export interface MacosRemoteDesktopVerifiedCodeIdentity {
  bundleIdentifier: string;
  teamId: string;
  designatedRequirement: string;
  /**
   * Kernel audit session and pid generation, consumed here rather than
   * discarded.
   *
   * Dropping them left the session unable to tell a superseded peer from the
   * live one: uid and code identity are identical across a relaunch, and a pid
   * is reused. The audit session is what ties this worker to one graphical
   * session, and pidVersion is what makes the pid non-recyclable.
   */
  auditSessionId: number;
  pidVersion: number;
}

export interface MacosRemoteDesktopPinnedPeer {
  readonly uid: number;
  readonly auditSessionId: number;
  readonly pidVersion: number;
  readonly workerGeneration: number;
  readonly sessionType: 'Aqua' | 'LoginWindow';
  readonly launchNonce: string;
}

export type MacosRemoteDesktopObservedGraphicalPeer = Pick<
  MacosRemoteDesktopVerifiedPeerIdentity,
  'kind' | 'sessionType'
>;

interface MacosRemoteDesktopIpcServerCommonOptions {
  authority: MacosRemoteDesktopIpcAuthorityHost;
  expectedCodeIdentity: MacosRemoteDesktopExpectedCodeIdentity;
  runtimeRoot?: string;
  /** Native getpeereid/LOCAL_PEERCRED boundary. Never derive this from JSON. */
  inspectPeerUid(socket: Socket): Promise<number>;
  /** Native Security.framework SecCode validation boundary. */
  verifyPeerCodeIdentity(
    socket: Socket,
    expected: MacosRemoteDesktopExpectedCodeIdentity,
  ): Promise<MacosRemoteDesktopVerifiedCodeIdentity>;
  onWorkerMessage(message: RemoteDesktopDaemonMessage): void | Promise<void>;
  /**
   * The agent lease this daemon currently holds, or null.
   *
   * Read per request rather than captured once: the lease is the agent
   * CONNECTION, and a reconnect must not be answered from a stale reference.
   */
  virtualDisplayLease?: () => MacosVirtualDisplayProxyLease | null;
  virtualDisplaySeams?: MacosVirtualDisplayProxySeams;
  onPeerAuthenticated?(
    launch: MacosRemoteDesktopIpcLaunch,
    session: MacosRemoteDesktopIpcSession,
  ): void | Promise<void>;
  /**
   * First post-ACK frame for a LoginWindow peer. Production must bind this
   * native post-composition attestation to the current bootstrap grant before
   * the peer is reported authenticated.
   */
  onGraphicalReadinessAttestation?(
    encoded: string,
    launch: MacosRemoteDesktopIpcLaunch,
    session: MacosRemoteDesktopIpcSession,
  ): void | Promise<void>;
  onDisconnect?(reason: MacosRemoteDesktopIpcDisconnectReason, error?: Error): void | Promise<void>;
  now?: () => number;
  handshakeTimeoutMs?: number;
  frameTimeoutMs?: number;
  callbackTimeoutMs?: number;
  writeTimeoutMs?: number;
  maxQueuedFrames?: number;
  maxPendingOutboundBytes?: number;
}

export type MacosRemoteDesktopIpcServerOptions = MacosRemoteDesktopIpcServerCommonOptions & (
  | {
    principal: MacosRemoteDesktopGraphicalSessionAuthority;
    user?: never;
    /** Authenticated observation; it must not be copied from `principal`. */
    inspectPeerGraphicalSession(
      socket: Socket,
    ): Promise<MacosRemoteDesktopObservedGraphicalPeer>;
  }
  | {
    user: MacosUserSession;
    principal?: never;
    inspectPeerGraphicalSession?: never;
  }
);

interface ConnectionState {
  socket: Socket;
  buffer: Buffer;
  lines: string[];
  pumping: boolean;
  authenticated: boolean;
  graphicalReadinessAccepted: boolean;
  session: MacosRemoteDesktopIpcSession | null;
  /** Pinned at hello and never re-derived from a later frame. */
  peer: MacosRemoteDesktopPinnedPeer | null;
  handshakeTimer: NodeJS.Timeout | null;
  frameTimer: NodeJS.Timeout | null;
  disconnectReason: MacosRemoteDesktopIpcDisconnectReason | null;
  disconnectError: Error | null;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_FRAME_TIMEOUT_MS = 5_000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 10_000;
const DEFAULT_WRITE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_QUEUED_FRAMES = 32;
const DEFAULT_MAX_PENDING_OUTBOUND_BYTES = MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES * 4;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 120_000;
const MAX_QUEUED_FRAMES_LIMIT = 1_024;
const PROBE_TIMEOUT_MS = 250;

function fail(code: string): never {
  throw new Error(code);
}

/**
 * Reads only the envelope type, without committing to a parser.
 *
 * A full parse would decide the frame is malformed before the dispatcher gets
 * to say which parser it belonged to, and this connection treats malformed as
 * terminal.
 */
function peekFrameType(line: string): string | null {
  if (line.length > MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const type = (parsed as Record<string, unknown>).type;
    return typeof type === 'string' ? type : null;
  } catch {
    return null;
  }
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function validateInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.INVALID_LIMITS);
  }
  return value;
}

function timeoutValue(value: number | undefined, fallback: number): number {
  return validateInteger(value ?? fallback, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

function modeOf(stats: Stats): number {
  return stats.mode & 0o7777;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertDirectory(path: string): Promise<Stats> {
  const stats = await lstatOrNull(path);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
  }
  return stats;
}

async function ensureDirectory(path: string, mode: number): Promise<void> {
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertDirectory(path);
}

async function ensureAbsoluteDirectoryChain(path: string, mode: number): Promise<void> {
  const parsed = parse(path);
  if (!parsed.root || resolve(path) !== path) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
  }
  let cursor = parsed.root;
  for (const component of path.slice(parsed.root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    await ensureDirectory(cursor, mode);
  }
}

async function ensureRuntimeDirectory(
  runtimeRoot: string,
  runtimeDirectory: string,
  owner: { uid: number; gid: number | null },
): Promise<void> {
  const canonicalRoot = resolve(runtimeRoot);
  const canonicalRuntime = resolve(runtimeDirectory);
  const child = relative(canonicalRoot, canonicalRuntime);
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
  }

  await ensureAbsoluteDirectoryChain(canonicalRoot, 0o755);
  await assertDirectory(canonicalRoot);
  let cursor = canonicalRoot;
  for (const component of child.split(sep)) {
    cursor = join(cursor, component);
    await ensureDirectory(cursor, MACOS_REMOTE_DESKTOP_RUNTIME_DIRECTORY_MODE);
  }
  await chown(canonicalRuntime, owner.uid, owner.gid ?? -1);
  await chmod(canonicalRuntime, MACOS_REMOTE_DESKTOP_RUNTIME_DIRECTORY_MODE);
  const secured = await assertDirectory(canonicalRuntime);
  if (secured.uid !== owner.uid
    || modeOf(secured) !== MACOS_REMOTE_DESKTOP_RUNTIME_DIRECTORY_MODE) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
  }
}

async function socketIsActive(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    const socket = net.createConnection({ path });
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(active);
    };
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT');
    });
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  const before = await lstatOrNull(path);
  if (!before) return;
  if (before.isSymbolicLink() || !before.isSocket()) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
  }
  if (await socketIsActive(path)) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.SOCKET_IN_USE);
  }
  const current = await lstatOrNull(path);
  if (!current || !sameFile(before, current) || !current.isSocket()) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
  }
  await unlink(path);
}

function filesystemEntry(path: string, stats: Stats): MacosRemoteDesktopFilesystemEntry {
  return {
    path,
    uid: stats.uid,
    mode: stats.mode,
    kind: stats.isSocket() ? 'socket' : 'directory',
  };
}

async function readSocketSecurity(
  runtimeDirectory: string,
  socketPath: string,
): Promise<MacosRemoteDesktopSocketSecurityEvidence> {
  const runtimeStats = await lstat(runtimeDirectory);
  const socketStats = await lstat(socketPath);
  if (runtimeStats.isSymbolicLink() || !runtimeStats.isDirectory()
    || socketStats.isSymbolicLink() || !socketStats.isSocket()) {
    fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
  }
  return {
    runtimeDirectory: filesystemEntry(runtimeDirectory, runtimeStats),
    socket: filesystemEntry(socketPath, socketStats),
  };
}

async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutCode)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ path });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

/**
 * Bounded newline-framed transport for one signed macOS GUI worker generation.
 * All protocol/route authority remains in MacosRemoteDesktopIpcAuthorityHost.
 */
export class MacosRemoteDesktopIpcServer {
  private readonly handshakeTimeoutMs: number;
  private readonly frameTimeoutMs: number;
  private readonly callbackTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly maxQueuedFrames: number;
  private readonly maxPendingOutboundBytes: number;
  private readonly now: () => number;
  private server: Server | null = null;
  private launch: MacosRemoteDesktopIpcLaunch | null = null;
  private socketIdentity: Stats | null = null;
  private candidate: ConnectionState | null = null;
  private active: ConnectionState | null = null;
  private generationActive = false;
  private teardownPromise: Promise<void> | null = null;
  private outboundTail: Promise<void> = Promise.resolve();
  private pendingOutboundBytes = 0;
  private readonly principalSource: MacosRemoteDesktopGraphicalSessionAuthority | MacosUserSession;
  private readonly owner: { uid: number; gid: number | null };
  private readonly runtimeRoot: string;

  constructor(private readonly options: MacosRemoteDesktopIpcServerOptions) {
    if (options.principal) {
      const binding = macosRemoteDesktopIpcPrincipalBinding(options.principal);
      this.principalSource = options.principal;
      this.owner = {
        uid: binding.uid,
        gid: options.principal.kind === 'aqua_user' ? options.principal.user.gid : null,
      };
      this.runtimeRoot = options.runtimeRoot ?? MACOS_REMOTE_DESKTOP_GRAPHICAL_RUNTIME_ROOT;
    } else {
      assertMacosUserSession(options.user);
      this.principalSource = options.user;
      this.owner = { uid: options.user.uid, gid: options.user.gid };
      this.runtimeRoot = options.runtimeRoot ?? MACOS_REMOTE_DESKTOP_RUNTIME_ROOT;
    }
    this.handshakeTimeoutMs = timeoutValue(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.frameTimeoutMs = timeoutValue(options.frameTimeoutMs, DEFAULT_FRAME_TIMEOUT_MS);
    this.callbackTimeoutMs = timeoutValue(options.callbackTimeoutMs, DEFAULT_CALLBACK_TIMEOUT_MS);
    this.writeTimeoutMs = timeoutValue(options.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS);
    this.maxQueuedFrames = validateInteger(
      options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES,
      1,
      MAX_QUEUED_FRAMES_LIMIT,
    );
    this.maxPendingOutboundBytes = validateInteger(
      options.maxPendingOutboundBytes ?? DEFAULT_MAX_PENDING_OUTBOUND_BYTES,
      1,
      MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES * MAX_QUEUED_FRAMES_LIMIT,
    );
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<MacosRemoteDesktopIpcLaunch> {
    if (this.teardownPromise) await this.teardownPromise;
    if (this.server || this.launch) fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.ALREADY_STARTED);

    const launch = this.options.authority.beginLaunch();
    this.launch = launch;
    this.generationActive = true;
    const expectedPaths = macosRemoteDesktopIpcPrincipalPaths(
      this.principalSource,
      this.runtimeRoot,
    );

    try {
      if (launch.socketPath !== expectedPaths.socketPath) {
        fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
      }
      await ensureRuntimeDirectory(this.runtimeRoot, expectedPaths.runtimeDirectory, this.owner);
      await removeStaleSocket(launch.socketPath);
      const server = net.createServer((socket) => this.accept(socket));
      server.maxConnections = 2;
      this.server = server;
      await listen(server, launch.socketPath);
      await chown(launch.socketPath, this.owner.uid, this.owner.gid ?? -1);
      await chmod(launch.socketPath, MACOS_REMOTE_DESKTOP_SOCKET_MODE);
      const evidence = await readSocketSecurity(expectedPaths.runtimeDirectory, launch.socketPath);
      if (evidence.runtimeDirectory.uid !== this.owner.uid
        || evidence.socket.uid !== this.owner.uid
        || modeOf(await lstat(launch.socketPath)) !== MACOS_REMOTE_DESKTOP_SOCKET_MODE) {
        fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH);
      }
      this.socketIdentity = await lstat(launch.socketPath);
      return launch;
    } catch (error) {
      await this.teardown('server_stopped', errorOf(error));
      throw error;
    }
  }

  async sendCommand(command: RemoteDesktopDaemonCommand): Promise<void> {
    const state = this.active;
    const launch = this.launch;
    if (!state?.session || !state.authenticated || !launch || state.socket.destroyed) {
      fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.NOT_CONNECTED);
    }
    const frame = `${JSON.stringify({
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HOST_COMMAND,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      workerGeneration: launch.workerGeneration,
      command,
    })}\n`;
    const bytes = Buffer.byteLength(frame);
    if (bytes > MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES + 1
      || this.pendingOutboundBytes + bytes > this.maxPendingOutboundBytes) {
      fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.BACKPRESSURE);
    }

    this.pendingOutboundBytes += bytes;
    const expectedState = state;
    const operation = this.outboundTail.then(async () => {
      if (this.active !== expectedState || !expectedState.session || expectedState.socket.destroyed) {
        fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.NOT_CONNECTED);
      }
      this.options.authority.acceptHostFrame(
        expectedState.session,
        frame.slice(0, -1),
        this.now(),
      );
      await this.write(expectedState.socket, frame);
    });
    this.outboundTail = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      void this.teardown('write_failed', errorOf(error));
      throw error;
    } finally {
      this.pendingOutboundBytes -= bytes;
    }
  }

  async stop(): Promise<void> {
    await this.teardown('server_stopped');
  }

  private accept(socket: Socket): void {
    if (!this.generationActive || this.candidate || this.active) {
      socket.once('error', () => undefined);
      socket.destroy(new Error(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.PEER_REJECTED));
      return;
    }
    socket.setNoDelay(true);
    const state: ConnectionState = {
      socket,
      buffer: Buffer.alloc(0),
      lines: [],
      pumping: false,
      authenticated: false,
      graphicalReadinessAccepted: false,
      session: null,
      peer: null,
      handshakeTimer: null,
      frameTimer: null,
      disconnectReason: null,
      disconnectError: null,
    };
    this.candidate = state;
    state.handshakeTimer = setTimeout(() => {
      this.reject(state, MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.HANDSHAKE_TIMEOUT);
    }, this.handshakeTimeoutMs);
    state.handshakeTimer.unref?.();
    socket.on('data', (chunk: Buffer) => this.receive(state, chunk));
    socket.once('error', () => undefined);
    socket.once('close', () => this.connectionClosed(state));
  }

  private receive(state: ConnectionState, chunk: Buffer): void {
    if (state.socket.destroyed || this.candidate !== state && this.active !== state) return;
    state.buffer = Buffer.concat([state.buffer, chunk]);
    const maxBufferedBytes = (MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES + 1) * this.maxQueuedFrames;
    if (state.buffer.length > maxBufferedBytes) {
      this.reject(state, MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.TOO_MANY_FRAMES);
      return;
    }

    let newline = state.buffer.indexOf(0x0a);
    while (newline >= 0) {
      const encoded = state.buffer.subarray(0, newline);
      state.buffer = state.buffer.subarray(newline + 1);
      if (encoded.length === 0
        || encoded.length > MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES
        || !isUtf8(encoded)) {
        this.reject(state, MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.INVALID_FRAME);
        return;
      }
      state.lines.push(encoded.toString('utf8'));
      if (state.lines.length > this.maxQueuedFrames) {
        this.reject(state, MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.TOO_MANY_FRAMES);
        return;
      }
      newline = state.buffer.indexOf(0x0a);
    }
    if (state.buffer.length > MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES) {
      this.reject(state, MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.INVALID_FRAME);
      return;
    }
    this.updateFrameTimer(state);
    void this.pump(state);
  }

  private updateFrameTimer(state: ConnectionState): void {
    if (state.buffer.length === 0) {
      if (state.frameTimer) clearTimeout(state.frameTimer);
      state.frameTimer = null;
      return;
    }
    if (state.frameTimer) return;
    state.frameTimer = setTimeout(() => {
      this.reject(state, MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.FRAME_TIMEOUT);
    }, this.frameTimeoutMs);
    state.frameTimer.unref?.();
  }

  private readonly virtualDisplayPending = new MacosVirtualDisplayPendingRegistry();
  private readonly leaseIds = new WeakMap<MacosVirtualDisplayProxyLease, number>();
  private nextLeaseId = 0;

  private async pump(state: ConnectionState): Promise<void> {
    if (state.pumping || state.socket.destroyed) return;
    state.pumping = true;
    state.socket.pause();
    try {
      while (!state.socket.destroyed && state.lines.length > 0) {
        const line = state.lines.shift();
        if (!line) fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.INVALID_FRAME);
        if (!state.authenticated) {
          await this.authenticate(state, line);
          continue;
        }
        const session = state.session;
        if (!session) fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.PEER_REJECTED);
        if (this.options.principal?.kind === 'loginwindow_bootstrap'
          && !state.graphicalReadinessAccepted) {
          if (peekFrameType(line) !== MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE
            || !this.options.onGraphicalReadinessAttestation) {
            fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.PEER_REJECTED);
          }
          const launch = this.launch;
          if (!launch) fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.PEER_REJECTED);
          await withDeadline(
            Promise.resolve(this.options.onGraphicalReadinessAttestation(
              line,
              launch,
              session,
            )),
            this.callbackTimeoutMs,
            MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.CALLBACK_TIMEOUT,
          );
          state.graphicalReadinessAccepted = true;
          await this.notifyPeerAuthenticated(launch, session);
          continue;
        }
        // Two envelopes share this stream. Routing every frame to the worker
        // message parser meant a virtual-display request threw and took the
        // connection with it -- the worker asking about a display was
        // indistinguishable from a worker speaking a protocol we do not know.
        if (peekFrameType(line)
          === MACOS_REMOTE_DESKTOP_IPC_MESSAGE.VIRTUAL_DISPLAY_REQUEST) {
          await this.serveVirtualDisplay(state, session, line);
          continue;
        }
        const message = this.options.authority.acceptWorkerFrame(session, line, this.now());
        try {
          await withDeadline(
            Promise.resolve(this.options.onWorkerMessage(message)),
            this.callbackTimeoutMs,
            MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.CALLBACK_TIMEOUT,
          );
        } catch (error) {
          this.reject(
            state,
            MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.CALLBACK_TIMEOUT,
            error,
            'callback_failed',
          );
          return;
        }
      }
    } catch (error) {
      this.reject(
        state,
        errorOf(error).message === MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.CALLBACK_TIMEOUT
          ? MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.CALLBACK_TIMEOUT
          : MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.INVALID_FRAME,
        error,
      );
    } finally {
      state.pumping = false;
      if (!state.socket.destroyed) state.socket.resume();
      if (!state.socket.destroyed && state.lines.length > 0) void this.pump(state);
    }
  }

  private async authenticate(state: ConnectionState, line: string): Promise<void> {
    const launch = this.launch;
    if (!launch || this.candidate !== state) {
      fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.PEER_REJECTED);
    }
    const paths = macosRemoteDesktopIpcPrincipalPaths(
      this.principalSource,
      this.runtimeRoot,
    );
    const observedGraphicalPeer = this.options.principal
      ? this.options.inspectPeerGraphicalSession(state.socket)
      : Promise.resolve<MacosRemoteDesktopObservedGraphicalPeer>({
        kind: 'aqua_user',
        sessionType: 'Aqua',
      });
    const [uid, codeIdentity, graphicalPeer, filesystem] = await withDeadline(
      Promise.all([
        this.options.inspectPeerUid(state.socket),
        this.options.verifyPeerCodeIdentity(state.socket, this.options.expectedCodeIdentity),
        observedGraphicalPeer,
        readSocketSecurity(paths.runtimeDirectory, paths.socketPath),
      ]),
      this.handshakeTimeoutMs,
      MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.HANDSHAKE_TIMEOUT,
    );
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.PEER_REJECTED);
    }
    // Refused, not defaulted. A zero audit session is the absence of a session,
    // and binding display authority to it would bind it to nothing.
    if (!Number.isSafeInteger(codeIdentity.auditSessionId)
      || codeIdentity.auditSessionId <= 0
      || !Number.isSafeInteger(codeIdentity.pidVersion)
      || codeIdentity.pidVersion <= 0) {
      fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.PEER_REJECTED);
    }
    const peer: MacosRemoteDesktopVerifiedPeerIdentity = {
      uid,
      auditSessionId: codeIdentity.auditSessionId,
      pidVersion: codeIdentity.pidVersion,
      kind: graphicalPeer.kind,
      sessionType: graphicalPeer.sessionType,
      bundleIdentifier: codeIdentity.bundleIdentifier,
      teamId: codeIdentity.teamId,
      designatedRequirement: codeIdentity.designatedRequirement,
    };
    const session = this.options.authority.authenticate(line, peer, filesystem);
    if (session.workerGeneration !== launch.workerGeneration) {
      fail(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.PEER_REJECTED);
    }
    state.session = session;
    state.peer = {
      uid: session.principal.uid,
      auditSessionId: session.principal.auditSessionId,
      pidVersion: session.principal.pidVersion,
      workerGeneration: session.workerGeneration,
      sessionType: session.principal.sessionType,
      launchNonce: session.launchNonce,
    };
    const acknowledgement: MacosRemoteDesktopIpcAuthenticated = {
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.AUTHENTICATED,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      workerGeneration: session.workerGeneration,
      uid: session.principal.uid,
      auditSessionId: session.principal.auditSessionId,
      pidVersion: session.principal.pidVersion,
      sessionType: session.principal.sessionType,
      launchChallenge: session.launchNonce,
    };
    await this.write(state.socket, `${JSON.stringify(acknowledgement)}\n`);
    state.authenticated = true;
    this.candidate = null;
    this.active = state;
    if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
    state.handshakeTimer = null;
    if (this.options.principal?.kind !== 'loginwindow_bootstrap') {
      await this.notifyPeerAuthenticated(launch, session);
    }
  }

  private async notifyPeerAuthenticated(
    launch: MacosRemoteDesktopIpcLaunch,
    session: MacosRemoteDesktopIpcSession,
  ): Promise<void> {
    if (!this.options.onPeerAuthenticated) return;
    await withDeadline(
      Promise.resolve(this.options.onPeerAuthenticated(launch, session)),
      this.callbackTimeoutMs,
      MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.CALLBACK_TIMEOUT,
    );
  }

  /**
   * Identity of the exact agent connection.
   *
   * Object identity, not a field: two leases can agree on every value and
   * still be different connections, and a reply authored by the previous one
   * must not settle a request made to its replacement.
   */
  private leaseIdOf(lease: MacosVirtualDisplayProxyLease): number {
    const known = this.leaseIds.get(lease);
    if (known !== undefined) return known;
    this.nextLeaseId += 1;
    this.leaseIds.set(lease, this.nextLeaseId);
    return this.nextLeaseId;
  }

  /**
   * Drops the display channel.
   *
   * Called when the agent lease ends, when this worker disconnects, and when
   * the peer identity changes. Every request in flight fails rather than
   * waiting for an answer that can no longer come from the principal it was
   * asked of.
   */
  revokeVirtualDisplayChannel(): number {
    return this.virtualDisplayPending.close();
  }

  /**
   * Answers one virtual-display request on the socket it arrived on.
   *
   * A refusal is a REPLY, not a disconnect. The worker asked a legitimate
   * question that this daemon could not answer, and dropping the connection
   * would take capture and input down with it.
   */
  private async serveVirtualDisplay(
    state: ConnectionState,
    session: MacosRemoteDesktopIpcSession,
    line: string,
  ): Promise<void> {
    const peer = state.peer;
    const lease = this.options.virtualDisplayLease?.() ?? null;
    const seams = this.options.virtualDisplaySeams;

    let requestId = 0;
    let reply: { ok: boolean; error?: string } = {
      ok: false, error: 'virtual_display_unavailable',
    };
    try {
      const accepted = this.options.authority.acceptVirtualDisplayRequest(session, line);
      requestId = accepted.requestId;

      if (peer === null || lease === null || seams === undefined) {
        reply = { ok: false, error: 'agent_unavailable' };
      } else {
        const identity: MacosVirtualDisplayChannelIdentity = {
          workerGeneration: peer.workerGeneration,
          auditSessionId: peer.auditSessionId,
          serviceGeneration: lease.serviceGeneration,
          leaseId: this.leaseIdOf(lease),
        };
        // The agent's audit session must be the worker's. A lease belonging to
        // another graphical session would answer truthfully about a display
        // this worker has no business reaching.
        if (lease.auditSessionId !== peer.auditSessionId) {
          this.virtualDisplayPending.close();
          reply = { ok: false, error: 'agent_session_mismatch' };
        } else {
          this.virtualDisplayPending.bind(identity);
          const admitted = this.virtualDisplayPending.admit(identity, requestId);
          if (!admitted.ok) {
            reply = { ok: false, error: admitted.error };
          } else {
            const answered = await proxyVirtualDisplayRequest(
              lease, accepted.request, accepted.routeGeneration, seams,
            );
            // Re-verified at settle time, not only at admit time: the lease or
            // the generation may have changed while this was in flight.
            if (!this.virtualDisplayPending.settle(identity, requestId)) {
              this.virtualDisplayPending.abandon(requestId);
              reply = { ok: false, error: 'virtual_display_identity_changed' };
            } else {
              reply = answered;
            }
          }
        }
      }
    } catch (error) {
      // A malformed request envelope is the one case that IS terminal: the
      // frame boundary itself is no longer trustworthy.
      this.virtualDisplayPending.close();
      this.reject(state, MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.INVALID_FRAME,
        error, 'frame_rejected');
      return;
    }

    if (state.socket.destroyed || this.active !== state) return;
    try {
      const frame = `${this.options.authority.encodeVirtualDisplayReply(
        session, requestId, reply,
      )}\n`;
      await this.write(state.socket, frame);
    } catch (error) {
      void this.teardown('write_failed', errorOf(error));
    }
  }

  private async write(socket: Socket, frame: string): Promise<void> {
    await withDeadline(new Promise<void>((resolveWrite, reject) => {
      socket.write(frame, (error) => {
        if (error) reject(error);
        else resolveWrite();
      });
    }), this.writeTimeoutMs, MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.WRITE_TIMEOUT);
  }

  private reject(
    state: ConnectionState,
    code: string,
    cause?: unknown,
    reason?: MacosRemoteDesktopIpcDisconnectReason,
  ): void {
    if (state.socket.destroyed) return;
    const error = cause ? errorOf(cause) : new Error(code);
    state.disconnectReason = reason ?? (state.authenticated
      ? code === MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.CALLBACK_TIMEOUT
        ? 'callback_failed'
        : 'frame_rejected'
      : 'authentication_failed');
    state.disconnectError = error;
    state.socket.destroy(error);
  }

  private connectionClosed(state: ConnectionState): void {
    if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
    if (state.frameTimer) clearTimeout(state.frameTimer);
    const owned = this.candidate === state || this.active === state;
    if (!owned) return;
    const authenticated = this.active === state;
    this.candidate = null;
    this.active = null;
    // The worker that asked is gone. Every display request still in flight is
    // failed rather than left to be answered into a socket nobody reads.
    this.virtualDisplayPending.close();
    void this.teardown(
      state.disconnectReason ?? (authenticated ? 'peer_disconnected' : 'authentication_failed'),
      state.disconnectError ?? undefined,
    ).catch(() => undefined);
  }

  private teardown(
    reason: MacosRemoteDesktopIpcDisconnectReason,
    error?: Error,
  ): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    const server = this.server;
    const socketPath = this.launch?.socketPath;
    const socketIdentity = this.socketIdentity;
    const hadGeneration = this.generationActive;
    this.generationActive = false;
    this.server = null;
    this.launch = null;
    this.socketIdentity = null;
    const candidate = this.candidate;
    const active = this.active;
    this.candidate = null;
    this.active = null;
    candidate?.socket.destroy();
    if (active !== candidate) active?.socket.destroy();
    if (hadGeneration) this.options.authority.cleanup();

    const operation = (async () => {
      if (server) await closeServer(server);
      if (socketPath && socketIdentity) {
        const current = await lstatOrNull(socketPath);
        if (current && current.isSocket() && sameFile(current, socketIdentity)) {
          await unlink(socketPath);
        }
      }
      if (hadGeneration && this.options.onDisconnect) {
        try {
          await Promise.resolve(this.options.onDisconnect(reason, error));
        } catch {
          // Observability callbacks cannot retain a socket, challenge or route.
        }
      }
    })().finally(() => {
      if (this.teardownPromise === operation) this.teardownPromise = null;
    });
    this.teardownPromise = operation;
    return operation;
  }
}
