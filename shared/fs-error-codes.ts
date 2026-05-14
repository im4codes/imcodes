export const FS_GENERIC_ERROR_CODES = {
  FORBIDDEN_PATH: 'forbidden_path',
  FILE_TOO_LARGE: 'file_too_large',
  FS_LIST_TIMEOUT: 'fs_list_timeout',
  FS_LIST_WORKER_QUEUE_FULL: 'worker_queue_full',
  FS_LIST_WORKER_TIMEOUT: 'worker_timeout',
  FS_LIST_WORKER_UNAVAILABLE: 'worker_unavailable',
  INVALID_REQUEST: 'invalid_request',
  INTERNAL_ERROR: 'internal_error',
  PARENT_NOT_FOUND: 'parent_not_found',
} as const;

export type FsGenericErrorCode = (typeof FS_GENERIC_ERROR_CODES)[keyof typeof FS_GENERIC_ERROR_CODES];

export const FS_GENERIC_ERROR_CODE_VALUES = [
  FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
  FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE,
  FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT,
  FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_QUEUE_FULL,
  FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_TIMEOUT,
  FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_UNAVAILABLE,
  FS_GENERIC_ERROR_CODES.INVALID_REQUEST,
  FS_GENERIC_ERROR_CODES.INTERNAL_ERROR,
  FS_GENERIC_ERROR_CODES.PARENT_NOT_FOUND,
] as const satisfies readonly FsGenericErrorCode[];

const FS_GENERIC_ERROR_CODE_SET: ReadonlySet<string> = new Set(FS_GENERIC_ERROR_CODE_VALUES);

export function isFsGenericErrorCode(value: unknown): value is FsGenericErrorCode {
  return typeof value === 'string' && FS_GENERIC_ERROR_CODE_SET.has(value);
}
