import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  daemonR2ManifestUrl,
  daemonR2TarballUrl,
  parseDaemonR2Manifest,
  resolveDaemonR2BaseUrl,
  resolveDaemonR2Channel,
  type DaemonR2Channel,
  type DaemonR2NpmManifest,
} from '../../shared/daemon-r2-package.js';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MANIFEST_TIMEOUT_MS = 8_000;
const DEFAULT_TARBALL_TIMEOUT_MS = 120_000;

export function isLocalTarballPkgSpec(pkgSpec: string): boolean {
  return /\.(?:tgz|tar\.gz)$/i.test(pkgSpec.trim());
}

function assertHttpsUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('refused non-HTTPS or credential-bearing R2 URL');
  }
  return parsed;
}

async function fetchHttpsWithRedirects(
  fetchImpl: typeof fetch,
  initialUrl: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<Response> {
  let current = assertHttpsUrl(initialUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current.toString(), {
      method: 'GET',
      ...(hop === 0 && headers ? { headers } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel?.().catch(() => {});
      if (hop >= MAX_REDIRECTS) {
        throw new Error('too many R2 redirects');
      }
      const location = response.headers.get('location')?.trim() ?? '';
      if (!location) {
        throw new Error('R2 redirect missing Location header');
      }
      current = assertHttpsUrl(new URL(location, current).toString());
      continue;
    }
    return response;
  }
  throw new Error('too many R2 redirects');
}

export type ResolveDaemonR2VersionResult =
  | { ok: true; channel: DaemonR2Channel; version: string; manifest: DaemonR2NpmManifest; baseUrl: string }
  | { ok: false; reason: string };

export async function resolveDaemonR2LatestVersion(input: {
  targetVersion?: string | null;
  currentVersion?: string | null;
  channel?: string | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ResolveDaemonR2VersionResult> {
  const env = input.env ?? process.env;
  const baseUrl = resolveDaemonR2BaseUrl(env);
  if (!baseUrl) return { ok: false, reason: 'r2_disabled_or_invalid_base' };

  const channel = resolveDaemonR2Channel({
    targetVersion: input.targetVersion,
    currentVersion: input.currentVersion,
    channel: input.channel,
  });
  const manifestUrl = daemonR2ManifestUrl(baseUrl, channel, env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX);
  if (!manifestUrl) return { ok: false, reason: 'r2_invalid_prefix' };

  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchHttpsWithRedirects(
      fetchImpl,
      manifestUrl,
      input.timeoutMs ?? DEFAULT_MANIFEST_TIMEOUT_MS,
      { accept: 'application/json' },
    );
  } catch (err) {
    return { ok: false, reason: `manifest_fetch_failed:${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `manifest_http_${response.status}` };
  }
  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    return { ok: false, reason: 'manifest_invalid_json' };
  }
  const manifest = parseDaemonR2Manifest(rawJson);
  if (!manifest || manifest.channel !== channel) {
    return { ok: false, reason: 'manifest_invalid_schema' };
  }
  const pinnedTarget = input.targetVersion?.trim();
  if (pinnedTarget && pinnedTarget !== 'latest' && pinnedTarget !== 'dev' && manifest.version !== pinnedTarget) {
    return { ok: false, reason: 'version_mismatch' };
  }
  return { ok: true, channel, version: manifest.version, manifest, baseUrl };
}

export type ResolveAndDownloadDaemonR2TarballResult =
  | {
      ok: true;
      tarballPath: string;
      channel: DaemonR2Channel;
      version: string;
      expectedBytes: number;
      manifest: DaemonR2NpmManifest;
    }
  | { ok: false; reason: string };

export async function resolveAndDownloadDaemonR2Tarball(input: {
  targetVersion?: string | null;
  currentVersion?: string | null;
  channel?: string | null;
  destDir: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  manifestTimeoutMs?: number;
  downloadTimeoutMs?: number;
}): Promise<ResolveAndDownloadDaemonR2TarballResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const resolved = await resolveDaemonR2LatestVersion({
    targetVersion: input.targetVersion,
    currentVersion: input.currentVersion,
    channel: input.channel,
    env,
    fetchImpl,
    timeoutMs: input.manifestTimeoutMs,
  });
  if (!resolved.ok) return resolved;

  const tarballUrl = daemonR2TarballUrl(
    resolved.baseUrl,
    resolved.channel,
    env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX,
  );
  if (!tarballUrl) return { ok: false, reason: 'r2_invalid_prefix' };

  const tarballPath = join(input.destDir, 'imcodes-r2.tgz');
  try {
    const response = await fetchHttpsWithRedirects(
      fetchImpl,
      tarballUrl,
      input.downloadTimeoutMs ?? DEFAULT_TARBALL_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { ok: false, reason: `tarball_http_${response.status}` };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== resolved.manifest.sizeBytes) {
      return { ok: false, reason: 'tarball_size_mismatch' };
    }
    const actualSha = createHash('sha256').update(bytes).digest('hex');
    if (actualSha !== resolved.manifest.sha256) {
      return { ok: false, reason: 'tarball_sha256_mismatch' };
    }
    mkdirSync(input.destDir, { recursive: true });
    writeFileSync(tarballPath, bytes);
    const expectedBytes = resolved.manifest.unpackedSizeBytes ?? (resolved.manifest.sizeBytes * 3);
    return {
      ok: true,
      tarballPath,
      channel: resolved.channel,
      version: resolved.version,
      expectedBytes,
      manifest: resolved.manifest,
    };
  } catch (err) {
    try { rmSync(tarballPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason: `tarball_download_failed:${err instanceof Error ? err.message : String(err)}` };
  }
}
