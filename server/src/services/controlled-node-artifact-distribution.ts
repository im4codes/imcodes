import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnvConfig } from '../env.js';
import { presignR2Artifact, r2CredentialsFromEnv } from './r2-relay.js';
import type { ControlledNodeAbiProfile } from '../../../shared/controlled-node-abi.js';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME,
  CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION,
  controlledNodeReleaseArtifactEntryKey,
  type ControlledNodeReleaseArtifactEntry,
  type ControlledNodeReleaseArtifactsManifest,
} from '../../../shared/controlled-node-artifacts.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_TAG_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_PREFIX_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const SAFE_FLAT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_GITHUB_BASE_URL = 'https://github.com';
export const DEFAULT_CONTROLLED_NODE_ARTIFACT_R2_BASE_URL = 'https://dl.im.codes';

export type ControlledNodeDistributionTier = 'r2' | 'github' | 'docker';
export type ArtifactReleaseChannel = 'master' | 'dev';

export function resolveArtifactChannel(version?: string): ArtifactReleaseChannel {
  return version?.includes('-dev.') ? 'dev' : 'master';
}

export interface ResolvedExternalArtifactDistribution {
  tier: 'r2' | 'github';
  url: string;
  entry: ControlledNodeReleaseArtifactEntry;
}

export interface VerifyExternalArtifactIdentity {
  asset: string;
  os?: string;
  arch?: string;
  abiProfile?: ControlledNodeAbiProfile;
  sha256: string;
  sizeBytes: number;
  version?: string;
  authenticodeSignerSha256?: string;
}

const R2_MANIFEST_FETCH_TIMEOUT_MS = 3_000;
const R2_MANIFEST_CACHE_HIT_TTL_MS = 60_000;
const R2_MANIFEST_CACHE_ERROR_TTL_MS = 15_000;
const R2_MANIFEST_CACHE_MAX_ENTRIES = 64;

interface CachedManifest {
  fileKey: string;
  manifest: ControlledNodeReleaseArtifactsManifest | null;
}

interface CachedR2Manifest {
  expiresAt: number;
  manifest: ControlledNodeReleaseArtifactsManifest | null;
}

const manifestCache = new Map<string, CachedManifest>();
const r2ManifestCache = new Map<string, CachedR2Manifest>();
const r2ManifestInFlight = new Map<string, Promise<ControlledNodeReleaseArtifactsManifest | null>>();
let r2ManifestFetchImpl: typeof fetch | null = null;

function parseHttpsBaseUrl(raw?: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeR2Prefix(raw?: string): string {
  const trimmed = raw?.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  if (!SAFE_PREFIX_RE.test(trimmed) || trimmed.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error('invalid_r2_prefix');
  }
  return `${trimmed}/`;
}

function isValidEntry(value: unknown): value is ControlledNodeReleaseArtifactEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.asset !== 'string' || !entry.asset) return false;
  if (typeof entry.assetFilename !== 'string' || !SAFE_FLAT_FILENAME_RE.test(entry.assetFilename)) return false;
  if (typeof entry.relativePath !== 'string' || !entry.relativePath) return false;
  if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) return false;
  if (typeof entry.sizeBytes !== 'number' || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0) return false;
  if (entry.version !== undefined && typeof entry.version !== 'string') return false;
  if (entry.authenticodeSignerSha256 !== undefined
    && (typeof entry.authenticodeSignerSha256 !== 'string' || !SHA256_RE.test(entry.authenticodeSignerSha256))) {
    return false;
  }
  return true;
}

function parseReleaseArtifactsManifestObject(
  parsed: unknown,
): ControlledNodeReleaseArtifactsManifest | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION
    || !record.artifacts || typeof record.artifacts !== 'object' || Array.isArray(record.artifacts)) {
    return null;
  }
  const cleanArtifacts: Record<string, ControlledNodeReleaseArtifactEntry> = {};
  for (const [k, v] of Object.entries(record.artifacts as Record<string, unknown>)) {
    if (isValidEntry(v)) cleanArtifacts[k] = v;
  }
  return {
    schemaVersion: CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION,
    ...(typeof record.version === 'string' && record.version.trim() ? { version: record.version.trim() } : {}),
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
    artifacts: cleanArtifacts,
  };
}

