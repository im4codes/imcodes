/**
 * Server fallback for embedding generation.
 *
 * Used by `src/context/embedding.ts:generateEmbedding` when the daemon's
 * local pipeline is permanently unavailable (e.g. sharp's transitive deps
 * left as empty placeholder dirs by `npm install -g --ignore-scripts`,
 * onnxruntime native binding can't load on this CPU). Calls the bound
 * server's `POST /api/embedding` endpoint and reconstructs a Float32Array
 * from the JSON response.
 *
 * Auth: the daemon authenticates with the same `Authorization: Bearer
 * <server-token>` + `X-Server-Id: <serverId>` pattern that `resolveAuth`
 * already accepts. No new auth surface required.
 *
 * Sticky-disable model:
 *   - First call sticky-fails on:
 *       * no bind credentials (`server.json` missing → `not_bound`)
 *       * 401/403 from server (revoked token → `unauthorized`)
 *       * 503 from server with `embedding_unavailable` (server pool also dead → `server_unavailable`)
 *   - Transient errors (network, timeout, 5xx) do NOT sticky-disable; the
 *     next call retries. This mirrors the daemon's local pipeline policy.
 *   - The sticky state is per-process and only resets on daemon restart.
 *
 * Concurrency: a single in-flight Promise is kept per (text). We don't
 * dedup by text on purpose — different texts have different embeddings —
 * but we DO short-circuit the credential read so a flurry of concurrent
 * fallback calls during a recall doesn't read `server.json` N times.
 */

import { EMBEDDING_DIM } from '../../shared/embedding-config.js';
import logger from '../util/logger.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

let unavailable = false;
let unavailableReason: string | null = null;

/** Test-only seam: reset sticky state between cases. */
export function _resetServerFallbackStateForTests(): void {
  unavailable = false;
  unavailableReason = null;
  // `undefined` (not null) means "not yet looked up". Setting to null
  // would short-circuit getCredentials() into returning null forever
  // because the cache hit check is `!== undefined`.
  cachedCredentials = undefined;
}

export function isServerFallbackUnavailable(): boolean {
  return unavailable;
}

export function getServerFallbackDisableReason(): string | null {
  return unavailableReason;
}

interface MinimalCredentials {
  serverId: string;
  token: string;
  workerUrl: string;
}

let cachedCredentials: MinimalCredentials | null | undefined = undefined;

async function getCredentials(): Promise<MinimalCredentials | null> {
  if (cachedCredentials !== undefined) return cachedCredentials;
  try {
    // Lazy-import bind-flow to avoid pulling daemon-only deps into module
    // graphs that import this file from web/test contexts.
    const { loadCredentials } = await import('../bind/bind-flow.js');
    const creds = await loadCredentials();
    if (!creds) {
      cachedCredentials = null;
      return null;
    }
    cachedCredentials = {
      serverId: creds.serverId,
      token: creds.token,
      workerUrl: creds.workerUrl,
    };
    return cachedCredentials;
  } catch (err) {
    logger.warn({ err }, 'embedding server fallback: loadCredentials threw');
    cachedCredentials = null;
    return null;
  }
}

/**
 * Try the server fallback. Returns a Float32Array on success, or null on
 * any failure (transient or sticky). Caller is responsible for treating
 * null as "could not embed; skip / substring-fallback".
 */
export async function tryServerEmbedding(
  text: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<Float32Array | null> {
  if (unavailable) return null;

  const creds = await getCredentials();
  if (!creds) {
    unavailable = true;
    unavailableReason = 'not_bound';
    logger.info({}, 'embedding server fallback: no bind credentials, sticky-disabled');
    return null;
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${creds.workerUrl.replace(/\/$/, '')}/api/embedding`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'X-Server-Id': creds.serverId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      unavailable = true;
      unavailableReason = 'unauthorized';
      logger.warn({ status: res.status }, 'embedding server fallback: server rejected auth, sticky-disabled');
      return null;
    }

    if (res.status === 503) {
      // Server pool itself is down. No point retrying every recall.
      unavailable = true;
      unavailableReason = 'server_unavailable';
      logger.warn({ status: res.status }, 'embedding server fallback: server pool unavailable, sticky-disabled');
      return null;
    }

    if (!res.ok) {
      // 4xx other than auth (validation, payload too large) or 5xx.
      // Don't sticky — could be a transient issue or a payload bug we want
      // to retry on the next call after the input changes.
      logger.warn({ status: res.status }, 'embedding server fallback: non-OK response (transient)');
      return null;
    }

    const body = await res.json() as { ok?: boolean; embedding?: number[]; dim?: number };
    if (!body || body.ok !== true || !Array.isArray(body.embedding)) {
      logger.warn({ body }, 'embedding server fallback: malformed response');
      return null;
    }
    if (body.embedding.length !== EMBEDDING_DIM) {
      logger.warn({ got: body.embedding.length, want: EMBEDDING_DIM }, 'embedding server fallback: wrong dim');
      return null;
    }

    return new Float32Array(body.embedding);
  } catch (err: unknown) {
    // Abort, network error, JSON parse error → transient. Don't sticky.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'embedding server fallback: transient error');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
