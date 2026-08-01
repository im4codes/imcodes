import { describe, expect, it } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_MSG,
  validateDirectFileTransferBrowserMessage,
  validateDirectFileTransferDaemonCommand,
  validateDirectFileTransferDaemonMessage,
  validateDirectFileTransferDataMessage,
} from '../shared/direct-file-transfer.js';

const requestId = '123e4567-e89b-12d3-a456-426614174000';
const clientUploadId = '123e4567-e89b-12d3-a456-426614174001';
const capability = 'A'.repeat(43);

describe('direct file transfer protocol', () => {
  it('accepts an unbounded safe-integer file size while rejecting extra keys', () => {
    const valid = {
      type: DIRECT_FILE_TRANSFER_MSG.INIT,
      requestId,
      clientUploadId,
      filename: 'archive.bin',
      size: 5 * 1024 * 1024 * 1024,
    };
    expect(validateDirectFileTransferBrowserMessage(valid)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferBrowserMessage({ ...valid, serverId: 'forged' })).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });

  it('keeps prepare authority and daemon results behind exact schemas', () => {
    const prepare = {
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      requestId,
      clientUploadId,
      filename: 'archive.bin',
      size: 100,
      capability,
      expiresAt: Date.now() + 60_000,
      iceServers: ['stun:stun.cloudflare.com:3478'],
    };
    expect(validateDirectFileTransferDaemonCommand(prepare)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDaemonCommand({ ...prepare, capability: 'short' })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferDaemonMessage({
      type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
      requestId,
      capability,
      loaded: 51,
      total: 50,
    })).toMatchObject({ ok: false });
  });

  it('requires exact control messages on the data channel', () => {
    const start = {
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: 1,
      requestId,
      clientUploadId,
      filename: 'archive.bin',
      size: 100,
      capability,
    };
    expect(validateDirectFileTransferDataMessage(start)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDataMessage({ ...start, protocolVersion: 2 })).toMatchObject({ ok: false });
  });
});
