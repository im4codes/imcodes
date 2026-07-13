/**
 * In-process controlled-node artifact catalog.
 *
 * Artifact bytes live in the immutable server image. A cheap manifest/file
 * fingerprint is probed on every lookup, while the expensive full-file digest
 * is single-flighted and cached per fingerprint. Successful cache entries hold
 * descriptors only — never open handles. Each download opens its own pinned
 * descriptor after admission, so mint/availability cannot close or leak a
 * handle later borrowed by a download.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONTROLLED_NODE_CANONICAL_ARTIFACTS,
  type ControlledNodeArch,
  type ControlledNodeOs,
} from '../../../shared/controlled-node-artifacts.js';
import type { Database } from '../db/client.js';

export type SupportedOs = ControlledNodeOs;
export type SupportedArch = ControlledNodeArch;

interface ArtifactIdentity {
  dev?: number;
  ino?: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ArtifactDescriptor {
  os: SupportedOs;
  arch: SupportedArch;
  filename: string;
  sizeBytes: number;
  sha256: string;
  /** Manifest + artifact identity + expected digest cache key. */
  fingerprint: string;
  mtimeMs: number;
  identity: ArtifactIdentity;
}

export interface OpenArtifact {
  descriptor: ArtifactDescriptor;
  handle: FileHandle;
  close: () => Promise<void>;
}

export type ArtifactVerification =
  | { ok: true; descriptor: ArtifactDescriptor }
  | {
      ok: false;
      reason: 'not_a_file' | 'mismatch' | 'read_failed';
      actualSha?: string;
      actualSize?: number;
      until: number;
    };

interface ArtifactProbe {
  descriptor: Omit<ArtifactDescriptor, 'sha256'>;
  expectedSha256: string;
}

interface CacheEntry {
  fingerprint: string;
  promise: Promise<ArtifactVerification>;
}

const NEGATIVE_TTL_MS = 30_000;
const HASH_BUFFER_BYTES = 64 * 1024;

const NODE_EXE_FILENAMES: Record<SupportedOs, string> = {
  win: 'imcodes-node.exe',
  mac: 'imcodes-node-macos',
  linux: 'imcodes-node-linux',
};

function cacheKey(dir: string, os: SupportedOs, arch: SupportedArch): string {
  return `${dir}::${os}::${arch}`;
}

function fileIdentity(stat: {
  dev?: number;
  ino?: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): ArtifactIdentity {
  return {
    ...(typeof stat.dev === 'number' ? { dev: stat.dev } : {}),
    ...(typeof stat.ino === 'number' ? { ino: stat.ino } : {}),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  const metadata = a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined) {
    return metadata && a.dev === b.dev && a.ino === b.ino;
  }
  return metadata;
}

function openReadNoFollow(path: string): Promise<FileHandle> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  return open(path, fsConstants.O_RDONLY | noFollow);
}

