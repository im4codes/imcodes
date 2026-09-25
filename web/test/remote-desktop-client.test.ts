import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_CONTROL_KIND,
  REMOTE_DESKTOP_CONTROL_REJECTION,
  REMOTE_DESKTOP_DATA_MSG,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_INPUT_BLOCKED,
  REMOTE_DESKTOP_KEYBOARD_KIND,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_POINTER_KIND,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_STOP_ORIGIN,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '@shared/remote-desktop.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { validateRemoteDesktopBrowserMessage } from '@shared/remote-desktop.js';
import {
  applyH264ReceiveCodecPreference,
  RemoteDesktopClient,
  chunkRemoteDesktopText,
  isRemoteDesktopKeyAllowed,
  prioritizeH264ReceiveCodecs,
} from '../src/remote-desktop-client.js';
import {
  REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT,
  clearRemoteDesktopBrowserDiagnostics,
  readRemoteDesktopBrowserDiagnostics,
} from '../src/remote-desktop-browser-diagnostics.js';

function videoCodec(mimeType: string, sdpFmtpLine?: string): RTCRtpCodec {
  return { mimeType, clockRate: 90_000, sdpFmtpLine };
}

describe('remote desktop receive codec compatibility', () => {
  it('prefers H.264 without removing codecs or their repair payloads', () => {
    const codecs = [
      videoCodec('video/VP8'),
      videoCodec('video/rtx', 'apt=96'),
      videoCodec('video/H264', 'packetization-mode=0'),
      videoCodec('video/red'),
      videoCodec('video/H264', 'packetization-mode=1'),
      videoCodec('video/VP9'),
    ];

    const preferred = prioritizeH264ReceiveCodecs(codecs);

    expect(preferred).toEqual([
      codecs[2],
      codecs[4],
      codecs[0],
      codecs[1],
      codecs[3],
      codecs[5],
    ]);
    expect(new Set(preferred)).toEqual(new Set(codecs));
  });

  it('leaves browser defaults alone when H.264 is unavailable', () => {
    expect(prioritizeH264ReceiveCodecs([
      videoCodec('video/VP8'),
      videoCodec('video/rtx', 'apt=96'),
    ])).toBeNull();
  });

  it('falls back to browser codec negotiation when preference application throws', () => {
    const setCodecPreferences = vi.fn(() => {
      throw new DOMException('unsupported codec preferences', 'OperationError');
    });
    const transceiver = { setCodecPreferences } as unknown as RTCRtpTransceiver;
    const codecs = [videoCodec('video/VP8'), videoCodec('video/H264')];

    expect(() => applyH264ReceiveCodecPreference(transceiver, codecs)).not.toThrow();
    expect(setCodecPreferences).toHaveBeenCalledWith([codecs[1], codecs[0]]);
  });
});

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  binaryType = '';
  sent: string[] = [];

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  send(value: string): void { this.sent.push(value); }
  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];
  failNextSend = false;

  constructor(readonly label: string, readonly options: RTCDataChannelInit) { super(); }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  send(value: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new DOMException('simulated send failure', 'OperationError');
    }
    this.sent.push(value);
  }
  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class FakePeer extends EventTarget {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  channels = new Map<string, FakeDataChannel>();
  candidates: RTCIceCandidateInit[] = [];
  failRemoteDescription = false;
  stats: Array<Record<string, unknown>> = [];
  offerOptions: Array<RTCOfferOptions | undefined> = [];
  configuration: RTCConfiguration = {};

  lastTransceiverReceiver: { playoutDelayHint?: number } = {};

  addTransceiver(): RTCRtpTransceiver {
    this.lastTransceiverReceiver = {};
    return {
      setCodecPreferences: vi.fn(),
      receiver: this.lastTransceiverReceiver,
    } as unknown as RTCRtpTransceiver;
  }

  createDataChannel(label: string, options: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeDataChannel(label, options);
    this.channels.set(label, channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options);
    return { type: 'offer', sdp: 'v=0\r\n' };
  }
  async setLocalDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = value as RTCSessionDescription;
  }
  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    if (this.failRemoteDescription) throw new DOMException('invalid answer', 'OperationError');
    this.remoteDescription = value as RTCSessionDescription;
  }
  async addIceCandidate(value: RTCIceCandidateInit): Promise<void> { this.candidates.push(value); }
  async getStats(): Promise<RTCStatsReport> {
    return {
      forEach: (callback: (value: RTCStats) => void) => {
        for (const value of this.stats) callback(value as unknown as RTCStats);
      },
    } as unknown as RTCStatsReport;
  }
  getConfiguration(): RTCConfiguration { return this.configuration; }
  setConfiguration(configuration: RTCConfiguration): void { this.configuration = configuration; }
  connect(): void {
    this.connectionState = 'connected';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  emitLocalCandidate(candidate: string, sdpMid = '0'): void {
    this.dispatchEvent(Object.assign(new Event('icecandidate'), {
      candidate: { candidate, sdpMid },
    }));
  }
  /** Gathering's final event, which carries no candidate object at all. */
  emitEndOfCandidates(): void {
    this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null }));
  }
  close(): void { this.connectionState = 'closed'; }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
});

