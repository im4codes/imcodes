// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import {
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
} from '../../shared/direct-file-transfer.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

const apiMocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  downloadAttachment: vi.fn(),
  streamAttachmentDownloadToWritable: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  storedPath: '',
  sourcePath: '',
  finalize: vi.fn(),
  resolveSource: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock('../src/api.js', () => apiMocks);
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  initFileTransfer: vi.fn(),
  createDirectUploadFilename: () => 'integrated-upload.bin',
  resolveUploadPath: () => storageMocks.storedPath,
  lookupAttachmentByClientUploadId: storageMocks.lookup,
  tryClaimClientUpload: vi.fn(() => Symbol('claim')),
  releaseClientUploadClaim: vi.fn(),
  finalizeDirectUploadedFile: storageMocks.finalize,
  resolveDirectFileDownloadSource: storageMocks.resolveSource,
}));
vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type LinkHooks = {
  browserSend?: (value: string | ArrayBuffer | ArrayBufferView) => void;
  daemonSend?: (value: string | Uint8Array) => void;
};

let linkHooks: LinkHooks = {};

class IntegratedBrowserDataChannel extends EventTarget {
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = 'connecting';
  node: IntegratedNodeDataChannel | null = null;

  constructor(readonly label: string) { super(); }

  send(value: string | ArrayBuffer | ArrayBufferView): void {
    linkHooks.browserSend?.(value);
    if (typeof value === 'string') this.node?.emitMessage(value);
    else if (ArrayBuffer.isView(value)) this.node?.emitMessage(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    else this.node?.emitMessage(Buffer.from(new Uint8Array(value)));
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  receive(value: string | Uint8Array): void {
    const data = typeof value === 'string'
      ? value
      : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.node?.emitClosed();
    this.dispatchEvent(new Event('close'));
  }
}

class IntegratedNodeDataChannel {
  private messageHandler: ((message: string | Buffer | ArrayBuffer) => void) | null = null;
  private closedHandler: (() => void) | null = null;
  private bufferedLowHandler: (() => void) | null = null;
  browser: IntegratedBrowserDataChannel | null = null;

  constructor(private readonly label: string) {}

  getLabel = () => this.label;
  bufferedAmount = () => 0;
  setBufferedAmountLowThreshold = vi.fn();
  onMessage = (handler: (message: string | Buffer | ArrayBuffer) => void) => { this.messageHandler = handler; };
  onClosed = (handler: () => void) => { this.closedHandler = handler; };
  onError = (_handler: (error: string) => void) => undefined;
  onBufferedAmountLow = (handler: () => void) => { this.bufferedLowHandler = handler; };
  sendMessage = (message: string) => {
    linkHooks.daemonSend?.(message);
    this.browser?.receive(message);
    return true;
  };
  sendMessageBinary = (message: Uint8Array) => {
    const copy = new Uint8Array(message);
    linkHooks.daemonSend?.(copy);
    this.browser?.receive(copy);
    return true;
  };
  close = () => { this.browser?.close(); };
  emitMessage(message: string | Buffer | ArrayBuffer): void { this.messageHandler?.(message); }
  emitClosed(): void { this.closedHandler?.(); }
  releaseBufferedAmount(): void { this.bufferedLowHandler?.(); }
}

class IntegratedNodePeerConnection {
  static latest: IntegratedNodePeerConnection | null = null;
  private dataChannelHandler: ((channel: IntegratedNodeDataChannel) => void) | null = null;
  private localDescriptionHandler: ((sdp: string, type: string) => void) | null = null;

  constructor() { IntegratedNodePeerConnection.latest = this; }
  onDataChannel = (handler: (channel: IntegratedNodeDataChannel) => void) => { this.dataChannelHandler = handler; };
  onLocalDescription = (handler: (sdp: string, type: string) => void) => { this.localDescriptionHandler = handler; };
  onLocalCandidate = (_handler: (candidate: string, mid: string) => void) => undefined;
  onStateChange = (_handler: (state: string) => void) => undefined;
  setRemoteDescription = (_sdp: string, type: string) => {
    if (type === 'offer') this.localDescriptionHandler?.('integrated-daemon-answer', 'answer');
  };
  addRemoteCandidate = vi.fn();
  close = vi.fn();
  rtt = () => 1;
  getSelectedCandidatePair = () => ({
    local: { address: '192.168.10.2', port: 4000, type: 'host', transportType: 'udp' },
    remote: { address: '192.168.10.3', port: 5000, type: 'host', transportType: 'udp' },
  });
  emitDataChannel(channel: IntegratedNodeDataChannel): void { this.dataChannelHandler?.(channel); }
}

class IntegratedBrowserPeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: RTCSessionDescription | null = null;
  private channelCount = 0;

  createDataChannel(label: string): RTCDataChannel {
    this.channelCount++;
    const browser = new IntegratedBrowserDataChannel(label);
    const node = new IntegratedNodeDataChannel(label);
    browser.node = node;
    node.browser = browser;
    IntegratedNodePeerConnection.latest?.emitDataChannel(node);
    queueMicrotask(() => browser.open());
    return browser as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.channelCount === 0) throw new Error('cold offer has no data-channel application section');
    return { type: 'offer', sdp: 'integrated-browser-offer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    this.connectionState = 'connected';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<RTCStatsReport> {
    return new Map([
      ['selected', { type: 'candidate-pair', selected: true, state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { type: 'local-candidate', candidateType: 'host' }],
      ['remote', { type: 'remote-candidate', candidateType: 'host' }],
    ]) as unknown as RTCStatsReport;
  }
  restartIce(): void {}
  close(): void { this.connectionState = 'closed'; }
}

vi.mock('node-datachannel', () => ({
  PeerConnection: IntegratedNodePeerConnection,
  initLogger: vi.fn(),
  cleanup: vi.fn(),
}));

const SERVER_ID = 'integrated-server-1';
const USER_ID = 'integrated-user-1';
const CAPABILITIES = [
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
  DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
];

type DirectModule = typeof import('../../src/daemon/direct-file-transfer.js');
type Router = import('../../server/src/ws/direct-file-transfer-router.js').DirectFileTransferRouter;

type Harness = {
  ws: WsClient;
  controls: Array<Record<string, unknown>>;
  restartServer(): void;
  restartCount(): number;
  direct: DirectModule;
};

async function createHarness(): Promise<Harness> {
  const direct = await import('../../src/daemon/direct-file-transfer.js');
  const { DirectFileTransferRouter } = await import('../../server/src/ws/direct-file-transfer-router.js');
  expect(await direct.initializeDirectFileTransfer()).toBe(true);

  const browserSocket = {} as WebSocket;
  const handlers = new Set<(message: ServerMessage) => void>();
  const capabilityHandlers = new Set<(snapshot: { capabilities: string[] } | null) => void>();
  const controls: Array<Record<string, unknown>> = [];
  let restarts = 0;
  let router: Router;

  const sender = {
    send(message: unknown) {
      router.handleDaemon(message, 1);
    },
  };
  const makeRouter = () => new DirectFileTransferRouter({
    serverId: () => SERVER_ID,
    daemonAvailable: () => true,
    daemonSupportsDirect: () => true,
    daemonGeneration: () => 1,
    resumeTicketSigningKey: () => 'integrated-persistent-resume-ticket-signing-key',
    sendDaemon: (message, generation) => {
      expect(generation).toBe(1);
      void direct.handleDirectFileTransferCommand(message, sender);
      return true;
    },
    sendBrowser: (_socket, message) => {
      controls.push(message);
      for (const handler of handlers) handler(message as ServerMessage);
    },
  });
  router = makeRouter();

  const routeBrowserControl = (message: Record<string, unknown>) => {
    controls.push(message);
    router.handleBrowser(browserSocket, USER_ID, message);
  };
  const ws = {
    getDaemonCapabilitySnapshot: () => ({
      daemonId: 'integrated-daemon-1', capabilities: CAPABILITIES,
      helloEpoch: restarts + 1, sentAt: Date.now(), observedAt: Date.now(),
    }),
    onDaemonCapabilitySnapshot: (handler: (snapshot: { capabilities: string[] } | null) => void) => {
      capabilityHandlers.add(handler);
      return () => capabilityHandlers.delete(handler);
    },
    onMessage: (handler: (message: ServerMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    send: routeBrowserControl,
    sendUrgent: routeBrowserControl,
  } as unknown as WsClient;

  return {
    ws,
    controls,
    direct,
    restartServer() {
      restarts++;
      router = makeRouter();
      for (const handler of capabilityHandlers) handler({ capabilities: CAPABILITIES });
    },
    restartCount: () => restarts,
  };
}

function makeFile(bytes: Uint8Array, name = 'integrated.bin'): File {
  return {
    name,
    type: 'application/octet-stream',
    size: bytes.byteLength,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }),
  } as unknown as File;
}

function messageType(value: string | ArrayBuffer | ArrayBufferView): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return (JSON.parse(value) as { type?: string }).type; } catch { return undefined; }
}

