import { isPlausibleServerId } from '@shared/controlled-node-host-link.js';
import {
  buildRemoteDesktopAppUrl,
  isRemoteDesktopAppPath,
  readRemoteDesktopAppMachineId,
} from '@shared/remote-desktop-app.js';
import { isStandaloneDisplayMode } from './pwa-install.js';
import { publishRemoteDesktopWindowBlocked } from './remote-desktop-window-notice.js';

export const REMOTE_DESKTOP_WINDOW_SERVER_QUERY = 'remoteDesktopServer';
export const REMOTE_DESKTOP_WALL_WINDOW_QUERY = 'remoteDesktopWall';

export function readRemoteDesktopWindowServerId(search = window.location.search): string | null {
  const value = new URLSearchParams(search).get(REMOTE_DESKTOP_WINDOW_SERVER_QUERY);
  return isPlausibleServerId(value) ? value : null;
}

/**
 * The installed-app entry (`/remote-desktop/app/`, see shared/remote-desktop-app.ts): the machine wall, or one machine when the link names
 * it (`?machine=<serverId>`). Null for every other page. A machine id that is not a plausible server id is ignored (the wall opens).
 */
export function resolveRemoteDesktopAppEntry(
  pathname: string,
  search: string,
): { machineId: string | null } | null {
  return isRemoteDesktopAppPath(pathname) ? { machineId: readRemoteDesktopAppMachineId(search) } : null;
}

export function isRemoteDesktopWallWindow(search = window.location.search): boolean {
  return new URLSearchParams(search).get(REMOTE_DESKTOP_WALL_WINDOW_QUERY) === '1';
}

export function buildRemoteDesktopWindowUrl(
  serverId: string,
  currentUrl = window.location.href,
): string {
  if (!isPlausibleServerId(serverId)) {
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
interface WindowBounds {
  width: number;
  height: number;
  left?: number;
  top?: number;
}

/**
 * A remote desktop wants every pixel: ask for a window over the whole usable
 * screen area (what a maximized window covers) instead of a fixed small size
 * the user then has to drag larger. Falls back to the fixed size only when the
 * screen cannot be measured. It is only a request: Firefox honours it, but in
 * the measurements behind the install-as-app work Chrome gave every popup the
 * size of the window that opened it. Nothing may depend on the size arriving.
 */
export function remoteDesktopWindowBounds(fallbackWidth: number, fallbackHeight: number): WindowBounds {
  const scr = typeof window !== 'undefined' ? window.screen as Screen & { availLeft?: number; availTop?: number } : undefined;
  const width = Math.trunc(scr?.availWidth ?? 0);
  const height = Math.trunc(scr?.availHeight ?? 0);
  if (width <= 0 || height <= 0) return { width: fallbackWidth, height: fallbackHeight };
  return {
    width,
    height,
    left: Math.trunc(scr?.availLeft ?? 0),
    top: Math.trunc(scr?.availTop ?? 0),
  };
}

function remoteDesktopWindowFeatures(bounds: WindowBounds): string {
  return [
    'popup=yes',
    'location=no',
    'toolbar=no',
    'menubar=no',
    'status=no',
    'resizable=yes',
    `width=${bounds.width}`,
    `height=${bounds.height}`,
    ...(bounds.left !== undefined ? [`left=${bounds.left}`] : []),
    ...(bounds.top !== undefined ? [`top=${bounds.top}`] : []),
  ].join(',');
}

/**
 * Open one of our windows and cut it loose from this one.
 *
 * Whether the browser ultimately honours any of this is the browser's call --
 * settings and enterprise policy can route every popup into a tab, and nothing
 * a page does overrides that.
 */
function openDetachedWindow(url: string, fallbackWidth: number, fallbackHeight: number): Window | null {
  const opened = window.open(url, '_blank', remoteDesktopWindowFeatures(
    remoteDesktopWindowBounds(fallbackWidth, fallbackHeight),
  ));
  if (opened) {
    try { opened.opener = null; } catch { /* Browser policy may already isolate the popup. */ }
  } else {
    // Blocked (pop-up blocker, or a call that was not a user gesture). The caller gets null, and the user gets told, from here, so no
    // button that opens a window can fail in silence.
    publishRemoteDesktopWindowBlocked();
  }
  return opened;
}

/**
 * From inside the installed app a pop-up would leave the app's scope (and bring the address strip back), so another window is another
 * app window: the app's own URL, opened with no window features. Blocked the same way as a pop-up, and reported the same way.
 */
function openInstalledAppWindow(url: string): Window | null {
  const opened = window.open(url, '_blank');
  if (opened) {
    try { opened.opener = null; } catch { /* Browser policy may already isolate the window. */ }
  } else {
    publishRemoteDesktopWindowBlocked();
  }
  return opened;
}

export function openRemoteDesktopWallWindow(): Window | null {
  if (isStandaloneDisplayMode()) return openInstalledAppWindow(buildRemoteDesktopAppUrl(undefined, window.location.origin));
  return openDetachedWindow(buildRemoteDesktopWallWindowUrl(), 1440, 900);
}

export function openRemoteDesktopWindow(serverId: string): Window | null {
  if (isStandaloneDisplayMode() && isPlausibleServerId(serverId)) {
    return openInstalledAppWindow(buildRemoteDesktopAppUrl(serverId, window.location.origin));
  }
  return openDetachedWindow(buildRemoteDesktopWindowUrl(serverId), 1280, 800);
}
