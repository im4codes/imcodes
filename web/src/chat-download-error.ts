import { FS_READ_ERROR_CODES } from '@shared/fs-read-error-codes.js';
import { FILE_PATH_HANDLE_ERROR } from '@shared/transport/file-transfer.js';

type Translate = (key: string, options?: Record<string, unknown>) => string;

type ErrorWithAttempts = { attemptedLocations?: unknown };

function withAttempts(message: string, error: unknown, t: Translate): string {
  const rawLocations = error && typeof error === 'object'
    ? (error as ErrorWithAttempts).attemptedLocations
    : undefined;
  const locations = Array.isArray(rawLocations)
    ? rawLocations.filter((item: unknown): item is string => typeof item === 'string').slice(0, 16)
    : [];
  return locations.length > 0
    ? t('upload.download_error_with_attempts', { message, locations: locations.join(' · ') })
    : message;
}

/** Convert stable daemon/file-transfer reasons into actionable chat UI text. */
export function localizeChatDownloadError(
  error: unknown,
  t: Translate,
  options: { pathRequest?: boolean } = {},
): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('daemon_offline') || message.includes('503')) return t('upload.daemon_offline');
  if (message.includes(FS_READ_ERROR_CODES.FORBIDDEN_PATH)) return withAttempts(t('upload.download_forbidden'), error, t);
  if (message.includes(FS_READ_ERROR_CODES.FILE_TOO_LARGE)) return withAttempts(t('upload.download_too_large'), error, t);
  if (message.includes(FILE_PATH_HANDLE_ERROR.INVALID_PATH)
    || message.includes(FILE_PATH_HANDLE_ERROR.NOT_REGULAR_FILE)) {
    return withAttempts(t('upload.download_invalid_file'), error, t);
  }
  if (options.pathRequest && (
    message.includes(FILE_PATH_HANDLE_ERROR.NOT_FOUND)
    || message.includes(FS_READ_ERROR_CODES.PARENT_NOT_FOUND)
    || message.includes('404')
  )) {
    return withAttempts(t('upload.download_not_found'), error, t);
  }
  if (message.includes('410') || message.includes('expired')
    || message.includes(FILE_PATH_HANDLE_ERROR.NOT_FOUND) || message.includes('404')) {
    return t('upload.download_expired');
  }
  if (message.includes('504') || message.includes('timeout')) return t('upload.download_timeout');
  return t('upload.download_failed');
}
