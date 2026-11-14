import type { RemoteDesktopTraffic, RemoteDesktopTrafficHistory } from './remote-desktop-traffic.js';
import { CONTROLLED_NODE_FAILURE_CLASS, type ControlledNodeFailureClass } from './controlled-node-endpoints.js';
import { REMOTE_DESKTOP_ACCESS_MODE, type RemoteDesktopAccessMode } from './remote-desktop.js';

/** Local-only management surface shared by every controlled-node platform. */
export const REMOTE_DESKTOP_LOCAL_MANAGEMENT = Object.freeze({
  HOST: '127.0.0.1',
  PORT: 43751,
  ROOT_PATH: '/',
  STATE_PATH: '/api/state',
  DAEMON_LOGS_PATH: '/api/daemon/logs',
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

export const REMOTE_DESKTOP_LOCAL_DAEMON_ACTION = Object.freeze({
  START: 'daemon_start',
  STOP: 'daemon_stop',
  RESTART: 'daemon_restart',
  ENABLE_AUTOSTART: 'daemon_enable_autostart',
  DISABLE_AUTOSTART: 'daemon_disable_autostart',
  BIND: 'daemon_bind',
} as const);

export type RemoteDesktopLocalDaemonAction =
  typeof REMOTE_DESKTOP_LOCAL_DAEMON_ACTION[keyof typeof REMOTE_DESKTOP_LOCAL_DAEMON_ACTION];

export const REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE = Object.freeze({
  BUNDLE: 'bundle',
  CLI: 'cli',
  NONE: 'none',
} as const);

export type RemoteDesktopLocalDaemonRuntimeSource =
  typeof REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE[keyof typeof REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE];

export const REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART = Object.freeze({
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  UNAVAILABLE: 'unavailable',
} as const);

export type RemoteDesktopLocalDaemonAutostartState =
  typeof REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART[keyof typeof REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART];

export const REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE = Object.freeze({
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected',
  UNKNOWN: 'unknown',
} as const);

export type RemoteDesktopLocalDaemonConnectionState =
  typeof REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE[keyof typeof REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE];

export const REMOTE_DESKTOP_LOCAL_DAEMON_REASON = Object.freeze({
  NO_ACTIVE_USER: 'no_active_user',
  NOT_INSTALLED: 'not_installed',
  NOT_BOUND: 'not_bound',
  UNAVAILABLE: 'unavailable',
} as const);

export type RemoteDesktopLocalDaemonReason =
  typeof REMOTE_DESKTOP_LOCAL_DAEMON_REASON[keyof typeof REMOTE_DESKTOP_LOCAL_DAEMON_REASON];

export interface RemoteDesktopLocalDaemonStatus {
  available: boolean;
  installed: boolean;
  bound: boolean;
  running: boolean;
  connectionState: RemoteDesktopLocalDaemonConnectionState;
  autostart: RemoteDesktopLocalDaemonAutostartState;
  runtimeSource: RemoteDesktopLocalDaemonRuntimeSource;
  version?: string;
  pid?: number;
  serverId?: string;
  serverHost?: string;
  serverOrigin?: string;
  userName?: string;
  lastError?: string;
  reason?: RemoteDesktopLocalDaemonReason;
  canControl: boolean;
  canBind: boolean;
  canViewLogs: boolean;
}

export interface RemoteDesktopLocalDaemonLogs {
  text: string;
  truncated: boolean;
  source?: string;
}

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
  daemon?: RemoteDesktopLocalDaemonStatus;
}

const REMOTE_DESKTOP_LOCAL_DAEMON_ERROR_MAX_CHARS = 240;

function stripDaemonControlChars(value: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, maxChars);
}

