import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_COMMON_DISPLAY_MODES,
  REMOTE_DESKTOP_CONTROL_KIND,
  REMOTE_DESKTOP_DATA_MSG,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_KEYBOARD_KIND,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_POINTER_KIND,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_SERVER_ID_QUERY,
  REMOTE_DESKTOP_SIGNALING_PATH,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
  isRemoteDesktopPresentedFrameCompatible,
  validateRemoteDesktopAuthorized,
  validateRemoteDesktopDataMessage,
  validateRemoteDesktopServerMessage,
  type RemoteDesktopAccessMode,
  type RemoteDesktopDisplay,
  type RemoteDesktopQuality,
  type RemoteDesktopRoute,
  type RemoteDesktopServerMessage,
  type RemoteDesktopState,
} from '@shared/remote-desktop.js';
import { PendingWebRtcCandidates, toWebRtcIceServers } from '@shared/webrtc-connectivity.js';
import { apiFetch, getApiBaseUrl } from './api.js';

const DATA_BUFFER_HIGH_WATER_BYTES = 256 * 1024;
const DATA_BUFFER_LOW_WATER_BYTES = 64 * 1024;
// Let the server own the authoritative negotiation deadline and reason.  The
// browser guard is only a final escape hatch if that terminal frame is lost.
const START_TIMEOUT_MS = REMOTE_DESKTOP_LIMITS.NEGOTIATION_TIMEOUT_MS + 5_000;
const INPUT_ACK_TIMEOUT_MS = 3_000;
const LAYOUT_TRANSITION_TIMEOUT_MS = 5_000;

export interface RemoteDesktopSnapshot {
  state: RemoteDesktopState;
  mode: RemoteDesktopAccessMode;
  inputEpoch: number;
  inputEnabled: boolean;
  route?: RemoteDesktopRoute;
  displays: RemoteDesktopDisplay[];
  selectedDisplayId?: string;
  layoutRevision: number;
  quality?: Omit<RemoteDesktopQuality, 'type' | 'protocolVersion' | 'sessionId' | 'sequence'>;
  stream: MediaStream | null;
  terminalReason?: string;
  error?: string;
  viewerCount?: number;
  controllerCount?: number;
  lastAcknowledgedInputSequence?: number;
  durationMs?: number;
  reconnectCount?: number;
  capabilityVersion?: string;
}

export interface RemoteDesktopClientHooks {
  onSnapshot(snapshot: RemoteDesktopSnapshot): void;
}

export interface RemoteDesktopClientDependencies {
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  createSocket?: (url: string) => WebSocket;
  fetchTicket?: (serverId: string, signal: AbortSignal) => Promise<string>;
  now?: () => number;
  isDocumentVisible?: () => boolean;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
}

function isOpen(channel: RTCDataChannel | null): channel is RTCDataChannel {
  return channel?.readyState === 'open';
}

function randomRequestId(): string {
  return crypto.randomUUID();
}

function defaultSocketUrl(serverId: string, ticket: string): string {
  const base = getApiBaseUrl().replace(/^http/, 'ws').replace(/\/$/, '');
  const query = new URLSearchParams({
    [REMOTE_DESKTOP_SERVER_ID_QUERY]: serverId,
    ticket,
  });
  return `${base}${REMOTE_DESKTOP_SIGNALING_PATH}?${query.toString()}`;
}

async function defaultFetchTicket(serverId: string, signal: AbortSignal): Promise<string> {
  const result = await apiFetch<{ ticket: string }>('/api/auth/ws-ticket', {
    method: 'POST',
    body: JSON.stringify({ serverId }),
    signal,
  });
  if (!result || typeof result.ticket !== 'string' || result.ticket.length === 0) {
    throw new Error('remote_desktop_invalid_ticket');
  }
  return result.ticket;
}

function decodeDataChannelPayload(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return null;
  return null;
}

function h264ReceiveCodecs(): RTCRtpCodec[] | null {
  const capabilities = typeof RTCRtpReceiver !== 'undefined'
    ? RTCRtpReceiver.getCapabilities?.('video')
    : null;
  if (!capabilities) return null;
  const h264 = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264');
  if (h264.length === 0) return null;
  const recovery = capabilities.codecs.filter((codec) => (
    codec.mimeType.toLowerCase() === 'video/rtx'
    || codec.mimeType.toLowerCase() === 'video/red'
    || codec.mimeType.toLowerCase() === 'video/ulpfec'
    || codec.mimeType.toLowerCase() === 'video/flexfec-03'
  ));
  return [...h264, ...recovery];
}

export function isRemoteDesktopKeyAllowed(
  code: string,
  modifiers: { control: boolean; alt: boolean },
): boolean {
  if (!/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Backspace|Tab|Enter|Escape|Space|Delete|Insert|Home|End|PageUp|PageDown|ShiftLeft|ShiftRight|ControlLeft|ControlRight|AltLeft|AltRight|CapsLock|NumLock|ScrollLock|Semicolon|Equal|Comma|Minus|Period|Slash|Backquote|BracketLeft|Backslash|BracketRight|Quote)$/.test(code)) {
    return false;
  }
  // Windows secure attention is never synthesized. The native worker repeats
  // this denial even if a malicious browser bypasses this client check.
  return !(code === 'Delete' && modifiers.control && modifiers.alt);
}

