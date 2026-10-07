import { REMOTE_DESKTOP_ACCESS_MODE, type RemoteDesktopAccessMode } from './remote-desktop.js';

/** Local-only management surface shared by every controlled-node platform. */
export const REMOTE_DESKTOP_LOCAL_MANAGEMENT = Object.freeze({
  HOST: '127.0.0.1',
  PORT: 43751,
  ROOT_PATH: '/',
  STATE_PATH: '/api/state',
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

export interface RemoteDesktopLocalExtras {
  deviceName?: string;
  permissions?: RemoteDesktopLocalPermissions;
}

/** Keep only what is well formed: a trimmed printable host name, known permission keys with known states. Anything else is dropped. */
export function sanitizeRemoteDesktopLocalExtras(value: unknown): RemoteDesktopLocalExtras {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as { deviceName?: unknown; permissions?: unknown };
  const out: RemoteDesktopLocalExtras = {};
  if (typeof raw.deviceName === 'string') {
    // eslint-disable-next-line no-control-regex
    const name = raw.deviceName.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, REMOTE_DESKTOP_LOCAL_DEVICE_NAME_MAX_CHARS);
    if (name) out.deviceName = name;
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
