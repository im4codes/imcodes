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
import { basename, join } from 'node:path';
import {
  CONTROLLED_NODE_ARTIFACT_VARIANTS,
  controlledNodeArtifactKey,
  type ControlledNodeArtifactArch,
  type ControlledNodeOs,
} from '../../../shared/controlled-node-artifacts.js';
import {
  DESKTOP_RELEASE_BUILD_VERSION_RE,
  DESKTOP_RELEASE_MANIFEST_FILENAME,
  DESKTOP_RELEASE_SHA256_RE,
  desktopReleaseTargetManifestFilename,
  isSafeManifestRelativePath,
  parseDesktopReleaseTarget,
  validateDesktopReleaseManifest,
  verifyDesktopReleaseComponentIdentity,
  type DesktopReleaseManifest,
  type DesktopReleaseTarget,
} from '../../../shared/desktop-release-manifest.js';
import { DAEMON_UPGRADE_TARGET_LATEST, normalizeDaemonUpgradeTargetVersion } from '../../../shared/daemon-upgrade.js';
import {
  CONTROLLED_NODE_ABI_MODERN,
  CONTROLLED_NODE_ABI_GLIBC217,
  CONTROLLED_NODE_ABI_PROFILES,
  normalizeControlledNodeAbiProfile,
  type ControlledNodeAbiProfile,
} from '../../../shared/controlled-node-abi.js';
import type { Database } from '../db/client.js';

export type SupportedOs = ControlledNodeOs;
export type SupportedArch = ControlledNodeArtifactArch;

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
  abiProfile?: ControlledNodeAbiProfile;
  filename: string;
  sizeBytes: number;
  sha256: string;
  authenticodeSignerSha256?: string;
  version: string;
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

const NODE_EXE_FILENAMES = new Map<string, string>([
  ['win:x64', 'imcodes-node.exe'],
  ['mac:universal', 'imcodes-node-macos'],
  ['linux:x64', 'imcodes-node-linux'],
]);

