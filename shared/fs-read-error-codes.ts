import { FS_GENERIC_ERROR_CODES } from './fs-error-codes.js';
export {
  FS_GENERIC_ERROR_CODES,
  FS_GENERIC_ERROR_CODE_VALUES,
  isFsGenericErrorCode,
  type FsGenericErrorCode,
} from './fs-error-codes.js';

export const FS_READ_ERROR_CODES = {
  ...FS_GENERIC_ERROR_CODES,
  BINARY_FILE: 'binary_file',
  /** The target path is a directory, not a file — the client should list it
   *  (open the folder) instead of treating it as a failed file preview. */
  IS_DIRECTORY: 'is_directory',
  PREVIEW_WORKER_QUEUE_FULL: 'preview_worker_queue_full',
  PREVIEW_WORKER_TIMEOUT: 'preview_worker_timeout',
  PREVIEW_WORKER_UNAVAILABLE: 'preview_worker_unavailable',
  PREVIEW_WORKER_CRASHED: 'preview_worker_crashed',
  PREVIEW_BRIDGE_TIMEOUT: 'preview_bridge_timeout',
  STALE_READ: 'stale_read',
} as const;

export type FsReadErrorCode = (typeof FS_READ_ERROR_CODES)[keyof typeof FS_READ_ERROR_CODES];

export const FS_READ_ERROR_CODE_VALUES = [
  FS_READ_ERROR_CODES.BINARY_FILE,
  FS_READ_ERROR_CODES.IS_DIRECTORY,
  FS_READ_ERROR_CODES.FORBIDDEN_PATH,
  FS_READ_ERROR_CODES.FILE_TOO_LARGE,
  FS_READ_ERROR_CODES.FS_LIST_TIMEOUT,
  FS_READ_ERROR_CODES.PREVIEW_WORKER_QUEUE_FULL,
  FS_READ_ERROR_CODES.PREVIEW_WORKER_TIMEOUT,
  FS_READ_ERROR_CODES.PREVIEW_WORKER_UNAVAILABLE,
  FS_READ_ERROR_CODES.PREVIEW_WORKER_CRASHED,
  FS_READ_ERROR_CODES.PREVIEW_BRIDGE_TIMEOUT,
  FS_READ_ERROR_CODES.STALE_READ,
  FS_READ_ERROR_CODES.INVALID_REQUEST,
  FS_READ_ERROR_CODES.INTERNAL_ERROR,
  FS_READ_ERROR_CODES.PARENT_NOT_FOUND,
] as const satisfies readonly FsReadErrorCode[];

const FS_READ_ERROR_CODE_SET: ReadonlySet<string> = new Set(FS_READ_ERROR_CODE_VALUES);

export function isFsReadErrorCode(value: unknown): value is FsReadErrorCode {
  return typeof value === 'string' && FS_READ_ERROR_CODE_SET.has(value);
}

export const FS_READ_PREVIEW_REASONS = {
  TOO_LARGE: 'too_large',
  BINARY: 'binary',
  UNKNOWN_TYPE: 'unknown_type',
} as const;

export type FsReadPreviewReason = (typeof FS_READ_PREVIEW_REASONS)[keyof typeof FS_READ_PREVIEW_REASONS];

export const FS_READ_PREVIEW_REASON_VALUES = [
  FS_READ_PREVIEW_REASONS.TOO_LARGE,
  FS_READ_PREVIEW_REASONS.BINARY,
  FS_READ_PREVIEW_REASONS.UNKNOWN_TYPE,
] as const satisfies readonly FsReadPreviewReason[];

const FS_READ_PREVIEW_REASON_SET: ReadonlySet<string> = new Set(FS_READ_PREVIEW_REASON_VALUES);

export function isFsReadPreviewReason(value: unknown): value is FsReadPreviewReason {
  return typeof value === 'string' && FS_READ_PREVIEW_REASON_SET.has(value);
}
