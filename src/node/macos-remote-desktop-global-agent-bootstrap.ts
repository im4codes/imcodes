import { timingSafeEqual } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import net, { type Server, type Socket } from 'node:net';
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { MacosRemoteDesktopGraphicalSessionAuthority } from './user-session-launcher.js';
import {
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_SOCKET_PATH,
  MACOS_REMOTE_DESKTOP_GRAPHICAL_RUNTIME_ROOT,
  macosRemoteDesktopGraphicalSessionPaths,
} from './macos-user-session.js';

export const MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION = 1 as const;

export const MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE = Object.freeze({
  HELLO: 'remote_desktop.macos_bootstrap.hello',
  GRANT: 'remote_desktop.macos_bootstrap.grant',
} as const);

export const MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR = Object.freeze({
  INVALID_PEER: 'macos_remote_desktop_bootstrap_invalid_peer',
  INVALID_HELLO: 'macos_remote_desktop_bootstrap_invalid_hello',
  IDENTITY_MISMATCH: 'macos_remote_desktop_bootstrap_identity_mismatch',
  REPLAY: 'macos_remote_desktop_bootstrap_replay',
  STALE_GENERATION: 'macos_remote_desktop_bootstrap_stale_generation',
  INVALID_LAUNCH: 'macos_remote_desktop_bootstrap_invalid_launch',
  HANDSHAKE_TIMEOUT: 'macos_remote_desktop_bootstrap_handshake_timeout',
} as const);

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/u;
const MAX_TRACKED_NONCES = 4_096;
const MAX_BOOTSTRAP_FRAME_BYTES = 16 * 1024;
/**
 * The whole hello-to-grant exchange, so it must outlast what happens inside it:
 * the launch it waits on may take up to DEFAULT_GRAPHICAL_AUTHORITY_TIMEOUT_MS
 * (15 s) while the component set is verified and readiness is read through the
 * signed app. At 5 s this listener hung up -- silently -- long before the grant
 * existed, the agent reported only "bootstrap refused" and was relaunched, and
 * no worker ever started. It must also stay below the agent's own wait
 * (kGrantReadDeadlineMs, 20 s), or the agent gives up on a grant still coming.
 */
export const MACOS_REMOTE_DESKTOP_BOOTSTRAP_HANDSHAKE_TIMEOUT_MS = 18_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = MACOS_REMOTE_DESKTOP_BOOTSTRAP_HANDSHAKE_TIMEOUT_MS;

export type MacosRemoteDesktopGraphicalSessionType = 'Aqua' | 'LoginWindow';

/** Kernel/Security.framework evidence, never fields copied from the hello. */
export interface MacosRemoteDesktopBootstrapVerifiedPeer {
  readonly uid: number;
  readonly auditSessionId: number;
  readonly pidVersion: number;
  /** Native classification after joining the authenticated peer audit session. */
  readonly sessionType: MacosRemoteDesktopGraphicalSessionType;
  readonly bundleIdentifier: string;
  readonly teamId: string;
  readonly designatedRequirement: string;
}

/** Declaration produced by the running global LaunchAgent. */
export interface MacosRemoteDesktopBootstrapHello {
  readonly type: typeof MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.HELLO;
  readonly bootstrapVersion: typeof MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION;
  readonly uid: number;
  readonly auditSessionId: number;
  readonly sessionType: MacosRemoteDesktopGraphicalSessionType;
  readonly instanceNonce: string;
}

export interface MacosRemoteDesktopBootstrapLaunch {
  readonly workerGeneration: number;
  readonly challenge: string;
  readonly socketPath: string;
}

export interface MacosRemoteDesktopBootstrapGrant
  extends MacosRemoteDesktopBootstrapLaunch {
  readonly type: typeof MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.GRANT;
  readonly bootstrapVersion: typeof MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION;
  readonly uid: number;
  readonly auditSessionId: number;
  readonly sessionType: MacosRemoteDesktopGraphicalSessionType;
  readonly instanceNonce: string;
}

