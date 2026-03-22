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
  /** Maximum single file size in bytes (20 MB). */
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  /** Server waits this long for daemon upload ack (ms). */
  UPLOAD_TIMEOUT_MS: 30_000,
  /** Server waits this long for daemon download response (ms). */
  DOWNLOAD_TIMEOUT_MS: 30_000,
  /** Temporary uploaded files are cleaned after this duration (ms). 24 hours. */
  TEMP_TTL_MS: 24 * 60 * 60 * 1000,
  /** Project-file download handles expire after this duration (ms). 1 hour. */
  HANDLE_TTL_MS: 60 * 60 * 1000,
  /** @deprecated — daemon overrides this to ~/.imcodes/uploads at runtime. Do not use directly. */
  UPLOAD_DIR_LEGACY: '/tmp/imcodes-uploads',
} as const;

// ── Server → Daemon messages ──────────────────────────────────────────────────

export interface FileUploadRequest {
  type: 'file.upload';
  uploadId: string;
  filename: string;
  originalName?: string;
  mime?: string;
  size: number;
  content: string; // base64
}

export interface FileDownloadRequest {
  type: 'file.download';
  downloadId: string;
  attachmentId: string;
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

export interface FileDownloadDone {
  type: 'file.download_done';
  downloadId: string;
  content: string; // base64
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
  | FileDownloadDone
  | FileDownloadError;

export type FileTransferServerMessage =
  | FileUploadRequest
  | FileDownloadRequest;

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
