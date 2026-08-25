import { describe, expect, it } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_ERROR_SCOPE,
  DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION,
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_RESUME_TICKET_TYPE,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
  isDirectFileTransferMessageType,
  isLegacyDirectFileTransferMessageType,
  classifyDirectFileTransferFailure,
  validateDirectFileTransferAuthorized,
  validateDirectFileTransferBrowserMessage,
  validateDirectFileTransferDaemonCommand,
  validateDirectFileTransferDaemonMessage,
  validateDirectFileTransferDataMessage,
  validateDirectFileTransferResumeTicketClaims,
  validateDirectFileTransferServerMessage,
} from '../../shared/direct-file-transfer.js';

const serverId = 'server-12345678';
const browserTabId = 'tab-12345678';
const leaseId = 'lease-12345678';
const requestId = 'request-12345678';
const attemptId = 'attempt-12345678';
const operationId = 'operation-12345678';
const authority = 'A'.repeat(43);
const resumeTicket = 'header.payload.signature';
const iceServers = ['stun:stun.cloudflare.com:3478'];

function binding(direction = DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) {
  return {
    serverId,
    browserTabId,
    leaseId,
    leaseGeneration: 1,
    daemonGeneration: 2,
    requestId,
    attemptId,
    attempt: 1,
    direction,
    operationId,
  };
}

function uploadInit() {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...binding(),
    clientUploadId: operationId,
    filename: 'archive.bin',
    size: 1_024,
  };
}

function downloadInit() {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...binding(DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD),
    clientDownloadId: operationId,
    previewHandle: 'preview-handle-12345678',
  };
}

