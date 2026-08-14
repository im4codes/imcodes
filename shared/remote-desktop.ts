import {
  DIRECT_CONNECTIVITY_ROUTE,
  isDirectFileTransferIceServerConfig,
  type DirectFileTransferIceServerConfig,
} from './direct-file-transfer.js';

export const REMOTE_DESKTOP_CAPABILITY = 'remote.desktop.windows.h264.v2' as const;
export const REMOTE_DESKTOP_PROTOCOL_VERSION = 2 as const;
export const REMOTE_DESKTOP_SIGNALING_PATH = '/api/remote-desktop/ws' as const;
export const REMOTE_DESKTOP_SERVER_ID_QUERY = 'serverId' as const;

export const REMOTE_DESKTOP_ROUTE = DIRECT_CONNECTIVITY_ROUTE;
export type RemoteDesktopRoute = typeof REMOTE_DESKTOP_ROUTE[keyof typeof REMOTE_DESKTOP_ROUTE];

export const REMOTE_DESKTOP_STATE = {
  AUTHORIZING: 'authorizing',
  PREPARING: 'preparing',
  CONNECTING: 'connecting',
  DIRECT: 'direct',
  RELAYED: 'relayed',
  SWITCHING_DISPLAY: 'switching_display',
  RECONNECTING: 'reconnecting',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  FAILED: 'failed',
} as const;

export type RemoteDesktopState = typeof REMOTE_DESKTOP_STATE[keyof typeof REMOTE_DESKTOP_STATE];

export const REMOTE_DESKTOP_MSG = {
  START: 'remote_desktop.start',
  AUTHORIZED: 'remote_desktop.authorized',
  PREPARE: 'remote_desktop.prepare',
  OFFER: 'remote_desktop.offer',
  ANSWER: 'remote_desktop.answer',
  ICE: 'remote_desktop.ice',
  LEASE: 'remote_desktop.lease',
  MODE_SET: 'remote_desktop.mode_set',
  MODE_STATE: 'remote_desktop.mode_state',
  CANCEL: 'remote_desktop.cancel',
  STOP: 'remote_desktop.stop',
  STATUS: 'remote_desktop.status',
  TERMINAL: 'remote_desktop.terminal',
  ERROR: 'remote_desktop.error',
} as const;

export const REMOTE_DESKTOP_DATA_MSG = {
  DISPLAY_TOPOLOGY: 'remote_desktop.data.display_topology',
  QUALITY: 'remote_desktop.data.quality',
  CLIPBOARD: 'remote_desktop.data.clipboard',
  POINTER: 'remote_desktop.data.pointer',
  KEYBOARD: 'remote_desktop.data.keyboard',
  CONTROL: 'remote_desktop.data.control',
  RELEASE_ALL: 'remote_desktop.data.release_all',
} as const;

export const REMOTE_DESKTOP_CHANNEL = {
  CONTROL: 'imcodes-rd-control',
  KEYBOARD: 'imcodes-rd-keyboard',
  POINTER: 'imcodes-rd-pointer',
} as const;

export const REMOTE_DESKTOP_TERMINAL_REASON = {
  STOPPED_BY_CONTROLLER: 'stopped_by_controller',
  STOPPED_BY_LOCAL_USER: 'stopped_by_local_user',
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  AUTHORITY_REVOKED: 'authority_revoked',
  AUTHORITY_EXPIRED: 'authority_expired',
  LEASE_EXPIRED: 'lease_expired',
  IDLE_TIMEOUT: 'idle_timeout',
  EXECUTION_DISABLED: 'execution_disabled',
  BROWSER_DISCONNECTED: 'browser_disconnected',
  DAEMON_REPLACED: 'daemon_replaced',
  WORKER_FAILED: 'worker_failed',
  MEDIA_UNAVAILABLE: 'media_unavailable',
  NEGOTIATION_TIMEOUT: 'negotiation_timeout',
  PEER_FAILED: 'peer_failed',
  PROTECTED_DESKTOP: 'protected_desktop',
  SESSION_LIMIT: 'session_limit',
  PROTOCOL_ERROR: 'protocol_error',
  INTERNAL_ERROR: 'internal_error',
} as const;

export const REMOTE_DESKTOP_ERROR = {
  INVALID_REQUEST: 'invalid_request',
  INVALID_AUTHORITY: 'invalid_authority',
  AUTHORITY_EXPIRED: 'authority_expired',
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  ACCESS_DENIED: 'access_denied',
  EXECUTION_DISABLED: 'execution_disabled',
  DAEMON_OFFLINE: 'daemon_offline',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  SESSION_LIMIT: 'session_limit',
  NEGOTIATION_TIMEOUT: 'negotiation_timeout',
  INTERNAL_ERROR: 'internal_error',
} as const;

export const REMOTE_DESKTOP_ACCESS_MODE = {
  VIEW: 'view',
  CONTROL: 'control',
} as const;

export type RemoteDesktopAccessMode = typeof REMOTE_DESKTOP_ACCESS_MODE[
  keyof typeof REMOTE_DESKTOP_ACCESS_MODE
];

export const REMOTE_DESKTOP_MODE_REASON = {
  INITIAL: 'initial',
  USER_SELECTED: 'user_selected',
  AUTHORITY_LOST: 'authority_lost',
} as const;

export type RemoteDesktopModeReason = typeof REMOTE_DESKTOP_MODE_REASON[
  keyof typeof REMOTE_DESKTOP_MODE_REASON
];

export type RemoteDesktopTerminalReason = typeof REMOTE_DESKTOP_TERMINAL_REASON[keyof typeof REMOTE_DESKTOP_TERMINAL_REASON];

export const REMOTE_DESKTOP_POINTER_KIND = {
  MOVE: 'move',
  BUTTON_DOWN: 'button_down',
  BUTTON_UP: 'button_up',
  WHEEL: 'wheel',
} as const;

export const REMOTE_DESKTOP_POINTER_BUTTON = {
  LEFT: 'left',
  MIDDLE: 'middle',
  RIGHT: 'right',
  BACK: 'back',
  FORWARD: 'forward',
} as const;

export const REMOTE_DESKTOP_KEYBOARD_KIND = {
  KEY_DOWN: 'key_down',
  KEY_UP: 'key_up',
  TEXT: 'text',
} as const;

