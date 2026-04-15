/**
 * Daemon-side file transfer handler.
 * Handles upload persistence, download resolution, and lifecycle cleanup.
 */
import { mkdir, writeFile, readFile, readdir, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import logger from '../util/logger.js';
import {
  FILE_TRANSFER_LIMITS,
  type AttachmentRef,
  type FileUploadRequest,
  type FileUploadDone,
  type FileUploadError,
  type FileDownloadRequest,
  type FileDownloadDone,
  type FileDownloadError,
} from '../../shared/transport/file-transfer.js';
import type { ServerLink } from './server-link.js';
import { homedir } from 'node:os';

/** Upload directory — ~/.imcodes/uploads (persists across reboots, unlike /tmp). */
const UPLOAD_DIR = path.join(homedir(), '.imcodes', 'uploads');

// ── Attachment registry ─────────────────────────────────────────────────────

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

    const filePath = path.join(UPLOAD_DIR, filename);

    // Safety: ensure the resolved path is inside UPLOAD_DIR
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
      throw new Error('path_traversal');
    }

    const buffer = Buffer.from(content, 'base64');
    await writeFile(resolved, buffer);

    // Write metadata sidecar for recovery after daemon restart
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
      size: buffer.length,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + FILE_TRANSFER_LIMITS.TEMP_TTL_MS).toISOString(),
      downloadable: true,
    };

    // Register in memory
    attachmentRegistry.set(filename, {
      id: filename,
      daemonPath: resolved,
      source: 'upload',
      originalName: originalName || filename,
      mime,
      size: buffer.length,
      createdAt: now,
      expiresAt: now + FILE_TRANSFER_LIMITS.TEMP_TTL_MS,
    });

    const response: FileUploadDone = {
      type: 'file.upload_done',
      uploadId,
      attachment,
    };
    serverLink.send(response);

    logger.info({ uploadId, filename, size: buffer.length }, 'File upload complete');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ uploadId, filename, err }, 'File upload failed');
    const response: FileUploadError = {
      type: 'file.upload_error',
      uploadId,
      message: errMsg,
    };
    serverLink.send(response);
  }
}

// ── Download ────────────────────────────────────────────────────────────────

export async function handleFileDownload(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const msg = cmd as unknown as FileDownloadRequest;
  const { downloadId, attachmentId } = msg;

  try {
    const entry = attachmentRegistry.get(attachmentId);

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

    const buffer = await readFile(resolved);
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
      message: errMsg.includes('ENOENT') ? 'not_found' : errMsg,
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
 * Generate a controlled download handle for a project file without copying it.
 * Returns the AttachmentRef with a short-lived handle.
 */
export function createProjectFileHandle(
  filePath: string,
  originalName: string,
  mime?: string,
  size?: number,
): AttachmentRef {
  const id = randomHex(16);
  const now = Date.now();

  attachmentRegistry.set(id, {
    id,
    daemonPath: path.resolve(filePath),
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
    daemonPath: path.resolve(filePath),
    originalName,
    mime,
    size,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + FILE_TRANSFER_LIMITS.HANDLE_TTL_MS).toISOString(),
    downloadable: true,
  };
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
