/**
 * Daemon-side file transfer handler.
 * Handles upload persistence, download resolution, and lifecycle cleanup.
 */
import { constants as fsConstants, createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { copyFile, link, mkdir, open, writeFile, readFile, readdir, stat, lstat, unlink, realpath as fsRealpath } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import logger from '../util/logger.js';
import {
  FILE_TRANSFER_LIMITS,
  FILE_TRANSFER_DIRECTORY_MAX_ENTRIES,
  FILE_TRANSFER_DIRECTORY_PATH,
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_DELETE_ERROR,
  FILE_TRANSFER_UPLOAD_ERROR_CODE,
  FILE_PATH_HANDLE_ERROR,
  type AttachmentRef,
  type FileUploadRequest,
  type FileUploadFetchRequest,
  type FileUploadDone,
  type FileUploadError,
  type FileUploadProgress,
  type FileDownloadRequest,
  type FileDownloadStreamRequest,
  type FileDownloadDone,
  type FileDownloadStreamReady,
  type FileDownloadError,
  validateFilePathHandleRequest,
  type FilePathHandleErrorReason,
  type FileDirectoryEntry,
  type FileDirectoryListDone,
  type FileDirectoryListError,
  type FileDeleteDone,
  type FileDeleteError,
  validateFileDeleteRequest,
  validateFileDirectoryListRequest,
} from '../../shared/transport/file-transfer.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { resolveCanonical, validateCanonicalRealPath } from './file-preview-path-policy.js';
import type { ValidatedRealPath } from './file-preview-path-policy.js';
export type { ValidatedRealPath } from './file-preview-path-policy.js';

/** Minimal reusable sender boundary implemented by both ServerLink and the thin node runtime. */
export interface FileTransferSender {
  send(message: unknown): unknown;
}

/** Upload directory — ~/.imcodes/uploads (persists across reboots, unlike /tmp). */
const UPLOAD_DIR = path.join(homedir(), '.imcodes', 'uploads');

// ── Attachment registry ─────────────────────────────────────────────────────

export interface TryCreateProjectFileHandleOptions {
  /**
   * Lenient canonicalization fallback paths are useful for best-effort
   * directory listings, but they are not canonical enough to mint handles.
   */
  usedFallback?: boolean;
}

type LocalDownloadErrorMessage = 'not_found' | 'expired' | 'download_failed';

interface AttachmentEntry {
  id: string;
  daemonPath: string;
  source: 'upload' | 'local';
  originalName?: string;
  mime?: string;
  size?: number;
  createdAt: number;
  expiresAt: number;
  /** Stable browser upload identity used to deduplicate direct → relay fallback. */
  clientUploadId?: string;
  /** Local-handle identity prevents path replacement between mint and read. */
  device?: number;
  inode?: number;
}

interface DownloadTarget {
  entry: AttachmentEntry;
  readPath: string;
  filename: string;
  mime?: string;
  size: number;
}

/**
 * A daemon-validated source for the direct-file data plane.  It deliberately
 * contains the resolved daemon path only after the existing attachment-handle
 * and file-preview checks have run; callers must never accept a browser path.
 */
export interface DirectFileDownloadSource {
  readPath: string;
  filename: string;
  mime?: string;
  size: number;
}

const attachmentRegistry = new Map<string, AttachmentEntry>();
const clientUploadClaims = new Map<string, {
  token: symbol;
  released: Promise<void>;
  release: () => void;
}>();

/**
 * Serialize direct transfer and relay fallback attempts that share the same
 * browser-generated identity. This closes the ambiguous-completion window:
 * relay waits for the direct writer to either commit or release its claim.
 */
export function tryClaimClientUpload(clientUploadId: string): symbol | null {
  if (clientUploadClaims.has(clientUploadId)) return null;
  const token = Symbol(clientUploadId);
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  clientUploadClaims.set(clientUploadId, { token, released, release });
  return token;
}

export function waitForClientUploadClaim(clientUploadId: string): Promise<void> | null {
  return clientUploadClaims.get(clientUploadId)?.released ?? null;
}

export function releaseClientUploadClaim(clientUploadId: string, token: symbol): void {
  const claim = clientUploadClaims.get(clientUploadId);
  if (!claim || claim.token !== token) return;
  clientUploadClaims.delete(clientUploadId);
  claim.release();
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function toValidatedRealPath(realPath: string): ValidatedRealPath {
  const validated = validateCanonicalRealPath(realPath);
  if (!validated) throw new Error(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
  return validated;
}

export async function validateProjectFilePath(filePath: string): Promise<ValidatedRealPath> {
  const realPath = await fsRealpath(path.resolve(filePath));
  return toValidatedRealPath(realPath);
}

function validateProjectFilePathSync(filePath: string): ValidatedRealPath {
  const realPath = realpathSync(path.resolve(filePath));
  return toValidatedRealPath(realPath);
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function sanitizeLocalDownloadError(err: unknown): LocalDownloadErrorMessage {
  return isNotFoundError(err) ? 'not_found' : 'download_failed';
}

function sendDownloadError(
  serverLink: FileTransferSender,
  downloadId: string,
  attachmentId: string,
  entry: AttachmentEntry | undefined,
  err: unknown,
): void {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error({ downloadId, attachmentId, err }, 'File download failed');
  const response: FileDownloadError = {
    type: 'file.download_error',
    downloadId,
    message: entry?.source === 'local'
      ? sanitizeLocalDownloadError(err)
      : (errMsg.includes('ENOENT') ? 'not_found' : errMsg),
  };
  serverLink.send(response);
}

export async function resolveDirectFileDownloadSource(attachmentId: string): Promise<DirectFileDownloadSource> {
  const entry = attachmentRegistry.get(attachmentId);

  if (!entry) {
    throw new Error('not_found');
  }

  if (Date.now() > entry.expiresAt) {
    attachmentRegistry.delete(attachmentId);
    throw new Error('expired');
  }

  const resolved = path.resolve(entry.daemonPath);
  const uploadDirResolved = path.resolve(UPLOAD_DIR);
  const isUpload = resolved.startsWith(uploadDirResolved + path.sep);
  if (!isUpload && entry.source !== 'local') {
    throw new Error('not_found');
  }

  if (entry.source === 'local') {
    const current = await lstat(entry.daemonPath);
    if (current.isSymbolicLink() || !current.isFile()) throw new Error('download_failed');
    if ((entry.device !== undefined && current.dev !== entry.device)
      || (entry.inode !== undefined && current.ino !== entry.inode)
      // Overlay/container filesystems can immediately reuse an inode when a
      // path is unlinked and recreated. Preserve the minted size as an
      // additional identity component so that replacement still fails closed.
      || (entry.size !== undefined && current.size !== entry.size)) {
      throw new Error('download_failed');
    }
  }
  const readPath = entry.source === 'local' ? await validateProjectFilePath(entry.daemonPath) : resolved;
  const fileStat = await stat(readPath);
  if (!fileStat.isFile()) throw new Error('download_failed');

  return {
    readPath,
    filename: entry.originalName || attachmentId,
    mime: entry.mime,
    size: fileStat.size,
  };
}

async function resolveDownloadTarget(
  attachmentId: string,
  serverLink: FileTransferSender,
  downloadId: string,
): Promise<DownloadTarget | null> {
  const entry = attachmentRegistry.get(attachmentId);
  try {
    const source = await resolveDirectFileDownloadSource(attachmentId);
    return { entry: entry!, ...source };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'not_found' || message === 'expired') {
      serverLink.send({
        type: 'file.download_error',
        downloadId,
        message,
      } satisfies FileDownloadError);
      return null;
    }
    sendDownloadError(serverLink, downloadId, attachmentId, entry, err);
    return null;
  }
}

export function resolveUploadPath(filename: string): string {
  const filePath = path.join(UPLOAD_DIR, filename);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    throw new Error('path_traversal');
  }
  return resolved;
}

function validateDestinationFileName(originalName: string): string {
  const stem = originalName.replace(/[. ]+$/g, '').split('.')[0]?.toUpperCase() ?? '';
  if (!originalName || originalName === '.' || originalName === '..'
    || originalName !== path.basename(originalName)
    || Buffer.byteLength(originalName, 'utf8') > 255
    || /[\u0000-\u001f<>:"/\\|?*]/.test(originalName)
    || /[. ]$/.test(originalName)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new Error('invalid_destination_name');
  }
  return originalName;
}

async function commitUploadedFileToDirectory(
  stagedPath: string,
  destinationDirectory: string,
  originalName: string,
): Promise<string> {
  const safeName = validateDestinationFileName(originalName);
  const requestedDirectory = path.resolve(destinationDirectory);
  const directoryStat = await lstat(requestedDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('invalid_destination_directory');
  }
  const directory = await validateProjectFilePath(requestedDirectory);
  const destination = path.join(directory, safeName);
  if (path.dirname(destination) !== directory) throw new Error('invalid_destination_name');
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) throw new Error('destination_exists');

  const siblingTemp = path.join(directory, `.${safeName}.imcodes-${randomHex(12)}.part`);
  try {
    await copyFile(stagedPath, siblingTemp, fsConstants.COPYFILE_EXCL);
    const handle = await open(siblingTemp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The sibling hard-link is the atomic, no-overwrite commit point. It keeps
    // a complete target invisible until every byte has been written and synced.
    await link(siblingTemp, destination);
    await unlink(siblingTemp);
    await unlink(stagedPath).catch(() => {});
    return destination;
  } catch (error) {
    await unlink(siblingTemp).catch(() => {});
    throw error;
  }
}

async function finalizeUploadedFile(params: {
  uploadId: string;
  filename: string;
  originalName?: string;
  mime?: string;
  resolved: string;
  size: number;
  serverLink: FileTransferSender;
  clientUploadId?: string;
  destinationDirectory?: string;
}): Promise<void> {
  const {
    uploadId,
    filename,
    originalName,
    mime,
    resolved,
    size,
    serverLink,
    clientUploadId,
    destinationDirectory,
  } = params;

  if (destinationDirectory) {
    const destination = await commitUploadedFileToDirectory(resolved, destinationDirectory, originalName ?? '');
    const destinationStat = await lstat(destination);
    const attachment = createProjectFileHandleFromValidatedPath(
      toValidatedRealPath(await fsRealpath(destination)),
      originalName ?? path.basename(destination),
      mime,
      destinationStat.size,
      { device: destinationStat.dev, inode: destinationStat.ino },
      clientUploadId,
    );
    serverLink.send({ type: FILE_TRANSFER_MSG.UPLOAD_DONE, uploadId, attachment } satisfies FileUploadDone);
    logger.info({ uploadId, size }, 'File upload committed to selected directory');
    return;
  }

  const metaPath = resolved + '.meta.json';
  await writeFile(metaPath, JSON.stringify({ originalName: originalName || filename, mime, clientUploadId })).catch(() => {});

  const now = Date.now();
  const attachment: AttachmentRef = {
    id: filename,
    source: 'upload',
    serverId: '', // server fills this before returning to client
    daemonPath: resolved,
    originalName: originalName || filename,
    mime,
    size,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + FILE_TRANSFER_LIMITS.TEMP_TTL_MS).toISOString(),
    downloadable: true,
  };

  attachmentRegistry.set(filename, {
    id: filename,
    daemonPath: resolved,
    source: 'upload',
    originalName: originalName || filename,
    mime,
    size,
    createdAt: now,
    expiresAt: now + FILE_TRANSFER_LIMITS.TEMP_TTL_MS,
    clientUploadId,
  });

  const response: FileUploadDone = {
    type: 'file.upload_done',
    uploadId,
    attachment,
  };
  serverLink.send(response);

  logger.info({ uploadId, filename, size }, 'File upload complete');
}

/**
 * Generate a daemon-owned upload filename. The user-controlled basename never
 * becomes part of the persisted path; only a conservative extension survives.
 */
export function createDirectUploadFilename(originalName: string): string {
  const ext = path.extname(originalName);
  const safeExt = /^\.[A-Za-z0-9]{1,20}$/.test(ext) ? ext : '';
  return `${randomHex(16)}${safeExt}`;
}

/** Return a committed upload for idempotent direct/relay retry handling. */
export function lookupAttachmentByClientUploadId(clientUploadId: string): AttachmentRef | undefined {
  for (const entry of attachmentRegistry.values()) {
    if (entry.clientUploadId !== clientUploadId) continue;
    return attachmentEntryToRef(entry);
  }
  return undefined;
}

async function acquireRelayUploadTurn(clientUploadId: string): Promise<
  { attachment: AttachmentRef; claim?: never } | { attachment?: never; claim: symbol }
> {
  while (true) {
    const attachment = lookupAttachmentByClientUploadId(clientUploadId);
    if (attachment) return { attachment };
    const claim = tryClaimClientUpload(clientUploadId);
    if (claim) {
      // The prior writer may have committed between the lookup and this claim.
      // Re-check while holding the claim so a relay never duplicates that file.
      const committed = lookupAttachmentByClientUploadId(clientUploadId);
      if (!committed) return { claim };
      releaseClientUploadClaim(clientUploadId, claim);
      return { attachment: committed };
    }
    const released = waitForClientUploadClaim(clientUploadId);
    if (released) await released;
  }
}

function attachmentEntryToRef(entry: AttachmentEntry): AttachmentRef {
  return {
    id: entry.id,
    source: entry.source,
    serverId: '',
    daemonPath: entry.daemonPath,
    originalName: entry.originalName,
    mime: entry.mime,
    size: entry.size,
    createdAt: new Date(entry.createdAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    downloadable: true,
  };
}

/** Commit a fully written direct-transfer temporary file into the attachment registry. */
export async function finalizeDirectUploadedFile(params: {
  clientUploadId: string;
  filename: string;
  originalName: string;
  mime?: string;
  resolved: string;
  size: number;
  destinationDirectory?: string;
}): Promise<AttachmentRef> {
  if (params.destinationDirectory) {
    const destination = await commitUploadedFileToDirectory(
      params.resolved,
      params.destinationDirectory,
      params.originalName,
    );
    const destinationStat = await lstat(destination);
    return createProjectFileHandleFromValidatedPath(
      toValidatedRealPath(await fsRealpath(destination)),
      params.originalName,
      params.mime,
      destinationStat.size,
      { device: destinationStat.dev, inode: destinationStat.ino },
      params.clientUploadId,
    );
  }
  const now = Date.now();
  await writeFile(`${params.resolved}.meta.json`, JSON.stringify({
    originalName: params.originalName,
    mime: params.mime,
    clientUploadId: params.clientUploadId,
  })).catch(() => {});
  const entry: AttachmentEntry = {
    id: params.filename,
    daemonPath: params.resolved,
    source: 'upload',
    originalName: params.originalName,
    mime: params.mime,
    size: params.size,
    createdAt: now,
    expiresAt: now + FILE_TRANSFER_LIMITS.TEMP_TTL_MS,
    clientUploadId: params.clientUploadId,
  };
  attachmentRegistry.set(params.filename, entry);
  return attachmentEntryToRef(entry);
}

/** ENOSPC — the disk filled up mid-write. libuv surfaces it as error.code on
 *  both POSIX and Windows; the message text is a defensive fallback. */
function isNoSpaceError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === 'ENOSPC') return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('enospc') || msg.includes('no space left');
}

function sendUploadError(serverLink: FileTransferSender, uploadId: string, filename: string | undefined, err: unknown): void {
  const errMsg = err instanceof Error ? err.message : String(err);
  const code = isNoSpaceError(err) ? FILE_TRANSFER_UPLOAD_ERROR_CODE.INSUFFICIENT_CAPACITY : undefined;
  logger.error({ uploadId, filename, err, code }, 'File upload failed');
  const response: FileUploadError = {
    type: 'file.upload_error',
    uploadId,
    message: errMsg,
    ...(code ? { code } : {}),
  };
  serverLink.send(response);
}

function sendUploadProgress(serverLink: FileTransferSender, uploadId: string, loaded: number, total: number): void {
  const response: FileUploadProgress = {
    type: 'file.upload_progress',
    uploadId,
    loaded: Math.max(0, Math.min(loaded, total)),
    total,
  };
  serverLink.send(response);
}

async function fetchRelayUpload(
  downloadUrl: string,
  resolved: string,
  expectedSize: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`relay_fetch_${response.status}`);
      }
      if (!response.body) {
        throw new Error('relay_fetch_empty_body');
      }
      let loaded = 0;
      let lastPct = -1;
      let lastSentAt = 0;
      const reportProgress = (force = false) => {
        const total = Math.max(1, expectedSize);
        const pct = Math.floor((loaded / total) * 100);
        const now = Date.now();
        if (force || pct !== lastPct && (now - lastSentAt >= 250 || pct >= 100)) {
          lastPct = pct;
          lastSentAt = now;
          onProgress?.(loaded, expectedSize);
        }
      };
      reportProgress(true);
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          loaded += chunk.length;
          reportProgress();
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        progress,
        createWriteStream(resolved),
      );
      const fileStat = await stat(resolved);
      if (fileStat.size !== expectedSize) {
        throw new Error('size_mismatch');
      }
      loaded = fileStat.size;
      reportProgress(true);
      return fileStat.size;
    } catch (err) {
      lastErr = err;
      await unlink(resolved).catch(() => {});
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Init ────────────────────────────────────────────────────────────────────

let initialized = false;

export async function initFileTransfer(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});
  await cleanupExpiredUploads();
  await recoverRegistry();
}

