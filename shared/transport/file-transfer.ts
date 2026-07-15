/**
 * Shared types for the file transfer channel (upload / download).
 * Used by server, daemon, and web.
 */

// ── Object model ──────────────────────────────────────────────────────────────

export type AttachmentSource = 'upload' | 'camera' | 'paste' | 'local' | 'generated';

export interface AttachmentRef {
  id: string;
  source: AttachmentSource;
  serverId: string;
  daemonPath: string;
  originalName?: string;
  mime?: string;
  size?: number;
  createdAt: string;   // ISO 8601
  expiresAt?: string;  // ISO 8601
  downloadable: boolean;
}

export type PreviewType = 'text' | 'image' | 'pdf' | 'unsupported';
export type PreviewReason = 'too_large' | 'binary' | 'unknown_type' | 'render_failed';

export interface PreviewMeta {
  previewable: boolean;
  previewType?: PreviewType;
  reason?: PreviewReason;
  maxInlineBytes?: number;
}

// ── Phase 1 limits ────────────────────────────────────────────────────────────

export const FILE_TRANSFER_LIMITS = {
  /** Maximum single file size in bytes (2 GB). */
  MAX_FILE_SIZE: 2 * 1024 * 1024 * 1024,
  /** Server waits this long for daemon upload ack (ms). */
  UPLOAD_TIMEOUT_MS: 300_000,
  /** Relay-staged uploads expire after this duration (ms). */
  STAGED_UPLOAD_TTL_MS: 10 * 60 * 1000,
  /** Server waits this long for daemon download response (ms). */
  DOWNLOAD_TIMEOUT_MS: 300_000,
  /** Per-attempt wait for the daemon's download stream to START delivering bytes
   *  (ms). Kept short so a wedged attempt is abandoned quickly and a fresh one
   *  started — the relay is re-tried at this cadence rather than stalled on a
   *  single long wait. A ready relay still returns the instant the first byte
   *  lands (this is only the give-up-and-retry threshold). Only large files take
   *  the relay (small files return inline). */
  DOWNLOAD_STREAM_READY_TIMEOUT_MS: 2_000,
  /** How many times the server tries the streaming relay (one fresh attempt
   *  every DOWNLOAD_STREAM_READY_TIMEOUT_MS) before falling back to base64. With
   *  the 2s cadence this spans ~8s of retries, recovering a relay that wedges on
   *  early attempts but becomes ready a few seconds in. */
  DOWNLOAD_STREAM_MAX_ATTEMPTS: 4,
  /** Files at or below this size are returned INLINE (base64 over the daemon WS)
   *  in a single round-trip instead of through the streaming relay. The relay's
   *  PUT round-trip + readiness handshake adds latency that dominates for small
   *  files (and is pure overhead if the relay is unhealthy), so it is reserved
   *  for genuinely large files where avoiding base64-over-WS bloat matters.
   *  1 MiB raw ≈ 1.37 MiB base64. */
  DOWNLOAD_INLINE_MAX_BYTES: 1024 * 1024,
  /** Temporary uploaded files are cleaned after this duration (ms). 24 hours. */
  TEMP_TTL_MS: 24 * 60 * 60 * 1000,
  /** Project-file download handles expire after this duration (ms). 4 hours. */
  HANDLE_TTL_MS: 4 * 60 * 60 * 1000,
  /** Directory for temporary uploads on daemon. */
  UPLOAD_DIR: '/tmp/imcodes-uploads',
} as const;

// ── Capability advertisement ────────────────────────────────────────────────

export const FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY = 'file.transfer.upload_fetch.v1' as const;
export const FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY = 'file.transfer.download_stream.v1' as const;
export const FILE_TRANSFER_PATH_HANDLE_CAPABILITY = 'file.transfer.path_handle.v1' as const;
export const FILE_TRANSFER_PATH_MAX_BYTES = 4 * 1024;
export const FILE_TRANSFER_ERROR_MAX_BYTES = 256;

// ── Server → Daemon messages ──────────────────────────────────────────────────

export const FILE_TRANSFER_MSG = {
  UPLOAD_FETCH: 'file.upload_fetch',
  UPLOAD_PROGRESS: 'file.upload_progress',
  UPLOAD_DONE: 'file.upload_done',
  UPLOAD_ERROR: 'file.upload_error',
  DOWNLOAD: 'file.download',
  DOWNLOAD_DONE: 'file.download_done',
  DOWNLOAD_ERROR: 'file.download_error',
  DOWNLOAD_STREAM: 'file.download_stream',
  DOWNLOAD_STREAM_READY: 'file.download_stream_ready',
  PATH_HANDLE: 'file.path_handle',
  PATH_HANDLE_DONE: 'file.path_handle_done',
  PATH_HANDLE_ERROR: 'file.path_handle_error',
} as const;

