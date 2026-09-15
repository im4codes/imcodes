import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { REMOTE_DESKTOP_MACOS_TEAM_ID } from '../../shared/remote-desktop-worker.js';
import type { MacosRemoteDesktopExpectedCodeIdentity } from './macos-remote-desktop-ipc.js';
import type { MacosRemoteDesktopVerifiedCodeIdentity } from './macos-remote-desktop-ipc-server.js';
import type { MacosRemoteDesktopGraphicalSessionType } from './macos-remote-desktop-global-agent-bootstrap.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024;
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const MAX_REQUIREMENT_BYTES = 1024;

export interface MacosRemoteDesktopVerifiedNativePeer
  extends MacosRemoteDesktopVerifiedCodeIdentity {
  uid: number;
  /**
   * Audit session the peer is in.
   *
   * Carried because uid alone cannot tell two successive login windows of the
   * same user apart, so a capability bound only to uid survives a logout and
   * silently applies to the next session.
   */
  auditSessionId: number;
  /**
   * Process-id VERSION, which is what makes a pid an identity: pids are
   * reused, and on a busy machine that is a matter of time.
   */
  pidVersion: number;
  /** Native window-server classification in the authenticated audit session. */
  sessionType: MacosRemoteDesktopGraphicalSessionType;
}

export interface MacosRemoteDesktopNativePeerVerifierOptions {
  executablePath: string;
  expectedUid: number;
  /** When set, the peer must be in THIS audit session. Omit to accept any. */
  expectedAuditSessionId?: number;
  expectedCodeIdentity: MacosRemoteDesktopExpectedCodeIdentity;
  timeoutMs?: number;
}

export interface MacosRemoteDesktopNativePeerVerificationSeams {
  inspectPeerUid(socket: Socket): Promise<number>;
  verifyPeerCodeIdentity(
    socket: Socket,
    expected: MacosRemoteDesktopExpectedCodeIdentity,
  ): Promise<MacosRemoteDesktopVerifiedCodeIdentity>;
  /**
   * The WHOLE verified peer, including the audit session and pid version.
   *
   * `verifyPeerCodeIdentity` deliberately returns only the code identity,
   * because that is all its existing caller may act on. A caller that binds a
   * capability to a session needs the session too, and getting it by casting
   * the narrower result would be reading a field the type says is not there.
   * Both go through the same single verification per socket.
   *
   * OPTIONAL because narrow test seams legitimately implement only the two
   * worker-socket methods. A consumer that needs the audit session must refuse
   * when it is absent rather than proceeding -- admitting a peer nobody fully
   * checked is worse than refusing to start.
   */
  verifyPeer?(socket: Socket): Promise<MacosRemoteDesktopVerifiedNativePeer>;
}

function fail(): never {
  throw new Error('macos_remote_desktop_native_peer_verification_failed');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sameExpectedIdentity(
  left: MacosRemoteDesktopExpectedCodeIdentity,
  right: MacosRemoteDesktopExpectedCodeIdentity,
): boolean {
  return left.bundleIdentifier === right.bundleIdentifier
    && left.teamId === right.teamId
    && left.designatedRequirement === right.designatedRequirement;
}

function validateOptions(options: MacosRemoteDesktopNativePeerVerifierOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (process.platform !== 'darwin'
    || !isAbsolute(options.executablePath)
    || !Number.isSafeInteger(options.expectedUid)
    || options.expectedUid <= 0
    || (options.expectedAuditSessionId !== undefined
      && (!Number.isSafeInteger(options.expectedAuditSessionId)
        || options.expectedAuditSessionId <= 0))
    || !BUNDLE_ID_RE.test(options.expectedCodeIdentity.bundleIdentifier)
    // NOT a shape check. The expectation reaches here derived from the
    // artifact manifest, which travels with the artifact and is therefore
    // attacker-reachable. Accepting any well-formed ten-character team id let
    // a component set signed by a foreign Apple team declare its own team,
    // derive a matching designated requirement, and then satisfy every
    // downstream comparison against itself. Pinning to the shipped team makes
    // the bar independent of the file being judged.
    || options.expectedCodeIdentity.teamId !== REMOTE_DESKTOP_MACOS_TEAM_ID
    || byteLength(options.expectedCodeIdentity.designatedRequirement) === 0
    || byteLength(options.expectedCodeIdentity.designatedRequirement) > MAX_REQUIREMENT_BYTES
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_TIMEOUT_MS
    || timeoutMs > MAX_TIMEOUT_MS) fail();
  return timeoutMs;
}

function parseVerifiedPeer(
  encoded: string,
  options: MacosRemoteDesktopNativePeerVerifierOptions,
): MacosRemoteDesktopVerifiedNativePeer {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return fail();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 8
    || record.version !== 1
    || !Number.isSafeInteger(record.uid)
    || record.uid !== options.expectedUid
    // Zero is what the kernel reports for "no audit session", and nothing can
    // be bound to that -- a capability that cannot be bound to a session is one
    // that outlives the session.
    || !Number.isSafeInteger(record.auditSessionId)
    || (record.auditSessionId as number) <= 0
    || !Number.isSafeInteger(record.pidVersion)
    || (record.pidVersion as number) <= 0
    || (record.sessionType !== 'Aqua' && record.sessionType !== 'LoginWindow')
    || (options.expectedAuditSessionId !== undefined
      && record.auditSessionId !== options.expectedAuditSessionId)
    || record.bundleIdentifier !== options.expectedCodeIdentity.bundleIdentifier
    || record.teamId !== options.expectedCodeIdentity.teamId
    // Restated against the pinned value rather than only against the
    // expectation. `validateOptions` already refuses a foreign expectation, so
    // this cannot fire today -- it is here so that a future caller who
    // constructs options by some other path cannot reintroduce the hole
    // silently. The peer's team is compared to what the product ships under,
    // never merely to what someone asked for.
    || record.teamId !== REMOTE_DESKTOP_MACOS_TEAM_ID
    || record.designatedRequirement !== options.expectedCodeIdentity.designatedRequirement) fail();
  return Object.freeze({
    uid: record.uid as number,
    auditSessionId: record.auditSessionId as number,
    pidVersion: record.pidVersion as number,
    sessionType: record.sessionType as MacosRemoteDesktopGraphicalSessionType,
    bundleIdentifier: record.bundleIdentifier as string,
    teamId: record.teamId as string,
    designatedRequirement: record.designatedRequirement as string,
  });
}