/** Scan upload dir and rebuild attachment registry for surviving files. */
async function recoverRegistry(): Promise<void> {
  try {
    const files = await readdir(UPLOAD_DIR);
    const now = Date.now();
    for (const file of files) {
      if (file.endsWith('.meta.json')) continue; // skip sidecar files
      if (attachmentRegistry.has(file)) continue;
      try {
        const filePath = path.join(UPLOAD_DIR, file);
        const fileStat = await stat(filePath);
        const age = now - fileStat.mtimeMs;
        if (age > FILE_TRANSFER_LIMITS.TEMP_TTL_MS) continue;

        // Try to read metadata sidecar
        let origName: string = file;
        let mime: string | undefined;
        let clientUploadId: string | undefined;
        try {
          const metaRaw = await readFile(filePath + '.meta.json', 'utf-8');
          const meta = JSON.parse(metaRaw) as { originalName?: string; mime?: string; clientUploadId?: string };
          if (meta.originalName) origName = meta.originalName;
          if (meta.mime) mime = meta.mime;
          if (typeof meta.clientUploadId === 'string') clientUploadId = meta.clientUploadId;
        } catch { /* no sidecar or invalid */ }

        attachmentRegistry.set(file, {
          id: file,
          daemonPath: path.resolve(filePath),
          source: 'upload',
          originalName: origName,
          mime,
          size: fileStat.size,
          createdAt: fileStat.mtimeMs,
          expiresAt: fileStat.mtimeMs + FILE_TRANSFER_LIMITS.TEMP_TTL_MS,
          clientUploadId,
        });
      } catch { /* skip unreadable files */ }
    }
    if (attachmentRegistry.size > 0) {
      logger.info({ count: attachmentRegistry.size }, 'Recovered upload attachment registry');
    }
  } catch { /* upload dir may not exist */ }
}