class RemoteDesktopSignalingSocket {
  private socket: WebSocket | null = null;
  private ticketAbort: AbortController | null = null;

  constructor(private readonly deps: RemoteDesktopClientDependencies) {}

  async connect(
    serverId: string,
    onMessage: (value: unknown) => void,
    onClose: () => void,
  ): Promise<void> {
    const abort = new AbortController();
    this.ticketAbort = abort;
    const ticket = await (this.deps.fetchTicket ?? defaultFetchTicket)(serverId, abort.signal);
    if (abort.signal.aborted) throw new Error('remote_desktop_canceled');
    const socket = (this.deps.createSocket ?? ((url) => new WebSocket(url)))(defaultSocketUrl(serverId, ticket));
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close(4000, 'remote_desktop_open_timeout');
        reject(new Error('remote_desktop_open_timeout'));
      }, START_TIMEOUT_MS);
      const opened = () => {
        clearTimeout(timer);
        socket.removeEventListener('error', failed);
        resolve();
      };
      const failed = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        reject(new Error('remote_desktop_socket_failed'));
      };
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      try { onMessage(JSON.parse(event.data)); } catch { /* strict parser below */ }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      onClose();
    });
  }

  send(message: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const encoded = JSON.stringify(message);
    if (new TextEncoder().encode(encoded).byteLength > REMOTE_DESKTOP_LIMITS.SDP_BYTES) return false;
    this.socket.send(encoded);
    return true;
  }

  close(): void {
    this.ticketAbort?.abort();
    this.ticketAbort = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'remote_desktop_client_closed');
  }
}

/** Browser-side direct-first WebRTC session. Media/input never use application HTTP/WS. */
export class RemoteDesktopClient {
  private readonly signaling: RemoteDesktopSignalingSocket;
  private readonly pendingRemoteCandidates = new PendingWebRtcCandidates<RTCIceCandidateInit>();
  private peer: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private keyboardChannel: RTCDataChannel | null = null;
  private pointerChannel: RTCDataChannel | null = null;
  private requestId: string | null = null;
  private sessionId: string | null = null;
  private capability: string | null = null;
  private daemonGeneration = 0;
  private expiresAt = 0;
  private startedAt = 0;
  private stopped = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private pointerFrame: number | null = null;
  private localIceCandidates = 0;
  private remoteIceCandidates = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private dataKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private statsInFlight = false;
  private iceRestartCount = 0;
  private iceRestartInFlight = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingAnswer = false;
  private previousInboundStats: { bytes: number; timestamp: number } | null = null;
  private lastMediaBytesReceived: number | null = null;
  private lastMediaProgressAt: number | null = null;
  private aggregateBytesReceived = 0;
  private pendingInputAckSequence: number | null = null;
  private inputAckTimer: ReturnType<typeof setTimeout> | null = null;
  private layoutTransitionTimer: ReturnType<typeof setTimeout> | null = null;
  private channelsReady = false;
  private workerInputEnabled = false;
  private presentedLayoutRevision = 0;
  private presentedDisplayId: string | null = null;
  private pendingPresentedFrame: {
    layoutRevision: number;
    displayId: string;
    displayWidth: number;
    displayHeight: number;
  } | null = null;
  private pendingPointerMove: { x: number; y: number } | null = null;
  private pressedCodes = new Set<string>();
  private pressedButtons = new Set<string>();
  private snapshot: RemoteDesktopSnapshot = {
    state: REMOTE_DESKTOP_STATE.AUTHORIZING,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    inputEpoch: 0,
    inputEnabled: false,
    displays: [],
    layoutRevision: 1,
    stream: null,
    durationMs: 0,
    reconnectCount: 0,
    capabilityVersion: REMOTE_DESKTOP_CAPABILITY,
  };

  constructor(
    private readonly serverId: string,
    private readonly hooks: RemoteDesktopClientHooks,
    private readonly deps: RemoteDesktopClientDependencies = {},
  ) {
    this.signaling = new RemoteDesktopSignalingSocket(deps);
  }

  current(): Readonly<RemoteDesktopSnapshot> {
    return this.snapshot;
  }