async function verifyNativePeer(
  socket: Socket,
  options: MacosRemoteDesktopNativePeerVerifierOptions,
  timeoutMs: number,
): Promise<MacosRemoteDesktopVerifiedNativePeer> {
  if (socket.destroyed || socket.connecting) fail();
  return await new Promise((resolve, reject) => {
    const child = spawn(options.executablePath, [
      '--imcodes-verify-peer-v1',
      '--socket-fd=3',
      `--expected-uid=${options.expectedUid}`,
      ...(options.expectedAuditSessionId === undefined
        ? []
        : [`--expected-audit-session-id=${options.expectedAuditSessionId}`]),
      `--bundle-id=${options.expectedCodeIdentity.bundleIdentifier}`,
      `--team-id=${options.expectedCodeIdentity.teamId}`,
      `--designated-requirement=${options.expectedCodeIdentity.designatedRequirement}`,
    ], {
      env: {},
      stdio: ['ignore', 'pipe', 'pipe', socket],
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: unknown, value?: MacosRemoteDesktopVerifiedNativePeer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      if (error || !value) reject(new Error('macos_remote_desktop_native_peer_verification_failed'));
      else resolve(value);
    };
    const overflow = () => {
      child.kill('SIGKILL');
      finish(new Error('macos_remote_desktop_native_peer_verification_failed'));
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_OUTPUT_BYTES) overflow();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) overflow();
    });
    child.once('error', finish);
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(new Error('macos_remote_desktop_native_peer_verification_failed'));
        return;
      }
      try {
        finish(undefined, parseVerifiedPeer(stdout.toString('utf8').trim(), options));
      } catch (error) {
        finish(error);
      }
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('macos_remote_desktop_native_peer_verification_failed'));
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Creates the two IPC-server seams from one native verification. The accepted
 * net.Socket is passed through child_process' documented stdio Stream support
 * as descriptor 3; no private socket internals or native Node addon is used.
 */
export function createMacosRemoteDesktopNativePeerVerificationSeams(
  options: MacosRemoteDesktopNativePeerVerifierOptions,
): MacosRemoteDesktopNativePeerVerificationSeams {
  const timeoutMs = validateOptions(options);
  const pending = new WeakMap<Socket, Promise<MacosRemoteDesktopVerifiedNativePeer>>();
  const inspect = (socket: Socket) => {
    const existing = pending.get(socket);
    if (existing) return existing;
    const operation = verifyNativePeer(socket, options, timeoutMs);
    pending.set(socket, operation);
    return operation;
  };
  return Object.freeze({
    async inspectPeerUid(socket: Socket): Promise<number> {
      return (await inspect(socket)).uid;
    },
    async verifyPeer(socket: Socket): Promise<MacosRemoteDesktopVerifiedNativePeer> {
      return await inspect(socket);
    },
    async verifyPeerCodeIdentity(
      socket: Socket,
      expected: MacosRemoteDesktopExpectedCodeIdentity,
    ): Promise<MacosRemoteDesktopVerifiedCodeIdentity> {
      if (!sameExpectedIdentity(expected, options.expectedCodeIdentity)) fail();
      const verified = await inspect(socket);
      // The audit session and pid generation travel with the identity rather
      // than being dropped here. The server binds display authority to them,
      // and a uid plus a code identity cannot tell a relaunched peer from the
      // live one.
      return {
        bundleIdentifier: verified.bundleIdentifier,
        teamId: verified.teamId,
        designatedRequirement: verified.designatedRequirement,
        auditSessionId: verified.auditSessionId,
        pidVersion: verified.pidVersion,
      };
    },
  });
}