// ── Upload ──────────────────────────────────────────────────────────────────

export async function handleFileUpload(cmd: Record<string, unknown>, serverLink: FileTransferSender): Promise<void> {
  const msg = cmd as unknown as FileUploadRequest;
  const { uploadId, filename, originalName, mime, content } = msg;
  let uploadClaim: symbol | null = null;

  try {
    await initFileTransfer();

    // Opportunistic cleanup before writing
    await cleanupExpiredUploads();

    if (msg.clientUploadId) {
      const turn = await acquireRelayUploadTurn(msg.clientUploadId);
      if (turn.attachment) {
        serverLink.send({ type: 'file.upload_done', uploadId, attachment: turn.attachment } satisfies FileUploadDone);
        return;
      }
      uploadClaim = turn.claim;
    }

    const resolved = resolveUploadPath(filename);

    const buffer = Buffer.from(content, 'base64');
    if (buffer.length > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
      throw new Error(FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE);
    }
    if (typeof msg.size === 'number' && buffer.length !== msg.size) {
      throw new Error('size_mismatch');
    }
    await writeFile(resolved, buffer);

    await finalizeUploadedFile({
      uploadId,
      filename,
      originalName,
      mime,
      resolved,
      size: buffer.length,
      serverLink,
      clientUploadId: msg.clientUploadId,
      destinationDirectory: msg.destinationDirectory,
    });
  } catch (err) {
    sendUploadError(serverLink, uploadId, filename, err);
  } finally {
    if (msg.clientUploadId && uploadClaim) releaseClientUploadClaim(msg.clientUploadId, uploadClaim);
  }
}

