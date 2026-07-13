import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';

const mockGetServersByUserId = vi.fn();
const mockGetFullServersByUserId = vi.fn();
const mockSendToDaemon = vi.fn();
const mockRequestDaemonUpgrade = vi.fn();
const mockDeleteServer = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
}));

vi.mock('../src/db/queries.js', () => ({
  getFullServersByUserId: (...args: unknown[]) => mockGetFullServersByUserId(...args),
  getServersByUserId: (...args: unknown[]) => mockGetServersByUserId(...args),
  updateServerHeartbeat: vi.fn(),
  updateServerName: vi.fn(),
  deleteServer: (...args: unknown[]) => mockDeleteServer(...args),
  upsertChannelBinding: vi.fn(),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: (...args: unknown[]) => mockSendToDaemon(...args),
      requestDaemonUpgrade: (...args: unknown[]) => mockRequestDaemonUpgrade(...args),
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

describe('server routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServersByUserId.mockResolvedValue([{ id: 'srv-1', name: 'Alpha' }]);
    mockGetFullServersByUserId.mockResolvedValue([{ id: 'srv-1', name: 'Alpha' }]);
    mockRequestDaemonUpgrade.mockReturnValue({
      ok: true,
      upgradeId: 'upgrade-1',
      targetVersion: 'latest',
      deliveryStatus: 'sent',
    });
    mockDeleteServer.mockResolvedValue(true);
    delete process.env.APP_VERSION;
  });

  it('GET /api/server returns persisted daemonVersion', async () => {
    mockGetFullServersByUserId.mockResolvedValue([{
      id: 'srv-1',
      name: 'Alpha',
      status: 'online',
      last_heartbeat_at: 123,
      daemon_version: '2026.5.2047-dev.2025',
      created_at: 99,
    }]);
    const app = await buildTestApp();

    const res = await app.request('/api/server');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      servers: [{
        id: 'srv-1',
        name: 'Alpha',
        status: 'online',
        lastHeartbeatAt: 123,
        daemonVersion: '2026.5.2047-dev.2025',
        createdAt: 99,
      }],
    });
  });

  it('requests daemon.upgrade with the server app version as targetVersion', async () => {
    process.env.APP_VERSION = '2026.4.905-dev.877';
    mockRequestDaemonUpgrade.mockReturnValue({
      ok: true,
      upgradeId: 'upgrade-1',
      targetVersion: '2026.4.905-dev.877',
      deliveryStatus: 'sent',
    });
    const app = await buildTestApp();

    const res = await app.request('/api/server/srv-1/upgrade', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      upgradeId: 'upgrade-1',
      targetVersion: '2026.4.905-dev.877',
      deliveryStatus: 'sent',
    });
    expect(mockRequestDaemonUpgrade).toHaveBeenCalledWith({
      targetVersion: '2026.4.905-dev.877',
      source: 'manual',
    });
    expect(mockSendToDaemon).not.toHaveBeenCalled();
  });

  it('requests latest only when APP_VERSION is unavailable', async () => {
    const app = await buildTestApp();

    const res = await app.request('/api/server/srv-1/upgrade', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(mockRequestDaemonUpgrade).toHaveBeenCalledWith({
      targetVersion: undefined,
      source: 'manual',
    });
  });

  it('returns 400 when the upgrade target is invalid', async () => {
    process.env.APP_VERSION = '2026.4.905-dev.877;touch /tmp/pwn';
    mockRequestDaemonUpgrade.mockReturnValue({
      ok: false,
      deliveryStatus: 'invalid_target',
      reason: 'invalid_target_version',
    });
    const app = await buildTestApp();

    const res = await app.request('/api/server/srv-1/upgrade', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_target_version',
      deliveryStatus: 'invalid_target',
    });
  });

  it('surfaces npm publication gate state without pretending the upgrade was sent', async () => {
    process.env.APP_VERSION = '2026.4.905-dev.877';
    mockRequestDaemonUpgrade.mockReturnValue({
      ok: true,
      upgradeId: 'upgrade-1',
      targetVersion: '2026.4.905-dev.877',
      deliveryStatus: 'pending_publication',
      nextAttemptAt: '2026-05-06T12:00:15.000Z',
      reason: 'target_version_not_published',
    });
    const app = await buildTestApp();

    const res = await app.request('/api/server/srv-1/upgrade', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      upgradeId: 'upgrade-1',
      targetVersion: '2026.4.905-dev.877',
      deliveryStatus: 'pending_publication',
      nextAttemptAt: '2026-05-06T12:00:15.000Z',
      reason: 'target_version_not_published',
    });
  });

  it('does not notify daemon when server delete authorization fails', async () => {
    mockDeleteServer.mockResolvedValueOnce(false);
    const app = await buildTestApp();

    const res = await app.request('/api/server/srv-1', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(mockDeleteServer).toHaveBeenCalledWith(expect.anything(), 'srv-1', 'user-1');
    expect(mockSendToDaemon).not.toHaveBeenCalled();
  });

  it('notifies daemon only after an authorized server delete succeeds', async () => {
    mockDeleteServer.mockResolvedValueOnce(true);
    const app = await buildTestApp();

    const res = await app.request('/api/server/srv-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockDeleteServer).toHaveBeenCalledWith(expect.anything(), 'srv-1', 'user-1');
    expect(mockSendToDaemon).toHaveBeenCalledWith(JSON.stringify({ type: 'server.delete' }));
  });
});
