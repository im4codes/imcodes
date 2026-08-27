/**
 * The root daemon's half of the virtual-display authority channel.
 *
 * DIRECTION. This process listens; the console-session LaunchAgent dials. That
 * is deliberate and it is the whole trust story: only root can place an object
 * in a directory no non-root principal can write, so a rendezvous the agent
 * created could have been created by anything running as that user and would
 * prove nothing about who answered.
 *
 * THE TWO DIRECTIONS ARE PROVEN DIFFERENTLY, BECAUSE THEY CAN BE.
 *
 *   agent proves this daemon  ->  kernel peer euid is 0, and the socket and
 *                                 every ancestor is root-owned, not a symlink
 *                                 and not writable by group or other.
 *   this daemon proves agent  ->  audit token plus the EXACT designated
 *                                 requirement, team and bundle of the selected
 *                                 artifact, plus uid and audit session.
 *
 * Code signing is not used in the agent's direction: this daemon is the Node
 * binary, which on macOS is ad-hoc signed by the build, and demanding a
 * Developer ID identity there would refuse every existing and development
 * install permanently. Root ownership of the path is the property that is both
 * available and meaningful.
 *
 * NOTHING SECRET IS EVER WRITTEN DOWN. The challenge is minted from the CSPRNG
 * only AFTER the agent has been authenticated, is sent only on that
 * authenticated connection, and never reaches a plist, an environment, an argv
 * or a log line. A secret that can be read is a secret that authenticates
 * nobody.
 *
 * THE CONNECTION IS THE LEASE. Authority lasts exactly as long as the socket
 * does. EOF or HUP revokes, terminally: a new daemon must perform a new
 * generation handshake rather than inherit an authority it never granted.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync, chownSync, lstatSync, mkdirSync, unlinkSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import type {
  MacosRemoteDesktopNativePeerVerificationSeams,
} from './macos-remote-desktop-peer-verifier.js';

/**
 * Mirrors kVirtualDisplayAuthorityDirectory / SocketPath in
 * native/macos-remote-desktop/macos_virtual_display_authority_link.h.
 *
 * NOT under /private/var/run, which is the obvious choice and is wrong: on
 * stock macOS that directory is `drwxrwxr-x root:daemon`, i.e. group-writable,
 * and the rule that makes root ownership mean anything would refuse it on every
 * real machine.
 */
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_DIRECTORY =
  '/private/var/db/imcodes-node/runtime' as const;
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH =
  `${MACOS_VIRTUAL_DISPLAY_AUTHORITY_DIRECTORY}/virtual-display-authority.sock` as const;

/**
 * 0o711, not 0o700.
 *
 * connect(2) needs SEARCH permission on every component, so a 0700 chain is
 * unreachable by the console-uid agent and fails with EACCES -- which is
 * indistinguishable from "the daemon is not running", i.e. a silent permanent
 * outage. Removing other's `x` buys nothing against substitution: replacing the
 * socket requires WRITE on the directory, which 0711 still denies. Same
 * security property, actually reachable.
 */
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_DIRECTORY_MODE = 0o711 as const;
/** 0o622: root reads and writes; everyone else may only CONNECT. */
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_MODE = 0o622 as const;

/** Challenge lifetime. A launch capability, not a session credential. */
export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_LIFETIME_MS = 60_000 as const;

export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR = Object.freeze({
  NOT_ROOT: 'macos_virtual_display_authority_not_root',
  CHAIN_UNSAFE: 'macos_virtual_display_authority_chain_unsafe',
  BIND_FAILED: 'macos_virtual_display_authority_bind_failed',
});

/** Group-write and other-write: the bits that let someone else REPLACE. */
const WRITABLE_BY_OTHERS = 0o022;
const ROOT_UID = 0;

export interface MacosVirtualDisplayAuthorityLease {
  readonly socket: Socket;
  readonly challenge: string;
  readonly serviceGeneration: number;
  readonly auditSessionId: number;
  readonly uid: number;
  /**
   * How long the challenge may be answered for, in milliseconds.
   *
   * A duration, because the agent measures it on its own monotonic clock. This
   * process's epoch instant means nothing there.
   */
  readonly ttlMs: number;
}

