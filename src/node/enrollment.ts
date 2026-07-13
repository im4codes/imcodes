import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import {
  NODE_ROLE,
  ENROLLMENT_REDEEM_VERSION_V2,
  ENROLLMENT_MAX_TRAILER_BYTES,
  ENROLLMENT_NODE_TOKEN_HASH_HEX_LEN,
  encodeEnrollmentTrailer,
  decodeEnrollmentTrailer,
  decodeEnrollmentTrailerWithRange,
  enrollmentOsFromNodePlatform,
  isEnrollmentNodeTokenHash,
  type EnrollRedeemV2Request,
  type EnrollRedeemV2Response,
  type EnrollmentBlob,
  type EnrollmentTrailerRange,
} from '../../shared/remote-exec.js';
import {
  applyWindowsAclCommands,
  windowsCredentialDir,
  windowsSecretFileAclCommands,
} from './installer.js';

export interface ControlledNodeCredential {
  serverId: string;
  token: string;
  serverUrl: string;
  nodeRole: typeof NODE_ROLE.CONTROLLED;
  refName?: string;
  displayName?: string;
}

export interface InstallIdentity {
  installId: string;
  nodeToken: string;
  nodeTokenHash: string;
}

export interface PendingInstallIdentity extends InstallIdentity {
  sourceExePath: string;
}

export interface EnrollmentRuntimeIdentity {
  platform: string;
  arch: string;
  hostname: string;
}

export interface FileIdentity {
  dev?: number;
  ino?: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface StagedExecutableReceipt {
  path: string;
  size: number;
  sha256: string;
  sourceIdentity: FileIdentity;
  stagedIdentity: FileIdentity;
}

export interface VerifiedEnrollmentSource {
  readonly sourcePath: string;
  readonly identity: FileIdentity;
  statSize(): Promise<number>;
  readExactly(position: number, length: number): Promise<Buffer>;
  readEnrollmentBlobWithRange(): Promise<EnrollmentTrailerRange | null>;
  stageTrailerFreeExecutable(destPath: string, trailerStart: number): Promise<StagedExecutableReceipt>;
  cleanupEnrollmentSource(trailerStart: number, trailerLength: number): Promise<SourceCleanupStatus>;
  close(): Promise<void>;
}

export type SourceCleanupStatus = 'pending' | 'cleaned' | 'skipped' | 'failed';

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function fsyncParentDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dirname(path), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type NodeFileHandle = Awaited<ReturnType<typeof open>>;
type StagingFileHandle = Pick<NodeFileHandle, 'write' | 'sync' | 'close'>;

export interface EnrollmentStagingFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  openDestination(path: string, flags: string, mode: number): Promise<StagingFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<Stats>;
  fsyncParentDirectory(path: string): Promise<void>;
}

const DEFAULT_ENROLLMENT_STAGING_FS: EnrollmentStagingFs = {
  mkdir,
  chmod,
  openDestination: (path, flags, mode) => open(path, flags, mode),
  rename,
  unlink,
  lstat,
  fsyncParentDirectory,
};

export function createEnrollmentStagingFs(
  overrides: Partial<EnrollmentStagingFs> = {},
): EnrollmentStagingFs {
  return { ...DEFAULT_ENROLLMENT_STAGING_FS, ...overrides };
}

function fileIdentityFromStat(stat: {
  dev?: number;
  ino?: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): FileIdentity {
  return {
    ...(typeof stat.dev === 'number' ? { dev: stat.dev } : {}),
    ...(typeof stat.ino === 'number' ? { ino: stat.ino } : {}),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  const stableMetadata = a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined) {
    return a.dev === b.dev && a.ino === b.ino && stableMetadata;
  }
  return stableMetadata;
}

function sourceOpenFlags(readWrite = false): number | string {
  const base = readWrite ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
  const nofollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  return base | nofollow;
}

async function openNoFollow(path: string, readWrite = false): Promise<Awaited<ReturnType<typeof open>>> {
  return open(path, sourceOpenFlags(readWrite));
}

export async function readExactly(
  handle: Pick<NodeFileHandle, 'read'>,
  position: number,
  length: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error('read_exactly_invalid_position');
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('read_exactly_invalid_length');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw new Error('read_exactly_eof');
    offset += bytesRead;
  }
  return buffer;
}

