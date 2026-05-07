export const FS_GENERIC_ERROR_CODES = {
  FORBIDDEN_PATH: 'forbidden_path',
  FILE_TOO_LARGE: 'file_too_large',
  INVALID_REQUEST: 'invalid_request',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type FsGenericErrorCode = (typeof FS_GENERIC_ERROR_CODES)[keyof typeof FS_GENERIC_ERROR_CODES];

export const FS_GENERIC_ERROR_CODE_VALUES = [
  FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
  FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE,
  FS_GENERIC_ERROR_CODES.INVALID_REQUEST,
  FS_GENERIC_ERROR_CODES.INTERNAL_ERROR,
] as const satisfies readonly FsGenericErrorCode[];

const FS_GENERIC_ERROR_CODE_SET: ReadonlySet<string> = new Set(FS_GENERIC_ERROR_CODE_VALUES);

export function isFsGenericErrorCode(value: unknown): value is FsGenericErrorCode {
  return typeof value === 'string' && FS_GENERIC_ERROR_CODE_SET.has(value);
}
