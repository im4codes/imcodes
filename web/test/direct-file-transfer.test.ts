// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_ERROR_SCOPE,
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
} from '../../shared/direct-file-transfer.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

const apiMocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  downloadAttachment: vi.fn(),
  streamAttachmentDownloadToWritable: vi.fn(),
}));

vi.mock('../src/api.js', () => apiMocks);

class FakeDataChannel extends EventTarget {
  constructor(readonly label = '') { super(); }

  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = 'connecting';
  sent: unknown[] = [];
  onSend: ((value: unknown) => void) | null = null;

  send(value: unknown): void {
    this.sent.push(value);
    this.onSend?.(value);
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  static onDataChannel: ((channel: FakeDataChannel, value: unknown) => void) | null = null;
  static selectedCandidateType = 'host';
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  channels: FakeDataChannel[] = [];

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label?: string): RTCDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    channel.onSend = (value) => FakePeerConnection.onDataChannel?.(channel, value);
    queueMicrotask(() => channel.open());
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'browser-lease-offer' };
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
      ['selected-pair', {
        type: 'candidate-pair', selected: true, state: 'succeeded',
        localCandidateId: 'local-candidate', remoteCandidateId: 'remote-candidate',
      }],
      ['local-candidate', { type: 'local-candidate', candidateType: FakePeerConnection.selectedCandidateType }],
      ['remote-candidate', { type: 'remote-candidate', candidateType: 'host' }],
    ]) as unknown as RTCStatsReport;
  }
  restartIce(): void {}
  close(): void { this.connectionState = 'closed'; }
}

const opaque = (char: string) => char.repeat(32);
const id = () => crypto.randomUUID();

function controlBinding(message: Record<string, unknown>) {
  return {
    serverId: message.serverId,
    browserTabId: message.browserTabId,
    leaseId: message.leaseId,
    leaseGeneration: message.leaseGeneration,
    daemonGeneration: message.daemonGeneration,
    requestId: message.requestId,
    attemptId: message.attemptId,
    attempt: message.attempt,
    direction: message.direction,
    operationId: message.operationId,
  };
}