export async function writeExactly(
  handle: Pick<NodeFileHandle, 'write'>,
  buffer: Buffer,
  position: number,
): Promise<void> {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error('write_exactly_invalid_position');
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten <= 0) throw new Error('write_exactly_no_progress');
    offset += bytesWritten;
  }
}

class VerifiedEnrollmentSourceImpl implements VerifiedEnrollmentSource {
  readonly sourcePath: string;
  readonly identity: FileIdentity;
  private closed = false;

  constructor(
    sourcePath: string,
    private readonly handle: NodeFileHandle,
    identity: FileIdentity,
    private readonly stagingFs: EnrollmentStagingFs,
  ) {
    this.sourcePath = sourcePath;
    this.identity = identity;
  }

  async statSize(): Promise<number> {
    const stat = await this.handle.stat();
    return stat.size;
  }

  async readExactly(position: number, length: number): Promise<Buffer> {
    const stat = await this.handle.stat();
    if (position + length > stat.size) throw new Error('read_exactly_range_exceeds_source');
    return readExactly(this.handle, position, length);
  }

  async readEnrollmentBlobWithRange(): Promise<EnrollmentTrailerRange | null> {
    const size = await this.statSize();
    const tailFileOffset = Math.max(0, size - ENROLLMENT_MAX_TRAILER_BYTES);
    const length = size - tailFileOffset;
    if (length <= 0) return null;
    const buf = await this.readExactly(tailFileOffset, length);
    return decodeEnrollmentTrailerWithRange(buf, tailFileOffset);
  }

