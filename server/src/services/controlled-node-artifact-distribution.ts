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

export type ControlledNodeDistributionTier = 'r2' | 'github' | 'docker';

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

interface CachedManifest {
  fileKey: string;
  manifest: ControlledNodeReleaseArtifactsManifest | null;
}

const manifestCache = new Map<string, CachedManifest>();

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
    const parsed = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
    if (parsed.schemaVersion !== CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION
      || !parsed.artifacts || typeof parsed.artifacts !== 'object' || Array.isArray(parsed.artifacts)) {
      manifestCache.set(dir, { fileKey, manifest: null });
      return null;
    }
    const cleanArtifacts: Record<string, ControlledNodeReleaseArtifactEntry> = {};
    for (const [k, v] of Object.entries(parsed.artifacts as Record<string, unknown>)) {
      if (isValidEntry(v)) cleanArtifacts[k] = v;
    }
    const manifest: ControlledNodeReleaseArtifactsManifest = {
      schemaVersion: CONTROLLED_NODE_RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION,
      ...(typeof parsed.version === 'string' && parsed.version.trim() ? { version: parsed.version.trim() } : {}),
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      artifacts: cleanArtifacts,
    };
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

function resolveR2Url(
  env: Partial<EnvConfig>,
  entry: ControlledNodeReleaseArtifactEntry,
): string | null {
  if (env.USE_R2_ARTIFACT === 'false') return null;
  let prefix = '';
  try {
    prefix = normalizeR2Prefix(env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX);
  } catch {
    return null;
  }
  const key = `${prefix}${entry.assetFilename}`;
  const publicBase = parseHttpsBaseUrl(env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL);
  if (publicBase) {
    const encodedPath = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
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

/**
 * Resolve optional external controlled-node artifact distribution in strict priority:
 * 1. Optional R2 (CDN public base URL or presigned R2 GET)
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

  const r2Url = resolveR2Url(env, entry);
  if (r2Url) {
    return { tier: 'r2', url: r2Url, entry };
  }
  const githubUrl = resolveGitHubUrl(env, manifest, entry);
  if (githubUrl) {
    return { tier: 'github', url: githubUrl, entry };
  }
  return null;
}
