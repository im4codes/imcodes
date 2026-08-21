import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_OPERATION_STATE,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_TERMINAL_STATE,
} from '../../shared/direct-file-transfer.js';

class FakeDataChannel {
  private messageHandler: ((message: string | Buffer | ArrayBuffer) => void) | null = null;
  private closedHandler: (() => void) | null = null;
  private errorHandler: ((error: string) => void) | null = null;
  sent: Array<string | Uint8Array> = [];
  close = vi.fn(() => this.closedHandler?.());
  sendMessage = vi.fn((message: string) => { this.sent.push(message); return true; });
  sendMessageBinary = vi.fn((message: Uint8Array) => { this.sent.push(message); return true; });
  bufferedAmount = () => 0;
  setBufferedAmountLowThreshold = vi.fn();
  onClosed = (handler: () => void) => { this.closedHandler = handler; };
  onError = (handler: (error: string) => void) => { this.errorHandler = handler; };
  onBufferedAmountLow = vi.fn();
  onMessage = (handler: (message: string | Buffer | ArrayBuffer) => void) => { this.messageHandler = handler; };

  constructor(private readonly label: string) {}

  getLabel = () => this.label;
  emit(message: string | Buffer | ArrayBuffer): void { this.messageHandler?.(message); }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;
  private dataChannelHandler: ((channel: FakeDataChannel) => void) | null = null;
  private localDescriptionHandler: ((sdp: string, type: string) => void) | null = null;
  private localCandidateHandler: ((candidate: string, mid: string) => void) | null = null;
  private stateHandler: ((state: string) => void) | null = null;
  close = vi.fn();
  setRemoteDescription = vi.fn((_sdp: string, type: string) => {
    if (type === 'offer') this.localDescriptionHandler?.('daemon-lease-answer', 'answer');
  });
  addRemoteCandidate = vi.fn();
  rtt = vi.fn(() => 2.5);
  getSelectedCandidatePair = vi.fn(() => ({
    local: { address: '192.168.1.2', port: 4000, type: 'host', transportType: 'udp' },
    remote: { address: '192.168.1.3', port: 5000, type: 'prflx', transportType: 'udp' },
  }));

  constructor() { FakePeerConnection.latest = this; }

  onDataChannel = (handler: (channel: FakeDataChannel) => void) => { this.dataChannelHandler = handler; };
  onLocalDescription = (handler: (sdp: string, type: string) => void) => { this.localDescriptionHandler = handler; };
  onLocalCandidate = (handler: (candidate: string, mid: string) => void) => { this.localCandidateHandler = handler; };
  onStateChange = (handler: (state: string) => void) => { this.stateHandler = handler; };
  emitDataChannel(channel: FakeDataChannel): void { this.dataChannelHandler?.(channel); }
}

const serverId = 'daemon-0001';
const browserTabId = 'browser-tab-0001';
const leaseId = 'lease-0001';
const requestId = 'request-0001';
const attemptId = 'attempt-0001';
const operationId = 'operation-0001';

function leasePrepare(overrides: Record<string, unknown> = {}) {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    requestId,
    serverId,
    browserTabId,
    leaseId,
    leaseGeneration: 1,
    daemonGeneration: 1,
    expiresAt: Date.now() + 60_000,
    iceServers: [],
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    serverId,
    browserTabId,
    leaseId,
    leaseGeneration: 1,
    daemonGeneration: 1,
    requestId,
    attemptId,
    attempt: 1,
    direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
    operationId,
    ...overrides,
  };
}

function uploadPrepare(overrides: Record<string, unknown> = {}) {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...binding(),
    clientUploadId: operationId,
    filename: 'source.bin',
    size: 5,
    authority: 'A'.repeat(43),
    authorityExpiresAt: Date.now() + 60_000,
    channelLabel: 'imcodes-file-upload-0001',
    iceServers: [],
    ...overrides,
  };
}

