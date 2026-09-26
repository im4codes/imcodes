import { oneWayServerOffsetMs } from '@shared/clock-sync.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_COMMON_DISPLAY_MODES,
  REMOTE_DESKTOP_CONTROL_KIND,
  REMOTE_DESKTOP_CONTROL_REJECTION,
  REMOTE_DESKTOP_DATA_MSG,
  REMOTE_DESKTOP_DPI_SCALE_PERCENTS,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_INPUT_BLOCKED,
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
  isRemoteDesktopQualityPreference,
  legacyRemoteDesktopQualityPreference,
  validateRemoteDesktopAuthorized,
  validateRemoteDesktopDataMessage,
  validateRemoteDesktopServerMessage,
  type RemoteDesktopAccessMode,
  type RemoteDesktopControlKind,
  type RemoteDesktopControlRejection,
  type RemoteDesktopDisplay,
  type RemoteDesktopInputBlocked,
  type RemoteDesktopQuality,
  type RemoteDesktopQualityPreference,
  type RemoteDesktopRoute,
  type RemoteDesktopServerMessage,
  type RemoteDesktopState,
  type RemoteDesktopStopOrigin,
} from '@shared/remote-desktop.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { PendingWebRtcCandidates, toWebRtcIceServers } from '@shared/webrtc-connectivity.js';
import type { RemoteDesktopBootstrapProof } from '@shared/remote-desktop-access.js';
import { apiFetch, getApiBaseUrl } from './api.js';
import {
  REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT,
  recordRemoteDesktopBrowserDiagnostic,
  type RemoteDesktopBrowserDiagnosticInput,
} from './remote-desktop-browser-diagnostics.js';
import {
  REMOTE_DESKTOP_MODIFIER_KEY,
  remoteDesktopModifierKind,
  type RemoteDesktopChordKey,
  type RemoteDesktopModifierKind,
} from './remote-desktop-keyboard.js';

const DATA_BUFFER_HIGH_WATER_BYTES = 256 * 1024;
/**
 * How often the newest absolute pointer position is mirrored on the reliable
 * channel.
 *
 * The unreliable pointer channel is the fast path, but it is allowed to drop
 * anything it likes, and on a relayed link it can drop nearly everything —
 * measured on a node whose cursor only ever moved when a click carried a
 * position with it. This interval is therefore the floor on how smoothly the
 * remote cursor can follow, so it is set for following rather than for the
 * occasional correction.
 */
const POINTER_RELIABLE_SYNC_INTERVAL_MS = 40;
const DATA_BUFFER_LOW_WATER_BYTES = 64 * 1024;
// Let the server own the authoritative negotiation deadline and reason.  The
// browser guard is only a final escape hatch if that terminal frame is lost.
const START_TIMEOUT_MS = REMOTE_DESKTOP_LIMITS.NEGOTIATION_TIMEOUT_MS + 5_000;
const INPUT_ACK_TIMEOUT_MS = 3_000;
/**
 * How long a display-mode, scale or monitor change may take before the session
 * is declared dead.
 *
 * Changing a mode tears the capture stack down and rebuilds it: Windows applies
 * the mode, DXGI duplication is re-created and re-probed, and a node whose
 * adapter never presents falls back to GDI before the first frame of the new
 * layout exists. Measured on such a node that is seconds of work, and five of
 * them was short enough to turn an ordinary resolution switch into a peer
 * failure and a reconnect.
 */
const LAYOUT_TRANSITION_TIMEOUT_MS = 20_000;
/** Latency guard thresholds (see RemoteDesktopClient.observeLatency). */
const LATENCY_GUARD = {
  /**
   * Lateness is a RISE over the lowest round trip this path has shown, not an
   * absolute figure: a phone on 5G across regions sits at ~300 ms all the
   * time, and an absolute 300 ms threshold held it at the 350 kbps floor
   * (360p5) forever -- the 150 ms "healthy" mark it needed to recover was
   * never reachable.
   */
  LATE_RTT_RISE_MS: 200,
  LATE_BUFFER_MS: 250,
  HEALTHY_RTT_RISE_MS: 80,
  HEALTHY_BUFFER_MS: 120,
  /**
   * A still screen sends a frame or two a second and next to no bytes; it
   * says nothing about congestion, and stepping down from its near-zero
   * throughput sent the cap straight to the floor.
   */
  MIN_ACTIVE_FPS: 5,
  STEP_DOWN_SAMPLES: 3,
  STEP_UP_SAMPLES: 15,
  STEP_DOWN_FACTOR: 0.6,
  STEP_UP_FACTOR: 1.5,
  MIN_BPS: 350_000,
  MAX_BPS: 15_000_000,
} as const;

const CLIPBOARD_REQUEST_TIMEOUT_MS = 2_000;

export interface RemoteDesktopSnapshot {
  state: RemoteDesktopState;
  mode: RemoteDesktopAccessMode;
  inputEpoch: number;
  inputEnabled: boolean;
  /** Capability advertised by the current worker; absent on older workers. */
  atomicButtonClick?: boolean;
  /** The worker honours viewer quality preferences (older workers do not). */
  qualityPreferenceSupported?: boolean;
  /** ...including Ultra (2160 and a raised bitrate ceiling). */
  qualityUltraSupported?: boolean;
  /** Ceiling of the relay this session was handed (its TURN tier), if any. */
  relayBitrateCapBps?: number;
  route?: RemoteDesktopRoute;
  displays: RemoteDesktopDisplay[];
  selectedDisplayId?: string;
  layoutRevision: number;
  /**
   * Live stream quality. The browser measures resolution, frame rate,
   * bitrate, round trip and dropped frames itself from its own WebRTC stats,
   * so these are present on every platform; `preset` / `encoderClass` exist
   * only when the worker reports them (Windows today).
   */
  quality?: Omit<RemoteDesktopQuality, 'type' | 'protocolVersion' | 'sessionId' | 'sequence' | 'preset' | 'encoderClass'>
    & Partial<Pick<RemoteDesktopQuality, 'preset' | 'encoderClass'>>;
  stream: MediaStream | null;
  terminalReason?: string;
  error?: string;
  /** Server-authoritative retry guidance for an ERROR response. */
  retryable?: boolean;
  viewerCount?: number;
  controllerCount?: number;
  /** The node is showing the Windows sign-in/lock screen. */
  signInScreen?: boolean;
  /** That node holds a stored secret it can be asked to type. */
  unlockAvailable?: boolean;
  /** Present only while input is off, naming what the node is waiting on. */
  inputBlocked?: RemoteDesktopInputBlocked;
  /**
   * Pointer moves this client has actually put on the wire. A remote cursor
   * that only jumps on click is either a browser that never produced the
   * moves or a node that never applied them, and those need opposite fixes —
   * this is the number that tells the two apart from the session itself.
   */
  /**
   * Moves that actually left on the best-effort pointer channel, and the
   * subset mirrored on the reliable one. Split because "the cursor does not
   * follow" has two very different causes -- nothing sent at all, or sent on a
   * channel the link is discarding -- and one total cannot tell them apart.
   */
  pointerMovesSent?: number;
  pointerMovesMirrored?: number;
  /** Pointer move calls accepted/rejected before a channel send is attempted. */
  pointerMoveCalls?: number;
  pointerMoveGateRejected?: number;
  pointerMoveChannelUnavailable?: number;
  pointerMoveBackpressureDrops?: number;
  pointerMoveSendFailures?: number;
  lastAcknowledgedInputSequence?: number;
  durationMs?: number;
  reconnectCount?: number;
  capabilityVersion?: string;
  /**
   * The last control command that was refused, with a monotonic id so the UI
   * re-shows the same reason when it happens again. Set by the worker's
   * rejection frame, and by this client when it declines to send at all —
   * either way the operator gets told instead of watching a click vanish.
   */
  controlRejection?: {
    id: number;
    kind: RemoteDesktopControlKind;
    reason: RemoteDesktopControlRejection;
    displayId?: string;
  };
}

export interface RemoteDesktopClientHooks {
  onSnapshot(snapshot: RemoteDesktopSnapshot): void;
  /** The exact signaling bridge observed an authenticated replacement daemon. */
  onDaemonReconnected?(): void;
}

export interface RemoteDesktopClientDependencies {
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  createSocket?: (url: string) => WebSocket;
  fetchTicket?: (serverId: string, signal: AbortSignal) => Promise<string>;
  now?: () => number;
  isDocumentVisible?: () => boolean;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  /** Anonymous guest bootstrap proof. It is sent as the bounded first WebSocket
   * frame and cleared from this dependency object immediately afterwards. */
  guestBootstrapProof?: RemoteDesktopBootstrapProof;
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

function defaultGuestSocketUrl(serverId: string): string {
  const base = getApiBaseUrl().replace(/^http/, 'ws').replace(/\/$/, '');
  const query = new URLSearchParams({ [REMOTE_DESKTOP_SERVER_ID_QUERY]: serverId });
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

export function prioritizeH264ReceiveCodecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] | null {
  const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264');
  if (h264.length === 0) return null;
  return [
    ...h264,
    ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'video/h264'),
  ];
}

