/**
 * The installable remote desktop app is served by the server's static handler: its manifest, its icons, and its entry page. Three traps
 * this pins: the manifest must not be served as application/octet-stream, a missing manifest/icon must be a 404 (the SPA fallback would
 * hand the browser index.html as a manifest or an icon, a silent install failure), and the entry page must still be the SPA.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import {
  REMOTE_DESKTOP_APP_ASSET_DIR,
  REMOTE_DESKTOP_APP_ICON_FILES,
  REMOTE_DESKTOP_APP_MANIFEST_MIME,
  REMOTE_DESKTOP_APP_MANIFEST_PATH,
  REMOTE_DESKTOP_APP_SCOPE,
  serializeRemoteDesktopAppManifest,
} from '../../shared/remote-desktop-app.js';

const SPA_MARKER = '<!doctype html><html><body>spa-shell</body></html>';
const dists: string[] = [];

function env(): Env {
  return {
    DB: {} as Database,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  };
}

/** A web build output directory; `withAppAssets: false` is a web build that predates the app (or lost its public files). */
function makeDist(withAppAssets: boolean): string {
  const dist = mkdtempSync(join(tmpdir(), 'imcodes-web-dist-'));
  dists.push(dist);
  writeFileSync(join(dist, 'index.html'), SPA_MARKER);
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  if (withAppAssets) {
    mkdirSync(join(dist, REMOTE_DESKTOP_APP_ASSET_DIR.slice(1)), { recursive: true });
    writeFileSync(join(dist, REMOTE_DESKTOP_APP_MANIFEST_PATH.slice(1)), serializeRemoteDesktopAppManifest());
    const realIcons = join(__dirname, '..', '..', 'web', 'public', 'remote-desktop-app');
    for (const icon of REMOTE_DESKTOP_APP_ICON_FILES) {
      writeFileSync(join(dist, icon.path.slice(1)), readFileSync(join(realIcons, icon.file)));
    }
  }
  return dist;
}

/** The server module reads WEB_DIST_PATH when it loads, so each dist needs a fresh module instance. */
async function appFor(dist: string) {
  vi.resetModules();
  process.env.WEB_DIST_PATH = dist;
  const { buildApp } = await import('../src/index.js');
  return buildApp(env());
}

// Loading the whole server module the first time is slow on a cold or busy machine: that cost belongs to setup, not to the first test.
vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => { await import('../src/index.js'); }, 120_000);
beforeEach(() => { delete process.env.WEB_DIST_PATH; });
afterEach(() => {
  delete process.env.WEB_DIST_PATH;
  for (const dist of dists.splice(0)) rmSync(dist, { recursive: true, force: true });
});

describe('the remote desktop app is served as an installable web app', () => {
  it('serves the manifest as application/manifest+json, revalidated each time, with the content the build emits', async () => {
    const app = await appFor(makeDist(true));
    const response = await app.request(REMOTE_DESKTOP_APP_MANIFEST_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(REMOTE_DESKTOP_APP_MANIFEST_MIME);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe(serializeRemoteDesktopAppManifest());
  });

  it('serves every icon the manifest names as a PNG', async () => {
    const app = await appFor(makeDist(true));
    for (const icon of REMOTE_DESKTOP_APP_ICON_FILES) {
      const response = await app.request(icon.path);
      expect(response.status, icon.path).toBe(200);
      expect(response.headers.get('content-type'), icon.path).toBe('image/png');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(Array.from(bytes.slice(1, 4)), icon.path).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    }
  });

  it('serves the entry page (with and without the trailing slash) and the guest page as the SPA, with the security headers', async () => {
    const app = await appFor(makeDist(true));
    for (const path of [REMOTE_DESKTOP_APP_SCOPE, REMOTE_DESKTOP_APP_SCOPE.slice(0, -1), `${REMOTE_DESKTOP_APP_SCOPE}?machine=srv-1`, '/remote-desktop/access']) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe('text/html');
      expect(await response.text(), path).toBe(SPA_MARKER);
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
    }
  });

  it('does not block the manifest or the icons with its own CSP (manifest-src falls back to default-src, which allows the same origin)', async () => {
    const app = await appFor(makeDist(true));
    const csp = (await app.request(REMOTE_DESKTOP_APP_SCOPE)).headers.get('content-security-policy') ?? '';
    const directive = (name: string) => csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
    const manifestSource = directive('manifest-src') ?? directive('default-src');
    expect(manifestSource).toContain("'self'");
    expect(directive('img-src')).toContain("'self'");
  });

  it('still falls back to the SPA for other unknown paths (the guard is only for the app assets)', async () => {
    const app = await appFor(makeDist(true));
    for (const path of ['/some/deep/link', '/remote-desktop/app/unknown-page', '/remote-desktop-appx/icon.png']) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(SPA_MARKER);
    }
  });
});

describe('a missing app asset is a 404, never the SPA page', () => {
  it('answers 404 for a manifest that is not in the build, and for an icon that is not there', async () => {
    const app = await appFor(makeDist(false));
    for (const path of [REMOTE_DESKTOP_APP_MANIFEST_PATH, REMOTE_DESKTOP_APP_ICON_FILES[0]!.path, `${REMOTE_DESKTOP_APP_ASSET_DIR}/no-such-file.png`, `${REMOTE_DESKTOP_APP_ASSET_DIR}/`, REMOTE_DESKTOP_APP_ASSET_DIR]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain('spa-shell');
    }
  });

  it('keeps serving the entry page itself when the assets are missing (the app still works in a tab)', async () => {
    const app = await appFor(makeDist(false));
    const response = await app.request(REMOTE_DESKTOP_APP_SCOPE);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SPA_MARKER);
  });
});