export const REMOTE_DESKTOP_CONTROL_KIND = {
  HELLO: 'hello',
  FRAME_PRESENTED: 'frame_presented',
  SELECT_DISPLAY: 'select_display',
  SET_DISPLAY_MODE: 'set_display_mode',
  SET_DISPLAY_SCALE: 'set_display_scale',
  COPY_SELECTION: 'copy_selection',
  KEEPALIVE: 'keepalive',
  INPUT_ACK: 'input_ack',
} as const;

export const REMOTE_DESKTOP_COMMON_DISPLAY_MODES = [
  { width: 1280, height: 720, label: '720p', recommendedDpiScalePercent: 125 },
  { width: 1920, height: 1080, label: '1080p', recommendedDpiScalePercent: 150 },
  { width: 2560, height: 1440, label: '1440p', recommendedDpiScalePercent: 175 },
  { width: 3840, height: 2160, label: '4K', recommendedDpiScalePercent: 225 },
] as const;

export const REMOTE_DESKTOP_DPI_SCALE_PERCENTS = [
  100, 125, 150, 175, 200, 225, 250, 300,
] as const;

export const REMOTE_DESKTOP_DISPLAY_ROTATION = {
  ROTATE_0: 0,
  ROTATE_90: 90,
  ROTATE_180: 180,
  ROTATE_270: 270,
} as const;

export const REMOTE_DESKTOP_QUALITY_PRESET = {
  P2160_30: '2160p30',
  P2160_15: '2160p15',
  P1440_30: '1440p30',
  P1080_30: '1080p30',
  P900_30: '900p30',
  P720_30: '720p30',
  P720_15: '720p15',
  P540_15: '540p15',
  P360_5: '360p5',
} as const;

export const REMOTE_DESKTOP_ENCODER_CLASS = {
  HARDWARE: 'hardware',
  SOFTWARE: 'software',
} as const;

export const REMOTE_DESKTOP_AUDIT_EVENT = {
  REQUESTED: 'remote_desktop.requested',
  ADMITTED: 'remote_desktop.admitted',
  CONNECTED: 'remote_desktop.connected',
  INPUT_ENABLED: 'remote_desktop.input_enabled',
  DISPLAY_CHANGED: 'remote_desktop.display_changed',
  RECONNECTING: 'remote_desktop.reconnecting',
  STOPPED: 'remote_desktop.stopped',
  REVOKED: 'remote_desktop.revoked',
  FAILED: 'remote_desktop.failed',
} as const;

export const REMOTE_DESKTOP_LIMITS = {
  REQUEST_ID_BYTES: 128,
  SESSION_ID_BYTES: 128,
  CAPABILITY_BYTES: 128,
  DISPLAY_ID_BYTES: 128,
  DISPLAY_LABEL_BYTES: 256,
  SDP_BYTES: 256 * 1024,
  ICE_CANDIDATE_BYTES: 16 * 1024,
  ICE_MID_BYTES: 256,
  ICE_SERVER_ENTRIES: 8,
  DISPLAYS: 16,
  KEY_CODE_BYTES: 64,
  KEY_VALUE_BYTES: 64,
  TEXT_BYTES: 4 * 1024,
  TEXT_CODE_UNITS: 2 * 1024,
  PASTE_TEXT_BYTES: 64 * 1024,
  CLIPBOARD_TEXT_BYTES: 12 * 1024,
  ERROR_DETAIL_BYTES: 512,
  // A cold Windows path includes Authenticode re-verification, active-user
  // worker launch, DXGI's first presentable frame, and ICE.  Production data
  // showed healthy direct sessions taking about 10s, so the former 15s bound
  // cut off normal cold starts with almost no scheduling/network headroom.
  NEGOTIATION_TIMEOUT_MS: 45_000,
  LEASE_DURATION_MS: 15_000,
  LEASE_RENEW_INTERVAL_MS: 5_000,
  KEEPALIVE_TIMEOUT_MS: 15_000,
  DATA_KEEPALIVE_INTERVAL_MS: 30_000,
  MEDIA_PROGRESS_TIMEOUT_MS: 10_000,
  IDLE_TIMEOUT_MS: 15 * 60_000,
  ABSOLUTE_LIFETIME_MS: 2 * 60 * 60_000,
  MAX_PER_BROWSER: 1,
  MAX_PER_USER: 2,
  MAX_PER_MACHINE: 4,
  MAX_PEER_CONNECTIONS_PER_WORKER: 4,
  MAX_TURN_ALLOCATIONS_PER_MACHINE: 4,
  MAX_ICE_CANDIDATES: 128,
  MAX_SIGNALING_PER_MINUTE: 600,
  MAX_SIGNALING_PER_MACHINE_PER_MINUTE: 2_400,
  MAX_STARTS_PER_MINUTE: 10,
  MAX_STARTS_PER_USER_PER_MINUTE: 20,
  MAX_STARTS_PER_MACHINE_PER_MINUTE: 40,
  MAX_AUDITS_PER_MACHINE_PER_MINUTE: 120,
  MAX_RECONNECT_ATTEMPTS: 3,
  // Old Windows hardware MFTs can take roughly three seconds to release their
  // final queued surfaces after PeerConnection teardown. Keep a bounded
  // margin before a replacement software encoder is created in the same
  // worker process.
  RECONNECT_BACKOFF_BASE_MS: 5_000,
  // Bound each outage independently. A connection that remains healthy for
  // this window earns a fresh retry budget, so a later transient drop does not
  // permanently strand a long-running remote-control panel.
  RECONNECT_STABILITY_RESET_MS: 30_000,
  MAX_ICE_RESTARTS: 1,
  MAX_MODE_CHANGES_PER_MINUTE: 30,
  MAX_POINTER_EVENTS_PER_SECOND: 240,
  MAX_KEYBOARD_EVENTS_PER_SECOND: 120,
  MAX_MONITOR_CHANGES_PER_MINUTE: 30,
  MAX_VIDEO_BITRATE_BPS: 15_000_000,
  MAX_AGGREGATE_VIDEO_BITRATE_BPS: 60_000_000,
  MAX_DISTINCT_CAPTURE_SOURCES: 4,
  MAX_GPU_CAPTURE_SURFACES: 4,
  MAX_WORKER_MEMORY_BYTES: 1024 * 1024 * 1024,
  MAX_ENCODER_QUEUE_FRAMES: 3,
} as const;

