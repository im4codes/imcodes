import { REMOTE_DESKTOP_ACCESS_MODE, type RemoteDesktopAccessMode } from './remote-desktop.js';

/** Local-only management surface shared by every controlled-node platform. */
export const REMOTE_DESKTOP_LOCAL_MANAGEMENT = Object.freeze({
  HOST: '127.0.0.1',
  PORT: 43751,
  ROOT_PATH: '/',
  STATE_PATH: '/api/state',
  ACTION_PATH: '/api/action',
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

export const REMOTE_DESKTOP_LOCAL_ACTION = Object.freeze({
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP_ALL: 'stop_all',
  DISCONNECT: 'disconnect',
} as const);

export type RemoteDesktopLocalAction = typeof REMOTE_DESKTOP_LOCAL_ACTION[
  keyof typeof REMOTE_DESKTOP_LOCAL_ACTION
];

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
