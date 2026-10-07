import { CONTROLLED_NODE_FAILURE_CLASS, type ControlledNodeFailureClass } from './controlled-node-endpoints.js';
import { REMOTE_DESKTOP_ACCESS_MODE, type RemoteDesktopAccessMode } from './remote-desktop.js';

/** Local-only management surface shared by every controlled-node platform. */
export const REMOTE_DESKTOP_LOCAL_MANAGEMENT = Object.freeze({
  HOST: '127.0.0.1',
  PORT: 43751,
  ROOT_PATH: '/',
  STATE_PATH: '/api/state',
  /** POST {target: a REMOTE_DESKTOP_LOCAL_PERMISSION value}: open that pane of macOS System Settings in the signed-in user's session (a fixed mapping; the page never names a URL). */
  OPEN_SETTINGS_PATH: '/open-settings',
  ACTION_PATH: '/api/action',
  /** Native clients (indicator, app) POST here, with OPEN_WINDOW_HEADER and no Origin, to have the node open or focus the panel window. */
  OPEN_WINDOW_PATH: '/open-window',
  OPEN_WINDOW_HEADER: 'x-aidesk-open-window',
  COOKIE_NAME: 'aidesk-local-session',
  CSRF_HEADER: 'x-aidesk-csrf',
  PAUSED_CAPABILITY: 'remote.desktop.access_paused.v1',
  STATE_FILE: 'remote-desktop-access.json',
  WEB_NODE_QUERY: 'aideskNode',
  WEB_ACTION_QUERY: 'aideskAction',
} as const);

export const REMOTE_DESKTOP_LOCAL_WEB_ACTION = Object.freeze({
  MANAGE: 'manage',
  SHARE: 'share',
} as const);

export type RemoteDesktopLocalWebAction = typeof REMOTE_DESKTOP_LOCAL_WEB_ACTION[keyof typeof REMOTE_DESKTOP_LOCAL_WEB_ACTION];

export const REMOTE_DESKTOP_LOCAL_ACTION = Object.freeze({
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP_ALL: 'stop_all',
  DISCONNECT: 'disconnect',
} as const);

/** Service-owned host → native worker status; never accepted from the server. */
export const REMOTE_DESKTOP_LOCAL_WORKER_MSG = Object.freeze({
  ACCESS_STATE: 'local_access_state',
} as const);

export type RemoteDesktopLocalAction = typeof REMOTE_DESKTOP_LOCAL_ACTION[
  keyof typeof REMOTE_DESKTOP_LOCAL_ACTION
];

/**
 * What the local panel may additionally show: the node's host name and, on macOS, the state of the permissions remote
 * desktop depends on. Both are OPTIONAL and additive: a node that does not send them (an older one) just shows less, and
 * the panel never treats absence as "denied".
 */
export const REMOTE_DESKTOP_LOCAL_PERMISSION = Object.freeze({
  SCREEN_RECORDING: 'screenRecording',
  ACCESSIBILITY: 'accessibility',
  FULL_DISK_ACCESS: 'fullDiskAccess',
} as const);
export const REMOTE_DESKTOP_LOCAL_PERMISSION_STATE = Object.freeze({
  GRANTED: 'granted',
  DENIED: 'denied',
  /** The node cannot tell (it has no probe for it, or the probe was inconclusive). Never shown as a failure. */
  UNKNOWN: 'unknown',
} as const);
export type RemoteDesktopLocalPermissionState = typeof REMOTE_DESKTOP_LOCAL_PERMISSION_STATE[
  keyof typeof REMOTE_DESKTOP_LOCAL_PERMISSION_STATE
];
export type RemoteDesktopLocalPermissions = Partial<Record<
  typeof REMOTE_DESKTOP_LOCAL_PERMISSION[keyof typeof REMOTE_DESKTOP_LOCAL_PERMISSION],
  RemoteDesktopLocalPermissionState
>>;
/** Longest host name the panel shows (it is cut with an ellipsis and carried in full in the hover title). */
export const REMOTE_DESKTOP_LOCAL_DEVICE_NAME_MAX_CHARS = 128;