  async stageTrailerFreeExecutable(destPath: string, trailerStart: number): Promise<StagedExecutableReceipt> {
    if (trailerStart <= 0) throw new Error('invalid_trailer_start');
    const currentSize = await this.statSize();
    if (trailerStart > currentSize) throw new Error('trailer_start_exceeds_source_size');
    await this.stagingFs.mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await this.stagingFs.chmod(dirname(destPath), 0o700);
    const temp = `${destPath}.${process.pid}.${randomUUID()}.tmp`;
    let dst: StagingFileHandle | null = null;
    let renamed = false;
    const hash = createHash('sha256');
    let written = 0;
    try {
      dst = await this.stagingFs.openDestination(temp, 'wx', 0o700);
      const chunkSize = 64 * 1024;
      while (written < trailerStart) {
        const toRead = Math.min(chunkSize, trailerStart - written);
        const buf = await this.readExactly(written, toRead);
        await writeExactly(dst, buf, written);
        hash.update(buf);
        written += buf.length;
      }
      await dst.sync();
      await dst.close();
      dst = null;
      if (process.platform !== 'win32') await this.stagingFs.chmod(temp, 0o755);
      await this.stagingFs.rename(temp, destPath);
      renamed = true;
      await this.stagingFs.fsyncParentDirectory(destPath);
    } catch (error) {
      await dst?.close().catch(() => {});
      if (!renamed) await this.stagingFs.unlink(temp).catch(() => {});
      throw error;
    } finally {
      if (dst) await dst.close().catch(() => {});
    }
    const stagedStat = await this.stagingFs.lstat(destPath);
    if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) throw new Error('staged_executable_not_regular');
    return {
      path: destPath,
      size: trailerStart,
      sha256: hash.digest('hex'),
      sourceIdentity: this.identity,
      stagedIdentity: fileIdentityFromStat(stagedStat),
    };
  }

  async cleanupEnrollmentSource(trailerStart: number, trailerLength: number): Promise<SourceCleanupStatus> {
    if (trailerLength <= 0 || trailerStart < 0) return 'skipped';
    let cleanupHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const before = await lstat(this.sourcePath);
      if (before.isSymbolicLink() || !sameFileIdentity(this.identity, fileIdentityFromStat(before))) return 'skipped';
      cleanupHandle = await openNoFollow(this.sourcePath, true);
      const after = await cleanupHandle.stat();
      if (!sameFileIdentity(this.identity, fileIdentityFromStat(after))) return 'skipped';
      // EXACT WRITE LOOP: a single `write()` may return short. Use the shared
      // `writeExactly` helper so partial writes or no-progress writes are
      // converted into a `failed` status (not a false `cleaned`).
      try {
        await writeExactly(cleanupHandle, Buffer.alloc(trailerLength), trailerStart);
        await cleanupHandle.sync();
        return 'cleaned';
      } catch {
        return 'failed';
      }
    } catch (error) {
      if (isNotFoundError(error)) return 'skipped';
      return 'failed';
    } finally {
      if (cleanupHandle) await cleanupHandle.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

export async function openVerifiedEnrollmentSource(
  sourcePath = process.execPath,
  stagingFs: EnrollmentStagingFs = createEnrollmentStagingFs(),
): Promise<VerifiedEnrollmentSource> {
  const before = await lstat(sourcePath);
  if (before.isSymbolicLink()) throw new Error('enrollment_source_is_symlink');
  if (!before.isFile()) throw new Error('enrollment_source_not_regular');
  const handle = await openNoFollow(sourcePath);
  try {
    const after = await handle.stat();
    if (!after.isFile() || !sameFileIdentity(fileIdentityFromStat(before), fileIdentityFromStat(after))) {
      throw new Error('enrollment_source_identity_changed');
    }
    return new VerifiedEnrollmentSourceImpl(sourcePath, handle, fileIdentityFromStat(after), stagingFs);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertWritablePathIsNotSymlink(path: string, errorCode: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Error(errorCode);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

async function writeProtectedJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') await chmod(temp, 0o600);
  await rename(temp, path);
  if (process.platform === 'win32') {
    applyWindowsAclCommands(windowsSecretFileAclCommands(path));
  }
  await fsyncParentDirectory(path);
}

// Framing lives in shared/ (10.4): the server download route and the node use
// one implementation. The node keeps only the IO layer. These thin wrappers
// preserve the historical names used by callers/tests.
export function encodeEnrollmentBlob(blob: EnrollmentBlob): Buffer {
  return encodeEnrollmentTrailer(blob);
}

export function parseEnrollmentBlob(data: Buffer): EnrollmentBlob | null {
  return decodeEnrollmentTrailer(data);
}

export function hashNodeToken(nodeToken: string): string {
  return createHash('sha256').update(nodeToken, 'utf8').digest('hex');
}

export function defaultCredentialPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(windowsCredentialDir(), 'credential.json');
  return platform === 'darwin'
    ? '/Library/Application Support/imcodes-node/credential.json'
    : '/var/lib/imcodes-node/credential.json';
}

export function defaultInstallIdentityPath(credentialPath = defaultCredentialPath()): string {
  return join(dirname(credentialPath), 'install-identity.json');
}

/** Stable trailer-free executable path used by boot autostart (distinct from download path). */
export function defaultStagedExecutablePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(windowsCredentialDir(), 'imcodes-node.exe');
  if (platform === 'darwin') return '/Library/Application Support/imcodes-node/imcodes-node-macos';
  return '/var/lib/imcodes-node/imcodes-node-linux';
}

/** Read only the executable's tail (random access, no full-file load). */
export async function readEnrollmentBlob(executablePath = process.execPath): Promise<EnrollmentBlob | null> {
  const withRange = await readEnrollmentBlobWithRange(executablePath);
  return withRange?.blob ?? null;
}

/** Read enrollment blob and its exact trailer byte range from the executable tail. */
export async function readEnrollmentBlobWithRange(executablePath = process.execPath): Promise<EnrollmentTrailerRange | null> {
  let source: VerifiedEnrollmentSource | null = null;
  try {
    source = await openVerifiedEnrollmentSource(executablePath);
    return source.readEnrollmentBlobWithRange();
  } catch {
    return null;
  } finally {
    if (source) await source.close().catch(() => {});
  }
}

export function generateInstallIdentity(): InstallIdentity {
  const nodeToken = randomBytes(32).toString('hex');
  const nodeTokenHash = hashNodeToken(nodeToken);
  if (!isEnrollmentNodeTokenHash(nodeTokenHash)) {
    throw new Error('generated nodeTokenHash is invalid');
  }
  return { installId: randomUUID(), nodeToken, nodeTokenHash };
}

export interface ProtectedSecretLoadOptions {
  platform?: NodeJS.Platform;
  assertCredentialDirSecured?: (dir: string) => void | Promise<void>;
}

async function assertSecretPathProtected(path: string, label: 'credential' | 'install_identity', options: ProtectedSecretLoadOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${label}_path_not_regular`);
    const assert = options.assertCredentialDirSecured ?? assertCredentialDirSecuredDefault;
    await assert(dirname(path));
    await assert(path);
    return;
  }
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error(`${label}_path_is_symlink`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${label}_permissions_insecure`);
}

