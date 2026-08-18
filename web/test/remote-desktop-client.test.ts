import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_CONTROL_KIND,
  REMOTE_DESKTOP_CONTROL_REJECTION,
  REMOTE_DESKTOP_DATA_MSG,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_POINTER_KIND,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '@shared/remote-desktop.js';
import {
  RemoteDesktopClient,
  chunkRemoteDesktopText,
  isRemoteDesktopKeyAllowed,
} from '../src/remote-desktop-client.js';

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
  channels = new Map<string, FakeDataChannel>();
  candidates: RTCIceCandidateInit[] = [];
  failRemoteDescription = false;
  stats: Array<Record<string, unknown>> = [];
  offerOptions: Array<RTCOfferOptions | undefined> = [];

  addTransceiver(): RTCRtpTransceiver {
    return { setCodecPreferences: vi.fn() } as unknown as RTCRtpTransceiver;
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
  connect(): void {
    this.connectionState = 'connected';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  close(): void { this.connectionState = 'closed'; }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
});

describe('RemoteDesktopClient', () => {
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
    client.releasePointerButtons();
    expect(JSON.parse(control.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      kind: REMOTE_DESKTOP_POINTER_KIND.BUTTON_UP,
      button: 'left',
    });
    expect(client.key('ControlLeft', 'Control', false, false, { control: false, alt: false })).toBe(true);

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
    expect(control.sent).toHaveLength(reliableBeforeBackpressure);

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
    expect(timeoutSpy.mock.calls.some((call) => call[1] === 5_000)).toBe(true);
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
    client.stop();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.STOP,
      aggregateBytesReceived: 54_321,
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

  it('rebuilds the peer on the same grant when the node hands the session to another desktop', async () => {
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

    socket.receive({ type: REMOTE_DESKTOP_MSG.RENEGOTIATE, ...authority });

    // A second peer is built and a second offer sent under the same grant: the
    // session is never failed, so the viewer keeps it without pressing Retry.
    await vi.waitFor(() => expect(peers).toHaveLength(2));
    const sentOffers = () => socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; sessionId?: string; capability?: string })
      .filter((message) => message.type === REMOTE_DESKTOP_MSG.OFFER);
    await vi.waitFor(() => expect(sentOffers()).toHaveLength(2));
    const offers = sentOffers();
    expect(offers[1]).toMatchObject({
      sessionId: authority.sessionId,
      capability: authority.capability,
    });
    expect(snapshots.some((snapshot) => snapshot.state === REMOTE_DESKTOP_STATE.FAILED)).toBe(false);
    expect(snapshots.some((snapshot) => snapshot.state === REMOTE_DESKTOP_STATE.RECONNECTING)).toBe(true);
    client.stop();
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
    client.stop();
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
    client.stop();
  });

  it('fails a foreground media stall but pauses the watchdog while the page is hidden', async () => {
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
      state: REMOTE_DESKTOP_STATE.FAILED,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
      inputEnabled: false,
    }));
    intervalSpy.mockRestore();
  });

  it('denies unknown keys and secure-attention input before the DataChannel', () => {
    expect(isRemoteDesktopKeyAllowed('KeyA', { control: false, alt: false })).toBe(true);
    expect(isRemoteDesktopKeyAllowed('MetaLeft', { control: false, alt: false })).toBe(false);
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
});
