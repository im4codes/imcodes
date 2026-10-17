import type { Plugin } from 'vite';
import {
  REMOTE_DESKTOP_APP_MANIFEST_MIME,
  REMOTE_DESKTOP_APP_MANIFEST_PATH,
  serializeRemoteDesktopAppManifest,
} from '../shared/remote-desktop-app';

/**
 * Emits the installable remote-desktop app's web manifest from the one description in shared/remote-desktop-app.ts (so the manifest, the
 * entry routing, the server's asset guard and the tests can never disagree about the scope or the icon paths), and serves the same text in
 * `vite dev`. The icons are committed under public/ (rendered from the official logo by scripts/aidesk-icon.mjs); there is no service worker.
 */
export function remoteDesktopAppManifestPlugin(): Plugin {
  const fileName = REMOTE_DESKTOP_APP_MANIFEST_PATH.replace(/^\//, '');
  return {
    name: 'imcodes-remote-desktop-app-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source: serializeRemoteDesktopAppManifest() });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== REMOTE_DESKTOP_APP_MANIFEST_PATH) return next();
        res.setHeader('Content-Type', REMOTE_DESKTOP_APP_MANIFEST_MIME);
        res.setHeader('Cache-Control', 'no-cache');
        res.end(serializeRemoteDesktopAppManifest());
      });
    },
  };
}
