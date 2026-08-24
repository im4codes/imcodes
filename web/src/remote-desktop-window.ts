export const REMOTE_DESKTOP_WINDOW_SERVER_QUERY = 'remoteDesktopServer';
export const REMOTE_DESKTOP_WALL_WINDOW_QUERY = 'remoteDesktopWall';

const REMOTE_DESKTOP_WINDOW_SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function readRemoteDesktopWindowServerId(search = window.location.search): string | null {
  const value = new URLSearchParams(search).get(REMOTE_DESKTOP_WINDOW_SERVER_QUERY);
  return value && REMOTE_DESKTOP_WINDOW_SERVER_ID.test(value) ? value : null;
}

export function isRemoteDesktopWallWindow(search = window.location.search): boolean {
  return new URLSearchParams(search).get(REMOTE_DESKTOP_WALL_WINDOW_QUERY) === '1';
}

export function buildRemoteDesktopWindowUrl(
  serverId: string,
  currentUrl = window.location.href,
): string {
  if (!REMOTE_DESKTOP_WINDOW_SERVER_ID.test(serverId)) {
    throw new Error('invalid_remote_desktop_server_id');
  }
  const url = new URL(currentUrl);
  url.searchParams.delete(REMOTE_DESKTOP_WALL_WINDOW_QUERY);
  url.searchParams.set(REMOTE_DESKTOP_WINDOW_SERVER_QUERY, serverId);
  url.hash = '';
  return url.toString();
}


export function buildRemoteDesktopWallWindowUrl(currentUrl = window.location.href): string {
  const url = new URL(currentUrl);
  url.searchParams.delete(REMOTE_DESKTOP_WINDOW_SERVER_QUERY);
  url.searchParams.set(REMOTE_DESKTOP_WALL_WINDOW_QUERY, '1');
  url.hash = '';
  return url.toString();
}

export function openRemoteDesktopWallWindow(): Window | null {
  const opened = window.open(
    buildRemoteDesktopWallWindowUrl(),
    '_blank',
    'popup,width=1440,height=900',
  );
  if (opened) {
    try { opened.opener = null; } catch { /* Browser policy may already isolate the popup. */ }
  }
  return opened;
}

export function openRemoteDesktopWindow(serverId: string): Window | null {
  const opened = window.open(
    buildRemoteDesktopWindowUrl(serverId),
    '_blank',
    'popup,width=1280,height=800',
  );
  if (opened) {
    try { opened.opener = null; } catch { /* Browser policy may already isolate the popup. */ }
  }
  return opened;
}
