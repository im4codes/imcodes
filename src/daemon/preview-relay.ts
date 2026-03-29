import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import type { ServerLink } from './server-link.js';
import logger from '../util/logger.js';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_ERROR,
  PREVIEW_LIMITS,
  PREVIEW_MSG,
  PREVIEW_TERMINAL_OUTCOME,
  packPreviewBinaryFrame,
  packPreviewWsFrame,
  parsePreviewBinaryFrame,
  parsePreviewWsFrame,
  type PreviewRequestMessage,
  type PreviewTerminalOutcome,
  type PreviewWsOpenMessage,
  type PreviewWsCloseMessage,
} from '../../shared/preview-types.js';
import { normalizePreviewUpstreamPath } from '../../shared/preview-policy.js';

type PendingPreviewRequest = {
  abortController: AbortController;
  bodyStream: PassThrough | null;
  requestBytes: number;
  responseBytes: number;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout>;
  timerMode: 'start' | 'idle';
};

const pendingPreviewRequests = new Map<string, PendingPreviewRequest>();
const LOOPBACK_HOST = '127.0.0.1';

// ── Preview registry: tracks previewId → port so WS tunnel can validate port ─
// Populated when HTTP requests arrive. The server always sends the correct port,
// but we cross-check to defend against confused-deputy scenarios.
const previewPortRegistry = new Map<string, number>();

// ── Active WS tunnels: wsId (dashless hex) → upstream WebSocket ──────────────
const activeWsTunnels = new Map<string, WebSocket>();

/** Normalize wsId to dashless 32-char hex (UUIDs have dashes, raw hex does not). */
function normalizeWsId(wsId: string): string {
  return wsId.replace(/-/g, '');
}

function sendWsError(serverLink: ServerLink, wsId: string, error: string): void {
  try {
    serverLink.send({ type: PREVIEW_MSG.WS_ERROR, wsId, error });
  } catch {
    // disconnected
  }
}

function cleanupWsTunnel(wsId: string): void {
  const ws = activeWsTunnels.get(wsId);
  activeWsTunnels.delete(wsId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.close(); } catch { /* ignore */ }
  }
}

function getSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  if (headers.has('set-cookie')) {
    logger.warn('Preview upstream Set-Cookie stripping fallback triggered; getSetCookie() unavailable');
  }
  return [];
}

function responseHeadersToRecord(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return;
    out[name] = value;
  });
  const setCookies = getSetCookieValues(headers);
  if (setCookies.length > 0) out['set-cookie'] = setCookies;
  return out;
}

function buildUpstreamHeaders(input: Record<string, string>, port: number): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (lower === 'host') continue;
    if (lower === 'origin') continue;
    if (lower === 'referer') continue;
    if (lower === 'accept-encoding') continue;
    headers.set(name, value);
  }
  headers.set('host', `${LOOPBACK_HOST}:${port}`);
  headers.set('accept-encoding', 'identity');
  return headers;
}

function mapPreviewErrorCode(error: unknown, timedOut: boolean): string {
  if (timedOut) return PREVIEW_ERROR.TIMEOUT;
  if (error instanceof Error && error.name === 'AbortError') return PREVIEW_ERROR.ABORTED;
  if (error instanceof Error && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT/i.test(error.message)) {
    return PREVIEW_ERROR.UPSTREAM_UNREACHABLE;
  }
  return PREVIEW_ERROR.UPSTREAM_ERROR;
}

function failPreviewRequest(
  serverLink: ServerLink,
  requestId: string,
  code: string,
  message?: string,
  outcome: PreviewTerminalOutcome = PREVIEW_TERMINAL_OUTCOME.ERROR,
): void {
  try {
    serverLink.send({
      type: PREVIEW_MSG.ERROR,
      requestId,
      code,
      message,
      terminalOutcome: outcome,
    });
  } catch {
    // disconnected
  }
}

function cleanupPreviewRequest(requestId: string): PendingPreviewRequest | null {
  const pending = pendingPreviewRequests.get(requestId) ?? null;
  if (!pending) return null;
  clearTimeout(pending.timer);
  pendingPreviewRequests.delete(requestId);
  return pending;
}

function resetPreviewTimeout(
  requestId: string,
  timeoutMs: number,
  mode: 'start' | 'idle',
): void {
  const pending = pendingPreviewRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.timerMode = mode;
  pending.timer = setTimeout(() => {
    const active = pendingPreviewRequests.get(requestId);
    if (!active) return;
    active.timedOut = true;
    active.abortController.abort();
  }, timeoutMs);
}

