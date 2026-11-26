import { describe, expect, it } from 'vitest';
import appAssets from '../../shared/remote-desktop-app.json' with { type: 'json' };
import {
  REMOTE_DESKTOP_APP_ASSET_DIR,
  REMOTE_DESKTOP_APP_ICON_FILES,
  REMOTE_DESKTOP_APP_ID,
  REMOTE_DESKTOP_APP_MANIFEST_PATH,
  REMOTE_DESKTOP_APP_PATH,
  REMOTE_DESKTOP_APP_SCOPE,
  REMOTE_DESKTOP_APP_START_URL,
  buildRemoteDesktopAppManifest,
  buildRemoteDesktopAppUrl,
  isRemoteDesktopAppAssetPath,
  isRemoteDesktopAppPath,
  readRemoteDesktopAppMachineId,
  serializeRemoteDesktopAppManifest,
} from '../../shared/remote-desktop-app.js';

/** Is `path` something an app with scope `scope` controls? (The manifest's rule: a plain prefix match.) */
const inScope = (path: string, scope = REMOTE_DESKTOP_APP_SCOPE) => path.startsWith(scope);

describe('the installable remote desktop app: manifest', () => {
  const manifest = buildRemoteDesktopAppManifest();

  it('starts inside its own scope, and its identity does not move with start_url', () => {
    expect(inScope(manifest.start_url)).toBe(true);
    expect(manifest.scope).toBe(REMOTE_DESKTOP_APP_SCOPE);
    expect(manifest.start_url).toBe(REMOTE_DESKTOP_APP_START_URL);
    expect(manifest.id).toBe(REMOTE_DESKTOP_APP_ID);
  });

  it('has a scope that captures nothing but the app: not the main site, not the guest access page, not its own assets', () => {
    expect(REMOTE_DESKTOP_APP_SCOPE.endsWith('/')).toBe(true);
    expect(REMOTE_DESKTOP_APP_SCOPE).not.toBe('/');
    for (const outside of ['/', '/index.html', '/?remoteDesktopServer=abc', '/remote-desktop/access', '/remote-desktop/access?invite=1', '/remote-desktop/native-step-up', '/api/server/x/upgrade']) {
      expect(inScope(outside), outside).toBe(false);
    }
    // the manifest and icons must stay reachable from pages outside the scope
    expect(inScope(REMOTE_DESKTOP_APP_MANIFEST_PATH)).toBe(false);
    for (const icon of manifest.icons) expect(inScope(icon.src), icon.src).toBe(false);
    // the deep link stays inside it
    expect(inScope(buildRemoteDesktopAppUrl('server-1'))).toBe(true);
  });

  it('is displayed as an app window, with a fallback chain that never shows the address bar of a tab', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.display_override[0]).toBe('standalone');
    expect(manifest.display_override).not.toContain('browser');
    // no title bar of our own is drawn, so the overlay mode would leave an unusable strip
    expect(manifest.display_override).not.toContain('window-controls-overlay');
  });

  it('lists a 192, a 512 and a maskable 512 icon, each at a path under the asset directory', () => {
    const summary = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}:${icon.type}`);
    expect(summary).toEqual(['192x192:any:image/png', '512x512:any:image/png', '512x512:maskable:image/png']);
    for (const icon of manifest.icons) expect(icon.src.startsWith(`${REMOTE_DESKTOP_APP_ASSET_DIR}/`)).toBe(true);
    expect(manifest.icons.map((icon) => icon.src)).toEqual(REMOTE_DESKTOP_APP_ICON_FILES.map((icon) => icon.path));
  });

  it('is one description for the generator and the code: the JSON both read is the source of the asset directory', () => {
    expect(REMOTE_DESKTOP_APP_ASSET_DIR).toBe(appAssets.assetDir);
    expect(REMOTE_DESKTOP_APP_MANIFEST_PATH.startsWith(`${appAssets.assetDir}/`)).toBe(true);
  });

  it('serializes as valid JSON ending in a newline (what the build emits)', () => {
    const text = serializeRemoteDesktopAppManifest();
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(manifest);
  });

  it('does not ask for a service worker anywhere', () => {
    expect(JSON.stringify(manifest)).not.toMatch(/service[-_ ]?worker|serviceworker/i);
  });
});

describe('the app entry and its deep link', () => {
  it('recognises the entry with and without the trailing slash, and nothing else under /remote-desktop/', () => {
    expect(isRemoteDesktopAppPath(REMOTE_DESKTOP_APP_PATH)).toBe(true);
    expect(isRemoteDesktopAppPath(REMOTE_DESKTOP_APP_SCOPE)).toBe(true);
    for (const other of ['/', '/remote-desktop', '/remote-desktop/', '/remote-desktop/access', '/remote-desktop/appx', '/remote-desktop/app/extra', '/remote-desktop/app.html']) {
      expect(isRemoteDesktopAppPath(other), other).toBe(false);
    }
  });

  it('reads a machine only when it is a plausible server id', () => {
    expect(readRemoteDesktopAppMachineId('?machine=srv_1-A')).toBe('srv_1-A');
    for (const search of ['', '?machine=', '?machine=a/b', '?machine=a b', '?machine=<x>', `?machine=${'x'.repeat(129)}`, '?other=srv']) {
      expect(readRemoteDesktopAppMachineId(search), search).toBeNull();
    }
  });

  it('builds the deep link with the server id in the query (so it is routed to the pod holding the daemon) and refuses a bad id', () => {
    expect(buildRemoteDesktopAppUrl()).toBe(REMOTE_DESKTOP_APP_START_URL);
    expect(buildRemoteDesktopAppUrl('srv-1', 'https://im.example')).toBe('https://im.example/remote-desktop/app/?machine=srv-1');
    expect(() => buildRemoteDesktopAppUrl('bad id')).toThrow('invalid_remote_desktop_server_id');
    expect(readRemoteDesktopAppMachineId(new URL(buildRemoteDesktopAppUrl('srv-1'), 'https://x').search)).toBe('srv-1');
  });

  it('treats only the asset directory as assets that must never fall back to the SPA page', () => {
    expect(isRemoteDesktopAppAssetPath(REMOTE_DESKTOP_APP_MANIFEST_PATH)).toBe(true);
    expect(isRemoteDesktopAppAssetPath(`${REMOTE_DESKTOP_APP_ASSET_DIR}/missing.png`)).toBe(true);
    expect(isRemoteDesktopAppAssetPath(REMOTE_DESKTOP_APP_ASSET_DIR)).toBe(true);
    for (const other of ['/', '/remote-desktop/app/', '/remote-desktop-appx/icon.png', '/remote-desktop/access', '/assets/x.js']) {
      expect(isRemoteDesktopAppAssetPath(other), other).toBe(false);
    }
  });
});