export interface MacosVirtualDisplayAuthorityListenerSeams {
  /** Verifies the connected agent. Rejecting throws. */
  readonly verification: MacosRemoteDesktopNativePeerVerificationSeams;
  /** Monotonically increasing across daemon restarts. Never reused. */
  readonly nextServiceGeneration: () => number;
  /**
   * Injected ONLY so a test can observe when the secret comes into existence.
   *
   * The ordering rule -- nothing is minted until the peer is authenticated --
   * cannot be pinned by watching the generation counter instead: a mutation
   * that minted a challenge early and threw it away left that assertion green.
   */
  readonly mintChallenge?: () => string;
  /** Injected only so the filesystem rules are provable offline. */
  readonly inspect?: (path: string) => {
    uid: number; mode: number; isSymbolicLink: boolean; isDirectory: boolean;
  } | null;
}

export interface MacosVirtualDisplayAuthorityListenerOptions {
  readonly socketPath?: string;
  /** Called once per authenticated agent. Its returned lease is live. */
  readonly onLease: (lease: MacosVirtualDisplayAuthorityLease) => void;
  /** Called when a lease's connection ends. Authority is over. */
  readonly onLeaseEnded: (lease: MacosVirtualDisplayAuthorityLease) => void;
}

function fail(reason: string): never {
  // The reason names WHICH rule refused, never what any secret was.
  throw new Error(reason);
}

/**
 * Every ancestor of `path`, from `/` down, then `path` itself.
 *
 * Walked explicitly rather than trusting the leaf, because a writable directory
 * ANYWHERE above the socket is a directory in which the socket can be replaced.
 */
