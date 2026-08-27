import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import {
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
  validateRemoteDesktopDaemonCommand,
  validateRemoteDesktopDaemonMessage,
  type RemoteDesktopDaemonCommand,
  type RemoteDesktopDaemonMessage,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_WORKER_IPC_VERSION } from '../../shared/remote-desktop-worker.js';
import {
  hasExactRemoteDesktopKeys,
  isRemoteDesktopRecord,
  remoteDesktopUtf8Bytes,
} from '../../shared/remote-desktop-contract-primitives.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY,
  macosRemoteDesktopUserSessionPaths,
} from './macos-user-session.js';
import { assertMacosUserSession, type MacosUserSession } from './user-session-launcher.js';
import {
  validateVirtualDisplayProxyRequest,
  type MacosVirtualDisplayProxyReply,
  type MacosVirtualDisplayProxyRequest,
} from './macos-virtual-display-proxy.js';

export const MACOS_REMOTE_DESKTOP_IPC_MESSAGE = Object.freeze({
  HELLO: 'remote_desktop.macos_ipc.hello',
  HOST_COMMAND: 'remote_desktop.macos_ipc.host_command',
  WORKER_MESSAGE: 'remote_desktop.macos_ipc.worker_message',
  /**
   * Worker asks the daemon a virtual-display question; the daemon answers.
   *
   * A worker never speaks to the resident agent: it asks over this already
   * authenticated socket, and the daemon forwards a request it AUTHORS itself
   * onto the one agent lease. Forwarding the worker's own line would let it name
   * a route generation belonging to another session.
   */
  VIRTUAL_DISPLAY_REQUEST: 'remote_desktop.macos_ipc.virtual_display_request',
  VIRTUAL_DISPLAY_REPLY: 'remote_desktop.macos_ipc.virtual_display_reply',
} as const);

/** Large enough for the bounded SDP contract, but never an unbounded JSON stream. */
export const MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES = REMOTE_DESKTOP_LIMITS.SDP_BYTES + 16 * 1024;
export const MACOS_REMOTE_DESKTOP_RUNTIME_DIRECTORY_MODE = 0o700;
export const MACOS_REMOTE_DESKTOP_SOCKET_MODE = 0o600;

const CHALLENGE_BYTES = 32;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const APPLE_TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const MAX_DESIGNATED_REQUIREMENT_BYTES = 1024;

export interface MacosRemoteDesktopExpectedCodeIdentity {
  bundleIdentifier: typeof MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier;
  teamId: string;
  designatedRequirement: string;
}

/**
 * Evidence produced by the native peer-inspection boundary (getpeereid plus
 * Security.framework SecCode validation), never by fields read from IPC JSON.
 */
export interface MacosRemoteDesktopVerifiedPeerIdentity {
  uid: number;
  bundleIdentifier: string;
  teamId: string;
  designatedRequirement: string;
}

export interface MacosRemoteDesktopFilesystemEntry {
  path: string;
  uid: number;
  mode: number;
  kind: 'directory' | 'socket';
}

export interface MacosRemoteDesktopSocketSecurityEvidence {
  runtimeDirectory: MacosRemoteDesktopFilesystemEntry;
  socket: MacosRemoteDesktopFilesystemEntry;
}

export interface MacosRemoteDesktopIpcLaunch {
  workerGeneration: number;
  challenge: string;
  socketPath: string;
}

export interface MacosRemoteDesktopIpcHello {
  type: typeof MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HELLO;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  workerGeneration: number;
  challenge: string;
}

export interface MacosRemoteDesktopIpcHostCommand {
  type: typeof MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HOST_COMMAND;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  workerGeneration: number;
  command: RemoteDesktopDaemonCommand;
}

export interface MacosRemoteDesktopIpcWorkerMessage {
  type: typeof MACOS_REMOTE_DESKTOP_IPC_MESSAGE.WORKER_MESSAGE;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  workerGeneration: number;
  message: RemoteDesktopDaemonMessage;
}

