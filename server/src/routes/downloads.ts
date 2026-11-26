import { createHash } from 'node:crypto';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Hono, type Context } from 'hono';
import type { Env, EnvConfig } from '../env.js';
import {
  extractArtifactDistributionEnv,
  loadReleaseArtifactsManifest,
  resolveArtifactChannel,
  resolveControlledNodeManifestEntryByKey,
  resolveGitHubReleasesUrl,
  resolveR2ObjectUrl,
  type ArtifactReleaseChannel,
} from '../services/controlled-node-artifact-distribution.js';

interface AndroidTargetSpec {
  kind: 'android';
  r2Key: string;
}

interface DesktopTargetSpec {
  kind: 'desktop';
  asset: string;
  os: string;
  arch: string;
}

type DownloadTargetSpec = AndroidTargetSpec | DesktopTargetSpec;

const DOWNLOAD_TARGETS: Readonly<Record<string, DownloadTargetSpec>> = Object.freeze({
  'android-with-fcm': { kind: 'android', r2Key: 'android/imcodes-with-fcm-latest.apk' },
  'android-without-fcm': { kind: 'android', r2Key: 'android/imcodes-without-fcm-latest.apk' },
  'desktop-mac': { kind: 'desktop', asset: 'desktop-installer-pkg', os: 'mac', arch: 'arm64' },
  'desktop-mac-intel': { kind: 'desktop', asset: 'desktop-installer-pkg', os: 'mac', arch: 'x64' },
  'desktop-win': { kind: 'desktop', asset: 'desktop-installer-exe', os: 'win', arch: 'x64' },
  'desktop-linux-deb': { kind: 'desktop', asset: 'desktop-installer-deb', os: 'linux', arch: 'x64' },
  'desktop-linux-sh': { kind: 'desktop', asset: 'desktop-installer-sh', os: 'linux', arch: 'x64' },
});

function setSecurityHeaders(c: Context): void {
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
}

function parseChannelQuery(raw: string | undefined): { valid: true; channel?: ArtifactReleaseChannel } | { valid: false } {
  if (raw === undefined) return { valid: true };
  if (raw === 'master' || raw === 'dev') return { valid: true, channel: raw };
  return { valid: false };
}

function resolveContainedRegularPath(baseDir: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/gu, '/').trim();
  if (!normalized || normalized.startsWith('/')) return null;
  const segments = normalized.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return null;
  const root = resolve(baseDir);
  const full = resolve(root, ...segments);
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  return full;
}

async function openVerifiedLocalInstaller(
  dir: string,
  relativePath: string,
  expectedSha256: string,
  expectedSizeBytes: number,
): Promise<{ handle: FileHandle; sizeBytes: number; close: () => Promise<void> } | null> {
  const fullPath = resolveContainedRegularPath(dir, relativePath);
  if (!fullPath) return null;
  let handle: FileHandle | null = null;
  try {
    const pathStat = await lstat(fullPath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size !== expectedSizeBytes || pathStat.size <= 0) {
      return null;
    }
    handle = await open(fullPath, 'r');
    const fdStat = await handle.stat();
    if (!fdStat.isFile() || fdStat.size !== pathStat.size || fdStat.mtimeMs !== pathStat.mtimeMs) {
      return null;
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (pos < fdStat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, fdStat.size - pos), pos);
      if (bytesRead <= 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      pos += bytesRead;
    }
    if (hash.digest('hex') !== expectedSha256.toLowerCase()) return null;
    const pinned = handle;
    handle = null;
    let closed = false;
    return {
      handle: pinned,
      sizeBytes: fdStat.size,
      close: async () => {
        if (closed) return;
        closed = true;
        await pinned.close().catch(() => {});
      },
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createDownloadsRoutes(
  artifactDirectory: () => string | undefined = () => process.env.IMCODES_NODE_EXE_DIR,
): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/latest/:target', async (c) => {
    setSecurityHeaders(c);
    const targetName = c.req.param('target');
    const spec = Object.prototype.hasOwnProperty.call(DOWNLOAD_TARGETS, targetName)
      ? DOWNLOAD_TARGETS[targetName]
      : undefined;
    if (!spec) {
      return c.json({ error: 'not_found' }, 404);
    }

    const channelQuery = parseChannelQuery(c.req.query('channel'));
    if (!channelQuery.valid) {
      return c.json({ error: 'invalid_channel' }, 400);
    }

    const env = extractArtifactDistributionEnv((c.env ?? {}) as Partial<EnvConfig>);
    const dir = artifactDirectory()?.trim();
    const manifest = dir ? await loadReleaseArtifactsManifest(dir) : null;
    const serverChannel: ArtifactReleaseChannel = resolveArtifactChannel(manifest?.version);
    const channel: ArtifactReleaseChannel = channelQuery.channel ?? serverChannel;

    if (spec.kind === 'android') {
      const r2Url = resolveR2ObjectUrl(env, `${channel}/${spec.r2Key}`);
      const location = r2Url ?? resolveGitHubReleasesUrl(env, channel);
      c.header('Location', location);
      return c.body(null, 302);
    }

    if (channelQuery.channel && channelQuery.channel !== serverChannel) {
      c.header('Location', resolveGitHubReleasesUrl(env, channelQuery.channel));
      return c.body(null, 302);
    }

    if (!dir) {
      return c.json({ error: 'not_found' }, 404);
    }

    const resolved = await resolveControlledNodeManifestEntryByKey(dir, env, {
      asset: spec.asset,
      os: spec.os,
      arch: spec.arch,
    });
    if (!resolved) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (resolved.external) {
      c.header('Location', resolved.external.url);
      return c.body(null, 302);
    }

    const opened = await openVerifiedLocalInstaller(
      dir,
      resolved.entry.relativePath,
      resolved.entry.sha256,
      resolved.entry.sizeBytes,
    );
    if (!opened) {
      return c.json({ error: 'not_found' }, 404);
    }

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = Buffer.alloc(64 * 1024);
        try {
          const { bytesRead } = await opened.handle.read(chunk, 0, chunk.length, null);
          if (bytesRead <= 0) {
            await opened.close();
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunk.subarray(0, bytesRead)));
        } catch (err) {
          await opened.close();
          controller.error(err);
        }
      },
      async cancel() {
        await opened.close();
      },
    });
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Length', String(opened.sizeBytes));
    c.header('Content-Disposition', `attachment; filename="${resolved.entry.assetFilename}"`);
    return c.body(stream as unknown as ReadableStream, 200);
  });

  return routes;
}

export const downloadsRoutes = createDownloadsRoutes();