export async function handleFileUploadFetch(cmd: Record<string, unknown>, serverLink: FileTransferSender): Promise<void> {
  const msg = cmd as unknown as FileUploadFetchRequest;
  const { uploadId, filename, originalName, mime, downloadUrl } = msg;
  let uploadClaim: symbol | null = null;

  try {
    await initFileTransfer();
    await cleanupExpiredUploads();

    if (msg.clientUploadId) {
      const turn = await acquireRelayUploadTurn(msg.clientUploadId);
      if (turn.attachment) {
        serverLink.send({ type: 'file.upload_done', uploadId, attachment: turn.attachment } satisfies FileUploadDone);
        return;
      }
      uploadClaim = turn.claim;
    }

    const resolved = resolveUploadPath(filename);
    if (typeof msg.size !== 'number' || msg.size < 0 || msg.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
      throw new Error(FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE);
    }
    if (!downloadUrl || typeof downloadUrl !== 'string') {
      throw new Error('missing_download_url');
    }

    const size = await fetchRelayUpload(downloadUrl, resolved, msg.size, (loaded, total) => {
      sendUploadProgress(serverLink, uploadId, loaded, total);
    });
    await finalizeUploadedFile({
      uploadId,
      filename,
      originalName,
      mime,
      resolved,
      size,
      serverLink,
      clientUploadId: msg.clientUploadId,
      destinationDirectory: msg.destinationDirectory,
    });
  } catch (err) {
    sendUploadError(serverLink, uploadId, filename, err);
  } finally {
    if (msg.clientUploadId && uploadClaim) releaseClientUploadClaim(msg.clientUploadId, uploadClaim);
  }
}