async function runPreviewFetch(serverLink: ServerLink, msg: PreviewRequestMessage, pending: PendingPreviewRequest): Promise<void> {
  const targetUrl = new URL(normalizePreviewUpstreamPath(msg.path), `http://${LOOPBACK_HOST}:${msg.port}`);
  try {
    const response = await fetch(targetUrl, {
      method: msg.method,
      headers: buildUpstreamHeaders(msg.headers, msg.port),
      body: pending.bodyStream as unknown as BodyInit | null | undefined,
      duplex: pending.bodyStream ? 'half' : undefined,
      redirect: 'manual',
      signal: pending.abortController.signal,
    } as RequestInit & { duplex?: 'half' });

    serverLink.send({
      type: PREVIEW_MSG.RESPONSE_START,
      requestId: msg.requestId,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersToRecord(response.headers),
    });
    resetPreviewTimeout(msg.requestId, PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS, 'idle');

    if (response.body) {
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pending.responseBytes += buffer.length;
        if (pending.responseBytes > PREVIEW_LIMITS.MAX_RESPONSE_BYTES) {
          pending.abortController.abort();
          failPreviewRequest(serverLink, msg.requestId, PREVIEW_ERROR.LIMIT_EXCEEDED, 'preview response exceeded byte limit', PREVIEW_TERMINAL_OUTCOME.LIMIT_EXCEEDED);
          cleanupPreviewRequest(msg.requestId);
          return;
        }
        resetPreviewTimeout(msg.requestId, PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS, 'idle');
        serverLink.sendBinary(packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.RESPONSE_BODY, msg.requestId, buffer));
      }
    }

    cleanupPreviewRequest(msg.requestId);
    serverLink.send({ type: PREVIEW_MSG.RESPONSE_END, requestId: msg.requestId });
  } catch (error) {
    const active = cleanupPreviewRequest(msg.requestId);
    if (!active) return;
    const code = mapPreviewErrorCode(error, active.timedOut);
    const outcome = code === PREVIEW_ERROR.TIMEOUT
      ? PREVIEW_TERMINAL_OUTCOME.TIMEOUT
      : code === PREVIEW_ERROR.ABORTED
        ? PREVIEW_TERMINAL_OUTCOME.ABORTED
        : PREVIEW_TERMINAL_OUTCOME.ERROR;
    failPreviewRequest(serverLink, msg.requestId, code, error instanceof Error ? error.message : String(error), outcome);
    logger.warn({ requestId: msg.requestId, code, err: error }, 'Preview upstream request failed');
  }
}

export function handlePreviewCommand(cmd: Record<string, unknown>, serverLink: ServerLink): boolean {
  if (cmd.type === PREVIEW_MSG.REQUEST) {
    const msg = cmd as unknown as PreviewRequestMessage;
    if (typeof msg.requestId !== 'string' || typeof msg.path !== 'string' || typeof msg.method !== 'string' || typeof msg.port !== 'number') {
      return true;
    }

    // Register previewId → port for later WS tunnel port validation.
    if (typeof msg.previewId === 'string') {
      previewPortRegistry.set(msg.previewId, msg.port);
    }

    const bodyStream = msg.hasBody ? new PassThrough() : null;
    bodyStream?.on('error', () => {
      // Expected on abort / limit enforcement. The terminal outcome is reported separately.
    });
    const abortController = new AbortController();
    const pending: PendingPreviewRequest = {
      abortController,
      bodyStream,
      requestBytes: 0,
      responseBytes: 0,
      timedOut: false,
      timer: setTimeout(() => {
        const active = pendingPreviewRequests.get(msg.requestId);
        if (!active) return;
        active.timedOut = true;
        active.abortController.abort();
      }, PREVIEW_LIMITS.RESPONSE_START_TIMEOUT_MS),
      timerMode: 'start',
    };
    pendingPreviewRequests.set(msg.requestId, pending);
    void runPreviewFetch(serverLink, msg, pending);
    return true;
  }

  if (cmd.type === PREVIEW_MSG.REQUEST_END && typeof cmd.requestId === 'string') {
    const pending = pendingPreviewRequests.get(cmd.requestId);
    pending?.bodyStream?.end();
    return true;
  }

  if (cmd.type === PREVIEW_MSG.ABORT && typeof cmd.requestId === 'string') {
    const pending = cleanupPreviewRequest(cmd.requestId);
    if (!pending) return true;
    pending.bodyStream?.destroy(new Error(PREVIEW_ERROR.ABORTED));
    pending.abortController.abort();
    return true;
  }

  if (cmd.type === PREVIEW_MSG.WS_OPEN) {
    const msg = cmd as unknown as PreviewWsOpenMessage;
    if (typeof msg.wsId !== 'string' || typeof msg.previewId !== 'string' || typeof msg.port !== 'number' || typeof msg.path !== 'string') {
      return true;
    }
    handlePreviewWsOpen(msg, serverLink);
    return true;
  }

  if (cmd.type === PREVIEW_MSG.CLOSE) {
    const previewId = cmd.previewId as string | undefined;
    if (previewId) clearPreviewPort(previewId);
    return true;
  }

  if (cmd.type === PREVIEW_MSG.WS_CLOSE) {
    const msg = cmd as unknown as PreviewWsCloseMessage;
    if (typeof msg.wsId !== 'string') return true;
    handlePreviewWsCloseFromServer(msg);
    return true;
  }

  return false;
}