export const REMOTE_DESKTOP_QUALITY_LADDER = [
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P2160_30, width: 3840, height: 2160, fps: 30, targetBitrateBps: 15_000_000 },
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P2160_15, width: 3840, height: 2160, fps: 15, targetBitrateBps: 12_000_000 },
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P1440_30, width: 2560, height: 1440, fps: 30, targetBitrateBps: 10_000_000 },
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P1080_30, width: 1920, height: 1080, fps: 30, targetBitrateBps: 6_000_000 },
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P900_30, width: 1600, height: 900, fps: 30, targetBitrateBps: 4_500_000 },
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P720_30, width: 1280, height: 720, fps: 30, targetBitrateBps: 3_000_000 },
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P720_15, width: 1280, height: 720, fps: 15, targetBitrateBps: 1_800_000 },
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P540_15, width: 960, height: 540, fps: 15, targetBitrateBps: 1_000_000 },
  { id: REMOTE_DESKTOP_QUALITY_PRESET.P360_5, width: 640, height: 360, fps: 5, targetBitrateBps: 350_000 },
] as const;

export interface RemoteDesktopStart {
  type: typeof REMOTE_DESKTOP_MSG.START;
  protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
  requestId: string;
  reconnectAttempt?: number;
}

export interface RemoteDesktopAuthority {
  requestId: string;
  sessionId: string;
  capability: string;
  expiresAt: number;
  leaseExpiresAt: number;
  daemonGeneration: number;
  mode: RemoteDesktopAccessMode;
  inputEpoch: number;
  iceServers: DirectFileTransferIceServerConfig[];
}

export interface RemoteDesktopAuthorized extends RemoteDesktopAuthority {
  type: typeof REMOTE_DESKTOP_MSG.AUTHORIZED;
}

export interface RemoteDesktopPrepare extends RemoteDesktopAuthority {
  type: typeof REMOTE_DESKTOP_MSG.PREPARE;
  reconnectAttempt?: number;
}

export interface RemoteDesktopOffer {
  type: typeof REMOTE_DESKTOP_MSG.OFFER;
  requestId: string;
  sessionId: string;
  capability: string;
  sdp: string;
}

export interface RemoteDesktopAnswer extends Omit<RemoteDesktopOffer, 'type'> {
  type: typeof REMOTE_DESKTOP_MSG.ANSWER;
}

export interface RemoteDesktopIce {
  type: typeof REMOTE_DESKTOP_MSG.ICE;
  requestId: string;
  sessionId: string;
  capability: string;
  candidate: string;
  mid: string;
}

export interface RemoteDesktopLease {
  type: typeof REMOTE_DESKTOP_MSG.LEASE;
  requestId: string;
  sessionId: string;
  capability: string;
  leaseExpiresAt: number;
  daemonGeneration: number;
  mode: RemoteDesktopAccessMode;
  inputEpoch: number;
}

export interface RemoteDesktopModeSet {
  type: typeof REMOTE_DESKTOP_MSG.MODE_SET;
  requestId: string;
  sessionId: string;
  capability: string;
  mode: RemoteDesktopAccessMode;
}

export interface RemoteDesktopModeState {
  type: typeof REMOTE_DESKTOP_MSG.MODE_STATE;
  requestId: string;
  sessionId: string;
  capability: string;
  mode: RemoteDesktopAccessMode;
  inputEpoch: number;
  reason: RemoteDesktopModeReason;
}

export interface RemoteDesktopStop {
  type: typeof REMOTE_DESKTOP_MSG.STOP;
  requestId: string;
  sessionId: string;
  capability: string;
  aggregateBytesReceived?: number;
}

export interface RemoteDesktopCancel {
  type: typeof REMOTE_DESKTOP_MSG.CANCEL;
  requestId: string;
  sessionId: string;
  capability: string;
}

export interface RemoteDesktopStatus {
  type: typeof REMOTE_DESKTOP_MSG.STATUS;
  requestId: string;
  sessionId: string;
  capability: string;
  mode: RemoteDesktopAccessMode;
  inputEpoch: number;
  state: RemoteDesktopState;
  route?: RemoteDesktopRoute;
  selectedDisplayId?: string;
  layoutRevision?: number;
  inputEnabled: boolean;
  viewerCount?: number;
  controllerCount?: number;
}

export interface RemoteDesktopTerminal {
  type: typeof REMOTE_DESKTOP_MSG.TERMINAL;
  requestId: string;
  sessionId: string;
  capability: string;
  reason: RemoteDesktopTerminalReason;
  detail?: string;
}

export interface RemoteDesktopError {
  type: typeof REMOTE_DESKTOP_MSG.ERROR;
  requestId: string;
  error: typeof REMOTE_DESKTOP_ERROR[keyof typeof REMOTE_DESKTOP_ERROR];
  retryable: boolean;
  detail?: string;
}

export interface RemoteDesktopDisplay {
  id: string;
  label: string;
  primary: boolean;
  available: boolean;
  width: number;
  height: number;
  dpiScale: number;
  rotation: typeof REMOTE_DESKTOP_DISPLAY_ROTATION[keyof typeof REMOTE_DESKTOP_DISPLAY_ROTATION];
}

export interface RemoteDesktopDisplayTopology {
  type: typeof REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY;
  protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
  sessionId: string;
  sequence: number;
  layoutRevision: number;
  displays: RemoteDesktopDisplay[];
  selectedDisplayId?: string;
}

export interface RemoteDesktopQuality {
  type: typeof REMOTE_DESKTOP_DATA_MSG.QUALITY;
  protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
  sessionId: string;
  sequence: number;
  preset: typeof REMOTE_DESKTOP_QUALITY_PRESET[keyof typeof REMOTE_DESKTOP_QUALITY_PRESET];
  encoderClass: typeof REMOTE_DESKTOP_ENCODER_CLASS[keyof typeof REMOTE_DESKTOP_ENCODER_CLASS];
  width: number;
  height: number;
  fps: number;
  bitrateBps: number;
  droppedFrames: number;
  rttMs: number;
}