async function deleteUploadedAttachment(entry: AttachmentEntry): Promise<void> {
  if (entry.source !== 'upload') throw new Error(FILE_TRANSFER_DELETE_ERROR.FORBIDDEN);
  const resolved = path.resolve(entry.daemonPath);
  const uploadRoot = path.resolve(UPLOAD_DIR);
  if (!resolved.startsWith(`${uploadRoot}${path.sep}`)) throw new Error(FILE_TRANSFER_DELETE_ERROR.FORBIDDEN);
  try {
    await unlink(resolved);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  await unlink(`${resolved}.meta.json`).catch((error) => {
    if (!isNotFoundError(error)) logger.warn({ attachmentId: entry.id, error }, 'Failed to remove upload metadata');
  });
  attachmentRegistry.delete(entry.id);
}

export async function handleFileDelete(cmd: Record<string, unknown>, serverLink: FileTransferSender): Promise<void> {
  const parsed = validateFileDeleteRequest(cmd);
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : '';
  if (!parsed.ok) {
    if (requestId) serverLink.send({
      type: FILE_TRANSFER_MSG.DELETE_ERROR,
      requestId,
      error: FILE_TRANSFER_DELETE_ERROR.DELETE_FAILED,
    } satisfies FileDeleteError);
    return;
  }
  try {
    await initFileTransfer();
    const entry = attachmentRegistry.get(parsed.value.attachmentId);
    // Deletion is idempotent: an expired/already-removed upload is already in
    // the state requested by the user.
    if (entry) await deleteUploadedAttachment(entry);
    serverLink.send({ type: FILE_TRANSFER_MSG.DELETE_DONE, requestId: parsed.value.requestId } satisfies FileDeleteDone);
  } catch (error) {
    const reason = error instanceof Error && error.message === FILE_TRANSFER_DELETE_ERROR.FORBIDDEN
      ? FILE_TRANSFER_DELETE_ERROR.FORBIDDEN
      : FILE_TRANSFER_DELETE_ERROR.DELETE_FAILED;
    logger.error({ requestId: parsed.value.requestId, attachmentId: parsed.value.attachmentId, error }, 'Failed to delete uploaded attachment');
    serverLink.send({ type: FILE_TRANSFER_MSG.DELETE_ERROR, requestId: parsed.value.requestId, error: reason } satisfies FileDeleteError);
  }
}

// ── Download ────────────────────────────────────────────────────────────────

/**
 * Read a download target fully and send it back INLINE as base64 over the daemon
 * WS (`file.download_done`). Shared by the legacy `file.download` path and the
 * small-file fast path of `handleFileDownloadStream` — for small files a single
 * inline round-trip is far faster than the relay's PUT + readiness handshake
 * (repo rule: never copy code).
 */
async function sendInlineDownload(serverLink: FileTransferSender, downloadId: string, target: DownloadTarget): Promise<void> {
  const buffer = await readFile(target.readPath);
  const response: FileDownloadDone = {
    type: 'file.download_done',
    downloadId,
    content: buffer.toString('base64'),
    mime: target.mime,
    filename: target.filename,
    size: buffer.length,
  };
  serverLink.send(response);
}

export async function handleFileDownload(cmd: Record<string, unknown>, serverLink: FileTransferSender): Promise<void> {
  const msg = cmd as unknown as FileDownloadRequest;
  const { downloadId, attachmentId } = msg;
  let target: DownloadTarget | null = null;

  try {
    target = await resolveDownloadTarget(attachmentId, serverLink, downloadId);
    if (!target) return;
    await sendInlineDownload(serverLink, downloadId, target);
  } catch (err) {
    sendDownloadError(serverLink, downloadId, attachmentId, target?.entry, err);
  }
}

export async function handleFileDownloadStream(cmd: Record<string, unknown>, serverLink: FileTransferSender): Promise<void> {
  const msg = cmd as unknown as FileDownloadStreamRequest;
  const { downloadId, attachmentId, uploadUrl } = msg;
  let target: DownloadTarget | null = null;

  try {
    if (!uploadUrl || typeof uploadUrl !== 'string') {
      throw new Error('missing_upload_url');
    }
    target = await resolveDownloadTarget(attachmentId, serverLink, downloadId);
    if (!target) return;

    // Small files: skip the relay and reply inline in a single round-trip. The
    // relay's PUT + readiness handshake is pure latency for these (and times out
    // entirely if the relay is unhealthy), so only genuinely large files stream.
    // The server returns the inline bytes immediately on receiving this.
    if (typeof target.size === 'number' && target.size >= 0
        && target.size <= FILE_TRANSFER_LIMITS.DOWNLOAD_INLINE_MAX_BYTES) {
      await sendInlineDownload(serverLink, downloadId, target);
      return;
    }

    const ready: FileDownloadStreamReady = {
      type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM_READY,
      downloadId,
      mime: target.mime,
      filename: target.filename,
      size: target.size,
    };
    serverLink.send(ready);

    const headers: Record<string, string> = {
      'content-type': target.mime || 'application/octet-stream',
      'content-length': String(target.size),
      'x-imcodes-filename': encodeURIComponent(target.filename),
    };
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers,
      body: createReadStream(target.readPath) as never,
      duplex: 'half',
      signal: AbortSignal.timeout(FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS),
    } as RequestInit & { duplex: 'half' });
    if (!response.ok) {
      throw new Error(`relay_upload_${response.status}`);
    }
  } catch (err) {
    sendDownloadError(serverLink, downloadId, attachmentId, target?.entry, err);
  }
}

