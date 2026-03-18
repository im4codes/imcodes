import { describe, it, expect, vi } from 'vitest';
import { authRoutes } from '../../src/routes/auth.js';
import { sha256Hex } from '../../src/security/crypto.js';
import { Hono } from 'hono';
import type { Env } from '../../src/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeApp(env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    Object.assign(c.env, env);
    await next();
  });
  app.route('/auth', authRoutes);
  return app;
}

function mockDb(overrides: Record<string, unknown> = {}) {
  const defaultFirst = vi.fn().mockResolvedValue(null);
  const defaultBind = vi.fn().mockReturnValue({ first: overrides.first ?? defaultFirst });
  return {
    prepare: vi.fn().mockReturnValue({
      bind: overrides.bind ?? defaultBind,
      first: overrides.first ?? defaultFirst,
      run: vi.fn().mockResolvedValue({}),
    }),
  } as unknown as D1Database;
}

// ── POST /auth/link removed ────────────────────────────────────────────────

describe('POST /link endpoint removed', () => {
  it('no POST /link route exists (platform linking only via OAuth)', () => {
    const route = authRoutes.routes.find(
      (r) => r.method === 'POST' && r.path === '/link',
    );
    expect(route).toBeUndefined();
  });

  it('POST /auth/link returns 404', async () => {
    const app = makeApp({ DB: mockDb(), JWT_SIGNING_KEY: 'test-key' });
    const res = await app.request('/auth/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'discord', platformUserId: '12345' }),
    });
    expect(res.status).toBe(404);
  });
});

// ── GET /auth/user/:id authorization ───────────────────────────────────────

describe('GET /user/:id authorization', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const app = makeApp({ DB: mockDb(), JWT_SIGNING_KEY: 'test-key' });
    const res = await app.request('/auth/user/some-id');
    expect(res.status).toBe(401);
  });

  it('rejects access to another user ID with 403', async () => {
    const apiKey = `deck_${'c'.repeat(64)}`;
    const keyHash = await sha256Hex(apiKey);

    // api_keys lookup returns caller as user-abc
    const firstFn = vi.fn().mockResolvedValueOnce({ user_id: 'user-abc' });
    const bindFn = vi.fn().mockReturnValue({ first: firstFn });
    const db = { prepare: vi.fn().mockReturnValue({ bind: bindFn }) } as unknown as D1Database;

    const app = makeApp({ DB: db, JWT_SIGNING_KEY: 'test-key' });
    const res = await app.request('/auth/user/different-user', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(403);
  });
});