export interface RemoteDesktopClipboard {
  type: typeof REMOTE_DESKTOP_DATA_MSG.CLIPBOARD;
  protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
  sessionId: string;
  sequence: number;
  requestId: string;
  available: boolean;
  text?: string;
}

interface RemoteDesktopInputBase {
  protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
  sessionId: string;
  sequence: number;
  layoutRevision: number;
  inputEpoch: number;
}

export interface RemoteDesktopPointer extends RemoteDesktopInputBase {
  type: typeof REMOTE_DESKTOP_DATA_MSG.POINTER;
  kind: typeof REMOTE_DESKTOP_POINTER_KIND[keyof typeof REMOTE_DESKTOP_POINTER_KIND];
  x?: number;
  y?: number;
  button?: typeof REMOTE_DESKTOP_POINTER_BUTTON[keyof typeof REMOTE_DESKTOP_POINTER_BUTTON];
  deltaX?: number;
  deltaY?: number;
}

export interface RemoteDesktopKeyboard extends RemoteDesktopInputBase {
  type: typeof REMOTE_DESKTOP_DATA_MSG.KEYBOARD;
  kind: typeof REMOTE_DESKTOP_KEYBOARD_KIND[keyof typeof REMOTE_DESKTOP_KEYBOARD_KIND];
  code?: string;
  key?: string;
  repeat?: boolean;
  text?: string;
}

export interface RemoteDesktopControl extends RemoteDesktopInputBase {
  type: typeof REMOTE_DESKTOP_DATA_MSG.CONTROL;
  kind: typeof REMOTE_DESKTOP_CONTROL_KIND[keyof typeof REMOTE_DESKTOP_CONTROL_KIND];
  enabled?: boolean;
  displayId?: string;
  width?: number;
  height?: number;
  dpiScalePercent?: number;
  requestId?: string;
  frameWidth?: number;
  frameHeight?: number;
  acknowledgedSequence?: number;
}

export interface RemoteDesktopReleaseAll extends RemoteDesktopInputBase {
  type: typeof REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL;
}

export type RemoteDesktopBrowserMessage = RemoteDesktopStart | RemoteDesktopOffer | RemoteDesktopIce | RemoteDesktopModeSet | RemoteDesktopCancel | RemoteDesktopStop;
export type RemoteDesktopDaemonCommand = RemoteDesktopPrepare | RemoteDesktopOffer | RemoteDesktopIce | RemoteDesktopLease | RemoteDesktopModeState | RemoteDesktopCancel | RemoteDesktopStop;
export type RemoteDesktopDaemonMessage = RemoteDesktopAnswer | RemoteDesktopIce | RemoteDesktopModeState | RemoteDesktopStatus | RemoteDesktopTerminal;
export type RemoteDesktopServerMessage = RemoteDesktopAuthorized | RemoteDesktopAnswer | RemoteDesktopIce | RemoteDesktopModeState | RemoteDesktopStatus | RemoteDesktopTerminal | RemoteDesktopError;
export type RemoteDesktopDataMessage = RemoteDesktopDisplayTopology | RemoteDesktopQuality | RemoteDesktopClipboard | RemoteDesktopPointer | RemoteDesktopKeyboard | RemoteDesktopControl | RemoteDesktopReleaseAll;

export type RemoteDesktopValidationResult<T> = { ok: true; value: T } | { ok: false; error: typeof REMOTE_DESKTOP_ERROR.INVALID_REQUEST };

export interface RemoteDesktopSequenceState {
  sessionId: string;
  layoutRevision: number;
  inputEpoch: number;
  lastSequence: number;
}

export interface RemoteDesktopNormalizedPoint {
  x: number;
  y: number;
}

export interface RemoteDesktopPhysicalPoint {
  x: number;
  y: number;
}

/**
 * Decoded video may be adaptively scaled, but it must preserve the selected
 * display aspect before the browser can acknowledge that layout for input.
 */
export function isRemoteDesktopPresentedFrameCompatible(
  frameWidth: number,
  frameHeight: number,
  displayWidth: number,
  displayHeight: number,
): boolean {
  const dimensions = [frameWidth, frameHeight, displayWidth, displayHeight];
  if (!dimensions.every((value) => (
    Number.isSafeInteger(value) && value > 0 && value <= 16_384
  ))) return false;
  const first = frameWidth * displayHeight;
  const second = frameHeight * displayWidth;
  return Math.abs(first - second) * 100 <= Math.max(first, second);
}

export interface RemoteDesktopVideoPointMapping {
  clientX: number;
  clientY: number;
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  videoWidth: number;
  videoHeight: number;
}

const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CAPABILITY_RE = /^[A-Za-z0-9_-]{43}$/;
const STATES = new Set<string>(Object.values(REMOTE_DESKTOP_STATE));
const ROUTES = new Set<string>(Object.values(REMOTE_DESKTOP_ROUTE));
const TERMINAL_REASONS = new Set<string>(Object.values(REMOTE_DESKTOP_TERMINAL_REASON));
const ERRORS = new Set<string>(Object.values(REMOTE_DESKTOP_ERROR));
const ACCESS_MODES = new Set<string>(Object.values(REMOTE_DESKTOP_ACCESS_MODE));
const MODE_REASONS = new Set<string>(Object.values(REMOTE_DESKTOP_MODE_REASON));
const ROTATIONS = new Set<number>(Object.values(REMOTE_DESKTOP_DISPLAY_ROTATION));
const QUALITY_PRESETS = new Set<string>(Object.values(REMOTE_DESKTOP_QUALITY_PRESET));
const ENCODER_CLASSES = new Set<string>(Object.values(REMOTE_DESKTOP_ENCODER_CLASS));
const POINTER_KINDS = new Set<string>(Object.values(REMOTE_DESKTOP_POINTER_KIND));
const POINTER_BUTTONS = new Set<string>(Object.values(REMOTE_DESKTOP_POINTER_BUTTON));
const KEYBOARD_KINDS = new Set<string>(Object.values(REMOTE_DESKTOP_KEYBOARD_KIND));
const CONTROL_KINDS = new Set<string>(Object.values(REMOTE_DESKTOP_CONTROL_KIND));

