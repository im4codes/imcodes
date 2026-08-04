import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DIRECT_CONNECTIVITY_RUNTIME_STATE,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PURPOSE,
} from '../../shared/direct-file-transfer.js';

class FakeDataChannel {
  private messageHandler: ((message: string | Buffer | ArrayBuffer) => void) | null = null;
  private closedHandler: (() => void) | null = null;
  private errorHandler: ((error: string) => void) | null = null;
  sent: Array<string | Uint8Array> = [];
  close = vi.fn();
  sendMessage = vi.fn((message: string) => { this.sent.push(message); return true; });
  sendMessageBinary = vi.fn((message: Uint8Array) => { this.sent.push(message); return true; });
  isOpen = () => true;
  bufferedAmount = () => 0;
  maxMessageSize = () => 65_536;
  setBufferedAmountLowThreshold = vi.fn();
  onOpen = vi.fn();
  onClosed = (handler: () => void) => { this.closedHandler = handler; };
  onError = (handler: (error: string) => void) => { this.errorHandler = handler; };
  onBufferedAmountLow = vi.fn();
  onMessage = (handler: (message: string | Buffer | ArrayBuffer) => void) => { this.messageHandler = handler; };
  getLabel = () => 'imcodes-file-upload';
  getId = () => 1;
  getProtocol = () => '';

  emit(message: string | Buffer | ArrayBuffer): void { this.messageHandler?.(message); }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;
  private dataChannelHandler: ((channel: FakeDataChannel) => void) | null = null;
  private localDescriptionHandler: ((sdp: string, type: string) => void) | null = null;
  private localCandidateHandler: ((candidate: string, mid: string) => void) | null = null;
  private stateHandler: ((state: string) => void) | null = null;
  close = vi.fn();

  constructor() { FakePeerConnection.latest = this; }
  setRemoteDescription = vi.fn((_sdp: string, type: string) => {
    if (type === 'offer') this.localDescriptionHandler?.('daemon-answer', 'answer');
  });
  addRemoteCandidate = vi.fn();
  rtt = vi.fn(() => 1.4);
  getSelectedCandidatePair = vi.fn(() => ({
    local: { address: '192.168.2.145', port: 49153, type: 'host', transportType: 'udp' },
    remote: { address: '192.168.2.59', port: 59074, type: 'prflx', transportType: 'udp' },
  }));
  onDataChannel = (handler: (channel: FakeDataChannel) => void) => { this.dataChannelHandler = handler; };
  onLocalDescription = (handler: (sdp: string, type: string) => void) => { this.localDescriptionHandler = handler; };
  onLocalCandidate = (handler: (candidate: string, mid: string) => void) => { this.localCandidateHandler = handler; };
  onStateChange = (handler: (state: string) => void) => { this.stateHandler = handler; };
  onIceStateChange = vi.fn();
  onSignalingStateChange = vi.fn();
  onGatheringStateChange = vi.fn();
  emitDataChannel(channel: FakeDataChannel): void { this.dataChannelHandler?.(channel); }
}