describe('RemoteDesktopClient', () => {
  it('preserves server retry guidance on an authorization error', async () => {
    let socket!: FakeSocket;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-retry-guidance',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => new FakePeer() as unknown as RTCPeerConnection,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.ERROR,
      requestId: start.requestId,
      error: REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE,
      retryable: true,
    });

    await vi.waitFor(() => expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.FAILED,
      error: REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE,
      retryable: true,
    }));
  });

  it('records track, peer/ICE and decoded-frame evidence in one bounded browser ring', async () => {
    vi.useFakeTimers();
    clearRemoteDesktopBrowserDiagnostics('controlled-win');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-diagnostics',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      isDocumentVisible: () => true,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_diagnos1',
      capability: 'd'.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      iceServers: [],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());

    const track = Object.assign(new EventTarget(), {
      id: 'track-is-not-recorded', muted: false, readyState: 'live' as MediaStreamTrackState,
    });
    peer.dispatchEvent(Object.assign(new Event('track'), {
      track,
      streams: [{ id: 'stream-is-not-recorded' }],
    }));
    track.muted = true;
    track.dispatchEvent(new Event('mute'));
    track.muted = false;
    track.dispatchEvent(new Event('unmute'));
    peer.connectionState = 'connected';
    peer.iceConnectionState = 'connected';
    peer.dispatchEvent(new Event('connectionstatechange'));
    peer.dispatchEvent(new Event('iceconnectionstatechange'));
    peer.stats = [{
      type: 'inbound-rtp', kind: 'video', bytesReceived: 12_345,
      packetsReceived: 234, framesReceived: 120, framesDecoded: 119,
      keyFramesDecoded: 3, framesDropped: 1, freezeCount: 2,
      totalFreezesDuration: 1.25, jitterBufferDelay: 0.75,
      jitterBufferEmittedCount: 118, timestamp: 2_000,
    }];
    await vi.advanceTimersByTimeAsync(1_000);

    const events = readRemoteDesktopBrowserDiagnostics('controlled-win');
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK,
      REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_MUTE,
      REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_UNMUTE,
      REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.PEER_CONNECTION_STATE,
      REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.PEER_ICE_STATE,
      REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.INBOUND_STATS,
    ]));
    expect(events.find((event) => (
      event.type === REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.INBOUND_STATS
    ))).toMatchObject({
      bytesReceived: 12_345,
      packetsReceived: 234,
      framesReceived: 120,
      framesDecoded: 119,
      keyFramesDecoded: 3,
      framesDropped: 1,
      freezeCount: 2,
      totalFreezesDurationMs: 1_250,
      jitterBufferDelayMs: 750,
      jitterBufferEmittedCount: 118,
    });
    expect(JSON.stringify(events)).not.toContain('track-is-not-recorded');
    expect(JSON.stringify(events)).not.toContain('stream-is-not-recorded');
    const eventCountAtStop = events.length;
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
    track.muted = true;
    track.dispatchEvent(new Event('mute'));
    peer.connectionState = 'failed';
    peer.dispatchEvent(new Event('connectionstatechange'));
    expect(readRemoteDesktopBrowserDiagnostics('controlled-win')).toHaveLength(eventCountAtStop);
    vi.useRealTimers();
  });

  it('hints the video receiver to minimize jitter-buffer playout delay', async () => {
    let socket!: FakeSocket;
    let peer!: FakePeer;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-playout',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_playout1',
      capability: 'e'.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      iceServers: [],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());

    // Every frame the jitter buffer holds back is uniform added latency for a
    // desktop the operator is actively controlling live -- Chrome's default
    // favors smooth playback over that, which is backwards here.
    expect(peer.lastTransceiverReceiver.playoutDelayHint).toBe(0);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('retries a weak signaling path and resumes the same peer without remounting its stream', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const peers: FakePeer[] = [];
      const snapshots: Array<ReturnType<RemoteDesktopClient['current']>> = [];
      const client = new RemoteDesktopClient('controlled-win', {
        onSnapshot: (snapshot) => snapshots.push({ ...snapshot }),
      }, {
        fetchTicket: async () => `ticket-${sockets.length + 1}`,
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          // The first connection succeeds, two reconnect attempts die before
          // opening, and the fourth socket finally reaches the server.
          queueMicrotask(() => (sockets.length === 2 || sockets.length === 3
            ? socket.close()
            : socket.open()));
          return socket as unknown as WebSocket;
        },
        createPeer: () => {
          const peer = new FakePeer();
          peers.push(peer);
          return peer as unknown as RTCPeerConnection;
        },
      });

      await client.start();
      const startMessage = JSON.parse(sockets[0]!.sent[0]!) as { requestId: string };
      const authority = {
        requestId: startMessage.requestId,
        sessionId: 'session_12345678',
        capability: 'a'.repeat(43),
        expiresAt: Date.now() + 60_000,
        leaseExpiresAt: Date.now() + 15_000,
        daemonGeneration: 7,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        iceServers: ['stun:stun.example.test:3478'],
      } as const;
      sockets[0]!.receive({ type: REMOTE_DESKTOP_MSG.AUTHORIZED, ...authority });
      await vi.waitFor(() => expect(peers).toHaveLength(1));
      await vi.waitFor(() => expect(client.current().state)
        .toBe(REMOTE_DESKTOP_STATE.CONNECTING));
      const stream = { id: 'preserved-stream' } as unknown as MediaStream;
      snapshots.push({ ...client.current(), stream });
      (client as unknown as { snapshot: ReturnType<RemoteDesktopClient['current']> }).snapshot = {
        ...client.current(),
        state: REMOTE_DESKTOP_STATE.DIRECT,
        stream,
        inputEnabled: true,
      };

      sockets[0]!.close();
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_BACKOFF_MS);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_BACKOFF_MS * 2);
      await vi.waitFor(() => expect(sockets).toHaveLength(3));
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_BACKOFF_MS * 4);
      await vi.waitFor(() => expect(sockets).toHaveLength(4));

      expect(peers).toHaveLength(1);
      expect(client.current()).toMatchObject({
        state: REMOTE_DESKTOP_STATE.RECONNECTING,
        stream,
        inputEnabled: false,
      });
      expect(JSON.parse(sockets[3]!.sent[0]!)).toEqual({
        type: REMOTE_DESKTOP_MSG.RESUME,
        protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
        requestId: authority.requestId,
        sessionId: authority.sessionId,
        capability: authority.capability,
      });

      sockets[3]!.receive({
        type: REMOTE_DESKTOP_MSG.RESUMED,
        ...authority,
        inputEpoch: 2,
        leaseExpiresAt: Date.now() + 15_000,
      });
      await vi.waitFor(() => expect(sockets[3]!.sent.map((raw) => JSON.parse(raw).type))
        .toContain(REMOTE_DESKTOP_MSG.OFFER));

      expect(peers).toHaveLength(1);
      expect(peers[0]!.offerOptions.at(-1)).toEqual({ iceRestart: true });
      expect(peers[0]!.configuration.iceServers).toEqual([{
        urls: 'stun:stun.example.test:3478',
      }]);
      expect(client.current().stream).toBe(stream);
      expect(client.current().inputEpoch).toBe(2);
      expect(snapshots.some((snapshot) => snapshot.state === REMOTE_DESKTOP_STATE.FAILED)).toBe(false);
      client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed only after the full five-minute signaling recovery budget', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const sockets: FakeSocket[] = [];
      const peers: FakePeer[] = [];
      const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
        fetchTicket: async () => `ticket-${sockets.length + 1}`,
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          queueMicrotask(() => socket.open());
          return socket as unknown as WebSocket;
        },
        createPeer: () => {
          const peer = new FakePeer();
          peers.push(peer);
          return peer as unknown as RTCPeerConnection;
        },
      });

      await client.start();
      const startMessage = JSON.parse(sockets[0]!.sent[0]!) as { requestId: string };
      sockets[0]!.receive({
        type: REMOTE_DESKTOP_MSG.AUTHORIZED,
        requestId: startMessage.requestId,
        sessionId: 'session_12345678',
        capability: 'a'.repeat(43),
        expiresAt: Date.now() + 10 * 60_000,
        leaseExpiresAt: Date.now() + 10 * 60_000,
        daemonGeneration: 7,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        iceServers: ['stun:stun.example.test:3478'],
      });
      await vi.waitFor(() => expect(peers).toHaveLength(1));
      await vi.waitFor(() => expect(client.current().state)
        .toBe(REMOTE_DESKTOP_STATE.CONNECTING));

      sockets[0]!.close();
      await vi.advanceTimersByTimeAsync(
        REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_GRACE_MS - 1,
      );
      expect(client.current().state).toBe(REMOTE_DESKTOP_STATE.RECONNECTING);
      expect(peers).toHaveLength(1);
      expect(peers[0]!.connectionState).not.toBe('closed');

      await vi.advanceTimersByTimeAsync(1);
      expect(client.current()).toMatchObject({
        state: REMOTE_DESKTOP_STATE.FAILED,
        terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.BROWSER_DISCONNECTED,
        inputEnabled: false,
      });
      expect(peers[0]!.connectionState).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the exact signaling bridge daemon lifecycle without treating it as remote-desktop data', async () => {
    let socket!: FakeSocket;
    const onDaemonReconnected = vi.fn();
    const onSnapshot = vi.fn();
    const client = new RemoteDesktopClient('sticky-server', {
      onSnapshot,
      onDaemonReconnected,
    }, {
      fetchTicket: async () => 'ticket-1',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
    });
    await client.start();
    const snapshotsBefore = onSnapshot.mock.calls.length;

    socket.receive({ type: DAEMON_MSG.RECONNECTED });

    expect(onDaemonReconnected).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledTimes(snapshotsBefore);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('keeps guest bootstrap proof out of the URL and waits for redemption before START', async () => {
    let socket!: FakeSocket;
    let socketUrl = '';
    const fetchTicket = vi.fn();
    const guestBootstrapProof = {
      ticket: 'guest-ticket-secret',
      browserKeyThumbprint: 'browser-thumbprint',
      signature: 'browser-signature',
    };
    const dependencies = {
      fetchTicket,
      guestBootstrapProof,
      createSocket: (url: string) => {
        socketUrl = url;
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
    };
    const client = new RemoteDesktopClient('sticky-server', { onSnapshot: vi.fn() }, dependencies);

    const starting = client.start();

    expect(fetchTicket).not.toHaveBeenCalled();
    expect(socketUrl).toContain('serverId=sticky-server');
    expect(socketUrl).not.toContain('ticket');
    expect(socketUrl).not.toContain('proof');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(JSON.parse(socket.sent[0]!)).toEqual(guestBootstrapProof);
    expect(socket.sent).toHaveLength(1);
    socket.receive({ type: REMOTE_DESKTOP_MSG.BOOTSTRAP_REDEEMED });
    await starting;
    expect(JSON.parse(socket.sent[1]!).type).toBe(REMOTE_DESKTOP_MSG.START);
    expect(dependencies.guestBootstrapProof).toBeUndefined();
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('defaults to independent Control but enables input only after every channel and worker acknowledgement', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const snapshots: Array<ReturnType<RemoteDesktopClient['current']>> = [];
    const animationFrames: FrameRequestCallback[] = [];
    const client = new RemoteDesktopClient('controlled-win', {
      onSnapshot: (snapshot) => snapshots.push({ ...snapshot }),
    }, {
      fetchTicket: async () => 'ticket-1',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      requestAnimationFrame: (callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      },
      cancelAnimationFrame: vi.fn(),
      now: () => now,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw).type)).toContain(REMOTE_DESKTOP_MSG.OFFER));

    expect([...peer.channels.keys()]).toEqual([
      REMOTE_DESKTOP_CHANNEL.CONTROL,
      REMOTE_DESKTOP_CHANNEL.KEYBOARD,
      REMOTE_DESKTOP_CHANNEL.POINTER,
    ]);
    expect(peer.channels.get(REMOTE_DESKTOP_CHANNEL.POINTER)?.options).toMatchObject({ ordered: false, maxRetransmits: 0 });
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    const keyboard = peer.channels.get(REMOTE_DESKTOP_CHANNEL.KEYBOARD)!;
    const pointer = peer.channels.get(REMOTE_DESKTOP_CHANNEL.POINTER)!;
    control.open();
    keyboard.open();
    expect(client.key('KeyA', 'a', true, false, { control: false, alt: false })).toBe(false);
    pointer.open();
    const keepaliveCall = intervalSpy.mock.calls.find((call) => (
      call[1] === REMOTE_DESKTOP_LIMITS.DATA_KEEPALIVE_INTERVAL_MS
    ));
    expect(keepaliveCall).toBeDefined();
    (keepaliveCall![0] as () => void)();
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kind: 'keepalive',
    });
    expect(client.key('KeyA', 'a', true, false, { control: false, alt: false })).toBe(false);
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 1,
      layoutRevision: 1,
      displays: [{
        id: 'display_initial1',
        label: 'DISPLAY1',
        primary: true,
        available: true,
        width: 1920,
        height: 1080,
        dpiScale: 1.5,
        rotation: 0,
      }],
      selectedDisplayId: 'display_initial1',
    });
    const initialReadyStatus = {
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display_initial1',
      layoutRevision: 1,
      inputEnabled: true,
      viewerCount: 1,
      controllerCount: 1,
    } as const;
    socket.receive(initialReadyStatus);
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(false));
    (keepaliveCall![0] as () => void)();
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kind: REMOTE_DESKTOP_CONTROL_KIND.KEEPALIVE,
    });
    socket.receive(initialReadyStatus);
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(false));
    expect(client.acknowledgePresentedFrame(1920, 1080)).toBe(true);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kind: REMOTE_DESKTOP_CONTROL_KIND.FRAME_PRESENTED,
      displayId: 'display_initial1',
      frameWidth: 1920,
      frameHeight: 1080,
      layoutRevision: 1,
    });
    socket.receive(initialReadyStatus);
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(true));
    intervalSpy.mockRestore();

    const clipboardPromise = client.requestRemoteClipboard();
    const clipboardRequest = JSON.parse(control.sent.at(-1)!);
    expect(clipboardRequest).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kind: REMOTE_DESKTOP_CONTROL_KIND.COPY_SELECTION,
    });
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.CLIPBOARD,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 4,
      requestId: clipboardRequest.requestId,
      available: true,
      text: 'selected remotely',
    });
    await expect(clipboardPromise).resolves.toBe('selected remotely');

    expect(client.key('ControlLeft', 'Control', true, false, { control: true, alt: false })).toBe(true);
    expect(client.pointerButton('left', true, 0.4, 0.6)).toBe(true);
    expect(client.pointerClick('left', 0.4, 0.6)).toBe(true);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      kind: REMOTE_DESKTOP_POINTER_KIND.BUTTON_CLICK,
      button: 'left',
      x: 0.4,
      y: 0.6,
    });
    client.releasePointerButtons();
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      kind: REMOTE_DESKTOP_POINTER_KIND.BUTTON_UP,
      button: 'left',
    });
    expect(client.key('ControlLeft', 'Control', false, false, { control: false, alt: false })).toBe(true);

    // Browser-reserved Cmd+E can swallow KeyE's keyup. The next Meta release
    // must heal the non-modifier as well, while an explicit exceptCode keeps
    // the current transition untouched.
    expect(client.key('MetaLeft', 'Meta', true, false, { control: false, alt: false })).toBe(true);
    expect(client.key('KeyE', 'e', true, false, { control: false, alt: false })).toBe(true);
    client.noteMetaChordKey('KeyE', 'e', true);
    const beforeModifierReconcile = keyboard.sent.length;
    client.reconcileModifiers({ meta: false }, 'MetaLeft');
    expect(keyboard.sent).toHaveLength(beforeModifierReconcile + 1);
    expect(JSON.parse(keyboard.sent.at(-1)!)).toMatchObject({
      kind: REMOTE_DESKTOP_KEYBOARD_KIND.KEY_UP,
      code: 'KeyE',
      key: 'e',
    });
    expect(client.key('MetaLeft', 'Meta', false, false, { control: false, alt: false })).toBe(true);

    expect(client.key('KeyA', 'a', true, false, { control: false, alt: false })).toBe(true);
    const keyDown = JSON.parse(keyboard.sent.at(-1)!) as { sequence: number };
    expect(keyDown).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
      inputEpoch: 1,
      code: 'KeyA',
    });
    keyboard.failNextSend = true;
    expect(client.key('KeyA', 'a', false, false, { control: false, alt: false })).toBe(false);
    client.releaseAll();
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL,
      inputEpoch: 1,
    });

    expect(client.pointerButton('left', true, 0.4, 0.6)).toBe(true);
    control.failNextSend = true;
    expect(client.pointerButton('left', false, 0.4, 0.6)).toBe(false);
    client.releaseAll();
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL,
      inputEpoch: 1,
    });
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 1,
      layoutRevision: 1,
      inputEpoch: 1,
      kind: 'input_ack',
      acknowledgedSequence: keyDown.sequence,
    });
    expect(client.current().lastAcknowledgedInputSequence).toBe(keyDown.sequence);
    now = 100;
    client.pointerMove(0.1, 0.2);
    client.pointerMove(0.8, 0.9);
    expect(animationFrames).toHaveLength(1);
    animationFrames[0]!(0);
    expect(JSON.parse(pointer.sent.at(-1)!)).toMatchObject({ x: 0.8, y: 0.9, inputEpoch: 1 });
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      kind: REMOTE_DESKTOP_POINTER_KIND.MOVE,
      x: 0.8,
      y: 0.9,
      inputEpoch: 1,
    });

    const sentBeforeBackpressure = pointer.sent.length;
    const reliableBeforeBackpressure = control.sent.length;
    pointer.bufferedAmount = 1_000_000;
    now = 150;
    client.pointerMove(0.2, 0.3);
    expect(animationFrames).toHaveLength(2);
    animationFrames[1]!(1);
    expect(pointer.sent).toHaveLength(sentBeforeBackpressure);
    // The reliable sample now runs at the cadence following needs, so a
    // congested fast channel no longer means the cursor stops: this move
    // leaves on the reliable channel instead of being dropped with it.
    expect(control.sent).toHaveLength(reliableBeforeBackpressure + 1);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      kind: REMOTE_DESKTOP_POINTER_KIND.MOVE,
      x: 0.2,
      y: 0.3,
    });

    // Even while the best-effort channel is congested, a bounded reliable
    // position sample makes the remote Windows cursor converge to the local
    // pointer instead of getting stuck at the last delivered packet.
    now = 250;
    client.pointerMove(0.7, 0.6);
    expect(animationFrames).toHaveLength(3);
    animationFrames[2]!(2);
    expect(pointer.sent).toHaveLength(sentBeforeBackpressure);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      kind: REMOTE_DESKTOP_POINTER_KIND.MOVE,
      x: 0.7,
      y: 0.6,
    });
    pointer.bufferedAmount = 0;

    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 2,
      layoutRevision: 2,
      displays: [{
        id: 'display_12345678',
        label: 'DISPLAY2',
        primary: false,
        available: true,
        width: 3840,
        height: 2160,
        dpiScale: 2.25,
        rotation: 0,
      }],
      selectedDisplayId: 'display_12345678',
    });
    await vi.waitFor(() => expect(client.current()).toMatchObject({
      layoutRevision: 2,
      inputEnabled: false,
    }));
    expect(client.acknowledgePresentedFrame(1080, 1920)).toBe(false);
    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display_initial1',
      layoutRevision: 1,
      inputEnabled: true,
      viewerCount: 1,
      controllerCount: 1,
    });
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(false));
    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display_12345678',
      layoutRevision: 2,
      inputEnabled: true,
      viewerCount: 1,
      controllerCount: 1,
    });
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(false));
    expect(client.acknowledgePresentedFrame(3840, 2160)).toBe(true);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kind: REMOTE_DESKTOP_CONTROL_KIND.FRAME_PRESENTED,
      displayId: 'display_12345678',
      frameWidth: 3840,
      frameHeight: 2160,
      layoutRevision: 2,
    });
    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display_12345678',
      layoutRevision: 2,
      inputEnabled: true,
      viewerCount: 1,
      controllerCount: 1,
    });
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(true));

    const messagesBeforeNoop = control.sent.length;
    expect(client.setDisplayMode('display_12345678', 3840, 2160)).toBe(true);
    expect(control.sent).toHaveLength(messagesBeforeNoop);
    expect(client.setDisplayScale('display_12345678', 225)).toBe(true);
    expect(control.sent).toHaveLength(messagesBeforeNoop);
    expect(client.setDisplayScale('display_12345678', 110)).toBe(false);
    expect(client.setDisplayMode('display_12345678', 1024, 768)).toBe(false);
    expect(client.setDisplayMode('missing-display', 1280, 720)).toBe(false);
    expect(client.setDisplayMode('display_12345678', 1280, 720)).toBe(true);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kind: 'set_display_mode',
      displayId: 'display_12345678',
      width: 1280,
      height: 720,
      layoutRevision: 2,
      inputEpoch: 1,
    });
    expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.SWITCHING_DISPLAY,
      inputEnabled: false,
    });
    // A layout change gets a budget sized for rebuilding the capture stack,
    // not the few seconds that used to turn a resolution switch into a peer
    // failure.
    expect(timeoutSpy.mock.calls.some((call) => call[1] === 20_000)).toBe(true);
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 3,
      layoutRevision: 3,
      displays: [{
        id: 'display_12345678',
        label: 'DISPLAY2',
        primary: false,
        available: true,
        width: 1280,
        height: 720,
        dpiScale: 2.25,
        rotation: 0,
      }],
      selectedDisplayId: 'display_12345678',
    });
    expect(client.acknowledgePresentedFrame(1280, 720)).toBe(true);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kind: REMOTE_DESKTOP_CONTROL_KIND.FRAME_PRESENTED,
      displayId: 'display_12345678',
      frameWidth: 1280,
      frameHeight: 720,
      layoutRevision: 3,
    });
    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display_12345678',
      layoutRevision: 3,
      inputEnabled: true,
      viewerCount: 1,
      controllerCount: 1,
    });
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(true));
    timeoutSpy.mockRestore();

    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 4,
      layoutRevision: 4,
      displays: [{
        id: 'display_replacement',
        label: 'DISPLAY3',
        primary: true,
        available: true,
        width: 1920,
        height: 1080,
        dpiScale: 1.5,
        rotation: 0,
      }],
    });
    await vi.waitFor(() => expect(client.current()).toMatchObject({
      selectedDisplayId: undefined,
      layoutRevision: 4,
      inputEnabled: false,
    }));
    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.SWITCHING_DISPLAY,
      route: 'direct',
      inputEnabled: false,
      viewerCount: 1,
      controllerCount: 1,
    });
    expect(client.selectDisplay('display_replacement')).toBe(true);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      kind: 'select_display',
      displayId: 'display_replacement',
      layoutRevision: 4,
    });

    client.setMode(REMOTE_DESKTOP_ACCESS_MODE.VIEW);
    expect(client.current().inputEnabled).toBe(false);
    expect(control.sent.map((raw) => JSON.parse(raw).type)).toContain(REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL);
    socket.receive({
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 2,
      reason: REMOTE_DESKTOP_MODE_REASON.USER_SELECTED,
    });
    await vi.waitFor(() => expect(client.current()).toMatchObject({ mode: 'view', inputEpoch: 2, inputEnabled: false }));
    expect(snapshots.length).toBeGreaterThan(3);
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 4,
      preset: '1080p30',
      encoderClass: 'hardware',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateBps: 6_000_000,
      droppedFrames: 0,
      rttMs: 12,
    });
    peer.stats = [{
      type: 'inbound-rtp',
      kind: 'video',
      bytesReceived: 54_321,
      timestamp: 1_000,
    }];
    peer.connect();
    await vi.waitFor(() => expect(client.current().quality).toBeDefined());
    await vi.waitFor(() => expect(client.current()).toMatchObject({
      pointerMoveCalls: 4,
      pointerMoveGateRejected: 0,
      pointerMoveChannelUnavailable: 0,
      pointerMoveBackpressureDrops: 2,
      pointerMoveSendFailures: 0,
      pointerMovesSent: 1,
      pointerMovesMirrored: 3,
    }));
    peer.connectionState = 'failed';
    peer.dispatchEvent(new Event('connectionstatechange'));
    await vi.waitFor(() => expect(socket.sent.filter((raw) => (
      JSON.parse(raw).type === REMOTE_DESKTOP_MSG.OFFER
    ))).toHaveLength(2));
    expect(peer.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      inputEnabled: false,
      reconnectCount: 1,
    });
    const beforeNoInputReconcile = keyboard.sent.length;
    client.reconcileModifiers({ control: false });
    expect(keyboard.sent).toHaveLength(beforeNoInputReconcile);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.STOP,
      stopOrigin: REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE,
      aggregateBytesReceived: 54_321,
    });
  });

  it('zeroes the viewer/controller footer and other live-only fields once the session tears down', async () => {
    let socket!: FakeSocket;
    const client = new RemoteDesktopClient('controlled-mac', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-teardown',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => new FakePeer() as unknown as RTCPeerConnection,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    // A live STATUS reports someone actually watching -- this is exactly the
    // state a stale-forever footer would keep showing after Stop.
    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      inputEnabled: true,
      viewerCount: 1,
      controllerCount: 1,
      signInScreen: true,
      unlockAvailable: true,
    });
    await vi.waitFor(() => expect(client.current().viewerCount).toBe(1));
    expect(client.current()).toMatchObject({
      route: 'direct',
      viewerCount: 1,
      controllerCount: 1,
      signInScreen: true,
      unlockAvailable: true,
    });

    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);

    expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.STOPPED,
      viewerCount: 0,
      controllerCount: 0,
      route: undefined,
      quality: undefined,
      signInScreen: false,
      unlockAvailable: false,
      inputBlocked: undefined,
    });
  });

  it('chunks paste text on UTF-8 and UTF-16 boundaries without splitting surrogate pairs', () => {
    const chunks = chunkRemoteDesktopText(`${'界'.repeat(1_500)}${'😀'.repeat(1_100)}`);
    expect(chunks).not.toBeNull();
    expect(chunks!.join('')).toBe(`${'界'.repeat(1_500)}${'😀'.repeat(1_100)}`);
    expect(chunks!.every((chunk) => (
      new TextEncoder().encode(chunk).byteLength <= REMOTE_DESKTOP_LIMITS.TEXT_BYTES
      && chunk.length <= REMOTE_DESKTOP_LIMITS.TEXT_CODE_UNITS
    ))).toBe(true);
    expect(chunkRemoteDesktopText('x'.repeat(REMOTE_DESKTOP_LIMITS.PASTE_TEXT_BYTES + 1)))
      .toBeNull();
  });

  it('keeps the browser peer and visible state while Windows hands off to a new console session', async () => {
    let socket!: FakeSocket;
    const peers: FakePeer[] = [];
    const snapshots: Array<ReturnType<RemoteDesktopClient['current']>> = [];
    const client = new RemoteDesktopClient('controlled-win', {
      onSnapshot: (snapshot) => snapshots.push({ ...snapshot }),
    }, {
      fetchTicket: async () => 'ticket-handover',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        const peer = new FakePeer();
        peers.push(peer);
        return peer as unknown as RTCPeerConnection;
      },
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw).type))
      .toContain(REMOTE_DESKTOP_MSG.OFFER));
    const peer = peers[0]!;
    socket.receive({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      ...authority,
      sdp: 'v=0\r\nold-worker',
    });
    await vi.waitFor(() => expect(peer.remoteDescription?.sdp).toContain('old-worker'));
    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      inputEnabled: false,
      viewerCount: 1,
      controllerCount: 0,
    });
    await vi.waitFor(() => expect(client.current().state).toBe(REMOTE_DESKTOP_STATE.DIRECT));
    const firstControl = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL);

    socket.receive({ type: REMOTE_DESKTOP_MSG.RENEGOTIATE, ...authority });

    // The same PeerConnection ICE-restarts against the replacement native
    // worker. Only SCTP channels are rebuilt; the mounted stream/last frame and
    // current visible state never enter the reconnecting UI.
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    const sentOffers = () => socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; sessionId?: string; capability?: string })
      .filter((message) => message.type === REMOTE_DESKTOP_MSG.OFFER);
    await vi.waitFor(() => expect(sentOffers()).toHaveLength(2));
    const offers = sentOffers();
    expect(offers[1]).toMatchObject({
      sessionId: authority.sessionId,
      capability: authority.capability,
    });
    expect(peer.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)).not.toBe(firstControl);
    peer.connectionState = 'connecting';
    peer.dispatchEvent(new Event('connectionstatechange'));
    expect(client.current().state).toBe(REMOTE_DESKTOP_STATE.DIRECT);
    socket.receive({
      type: REMOTE_DESKTOP_MSG.ICE,
      ...authority,
      candidate: 'candidate:new-worker',
      mid: '0',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The old remoteDescription remains installed until the replacement
    // ANSWER, but its new-generation candidate must still wait for that answer.
    expect(peer.candidates).toHaveLength(0);
    socket.receive({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      ...authority,
      sdp: 'v=0\r\nnew-worker',
    });
    await vi.waitFor(() => expect(peer.candidates).toEqual([{
      candidate: 'candidate:new-worker',
      sdpMid: '0',
    }]));
    expect(snapshots.some((snapshot) => snapshot.state === REMOTE_DESKTOP_STATE.FAILED)).toBe(false);
    expect(snapshots.some((snapshot) => snapshot.state === REMOTE_DESKTOP_STATE.RECONNECTING)).toBe(false);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('surfaces a refused layout command instead of letting the click vanish', async () => {
    let socket!: FakeSocket;
    let peer!: FakePeer;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-reject',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.open();

    // Refused locally: input is not ready, so nothing is sent — but the
    // operator still learns why the resolution did not change.
    const sentBefore = control.sent.length;
    expect(client.setDisplayMode('display_initial1', 1920, 1080)).toBe(false);
    expect(control.sent).toHaveLength(sentBefore);
    expect(client.current().controlRejection).toMatchObject({
      id: 1,
      kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,
      reason: REMOTE_DESKTOP_CONTROL_REJECTION.DISPLAY_UNAVAILABLE,
      displayId: 'display_initial1',
    });

    // Refused by the node: a driver with no monitor attached offers no such
    // mode. The id advances so the same reason can be shown again.
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL_REJECTED,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 4,
      kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,
      reason: REMOTE_DESKTOP_CONTROL_REJECTION.MODE_UNSUPPORTED,
      displayId: 'display_initial1',
    });
    expect(client.current().controlRejection).toMatchObject({
      id: 2,
      reason: REMOTE_DESKTOP_CONTROL_REJECTION.MODE_UNSUPPORTED,
    });

    // A rejection naming another session is not this session's answer.
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL_REJECTED,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_87654321',
      sequence: 5,
      kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,
      reason: REMOTE_DESKTOP_CONTROL_REJECTION.MODE_CHANGE_FAILED,
    });
    expect(client.current().controlRejection?.id).toBe(2);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('offers unlock only when the node says it can answer its own sign-in screen', async () => {
    let socket!: FakeSocket;
    let peer!: FakePeer;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-unlock',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.open();

    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      inputEnabled: false,
      signInScreen: true,
      unlockAvailable: true,
    });
    await vi.waitFor(() => expect(client.current().signInScreen).toBe(true));
    expect(client.current().unlockAvailable).toBe(true);

    // Without input authority the request is refused here and explained,
    // rather than sent and silently dropped by the node.
    const sentBefore = control.sent.length;
    expect(client.requestUnlock()).toBe(false);
    expect(control.sent).toHaveLength(sentBefore);
    expect(client.current().controlRejection).toMatchObject({
      kind: REMOTE_DESKTOP_CONTROL_KIND.UNLOCK,
      reason: REMOTE_DESKTOP_CONTROL_REJECTION.NOT_PERMITTED,
    });
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('marks retry starts with a bounded reconnect attempt', async () => {
    let socket!: FakeSocket;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-retry',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
    });
    await client.start(2);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.START,
      reconnectAttempt: 2,
    });
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('eases off only for a live picture that lags beyond its own path, never for a still screen or a steady far link', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-linux', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-quality',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });
    const smooth = { maxHeight: 1080, maxFps: 30, maxBitrateBps: 0, priority: 'framerate' } as const;
    expect(client.setQualityPreference(smooth)).toBe(true);
    expect(client.setQualityPreference({ ...smooth, maxFps: 45 } as never)).toBe(false);

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = { requestId: start.requestId, sessionId: 'session_quality1', capability: 'q'.repeat(43) };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: 60_000,
      leaseExpiresAt: 15_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: [],
      relayBitrateCapBps: 500_000,
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    expect(client.current().relayBitrateCapBps).toBe(500_000);
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.open();
    const qualityControls = () => control.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.kind === REMOTE_DESKTOP_CONTROL_KIND.SET_QUALITY_PREFERENCE);

    // An older worker never advertised support: nothing may reach it.
    const status = {
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.RELAYED,
      route: 'relay',
      inputEnabled: false,
    };
    socket.receive(status);
    await vi.waitFor(() => expect(client.current().qualityPreferenceSupported).toBe(false));
    expect(qualityControls()).toHaveLength(0);

    socket.receive({ ...status, qualityPreference: true });
    await vi.waitFor(() => expect(qualityControls()).toHaveLength(1));
    expect(qualityControls()[0]).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      maxHeight: 1080, maxFps: 30, maxBitrateBps: 0, priority: 'framerate',
    });
    // Repeated status frames do not resend an unchanged preference.
    socket.receive({ ...status, qualityPreference: true });
    expect(qualityControls()).toHaveLength(1);

    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    expect(statsTick).toBeTypeOf('function');
    const baseline = qualityControls().length;
    let bytes = 0;
    let frames = 0;
    let buffer = 0;
    const sample = async (i: number, rttS: number, fps: number, bufferPerFrameS: number, bytesPerS: number) => {
      now = i * 1_000;
      bytes += bytesPerS;
      frames += fps;
      buffer += fps * bufferPerFrameS;
      peer.stats = [
        {
          type: 'inbound-rtp', kind: 'video', bytesReceived: bytes, timestamp: now,
          frameWidth: 1920, frameHeight: 1080, framesPerSecond: fps,
          jitterBufferDelay: buffer, jitterBufferEmittedCount: frames,
        },
        { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: rttS },
      ];
      statsTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    // A phone on 5G far away: 300 ms every sample, a still screen at 1 fps.
    for (let i = 1; i <= 8; i += 1) await sample(i, 0.3, 1, 0.3, 2_000);
    expect(qualityControls()).toHaveLength(baseline);
    // The same far link with a moving picture: steady, so still no ceiling.
    for (let i = 9; i <= 16; i += 1) await sample(i, 0.3, 30, 0.02, 250_000);
    expect(qualityControls()).toHaveLength(baseline);
    // Round trips climb 250 ms above that path's own floor: now it lags.
    for (let i = 17; i <= 20; i += 1) await sample(i, 0.55, 30, 0.02, 250_000);
    await vi.waitFor(() => expect(qualityControls().length).toBeGreaterThan(baseline));
    expect(qualityControls().at(-1)!.maxBitrateBps).toBe(1_200_000);
    client.stop();
  });

  it('sends this viewer\'s quality preference only to a capable worker and eases the bitrate off when the picture lags', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-linux', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-quality',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });
    const smooth = { maxHeight: 1080, maxFps: 30, maxBitrateBps: 0, priority: 'framerate' } as const;
    expect(client.setQualityPreference(smooth)).toBe(true);
    expect(client.setQualityPreference({ ...smooth, maxFps: 45 } as never)).toBe(false);

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = { requestId: start.requestId, sessionId: 'session_quality1', capability: 'q'.repeat(43) };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: 60_000,
      leaseExpiresAt: 15_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: [],
      relayBitrateCapBps: 500_000,
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    expect(client.current().relayBitrateCapBps).toBe(500_000);
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.open();
    const qualityControls = () => control.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.kind === REMOTE_DESKTOP_CONTROL_KIND.SET_QUALITY_PREFERENCE);

    // An older worker never advertised support: nothing may reach it.
    const status = {
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.RELAYED,
      route: 'relay',
      inputEnabled: false,
    };
    socket.receive(status);
    await vi.waitFor(() => expect(client.current().qualityPreferenceSupported).toBe(false));
    expect(qualityControls()).toHaveLength(0);

    socket.receive({ ...status, qualityPreference: true });
    await vi.waitFor(() => expect(qualityControls()).toHaveLength(1));
    expect(qualityControls()[0]).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      maxHeight: 1080, maxFps: 30, maxBitrateBps: 0, priority: 'framerate',
    });
    // Repeated status frames do not resend an unchanged preference.
    socket.receive({ ...status, qualityPreference: true });
    expect(qualityControls()).toHaveLength(1);

    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    expect(statsTick).toBeTypeOf('function');
    // 2 Mbps arriving, but every frame waits 400 ms in the jitter buffer.
    const sample = async (i: number, bufferPerFrameS: number) => {
      now = i * 1_000;
      peer.stats = [
        {
          type: 'inbound-rtp', kind: 'video', bytesReceived: i * 250_000, timestamp: now,
          frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30,
          jitterBufferDelay: i * 30 * bufferPerFrameS, jitterBufferEmittedCount: i * 30,
        },
        { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.02 },
      ];
      statsTick();
      // Stats collection is asynchronous; let each sample land in order.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    for (let i = 1; i <= 6; i += 1) await sample(i, 0.4);
    await vi.waitFor(() => expect(qualityControls().length).toBeGreaterThanOrEqual(2));
    const eased = qualityControls()[1]!;
    expect(eased.maxBitrateBps).toBe(1_200_000);
    expect(eased).toMatchObject({ maxHeight: 1080, maxFps: 30, priority: 'framerate' });

    // A hand-tuned custom preference is respected as is: no guard ceiling.
    const custom = { maxHeight: 1440, maxFps: 60, maxBitrateBps: 8_000_000, priority: 'resolution' } as const;
    expect(client.setQualityPreference(custom, { latencyGuard: false })).toBe(true);
    expect(qualityControls().at(-1)).toMatchObject(custom);
    const sentAfterCustom = qualityControls().length;
    for (let i = 7; i <= 12; i += 1) await sample(i, 0.4);
    expect(qualityControls()).toHaveLength(sentAfterCustom);

    // Ultra reaches a worker without `qualityUltra` as what it accepts...
    const ultra = { maxHeight: 2160, maxFps: 30, maxBitrateBps: 30_000_000, priority: 'resolution' } as const;
    expect(client.setQualityPreference(ultra, { latencyGuard: false })).toBe(true);
    expect(qualityControls().at(-1)).toMatchObject({ maxHeight: 0, maxBitrateBps: 0, priority: 'resolution' });
    // ...and as itself, immediately, once the worker says it takes it.
    socket.receive({ ...status, qualityPreference: true, qualityUltra: true });
    await vi.waitFor(() => expect(qualityControls().at(-1)).toMatchObject(ultra));
    client.stop();
  });

  it('measures resolution, FPS, bitrate and round trip in the browser when the worker reports no quality', async () => {
    // macOS and Linux workers send no QUALITY frames; the footer must still show
    // speed, frame rate and latency, measured from the browser's own stats.
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-mac', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-browser-quality',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_browserq1',
      capability: 'b'.repeat(43),
      expiresAt: 60_000,
      leaseExpiresAt: 15_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: [],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    // Before the first frame has a size there is nothing to show.
    peer.stats = [{ type: 'inbound-rtp', kind: 'video', bytesReceived: 0, timestamp: 0 }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    expect(statsTick).toBeTypeOf('function');
    await vi.waitFor(() => expect(client.current().durationMs).toBeDefined());
    expect(client.current().quality).toBeUndefined();

    now = 1_000;
    peer.stats = [
      {
        type: 'inbound-rtp', kind: 'video', bytesReceived: 500_000, timestamp: 1_000,
        frameWidth: 2560, frameHeight: 1440, framesPerSecond: 24, framesDropped: 2,
      },
      { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.045 },
    ];
    statsTick();
    now = 2_000;
    peer.stats = [
      {
        type: 'inbound-rtp', kind: 'video', bytesReceived: 900_000, timestamp: 2_000,
        frameWidth: 2560, frameHeight: 1440, framesPerSecond: 24, framesDropped: 2,
      },
      { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.045 },
    ];
    statsTick();
    await vi.waitFor(() => expect(client.current().quality?.bitrateBps).toBeGreaterThan(0));
    expect(client.current().quality).toMatchObject({
      width: 2560, height: 1440, fps: 24, droppedFrames: 2, rttMs: 45,
    });
    expect(client.current().quality?.encoderClass).toBeUndefined();
    expect(client.current().quality?.preset).toBeUndefined();
    client.stop();
  });

  it('ICE-restarts a foreground media stall but pauses the watchdog while hidden', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    let visible = true;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-media-watchdog',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => visible,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_watchdog1',
      capability: 'w'.repeat(43),
      expiresAt: 60_000,
      leaseExpiresAt: 15_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: [],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_watchdog1',
      sequence: 1,
      preset: '720p30',
      encoderClass: 'hardware',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateBps: 3_000_000,
      droppedFrames: 0,
      rttMs: 1,
    });
    peer.stats = [{
      type: 'inbound-rtp', kind: 'video', bytesReceived: 1_000, timestamp: 1_000,
    }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    expect(statsTick).toBeTypeOf('function');
    await vi.waitFor(() => expect(client.current().quality?.bitrateBps).toBe(3_000_000));

    visible = false;
    now = 30_000;
    statsTick();
    await vi.waitFor(() => expect(client.current().state).not.toBe(REMOTE_DESKTOP_STATE.FAILED));

    visible = true;
    now = 31_000;
    statsTick();
    await vi.waitFor(() => expect(client.current().state).not.toBe(REMOTE_DESKTOP_STATE.FAILED));
    now += REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS;
    statsTick();
    await vi.waitFor(() => expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      inputEnabled: false,
    }));
    expect(peer.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.OFFER,
      sessionId: 'session_watchdog1',
    }));
    intervalSpy.mockRestore();
  });

  it('reads Server deadlines on the Server clock when the browser clock is minutes ahead', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    // The browser clock runs ten minutes ahead of the Server.
    const skew = 10 * 60_000;
    let now = skew + 1_000;
    const client = new RemoteDesktopClient('controlled-mac', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-clock-skew',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_clockskew',
      capability: 'k'.repeat(43),
      serverTime: 1_000,
      expiresAt: 61_000,
      leaseExpiresAt: 16_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: [],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_clockskew',
      sequence: 1,
      preset: '720p30',
      encoderClass: 'hardware',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateBps: 3_000_000,
      droppedFrames: 0,
      rttMs: 1,
    });
    peer.stats = [{
      type: 'inbound-rtp', kind: 'video', bytesReceived: 1_000, timestamp: 1_000,
    }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    expect(statsTick).toBeTypeOf('function');
    await vi.waitFor(() => expect(client.current().quality?.bitrateBps).toBe(3_000_000));

    // Read raw, the 61 s deadline would already be ten minutes gone and the
    // stall below would fail the session instead of restarting ICE.
    now += REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS;
    statsTick();
    await vi.waitFor(() => expect(client.current().state).toBe(REMOTE_DESKTOP_STATE.RECONNECTING));
    expect(peer.offerOptions.at(-1)).toEqual({ iceRestart: true });
    intervalSpy.mockRestore();
  });

  it('waits out a slow first frame then recovers an established stream in place', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-first-media',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_firstmed',
      capability: 'f'.repeat(43),
      expiresAt: 60_000,
      leaseExpiresAt: 15_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_firstmed',
      sequence: 1,
      preset: '720p30',
      encoderClass: 'hardware',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateBps: 3_000_000,
      droppedFrames: 0,
      rttMs: 1,
    });
    // An inbound-rtp report exists as soon as the transceiver does, pinned at
    // zero bytes: this is a relayed path still setting up, not a dead peer.
    peer.stats = [{
      type: 'inbound-rtp', kind: 'video', bytesReceived: 0, timestamp: 1_000,
    }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    expect(statsTick).toBeTypeOf('function');

    // Well past the stall window, which used to kill exactly this connection.
    for (const at of [1_000, 5_000, REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS + 4_000]) {
      now = at;
      statsTick();
      await Promise.resolve();
      expect(client.current().state).not.toBe(REMOTE_DESKTOP_STATE.FAILED);
    }

    // Media arrives late and the session simply continues.
    peer.stats = [{
      type: 'inbound-rtp', kind: 'video', bytesReceived: 12_000, timestamp: 20_000,
    }];
    now = REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS + 6_000;
    statsTick();
    await vi.waitFor(() => expect(client.current().quality?.bitrateBps).toBeGreaterThan(0));
    expect(client.current().state).not.toBe(REMOTE_DESKTOP_STATE.FAILED);

    // Once started, a stall is a weak-network recovery signal rather than a
    // reason to discard the peer and make the user start the whole flow over.
    now += REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS + 1_000;
    statsTick();
    await vi.waitFor(() => expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      inputEnabled: false,
    }));
    expect(peer.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(client.current().terminalReason).toBeUndefined();
    intervalSpy.mockRestore();
  });

  it('gives up on a peer that never delivers a first frame at all', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-no-media',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_nomedia1',
      capability: 'n'.repeat(43),
      expiresAt: 600_000,
      leaseExpiresAt: 150_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_nomedia1',
      sequence: 1,
      preset: '720p30',
      encoderClass: 'hardware',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateBps: 3_000_000,
      droppedFrames: 0,
      rttMs: 1,
    });
    peer.stats = [{
      type: 'inbound-rtp', kind: 'video', bytesReceived: 0, timestamp: 1_000,
    }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    now = 1_000;
    statsTick();
    await Promise.resolve();
    now = 1_000 + REMOTE_DESKTOP_LIMITS.FIRST_MEDIA_TIMEOUT_MS;
    statsTick();
    await vi.waitFor(() => expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.FAILED,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
    }));
    intervalSpy.mockRestore();
  });

  it('re-arms the frame acknowledgement when the node says it is waiting for one', async () => {
    // Input goes off across a desktop switch and only returns once a frame of
    // the new layout is acknowledged. If this client has nothing queued to
    // acknowledge with, it would stay off for the rest of the session — which
    // is a whole toolbar greyed out with no way back.
    let socket!: FakeSocket;
    let peer!: FakePeer;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-rearm',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_rearm123',
      capability: 'r'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.open();
    peer.channels.get(REMOTE_DESKTOP_CHANNEL.KEYBOARD)!.open();
    peer.channels.get(REMOTE_DESKTOP_CHANNEL.POINTER)!.open();
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: authority.sessionId,
      sequence: 1,
      layoutRevision: 1,
      displays: [{
        id: 'display_rearm001',
        label: 'DISPLAY1',
        primary: true,
        available: true,
        width: 1920,
        height: 1080,
        dpiScale: 1,
        rotation: 0,
      }],
      selectedDisplayId: 'display_rearm001',
    });
    // Consume the queued acknowledgement, as a rendered frame does.
    expect(client.acknowledgePresentedFrame(1920, 1080)).toBe(true);
    const sentBefore = control.sent.length;

    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display_rearm001',
      layoutRevision: 1,
      inputEnabled: false,
      inputBlocked: REMOTE_DESKTOP_INPUT_BLOCKED.AWAITING_FRAME,
    });
    await vi.waitFor(() => expect(client.current().inputBlocked)
      .toBe(REMOTE_DESKTOP_INPUT_BLOCKED.AWAITING_FRAME));
    // Re-armed: the next rendered frame can answer the node again.
    expect(client.acknowledgePresentedFrame(1920, 1080)).toBe(true);
    expect(control.sent.length).toBeGreaterThan(sentBefore);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      kind: REMOTE_DESKTOP_CONTROL_KIND.FRAME_PRESENTED,
      displayId: 'display_rearm001',
    });
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('keeps the remote cursor following when frame callbacks never fire', async () => {
    // The remote cursor only ever moved when a click carried a position with
    // it. Moves are coalesced behind a frame callback and sent on a channel
    // that may drop them, so neither can be the only path: a window whose
    // frame callbacks are throttled away must still send, and the reliable
    // mirror is what makes following visible at all on a lossy link.
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-follow',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      // A frame callback that is scheduled and never runs.
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: vi.fn(),
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_follow01',
      capability: 'f'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: 600_000,
      leaseExpiresAt: 150_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    const pointer = peer.channels.get(REMOTE_DESKTOP_CHANNEL.POINTER)!;
    control.open();
    peer.channels.get(REMOTE_DESKTOP_CHANNEL.KEYBOARD)!.open();
    pointer.open();
    // Channels open means the peer is connected, which is also what starts the
    // once-a-second diagnostics the footer counter is published on.
    peer.connect();
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: authority.sessionId,
      sequence: 1,
      layoutRevision: 1,
      displays: [{
        id: 'display_follow001',
        label: 'DISPLAY1',
        primary: true,
        available: true,
        width: 1920,
        height: 1080,
        dpiScale: 1,
        rotation: 0,
      }],
      selectedDisplayId: 'display_follow001',
    });
    client.acknowledgePresentedFrame(1920, 1080);
    socket.receive({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display_follow001',
      layoutRevision: 1,
      inputEnabled: true,
    });
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(true));

    const movesOn = (channel: FakeDataChannel) => channel.sent
      .map((raw) => JSON.parse(raw) as { kind?: string })
      .filter((message) => message.kind === REMOTE_DESKTOP_POINTER_KIND.MOVE).length;

    // A hover: many moves, no click, and no frame callback ever running.
    for (let step = 0; step < 10; step += 1) {
      now += 50;
      client.pointerMove(0.1 + step * 0.05, 0.5);
    }
    // Every one of them would have been swallowed while waiting for a frame.
    expect(movesOn(pointer) + movesOn(control)).toBeGreaterThan(5);
    // The reliable channel carries them, so following survives a link that
    // drops the fast path entirely.
    expect(movesOn(control)).toBeGreaterThan(5);

    // The footer counter is the only way an operator can tell "nothing is
    // being sent" from "sent and dropped", so it has to be published even
    // before there are inbound video stats to report alongside, and it has to
    // separate the two channels rather than adding them into one number.
    await vi.waitFor(() => {
      expect(client.current().pointerMovesMirrored ?? 0).toBeGreaterThan(5);
    }, { timeout: 3_000 });
    expect(client.current().pointerMovesSent).toBe(movesOn(pointer));
    expect(client.current().pointerMovesMirrored).toBe(movesOn(control));
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('denies unknown keys and secure-attention input before the DataChannel', () => {
    expect(isRemoteDesktopKeyAllowed('KeyA', { control: false, alt: false })).toBe(true);
    // Command needs to reach a macOS target as itself (remote-desktop-keyboard's
    // command bridge decides WHEN to forward it; this is just the wire allowlist,
    // which must not block it on every target the way it used to).
    expect(isRemoteDesktopKeyAllowed('MetaLeft', { control: false, alt: false })).toBe(true);
    expect(isRemoteDesktopKeyAllowed('MetaRight', { control: false, alt: false })).toBe(true);
    expect(isRemoteDesktopKeyAllowed('Delete', { control: true, alt: true })).toBe(false);
    expect(isRemoteDesktopKeyAllowed('FutureKey', { control: false, alt: false })).toBe(false);
  });

  it('fails closed when asynchronous WebRTC signaling rejects', async () => {
    let socket!: FakeSocket;
    let peer!: FakePeer;
    const client = new RemoteDesktopClient('controlled-win', {
      onSnapshot: vi.fn(),
    }, {
      fetchTicket: async () => 'ticket-1',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_abcdefgh',
      capability: 'b'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 8,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: [],
    });
    await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw).type))
      .toContain(REMOTE_DESKTOP_MSG.OFFER));

    peer.failRemoteDescription = true;
    socket.receive({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      ...authority,
      sdp: 'v=0\r\n',
    });
    await vi.waitFor(() => expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.FAILED,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR,
    }));
  });

  // tsk_4d0: 527ca1bda gave weak networks in-place ICE recovery, but its
  // per-incident budgets are session-lifetime counters. A connection that
  // recovers successfully never gets its budget back, so a long, healthy
  // session is eventually torn down by its own recovery guard.
  it('restores the ICE recovery budget after each successful in-place recovery', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-budget',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_budget01',
      capability: 'b'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: 3_600_000,
      leaseExpiresAt: 3_600_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());

    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_budget01',
      sequence: 1,
      preset: '720p30',
      encoderClass: 'hardware',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateBps: 3_000_000,
      droppedFrames: 0,
      rttMs: 1,
    });
    let bytes = 10_000;
    peer.stats = [{ type: 'inbound-rtp', kind: 'video', bytesReceived: bytes, timestamp: 1_000 }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    expect(statsTick).toBeTypeOf('function');
    now = 1_000;
    statsTick();
    await Promise.resolve();

    // Every one of these stalls is a *recovered* incident: the restart is
    // answered and media resumes. One more than the budget proves the budget
    // is per-incident rather than per-session.
    for (let attempt = 1; attempt <= REMOTE_DESKTOP_LIMITS.MAX_ICE_RESTARTS + 1; attempt++) {
      now += REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS + 1_000;
      statsTick();
      await vi.waitFor(() => expect(peer.offerOptions).toHaveLength(attempt + 1));
      expect(peer.offerOptions.at(-1)).toEqual({ iceRestart: true });
      expect(client.current().terminalReason).toBeUndefined();
      expect(client.current().state).not.toBe(REMOTE_DESKTOP_STATE.FAILED);

      socket.receive({ type: REMOTE_DESKTOP_MSG.ANSWER, ...authority, sdp: `v=0\r\nrecovered-${attempt}` });
      await vi.waitFor(() => expect(peer.remoteDescription?.sdp).toContain(`recovered-${attempt}`));
      peer.connect();
      bytes += 10_000;
      now += 1_000;
      peer.stats = [{ type: 'inbound-rtp', kind: 'video', bytesReceived: bytes, timestamp: now }];
      statsTick();
      await Promise.resolve();
      expect(client.current().state).not.toBe(REMOTE_DESKTOP_STATE.FAILED);
    }
    intervalSpy.mockRestore();
  });

  // The ICE-candidate flood cap is a per-negotiation guard: `renegotiate()`
  // already rezeroes it for each new generation. The client-initiated restart
  // path does not, so candidates accumulate across generations until a
  // perfectly healthy peer is failed with protocol_error.
  it('counts the ICE candidate flood cap per negotiation generation, not per session', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-flood',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_flood001',
      capability: 'c'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: 3_600_000,
      leaseExpiresAt: 3_600_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_flood001',
      sequence: 1,
      preset: '720p30',
      encoderClass: 'hardware',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateBps: 3_000_000,
      droppedFrames: 0,
      rttMs: 1,
    });
    await vi.waitFor(() => expect(socket.sent.filter((raw) => (
      JSON.parse(raw).type === REMOTE_DESKTOP_MSG.OFFER
    ))).toHaveLength(1));
    socket.receive({ type: REMOTE_DESKTOP_MSG.ANSWER, ...authority, sdp: 'v=0\r\ngen-1' });
    await vi.waitFor(() => expect(peer.remoteDescription?.sdp).toContain('gen-1'));

    peer.stats = [{ type: 'inbound-rtp', kind: 'video', bytesReceived: 10_000, timestamp: 1_000 }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    now = 1_000;
    statsTick();
    await Promise.resolve();

    // A busy but legal first generation, comfortably under the cap.
    const firstGeneration = REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES - 8;
    for (let i = 0; i < firstGeneration; i++) {
      socket.receive({ type: REMOTE_DESKTOP_MSG.ICE, ...authority, candidate: `candidate:gen1-${i}`, mid: '0' });
    }
    await vi.waitFor(() => expect(peer.candidates.length).toBe(firstGeneration));
    expect(client.current().terminalReason).toBeUndefined();

    // Weak network: one in-place restart opens a brand new ICE generation.
    now += REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS + 1_000;
    statsTick();
    await vi.waitFor(() => expect(peer.offerOptions).toHaveLength(2));
    socket.receive({ type: REMOTE_DESKTOP_MSG.ANSWER, ...authority, sdp: 'v=0\r\ngen-2' });
    await vi.waitFor(() => expect(peer.remoteDescription?.sdp).toContain('gen-2'));
    peer.connect();

    // The replacement generation re-gathers its own candidates. They must be
    // counted against a fresh budget, exactly as `renegotiate()` does.
    for (let i = 0; i < 16; i++) {
      socket.receive({ type: REMOTE_DESKTOP_MSG.ICE, ...authority, candidate: `candidate:gen2-${i}`, mid: '0' });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(client.current().terminalReason).toBeUndefined();
    expect(client.current().state).not.toBe(REMOTE_DESKTOP_STATE.FAILED);
    intervalSpy.mockRestore();
  });


  // The budget is earned back by recovering, not merely by ticking. A tab that
  // is hidden and shown again clears the progress clock without any media
  // arriving, and that must not hand a dead peer a fresh set of restarts.
  it('keeps failing closed when restarts never actually restore media', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    let visible = true;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-failclosed',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => visible,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_failclos',
      capability: 'd'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: 3_600_000,
      leaseExpiresAt: 3_600_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_failclos',
      sequence: 1,
      preset: '720p30',
      encoderClass: 'hardware',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateBps: 3_000_000,
      droppedFrames: 0,
      rttMs: 1,
    });

    // Media starts once and then stops for good.
    peer.stats = [{ type: 'inbound-rtp', kind: 'video', bytesReceived: 10_000, timestamp: 1_000 }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    now = 1_000;
    statsTick();
    await Promise.resolve();

    // Spend the whole budget without a single byte of recovered media.
    for (let attempt = 1; attempt <= REMOTE_DESKTOP_LIMITS.MAX_ICE_RESTARTS; attempt++) {
      now += REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS + 1_000;
      statsTick();
      await vi.waitFor(() => expect(peer.offerOptions).toHaveLength(attempt + 1));
      peer.connect();
      await Promise.resolve();
    }
    expect(client.current().terminalReason).toBeUndefined();

    // Hide and reveal the tab. This clears the media progress clock, but no
    // media has arrived, so it is not evidence of recovery.
    visible = false;
    now += 1_000;
    statsTick();
    await Promise.resolve();
    visible = true;
    now += 1_000;
    statsTick();
    await Promise.resolve();

    // The peer is still dead, and the exhausted budget must stay exhausted.
    now += REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS + 1_000;
    statsTick();
    await vi.waitFor(() => expect(client.current()).toMatchObject({
      state: REMOTE_DESKTOP_STATE.FAILED,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
    }));
    expect(peer.offerOptions).toHaveLength(REMOTE_DESKTOP_LIMITS.MAX_ICE_RESTARTS + 1);
    intervalSpy.mockRestore();
  });

})

  // tsk_4d0 R3. The remote flood cap has a per-generation regression test, but
  // the LOCAL counter is incremented on a different path -- the peer's own
  // `icecandidate` events -- and had none. A restart that rezeroes only the
  // remote counter still fails a healthy recovering peer with protocol_error
  // once its own re-gathered candidates push the lifetime total past the cap.
  it('counts locally gathered ICE candidates per generation, not per session', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    let now = 0;
    const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
      fetchTicket: async () => 'ticket-local-flood',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      now: () => now,
      isDocumentVisible: () => true,
    });

    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    const authority = {
      requestId: start.requestId,
      sessionId: 'session_locflood',
      capability: 'e'.repeat(43),
    };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      expiresAt: 3_600_000,
      leaseExpiresAt: 3_600_000,
      daemonGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(peer).toBeDefined());
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_locflood',
      sequence: 1,
      preset: '720p30',
      encoderClass: 'hardware',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateBps: 3_000_000,
      droppedFrames: 0,
      rttMs: 1,
    });
    await vi.waitFor(() => expect(socket.sent.filter((raw) => (
      JSON.parse(raw).type === REMOTE_DESKTOP_MSG.OFFER
    ))).toHaveLength(1));
    socket.receive({ type: REMOTE_DESKTOP_MSG.ANSWER, ...authority, sdp: 'v=0\\r\\nlocal-gen-1' });
    await vi.waitFor(() => expect(peer.remoteDescription?.sdp).toContain('local-gen-1'));

    peer.stats = [{ type: 'inbound-rtp', kind: 'video', bytesReceived: 10_000, timestamp: 1_000 }];
    peer.connect();
    const statsTick = intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0] as (() => void);
    now = 1_000;
    statsTick();
    await Promise.resolve();

    const iceSent = () => socket.sent.filter((raw) => JSON.parse(raw).type === REMOTE_DESKTOP_MSG.ICE).length;

    // Generation 1: busy but legal, comfortably under the cap.
    const firstGeneration = REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES - 8;
    for (let i = 0; i < firstGeneration; i++) peer.emitLocalCandidate(`candidate:local-gen1-${i}`);
    // Every one was really relayed, so the counter was really exercised: this
    // is what keeps the assertion below from passing against a dropped event.
    expect(iceSent()).toBe(firstGeneration);
    expect(client.current().terminalReason).toBeUndefined();

    // Weak network: one in-place restart on the SAME peer opens a new ICE
    // generation. No session rebuild -- the peer object must be preserved.
    const peerBeforeRestart = peer;
    now += REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS + 1_000;
    statsTick();
    await vi.waitFor(() => expect(peer.offerOptions).toHaveLength(2));
    expect(peer.offerOptions.at(-1)).toEqual({ iceRestart: true });
    socket.receive({ type: REMOTE_DESKTOP_MSG.ANSWER, ...authority, sdp: 'v=0\\r\\nlocal-gen-2' });
    await vi.waitFor(() => expect(peer.remoteDescription?.sdp).toContain('local-gen-2'));
    peer.connect();

    // Generation 2 stays well under the cap on its own, but the lifetime total
    // (120 + 16 = 136) exceeds MAX_ICE_CANDIDATES (128).
    const secondGeneration = 16;
    for (let i = 0; i < secondGeneration; i++) peer.emitLocalCandidate(`candidate:local-gen2-${i}`);
    expect(secondGeneration).toBeLessThan(REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES);
    expect(firstGeneration + secondGeneration).toBeGreaterThan(REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES);

    // A healthy, recovering peer must survive its own re-gathering.
    expect(client.current().terminalReason).toBeUndefined();
    expect(client.current().state).not.toBe(REMOTE_DESKTOP_STATE.FAILED);
    expect(peer).toBe(peerBeforeRestart);
    expect(iceSent()).toBe(firstGeneration + secondGeneration);
    intervalSpy.mockRestore();
  });