function invalid<T>(): RemoteDesktopValidationResult<T> {
  return { ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Bytes(value) <= maxBytes;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function isCapability(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_RE.test(value);
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function hasSessionCorrelation(value: Record<string, unknown>): boolean {
  return isId(value.requestId) && isId(value.sessionId) && isCapability(value.capability);
}

function hasInputCorrelation(value: Record<string, unknown>): boolean {
  return value.protocolVersion === REMOTE_DESKTOP_PROTOCOL_VERSION
    && isId(value.sessionId)
    && isSafeNonNegative(value.sequence)
    && isSafePositive(value.layoutRevision)
    && isSafeNonNegative(value.inputEpoch);
}

function validateAuthority(value: Record<string, unknown>): boolean {
  return hasSessionCorrelation(value)
    && isSafePositive(value.expiresAt)
    && isSafePositive(value.leaseExpiresAt)
    && value.leaseExpiresAt <= value.expiresAt
    && isSafePositive(value.daemonGeneration)
    && typeof value.mode === 'string' && ACCESS_MODES.has(value.mode)
    && isSafeNonNegative(value.inputEpoch)
    && (value.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL || (value.inputEpoch as number) > 0)
    && Array.isArray(value.iceServers)
    && value.iceServers.length <= REMOTE_DESKTOP_LIMITS.ICE_SERVER_ENTRIES
    && value.iceServers.every(isDirectFileTransferIceServerConfig);
}

function validateSdp(value: Record<string, unknown>): boolean {
  return hasSessionCorrelation(value) && isBoundedString(value.sdp, REMOTE_DESKTOP_LIMITS.SDP_BYTES);
}

function validateIce(value: Record<string, unknown>): boolean {
  return hasSessionCorrelation(value)
    && isBoundedString(value.candidate, REMOTE_DESKTOP_LIMITS.ICE_CANDIDATE_BYTES)
    && isBoundedString(value.mid, REMOTE_DESKTOP_LIMITS.ICE_MID_BYTES);
}

export function validateRemoteDesktopBrowserMessage(value: unknown): RemoteDesktopValidationResult<RemoteDesktopBrowserMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === REMOTE_DESKTOP_MSG.START) {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'requestId'], ['reconnectAttempt'])
      || value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION
      || !isId(value.requestId)
      || (value.reconnectAttempt !== undefined
        && (!isSafeNonNegative(value.reconnectAttempt)
          || value.reconnectAttempt > REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS))) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopStart };
  }
  if (value.type === REMOTE_DESKTOP_MSG.OFFER) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'sdp']) || !validateSdp(value)) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopOffer };
  }
  if (value.type === REMOTE_DESKTOP_MSG.ICE) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'candidate', 'mid']) || !validateIce(value)) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopIce };
  }
  if (value.type === REMOTE_DESKTOP_MSG.MODE_SET) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'mode'])
      || !hasSessionCorrelation(value)
      || typeof value.mode !== 'string' || !ACCESS_MODES.has(value.mode)) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopModeSet };
  }
  if (value.type === REMOTE_DESKTOP_MSG.CANCEL) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability']) || !hasSessionCorrelation(value)) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopCancel };
  }
  if (value.type === REMOTE_DESKTOP_MSG.STOP) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability'], ['aggregateBytesReceived'])
      || !hasSessionCorrelation(value)
      || (value.aggregateBytesReceived !== undefined
        && !isSafeNonNegative(value.aggregateBytesReceived))) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopStop };
  }
  return invalid();
}

export function validateRemoteDesktopDaemonCommand(value: unknown): RemoteDesktopValidationResult<RemoteDesktopDaemonCommand> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === REMOTE_DESKTOP_MSG.PREPARE) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'expiresAt', 'leaseExpiresAt', 'daemonGeneration', 'mode', 'inputEpoch', 'iceServers'], ['reconnectAttempt'])
      || !validateAuthority(value)
      || (value.reconnectAttempt !== undefined
        && (!isSafeNonNegative(value.reconnectAttempt)
          || value.reconnectAttempt > REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS))) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopPrepare };
  }
  if (value.type === REMOTE_DESKTOP_MSG.LEASE) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'leaseExpiresAt', 'daemonGeneration', 'mode', 'inputEpoch'])
      || !hasSessionCorrelation(value)
      || !isSafePositive(value.leaseExpiresAt)
      || !isSafePositive(value.daemonGeneration)
      || typeof value.mode !== 'string' || !ACCESS_MODES.has(value.mode)
      || !isSafeNonNegative(value.inputEpoch)
      || (value.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL && (value.inputEpoch as number) === 0)) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopLease };
  }
  if (value.type === REMOTE_DESKTOP_MSG.MODE_STATE) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'mode', 'inputEpoch', 'reason'])
      || !hasSessionCorrelation(value)
      || typeof value.mode !== 'string' || !ACCESS_MODES.has(value.mode)
      || !isSafeNonNegative(value.inputEpoch)
      || (value.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL && (value.inputEpoch as number) === 0)
      || typeof value.reason !== 'string'
      || !MODE_REASONS.has(value.reason)) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopModeState };
  }
  const browser = validateRemoteDesktopBrowserMessage(value);
  if (browser.ok
    && browser.value.type !== REMOTE_DESKTOP_MSG.START
    && browser.value.type !== REMOTE_DESKTOP_MSG.MODE_SET) {
    return { ok: true, value: browser.value };
  }
  return invalid();
}