function cacheKey(dir: string, os: SupportedOs, arch: SupportedArch, abiProfile?: ControlledNodeAbiProfile): string {
  return `${dir}::${controlledNodeArtifactKey(os, arch, abiProfile)}`;
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
  abiProfile: ControlledNodeAbiProfile,
): Promise<ArtifactProbe | null> {
  const filename = abiProfile === CONTROLLED_NODE_ABI_GLIBC217
    ? (os === 'linux' && arch === 'x64' ? CONTROLLED_NODE_ABI_PROFILES.GLIBC217.fileName : undefined)
    : NODE_EXE_FILENAMES.get(`${os}:${arch}`);
  if (!filename) return null;
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
    const raw = JSON.parse(manifestText) as {
      schemaVersion?: unknown;
      artifact?: Record<string, unknown>;
      build?: Record<string, unknown>;
      toolchain?: Record<string, unknown>;
    };
    if (raw.schemaVersion !== 1 || !raw.artifact || typeof raw.artifact !== 'object') return null;
    const artifact = raw.artifact;
    if (artifact.fileName !== filename || artifact.arch !== arch
      || normalizeControlledNodeAbiProfile(artifact.abiProfile) !== abiProfile) return null;
    if (abiProfile === CONTROLLED_NODE_ABI_GLIBC217) {
      const pin = CONTROLLED_NODE_ABI_PROFILES.GLIBC217;
      const toolchain = raw.toolchain;
      if (!toolchain || toolchain.nodeProvider !== pin.provider
        || toolchain.nodeVersion !== pin.nodeVersion || toolchain.nodeArchive !== pin.nodeArchive
        || toolchain.nodeArchiveSha256 !== pin.nodeArchiveSha256
        || toolchain.nodeBinarySha256 !== pin.nodeBinarySha256
        || typeof toolchain.seaBlobSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(toolchain.seaBlobSha256)) return null;
    }
    const rawOs = typeof artifact.os === 'string' ? artifact.os.toLowerCase() : '';
    const mappedOs = rawOs === 'darwin' ? 'mac' : rawOs === 'win32' ? 'win' : rawOs;
    if (mappedOs !== os) return null;
    if (typeof artifact.size !== 'number' || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) return null;
    if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(artifact.sha256)) return null;
    const authenticodeSignerSha256 = typeof artifact.authenticodeSignerSha256 === 'string'
      && /^[0-9a-f]{64}$/i.test(artifact.authenticodeSignerSha256)
      ? artifact.authenticodeSignerSha256.toLowerCase()
      : null;
    if (mappedOs === 'win' && !authenticodeSignerSha256) return null;
    let version: string;
    try {
      version = normalizeDaemonUpgradeTargetVersion(raw.build?.version);
    } catch {
      return null;
    }
    if (version === DAEMON_UPGRADE_TARGET_LATEST) return null;
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
      authenticodeSignerSha256 ?? '',
      version,
    ].join(':');
    return {
      expectedSha256: artifact.sha256.toLowerCase(),
      descriptor: {
        os,
        arch,
        ...(abiProfile !== CONTROLLED_NODE_ABI_MODERN ? { abiProfile } : {}),
        filename,
        sizeBytes: artifact.size,
        ...(authenticodeSignerSha256 ? { authenticodeSignerSha256 } : {}),
        version,
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
    abiProfile: ControlledNodeAbiProfile = CONTROLLED_NODE_ABI_MODERN,
  ): Promise<ArtifactVerification> {
    const key = cacheKey(dir, os, arch, abiProfile);
    const probe = await probeArtifact(dir, os, arch, abiProfile);
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
    const descriptors = await Promise.all(CONTROLLED_NODE_ARTIFACT_VARIANTS.map(async ({ os, arch, abiProfile }) => {
      const result = await this.ensureVerified(dir, os, arch, abiProfile);
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
             FROM ${descriptor.abiProfile === CONTROLLED_NODE_ABI_GLIBC217
               ? 'controlled_node_artifact_variants' : 'controlled_node_artifact_manifests'}
            WHERE os = $1 AND arch = $2${descriptor.abiProfile === CONTROLLED_NODE_ABI_GLIBC217 ? ' AND abi_profile = $3' : ''}`,
          descriptor.abiProfile === CONTROLLED_NODE_ABI_GLIBC217
            ? [descriptor.os, descriptor.arch, descriptor.abiProfile] : [descriptor.os, descriptor.arch],
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

  invalidate(dir: string, os: SupportedOs, arch: SupportedArch, abiProfile: ControlledNodeAbiProfile = CONTROLLED_NODE_ABI_MODERN): void {
    this.cache.delete(cacheKey(dir, os, arch, abiProfile));
  }

  async persistDescriptor(db: Database, descriptor: ArtifactDescriptor): Promise<void> {
    const now = Date.now();
    const compat = descriptor.abiProfile === CONTROLLED_NODE_ABI_GLIBC217;
    await db.execute(
      `INSERT INTO ${compat ? 'controlled_node_artifact_variants' : 'controlled_node_artifact_manifests'}
         (os, arch, filename, size_bytes, sha256, source, created_at, updated_at${compat ? ', abi_profile' : ''})
       VALUES ($1, $2, $3, $4, $5, 'manifest_json', $6, $6${compat ? ', $7' : ''})
       ON CONFLICT (os, arch${compat ? ', abi_profile' : ''}) DO UPDATE
         SET filename = EXCLUDED.filename,
             size_bytes = EXCLUDED.size_bytes,
             sha256 = EXCLUDED.sha256,
             source = EXCLUDED.source,
             updated_at = EXCLUDED.updated_at`,
      [descriptor.os, descriptor.arch, descriptor.filename, descriptor.sizeBytes, descriptor.sha256, now,
        ...(compat ? [descriptor.abiProfile] : [])],
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

const RELEASE_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const DAEMON_RUNTIME_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS = [
  'package/package.json',
  'package/config/default.yaml',
  'package/dist/src/index.js',
  'package/dist/src/cli.js',
] as const;

export type OpenedCatalogReleaseManifest =
  | {
      status: 'ok';
      bytes: Buffer;
      close: () => Promise<void>;
      filename: string;
      sizeBytes: number;
      sha256: string;
      version: string;
      manifest: DesktopReleaseManifest;
    }
  | { status: 'not_published' }
  | { status: 'invalid'; reason: string };

export type OpenedCatalogDaemonRuntime =
  | {
      status: 'ok';
      handle?: FileHandle;
      bytes?: Buffer;
      close: () => Promise<void>;
      filename: string;
      sizeBytes: number;
      sha256: string;
      version: string;
      releaseManifestSha256?: string;
      authenticodeSignerSha256?: string;
    }
  | { status: 'not_published' }
  | { status: 'invalid'; reason: string };

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

async function readPinnedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<{ ok: true; bytes: Buffer; sha256: string } | { ok: false; kind: 'not_published' | 'invalid'; reason: string }> {
  let handle: FileHandle | null = null;
  try {
    const pathStat = await lstat(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size <= 0 || pathStat.size > maxBytes) {
      return { ok: false, kind: 'invalid', reason: 'invalid_file_stat' };
    }
    handle = await openReadNoFollow(filePath);
    const fdStat = await handle.stat();
    if (!fdStat.isFile() || !sameIdentity(fileIdentity(pathStat), fileIdentity(fdStat))) {
      return { ok: false, kind: 'invalid', reason: 'file_identity_changed' };
    }
    const bytes = await handle.readFile();
    if (bytes.length !== fdStat.size) {
      return { ok: false, kind: 'invalid', reason: 'short_read' };
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { ok: true, bytes, sha256 };
  } catch (error) {
    if (isEnoent(error)) return { ok: false, kind: 'not_published', reason: 'not_found' };
    return { ok: false, kind: 'invalid', reason: 'read_failed' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function openDesktopReleaseManifestArtifact(
  dir: string,
  target: DesktopReleaseTarget | null,
): Promise<OpenedCatalogReleaseManifest> {
  const candidates = target
    ? [desktopReleaseTargetManifestFilename(target), DESKTOP_RELEASE_MANIFEST_FILENAME]
    : [DESKTOP_RELEASE_MANIFEST_FILENAME];

  for (const filename of candidates) {
    const filePath = join(dir, filename);
    const read = await readPinnedRegularFile(filePath, RELEASE_MANIFEST_MAX_BYTES);
    if (!read.ok) {
      if (read.kind === 'not_published') continue;
      return { status: 'invalid', reason: read.reason };
    }
    let manifest: DesktopReleaseManifest;
    try {
      manifest = validateDesktopReleaseManifest(JSON.parse(read.bytes.toString('utf8')));
    } catch (error) {
      return { status: 'invalid', reason: error instanceof Error ? error.message : 'invalid_manifest' };
    }
    if (target && !manifest.targets[target]) {
      return { status: 'invalid', reason: `missing_target_${target}` };
    }
    return {
      status: 'ok',
      bytes: read.bytes,
      close: async () => {},
      filename,
      sizeBytes: read.bytes.length,
      sha256: read.sha256,
      version: manifest.releaseVersion,
      manifest,
    };
  }
  return { status: 'not_published' };
}

function validateDaemonRuntimeManifestRecord(
  raw: unknown,
  target: DesktopReleaseTarget,
): {
  fileName: string;
  size: number;
  sha256: string;
  version: string;
  authenticodeSignerSha256?: string;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) return null;
  const { os, arch } = parseDesktopReleaseTarget(target);
  const expectedFormat = os === 'win32' ? 'zip' : 'tar.gz';
  const expectedFilename = `daemon-runtime-${target}.${expectedFormat}`;

  const artifact = obj.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return null;
  const a = artifact as Record<string, unknown>;
  if (a.fileName !== expectedFilename || basename(String(a.fileName)) !== expectedFilename) return null;
  if (a.os !== os || a.arch !== arch || a.format !== expectedFormat) return null;
  if (typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size <= 0) return null;
  if (typeof a.sha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(a.sha256)) return null;
  const signer =
    typeof a.authenticodeSignerSha256 === 'string' && DESKTOP_RELEASE_SHA256_RE.test(a.authenticodeSignerSha256)
      ? a.authenticodeSignerSha256
      : undefined;
  if (a.authenticodeSignerSha256 !== undefined && !signer) return null;

  const entrypoint = obj.entrypoint as Record<string, unknown> | undefined;
  const expectedNode = os === 'win32' ? 'node.exe' : 'bin/node';
  if (!entrypoint || entrypoint.node !== expectedNode || entrypoint.script !== 'package/dist/src/index.js') return null;

  const build = obj.build as Record<string, unknown> | undefined;
  if (!build || typeof build.version !== 'string' || !DESKTOP_RELEASE_BUILD_VERSION_RE.test(build.version)) return null;

  if (!Array.isArray(obj.files) || obj.files.length === 0) return null;
  const filePaths = new Set<string>();
  for (const fileEntry of obj.files) {
    if (!fileEntry || typeof fileEntry !== 'object') return null;
    const f = fileEntry as Record<string, unknown>;
    if (!isSafeManifestRelativePath(f.path)) return null;
    if (typeof f.sha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(f.sha256)) return null;
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) return null;
    filePaths.add(f.path);
  }
  if (!filePaths.has(expectedNode)) return null;
  for (const reqPath of DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS) {
    if (!filePaths.has(reqPath)) return null;
  }

  return {
    fileName: expectedFilename,
    size: a.size,
    sha256: a.sha256,
    version: build.version,
    ...(signer ? { authenticodeSignerSha256: signer } : {}),
  };
}

export async function openDaemonRuntimeArtifact(
  dir: string,
  target: DesktopReleaseTarget,
  wantManifest: boolean,
): Promise<OpenedCatalogDaemonRuntime> {
  const runtimeDir = join(dir, 'daemon-runtime');
  const manifestFilename = `daemon-runtime-${target}.manifest.json`;
  const manifestPath = join(runtimeDir, manifestFilename);
  const readManifest = await readPinnedRegularFile(manifestPath, DAEMON_RUNTIME_MANIFEST_MAX_BYTES);
  if (!readManifest.ok) {
    return readManifest.kind === 'not_published'
      ? { status: 'not_published' }
      : { status: 'invalid', reason: readManifest.reason };
  }

  let parsedManifest: ReturnType<typeof validateDaemonRuntimeManifestRecord> = null;
  try {
    parsedManifest = validateDaemonRuntimeManifestRecord(JSON.parse(readManifest.bytes.toString('utf8')), target);
  } catch {
    return { status: 'invalid', reason: 'malformed_daemon_runtime_manifest' };
  }
  if (!parsedManifest) {
    return { status: 'invalid', reason: 'invalid_daemon_runtime_manifest' };
  }

  // Always verify the archive itself exists and matches the manifest before serving either manifest or archive.
  const archivePath = join(runtimeDir, parsedManifest.fileName);
  let archiveHandle: FileHandle | null = null;
  try {
    const archivePathStat = await lstat(archivePath);
    if (!archivePathStat.isFile() || archivePathStat.isSymbolicLink() || archivePathStat.size !== parsedManifest.size) {
      return { status: 'invalid', reason: 'daemon_runtime_archive_stat_mismatch' };
    }
    archiveHandle = await openReadNoFollow(archivePath);
    const fdStat = await archiveHandle.stat();
    if (!fdStat.isFile() || !sameIdentity(fileIdentity(archivePathStat), fileIdentity(fdStat))) {
      await archiveHandle.close().catch(() => {});
      return { status: 'invalid', reason: 'daemon_runtime_archive_identity_changed' };
    }
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (position < parsedManifest.size) {
      const { bytesRead } = await archiveHandle.read(buf, 0, Math.min(buf.length, parsedManifest.size - position), position);
      if (bytesRead <= 0) {
        await archiveHandle.close().catch(() => {});
        return { status: 'invalid', reason: 'daemon_runtime_archive_short_read' };
      }
      hash.update(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
    const actualSha = hash.digest('hex');
    if (actualSha !== parsedManifest.sha256) {
      await archiveHandle.close().catch(() => {});
      return { status: 'invalid', reason: 'daemon_runtime_archive_sha256_mismatch' };
    }

    // Cross-check unified release manifest when published alongside artifacts.
    const releaseCheck = await openDesktopReleaseManifestArtifact(dir, target);
    if (releaseCheck.status === 'invalid') {
      await archiveHandle.close().catch(() => {});
      return { status: 'invalid', reason: `release_manifest_invalid:${releaseCheck.reason}` };
    }
    if (releaseCheck.status === 'ok') {
      const check = verifyDesktopReleaseComponentIdentity(releaseCheck.manifest, target, 'daemon-runtime', {
        version: parsedManifest.version,
        fileName: parsedManifest.fileName,
        sha256: parsedManifest.sha256,
        sizeBytes: parsedManifest.size,
        ...(parsedManifest.authenticodeSignerSha256
          ? { authenticodeSignerSha256: parsedManifest.authenticodeSignerSha256 }
          : {}),
      });
      await releaseCheck.close();
      if (!check.ok) {
        await archiveHandle.close().catch(() => {});
        return { status: 'invalid', reason: check.reason };
      }
    }

    if (wantManifest) {
      await archiveHandle.close().catch(() => {});
      return {
        status: 'ok',
        bytes: readManifest.bytes,
        close: async () => {},
        filename: manifestFilename,
        sizeBytes: readManifest.bytes.length,
        sha256: readManifest.sha256,
        version: parsedManifest.version,
        ...(parsedManifest.authenticodeSignerSha256
          ? { authenticodeSignerSha256: parsedManifest.authenticodeSignerSha256 }
          : {}),
      };
    }

    const pinned = archiveHandle;
    archiveHandle = null;
    return {
      status: 'ok',
      handle: pinned,
      close: makeSafeCloseOnce(pinned),
      filename: parsedManifest.fileName,
      sizeBytes: parsedManifest.size,
      sha256: parsedManifest.sha256,
      version: parsedManifest.version,
      ...(releaseCheck.status === 'ok' ? { releaseManifestSha256: releaseCheck.sha256 } : {}),
      ...(parsedManifest.authenticodeSignerSha256
        ? { authenticodeSignerSha256: parsedManifest.authenticodeSignerSha256 }
        : {}),
    };
  } catch (error) {
    await archiveHandle?.close().catch(() => {});
    if (isEnoent(error)) return { status: 'not_published' };
    return { status: 'invalid', reason: 'daemon_runtime_open_failed' };
  }
}