describe('daemon direct file transfer v2 lease broker', () => {
  let root: string;
  let storedPath: string;
  let sourcePath: string;
  let finalizeDirectUploadedFile: ReturnType<typeof vi.fn>;
  let resolveDirectFileDownloadSource: ReturnType<typeof vi.fn>;
  let directLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(path.join(tmpdir(), 'imcodes-direct-file-v2-'));
    storedPath = path.join(root, 'stored.bin');
    sourcePath = path.join(root, 'source.bin');
    await writeFile(sourcePath, 'download');
    finalizeDirectUploadedFile = vi.fn(async (params: { size: number }) => ({
      id: 'stored-id', source: 'upload', serverId: '', daemonPath: storedPath,
      originalName: 'source.bin', size: params.size, createdAt: new Date().toISOString(), downloadable: true,
    }));
    resolveDirectFileDownloadSource = vi.fn(async (previewHandle: string) => {
      if (previewHandle !== 'preview-handle-0001') throw new Error('not_found');
      return { attachmentId: 'preview-handle-0001', readPath: sourcePath, filename: 'source.bin', size: 8, mime: 'application/octet-stream' };
    });
    directLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.doMock('node-datachannel', () => ({ PeerConnection: FakePeerConnection, initLogger: vi.fn(), cleanup: vi.fn() }));
    vi.doMock('../../src/daemon/file-transfer-handler.js', () => ({
      initFileTransfer: vi.fn(),
      createDirectUploadFilename: () => 'stored.bin',
      resolveUploadPath: () => storedPath,
      lookupAttachmentByClientUploadId: vi.fn(() => undefined),
      tryClaimClientUpload: vi.fn(() => Symbol('claim')),
      releaseClientUploadClaim: vi.fn(),
      finalizeDirectUploadedFile,
      resolveDirectFileDownloadSource,
    }));
    vi.doMock('../../src/util/logger.js', () => ({ default: directLogger }));
  });

  afterEach(async () => {
    vi.doUnmock('node-datachannel');
    vi.doUnmock('../../src/daemon/file-transfer-handler.js');
    vi.doUnmock('../../src/util/logger.js');
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  async function readyLease() {
    const direct = await import('../../src/daemon/direct-file-transfer.js');
    expect(await direct.initializeDirectFileTransfer()).toBe(true);
    const sent: Array<Record<string, unknown>> = [];
    const sender = { send: (message: unknown) => sent.push(message as Record<string, unknown>) };
    await direct.handleDirectFileTransferCommand(leasePrepare(), sender);
    expect(sent).toContainEqual(expect.objectContaining({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED, leaseId, leaseGeneration: 1 }));
    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId, browserTabId, leaseId, leaseGeneration: 1, daemonGeneration: 1,
      requestId, sdp: 'browser-lease-offer',
    }, sender);
    expect(sent).toContainEqual(expect.objectContaining({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER, sdp: 'daemon-lease-answer' }));
    return { direct, sent, sender };
  }

  it('prewarms only a lease, then performs the non-file health diagnostic without authority', async () => {
    const { direct, sent } = await readyLease();
    const health = new FakeDataChannel('imcodes-health-0001');
    FakePeerConnection.latest!.emitDataChannel(health);
    health.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PROBE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId, browserTabId, leaseId, leaseGeneration: 1, daemonGeneration: 1,
      nonce: 'probe-nonce-0001',
    }));
    await vi.waitFor(() => expect(health.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PONG)));
    const pong = JSON.parse(health.sent[0] as string);
    expect(pong).toMatchObject({ nonce: 'probe-nonce-0001', localCandidate: { address: '192.168.1.2' } });
    expect(sent.find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.AUTHORIZED)).toBeUndefined();
    await direct.shutdownDirectFileTransfers();
  });

  it('commits an upload once on a ready lease and exposes it through exact status recovery', async () => {
    const { direct, sent, sender } = await readyLease();
    const authority = uploadPrepare();
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(), authority: authority.authority,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    channel.emit(Buffer.from('hello'));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(), totalBytes: 5,
    }));
    await vi.waitFor(() => expect(finalizeDirectUploadedFile).toHaveBeenCalledTimes(1));
    await expect(readFile(storedPath, 'utf8')).resolves.toBe('hello');
    expect(directLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'direct_file_v2.direct_success', direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD, attempt: 1, bytes: 5, route: 'direct',
      }),
      'Direct file transfer v2 metric',
    );
    const logText = JSON.stringify([
      ...directLogger.info.mock.calls,
      ...directLogger.warn.mock.calls,
      ...directLogger.debug.mock.calls,
    ]);
    expect(logText).not.toContain(leaseId);
    expect(logText).not.toContain(operationId);
    expect(logText).not.toContain(authority.authority);
    expect(logText).not.toContain(sourcePath);
    expect(sent).toContainEqual(expect.objectContaining({ type: DIRECT_FILE_TRANSFER_MSG.TERMINAL, state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED }));

    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
    }, sender);
    expect(sent).toContainEqual(expect.objectContaining({ type: DIRECT_FILE_TRANSFER_MSG.STATUS, state: DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED }));
    await direct.shutdownDirectFileTransfers();
  });

  it('re-prepares an existing live lease at a new daemon generation without stranding its channel or status query', async () => {
    const { direct, sent, sender } = await readyLease();
    const authority = uploadPrepare();
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      authority: authority.authority,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));

    const rebindRequestId = 'rebind-request-0001';
    await direct.handleDirectFileTransferCommand(leasePrepare({ requestId: rebindRequestId, daemonGeneration: 2 }), sender);
    expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      requestId: rebindRequestId,
      daemonGeneration: 2,
    }));

    // The direct channel remains live across the control-link replacement.
    // Its already-authorized data binding stays on generation 1 until it
    // completes, while post-rebind status recovery uses generation 2.
    const reboundBinding = binding({ daemonGeneration: 2 });
    channel.emit(Buffer.from('hello'));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      totalBytes: 5,
    }));
    await vi.waitFor(() => expect(finalizeDirectUploadedFile).toHaveBeenCalledTimes(1));
    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...reboundBinding,
    }, sender);
    expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.STATUS,
      daemonGeneration: 2,
      state: DIRECT_FILE_TRANSFER_OPERATION_STATE.COMMITTED,
    }));
    await direct.shutdownDirectFileTransfers();
  });

  it('streams only the daemon-resolved preview handle after receive credit and waits for browser commit', async () => {
    const { direct, sent, sender } = await readyLease();
    const authority = uploadPrepare({
      ...binding({ direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD, operationId: 'download-op-0001', attemptId: 'download-attempt-0001' }),
      clientDownloadId: 'download-op-0001',
      previewHandle: 'preview-handle-0001',
      channelLabel: 'imcodes-file-download-0001',
    });
    delete (authority as Record<string, unknown>).clientUploadId;
    delete (authority as Record<string, unknown>).filename;
    delete (authority as Record<string, unknown>).size;
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    const downloadBinding = binding({ direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD, operationId: 'download-op-0001', attemptId: 'download-attempt-0001' });
    channel.emit(JSON.stringify({ type: DIRECT_FILE_TRANSFER_DATA_MSG.START, protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION, ...downloadBinding, authority: authority.authority }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    channel.emit(JSON.stringify({ type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT, protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION, ...downloadBinding, creditBytes: 8 }));
    await vi.waitFor(() => expect(channel.sent.some((message) => message instanceof Uint8Array && Buffer.from(message).toString() === 'download')).toBe(true));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.FINISH)));
    channel.emit(JSON.stringify({ type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED, protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION, ...downloadBinding, totalBytes: 8 }));
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ type: DIRECT_FILE_TRANSFER_MSG.TERMINAL, operationId: 'download-op-0001', state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED })));
    expect(resolveDirectFileDownloadSource).toHaveBeenCalledWith('preview-handle-0001');
    await direct.shutdownDirectFileTransfers();
  });

  it('classifies an expired preview handle as refreshable rather than an expired operation authority', async () => {
    resolveDirectFileDownloadSource.mockRejectedValueOnce(new Error('expired'));
    const { direct, sent, sender } = await readyLease();
    const authority = uploadPrepare({
      ...binding({ direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD, operationId: 'expired-download-op', attemptId: 'expired-download-attempt' }),
      clientDownloadId: 'expired-download-op',
      previewHandle: 'expired-preview-handle',
      channelLabel: 'imcodes-file-download-expired',
    });
    delete (authority as Record<string, unknown>).clientUploadId;
    delete (authority as Record<string, unknown>).filename;
    delete (authority as Record<string, unknown>).size;
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    const downloadBinding = binding({
      direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
      operationId: 'expired-download-op',
      attemptId: 'expired-download-attempt',
    });
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      authority: authority.authority,
    }));
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      error: DIRECT_FILE_TRANSFER_ERROR.PREVIEW_HANDLE_INVALID,
      retryable: false,
    })));
    expect(sent).not.toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      error: DIRECT_FILE_TRANSFER_ERROR.AUTHORITY_EXPIRED,
    }));
    await direct.shutdownDirectFileTransfers();
  });
});
