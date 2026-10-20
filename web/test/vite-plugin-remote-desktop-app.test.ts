import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_APP_MANIFEST_MIME,
  REMOTE_DESKTOP_APP_MANIFEST_PATH,
  serializeRemoteDesktopAppManifest,
} from '../../shared/remote-desktop-app';
import { remoteDesktopAppManifestPlugin } from '../vite-plugin-remote-desktop-app';

describe('the build emits the remote desktop app manifest', () => {
  const plugin = remoteDesktopAppManifestPlugin();

  it('emits it as a build asset at the path the page links, with the text the shared description produces', () => {
    const emitFile = vi.fn();
    (plugin.generateBundle as unknown as (this: { emitFile: typeof emitFile }) => void).call({ emitFile });
    expect(emitFile).toHaveBeenCalledTimes(1);
    expect(emitFile).toHaveBeenCalledWith({
      type: 'asset',
      fileName: REMOTE_DESKTOP_APP_MANIFEST_PATH.slice(1),
      source: serializeRemoteDesktopAppManifest(),
    });
  });

  it('serves the same text in the dev server, with the manifest MIME, and leaves every other request alone', () => {
    const middlewares: Array<(req: { url?: string }, res: unknown, next: () => void) => void> = [];
    (plugin.configureServer as unknown as (server: unknown) => void)({ middlewares: { use: (fn: (typeof middlewares)[number]) => middlewares.push(fn) } });
    expect(middlewares).toHaveLength(1);
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => { headers[name] = value; }, end: vi.fn() };
    const next = vi.fn();
    middlewares[0]!({ url: `${REMOTE_DESKTOP_APP_MANIFEST_PATH}?v=1` }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(headers['Content-Type']).toBe(REMOTE_DESKTOP_APP_MANIFEST_MIME);
    expect(res.end).toHaveBeenCalledWith(serializeRemoteDesktopAppManifest());
    middlewares[0]!({ url: '/remote-desktop/app/' }, res, next);
    middlewares[0]!({ url: undefined }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('is registered in the web build', () => {
    const config = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');
    expect(config).toContain('remoteDesktopAppManifestPlugin()');
  });

  it('is not linked from the main page: only the remote desktop UI advertises the app (the link is added at run time)', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    expect(html).not.toMatch(/rel=["']manifest["']/i);
  });

  it('adds no service worker (installation does not need one; a cache only adds upgrade problems)', () => {
    const config = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');
    expect(config).not.toMatch(/vite-plugin-pwa|workbox|serviceWorker/i);
    expect(readFileSync(resolve(__dirname, '../index.html'), 'utf8')).not.toMatch(/serviceWorker/);
  });
});