/** Remove a preview from the port registry when the preview is closed. */
export function clearPreviewPort(previewId: string): void {
  previewPortRegistry.delete(previewId);
}

// ── WS tunnel: open upstream connection ──────────────────────────────────────

function handlePreviewWsOpen(msg: PreviewWsOpenMessage, serverLink: ServerLink): void {
  const wsId = normalizeWsId(msg.wsId);

  // Validate port range.
  if (msg.port < 1 || msg.port > 65535 || !Number.isInteger(msg.port)) {
    sendWsError(serverLink, msg.wsId, 'invalid port');
    return;
  }

  // Validate port matches registered preview port (if known).
  const registeredPort = previewPortRegistry.get(msg.previewId);
  if (registeredPort !== undefined && registeredPort !== msg.port) {
    logger.warn({ wsId, previewId: msg.previewId, msgPort: msg.port, registeredPort }, 'Preview WS port mismatch');
    sendWsError(serverLink, msg.wsId, 'port mismatch');
    return;
  }

  // Sanitize the path.
  const sanitizedPath = normalizePreviewUpstreamPath(msg.path);

  const upstreamUrl = `ws://${LOOPBACK_HOST}:${msg.port}${sanitizedPath}`;
  logger.debug({ wsId, url: upstreamUrl }, 'Preview WS: connecting to upstream');

  // Connect to upstream. Pass subprotocols if provided; strip Sec-WebSocket-Extensions
  // (extension negotiation cannot be preserved end-to-end through a message-level relay).
  const protocols = Array.isArray(msg.protocols) && msg.protocols.length > 0 ? msg.protocols : undefined;
  const upstreamWs = new WebSocket(upstreamUrl, protocols, {
    headers: { host: `${LOOPBACK_HOST}:${msg.port}` },
  });

  // Track before open fires, so WS_CLOSE from server during handshake is handled.
  activeWsTunnels.set(wsId, upstreamWs);

  let opened = false;

  upstreamWs.on('open', () => {
    opened = true;
    logger.debug({ wsId }, 'Preview WS: upstream connected');
    try {
      serverLink.send({
        type: PREVIEW_MSG.WS_OPENED,
        wsId: msg.wsId,
        protocol: upstreamWs.protocol || undefined,
      });
    } catch {
      // Server disconnected — clean up upstream.
      cleanupWsTunnel(wsId);
    }
  });

  upstreamWs.on('unexpected-response', (_req, res) => {
    if (opened) return;
    const status = res.statusCode ?? 0;
    const statusText = res.statusMessage ?? '';
    const errMsg = statusText
      ? `upstream rejected: ${status} ${statusText}`
      : `upstream rejected: ${status}`;
    logger.warn({ wsId, status }, 'Preview WS: upstream rejected upgrade');
    cleanupWsTunnel(wsId);
    sendWsError(serverLink, msg.wsId, errMsg);
  });

  upstreamWs.on('error', (err) => {
    if (opened) {
      // Error after open — just log; close event will fire next.
      logger.warn({ wsId, err: err.message }, 'Preview WS: upstream error after open');
      return;
    }
    cleanupWsTunnel(wsId);
    sendWsError(serverLink, msg.wsId, `connection failed: ${err.message}`);
  });

  upstreamWs.on('message', (data: WebSocket.RawData, isBinaryMsg: boolean) => {
    // Enforce message size limit.
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (payload.length > PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES) {
      logger.warn({ wsId, size: payload.length }, 'Preview WS: upstream message exceeds size limit, closing tunnel');
      cleanupWsTunnel(wsId);
      try {
        serverLink.send({ type: PREVIEW_MSG.WS_CLOSE, wsId: msg.wsId, code: 1009, reason: 'Message Too Big' });
      } catch { /* ignore */ }
      return;
    }
    serverLink.sendBinary(packPreviewWsFrame(msg.wsId, isBinaryMsg, payload));
  });

  upstreamWs.on('close', (code, reasonBuf) => {
    const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf ?? '');
    logger.debug({ wsId, code, reason }, 'Preview WS: upstream closed');
    activeWsTunnels.delete(wsId);
    try {
      serverLink.send({ type: PREVIEW_MSG.WS_CLOSE, wsId: msg.wsId, code, reason });
    } catch { /* ignore */ }
  });
}

