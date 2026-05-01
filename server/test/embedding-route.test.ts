/**
 * HTTP route tests for `/api/embedding`.
 *
 * Auth gating, payload validation, and pool-state surface are covered
 * here. The pool itself is mocked via `__setEmbeddingPoolForTests` so we
 * never spawn a real worker_threads worker (no model load, fast test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { __setEmbeddingPoolForTests, EmbeddingPool } from '../src/util/embedding-pool.js';
import { EMBEDDING_DIM } from '../../shared/embedding-config.js';

// ── In-memory mock DB (only the bits requireAuth touches) ─────────────────

function makeMemDb(): Database {
  const apiKeys = new Map<string, { id: string; user_id: string; key_hash: string }>();
  apiKeys.set('hash:deck_test_key', { id: 'k1', user_id: 'u1', key_hash: 'hash:deck_test_key' });

  return {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('from api_keys where key_hash')) {
        for (const k of apiKeys.values()) {
          if (k.key_hash === params[0]) return { id: k.id, user_id: k.user_id } as T;
        }
        return null;
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
}

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  return {
    ...real,
    // Force sha256Hex to a known value so the in-memory api_keys row matches
    sha256Hex: (input: string) => 'hash:' + input,
  };
});

function makeEnv(): Env {
  return {
    DB: makeMemDb(),
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  } as unknown as Env;
}

// ── Mock pool builder ─────────────────────────────────────────────────────────

class MockPool extends EmbeddingPool {
  embedSpy = vi.fn<(text: string) => Promise<Float32Array | null>>();
  available = true;
  reason: string | null = null;

  constructor() {
    // Pass a factory that throws if anyone tries to actually spawn a worker.
    super(() => { throw new Error('mock pool: unexpected real worker spawn'); });
  }
  override isAvailable(): boolean { return this.available; }
  override getDisableReason(): string | null { return this.reason; }
  override async embed(text: string): Promise<Float32Array | null> {
    return this.embedSpy(text);
  }
  override async destroy(): Promise<void> { /* no-op */ }
}

let app: ReturnType<typeof buildApp>;
let env: Env;
let pool: MockPool;

beforeEach(() => {
  env = makeEnv();
  app = buildApp(env);
  pool = new MockPool();
  __setEmbeddingPoolForTests(pool);
});

afterEach(() => {
  __setEmbeddingPoolForTests(null);
});

// ── Auth gate ──

describe('POST /api/embedding auth', () => {
  it('returns 401 without any auth header', async () => {
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(401);
    expect(pool.embedSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid API key (deck_*) and forwards to the pool', async () => {
    const fake = new Float32Array(EMBEDDING_DIM);
    fake[0] = 0.42;
    pool.embedSpy.mockResolvedValueOnce(fake);

    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer deck_test_key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; dim: number; embedding: number[] };
    expect(body.ok).toBe(true);
    expect(body.dim).toBe(EMBEDDING_DIM);
    expect(body.embedding[0]).toBeCloseTo(0.42);
    expect(pool.embedSpy).toHaveBeenCalledWith('hello');
  });
});

// ── Payload validation ──

describe('POST /api/embedding payload', () => {
  const auth = { Authorization: 'Bearer deck_test_key', 'Content-Type': 'application/json' };

  it('rejects an empty text field', async () => {
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_payload');
  });

  it('rejects a non-string text field', async () => {
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: auth,
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_json');
  });

  it('rejects payload exceeding the byte cap', async () => {
    const huge = 'x'.repeat(8193);
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: huge }),
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string; limit_bytes: number };
    expect(body.error).toBe('text_too_large');
    expect(body.limit_bytes).toBe(8192);
    expect(pool.embedSpy).not.toHaveBeenCalled();
  });
});

// ── Pool state surfacing ──

describe('POST /api/embedding pool failure modes', () => {
  const auth = { Authorization: 'Bearer deck_test_key', 'Content-Type': 'application/json' };

  it('returns 503 when the pool is sticky-disabled, with the disable reason', async () => {
    pool.available = false;
    pool.reason = 'MODULE_NOT_FOUND';
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; reason: string };
    expect(body.error).toBe('embedding_unavailable');
    expect(body.reason).toBe('MODULE_NOT_FOUND');
    expect(pool.embedSpy).not.toHaveBeenCalled();
  });

  it('returns 503 if pool.embed resolves to null (transient unavailable)', async () => {
    pool.embedSpy.mockResolvedValueOnce(null);
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(503);
  });

  it('returns 504 when pool.embed throws "timed out"', async () => {
    pool.embedSpy.mockRejectedValueOnce(new Error('embedding request 7 timed out after 15000ms'));
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(504);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('embedding_timeout');
  });

  it('returns 500 with detail for any other pool error', async () => {
    pool.embedSpy.mockRejectedValueOnce(new Error('something else broke'));
    const res = await app.request('/api/embedding', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe('embedding_failed');
    expect(body.detail).toContain('something else broke');
  });
});