export async function loadReleaseArtifactsManifest(
  dir: string,
): Promise<ControlledNodeReleaseArtifactsManifest | null> {
  const path = join(dir, CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME);
  let handle = null;
  try {
    const pathStat = await lstat(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size <= 0 || pathStat.size > MAX_MANIFEST_BYTES) {
      manifestCache.delete(dir);
      return null;
    }
    const fileKey = `${pathStat.dev ?? ''}:${pathStat.ino ?? ''}:${pathStat.size}:${pathStat.mtimeMs}:${pathStat.ctimeMs}`;
    const cached = manifestCache.get(dir);
    if (cached && cached.fileKey === fileKey) {
      return cached.manifest;
    }

    const noFollow = typeof (await import('node:fs')).constants.O_NOFOLLOW === 'number'
      ? (await import('node:fs')).constants.O_NOFOLLOW
      : 0;
    handle = await open(path, (await import('node:fs')).constants.O_RDONLY | noFollow);
    const fdStat = await handle.stat();
    if (!fdStat.isFile() || fdStat.size !== pathStat.size || fdStat.mtimeMs !== pathStat.mtimeMs) {
      return null;
    }
    const parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
    const manifest = parseReleaseArtifactsManifestObject(parsed);
    if (!manifest) {
      manifestCache.set(dir, { fileKey, manifest: null });
      return null;
    }
    manifestCache.set(dir, { fileKey, manifest });
    return manifest;
  } catch {
    manifestCache.delete(dir);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function invalidateReleaseArtifactsManifestCache(dir?: string): void {
  if (dir) manifestCache.delete(dir);
  else manifestCache.clear();
}

export function invalidateR2ReleaseManifestCache(): void {
  r2ManifestCache.clear();
  r2ManifestInFlight.clear();
}

export function setR2ManifestFetchForTests(fetchImpl: typeof fetch | null): void {
  r2ManifestFetchImpl = fetchImpl;
  invalidateR2ReleaseManifestCache();
}

function findVerifiedManifestEntry(
  manifest: ControlledNodeReleaseArtifactsManifest,
  identity: VerifyExternalArtifactIdentity,
): ControlledNodeReleaseArtifactEntry | null {
  const keys = [controlledNodeReleaseArtifactEntryKey(identity)];
  if (identity.asset === CONTROLLED_NODE_ARTIFACT_ASSETS.DESKTOP_RELEASE_MANIFEST && (identity.os || identity.arch)) {
    keys.push(controlledNodeReleaseArtifactEntryKey({ asset: identity.asset }));
  }
  for (const key of keys) {
    const entry = manifest.artifacts[key];
    if (!entry) continue;
    if (entry.sha256 !== identity.sha256.toLowerCase()) continue;
    if (entry.sizeBytes !== identity.sizeBytes) continue;
    if (identity.version && entry.version && entry.version !== identity.version) continue;
    if (identity.authenticodeSignerSha256
      && entry.authenticodeSignerSha256
      && entry.authenticodeSignerSha256 !== identity.authenticodeSignerSha256.toLowerCase()) {
      continue;
    }
    return entry;
  }
  return null;
}

export function extractArtifactDistributionEnv(
  ctxEnv: Partial<EnvConfig> = {},
): Partial<EnvConfig> {
  return {
    USE_R2_RELAY: ctxEnv.USE_R2_RELAY ?? process.env.USE_R2_RELAY,
    R2_ACCOUNT_ID: ctxEnv.R2_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID,
    R2_BUCKET: ctxEnv.R2_BUCKET ?? process.env.R2_BUCKET,
    R2_ACCESS_KEY_ID: ctxEnv.R2_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: ctxEnv.R2_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY,
    USE_R2_ARTIFACT: ctxEnv.USE_R2_ARTIFACT ?? process.env.USE_R2_ARTIFACT,
    CONTROLLED_NODE_ARTIFACT_R2_BASE_URL:
      ctxEnv.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL ?? process.env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL,
    CONTROLLED_NODE_ARTIFACT_R2_PREFIX:
      ctxEnv.CONTROLLED_NODE_ARTIFACT_R2_PREFIX ?? process.env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX,
    CONTROLLED_NODE_ARTIFACT_GITHUB_REPO:
      ctxEnv.CONTROLLED_NODE_ARTIFACT_GITHUB_REPO ?? process.env.CONTROLLED_NODE_ARTIFACT_GITHUB_REPO,
    CONTROLLED_NODE_ARTIFACT_GITHUB_TAG:
      ctxEnv.CONTROLLED_NODE_ARTIFACT_GITHUB_TAG ?? process.env.CONTROLLED_NODE_ARTIFACT_GITHUB_TAG,
    CONTROLLED_NODE_ARTIFACT_GITHUB_BASE_URL:
      ctxEnv.CONTROLLED_NODE_ARTIFACT_GITHUB_BASE_URL ?? process.env.CONTROLLED_NODE_ARTIFACT_GITHUB_BASE_URL,
  };
}

export function resolveR2ObjectUrl(
  env: Partial<EnvConfig>,
  relativeKey: string,
): string | null {
  if (env.USE_R2_ARTIFACT === 'false') return null;
  const cleanKey = relativeKey.trim().replace(/^\/+/u, '');
  if (!cleanKey || cleanKey.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    return null;
  }
  let prefix = '';
  try {
    prefix = normalizeR2Prefix(env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX);
  } catch {
    return null;
  }
  const key = `${prefix}${cleanKey}`;
  const encodedPath = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const explicitBase = env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL;
  if (explicitBase !== undefined) {
    if (explicitBase.trim() !== '') {
      const publicBase = parseHttpsBaseUrl(explicitBase);
      if (!publicBase) return null;
      return `${publicBase}/${encodedPath}`;
    }
    if (env.USE_R2_ARTIFACT === 'true') {
      const creds = r2CredentialsFromEnv(env);
      if (!creds) return null;
      try {
        return presignR2Artifact(creds, key, 300);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (env.USE_R2_ARTIFACT === 'true') {
    const creds = r2CredentialsFromEnv(env);
    if (creds) {
      try {
        return presignR2Artifact(creds, key, 300);
      } catch {
        return null;
      }
    }
  }
  return `${DEFAULT_CONTROLLED_NODE_ARTIFACT_R2_BASE_URL}/${encodedPath}`;
}

function resolveR2Url(
  env: Partial<EnvConfig>,
  manifest: ControlledNodeReleaseArtifactsManifest,
  entry: ControlledNodeReleaseArtifactEntry,
): string | null {
  const channel = resolveArtifactChannel(manifest.version ?? entry.version);
  const url = resolveR2ObjectUrl(env, `${channel}/${entry.assetFilename}`);
  if (!url) return null;
  // Append a content-addressed query parameter on public CDN URLs to bust
  // Cloudflare's default 4h edge cache across mutable channel paths, while
  // never mutating SigV4 presigned URLs that already carry query signatures.
  return url.includes('?') ? url : `${url}?v=${entry.sha256.slice(0, 16)}`;
}

function resolveGitHubUrl(
  env: Partial<EnvConfig>,
  manifest: ControlledNodeReleaseArtifactsManifest,
  entry: ControlledNodeReleaseArtifactEntry,
): string | null {
  const repo = env.CONTROLLED_NODE_ARTIFACT_GITHUB_REPO?.trim();
  if (!repo || !GITHUB_REPO_RE.test(repo)) return null;
  const rawBase = env.CONTROLLED_NODE_ARTIFACT_GITHUB_BASE_URL?.trim();
  const baseUrl = rawBase ? parseHttpsBaseUrl(rawBase) : DEFAULT_GITHUB_BASE_URL;
  if (!baseUrl) return null;

  const explicitTag = env.CONTROLLED_NODE_ARTIFACT_GITHUB_TAG?.trim();
  const inferredVersion = manifest.version ?? entry.version;
  const tag = explicitTag || (inferredVersion ? `controlled-node-v${inferredVersion}` : '');
  if (!tag || !SAFE_TAG_RE.test(tag)) return null;

  return `${baseUrl}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(entry.assetFilename)}`;
}

function r2ManifestCacheKey(env: Partial<EnvConfig>, channel: ArtifactReleaseChannel): string {
  return [
    channel,
    env.USE_R2_ARTIFACT ?? '',
    env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL?.trim().replace(/\/+$/, '') ?? '',
    env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX?.trim().replace(/^\/+|\/+$/g, '') ?? '',
    env.R2_ACCOUNT_ID ?? '',
    env.R2_BUCKET ?? '',
  ].join('|');
}

function setCachedR2Manifest(
  cacheKey: string,
  manifest: ControlledNodeReleaseArtifactsManifest | null,
  ttlMs: number,
): void {
  if (r2ManifestCache.has(cacheKey)) {
    r2ManifestCache.delete(cacheKey);
  } else if (r2ManifestCache.size >= R2_MANIFEST_CACHE_MAX_ENTRIES) {
    const oldestKey = r2ManifestCache.keys().next().value;
    if (oldestKey !== undefined) r2ManifestCache.delete(oldestKey);
  }
  r2ManifestCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, manifest });
}

async function fetchLiveR2Manifest(
  env: Partial<EnvConfig>,
  channel: ArtifactReleaseChannel,
): Promise<ControlledNodeReleaseArtifactsManifest | null> {
  const manifestUrl = resolveR2ObjectUrl(env, `${channel}/${CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_FILENAME}`);
  if (!manifestUrl) return null;

  const cacheKey = r2ManifestCacheKey(env, channel);
  const now = Date.now();
  const cached = r2ManifestCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.manifest;
  }

  const inFlight = r2ManifestInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchImpl = r2ManifestFetchImpl ?? globalThis.fetch;
  const promise = (async (): Promise<ControlledNodeReleaseArtifactsManifest | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, R2_MANIFEST_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(manifestUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        setCachedR2Manifest(cacheKey, null, R2_MANIFEST_CACHE_ERROR_TTL_MS);
        return null;
      }
      const contentLengthHeader = response.headers.get('content-length');
      const declaredSize = contentLengthHeader && /^\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : null;
      if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_MANIFEST_BYTES)) {
        await response.body?.cancel().catch(() => {});
        setCachedR2Manifest(cacheKey, null, R2_MANIFEST_CACHE_ERROR_TTL_MS);
        return null;
      }
      const rawText = await response.text();
      const actualBytes = Buffer.byteLength(rawText, 'utf8');
      if (actualBytes <= 0 || actualBytes > MAX_MANIFEST_BYTES) {
        setCachedR2Manifest(cacheKey, null, R2_MANIFEST_CACHE_ERROR_TTL_MS);
        return null;
      }
      const liveManifest = parseReleaseArtifactsManifestObject(JSON.parse(rawText) as unknown);
      if (!liveManifest) {
        setCachedR2Manifest(cacheKey, null, R2_MANIFEST_CACHE_ERROR_TTL_MS);
        return null;
      }
      setCachedR2Manifest(cacheKey, liveManifest, R2_MANIFEST_CACHE_HIT_TTL_MS);
      return liveManifest;
    } catch {
      setCachedR2Manifest(cacheKey, null, R2_MANIFEST_CACHE_ERROR_TTL_MS);
      return null;
    } finally {
      clearTimeout(timeoutId);
      r2ManifestInFlight.delete(cacheKey);
    }
  })();

  r2ManifestInFlight.set(cacheKey, promise);
  return promise;
}