export interface MacosRemoteDesktopIpcVirtualDisplayRequest {
  type: typeof MACOS_REMOTE_DESKTOP_IPC_MESSAGE.VIRTUAL_DISPLAY_REQUEST;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  workerGeneration: number;
  /** Correlates one reply to one request on an otherwise async stream. */
  requestId: number;
  request: MacosVirtualDisplayProxyRequest;
}

export interface MacosRemoteDesktopIpcVirtualDisplayReply {
  type: typeof MACOS_REMOTE_DESKTOP_IPC_MESSAGE.VIRTUAL_DISPLAY_REPLY;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  workerGeneration: number;
  requestId: number;
  reply: MacosVirtualDisplayProxyReply;
}

export type MacosRemoteDesktopIpcFrame =
  | MacosRemoteDesktopIpcHello
  | MacosRemoteDesktopIpcHostCommand
  | MacosRemoteDesktopIpcWorkerMessage
  | MacosRemoteDesktopIpcVirtualDisplayRequest
  | MacosRemoteDesktopIpcVirtualDisplayReply;

/** Opaque by object identity: a JSON value can never forge an accepted session. */
export interface MacosRemoteDesktopIpcSession {
  readonly workerGeneration: number;
  readonly socketPath: string;
}

interface TrackedRoute {
  requestId: string;
  sessionId: string;
  capability: string;
  daemonGeneration: number;
  routeGeneration: number;
  expiresAt: number;
  leaseExpiresAt: number;
}

export interface MacosRemoteDesktopIpcHostOptions {
  user: MacosUserSession;
  expectedCodeIdentity: MacosRemoteDesktopExpectedCodeIdentity;
  runtimeRoot?: string;
  randomChallenge?: () => Buffer;
}

function fail(code: string): never {
  throw new Error(code);
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validateExpectedCodeIdentity(value: MacosRemoteDesktopExpectedCodeIdentity): void {
  const canonicalRequirement = `identifier "${value.bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${value.teamId}"`;
  if (value.bundleIdentifier !== MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier
    || !APPLE_TEAM_ID_RE.test(value.teamId)
    || canonicalRequirement.length > MAX_DESIGNATED_REQUIREMENT_BYTES
    || value.designatedRequirement !== canonicalRequirement) {
    fail('macos_remote_desktop_ipc_invalid_expected_identity');
  }
}

function matchesCodeIdentity(
  peer: MacosRemoteDesktopVerifiedPeerIdentity,
  expected: MacosRemoteDesktopExpectedCodeIdentity,
): boolean {
  return peer.bundleIdentifier === expected.bundleIdentifier
    && peer.teamId === expected.teamId
    && peer.designatedRequirement === expected.designatedRequirement;
}

function unixMode(mode: number): number {
  return mode & 0o7777;
}

export function validateMacosRemoteDesktopSocketSecurity(
  evidence: MacosRemoteDesktopSocketSecurityEvidence,
  user: MacosUserSession,
  runtimeRoot?: string,
): boolean {
  try {
    assertMacosUserSession(user);
    const paths = macosRemoteDesktopUserSessionPaths(user, runtimeRoot);
    return evidence.runtimeDirectory.kind === 'directory'
      && evidence.runtimeDirectory.path === paths.runtimeDirectory
      && evidence.runtimeDirectory.uid === user.uid
      && unixMode(evidence.runtimeDirectory.mode) === MACOS_REMOTE_DESKTOP_RUNTIME_DIRECTORY_MODE
      && evidence.socket.kind === 'socket'
      && evidence.socket.path === paths.socketPath
      && dirname(evidence.socket.path) === evidence.runtimeDirectory.path
      && evidence.socket.uid === user.uid
      && unixMode(evidence.socket.mode) === MACOS_REMOTE_DESKTOP_SOCKET_MODE;
  } catch {
    return false;
  }
}

export function decodeMacosRemoteDesktopIpcFrame(value: string): unknown {
  if (typeof value !== 'string' || value.length === 0
    || /[\0\r\n]/.test(value)
    || remoteDesktopUtf8Bytes(value) > MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES) {
    fail('macos_remote_desktop_ipc_invalid_frame');
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fail('macos_remote_desktop_ipc_invalid_frame');
  }
}

/**
 * The inverse of the decoder, bounded the same way.
 *
 * Symmetric on purpose: a frame this process emits must be one it would itself
 * accept. Encoding without the bound would let the daemon send something the
 * worker's decoder refuses, which reads on the far side as a corrupt peer.
 */
export function encodeMacosRemoteDesktopIpcFrame(frame: unknown): string {
  const encoded = JSON.stringify(frame);
  if (typeof encoded !== 'string' || encoded.length === 0
    || /[\0\r\n]/.test(encoded)
    || remoteDesktopUtf8Bytes(encoded) > MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES) {
    fail('macos_remote_desktop_ipc_invalid_frame');
  }
  return encoded;
}

function parseHello(value: unknown): MacosRemoteDesktopIpcHello | null {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, [
      'type', 'ipcVersion', 'workerGeneration', 'challenge',
    ])
    || value.type !== MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HELLO
    || value.ipcVersion !== REMOTE_DESKTOP_WORKER_IPC_VERSION
    || !isSafePositiveInteger(value.workerGeneration)
    || typeof value.challenge !== 'string'
    || !CHALLENGE_RE.test(value.challenge)) return null;
  return value as unknown as MacosRemoteDesktopIpcHello;
}