// ── Project file download handles ───────────────────────────────────────────

/**
 * Look up an attachment by its daemon path. Returns the entry or undefined.
 */
export function lookupAttachment(daemonPath: string): AttachmentEntry | undefined {
  const resolved = path.resolve(daemonPath);
  for (const entry of attachmentRegistry.values()) {
    if (entry.daemonPath === resolved) return entry;
  }
  return undefined;
}

/**
 * Look up an attachment by ID. Returns the entry or undefined.
 */
export function lookupAttachmentById(id: string): AttachmentEntry | undefined {
  return attachmentRegistry.get(id);
}

/**
 * Register a controlled, short-lived path handle for an already validated
 * project file. The handle binds the path's filesystem identity; replacement or
 * symbolic-link substitution invalidates it before any bytes are read.
 */
export function createProjectFileHandleFromValidatedPath(
  validatedRealPath: ValidatedRealPath,
  originalName: string,
  mime?: string,
  size?: number,
  identity?: { device: number; inode: number },
  clientUploadId?: string,
): AttachmentRef {
  const daemonPath = String(validatedRealPath);
  const validated = validateCanonicalRealPath(daemonPath);
  if (!validated) throw new Error(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);

  const id = randomHex(16);
  const now = Date.now();

  attachmentRegistry.set(id, {
    id,
    daemonPath,
    source: 'local',
    originalName,
    mime,
    size,
    createdAt: now,
    expiresAt: now + FILE_TRANSFER_LIMITS.HANDLE_TTL_MS,
    ...(identity ? { device: identity.device, inode: identity.inode } : {}),
    ...(clientUploadId ? { clientUploadId } : {}),
  });

  return {
    id,
    source: 'local',
    serverId: '',
    daemonPath,
    originalName,
    mime,
    size,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + FILE_TRANSFER_LIMITS.HANDLE_TTL_MS).toISOString(),
    downloadable: true,
  };
}