async function verifyLiveR2ManifestMatchesEntry(
  env: Partial<EnvConfig>,
  channel: ArtifactReleaseChannel,
  entry: ControlledNodeReleaseArtifactEntry,
  identity: VerifyExternalArtifactIdentity,
): Promise<boolean> {
  const liveManifest = await fetchLiveR2Manifest(env, channel);
  if (!liveManifest) return false;
  const r2Entry = findVerifiedManifestEntry(liveManifest, {
    ...identity,
    asset: entry.asset,
    os: entry.os,
    arch: entry.arch,
    abiProfile: entry.abiProfile,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
    version: entry.version ?? identity.version,
    authenticodeSignerSha256: entry.authenticodeSignerSha256,
  });
  return Boolean(r2Entry && r2Entry.assetFilename === entry.assetFilename);
}

/**
 * Resolve optional external controlled-node artifact distribution in strict priority:
 * 1. Optional R2 (CDN public base URL or presigned R2 GET) — verified against live R2 release-artifacts-manifest.json
 * 2. Optional GitHub Releases deterministic flat asset URL
 * 3. null -> caller falls back to Tier 3 built-in Docker streaming
 */
export async function resolveControlledNodeExternalArtifact(
  dir: string,
  env: Partial<EnvConfig>,
  identity: VerifyExternalArtifactIdentity,
): Promise<ResolvedExternalArtifactDistribution | null> {
  const manifest = await loadReleaseArtifactsManifest(dir);
  if (!manifest) return null;
  const entry = findVerifiedManifestEntry(manifest, identity);
  if (!entry) return null;

  const channel = resolveArtifactChannel(manifest.version ?? entry.version);
  const r2Url = resolveR2Url(env, manifest, entry);
  if (r2Url && await verifyLiveR2ManifestMatchesEntry(env, channel, entry, {
    ...identity,
    version: identity.version ?? manifest.version,
  })) {
    return { tier: 'r2', url: r2Url, entry };
  }
  const githubUrl = resolveGitHubUrl(env, manifest, entry);
  if (githubUrl) {
    return { tier: 'github', url: githubUrl, entry };
  }
  return null;
}