export async function loadInstallIdentity(
  path = defaultInstallIdentityPath(),
  options: ProtectedSecretLoadOptions = {},
): Promise<PendingInstallIdentity | null> {
  try {
    await assertSecretPathProtected(path, 'install_identity', options);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PendingInstallIdentity>;
    if (!parsed.installId || !parsed.nodeToken || !parsed.nodeTokenHash || !parsed.sourceExePath) {
      throw new Error('install_identity_invalid');
    }
    if (hashNodeToken(parsed.nodeToken) !== parsed.nodeTokenHash) throw new Error('install_identity_hash_mismatch');
    if (!isEnrollmentNodeTokenHash(parsed.nodeTokenHash)) throw new Error('install_identity_hash_invalid');
    return parsed as PendingInstallIdentity;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

/** Persist install identity BEFORE any network redeem (D-A). */
export async function persistInstallIdentity(
  identity: PendingInstallIdentity,
  path = defaultInstallIdentityPath(),
): Promise<void> {
  await assertWritablePathIsNotSymlink(path, 'install_identity_path_is_symlink');
  await writeProtectedJson(path, identity);
}

export async function loadCredential(
  path: string = defaultCredentialPath(),
  options: ProtectedSecretLoadOptions = {},
): Promise<ControlledNodeCredential | null> {
  try {
    // Validate the live descriptor/ACL BEFORE parsing either reusable secret.
    // On Windows tool absence or malformed ACL output rejects the load.
    await assertSecretPathProtected(path, 'credential', options);
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ControlledNodeCredential>;
    if (value.nodeRole !== NODE_ROLE.CONTROLLED || !value.serverId || !value.token || !value.serverUrl) {
      throw new Error('credential_invalid');
    }
    return value as ControlledNodeCredential;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

// Lazy-resolved at first call so the test seam (which mutates the module
// export) can take effect without breaking import order. Implementation is
// `windows-security.assertCredentialDirSecured`.
let _assertCredentialDirSecuredImpl: ((dir: string) => void | Promise<void>) | null = null;
async function assertCredentialDirSecuredDefault(dir: string): Promise<void> {
  if (!_assertCredentialDirSecuredImpl) {
    const mod = await import('./windows-security.js');
    _assertCredentialDirSecuredImpl = mod.assertCredentialDirSecured;
  }
  await _assertCredentialDirSecuredImpl!(dir);
}

export async function persistCredential(credential: ControlledNodeCredential, path = defaultCredentialPath()): Promise<void> {
  await assertWritablePathIsNotSymlink(path, 'credential_path_is_symlink');
  await writeProtectedJson(path, credential);
}

export function buildEnrollRedeemV2Request(
  blob: EnrollmentBlob,
  identity: InstallIdentity,
  runtime: EnrollmentRuntimeIdentity = {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
  },
): EnrollRedeemV2Request {
  return {
    version: ENROLLMENT_REDEEM_VERSION_V2,
    enrollToken: blob.enrollToken,
    installId: identity.installId,
    nodeTokenHash: identity.nodeTokenHash,
    hostname: runtime.hostname,
    os: enrollmentOsFromNodePlatform(runtime.platform),
    arch: runtime.arch,
  };
}

/** D-A v2 redeem — sends installId + nodeTokenHash; response MUST NOT carry a raw token. */
export async function redeemEnrollmentV2(
  blob: EnrollmentBlob,
  identity: InstallIdentity,
  fetchFn: typeof fetch = fetch,
): Promise<ControlledNodeCredential> {
  const expectedOrigin = allowedEnrollmentServerOrigin(blob.serverUrl);
  const body = buildEnrollRedeemV2Request(blob, identity);
  const redeemUrl = new URL('/api/enroll/v2/redeem', expectedOrigin).toString();
  const response = await fetchFn(redeemUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  if (response.redirected) throw new Error('enrollment_redeem_redirect_rejected');
  let responseOrigin: string;
  try {
    responseOrigin = new URL(response.url).origin;
  } catch {
    throw new Error('enrollment_redeem_response_url_invalid');
  }
  if (responseOrigin !== expectedOrigin) throw new Error('enrollment_redeem_origin_mismatch');
  if (!response.ok) throw new Error(`enrollment_redeem_failed:${response.status}`);
  const value = await response.json() as EnrollRedeemV2Response & { token?: string };
  if ('token' in value && value.token) throw new Error('enrollment_redeem_v2_returned_raw_token');
  if (value.nodeRole !== NODE_ROLE.CONTROLLED || !value.serverId) throw new Error('enrollment_redeem_invalid_response');
  return {
    serverId: value.serverId,
    token: identity.nodeToken,
    serverUrl: expectedOrigin,
    nodeRole: NODE_ROLE.CONTROLLED,
    refName: value.refName,
    displayName: value.displayName,
  };
}

/** Copy the trailer-free executable prefix to a stable protected path. */
export async function copyCleanExecutable(
  sourcePath: string,
  trailerStart: number,
  destPath: string,
): Promise<StagedExecutableReceipt> {
  let source: VerifiedEnrollmentSource | null = null;
  try {
    source = await openVerifiedEnrollmentSource(sourcePath);
    return await source.stageTrailerFreeExecutable(destPath, trailerStart);
  } finally {
    if (source) await source.close().catch(() => {});
  }
}

/**
 * Best-effort privacy cleanup of the downloaded source executable's trailer.
 * Failure (e.g. locked running image on Windows) is surfaced, not swallowed.
 */
export async function cleanupEnrollmentSource(
  sourcePath: string,
  trailerStart: number,
  trailerLength: number,
): Promise<SourceCleanupStatus> {
  if (trailerLength <= 0 || trailerStart < 0) return 'skipped';
  let source: VerifiedEnrollmentSource | null = null;
  try {
    source = await openVerifiedEnrollmentSource(sourcePath);
    return await source.cleanupEnrollmentSource(trailerStart, trailerLength);
  } catch (error) {
    if (isNotFoundError(error)) return 'skipped';
    return 'failed';
  } finally {
    if (source) await source.close().catch(() => {});
  }
}

/**
 * Best-effort token burn (D-A privacy cleanup only, NOT a security boundary).
 * Prefer {@link cleanupEnrollmentSource} when the exact trailer range is known.
 */
export async function burnEnrollmentBlob(executablePath = process.execPath): Promise<void> {
  const range = await readEnrollmentBlobWithRange(executablePath);
  if (!range) return;
  const status = await cleanupEnrollmentSource(executablePath, range.trailerStart, range.trailerLength);
  if (status === 'failed') throw new Error('enrollment_burn_failed');
}

export function assertProductionServerUrl(serverUrl: string): void {
  allowedEnrollmentServerOrigin(serverUrl);
}

function isLocalDevelopmentHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1'
    || normalized === '[::1]';
}

/**
 * Validate and canonicalize the enrollment server URL to a single trusted
 * origin. Plain HTTP is available only for explicitly-enabled loopback dev
 * servers; credentials, paths, queries, and fragments are never accepted.
 */
export function allowedEnrollmentServerOrigin(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error('enrollment_server_url_invalid');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('enrollment_server_url_must_be_origin');
  }
  const secure = url.protocol === 'https:';
  const localDev = url.protocol === 'http:'
    && process.env.IMCODES_NODE_ALLOW_HTTP_ENROLL === '1'
    && isLocalDevelopmentHostname(url.hostname);
  if (!secure && !localDev) throw new Error('enrollment_server_url_must_be_https');
  return url.origin;
}

export function isValidNodeTokenHash(value: string): boolean {
  return isEnrollmentNodeTokenHash(value) && value.length === ENROLLMENT_NODE_TOKEN_HASH_HEX_LEN;
}