  async start(reconnectAttempt = 0): Promise<void> {
    if (this.requestId || this.stopped) throw new Error('remote_desktop_already_started');
    this.startedAt = this.deps.now?.() ?? Date.now();
    this.publish({ state: REMOTE_DESKTOP_STATE.AUTHORIZING, durationMs: 0 });
    await this.signaling.connect(
      this.serverId,
      (value) => {
        void this.handleServer(value).catch(() => {
          this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR);
        });
      },
      () => this.fail(REMOTE_DESKTOP_TERMINAL_REASON.BROWSER_DISCONNECTED),
    );
    const requestId = randomRequestId();
    this.requestId = requestId;
    if (!this.signaling.send({
      type: REMOTE_DESKTOP_MSG.START,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      requestId,
      ...(reconnectAttempt > 0 ? { reconnectAttempt } : {}),
    })) {
      this.fail(REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE);
      return;
    }
    this.startTimer = setTimeout(() => this.fail(REMOTE_DESKTOP_ERROR.NEGOTIATION_TIMEOUT), START_TIMEOUT_MS);
  }

  setMode(mode: RemoteDesktopAccessMode): void {
    if (!this.sessionId || !this.capability || this.stopped) return;
    if (mode === REMOTE_DESKTOP_ACCESS_MODE.VIEW) {
      this.releaseAll();
      this.publish({ inputEnabled: false });
    }
    this.signaling.send({
      type: REMOTE_DESKTOP_MSG.MODE_SET,
      requestId: this.requestId,
      sessionId: this.sessionId,
      capability: this.capability,
      mode,
    });
  }

  selectDisplay(displayId: string): boolean {
    if (!this.snapshot.displays.some((display) => display.id === displayId && display.available)) return false;
    if (displayId === this.snapshot.selectedDisplayId) return true;
    this.releaseAll();
    const sent = this.sendControl({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_CONTROL_KIND.SELECT_DISPLAY,
      displayId,
    });
    if (sent) this.beginLayoutTransition();
    return sent;
  }

  setDisplayMode(displayId: string, width: number, height: number): boolean {
    const display = this.snapshot.displays.find((candidate) => (
      candidate.id === displayId && candidate.available
    ));
    if (!this.snapshot.inputEnabled
      || !display
      || !REMOTE_DESKTOP_COMMON_DISPLAY_MODES.some((mode) => (
        mode.width === width && mode.height === height
      ))) return false;
    if (display.width === width && display.height === height) return true;
    this.releaseAll();
    const sent = this.sendControl({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,
      displayId,
      width,
      height,
    });
    if (sent) {
      this.beginLayoutTransition();
    }
    return sent;
  }

  /**
   * Called only from HTMLVideoElement.requestVideoFrameCallback. Receiving
   * topology metadata is not enough: the worker accepts input only after the
   * browser has actually presented a compatible decoded frame for that exact
   * display/layout revision.
   */
  acknowledgePresentedFrame(frameWidth: number, frameHeight: number): boolean {
    const pending = this.pendingPresentedFrame;
    if (!pending || !this.channelsReady || this.stopped
      || !isRemoteDesktopPresentedFrameCompatible(
        frameWidth,
        frameHeight,
        pending.displayWidth,
        pending.displayHeight,
      )) return false;
    const sent = this.sendControl({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_CONTROL_KIND.FRAME_PRESENTED,
      displayId: pending.displayId,
      frameWidth,
      frameHeight,
    });
    if (sent) {
      this.presentedLayoutRevision = pending.layoutRevision;
      this.presentedDisplayId = pending.displayId;
      this.pendingPresentedFrame = null;
    }
    return sent;
  }

  pointerMove(x: number, y: number): void {
    if (!this.canSendInput() || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.pendingPointerMove = {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
    if (this.pointerFrame !== null) return;
    const request = this.deps.requestAnimationFrame ?? requestAnimationFrame;
    this.pointerFrame = request(() => {
      this.pointerFrame = null;
      this.flushPointerMove();
    });
  }

  pointerButton(button: 'left' | 'middle' | 'right' | 'back' | 'forward', down: boolean, x?: number, y?: number): boolean {
    if (!this.canSendInput()) return false;
    const sent = this.sendControl({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      ...this.inputBase(),
      kind: down ? REMOTE_DESKTOP_POINTER_KIND.BUTTON_DOWN : REMOTE_DESKTOP_POINTER_KIND.BUTTON_UP,
      button,
      ...(x === undefined ? {} : { x: Math.max(0, Math.min(1, x)) }),
      ...(y === undefined ? {} : { y: Math.max(0, Math.min(1, y)) }),
    });
    if (sent) {
      if (down) this.pressedButtons.add(button);
      else this.pressedButtons.delete(button);
    }
    return sent;
  }

  wheel(deltaX: number, deltaY: number, x?: number, y?: number): boolean {
    if (!this.canSendInput()) return false;
    return this.sendPointer({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_POINTER_KIND.WHEEL,
      deltaX: Math.max(-10_000, Math.min(10_000, deltaX)),
      deltaY: Math.max(-10_000, Math.min(10_000, deltaY)),
      ...(x === undefined ? {} : { x: Math.max(0, Math.min(1, x)) }),
      ...(y === undefined ? {} : { y: Math.max(0, Math.min(1, y)) }),
    });
  }

  key(code: string, key: string, down: boolean, repeat: boolean, modifiers: { control: boolean; alt: boolean }): boolean {
    if (!this.canSendInput() || !isRemoteDesktopKeyAllowed(code, modifiers)) return false;
    const sent = this.sendKeyboard({
      type: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
      ...this.inputBase(),
      kind: down ? REMOTE_DESKTOP_KEYBOARD_KIND.KEY_DOWN : REMOTE_DESKTOP_KEYBOARD_KIND.KEY_UP,
      code,
      key: key.slice(0, REMOTE_DESKTOP_LIMITS.KEY_VALUE_BYTES),
      repeat,
    });
    if (sent) {
      if (down) this.pressedCodes.add(code);
      else this.pressedCodes.delete(code);
    }
    return sent;
  }

  text(value: string): boolean {
    if (!this.canSendInput() || !value) return false;
    return this.sendKeyboard({
      type: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_KEYBOARD_KIND.TEXT,
      text: value,
    });
  }

  releaseAll(): void {
    this.pendingPointerMove = null;
    if (this.pointerFrame !== null) {
      (this.deps.cancelAnimationFrame ?? cancelAnimationFrame)(this.pointerFrame);
      this.pointerFrame = null;
    }
    if ((this.pressedCodes.size > 0 || this.pressedButtons.size > 0) && this.sessionId) {
      const sent = this.sendControl({
        type: REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL,
        ...this.inputBase(),
      });
      if (!sent) return;
    }
    this.pressedCodes.clear();
    this.pressedButtons.clear();
  }

  /** Release captured pointer buttons without disturbing held modifiers. */
  releasePointerButtons(): void {
    for (const button of [...this.pressedButtons]) {
      const sent = this.sendControl({
        type: REMOTE_DESKTOP_DATA_MSG.POINTER,
        ...this.inputBase(),
        kind: REMOTE_DESKTOP_POINTER_KIND.BUTTON_UP,
        button,
      });
      if (!sent) {
        // A selective transition could not be delivered. Fall back to the
        // idempotent worker-side ledger reset rather than leave a button held.
        this.releaseAll();
        return;
      }
      this.pressedButtons.delete(button);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.releaseAll();
    if (this.requestId && this.sessionId && this.capability) {
      this.signaling.send({
        type: REMOTE_DESKTOP_MSG.STOP,
        requestId: this.requestId,
        sessionId: this.sessionId,
        capability: this.capability,
        ...(this.aggregateBytesReceived > 0
          ? { aggregateBytesReceived: this.aggregateBytesReceived }
          : {}),
      });
    }
    this.teardown(REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_CONTROLLER);
  }

  private async handleServer(value: unknown): Promise<void> {
    const parsed = validateRemoteDesktopServerMessage(value);
    if (!parsed.ok || !this.requestId || parsed.value.requestId !== this.requestId || this.stopped) return;
    const message = parsed.value;
    if (message.type === REMOTE_DESKTOP_MSG.AUTHORIZED) {
      if (this.sessionId || !validateRemoteDesktopAuthorized(message).ok) return;
      await this.preparePeer(message);
      return;
    }
    if (!this.matchesAuthority(message)) return;
    if (message.type === REMOTE_DESKTOP_MSG.ANSWER) {
      if (!this.peer || !this.awaitingAnswer) return;
      await this.peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      this.awaitingAnswer = false;
      await this.pendingRemoteCandidates.flush((candidate) => this.peer?.addIceCandidate(candidate));
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.ICE) {
      this.remoteIceCandidates++;
      if (this.remoteIceCandidates > REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES) {
        this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR);
        return;
      }
      const candidate = { candidate: message.candidate, sdpMid: message.mid };
      if (!this.peer?.remoteDescription) this.pendingRemoteCandidates.push(candidate);
      else await this.peer.addIceCandidate(candidate);
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.MODE_STATE) {
      if (message.inputEpoch < this.snapshot.inputEpoch) return;
      if (message.inputEpoch !== this.snapshot.inputEpoch
        || message.mode !== this.snapshot.mode) {
        this.workerInputEnabled = false;
        this.clearInputAck();
      }
      this.publish({
        mode: message.mode,
        inputEpoch: message.inputEpoch,
        inputEnabled: false,
      });
      if (message.mode === REMOTE_DESKTOP_ACCESS_MODE.VIEW) this.releaseAll();
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.STATUS) {
      if (message.inputEpoch !== this.snapshot.inputEpoch || message.mode !== this.snapshot.mode) return;
      const statusMatchesConsumedTopology = message.selectedDisplayId !== undefined
        && message.layoutRevision !== undefined
        && message.selectedDisplayId === this.snapshot.selectedDisplayId
        && message.layoutRevision === this.snapshot.layoutRevision
        && this.snapshot.displays.some((display) => (
          display.id === message.selectedDisplayId && display.available
        ));
      const statusMatchesPresentedFrame = statusMatchesConsumedTopology
        && this.presentedLayoutRevision === message.layoutRevision
        && this.presentedDisplayId === message.selectedDisplayId;
      this.workerInputEnabled = message.inputEnabled && statusMatchesPresentedFrame;
      if (message.inputEnabled && !statusMatchesPresentedFrame) this.releaseAll();
      this.publish({
        state: message.state,
        route: message.route,
        inputEnabled: this.channelsReady
          && this.workerInputEnabled
          && message.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        viewerCount: message.viewerCount,
        controllerCount: message.controllerCount,
      });
      if (message.state === REMOTE_DESKTOP_STATE.DIRECT || message.state === REMOTE_DESKTOP_STATE.RELAYED) {
        this.clearStartTimer();
      }
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.TERMINAL) {
      this.teardown(message.reason);
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.ERROR) this.fail(message.error);
  }

  private async preparePeer(authority: Extract<RemoteDesktopServerMessage, { type: typeof REMOTE_DESKTOP_MSG.AUTHORIZED }>): Promise<void> {
    this.sessionId = authority.sessionId;
    this.capability = authority.capability;
    this.daemonGeneration = authority.daemonGeneration;
    this.expiresAt = authority.expiresAt;
    this.publish({
      state: REMOTE_DESKTOP_STATE.PREPARING,
      mode: authority.mode,
      inputEpoch: authority.inputEpoch,
      inputEnabled: false,
    });
    const peer = (this.deps.createPeer ?? ((configuration) => new RTCPeerConnection(configuration)))({
      iceServers: toWebRtcIceServers(authority.iceServers),
      bundlePolicy: 'max-bundle',
    });
    this.peer = peer;
    const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
    const codecs = h264ReceiveCodecs();
    if (codecs && typeof transceiver.setCodecPreferences === 'function') transceiver.setCodecPreferences(codecs);
    this.controlChannel = peer.createDataChannel(REMOTE_DESKTOP_CHANNEL.CONTROL, { ordered: true });
    this.keyboardChannel = peer.createDataChannel(REMOTE_DESKTOP_CHANNEL.KEYBOARD, { ordered: true });
    this.pointerChannel = peer.createDataChannel(REMOTE_DESKTOP_CHANNEL.POINTER, { ordered: false, maxRetransmits: 0 });
    for (const channel of [this.controlChannel, this.keyboardChannel, this.pointerChannel]) {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = DATA_BUFFER_LOW_WATER_BYTES;
      channel.addEventListener('open', () => this.updateChannelReadiness());
      channel.addEventListener('close', () => {
        this.releaseAll();
        this.updateChannelReadiness();
        if (!this.stopped) this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
      });
    }
    this.controlChannel.addEventListener('message', (event) => this.handleData(event.data));
    this.controlChannel.addEventListener('open', () => {
      this.sendControl({
        type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
        ...this.inputBase(),
        kind: REMOTE_DESKTOP_CONTROL_KIND.HELLO,
      });
    });
    peer.addEventListener('track', (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.publish({ stream });
    });
    peer.addEventListener('icecandidate', (event) => {
      if (!event.candidate || !this.authorityReady()) return;
      this.localIceCandidates++;
      if (this.localIceCandidates > REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES) {
        this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR);
        return;
      }
      this.signaling.send({
        type: REMOTE_DESKTOP_MSG.ICE,
        ...this.authorityFields(),
        candidate: event.candidate.candidate,
        mid: event.candidate.sdpMid ?? '0',
      });
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        if (peer.connectionState === 'failed') void this.restartIce(peer);
        else this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
      } else if (peer.connectionState === 'disconnected') {
        this.clearDisconnectTimer();
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          void this.restartIce(peer);
        }, 1_500);
      } else if (peer.connectionState === 'connecting') {
        this.clearDisconnectTimer();
        this.publish({ state: REMOTE_DESKTOP_STATE.CONNECTING });
      } else if (peer.connectionState === 'connected') {
        this.clearDisconnectTimer();
        this.iceRestartInFlight = false;
        this.startStats(peer);
      }
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (!peer.localDescription?.sdp || !this.authorityReady()) {
      this.fail(REMOTE_DESKTOP_ERROR.INTERNAL_ERROR);
      return;
    }
    this.publish({ state: REMOTE_DESKTOP_STATE.CONNECTING });
    this.awaitingAnswer = true;
    this.signaling.send({
      type: REMOTE_DESKTOP_MSG.OFFER,
      ...this.authorityFields(),
      sdp: peer.localDescription.sdp,
    });
  }

  private handleData(raw: unknown): void {
    const text = decodeDataChannelPayload(raw);
    if (!text) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return; }
    const parsed = validateRemoteDesktopDataMessage(value);
    if (!parsed.ok || parsed.value.sessionId !== this.sessionId) return;
    if (parsed.value.type === REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY) {
      const topology = parsed.value;
      if (topology.layoutRevision < this.snapshot.layoutRevision) return;
      if (topology.layoutRevision !== this.snapshot.layoutRevision) this.releaseAll();
      this.clearLayoutTransitionTimer();
      this.workerInputEnabled = false;
      this.presentedLayoutRevision = 0;
      this.presentedDisplayId = null;
      const selected = topology.displays.find((display) => (
        display.id === topology.selectedDisplayId && display.available
      ));
      this.pendingPresentedFrame = selected ? {
        layoutRevision: topology.layoutRevision,
        displayId: selected.id,
        displayWidth: selected.width,
        displayHeight: selected.height,
      } : null;
      this.publish({
        displays: topology.displays,
        selectedDisplayId: topology.selectedDisplayId,
        layoutRevision: topology.layoutRevision,
        inputEnabled: false,
      });
    } else if (parsed.value.type === REMOTE_DESKTOP_DATA_MSG.QUALITY) {
      const { type: _type, protocolVersion: _protocol, sessionId: _session, sequence: _sequence, ...quality } = parsed.value;
      this.publish({ quality });
    } else if (parsed.value.type === REMOTE_DESKTOP_DATA_MSG.CONTROL
      && parsed.value.kind === REMOTE_DESKTOP_CONTROL_KIND.INPUT_ACK
      && parsed.value.layoutRevision === this.snapshot.layoutRevision
      && parsed.value.inputEpoch === this.snapshot.inputEpoch
      && parsed.value.acknowledgedSequence !== undefined
      && parsed.value.acknowledgedSequence < this.sequence
      && parsed.value.acknowledgedSequence > (this.snapshot.lastAcknowledgedInputSequence ?? -1)) {
      this.publish({ lastAcknowledgedInputSequence: parsed.value.acknowledgedSequence });
      if (this.pendingInputAckSequence !== null
        && parsed.value.acknowledgedSequence >= this.pendingInputAckSequence) {
        this.pendingInputAckSequence = null;
        if (this.inputAckTimer) clearTimeout(this.inputAckTimer);
        this.inputAckTimer = null;
      }
    }
  }

  private flushPointerMove(): void {
    const move = this.pendingPointerMove;
    this.pendingPointerMove = null;
    if (!move || !this.canSendInput() || !isOpen(this.pointerChannel)) return;
    if (this.pointerChannel.bufferedAmount > DATA_BUFFER_HIGH_WATER_BYTES) {
      // Only the superseded motion is dropped. Key/button transitions use a
      // different reliable channel and never enter this queue.
      return;
    }
    this.sendPointer({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_POINTER_KIND.MOVE,
      ...move,
    });
  }

  private startStats(peer: RTCPeerConnection): void {
    if (this.statsTimer || typeof peer.getStats !== 'function') return;
    const collect = () => { void this.collectStats(peer); };
    collect();
    this.statsTimer = setInterval(collect, 1_000);
  }

  private updateChannelReadiness(): void {
    this.channelsReady = isOpen(this.controlChannel)
      && isOpen(this.keyboardChannel)
      && isOpen(this.pointerChannel);
    if (this.channelsReady && !this.dataKeepaliveTimer) {
      this.dataKeepaliveTimer = setInterval(() => {
        if (!this.channelsReady || this.stopped) return;
        this.sendControl({
          type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
          ...this.inputBase(),
          kind: REMOTE_DESKTOP_CONTROL_KIND.KEEPALIVE,
        });
      }, REMOTE_DESKTOP_LIMITS.DATA_KEEPALIVE_INTERVAL_MS);
    } else if (!this.channelsReady && this.dataKeepaliveTimer) {
      clearInterval(this.dataKeepaliveTimer);
      this.dataKeepaliveTimer = null;
    }
    this.publish({
      inputEnabled: this.channelsReady
        && this.workerInputEnabled
        && this.presentedLayoutRevision === this.snapshot.layoutRevision
        && this.presentedDisplayId === this.snapshot.selectedDisplayId
        && this.snapshot.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL
        && this.snapshot.inputEpoch > 0,
    });
  }

  private async collectStats(peer: RTCPeerConnection): Promise<void> {
    if (this.statsInFlight || this.stopped || this.peer !== peer) return;
    this.statsInFlight = true;
    try {
      const report = await peer.getStats();
      if (this.stopped || this.peer !== peer) return;
      const entries: Array<Record<string, unknown>> = [];
      let rttMs: number | undefined;
      report.forEach((entry) => {
        const value = entry as unknown as Record<string, unknown>;
        entries.push(value);
        if (value.type === 'candidate-pair' && value.state === 'succeeded'
          && value.nominated === true && typeof value.currentRoundTripTime === 'number'
          && Number.isFinite(value.currentRoundTripTime)) {
          rttMs = Math.max(0, Math.min(3_600_000, value.currentRoundTripTime * 1_000));
        }
      });
      const inbound = entries.find((value) => value.type === 'inbound-rtp'
        && (value.kind === 'video' || value.mediaType === 'video'));
      const quality = this.snapshot.quality;
      const durationMs = Math.max(0, (this.deps.now?.() ?? Date.now()) - this.startedAt);
      if (!inbound || !quality) {
        this.publish({ durationMs });
        return;
      }
      const width = typeof inbound.frameWidth === 'number' && Number.isFinite(inbound.frameWidth)
        ? Math.max(1, Math.min(16_384, Math.floor(inbound.frameWidth))) : quality.width;
      const height = typeof inbound.frameHeight === 'number' && Number.isFinite(inbound.frameHeight)
        ? Math.max(1, Math.min(16_384, Math.floor(inbound.frameHeight))) : quality.height;
      const fps = typeof inbound.framesPerSecond === 'number' && Number.isFinite(inbound.framesPerSecond)
        ? Math.max(0, Math.min(240, inbound.framesPerSecond)) : quality.fps;
      const droppedFrames = typeof inbound.framesDropped === 'number' && Number.isSafeInteger(inbound.framesDropped)
        ? Math.max(0, inbound.framesDropped) : quality.droppedFrames;
      let bitrateBps = quality.bitrateBps;
      if (typeof inbound.bytesReceived === 'number' && Number.isSafeInteger(inbound.bytesReceived)
        && typeof inbound.timestamp === 'number' && Number.isFinite(inbound.timestamp)) {
        const now = this.deps.now?.() ?? Date.now();
        const visible = this.deps.isDocumentVisible?.()
          ?? (typeof document === 'undefined' || document.visibilityState === 'visible');
        if (!visible) {
          this.lastMediaBytesReceived = inbound.bytesReceived;
          this.lastMediaProgressAt = null;
        } else if (this.lastMediaBytesReceived === null
          || inbound.bytesReceived !== this.lastMediaBytesReceived
          || this.lastMediaProgressAt === null) {
          this.lastMediaBytesReceived = inbound.bytesReceived;
          this.lastMediaProgressAt = now;
        } else if (now - this.lastMediaProgressAt
          >= REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS) {
          this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
          return;
        }
        this.aggregateBytesReceived = Math.max(this.aggregateBytesReceived, inbound.bytesReceived);
        const previous = this.previousInboundStats;
        if (previous && inbound.timestamp > previous.timestamp && inbound.bytesReceived >= previous.bytes) {
          bitrateBps = Math.max(0, Math.min(
            REMOTE_DESKTOP_LIMITS.MAX_VIDEO_BITRATE_BPS,
            Math.round((inbound.bytesReceived - previous.bytes) * 8_000 / (inbound.timestamp - previous.timestamp)),
          ));
        }
        this.previousInboundStats = { bytes: inbound.bytesReceived, timestamp: inbound.timestamp };
      }
      this.publish({ quality: {
        ...quality,
        width,
        height,
        fps,
        bitrateBps,
        droppedFrames,
        ...(rttMs === undefined ? {} : { rttMs }),
      }, durationMs });
    } catch {
      // Stats are diagnostics only and never change media/input authority.
    } finally {
      this.statsInFlight = false;
    }
  }

  private async restartIce(peer: RTCPeerConnection): Promise<void> {
    if (this.iceRestartInFlight) return;
    if (this.stopped || this.peer !== peer || !this.authorityReady()
      || this.iceRestartCount >= REMOTE_DESKTOP_LIMITS.MAX_ICE_RESTARTS
      || this.expiresAt <= (this.deps.now?.() ?? Date.now())) {
      this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
      return;
    }
    this.iceRestartInFlight = true;
    this.iceRestartCount++;
    this.releaseAll();
    this.workerInputEnabled = false;
    this.requirePresentedFrameForCurrentTopology();
    this.publish({
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      inputEnabled: false,
      reconnectCount: this.iceRestartCount,
    });
    try {
      const offer = await peer.createOffer({ iceRestart: true });
      if (this.stopped || this.peer !== peer || !this.authorityReady()) return;
      await peer.setLocalDescription(offer);
      if (!peer.localDescription?.sdp) throw new Error('missing_restart_sdp');
      this.awaitingAnswer = true;
      if (!this.signaling.send({
        type: REMOTE_DESKTOP_MSG.OFFER,
        ...this.authorityFields(),
        sdp: peer.localDescription.sdp,
      })) throw new Error('restart_signal_failed');
      this.clearStartTimer();
      this.startTimer = setTimeout(
        () => this.fail(REMOTE_DESKTOP_TERMINAL_REASON.NEGOTIATION_TIMEOUT),
        START_TIMEOUT_MS,
      );
    } catch {
      this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
    }
  }

  private inputBase() {
    return {
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId: this.sessionId ?? 'invalid_session',
      sequence: this.sequence++,
      layoutRevision: this.snapshot.layoutRevision,
      inputEpoch: this.snapshot.inputEpoch,
    };
  }

  private sendControl(message: object): boolean {
    return this.sendData(this.controlChannel, message, true);
  }

  private sendKeyboard(message: object): boolean {
    return this.sendData(this.keyboardChannel, message, true);
  }

  private sendPointer(message: object): boolean {
    return this.sendData(this.pointerChannel, message, false);
  }

  private sendData(channel: RTCDataChannel | null, message: object, reliableTransition: boolean): boolean {
    if (!isOpen(channel)) return false;
    if (reliableTransition && channel.bufferedAmount > DATA_BUFFER_HIGH_WATER_BYTES) {
      this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR);
      return false;
    }
    const parsed = validateRemoteDesktopDataMessage(message);
    if (!parsed.ok) return false;
    try {
      channel.send(JSON.stringify(parsed.value));
    } catch {
      // A failed key/button-up must not clear the local pressed-state ledger.
      // The caller can retry it, while teardown still has RELEASE_ALL as the
      // authoritative last line of defence against stuck remote input.
      return false;
    }
    if (reliableTransition && (
      parsed.value.type === REMOTE_DESKTOP_DATA_MSG.KEYBOARD
      || parsed.value.type === REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL
      || (parsed.value.type === REMOTE_DESKTOP_DATA_MSG.POINTER
        && (parsed.value.kind === REMOTE_DESKTOP_POINTER_KIND.BUTTON_DOWN
          || parsed.value.kind === REMOTE_DESKTOP_POINTER_KIND.BUTTON_UP))
    )) {
      this.pendingInputAckSequence = parsed.value.sequence;
      if (this.inputAckTimer) clearTimeout(this.inputAckTimer);
      this.inputAckTimer = setTimeout(() => {
        this.inputAckTimer = null;
        if (this.pendingInputAckSequence !== null) {
          this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
        }
      }, INPUT_ACK_TIMEOUT_MS);
    }
    return true;
  }

  private canSendInput(): boolean {
    return !this.stopped
      && this.snapshot.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL
      && this.snapshot.inputEnabled
      && this.snapshot.inputEpoch > 0
      && this.expiresAt > (this.deps.now?.() ?? Date.now());
  }

  private clearInputAck(): void {
    if (this.inputAckTimer) clearTimeout(this.inputAckTimer);
    this.inputAckTimer = null;
    this.pendingInputAckSequence = null;
  }

  private matchesAuthority(message: RemoteDesktopServerMessage): boolean {
    if (message.type === REMOTE_DESKTOP_MSG.ERROR || message.type === REMOTE_DESKTOP_MSG.AUTHORIZED) return false;
    return message.sessionId === this.sessionId && message.capability === this.capability;
  }

  private authorityReady(): boolean {
    return Boolean(this.requestId && this.sessionId && this.capability && this.daemonGeneration > 0);
  }

  private authorityFields() {
    return {
      requestId: this.requestId!,
      sessionId: this.sessionId!,
      capability: this.capability!,
    };
  }

  private publish(patch: Partial<RemoteDesktopSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.hooks.onSnapshot(this.snapshot);
  }

  private fail(reason: string): void {
    if (this.stopped) return;
    this.publish({ state: REMOTE_DESKTOP_STATE.FAILED, error: reason, inputEnabled: false });
    this.teardown(reason);
  }

  private teardown(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearStartTimer();
    this.releaseAll();
    try { this.controlChannel?.close(); } catch { /* closed */ }
    try { this.keyboardChannel?.close(); } catch { /* closed */ }
    try { this.pointerChannel?.close(); } catch { /* closed */ }
    try { this.peer?.close(); } catch { /* closed */ }
    this.controlChannel = null;
    this.keyboardChannel = null;
    this.pointerChannel = null;
    this.peer = null;
    this.channelsReady = false;
    this.workerInputEnabled = false;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (this.dataKeepaliveTimer) clearInterval(this.dataKeepaliveTimer);
    this.dataKeepaliveTimer = null;
    this.clearDisconnectTimer();
    this.previousInboundStats = null;
    this.lastMediaBytesReceived = null;
    this.lastMediaProgressAt = null;
    this.clearInputAck();
    this.clearLayoutTransitionTimer();
    this.pendingPresentedFrame = null;
    this.presentedLayoutRevision = 0;
    this.presentedDisplayId = null;
    this.signaling.close();
    this.capability = null;
    this.publish({
      state: reason === REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_CONTROLLER
        || reason === REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_LOCAL_USER
        ? REMOTE_DESKTOP_STATE.STOPPED
        : REMOTE_DESKTOP_STATE.FAILED,
      inputEnabled: false,
      stream: null,
      terminalReason: reason,
    });
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private beginLayoutTransition(): void {
    this.workerInputEnabled = false;
    this.pendingPresentedFrame = null;
    this.presentedLayoutRevision = 0;
    this.presentedDisplayId = null;
    this.clearLayoutTransitionTimer();
    this.layoutTransitionTimer = setTimeout(() => {
      this.layoutTransitionTimer = null;
      if (!this.stopped) this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
    }, LAYOUT_TRANSITION_TIMEOUT_MS);
    this.publish({
      state: REMOTE_DESKTOP_STATE.SWITCHING_DISPLAY,
      inputEnabled: false,
    });
  }

  private requirePresentedFrameForCurrentTopology(): void {
    this.presentedLayoutRevision = 0;
    this.presentedDisplayId = null;
    const selected = this.snapshot.displays.find((display) => (
      display.id === this.snapshot.selectedDisplayId && display.available
    ));
    this.pendingPresentedFrame = selected ? {
      layoutRevision: this.snapshot.layoutRevision,
      displayId: selected.id,
      displayWidth: selected.width,
      displayHeight: selected.height,
    } : null;
  }

  private clearLayoutTransitionTimer(): void {
    if (this.layoutTransitionTimer) clearTimeout(this.layoutTransitionTimer);
    this.layoutTransitionTimer = null;
  }
}