/**
 * Compatibility wrapper for existing callers. It now performs strict canonical
 * validation before registering the local path handle.
 */
export function createProjectFileHandle(
  filePath: string,
  originalName: string,
  mime?: string,
  size?: number,
): AttachmentRef {
  return createProjectFileHandleFromValidatedPath(
    validateProjectFilePathSync(filePath),
    originalName,
    mime,
    size,
  );
}

/**
 * Tolerant helper for best-effort callers such as fs.ls includeMetadata. It
 * preserves listing success when a file cannot safely receive a downloadId.
 */
export async function tryCreateProjectFileHandle(
  filePath: string,
  originalName: string,
  mime?: string,
  size?: number,
  options: TryCreateProjectFileHandleOptions = {},
): Promise<AttachmentRef | null> {
  if (options.usedFallback) return null;

  try {
    const validated = await validateProjectFilePath(filePath);
    return createProjectFileHandleFromValidatedPath(validated, originalName, mime, size);
  } catch {
    logger.debug({ event: 'try_create_project_file_handle_skipped' }, 'Skipped unsafe local project file download handle');
    return null;
  }
}

function stablePathHandleError(err: unknown): FilePathHandleErrorReason {
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') return FILE_PATH_HANDLE_ERROR.NOT_FOUND;
  const message = err instanceof Error ? err.message : '';
  if (message === FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH) return FILE_PATH_HANDLE_ERROR.FORBIDDEN_PATH;
  if (message === FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE) return FILE_PATH_HANDLE_ERROR.FILE_TOO_LARGE;
  if (message === 'not_regular_file' || message === 'symbolic_link') return FILE_PATH_HANDLE_ERROR.NOT_REGULAR_FILE;
  return FILE_PATH_HANDLE_ERROR.HANDLE_FAILED;
}

function sendDirectoryListError(sender: FileTransferSender, requestId: string, error: string): void {
  sender.send({
    type: FILE_TRANSFER_MSG.DIRECTORY_LIST_ERROR,
    requestId,
    error,
  } satisfies FileDirectoryListError);
}

