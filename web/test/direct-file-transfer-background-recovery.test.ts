// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_LEASE_CAPABILITY,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY,
} from '@shared/direct-file-transfer.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

const { mockFallbackUploadFile } = vi.hoisted(() => ({
  mockFallbackUploadFile: vi.fn(),
}));

vi.mock('../src/api.js', () => ({
  uploadFile: (...args: unknown[]) => mockFallbackUploadFile(...args),
}));

vi.mock('../src/r2-relay-preference.js', () => ({
  isFileRelaySelected: () => false,
  isServerR2RelayEnabled: () => false,
  readFileRelayMode: () => 'auto',
  setFileRelayUser: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  registerPlugin: () => ({ start: async () => ({ started: false }), stop: async () => {} }),
}));

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly label: string;
  readonly sent: unknown[] = [];
  onSend?: (value: unknown) => void;
  constructor(label: string) {
    super();
    this.label = label;
  }
  send(value: unknown): void {
    this.sent.push(value);
    this.onSend?.(value);
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  readonly index: number;
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  channels: FakeDataChannel[] = [];
  closed = false;
  onDataChannelSend?: (channel: FakeDataChannel, value: unknown, peerIndex: number) => void;

  constructor() {
    super();
    this.index = FakePeerConnection.instances.length;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string): RTCDataChannel {
    const channel = new FakeDataChannel(label);
    channel.onSend = (value) => this.onDataChannelSend?.(channel, value, this.index);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: `offer-${this.index}` };
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc as RTCSessionDescription;
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc as RTCSessionDescription;
    this.connectionState = 'connected';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<RTCStatsReport> {
    return new Map([
      ['pair', { type: 'candidate-pair', selected: true, state: 'succeeded', localCandidateId: 'lc', remoteCandidateId: 'rc' }],
      ['lc', { type: 'local-candidate', candidateType: 'host' }],
      ['rc', { type: 'remote-candidate', candidateType: 'host' }],
    ]) as unknown as RTCStatsReport;
  }
  restartIce = vi.fn();
  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

const CAPS = [DIRECT_FILE_TRANSFER_LEASE_CAPABILITY, DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY];
const opaque = (ch: string) => ch.repeat(32);

function setDocumentVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function createMockWs(options: {
  freezePeerIndexes?: Set<number>;
  freezeBeforeAcceptedPeerIndexes?: Set<number>;
  stallAllOffers?: boolean;
  onFinishAttempt?: (peerIndex: number, channel: FakeDataChannel, msg: Record<string, unknown>) => boolean;
} = {}) {
  const messageHandlers = new Set<(m: ServerMessage) => void>();
  const capabilityHandlers = new Set<(snap: { capabilities: string[] } | null) => void>();
  let snapshot: { capabilities: string[] } | null = { capabilities: CAPS };

  const emitMessage = (msg: Record<string, unknown>) => {
    for (const h of messageHandlers) h(msg as ServerMessage);
  };

  const emitCapabilitySnapshot = (next: { capabilities: string[] } | null) => {
    snapshot = next;
    for (const h of capabilityHandlers) h(next);
  };

  const handleData = (channel: FakeDataChannel, value: unknown, peerIndex: number) => {
    if (typeof value !== 'string') return;
    const msg = JSON.parse(value) as Record<string, unknown>;
    if (msg.type === DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PROBE) {
      queueMicrotask(() => {
        channel.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({
            type: DIRECT_FILE_TRANSFER_DATA_MSG.HEALTH_PONG,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            serverId: msg.serverId,
            browserTabId: msg.browserTabId,
            leaseId: msg.leaseId,
            leaseGeneration: msg.leaseGeneration,
            daemonGeneration: msg.daemonGeneration,
            nonce: msg.nonce,
            rttMs: 1,
          }),
        }));
      });
      return;
    }

    const common = {
      serverId: msg.serverId,
      browserTabId: msg.browserTabId,
      leaseId: msg.leaseId,
      leaseGeneration: msg.leaseGeneration,
      daemonGeneration: msg.daemonGeneration,
      requestId: msg.requestId,
      attemptId: msg.attemptId,
      attempt: msg.attempt,
      direction: msg.direction,
      operationId: msg.operationId,
    };

    if (msg.type === DIRECT_FILE_TRANSFER_DATA_MSG.START) {
      if (options.freezeBeforeAcceptedPeerIndexes?.has(peerIndex)) {
        return;
      }
      queueMicrotask(() => {
        channel.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({
            type: DIRECT_FILE_TRANSFER_DATA_MSG.ACCEPTED,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            ...common,
          }),
        }));
      });
      return;
    }

    if (msg.type === DIRECT_FILE_TRANSFER_DATA_MSG.FINISH) {
      if (options.freezePeerIndexes?.has(peerIndex)) {
        return;
      }
      if (options.onFinishAttempt?.(peerIndex, channel, msg)) {
        return;
      }
      queueMicrotask(() => {
        channel.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({
            type: DIRECT_FILE_TRANSFER_DATA_MSG.UPLOAD_COMMITTED,
            protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
            ...common,
            attachment: {
              id: opaque('b'),
              source: 'upload',
              serverId: msg.serverId,
              daemonPath: '/tmp/direct-recovered.bin',
              originalName: 'direct.bin',
              size: 16,
              createdAt: '2026-11-15T00:00:00.000Z',
              downloadable: true,
            },
          }),
        }));
      });
    }
  };

  FakePeerConnection.prototype.createDataChannel = function (label: string) {
    const channel = new FakeDataChannel(label);
    channel.onSend = (value) => handleData(channel, value, this.index);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  };

  const ws = {
    connected: true,
    onMessage: (h: (m: ServerMessage) => void) => {
      messageHandlers.add(h);
      return () => messageHandlers.delete(h);
    },
    onDaemonCapabilitySnapshot: (h: (s: { capabilities: string[] } | null) => void) => {
      capabilityHandlers.add(h);
      h(snapshot);
      return () => capabilityHandlers.delete(h);
    },
    getDaemonCapabilitySnapshot: () => snapshot,
    targetsServer: () => true,
    send: vi.fn(),
    sendUrgent: (raw: Record<string, unknown>) => {
      if (raw.type === DIRECT_FILE_TRANSFER_MSG.LEASE_INIT) {
        queueMicrotask(() => emitMessage({
          type: DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          requestId: raw.requestId,
          serverId: raw.serverId,
          browserTabId: raw.browserTabId,
          leaseId: crypto.randomUUID(),
          leaseGeneration: 1,
          daemonGeneration: 1,
          resumeTicket: `${opaque('r')}.${opaque('s')}.${opaque('t')}`,
          idleExpiresAt: Date.now() + 60_000,
          expiresAt: Date.now() + 300_000,
          iceServers: [],
        }));
      } else if (raw.type === DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND) {
        queueMicrotask(() => emitMessage({
          type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND,
          protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
          requestId: raw.requestId,
          serverId: raw.serverId,
          browserTabId: raw.browserTabId,
          leaseId: raw.leaseId,
          leaseGeneration: raw.leaseGeneration ?? 1,
          daemonGeneration: raw.daemonGeneration ?? 1,
          resumeTicket: `${opaque('r')}.${opaque('s')}.${opaque('t')}`,
          idleExpiresAt: Date.now() + 60_000,
          expiresAt: Date.now() + 300_000,
          iceServers: [],
        }));
      } else if (raw.type === DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER) {
        if (options.stallAllOffers) {
          return;
        }
        queueMicrotask(() => emitMessage({
          ...raw,
          type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER,
          sdp: 'daemon-lease-answer',
        }));
      } else if (raw.type === DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT) {
        queueMicrotask(() => emitMessage({
          ...raw,
          type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED,
          authority: opaque('a'),
          authorityExpiresAt: Date.now() + 60_000,
          channelLabel: `imcodes-op-${String(raw.operationId)}`,
          iceServers: [],
        }));
      }
    },
  } as unknown as WsClient;

  return { ws, emitCapabilitySnapshot };
}

