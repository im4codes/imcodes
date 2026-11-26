/**
 * Giving a daemon's machine control of the sign-in and lock screen.
 *
 * Only a LocalSystem component can follow Windows onto the secure desktop, and
 * this repository already has one: the controlled node. So rather than growing a
 * second privileged component beside it, enabling this installs the controlled
 * node on that machine the ordinary way — the browser mints an enrolment ticket
 * with its own session, the daemon fetches the executable that ticket
 * personalises, and one UAC prompt on the machine does the rest.
 *
 * The enrolment records which daemon it was started from, so both installs are
 * known to share a machine and the browser keeps offering a single entry.
 *
 * Linux and macOS daemons install the node the same way when asked from the
 * daemon's remote-desktop setup: the request then carries an install code,
 * and the daemon runs that code's install script -- fetched from its own
 * server, never from a URL in the message -- with administrator rights.
 * Without a password (`sudo -n`) when that user may, otherwise through the
 * macOS administrator prompt on that computer's own screen; a Linux user who
 * needs a password for sudo gets the command to run instead.
 */

import {
  CONTROLLED_NODE_CANONICAL_ARTIFACTS,
  isControlledNodeInstallCode,
  type ControlledNodeArtifactPair,
} from './controlled-node-artifacts.js';

export const REMOTE_DESKTOP_LOGIN_SCREEN_MSG = {
  /** Browser → daemon, carrying the ticket it just minted. */
  REQUEST: 'remote_desktop.login_screen_install',
  /** Daemon → browsers: how far that got. */
  STATE: 'remote_desktop.login_screen_state',
} as const;

export const REMOTE_DESKTOP_LOGIN_SCREEN_STATE = {
  DOWNLOADING: 'downloading',
  /** Waiting on the UAC prompt, which appears on that machine's own screen. */
  ELEVATING: 'elevating',
  /**
   * The elevated installer finished. The node enrols itself from there, so the
   * machine appears in the browser's own list rather than being reported here.
   */
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type RemoteDesktopLoginScreenState =
  (typeof REMOTE_DESKTOP_LOGIN_SCREEN_STATE)[keyof typeof REMOTE_DESKTOP_LOGIN_SCREEN_STATE];

export const REMOTE_DESKTOP_LOGIN_SCREEN_ERROR = {
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  /** The daemon is not bound, so it has nowhere to fetch the installer from. */
  NOT_BOUND: 'not_bound',
  /** The ticket was rejected, or the download failed. */
  DOWNLOAD_FAILED: 'download_failed',
  /** Nobody approved the prompt on that machine. */
  ELEVATION_DECLINED: 'elevation_declined',
  /** Linux: this user needs a password for sudo, so someone has to type it there. */
  ADMIN_REQUIRED: 'admin_required',
  /** The installer ran with administrator rights and did not succeed. */
  INSTALL_FAILED: 'install_failed',
} as const;

export type RemoteDesktopLoginScreenError =
  (typeof REMOTE_DESKTOP_LOGIN_SCREEN_ERROR)[keyof typeof REMOTE_DESKTOP_LOGIN_SCREEN_ERROR];

export interface RemoteDesktopLoginScreenStateMessage {
  type: typeof REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE;
  state: RemoteDesktopLoginScreenState;
  error?: RemoteDesktopLoginScreenError;
}

const STATES = new Set<string>(Object.values(REMOTE_DESKTOP_LOGIN_SCREEN_STATE));
const ERRORS = new Set<string>(Object.values(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR));

/** Tickets are opaque to everything between the browser and the server. */
const TICKET_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

/** Read the ticket out of an install request, or null when it is not usable. */
export function readRemoteDesktopLoginScreenTicket(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST) return null;
  const ticket = typeof message.ticket === 'string' ? message.ticket.trim() : '';
  return TICKET_RE.test(ticket) ? ticket : null;
}

/** Read the install code out of a Linux or macOS install request, or null. */
export function readRemoteDesktopLoginScreenInstallCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST) return null;
  return isControlledNodeInstallCode(message.installCode) ? message.installCode : null;
}

/**
 * Advertised in `daemon.hello` by a daemon that can install the controlled
 * node on its own computer, naming the artifact that computer needs: the
 * browser mints the install code for exactly that artifact.
 */
const INSTALL_HERE_CAPABILITY_PREFIX = 'controlled_node.install_here.v1:';

export function controlledNodeInstallHereCapability(target: ControlledNodeArtifactPair): string {
  return `${INSTALL_HERE_CAPABILITY_PREFIX}${target.os}-${target.arch}`;
}

/** The artifact a daemon offers to install on its computer, or null if none. */
export function readControlledNodeInstallHereTarget(
  capabilities: readonly string[],
): ControlledNodeArtifactPair | null {
  for (const capability of capabilities) {
    if (!capability.startsWith(INSTALL_HERE_CAPABILITY_PREFIX)) continue;
    const named = capability.slice(INSTALL_HERE_CAPABILITY_PREFIX.length);
    const target = CONTROLLED_NODE_CANONICAL_ARTIFACTS.find(
      (artifact) => `${artifact.os}-${artifact.arch}` === named,
    );
    if (target) return target;
  }
  return null;
}

/**
 * Validate a daemon-reported state before relaying it. Unknown states and
 * free-form errors are dropped rather than passed through, so the browser only
 * renders values it has wording for.
 */
export function validateRemoteDesktopLoginScreenStateMessage(
  value: unknown,
): RemoteDesktopLoginScreenStateMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE) return null;
  if (typeof message.state !== 'string' || !STATES.has(message.state)) return null;
  if (message.error !== undefined
    && (typeof message.error !== 'string' || !ERRORS.has(message.error))) return null;
  return {
    type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE,
    state: message.state as RemoteDesktopLoginScreenState,
    ...(message.error ? { error: message.error as RemoteDesktopLoginScreenError } : {}),
  };
}