export interface MacosRemoteDesktopBootstrapRevocation {
  readonly uid: number;
  readonly auditSessionId: number;
  readonly pidVersion: number;
  readonly workerGeneration: number;
  readonly socketPath: string;
  readonly reason: 'session_successor' | 'session_exit' | 'shutdown';
}

interface ActiveInstance {
  readonly peer: MacosRemoteDesktopBootstrapVerifiedPeer;
  readonly hello: MacosRemoteDesktopBootstrapHello;
  readonly grant: MacosRemoteDesktopBootstrapGrant;
}

/**
 * Throw a bootstrap error, optionally naming WHICH check refused.
 *
 * One code is shared by several distinct checks. Without the detail, a
 * production log showed `macos_remote_desktop_bootstrap_invalid_launch` every
 * five minutes and gave no way to tell a stale socket from a live one from a
 * wrongly owned directory -- the difference between a race and a check that can
 * never pass. The code stays first so anything matching on it still matches.
 */
function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function isPositiveUint32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= 0xffff_ffff;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function validatePeer(peer: MacosRemoteDesktopBootstrapVerifiedPeer): void {
  if (!exactKeys(peer, [
    'uid', 'auditSessionId', 'pidVersion', 'sessionType', 'bundleIdentifier', 'teamId',
    'designatedRequirement',
  ])
    || !isPositiveUint32(peer.uid)
    || !isPositiveUint32(peer.auditSessionId)
    || !isPositiveUint32(peer.pidVersion)
    || (peer.sessionType !== 'Aqua' && peer.sessionType !== 'LoginWindow')
    || typeof peer.bundleIdentifier !== 'string'
    || peer.bundleIdentifier.length === 0
    || typeof peer.teamId !== 'string'
    || peer.teamId.length === 0
    || typeof peer.designatedRequirement !== 'string'
    || peer.designatedRequirement.length === 0) {
    fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_PEER);
  }
}

function validateHello(hello: MacosRemoteDesktopBootstrapHello): void {
  if (!exactKeys(hello, [
    'type', 'bootstrapVersion', 'uid', 'auditSessionId', 'sessionType',
    'instanceNonce',
  ])
    || hello.type !== MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.HELLO
    || hello.bootstrapVersion !== MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION
    || !isPositiveUint32(hello.uid)
    || !isPositiveUint32(hello.auditSessionId)
    || (hello.sessionType !== 'Aqua' && hello.sessionType !== 'LoginWindow')
    || typeof hello.instanceNonce !== 'string'
    || !SECRET_RE.test(hello.instanceNonce)) {
    fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_HELLO);
  }
}

export function decodeMacosRemoteDesktopBootstrapHello(
  line: string,
): MacosRemoteDesktopBootstrapHello {
  if (typeof line !== 'string'
    || line.length === 0
    || Buffer.byteLength(line, 'utf8') > MAX_BOOTSTRAP_FRAME_BYTES
    || /[\0\r\n]/u.test(line)) {
    fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_HELLO);
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_HELLO);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_HELLO);
  }
  validateHello(value as MacosRemoteDesktopBootstrapHello);
  return Object.freeze({ ...(value as MacosRemoteDesktopBootstrapHello) });
}

function instanceKey(uid: number, auditSessionId: number): string {
  return `${uid}/${auditSessionId}`;
}

/**
 * One-time admission ledger for the root-daemon bootstrap socket.
 *
 * The global plist carries only the stable bootstrap socket name. Everything
 * usable by a worker is minted after kernel peer verification and is scoped to
 * uid + audit-session + pid-version + process nonce. A successor revokes the
 * old socket before its own grant is returned.
 */
export class MacosRemoteDesktopGlobalAgentBootstrap {
  readonly socketPath = MACOS_REMOTE_DESKTOP_BOOTSTRAP_SOCKET_PATH;
  private readonly active = new Map<string, ActiveInstance>();
  private readonly activeByUid = new Map<number, string>();
  private readonly consumedNonceQueue: string[] = [];
  private readonly consumedNonces = new Set<string>();
  private lastWorkerGeneration = 0;

