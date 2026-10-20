/**
 * Retry helper for HTTP calls that failed before any request byte was sent.
 *
 * A connect timeout, a DNS lookup failure, a refused connection or a TLS socket
 * dropped before the handshake finished all mean the server never saw the
 * request, so repeating it cannot duplicate side effects. Networks that sit
 * behind a flaky transparent proxy / fake-IP DNS gateway produce exactly these
 * errors in short bursts; a handful of spaced attempts rides them out where a
 * fixed sub-second retry does not.
 *
 * Anything else (an HTTP status, a timeout while streaming, a reset after the
 * request started) is rethrown immediately: the caller owns that policy.
 */
import { FILE_TRANSFER_LIMITS } from '../../shared/transport/file-transfer.js';

const PRE_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const PRE_CONNECT_ERROR_NAMES: ReadonlySet<string> = new Set(['ConnectTimeoutError']);
const TLS_DROPPED_BEFORE_SECURE_RE = /disconnected before secure TLS connection was established/i;
const MAX_CAUSE_DEPTH = 5;

/** True when `err` (or an error in its `cause` chain) proves no request byte was sent. */
export function isPreConnectNetworkError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && PRE_CONNECT_ERROR_CODES.has(code)) return true;
    if (PRE_CONNECT_ERROR_NAMES.has(current.name)) return true;
    if (TLS_DROPPED_BEFORE_SECURE_RE.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface PreConnectRetryOptions {
  /** Total attempts, including the first. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Test seam; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Delay before retry number `retry` (1-based): base * 2^(retry-1), capped. */
export function preConnectRetryDelayMs(retry: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, retry - 1));
}

/**
 * Run `op`, repeating it only while it fails with a pre-connect network error.
 * `op` must build every per-attempt resource itself (abort signal, body stream).
 */
export async function withPreConnectRetry<T>(
  op: (attempt: number) => Promise<T>,
  options: PreConnectRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? FILE_TRANSFER_LIMITS.RELAY_PRE_CONNECT_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? FILE_TRANSFER_LIMITS.RELAY_PRE_CONNECT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? FILE_TRANSFER_LIMITS.RELAY_PRE_CONNECT_MAX_DELAY_MS;
  const sleep = options.sleep ?? realSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await op(attempt);
    } catch (err) {
      if (attempt >= maxAttempts || !isPreConnectNetworkError(err)) throw err;
      await sleep(preConnectRetryDelayMs(attempt, baseDelayMs, maxDelayMs));
    }
  }
}