describe('daemon direct file transfer', () => {
  let root: string;
  let finalPath: string;
  let finalizeDirectUploadedFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(path.join(tmpdir(), 'imcodes-direct-upload-'));
    finalPath = path.join(root, 'stored.bin');
    finalizeDirectUploadedFile = vi.fn(async (params: { size: number }) => ({
      id: 'stored.bin',
      source: 'upload',
      serverId: '',
      daemonPath: finalPath,
      originalName: 'source.bin',
      size: params.size,
      createdAt: new Date().toISOString(),
      downloadable: true,
    }));
    vi.doMock('node-datachannel', () => ({
      PeerConnection: FakePeerConnection,
      initLogger: vi.fn(),
      cleanup: vi.fn(),
    }));
    vi.doMock('../../src/daemon/file-transfer-handler.js', () => ({
      initFileTransfer: vi.fn(),
      createDirectUploadFilename: () => 'stored.bin',
      resolveUploadPath: () => finalPath,
      lookupAttachmentByClientUploadId: () => undefined,
      tryClaimClientUpload: () => Symbol('claim'),
      releaseClientUploadClaim: vi.fn(),
      finalizeDirectUploadedFile,
    }));
    vi.doMock('../../src/util/logger.js', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
  });

  afterEach(async () => {
    vi.doUnmock('node-datachannel');
    vi.doUnmock('../../src/daemon/file-transfer-handler.js');
    vi.doUnmock('../../src/util/logger.js');
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  it('answers signaling, streams chunks to a part file, and commits exactly once', async () => {
    const direct = await import('../../src/daemon/direct-file-transfer.js');
    expect(await direct.initializeDirectFileTransfer()).toBe(true);
    const sent: Array<Record<string, unknown>> = [];
    const sender = { send: (message: unknown) => sent.push(message as Record<string, unknown>) };
    const authority = {
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      clientUploadId: '123e4567-e89b-12d3-a456-426614174001',
      filename: 'source.bin',
      size: 5,
      capability: 'A'.repeat(43),
      expiresAt: Date.now() + 60_000,
      iceServers: [],
    } as const;
    await direct.handleDirectFileTransferCommand(authority, sender);
    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.ICE,
      requestId: authority.requestId,
      capability: authority.capability,
      candidate: 'candidate-before-offer',
      mid: '0',
    }, sender);
    expect(FakePeerConnection.latest!.addRemoteCandidate).not.toHaveBeenCalled();
    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.OFFER,
      requestId: authority.requestId,
      capability: authority.capability,
      sdp: 'browser-offer',
    }, sender);
    expect(sent).toContainEqual(expect.objectContaining({ type: DIRECT_FILE_TRANSFER_MSG.ANSWER, sdp: 'daemon-answer' }));
    expect(FakePeerConnection.latest!.addRemoteCandidate).toHaveBeenCalledWith('candidate-before-offer', '0');

    const channel = new FakeDataChannel();
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: 1,
      requestId: authority.requestId,
      clientUploadId: authority.clientUploadId,
      filename: authority.filename,
      size: authority.size,
      capability: authority.capability,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    channel.emit(Buffer.from('hello'));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      requestId: authority.requestId,
      totalBytes: 5,
    }));

    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.DONE,
      clientUploadId: authority.clientUploadId,
    })));
    await expect(readFile(finalPath, 'utf8')).resolves.toBe('hello');
    expect(finalizeDirectUploadedFile).toHaveBeenCalledTimes(1);
    await direct.shutdownDirectFileTransfers();
  });

  it('rejects a data-channel start whose metadata does not match the server authority', async () => {
    const direct = await import('../../src/daemon/direct-file-transfer.js');
    await direct.initializeDirectFileTransfer();
    const sent: Array<Record<string, unknown>> = [];
    const sender = { send: (message: unknown) => sent.push(message as Record<string, unknown>) };
    const authority = {
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      requestId: '123e4567-e89b-12d3-a456-426614174010',
      clientUploadId: '123e4567-e89b-12d3-a456-426614174011',
      filename: 'source.bin',
      size: 5,
      capability: 'B'.repeat(43),
      expiresAt: Date.now() + 60_000,
      iceServers: [],
    } as const;
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel();
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: 1,
      requestId: authority.requestId,
      clientUploadId: authority.clientUploadId,
      filename: authority.filename,
      size: 6,
      capability: authority.capability,
    }));
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      error: 'invalid_authority',
      retryable: false,
    })));
    expect(finalizeDirectUploadedFile).not.toHaveBeenCalled();
    await direct.shutdownDirectFileTransfers();
  });

  it('rejects a checksum mismatch and removes the partial upload', async () => {
    const direct = await import('../../src/daemon/direct-file-transfer.js');
    await direct.initializeDirectFileTransfer();
    const sent: Array<Record<string, unknown>> = [];
    const sender = { send: (message: unknown) => sent.push(message as Record<string, unknown>) };
    const authority = {
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      requestId: '123e4567-e89b-12d3-a456-426614174020',
      clientUploadId: '123e4567-e89b-12d3-a456-426614174021',
      filename: 'source.bin',
      size: 5,
      sha256: '0'.repeat(64),
      capability: 'C'.repeat(43),
      expiresAt: Date.now() + 60_000,
      iceServers: [],
    } as const;
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel();
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: 1,
      requestId: authority.requestId,
      clientUploadId: authority.clientUploadId,
      filename: authority.filename,
      size: authority.size,
      sha256: authority.sha256,
      capability: authority.capability,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    channel.emit(Buffer.from('hello'));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      requestId: authority.requestId,
      totalBytes: 5,
    }));

    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      error: 'checksum_mismatch',
      retryable: false,
    })));
    expect(finalizeDirectUploadedFile).not.toHaveBeenCalled();
    await expect(access(finalPath)).rejects.toThrow();
    await direct.shutdownDirectFileTransfers();
  });

  it('answers an authenticated probe without creating a file or attachment', async () => {
    const direct = await import('../../src/daemon/direct-file-transfer.js');
    await direct.initializeDirectFileTransfer();
    const sent: Array<Record<string, unknown>> = [];
    const sender = { send: (message: unknown) => sent.push(message as Record<string, unknown>) };
    const authority = {
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      purpose: DIRECT_FILE_TRANSFER_PURPOSE.PROBE,
      requestId: '123e4567-e89b-12d3-a456-426614174030',
      clientUploadId: '123e4567-e89b-12d3-a456-426614174031',
      filename: 'connectivity-probe',
      size: 0,
      capability: 'D'.repeat(43),
      expiresAt: Date.now() + 60_000,
      iceServers: [],
    } as const;
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel();
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.PROBE,
      protocolVersion: 1,
      requestId: authority.requestId,
      capability: authority.capability,
      nonce: 'probe-nonce-12345678',
    }));

    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.PONG)));
    const pong = JSON.parse(channel.sent.find((value) => typeof value === 'string') as string) as Record<string, unknown>;
    expect(pong).toMatchObject({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.PONG,
      nonce: 'probe-nonce-12345678',
      rttMs: 1.4,
      localCandidate: { address: '192.168.2.145', type: 'host' },
      remoteCandidate: { address: '192.168.2.59', type: 'prflx' },
    });
    expect(finalizeDirectUploadedFile).not.toHaveBeenCalled();
    await expect(access(finalPath)).rejects.toThrow();
    await direct.shutdownDirectFileTransfers();
  });

  it('fails closed when the optional native dependency is unavailable', async () => {
    vi.resetModules();
    vi.doMock('node-datachannel', () => { throw new Error('native addon unavailable'); });
    const direct = await import('../../src/daemon/direct-file-transfer.js');
    await expect(direct.initializeDirectFileTransfer()).resolves.toBe(false);
    expect(direct.isDirectFileTransferAvailable()).toBe(false);
    expect(direct.getDirectConnectivityRuntimeStatus()).toMatchObject({
      state: DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE,
    });
  });
});
