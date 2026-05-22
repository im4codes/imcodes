/**
 * Daemon-side file transfer handler.
 * Handles upload persistence, download resolution, and lifecycle cleanup.
 */
import { createWriteStream, realpathSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, stat, unlink, realpath as fsRealpath } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import logger from '../util/logger.js';
import {
  FILE_TRANSFER_LIMITS,
  type AttachmentRef,
  type FileUploadRequest,
  type FileUploadFetchRequest,
  type FileUploadDone,
  type FileUploadError,
  type FileUploadProgress,
  type FileDownloadRequest,
  type FileDownloadDone,
  type FileDownloadError,
} from '../../shared/transport/file-transfer.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import type { ServerLink } from './server-link.js';
import { validateCanonicalRealPath } from './file-preview-path-policy.js';
import type { ValidatedRealPath } from './file-preview-path-policy.js';
export type { ValidatedRealPath } from './file-preview-path-policy.js';

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
}

const attachmentRegistry = new Map<string, AttachmentEntry>();

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

function resolveUploadPath(filename: string): string {
  const filePath = path.join(UPLOAD_DIR, filename);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    throw new Error('path_traversal');
  }
  return resolved;
}

async function finalizeUploadedFile(params: {
  uploadId: string;
  filename: string;
  originalName?: string;
  mime?: string;
  resolved: string;
  size: number;
  serverLink: ServerLink;
}): Promise<void> {
  const { uploadId, filename, originalName, mime, resolved, size, serverLink } = params;

  const metaPath = resolved + '.meta.json';
  await writeFile(metaPath, JSON.stringify({ originalName: originalName || filename, mime })).catch(() => {});

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
  });

  const response: FileUploadDone = {
    type: 'file.upload_done',
    uploadId,
    attachment,
  };
  serverLink.send(response);

  logger.info({ uploadId, filename, size }, 'File upload complete');
}

function sendUploadError(serverLink: ServerLink, uploadId: string, filename: string | undefined, err: unknown): void {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error({ uploadId, filename, err }, 'File upload failed');
  const response: FileUploadError = {
    type: 'file.upload_error',
    uploadId,
    message: errMsg,
  };
  serverLink.send(response);
}

function sendUploadProgress(serverLink: ServerLink, uploadId: string, loaded: number, total: number): void {
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
      const response = await fetch(downloadUrl);
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
        try {
          const metaRaw = await readFile(filePath + '.meta.json', 'utf-8');
          const meta = JSON.parse(metaRaw) as { originalName?: string; mime?: string };
          if (meta.originalName) origName = meta.originalName;
          if (meta.mime) mime = meta.mime;
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
        });
      } catch { /* skip unreadable files */ }
    }
    if (attachmentRegistry.size > 0) {
      logger.info({ count: attachmentRegistry.size }, 'Recovered upload attachment registry');
    }
  } catch { /* upload dir may not exist */ }
}

// ── Upload ──────────────────────────────────────────────────────────────────

export async function handleFileUpload(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const msg = cmd as unknown as FileUploadRequest;
  const { uploadId, filename, originalName, mime, content } = msg;

  try {
    await initFileTransfer();

    // Opportunistic cleanup before writing
    await cleanupExpiredUploads();

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
    });
  } catch (err) {
    sendUploadError(serverLink, uploadId, filename, err);
  }
}

export async function handleFileUploadFetch(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const msg = cmd as unknown as FileUploadFetchRequest;
  const { uploadId, filename, originalName, mime, downloadUrl } = msg;

  try {
    await initFileTransfer();
    await cleanupExpiredUploads();

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
    });
  } catch (err) {
    sendUploadError(serverLink, uploadId, filename, err);
  }
}

// ── Download ────────────────────────────────────────────────────────────────

export async function handleFileDownload(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const msg = cmd as unknown as FileDownloadRequest;
  const { downloadId, attachmentId } = msg;
  let entry: AttachmentEntry | undefined;

  try {
    entry = attachmentRegistry.get(attachmentId);

    if (!entry) {
      const response: FileDownloadError = {
        type: 'file.download_error',
        downloadId,
        message: 'not_found',
      };
      serverLink.send(response);
      return;
    }

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      attachmentRegistry.delete(attachmentId);
      const response: FileDownloadError = {
        type: 'file.download_error',
        downloadId,
        message: 'expired',
      };
      serverLink.send(response);
      return;
    }

    // Validate path is in allowed ranges
    const resolved = path.resolve(entry.daemonPath);
    const uploadDirResolved = path.resolve(UPLOAD_DIR);
    const isUpload = resolved.startsWith(uploadDirResolved + path.sep);
    // For 'local' source, the path must exist and is validated at handle creation time
    if (!isUpload && entry.source !== 'local') {
      const response: FileDownloadError = {
        type: 'file.download_error',
        downloadId,
        message: 'not_found',
      };
      serverLink.send(response);
      return;
    }

    const readPath = entry.source === 'local'
      ? await validateProjectFilePath(entry.daemonPath)
      : resolved;
    const buffer = await readFile(readPath);
    const content = buffer.toString('base64');

    const response: FileDownloadDone = {
      type: 'file.download_done',
      downloadId,
      content,
      mime: entry.mime,
      filename: entry.originalName || attachmentId,
      size: buffer.length,
    };
    serverLink.send(response);
  } catch (err) {
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
 * project file. The handle points at the current path and is not an immutable
 * content snapshot.
 */
export function createProjectFileHandleFromValidatedPath(
  validatedRealPath: ValidatedRealPath,
  originalName: string,
  mime?: string,
  size?: number,
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