/** Sanitize Coding Daemon status before returning it over the local management API; never forwards credentials or arbitrary URLs. */
export function sanitizeRemoteDesktopLocalDaemonStatus(value: unknown): RemoteDesktopLocalDaemonStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const connStates = new Set<unknown>(Object.values(REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE));
  const autostartStates = new Set<unknown>(Object.values(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART));
  const runtimeSources = new Set<unknown>(Object.values(REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE));
  const reasons = new Set<unknown>(Object.values(REMOTE_DESKTOP_LOCAL_DAEMON_REASON));

  const out: RemoteDesktopLocalDaemonStatus = {
    available: Boolean(raw.available),
    installed: Boolean(raw.installed),
    bound: Boolean(raw.bound),
    running: Boolean(raw.running),
    connectionState: connStates.has(raw.connectionState)
      ? raw.connectionState as RemoteDesktopLocalDaemonConnectionState
      : REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.UNKNOWN,
    autostart: autostartStates.has(raw.autostart)
      ? raw.autostart as RemoteDesktopLocalDaemonAutostartState
      : REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.UNAVAILABLE,
    runtimeSource: runtimeSources.has(raw.runtimeSource)
      ? raw.runtimeSource as RemoteDesktopLocalDaemonRuntimeSource
      : REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.NONE,
    canControl: Boolean(raw.canControl),
    canBind: Boolean(raw.canBind),
    canViewLogs: Boolean(raw.canViewLogs),
  };
  if (typeof raw.version === 'string') {
    const version = raw.version.trim();
    if (/^[\w.+-]{1,64}$/u.test(version)) out.version = version;
  }
  if (typeof raw.pid === 'number' && Number.isSafeInteger(raw.pid) && raw.pid > 0) {
    out.pid = raw.pid;
  }
  if (typeof raw.serverId === 'string') {
    const serverId = raw.serverId.trim();
    if (/^[A-Za-z0-9._-]{1,128}$/u.test(serverId)) out.serverId = serverId;
  }
  if (typeof raw.serverHost === 'string') {
    const host = raw.serverHost.trim();
    if (/^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/u.test(host)) out.serverHost = host;
  }
  if (typeof raw.serverOrigin === 'string') {
    const origin = raw.serverOrigin.trim();
    if (/^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/u.test(origin)) out.serverOrigin = origin;
  }
  if (typeof raw.userName === 'string') {
    const userName = stripDaemonControlChars(raw.userName, 64);
    if (userName) out.userName = userName;
  }
  if (typeof raw.lastError === 'string') {
    const lastError = stripDaemonControlChars(raw.lastError, REMOTE_DESKTOP_LOCAL_DAEMON_ERROR_MAX_CHARS)
      .replace(/(?:Bearer\s+|token\s*[:=]\s*|\/bind\/)[^\s,;]+/giu, '[redacted]');
    if (lastError) out.lastError = lastError;
  }
  if (reasons.has(raw.reason)) {
    out.reason = raw.reason as RemoteDesktopLocalDaemonReason;
  }
  return out;
}

/** Keep only what is well formed: a trimmed printable host name, known permission keys with known states. Anything else is dropped. */
export function sanitizeRemoteDesktopLocalExtras(value: unknown): RemoteDesktopLocalExtras {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as { deviceName?: unknown; permissions?: unknown; version?: unknown; daemon?: unknown };
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
  if (raw.daemon !== undefined) {
    const daemon = sanitizeRemoteDesktopLocalDaemonStatus(raw.daemon);
    if (daemon) out.daemon = daemon;
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
  traffic?: RemoteDesktopTraffic;
}

export interface RemoteDesktopLocalStatus {
  publicNodeId: string;
  traffic?: RemoteDesktopTrafficHistory;
  paused: boolean;
  connections: readonly RemoteDesktopLocalConnection[];
  daemon?: RemoteDesktopLocalDaemonStatus;
}

export function isRemoteDesktopLocalMode(value: unknown): value is RemoteDesktopAccessMode {
  return value === REMOTE_DESKTOP_ACCESS_MODE.VIEW
    || value === REMOTE_DESKTOP_ACCESS_MODE.CONTROL;
}
