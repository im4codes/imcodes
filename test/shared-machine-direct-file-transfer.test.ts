import { describe, expect, it } from 'vitest';
import {
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_HANDSHAKE_MSG,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
  isValidMachineDirectEncryptedFrameLength,
  isPrivateMachineDirectAddress,
  validateMachineDirectSourceHello,
  validateMachineDirectTargetHello,
  validateMachineDirectUploadRequest,
  validateMachineDirectUploadResponse,
} from '../shared/machine-direct-file-transfer.js';
import { validateAttachmentRef } from '../shared/transport/file-transfer.js';

function request() {
  return {
    type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
    requestId: 'r'.repeat(32),
    clientUploadId: 'c'.repeat(32),
    capability: 'A'.repeat(43),
    candidates: [{ host: '192.168.2.145', port: 43123 }],
    originalName: 'report.txt',
    mime: 'text/plain',
    size: 5,
    expiresAt: Date.now() + 10_000,
  };
}

describe('machine direct file-transfer trust boundary', () => {
  it('accepts routed private candidates but rejects public, loopback, hostnames, and extra keys', () => {
    expect(isPrivateMachineDirectAddress('192.168.2.145')).toBe(true);
    expect(isPrivateMachineDirectAddress('172.16.253.211')).toBe(true);
    expect(isPrivateMachineDirectAddress('100.64.0.2')).toBe(true);
    expect(isPrivateMachineDirectAddress('8.8.8.8')).toBe(false);
    expect(isPrivateMachineDirectAddress('127.0.0.1')).toBe(false);
    expect(isPrivateMachineDirectAddress('internal.example')).toBe(false);
    expect(validateMachineDirectUploadRequest(request()).ok).toBe(true);
    expect(validateMachineDirectUploadRequest({ ...request(), targetIp: '10.0.0.9' }).ok).toBe(false);
    expect(validateMachineDirectUploadRequest({ ...request(), candidates: [{ host: '8.8.8.8', port: 53 }] }).ok).toBe(false);
  });

  it('strictly validates terminal responses and attachment shape', () => {
    const attachment = {
      id: 'a'.repeat(32),
      source: 'upload',
      serverId: '',
      daemonPath: '/tmp/a',
      originalName: 'a.txt',
      size: 5,
      createdAt: new Date().toISOString(),
      downloadable: true,
    };
    expect(validateMachineDirectUploadResponse({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE,
      requestId: 'r'.repeat(32),
      attachment,
    }, validateAttachmentRef).ok).toBe(true);
    expect(validateMachineDirectUploadResponse({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE,
      requestId: 'r'.repeat(32),
      attachment,
      injected: true,
    }, validateAttachmentRef).ok).toBe(false);
    expect(validateMachineDirectUploadResponse({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      requestId: 'r'.repeat(32),
      error: '/private/path',
    }, validateAttachmentRef).ok).toBe(false);
  });

  it('strictly validates handshake envelopes and encrypted-frame bounds', () => {
    const targetHello = {
      type: MACHINE_DIRECT_HANDSHAKE_MSG.TARGET_HELLO,
      requestId: 'r'.repeat(32),
      nonce: 'n'.repeat(24),
      proof: 'p'.repeat(43),
    };
    expect(validateMachineDirectTargetHello(targetHello)).toEqual(targetHello);
    expect(validateMachineDirectTargetHello({ ...targetHello, injected: true })).toBeNull();
    expect(validateMachineDirectTargetHello({ ...targetHello, nonce: 'n'.repeat(23) })).toBeNull();
    expect(validateMachineDirectSourceHello({ ...targetHello, type: MACHINE_DIRECT_HANDSHAKE_MSG.SOURCE_HELLO })).not.toBeNull();
    expect(validateMachineDirectSourceHello(targetHello)).toBeNull();

    const minimum = MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FRAME_AUTH_TAG_BYTES + 1;
    const maximum = MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_FRAME_PLAINTEXT_BYTES
      + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FRAME_AUTH_TAG_BYTES;
    expect(isValidMachineDirectEncryptedFrameLength(minimum)).toBe(true);
    expect(isValidMachineDirectEncryptedFrameLength(maximum)).toBe(true);
    expect(isValidMachineDirectEncryptedFrameLength(minimum - 1)).toBe(false);
    expect(isValidMachineDirectEncryptedFrameLength(maximum + 1)).toBe(false);
    expect(isValidMachineDirectEncryptedFrameLength(1.5)).toBe(false);
  });
});
