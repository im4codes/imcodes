import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';

const mockGetServersByUserId = vi.fn();
const mockSendToDaemon = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
}));

vi.mock('../src/db/queries.js', () => ({
  getServersByUserId: (...args: unknown[]) => mockGetServersByUserId(...args),
  updateServerHeartbeat: vi.fn(),
  updateServerName: vi.fn(),
  deleteServer: vi.fn(),
  upsertChannelBinding: vi.fn(),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: (...args: unknown[]) => mockSendToDaemon(...args),
    }),
  },
}));

function makeEnv(): Env {
  return {
    DB: {} as never,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'test',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

async function buildTestApp() {
  const { serverRoutes } = await import('../src/routes/server.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, makeEnv());
    await next();
  });
  app.route('/api/server', serverRoutes);
  return app;
}

describe('POST /api/server/:id/upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServersByUserId.mockResolvedValue([{ id: 'srv-1', name: 'Alpha' }]);
    delete process.env.APP_VERSION;
  });

  it('sends daemon.upgrade with the server app version as targetVersion', async () => {
    process.env.APP_VERSION = '2026.4.905-dev.877';
    const app = await buildTestApp();

    const res = await app.request('/api/server/srv-1/upgrade', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(mockSendToDaemon).toHaveBeenCalledWith(JSON.stringify({
      type: 'daemon.upgrade',
      targetVersion: '2026.4.905-dev.877',
    }));
  });

  it('omits targetVersion only when APP_VERSION is unavailable', async () => {
    const app = await buildTestApp();

    const res = await app.request('/api/server/srv-1/upgrade', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(mockSendToDaemon).toHaveBeenCalledWith(JSON.stringify({ type: 'daemon.upgrade' }));
  });
});
