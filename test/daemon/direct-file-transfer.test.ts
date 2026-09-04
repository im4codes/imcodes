import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_OPERATION_CHANNEL_PREFIX,
  DIRECT_FILE_TRANSFER_OPERATION_STATE,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_TERMINAL_STATE,
} from '../../shared/direct-file-transfer.js';

class FakeDataChannel {
  private messageHandler: ((message: string | Buffer | ArrayBuffer) => void) | null = null;
  private closedHandler: (() => void) | null = null;
  private errorHandler: ((error: string) => void) | null = null;
  private bufferedAmountLowHandler: (() => void) | null = null;
  bufferedAmountValue = 0;
  sent: Array<string | Uint8Array> = [];
  close = vi.fn(() => this.closedHandler?.());
  isOpen = vi.fn(() => this.close.mock.calls.length === 0);
  sendMessage = vi.fn((message: string) => { this.sent.push(message); return true; });
  sendMessageBinary = vi.fn((message: Uint8Array) => { this.sent.push(message); return true; });
  bufferedAmount = () => this.bufferedAmountValue;
  setBufferedAmountLowThreshold = vi.fn();
  onClosed = (handler: () => void) => { this.closedHandler = handler; };
  onError = (handler: (error: string) => void) => { this.errorHandler = handler; };
  onBufferedAmountLow = (handler: () => void) => { this.bufferedAmountLowHandler = handler; };
  onMessage = (handler: (message: string | Buffer | ArrayBuffer) => void) => { this.messageHandler = handler; };

  constructor(private readonly label: string) {}