async function probeArtifact(
  dir: string,
  os: SupportedOs,
  arch: SupportedArch,
): Promise<ArtifactProbe | null> {
  const filename = NODE_EXE_FILENAMES[os];
  const manifestPath = join(dir, `${filename}.manifest.json`);
  const artifactPath = join(dir, filename);
  let manifestHandle: FileHandle | null = null;
  try {
    const [manifestPathStat, artifactStat] = await Promise.all([
      lstat(manifestPath),
      lstat(artifactPath),
    ]);
    if (!manifestPathStat.isFile() || manifestPathStat.isSymbolicLink()) return null;
    if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) return null;
    manifestHandle = await openReadNoFollow(manifestPath);
    const manifestStat = await manifestHandle.stat();
    if (!manifestStat.isFile()
      || !sameIdentity(fileIdentity(manifestPathStat), fileIdentity(manifestStat))) return null;
    const manifestText = await manifestHandle.readFile('utf8');
    const raw = JSON.parse(manifestText) as { schemaVersion?: unknown; artifact?: Record<string, unknown> };
    if (raw.schemaVersion !== 1 || !raw.artifact || typeof raw.artifact !== 'object') return null;
    const artifact = raw.artifact;
    if (artifact.fileName !== filename || artifact.arch !== arch) return null;
    const rawOs = typeof artifact.os === 'string' ? artifact.os.toLowerCase() : '';
    const mappedOs = rawOs === 'darwin' ? 'mac' : rawOs === 'win32' ? 'win' : rawOs;
    if (mappedOs !== os) return null;
    if (typeof artifact.size !== 'number' || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) return null;
    if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(artifact.sha256)) return null;
    const identity = fileIdentity(artifactStat);
    const manifestDigest = createHash('sha256').update(manifestText, 'utf8').digest('hex');
    const fingerprint = [
      filename,
      identity.dev ?? '',
      identity.ino ?? '',
      identity.size,
      identity.mtimeMs,
      identity.ctimeMs,
      manifestStat.size,
      manifestStat.mtimeMs,
      manifestDigest,
      artifact.sha256.toLowerCase(),
    ].join(':');
    return {
      expectedSha256: artifact.sha256.toLowerCase(),
      descriptor: {
        os,
        arch,
        filename,
        sizeBytes: artifact.size,
        fingerprint,
        mtimeMs: identity.mtimeMs,
        identity,
      },
    };
  } catch {
    return null;
  } finally {
    await manifestHandle?.close().catch(() => {});
  }
}

