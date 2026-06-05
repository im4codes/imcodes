/**
 * Shared Local Web Preview protocol constants.
 * Single source of truth for daemon/server/web message names and binary frame tags.
 */

export const PREVIEW_MSG = {
  CREATE: 'preview.create',
  CLOSE: 'preview.close',
  REQUEST: 'preview.request',
  REQUEST_BODY: 'preview.request_body',
  REQUEST_END: 'preview.request_end',
  RESPONSE_START: 'preview.response_start',
  RESPONSE_BODY: 'preview.response_body',
  RESPONSE_END: 'preview.response_end',
  ABORT: 'preview.abort',
  ERROR: 'preview.error',
  WS_OPEN: 'preview.ws.open',
  WS_OPENED: 'preview.ws.opened',
  WS_CLOSE: 'preview.ws.close',
  WS_ERROR: 'preview.ws.error',
} as const;

export const PREVIEW_ACCESS_TOKEN_QUERY_PARAM = 'preview_access_token';

export type PreviewMessageType = (typeof PREVIEW_MSG)[keyof typeof PREVIEW_MSG];

export const PREVIEW_BINARY_FRAME = {
  REQUEST_BODY: 0x02,
  RESPONSE_BODY: 0x03,
  WS_DATA: 0x04,
} as const;

export type PreviewBinaryFrameType = (typeof PREVIEW_BINARY_FRAME)[keyof typeof PREVIEW_BINARY_FRAME];

export const PREVIEW_TERMINAL_OUTCOME = {
  RESPONSE_END: 'response_end',
  ERROR: 'error',
  ABORTED: 'aborted',
  TIMEOUT: 'timeout',
  LIMIT_EXCEEDED: 'limit_exceeded',
} as const;

export type PreviewTerminalOutcome = (typeof PREVIEW_TERMINAL_OUTCOME)[keyof typeof PREVIEW_TERMINAL_OUTCOME];

/**
 * Read a positive-integer override from an env var when running under Node
 * (daemon/server). Browser-safe: when `process` is absent (web bundle) or the
 * value is missing/invalid, the compiled-in default is used. Used so preview
 * limits are env-tunable (per design A21 — tests set small thresholds; public
 * deployments can tighten) without breaking the browser build.
 */
