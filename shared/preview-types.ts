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
} as const;

export const PREVIEW_ACCESS_TOKEN_QUERY_PARAM = 'preview_access_token';

export type PreviewMessageType = (typeof PREVIEW_MSG)[keyof typeof PREVIEW_MSG];

export const PREVIEW_BINARY_FRAME = {
  REQUEST_BODY: 0x02,
  RESPONSE_BODY: 0x03,
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

export const PREVIEW_LIMITS = {
  MAX_REQUEST_BYTES: 10 * 1024 * 1024,
  MAX_RESPONSE_BYTES: 50 * 1024 * 1024,
  DEFAULT_TTL_MS: 30 * 60 * 1000,
  DEFAULT_IDLE_TTL_MS: 10 * 60 * 1000,
  RESPONSE_START_TIMEOUT_MS: 30_000,
  STREAM_IDLE_TIMEOUT_MS: 120_000,
  MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER: 8,
  MAX_REQUESTS_PER_WINDOW: 120,
  REQUEST_RATE_WINDOW_MS: 60_000,
} as const;

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

export function packPreviewBinaryFrame(frameType: PreviewBinaryFrameType, requestId: string, payload: Uint8Array): Buffer {
  const idBytes = Buffer.from(requestId, 'utf8');
  const header = Buffer.allocUnsafe(3 + idBytes.length);
  header[0] = frameType;
  header.writeUInt16BE(idBytes.length, 1);
  idBytes.copy(header, 3);
  return Buffer.concat([header, Buffer.from(payload)]);
}

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