  constructor(
    private readonly revoke: (
      revocation: MacosRemoteDesktopBootstrapRevocation,
    ) => void | Promise<void>,
    private readonly runtimeRoot = MACOS_REMOTE_DESKTOP_GRAPHICAL_RUNTIME_ROOT,
  ) {}

  async issueGrant(
    peer: MacosRemoteDesktopBootstrapVerifiedPeer,
    hello: MacosRemoteDesktopBootstrapHello,
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
    launch: MacosRemoteDesktopBootstrapLaunch,
  ): Promise<MacosRemoteDesktopBootstrapGrant> {
    validatePeer(peer);
    validateHello(hello);
    const authorityUid = authority.kind === 'aqua_user'
      ? authority.user.uid
      : authority.uid;
    if (peer.uid !== hello.uid
      || peer.auditSessionId !== hello.auditSessionId
      || authorityUid !== peer.uid
      || authority.auditSessionId !== peer.auditSessionId
      || authority.pidVersion !== peer.pidVersion
      || authority.sessionType !== peer.sessionType) {
      fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.IDENTITY_MISMATCH);
    }
    const nonceKey = `${peer.uid}/${peer.auditSessionId}/${peer.pidVersion}/${hello.instanceNonce}`;
    if (this.consumedNonces.has(nonceKey)) {
      fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.REPLAY);
    }
    if (!isPositiveUint32(launch.workerGeneration)
      || launch.workerGeneration <= this.lastWorkerGeneration) {
      fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.STALE_GENERATION);
    }
    const paths = macosRemoteDesktopGraphicalSessionPaths(peer, this.runtimeRoot);
    if (!SECRET_RE.test(launch.challenge) || launch.socketPath !== paths.socketPath) {
      fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_LAUNCH);
    }

    const key = instanceKey(peer.uid, peer.auditSessionId);
    const previousKey = this.activeByUid.get(peer.uid);
    if (previousKey) {
      const previous = this.active.get(previousKey);
      if (previous) {
        await this.revoke({
          uid: previous.peer.uid,
          auditSessionId: previous.peer.auditSessionId,
          pidVersion: previous.peer.pidVersion,
          workerGeneration: previous.grant.workerGeneration,
          socketPath: previous.grant.socketPath,
          reason: 'session_successor',
        });
        this.active.delete(previousKey);
      }
    }

    const grant: MacosRemoteDesktopBootstrapGrant = Object.freeze({
      type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.GRANT,
      bootstrapVersion: MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
      uid: peer.uid,
      auditSessionId: peer.auditSessionId,
      sessionType: authority.sessionType,
      instanceNonce: hello.instanceNonce,
      workerGeneration: launch.workerGeneration,
      challenge: launch.challenge,
      socketPath: launch.socketPath,
    });
    this.lastWorkerGeneration = launch.workerGeneration;
    this.rememberNonce(nonceKey);
    this.active.set(key, { peer: Object.freeze({ ...peer }), hello, grant });
    this.activeByUid.set(peer.uid, key);
    return grant;
  }

  async revokeInstance(
    peer: Pick<MacosRemoteDesktopBootstrapVerifiedPeer, 'uid' | 'auditSessionId' | 'pidVersion'>,
    reason: 'session_exit' | 'shutdown' = 'session_exit',
  ): Promise<boolean> {
    const key = instanceKey(peer.uid, peer.auditSessionId);
    const current = this.active.get(key);
    if (!current
      || current.peer.pidVersion !== peer.pidVersion
      || this.activeByUid.get(peer.uid) !== key) return false;
    await this.revoke({
      uid: current.peer.uid,
      auditSessionId: current.peer.auditSessionId,
      pidVersion: current.peer.pidVersion,
      workerGeneration: current.grant.workerGeneration,
      socketPath: current.grant.socketPath,
      reason,
    });
    this.active.delete(key);
    this.activeByUid.delete(peer.uid);
    return true;
  }

  async shutdown(): Promise<void> {
    for (const current of [...this.active.values()]) {
      await this.revokeInstance(current.peer, 'shutdown');
    }
  }

  isActive(grant: MacosRemoteDesktopBootstrapGrant): boolean {
    const current = this.active.get(instanceKey(grant.uid, grant.auditSessionId));
    return current?.grant === grant
      && sameSecret(current.grant.challenge, grant.challenge)
      && sameSecret(current.grant.instanceNonce, grant.instanceNonce);
  }

  private rememberNonce(nonce: string): void {
    this.consumedNonces.add(nonce);
    this.consumedNonceQueue.push(nonce);
    if (this.consumedNonceQueue.length <= MAX_TRACKED_NONCES) return;
    const oldest = this.consumedNonceQueue.shift();
    if (oldest) this.consumedNonces.delete(oldest);
  }
}