function operationAttempts(controls: Array<Record<string, unknown>>): number[] {
  return controls
    .filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)
    .map((message) => message.attempt as number);
}

function binaryPayloadBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (!value || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + binaryPayloadBytes(entry, seen), 0);
  return Object.values(value as Record<string, unknown>)
    .reduce((sum, entry) => sum + binaryPayloadBytes(entry, seen), 0);
}

describe('browser↔daemon direct file transfer across Server restart', () => {
  let root = '';
  let direct: DirectModule | null = null;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    linkHooks = {};
    IntegratedNodePeerConnection.latest = null;
    vi.stubGlobal('RTCPeerConnection', IntegratedBrowserPeerConnection);
    root = await mkdtemp(path.join(tmpdir(), 'imcodes-direct-integration-'));
    storageMocks.storedPath = path.join(root, 'stored.bin');
    storageMocks.sourcePath = path.join(root, 'source.bin');
    await writeFile(storageMocks.sourcePath, Buffer.from('download-through-restart'));
    storageMocks.lookup.mockReturnValue(undefined);
    storageMocks.finalize.mockImplementation(async (input: { size: number }) => ({
      id: 'integrated-attachment', source: 'upload', serverId: SERVER_ID,
      daemonPath: storageMocks.storedPath, originalName: 'integrated.bin',
      size: input.size, createdAt: '2026-08-21T00:00:00.000Z', downloadable: true,
    }));
    storageMocks.resolveSource.mockImplementation(async () => ({
      attachmentId: 'preview-1', readPath: storageMocks.sourcePath,
      filename: 'source.bin', size: Buffer.byteLength('download-through-restart'),
      mime: 'application/octet-stream',
    }));
    apiMocks.uploadFile.mockRejectedValue(new Error('unexpected HTTP upload fallback'));
    apiMocks.streamAttachmentDownloadToWritable.mockRejectedValue(new Error('unexpected HTTP download fallback'));
  });

  afterEach(async () => {
    await direct?.shutdownDirectFileTransfers();
    direct = null;
    vi.unstubAllGlobals();
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  it('survives restart before ACCEPTED without consuming another attempt', async () => {
    const harness = await createHarness();
    direct = harness.direct;
    let restarted = false;
    linkHooks.browserSend = (value) => {
      if (!restarted && messageType(value) === DIRECT_FILE_TRANSFER_DATA_MSG.START) {
        restarted = true;
        harness.restartServer();
      }
    };
    const bytes = new TextEncoder().encode('restart-before-accepted');
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');

    await expect(uploadFileDirect(harness.ws, makeFile(bytes), crypto.randomUUID(), undefined, undefined, undefined, undefined, SERVER_ID))
      .resolves.toMatchObject({ attachment: { id: 'integrated-attachment' } });

    expect(harness.restartCount()).toBe(1);
    expect(operationAttempts(harness.controls)).toEqual([1]);
    expect(storageMocks.finalize).toHaveBeenCalledOnce();
    expect(await readFile(storageMocks.storedPath)).toEqual(Buffer.from(bytes));
    expect(apiMocks.uploadFile).not.toHaveBeenCalled();
  });

  it('survives a mid-stream restart without duplicate commit or retry-budget loss', async () => {
    const harness = await createHarness();
    direct = harness.direct;
    let binaryChunks = 0;
    linkHooks.browserSend = (value) => {
      if (typeof value !== 'string' && ++binaryChunks === 1) harness.restartServer();
    };
    const bytes = new Uint8Array(2 * 64 * 1024 + 17).map((_, index) => index % 251);
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');

    await expect(uploadFileDirect(harness.ws, makeFile(bytes), crypto.randomUUID(), undefined, undefined, undefined, undefined, SERVER_ID))
      .resolves.toMatchObject({ attachment: { id: 'integrated-attachment' } });

    expect(harness.restartCount()).toBe(1);
    expect(binaryChunks).toBeGreaterThan(1);
    expect(operationAttempts(harness.controls)).toEqual([1]);
    expect(storageMocks.finalize).toHaveBeenCalledOnce();
    expect(await readFile(storageMocks.storedPath)).toEqual(Buffer.from(bytes));
  });

  it('recovers after daemon upload commit before browser acknowledgement without retransmission', async () => {
    const harness = await createHarness();
    direct = harness.direct;
    let restarted = false;
    linkHooks.daemonSend = (value) => {
      if (!restarted && typeof value === 'string' && messageType(value) === DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED) {
        restarted = true;
        harness.restartServer();
      }
    };
    const bytes = new TextEncoder().encode('commit-before-browser-ack');
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');

    await expect(uploadFileDirect(harness.ws, makeFile(bytes), crypto.randomUUID(), undefined, undefined, undefined, undefined, SERVER_ID))
      .resolves.toMatchObject({ attachment: { id: 'integrated-attachment' } });
    await vi.waitFor(() => expect(harness.controls.some((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND)).toBe(true));

    expect(harness.restartCount()).toBe(1);
    expect(operationAttempts(harness.controls)).toEqual([1]);
    expect(storageMocks.finalize).toHaveBeenCalledOnce();
    expect(apiMocks.uploadFile).not.toHaveBeenCalled();
  });

  it('survives restart after writer close and before download commit acknowledgement without re-streaming', async () => {
    const harness = await createHarness();
    direct = harness.direct;
    const written: Uint8Array[] = [];
    const writer = {
      write: vi.fn(async (value: BufferSource) => {
        const bytes = value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        written.push(new Uint8Array(bytes));
      }),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    let restarted = false;
    linkHooks.browserSend = (value) => {
      if (!restarted && messageType(value) === DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED) {
        expect(writer.close).toHaveBeenCalledOnce();
        restarted = true;
        harness.restartServer();
      }
    };
    const { downloadPreviewWithDirectFallback } = await import('../src/direct-file-transfer.js');

    await expect(downloadPreviewWithDirectFallback({
      ws: harness.ws,
      serverId: SERVER_ID,
      previewHandle: 'preview-handle-1',
      destination: { handle: { createWritable: vi.fn().mockResolvedValue(writer) } },
    })).resolves.toBeUndefined();
    await vi.waitFor(() => expect(harness.controls.some((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND)).toBe(true));

    expect(harness.restartCount()).toBe(1);
    expect(operationAttempts(harness.controls)).toEqual([1]);
    expect(storageMocks.resolveSource).toHaveBeenCalledOnce();
    expect(writer.close).toHaveBeenCalledOnce();
    expect(Buffer.concat(written.map((bytes) => Buffer.from(bytes))).toString()).toBe('download-through-restart');
    expect(apiMocks.streamAttachmentDownloadToWritable).not.toHaveBeenCalled();
  });

  it('traces direct payload around Server while HTTP fallback carries payload through its Server boundary', async () => {
    const harness = await createHarness();
    direct = harness.direct;
    let browserToDaemonBytes = 0;
    let daemonToBrowserBytes = 0;
    linkHooks.browserSend = (value) => {
      if (typeof value !== 'string') browserToDaemonBytes += value.byteLength;
    };
    linkHooks.daemonSend = (value) => {
      if (typeof value !== 'string') daemonToBrowserBytes += value.byteLength;
    };
    const uploadBytes = new TextEncoder().encode('direct-upload-payload');
    const directWritten: Uint8Array[] = [];
    const directWriter = {
      write: vi.fn(async (value: BufferSource) => {
        const bytes = value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        directWritten.push(new Uint8Array(bytes));
      }),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const {
      downloadPreviewWithDirectFallback,
      uploadFileDirect,
      uploadFileWithDirectFallback,
    } = await import('../src/direct-file-transfer.js');

    await uploadFileDirect(harness.ws, makeFile(uploadBytes), crypto.randomUUID(), undefined, undefined, undefined, undefined, SERVER_ID);
    await downloadPreviewWithDirectFallback({
      ws: harness.ws,
      serverId: SERVER_ID,
      previewHandle: 'preview-handle-direct-trace',
      destination: { handle: { createWritable: vi.fn().mockResolvedValue(directWriter) } },
    });

    const expectedDownloadBytes = Buffer.byteLength('download-through-restart');
    expect(browserToDaemonBytes).toBe(uploadBytes.byteLength);
    expect(daemonToBrowserBytes).toBe(expectedDownloadBytes);
    expect(binaryPayloadBytes(harness.controls)).toBe(0);
    const stickyControl = harness.controls.filter((message) => typeof message.serverId === 'string');
    expect(stickyControl.length).toBeGreaterThan(0);
    expect(stickyControl.every((message) => message.serverId === SERVER_ID)).toBe(true);
    expect(Buffer.concat(directWritten.map((bytes) => Buffer.from(bytes))).toString()).toBe('download-through-restart');

    let httpServerPayloadBytes = 0;
    apiMocks.uploadFile.mockImplementation(async (_serverId: string, file: File) => {
      httpServerPayloadBytes += file.size;
      return {
        ok: true,
        attachment: {
          id: 'http-upload', source: 'upload', serverId: SERVER_ID,
          daemonPath: '/tmp/http-upload.bin', createdAt: '2026-08-21T00:00:00.000Z', downloadable: true,
        },
      };
    });
    const httpDownloadBytes = new TextEncoder().encode('http-download-payload');
    apiMocks.streamAttachmentDownloadToWritable.mockImplementation(async (
      _serverId: string,
      _previewHandle: string,
      writer: { write(data: BufferSource): Promise<void> },
    ) => {
      httpServerPayloadBytes += httpDownloadBytes.byteLength;
      await writer.write(httpDownloadBytes);
    });
    const noDirectWs = {
      getDaemonCapabilitySnapshot: () => ({
        daemonId: 'integrated-daemon-1', capabilities: [], helloEpoch: 1,
        sentAt: Date.now(), observedAt: Date.now(),
      }),
      onDaemonCapabilitySnapshot: () => () => undefined,
      onMessage: () => () => undefined,
      send: vi.fn(),
    } as unknown as WsClient;
    const httpUploadBytes = new TextEncoder().encode('http-upload-payload');
    await uploadFileWithDirectFallback({
      ws: null,
      serverId: SERVER_ID,
      file: makeFile(httpUploadBytes, 'http-upload.bin'),
    });
    const httpWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    await downloadPreviewWithDirectFallback({
      ws: noDirectWs,
      serverId: SERVER_ID,
      previewHandle: 'preview-handle-http-trace',
      destination: { handle: { createWritable: vi.fn().mockResolvedValue(httpWriter) } },
    });

    expect(httpServerPayloadBytes).toBe(httpUploadBytes.byteLength + httpDownloadBytes.byteLength);
    expect(apiMocks.uploadFile).toHaveBeenCalledOnce();
    expect(apiMocks.streamAttachmentDownloadToWritable).toHaveBeenCalledOnce();
  });
});
