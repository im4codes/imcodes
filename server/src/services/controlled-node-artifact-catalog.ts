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
  CONTROLLED_NODE_ARCH_ARM64,
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL,
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_VARIANTS,
  CONTROLLED_NODE_OS_LINUX,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_WIN,
  controlledNodeArtifactKey,
  controlledNodeDaemonRuntimeTarget,
  controlledNodeReleaseArtifactEntryKey,
  normalizeControlledNodeArtifactPair,
  resolveControlledNodeRuntimeArch,
  type ControlledNodeArch,
  type ControlledNodeArtifactArch,
  type ControlledNodeOs,
} from '../../../shared/controlled-node-artifacts.js';
import { loadReleaseArtifactsManifest } from './controlled-node-artifact-distribution.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  validateRemoteDesktopWorkerManifest,
} from '../../../shared/remote-desktop-worker.js';
import {
  DESKTOP_RELEASE_MANIFEST_FILENAME,
  daemonRuntimeManifestFilename,
  desktopReleaseTargetManifestFilename,
  validateDaemonRuntimeManifest,
  validateDesktopReleaseManifest,
  verifyDesktopReleaseComponentIdentity,
  type DaemonRuntimeManifest,
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
      /** True when local archive is absent and archive downloads must redirect to verified external R2/GitHub URLs. */
      externalOnly?: boolean;
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

async function verifyDaemonRuntimeReleaseManifest(
  dir: string,
  target: DesktopReleaseTarget,
  identity: {
    version: string;
    fileName: string;
    sha256: string;
    sizeBytes: number;
    authenticodeSignerSha256?: string;
  },
): Promise<{ ok: true; releaseManifestSha256?: string } | { ok: false; reason: string }> {
  const releaseCheck = await openDesktopReleaseManifestArtifact(dir, target);
  if (releaseCheck.status === 'invalid') {
    return { ok: false, reason: `release_manifest_invalid:${releaseCheck.reason}` };
  }
  if (releaseCheck.status === 'not_published') {
    return { ok: true };
  }
  try {
    const check = verifyDesktopReleaseComponentIdentity(releaseCheck.manifest, target, 'daemon-runtime', identity);
    if (!check.ok) {
      return { ok: false, reason: check.reason };
    }
    return { ok: true, releaseManifestSha256: releaseCheck.sha256 };
  } finally {
    await releaseCheck.close();
  }
}

export async function openDaemonRuntimeArtifact(
  dir: string,
  target: DesktopReleaseTarget,
  wantManifest: boolean,
): Promise<OpenedCatalogDaemonRuntime> {
  const runtimeDir = join(dir, 'daemon-runtime');
  const manifestFilename = daemonRuntimeManifestFilename(target);
  const manifestPath = join(runtimeDir, manifestFilename);
  const readManifest = await readPinnedRegularFile(manifestPath, DAEMON_RUNTIME_MANIFEST_MAX_BYTES);
  if (!readManifest.ok) {
    return readManifest.kind === 'not_published'
      ? { status: 'not_published' }
      : { status: 'invalid', reason: readManifest.reason };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readManifest.bytes.toString('utf8'));
  } catch {
    return { status: 'invalid', reason: 'malformed_daemon_runtime_manifest' };
  }

  let parsedManifest: DaemonRuntimeManifest;
  try {
    parsedManifest = validateDaemonRuntimeManifest(rawJson, target);
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'invalid_daemon_runtime_manifest',
    };
  }

  const archiveFileName = parsedManifest.artifact.fileName;
  const archiveSize = parsedManifest.artifact.size;
  const archiveSha256 = parsedManifest.artifact.sha256;
  const archiveSigner = parsedManifest.artifact.authenticodeSignerSha256;
  const buildVersion = parsedManifest.build.version;
  const archivePath = join(runtimeDir, archiveFileName);
  const identity = {
    version: buildVersion,
    fileName: archiveFileName,
    sha256: archiveSha256,
    sizeBytes: archiveSize,
    ...(archiveSigner ? { authenticodeSignerSha256: archiveSigner } : {}),
  };

  let archiveHandle: FileHandle | null = null;
  try {
    const archivePathStat = await lstat(archivePath);
    if (!archivePathStat.isFile() || archivePathStat.isSymbolicLink() || archivePathStat.size !== archiveSize) {
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
    while (position < archiveSize) {
      const { bytesRead } = await archiveHandle.read(buf, 0, Math.min(buf.length, archiveSize - position), position);
      if (bytesRead <= 0) {
        await archiveHandle.close().catch(() => {});
        return { status: 'invalid', reason: 'daemon_runtime_archive_short_read' };
      }
      hash.update(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
    const actualSha = hash.digest('hex');
    if (actualSha !== archiveSha256) {
      await archiveHandle.close().catch(() => {});
      return { status: 'invalid', reason: 'daemon_runtime_archive_sha256_mismatch' };
    }

    const releaseCheck = await verifyDaemonRuntimeReleaseManifest(dir, target, identity);
    if (!releaseCheck.ok) {
      await archiveHandle.close().catch(() => {});
      return { status: 'invalid', reason: releaseCheck.reason };
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
        version: buildVersion,
        ...(archiveSigner ? { authenticodeSignerSha256: archiveSigner } : {}),
      };
    }

    const pinned = archiveHandle;
    archiveHandle = null;
    return {
      status: 'ok',
      handle: pinned,
      close: makeSafeCloseOnce(pinned),
      filename: archiveFileName,
      sizeBytes: archiveSize,
      sha256: archiveSha256,
      version: buildVersion,
      ...(releaseCheck.releaseManifestSha256 ? { releaseManifestSha256: releaseCheck.releaseManifestSha256 } : {}),
      ...(archiveSigner ? { authenticodeSignerSha256: archiveSigner } : {}),
    };
  } catch (error) {
    await archiveHandle?.close().catch(() => {});
    if (!isEnoent(error)) {
      return { status: 'invalid', reason: 'daemon_runtime_open_failed' };
    }

    // Archive is not baked into the local disk (for example server Docker image
    // excluding *.tar.gz / *.zip). Allow manifest-verified external-only metadata
    // and redirects when both desktop-release*.manifest.json and
    // release-artifacts-manifest.json match the local daemon-runtime manifest.
    const releaseCheck = await verifyDaemonRuntimeReleaseManifest(dir, target, identity);
    if (!releaseCheck.ok) {
      return { status: 'invalid', reason: releaseCheck.reason };
    }
    const releaseArtifactsManifest = await loadReleaseArtifactsManifest(dir);
    if (!releaseArtifactsManifest) {
      return { status: 'not_published' };
    }
    const normOs = parsedManifest.artifact.os === 'darwin'
      ? CONTROLLED_NODE_OS_MAC
      : parsedManifest.artifact.os === 'win32'
        ? CONTROLLED_NODE_OS_WIN
        : CONTROLLED_NODE_OS_LINUX;
    const normArch = parsedManifest.artifact.arch;
    const entry = releaseArtifactsManifest.artifacts[
      controlledNodeReleaseArtifactEntryKey({
        asset: CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME,
        os: normOs,
        arch: normArch,
      })
    ];
    if (!entry) {
      return { status: 'not_published' };
    }
    if (
      entry.asset !== CONTROLLED_NODE_ARTIFACT_ASSETS.DAEMON_RUNTIME
      || entry.assetFilename !== archiveFileName
      || entry.sha256 !== archiveSha256.toLowerCase()
      || entry.sizeBytes !== archiveSize
      || entry.version !== buildVersion
      || (entry.os && entry.os !== normOs)
      || (entry.arch && entry.arch !== normArch)
      || ((archiveSigner || entry.authenticodeSignerSha256)
        && entry.authenticodeSignerSha256 !== archiveSigner?.toLowerCase())
    ) {
      return { status: 'invalid', reason: 'daemon_runtime_release_artifacts_mismatch' };
    }

    if (wantManifest) {
      return {
        status: 'ok',
        bytes: readManifest.bytes,
        close: async () => {},
        filename: manifestFilename,
        sizeBytes: readManifest.bytes.length,
        sha256: readManifest.sha256,
        version: buildVersion,
        ...(archiveSigner ? { authenticodeSignerSha256: archiveSigner } : {}),
      };
    }

    return {
      status: 'ok',
      externalOnly: true,
      close: async () => {},
      filename: archiveFileName,
      sizeBytes: archiveSize,
      sha256: archiveSha256,
      version: buildVersion,
      ...(releaseCheck.releaseManifestSha256 ? { releaseManifestSha256: releaseCheck.releaseManifestSha256 } : {}),
      ...(archiveSigner ? { authenticodeSignerSha256: archiveSigner } : {}),
    };
  }
}

export async function openRemoteDesktopWorkerArtifact(
  dir: string,
  asset: typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
    | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
    | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY,
  legacyManifest = false,
): Promise<{
  handle?: FileHandle;
  bytes?: Buffer;
  close: () => Promise<void>;
  filename: string;
  sizeBytes: number;
  sha256: string;
  version: string;
} | null> {
  const workerDir = join(dir, 'remote-desktop-worker', 'win32-x64');
  const executablePath = join(workerDir, REMOTE_DESKTOP_WORKER_FILENAME);
  const manifestFilename = `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
  const manifestPath = join(workerDir, manifestFilename);
  const virtualDisplayPath = join(workerDir, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME);
  let executable: FileHandle | null = null;
  let manifestHandle: FileHandle | null = null;
  let virtualDisplayHandle: FileHandle | null = null;
  let requested: FileHandle | null = null;
  try {
    const [executablePathStat, manifestPathStat, virtualDisplayPathStat] = await Promise.all([
      lstat(executablePath),
      lstat(manifestPath),
      lstat(virtualDisplayPath),
    ]);
    if (!executablePathStat.isFile() || executablePathStat.isSymbolicLink()
      || !manifestPathStat.isFile() || manifestPathStat.isSymbolicLink()
      || !virtualDisplayPathStat.isFile() || virtualDisplayPathStat.isSymbolicLink()
      || manifestPathStat.size <= 0 || manifestPathStat.size > 64 * 1024) return null;
    manifestHandle = await open(manifestPath, 'r');
    const manifestStat = await manifestHandle.stat();
    if (!manifestStat.isFile() || manifestStat.size !== manifestPathStat.size
      || manifestStat.mtimeMs !== manifestPathStat.mtimeMs
      || manifestStat.ctimeMs !== manifestPathStat.ctimeMs) return null;
    // Keep the exact bytes used for the HTTP digest. Decoding and re-encoding
    // would make the advertised SHA-256 differ from the bytes held by this
    // pinned descriptor if a malformed UTF-8 sequence ever reached disk.
    const rawManifest = await manifestHandle.readFile();
    await manifestHandle.close();
    manifestHandle = null;
    const manifest = validateRemoteDesktopWorkerManifest(JSON.parse(rawManifest.toString('utf8')));
    if (!manifest || manifest.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION
      || manifest.size !== executablePathStat.size
      || manifest.virtualDisplay.size !== virtualDisplayPathStat.size) return null;

    executable = await open(executablePath, 'r');
    const executableStat = await executable.stat();
    if (!executableStat.isFile() || executableStat.size !== executablePathStat.size
      || executableStat.mtimeMs !== executablePathStat.mtimeMs
      || executableStat.ctimeMs !== executablePathStat.ctimeMs) return null;
    const executableHash = createHash('sha256');
    const executableBuffer = Buffer.alloc(64 * 1024);
    let executablePosition = 0;
    while (executablePosition < executableStat.size) {
      const { bytesRead } = await executable.read(
        executableBuffer,
        0,
        Math.min(executableBuffer.length, executableStat.size - executablePosition),
        executablePosition,
      );
      if (bytesRead <= 0) return null;
      executableHash.update(executableBuffer.subarray(0, bytesRead));
      executablePosition += bytesRead;
    }
    if (executableHash.digest('hex') !== manifest.sha256) return null;

    virtualDisplayHandle = await open(virtualDisplayPath, 'r');
    const virtualDisplayStat = await virtualDisplayHandle.stat();
    if (!virtualDisplayStat.isFile()
      || virtualDisplayStat.size !== virtualDisplayPathStat.size
      || virtualDisplayStat.mtimeMs !== virtualDisplayPathStat.mtimeMs
      || virtualDisplayStat.ctimeMs !== virtualDisplayPathStat.ctimeMs) {
      return null;
    }
    const virtualDisplayHash = createHash('sha256');
    const virtualDisplayBuffer = Buffer.alloc(64 * 1024);
    let virtualDisplayPosition = 0;
    while (virtualDisplayPosition < virtualDisplayStat.size) {
      const { bytesRead } = await virtualDisplayHandle.read(
        virtualDisplayBuffer,
        0,
        Math.min(virtualDisplayBuffer.length, virtualDisplayStat.size - virtualDisplayPosition),
        virtualDisplayPosition,
      );
      if (bytesRead <= 0) {
        return null;
      }
      virtualDisplayHash.update(virtualDisplayBuffer.subarray(0, bytesRead));
      virtualDisplayPosition += bytesRead;
    }
    if (virtualDisplayHash.digest('hex') !== manifest.virtualDisplay.sha256) {
      return null;
    }

    if (asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
      && legacyManifest) {
      const bytes = Buffer.from(JSON.stringify({
        ...manifest,
        protocolVersion: REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION,
      }));
      await executable.close();
      executable = null;
      await virtualDisplayHandle.close();
      virtualDisplayHandle = null;
      return {
        bytes,
        close: async () => {},
        filename: manifestFilename,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        version: manifest.workerVersion,
      };
    }

    const requestedPath = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
      ? executablePath
      : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
        ? manifestPath : virtualDisplayPath;
    const requestedPathStat = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
      ? executablePathStat
      : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
        ? manifestPathStat : virtualDisplayPathStat;
    requested = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
      ? executable
      : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY
        ? virtualDisplayHandle : await open(requestedPath, 'r');
    if (requested === executable) executable = null;
    if (requested === virtualDisplayHandle) virtualDisplayHandle = null;
    else {
      await virtualDisplayHandle.close();
      virtualDisplayHandle = null;
    }
    const requestedStat = await requested.stat();
    if (!requestedStat.isFile() || requestedStat.size !== requestedPathStat.size
      || requestedStat.mtimeMs !== requestedPathStat.mtimeMs
      || requestedStat.ctimeMs !== requestedPathStat.ctimeMs) return null;
    const requestedHash = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
      ? manifest.sha256
      : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
        ? createHash('sha256').update(rawManifest).digest('hex')
        : manifest.virtualDisplay.sha256;
    let closed = false;
    const pinned = requested;
    requested = null;
    return {
      handle: pinned,
      close: async () => {
        if (closed) return;
        closed = true;
        await pinned.close().catch(() => {});
      },
      filename: asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
        ? REMOTE_DESKTOP_WORKER_FILENAME
        : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
          ? manifestFilename : REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
      sizeBytes: requestedStat.size,
      sha256: requestedHash,
      version: manifest.workerVersion,
    };
  } catch {
    return null;
  } finally {
    await executable?.close().catch(() => {});
    await manifestHandle?.close().catch(() => {});
    await virtualDisplayHandle?.close().catch(() => {});
    await requested?.close().catch(() => {});
  }
}

export type ControlledNodeUpgradeArtifactUnavailableReason =
  | 'executable_not_built'
  | 'remote_desktop_worker_not_built'
  | 'windows_release_version_mismatch'
  | 'desktop_release_manifest_invalid'
  | 'desktop_release_manifest_mismatch';

export interface ControlledNodeUpgradeArtifactAvailability {
  /** False when IMCODES_NODE_EXE_DIR is unset/empty (artifact catalog not configured). */
  configured: boolean;
  available: boolean;
  reason?: ControlledNodeUpgradeArtifactUnavailableReason;
}

/**
 * Determine whether the running server image bundles a verified controlled-node
 * upgrade release unit for the target platform `(os, arch, abiProfile)`.
 * Mirrors `/api/enroll/v2/node-artifact` gating so UI discovery, auto-upgrade,
 * and manual upgrade endpoints stay aligned when an image intentionally omits
 * a platform (e.g. Windows artifacts on `:dev` builds).
 */
export type NodeDesktopReleaseManifestCheckResult =
  | { ok: true; releaseManifestSha256?: string }
  | { ok: false; error: 'desktop_release_manifest_invalid' | 'desktop_release_manifest_mismatch'; reason?: string };

/**
 * Verify published per-target Desktop Release Manifest alignment for a `node` artifact.
 * For `mac:universal`, uses the resolved runtime arch when known (returning its pinned
 * manifest SHA-256), and verifies all published macOS targets (`darwin-arm64`,
 * `darwin-x64`) while omitting an ambiguous pinned hash when runtime arch is unknown.
 */
export async function verifyDesktopReleaseManifestForNodeArtifact(
  dir: string,
  artifactOs: ControlledNodeOs,
  artifactArch: ControlledNodeArtifactArch,
  descriptor: { version: string; sha256: string; sizeBytes: number },
  runtimeArch?: ControlledNodeArch | null,
): Promise<NodeDesktopReleaseManifestCheckResult> {
  const isUniversalMac = artifactOs === CONTROLLED_NODE_OS_MAC
    && artifactArch === CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL;
  let targetsToCheck: DesktopReleaseTarget[] = [];
  let emitPinnedHeader = false;

  if (isUniversalMac) {
    if (runtimeArch) {
      const target = controlledNodeDaemonRuntimeTarget(artifactOs, runtimeArch);
      if (target) {
        targetsToCheck = [target];
        emitPinnedHeader = true;
      }
    } else {
      targetsToCheck = [CONTROLLED_NODE_ARCH_ARM64, CONTROLLED_NODE_ARCH_X64]
        .map((candidate) => controlledNodeDaemonRuntimeTarget(artifactOs, candidate))
        .filter((target): target is DesktopReleaseTarget => target !== null);
      emitPinnedHeader = false;
    }
  } else {
    const target = controlledNodeDaemonRuntimeTarget(artifactOs, artifactArch);
    if (target) {
      targetsToCheck = [target];
      emitPinnedHeader = true;
    }
  }

  let releaseManifestSha256: string | undefined;
  for (const target of targetsToCheck) {
    const releaseCheck = await openDesktopReleaseManifestArtifact(dir, target);
    if (releaseCheck.status === 'invalid') {
      return { ok: false, error: 'desktop_release_manifest_invalid', reason: releaseCheck.reason };
    }
    if (releaseCheck.status === 'ok') {
      await releaseCheck.close();
      const entry = releaseCheck.manifest.targets[target]?.components['imcodes-node'];
      if (entry && (entry.sha256 !== descriptor.sha256 || entry.sizeBytes !== descriptor.sizeBytes || entry.version !== descriptor.version)) {
        return { ok: false, error: 'desktop_release_manifest_mismatch' };
      }
      if (emitPinnedHeader) {
        releaseManifestSha256 = releaseCheck.sha256;
      }
    }
  }
  return { ok: true, ...(releaseManifestSha256 ? { releaseManifestSha256 } : {}) };
}

export async function checkControlledNodeUpgradeArtifactAvailability(input: {
  os?: string | null;
  arch?: string | null;
  abiProfile?: unknown;
  artifactDir?: string | null;
  artifactCatalog?: ArtifactCatalog;
}): Promise<ControlledNodeUpgradeArtifactAvailability> {
  const dir = (input.artifactDir ?? process.env.IMCODES_NODE_EXE_DIR)?.trim();
  if (!dir) {
    return { configured: false, available: true };
  }

  const rawOs = typeof input.os === 'string' ? input.os.trim().toLowerCase() : '';
  const os: ControlledNodeOs | null = rawOs === 'win32' || rawOs === CONTROLLED_NODE_OS_WIN
    ? CONTROLLED_NODE_OS_WIN
    : rawOs === 'darwin' || rawOs === CONTROLLED_NODE_OS_MAC
      ? CONTROLLED_NODE_OS_MAC
      : rawOs === CONTROLLED_NODE_OS_LINUX
        ? CONTROLLED_NODE_OS_LINUX
        : null;
  if (!os) {
    return { configured: true, available: false, reason: 'executable_not_built' };
  }

  const rawArch = typeof input.arch === 'string' && input.arch.trim() ? input.arch.trim().toLowerCase() : null;
  const fallbackArch = os === CONTROLLED_NODE_OS_MAC
    ? CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL
    : CONTROLLED_NODE_ARCH_X64;
  const profile = input.abiProfile === undefined || input.abiProfile === null
    ? CONTROLLED_NODE_ABI_MODERN
    : normalizeControlledNodeAbiProfile(input.abiProfile);
  if (!profile) {
    return { configured: true, available: false, reason: 'executable_not_built' };
  }
  const artifactTarget = normalizeControlledNodeArtifactPair(os, rawArch ?? fallbackArch, profile);
  if (!artifactTarget) {
    return { configured: true, available: false, reason: 'executable_not_built' };
  }
  const targetAbi = artifactTarget.abiProfile ?? profile;
  const catalog = input.artifactCatalog ?? defaultArtifactCatalog;
  const v = await catalog.ensureVerified(dir, artifactTarget.os, artifactTarget.arch, targetAbi);
  if (!v.ok) {
    return { configured: true, available: false, reason: 'executable_not_built' };
  }

  if (artifactTarget.os === CONTROLLED_NODE_OS_WIN && artifactTarget.arch === CONTROLLED_NODE_ARCH_X64) {
    const workerRelease = await openRemoteDesktopWorkerArtifact(
      dir,
      CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST,
    );
    if (!workerRelease) {
      return { configured: true, available: false, reason: 'remote_desktop_worker_not_built' };
    }
    const workerVersionMatches = workerRelease.version === v.descriptor.version;
    await workerRelease.close();
    if (!workerVersionMatches) {
      return { configured: true, available: false, reason: 'windows_release_version_mismatch' };
    }
  }

  if (targetAbi === CONTROLLED_NODE_ABI_MODERN) {
    const manifestCheck = await verifyDesktopReleaseManifestForNodeArtifact(
      dir,
      artifactTarget.os,
      artifactTarget.arch,
      v.descriptor,
      resolveControlledNodeRuntimeArch(rawArch),
    );
    if (!manifestCheck.ok) {
      return { configured: true, available: false, reason: manifestCheck.error };
    }
  }

  return { configured: true, available: true };
}
