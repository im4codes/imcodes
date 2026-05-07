import type { FsReadErrorCode, FsReadPreviewReason } from '../../shared/fs-read-error-codes.js';

export type PreviewReadWorkerPhase = 'preflight' | 'snapshot';
export type PreviewReadWorkerRequestId = number;
export type PreviewReadWorkerSlotId = number;
export type PreviewReadWorkerGeneration = number;

export const DEFAULT_PREVIEW_READ_WORKERS_TARGET = 2;
export const MIN_PREVIEW_READ_WORKERS_TARGET = 1;
export const HARD_MAX_PREVIEW_READ_WORKERS = 4;
export const DEFAULT_PREVIEW_READ_POOL_QUEUE_CAP = 32;

export type PreviewReadPreviewKind = 'text' | 'image' | 'office' | 'video' | 'too_large' | 'unknown';

export interface PreviewReadClassification {
  previewKind: PreviewReadPreviewKind;
  mimeType?: string;
  extension?: string;
  sizeLimitBytes: number;
  previewMode?: 'stream';
  previewReason?: FsReadPreviewReason;
}

export interface PreviewReadWorkerIdentity {
  workerRequestId: PreviewReadWorkerRequestId;
  workerSlotId: PreviewReadWorkerSlotId;
  workerGeneration: PreviewReadWorkerGeneration;
}

/**
 * Defense-in-depth: worker wire is internal-only. Public/browser ids, download
 * handles, raw error detail, and runtime policy hot-reload fields are not part
 * of the v1 worker protocol.
 */
export interface ForbiddenPreviewReadWorkerWireFields {
  requestId?: never;
  externalRequestId?: never;
  downloadId?: never;
  attachmentId?: never;
  attachment?: never;
  serverLink?: never;
  browserSocket?: never;
  socket?: never;
  rawError?: never;
  errorMessage?: never;
  message?: never;
  stack?: never;
  errno?: never;
  syscall?: never;
  policyVersion?: never;
}

export interface PreviewReadPreflightRequest
  extends PreviewReadWorkerIdentity, ForbiddenPreviewReadWorkerWireFields {
  phase: 'preflight';
  rawPath: string;
}

export interface PreviewReadSnapshotRequest
  extends PreviewReadWorkerIdentity, ForbiddenPreviewReadWorkerWireFields {
  phase: 'snapshot';
  realPath: string;
  startSignature: string;
  size: number;
  mtimeMs: number;
  fileName: string;
  classification: PreviewReadClassification;
}

export type PreviewReadWorkerRequest = PreviewReadPreflightRequest | PreviewReadSnapshotRequest;

export type PreviewReadPreflightJobInput = Omit<
  PreviewReadPreflightRequest,
  keyof PreviewReadWorkerIdentity | keyof ForbiddenPreviewReadWorkerWireFields
>;

export type PreviewReadSnapshotJobInput = Omit<
  PreviewReadSnapshotRequest,
  keyof PreviewReadWorkerIdentity | keyof ForbiddenPreviewReadWorkerWireFields
>;

export type PreviewReadWorkerJobInput = PreviewReadPreflightJobInput | PreviewReadSnapshotJobInput;

export interface PreviewReadWorkerResultBase
  extends PreviewReadWorkerIdentity, ForbiddenPreviewReadWorkerWireFields {
  phase: PreviewReadWorkerPhase;
}

export interface PreviewReadWorkerError extends PreviewReadWorkerResultBase {
  kind: 'error';
  error: FsReadErrorCode;
  previewReason?: FsReadPreviewReason;
  sanitized: true;
}

export interface PreviewReadPreflightSuccess extends PreviewReadWorkerResultBase {
  phase: 'preflight';
  kind: 'success';
  realPath: string;
  startSignature: string;
  size: number;
  mtimeMs: number;
  fileName: string;
  classification: PreviewReadClassification;
}

export type PreviewReadSnapshotPayload =
  | { mode: 'text'; content: string }
  | { mode: 'base64'; content: string; encoding: 'base64'; mimeType: string }
  | { mode: 'stream'; previewMode: 'stream'; mimeType: string; size: number }
  | { mode: 'unavailable'; error: FsReadErrorCode; previewReason?: FsReadPreviewReason };

export interface PreviewReadSnapshotSuccess extends PreviewReadWorkerResultBase {
  phase: 'snapshot';
  kind: 'success';
  realPath: string;
  startSignature: string;
  endSignature: string;
  size: number;
  mtimeMs: number;
  fileName: string;
  classification: PreviewReadClassification;
  payload: PreviewReadSnapshotPayload;
}

export type PreviewReadWorkerSuccess = PreviewReadPreflightSuccess | PreviewReadSnapshotSuccess;
export type PreviewReadWorkerResult = PreviewReadWorkerSuccess | PreviewReadWorkerError;

export function withPreviewReadWorkerIdentity<T extends PreviewReadWorkerJobInput>(
  input: T,
  identity: PreviewReadWorkerIdentity,
): PreviewReadWorkerRequest {
  return { ...input, ...identity } as PreviewReadWorkerRequest;
}

export function isPreviewReadWorkerResultFor(
  result: PreviewReadWorkerResult,
  identity: PreviewReadWorkerIdentity,
): boolean {
  return result.workerRequestId === identity.workerRequestId
    && result.workerSlotId === identity.workerSlotId
    && result.workerGeneration === identity.workerGeneration;
}