export const FILE_PATH_HANDLE_ERROR = {
  INVALID_PATH: 'invalid_path',
  NOT_FOUND: 'not_found',
  FORBIDDEN_PATH: 'forbidden_path',
  NOT_REGULAR_FILE: 'not_regular_file',
  FILE_TOO_LARGE: 'file_too_large',
  HANDLE_FAILED: 'handle_failed',
} as const;

export type FilePathHandleErrorReason = typeof FILE_PATH_HANDLE_ERROR[keyof typeof FILE_PATH_HANDLE_ERROR];

export interface FileUploadRequest {
  type: 'file.upload';
  uploadId: string;
  filename: string;
  originalName?: string;
  mime?: string;
  size: number;
  content: string; // base64
}

export interface FileUploadFetchRequest {
  type: 'file.upload_fetch';
  uploadId: string;
  filename: string;
  originalName?: string;
  mime?: string;
  size: number;
  downloadUrl: string;
}

export interface FileDownloadRequest {
  type: 'file.download';
  downloadId: string;
  attachmentId: string;
}

export interface FileDownloadStreamRequest {
  type: 'file.download_stream';
  downloadId: string;
  attachmentId: string;
  uploadUrl: string;
}

/** Server -> controlled node: mint a short-lived handle for one explicit path. */
export interface FilePathHandleRequest {
  type: typeof FILE_TRANSFER_MSG.PATH_HANDLE;
  requestId: string;
  path: string;
}

// ── Daemon → Server messages ──────────────────────────────────────────────────

export interface FileUploadDone {
  type: 'file.upload_done';
  uploadId: string;
  attachment: AttachmentRef;
}

export interface FileUploadError {
  type: 'file.upload_error';
  uploadId: string;
  message: string;
}

export interface FileUploadProgress {
  type: 'file.upload_progress';
  uploadId: string;
  loaded: number;
  total: number;
}

export interface FileDownloadDone {
  type: 'file.download_done';
  downloadId: string;
  content: string; // base64
  mime?: string;
  filename?: string;
  size?: number;
}

export interface FileDownloadStreamReady {
  type: 'file.download_stream_ready';
  downloadId: string;
  mime?: string;
  filename?: string;
  size?: number;
}

export interface FileDownloadError {
  type: 'file.download_error';
  downloadId: string;
  message: string;
}

export interface FilePathHandleDone {
  type: typeof FILE_TRANSFER_MSG.PATH_HANDLE_DONE;
  requestId: string;
  attachment: AttachmentRef;
}

export interface FilePathHandleError {
  type: typeof FILE_TRANSFER_MSG.PATH_HANDLE_ERROR;
  requestId: string;
  error: FilePathHandleErrorReason;
}

export type FileTransferDaemonMessage =
  | FileUploadDone
  | FileUploadError
  | FileUploadProgress
  | FileDownloadDone
  | FileDownloadStreamReady
  | FileDownloadError
  | FilePathHandleDone
  | FilePathHandleError;

export type FileTransferServerMessage =
  | FileUploadRequest
  | FileUploadFetchRequest
  | FileDownloadRequest
  | FileDownloadStreamRequest
  | FilePathHandleRequest;

export type ControlledFileTransferResponse =
  | FileUploadDone
  | FileUploadError
  | FileUploadProgress
  | FileDownloadDone
  | FileDownloadStreamReady
  | FileDownloadError
  | FilePathHandleDone
  | FilePathHandleError;

export type ControlledFileTransferRequest =
  | FileUploadFetchRequest
  | FileDownloadRequest
  | FileDownloadStreamRequest
  | FilePathHandleRequest;

export type FileTransferValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const FILE_TRANSFER_ID_RE = /^[A-Za-z0-9_-]{1,128}(?:\.[A-Za-z0-9]{1,20})?$/;
const FILE_TRANSFER_ERROR_RE = /^[a-z0-9_:-]{1,128}$/;
const FILE_TRANSFER_ATTACHMENT_KEYS = new Set([
  'id', 'source', 'serverId', 'daemonPath', 'originalName', 'mime', 'size',
  'createdAt', 'expiresAt', 'downloadable',
]);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTransferId(value: unknown): value is string {
  return typeof value === 'string' && FILE_TRANSFER_ID_RE.test(value);
}

function isBoundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && utf8Bytes(value) <= maxBytes;
}