/** Bounded controlled-node browser used by the integrated remote desktop file manager. */
export async function handleFileDirectoryList(cmd: Record<string, unknown>, sender: FileTransferSender): Promise<void> {
  const parsed = validateFileDirectoryListRequest(cmd);
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : '';
  if (!parsed.ok) {
    if (requestId) sendDirectoryListError(sender, requestId, 'invalid_path');
    return;
  }

  try {
    if (process.platform === 'win32' && parsed.value.path === FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES) {
      const entries = (await Promise.all(
        Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
          .map(async (drive): Promise<FileDirectoryEntry | null> => {
            try {
              await readdir(drive);
              return { name: drive, path: drive, isDir: true, hidden: false };
            } catch {
              return null;
            }
          }),
      )).filter((entry): entry is FileDirectoryEntry => entry !== null);
      sender.send({
        type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE,
        requestId: parsed.value.requestId,
        path: parsed.value.path,
        resolvedPath: FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES_ROOT,
        entries,
      } satisfies FileDirectoryListDone);
      return;
    }

    const canonical = await resolveCanonical(parsed.value.path, 'strict');
    if (!canonical) throw new Error(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
    const directoryStat = await lstat(canonical.realPath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('not_directory');
    }
    const entries = (await readdir(canonical.realPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry): FileDirectoryEntry => ({
        name: entry.name,
        path: path.join(canonical.realPath, entry.name),
        isDir: entry.isDirectory(),
        hidden: entry.name.startsWith('.'),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
      })
      .slice(0, FILE_TRANSFER_DIRECTORY_MAX_ENTRIES);
    sender.send({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE,
      requestId: parsed.value.requestId,
      path: parsed.value.path,
      resolvedPath: canonical.realPath,
      entries,
    } satisfies FileDirectoryListDone);
  } catch (error) {
    const code = isNotFoundError(error)
      ? 'not_found'
      : error instanceof Error && /^[a-z0-9_:-]{1,128}$/.test(error.message)
        ? error.message
        : 'directory_list_failed';
    sendDirectoryListError(sender, parsed.value.requestId, code);
  }
}

/** Controlled-node explicit-path registration; bytes still use the existing download path. */
export async function handleFilePathHandle(cmd: Record<string, unknown>, sender: FileTransferSender): Promise<void> {
  const parsed = validateFilePathHandleRequest(cmd);
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : '';
  if (!parsed.ok) {
    if (requestId) sender.send({ type: FILE_TRANSFER_MSG.PATH_HANDLE_ERROR, requestId, error: FILE_PATH_HANDLE_ERROR.INVALID_PATH });
    return;
  }
  try {
    const requested = path.resolve(parsed.value.path);
    const requestedStat = await lstat(requested);
    if (requestedStat.isSymbolicLink()) throw new Error('symbolic_link');
    if (!requestedStat.isFile()) throw new Error('not_regular_file');
    if (requestedStat.size > FILE_TRANSFER_LIMITS.MAX_FILE_SIZE) {
      throw new Error(FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE);
    }
    const validated = await validateProjectFilePath(requested).catch((err) => {
      if (isNotFoundError(err)) throw err;
      throw new Error(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH);
    });
    const attachment = createProjectFileHandleFromValidatedPath(
      validated,
      path.basename(requested),
      undefined,
      requestedStat.size,
      { device: requestedStat.dev, inode: requestedStat.ino },
    );
    sender.send({ type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE, requestId: parsed.value.requestId, attachment });
  } catch (err) {
    sender.send({
      type: FILE_TRANSFER_MSG.PATH_HANDLE_ERROR,
      requestId: parsed.value.requestId,
      error: stablePathHandleError(err),
    });
  }
}

// ── Lifecycle cleanup ───────────────────────────────────────────────────────

async function cleanupExpiredUploads(): Promise<void> {
  const now = Date.now();

  // Clean registry entries
  for (const [id, entry] of attachmentRegistry) {
    if (now > entry.expiresAt) {
      attachmentRegistry.delete(id);
    }
  }

  // Clean actual files in upload dir
  try {
    const files = await readdir(UPLOAD_DIR);
    for (const file of files) {
      try {
        const filePath = path.join(UPLOAD_DIR, file);
        const fileStat = await stat(filePath);
        const age = now - fileStat.mtimeMs;
        if (age > FILE_TRANSFER_LIMITS.TEMP_TTL_MS) {
          await unlink(filePath);
          await unlink(filePath + '.meta.json').catch(() => {});
          logger.debug({ file }, 'Cleaned up expired upload');
        }
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* upload dir may not exist yet */ }
}

/** Run periodic cleanup. Call from daemon startup. */
export function startCleanupTimer(): ReturnType<typeof setInterval> {
  // Run cleanup every hour
  return setInterval(() => {
    cleanupExpiredUploads().catch((err) =>
      logger.error({ err }, 'Upload cleanup failed'),
    );
  }, 60 * 60 * 1000);
}