export function validateRemoteDesktopDaemonMessage(value: unknown): RemoteDesktopValidationResult<RemoteDesktopDaemonMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === REMOTE_DESKTOP_MSG.ANSWER) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'sdp']) || !validateSdp(value)) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopAnswer };
  }
  if (value.type === REMOTE_DESKTOP_MSG.ICE) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'candidate', 'mid']) || !validateIce(value)) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopIce };
  }
  if (value.type === REMOTE_DESKTOP_MSG.MODE_STATE) {
    const command = validateRemoteDesktopDaemonCommand(value);
    return command.ok && command.value.type === REMOTE_DESKTOP_MSG.MODE_STATE
      ? { ok: true, value: command.value }
      : invalid();
  }
  if (value.type === REMOTE_DESKTOP_MSG.STATUS) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'mode', 'inputEpoch', 'state', 'inputEnabled'], ['route', 'selectedDisplayId', 'layoutRevision', 'viewerCount', 'controllerCount'])
      || !hasSessionCorrelation(value)
      || typeof value.mode !== 'string' || !ACCESS_MODES.has(value.mode)
      || !isSafeNonNegative(value.inputEpoch)
      || typeof value.state !== 'string' || !STATES.has(value.state)
      || (value.route !== undefined && (typeof value.route !== 'string' || !ROUTES.has(value.route)))
      || (value.selectedDisplayId !== undefined
        && !isBoundedString(value.selectedDisplayId, REMOTE_DESKTOP_LIMITS.DISPLAY_ID_BYTES))
      || (value.layoutRevision !== undefined
        && (!Number.isSafeInteger(value.layoutRevision) || (value.layoutRevision as number) <= 0))
      || ((value.selectedDisplayId === undefined) !== (value.layoutRevision === undefined))
      || typeof value.inputEnabled !== 'boolean'
      || (value.viewerCount !== undefined
        && (!isSafeNonNegative(value.viewerCount) || value.viewerCount > REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE))
      || (value.controllerCount !== undefined
        && (!isSafeNonNegative(value.controllerCount) || value.controllerCount > REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE))
      || (value.viewerCount !== undefined && value.controllerCount !== undefined
        && value.controllerCount > value.viewerCount)
      || (value.inputEnabled && (value.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL || (value.inputEpoch as number) === 0))) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopStatus };
  }
  if (value.type === REMOTE_DESKTOP_MSG.TERMINAL) {
    if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'reason'], ['detail'])
      || !hasSessionCorrelation(value)
      || typeof value.reason !== 'string' || !TERMINAL_REASONS.has(value.reason)
      || (value.detail !== undefined && !isBoundedString(value.detail, REMOTE_DESKTOP_LIMITS.ERROR_DETAIL_BYTES))) return invalid();
    return { ok: true, value: value as unknown as RemoteDesktopTerminal };
  }
  return invalid();
}

export function validateRemoteDesktopAuthorized(value: unknown): RemoteDesktopValidationResult<RemoteDesktopAuthorized> {
  if (!isRecord(value)
    || value.type !== REMOTE_DESKTOP_MSG.AUTHORIZED
    || !hasExactKeys(value, ['type', 'requestId', 'sessionId', 'capability', 'expiresAt', 'leaseExpiresAt', 'daemonGeneration', 'mode', 'inputEpoch', 'iceServers'])
    || !validateAuthority(value)) return invalid();
  return { ok: true, value: value as unknown as RemoteDesktopAuthorized };
}

export function validateRemoteDesktopServerMessage(value: unknown): RemoteDesktopValidationResult<RemoteDesktopServerMessage> {
  const authorized = validateRemoteDesktopAuthorized(value);
  if (authorized.ok) return authorized;
  const daemon = validateRemoteDesktopDaemonMessage(value);
  if (daemon.ok) return daemon;
  const command = validateRemoteDesktopDaemonCommand(value);
  if (command.ok && command.value.type === REMOTE_DESKTOP_MSG.MODE_STATE) {
    return { ok: true, value: command.value as RemoteDesktopModeState };
  }
  if (!isRecord(value)
    || value.type !== REMOTE_DESKTOP_MSG.ERROR
    || !hasExactKeys(value, ['type', 'requestId', 'error', 'retryable'], ['detail'])
    || !isId(value.requestId)
    || typeof value.error !== 'string' || !ERRORS.has(value.error)
    || typeof value.retryable !== 'boolean'
    || (value.detail !== undefined && !isBoundedString(value.detail, REMOTE_DESKTOP_LIMITS.ERROR_DETAIL_BYTES))) return invalid();
  return { ok: true, value: value as unknown as RemoteDesktopError };
}

function isDisplay(value: unknown): value is RemoteDesktopDisplay {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'label', 'primary', 'available', 'width', 'height', 'dpiScale', 'rotation'])) return false;
  return isBoundedString(value.id, REMOTE_DESKTOP_LIMITS.DISPLAY_ID_BYTES)
    && isBoundedString(value.label, REMOTE_DESKTOP_LIMITS.DISPLAY_LABEL_BYTES)
    && typeof value.primary === 'boolean'
    && typeof value.available === 'boolean'
    && isSafePositive(value.width) && value.width <= 16_384
    && isSafePositive(value.height) && value.height <= 16_384
    && isFiniteRange(value.dpiScale, 0.5, 8)
    && typeof value.rotation === 'number' && ROTATIONS.has(value.rotation);
}

function hasUniqueDisplayIds(displays: readonly RemoteDesktopDisplay[]): boolean {
  return new Set(displays.map((display) => display.id)).size === displays.length;
}

function validateDisplayTopology(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['type', 'protocolVersion', 'sessionId', 'sequence', 'layoutRevision', 'displays'], ['selectedDisplayId'])
    || value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION
    || !isId(value.sessionId)
    || !isSafeNonNegative(value.sequence)
    || !isSafePositive(value.layoutRevision)
    || !Array.isArray(value.displays)
    || value.displays.length === 0
    || value.displays.length > REMOTE_DESKTOP_LIMITS.DISPLAYS
    || !value.displays.every(isDisplay)
    || !hasUniqueDisplayIds(value.displays)) return false;
  return value.selectedDisplayId === undefined
    || (isBoundedString(value.selectedDisplayId, REMOTE_DESKTOP_LIMITS.DISPLAY_ID_BYTES)
      && value.displays.some((display) => display.id === value.selectedDisplayId && display.available));
}

function validateQuality(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['type', 'protocolVersion', 'sessionId', 'sequence', 'preset', 'encoderClass', 'width', 'height', 'fps', 'bitrateBps', 'droppedFrames', 'rttMs'])
    && value.protocolVersion === REMOTE_DESKTOP_PROTOCOL_VERSION
    && isId(value.sessionId)
    && isSafeNonNegative(value.sequence)
    && typeof value.preset === 'string' && QUALITY_PRESETS.has(value.preset)
    && typeof value.encoderClass === 'string' && ENCODER_CLASSES.has(value.encoderClass)
    && isSafePositive(value.width) && value.width <= 16_384
    && isSafePositive(value.height) && value.height <= 16_384
    && isFiniteRange(value.fps, 0, 240)
    && isSafeNonNegative(value.bitrateBps) && value.bitrateBps <= REMOTE_DESKTOP_LIMITS.MAX_VIDEO_BITRATE_BPS
    && isSafeNonNegative(value.droppedFrames)
    && isFiniteRange(value.rttMs, 0, 3_600_000);
}