function isSafeSize(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= FILE_TRANSFER_LIMITS.MAX_FILE_SIZE;
}

export function validateAttachmentRef(value: unknown): AttachmentRef | null {
  if (!isObject(value) || !hasOnlyKeys(value, FILE_TRANSFER_ATTACHMENT_KEYS)) return null;
  if (!isTransferId(value.id)) return null;
  if (value.source !== 'upload' && value.source !== 'local') return null;
  if (!isBoundedString(value.serverId, 256, true)) return null;
  if (!isBoundedString(value.daemonPath, FILE_TRANSFER_PATH_MAX_BYTES)) return null;
  if (value.originalName !== undefined && !isBoundedString(value.originalName, 1024)) return null;
  if (value.mime !== undefined && !isBoundedString(value.mime, 256)) return null;
  if (value.size !== undefined && !isSafeSize(value.size)) return null;
  if (!isBoundedString(value.createdAt, 64)) return null;
  if (value.expiresAt !== undefined && !isBoundedString(value.expiresAt, 64)) return null;
  if (typeof value.downloadable !== 'boolean') return null;
  return value as unknown as AttachmentRef;
}

/** Strict trust-boundary validator for server-issued explicit-path handle requests. */
export function validateFilePathHandleRequest(value: unknown): FileTransferValidationResult<FilePathHandleRequest> {
  if (!isObject(value)) return { ok: false, error: 'invalid_object' };
  if (!hasOnlyKeys(value, new Set(['type', 'requestId', 'path']))) return { ok: false, error: 'unknown_field' };
  if (value.type !== FILE_TRANSFER_MSG.PATH_HANDLE) return { ok: false, error: 'invalid_type' };
  if (!isTransferId(value.requestId)) return { ok: false, error: 'invalid_request_id' };
  if (!isBoundedString(value.path, FILE_TRANSFER_PATH_MAX_BYTES)) return { ok: false, error: 'invalid_path' };
  return { ok: true, value: value as unknown as FilePathHandleRequest };
}

/** Strict validator for the bounded file controls accepted by the thin node. */
export function validateControlledFileTransferRequest(
  value: unknown,
): FileTransferValidationResult<ControlledFileTransferRequest> {
  if (!isObject(value) || typeof value.type !== 'string') return { ok: false, error: 'invalid_object' };
  if (value.type === FILE_TRANSFER_MSG.PATH_HANDLE) return validateFilePathHandleRequest(value);
  if (value.type === 'file.upload_fetch') {
    if (!hasOnlyKeys(value, new Set(['type', 'uploadId', 'filename', 'originalName', 'mime', 'size', 'downloadUrl']))
      || !isTransferId(value.uploadId)
      || typeof value.filename !== 'string' || !/^[a-f0-9]{16,128}(\.[A-Za-z0-9]{1,20})?$/.test(value.filename)
      || (value.originalName !== undefined && !isBoundedString(value.originalName, 1024))
      || (value.mime !== undefined && !isBoundedString(value.mime, 256))
      || !isSafeSize(value.size)
      || !isBoundedString(value.downloadUrl, 8192)) {
      return { ok: false, error: 'invalid_upload_fetch' };
    }
    return { ok: true, value: value as unknown as FileUploadFetchRequest };
  }
  if (value.type === 'file.download') {
    if (!hasOnlyKeys(value, new Set(['type', 'downloadId', 'attachmentId']))
      || !isTransferId(value.downloadId) || !isTransferId(value.attachmentId)) {
      return { ok: false, error: 'invalid_download' };
    }
    return { ok: true, value: value as unknown as FileDownloadRequest };
  }
  if (value.type === FILE_TRANSFER_MSG.DOWNLOAD_STREAM) {
    if (!hasOnlyKeys(value, new Set(['type', 'downloadId', 'attachmentId', 'uploadUrl']))
      || !isTransferId(value.downloadId) || !isTransferId(value.attachmentId)
      || !isBoundedString(value.uploadUrl, 8192)) {
      return { ok: false, error: 'invalid_download_stream' };
    }
    return { ok: true, value: value as unknown as FileDownloadStreamRequest };
  }
  return { ok: false, error: 'invalid_type' };
}

/**
 * Validate every transfer frame admitted from a CONTROLLED credential. Full
 * daemons retain their compatibility path; the controlled-node bridge uses this
 * stricter surface before touching a pending request.
 */
