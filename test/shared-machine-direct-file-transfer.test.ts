import { describe, expect, it } from 'vitest';
import {
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_HANDSHAKE_MSG,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
  isValidMachineDirectEncryptedFrameLength,
  isPrivateMachineDirectAddress,
  isRoutableMachineDirectAddress,
  refreshMachineDirectUploadAuthority,
  refreshMachineDirectFetchAuthority,
  validateMachineDirectFetchRequest,
  validateMachineDirectFetchResponse,
  validateMachineDirectFetchStart,
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
  it('refreshes authority from the receiving hop clock regardless of sender clock skew', () => {
    const receivedAt = Date.parse('2026-08-03T12:00:00.000Z');
    for (const expiresAt of [receivedAt - 30 * 86_400_000, receivedAt + 30 * 86_400_000]) {
      expect(refreshMachineDirectUploadAuthority({ ...request(), expiresAt }, receivedAt).expiresAt).toBe(
        receivedAt + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
      );
    }
  });

  it('strictly validates reverse fetch controls, metadata, terminals, and local authority refresh', () => {
    const receivedAt = Date.parse('2026-08-03T12:00:00.000Z');
    const fetchRequest = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: 'f'.repeat(32),
      capability: 'B'.repeat(43),
      candidates: [{ host: '172.16.253.211', port: 45125 }],
      sourcePath: '/tmp/large.bin',
      expiresAt: receivedAt - 30 * 86_400_000,
    };
    const parsed = validateMachineDirectFetchRequest(fetchRequest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(refreshMachineDirectFetchAuthority(parsed.value, receivedAt).expiresAt).toBe(
      receivedAt + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    );
    expect(validateMachineDirectFetchRequest({ ...fetchRequest, injected: true }).ok).toBe(false);
    expect(validateMachineDirectFetchRequest({ ...fetchRequest, candidates: [{ host: '8.8.8.8', port: 53 }] }).ok).toBe(false);
    expect(validateMachineDirectFetchStart({ size: Number.MAX_SAFE_INTEGER, originalName: 'large.bin' })).toEqual({
      size: Number.MAX_SAFE_INTEGER,
      originalName: 'large.bin',
    });
    expect(validateMachineDirectFetchStart({ size: 5, originalName: 'x', injected: true })).toBeNull();
    expect(validateMachineDirectFetchResponse({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
      requestId: fetchRequest.requestId,
      size: 5,
    }).ok).toBe(true);
    expect(validateMachineDirectFetchResponse({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
      requestId: fetchRequest.requestId,
      size: 5,
      injected: true,
    }).ok).toBe(false);
  });

  it('keeps legacy link-local candidates schema-compatible but excludes them from dialing', () => {
    expect(isPrivateMachineDirectAddress('192.168.2.145')).toBe(true);
    expect(isPrivateMachineDirectAddress('172.16.253.211')).toBe(true);
    expect(isPrivateMachineDirectAddress('100.64.0.2')).toBe(true);
    expect(isPrivateMachineDirectAddress('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateMachineDirectAddress('169.254.10.20')).toBe(true);
    expect(isPrivateMachineDirectAddress('fe80::1')).toBe(true);
    expect(isPrivateMachineDirectAddress('8.8.8.8')).toBe(false);
    expect(isPrivateMachineDirectAddress('127.0.0.1')).toBe(false);
    expect(isPrivateMachineDirectAddress('internal.example')).toBe(false);
    expect(isRoutableMachineDirectAddress('192.168.2.145')).toBe(true);
    expect(isRoutableMachineDirectAddress('100.64.0.2')).toBe(true);
    expect(isRoutableMachineDirectAddress('fd12:3456:789a::1')).toBe(true);
    expect(isRoutableMachineDirectAddress('169.254.10.20')).toBe(false);
    expect(isRoutableMachineDirectAddress('fe80::1')).toBe(false);
    expect(validateMachineDirectUploadRequest(request()).ok).toBe(true);
    expect(validateMachineDirectUploadRequest({ ...request(), targetIp: '10.0.0.9' }).ok).toBe(false);
    expect(validateMachineDirectUploadRequest({ ...request(), candidates: [{ host: '8.8.8.8', port: 53 }] }).ok).toBe(false);
    expect(validateMachineDirectFetchRequest({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: 'f'.repeat(32),
      capability: 'B'.repeat(43),
      candidates: [
        { host: '172.16.253.211', port: 45125 },
        { host: 'fe80::1', port: 45125 },
      ],
      sourcePath: '/tmp/large.bin',
      expiresAt: Date.now() + 10_000,
    }).ok).toBe(true);
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
