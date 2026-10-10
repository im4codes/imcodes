/**
 * The display scale a user settled on for a given remote machine, saved
 * locally so reopening the same session doesn't start back at the default
 * and force a manual re-adjustment every time. Keyed per machine: the right
 * scale for a 4K desktop and a laptop are rarely the same.
 */
export const REMOTE_DESKTOP_ZOOM_PREFERENCE_STORAGE_KEY_PREFIX = 'imcodes.web.remote-desktop.zoom.v1.';

export type RemoteDesktopZoomViewScale = 'fit' | 'actual';

export interface RemoteDesktopZoomPreference {
  viewScale: RemoteDesktopZoomViewScale;
  /** The pinch/+- zoom ratio on top of viewScale's base, e.g. 1 = 100%. */
  scale: number;
}

interface StoredRemoteDesktopZoomPreference {
  version: 1;
  viewScale: RemoteDesktopZoomViewScale;
  scale: number;
}

function isRemoteDesktopZoomViewScale(value: unknown): value is RemoteDesktopZoomViewScale {
  return value === 'fit' || value === 'actual';
}

function remoteDesktopZoomPreferenceStorageKey(serverId: string): string {
  return `${REMOTE_DESKTOP_ZOOM_PREFERENCE_STORAGE_KEY_PREFIX}${serverId}`;
}

export function loadRemoteDesktopZoomPreference(
  serverId: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): RemoteDesktopZoomPreference | null {
  try {
    const raw = storage.getItem(remoteDesktopZoomPreferenceStorageKey(serverId));
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<StoredRemoteDesktopZoomPreference> | null;
    if (
      value?.version === 1
      && isRemoteDesktopZoomViewScale(value.viewScale)
      && typeof value.scale === 'number'
      && Number.isFinite(value.scale)
    ) {
      return { viewScale: value.viewScale, scale: value.scale };
    }
  } catch {
    // Local preferences are fail-soft; an unavailable or corrupt store must not block the UI.
  }
  return null;
}

export function saveRemoteDesktopZoomPreference(
  serverId: string,
  preference: RemoteDesktopZoomPreference,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    const value: StoredRemoteDesktopZoomPreference = { version: 1, ...preference };
    storage.setItem(remoteDesktopZoomPreferenceStorageKey(serverId), JSON.stringify(value));
  } catch {
    // Browser privacy modes and exhausted quotas are non-fatal for this local-only preference.
  }
}