export function validateControlledFileTransferResponse(
  value: unknown,
): FileTransferValidationResult<ControlledFileTransferResponse> {
  if (!isObject(value) || typeof value.type !== 'string') return { ok: false, error: 'invalid_object' };
  const v = value;
  if (v.type === 'file.upload_progress') {
    if (!hasOnlyKeys(v, new Set(['type', 'uploadId', 'loaded', 'total']))
      || !isTransferId(v.uploadId) || !isSafeSize(v.loaded) || !isSafeSize(v.total)
      || v.loaded > v.total) return { ok: false, error: 'invalid_upload_progress' };
    return { ok: true, value: v as unknown as FileUploadProgress };
  }
  if (v.type === 'file.upload_done') {
    const attachment = validateAttachmentRef(v.attachment);
    if (!hasOnlyKeys(v, new Set(['type', 'uploadId', 'attachment']))
      || !isTransferId(v.uploadId) || !attachment) return { ok: false, error: 'invalid_upload_done' };
    return { ok: true, value: { type: v.type, uploadId: v.uploadId, attachment } };
  }
  if (v.type === 'file.upload_error') {
    if (!hasOnlyKeys(v, new Set(['type', 'uploadId', 'message']))
      || !isTransferId(v.uploadId) || !isBoundedString(v.message, FILE_TRANSFER_ERROR_MAX_BYTES)
      || !FILE_TRANSFER_ERROR_RE.test(v.message)) return { ok: false, error: 'invalid_upload_error' };
    return { ok: true, value: v as unknown as FileUploadError };
  }
  if (v.type === 'file.download_done') {
    const maxBase64Bytes = Math.ceil(FILE_TRANSFER_LIMITS.DOWNLOAD_INLINE_MAX_BYTES * 4 / 3) + 8;
    if (!hasOnlyKeys(v, new Set(['type', 'downloadId', 'content', 'mime', 'filename', 'size']))
      || !isTransferId(v.downloadId) || !isBoundedString(v.content, maxBase64Bytes, true)
      || (v.mime !== undefined && !isBoundedString(v.mime, 256))
      || (v.filename !== undefined && !isBoundedString(v.filename, 1024))
      || (v.size !== undefined && !isSafeSize(v.size))) return { ok: false, error: 'invalid_download_done' };
    return { ok: true, value: v as unknown as FileDownloadDone };
  }
  if (v.type === FILE_TRANSFER_MSG.DOWNLOAD_STREAM_READY) {
    if (!hasOnlyKeys(v, new Set(['type', 'downloadId', 'mime', 'filename', 'size']))
      || !isTransferId(v.downloadId)
      || (v.mime !== undefined && !isBoundedString(v.mime, 256))
      || (v.filename !== undefined && !isBoundedString(v.filename, 1024))
      || (v.size !== undefined && !isSafeSize(v.size))) return { ok: false, error: 'invalid_download_ready' };
    return { ok: true, value: v as unknown as FileDownloadStreamReady };
  }
  if (v.type === 'file.download_error') {
    if (!hasOnlyKeys(v, new Set(['type', 'downloadId', 'message']))
      || !isTransferId(v.downloadId) || !isBoundedString(v.message, FILE_TRANSFER_ERROR_MAX_BYTES)
      || !FILE_TRANSFER_ERROR_RE.test(v.message)) return { ok: false, error: 'invalid_download_error' };
    return { ok: true, value: v as unknown as FileDownloadError };
  }
  if (v.type === FILE_TRANSFER_MSG.PATH_HANDLE_DONE) {
    const attachment = validateAttachmentRef(v.attachment);
    if (!hasOnlyKeys(v, new Set(['type', 'requestId', 'attachment']))
      || !isTransferId(v.requestId) || !attachment) return { ok: false, error: 'invalid_path_handle_done' };
    return { ok: true, value: { type: v.type, requestId: v.requestId, attachment } };
  }
  if (v.type === FILE_TRANSFER_MSG.PATH_HANDLE_ERROR) {
    const errors = new Set<string>(Object.values(FILE_PATH_HANDLE_ERROR));
    if (!hasOnlyKeys(v, new Set(['type', 'requestId', 'error']))
      || !isTransferId(v.requestId) || typeof v.error !== 'string' || !errors.has(v.error)) {
      return { ok: false, error: 'invalid_path_handle_error' };
    }
    return { ok: true, value: v as unknown as FilePathHandleError };
  }
  return { ok: false, error: 'invalid_type' };
}

// ── FileBrowser extensions ────────────────────────────────────────────────────

export interface FileEntryDownload {
  attachmentId: string;
  downloadable: boolean;
  expiresAt?: string;
}

export interface FileEntryMeta {
  preview?: PreviewMeta;
  download?: FileEntryDownload;
}
