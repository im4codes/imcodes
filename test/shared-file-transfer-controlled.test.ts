import { describe, expect, it } from 'vitest';
import {
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_PATH_MAX_BYTES,
  validateControlledFileTransferRequest,
  validateControlledFileTransferResponse,
  validateFileDirectoryListRequest,
  validateFilePathHandleRequest,
} from '../shared/transport/file-transfer.js';

describe('controlled file-transfer trust boundary', () => {
  it('accepts only strict explicit-path requests', () => {
    expect(validateFilePathHandleRequest({
      type: FILE_TRANSFER_MSG.PATH_HANDLE,
      requestId: 'request-1',
      path: '/tmp/report.txt',
    }).ok).toBe(true);
    expect(validateFilePathHandleRequest({
      type: FILE_TRANSFER_MSG.PATH_HANDLE,
      requestId: 'request-1',
      path: '/tmp/report.txt',
      recursive: true,
    })).toEqual({ ok: false, error: 'unknown_field' });
    expect(validateFilePathHandleRequest({
      type: FILE_TRANSFER_MSG.PATH_HANDLE,
      requestId: 'request-1',
      path: 'x'.repeat(FILE_TRANSFER_PATH_MAX_BYTES + 1),
    }).ok).toBe(false);
    expect(validateControlledFileTransferRequest({
      type: 'file.upload',
      uploadId: 'upload-1',
      content: 'secret-base64',
    }).ok).toBe(false);
  });

  it('rejects unknown response fields and oversized or unsafe error values', () => {
    const attachment = {
      id: 'a'.repeat(32),
      source: 'local',
      serverId: '',
      daemonPath: '/tmp/report.txt',
      createdAt: new Date().toISOString(),
      downloadable: true,
    };
    expect(validateControlledFileTransferResponse({
      type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
      requestId: 'request-1',
      attachment,
    }).ok).toBe(true);
    expect(validateControlledFileTransferResponse({
      type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
      requestId: 'request-1',
      attachment: { ...attachment, prompt: 'private' },
    }).ok).toBe(false);
    expect(validateControlledFileTransferResponse({
      type: FILE_TRANSFER_MSG.UPLOAD_DONE,
      uploadId: 'upload-1',
      attachment: { ...attachment, id: `${'b'.repeat(32)}.txt`, source: 'upload' },
    }).ok).toBe(true);
    expect(validateControlledFileTransferResponse({
      type: FILE_TRANSFER_MSG.DOWNLOAD_ERROR,
      downloadId: 'download-1',
      message: '/Users/alice/.ssh/id_rsa',
    }).ok).toBe(false);
  });

  it('strictly validates attachment deletion requests and terminals', () => {
    expect(validateControlledFileTransferRequest({
      type: FILE_TRANSFER_MSG.DELETE,
      requestId: 'delete-1',
      attachmentId: 'abc123.txt',
    }).ok).toBe(true);
    expect(validateControlledFileTransferRequest({
      type: FILE_TRANSFER_MSG.DELETE,
      requestId: 'delete-1',
      attachmentId: 'abc123.txt',
      daemonPath: '/tmp/other-file',
    })).toEqual({ ok: false, error: 'unknown_field' });
    expect(validateControlledFileTransferResponse({
      type: FILE_TRANSFER_MSG.DELETE_DONE,
      requestId: 'delete-1',
    }).ok).toBe(true);
    expect(validateControlledFileTransferResponse({
      type: FILE_TRANSFER_MSG.DELETE_ERROR,
      requestId: 'delete-1',
      error: 'arbitrary_error',
    }).ok).toBe(false);
  });

  it('strictly validates bounded directory-list requests and responses', () => {
    expect(validateFileDirectoryListRequest({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST,
      requestId: 'directory-1',
      path: 'C:\\Users',
    }).ok).toBe(true);
    expect(validateFileDirectoryListRequest({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST,
      requestId: 'directory-1',
      path: 'C:\\Users',
      recursive: true,
    })).toEqual({ ok: false, error: 'unknown_field' });
    expect(validateControlledFileTransferResponse({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE,
      requestId: 'directory-1',
      path: 'C:\\Users',
      resolvedPath: 'C:\\Users',
      entries: [{ name: 'Public', path: 'C:\\Users\\Public', isDir: true, hidden: false }],
    }).ok).toBe(true);
    expect(validateControlledFileTransferResponse({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE,
      requestId: 'directory-1',
      path: 'C:\\Users',
      resolvedPath: 'C:\\Users',
      entries: [{ name: 'Public', path: 'C:\\Users\\Public', isDir: true, hidden: false, size: 1 }],
    }).ok).toBe(false);
  });

  it('accepts a bounded selected destination only on the upload-fetch shape', () => {
    const base = {
      type: FILE_TRANSFER_MSG.UPLOAD_FETCH,
      uploadId: 'upload-destination',
      filename: 'abcdef1234567890.txt',
      originalName: 'report.txt',
      size: 5,
      downloadUrl: 'https://example.test/staged',
    } as const;
    expect(validateControlledFileTransferRequest({
      ...base,
      destinationDirectory: 'C:\\Users\\Public',
    }).ok).toBe(true);
    expect(validateControlledFileTransferRequest({
      ...base,
      destinationDirectory: 'x'.repeat(FILE_TRANSFER_PATH_MAX_BYTES + 1),
    }).ok).toBe(false);
  });
});