function createTestUploadFile(name: string, size = 16): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i & 0xff;
  return {
    name,
    size: bytes.byteLength,
    type: 'application/octet-stream',
    lastModified: 1,
    slice: (start = 0, end = bytes.byteLength) => {
      const part = bytes.slice(start, end);
      return {
        arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
      } as Blob;
    },
  } as unknown as File;
}

describe('direct-file-transfer zombie peer recovery & iOS delayed errors', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    FakePeerConnection.instances = [];
    mockFallbackUploadFile.mockReset();
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    setDocumentVisibility('visible');
    const lifecycle = await import('../src/upload-suspend-wait.js');
    lifecycle.resetUploadLifecycleForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setDocumentVisibility('visible');
  });

  it('closes frozen post-FINISH active peer on invalidateLeaseControl + resumeDirectFileTransfers and recovers on a fresh peer', async () => {
    const { uploadFileDirect, resumeDirectFileTransfers } = await import('../src/direct-file-transfer.js');
    const { ws, emitCapabilitySnapshot } = createMockWs({ freezePeerIndexes: new Set([0]) });
    const file = createTestUploadFile('direct.bin', 16);

    const uploadPromise = uploadFileDirect(
      ws,
      file,
      'upl-zombie-1',
      undefined,
      undefined,
      undefined,
      'deck_sub_1',
      'srv-1',
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(FakePeerConnection.instances).toHaveLength(1);
    const deadPeer = FakePeerConnection.instances[0];
    expect(deadPeer.connectionState).toBe('connected');

    // Simulate mobile resume: capability drop + restore (increments controlEpoch while active.size > 0)
    // followed by resumeDirectFileTransfers waking active attempts.
    emitCapabilitySnapshot(null);
    emitCapabilitySnapshot({ capabilities: CAPS });
    resumeDirectFileTransfers(ws, 'srv-1');

    // Post-FINISH triggers STATUS_QUERY with STATUS_RECOVERY_DEADLINE_MS (15s) before failing & closing deadPeer.
    await vi.advanceTimersByTimeAsync(16_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const res = await uploadPromise;
    expect(res.ok).toBe(true);
    expect(res.attachment.daemonPath).toBe('/tmp/direct-recovered.bin');
    expect(deadPeer.closed).toBe(true);
    expect(FakePeerConnection.instances.length).toBeGreaterThanOrEqual(2);
    expect(FakePeerConnection.instances[1]).not.toBe(deadPeer);
  });

  it('closes mid-stream frozen active peer within 2.5s FOREGROUND_RESUME_PROBE_MS and recovers on a fresh peer', async () => {
    const { uploadFileDirect, resumeDirectFileTransfers } = await import('../src/direct-file-transfer.js');
    const { ws, emitCapabilitySnapshot } = createMockWs({ freezeBeforeAcceptedPeerIndexes: new Set([0]) });
    const file = createTestUploadFile('midstream.bin', 16);

    const uploadPromise = uploadFileDirect(
      ws,
      file,
      'upl-midstream-1',
      undefined,
      undefined,
      undefined,
      'deck_sub_1',
      'srv-1',
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(FakePeerConnection.instances).toHaveLength(1);
    const deadPeer = FakePeerConnection.instances[0];

    emitCapabilitySnapshot(null);
    emitCapabilitySnapshot({ capabilities: CAPS });
    resumeDirectFileTransfers(ws, 'srv-1');

    // Mid-stream (!uploadSourceFinished) arms FOREGROUND_RESUME_PROBE_MS (2.5s) rather than 20-30s NO_PROGRESS_TIMEOUT
    await vi.advanceTimersByTimeAsync(2_600);
    expect(deadPeer.closed).toBe(true);

    // Retry backoff completes on fresh peer #2
    await vi.advanceTimersByTimeAsync(3_500);

    const res = await uploadPromise;
    expect(res.ok).toBe(true);
    expect(res.attachment.daemonPath).toBe('/tmp/direct-recovered.bin');
    expect(deadPeer.closed).toBe(true);
    expect(FakePeerConnection.instances.length).toBeGreaterThanOrEqual(2);
    expect(FakePeerConnection.instances[1]).not.toBe(deadPeer);
  });

  it('survives 4 consecutive iOS background pauses on Direct without exhausting MAX_ATTEMPTS=3', async () => {
    const { uploadFileDirect } = await import('../src/direct-file-transfer.js');
    let finishCalls = 0;
    const { ws } = createMockWs({
      onFinishAttempt: (_peerIndex, channel) => {
        finishCalls += 1;
        if (finishCalls <= 4) {
          // Simulate iOS freeze -> resume -> delayed channel close after already visible
          setDocumentVisibility('hidden');
          document.dispatchEvent(new Event('visibilitychange'));
          setDocumentVisibility('visible');
          document.dispatchEvent(new Event('visibilitychange'));
          queueMicrotask(() => channel.close());
          return true;
        }
        return false;
      },
    });

    const file = createTestUploadFile('ios-direct.bin', 16);
    const promise = uploadFileDirect(
      ws,
      file,
      'upl-ios-direct-1',
      undefined,
      undefined,
      undefined,
      'deck_sub_1',
      'srv-1',
    );

    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(350);
    }

    const res = await promise;
    expect(res.ok).toBe(true);
    expect(finishCalls).toBe(5);
  });

  it('pauses direct connectTimer while backgrounded instead of falling back to HTTP prematurely', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws } = createMockWs({ stallAllOffers: true });
    const file = createTestUploadFile('fallback-pause.bin', 16);

    mockFallbackUploadFile.mockResolvedValue({
      ok: true,
      attachment: {
        id: opaque('f'),
        source: 'upload',
        serverId: 'srv-1',
        daemonPath: '/tmp/http-fallback.bin',
        originalName: 'fallback-pause.bin',
        size: 16,
        createdAt: '2026-11-15T00:00:00.000Z',
        downloadable: true,
      },
    });

    const promise = uploadFileWithDirectFallback({
      ws,
      file,
      serverId: 'srv-1',
      sessionName: 'deck_sub_1',
    });

    await vi.advanceTimersByTimeAsync(500);
    // Background the app before the 8s direct connect fallback deadline elapses
    setDocumentVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    // Even after 15s hidden (>8s UPLOAD_DIRECT_CONNECT_MIN_FALLBACK_MS), HTTP fallback must NOT fire while backgrounded
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockFallbackUploadFile).not.toHaveBeenCalled();

    // Returning to foreground re-arms connect timeout (8s) and falls back cleanly if Direct still does not respond
    setDocumentVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(9_000);

    const res = await promise;
    expect(res.ok).toBe(true);
    expect(mockFallbackUploadFile).toHaveBeenCalledTimes(1);
    expect(res.attachment.daemonPath).toBe('/tmp/http-fallback.bin');
  });

  it('re-arms direct connectTimer instead of falling back immediately when timer fires after background resume crossed epoch', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws } = createMockWs({ stallAllOffers: true });
    const file = createTestUploadFile('resume-crossed-epoch.bin', 16);

    mockFallbackUploadFile.mockResolvedValue({
      ok: true,
      attachment: {
        id: opaque('f'),
        source: 'upload',
        serverId: 'srv-1',
        daemonPath: '/tmp/http-after-rearm.bin',
        originalName: 'resume-crossed-epoch.bin',
        size: 16,
        createdAt: '2026-11-15T00:00:00.000Z',
        downloadable: true,
      },
    });

    const promise = uploadFileWithDirectFallback({
      ws,
      file,
      serverId: 'srv-1',
      sessionName: 'deck_sub_1',
    });

    await vi.advanceTimersByTimeAsync(500);
    // Simulate quick app switch before connectTimer expires: hidden -> visible before timer fires
    setDocumentVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(2_000);
    setDocumentVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    // Advance past the original 8s deadline (500 + 2000 + 6000 = 8500): timer fires while already visible,
    // detects crossed backgroundEpoch, and re-arms a fresh 8s connect window instead of immediate HTTP fallback.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mockFallbackUploadFile).not.toHaveBeenCalled();

    // After the re-armed 8s window elapses with Direct still stalled, HTTP fallback proceeds cleanly.
    await vi.advanceTimersByTimeAsync(8_500);
    const res = await promise;
    expect(res.ok).toBe(true);
    expect(mockFallbackUploadFile).toHaveBeenCalledTimes(1);
    expect(res.attachment.daemonPath).toBe('/tmp/http-after-rearm.bin');
  });

  it('falls back to HTTP without clearing resumable identity on non-user CANCELED from lease control invalidation', async () => {
    const { uploadFileWithDirectFallback, resumeDirectFileTransfers } = await import('../src/direct-file-transfer.js');
    const { ws } = createMockWs({ stallAllOffers: true });
    const file = createTestUploadFile('non-user-cancel.bin', 16);

    mockFallbackUploadFile.mockImplementation(async (_srv: string, _f: File, _onProg?: unknown, clientUploadId?: string) => ({
      ok: true,
      attachment: {
        id: opaque('c'),
        source: 'upload',
        serverId: 'srv-1',
        daemonPath: `/tmp/http-${String(clientUploadId ?? 'missing')}.bin`,
        originalName: 'non-user-cancel.bin',
        size: 16,
        createdAt: '2026-11-15T00:00:00.000Z',
        downloadable: true,
      },
    }));

    const controller = new AbortController();
    const promise = uploadFileWithDirectFallback({
      ws,
      file,
      serverId: 'srv-1',
      sessionName: 'deck_sub_1',
      clientUploadId: 'cid-keep-me',
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(100);
    // Simulate WS reconnect / resume closing peer while user signal was NOT aborted
    resumeDirectFileTransfers(ws, 'srv-1');
    await vi.advanceTimersByTimeAsync(17_000);

    const res = await promise;
    expect(res.ok).toBe(true);
    expect(res.attachment.daemonPath).toBe('/tmp/http-cid-keep-me.bin');
    expect(mockFallbackUploadFile).toHaveBeenCalledWith(
      'srv-1',
      file,
      undefined,
      'cid-keep-me',
      controller.signal,
      'deck_sub_1',
    );
  });
});