  getLabel = () => this.label;
  emit(message: string | Buffer | ArrayBuffer): void { this.messageHandler?.(message); }
  emitError(error: string): void { this.errorHandler?.(error); }
  releaseBufferedAmount(): void {
    this.bufferedAmountValue = 0;
    this.bufferedAmountLowHandler?.();
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;
  static instances: FakePeerConnection[] = [];
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

  constructor() {
    FakePeerConnection.latest = this;
    FakePeerConnection.instances.push(this);
  }

  onDataChannel = (handler: (channel: FakeDataChannel) => void) => { this.dataChannelHandler = handler; };
  onLocalDescription = (handler: (sdp: string, type: string) => void) => { this.localDescriptionHandler = handler; };
  onLocalCandidate = (handler: (candidate: string, mid: string) => void) => { this.localCandidateHandler = handler; };
  onStateChange = (handler: (state: string) => void) => { this.stateHandler = handler; };
  emitDataChannel(channel: FakeDataChannel): void { this.dataChannelHandler?.(channel); }
  emitState(state: string): void { this.stateHandler?.(state); }
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

function downloadPrepare(overrides: Record<string, unknown> = {}) {
  const downloadOperationId = typeof overrides.operationId === 'string' ? overrides.operationId : 'download-operation-0001';
  const downloadAttemptId = typeof overrides.attemptId === 'string' ? overrides.attemptId : 'download-attempt-0001';
  const downloadRequestId = typeof overrides.requestId === 'string' ? overrides.requestId : 'download-request-0001';
  return {
    type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...binding({
      direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
      operationId: downloadOperationId,
      attemptId: downloadAttemptId,
      requestId: downloadRequestId,
    }),
    clientDownloadId: downloadOperationId,
    previewHandle: 'preview-handle-0001',
    authority: 'D'.repeat(43),
    authorityExpiresAt: Date.now() + 60_000,
    channelLabel: `imcodes-file-${downloadAttemptId}`,
    iceServers: [],
    ...overrides,
  };
}

describe('daemon direct file transfer v2 lease broker', () => {
  let root: string;
  let storedPath: string;
  let sourcePath: string;
  let finalizeDirectUploadedFile: ReturnType<typeof vi.fn>;
  let lookupAttachmentByClientUploadId: ReturnType<typeof vi.fn>;
  let resolveDirectFileDownloadSource: ReturnType<typeof vi.fn>;
  let directLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    FakePeerConnection.latest = null;
    FakePeerConnection.instances = [];
    root = await mkdtemp(path.join(tmpdir(), 'imcodes-direct-file-v2-'));
    storedPath = path.join(root, 'stored.bin');
    sourcePath = path.join(root, 'source.bin');
    await writeFile(sourcePath, 'download');
    finalizeDirectUploadedFile = vi.fn(async (params: { size: number }) => ({
      id: 'stored-id', source: 'upload', serverId: '', daemonPath: storedPath,
      originalName: 'source.bin', size: params.size, createdAt: new Date().toISOString(), downloadable: true,
    }));
    lookupAttachmentByClientUploadId = vi.fn(() => undefined);
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
      lookupAttachmentByClientUploadId,
      tryClaimClientUpload: vi.fn(() => Symbol('claim')),
      releaseClientUploadClaim: vi.fn(),
      finalizeDirectUploadedFile,
      resolveDirectFileDownloadSource,
    }));
    vi.doMock('../../src/util/logger.js', () => ({ default: directLogger }));
  });

  afterEach(async () => {
    vi.useRealTimers();
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

  it('retains an operation channel that wins the PREPARE race on a warm peer', async () => {
    const { direct, sender } = await readyLease();
    const authority = uploadPrepare({
      channelLabel: `${DIRECT_FILE_TRANSFER_OPERATION_CHANNEL_PREFIX}${attemptId}`,
    });
    const channel = new FakeDataChannel(authority.channelLabel as string);

    // Browser AUTHORIZED and daemon PREPARE use independent sockets. A warm
    // peer can deliver this channel before the daemon processes PREPARE.
    FakePeerConnection.latest!.emitDataChannel(channel);
    expect(channel.close).not.toHaveBeenCalled();
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      authority: authority.authority,
    }));

    await direct.handleDirectFileTransferCommand(authority, sender);
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    expect(channel.close).not.toHaveBeenCalled();
    await direct.shutdownDirectFileTransfers();
  });

  it('replaces an inactive lease peer for a fresh browser offer and drops stale ICE', async () => {
    const { direct, sent, sender } = await readyLease();
    const previous = FakePeerConnection.latest!;
    const retryRequestId = 'lease-retry-request-0001';

    // A browser may trickle before its offer is delivered. It must be held for
    // that new request rather than added to the old peer.
    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ICE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId, browserTabId, leaseId, leaseGeneration: 1, daemonGeneration: 1,
      requestId: retryRequestId,
      candidate: 'candidate:retry 1 udp 1 192.168.1.10 4000 typ host', mid: '0',
    }, sender);
    expect(previous.addRemoteCandidate).not.toHaveBeenCalled();

    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId, browserTabId, leaseId, leaseGeneration: 1, daemonGeneration: 1,
      requestId: retryRequestId, sdp: 'browser-retry-offer',
    }, sender);

    const replacement = FakePeerConnection.latest!;
    expect(replacement).not.toBe(previous);
    expect(previous.close).toHaveBeenCalledOnce();
    expect(replacement.setRemoteDescription).toHaveBeenCalledWith('browser-retry-offer', 'offer');
    expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER,
      requestId: retryRequestId,
      sdp: 'daemon-lease-answer',
    }));
    expect(replacement.addRemoteCandidate).toHaveBeenCalledWith(
      'candidate:retry 1 udp 1 192.168.1.10 4000 typ host',
      '0',
    );

    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ICE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId, browserTabId, leaseId, leaseGeneration: 1, daemonGeneration: 1,
      requestId,
      candidate: 'candidate:stale 1 udp 1 192.168.1.11 4001 typ host', mid: '0',
    }, sender);
    expect(replacement.addRemoteCandidate).toHaveBeenCalledTimes(1);
    await direct.shutdownDirectFileTransfers();
  });

  /**
   * The upload direction used to give the sender nothing until the transfer was
   * over: UPLOAD_COMMITTED is terminal and carries the finished attachment, and
   * CREDIT was validated for DOWNLOAD only. So a browser sending a large file
   * judged liveness purely from its own bufferedAmount and could not tell a
   * slow-but-committing receiver from a dead one.
   *
   * The daemon now reports its durable offset as it writes. This asserts the
   * daemon HALF of that contract, which the browser suite cannot cover because
   * it drives a fake peer rather than this module.
   */
  it('reports a monotonic committed offset while an upload is still streaming', async () => {
    const { direct, sender } = await readyLease();
    const chunk = DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES;
    const authority = uploadPrepare({ size: chunk * 3 });
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(), authority: authority.authority,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));

    const committedOffsets = () => channel.sent
      .filter((m): m is string => typeof m === 'string')
      .map((m) => { try { return JSON.parse(m) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => !!m
        && m.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT
        && m.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD)
      .map((m) => m.committedBytes as number);

    channel.emit(Buffer.alloc(chunk, 1));
    await vi.waitFor(() => expect(committedOffsets().length).toBeGreaterThanOrEqual(1));
    channel.emit(Buffer.alloc(chunk, 2));
    await vi.waitFor(() => expect(committedOffsets().length).toBeGreaterThanOrEqual(2));

    const offsets = committedOffsets();
    // Reported only after the write resolves, so it is a commit point.
    expect(offsets[0]).toBe(chunk);
    expect(offsets[1]).toBe(chunk * 2);
    // Monotonic, and never ahead of what was actually handed over.
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]!);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(chunk * 3);
  });

  /**
   * C — a transient channel/ICE replacement must cost only the bytes not yet
   * committed, not the whole file and not a fallback to the HTTP relay.
   */
  it('resumes a replacement attempt from the confirmed offset instead of restarting at zero', async () => {
    const { direct, sender } = await readyLease();
    const chunk = DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES;
    const total = chunk * 2;
    const first = uploadPrepare({ size: total });
    await direct.handleDirectFileTransferCommand(first, sender);
    const firstChannel = new FakeDataChannel(first.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(firstChannel);
    firstChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(), authority: first.authority,
    }));
    await vi.waitFor(() => expect(firstChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    firstChannel.emit(Buffer.alloc(chunk, 7));
    await vi.waitFor(() => expect(firstChannel.sent.some((m) => typeof m === 'string' && m.includes('"committedBytes"'))).toBe(true));

    // Transient loss: the channel goes away with half the file committed.
    firstChannel.close();

    const second = uploadPrepare({
      ...binding({ requestId: 'resume-request-2', attemptId: 'resume-attempt-2' }),
      size: total,
      authority: 'R'.repeat(43),
      channelLabel: 'imcodes-file-upload-0002',
    });
    await direct.handleDirectFileTransferCommand(second, sender);
    const secondChannel = new FakeDataChannel(second.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(secondChannel);
    secondChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({ requestId: 'resume-request-2', attemptId: 'resume-attempt-2' }),
      authority: second.authority,
      resumeOffset: chunk,
    }));
    await vi.waitFor(() => expect(secondChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));

    // The replacement must already be credited with the committed prefix.
    const committed = secondChannel.sent
      .filter((m): m is string => typeof m === 'string')
      .map((m) => { try { return JSON.parse(m) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => !!m && m.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT)
      .map((m) => m.committedBytes as number);
    expect(committed[0], 'the resumed attempt must start credited at the confirmed offset, not zero').toBe(chunk);

    // Only the remaining half is sent, and the file still commits intact.
    secondChannel.emit(Buffer.alloc(chunk, 9));
    secondChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({ requestId: 'resume-request-2', attemptId: 'resume-attempt-2' }),
      totalBytes: total,
    }));
    await vi.waitFor(() => expect(secondChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED)));
  });

  it('fails closed on a resume offset that does not match the partial, and keeps the partial', async () => {
    const { direct, sender } = await readyLease();
    const chunk = DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES;
    const total = chunk * 2;
    const first = uploadPrepare({ size: total });
    await direct.handleDirectFileTransferCommand(first, sender);
    const firstChannel = new FakeDataChannel(first.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(firstChannel);
    firstChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(), authority: first.authority,
    }));
    await vi.waitFor(() => expect(firstChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    firstChannel.emit(Buffer.alloc(chunk, 7));
    await vi.waitFor(() => expect(firstChannel.sent.some((m) => typeof m === 'string' && m.includes('"committedBytes"'))).toBe(true));
    firstChannel.close();

    const uploadDir = path.dirname(storedPath);
    const partialsBefore = (await readdir(uploadDir)).filter((e) => e.endsWith('.part'));
    expect(partialsBefore).toHaveLength(1);

    const second = uploadPrepare({
      ...binding({ requestId: 'bad-offset-2', attemptId: 'bad-offset-attempt-2' }),
      size: total,
      authority: 'Q'.repeat(43),
      channelLabel: 'imcodes-file-upload-0003',
    });
    await direct.handleDirectFileTransferCommand(second, sender);
    const secondChannel = new FakeDataChannel(second.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(secondChannel);
    secondChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({ requestId: 'bad-offset-2', attemptId: 'bad-offset-attempt-2' }),
      authority: second.authority,
      // Claims more than was actually committed.
      resumeOffset: chunk + 1,
    }));
    await vi.waitFor(() => expect(secondChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ERROR)));
    expect(secondChannel.sent).not.toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED));

    // A wrong or hostile offset must not be able to destroy data a legitimate
    // sender can still resume from.
    const partialsAfter = (await readdir(uploadDir)).filter((e) => e.endsWith('.part'));
    expect(partialsAfter, 'a mismatched resume must not delete the recoverable partial').toEqual(partialsBefore);
  });

  /**
   * The mirror image of the test above, and the one the size check actually
   * exists for. When the partial is SHORTER than the claimed offset, the
   * re-hash of [0, resumeOffset) runs out of file and fails anyway. When it is
   * LONGER, that fallback reads happily and nothing else notices: the handle is
   * opened 'r+' and is never truncated, so the resumed write would continue on
   * top of a file that still carries bytes past the agreed boundary.
   */
  it('fails closed when the partial is longer than the claimed resume offset', async () => {
    const { direct, sender } = await readyLease();
    const chunk = DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES;
    const total = chunk * 3;
    const first = uploadPrepare({ size: total });
    await direct.handleDirectFileTransferCommand(first, sender);
    const firstChannel = new FakeDataChannel(first.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(firstChannel);
    firstChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(), authority: first.authority,
    }));
    await vi.waitFor(() => expect(firstChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    firstChannel.emit(Buffer.alloc(chunk, 7));
    firstChannel.emit(Buffer.alloc(chunk, 9));
    await vi.waitFor(() => expect(
      firstChannel.sent.filter((m) => typeof m === 'string' && m.includes('"committedBytes"')).length,
    ).toBeGreaterThanOrEqual(2));
    firstChannel.close();

    const uploadDir = path.dirname(storedPath);
    const partialsBefore = (await readdir(uploadDir)).filter((e) => e.endsWith('.part'));
    expect(partialsBefore).toHaveLength(1);

    const second = uploadPrepare({
      ...binding({ requestId: 'long-part-2', attemptId: 'long-part-attempt-2' }),
      size: total,
      authority: 'R'.repeat(43),
      channelLabel: 'imcodes-file-upload-0004',
    });
    await direct.handleDirectFileTransferCommand(second, sender);
    const secondChannel = new FakeDataChannel(second.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(secondChannel);
    secondChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({ requestId: 'long-part-2', attemptId: 'long-part-attempt-2' }),
      authority: second.authority,
      // Two chunks are on disk; this claims only one.
      resumeOffset: chunk,
    }));
    await vi.waitFor(() => expect(secondChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ERROR)));
    expect(
      secondChannel.sent,
      'a resume offset that disagrees with the partial on disk must never be accepted',
    ).not.toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED));

    const partialsAfter = (await readdir(uploadDir)).filter((e) => e.endsWith('.part'));
    expect(partialsAfter, 'the recoverable partial must survive the rejection').toEqual(partialsBefore);
  });

  /**
   * RED — an evicted resume state leaves its partial behind forever.
   *
   * `pruneUploadResumeStates` deletes map entries only; the unlink lives in
   * `discardUploadResumeState`, which is reached exclusively on terminal
   * outcomes. The part path is `randomBytes(16)` and is recorded nowhere but
   * that in-memory map, so once the entry is dropped the file on disk is
   * unattributable and unreachable: a permanent orphan that grows with every
   * abandoned upload.
   */
  async function leavePartial(
    direct: Awaited<ReturnType<typeof readyLease>>['direct'],
    sender: { send: (message: unknown) => void },
    tag: string,
    label: string,
    size: number,
  ): Promise<void> {
    const prepare = uploadPrepare({
      ...binding({ requestId: `${tag}-req`, attemptId: `${tag}-att`, operationId: `${tag}-op` }),
      size,
      authority: tag.padEnd(43, 'z').slice(0, 43),
      channelLabel: label,
      clientUploadId: `${tag}-op`,
    });
    await direct.handleDirectFileTransferCommand(prepare, sender);
    const channel = new FakeDataChannel(label);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({ requestId: `${tag}-req`, attemptId: `${tag}-att`, operationId: `${tag}-op` }),
      authority: prepare.authority,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    channel.emit(Buffer.alloc(DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES, 3));
    await vi.waitFor(() => expect(channel.sent.some((m) => typeof m === 'string' && m.includes('"committedBytes"'))).toBe(true));
    channel.close();
  }

  const partialsOf = async (dir: string) => (await readdir(dir)).filter((e) => e.endsWith('.part'));

  /**
   * How an in-flight attempt loses its transport. All four are RETRYABLE
   * transport loss, so all four must leave both the resume state and the bytes
   * intact — the whole point of resuming is that a dropped connection costs
   * the remaining bytes, not the whole file.
   */
  type Interruption = 'close' | 'channel-error' | 'peer-failed' | 'peer-disconnected';

  /**
   * Triggers the loss AND waits for the daemon to finish acting on it. The
   * unlink happens inside closeTransferResources, which runs after the
   * TERMINAL control frame is sent, so waiting on TERMINAL alone would let a
   * resume race ahead of the discard and pass for the wrong reason.
   */
  async function interrupt(
    channel: FakeDataChannel,
    mode: Interruption,
    sent: Array<Record<string, unknown>>,
  ): Promise<void> {
    const before = sent.filter((m) => m.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL).length;
    if (mode === 'close') channel.close();
    else if (mode === 'channel-error') channel.emitError('ice-transport-failure');
    else FakePeerConnection.latest!.emitState(mode === 'peer-failed' ? 'failed' : 'disconnected');
    await vi.waitFor(() => expect(
      sent.filter((m) => m.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL).length,
    ).toBeGreaterThan(before));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const committedFrom = (channel: FakeDataChannel): number => {
    const frames = channel.sent.filter((m): m is string => typeof m === 'string' && m.includes('"committedBytes"'));
    const last = frames[frames.length - 1];
    return last ? (JSON.parse(last).committedBytes as number) : 0;
  };

  /** Start an upload, deliver one chunk, and return once the receiver has
   *  durably committed it. The channel is left open and unsettled. */
  async function uploadUpToFirstCommit(
    direct: Awaited<ReturnType<typeof readyLease>>['direct'],
    sender: { send: (message: unknown) => void },
    tag: string,
    label: string,
    size: number,
  ): Promise<{ channel: FakeDataChannel; authority: string }> {
    const prepare = uploadPrepare({
      ...binding({ requestId: `${tag}-req`, attemptId: `${tag}-att`, operationId: `${tag}-op` }),
      size,
      authority: tag.padEnd(43, 'z').slice(0, 43),
      channelLabel: label,
      clientUploadId: `${tag}-op`,
    });
    await direct.handleDirectFileTransferCommand(prepare, sender);
    const channel = new FakeDataChannel(label);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({ requestId: `${tag}-req`, attemptId: `${tag}-att`, operationId: `${tag}-op` }),
      authority: prepare.authority,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    channel.emit(Buffer.alloc(DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES, 5));
    await vi.waitFor(() => expect(committedFrom(channel)).toBeGreaterThan(0));
    return { channel, authority: prepare.authority as string };
  }

  /** A replacement attempt for the SAME operation, resuming at `offset`. */
  async function resumeAttempt(
    direct: Awaited<ReturnType<typeof readyLease>>['direct'],
    sender: { send: (message: unknown) => void },
    tag: string,
    label: string,
    size: number,
    offset: number,
  ): Promise<FakeDataChannel> {
    const prepare = uploadPrepare({
      ...binding({ requestId: `${tag}-req2`, attemptId: `${tag}-att2`, operationId: `${tag}-op` }),
      size,
      authority: `${tag}resume`.padEnd(43, 'y').slice(0, 43),
      channelLabel: label,
      clientUploadId: `${tag}-op`,
    });
    await direct.handleDirectFileTransferCommand(prepare, sender);
    const channel = new FakeDataChannel(label);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({ requestId: `${tag}-req2`, attemptId: `${tag}-att2`, operationId: `${tag}-op` }),
      authority: prepare.authority,
      resumeOffset: offset,
    }));
    await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(0));
    return channel;
  }

  /**
   * RED — only a clean `close` preserved the partial. `channel.onError` and
   * every peer state transition call failTransfer WITHOUT the discardPartial
   * argument, so they take the default and destroy exactly the resume state
   * and bytes a replacement attempt needs. The R2 resume evidence never caught
   * this because its only interruption was a clean close.
   */
  it.each<Interruption>(['close', 'channel-error', 'peer-failed', 'peer-disconnected'])(
    'keeps the resume state and the bytes after a retryable transport loss (%s)',
    async (mode) => {
      const { direct, sender, sent } = await readyLease();
      const total = DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES * 4;
      const tag = `loss${mode.replace(/-/g, '')}`;
      const { channel } = await uploadUpToFirstCommit(direct, sender, tag, 'imcodes-file-upload-0301', total);
      const committed = committedFrom(channel);
      expect(committed).toBe(DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES);

      await interrupt(channel, mode, sent);

      // The only assertion that proves BOTH survived: a replacement attempt
      // resuming at the confirmed offset is accepted. A surviving file with a
      // dropped map entry fails here, and so does a dropped file.
      const resumed = await resumeAttempt(direct, sender, tag, 'imcodes-file-upload-0302', total, committed);
      await vi.waitFor(() => expect(resumed.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
      expect(
        resumed.sent,
        'a retryable transport loss must not turn the next attempt into a whole-file restart or a hard failure',
      ).not.toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ERROR));
    },
    60_000,
  );

  /**
   * RED — capacity eviction deletes the map entry BEFORE asking whether the
   * partial is still in use. A live oldest upload therefore keeps its file and
   * loses the only reference that could ever name it again: it can no longer
   * resume, and the file it left behind is an orphan.
   */
  it('never strips a live upload of its resume state under capacity pressure', async () => {
    const { direct, sender, sent } = await readyLease();
    const total = DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES * 4;
    // The oldest entry, and deliberately still live and unsettled.
    const { channel } = await uploadUpToFirstCommit(direct, sender, 'liveoldest', 'imcodes-file-upload-0401', total);
    const committed = committedFrom(channel);
    expect(committed).toBeGreaterThan(0);

    // Push the ledger past capacity so eviction runs and reaches the oldest.
    for (let i = 0; i <= DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY; i++) {
      await leavePartial(direct, sender, `pressureprobe${i}`, `imcodes-file-upload-${String(500 + i).padStart(4, '0')}`, DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES * 2);
    }

    // Now lose the transport the ordinary way and retry.
    await interrupt(channel, 'close', sent);
    const resumed = await resumeAttempt(direct, sender, 'liveoldest', 'imcodes-file-upload-0402', total, committed);
    await vi.waitFor(() => expect(resumed.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    expect(
      resumed.sent,
      'capacity pressure must never evict a live upload out of its own resume state',
    ).not.toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ERROR));
  }, 300_000);


  it('unlinks the partial when its resume state expires, instead of orphaning it', async () => {
    const { direct, sender } = await readyLease();
    const uploadDir = path.dirname(storedPath);
    await leavePartial(direct, sender, 'ttlone', 'imcodes-file-upload-0101', DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES * 4);
    const before = await partialsOf(uploadDir);
    expect(before).toHaveLength(1);

    // Only Date is faked, so vi.waitFor's own timers keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_TTL_MS + 60_000);
    try {
      // Any later upload runs the prune; nothing here depends on a timer.
      await leavePartial(direct, sender, 'ttltwo', 'imcodes-file-upload-0102', DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES * 4);
      const after = await partialsOf(uploadDir);
      expect(
        after,
        'the expired partial is unreachable once its state is gone; leaving it on disk is a permanent orphan',
      ).not.toContain(before[0]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('keeps the number of partials on disk bounded by the resume ledger capacity', async () => {
    const { direct, sender } = await readyLease();
    const uploadDir = path.dirname(storedPath);
    const overflow = DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY + 2;
    for (let i = 0; i < overflow; i++) {
      await leavePartial(direct, sender, `capacityprobe${i}`, `imcodes-file-upload-${String(200 + i).padStart(4, '0')}`, DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES * 2);
    }
    const partials = await partialsOf(uploadDir);
    // The prune runs at the START of an upload, before that upload inserts its
    // own state, so the steady state is capacity + 1 rather than capacity.
    // What matters is that it is BOUNDED: without eviction unlinking the file,
    // every abandoned upload adds one partial that nothing can ever remove.
    expect(
      partials.length,
      'capacity eviction drops the state but never the file, so partials grow without bound',
    ).toBeLessThanOrEqual(DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_CAPACITY + 1);
  }, 180_000);

  it('scavenges partials orphaned by a previous process without touching recoverable or committed files', async () => {
    const { direct } = await readyLease();
    const uploadDir = path.dirname(storedPath);
    const stale = path.join(uploadDir, `${path.basename(storedPath)}.${'a'.repeat(32)}.part`);
    const fresh = path.join(uploadDir, `${path.basename(storedPath)}.${'b'.repeat(32)}.part`);
    const committed = path.join(uploadDir, 'already-committed.bin');
    const foreign = path.join(uploadDir, 'not-ours.part');
    await writeFile(stale, 'stale');
    await writeFile(fresh, 'fresh');
    await writeFile(committed, 'committed');
    await writeFile(foreign, 'foreign');
    const old = Date.now() - DIRECT_FILE_TRANSFER_LIMITS.OPERATION_LEDGER_TTL_MS - 60_000;
    await utimes(stale, old / 1000, old / 1000);
    await utimes(foreign, old / 1000, old / 1000);

    await direct.scavengeOrphanUploadPartials();

    await expect(access(stale), 'a partial older than the resume TTL cannot belong to any live state').rejects.toThrow();
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(access(committed), 'a committed file is not a partial and must never be swept').resolves.toBeUndefined();
    await expect(access(foreign), 'only this daemon\'s own random-suffix partials may be swept').resolves.toBeUndefined();
  }, 60_000);

  it('commits a selected-directory upload once and exposes it through exact status recovery', async () => {
    const { direct, sent, sender } = await readyLease();
    const authority = uploadPrepare({ destinationDirectory: 'C:\\Users\\admin\\Desktop' });
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
    expect(finalizeDirectUploadedFile).toHaveBeenCalledWith(expect.objectContaining({
      destinationDirectory: 'C:\\Users\\admin\\Desktop',
    }));
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

  it('removes promoted staging when selected-directory commit fails', async () => {
    const { direct, sent, sender } = await readyLease();
    finalizeDirectUploadedFile.mockRejectedValueOnce(new Error('destination_exists'));
    const authority = uploadPrepare({ destinationDirectory: 'C:\\Users\\admin\\Desktop' });
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
    channel.emit(Buffer.from('hello'));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      totalBytes: 5,
    }));

    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED,
      error: DIRECT_FILE_TRANSFER_ERROR.WRITE_FAILED,
    })));
    await expect(readFile(storedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await direct.shutdownDirectFileTransfers();
  });

  it('rejects a data START whose exact authority binding differs from the prepared attempt', async () => {
    const { direct, sent, sender } = await readyLease();
    const authority = uploadPrepare();
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({ requestId: 'forged-request-0001' }),
      authority: authority.authority,
    }));

    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      attemptId,
      error: DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY,
      retryable: false,
    })));
    expect(finalizeDirectUploadedFile).not.toHaveBeenCalled();
    await direct.shutdownDirectFileTransfers();
  });

  it('rejects a mismatched declared upload byte count and removes the partial file', async () => {
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
    channel.emit(Buffer.from('hello'));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      totalBytes: 4,
    }));

    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      attemptId,
      error: DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH,
      retryable: false,
    })));
    expect(finalizeDirectUploadedFile).not.toHaveBeenCalled();
    await expect(access(`${storedPath}.${attemptId}.part`)).rejects.toThrow();
    await direct.shutdownDirectFileTransfers();
  });

  it('reuses one ready peer for an upload followed by a preview download', async () => {
    const { direct, sent, sender } = await readyLease();
    const uploadAuthority = uploadPrepare();
    await direct.handleDirectFileTransferCommand(uploadAuthority, sender);
    const uploadChannel = new FakeDataChannel(uploadAuthority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(uploadChannel);
    uploadChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      authority: uploadAuthority.authority,
    }));
    await vi.waitFor(() => expect(uploadChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    uploadChannel.emit(Buffer.from('hello'));
    uploadChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      totalBytes: 5,
    }));
    await vi.waitFor(() => expect(finalizeDirectUploadedFile).toHaveBeenCalledOnce());

    const downloadAuthority = downloadPrepare();
    await direct.handleDirectFileTransferCommand(downloadAuthority, sender);
    const downloadChannel = new FakeDataChannel(downloadAuthority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(downloadChannel);
    const downloadBinding = binding({
      direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
      operationId: downloadAuthority.operationId,
      attemptId: downloadAuthority.attemptId,
      requestId: downloadAuthority.requestId,
    });
    downloadChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      authority: downloadAuthority.authority,
    }));
    await vi.waitFor(() => expect(downloadChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    downloadChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      creditBytes: 8,
    }));
    await vi.waitFor(() => expect(downloadChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.FINISH)));
    downloadChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      totalBytes: 8,
    }));
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      operationId: downloadAuthority.operationId,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED,
    })));

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(resolveDirectFileDownloadSource).toHaveBeenCalledOnce();
    await direct.shutdownDirectFileTransfers();
  });

  it('returns an existing upload result for a duplicate stable operation id without committing again', async () => {
    const { direct, sent, sender } = await readyLease();
    const first = uploadPrepare();
    await direct.handleDirectFileTransferCommand(first, sender);
    const channel = new FakeDataChannel(first.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      authority: first.authority,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    channel.emit(Buffer.from('hello'));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding(),
      totalBytes: 5,
    }));
    await vi.waitFor(() => expect(finalizeDirectUploadedFile).toHaveBeenCalledOnce());

    const existing = await finalizeDirectUploadedFile.mock.results[0]!.value;
    lookupAttachmentByClientUploadId.mockReturnValue(existing);
    const duplicate = uploadPrepare({
      ...binding({ requestId: 'request-duplicate-0002', attemptId: 'attempt-duplicate-0002' }),
      authority: 'B'.repeat(43),
      channelLabel: 'imcodes-file-upload-duplicate-0002',
    });
    await direct.handleDirectFileTransferCommand(duplicate, sender);

    expect(finalizeDirectUploadedFile).toHaveBeenCalledOnce();
    expect(sent.filter((message) => (
      message.type === DIRECT_FILE_TRANSFER_MSG.TERMINAL
      && message.operationId === operationId
      && message.state === DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED
    ))).toHaveLength(2);
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

  it('enforces the shared active-channel quota and rejects an overflow channel', async () => {
    const { direct, sender } = await readyLease();
    for (let index = 0; index < DIRECT_FILE_TRANSFER_LIMITS.MAX_ACTIVE_CHANNELS_PER_LEASE; index += 1) {
      const suffix = String(index + 1).padStart(4, '0');
      const authority = uploadPrepare({
        ...binding({
          requestId: `quota-request-${suffix}`,
          attemptId: `quota-attempt-${suffix}`,
          operationId: `quota-operation-${suffix}`,
        }),
        clientUploadId: `quota-operation-${suffix}`,
        authority: String.fromCharCode(65 + index).repeat(43),
        channelLabel: `imcodes-file-quota-${suffix}`,
      });
      await direct.handleDirectFileTransferCommand(authority, sender);
      const channel = new FakeDataChannel(authority.channelLabel as string);
      FakePeerConnection.latest!.emitDataChannel(channel);
      expect(channel.close).not.toHaveBeenCalled();
    }

    const overflow = uploadPrepare({
      ...binding({
        requestId: 'quota-request-overflow',
        attemptId: 'quota-attempt-overflow',
        operationId: 'quota-operation-overflow',
      }),
      clientUploadId: 'quota-operation-overflow',
      authority: 'Z'.repeat(43),
      channelLabel: 'imcodes-file-quota-overflow',
    });
    await direct.handleDirectFileTransferCommand(overflow, sender);
    const overflowChannel = new FakeDataChannel(overflow.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(overflowChannel);

    expect(overflowChannel.close).toHaveBeenCalledOnce();
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
    expect(channel.sent.some((message) => message instanceof Uint8Array)).toBe(false);
    channel.emit(JSON.stringify({ type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT, protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION, ...downloadBinding, creditBytes: 8 }));
    await vi.waitFor(() => expect(channel.sent.some((message) => message instanceof Uint8Array && Buffer.from(message).toString() === 'download')).toBe(true));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.FINISH)));
    channel.emit(JSON.stringify({ type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED, protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION, ...downloadBinding, totalBytes: 8 }));
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ type: DIRECT_FILE_TRANSFER_MSG.TERMINAL, operationId: 'download-op-0001', state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.COMMITTED })));
    expect(resolveDirectFileDownloadSource).toHaveBeenCalledWith('preview-handle-0001');
    await direct.shutdownDirectFileTransfers();
  });

  it('withholds download bytes while the data-channel buffer is above the shared high-water mark', async () => {
    const { direct, sender } = await readyLease();
    const authority = downloadPrepare({
      operationId: 'slow-download-operation',
      attemptId: 'slow-download-attempt',
      requestId: 'slow-download-request',
    });
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    channel.bufferedAmountValue = DIRECT_FILE_TRANSFER_LIMITS.DOWNLOAD_CHANNEL_BUFFER_HIGH_WATER_BYTES + 1;
    FakePeerConnection.latest!.emitDataChannel(channel);
    const downloadBinding = binding({
      direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
      operationId: authority.operationId,
      attemptId: authority.attemptId,
      requestId: authority.requestId,
    });
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      authority: authority.authority,
    }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      creditBytes: DIRECT_FILE_TRANSFER_LIMITS.DATA_CREDIT_BYTES,
    }));
    await vi.waitFor(() => expect(channel.setBufferedAmountLowThreshold).toHaveBeenCalledWith(
      DIRECT_FILE_TRANSFER_LIMITS.DOWNLOAD_CHANNEL_BUFFER_LOW_WATER_BYTES,
    ));
    expect(channel.sent.some((message) => message instanceof Uint8Array)).toBe(false);

    channel.releaseBufferedAmount();
    await vi.waitFor(() => expect(channel.sent.some((message) => message instanceof Uint8Array)).toBe(true));
    await vi.waitFor(() => expect(channel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.FINISH)));
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      totalBytes: 8,
    }));
    await direct.shutdownDirectFileTransfers();
  });

  it('bounds a saturated download queue while a sibling upload is accepted', async () => {
    const largeDownloadSize = DIRECT_FILE_TRANSFER_LIMITS.DOWNLOAD_CHANNEL_BUFFER_HIGH_WATER_BYTES
      + (DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES * 4);
    await writeFile(sourcePath, Buffer.alloc(largeDownloadSize, 0x44));
    resolveDirectFileDownloadSource.mockResolvedValueOnce({
      attachmentId: 'preview-handle-0001',
      readPath: sourcePath,
      filename: 'source.bin',
      size: largeDownloadSize,
      mime: 'application/octet-stream',
    });
    const { direct, sender } = await readyLease();
    const download = downloadPrepare({
      operationId: 'concurrent-download-operation',
      attemptId: 'concurrent-download-attempt',
      requestId: 'concurrent-download-request',
    });
    await direct.handleDirectFileTransferCommand(download, sender);
    const downloadChannel = new FakeDataChannel(download.channelLabel as string);
    downloadChannel.sendMessageBinary.mockImplementation((message: Uint8Array) => {
      downloadChannel.sent.push(message);
      downloadChannel.bufferedAmountValue += message.byteLength;
      return true;
    });
    FakePeerConnection.latest!.emitDataChannel(downloadChannel);
    const downloadBinding = binding({
      direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
      operationId: download.operationId,
      attemptId: download.attemptId,
      requestId: download.requestId,
    });
    downloadChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      authority: download.authority,
    }));
    await vi.waitFor(() => expect(downloadChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    downloadChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...downloadBinding,
      creditBytes: DIRECT_FILE_TRANSFER_LIMITS.DATA_CREDIT_BYTES,
    }));
    await vi.waitFor(() => expect(downloadChannel.setBufferedAmountLowThreshold).toHaveBeenCalledWith(
      DIRECT_FILE_TRANSFER_LIMITS.DOWNLOAD_CHANNEL_BUFFER_LOW_WATER_BYTES,
    ));

    const queuedDownloadBytes = downloadChannel.sent.reduce(
      (total, message) => total + (message instanceof Uint8Array ? message.byteLength : 0),
      0,
    );
    expect(queuedDownloadBytes).toBeLessThanOrEqual(
      DIRECT_FILE_TRANSFER_LIMITS.DOWNLOAD_CHANNEL_BUFFER_HIGH_WATER_BYTES
        + DIRECT_FILE_TRANSFER_LIMITS.DATA_CHUNK_BYTES,
    );
    expect(queuedDownloadBytes).toBeLessThan(DIRECT_FILE_TRANSFER_LIMITS.DATA_BUFFER_HIGH_WATER_BYTES);

    const upload = uploadPrepare({
      ...binding({
        operationId: 'concurrent-upload-operation',
        attemptId: 'concurrent-upload-attempt',
        requestId: 'concurrent-upload-request',
      }),
      clientUploadId: 'concurrent-upload-operation',
      channelLabel: 'imcodes-file-concurrent-upload',
    });
    await direct.handleDirectFileTransferCommand(upload, sender);
    const uploadChannel = new FakeDataChannel(upload.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(uploadChannel);
    uploadChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({
        operationId: upload.operationId,
        attemptId: upload.attemptId,
        requestId: upload.requestId,
      }),
      authority: upload.authority,
    }));
    await vi.waitFor(() => expect(uploadChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    expect(downloadChannel.bufferedAmountValue).toBeGreaterThan(
      DIRECT_FILE_TRANSFER_LIMITS.DOWNLOAD_CHANNEL_BUFFER_HIGH_WATER_BYTES,
    );

    await direct.shutdownDirectFileTransfers();
  });

  it('fails an inactive attempt at the shared no-progress deadline', async () => {
    vi.useFakeTimers();
    const { direct, sent, sender } = await readyLease();
    const authority = uploadPrepare({
      ...binding({ requestId: 'timeout-request-0001', attemptId: 'timeout-attempt-0001', operationId: 'timeout-operation-0001' }),
      clientUploadId: 'timeout-operation-0001',
      channelLabel: 'imcodes-file-timeout-0001',
    });
    await direct.handleDirectFileTransferCommand(authority, sender);

    await vi.advanceTimersByTimeAsync(DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS);
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      attemptId: 'timeout-attempt-0001',
      error: DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT,
      retryable: true,
    })));
    await direct.shutdownDirectFileTransfers();
  });

  it('restarts the no-progress window when a slow relayed channel finally attaches', async () => {
    // The window is armed at authorization, before any channel exists, so a
    // browser still completing ICE and DTLS was spending it. A relayed path is
    // allowed to take tens of seconds to open; the attempt must not be failed
    // for a stall that has not happened yet.
    vi.useFakeTimers();
    const { direct, sent, sender } = await readyLease();
    const authority = uploadPrepare({
      ...binding({ requestId: 'slow-request-00000001', attemptId: 'slow-attempt-00000001', operationId: 'slow-operation-000001' }),
      clientUploadId: 'slow-operation-000001',
      channelLabel: 'imcodes-file-slowopen-0001',
    });
    await direct.handleDirectFileTransferCommand(authority, sender);

    const beforeAttach = DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS - 5_000;
    await vi.advanceTimersByTimeAsync(beforeAttach);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    await vi.advanceTimersByTimeAsync(0);

    // Past the deadline measured from authorization, but well inside a window
    // measured from the channel arriving.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).not.toContainEqual(expect.objectContaining({
      attemptId: 'slow-attempt-00000001',
      error: DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT,
    }));

    // A channel that then goes quiet is still a stall, and still fails.
    await vi.advanceTimersByTimeAsync(DIRECT_FILE_TRANSFER_LIMITS.NO_PROGRESS_TIMEOUT_MS);
    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      attemptId: 'slow-attempt-00000001',
      error: DIRECT_FILE_TRANSFER_ERROR.NO_PROGRESS_TIMEOUT,
      retryable: true,
    })));
    await direct.shutdownDirectFileTransfers();
  });

  it('cancels atomically, removes the partial file, and ignores late frames from the stale attempt', async () => {
    const { direct, sent, sender } = await readyLease();
    const first = uploadPrepare({
      ...binding({ requestId: 'cancel-request-0001', attemptId: 'cancel-attempt-0001', operationId: 'cancel-operation-0001' }),
      clientUploadId: 'cancel-operation-0001',
      channelLabel: 'imcodes-file-cancel-0001',
    });
    await direct.handleDirectFileTransferCommand(first, sender);
    const firstChannel = new FakeDataChannel(first.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(firstChannel);
    const firstBinding = binding({
      requestId: first.requestId,
      attemptId: first.attemptId,
      operationId: first.operationId,
    });
    firstChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...firstBinding,
      authority: first.authority,
    }));
    await vi.waitFor(() => expect(firstChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));
    // The partial's path is server-generated and deliberately unpredictable —
    // interpolating a client-supplied operationId/attemptId/filename into a
    // path is a traversal and collision surface. So discover it rather than
    // reconstructing it; a test that can guess the name would be asserting the
    // very property we removed.
    const partialsFor = async () => (await readdir(path.dirname(storedPath)))
      .filter((entry) => entry.startsWith(`${path.basename(storedPath)}.`) && entry.endsWith('.part'));
    const partials = await partialsFor();
    expect(partials, 'the in-progress upload must have exactly one partial file').toHaveLength(1);
    const partialPath = path.join(path.dirname(storedPath), partials[0]!);
    await expect(access(partialPath)).resolves.toBeUndefined();
    await direct.handleDirectFileTransferCommand({
      type: DIRECT_FILE_TRANSFER_MSG.CANCEL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...firstBinding,
      authority: first.authority,
      reason: DIRECT_FILE_TRANSFER_ERROR.CANCELED,
    }, sender);
    await expect(access(partialPath)).rejects.toThrow();
    expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      attemptId: first.attemptId,
      error: DIRECT_FILE_TRANSFER_ERROR.CANCELED,
    }));

    const second = uploadPrepare({
      ...binding({ requestId: 'cancel-request-0002', attemptId: 'cancel-attempt-0002', operationId: 'cancel-operation-0001' }),
      clientUploadId: 'cancel-operation-0001',
      authority: 'E'.repeat(43),
      channelLabel: 'imcodes-file-cancel-0002',
    });
    await direct.handleDirectFileTransferCommand(second, sender);
    const secondChannel = new FakeDataChannel(second.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(secondChannel);
    const secondBinding = binding({
      requestId: second.requestId,
      attemptId: second.attemptId,
      operationId: second.operationId,
    });
    secondChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...secondBinding,
      authority: second.authority,
    }));
    await vi.waitFor(() => expect(secondChannel.sent).toContainEqual(expect.stringContaining(DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED)));

    firstChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...firstBinding,
      totalBytes: 0,
    }));
    secondChannel.emit(Buffer.from('hello'));
    secondChannel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...secondBinding,
      totalBytes: 5,
    }));
    await vi.waitFor(() => expect(finalizeDirectUploadedFile).toHaveBeenCalledOnce());
    await expect(readFile(storedPath, 'utf8')).resolves.toBe('hello');
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

  it('maps preview identity or policy rejection to a terminal policy-denied error', async () => {
    resolveDirectFileDownloadSource.mockRejectedValueOnce(new Error('canonical_identity_changed'));
    const { direct, sent, sender } = await readyLease();
    const authority = downloadPrepare({
      operationId: 'policy-download-operation',
      attemptId: 'policy-download-attempt',
      requestId: 'policy-download-request',
      previewHandle: 'policy-preview-handle',
    });
    await direct.handleDirectFileTransferCommand(authority, sender);
    const channel = new FakeDataChannel(authority.channelLabel as string);
    FakePeerConnection.latest!.emitDataChannel(channel);
    channel.emit(JSON.stringify({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...binding({
        direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
        operationId: authority.operationId,
        attemptId: authority.attemptId,
        requestId: authority.requestId,
      }),
      authority: authority.authority,
    }));

    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      error: DIRECT_FILE_TRANSFER_ERROR.PREVIEW_POLICY_DENIED,
      retryable: false,
    })));
    await direct.shutdownDirectFileTransfers();
  });

  it('rejects a browser-supplied source path before resolving a preview handle', async () => {
    const { direct, sender } = await readyLease();
    const malicious = { ...downloadPrepare(), path: '/etc/shadow' };

    await expect(direct.handleDirectFileTransferCommand(malicious, sender)).resolves.toBe(false);
    expect(resolveDirectFileDownloadSource).not.toHaveBeenCalled();
    await direct.shutdownDirectFileTransfers();
  });
});
