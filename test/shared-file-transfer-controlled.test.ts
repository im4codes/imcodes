import { describe, expect, it } from 'vitest';
import {
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_PATH_MAX_BYTES,
  validateControlledFileTransferRequest,
  validateControlledFileTransferResponse,
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
});