function validateClipboard(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(
    value,
    ['type', 'protocolVersion', 'sessionId', 'sequence', 'requestId', 'available'],
    ['text'],
  )
    || value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION
    || !isId(value.sessionId)
    || !isSafeNonNegative(value.sequence)
    || !isId(value.requestId)
    || typeof value.available !== 'boolean') return false;
  return value.available
    ? isBoundedString(value.text, REMOTE_DESKTOP_LIMITS.CLIPBOARD_TEXT_BYTES)
    : value.text === undefined;
}

function validatePointer(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['type', 'protocolVersion', 'sessionId', 'sequence', 'layoutRevision', 'inputEpoch', 'kind'], ['x', 'y', 'button', 'deltaX', 'deltaY'])
    || !hasInputCorrelation(value)
    || !isSafePositive(value.inputEpoch)
    || typeof value.kind !== 'string' || !POINTER_KINDS.has(value.kind)) return false;
  if (value.kind === REMOTE_DESKTOP_POINTER_KIND.MOVE) {
    return isFiniteRange(value.x, 0, 1) && isFiniteRange(value.y, 0, 1)
      && value.button === undefined && value.deltaX === undefined && value.deltaY === undefined;
  }
  if (value.kind === REMOTE_DESKTOP_POINTER_KIND.BUTTON_DOWN || value.kind === REMOTE_DESKTOP_POINTER_KIND.BUTTON_UP) {
    return typeof value.button === 'string' && POINTER_BUTTONS.has(value.button)
      && (value.x === undefined || isFiniteRange(value.x, 0, 1))
      && (value.y === undefined || isFiniteRange(value.y, 0, 1))
      && value.deltaX === undefined && value.deltaY === undefined;
  }
  return isFiniteRange(value.deltaX, -10_000, 10_000)
    && isFiniteRange(value.deltaY, -10_000, 10_000)
    && value.button === undefined
    && (value.x === undefined || isFiniteRange(value.x, 0, 1))
    && (value.y === undefined || isFiniteRange(value.y, 0, 1));
}

function validateKeyboard(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['type', 'protocolVersion', 'sessionId', 'sequence', 'layoutRevision', 'inputEpoch', 'kind'], ['code', 'key', 'repeat', 'text'])
    || !hasInputCorrelation(value)
    || !isSafePositive(value.inputEpoch)
    || typeof value.kind !== 'string' || !KEYBOARD_KINDS.has(value.kind)) return false;
  if (value.kind === REMOTE_DESKTOP_KEYBOARD_KIND.TEXT) {
    return isBoundedString(value.text, REMOTE_DESKTOP_LIMITS.TEXT_BYTES)
      && value.code === undefined && value.key === undefined && value.repeat === undefined;
  }
  return isBoundedString(value.code, REMOTE_DESKTOP_LIMITS.KEY_CODE_BYTES)
    && isBoundedString(value.key, REMOTE_DESKTOP_LIMITS.KEY_VALUE_BYTES)
    && typeof value.repeat === 'boolean'
    && value.text === undefined;
}

function validateControl(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['type', 'protocolVersion', 'sessionId', 'sequence', 'layoutRevision', 'inputEpoch', 'kind'], ['displayId', 'width', 'height', 'dpiScalePercent', 'requestId', 'frameWidth', 'frameHeight', 'acknowledgedSequence'])
    || !hasInputCorrelation(value)
    || typeof value.kind !== 'string' || !CONTROL_KINDS.has(value.kind)) return false;
  if (value.kind === REMOTE_DESKTOP_CONTROL_KIND.SELECT_DISPLAY) {
    return isBoundedString(value.displayId, REMOTE_DESKTOP_LIMITS.DISPLAY_ID_BYTES)
      && value.width === undefined && value.height === undefined
      && value.dpiScalePercent === undefined && value.requestId === undefined
      && value.frameWidth === undefined && value.frameHeight === undefined
      && value.acknowledgedSequence === undefined;
  }
  if (value.kind === REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE) {
    return isBoundedString(value.displayId, REMOTE_DESKTOP_LIMITS.DISPLAY_ID_BYTES)
      && REMOTE_DESKTOP_COMMON_DISPLAY_MODES.some((mode) => (
        value.width === mode.width && value.height === mode.height
      ))
      && value.dpiScalePercent === undefined && value.requestId === undefined
      && value.frameWidth === undefined && value.frameHeight === undefined
      && value.acknowledgedSequence === undefined;
  }
  if (value.kind === REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_SCALE) {
    return isBoundedString(value.displayId, REMOTE_DESKTOP_LIMITS.DISPLAY_ID_BYTES)
      && typeof value.dpiScalePercent === 'number'
      && REMOTE_DESKTOP_DPI_SCALE_PERCENTS.includes(
        value.dpiScalePercent as typeof REMOTE_DESKTOP_DPI_SCALE_PERCENTS[number],
      )
      && value.width === undefined && value.height === undefined
      && value.requestId === undefined
      && value.frameWidth === undefined && value.frameHeight === undefined
      && value.acknowledgedSequence === undefined;
  }
  if (value.kind === REMOTE_DESKTOP_CONTROL_KIND.COPY_SELECTION) {
    return isId(value.requestId)
      && value.displayId === undefined && value.width === undefined
      && value.height === undefined && value.dpiScalePercent === undefined
      && value.frameWidth === undefined && value.frameHeight === undefined
      && value.acknowledgedSequence === undefined;
  }
  if (value.kind === REMOTE_DESKTOP_CONTROL_KIND.FRAME_PRESENTED) {
    return isBoundedString(value.displayId, REMOTE_DESKTOP_LIMITS.DISPLAY_ID_BYTES)
      && isSafePositive(value.frameWidth) && (value.frameWidth as number) <= 16_384
      && isSafePositive(value.frameHeight) && (value.frameHeight as number) <= 16_384
      && value.width === undefined && value.height === undefined
      && value.dpiScalePercent === undefined && value.requestId === undefined
      && value.acknowledgedSequence === undefined;
  }
  if (value.kind === REMOTE_DESKTOP_CONTROL_KIND.INPUT_ACK) {
    return isSafeNonNegative(value.acknowledgedSequence)
      && value.displayId === undefined && value.width === undefined
      && value.height === undefined && value.frameWidth === undefined
      && value.frameHeight === undefined && value.dpiScalePercent === undefined
      && value.requestId === undefined;
  }
  return value.displayId === undefined && value.width === undefined
    && value.height === undefined && value.frameWidth === undefined
    && value.frameHeight === undefined && value.acknowledgedSequence === undefined
    && value.dpiScalePercent === undefined && value.requestId === undefined;
}

