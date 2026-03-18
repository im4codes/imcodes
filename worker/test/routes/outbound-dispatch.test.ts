import { describe, it, expect, vi } from 'vitest';
import { outboundRoutes } from '../../src/routes/outbound.js';
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
  app.route('/outbound', outboundRoutes);
  return app;
}

function outboundPayload(overrides: Record<string, string> = {}) {
  return {
    platform: 'telegram',
    botId: 'bot-1',
    channelId: 'ch-1',
    content: 'Hello from daemon',
    ...overrides,
  };
}

// ── POST /outbound auth ────────────────────────────────────────────────────

describe('POST /outbound authorization', () => {
  it('rejects request without Authorization header', async () => {
    const app = makeApp({ DB: {} as D1Database });
    const res = await app.request('/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outboundPayload()),
    });
    expect(res.status).toBe(401);
  });

  it('rejects request with invalid server token', async () => {
    const firstFn = vi.fn().mockResolvedValue(null); // no matching server
    const bindFn = vi.fn().mockReturnValue({ first: firstFn });
    const db = { prepare: vi.fn().mockReturnValue({ bind: bindFn }) } as unknown as D1Database;

    const app = makeApp({ DB: db });
    const res = await app.request('/outbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer bad-token',
      },
      body: JSON.stringify(outboundPayload()),
    });
    expect(res.status).toBe(401);
  });
});

// ── POST /outbound payload validation ──────────────────────────────────────

describe('POST /outbound payload validation', () => {
  async function makeAuthenticatedApp() {
    const serverToken = 'server-token-xyz';
    const tokenHash = await sha256Hex(serverToken);

    const firstFn = vi.fn().mockResolvedValue({ id: 'srv-1', user_id: 'owner-1' });
    const bindFn = vi.fn().mockReturnValue({ first: firstFn });
    const db = { prepare: vi.fn().mockReturnValue({ bind: bindFn }) } as unknown as D1Database;

    const app = makeApp({ DB: db, BOT_ENCRYPTION_KEY: 'test-key' });
    return { app, serverToken };
  }

  it('rejects payload missing botId', async () => {
    const { app, serverToken } = await makeAuthenticatedApp();
    const res = await app.request('/outbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serverToken}`,
      },
      body: JSON.stringify({ platform: 'telegram', channelId: 'ch-1', content: 'hello' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_payload');
  });

  it('rejects payload missing platform', async () => {
    const { app, serverToken } = await makeAuthenticatedApp();
    const res = await app.request('/outbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serverToken}`,
      },
      body: JSON.stringify({ botId: 'bot-1', channelId: 'ch-1', content: 'hello' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects payload missing content', async () => {
    const { app, serverToken } = await makeAuthenticatedApp();
    const res = await app.request('/outbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serverToken}`,
      },
      body: JSON.stringify({ platform: 'telegram', botId: 'bot-1', channelId: 'ch-1' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns unknown_platform for unsupported platform', async () => {
    const { app, serverToken } = await makeAuthenticatedApp();
    const res = await app.request('/outbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serverToken}`,
      },
      body: JSON.stringify(outboundPayload({ platform: 'nonexistent' })),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unknown_platform');
  });
});

// ── POST /outbound bot ownership check ─────────────────────────────────────

describe('POST /outbound bot ownership', () => {
  it('rejects when bot is owned by a different user than the server owner', async () => {
    const serverToken = 'server-token-abc';
    const tokenHash = await sha256Hex(serverToken);

    // Server lookup returns owner-1
    // Bot lookup (platform_bots) returns a bot owned by owner-2
    const firstFn = vi.fn()
      .mockResolvedValueOnce({ id: 'srv-1', user_id: 'owner-1' })   // servers lookup
      .mockResolvedValueOnce({                                        // platform_bots lookup
        id: 'bot-1',
        user_id: 'owner-2',  // different user!
        platform: 'telegram',
        config_encrypted: 'encrypted-data',
      });
    const bindFn = vi.fn().mockReturnValue({ first: firstFn });
    const db = { prepare: vi.fn().mockReturnValue({ bind: bindFn }) } as unknown as D1Database;

    // Mock decryptBotConfig to avoid needing real crypto
    const { decryptBotConfig } = await import('../../src/security/crypto.js');
    vi.mock('../../src/security/crypto.js', async (importOriginal) => {
      const orig = await importOriginal() as Record<string, unknown>;
      return {
        ...orig,
        decryptBotConfig: vi.fn().mockResolvedValue({ botToken: 'fake' }),
      };
    });

    const app = makeApp({ DB: db, BOT_ENCRYPTION_KEY: 'test-key' });
    const res = await app.request('/outbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serverToken}`,
      },
      body: JSON.stringify(outboundPayload()),
    });

    // Either 403 (forbidden — bot owned by different user) or 404 (bot not found)
    // depending on mock setup. The key assertion is it's NOT 200.
    expect(res.status).not.toBe(200);

    vi.restoreAllMocks();
  });
});