export interface MacosRemoteDesktopGlobalAgentBootstrapListenerOptions {
  socketPath?: string;
  runtimeRoot?: string;
  handshakeTimeoutMs?: number;
  /** Builds the native verifier after the bounded hello supplies expectations. */
  verifyPeer(
    socket: Socket,
    expected: { uid: number; auditSessionId: number },
  ): Promise<MacosRemoteDesktopBootstrapVerifiedPeer>;
  resolveAuthority(
    peer: MacosRemoteDesktopBootstrapVerifiedPeer,
    hello: MacosRemoteDesktopBootstrapHello,
  ): Promise<MacosRemoteDesktopGraphicalSessionAuthority>;
  createLaunch(
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
  ): Promise<MacosRemoteDesktopBootstrapLaunch>;
  /**
   * Receives the exact immutable grant admitted by the ledger. Production
   * readiness must bind to this object rather than reconstructing authority
   * from the earlier launch request. Failure aborts the write and revokes the
   * just-issued instance.
   */
  onGrantIssued?(
    grant: MacosRemoteDesktopBootstrapGrant,
    authority: MacosRemoteDesktopGraphicalSessionAuthority,
  ): void | Promise<void>;
  revoke(revocation: MacosRemoteDesktopBootstrapRevocation): void | Promise<void>;
  /** Test-only filesystem seam; production omission enforces root ownership. */
  prepareSocketPath?(path: string): Promise<void>;
  secureSocketPath?(path: string): Promise<void>;
  onBackgroundError?(error: unknown): void;
}

/**
 * Why the bootstrap socket's directory cannot be trusted, or null if it can.
 *
 * Pure, so the rule can be tested without root. The check it replaces lived
 * inside a function hard-wired to the production path under /var/run, which no
 * test could reach -- and it demanded gid 0, which on macOS is never true for a
 * directory created in root:daemon /var/run. It failed on every real Mac and
 * nothing in the suite could see it.
 */
export function macosBootstrapSocketDirectoryRefusal(stats: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}): string | null {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return 'socket_directory_not_directory';
  // Owner and writability are what matter. The group is not: a group without
  // the write bit grants nothing.
  if (stats.uid !== 0 || (stats.mode & 0o022) !== 0) return 'socket_directory_untrusted';
  return null;
}

