// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY,
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

const browserDownloadMocks = vi.hoisted(() => ({
  saveBlobViaDownloadAnchor: vi.fn(),
  shareBlobOrDownload: vi.fn().mockResolvedValue('shared'),
}));

vi.mock('../src/api.js', () => apiMocks);
vi.mock('../src/browser-download.js', () => browserDownloadMocks);

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
  static keepConnectingAfterAnswer = false;
  /** How long a newly created data channel takes to report `open`. */
  static channelOpenDelayMs = 0;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  channels: FakeDataChannel[] = [];
  offerChannelLabels: string[][] = [];

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label?: string): RTCDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    channel.onSend = (value) => FakePeerConnection.onDataChannel?.(channel, value);
    // A LAN channel opens as good as immediately; a relayed one has to finish
    // ICE checks and a DTLS handshake first, which is what the delay models.
    if (FakePeerConnection.channelOpenDelayMs > 0) {
      setTimeout(() => channel.open(), FakePeerConnection.channelOpenDelayMs);
    } else {
      queueMicrotask(() => channel.open());
    }
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offerChannelLabels.push(this.channels.map((channel) => channel.label));
    if (this.channels.length === 0) throw new Error('cold offer has no data-channel application section');
    return { type: 'offer', sdp: 'browser-lease-offer' };
  }

  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    if (!FakePeerConnection.keepConnectingAfterAnswer) {
      this.connectionState = 'connected';
      this.dispatchEvent(new Event('connectionstatechange'));
    }
  }
  addedCandidates: RTCIceCandidateInit[] = [];
  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    if (candidate) this.addedCandidates.push(candidate);
  }
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
  restartIce = vi.fn();
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
  mode: 'success' | 'operation_failure' | 'lease_signal_failure' | 'hold' | 'authorized_hold' | 'status_committed' | 'commit_ack_lost_status_committed' | 'terminal_committed' | 'ack_then_late_terminal' | 'download_hold_rebind' | 'download_size_mismatch' | 'error_after_expiry' | 'drop_first_lease_ready' | 'drop_first_lease_answer' | 'control_socket_closed' = 'success',
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
  let leaseOfferCount = 0;
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
      if (mode === 'commit_ack_lost_status_committed') return;
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
          totalBytes: mode === 'download_size_mismatch' ? 2 : 3,
        }),
      })), 0);
    }
  };
  FakePeerConnection.onDataChannel = handleData;
  let capabilitySnapshot: string[] | null = capabilities;
  const sendControlMessage = (message: Record<string, unknown>) => {
    if (mode === 'control_socket_closed') throw new Error('WebSocket not connected');
    sent.push(message);
    if (message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT) {
        if (++leaseInitCount === 1 && mode === 'drop_first_lease_ready') return;
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
        if (leaseInitCount === 1 && leaseTiming.readyDelayMs) setTimeout(respond, leaseTiming.readyDelayMs);
        else queueMicrotask(respond);
    } else if (message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER) {
        if (++leaseOfferCount === 1 && mode === 'drop_first_lease_answer') return;
        if (mode === 'lease_signal_failure') {
          queueMicrotask(() => emit({
            type: DIRECT_FILE_TRANSFER_MSG.ERROR,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
            requestId: message.requestId,
            error: DIRECT_FILE_TRANSFER_ERROR.STALE_DAEMON_GENERATION,
            retryable: true,
          }));
        } else {
          queueMicrotask(() => emit({ ...message, type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER, sdp: 'daemon-lease-answer' }));
        }
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
    } else if (message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY
      && (mode === 'status_committed' || mode === 'commit_ack_lost_status_committed')) {
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
  };
  const ws = {
    getDaemonCapabilitySnapshot: () => capabilitySnapshot ? ({
      daemonId: 'daemon-1', capabilities: capabilitySnapshot, helloEpoch: 1, sentAt: Date.now(), observedAt: Date.now(),
    }) : null,
    onDaemonCapabilitySnapshot: (handler: (snapshot: { capabilities: string[] } | null) => void) => {
      capabilityHandlers.add(handler);
      handler(capabilitySnapshot ? { capabilities: capabilitySnapshot } : null);
      return () => capabilityHandlers.delete(handler);
    },
    onMessage: (handler: (message: ServerMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    send: vi.fn(),
    sendUrgent: sendControlMessage,
  } as unknown as WsClient;
  return {
    ws,
    sent,
    emit,
    emitCapabilitySnapshot: (snapshot: string[] | null = capabilities) => {
      capabilitySnapshot = snapshot;
      for (const handler of capabilityHandlers) handler(snapshot ? { capabilities: snapshot } : null);
    },
  };
}

const directCapabilities = [
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
  DIRECT_FILE_TRANSFER_PREVIEW_DOWNLOAD_CAPABILITY,
  DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY,
];

function createUploadFile(name: string, content: string): File {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    type: 'text/plain',
    size: bytes.byteLength,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }),
  } as unknown as File;
}

