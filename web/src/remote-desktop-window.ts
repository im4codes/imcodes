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

/**
 * Ask for a real window rather than a tab -- twice, because browsers disagree
 * about which request they honour.
 *
 * `popup=yes` is the modern feature. The rest are legacy chrome switches that
 * no longer control anything visually; what they still do is satisfy the older
 * rule engines use when they ignore `popup`: a window whose `location` and
 * `toolbar` are both off is opened as a popup. Saying both means an engine that
 * reads either one arrives at a window.
 *
 * `popup=yes` rather than a bare `popup`: the empty value is specified to mean
 * true, but spelling it out costs nothing and removes the dependence on that
 * corner of the parser.
 *
 * `resizable=yes` deliberately stays on -- a remote desktop that cannot be
 * resized is worse than a tab.
 *
 * `noopener` is deliberately absent: it makes `window.open` return null, and
 * the caller needs the handle to tell "opened" from "blocked". The opener is
 * severed below instead, which achieves the same isolation.
 */
function remoteDesktopWindowFeatures(width: number, height: number): string {
  return [
    'popup=yes',
    'location=no',
    'toolbar=no',
    'menubar=no',
    'status=no',
    'resizable=yes',
    `width=${width}`,
    `height=${height}`,
  ].join(',');
}

/**
 * Open one of our windows and cut it loose from this one.
 *
 * Whether the browser ultimately honours any of this is the browser's call --
 * settings and enterprise policy can route every popup into a tab, and nothing
 * a page does overrides that.
 */
function openDetachedWindow(url: string, width: number, height: number): Window | null {
  const opened = window.open(url, '_blank', remoteDesktopWindowFeatures(width, height));
  if (opened) {
    try { opened.opener = null; } catch { /* Browser policy may already isolate the popup. */ }
  }
  return opened;
}

export function openRemoteDesktopWallWindow(): Window | null {
  return openDetachedWindow(buildRemoteDesktopWallWindowUrl(), 1440, 900);
}

export function openRemoteDesktopWindow(serverId: string): Window | null {
  return openDetachedWindow(buildRemoteDesktopWindowUrl(serverId), 1280, 800);
}
