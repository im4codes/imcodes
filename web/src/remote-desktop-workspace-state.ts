import type { MachineListItem } from './api/machines.js';
import { REMOTE_DESKTOP_ACCESS_LIMITS } from '@shared/remote-desktop-access.js';
import {
  remoteDesktopHostKey,
  type RemoteDesktopHostTarget,
} from './remote-desktop-connection-manager.js';

export const REMOTE_DESKTOP_WORKSPACE_WINDOW_ID = 'remote-desktop-workspace';
export const REMOTE_DESKTOP_WALL_TAB_ID = 'wall';
export const REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS = REMOTE_DESKTOP_ACCESS_LIMITS.WALL_MAX_HOSTS;

export type RemoteDesktopWorkspaceMachine = MachineListItem & RemoteDesktopHostTarget;
export type RemoteDesktopWorkspaceTabId = typeof REMOTE_DESKTOP_WALL_TAB_ID | string;

export interface RemoteDesktopWorkspaceHost {
  hostKey: string;
  machine: RemoteDesktopWorkspaceMachine;
}

export interface RemoteDesktopWorkspaceState {
  open: boolean;
  activeTabId: RemoteDesktopWorkspaceTabId;
  orderedHostKeys: readonly string[];
  hosts: Readonly<Record<string, RemoteDesktopWorkspaceHost>>;
}

export function createRemoteDesktopWorkspaceState(): RemoteDesktopWorkspaceState {
  return {
    open: false,
    activeTabId: REMOTE_DESKTOP_WALL_TAB_ID,
    orderedHostKeys: [],
    hosts: {},
  };
}

export function openRemoteDesktopWorkspaceHost(
  state: RemoteDesktopWorkspaceState,
  machine: RemoteDesktopWorkspaceMachine,
): RemoteDesktopWorkspaceState {
  const hostKey = remoteDesktopHostKey(machine);
  if (!hostKey) return state;
  const existing = state.hosts[hostKey];
  if (existing) {
    return {
      ...state,
      open: true,
      activeTabId: hostKey,
      hosts: {
        ...state.hosts,
        [hostKey]: { hostKey, machine },
      },
    };
  }
  if (state.orderedHostKeys.length >= REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS) return state;
  return {
    open: true,
    activeTabId: hostKey,
    orderedHostKeys: [...state.orderedHostKeys, hostKey],
    hosts: {
      ...state.hosts,
      [hostKey]: { hostKey, machine },
    },
  };
}

export function activateRemoteDesktopWorkspaceTab(
  state: RemoteDesktopWorkspaceState,
  tabId: RemoteDesktopWorkspaceTabId,
): RemoteDesktopWorkspaceState {
  if (tabId !== REMOTE_DESKTOP_WALL_TAB_ID && !state.hosts[tabId]) return state;
  if (state.open && state.activeTabId === tabId) return state;
  return { ...state, open: true, activeTabId: tabId };
}

export function closeRemoteDesktopWorkspaceHost(
  state: RemoteDesktopWorkspaceState,
  hostKey: string,
): RemoteDesktopWorkspaceState {
  const index = state.orderedHostKeys.indexOf(hostKey);
  if (index < 0) return state;
  const orderedHostKeys = state.orderedHostKeys.filter((key) => key !== hostKey);
  const hosts = { ...state.hosts };
  delete hosts[hostKey];
  const activeTabId = state.activeTabId === hostKey
    ? orderedHostKeys[Math.min(index, orderedHostKeys.length - 1)] ?? REMOTE_DESKTOP_WALL_TAB_ID
    : state.activeTabId;
  return { ...state, open: orderedHostKeys.length > 0, orderedHostKeys, hosts, activeTabId };
}

export function reorderRemoteDesktopWorkspaceHost(
  state: RemoteDesktopWorkspaceState,
  hostKey: string,
  direction: -1 | 1,
): RemoteDesktopWorkspaceState {
  const from = state.orderedHostKeys.indexOf(hostKey);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= state.orderedHostKeys.length) return state;
  const orderedHostKeys = [...state.orderedHostKeys];
  [orderedHostKeys[from], orderedHostKeys[to]] = [orderedHostKeys[to], orderedHostKeys[from]];
  return { ...state, orderedHostKeys };
}

export function closeRemoteDesktopWorkspace(
  _state: RemoteDesktopWorkspaceState,
): RemoteDesktopWorkspaceState {
  return createRemoteDesktopWorkspaceState();
}

export function remoteDesktopWorkspaceHosts(
  state: RemoteDesktopWorkspaceState,
): RemoteDesktopWorkspaceHost[] {
  return state.orderedHostKeys.flatMap((key) => state.hosts[key] ? [state.hosts[key]] : []);
}
