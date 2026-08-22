/**
 * Remote-desktop worker installation on a normal (FULL) daemon.
 *
 * A controlled node release stages the native worker through the atomic
 * self-upgrade script, but the first-install executable is intentionally a
 * single file and may need to fetch its same-version sidecars. A normal daemon
 * installed from npm has the same on-demand need. These types carry that request
 * and its outcome; the signalling protocol in `remote-desktop.ts` is untouched.
 */

/**
 * Advertised by a daemon that could serve remote control but has no worker
 * installed yet. It is deliberately distinct from `REMOTE_DESKTOP_CAPABILITY`,
 * which means "ready now": the UI needs to tell "this machine cannot do remote
 * control" apart from "this machine needs one download first".
 */
export const REMOTE_DESKTOP_INSTALLABLE_CAPABILITY = 'remote.desktop.windows.installable.v1' as const;

export const REMOTE_DESKTOP_INSTALL_MSG = {
  /** Browser → daemon: fetch and install the worker bundle. */
  REQUEST: 'remote_desktop.worker_install',
  /** Daemon → browsers: current installation state. */
  STATE: 'remote_desktop.worker_install_state',
} as const;

export const REMOTE_DESKTOP_INSTALL_STATE = {
  /** This host cannot run the worker (not Windows x64, or the feature is off). */
  UNSUPPORTED: 'unsupported',
  /** Supported, no worker installed yet. */
  MISSING: 'missing',
  DOWNLOADING: 'downloading',
  INSTALLED: 'installed',
  FAILED: 'failed',
} as const;

export type RemoteDesktopInstallState =
  (typeof REMOTE_DESKTOP_INSTALL_STATE)[keyof typeof REMOTE_DESKTOP_INSTALL_STATE];

export const REMOTE_DESKTOP_INSTALL_ERROR = {
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  /** The daemon is not bound to a server, so it has nothing to download from. */
  NOT_BOUND: 'not_bound',
  DOWNLOAD_FAILED: 'download_failed',
  /** Downloaded, but the bundle did not match its pinned signature/manifest. */
  VERIFICATION_FAILED: 'verification_failed',
  /** The server has no worker build for this platform yet. */
  NOT_AVAILABLE: 'not_available',
} as const;

export type RemoteDesktopInstallError =
  (typeof REMOTE_DESKTOP_INSTALL_ERROR)[keyof typeof REMOTE_DESKTOP_INSTALL_ERROR];

export interface RemoteDesktopInstallStateMessage {
  type: typeof REMOTE_DESKTOP_INSTALL_MSG.STATE;
  state: RemoteDesktopInstallState;
  error?: RemoteDesktopInstallError;
}

const INSTALL_STATES = new Set<string>(Object.values(REMOTE_DESKTOP_INSTALL_STATE));
const INSTALL_ERRORS = new Set<string>(Object.values(REMOTE_DESKTOP_INSTALL_ERROR));

export function isRemoteDesktopInstallState(value: unknown): value is RemoteDesktopInstallState {
  return typeof value === 'string' && INSTALL_STATES.has(value);
}

/**
 * Validate a daemon-reported installation state before it is relayed onward.
 * Unknown states and free-form error strings are rejected rather than passed
 * through, so the browser only ever renders values it has translations for.
 */
export function validateRemoteDesktopInstallStateMessage(
  value: unknown,
): RemoteDesktopInstallStateMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== REMOTE_DESKTOP_INSTALL_MSG.STATE) return null;
  if (!isRemoteDesktopInstallState(message.state)) return null;
  if (message.error !== undefined
    && (typeof message.error !== 'string' || !INSTALL_ERRORS.has(message.error))) return null;
  return {
    type: REMOTE_DESKTOP_INSTALL_MSG.STATE,
    state: message.state,
    ...(message.error ? { error: message.error as RemoteDesktopInstallError } : {}),
  };
}