function previewLimitFromEnv(name: string, def: number): number {
  try {
    const raw = (typeof process !== 'undefined' && process.env) ? process.env[name] : undefined;
    if (raw == null || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
  } catch {
    return def;
  }
}

export const PREVIEW_LIMITS = {
  MAX_REQUEST_BYTES: 10 * 1024 * 1024,
  MAX_RESPONSE_BYTES: previewLimitFromEnv('PREVIEW_MAX_RESPONSE_BYTES', 50 * 1024 * 1024),
  DEFAULT_TTL_MS: 30 * 60 * 1000,
  DEFAULT_IDLE_TTL_MS: 10 * 60 * 1000,
  /**
   * Absolute hard ceiling on a preview's lifetime (run 8a975732-23a A9).
   * Activity slides `expiresAt` (DEFAULT_TTL_MS each touch) but never past
   * `createdAt + PREVIEW_MAX_LIFETIME_HARD_MS` — so a long-running dev session
   * survives, but a single stream is not unbounded (the byte-cap-exemption × TTL
   * coupling guard).
   */
  PREVIEW_MAX_LIFETIME_HARD_MS: previewLimitFromEnv('PREVIEW_MAX_LIFETIME_HARD_MS', 8 * 60 * 60 * 1000),
  RESPONSE_START_TIMEOUT_MS: 30_000,
  STREAM_IDLE_TIMEOUT_MS: 120_000,
  MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER: 8,
  /**
   * Per-request COUNT rate-limit constants — DEPRECATED (run 85582241/8a975732):
   * the count-based limiter (`previewRateLimiter`) misfires on a real SPA first
   * paint (dozens–hundreds of sub-resource requests) and is removed from the
   * proxy path. Replaced by the in-flight concurrency floor below. Kept only so
   * any lingering reference still type-checks; do NOT reintroduce count limiting.
   */
  MAX_REQUESTS_PER_WINDOW: 120,
  REQUEST_RATE_WINDOW_MS: 60_000,
  /**
   * In-flight (concurrent unsettled) HTTP request floor — the resource-dimension
   * abuse guard that replaces per-request count limiting. Defaults are high
   * enough that a normal SPA first paint (browsers cap ~6 concurrent/host) never
   * trips it; only scripted abuse against the loopback upstream is blocked. WS
   * tunnels are NOT counted here (they have MAX_WS_PER_PREVIEW). env-tunable.
   */
  MAX_INFLIGHT_PREVIEW_HTTP_PER_PREVIEW: previewLimitFromEnv('PREVIEW_MAX_INFLIGHT_PER_PREVIEW', 64),
  MAX_INFLIGHT_PREVIEW_HTTP_PER_SERVER: previewLimitFromEnv('PREVIEW_MAX_INFLIGHT_PER_SERVER', 256),
  /**
   * Unconsumed-buffer high-watermark for a streaming response on the server side
   * (run 8a975732-23a A7). Measured in BYTES (via ByteLengthQueuingStrategy or an
   * explicit unconsumed-byte counter — NOT ReadableStreamDefaultController
   * .desiredSize). Exceeding it deterministically closes the stream. MUST ship in
   * the same PR as the streaming byte-cap exemption.
   */
  MAX_PREVIEW_STREAM_BUFFER_BYTES: previewLimitFromEnv('PREVIEW_MAX_STREAM_BUFFER_BYTES', 16 * 1024 * 1024),
  MAX_WS_PER_PREVIEW: 8,
  MAX_WS_PER_SERVER: 16,
  MAX_WS_MESSAGE_BYTES: 1_048_576, // 1MB
  WS_IDLE_TIMEOUT_MS: 300_000, // 5 minutes
  WS_OPEN_TIMEOUT_MS: 15_000, // 15 seconds
  MAX_WS_PENDING_QUEUE_BYTES: 65_536, // 64KB
} as const;

/**
 * Browser-local MRU history cap for the preview port/path input dropdowns
 * (run 8a975732-23a B / capability local-web-preview-input-history). Web-side
 * constant; not env-tunable.
 */
export const LOCAL_PREVIEW_HISTORY_MAX = 10;

/**
 * HTTP status returned when the in-flight preview concurrency floor is hit
 * (run 8a975732-23a A5). 503 (not 429) to distinguish from the removed
 * count-based rate limiter. Pairs with PREVIEW_ERROR.INFLIGHT_LIMIT.
 */
export const PREVIEW_INFLIGHT_REJECT_HTTP_STATUS = 503;

export const PREVIEW_ERROR = {
  FORBIDDEN: 'forbidden',
  INVALID_PORT: 'invalid_port',
  INVALID_PATH: 'invalid_path',
  PREVIEW_NOT_FOUND: 'preview_not_found',
  PREVIEW_EXPIRED: 'preview_expired',
  DAEMON_OFFLINE: 'daemon_offline',
  NOT_IMPLEMENTED: 'not_implemented',
  UPSTREAM_UNREACHABLE: 'upstream_unreachable',
  UPSTREAM_ERROR: 'upstream_error',
  LIMIT_EXCEEDED: 'limit_exceeded',
  INFLIGHT_LIMIT: 'inflight_limit',
  ABORTED: 'aborted',
  TIMEOUT: 'timeout',
  INVALID_REQUEST: 'invalid_request',
} as const;

export interface PreviewRecord {
  id: string;
  serverId: string;
  userId: string;
  port: number;
  path: string;
  createdAt: number;
  expiresAt: number;
  lastAccessAt: number;
}

export interface CreatePreviewRequest {
  port: number;
  path?: string;
}

export interface CreatePreviewResponse {
  ok: true;
  preview: Pick<PreviewRecord, 'id' | 'serverId' | 'port' | 'path' | 'expiresAt'> & {
    url: string;
    accessToken: string;
  };
}

export interface PreviewRequestMessage {
  type: typeof PREVIEW_MSG.REQUEST;
  requestId: string;
  previewId: string;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  hasBody: boolean;
}

export interface PreviewRequestEndMessage {
  type: typeof PREVIEW_MSG.REQUEST_END;
  requestId: string;
}

export interface PreviewResponseStartMessage {
  type: typeof PREVIEW_MSG.RESPONSE_START;
  requestId: string;
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
}

export interface PreviewResponseEndMessage {
  type: typeof PREVIEW_MSG.RESPONSE_END;
  requestId: string;
}

export interface PreviewErrorMessage {
  type: typeof PREVIEW_MSG.ERROR;
  requestId: string;
  code: string;
  message?: string;
  terminalOutcome?: PreviewTerminalOutcome;
}

export interface PreviewWsOpenMessage {
  type: typeof PREVIEW_MSG.WS_OPEN;
  wsId: string;
  previewId: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  protocols: string[];
}

export interface PreviewWsOpenedMessage {
  type: typeof PREVIEW_MSG.WS_OPENED;
  wsId: string;
  protocol?: string;
}

export interface PreviewWsCloseMessage {
  type: typeof PREVIEW_MSG.WS_CLOSE;
  wsId: string;
  code: number;
  reason: string;
}

export interface PreviewWsErrorMessage {
  type: typeof PREVIEW_MSG.WS_ERROR;
  wsId: string;
  error: string;
}

export function packPreviewBinaryFrame(frameType: PreviewBinaryFrameType, requestId: string, payload: Uint8Array): Buffer {
  const idBytes = Buffer.from(requestId, 'utf8');
  const header = Buffer.allocUnsafe(3 + idBytes.length);
  header[0] = frameType;
  header.writeUInt16BE(idBytes.length, 1);
  idBytes.copy(header, 3);
  return Buffer.concat([header, Buffer.from(payload)]);
}

// NOTE: Returns null for 0x04 (WS_DATA) frames intentionally — callers must check
// the first byte to dispatch to parsePreviewWsFrame for WS tunnel frames.
export function parsePreviewBinaryFrame(data: Buffer): { frameType: PreviewBinaryFrameType; requestId: string; payload: Buffer } | null {
  if (data.length < 3) return null;
  const frameType = data[0] as PreviewBinaryFrameType;
  if (frameType !== PREVIEW_BINARY_FRAME.REQUEST_BODY && frameType !== PREVIEW_BINARY_FRAME.RESPONSE_BODY) return null;
  const idLength = data.readUInt16BE(1);
  if (data.length < 3 + idLength) return null;
  const requestId = data.subarray(3, 3 + idLength).toString('utf8');
  return {
    frameType,
    requestId,
    payload: data.subarray(3 + idLength),
  };
}

/**
 * Pack a WS tunnel data frame.
 * Frame format: [0x04][16 raw bytes wsId][1-byte flags][payload]
 * wsId may be in UUID format (with dashes) or dashless 32-char hex — dashes are stripped before encoding.
 * flags bit 0: 1 = binary, 0 = text
 */
export function packPreviewWsFrame(wsId: string, isBinary: boolean, payload: Uint8Array): Buffer {
  // Strip dashes to handle UUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  const idBuf = Buffer.from(wsId.replace(/-/g, ''), 'hex');
  const header = Buffer.allocUnsafe(1 + 16 + 1);
  header[0] = PREVIEW_BINARY_FRAME.WS_DATA;
  idBuf.copy(header, 1, 0, 16);
  header[17] = isBinary ? 1 : 0;
  return Buffer.concat([header, Buffer.from(payload)]);
}

/**
 * Parse a WS tunnel data frame.
 * Returns wsId as dashless 32-char hex string.
 * Both sides should normalize wsId to dashless hex for comparison.
 * Returns null if data is not a valid WS_DATA frame.
 */
export function parsePreviewWsFrame(data: Buffer): { wsId: string; isBinary: boolean; payload: Buffer } | null {
  if (data.length < 18 || data[0] !== PREVIEW_BINARY_FRAME.WS_DATA) return null;
  const wsId = data.subarray(1, 17).toString('hex');
  const isBinary = (data[17] & 0x01) !== 0;
  const payload = data.subarray(18);
  return { wsId, isBinary, payload };
}