;

describe('RemoteDesktopClient translated shortcuts and paste', () => {
  async function inputReadyClient() {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    let socket!: FakeSocket;
    let peer!: FakePeer;
    const client = new RemoteDesktopClient('controlled-linux', { onSnapshot: () => {} }, {
      fetchTicket: async () => 'ticket-1',
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      createPeer: () => {
        peer = new FakePeer();
        return peer as unknown as RTCPeerConnection;
      },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: vi.fn(),
      now: () => 0,
    });
    await client.start();
    const start = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    });
    await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw).type)).toContain(REMOTE_DESKTOP_MSG.OFFER));
    const control = peer.channels.get(REMOTE_DESKTOP_CHANNEL.CONTROL)!;
    const keyboard = peer.channels.get(REMOTE_DESKTOP_CHANNEL.KEYBOARD)!;
    control.open();
    keyboard.open();
    peer.channels.get(REMOTE_DESKTOP_CHANNEL.POINTER)!.open();
    const keepalive = intervalSpy.mock.calls.find((call) => (
      call[1] === REMOTE_DESKTOP_LIMITS.DATA_KEEPALIVE_INTERVAL_MS
    ))![0] as () => void;
    intervalSpy.mockRestore();
    keepalive();
    control.receive({
      type: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: 'session_12345678',
      sequence: 1,
      layoutRevision: 1,
      displays: [{
        id: 'display_initial1', label: 'DISPLAY1', primary: true, available: true,
        width: 1920, height: 1080, dpiScale: 1, rotation: 0,
      }],
      selectedDisplayId: 'display_initial1',
    });
    const status = {
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId: start.requestId,
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display_initial1',
      layoutRevision: 1,
      inputEnabled: true,
      viewerCount: 1,
      controllerCount: 1,
    } as const;
    socket.receive(status);
    keepalive();
    socket.receive(status);
    client.acknowledgePresentedFrame(1920, 1080);
    socket.receive(status);
    await vi.waitFor(() => expect(client.current().inputEnabled).toBe(true));
    keyboard.sent.length = 0;
    control.sent.length = 0;
    // What reached the remote keyboard, as `down Code` / `up Code` / `text ...`.
    const typed = () => keyboard.sent.splice(0).map((raw) => {
      const message = JSON.parse(raw) as { kind: string; code?: string; text?: string };
      if (message.kind === 'text') return `text ${message.text}`;
      return `${message.kind === 'key_down' ? 'down' : 'up'} ${message.code}`;
    });
    return { client, control, keyboard, typed };
  }

  const released = { control: false, alt: false };

  it('taps a translated chord with only its own modifiers, then puts the held one back for the next key', async () => {
    const { client, typed } = await inputReadyClient();
    // A Mac operator's Command, forwarded to a PC target as Control.
    expect(client.key('ControlLeft', 'Control', true, false, { control: true, alt: false })).toBe(true);
    // Command+Left means Home on a PC -- not Control+Home.
    expect(client.tapChords([[{ code: 'Home', key: 'Home' }]])).toBe(true);
    expect(typed()).toEqual(['down ControlLeft', 'up ControlLeft', 'down Home', 'up Home']);
    // Still holding Command, the operator presses A: Control goes back down first.
    expect(client.key('KeyA', 'a', true, false, { control: true, alt: false })).toBe(true);
    expect(typed()).toEqual(['down ControlLeft', 'down KeyA']);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('never releases a held Alt on its own, and has nothing left to send when it is let go', async () => {
    const { client, typed } = await inputReadyClient();
    // A Mac operator's Option, which is Alt on a PC target.
    client.key('AltLeft', 'Alt', true, false, { control: false, alt: true });
    typed();
    // Option+Left is Control+Left there. Control goes down BEFORE Alt comes up:
    // an Alt pressed and released with nothing in between opens the menu bar.
    expect(client.tapChords([[{ code: 'ControlLeft', key: 'Control' }, { code: 'ArrowLeft', key: 'ArrowLeft' }]]))
      .toBe(true);
    expect(typed()).toEqual([
      'down ControlLeft', 'up AltLeft', 'down ArrowLeft', 'up ArrowLeft', 'up ControlLeft',
    ]);
    // Releasing Option afterwards must not send a lone Alt release.
    expect(client.key('AltLeft', 'Alt', false, false, released)).toBe(true);
    expect(typed()).toEqual([]);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('keeps a held modifier the chord wants, and taps multi-chord sequences in order', async () => {
    const { client, typed } = await inputReadyClient();
    client.key('ControlLeft', 'Control', true, false, { control: true, alt: false });
    client.key('ShiftLeft', 'Shift', true, false, { control: true, alt: false });
    typed();
    // Command+Shift+Left: select to the line start, keeping the held Shift.
    client.tapChords([[{ code: 'ShiftLeft', key: 'Shift' }, { code: 'Home', key: 'Home' }]]);
    expect(typed()).toEqual(['up ControlLeft', 'down Home', 'up Home']);
    client.key('ShiftLeft', 'Shift', false, false, released);
    typed();
    // Command+Backspace: delete to the line start as two chords.
    client.tapChords([
      [{ code: 'ShiftLeft', key: 'Shift' }, { code: 'Home', key: 'Home' }],
      [{ code: 'Backspace', key: 'Backspace' }],
    ]);
    expect(typed()).toEqual([
      'down ShiftLeft', 'down Home', 'up Home', 'up ShiftLeft', 'down Backspace', 'up Backspace',
    ]);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('types pasted text with the paste shortcut\'s Control or Command lifted', async () => {
    const { client, typed } = await inputReadyClient();
    // Command on a Mac target stays Command; typed underneath it, "hello"
    // would be Command+H (hide) and friends.
    client.key('MetaLeft', 'Meta', true, false, released);
    client.key('ShiftLeft', 'Shift', true, false, released);
    typed();
    expect(client.text('hello')).toBe(true);
    expect(typed()).toEqual(['up MetaLeft', 'text hello']);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('does not put a lifted modifier back down once the browser reports it released', async () => {
    const { client, typed } = await inputReadyClient();
    // Command held on a Mac target, lifted for pasted text.
    client.key('MetaLeft', 'Meta', true, false, released);
    typed();
    expect(client.text('hello')).toBe(true);
    typed();
    // Command's key-up was swallowed (e.g. by a system shortcut), so the
    // viewer never saw it; the next key event reports Meta up.
    client.reconcileModifiers({ control: false, alt: false, shift: false, meta: false }, 'KeyA');
    expect(client.key('KeyA', 'a', true, false, released)).toBe(true);
    // Plain "a", not Command+A.
    expect(typed()).toEqual(['down KeyA']);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('puts a lifted modifier back down before a click', async () => {
    const { client, control, typed } = await inputReadyClient();
    client.key('ControlLeft', 'Control', true, false, { control: true, alt: false });
    client.tapChords([[{ code: 'End', key: 'End' }]]);
    typed();
    // Still holding Command: the click is a Control+click on the PC.
    expect(client.pointerButton('left', true, 0.5, 0.5)).toBe(true);
    expect(typed()).toEqual(['down ControlLeft']);
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      kind: REMOTE_DESKTOP_POINTER_KIND.BUTTON_DOWN,
    });
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });

  it('releases everything when a chord cannot be delivered whole', async () => {
    const { client, control, keyboard, typed } = await inputReadyClient();
    client.key('ControlLeft', 'Control', true, false, { control: true, alt: false });
    typed();
    keyboard.failNextSend = true;
    expect(client.tapChords([[{ code: 'Home', key: 'Home' }]])).toBe(false);
    expect(control.sent.map((raw) => JSON.parse(raw).type)).toContain(REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL);
    client.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
  });
});


// Gathering ends with an EMPTY candidate line and then a null event. Firefox
// emits both (measured on Firefox 156), Chromium only the null one, and the
// empty one is not a candidate: the server refused it as a malformed message
// and stopped the session with `invalid_request` -- every Firefox session,
// on every host, the moment gathering finished.
it('never sends the end-of-candidates marker as a candidate', async () => {
  let socket!: FakeSocket;
  let peer!: FakePeer;
  const client = new RemoteDesktopClient('controlled-win', { onSnapshot: vi.fn() }, {
    fetchTicket: async () => 'ticket-end-of-candidates',
    createSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    },
    createPeer: () => {
      peer = new FakePeer();
      return peer as unknown as RTCPeerConnection;
    },
    isDocumentVisible: () => true,
  });

  await client.start();
  const start = JSON.parse(socket.sent[0]!) as { requestId: string };
  const authority = {
    requestId: start.requestId,
    sessionId: 'session_endofcands',
    capability: 'f'.repeat(43),
  };
  socket.receive({
    type: REMOTE_DESKTOP_MSG.AUTHORIZED,
    ...authority,
    expiresAt: 3_600_000,
    leaseExpiresAt: 3_600_000,
    daemonGeneration: 1,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    inputEpoch: 1,
    iceServers: ['stun:stun.example.test:3478'],
  });
  await vi.waitFor(() => expect(peer).toBeDefined());

  const iceMessages = () => socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; candidate?: string })
    .filter((message) => message.type === REMOTE_DESKTOP_MSG.ICE);

  peer.emitLocalCandidate('');
  expect(iceMessages()).toHaveLength(0);

  peer.emitLocalCandidate('candidate:real 1 UDP 1 10.0.0.1 1 typ host');
  expect(iceMessages().map((message) => message.candidate))
    .toEqual(['candidate:real 1 UDP 1 10.0.0.1 1 typ host']);

  // The null event that follows the marker is not a candidate either.
  peer.emitEndOfCandidates();
  expect(iceMessages()).toHaveLength(1);

  // Cross-tier lock: every message this client actually put on the wire has
  // to pass the SAME contract the server validates with, or the server ends
  // the session as malformed. Tightening either side alone fails here.
  for (const message of socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)) {
    expect(validateRemoteDesktopBrowserMessage(message).ok, JSON.stringify(message)).toBe(true);
  }
});

// The other half of the same lock, and the half that protects a browser still
// running an older bundle: the contract must accept the marker even though
// this client no longer sends it, so an already-open page cannot terminate
// its own session by finishing ICE gathering.
it('keeps the contract open to an end-of-candidates marker from any client', () => {
  const correlation = {
    requestId: 'b'.repeat(32),
    sessionId: 'g'.repeat(43),
    capability: 'h'.repeat(43),
  };
  expect(validateRemoteDesktopBrowserMessage({
    type: REMOTE_DESKTOP_MSG.ICE, ...correlation, candidate: '', mid: '0',
  }).ok).toBe(true);
});