function parseHostCommand(value: unknown): MacosRemoteDesktopIpcHostCommand | null {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, [
      'type', 'ipcVersion', 'workerGeneration', 'command',
    ])
    || value.type !== MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HOST_COMMAND
    || value.ipcVersion !== REMOTE_DESKTOP_WORKER_IPC_VERSION
    || !isSafePositiveInteger(value.workerGeneration)) return null;
  const command = validateRemoteDesktopDaemonCommand(value.command);
  if (!command.ok) return null;
  return { ...value, command: command.value } as MacosRemoteDesktopIpcHostCommand;
}

function parseVirtualDisplayRequest(
  value: unknown,
): MacosRemoteDesktopIpcVirtualDisplayRequest | null {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, [
      'type', 'ipcVersion', 'workerGeneration', 'requestId', 'request',
    ])
    || value.type !== MACOS_REMOTE_DESKTOP_IPC_MESSAGE.VIRTUAL_DISPLAY_REQUEST
    || value.ipcVersion !== REMOTE_DESKTOP_WORKER_IPC_VERSION
    || !isSafePositiveInteger(value.workerGeneration)
    || !isSafePositiveInteger(value.requestId)) return null;
  // The request's own shape is validated where its rules live, so the two
  // cannot drift into disagreeing about what a readiness question may carry.
  const request = validateVirtualDisplayProxyRequest(value.request);
  if (request === null) return null;
  return { ...value, request } as MacosRemoteDesktopIpcVirtualDisplayRequest;
}

function parseWorkerMessage(value: unknown): MacosRemoteDesktopIpcWorkerMessage | null {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, [
      'type', 'ipcVersion', 'workerGeneration', 'message',
    ])
    || value.type !== MACOS_REMOTE_DESKTOP_IPC_MESSAGE.WORKER_MESSAGE
    || value.ipcVersion !== REMOTE_DESKTOP_WORKER_IPC_VERSION
    || !isSafePositiveInteger(value.workerGeneration)) return null;
  const message = validateRemoteDesktopDaemonMessage(value.message);
  if (!message.ok) return null;
  return { ...value, message: message.value } as MacosRemoteDesktopIpcWorkerMessage;
}

function routeMatches(
  value: Pick<RemoteDesktopDaemonCommand | RemoteDesktopDaemonMessage, 'requestId' | 'sessionId' | 'capability'>,
  route: TrackedRoute,
): boolean {
  return value.requestId === route.requestId
    && value.sessionId === route.sessionId
    && equalSecret(value.capability, route.capability);
}

