import { PassThrough } from 'node:stream';
import type { ServerLink } from './server-link.js';
import logger from '../util/logger.js';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_ERROR,
  PREVIEW_LIMITS,
  PREVIEW_MSG,
  PREVIEW_TERMINAL_OUTCOME,
  packPreviewBinaryFrame,
  parsePreviewBinaryFrame,
  type PreviewRequestMessage,
  type PreviewTerminalOutcome,
} from '../../shared/preview-types.js';
import { normalizePreviewUpstreamPath } from '../../shared/preview-policy.js';

type PendingPreviewRequest = {
  abortController: AbortController;
  bodyStream: PassThrough | null;
  requestBytes: number;
  responseBytes: number;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const pendingPreviewRequests = new Map<string, PendingPreviewRequest>();
const LOOPBACK_HOST = '127.0.0.1';

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
    headers.set(name, value);
  }
  headers.set('host', `${LOOPBACK_HOST}:${port}`);
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
      }, PREVIEW_LIMITS.REQUEST_TIMEOUT_MS),
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

  return false;
}

export function handlePreviewBinaryFrame(data: Buffer, serverLink: ServerLink): boolean {
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