export function applyH264ReceiveCodecPreference(
  transceiver: RTCRtpTransceiver,
  codecs: readonly RTCRtpCodec[],
): void {
  const preferred = prioritizeH264ReceiveCodecs(codecs);
  if (!preferred || typeof transceiver.setCodecPreferences !== 'function') return;
  try {
    transceiver.setCodecPreferences(preferred);
  } catch {
    // A browser with an incomplete codec-preference implementation can still
    // negotiate H.264 from its default offer because the worker only advertises
    // H.264. Do not turn that recoverable compatibility gap into protocol_error.
  }
}

export function isRemoteDesktopKeyAllowed(
  code: string,
  modifiers: { control: boolean; alt: boolean },
): boolean {
  if (!/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Backspace|Tab|Enter|Escape|Space|Delete|Insert|Home|End|PageUp|PageDown|ShiftLeft|ShiftRight|ControlLeft|ControlRight|AltLeft|AltRight|MetaLeft|MetaRight|CapsLock|NumLock|ScrollLock|Semicolon|Equal|Comma|Minus|Period|Slash|Backquote|BracketLeft|Backslash|BracketRight|Quote)$/.test(code)) {
    return false;
  }
  // Windows secure attention is never synthesized. The native worker repeats
  // this denial even if a malicious browser bypasses this client check.
  return !(code === 'Delete' && modifiers.control && modifiers.alt);
}

