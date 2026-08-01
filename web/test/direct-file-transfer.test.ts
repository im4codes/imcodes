// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIRECT_FILE_TRANSFER_CAPABILITY, DIRECT_FILE_TRANSFER_MSG } from '../../shared/direct-file-transfer.js';
import type { ServerMessage, WsClient } from '../src/ws-client.js';

const uploadFileMock = vi.fn();
vi.mock('../src/api.js', () => ({
  uploadFile: uploadFileMock,
}));

const capability = 'A'.repeat(43);

class FakeDataChannel extends EventTarget {
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: unknown[] = [];
  onSend: ((value: unknown) => void) | null = null;

  send(value: unknown): void {
    this.sent.push(value);
    this.onSend?.(value);
  }

  close(): void {}
}

class FakePeerConnection extends EventTarget {
  static latest: FakePeerConnection | null = null;
  readonly channel = new FakeDataChannel();
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = 'new';

  constructor() {
    super();
    FakePeerConnection.latest = this;
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'browser-offer' };
  }

  async setLocalDescription(): Promise<void> {
    queueMicrotask(() => this.channel.dispatchEvent(new Event('open')));
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
  }

  async addIceCandidate(): Promise<void> {}
  close(): void {}
}

function createWs(capabilities: string[]) {
  const handlers = new Set<(message: ServerMessage) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const emit = (message: ServerMessage) => {
    for (const handler of handlers) handler(message);
  };
  const ws = {
    getDaemonCapabilitySnapshot: () => ({
      daemonId: 'daemon-1', capabilities, helloEpoch: 1, sentAt: Date.now(), observedAt: Date.now(),
    }),
    onMessage: (handler: (message: ServerMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    send: (message: Record<string, unknown>) => {
      sent.push(message);
      if (message.type === DIRECT_FILE_TRANSFER_MSG.INIT) {
        queueMicrotask(() => emit({
          ...message,
          type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED,
          capability,
          expiresAt: Date.now() + 60_000,
          iceServers: [],
        } as ServerMessage));
      }
      if (message.type === DIRECT_FILE_TRANSFER_MSG.OFFER) {
        queueMicrotask(() => emit({
          type: DIRECT_FILE_TRANSFER_MSG.ANSWER,
          requestId: message.requestId,
          capability,
          sdp: 'daemon-answer',
        } as ServerMessage));
      }
    },
  } as unknown as WsClient;
  return { ws, sent, emit };
}

describe('direct file upload fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    uploadFileMock.mockResolvedValue({
      ok: true,
      attachment: { id: 'relay', daemonPath: '/relay/file', serverId: 'server-1' },
    });
  });

  it('uses the existing relay with the stable upload identity when direct is unavailable', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs([]);
    const modes: string[] = [];
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    await expect(uploadFileWithDirectFallback({
      ws,
      serverId: 'server-1',
      file,
      onMode: (mode) => modes.push(mode),
    })).resolves.toMatchObject({ attachment: { id: 'relay' } });
    expect(modes).toEqual(['relay']);
    expect(uploadFileMock).toHaveBeenCalledWith(
      'server-1',
      file,
      undefined,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });

  it('does not make a doomed relay request for an oversized file without direct capability', async () => {
    const { DirectFileTransferFailure, uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws } = createWs([]);
    const huge = { name: 'huge.bin', type: 'application/octet-stream', size: 3 * 1024 * 1024 * 1024 } as File;
    await expect(uploadFileWithDirectFallback({ ws, serverId: 'server-1', file: huge })).rejects.toMatchObject({
      name: DirectFileTransferFailure.name,
      code: 'relay_size_limit',
    });
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('falls back to relay in the same upload after direct negotiation fails', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const fixture = createWs([DIRECT_FILE_TRANSFER_CAPABILITY]);
    (fixture.ws as unknown as { send: (message: Record<string, unknown>) => void }).send = (message) => {
      if (message.type !== DIRECT_FILE_TRANSFER_MSG.INIT) return;
      queueMicrotask(() => fixture.emit({
        type: DIRECT_FILE_TRANSFER_MSG.ERROR,
        requestId: message.requestId as string,
        error: 'connection_failed',
        retryable: true,
      } as ServerMessage));
    };
    const modes: string[] = [];
    const file = new File(['fallback'], 'fallback.txt', { type: 'text/plain' });
    await expect(uploadFileWithDirectFallback({
      ws: fixture.ws,
      serverId: 'server-1',
      file,
      onMode: (mode) => modes.push(mode),
    })).resolves.toMatchObject({ attachment: { id: 'relay' } });
    expect(modes).toEqual(['connecting', 'falling_back', 'relay']);
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
  });

  it('streams bytes over the data channel and reports P2P direct mode without invoking relay', async () => {
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    const { ws, emit } = createWs([DIRECT_FILE_TRANSFER_CAPABILITY]);
    const modes: string[] = [];
    const progress: number[] = [];
    const bytes = new TextEncoder().encode('hello direct');
    const file = {
      name: 'hello.txt',
      type: 'text/plain',
      size: bytes.byteLength,
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => bytes.slice(start, end).buffer,
      }),
    } as unknown as File;
    const pending = uploadFileWithDirectFallback({
      ws,
      serverId: 'server-1',
      file,
      onMode: (mode) => modes.push(mode),
      onProgress: (value) => progress.push(value),
    });

    await vi.waitFor(() => expect(FakePeerConnection.latest?.channel.sent.length).toBeGreaterThan(0));
    const peer = FakePeerConnection.latest!;
    peer.channel.onSend = (value) => {
      if (typeof value !== 'string') return;
      const payload = JSON.parse(value) as { type: string; requestId: string };
      if (payload.type === 'direct_file.data.start') {
        queueMicrotask(() => peer.channel.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED.replace('authorized', 'data.accepted'), requestId: payload.requestId }),
        })));
      }
      if (payload.type === 'direct_file.data.finish') {
        queueMicrotask(() => emit({
          type: DIRECT_FILE_TRANSFER_MSG.DONE,
          requestId: payload.requestId,
          capability,
          clientUploadId: 'ignored-by-client',
          attachment: {
            id: 'direct', source: 'upload', serverId: 'server-1', daemonPath: '/direct/file',
            size: file.size, createdAt: new Date().toISOString(), downloadable: true,
          },
        } as ServerMessage));
      }
    };
    // The START may have been sent before the hook above was installed.
    const start = peer.channel.sent.find((value) => typeof value === 'string') as string;
    const startPayload = JSON.parse(start) as { requestId: string };
    peer.channel.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'direct_file.data.accepted', requestId: startPayload.requestId }),
    }));

    await expect(pending).resolves.toMatchObject({ attachment: { id: 'direct' } });
    expect(modes).toContain('direct');
    expect(progress).toContain(100);
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(peer.channel.sent.some((value) => typeof value !== 'string')).toBe(true);
  });
});