export function authorityAncestors(path: string): string[] {
  const chain: string[] = [];
  let current = path;
  for (;;) {
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

/**
 * Refuses unless every component is root-owned, not a symlink, and not
 * group- or world-writable.
 *
 * Directories must ALSO grant search to other, or the console-uid agent cannot
 * traverse to the socket -- and that failure is an EACCES that reads exactly
 * like "the daemon is not running".
 */
export function assertAuthorityChainSafe(
  path: string,
  inspect: NonNullable<MacosVirtualDisplayAuthorityListenerSeams['inspect']>,
): void {
  const chain = authorityAncestors(path);
  for (const [index, component] of chain.entries()) {
    const facts = inspect(component);
    if (facts === null) fail(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
    // lstat, never stat: a symlink anywhere means the object the kernel
    // resolves is not the object that was checked.
    if (facts.isSymbolicLink) fail(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
    if (facts.uid !== ROOT_UID) fail(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
    const isLeaf = index === chain.length - 1;
    if (isLeaf) continue;
    if (!facts.isDirectory) fail(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
    if ((facts.mode & WRITABLE_BY_OTHERS) !== 0)
      fail(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
    if ((facts.mode & 0o001) === 0)
      fail(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
  }
}

function defaultInspect(path: string) {
  try {
    const facts = lstatSync(path);
    return {
      uid: facts.uid,
      mode: facts.mode & 0o7777,
      isSymbolicLink: facts.isSymbolicLink(),
      isDirectory: facts.isDirectory(),
    };
  } catch {
    return null;
  }
}

/**
 * Creates the runtime directory chain, EXPLICITLY owned and moded.
 *
 * Explicitly, not through umask: umask can only remove bits, so an inherited
 * permissive umask leaves the object wider than intended and an inherited
 * restrictive one leaves it unreachable. Neither failure is visible where it is
 * caused. (Measured: bind() applies the umask, so a socket created under
 * umask 0077 comes out with no `other` bits at all.)
 */
function ensureAuthorityDirectory(socketPath: string): void {
  const directory = dirname(socketPath);
  for (const component of [dirname(directory), directory]) {
    mkdirSync(component, { recursive: true, mode: MACOS_VIRTUAL_DISPLAY_AUTHORITY_DIRECTORY_MODE });
    chownSync(component, ROOT_UID, ROOT_UID);
    chmodSync(component, MACOS_VIRTUAL_DISPLAY_AUTHORITY_DIRECTORY_MODE);
  }
}

/** 43 characters of base64url, matching the native challenge grammar. */
function mintChallenge(): string {
  // CSPRNG, and minted only after the peer is authenticated. A challenge
  // generated before authentication is a secret handed to whoever connected.
  return randomBytes(32).toString('base64url').slice(0, 43);
}

export function serializeAuthorityChallenge(lease: {
  challenge: string; serviceGeneration: number; auditSessionId: number;
  ttlMs: number;
}): string {
  // Mirrors ParseVirtualDisplayAuthorityChallenge; key order is part of the
  // canonical form the native parser re-serialises and compares.
  // A TTL, not an absolute deadline: the agent compares against
  // CLOCK_MONOTONIC, so an epoch instant from this process was never
  // comparable there and the freshness check could never fire.
  return `chal1 challenge=${lease.challenge} svcgen=${lease.serviceGeneration}`
    + ` asid=${lease.auditSessionId} ttl=${lease.ttlMs}`;
}

export interface MacosVirtualDisplayAuthorityListener {
  readonly server: Server;
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Everything that happens to ONE connected agent.
 *
 * Exported so the ordering rules are provable without root and without a
 * socket: that authentication strictly precedes minting, that a refused peer
 * never causes a challenge to exist at all, and that the connection's end is
 * the authority's end.
 */
export async function handleAuthorityConnection(
  socket: Socket,
  options: MacosVirtualDisplayAuthorityListenerOptions,
  seams: MacosVirtualDisplayAuthorityListenerSeams,
): Promise<void> {
  let lease: MacosVirtualDisplayAuthorityLease | null = null;
  try {
    // AUTHENTICATE FIRST, ALWAYS.
    //
    // Nothing is minted, nothing is sent and nothing is remembered until the
    // agent's audit token, exact designated requirement, team, bundle, uid and
    // audit session have all been checked. A challenge generated before this
    // point would be a secret handed to whoever connected.
    // `verifyPeer` is optional on the seam because narrow test seams implement
    // only the worker-socket methods. Absent means nobody can establish the
    // agent's audit session, and admitting a peer we could not fully check is
    // worse than refusing to lease at all.
    if (typeof seams.verification.verifyPeer !== 'function') {
      socket.destroy();
      return;
    }
    const peer = await seams.verification.verifyPeer(socket);
    if (!Number.isSafeInteger(peer.auditSessionId) || peer.auditSessionId <= 0
      || !Number.isSafeInteger(peer.uid) || peer.uid <= 0) {
      socket.destroy();
      return;
    }

    lease = Object.freeze({
      socket,
      challenge: (seams.mintChallenge ?? mintChallenge)(),
      serviceGeneration: seams.nextServiceGeneration(),
      auditSessionId: peer.auditSessionId,
      uid: peer.uid,
      ttlMs: MACOS_VIRTUAL_DISPLAY_AUTHORITY_LIFETIME_MS,
    });
    socket.write(`${serializeAuthorityChallenge(lease)}\n`);
    options.onLease(lease);
  } catch {
    // Any failure at all -- unverifiable peer, wrong identity, wrong session --
    // drops the connection without a challenge ever existing.
    socket.destroy();
    return;
  }
  const end = () => {
    if (lease === null) return;
    const ended = lease;
    lease = null;
    // TERMINAL. A new daemon must perform a new generation handshake rather
    // than inherit an authority it never granted.
    options.onLeaseEnded(ended);
  };
  socket.on('close', end);
  socket.on('end', end);
  socket.on('error', end);
}

export async function startMacosVirtualDisplayAuthorityListener(
  options: MacosVirtualDisplayAuthorityListenerOptions,
  seams: MacosVirtualDisplayAuthorityListenerSeams,
): Promise<MacosVirtualDisplayAuthorityListener> {
  // Root is the trust root. A non-root daemon could not create a rendezvous
  // the agent would accept, so this refuses here rather than producing one
  // that is silently never usable.
  if (typeof process.getuid !== 'function' || process.getuid() !== ROOT_UID)
    fail(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.NOT_ROOT);

  const socketPath = options.socketPath ?? MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH;
  const inspect = seams.inspect ?? defaultInspect;

  ensureAuthorityDirectory(socketPath);
  // Only this daemon ever unlinks. The agent must never remove or recreate the
  // rendezvous -- if it could, it could substitute one.
  try { unlinkSync(socketPath); } catch { /* absent is the normal case */ }

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  try {
    chownSync(socketPath, ROOT_UID, ROOT_UID);
    chmodSync(socketPath, MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_MODE);
    // Verified AFTER creation, so what is checked is what exists rather than
    // what was intended.
    assertAuthorityChainSafe(socketPath, inspect);
  } catch (error) {
    server.close();
    try { unlinkSync(socketPath); } catch { /* best effort */ }
    throw error;
  }

  server.on('connection', (socket: Socket) => {
    void handleAuthorityConnection(socket, options, seams);
  });

  return Object.freeze({
    server,
    socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      try { unlinkSync(socketPath); } catch { /* best effort */ }
    },
  });
}