/**
 * Host-side authorization state for one active GUI user. This class does not
 * inspect code signatures itself: callers must provide peer evidence obtained
 * from the native Darwin socket/Security.framework boundary, never wire JSON.
 */
export class MacosRemoteDesktopIpcAuthorityHost {
  private workerGeneration = 0;
  private activeLaunch: MacosRemoteDesktopIpcLaunch | null = null;
  private activeSession: MacosRemoteDesktopIpcSession | null = null;
  private readonly routes = new Map<string, TrackedRoute>();
  private readonly randomChallenge: () => Buffer;

  constructor(private readonly options: MacosRemoteDesktopIpcHostOptions) {
    assertMacosUserSession(options.user);
    validateExpectedCodeIdentity(options.expectedCodeIdentity);
    this.randomChallenge = options.randomChallenge ?? (() => randomBytes(CHALLENGE_BYTES));
  }

  beginLaunch(): MacosRemoteDesktopIpcLaunch {
    this.cleanup();
    const challengeBytes = this.randomChallenge();
    if (!Buffer.isBuffer(challengeBytes) || challengeBytes.length !== CHALLENGE_BYTES) {
      fail('macos_remote_desktop_ipc_invalid_challenge_source');
    }
    const paths = macosRemoteDesktopUserSessionPaths(this.options.user, this.options.runtimeRoot);
    const launch = Object.freeze({
      workerGeneration: this.workerGeneration,
      challenge: challengeBytes.toString('base64url'),
      socketPath: paths.socketPath,
    });
    this.activeLaunch = launch;
    return launch;
  }

  authenticate(
    frame: string,
    peer: MacosRemoteDesktopVerifiedPeerIdentity,
    filesystem: MacosRemoteDesktopSocketSecurityEvidence,
  ): MacosRemoteDesktopIpcSession {
    const launch = this.activeLaunch;
    const hello = parseHello(decodeMacosRemoteDesktopIpcFrame(frame));
    if (!launch || !hello
      || this.activeSession !== null
      || peer.uid !== this.options.user.uid
      || !matchesCodeIdentity(peer, this.options.expectedCodeIdentity)
      || !validateMacosRemoteDesktopSocketSecurity(
        filesystem,
        this.options.user,
        this.options.runtimeRoot,
      )
      || hello.workerGeneration !== launch.workerGeneration
      || !equalSecret(hello.challenge, launch.challenge)) {
      fail('macos_remote_desktop_ipc_authentication_failed');
    }
    const session = Object.freeze({
      workerGeneration: launch.workerGeneration,
      socketPath: launch.socketPath,
    });
    this.activeSession = session;
    return session;
  }

  acceptHostFrame(
    session: MacosRemoteDesktopIpcSession,
    frame: string,
    now = Date.now(),
  ): RemoteDesktopDaemonCommand {
    this.assertActiveSession(session);
    const envelope = parseHostCommand(decodeMacosRemoteDesktopIpcFrame(frame));
    if (!envelope || envelope.workerGeneration !== session.workerGeneration) {
      fail('macos_remote_desktop_ipc_invalid_host_frame');
    }
    const command = envelope.command;
    if (command.type === REMOTE_DESKTOP_MSG.PREPARE) {
      this.authorizeRoute(command, now);
      return command;
    }
    const route = this.routes.get(command.sessionId);
    if (!route || !routeMatches(command, route)
      || route.expiresAt <= now || route.leaseExpiresAt <= now) {
      fail('macos_remote_desktop_ipc_route_authority_rejected');
    }
    if (command.type === REMOTE_DESKTOP_MSG.LEASE) {
      if (command.daemonGeneration !== route.daemonGeneration
        || command.routeGeneration !== route.routeGeneration
        || command.leaseExpiresAt <= now
        || command.leaseExpiresAt > route.expiresAt
        || command.leaseExpiresAt - now > REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS) {
        fail('macos_remote_desktop_ipc_route_authority_rejected');
      }
      route.leaseExpiresAt = command.leaseExpiresAt;
    }
    if (command.type === REMOTE_DESKTOP_MSG.STOP
      || command.type === REMOTE_DESKTOP_MSG.CANCEL) {
      this.routes.delete(command.sessionId);
    }
    return command;
  }