/** The System Settings pane each permission lives in (macOS). The node opens exactly these, chosen by key, never by anything the page sends. */
export const MACOS_PRIVACY_PANE_URL: Readonly<Record<string, string>> = Object.freeze({
  [REMOTE_DESKTOP_LOCAL_PERMISSION.SCREEN_RECORDING]: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  [REMOTE_DESKTOP_LOCAL_PERMISSION.ACCESSIBILITY]: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  [REMOTE_DESKTOP_LOCAL_PERMISSION.FULL_DISK_ACCESS]: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
});
export type RemoteDesktopLocalPermissionTarget = typeof REMOTE_DESKTOP_LOCAL_PERMISSION[keyof typeof REMOTE_DESKTOP_LOCAL_PERMISSION];
export function isRemoteDesktopLocalPermissionTarget(value: unknown): value is RemoteDesktopLocalPermissionTarget {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MACOS_PRIVACY_PANE_URL, value);
}

/** The node cannot reach its server: which address (host[:port], no scheme or path) and why. Shown by the panel; carries no secret. */
export interface RemoteDesktopLocalServerConnection {
  target: string;
  reason: ControlledNodeFailureClass;
}

export interface RemoteDesktopLocalExtras {
  deviceName?: string;
  /** Present only while the node cannot reach its server. */
  serverConnection?: RemoteDesktopLocalServerConnection;
  /** The node's own version, shown on the About page. */
  version?: string;
  permissions?: RemoteDesktopLocalPermissions;
}

/** Keep only what is well formed: a trimmed printable host name, known permission keys with known states. Anything else is dropped. */
export function sanitizeRemoteDesktopLocalExtras(value: unknown): RemoteDesktopLocalExtras {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as { deviceName?: unknown; permissions?: unknown; version?: unknown };
  const out: RemoteDesktopLocalExtras = {};
  if (typeof raw.deviceName === 'string') {
    // eslint-disable-next-line no-control-regex
    const name = raw.deviceName.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, REMOTE_DESKTOP_LOCAL_DEVICE_NAME_MAX_CHARS);
    if (name) out.deviceName = name;
  }
  const connection = (value as { serverConnection?: unknown }).serverConnection;
  if (connection && typeof connection === 'object' && !Array.isArray(connection)) {
    const { target, reason } = connection as { target?: unknown; reason?: unknown };
    if (typeof target === 'string' && /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/u.test(target)
      && typeof reason === 'string' && (Object.values(CONTROLLED_NODE_FAILURE_CLASS) as string[]).includes(reason)) {
      out.serverConnection = { target, reason: reason as ControlledNodeFailureClass };
    }
  }
  if (typeof raw.version === 'string') {
    const version = raw.version.trim();
    if (/^[\w.+-]{1,64}$/u.test(version)) out.version = version;
  }
  if (raw.permissions && typeof raw.permissions === 'object' && !Array.isArray(raw.permissions)) {
    const states = new Set<unknown>(Object.values(REMOTE_DESKTOP_LOCAL_PERMISSION_STATE));
    const permissions: RemoteDesktopLocalPermissions = {};
    for (const key of Object.values(REMOTE_DESKTOP_LOCAL_PERMISSION)) {
      const state = (raw.permissions as Record<string, unknown>)[key];
      if (states.has(state)) permissions[key] = state as RemoteDesktopLocalPermissionState;
    }
    if (Object.keys(permissions).length > 0) out.permissions = permissions;
  }
  return out;
}

export interface RemoteDesktopLocalConnection {
  /** Random panel-local handle. Never a route/session/capability identifier. */
  id: string;
  /** Safe local label. Never an email address or internal identifier. */
  label: string;
  connectedAt: number;
  mode: RemoteDesktopAccessMode;
}

export interface RemoteDesktopLocalStatus {
  publicNodeId: string;
  paused: boolean;
  connections: readonly RemoteDesktopLocalConnection[];
}

export function isRemoteDesktopLocalMode(value: unknown): value is RemoteDesktopAccessMode {
  return value === REMOTE_DESKTOP_ACCESS_MODE.VIEW
    || value === REMOTE_DESKTOP_ACCESS_MODE.CONTROL;
}