// ── WS tunnel: handle close from server ──────────────────────────────────────

function handlePreviewWsCloseFromServer(msg: PreviewWsCloseMessage): void {
  const wsId = normalizeWsId(msg.wsId);
  const ws = activeWsTunnels.get(wsId);
  if (!ws) return;
  activeWsTunnels.delete(wsId);
  try {
    ws.close(msg.code, msg.reason);
  } catch { /* ignore */ }
}

export function handlePreviewBinaryFrame(data: Buffer, serverLink: ServerLink): boolean {
  // Dispatch based on first byte: 0x04 is a WS_DATA frame, others are HTTP relay frames.
  if (data.length > 0 && data[0] === PREVIEW_BINARY_FRAME.WS_DATA) {
    return handlePreviewWsDataFrame(data, serverLink);
  }

  const frame = parsePreviewBinaryFrame(data);
  if (!frame || frame.frameType !== PREVIEW_BINARY_FRAME.REQUEST_BODY) return false;
  const pending = pendingPreviewRequests.get(frame.requestId);
  if (!pending) return true;

  pending.requestBytes += frame.payload.length;
  if (pending.requestBytes > PREVIEW_LIMITS.MAX_REQUEST_BYTES) {
    pending.bodyStream?.destroy(new Error(PREVIEW_ERROR.LIMIT_EXCEEDED));
    pending.abortController.abort();
    cleanupPreviewRequest(frame.requestId);
    failPreviewRequest(serverLink, frame.requestId, PREVIEW_ERROR.LIMIT_EXCEEDED, 'preview request exceeded byte limit', PREVIEW_TERMINAL_OUTCOME.LIMIT_EXCEEDED);
    return true;
  }

  pending.bodyStream?.write(frame.payload);
  return true;
}

// ── WS tunnel: relay incoming WS_DATA frame to upstream ──────────────────────

function handlePreviewWsDataFrame(data: Buffer, serverLink: ServerLink): boolean {
  const parsed = parsePreviewWsFrame(data);
  if (!parsed) return false;

  // Enforce message size limit from server → upstream direction.
  if (parsed.payload.length > PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES) {
    const ws = activeWsTunnels.get(parsed.wsId);
    if (ws) {
      activeWsTunnels.delete(parsed.wsId);
      try { ws.close(1009, 'Message Too Big'); } catch { /* ignore */ }
    }
    try {
      serverLink.send({ type: PREVIEW_MSG.WS_CLOSE, wsId: parsed.wsId, code: 1009, reason: 'Message Too Big' });
    } catch { /* ignore */ }
    return true;
  }

  const upstreamWs = activeWsTunnels.get(parsed.wsId);
  if (!upstreamWs) return true; // tunnel already closed — silently discard

  if (upstreamWs.readyState !== WebSocket.OPEN) return true;

  try {
    if (parsed.isBinary) {
      upstreamWs.send(parsed.payload);
    } else {
      upstreamWs.send(parsed.payload.toString('utf8'));
    }
  } catch (err) {
    logger.warn({ wsId: parsed.wsId, err: (err as Error).message }, 'Preview WS: error forwarding to upstream');
  }
  return true;
}