export function validateRemoteDesktopDataMessage(value: unknown): RemoteDesktopValidationResult<RemoteDesktopDataMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY && validateDisplayTopology(value)) {
    return { ok: true, value: value as unknown as RemoteDesktopDisplayTopology };
  }
  if (value.type === REMOTE_DESKTOP_DATA_MSG.QUALITY && validateQuality(value)) {
    return { ok: true, value: value as unknown as RemoteDesktopQuality };
  }
  if (value.type === REMOTE_DESKTOP_DATA_MSG.CLIPBOARD && validateClipboard(value)) {
    return { ok: true, value: value as unknown as RemoteDesktopClipboard };
  }
  if (value.type === REMOTE_DESKTOP_DATA_MSG.POINTER && validatePointer(value)) {
    return { ok: true, value: value as unknown as RemoteDesktopPointer };
  }
  if (value.type === REMOTE_DESKTOP_DATA_MSG.KEYBOARD && validateKeyboard(value)) {
    return { ok: true, value: value as unknown as RemoteDesktopKeyboard };
  }
  if (value.type === REMOTE_DESKTOP_DATA_MSG.CONTROL && validateControl(value)) {
    return { ok: true, value: value as unknown as RemoteDesktopControl };
  }
  if (value.type === REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL
    && hasExactKeys(value, ['type', 'protocolVersion', 'sessionId', 'sequence', 'layoutRevision', 'inputEpoch'])
    && hasInputCorrelation(value)
    && isSafePositive(value.inputEpoch)) {
    return { ok: true, value: value as unknown as RemoteDesktopReleaseAll };
  }
  return invalid();
}

/**
 * Stateless replay/layout guard for a caller-owned per-channel sequence state.
 * The caller advances lastSequence only after the validated operation succeeds.
 */
export function isRemoteDesktopSequenceAccepted(
  message: Pick<RemoteDesktopInputBase, 'sessionId' | 'sequence' | 'layoutRevision' | 'inputEpoch'>,
  state: RemoteDesktopSequenceState,
): boolean {
  return message.sessionId === state.sessionId
    && message.layoutRevision === state.layoutRevision
    && message.inputEpoch === state.inputEpoch
    && Number.isSafeInteger(message.sequence)
    && message.sequence > state.lastSequence;
}

/** Converts a browser pointer to normalized video-content coordinates. */
export function mapRemoteDesktopVideoPoint(
  mapping: RemoteDesktopVideoPointMapping,
): RemoteDesktopNormalizedPoint | null {
  if (!Object.values(mapping).every((value) => typeof value === 'number' && Number.isFinite(value))
    || mapping.viewportWidth <= 0
    || mapping.viewportHeight <= 0
    || mapping.videoWidth <= 0
    || mapping.videoHeight <= 0) return null;

  const scale = Math.min(
    mapping.viewportWidth / mapping.videoWidth,
    mapping.viewportHeight / mapping.videoHeight,
  );
  const contentWidth = mapping.videoWidth * scale;
  const contentHeight = mapping.videoHeight * scale;
  const contentLeft = mapping.viewportLeft + ((mapping.viewportWidth - contentWidth) / 2);
  const contentTop = mapping.viewportTop + ((mapping.viewportHeight - contentHeight) / 2);
  const contentX = mapping.clientX - contentLeft;
  const contentY = mapping.clientY - contentTop;

  if (contentX < 0 || contentY < 0 || contentX > contentWidth || contentY > contentHeight) return null;
  return {
    x: Math.min(1, Math.max(0, contentX / contentWidth)),
    y: Math.min(1, Math.max(0, contentY / contentHeight)),
  };
}

/**
 * Maps normalized post-rotation video coordinates to monitor-relative physical
 * pixels. dpiScale is diagnostic and must not be multiplied in again.
 */
export function mapRemoteDesktopPointToPhysicalPixels(
  point: RemoteDesktopNormalizedPoint,
  display: Pick<RemoteDesktopDisplay, 'width' | 'height' | 'dpiScale' | 'rotation' | 'available'>,
  inputLayoutRevision: number,
  currentLayoutRevision: number,
): RemoteDesktopPhysicalPoint | null {
  if (!display.available
    || !isSafePositive(inputLayoutRevision)
    || inputLayoutRevision !== currentLayoutRevision
    || !isSafePositive(display.width)
    || !isSafePositive(display.height)
    || !isFiniteRange(display.dpiScale, 0.5, 8)
    || !ROTATIONS.has(display.rotation)
    || !isFiniteRange(point.x, 0, 1)
    || !isFiniteRange(point.y, 0, 1)) return null;

  return {
    x: Math.min(display.width - 1, Math.floor(point.x * display.width)),
    y: Math.min(display.height - 1, Math.floor(point.y * display.height)),
  };
}

export function isRemoteDesktopMessageType(value: unknown): value is string {
  return typeof value === 'string' && (Object.values(REMOTE_DESKTOP_MSG) as string[]).includes(value);
}

export function isRemoteDesktopDaemonMessageType(value: unknown): boolean {
  return value === REMOTE_DESKTOP_MSG.ANSWER
    || value === REMOTE_DESKTOP_MSG.ICE
    || value === REMOTE_DESKTOP_MSG.MODE_STATE
    || value === REMOTE_DESKTOP_MSG.STATUS
    || value === REMOTE_DESKTOP_MSG.TERMINAL;
}