  /**
   * Accepts one virtual-display question from the authenticated worker.
   *
   * Returns the request together with the generation the daemon AUTHENTICATED,
   * which is what the control line will be built from. Whatever generation the
   * frame carried is checked for agreement and then never used again.
   */
  acceptVirtualDisplayRequest(
    session: MacosRemoteDesktopIpcSession,
    frame: string,
  ): { requestId: number; request: MacosVirtualDisplayProxyRequest;
       routeGeneration: number } {
    this.assertActiveSession(session);
    const envelope = parseVirtualDisplayRequest(
      decodeMacosRemoteDesktopIpcFrame(frame),
    );
    if (!envelope || envelope.workerGeneration !== session.workerGeneration) {
      fail('macos_remote_desktop_ipc_invalid_worker_frame');
    }
    return {
      requestId: envelope.requestId,
      request: envelope.request,
      routeGeneration: session.workerGeneration,
    };
  }

  encodeVirtualDisplayReply(
    session: MacosRemoteDesktopIpcSession,
    requestId: number,
    reply: MacosVirtualDisplayProxyReply,
  ): string {
    this.assertActiveSession(session);
    return encodeMacosRemoteDesktopIpcFrame({
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.VIRTUAL_DISPLAY_REPLY,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      workerGeneration: session.workerGeneration,
      requestId,
      reply,
    });
  }

  acceptWorkerFrame(
    session: MacosRemoteDesktopIpcSession,
    frame: string,
    now = Date.now(),
  ): RemoteDesktopDaemonMessage {
    this.assertActiveSession(session);
    const envelope = parseWorkerMessage(decodeMacosRemoteDesktopIpcFrame(frame));
    if (!envelope || envelope.workerGeneration !== session.workerGeneration) {
      fail('macos_remote_desktop_ipc_invalid_worker_frame');
    }
    const message = envelope.message;
    const route = this.routes.get(message.sessionId);
    if (!route || !routeMatches(message, route)
      || route.expiresAt <= now || route.leaseExpiresAt <= now) {
      fail('macos_remote_desktop_ipc_route_authority_rejected');
    }
    if (message.type === REMOTE_DESKTOP_MSG.TERMINAL) {
      this.routes.delete(message.sessionId);
    }
    return message;
  }

  cleanup(): void {
    this.workerGeneration += 1;
    this.activeLaunch = null;
    this.activeSession = null;
    this.routes.clear();
  }

  private assertActiveSession(session: MacosRemoteDesktopIpcSession): void {
    if (this.activeSession !== session
      || session.workerGeneration !== this.workerGeneration) {
      fail('macos_remote_desktop_ipc_stale_session');
    }
  }

  private authorizeRoute(command: RemoteDesktopPrepare, now: number): void {
    if (command.expiresAt <= now
      || command.leaseExpiresAt <= now
      || command.expiresAt - now > REMOTE_DESKTOP_LIMITS.ABSOLUTE_LIFETIME_MS
      || command.leaseExpiresAt - now > REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS
      || command.routeGeneration === undefined
      || this.routes.has(command.sessionId)) {
      fail('macos_remote_desktop_ipc_route_authority_rejected');
    }
    this.routes.set(command.sessionId, {
      requestId: command.requestId,
      sessionId: command.sessionId,
      capability: command.capability,
      daemonGeneration: command.daemonGeneration,
      routeGeneration: command.routeGeneration,
      expiresAt: command.expiresAt,
      leaseExpiresAt: command.leaseExpiresAt,
    });
  }
}