describe('direct file transfer v2 browser broker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    FakePeerConnection.instances = [];
    FakePeerConnection.selectedCandidateType = 'host';
    FakePeerConnection.keepConnectingAfterAnswer = false;
    FakePeerConnection.channelOpenDelayMs = 0;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    apiMocks.uploadFile.mockResolvedValue({
      ok: true,
      attachment: { id: 'relay-attachment', serverId: 'server-1', daemonPath: '/tmp/relay.txt' },
    });
  });

  it('acquires the File System Access destination during the user action and classifies picker cancellation', async () => {
    const { selectPreviewDownloadDestination } = await import('../src/direct-file-transfer.js');
    const handle = { createWritable: vi.fn() };
    const picker = vi.fn().mockResolvedValueOnce(handle);
    vi.stubGlobal('showSaveFilePicker', picker);

    await expect(selectPreviewDownloadDestination('report.pdf')).resolves.toEqual({ handle });
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'report.pdf' });
    expect(FakePeerConnection.instances).toHaveLength(0);

    picker.mockRejectedValueOnce(new DOMException('canceled', 'AbortError'));
    await expect(selectPreviewDownloadDestination('report.pdf')).rejects.toMatchObject({
      code: DIRECT_FILE_TRANSFER_ERROR.CANCELED,
      retryable: false,
    });
    expect(FakePeerConnection.instances).toHaveLength(0);
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

  it('sends a selected destination directory over direct transport only when the daemon advertises it', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);

    await uploadFileWithDirectFallback({
      ws,
      serverId: 'server-1',
      file: createUploadFile('report.txt', 'direct-directory'),
      destinationDirectory: 'C:\\Users\\admin\\Desktop',
    });

    expect(sent).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      destinationDirectory: 'C:\\Users\\admin\\Desktop',
    }));
    expect(apiMocks.uploadFile).not.toHaveBeenCalled();
  });

  it('keeps selected-directory upload on HTTP for a rolling daemon without the optional direct capability', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const legacyCapabilities = directCapabilities.filter(
      (capability) => capability !== DIRECT_FILE_TRANSFER_DIRECTORY_UPLOAD_CAPABILITY,
    );
    const { ws, sent } = createWs(legacyCapabilities);
    const file = createUploadFile('report.txt', 'relay-directory');

    await uploadFileWithDirectFallback({
      ws,
      serverId: 'server-1',
      file,
      destinationDirectory: 'C:\\Users\\admin\\Desktop',
    });

    expect(sent).toHaveLength(0);
    expect(apiMocks.uploadFile).toHaveBeenCalledWith(
      'server-1',
      file,
      undefined,
      expect.any(String),
      undefined,
      undefined,
      'C:\\Users\\admin\\Desktop',
    );
  });

  it('forces one HTTP fallback when direct upload has not connected within 20 seconds', async () => {
    vi.useFakeTimers();
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'hold');
    const modes: string[] = [];
    const upload = uploadFileWithDirectFallback({
      ws,
      serverId: 'server-1',
      file: new File(['relay'], 'relay.txt', { type: 'text/plain' }),
      onMode: (mode) => modes.push(mode),
    });

    await vi.advanceTimersByTimeAsync(DIRECT_FILE_TRANSFER_LIMITS.UPLOAD_DIRECT_CONNECT_FALLBACK_MS - 1);
    expect(apiMocks.uploadFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(upload).resolves.toMatchObject({ attachment: { id: 'relay-attachment' } });
    const directAttempts = sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT);
    expect(directAttempts.length).toBeGreaterThan(0);
    expect(directAttempts.length).toBeLessThanOrEqual(DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS);
    expect(apiMocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(modes).toEqual(['connecting', 'falling_back', 'relay']);
  });

  it('cancels immediately while authority-free lease setup is still pending', async () => {
    vi.useFakeTimers();
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs(directCapabilities, 'success', {
      readyDelayMs: DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS - 1,
    });
    const controller = new AbortController();
    const upload = uploadFileWithDirectFallback({
      ws,
      serverId: 'server-1',
      file: new File(['cancel'], 'cancel.txt', { type: 'text/plain' }),
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(upload).rejects.toMatchObject({ code: DIRECT_FILE_TRANSFER_ERROR.CANCELED });
    expect(apiMocks.uploadFile).not.toHaveBeenCalled();
  });

  it('creates an authority-free data channel before the cold lease offer', async () => {
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs(directCapabilities);
    const file = createUploadFile('direct.txt', 'direct');

    await uploadFileDirect(ws, file, id(), undefined, undefined, undefined, undefined, 'server-1');

    const peer = FakePeerConnection.instances.at(-1)!;
    expect(peer.offerChannelLabels).toHaveLength(1);
    expect(peer.offerChannelLabels[0]).toHaveLength(1);
    expect(peer.offerChannelLabels[0]?.[0]).toMatch(/^imcodes-health-/);
    expect(peer.offerChannelLabels[0]?.some((label) => label.startsWith('imcodes-op-'))).toBe(false);
    expect(peer.channels.some((channel) => channel.label.startsWith('imcodes-op-'))).toBe(true);
  });

  it('retries lease initialization when the first READY is lost after daemon preparation', async () => {
    vi.useFakeTimers();
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'drop_first_lease_ready');
    const upload = uploadFileDirect(ws, createUploadFile('retry.txt', 'retry'), id(), undefined, undefined, undefined, undefined, 'server-1');

    await vi.advanceTimersByTimeAsync(
      DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS + DIRECT_FILE_TRANSFER_LIMITS.RETRY_BACKOFF_MS[0] + 1_000,
    );

    await expect(upload).resolves.toMatchObject({ attachment: { id: 'direct-attachment' } });
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(2);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toHaveLength(1);
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

  it('opens a relayed data channel that needs longer than the signalling budget', async () => {
    // A phone on a carrier network reaches the daemon through TURN. The
    // allocation, permission, connectivity checks and DTLS handshake routinely
    // outlast the eight seconds a signalling round trip needs, and reusing that
    // budget here is what made every relayed transfer time out while the same
    // build worked on a LAN.
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    FakePeerConnection.channelOpenDelayMs = 12_000;
    expect(FakePeerConnection.channelOpenDelayMs)
      .toBeGreaterThan(DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS);
    expect(FakePeerConnection.channelOpenDelayMs)
      .toBeLessThan(DIRECT_FILE_TRANSFER_LIMITS.CHANNEL_OPEN_TIMEOUT_MS);

    vi.useFakeTimers();
    try {
      const { ws } = createWs(directCapabilities);
      const bytes = new TextEncoder().encode('relayed');
      const file = {
        name: 'relayed.txt',
        type: 'text/plain',
        size: bytes.byteLength,
        slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
      } as unknown as File;

      const upload = uploadFileDirect(ws, file, id(), undefined, undefined, undefined, undefined, 'server-1');
      const settled = vi.fn();
      void upload.then(() => settled('resolved'), () => settled('rejected'));

      await vi.advanceTimersByTimeAsync(DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS + 500);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(FakePeerConnection.channelOpenDelayMs);
      await expect(upload).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a data channel as soon as the peer reports failed, without spending the open budget', async () => {
    // The long open budget is only affordable because a path that cannot work
    // says so immediately. If this wait ignored the peer state it would hold
    // every doomed transfer for the full window before a retry or HTTP was
    // allowed, which is why the assertion is about how soon the next attempt
    // begins rather than about the upload's eventual outcome.
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    FakePeerConnection.channelOpenDelayMs = 10 * DIRECT_FILE_TRANSFER_LIMITS.CHANNEL_OPEN_TIMEOUT_MS;

    vi.useFakeTimers();
    try {
      const { ws } = createWs(directCapabilities);
      const bytes = new TextEncoder().encode('doomed');
      const file = {
        name: 'doomed.txt',
        type: 'text/plain',
        size: bytes.byteLength,
        slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
      } as unknown as File;

      const upload = uploadFileDirect(ws, file, id(), undefined, undefined, undefined, undefined, 'server-1');
      // Nothing here awaits the upload itself: with every channel held shut it
      // only settles after the whole retry budget, which is not what is
      // under test. Swallow it so the rejection is not unhandled.
      upload.catch(() => undefined);

      // vi.waitFor cannot be used here: it polls on real time while the clock
      // driving this flow is fake, so it would starve rather than wait.
      for (let tick = 0; tick < 200; tick++) {
        if ((FakePeerConnection.instances.at(-1)?.channels.length ?? 0) > 1) break;
        await vi.advanceTimersByTimeAsync(10);
      }
      const peer = FakePeerConnection.instances.at(-1)!;
      expect(peer.channels.length).toBeGreaterThan(1);
      const channelsBefore = FakePeerConnection.instances
        .reduce((total, instance) => total + instance.channels.length, 0);

      peer.connectionState = 'failed';
      peer.dispatchEvent(new Event('connectionstatechange'));

      // Well inside the open budget the attempt must already have been given
      // up and the next one begun — a retry reuses the peer with an ICE
      // restart, so the observable is a freshly allocated channel.
      await vi.advanceTimersByTimeAsync(DIRECT_FILE_TRANSFER_LIMITS.NEGOTIATION_TIMEOUT_MS);
      const channelsAfter = FakePeerConnection.instances
        .reduce((total, instance) => total + instance.channels.length, 0);
      expect(channelsAfter).toBeGreaterThan(channelsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a daemon ICE candidate that arrives after the answer', async () => {
    // Host candidates come from local interfaces and arrive with the answer; a
    // server-reflexive candidate costs a STUN round trip and a relay candidate
    // a TURN allocation, so both land later. Dropping them left the remote peer
    // holding nothing but private addresses, which a LAN can route and a phone
    // cannot — the connection then failed with no visible cause.
    const { prewarmDirectFileLease } = await import('../src/direct-file-transfer.js');
    const { ws, sent, emit } = createWs(directCapabilities);
    const release = prewarmDirectFileLease(ws, 'server-1');

    await vi.waitFor(() => expect(sent.some((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toBe(true));
    const offer = sent.find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)!;
    // The answer must already be applied: this pins what happens *after* it.
    await vi.waitFor(() => expect(FakePeerConnection.instances.at(-1)?.remoteDescription).toBeTruthy());

    const relay = 'candidate:11 1 UDP 1046015 43.248.99.95 49201 typ relay raddr 0.0.0.0 rport 0';
    emit({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ICE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: offer.serverId,
      browserTabId: offer.browserTabId,
      leaseId: offer.leaseId,
      leaseGeneration: offer.leaseGeneration,
      daemonGeneration: offer.daemonGeneration,
      requestId: offer.requestId,
      candidate: relay,
      mid: '0',
    });

    await vi.waitFor(() => expect(FakePeerConnection.instances.at(-1)!.addedCandidates)
      .toContainEqual(expect.objectContaining({ candidate: relay })));

    // And it must survive an operation. Every transfer waits on its own control
    // messages; if that shared wait tore the ICE subscription down, the daemon's
    // late candidates would start being dropped again from the first upload on
    // — which is precisely the state this fix exists to prevent.
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    const bytes = new TextEncoder().encode('after');
    await uploadFileDirect(ws, {
      name: 'after.txt',
      type: 'text/plain',
      size: bytes.byteLength,
      slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    } as unknown as File, id(), undefined, undefined, undefined, undefined, 'server-1');

    const srflx = 'candidate:10 1 UDP 1678767871 124.90.108.198 55944 typ srflx raddr 0.0.0.0 rport 0';
    emit({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ICE,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: offer.serverId,
      browserTabId: offer.browserTabId,
      leaseId: offer.leaseId,
      leaseGeneration: offer.leaseGeneration,
      daemonGeneration: offer.daemonGeneration,
      requestId: offer.requestId,
      candidate: srflx,
      mid: '0',
    });
    await vi.waitFor(() => expect(FakePeerConnection.instances.at(-1)!.addedCandidates)
      .toContainEqual(expect.objectContaining({ candidate: srflx })));
    release?.();
  });

  it('reuses one lease peer for an upload followed by a preview download', async () => {
    const { uploadFileDirect, downloadPreviewWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);
    const uploadBytes = new TextEncoder().encode('upload');
    const file = {
      name: 'upload.txt',
      type: 'text/plain',
      size: uploadBytes.byteLength,
      slice: (start: number, end: number) => ({ arrayBuffer: async () => uploadBytes.slice(start, end).buffer }),
    } as unknown as File;
    await uploadFileDirect(ws, file, id(), undefined, undefined, undefined, undefined, 'server-1');

    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    await downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'preview-handle-1',
      destination: { handle: { createWritable: vi.fn().mockResolvedValue(writer) } },
    });

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toHaveLength(1);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)).toHaveLength(2);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(writer.close).toHaveBeenCalledOnce();
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

  it('waits for a slow writer before replenishing credit or committing a finished download', async () => {
    const { downloadPreviewWithDirectFallback } = await import('../src/direct-file-transfer.js');
    let resolveWrite!: () => void;
    const writeSettled = new Promise<void>((resolve) => { resolveWrite = resolve; });
    const writer = {
      write: vi.fn(() => writeSettled),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const { ws } = createWs(directCapabilities);
    vi.stubGlobal('Blob', class BlobForbidden {
      constructor() { throw new Error('direct download must not construct a Blob'); }
    });

    const pending = downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'slow-preview-handle',
      destination: { handle: { createWritable: vi.fn().mockResolvedValue(writer) } },
    });
    await vi.waitFor(() => expect(writer.write).toHaveBeenCalledOnce());
    const channel = FakePeerConnection.instances.at(-1)!.channels.find((candidate) => candidate.label.startsWith('imcodes-op-'))!;
    const messagesBeforeWrite = channel.sent
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(messagesBeforeWrite.filter((message) => message.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT)).toHaveLength(1);
    expect(messagesBeforeWrite).not.toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED,
    }));
    expect(writer.close).not.toHaveBeenCalled();

    resolveWrite();
    await expect(pending).resolves.toBeUndefined();
    const messagesAfterWrite = channel.sent
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(messagesAfterWrite.filter((message) => message.type === DIRECT_FILE_TRANSFER_DATA_MSG.CREDIT)).toHaveLength(2);
    expect(messagesAfterWrite).toContainEqual(expect.objectContaining({
      type: DIRECT_FILE_TRANSFER_DATA_MSG.DOWNLOAD_COMMITTED,
      totalBytes: 3,
    }));
    expect(writer.close).toHaveBeenCalledOnce();
  });

  it('rejects a download whose FINISH byte count differs from accepted and written bytes', async () => {
    const { downloadPreviewWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const { ws } = createWs(directCapabilities, 'download_size_mismatch');

    await expect(downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'mismatched-preview',
      destination: { handle: { createWritable: vi.fn().mockResolvedValue(writer) } },
    })).rejects.toMatchObject({ code: DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH, retryable: false });

    expect(writer.write).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledOnce();
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
    const { ws, sent } = createWs([]);
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
    expect(sent).toHaveLength(0);
  });

  it('downloads through P2P inside the native WebView before opening save or share', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    const { downloadPreviewWithDirectFallback, FILE_DOWNLOAD_TRANSPORT_MODE } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);
    const onProgress = vi.fn();
    const onMode = vi.fn();
    const httpFallback = vi.fn();

    await downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'preview-handle-1',
      suggestedName: 'mobile-report.pdf',
      destination: null,
      httpFallback,
      onProgress,
      onMode,
    });

    expect(onMode.mock.calls.map(([mode]) => mode)).toEqual([
      FILE_DOWNLOAD_TRANSPORT_MODE.CONNECTING,
      FILE_DOWNLOAD_TRANSPORT_MODE.DIRECT,
    ]);
    expect(onProgress).toHaveBeenCalledWith({ loadedBytes: 0, totalBytes: 3 });
    expect(onProgress).toHaveBeenLastCalledWith({ loadedBytes: 3, totalBytes: 3 });
    expect(browserDownloadMocks.shareBlobOrDownload).toHaveBeenCalledOnce();
    const [blob, fileName] = browserDownloadMocks.shareBlobOrDownload.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(3);
    expect(fileName).toBe('mobile-report.pdf');
    expect(apiMocks.streamAttachmentDownloadToWritable).not.toHaveBeenCalled();
    expect(apiMocks.downloadAttachment).not.toHaveBeenCalled();
    expect(httpFallback).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT }));
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('falls back from mobile P2P to HTTP before opening save or share', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    apiMocks.streamAttachmentDownloadToWritable.mockImplementationOnce(async (...args: unknown[]) => {
      const writable = args[2] as { write(data: BufferSource): Promise<void> };
      const progress = args[5] as ((value: { loadedBytes: number; totalBytes: number | null }) => void) | undefined;
      progress?.({ loadedBytes: 0, totalBytes: 4 });
      await writable.write(new Uint8Array([4, 5, 6, 7]));
      progress?.({ loadedBytes: 4, totalBytes: 4 });
    });
    const { downloadPreviewWithDirectFallback, FILE_DOWNLOAD_TRANSPORT_MODE } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs(directCapabilities, 'operation_failure');
    const onMode = vi.fn();

    await downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'preview-handle-1',
      suggestedName: 'mobile-fallback.pdf',
      destination: null,
      onMode,
    });

    expect(onMode.mock.calls.map(([mode]) => mode)).toEqual([
      FILE_DOWNLOAD_TRANSPORT_MODE.CONNECTING,
      FILE_DOWNLOAD_TRANSPORT_MODE.FALLING_BACK,
      FILE_DOWNLOAD_TRANSPORT_MODE.HTTP,
    ]);
    expect(apiMocks.streamAttachmentDownloadToWritable).toHaveBeenCalledOnce();
    expect(browserDownloadMocks.shareBlobOrDownload).toHaveBeenCalledOnce();
    const [blob, fileName] = browserDownloadMocks.shareBlobOrDownload.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(4);
    expect(fileName).toBe('mobile-fallback.pdf');
  });

  it('keeps completed native P2P bytes for a fresh save tap when automatic sharing loses activation', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    browserDownloadMocks.shareBlobOrDownload
      .mockRejectedValueOnce(new DOMException('gesture expired', 'NotAllowedError'))
      .mockResolvedValueOnce('shared');
    const { downloadPreviewWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs(directCapabilities);
    let save: (() => Promise<void>) | undefined;

    await expect(downloadPreviewWithDirectFallback({
      ws,
      serverId: 'server-1',
      previewHandle: 'preview-handle-1',
      suggestedName: 'mobile-report.pdf',
      destination: null,
      onSaveReady: (action) => { save = action; },
    })).resolves.toBeUndefined();

    expect(save).toBeTypeOf('function');
    await expect(save!()).resolves.toBeUndefined();
    expect(browserDownloadMocks.shareBlobOrDownload).toHaveBeenCalledTimes(2);
    expect(browserDownloadMocks.shareBlobOrDownload.mock.calls[1]?.[1]).toBe('mobile-report.pdf');
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
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    try {
      await expect(uploadFileWithDirectFallback({ ws, serverId: 'server-1', file })).resolves.toMatchObject({
        attachment: { id: 'relay-attachment' },
      });

      expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)).toHaveLength(3);
      expect(apiMocks.uploadFile).toHaveBeenCalledTimes(1);
      const delays = timeout.mock.calls.map((call) => call[1]);
      expect(delays).toContain(DIRECT_FILE_TRANSFER_LIMITS.RETRY_BACKOFF_MS[0]);
      expect(delays).toContain(DIRECT_FILE_TRANSFER_LIMITS.RETRY_BACKOFF_MS[1]);
    } finally {
      random.mockRestore();
      timeout.mockRestore();
    }
  }, 10_000);

  it('falls back once after three retryable lease-signal races instead of multiplying lease retries', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'lease_signal_failure');
    const file = new File(['retry'], 'retry.txt', { type: 'text/plain' });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await expect(uploadFileWithDirectFallback({ ws, serverId: 'server-1', file })).resolves.toMatchObject({
        attachment: { id: 'relay-attachment' },
      });
      // The first direct attempt initializes the lease. Each of the three
      // bounded transport attempts offers against that same matching lease;
      // after the shared budget the normal HTTP upload is invoked exactly once.
      expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
      expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toHaveLength(3);
      expect(apiMocks.uploadFile).toHaveBeenCalledTimes(1);
    } finally {
      random.mockRestore();
    }
  }, 10_000);

  it('isolates daemon scopes and disposes released peers at the authoritative idle deadline', async () => {
    vi.useFakeTimers();
    const { prewarmDirectFileLease } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);
    const releaseA = prewarmDirectFileLease(ws, 'server-a');
    const releaseB = prewarmDirectFileLease(ws, 'server-b');
    await vi.advanceTimersByTimeAsync(0);

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(2);
    expect(FakePeerConnection.instances).toHaveLength(2);
    releaseA?.();
    releaseB?.();
    await vi.advanceTimersByTimeAsync(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS);
    expect(FakePeerConnection.instances.every((peer) => peer.connectionState === 'closed')).toBe(true);
  });

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

  it('holds upload progress below 100 and recovers a lost commit ACK before HTTP retransmission', async () => {
    vi.useFakeTimers();
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities, 'commit_ack_lost_status_committed');
    const progress: number[] = [];

    const pending = uploadFileWithDirectFallback({
      ws,
      serverId: 'server-1',
      file: createUploadFile('commit-recovery.txt', 'already durable'),
      onProgress: (value) => progress.push(value),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(progress).toContain(99));
    expect(progress).not.toContain(100);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DIRECT_FILE_TRANSFER_LIMITS.STATUS_RECOVERY_DEADLINE_MS);
    await expect(pending).resolves.toMatchObject({ attachment: { id: 'status-committed' } });

    expect(progress.at(-1)).toBe(100);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY)).toHaveLength(1);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT)).toHaveLength(1);
    expect(apiMocks.uploadFile).not.toHaveBeenCalled();
  });


  it('establishes and then reuses an inert v2 lease for explicit diagnostics without file authority', async () => {
    const { probeDirectConnectivity } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);

    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });
    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });

    // Normal WsClient.send is deliberately a silent no-op while foreground
    // liveness is being probed. Direct request/response control must use the
    // open-socket throwing path instead, or LEASE_INIT disappears at stage 1.
    expect(ws.send).not.toHaveBeenCalled();
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
    for (const message of sent.filter((entry) => entry.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER || entry.type === DIRECT_FILE_TRANSFER_MSG.LEASE_ICE)) {
      expect(message).not.toHaveProperty('authority');
      expect(message).not.toHaveProperty('previewHandle');
      expect(message).not.toHaveProperty('sessionName');
    }
  });

  it('invalidates an unanswered LEASE_INIT on socket loss and immediately starts fresh after reconnect', async () => {
    const { probeDirectConnectivity, DirectFileTransferFailure } = await import('../src/direct-file-transfer.js');
    const { ws, sent, emitCapabilitySnapshot } = createWs(directCapabilities, 'drop_first_lease_ready');

    const stale = probeDirectConnectivity(ws, undefined, 'server-1');
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
    });

    emitCapabilitySnapshot(null);
    // Reconnect and retry before the stale promise's rejection/finally
    // microtasks run. This pins the ownership-slot race that previously let an
    // old finally erase the new creating promise.
    emitCapabilitySnapshot(directCapabilities);
    const fresh = probeDirectConnectivity(ws, undefined, 'server-1');
    await expect(stale).rejects.toEqual(expect.objectContaining({
      name: DirectFileTransferFailure.name,
      code: DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED,
      retryable: true,
    }));

    await expect(fresh).resolves.toMatchObject({ route: 'lan_direct' });
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(2);
  });

  it('invalidates an unanswered lease SDP exchange instead of retaining peerCreating across reconnect', async () => {
    const { probeDirectConnectivity } = await import('../src/direct-file-transfer.js');
    const { ws, sent, emitCapabilitySnapshot } = createWs(directCapabilities, 'drop_first_lease_answer');

    const stale = probeDirectConnectivity(ws, undefined, 'server-1');
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toHaveLength(1);
    });

    emitCapabilitySnapshot(null);
    emitCapabilitySnapshot(directCapabilities);
    const fresh = probeDirectConnectivity(ws, undefined, 'server-1');
    await expect(stale).rejects.toMatchObject({
      code: DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED,
      retryable: true,
    });

    await expect(fresh).resolves.toMatchObject({ route: 'lan_direct' });
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(2);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toHaveLength(2);
    expect(FakePeerConnection.instances.at(0)?.connectionState).toBe('closed');
  });

  it('replaces an established idle lease peer after daemon generation replacement', async () => {
    const { probeDirectConnectivity } = await import('../src/direct-file-transfer.js');
    const { ws, sent, emitCapabilitySnapshot } = createWs(directCapabilities);

    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });
    const stalePeer = FakePeerConnection.instances.at(-1)!;

    // WsClient emits this null snapshot on daemon.disconnected/reconnected even
    // though the browser↔Server socket itself remains open during an upgrade.
    emitCapabilitySnapshot(null);
    expect(stalePeer.connectionState).toBe('closed');

    emitCapabilitySnapshot(directCapabilities);
    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });

    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(2);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toHaveLength(2);
    expect(FakePeerConnection.instances.at(-1)).not.toBe(stalePeer);
  });

  it('falls back to HTTP when the control socket is absent instead of silently waiting for direct timeouts', async () => {
    vi.useFakeTimers();
    const { uploadFileWithDirectFallback, FILE_UPLOAD_TRANSPORT_MODE } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs(directCapabilities, 'control_socket_closed');
    const modes: string[] = [];

    const pending = uploadFileWithDirectFallback({
      ws,
      serverId: 'server-1',
      file: createUploadFile('socket-closed.txt', 'relay me'),
      onMode: (mode) => modes.push(mode),
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toMatchObject({ attachment: { id: 'relay-attachment' } });
    expect(modes).toEqual(expect.arrayContaining([
      FILE_UPLOAD_TRANSPORT_MODE.CONNECTING,
      FILE_UPLOAD_TRANSPORT_MODE.FALLING_BACK,
      FILE_UPLOAD_TRANSPORT_MODE.RELAY,
    ]));
    expect(apiMocks.uploadFile).toHaveBeenCalledOnce();
  });

  it('ICE-restarts a disconnected long-lived mobile peer instead of reusing its dead channel path', async () => {
    const { probeDirectConnectivity } = await import('../src/direct-file-transfer.js');
    const { ws, sent } = createWs(directCapabilities);

    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });
    const peer = FakePeerConnection.instances.at(-1)!;
    peer.connectionState = 'disconnected';
    peer.dispatchEvent(new Event('connectionstatechange'));

    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });

    expect(peer.restartIce).toHaveBeenCalledOnce();
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER)).toHaveLength(2);
    expect(sent.filter((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT)).toHaveLength(1);
  });

  it('does not misreport a lagging peer connection state as an unavailable runtime', async () => {
    const { probeDirectConnectivity } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs(directCapabilities);
    FakePeerConnection.keepConnectingAfterAnswer = true;

    await expect(probeDirectConnectivity(ws, undefined, 'server-1')).resolves.toMatchObject({ route: 'lan_direct' });
    expect(FakePeerConnection.instances.at(-1)?.connectionState).toBe('new');
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
