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
   *  (ms). Long enough to catch a relay that becomes ready a few seconds in
   *  (e.g. ~4s), NOT so short it abandons a relay that would have worked. Only
   *  large files take the relay (small files return inline). Combined with
   *  DOWNLOAD_STREAM_MAX_ATTEMPTS, the relay gets several chances before the
   *  base64 fallback. */
  DOWNLOAD_STREAM_READY_TIMEOUT_MS: 4_000,
  /** How many times the server retries the streaming relay (each waiting
   *  DOWNLOAD_STREAM_READY_TIMEOUT_MS) before falling back to base64. Retrying
   *  with a fresh attempt recovers a relay whose first PUT wedged, while a ready
   *  relay still returns as soon as bytes flow. */
  DOWNLOAD_STREAM_MAX_ATTEMPTS: 2,
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

// ── Server → Daemon messages ──────────────────────────────────────────────────

export const FILE_TRANSFER_MSG = {
  DOWNLOAD_STREAM: 'file.download_stream',
  DOWNLOAD_STREAM_READY: 'file.download_stream_ready',
} as const;

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

export type FileTransferDaemonMessage =
  | FileUploadDone
  | FileUploadError
  | FileUploadProgress
  | FileDownloadDone
  | FileDownloadStreamReady
  | FileDownloadError;

export type FileTransferServerMessage =
  | FileUploadRequest
  | FileUploadFetchRequest
  | FileDownloadRequest
  | FileDownloadStreamRequest;

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
