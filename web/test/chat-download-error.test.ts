import { describe, expect, it } from 'vitest';
import { FS_READ_ERROR_CODES } from '@shared/fs-read-error-codes.js';
import { FILE_PATH_HANDLE_ERROR } from '@shared/transport/file-transfer.js';
import { localizeChatDownloadError } from '../src/chat-download-error.js';

const t = (key: string) => key;

describe('chat download error localization', () => {
  it.each([
    [FS_READ_ERROR_CODES.PARENT_NOT_FOUND, 'upload.download_not_found'],
    [FILE_PATH_HANDLE_ERROR.NOT_FOUND, 'upload.download_not_found'],
    [FS_READ_ERROR_CODES.FORBIDDEN_PATH, 'upload.download_forbidden'],
    [FS_READ_ERROR_CODES.FILE_TOO_LARGE, 'upload.download_too_large'],
    [FILE_PATH_HANDLE_ERROR.INVALID_PATH, 'upload.download_invalid_file'],
    [FILE_PATH_HANDLE_ERROR.NOT_REGULAR_FILE, 'upload.download_invalid_file'],
  ])('maps a path request error %s to an actionable tooltip', (error, expected) => {
    expect(localizeChatDownloadError(new Error(error), t, { pathRequest: true })).toBe(expected);
  });

  it('keeps a stale transfer handle distinct from a file missing at path lookup', () => {
    expect(localizeChatDownloadError(new Error(FILE_PATH_HANDLE_ERROR.NOT_FOUND), t)).toBe('upload.download_expired');
  });

  it('shows redacted daemon resolution attempts with the concrete failure reason', () => {
    const error = Object.assign(new Error(FS_READ_ERROR_CODES.PARENT_NOT_FOUND), {
      attemptedLocations: ['cwd:dist/report.pdf', 'project:dist/report.pdf', 'cwd-search:report.pdf'],
    });
    const translate = (key: string, options?: Record<string, unknown>) => (
      key === 'upload.download_error_with_attempts'
        ? `${options?.message} — ${options?.locations}`
        : key
    );
    expect(localizeChatDownloadError(error, translate, { pathRequest: true })).toBe(
      'upload.download_not_found — cwd:dist/report.pdf · project:dist/report.pdf · cwd-search:report.pdf',
    );
  });
});