export function chunkRemoteDesktopText(value: string): string[] | null {
  const encoder = new TextEncoder();
  if (!value) return null;
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  let codeUnits = 0;
  for (const symbol of value) {
    const symbolBytes = encoder.encode(symbol).byteLength;
    if (chunk && (bytes + symbolBytes > REMOTE_DESKTOP_LIMITS.TEXT_BYTES
      || codeUnits + symbol.length > REMOTE_DESKTOP_LIMITS.TEXT_CODE_UNITS)) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
      codeUnits = 0;
    }
    chunk += symbol;
    bytes += symbolBytes;
    codeUnits += symbol.length;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function chunkClipboardPasteText(value: string): string[] | null {
  if (!value) return null;
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const symbol of value) {
    const symbolBytes = encoder.encode(symbol).byteLength;
    if (chunk && bytes + symbolBytes > REMOTE_DESKTOP_LIMITS.PASTE_TEXT_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += symbol;
    bytes += symbolBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

class RemoteDesktopSignalingSocket {
  private socket: WebSocket | null = null;
  private ticketAbort: AbortController | null = null;
  private readonly guest: boolean;

  constructor(private readonly deps: RemoteDesktopClientDependencies) {
    this.guest = deps.guestBootstrapProof !== undefined;
  }

  async connect(
    serverId: string,
    onMessage: (value: unknown) => void,
    onClose: () => void,
    onDaemonReconnected?: () => void,
    resume = false,
  ): Promise<void> {
    const abort = new AbortController();
    this.ticketAbort = abort;
    const guestBootstrapProof = resume ? undefined : this.deps.guestBootstrapProof;
    const fetchTicket = this.deps.fetchTicket ?? defaultFetchTicket;
    let ticket = '';
    if (!this.guest) {
      if (resume) {
        ticket = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            abort.abort();
            reject(new Error('remote_desktop_ticket_timeout'));
          }, REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_ATTEMPT_TIMEOUT_MS);
          void fetchTicket(serverId, abort.signal).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error: unknown) => { clearTimeout(timer); reject(error); },
          );
        });
      } else {
        ticket = await fetchTicket(serverId, abort.signal);
      }
    }
    const socketUrl = this.guest
      ? defaultGuestSocketUrl(serverId)
      : defaultSocketUrl(serverId, ticket);
    if (abort.signal.aborted) throw new Error('remote_desktop_canceled');
    const socket = (this.deps.createSocket ?? ((url) => new WebSocket(url)))(socketUrl);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', closed);
        socket.removeEventListener('message', redeemed);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        socket.close(4000, 'remote_desktop_open_timeout');
        fail(new Error('remote_desktop_open_timeout'));
      }, resume
        ? REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_ATTEMPT_TIMEOUT_MS
        : START_TIMEOUT_MS);
      const redeemed = (event: MessageEvent) => {
        if (typeof event.data !== 'string') {
          socket.close(4000, 'remote_desktop_bootstrap_failed');
          fail(new Error('remote_desktop_bootstrap_failed'));
          return;
        }
        let value: unknown;
        try { value = JSON.parse(event.data); } catch {
          socket.close(4000, 'remote_desktop_bootstrap_failed');
          fail(new Error('remote_desktop_bootstrap_failed'));
          return;
        }
        const parsed = validateRemoteDesktopServerMessage(value);
        if (!parsed.ok || parsed.value.type !== REMOTE_DESKTOP_MSG.BOOTSTRAP_REDEEMED) {
          socket.close(4000, 'remote_desktop_bootstrap_failed');
          fail(new Error('remote_desktop_bootstrap_failed'));
          return;
        }
        succeed();
      };
      const opened = () => {
        if (guestBootstrapProof) {
          try {
            socket.send(JSON.stringify(guestBootstrapProof));
            this.deps.guestBootstrapProof = undefined;
            socket.addEventListener('message', redeemed);
          } catch {
            socket.close(4000, 'remote_desktop_bootstrap_failed');
            fail(new Error('remote_desktop_bootstrap_failed'));
            return;
          }
          return;
        }
        succeed();
      };
      const failed = () => {
        fail(new Error('remote_desktop_socket_failed'));
      };
      const closed = () => fail(new Error('remote_desktop_socket_failed'));
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', closed, { once: true });
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      try {
        const value = JSON.parse(event.data) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)
          && (value as { type?: unknown }).type === DAEMON_MSG.RECONNECTED) {
          onDaemonReconnected?.();
          return;
        }
        onMessage(value);
      } catch { /* strict parser below */ }
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

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
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
  /** The grant this session was authorized with, replayed on a worker handover. */
  private authorized: Extract<RemoteDesktopServerMessage, { type: typeof REMOTE_DESKTOP_MSG.AUTHORIZED }> | null = null;
  /** What this viewer wants; re-sent to every (re)connected capable worker. */
  private desiredQualityPreference: RemoteDesktopQualityPreference | null = null;
  /** The preference the current worker session already has. */
  private sentQualityPreferenceKey: string | null = null;
  /**
   * Latency guard: an extra, temporary bitrate ceiling the browser applies on
   * top of the viewer's own choice when the stream shows up late (round trip
   * or playback buffering), and relaxes once it is healthy again. Covers the
   * case congestion control misses: bandwidth looks fine, delivery is slow.
   */
  private latencyGuardEnabled = false;
  private latencyGuardCapBps: number | null = null;
  private latencyBadStreak = 0;
  /** Lowest round trip seen on this path; lateness is measured above it. */
  private latencyBaselineRttMs: number | null = null;
  private latencyGoodStreak = 0;
  private previousJitterBuffer: { delay: number; emitted: number } | null = null;
  private renegotiating = false;
  /** Keep the last decoded frame visible while a new Windows session takes over. */
  private seamlessHandover = false;
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
  private pendingIceRestart = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private signalingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private signalingReconnectAttempts = 0;
  private signalingReconnectInFlight = false;
  private signalingStableState: RemoteDesktopState | null = null;
  private signalingDisconnectedAt: number | null = null;
  private awaitingAnswer = false;
  private previousInboundStats: { bytes: number; timestamp: number } | null = null;
  private lastMediaBytesReceived: number | null = null;
  private lastMediaProgressAt: number | null = null;
  /** Media that never started is a different failure from media that stopped. */
  private mediaStarted = false;
  private firstMediaWaitStartedAt: number | null = null;
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
  private lastReliablePointerSyncAt = Number.NEGATIVE_INFINITY;
  private lastPointerFlushAt = Number.NEGATIVE_INFINITY;
  private pointerMovesSent = 0;
  private pointerMovesMirrored = 0;
  private pointerMoveCalls = 0;
  private pointerMoveGateRejected = 0;
  private pointerMoveChannelUnavailable = 0;
  private pointerMoveBackpressureDrops = 0;
  private pointerMoveSendFailures = 0;
  private pressedCodes = new Set<string>();
  /** Keys pressed while Meta was held; browsers may swallow their keyup. */
  private pressedWhileMeta = new Map<string, string>();
  /**
   * Modifiers the operator is still holding that a translated shortcut or a
   * paste lifted on the remote (see tapChords and text). One goes back down
   * just before the next ordinary key or button press needs it, and its
   * physical release has nothing left to do. Never restored eagerly: an Alt
   * pressed and released with nothing in between opens the menu bar on
   * Windows.
   */
  private liftedModifiers = new Set<string>();
  private pressedButtons = new Set<string>();
  private pendingClipboardRequests = new Map<string, {
    resolve(value: string | null): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private pendingPaste: { id: string; text: string; finalSequence: number } | null = null;
  private controlRejectionId = 0;
  private diagnosticTrackCleanup: (() => void) | null = null;
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

  private recordBrowserDiagnostic(event: RemoteDesktopBrowserDiagnosticInput): void {
    recordRemoteDesktopBrowserDiagnostic(this.serverId, event);
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
      () => this.handleSignalingClose(),
      this.hooks.onDaemonReconnected,
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
    // Offered by this display if it reported its driver's list; otherwise the
    // common sizes, which is all an older node can be asked for.
    const offered = display?.modes ?? REMOTE_DESKTOP_COMMON_DISPLAY_MODES;
    if (!offered.some((mode) => mode.width === width && mode.height === height)) {
      return false;
    }
    if (!this.snapshot.inputEnabled || !display) {
      // Refused here rather than on the node, but the operator saw the same
      // thing — a click that changed nothing — so answer it the same way.
      this.publishControlRejection(
        REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,
        display
          ? REMOTE_DESKTOP_CONTROL_REJECTION.NOT_PERMITTED
          : REMOTE_DESKTOP_CONTROL_REJECTION.DISPLAY_UNAVAILABLE,
        displayId,
      );
      return false;
    }
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

  setDisplayScale(displayId: string, dpiScalePercent: number): boolean {
    const display = this.snapshot.displays.find((candidate) => (
      candidate.id === displayId && candidate.available
    ));
    if (!REMOTE_DESKTOP_DPI_SCALE_PERCENTS.includes(
      dpiScalePercent as typeof REMOTE_DESKTOP_DPI_SCALE_PERCENTS[number],
    )) return false;
    if (!this.snapshot.inputEnabled || !display) {
      this.publishControlRejection(
        REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_SCALE,
        display
          ? REMOTE_DESKTOP_CONTROL_REJECTION.NOT_PERMITTED
          : REMOTE_DESKTOP_CONTROL_REJECTION.DISPLAY_UNAVAILABLE,
        displayId,
      );
      return false;
    }
    if (Math.round(display.dpiScale * 100) === dpiScalePercent) return true;
    this.releaseAll();
    const sent = this.sendControl({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_SCALE,
      displayId,
      dpiScalePercent,
    });
    if (sent) this.beginLayoutTransition();
    return sent;
  }

  /**
   * This viewer's quality preference (resolution / frame-rate / bitrate caps
   * and priority). Remembered and (re)sent to every capable worker session;
   * never sent to a worker that did not advertise support.
   */
  setQualityPreference(
    preference: RemoteDesktopQualityPreference,
    options: { latencyGuard?: boolean } = {},
  ): boolean {
    if (!isRemoteDesktopQualityPreference(preference)) return false;
    this.desiredQualityPreference = { ...preference };
    this.latencyGuardEnabled = options.latencyGuard !== false;
    if (!this.latencyGuardEnabled) this.resetLatencyGuard();
    this.flushQualityPreference();
    return true;
  }

  private resetLatencyGuard(): void {
    this.latencyGuardCapBps = null;
    this.latencyBaselineRttMs = null;
    this.latencyBadStreak = 0;
    this.latencyGoodStreak = 0;
  }

  /** The viewer's preference with the latency guard's ceiling folded in. */
  private effectiveQualityPreference(): RemoteDesktopQualityPreference | null {
    const preference = this.desiredQualityPreference;
    if (!preference) return null;
    const guard = this.latencyGuardCapBps;
    if (guard === null) return preference;
    const own = preference.maxBitrateBps;
    return { ...preference, maxBitrateBps: own > 0 ? Math.min(own, guard) : guard };
  }

  /**
   * One stats sample: step the guard ceiling down after sustained lateness,
   * back up after a sustained healthy stretch.
   */
  private observeLatency(
    rttMs: number | undefined,
    jitterBufferMs: number | undefined,
    bitrateBps: number,
    fps: number,
  ): void {
    if (!this.latencyGuardEnabled || !this.desiredQualityPreference) return;
    if (rttMs !== undefined) {
      this.latencyBaselineRttMs = this.latencyBaselineRttMs === null
        ? rttMs
        : Math.min(this.latencyBaselineRttMs, rttMs);
    }
    // An idle picture is neither late nor healthy evidence.
    if (fps < LATENCY_GUARD.MIN_ACTIVE_FPS) return;
    const rise = rttMs !== undefined && this.latencyBaselineRttMs !== null
      ? rttMs - this.latencyBaselineRttMs
      : undefined;
    const late = (rise !== undefined && rise >= LATENCY_GUARD.LATE_RTT_RISE_MS)
      || (jitterBufferMs !== undefined && jitterBufferMs >= LATENCY_GUARD.LATE_BUFFER_MS);
    const healthy = (rise === undefined || rise < LATENCY_GUARD.HEALTHY_RTT_RISE_MS)
      && (jitterBufferMs === undefined || jitterBufferMs < LATENCY_GUARD.HEALTHY_BUFFER_MS);
    this.latencyBadStreak = late ? this.latencyBadStreak + 1 : 0;
    this.latencyGoodStreak = healthy ? this.latencyGoodStreak + 1 : 0;
    let next = this.latencyGuardCapBps;
    if (this.latencyBadStreak >= LATENCY_GUARD.STEP_DOWN_SAMPLES && bitrateBps > 0) {
      const base = next === null ? bitrateBps : Math.min(next, bitrateBps);
      next = Math.max(LATENCY_GUARD.MIN_BPS, Math.round(base * LATENCY_GUARD.STEP_DOWN_FACTOR));
      this.latencyBadStreak = 0;
    } else if (next !== null && this.latencyGoodStreak >= LATENCY_GUARD.STEP_UP_SAMPLES) {
      const raised = Math.round(next * LATENCY_GUARD.STEP_UP_FACTOR);
      next = raised >= LATENCY_GUARD.MAX_BPS ? null : raised;
      this.latencyGoodStreak = 0;
    }
    if (next !== this.latencyGuardCapBps) {
      this.latencyGuardCapBps = next;
      this.flushQualityPreference();
    }
  }

  private flushQualityPreference(): void {
    const effective = this.effectiveQualityPreference();
    if (!effective || !this.snapshot.qualityPreferenceSupported || !isOpen(this.controlChannel)) return;
    const preference = this.snapshot.qualityUltraSupported
      ? effective
      : legacyRemoteDesktopQualityPreference(effective);
    const key = JSON.stringify(preference);
    if (key === this.sentQualityPreferenceKey) return;
    if (this.sendControl({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_CONTROL_KIND.SET_QUALITY_PREFERENCE,
      maxHeight: preference.maxHeight,
      maxFps: preference.maxFps,
      maxBitrateBps: preference.maxBitrateBps,
      priority: preference.priority,
    })) {
      this.sentQualityPreferenceKey = key;
    }
  }

  /**
   * Ask the node to answer its own sign-in screen with the secret it stores.
   * Auto unlock already tries this, but the sign-in UI can swallow a keystroke,
   * so the operator keeps a way to say "try again" — and gets told when the
   * node refuses instead of watching another click disappear.
   */
  requestUnlock(): boolean {
    if (!this.snapshot.inputEnabled || !this.snapshot.unlockAvailable) {
      this.publishControlRejection(
        REMOTE_DESKTOP_CONTROL_KIND.UNLOCK,
        this.snapshot.inputEnabled
          ? REMOTE_DESKTOP_CONTROL_REJECTION.UNLOCK_UNAVAILABLE
          : REMOTE_DESKTOP_CONTROL_REJECTION.NOT_PERMITTED,
      );
      return false;
    }
    return this.sendControl({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_CONTROL_KIND.UNLOCK,
    });
  }

  requestRemoteClipboard(): Promise<string | null> {
    if (!this.canSendInput()) return Promise.resolve(null);
    const requestId = randomRequestId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingClipboardRequests.delete(requestId);
        resolve(null);
      }, CLIPBOARD_REQUEST_TIMEOUT_MS);
      this.pendingClipboardRequests.set(requestId, { resolve, timer });
      const sent = this.sendControl({
        type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
        ...this.inputBase(),
        kind: REMOTE_DESKTOP_CONTROL_KIND.COPY_SELECTION,
        requestId,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingClipboardRequests.delete(requestId);
        resolve(null);
      }
    });
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
    this.pointerMoveCalls += 1;
    if (!this.canSendInput() || !Number.isFinite(x) || !Number.isFinite(y)) {
      this.pointerMoveGateRejected += 1;
      return;
    }
    this.pendingPointerMove = {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
    if (this.pointerFrame !== null) {
      // A frame callback that never fires — an occluded or throttled window,
      // a host that batches them away — would otherwise swallow every move
      // after the first. Fall back to sending on the interval the reliable
      // mirror already runs at rather than waiting for a frame that is not
      // coming.
      const now = this.deps.now?.() ?? Date.now();
      if (now - this.lastPointerFlushAt >= POINTER_RELIABLE_SYNC_INTERVAL_MS) {
        this.flushPointerMove();
      }
      return;
    }
    const request = this.deps.requestAnimationFrame
      ?? ((callback: FrameRequestCallback) => globalThis.requestAnimationFrame(callback));
    this.pointerFrame = request(() => {
      this.pointerFrame = null;
      this.flushPointerMove();
    });
  }

  pointerButton(button: 'left' | 'middle' | 'right' | 'back' | 'forward', down: boolean, x?: number, y?: number): boolean {
    if (!this.canSendInput()) return false;
    if (down && !this.restoreLiftedModifiers()) return false;
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

  /** Complete a click atomically on the worker so Windows can recognize the
   * second half of a double-click even when data-channel scheduling is busy. */
  pointerClick(button: 'left' | 'middle' | 'right' | 'back' | 'forward', x?: number, y?: number): boolean {
    if (!this.canSendInput() || !this.restoreLiftedModifiers()) return false;
    return this.sendControl({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_POINTER_KIND.BUTTON_CLICK,
      button,
      ...(x === undefined ? {} : { x: Math.max(0, Math.min(1, x)) }),
      ...(y === undefined ? {} : { y: Math.max(0, Math.min(1, y)) }),
    });
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

  key(code: string, key: string, down: boolean, repeat: boolean, modifiers: { control: boolean; alt: boolean; meta?: boolean }): boolean {
    if (!this.canSendInput() || !isRemoteDesktopKeyAllowed(code, modifiers)) return false;
    if (down && !repeat && this.pressedCodes.has(code)) {
      if (!this.sendKeyTransition(code, key, false, false)) return false;
    }
    if (this.liftedModifiers.delete(code)) {
      // Already up on the remote: releasing it is done, pressing it again is
      // an ordinary press.
      if (!down) return true;
    } else if (down && !remoteDesktopModifierKind(code) && !this.restoreLiftedModifiers()) {
      return false;
    }
    const sent = this.sendKeyTransition(code, key, down, repeat);
    if (sent && !down) this.pressedWhileMeta.delete(code);
    return sent;
  }

  /** Record a non-modifier delivered while the browser held Meta. */
  noteMetaChordKey(code: string, key: string, metaHeld: boolean): void {
    if (metaHeld && !remoteDesktopModifierKind(code) && this.pressedCodes.has(code)) {
      this.pressedWhileMeta.set(code, key);
    }
  }

  /**
   * Tap shortcut chords on the remote as self-contained gestures, whatever the
   * operator is physically holding -- used for shortcuts the target spells
   * differently from the controller (see translateRemoteDesktopShortcut), so
   * Command+Left can arrive as a bare Home although Command is still held.
   *
   * Each chord presses its own missing modifiers first, then lifts any held
   * modifier it does not want (in that order, so a held Alt is never released
   * on its own), taps its keys, and releases what it pressed. Lifted modifiers
   * stay up until the next ordinary key needs them.
   */
  tapChords(chords: readonly (readonly RemoteDesktopChordKey[])[]): boolean {
    if (!this.canSendInput()) return false;
    for (const chord of chords) {
      const modifiers = chord.filter((entry) => remoteDesktopModifierKind(entry.code));
      const keys = chord.filter((entry) => !remoteDesktopModifierKind(entry.code));
      const wanted = new Set(modifiers.map((entry) => remoteDesktopModifierKind(entry.code)));
      const pressedHere: RemoteDesktopChordKey[] = [];
      for (const modifier of modifiers) {
        if (this.heldModifierKinds().has(remoteDesktopModifierKind(modifier.code)!)) continue;
        if (!this.sendKeyTransition(modifier.code, modifier.key, true, false)) return this.abandonTap();
        pressedHere.push(modifier);
      }
      if (!this.liftHeldModifiers((kind) => wanted.has(kind))) return this.abandonTap();
      const held = this.heldModifierKinds();
      const flags = { control: held.has('control'), alt: held.has('alt') };
      for (const entry of keys) {
        if (!isRemoteDesktopKeyAllowed(entry.code, flags)
          || !this.sendKeyTransition(entry.code, entry.key, true, false)) return this.abandonTap();
      }
      for (const entry of [...keys].reverse()) {
        if (!this.sendKeyTransition(entry.code, entry.key, false, false)) return this.abandonTap();
      }
      for (const modifier of [...pressedHere].reverse()) {
        if (!this.sendKeyTransition(modifier.code, modifier.key, false, false)) return this.abandonTap();
      }
    }
    return true;
  }

  text(value: string): boolean {
    if (!this.canSendInput()) return false;
    return this.sendTypedText(value);
  }

  /** Paste a clipboard payload remotely with one OS clipboard write + native shortcut. */
  pasteText(value: string): boolean {
    if (!this.canSendInput() || !value) return false;
    if (new TextEncoder().encode(value).byteLength > REMOTE_DESKTOP_LIMITS.PASTE_TEXT_BYTES) {
      const sent = this.sendTypedText(value);
      if (sent) this.publishControlRejection(
        REMOTE_DESKTOP_CONTROL_KIND.PASTE_TEXT,
        REMOTE_DESKTOP_CONTROL_REJECTION.PASTE_TOO_LARGE,
      );
      return sent;
    }
    const chunks = chunkClipboardPasteText(value);
    if (!chunks?.length || this.pendingPaste) return false;
    const id = globalThis.crypto?.randomUUID?.()
      ?? `paste_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    let finalSequence = -1;
    for (let index = 0; index < chunks.length; index += 1) {
      const base = this.inputBase();
      finalSequence = base.sequence;
      if (!this.sendControl({
        type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
        ...base,
        kind: REMOTE_DESKTOP_CONTROL_KIND.PASTE_TEXT,
        pasteId: id,
        chunkIndex: index,
        chunkCount: chunks.length,
        text: chunks[index],
      })) {
        this.publishControlRejection(
          REMOTE_DESKTOP_CONTROL_KIND.PASTE_TEXT,
          REMOTE_DESKTOP_CONTROL_REJECTION.PASTE_UNAVAILABLE,
        );
        return this.sendTypedText(value);
      }
    }
    this.pendingPaste = { id, text: value, finalSequence };
    return true;
  }

  private sendTypedText(value: string): boolean {
    const chunks = chunkRemoteDesktopText(value);
    if (!chunks) return false;
    // A paste shortcut leaves its Control or Command held. Typed underneath
    // it, the text turns into a string of shortcuts on the target (on a Mac,
    // Command+H, Command+W, Command+Q...).
    if (!this.liftHeldModifiers((kind) => kind !== 'control' && kind !== 'meta')) return false;
    for (const text of chunks) {
      if (!this.sendKeyboard({
        type: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
        ...this.inputBase(),
        kind: REMOTE_DESKTOP_KEYBOARD_KIND.TEXT,
        text,
      })) return false;
    }
    return true;
  }

  releaseAll(): void {
    this.liftedModifiers.clear();
    this.pendingPointerMove = null;
    this.lastReliablePointerSyncAt = Number.NEGATIVE_INFINITY;
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
    this.pressedWhileMeta.clear();
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

  stop(stopOrigin: RemoteDesktopStopOrigin): void {
    if (this.stopped) return;
    this.releaseAll();
    if (this.requestId && this.sessionId && this.capability) {
      this.signaling.send({
        type: REMOTE_DESKTOP_MSG.STOP,
        requestId: this.requestId,
        sessionId: this.sessionId,
        capability: this.capability,
        stopOrigin,
        ...(this.aggregateBytesReceived > 0
          ? { aggregateBytesReceived: this.aggregateBytesReceived }
          : {}),
      });
    }
    this.teardown(REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_CONTROLLER);
  }

  /**
   * A real Windows logoff destroys the console session that owns DXGI, so the
   * node must move capture to a worker in the next console session. Keep this
   * browser PeerConnection and its last decoded frame, ICE-restart it against
   * the replacement worker, and rebuild only its data channels. The grant,
   * stream element and visible state all survive the handover.
   */
  private async renegotiate(): Promise<void> {
    const authority = this.authorized;
    const peer = this.peer;
    if (!authority || !peer || this.stopped || this.renegotiating) return;
    this.renegotiating = true;
    this.seamlessHandover = true;
    try {
      this.clearStartTimer();
      this.clearDisconnectTimer();
      this.releaseAll();
      this.workerInputEnabled = false;
      this.awaitingAnswer = false;
      this.iceRestartInFlight = true;
      this.localIceCandidates = 0;
      this.remoteIceCandidates = 0;
      this.pendingRemoteCandidates.clear();
      if (this.statsTimer) clearInterval(this.statsTimer);
      this.statsTimer = null;
      this.previousInboundStats = null;
      this.previousJitterBuffer = null;
      this.latencyBaselineRttMs = null;
      this.lastMediaBytesReceived = null;
      this.lastMediaProgressAt = null;
      this.mediaStarted = false;
      this.firstMediaWaitStartedAt = null;
      const supersededChannels = [this.controlChannel, this.keyboardChannel, this.pointerChannel];
      this.controlChannel = null;
      this.keyboardChannel = null;
      this.pointerChannel = null;
      this.channelsReady = false;
      for (const channel of supersededChannels) {
        try { channel?.close(); } catch { /* closed */ }
      }
      this.createDataChannels(peer);
      // Do not publish PREPARING/CONNECTING/RECONNECTING: the existing stream
      // and its last frame remain mounted until the replacement sends frames.
      this.publish({ inputEnabled: false });
      this.requirePresentedFrameForCurrentTopology();
      const offer = await peer.createOffer({ iceRestart: true });
      if (this.stopped || this.peer !== peer || !this.authorityReady()) return;
      await peer.setLocalDescription(offer);
      if (!peer.localDescription?.sdp) throw new Error('missing_handover_sdp');
      this.awaitingAnswer = true;
      if (!this.signaling.send({
        type: REMOTE_DESKTOP_MSG.OFFER,
        ...this.authorityFields(),
        sdp: peer.localDescription.sdp,
      })) throw new Error('handover_signal_failed');
      this.startTimer = setTimeout(
        () => this.fail(REMOTE_DESKTOP_TERMINAL_REASON.NEGOTIATION_TIMEOUT),
        START_TIMEOUT_MS,
      );
    } catch {
      this.seamlessHandover = false;
      this.iceRestartInFlight = false;
      this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
    } finally {
      this.renegotiating = false;
    }
  }

  private async handleServer(value: unknown): Promise<void> {
    const parsed = validateRemoteDesktopServerMessage(value);
    if (!parsed.ok || this.stopped) return;
    // Consumed by the signaling handshake before START; ignore a duplicate
    // rather than letting a content-free acknowledgement affect a session.
    if (parsed.value.type === REMOTE_DESKTOP_MSG.BOOTSTRAP_REDEEMED) return;
    if (!this.requestId || parsed.value.requestId !== this.requestId) return;
    const message = parsed.value;
    if (message.type === REMOTE_DESKTOP_MSG.AUTHORIZED) {
      if (this.sessionId || !validateRemoteDesktopAuthorized(message).ok) return;
      this.authorized = message;
      this.publish({ relayBitrateCapBps: message.relayBitrateCapBps });
      await this.preparePeer(message);
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.RESUMED) {
      if (!this.matchesAuthority(message) || !this.peer) return;
      this.authorized = { ...message, type: REMOTE_DESKTOP_MSG.AUTHORIZED };
      this.daemonGeneration = message.daemonGeneration;
      this.expiresAt = this.serverDeadlineToLocal(message.expiresAt, message.serverTime);
      this.signalingReconnectAttempts = 0;
      this.signalingReconnectInFlight = false;
      this.signalingDisconnectedAt = null;
      this.clearSignalingReconnectTimer();
      this.clearStartTimer();
      this.workerInputEnabled = false;
      this.clearInputAck();
      this.requirePresentedFrameForCurrentTopology();
      const peerState = this.peer.connectionState;
      try {
        this.peer.setConfiguration({ iceServers: toWebRtcIceServers(message.iceServers) });
      } catch {
        // A connected direct path does not need fresh TURN credentials yet.
        // If recovery needs ICE now, however, continuing with credentials that
        // may have expired during the outage would only manufacture a doomed
        // restart and hide the real failure.
        if (this.pendingIceRestart || peerState === 'disconnected' || peerState === 'failed') {
          this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
          return;
        }
      }
      this.publish({
        state: peerState === 'connected' && this.signalingStableState
          ? this.signalingStableState
          : REMOTE_DESKTOP_STATE.RECONNECTING,
        mode: message.mode,
        inputEpoch: message.inputEpoch,
        inputEnabled: false,
      });
      this.signalingStableState = null;
      if (isOpen(this.controlChannel)) {
        this.sendControl({
          type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
          ...this.inputBase(),
          kind: REMOTE_DESKTOP_CONTROL_KIND.HELLO,
        });
      }
      if (this.pendingIceRestart || peerState === 'disconnected' || peerState === 'failed') {
        this.pendingIceRestart = false;
        await this.restartIce(this.peer);
      }
      return;
    }
    // Admission errors are request-bound and intentionally have no session or
    // capability yet. Handle them before the authority matcher, which rejects
    // ERROR by design. Otherwise the browser waits for its negotiation timeout
    // and loses the Server's retryable guidance.
    if (message.type === REMOTE_DESKTOP_MSG.ERROR) {
      this.fail(message.error, message.retryable);
      return;
    }
    if (!this.matchesAuthority(message)) return;
    if (message.type === REMOTE_DESKTOP_MSG.RENEGOTIATE) {
      await this.renegotiate();
      return;
    }
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
      if (!this.peer?.remoteDescription || this.awaitingAnswer) {
        this.pendingRemoteCandidates.push(candidate);
      }
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
        atomicButtonClick: message.atomicButtonClick === true,
        qualityPreferenceSupported: message.qualityPreference === true,
        qualityUltraSupported: message.qualityUltra === true,
        viewerCount: message.viewerCount,
        controllerCount: message.controllerCount,
        signInScreen: message.signInScreen === true,
        unlockAvailable: message.unlockAvailable === true,
        inputBlocked: message.inputBlocked,
      });
      this.flushQualityPreference();
      if (message.inputBlocked === REMOTE_DESKTOP_INPUT_BLOCKED.AWAITING_FRAME
        && !this.pendingPresentedFrame) {
        // The node is waiting for a frame of the current layout and this client
        // has nothing queued to acknowledge with — a topology whose frame was
        // already consumed, or one that arrived without a usable selection.
        // Re-arm from what it knows, or input stays off for the whole session.
        this.requirePresentedFrameForCurrentTopology();
      }
      if (message.state === REMOTE_DESKTOP_STATE.DIRECT || message.state === REMOTE_DESKTOP_STATE.RELAYED) {
        this.clearStartTimer();
      }
      return;
    }
    if (message.type === REMOTE_DESKTOP_MSG.TERMINAL) {
      this.teardown(message.reason);
      return;
    }
  }

  /**
   * The Server's absolute deadline on this browser's clock. A browser clock
   * minutes off otherwise ends the session early or keeps input enabled past
   * the grant. Without a Server time (older Server) it is used as sent.
   */
  private serverDeadlineToLocal(serverDeadline: number, serverTime: number | undefined): number {
    const offset = oneWayServerOffsetMs(serverTime, this.deps.now?.() ?? Date.now());
    return serverDeadline - offset;
  }

  private async preparePeer(authority: Extract<RemoteDesktopServerMessage, { type: typeof REMOTE_DESKTOP_MSG.AUTHORIZED }>): Promise<void> {
    this.sessionId = authority.sessionId;
    this.capability = authority.capability;
    this.daemonGeneration = authority.daemonGeneration;
    this.expiresAt = this.serverDeadlineToLocal(authority.expiresAt, authority.serverTime);
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
    const capabilities = typeof RTCRtpReceiver !== 'undefined'
      ? RTCRtpReceiver.getCapabilities?.('video')
      : null;
    if (capabilities) applyH264ReceiveCodecPreference(transceiver, capabilities.codecs);
    // Non-standard, Chromium-only: hints the jitter buffer to minimize
    // buffering rather than smooth over network jitter, the same tradeoff
    // cloud-gaming/remote-control WebRTC products make. Chrome's default
    // playout delay favors smooth video over latency, which is backwards for
    // a desktop the operator is actively controlling live -- every frame the
    // jitter buffer holds back is added, uniform latency regardless of how
    // quickly the encoder and network actually delivered it. Best-effort:
    // absent on Safari/Firefox, so this silently no-ops there.
    if (transceiver.receiver) {
      (transceiver.receiver as unknown as { playoutDelayHint?: number }).playoutDelayHint = 0;
    }
    this.createDataChannels(peer);
    peer.addEventListener('track', (event) => {
      this.diagnosticTrackCleanup?.();
      const track = event.track;
      const recordTrackState = (
        type: typeof REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK
          | typeof REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_MUTE
          | typeof REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_UNMUTE
          | typeof REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_ENDED,
      ) => {
        if (this.stopped || this.peer !== peer) return;
        this.recordBrowserDiagnostic({
          type,
          trackMuted: track.muted,
          trackReadyState: track.readyState,
        });
      };
      const onMute = () => recordTrackState(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_MUTE);
      const onUnmute = () => recordTrackState(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_UNMUTE);
      const onEnded = () => recordTrackState(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_ENDED);
      track.addEventListener('mute', onMute);
      track.addEventListener('unmute', onUnmute);
      track.addEventListener('ended', onEnded);
      this.diagnosticTrackCleanup = () => {
        track.removeEventListener('mute', onMute);
        track.removeEventListener('unmute', onUnmute);
        track.removeEventListener('ended', onEnded);
      };
      recordTrackState(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK);
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.publish({ stream });
    });
    peer.addEventListener('icecandidate', (event) => {
      // Gathering ends with a candidate carrying an EMPTY candidate line, and
      // then with a null one. Firefox emits both (measured on Firefox 156);
      // Chromium emits only the null one. The empty marker names no address
      // and nothing can be done with it, so it is not sent.
      if (!event.candidate?.candidate || !this.authorityReady()) return;
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
      if (this.peer !== peer) return;
      this.recordBrowserDiagnostic({
        type: REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.PEER_CONNECTION_STATE,
        connectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        signalingState: peer.signalingState,
      });
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
        if (!this.seamlessHandover) {
          this.publish({ state: REMOTE_DESKTOP_STATE.CONNECTING });
        }
      } else if (peer.connectionState === 'connected') {
        this.clearDisconnectTimer();
        this.seamlessHandover = false;
        this.iceRestartInFlight = false;
        this.startStats(peer);
      }
    });
    peer.addEventListener('iceconnectionstatechange', () => {
      if (this.stopped || this.peer !== peer) return;
      this.recordBrowserDiagnostic({
        type: REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.PEER_ICE_STATE,
        connectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        signalingState: peer.signalingState,
      });
    });
    peer.addEventListener('signalingstatechange', () => {
      if (this.stopped || this.peer !== peer) return;
      this.recordBrowserDiagnostic({
        type: REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.PEER_SIGNALING_STATE,
        connectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        signalingState: peer.signalingState,
      });
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

  private createDataChannels(peer: RTCPeerConnection): void {
    const control = peer.createDataChannel(REMOTE_DESKTOP_CHANNEL.CONTROL, { ordered: true });
    const keyboard = peer.createDataChannel(REMOTE_DESKTOP_CHANNEL.KEYBOARD, { ordered: true });
    const pointer = peer.createDataChannel(REMOTE_DESKTOP_CHANNEL.POINTER, { ordered: false, maxRetransmits: 0 });
    this.controlChannel = control;
    this.keyboardChannel = keyboard;
    this.pointerChannel = pointer;
    for (const channel of [control, keyboard, pointer]) {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = DATA_BUFFER_LOW_WATER_BYTES;
      channel.addEventListener('open', () => this.updateChannelReadiness());
      channel.addEventListener('close', () => {
        // The old SCTP association closes its channels during an in-place ICE
        // handover. Only a channel that is still current may fail the session.
        if (this.peer !== peer || ![
          this.controlChannel, this.keyboardChannel, this.pointerChannel,
        ].includes(channel)) return;
        this.releaseAll();
        this.updateChannelReadiness();
        if (!this.stopped) this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
      });
    }
    control.addEventListener('message', (event) => this.handleData(event.data));
    control.addEventListener('open', () => {
      this.sendControl({
        type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
        ...this.inputBase(),
        kind: REMOTE_DESKTOP_CONTROL_KIND.HELLO,
      });
    });
  }

  private publishControlRejection(
    kind: RemoteDesktopControlKind,
    reason: RemoteDesktopControlRejection,
    displayId?: string,
  ): void {
    this.controlRejectionId += 1;
    this.publish({
      controlRejection: {
        id: this.controlRejectionId,
        kind,
        reason,
        ...(displayId === undefined ? {} : { displayId }),
      },
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
    } else if (parsed.value.type === REMOTE_DESKTOP_DATA_MSG.CLIPBOARD) {
      const pending = this.pendingClipboardRequests.get(parsed.value.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingClipboardRequests.delete(parsed.value.requestId);
      pending.resolve(parsed.value.available ? parsed.value.text ?? null : null);
    } else if (parsed.value.type === REMOTE_DESKTOP_DATA_MSG.CONTROL_REJECTED) {
      if (parsed.value.kind === REMOTE_DESKTOP_CONTROL_KIND.PASTE_TEXT
        && parsed.value.reason === REMOTE_DESKTOP_CONTROL_REJECTION.PASTE_UNAVAILABLE
        && this.pendingPaste) {
        const pending = this.pendingPaste;
        this.pendingPaste = null;
        this.sendTypedText(pending.text);
      }
      this.publishControlRejection(
        parsed.value.kind,
        parsed.value.reason,
        parsed.value.displayId,
      );
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
      if (this.pendingPaste
        && parsed.value.acknowledgedSequence >= this.pendingPaste.finalSequence) {
        this.pendingPaste = null;
      }
    }
  }

  private flushPointerMove(): void {
    const move = this.pendingPointerMove;
    this.pendingPointerMove = null;
    if (!move) return;
    if (!this.canSendInput()) {
      this.pointerMoveGateRejected += 1;
      return;
    }
    const now = this.deps.now?.() ?? Date.now();
    this.lastPointerFlushAt = now;
    if (now - this.lastReliablePointerSyncAt >= POINTER_RELIABLE_SYNC_INTERVAL_MS
      && this.sendReliablePointerSync({
        type: REMOTE_DESKTOP_DATA_MSG.POINTER,
        ...this.inputBase(),
        kind: REMOTE_DESKTOP_POINTER_KIND.MOVE,
        ...move,
      })) {
      // The low-latency pointer channel intentionally drops stale packets.
      // Periodically mirror the newest absolute position on the reliable
      // control channel so the remote cursor always converges to the local
      // cursor even when the final unreliable datagram is lost.
      this.lastReliablePointerSyncAt = now;
      this.pointerMovesMirrored += 1;
    }
    if (!isOpen(this.pointerChannel)) {
      this.pointerMoveChannelUnavailable += 1;
      return;
    }
    if (this.pointerChannel.bufferedAmount > DATA_BUFFER_HIGH_WATER_BYTES) {
      // Only the superseded motion is dropped. Key/button transitions use a
      // different reliable channel and never enter this queue.
      this.pointerMoveBackpressureDrops += 1;
      return;
    }
    if (this.sendPointer({
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      ...this.inputBase(),
      kind: REMOTE_DESKTOP_POINTER_KIND.MOVE,
      ...move,
    })) {
      this.pointerMovesSent += 1;
    } else {
      this.pointerMoveSendFailures += 1;
    }
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
    // A reopened channel is a new worker session: it has no preference yet.
    if (!isOpen(this.controlChannel)) this.sentQualityPreferenceKey = null;
    else this.flushQualityPreference();
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
      if (inbound) {
        const diagnosticNumber = (name: string, multiplier = 1): number | undefined => {
          const value = inbound[name];
          return typeof value === 'number' && Number.isFinite(value)
            ? Math.max(0, Math.round(value * multiplier))
            : undefined;
        };
        this.recordBrowserDiagnostic({
          type: REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.INBOUND_STATS,
          connectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          signalingState: peer.signalingState,
          bytesReceived: diagnosticNumber('bytesReceived'),
          packetsReceived: diagnosticNumber('packetsReceived'),
          framesReceived: diagnosticNumber('framesReceived'),
          framesDecoded: diagnosticNumber('framesDecoded'),
          keyFramesDecoded: diagnosticNumber('keyFramesDecoded'),
          framesDropped: diagnosticNumber('framesDropped'),
          freezeCount: diagnosticNumber('freezeCount'),
          totalFreezesDurationMs: diagnosticNumber('totalFreezesDuration', 1_000),
          jitterBufferDelayMs: diagnosticNumber('jitterBufferDelay', 1_000),
          jitterBufferEmittedCount: diagnosticNumber('jitterBufferEmittedCount'),
          documentVisible: this.deps.isDocumentVisible?.()
            ?? (typeof document === 'undefined' || document.visibilityState === 'visible'),
        });
      }
      // A worker that reports its own quality (Windows) supplies the baseline
      // plus encoder/preset; the macOS and Linux workers do not, so the
      // browser's own measurements are the whole picture there.
      const quality = this.snapshot.quality
        ?? { width: 0, height: 0, fps: 0, bitrateBps: 0, droppedFrames: 0, rttMs: 0 };
      const durationMs = Math.max(0, (this.deps.now?.() ?? Date.now()) - this.startedAt);
      if (!inbound) {
        // The pointer counters are the one diagnostic that matters most before
        // there is a picture to measure -- "is anything being sent at all" --
        // so they must not ride along with the quality publish alone.
        this.publish({
          durationMs,
          pointerMovesSent: this.pointerMovesSent,
          pointerMovesMirrored: this.pointerMovesMirrored,
          pointerMoveCalls: this.pointerMoveCalls,
          pointerMoveGateRejected: this.pointerMoveGateRejected,
          pointerMoveChannelUnavailable: this.pointerMoveChannelUnavailable,
          pointerMoveBackpressureDrops: this.pointerMoveBackpressureDrops,
          pointerMoveSendFailures: this.pointerMoveSendFailures,
        });
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
        if (inbound.bytesReceived > 0) this.mediaStarted = true;
        if (!visible) {
          this.lastMediaBytesReceived = inbound.bytesReceived;
          this.lastMediaProgressAt = null;
          this.firstMediaWaitStartedAt = null;
        } else if (!this.mediaStarted) {
          // Still waiting for the first byte. `inbound-rtp` exists from the
          // moment the transceiver does, with bytesReceived pinned at 0, so the
          // stall rule would otherwise declare a peer dead while it is still
          // legitimately setting up a relayed path.
          this.firstMediaWaitStartedAt ??= now;
          this.lastMediaBytesReceived = inbound.bytesReceived;
          this.lastMediaProgressAt = now;
          if (now - this.firstMediaWaitStartedAt
            >= REMOTE_DESKTOP_LIMITS.FIRST_MEDIA_TIMEOUT_MS) {
            this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
            return;
          }
        } else if (this.lastMediaBytesReceived === null
          || inbound.bytesReceived !== this.lastMediaBytesReceived
          || this.lastMediaProgressAt === null) {
          // Media is flowing again, so the recovery that got us here is over.
          // The restart budget bounds a single incident; without releasing it
          // on proof of recovery, a long healthy session eventually spends its
          // lifetime allowance and is torn down by its own weak-network guard.
          if (this.lastMediaBytesReceived !== null
            && inbound.bytesReceived > this.lastMediaBytesReceived) {
            this.iceRestartCount = 0;
          }
          this.lastMediaBytesReceived = inbound.bytesReceived;
          this.lastMediaProgressAt = now;
        } else if (now - this.lastMediaProgressAt
          >= REMOTE_DESKTOP_LIMITS.MEDIA_PROGRESS_TIMEOUT_MS) {
          // Some weak paths keep ICE nominally "connected" after media has
          // stopped flowing. Give that black-holed path the same bounded,
          // in-place recovery as an explicit connection-state failure instead
          // of discarding the mounted stream and starting the whole flow over.
          this.lastMediaProgressAt = now;
          await this.restartIce(peer);
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
        // Average time a frame waited in the playback buffer this interval.
        let jitterBufferMs: number | undefined;
        if (typeof inbound.jitterBufferDelay === 'number' && Number.isFinite(inbound.jitterBufferDelay)
          && typeof inbound.jitterBufferEmittedCount === 'number' && Number.isFinite(inbound.jitterBufferEmittedCount)) {
          const previousBuffer = this.previousJitterBuffer;
          if (previousBuffer && inbound.jitterBufferEmittedCount > previousBuffer.emitted
            && inbound.jitterBufferDelay >= previousBuffer.delay) {
            jitterBufferMs = ((inbound.jitterBufferDelay - previousBuffer.delay)
              / (inbound.jitterBufferEmittedCount - previousBuffer.emitted)) * 1_000;
          }
          this.previousJitterBuffer = { delay: inbound.jitterBufferDelay, emitted: inbound.jitterBufferEmittedCount };
        }
        if (visible && this.mediaStarted) this.observeLatency(rttMs, jitterBufferMs, bitrateBps, fps);
      }
      this.publish({
        pointerMovesSent: this.pointerMovesSent,
        pointerMovesMirrored: this.pointerMovesMirrored,
        pointerMoveCalls: this.pointerMoveCalls,
        pointerMoveGateRejected: this.pointerMoveGateRejected,
        pointerMoveChannelUnavailable: this.pointerMoveChannelUnavailable,
        pointerMoveBackpressureDrops: this.pointerMoveBackpressureDrops,
        pointerMoveSendFailures: this.pointerMoveSendFailures,
        durationMs,
        // Browser-only measurements start once the first frame has a size;
        // before that there is nothing meaningful to show ("0x0 · 0 FPS").
        ...(this.snapshot.quality || width > 0 ? {
          quality: {
            ...quality,
            width,
            height,
            fps,
            bitrateBps,
            droppedFrames,
            ...(rttMs === undefined ? {} : { rttMs }),
          },
        } : {}),
      });
    } catch {
      // Stats are diagnostics only and never change media/input authority.
    } finally {
      this.statsInFlight = false;
    }
  }

  private async restartIce(peer: RTCPeerConnection): Promise<void> {
    if (this.iceRestartInFlight) return;
    if (!this.signaling.isOpen()) {
      this.pendingIceRestart = true;
      this.releaseAll();
      this.workerInputEnabled = false;
      this.publish({ state: REMOTE_DESKTOP_STATE.RECONNECTING, inputEnabled: false });
      return;
    }
    if (this.stopped || this.peer !== peer || !this.authorityReady()
      || this.iceRestartCount >= REMOTE_DESKTOP_LIMITS.MAX_ICE_RESTARTS
      || this.expiresAt <= (this.deps.now?.() ?? Date.now())) {
      this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED);
      return;
    }
    this.iceRestartInFlight = true;
    this.iceRestartCount++;
    // An ICE restart re-gathers a whole new candidate generation, just like
    // `renegotiate()`. The flood cap bounds one negotiation, so it has to be
    // rezeroed here too; counting across generations turns a recovering peer
    // into a protocol_error.
    this.localIceCandidates = 0;
    this.remoteIceCandidates = 0;
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

  private handleSignalingClose(): void {
    if (this.stopped) return;
    // A socket can close after connect() resolved but before RESUMED arrives.
    // Release the in-flight latch so that close itself schedules the next
    // bounded attempt rather than stranding the session in reconnecting.
    this.signalingReconnectInFlight = false;
    if (!this.authorityReady() || !this.peer) {
      this.fail(REMOTE_DESKTOP_TERMINAL_REASON.BROWSER_DISCONNECTED);
      return;
    }
    const now = this.deps.now?.() ?? Date.now();
    this.signalingDisconnectedAt ??= now;
    if (this.snapshot.state === REMOTE_DESKTOP_STATE.DIRECT
      || this.snapshot.state === REMOTE_DESKTOP_STATE.RELAYED) {
      this.signalingStableState = this.snapshot.state;
    }
    this.clearStartTimer();
    this.releaseAll();
    this.workerInputEnabled = false;
    this.clearInputAck();
    if (this.peer.connectionState !== 'connected') this.pendingIceRestart = true;
    this.publish({
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      inputEnabled: false,
      reconnectCount: this.signalingReconnectAttempts + 1,
    });
    this.scheduleSignalingReconnect();
  }

  private scheduleSignalingReconnect(): void {
    if (this.stopped || this.signalingReconnectTimer || this.signalingReconnectInFlight) return;
    const now = this.deps.now?.() ?? Date.now();
    const disconnectedAt = this.signalingDisconnectedAt ?? now;
    const elapsed = now - disconnectedAt;
    if (elapsed >= REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_GRACE_MS
      || this.signalingReconnectAttempts >= REMOTE_DESKTOP_LIMITS.MAX_SIGNALING_RECONNECT_ATTEMPTS
      || this.expiresAt <= now) {
      this.fail(REMOTE_DESKTOP_TERMINAL_REASON.BROWSER_DISCONNECTED);
      return;
    }
    const backoff = REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_BACKOFF_MS
      * (2 ** this.signalingReconnectAttempts);
    const remaining = REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_GRACE_MS - elapsed;
    this.signalingReconnectTimer = setTimeout(() => {
      this.signalingReconnectTimer = null;
      void this.resumeSignaling();
    }, Math.min(
      backoff,
      REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_MAX_BACKOFF_MS,
      remaining,
    ));
  }

  private async resumeSignaling(): Promise<void> {
    if (this.stopped || this.signalingReconnectInFlight || !this.authorityReady()) return;
    this.signalingReconnectInFlight = true;
    this.signalingReconnectAttempts += 1;
    try {
      await this.signaling.connect(
        this.serverId,
        (value) => {
          void this.handleServer(value).catch(() => {
            this.fail(REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR);
          });
        },
        () => this.handleSignalingClose(),
        this.hooks.onDaemonReconnected,
        true,
      );
      if (!this.signaling.send({
        type: REMOTE_DESKTOP_MSG.RESUME,
        protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
        ...this.authorityFields(),
      })) throw new Error('resume_signal_failed');
      this.signalingReconnectInFlight = false;
      const now = this.deps.now?.() ?? Date.now();
      const elapsed = now - (this.signalingDisconnectedAt ?? now);
      this.clearStartTimer();
      this.startTimer = setTimeout(
        () => {
          this.startTimer = null;
          this.signaling.close();
          this.signalingReconnectInFlight = false;
          this.scheduleSignalingReconnect();
        },
        Math.max(1, Math.min(
          REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_ATTEMPT_TIMEOUT_MS,
          REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_GRACE_MS - elapsed,
        )),
      );
    } catch {
      this.signalingReconnectInFlight = false;
      this.scheduleSignalingReconnect();
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

  private sendKeyTransition(code: string, key: string, down: boolean, repeat: boolean): boolean {
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

  /**
   * Reconcile the browser's authoritative modifier flags with the keys that
   * this viewer has actually sent to the worker. Browsers may swallow a
   * modifier key-up when a window/tab loses focus (notably Command shortcuts
   * on macOS), so the next event is the first reliable opportunity to heal the
   * remote state without disturbing modifiers that are still physically held.
   */
  reconcileModifiers(
    modifiers: Partial<Record<RemoteDesktopModifierKind, boolean>>,
    exceptCode?: string,
  ): void {
    if (!this.canSendInput()) return;
    for (const code of [...this.pressedCodes]) {
      const kind = remoteDesktopModifierKind(code);
      if (!kind || code === exceptCode || modifiers[kind] !== false) continue;
      this.sendKeyTransition(code, REMOTE_DESKTOP_MODIFIER_KEY[kind], false, false);
    }
    // A modifier a translated chord or a paste lifted on the remote goes back
    // down before the next key -- but only while the operator still holds it.
    // If its key-up was swallowed, restoring it would press a modifier nobody
    // holds and turn the next letter into a shortcut.
    for (const code of [...this.liftedModifiers]) {
      const kind = remoteDesktopModifierKind(code);
      if (kind && code !== exceptCode && modifiers[kind] === false) this.liftedModifiers.delete(code);
    }
    if (modifiers.meta === false) {
      for (const [code, key] of [...this.pressedWhileMeta]) {
        if (code === exceptCode || !this.pressedCodes.has(code)) {
          this.pressedWhileMeta.delete(code);
          continue;
        }
        if (this.sendKeyTransition(code, key, false, false)) {
          this.pressedWhileMeta.delete(code);
        }
      }
    }
  }

  private heldModifierKinds(): Set<RemoteDesktopModifierKind> {
    const kinds = new Set<RemoteDesktopModifierKind>();
    for (const code of this.pressedCodes) {
      const kind = remoteDesktopModifierKind(code);
      if (kind) kinds.add(kind);
    }
    return kinds;
  }

  /** Release every held modifier `keep` refuses, remembering it as lifted. */
  private liftHeldModifiers(keep: (kind: RemoteDesktopModifierKind) => boolean): boolean {
    for (const code of [...this.pressedCodes]) {
      const kind = remoteDesktopModifierKind(code);
      if (!kind || keep(kind)) continue;
      if (!this.sendKeyTransition(code, REMOTE_DESKTOP_MODIFIER_KEY[kind], false, false)) return false;
      this.liftedModifiers.add(code);
    }
    return true;
  }

  private restoreLiftedModifiers(): boolean {
    for (const code of [...this.liftedModifiers]) {
      const kind = remoteDesktopModifierKind(code);
      if (kind && !this.sendKeyTransition(code, REMOTE_DESKTOP_MODIFIER_KEY[kind], true, false)) return false;
      this.liftedModifiers.delete(code);
    }
    return true;
  }

  /** A chord that could not be delivered whole must not leave anything held. */
  private abandonTap(): false {
    this.releaseAll();
    return false;
  }

  private sendKeyboard(message: object): boolean {
    return this.sendData(this.keyboardChannel, message, true);
  }

  private sendPointer(message: object): boolean {
    return this.sendData(this.pointerChannel, message, false);
  }

  private sendReliablePointerSync(message: object): boolean {
    if (!isOpen(this.controlChannel)
      || this.controlChannel.bufferedAmount > DATA_BUFFER_HIGH_WATER_BYTES) return false;
    return this.sendData(this.controlChannel, message, false);
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
          || parsed.value.kind === REMOTE_DESKTOP_POINTER_KIND.BUTTON_UP
          || parsed.value.kind === REMOTE_DESKTOP_POINTER_KIND.BUTTON_CLICK))
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
    if (message.type === REMOTE_DESKTOP_MSG.BOOTSTRAP_REDEEMED
      || message.type === REMOTE_DESKTOP_MSG.ERROR
      || message.type === REMOTE_DESKTOP_MSG.AUTHORIZED) return false;
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

  private fail(reason: string, retryable?: boolean): void {
    if (this.stopped) return;
    this.publish({
      state: REMOTE_DESKTOP_STATE.FAILED,
      error: reason,
      inputEnabled: false,
      ...(retryable === undefined ? {} : { retryable }),
    });
    this.teardown(reason);
  }

  private teardown(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearStartTimer();
    this.clearSignalingReconnectTimer();
    this.signalingReconnectInFlight = false;
    this.signalingDisconnectedAt = null;
    this.pendingIceRestart = false;
    this.releaseAll();
    try { this.controlChannel?.close(); } catch { /* closed */ }
    try { this.keyboardChannel?.close(); } catch { /* closed */ }
    try { this.pointerChannel?.close(); } catch { /* closed */ }
    try { this.peer?.close(); } catch { /* closed */ }
    this.controlChannel = null;
    this.keyboardChannel = null;
    this.pointerChannel = null;
    this.peer = null;
    this.diagnosticTrackCleanup?.();
    this.diagnosticTrackCleanup = null;
    this.channelsReady = false;
    this.workerInputEnabled = false;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (this.dataKeepaliveTimer) clearInterval(this.dataKeepaliveTimer);
    this.dataKeepaliveTimer = null;
    this.clearDisconnectTimer();
    this.previousInboundStats = null;
    this.previousJitterBuffer = null;
    this.latencyBaselineRttMs = null;
    this.lastMediaBytesReceived = null;
    this.lastMediaProgressAt = null;
    this.clearInputAck();
    this.clearLayoutTransitionTimer();
    for (const pending of this.pendingClipboardRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingClipboardRequests.clear();
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
      // These fields only ever arrive on a live STATUS message, and no more
      // of those are coming once the session is torn down -- publish() only
      // merges the given keys, so leaving them out keeps whatever was last
      // observed on the wire instead of reflecting that nobody is connected
      // any more. Concretely: the "N viewing" footer kept reporting the last
      // real viewer/controller count forever after Stop, on every platform,
      // because this patch never zeroed it.
      viewerCount: 0,
      controllerCount: 0,
      route: undefined,
      quality: undefined,
      signInScreen: false,
      unlockAvailable: false,
      inputBlocked: undefined,
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

  private clearSignalingReconnectTimer(): void {
    if (this.signalingReconnectTimer) clearTimeout(this.signalingReconnectTimer);
    this.signalingReconnectTimer = null;
  }

  private beginLayoutTransition(): void {
    this.workerInputEnabled = false;
    this.pendingPresentedFrame = null;
    this.presentedLayoutRevision = 0;
    this.presentedDisplayId = null;
    // The picture legitimately stops while the new layout is built, so the
    // stall rule — which exists for media that died — must not be the thing
    // that judges it. This is a first frame again, bounded by the transition
    // budget below.
    this.mediaStarted = false;
    this.firstMediaWaitStartedAt = null;
    this.lastMediaProgressAt = null;
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