function createWs(
  capabilities: string[],
  mode: 'success' | 'operation_failure' | 'hold' | 'authorized_hold' | 'status_committed' | 'terminal_committed' | 'ack_then_late_terminal' | 'download_hold_rebind' | 'error_after_expiry' = 'success',
  leaseTiming: { readyDelayMs?: number; idleWindowMs?: number; terminalDelayMs?: number; rebindDaemonGeneration?: number } = {},
) {
  const handlers = new Set<(message: ServerMessage) => void>();
  const capabilityHandlers = new Set<(snapshot: { capabilities: string[] } | null) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const emit = (message: Record<string, unknown>) => {
    for (const handler of handlers) handler(message as ServerMessage);
  };
  const completedDownloads = new WeakSet<FakeDataChannel>();
  let leaseInitCount = 0;
  const handleData = (channel: FakeDataChannel, value: unknown) => {
    if (typeof value !== 'string') return;
    const payload = JSON.parse(value) as Record<string, unknown>;
    if (payload.type === DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PROBE) {
      queueMicrotask(() => channel.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          type: DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PONG,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          serverId: payload.serverId,
          browserTabId: payload.browserTabId,
          leaseId: payload.leaseId,
          leaseGeneration: payload.leaseGeneration,
          daemonGeneration: payload.daemonGeneration,
          nonce: payload.nonce,
          rttMs: 1,
          localCandidate: { address: '192.168.1.20', port: 5000, type: 'host', transportType: 'udp' },
          remoteCandidate: { address: '192.168.1.21', port: 5001, type: 'host', transportType: 'udp' },
        }),
      })));
      return;
    }
    if (payload.type === DIRECT_FILE_TRANSFER_DATA_MSG.START) {
      if (mode === 'error_after_expiry') {
        const common = controlBinding(payload);
        setTimeout(() => emit({
          type: DIRECT_FILE_TRANSFER_MSG.ERROR,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
          ...common,
          error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
          retryable: false,
          idleExpiresAt: Date.now() + (leaseTiming.idleWindowMs ?? DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS),
        }), leaseTiming.terminalDelayMs ?? 0);
        return;
      }
      if (mode === 'terminal_committed') {
        const common = controlBinding(payload);
        setTimeout(() => emit({
          type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          ...common,
          state: 'committed',
          idleExpiresAt: Date.now() + (leaseTiming.idleWindowMs ?? DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS),
          attachment: {
            id: 'terminal-committed', source: 'upload', serverId: 'server-1', daemonPath: '/tmp/terminal.txt',
            createdAt: '2026-01-01T00:00:00.000Z', downloadable: true,
          },
        }), leaseTiming.terminalDelayMs ?? 0);
        return;
      }
      if (mode === 'authorized_hold' || mode === 'status_committed') return;
      const common = controlBinding(payload);
      if (payload.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) {
        queueMicrotask(() => channel.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({
            type: DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            ...common,
          }),
        })));
      } else {
        queueMicrotask(() => channel.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({
            type: DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            ...common,
            filename: 'preview.bin',
            size: 3,
          }),
        })));
      }
      return;
    }
    if (payload.type === DIRECT_FILE_TRANSFER_DATA_MSG.FINISH && payload.direction === DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD) {
      const common = controlBinding(payload);
      queueMicrotask(() => channel.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          type: DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          ...common,
          attachment: { id: 'direct-attachment', source: 'upload', serverId: 'server-1', daemonPath: '/tmp/direct.txt', createdAt: '2026-01-01T00:00:00.000Z', downloadable: true },
        }),
      })));
      if (mode === 'ack_then_late_terminal') {
        setTimeout(() => emit({
          type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          ...common,
          state: 'committed',
          idleExpiresAt: Date.now() + (leaseTiming.idleWindowMs ?? DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS),
          attachment: { id: 'direct-attachment', source: 'upload', serverId: 'server-1', daemonPath: '/tmp/direct.txt', createdAt: '2026-01-01T00:00:00.000Z', downloadable: true },
        }), leaseTiming.terminalDelayMs ?? 0);
      }
      return;
    }
    if (payload.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT && payload.direction === DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD) {
      if (mode === 'download_hold_rebind') return;
      if (completedDownloads.has(channel)) return;
      completedDownloads.add(channel);
      const common = controlBinding(payload);
      queueMicrotask(() => channel.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1, 2, 3]) })));
      setTimeout(() => channel.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          ...common,
          totalBytes: 3,
        }),
      })), 0);
    }
  };
  FakePeerConnection.onDataChannel = handleData;
  const ws = {
    getDaemonCapabilitySnapshot: () => ({
      daemonId: 'daemon-1', capabilities, helloEpoch: 1, sentAt: Date.now(), observedAt: Date.now(),
    }),
    onDaemonCapabilitySnapshot: (handler: (snapshot: { capabilities: string[] } | null) => void) => {
      capabilityHandlers.add(handler);
      return () => capabilityHandlers.delete(handler);
    },
    onMessage: (handler: (message: ServerMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    send: (message: Record<string, unknown>) => {
      sent.push(message);
      if (message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT) {
        // The idle deadline is issued at LEASE_INIT, not when the browser
        // receives the delayed READY. This makes the test catch a browser
        // implementation that incorrectly starts a fresh five-minute timer
        // after SDP/ICE negotiation.
        const issuedAt = Date.now();
        const respond = () => emit({
          type: DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          requestId: message.requestId,
          serverId: message.serverId,
          browserTabId: message.browserTabId,
          leaseId: id(),
          leaseGeneration: 1,
          daemonGeneration: 1,
          resumeTicket: `${opaque('r')}.${opaque('s')}.${opaque('t')}`,
          idleExpiresAt: issuedAt + (leaseTiming.idleWindowMs ?? DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS),
          expiresAt: issuedAt + 10 * 60_000,
          iceServers: [],
        });
        if (++leaseInitCount === 1 && leaseTiming.readyDelayMs) setTimeout(respond, leaseTiming.readyDelayMs);
        else queueMicrotask(respond);
      } else if (message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER) {
        queueMicrotask(() => emit({ ...message, type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER, sdp: 'daemon-lease-answer' }));
      } else if (message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND) {
        queueMicrotask(() => emit({
          type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          requestId: message.requestId,
          serverId: message.serverId,
          browserTabId: message.browserTabId,
          leaseId: message.leaseId,
          leaseGeneration: message.leaseGeneration,
          daemonGeneration: leaseTiming.rebindDaemonGeneration ?? 1,
          resumeTicket: `${opaque('u')}.${opaque('v')}.${opaque('w')}`,
          idleExpiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
          expiresAt: Date.now() + 10 * 60_000,
          iceServers: [],
        }));
      } else if (message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY && mode === 'status_committed') {
        queueMicrotask(() => emit({
          type: DIRECT_FILE_TRANSFER_MSG.STATUS,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          ...controlBinding(message),
          state: 'committed',
          idleExpiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
          attachment: {
            id: 'status-committed', source: 'upload', serverId: 'server-1', daemonPath: '/tmp/status.txt',
            createdAt: '2026-01-01T00:00:00.000Z', downloadable: true,
          },
        }));
      } else if (message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT) {
        if (mode === 'operation_failure') {
          queueMicrotask(() => emit({
            type: DIRECT_FILE_TRANSFER_MSG.ERROR,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
            ...controlBinding(message),
            error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
            retryable: true,
          }));
        } else if (mode !== 'hold') {
          queueMicrotask(() => emit({
            ...message,
            type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED,
            authority: opaque('a'),
            authorityExpiresAt: Date.now() + 60_000,
            channelLabel: `imcodes-op-${String(message.operationId)}`,
            iceServers: [],
          }));
        }
      }
    },
  } as unknown as WsClient;
  return {
    ws,
    sent,
    emit,
    emitCapabilitySnapshot: () => {
      for (const handler of capabilityHandlers) handler({ capabilities });
    },
  };
}

const directCapabilities = [
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
  DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
];

describe('direct file transfer v2 browser broker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    FakePeerConnection.instances = [];
    FakePeerConnection.selectedCandidateType = 'host';
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    apiMocks.uploadFile.mockResolvedValue({
      ok: true,
      attachment: { id: 'relay-attachment', serverId: 'server-1', daemonPath: '/tmp/relay.txt' },
    });
  });

  it('uses HTTP relay directly when the v2 upload capabilities are unavailable', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs([]);
    const file = new File(['relay'], 'relay.txt', { type: 'text/plain' });

    await expect(uploadFileWithDirectFallback({ ws, serverId: 'server-1', file })).resolves.toMatchObject({
      attachment: { id: 'relay-attachment' },
    });

    expect(sent).toHaveLength(0);
    expect(apiMocks.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('prewarms one lease-only peer and reuses it for two uploads without authority in SDP/ICE', async () => {
    const { prewarmDirectFileLease, uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);
    const release = prewarmDirectFileLease(ws, 'server-1');
    await vi.waitFor(() => expect(sent.some((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toBe(true));

    const file = (name: string, content: string) => {
      const bytes = new TextEncoder().encode(content);
      return {
        name,
        type: 'text/plain',
        size: bytes.byteLength,
        slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
      } as unknown as File;
    };
    await uploadFileDirect(ws, file('first.txt', 'first'), id(), undefined, undefined, undefined, undefined, 'server-1');
    await uploadFileDirect(ws, file('second.txt', 'second'), id(), undefined, undefined, undefined, undefined, 'server-1');

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toHaveLength(1);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)).toHaveLength(2);
    expect(FakePeerConnection.instances).toHaveLength(1);
    for (const message of sent.filter((entry) => entry.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER || entry.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE)) {
      expect(message).not.toHaveProperty('authority');
      expect(message).not.toHaveProperty('previewHandle');
      expect(message).not.toHaveProperty('sessionName');
    }
    release?.();
  });

  it('streams a direct preview into a File System Access writer without Blob/HTTP fallback', async () => {
    const { downloadPreviewWithDirectFallback, FILE_DOWNLOAD_TRANSPORT_MODE } = await import('../src/direct-file-transfer.js');
    const writer = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
    const destination = { handle: { createWritable: vi.fn().mockResolvedValue(writer) } };
    const { ws } = createWs(directCapabilities);
    const onProgress = vi.fn();
    const onMode = vi.fn();

    await downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'preview-handle-1',
      destination,
      onProgress,
      onMode,
    });

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(onMode).toHaveBeenCalledWith(FILE_DOWNLOAD_TRANSPORT_MODE.CONNECTING);
    expect(onMode).toHaveBeenCalledWith(FILE_DOWNLOAD_TRANSPORT_MODE.DIRECT);
    expect(onProgress).toHaveBeenCalledWith({ loadedBytes: 0, totalBytes: 3 });
    expect(onProgress).toHaveBeenLastCalledWith({ loadedBytes: 3, totalBytes: 3 });
    expect(apiMocks.streamAttachmentDownloadToWritable).not.toHaveBeenCalled();
  });

  it('reports direct exhaustion and HTTP sink progress through the same download callbacks', async () => {
    const { downloadPreviewWithDirectFallback, FILE_DOWNLOAD_TRANSPORT_MODE } = await import('../src/direct-file-transfer.js');
    const writers = Array.from({ length: 4 }, () => ({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    }));
    const destination = { handle: { createWritable: vi.fn().mockImplementation(() => Promise.resolve(writers.shift()!)) } };
    const { ws } = createWs(directCapabilities, 'operation_failure');
    const onProgress = vi.fn();
    const onMode = vi.fn();
    apiMocks.streamAttachmentDownloadToWritable.mockImplementationOnce(async (...args: unknown[]) => {
      const progress = args[5] as ((value: { loadedBytes: number; totalBytes: number | null }) => void) | undefined;
      progress?.({ loadedBytes: 0, totalBytes: 8 });
      progress?.({ loadedBytes: 8, totalBytes: 8 });
    });

    await downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'preview-handle-1',
      destination,
      onProgress,
      onMode,
    });

    expect(destination.handle.createWritable).toHaveBeenCalledTimes(4);
    expect(onMode.mock.calls.map(([mode]) => mode)).toEqual([
      FILE_DOWNLOAD_TRANSPORT_MODE.CONNECTING,
      FILE_DOWNLOAD_TRANSPORT_MODE.FALLING_BACK,
      FILE_DOWNLOAD_TRANSPORT_MODE.HTTP,
    ]);
    expect(onProgress).toHaveBeenLastCalledWith({ loadedBytes: 8, totalBytes: 8 });
    expect(apiMocks.streamAttachmentDownloadToWritable).toHaveBeenCalledOnce();
  });

  it('labels an unobservable native/browser download as handed off without fabricated progress', async () => {
    const { downloadPreviewWithDirectFallback, FILE_DOWNLOAD_TRANSPORT_MODE } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs([]);
    const httpFallback = vi.fn().mockResolvedValue(undefined);
    const onProgress = vi.fn();
    const onMode = vi.fn();

    await downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'preview-handle-1',
      destination: null,
      httpFallback,
      onProgress,
      onMode,
    });

    expect(onMode).toHaveBeenCalledOnce();
    expect(onMode).toHaveBeenCalledWith(FILE_DOWNLOAD_TRANSPORT_MODE.BROWSER);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('classifies daemon preview-handle expiry as the File Browser one-refresh condition', async () => {
    const { DirectFileTransferFailure, isDirectFileTransferStaleHandleError } = await import('../src/direct-file-transfer.js');
    expect(isDirectFileTransferStaleHandleError(new DirectFileTransferFailure(
      DIRECT_FILE_TRANSFER_ERROR.PREVIEW_HANDLE_INVALID,
      false,
    ))).toBe(true);
    expect(isDirectFileTransferStaleHandleError(new DirectFileTransferFailure(
      DIRECT_FILE_TRANSFER_ERROR.CANCELED,
      false,
    ))).toBe(false);
  });

  it('records a redacted relay route when the selected peer pair uses TURN', async () => {
    const { uploadFileDirect, DIRECT_FILE_TRANSFER_CLIENT_METRIC } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs(directCapabilities);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    FakePeerConnection.selectedCandidateType = 'relay';
    const bytes = new TextEncoder().encode('relay');
    const file = {
      name: 'relay.txt', type: 'text/plain', size: bytes.byteLength,
      slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    } as unknown as File;
    try {
      await uploadFileDirect(ws, file, id(), undefined, undefined, undefined, undefined, 'server-1');
      const metrics = debug.mock.calls
        .filter(([prefix]) => prefix === '[direct-file-transfer]')
        .map(([, fields]) => fields as Record<string, unknown>);
      expect(metrics).toContainEqual(expect.objectContaining({
        metric: DIRECT_FILE_TRANSFER_CLIENT_METRIC.DIRECT_SUCCESS,
        direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
        route: 'relay',
      }));
      for (const metric of metrics) {
        expect(metric).not.toHaveProperty('serverId');
        expect(metric).not.toHaveProperty('operationId');
        expect(metric).not.toHaveProperty('authority');
        expect(metric).not.toHaveProperty('path');
      }
    } finally {
      debug.mockRestore();
    }
  });

  it('retries direct transport three times then performs exactly one relay fallback', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'operation_failure');
    const file = new File(['retry'], 'retry.txt', { type: 'text/plain' });

    await expect(uploadFileWithDirectFallback({ ws, serverId: 'server-1', file })).resolves.toMatchObject({
      attachment: { id: 'relay-attachment' },
    });

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)).toHaveLength(3);
    expect(apiMocks.uploadFile).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('rebind recovery settles a committed status without retransmitting START or authority', async () => {
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws, sent, emitCapabilitySnapshot } = createWs(directCapabilities, 'status_committed');
    const pending = uploadFileDirect(
      ws,
      new File(['hold'], 'hold.txt'),
      id(),
      undefined,
      undefined,
      undefined,
      undefined,
      'server-1',
    );
    await vi.waitFor(() => expect(
      FakePeerConnection.instances.at(-1)?.channels.some((channel) => channel.sent.some((value) => (
        typeof value === 'string' && JSON.parse(value).type === DIRECT_FILE_TRANSFER_DATA_MSG.START
      ))),
    ).toBe(true));

    emitCapabilitySnapshot();
    await vi.waitFor(() => expect(sent.some((message) => message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY)).toBe(true));
    const statusQuery = sent.find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY)!;
    expect(statusQuery).not.toHaveProperty('authority');
    await expect(pending).resolves.toMatchObject({ attachment: { id: 'status-committed' } });
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)).toHaveLength(1);
    expect(FakePeerConnection.instances.at(-1)?.channels.filter((channel) => channel.label.startsWith('imcodes-op-'))).toHaveLength(1);
  });


  it('establishes and then reuses an inert v2 lease for explicit diagnostics without file authority', async () => {
    const { probeDirectConnectivity } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);

    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });
    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
    for (const message of sent.filter((entry) => entry.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER || entry.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE)) {
      expect(message).not.toHaveProperty('authority');
      expect(message).not.toHaveProperty('previewHandle');
      expect(message).not.toHaveProperty('sessionName');
    }
  });

  it('tears down an idle prewarm after five minutes and initializes a new lease on the next click', async () => {
    vi.useFakeTimers();
    const { prewarmDirectFileLease, uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);
    const release = prewarmDirectFileLease(ws, 'server-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const bytes = new TextEncoder().encode('after-idle');
    const file = {
      name: 'after-idle.txt', type: 'text/plain', size: bytes.byteLength,
      slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    } as unknown as File;
    const pending = uploadFileDirect(ws, file, id(), undefined, undefined, undefined, undefined, 'server-1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ ok: true });

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(2);
    expect(FakePeerConnection.instances).toHaveLength(2);
    release?.();
  });

  it('uses the server idle deadline from LEASE_INIT even when READY/SDP are delayed', async () => {
    vi.useFakeTimers();
    const { prewarmDirectFileLease, uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'success', {
      readyDelayMs: 4 * 60 * 1000,
      idleWindowMs: 5 * 60 * 1000,
    });
    const release = prewarmDirectFileLease(ws, 'server-1');
    // READY reaches the browser after four minutes, leaving only one minute
    // of server authority. A client-relative timer here would incorrectly
    // keep this lease alive until minute nine.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(60_000);

    const bytes = new TextEncoder().encode('fresh-authority');
    const file = {
      name: 'fresh-authority.txt', type: 'text/plain', size: bytes.byteLength,
      slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    } as unknown as File;
    const pending = uploadFileDirect(ws, file, id(), undefined, undefined, undefined, undefined, 'server-1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ ok: true });

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(2);
    release?.();
  });

  it('retains a reusable peer through a fresh terminal idle deadline after a long active operation', async () => {
    vi.useFakeTimers();
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'terminal_committed', {
      // A short window models the real >5-minute case without allowing the
      // no-progress watchdog to fire during this focused fake-timer test.
      idleWindowMs: 100,
      terminalDelayMs: 101,
    });
    const makeFile = (name: string) => {
      const bytes = new TextEncoder().encode(name);
      return {
        name, type: 'text/plain', size: bytes.byteLength,
        slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
      } as unknown as File;
    };

    const first = uploadFileDirect(ws, makeFile('long.txt'), id(), undefined, undefined, undefined, undefined, 'server-1');
    await vi.advanceTimersByTimeAsync(101);
    await expect(first).resolves.toMatchObject({ attachment: { id: 'terminal-committed' } });

    // The original authority expired at t=100 while the operation was active.
    // The terminal's fresh t=201 deadline must preserve the current lease for
    // this next click rather than clearing it from the initial READY deadline.
    await vi.advanceTimersByTimeAsync(49);
    const second = uploadFileDirect(ws, makeFile('reused.txt'), id(), undefined, undefined, undefined, undefined, 'server-1');
    await vi.advanceTimersByTimeAsync(101);
    await expect(second).resolves.toMatchObject({ attachment: { id: 'terminal-committed' } });

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('keeps the lease alive for a late Server terminal after a data-plane upload ACK', async () => {
    vi.useFakeTimers();
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'ack_then_late_terminal', {
      idleWindowMs: 100,
      terminalDelayMs: 101,
    });
    const makeFile = (name: string) => {
      const bytes = new TextEncoder().encode(name);
      return {
        name, type: 'text/plain', size: bytes.byteLength,
        slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
      } as unknown as File;
    };

    const first = uploadFileDirect(ws, makeFile('ack.txt'), id(), undefined, undefined, undefined, undefined, 'server-1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toMatchObject({ attachment: { id: 'direct-attachment' } });
    // The data-plane ACK has already removed its per-attempt control listener.
    // The grace observer must own the terminal at t=101, after the original
    // authority deadline at t=100.
    await vi.advanceTimersByTimeAsync(101);

    const second = uploadFileDirect(ws, makeFile('reused-after-terminal.txt'), id(), undefined, undefined, undefined, undefined, 'server-1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toMatchObject({ attachment: { id: 'direct-attachment' } });

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('keeps authorized data-plane generation while rebind status uses the new control generation', async () => {
    const { downloadPreviewWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const writer = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
    const destination = { handle: { createWritable: vi.fn().mockResolvedValue(writer) } };
    const { ws, sent, emitCapabilitySnapshot } = createWs(directCapabilities, 'download_hold_rebind', {
      rebindDaemonGeneration: 2,
    });
    const pending = downloadPreviewWithDirectFallback({
      ws, serverId: 'server-1', previewHandle: 'preview-old-generation', destination,
    });
    await vi.waitFor(() => expect(
      FakePeerConnection.instances.at(-1)?.channels.some((channel) => channel.label.startsWith('imcodes-op-') && channel.sent.some((value) => (
        typeof value === 'string' && JSON.parse(value).type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT
      ))),
    ).toBe(true));
    const init = sent.find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)!;
    const channel = FakePeerConnection.instances.at(-1)!.channels.find((candidate) => candidate.label.startsWith('imcodes-op-'))!;

    emitCapabilitySnapshot();
    await vi.waitFor(() => expect(sent.some((message) => message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY)).toBe(true));
    const status = sent.find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY)!;
    expect(status.daemonGeneration).toBe(2);

    // The old daemon peer continues the in-flight channel. A new control
    // generation must not rewrite its authority-bound CREDIT/COMMIT binding.
    channel.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1, 2, 3]) }));
    await vi.waitFor(() => expect(writer.write).toHaveBeenCalledOnce());
    channel.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: DIRECT_FILE_TRANSFER_DATA_MSG.FINISH,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        ...controlBinding(init),
        totalBytes: 3,
      }),
    }));
    await expect(pending).resolves.toBeUndefined();

    const dataMessages = channel.sent
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(dataMessages.filter((message) => message.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT)).toEqual(
      expect.arrayContaining([expect.objectContaining({ daemonGeneration: 1 })]),
    );
    expect(dataMessages).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED,
      daemonGeneration: 1,
    }));
  });

  it('keeps cancellation grace through the original expiry for a late canceled terminal', async () => {
    vi.useFakeTimers();
    const { downloadPreviewWithDirectFallback, uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const writer = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
    const destination = { handle: { createWritable: vi.fn().mockResolvedValue(writer) } };
    const { ws, sent, emit } = createWs(directCapabilities, 'download_hold_rebind', { idleWindowMs: 100 });
    const controller = new AbortController();
    const canceled = downloadPreviewWithDirectFallback({
      ws, serverId: 'server-1', previewHandle: 'cancel-preview', destination, signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(sent.some((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)).toBe(true));
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ code: DIRECT_FILE_TRANSFER_ERROR.CANCELED });
    const cancel = sent.find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.CANCEL)!;
    expect(cancel.daemonGeneration).toBe(1);

    await vi.advanceTimersByTimeAsync(101);
    emit({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      ...controlBinding(cancel),
      state: 'canceled',
      idleExpiresAt: Date.now() + 100,
    });

    const bytes = new TextEncoder().encode('after-cancel');
    const file = {
      name: 'after-cancel.txt', type: 'text/plain', size: bytes.byteLength,
      slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    } as unknown as File;
    const next = uploadFileDirect(ws, file, id(), undefined, undefined, undefined, undefined, 'server-1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toMatchObject({ attachment: { id: 'direct-attachment' } });
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
  });

  it('applies a server operation-error idle deadline before failing the attempt', async () => {
    vi.useFakeTimers();
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'error_after_expiry', {
      idleWindowMs: 100,
      terminalDelayMs: 101,
    });
    const makeFile = (name: string) => {
      const bytes = new TextEncoder().encode(name);
      return {
        name, type: 'text/plain', size: bytes.byteLength,
        slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
      } as unknown as File;
    };

    const first = uploadFileDirect(ws, makeFile('first-error.txt'), id(), undefined, undefined, undefined, undefined, 'server-1');
    // Attach the rejection assertion before advancing fake time: the server error
    // is intentionally delivered by the timer below.
    const firstRejected = expect(first).rejects.toMatchObject({ code: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED });
    await vi.advanceTimersByTimeAsync(101);
    await firstRejected;

    const second = uploadFileDirect(ws, makeFile('reuse-after-error.txt'), id(), undefined, undefined, undefined, undefined, 'server-1');
    const secondRejected = expect(second).rejects.toMatchObject({ code: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED });
    await vi.advanceTimersByTimeAsync(101);
    await secondRejected;
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
  });

});