describe('direct file transfer v2 shared protocol', () => {
  it('advertises independent v2 lease, upload recovery, and preview-download capabilities', () => {
    expect(DIRECT_FILE_TRANSFER_LEASE_CAPABILITY).toBe('file.transfer.direct.lease.v2');
    expect(DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY).toBe('file.transfer.direct.upload_recovery.v2');
    expect(DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY).toBe('file.transfer.direct.preview_download.v2');
    expect(DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY).toBe('file.transfer.direct.directory_upload.v1');
    expect(DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS).toBe(3);
    expect(DIRECT_FILE_TRANSFER_LIMITS.RETRY_BACKOFF_MS).toEqual([250, 1_000]);
    expect(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS).toBe(5 * 60 * 1_000);
    expect(DIRECT_FILE_TRANSFER_LIMITS.RESUME_TICKET_TTL_MS).toBe(10 * 60 * 1_000);
    expect(DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY).toBe(256);
  });

  it('validates an exact, inert lease init and rejects legacy v1 messages', () => {
    const init = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_INIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId,
      serverId,
      browserTabId,
    };
    expect(validateDirectFileTransferBrowserMessage(init)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferBrowserMessage({ ...init, previewHandle: 'must-not-be-on-lease' })).toMatchObject({ ok: false });
    expect(isDirectFileTransferMessageType('direct_file.init')).toBe(false);
    expect(isLegacyDirectFileTransferMessageType('direct_file.init')).toBe(true);
    expect(isLegacyDirectFileTransferMessageType('direct_file.v2.unknown')).toBe(false);
    expect(validateDirectFileTransferBrowserMessage({ type: 'direct_file.init', requestId })).toMatchObject({ ok: false });
  });

  it('validates a persistent-secret ticket only for its exact lease binding', () => {
    const claims = {
      type: DIRECT_FILE_TRANSFER_RESUME_TICKET_TYPE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      userId: 'user-12345678',
      browserTabId,
      serverId,
      leaseId,
      leaseGeneration: 1,
      expiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.RESUME_TICKET_TTL_MS,
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 600,
    };
    expect(validateDirectFileTransferResumeTicketClaims(claims)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferResumeTicketClaims({ ...claims, path: '/tmp/forged' })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferResumeTicketClaims({ ...claims, leaseGeneration: 0 })).toMatchObject({ ok: false });

    const ready = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId,
      serverId,
      browserTabId,
      leaseId,
      leaseGeneration: 1,
      daemonGeneration: 2,
      resumeTicket,
      idleExpiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
      expiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.RESUME_TICKET_TTL_MS,
      iceServers,
    };
    expect(validateDirectFileTransferServerMessage(ready)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferServerMessage({ ...ready, resumeTicket: 'not-a-jwt' })).toMatchObject({ ok: false });
  });

  it('separates upload metadata from handle-only download authorization', () => {
    expect(validateDirectFileTransferBrowserMessage(uploadInit())).toMatchObject({ ok: true });
    expect(validateDirectFileTransferBrowserMessage({
      ...uploadInit(),
      destinationDirectory: 'C:\\Users\\admin\\Desktop',
    })).toMatchObject({ ok: true });
    expect(validateDirectFileTransferBrowserMessage({
      ...uploadInit(),
      destinationDirectory: `C:\\${'x'.repeat(5_000)}`,
    })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferBrowserMessage(downloadInit())).toMatchObject({ ok: true });

    for (const forbidden of [
      { path: '/etc/shadow' },
      { destination: 'C:\\Users\\x\\Downloads' },
      { filename: 'override.bin' },
      { sourceMetadata: { name: 'forged' } },
    ]) {
      expect(validateDirectFileTransferBrowserMessage({ ...downloadInit(), ...forbidden })).toMatchObject({ ok: false });
    }
    expect(validateDirectFileTransferBrowserMessage({ ...downloadInit(), operationId: 'other-12345678' })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferBrowserMessage({ ...uploadInit(), clientDownloadId: operationId })).toMatchObject({ ok: false });
  });

  it('binds authorization to the exact attempt, lease generation, and direction', () => {
    const authorized = {
      ...uploadInit(),
      type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED,
      authority,
      authorityExpiresAt: Date.now() + 60_000,
      channelLabel: 'direct-file-channel-1',
      iceServers,
    };
    expect(validateDirectFileTransferAuthorized(authorized)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferAuthorized({ ...authorized, attempt: 4 })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferAuthorized({ ...authorized, leaseGeneration: 0 })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferAuthorized({ ...authorized, authority: 'short' })).toMatchObject({ ok: false });

    const prepare = { ...authorized, type: DIRECT_FILE_TRANSFER_MSG.PREPARE };
    expect(validateDirectFileTransferDaemonCommand(prepare)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDaemonCommand({ ...prepare, previewHandle: 'forged' })).toMatchObject({ ok: false });

    const status = {
      type: DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
    };
    expect(validateDirectFileTransferBrowserMessage(status)).toMatchObject({ ok: true });
    // Recovery cannot reuse the one-time data-start authority.
    expect(validateDirectFileTransferBrowserMessage({ ...status, authority })).toMatchObject({ ok: false });
  });

  it('requires a daemon-only lease prepare before a prewarmed peer accepts offers', () => {
    const prepare = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId,
      serverId,
      browserTabId,
      leaseId,
      leaseGeneration: 1,
      daemonGeneration: 2,
      expiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
      iceServers,
    };
    expect(validateDirectFileTransferDaemonCommand(prepare)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDaemonCommand({ ...prepare, resumeTicket })).toMatchObject({ ok: false });

    const prepared = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId,
      serverId,
      browserTabId,
      leaseId,
      leaseGeneration: 1,
      daemonGeneration: 2,
    };
    expect(validateDirectFileTransferDaemonMessage(prepared)).toMatchObject({ ok: true });
    // The router consumes the daemon ack and mints the ticket; it is never browser-facing.
    expect(validateDirectFileTransferServerMessage(prepared)).toMatchObject({ ok: false });
  });

  it('permits an idle deadline only on Server terminal cleanup outcomes', () => {
    const daemonTerminal = {
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      state: 'failed',
      error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
    };
    const idleExpiresAt = Date.now() + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS;
    // Daemons never select a browser lease lifetime themselves.
    expect(validateDirectFileTransferDaemonMessage({ ...daemonTerminal, idleExpiresAt })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferServerMessage(daemonTerminal)).toMatchObject({ ok: false });
    expect(validateDirectFileTransferServerMessage({ ...daemonTerminal, idleExpiresAt })).toMatchObject({ ok: true });

    const terminalStatus = {
      type: DIRECT_FILE_TRANSFER_MSG.STATUS,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      state: 'committed',
      idleExpiresAt,
    };
    expect(validateDirectFileTransferServerMessage(terminalStatus)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferServerMessage({ ...terminalStatus, idleExpiresAt: undefined })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferServerMessage({ ...terminalStatus, state: 'streaming' })).toMatchObject({ ok: false });

    const daemonError = {
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
      ...binding(),
      error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
      retryable: true,
    };
    expect(validateDirectFileTransferDaemonMessage({ ...daemonError, idleExpiresAt })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferServerMessage({ ...daemonError, idleExpiresAt })).toMatchObject({ ok: true });
  });

  it('negotiates a prewarmed peer with lease-only signaling and no file authority', () => {
    const offer = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId,
      serverId,
      browserTabId,
      leaseId,
      leaseGeneration: 1,
      daemonGeneration: 2,
      sdp: 'v=0\r\no=browser 1 1 IN IP4 127.0.0.1',
    };
    expect(validateDirectFileTransferBrowserMessage(offer)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferBrowserMessage({ ...offer, authority })).toMatchObject({ ok: false });

    const answer = { ...offer, type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER };
    expect(validateDirectFileTransferDaemonMessage(answer)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferServerMessage(answer)).toMatchObject({ ok: true });

    const ice = {
      ...binding(),
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ICE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      candidate: 'candidate:0 1 UDP 2122252543 192.168.1.2 12345 typ host',
      mid: '0',
    };
    // Deliberately omit operation/attempt properties: lease ICE carries only lease binding.
    const { attemptId: _attemptId, attempt: _attempt, direction: _direction, operationId: _operationId, ...leaseIce } = ice;
    expect(validateDirectFileTransferBrowserMessage(leaseIce)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferBrowserMessage({ ...leaseIce, attemptId })).toMatchObject({ ok: false });
  });

  it('uses exact data-plane start, download credit, finish, and commit schemas', () => {
    const start = {
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD),
      authority,
    };
    expect(validateDirectFileTransferDataMessage(start)).toMatchObject({ ok: true });

    const credit = {
      type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD),
      creditBytes: DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES,
    };
    expect(validateDirectFileTransferDataMessage(credit)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDataMessage({ ...credit, direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferDataMessage({ ...credit, creditBytes: DIRECT_FILE_TRANSFER_LIMITS.DATA_CREDIT_BYTES + 1 })).toMatchObject({ ok: false });

    const finish = {
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD),
      totalBytes: 1_024,
    };
    expect(validateDirectFileTransferDataMessage(finish)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDataMessage({ ...finish, totalBytes: -1 })).toMatchObject({ ok: false });

    const committed = {
      type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD),
      totalBytes: 1_024,
    };
    expect(validateDirectFileTransferDataMessage(committed)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDataMessage({ ...committed, attachment: {} })).toMatchObject({ ok: false });
  });

  it('accepts a lease-scoped malformed-init error without inventing a fake authority', () => {
    const error = {
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
      requestId,
      error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST,
      retryable: false,
    };
    expect(validateDirectFileTransferServerMessage(error)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDaemonMessage({ ...error, leaseId })).toMatchObject({ ok: false });
  });

  it('centralizes the three-attempt HTTP-fallback boundary without masking security failures', () => {
    expect(classifyDirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED, 1))
      .toBe(DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.RETRY_DIRECT);
    expect(classifyDirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CHANNEL_CLOSED, 3))
      .toBe(DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.HTTP_FALLBACK);
    expect(classifyDirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE, 0))
      .toBe(DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.HTTP_FALLBACK);
    expect(classifyDirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CANCELED, 1))
      .toBe(DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.TERMINAL);
    expect(classifyDirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.PREVIEW_POLICY_DENIED, 3))
      .toBe(DIRECT_FILE_TRANSFER_FAILURE_DISPOSITION.TERMINAL);
  });
});
