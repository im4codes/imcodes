/**
 * The bridge between a user-level daemon and a LocalSystem helper that can
 * follow Windows onto the sign-in and lock desktops.
 *
 * A daemon runs as the interactive user and can only start the worker in its own
 * session, which leaves the secure desktop out of reach — the same limitation
 * every remote-control tool has before you let its installer register a
 * privileged service. Enabling this feature registers such a helper once, behind
 * a UAC prompt, and the daemon then relays the signalling it already receives to
 * that helper instead of starting a worker itself.
 *
 * What crosses this pipe is exactly what already crosses the daemon/server
 * boundary — validated remote-desktop envelopes — so the helper applies the same
 * authority, lease and input-epoch checks the controlled node does. Media, input
 * and the daemon's server credential never travel here.
 */

/**
 * Advertised once the elevated helper is installed and answering. Distinct from
 * the plain remote-desktop capability: it is what tells the browser this machine
 * can be controlled at the sign-in screen, not merely once someone has logged in.
 */
export const REMOTE_DESKTOP_ELEVATED_CAPABILITY = 'remote.desktop.windows.elevated.v1' as const;

/** Fixed, per-machine. The ACL — not obscurity — is what limits who may connect. */
export const REMOTE_DESKTOP_ELEVATED_PIPE = '\\\\.\\pipe\\imcodes-remote-desktop-elevated' as const;

export const REMOTE_DESKTOP_ELEVATED_MSG = {
  /** Daemon → helper, first line: proves the sender read the secret. */
  HELLO: 'remote_desktop.elevated_hello',
  /** Helper → daemon: the hello was accepted. */
  READY: 'remote_desktop.elevated_ready',
  /** Daemon → helper: one validated remote-desktop command. */
  COMMAND: 'remote_desktop.elevated_command',
  /** Helper → daemon: one remote-desktop message to relay back to the browser. */
  EVENT: 'remote_desktop.elevated_event',
} as const;

/** Enabling, and the states the browser has to be able to tell apart. */
export const REMOTE_DESKTOP_ELEVATED_STATE = {
  /** Not Windows, or the worker itself is not installed yet. */
  UNSUPPORTED: 'unsupported',
  /** Could be enabled; the helper is not installed. */
  AVAILABLE: 'available',
  /** Waiting on the UAC prompt on the machine's own screen. */
  ELEVATING: 'elevating',
  INSTALLED: 'installed',
  FAILED: 'failed',
} as const;

export type RemoteDesktopElevatedState =
  (typeof REMOTE_DESKTOP_ELEVATED_STATE)[keyof typeof REMOTE_DESKTOP_ELEVATED_STATE];

export const REMOTE_DESKTOP_ELEVATED_ERROR = {
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  /** The worker bundle has to be installed before there is anything to elevate. */
  WORKER_MISSING: 'worker_missing',
  /** The UAC prompt was dismissed, or no one was at the machine to answer it. */
  ELEVATION_DECLINED: 'elevation_declined',
  /** Elevation succeeded but the helper did not come up. */
  INSTALL_FAILED: 'install_failed',
} as const;

export type RemoteDesktopElevatedError =
  (typeof REMOTE_DESKTOP_ELEVATED_ERROR)[keyof typeof REMOTE_DESKTOP_ELEVATED_ERROR];

/** Browser → daemon. Carries nothing: the request is the whole message. */
export const REMOTE_DESKTOP_ELEVATED_INSTALL_MSG = {
  REQUEST: 'remote_desktop.elevated_install',
  STATE: 'remote_desktop.elevated_install_state',
} as const;

const ELEVATED_STATES = new Set<string>(Object.values(REMOTE_DESKTOP_ELEVATED_STATE));
const ELEVATED_ERRORS = new Set<string>(Object.values(REMOTE_DESKTOP_ELEVATED_ERROR));

export interface RemoteDesktopElevatedStateMessage {
  type: typeof REMOTE_DESKTOP_ELEVATED_INSTALL_MSG.STATE;
  state: RemoteDesktopElevatedState;
  error?: RemoteDesktopElevatedError;
}

export function validateRemoteDesktopElevatedStateMessage(
  value: unknown,
): RemoteDesktopElevatedStateMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== REMOTE_DESKTOP_ELEVATED_INSTALL_MSG.STATE) return null;
  if (typeof message.state !== 'string' || !ELEVATED_STATES.has(message.state)) return null;
  if (message.error !== undefined
    && (typeof message.error !== 'string' || !ELEVATED_ERRORS.has(message.error))) return null;
  return {
    type: REMOTE_DESKTOP_ELEVATED_INSTALL_MSG.STATE,
    state: message.state as RemoteDesktopElevatedState,
    ...(message.error ? { error: message.error as RemoteDesktopElevatedError } : {}),
  };
}

/** Bounded so a hostile local writer cannot make the helper allocate. */
export const REMOTE_DESKTOP_ELEVATED_LIMITS = {
  MAX_LINE_BYTES: 256 * 1024,
  SECRET_BYTES: 32,
  HELLO_TIMEOUT_MS: 2_000,
  CONNECT_TIMEOUT_MS: 5_000,
} as const;

export interface RemoteDesktopElevatedHello {
  type: typeof REMOTE_DESKTOP_ELEVATED_MSG.HELLO;
  secret: string;
}

/**
 * Accept a hello only when it carries the exact secret the helper wrote for the
 * user it was installed for. The pipe ACL already restricts who can connect;
 * this makes a mis-set ACL insufficient on its own.
 */
export function validateRemoteDesktopElevatedHello(
  value: unknown,
  expectedSecret: string,
  equals: (a: string, b: string) => boolean,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type !== REMOTE_DESKTOP_ELEVATED_MSG.HELLO) return false;
  if (typeof message.secret !== 'string' || !expectedSecret) return false;
  return equals(message.secret, expectedSecret);
}
