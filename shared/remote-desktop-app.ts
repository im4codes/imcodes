// The installable "IM.codes Remote Desktop" web app: where it lives, what its manifest says, which icons it uses.
//
// A `window.open` popup always keeps a (read-only) address strip; the only window without one is an installed app window. So the remote
// desktop gets its own installable entry. Its scope is deliberately narrow (`/remote-desktop/app/`): installing it must not turn the
// whole IM.codes site into a captured app, and the guest access page (`/remote-desktop/access`) is outside it.
//
// One source for the web (entry routing, manifest link), the Vite build (which emits the manifest from `buildRemoteDesktopAppManifest`)
// and the tests. Icons are rendered from the official logo by scripts/aidesk-icon.mjs (`pwa-icons`) and committed under web/public.

import { isPlausibleServerId } from './controlled-node-host-link.js';
// The values the icon generator (scripts/aidesk-icon.mjs, plain node) shares with this module live in the JSON: the one place they are written.
import appAssets from './remote-desktop-app.json' with { type: 'json' };

/** Everything under this path (with the trailing slash) belongs to the installed app. */
export const REMOTE_DESKTOP_APP_SCOPE = '/remote-desktop/app/';
/** The same page without the trailing slash: served by the SPA fallback, outside the manifest scope, treated as the app entry too. */
export const REMOTE_DESKTOP_APP_PATH = '/remote-desktop/app';
/** The page an installed app opens: the machine wall (pick a machine, or open several in tabs). */
export const REMOTE_DESKTOP_APP_START_URL = REMOTE_DESKTOP_APP_SCOPE;
/** Stable identity of the app: changing `start_url` later must not make browsers treat it as a different app. */
export const REMOTE_DESKTOP_APP_ID = REMOTE_DESKTOP_APP_SCOPE;
/** Deep link: `/remote-desktop/app/?machine=<serverId>` opens that machine directly (a daemon-dependent request: it carries the serverId). */
export const REMOTE_DESKTOP_APP_MACHINE_QUERY = 'machine';

/** Directory of the app's static assets (outside the scope, so the manifest and icons stay reachable from any page). */
export const REMOTE_DESKTOP_APP_ASSET_DIR: string = appAssets.assetDir;
export const REMOTE_DESKTOP_APP_MANIFEST_PATH = `${REMOTE_DESKTOP_APP_ASSET_DIR}/manifest.webmanifest`;
export const REMOTE_DESKTOP_APP_MANIFEST_MIME = 'application/manifest+json';

export type RemoteDesktopAppIconPurpose = 'any' | 'maskable';
/** The icon files in web/public/remote-desktop-app: the pixel size each must have, its purpose, and the URL it is served at. */
export const REMOTE_DESKTOP_APP_ICON_FILES: ReadonlyArray<Readonly<{ file: string; size: number; purpose: RemoteDesktopAppIconPurpose; path: string }>> = Object.freeze(
  appAssets.icons.map((icon) => Object.freeze({
    file: icon.file,
    size: icon.size,
    purpose: icon.purpose as RemoteDesktopAppIconPurpose,
    path: `${REMOTE_DESKTOP_APP_ASSET_DIR}/${icon.file}`,
  })),
);
/** Where the generator writes the icons, relative to the repository root. */
export const REMOTE_DESKTOP_APP_ICON_SOURCE_DIR: string = appAssets.iconSourceDir;
/** The file in that directory recording which logo the icons were rendered from (the test binds it to the logo's hash). */
export const REMOTE_DESKTOP_APP_ICON_SOURCE_HASH_FILE: string = appAssets.iconSourceHashFile;
/** A maskable icon is cropped by the platform: everything that matters must sit inside this fraction of the width (W3C safe zone). */
export const REMOTE_DESKTOP_APP_MASKABLE_SAFE_ZONE_RATIO: number = appAssets.maskableSafeZoneRatio;

export const REMOTE_DESKTOP_APP_THEME_COLOR = '#0a0e1a';

export interface RemoteDesktopAppManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  display_override: string[];
  background_color: string;
  theme_color: string;
  launch_handler: { client_mode: string[] };
  icons: Array<{ src: string; sizes: string; type: 'image/png'; purpose: RemoteDesktopAppIconPurpose }>;
}

/**
 * The manifest. `display_override` falls back from the app window to the minimal-ui window if a browser cannot do standalone.
 * No `window-controls-overlay`: the UI does not draw its own title bar. No service worker is involved anywhere: Chrome stopped
 * requiring one for installation (108 mobile / 112 desktop), and a cache here would only add upgrade problems.
 */
export function buildRemoteDesktopAppManifest(): RemoteDesktopAppManifest {
  return {
    id: REMOTE_DESKTOP_APP_ID,
    name: 'IM.codes Remote Desktop',
    short_name: 'IM.codes RD',
    description: 'Remote desktop for the machines connected to IM.codes, in its own window.',
    start_url: REMOTE_DESKTOP_APP_START_URL,
    scope: REMOTE_DESKTOP_APP_SCOPE,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: REMOTE_DESKTOP_APP_THEME_COLOR,
    theme_color: REMOTE_DESKTOP_APP_THEME_COLOR,
    // Launching the app again (for example from a deep link) reuses the open window instead of stacking a second one.
    launch_handler: { client_mode: ['navigate-existing', 'auto'] },
    icons: REMOTE_DESKTOP_APP_ICON_FILES.map(({ path, size, purpose }) => ({
      src: path,
      sizes: `${size}x${size}`,
      type: 'image/png' as const,
      purpose,
    })),
  };
}

export function serializeRemoteDesktopAppManifest(): string {
  return `${JSON.stringify(buildRemoteDesktopAppManifest(), null, 2)}\n`;
}

/** True for the app entry, with or without the trailing slash. Anything else under `/remote-desktop/` (the guest page) is not it. */
export function isRemoteDesktopAppPath(pathname: string): boolean {
  return pathname === REMOTE_DESKTOP_APP_PATH || pathname === REMOTE_DESKTOP_APP_SCOPE;
}

/** The machine a deep link names, or null (no link, or an id that is not a plausible server id). */
export function readRemoteDesktopAppMachineId(search: string): string | null {
  const value = new URLSearchParams(search).get(REMOTE_DESKTOP_APP_MACHINE_QUERY);
  return isPlausibleServerId(value) ? value : null;
}

export function buildRemoteDesktopAppUrl(serverId?: string, origin = ''): string {
  if (serverId === undefined) return `${origin}${REMOTE_DESKTOP_APP_START_URL}`;
  if (!isPlausibleServerId(serverId)) throw new Error('invalid_remote_desktop_server_id');
  return `${origin}${REMOTE_DESKTOP_APP_START_URL}?${REMOTE_DESKTOP_APP_MACHINE_QUERY}=${encodeURIComponent(serverId)}`;
}

/** A request path that belongs to the app's static assets: when the file is missing it is a 404, never the SPA's index.html. */
export function isRemoteDesktopAppAssetPath(pathname: string): boolean {
  return pathname === REMOTE_DESKTOP_APP_ASSET_DIR || pathname.startsWith(`${REMOTE_DESKTOP_APP_ASSET_DIR}/`);
}