async function prepareProductionSocketPath(path: string): Promise<void> {
  if (path !== MACOS_REMOTE_DESKTOP_BOOTSTRAP_SOCKET_PATH || !isAbsolute(path)) {
    fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_LAUNCH, 'socket_path_unexpected');
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const stats = await lstat(directory);
  // Root-owned and writable by nobody else. The GROUP is deliberately not
  // required to be 0: macOS's /var/run is root:daemon, and a directory created
  // inside it inherits that group, so demanding gid 0 made this check fail on
  // every real Mac -- the listener never started and remote desktop could not
  // come up at all. A group with no write bit grants nothing, which is the
  // property this check exists to enforce.
  const refusal = macosBootstrapSocketDirectoryRefusal(stats);
  if (refusal) fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_LAUNCH, refusal);
  try {
    const existing = await lstat(path);
    if (!existing.isSocket() || existing.isSymbolicLink()) {
      fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_LAUNCH, 'socket_path_not_socket');
    }
    const active = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection({ path });
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        probe.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish(true), 250);
      timer.unref?.();
      probe.once('connect', () => {
        clearTimeout(timer);
        finish(true);
      });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        finish(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT');
      });
    });
    if (active) fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_LAUNCH, 'socket_already_listening');
    const current = await lstat(path);
    if (!current.isSocket() || current.isSymbolicLink()
      || current.dev !== existing.dev || current.ino !== existing.ino) {
      fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_LAUNCH, 'socket_replaced_during_probe');
    }
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function secureProductionSocketPath(path: string): Promise<void> {
  await chown(path, 0, 0);
  // The rendezvous is discoverable by every graphical user. It carries no
  // authority: every connection is code/uid/asid verified before a grant.
  await chmod(path, 0o666);
  const stats = await lstat(path);
  if (!stats.isSocket() || stats.isSymbolicLink()
    || stats.uid !== 0 || stats.gid !== 0 || (stats.mode & 0o7777) !== 0o666) {
    fail(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_LAUNCH, 'socket_not_secured');
  }
}

/** Root-daemon listener for the global LaunchAgent's one-shot handshake. */
export class MacosRemoteDesktopGlobalAgentBootstrapListener {
  private readonly ledger: MacosRemoteDesktopGlobalAgentBootstrap;
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;

  constructor(private readonly options: MacosRemoteDesktopGlobalAgentBootstrapListenerOptions) {
    this.ledger = new MacosRemoteDesktopGlobalAgentBootstrap(
      options.revoke,
      options.runtimeRoot,
    );
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('macos_remote_desktop_bootstrap_already_started');
    const socketPath = this.options.socketPath ?? MACOS_REMOTE_DESKTOP_BOOTSTRAP_SOCKET_PATH;
    await (this.options.prepareSocketPath ?? prepareProductionSocketPath)(socketPath);
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      await (this.options.secureSocketPath ?? secureProductionSocketPath)(socketPath);
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await this.ledger.shutdown();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const socketPath = this.options.socketPath ?? MACOS_REMOTE_DESKTOP_BOOTSTRAP_SOCKET_PATH;
    await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(
      new Error(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.HANDSHAKE_TIMEOUT),
    ), this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.sockets.delete(socket);
      socket.removeAllListeners();
      if (error) this.options.onBackgroundError?.(error);
      socket.destroy();
    };
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BOOTSTRAP_FRAME_BYTES) {
        finish(new Error(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_HELLO));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) {
        finish(new Error(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_HELLO));
        return;
      }
      if (!isUtf8(buffer.subarray(0, newline))) {
        finish(new Error(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_HELLO));
        return;
      }
      const line = buffer.subarray(0, newline).toString('utf8');
      void this.handle(socket, line).then(() => {
        settled = true;
        clearTimeout(timer);
        this.sockets.delete(socket);
        socket.end();
      }, finish);
    });
    socket.once('error', finish);
    socket.once('close', () => finish());
  }

  private async handle(socket: Socket, line: string): Promise<void> {
    const hello = decodeMacosRemoteDesktopBootstrapHello(line);
    const peer = await this.options.verifyPeer(socket, {
      uid: hello.uid,
      auditSessionId: hello.auditSessionId,
    });
    const authority = await this.options.resolveAuthority(peer, hello);
    const launch = await this.options.createLaunch(authority);
    const grant = await this.ledger.issueGrant(peer, hello, authority, launch);
    try {
      await this.options.onGrantIssued?.(grant, authority);
      await new Promise<void>((resolve, reject) => {
        socket.write(`${JSON.stringify(grant)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      await this.ledger.revokeInstance(peer, 'session_exit');
      throw error;
    }
  }
}
