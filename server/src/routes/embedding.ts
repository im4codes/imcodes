/**
 * POST /api/embedding — server-side embedding fallback for logged-in users.
 *
 * Why this exists: when a daemon's local embedding pipeline is broken
 * (sharp transitive deps left as empty placeholders by `npm install -g
 * --ignore-scripts`, onnxruntime native binding incompatible with the
 * host CPU, etc.) the daemon needs a way to keep semantic search alive
 * without compiling against the broken local pipeline. This route lets
 * the daemon (or a browser client, same auth surface) push text and
 * receive a Float32 embedding from the server's own worker pool.
 *
 * Authentication: `requireAuth` — supports the same three modes as every
 * other authenticated endpoint:
 *   1. `rcc_session` cookie (browser)
 *   2. `Authorization: Bearer <server-token>` + `X-Server-Id` (daemon)
 *   3. `Authorization: Bearer deck_*` (API key)
 *
 * Compute path: never on the main thread. The route delegates to
 * `getEmbeddingPool().embed(text)` which forwards to a `worker_threads`
 * worker. See `embedding-pool.ts`.
 *
 * Response shape (success):
 *   { ok: true, dim: 384, embedding: number[384] }
 *
 * Response shape (failure):
 *   { ok: false, error: '<reason>' }
 *   - 400 invalid_payload
 *   - 401 unauthorized (handled by middleware)
 *   - 413 text_too_large (>8192 chars)
 *   - 503 embedding_unavailable (pool sticky-disabled)
 *   - 504 embedding_timeout (worker exceeded request budget)
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { getEmbeddingPool } from '../util/embedding-pool.js';
import logger from '../util/logger.js';

export const embeddingRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

embeddingRoutes.use('/*', requireAuth());

/**
 * Server payloads cap text length before compute. The model itself
 * silently truncates beyond ~512 tokens, but accepting unbounded input
 * lets a malicious caller waste CPU and memory on tokenization. 8 KB
 * matches the existing summary-write guards elsewhere in the server.
 */
const MAX_TEXT_BYTES = 8192;

embeddingRoutes.post('/', async (c) => {
  const userId = c.get('userId' as never) as string;

  let body: { text?: unknown };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }

  const text = body.text;
  if (typeof text !== 'string' || text.length === 0) {
    return c.json({ ok: false, error: 'invalid_payload' }, 400);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return c.json({ ok: false, error: 'text_too_large', limit_bytes: MAX_TEXT_BYTES }, 413);
  }

  const pool = getEmbeddingPool();
  if (!pool.isAvailable()) {
    return c.json({ ok: false, error: 'embedding_unavailable', reason: pool.getDisableReason() }, 503);
  }

  try {
    const vec = await pool.embed(text);
    if (!vec) {
      return c.json({ ok: false, error: 'embedding_unavailable', reason: pool.getDisableReason() }, 503);
    }
    // Float32Array → number[] for JSON. Each component is already a JS
    // float64 internally; the wire format trades ~3× size for client
    // simplicity (no base64 decode, works in browser tests).
    return c.json({ ok: true, dim: vec.length, embedding: Array.from(vec) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timed out')) {
      return c.json({ ok: false, error: 'embedding_timeout' }, 504);
    }
    logger.warn({ err, userId }, 'embedding route: pool rejected request');
    return c.json({ ok: false, error: 'embedding_failed', detail: message }, 500);
  }
});