async function hashProbe(
  dir: string,
  probe: ArtifactProbe,
  onFullHash: () => void,
): Promise<ArtifactVerification> {
  const path = join(dir, probe.descriptor.filename);
  let handle: FileHandle | null = null;
  try {
    handle = await openReadNoFollow(path);
    const stat = await handle.stat();
    const identity = fileIdentity(stat);
    if (!stat.isFile() || !sameIdentity(identity, probe.descriptor.identity)) {
      return { ok: false, reason: 'not_a_file', until: Date.now() + NEGATIVE_TTL_MS };
    }
    if (stat.size !== probe.descriptor.sizeBytes) {
      return {
        ok: false,
        reason: 'mismatch',
        actualSize: stat.size,
        until: Date.now() + NEGATIVE_TTL_MS,
      };
    }
    onFullHash();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(HASH_BUFFER_BYTES);
    let position = 0;
    while (position < stat.size) {
      const length = Math.min(buffer.length, stat.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) {
        return { ok: false, reason: 'read_failed', until: Date.now() + NEGATIVE_TTL_MS };
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const actualSha = hash.digest('hex');
    if (actualSha !== probe.expectedSha256) {
      return {
        ok: false,
        reason: 'mismatch',
        actualSha,
        actualSize: stat.size,
        until: Date.now() + NEGATIVE_TTL_MS,
      };
    }
    return { ok: true, descriptor: { ...probe.descriptor, sha256: actualSha } };
  } catch {
    return { ok: false, reason: 'read_failed', until: Date.now() + NEGATIVE_TTL_MS };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export interface ArtifactCatalogDiagnostics {
  fullHashCount: number;
  activePinnedHandles: number;
}

/**
 * One app/test-scoped catalog. No cache, negative result, verifier promise or
 * descriptor count is shared unless the caller deliberately shares this
 * instance.
 */
export class ArtifactCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private fullHashCount = 0;
  private activePinnedHandles = 0;

  async ensureVerified(
    dir: string,
    os: SupportedOs,
    arch: SupportedArch,
  ): Promise<ArtifactVerification> {
    const key = cacheKey(dir, os, arch);
    const probe = await probeArtifact(dir, os, arch);
    if (!probe) {
      this.cache.delete(key);
      return { ok: false, reason: 'not_a_file', until: Date.now() + NEGATIVE_TTL_MS };
    }
    const cached = this.cache.get(key);
    if (cached?.fingerprint === probe.descriptor.fingerprint) {
      const result = await cached.promise;
      if (result.ok || result.until > Date.now()) return result;
    }
    const promise = hashProbe(dir, probe, () => { this.fullHashCount += 1; });
    this.cache.set(key, { fingerprint: probe.descriptor.fingerprint, promise });
    return promise;
  }

  /** Open a fresh descriptor and prove it still matches cached verification. */
  async openPinned(dir: string, descriptor: ArtifactDescriptor): Promise<OpenArtifact | null> {
    const path = join(dir, descriptor.filename);
    let handle: FileHandle | null = null;
    try {
      handle = await openReadNoFollow(path);
      const stat = await handle.stat();
      if (!stat.isFile() || !sameIdentity(fileIdentity(stat), descriptor.identity)) {
        await handle.close();
        return null;
      }
      this.activePinnedHandles += 1;
      const pinnedHandle = handle;
      handle = null;
      return {
        descriptor,
        handle: pinnedHandle,
        close: makeSafeCloseOnce(pinnedHandle, () => { this.activePinnedHandles -= 1; }),
      };
    } catch {
      await handle?.close().catch(() => {});
      return null;
    }
  }

  async listAvailable(dir: string, db?: Database): Promise<ArtifactDescriptor[]> {
    const descriptors = await Promise.all(CONTROLLED_NODE_CANONICAL_ARTIFACTS.map(async ({ os, arch }) => {
      const result = await this.ensureVerified(dir, os, arch);
      return result.ok ? result.descriptor : null;
    }));
    const available = descriptors.filter((value): value is ArtifactDescriptor => value !== null);
    if (db) {
      await Promise.all(available.map(async (descriptor) => {
        const existing = await db.queryOne<{
          filename: string;
          size_bytes: number;
          sha256: string;
          source: string;
        }>(
          `SELECT filename, size_bytes, sha256, source
             FROM controlled_node_artifact_manifests
            WHERE os = $1 AND arch = $2`,
          [descriptor.os, descriptor.arch],
        );
        if (existing
          && existing.filename === descriptor.filename
          && Number(existing.size_bytes) === descriptor.sizeBytes
          && existing.sha256 === descriptor.sha256
          && existing.source === 'manifest_json') return;
        await this.persistDescriptor(db, descriptor);
      }));
    }
    return available;
  }

  invalidate(dir: string, os: SupportedOs, arch: SupportedArch): void {
    this.cache.delete(cacheKey(dir, os, arch));
  }

  async persistDescriptor(db: Database, descriptor: ArtifactDescriptor): Promise<void> {
    const now = Date.now();
    await db.execute(
      `INSERT INTO controlled_node_artifact_manifests
         (os, arch, filename, size_bytes, sha256, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'manifest_json', $6, $6)
       ON CONFLICT (os, arch) DO UPDATE
         SET filename = EXCLUDED.filename,
             size_bytes = EXCLUDED.size_bytes,
             sha256 = EXCLUDED.sha256,
             source = EXCLUDED.source,
             updated_at = EXCLUDED.updated_at`,
      [descriptor.os, descriptor.arch, descriptor.filename, descriptor.sizeBytes, descriptor.sha256, now],
    );
  }

  getDiagnostics(): ArtifactCatalogDiagnostics {
    return {
      fullHashCount: this.fullHashCount,
      activePinnedHandles: this.activePinnedHandles,
    };
  }
}

export function createArtifactCatalog(): ArtifactCatalog {
  return new ArtifactCatalog();
}

/** Production default, deliberately shared only by the default route export. */
export const defaultArtifactCatalog = createArtifactCatalog();

export function makeSafeCloseOnce(handle: FileHandle, onClosed?: () => void): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    try {
      await handle.close();
    } catch {
      // Closing an already-closed/erroring descriptor must not hide the primary error.
    } finally {
      onClosed?.();
    }
  };
}
