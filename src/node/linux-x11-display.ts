import { readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

/**
 * Which X servers on this box can the controlled node's root worker actually
 * open?
 *
 * A socket in /tmp/.X11-unix is not a usable display. On a stock desktop
 * Ubuntu (GNOME on Wayland) the only sockets belong to the login greeter's or
 * the user's Xwayland, which reject a client without their auth cookie, and
 * the real screen is not reachable over X11 at all. Treating "a socket exists"
 * as "there is a display" sends the worker to a display it can never open
 * (the session sits in its first connecting step) and stops the node from
 * offering to set up a virtual desktop that would work.
 */
export const X11_SOCKET_DIR = '/tmp/.X11-unix';
const X11_SOCKET_NAME_PATTERN = /^X(\d+)$/;
const PROBE_TIMEOUT_MS = 1500;
/** A cached answer is reused this long; the node re-probes on its next refresh. */
export const X11_DISPLAY_CACHE_TTL_MS = 15_000;

export const X11_DISPLAY_ACCESS = {
  ACCESSIBLE: 'accessible',
  AUTH_REQUIRED: 'auth_required',
  UNREACHABLE: 'unreachable',
} as const;
export type X11DisplayAccess = typeof X11_DISPLAY_ACCESS[keyof typeof X11_DISPLAY_ACCESS];

/** X11 connection setup request: little-endian, protocol 11.0, no authorization. */
const X11_SETUP_REQUEST = Buffer.from([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const X11_SETUP_REPLY = { FAILED: 0, SUCCESS: 1, AUTHENTICATE: 2 } as const;

export function listX11DisplayNumbers(socketDir: string = X11_SOCKET_DIR): number[] {
  let entries: string[];
  try {
    entries = readdirSync(socketDir);
  } catch {
    return [];
  }
  return entries
    .map((name) => X11_SOCKET_NAME_PATTERN.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .sort((a, b) => a - b);
}

/**
 * Attempt the X11 connection handshake without credentials. A server that
 * accepts it is usable by the worker as it is spawned (no cookie, no xhost);
 * one that answers "failed"/"authenticate" is not.
 */
export function probeX11Display(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<X11DisplayAccess> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(socketPath);
    const finish = (result: X11DisplayAccess): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(X11_DISPLAY_ACCESS.UNREACHABLE), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => socket.write(X11_SETUP_REQUEST));
    socket.once('data', (chunk: Buffer) => {
      finish(chunk[0] === X11_SETUP_REPLY.SUCCESS
        ? X11_DISPLAY_ACCESS.ACCESSIBLE
        : X11_DISPLAY_ACCESS.AUTH_REQUIRED);
    });
    socket.once('error', () => finish(X11_DISPLAY_ACCESS.UNREACHABLE));
    socket.once('close', () => finish(X11_DISPLAY_ACCESS.UNREACHABLE));
  });
}

interface X11DisplaySnapshot {
  socketDir: string;
  at: number;
  all: readonly number[];
  accessible: readonly number[];
}

let snapshot: X11DisplaySnapshot | null = null;
let inFlight: Promise<boolean> | null = null;

/**
 * Re-probe every display socket. Resolves true when the set of accessible
 * displays changed (so a caller can re-publish capabilities).
 */
export function refreshX11DisplayProbe(
  socketDir: string = X11_SOCKET_DIR,
  probe: (socketPath: string) => Promise<X11DisplayAccess> = probeX11Display,
  now: () => number = Date.now,
): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const all = listX11DisplayNumbers(socketDir);
    const results = await Promise.all(all.map(async (number) => (
      [number, await probe(join(socketDir, `X${number}`))] as const
    )));
    const accessible = results
      .filter(([, access]) => access === X11_DISPLAY_ACCESS.ACCESSIBLE)
      .map(([number]) => number);
    const previous = snapshot?.socketDir === socketDir ? snapshot.accessible : undefined;
    snapshot = { socketDir, at: now(), all, accessible };
    return previous === undefined
      || previous.length !== accessible.length
      || previous.some((value, index) => value !== accessible[index]);
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** The accessible display numbers from the last probe of `socketDir`; undefined until probed. */
export function accessibleX11DisplayNumbers(socketDir: string = X11_SOCKET_DIR): readonly number[] | undefined {
  return snapshot?.socketDir === socketDir ? snapshot.accessible : undefined;
}

export function x11DisplayProbeIsStale(
  socketDir: string = X11_SOCKET_DIR,
  now: number = Date.now(),
): boolean {
  return !snapshot || snapshot.socketDir !== socketDir || now - snapshot.at >= X11_DISPLAY_CACHE_TTL_MS;
}

export function resetX11DisplayProbeForTests(): void {
  snapshot = null;
  inFlight = null;
}