export async function resolveControlledNodeManifestEntryByKey(
  dir: string,
  env: Partial<EnvConfig>,
  lookup: { asset: string; os?: string; arch?: string; abiProfile?: ControlledNodeAbiProfile },
): Promise<{
  entry: ControlledNodeReleaseArtifactEntry;
  external: ResolvedExternalArtifactDistribution | null;
} | null> {
  const manifest = await loadReleaseArtifactsManifest(dir);
  if (!manifest) return null;
  const entry = manifest.artifacts[controlledNodeReleaseArtifactEntryKey(lookup)];
  if (!entry) return null;
  const external = await resolveControlledNodeExternalArtifact(dir, env, {
    asset: entry.asset,
    os: entry.os,
    arch: entry.arch,
    abiProfile: entry.abiProfile,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
    version: entry.version,
    authenticodeSignerSha256: entry.authenticodeSignerSha256,
  });
  return { entry, external };
}

export function resolveGitHubReleasesUrl(
  env: Partial<EnvConfig>,
  channel: ArtifactReleaseChannel = 'master',
): string {
  const rawRepo = env.CONTROLLED_NODE_ARTIFACT_GITHUB_REPO?.trim();
  const repo = rawRepo && GITHUB_REPO_RE.test(rawRepo) ? rawRepo : 'im4codes/imcodes';
  const rawBase = env.CONTROLLED_NODE_ARTIFACT_GITHUB_BASE_URL?.trim();
  const baseUrl = (rawBase ? parseHttpsBaseUrl(rawBase) : null) ?? DEFAULT_GITHUB_BASE_URL;
  return channel === 'dev' ? `${baseUrl}/${repo}/releases` : `${baseUrl}/${repo}/releases/latest`;
}
