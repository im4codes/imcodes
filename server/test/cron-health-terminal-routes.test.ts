import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const logAuditMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerDebugMock = vi.fn();
const getServerByIdMock = vi.fn();
const resolveServerRoleMock = vi.fn();

vi.mock('../src/security/audit.js', () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

vi.mock('../src/util/logger.js', () => ({
  default: {
    info: (...args: unknown[]) => loggerInfoMock(...args),
    debug: (...args: unknown[]) => loggerDebugMock(...args),
    error: vi.fn(),
  },
}));

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => resolveServerRoleMock(...args),
}));

vi.mock('../src/db/queries.js', () => ({
  getServerById: (...args: unknown[]) => getServerByIdMock(...args),
}));

describe('healthCheckCron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logAuditMock.mockResolvedValue(undefined);
  });

  it('marks stale online servers offline and writes audit records', async () => {
    const query = vi.fn(async () => [
      { id: 'srv-1', name: 'Alpha', user_id: 'user-1', last_heartbeat_at: null },
      { id: 'srv-2', name: 'Beta', user_id: 'user-2', last_heartbeat_at: 123 },
    ]);
    const execute = vi.fn(async () => undefined);
    const { healthCheckCron } = await import('../src/cron/health-check.js');

    await healthCheckCron({ DB: { query, execute } } as any);

    expect(query).toHaveBeenCalledWith(
      "SELECT id, name, user_id, last_heartbeat_at FROM servers WHERE status = 'online' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < $1)",
      [expect.any(Number)],
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, "UPDATE servers SET status = 'offline' WHERE id = $1", ['srv-1']);
    expect(execute).toHaveBeenNthCalledWith(2, "UPDATE servers SET status = 'offline' WHERE id = $1", ['srv-2']);
    expect(logAuditMock).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        serverId: 'srv-1',
        action: 'server.offline',
        details: { lastHeartbeat: null, reason: 'heartbeat_timeout' },
      },
      { query, execute },
    );
    expect(loggerInfoMock).toHaveBeenCalledWith({ markedOffline: 2 }, 'Health check cron complete');
  });

  it('is a no-op when no heartbeats are stale', async () => {
    const query = vi.fn(async () => []);
    const execute = vi.fn(async () => undefined);
    const { healthCheckCron } = await import('../src/cron/health-check.js');

    await healthCheckCron({ DB: { query, execute } } as any);

    expect(execute).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith({ markedOffline: 0 }, 'Health check cron complete');
  });
});

describe('terminal routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerByIdMock.mockResolvedValue({ id: 'srv-1' });
    resolveServerRoleMock.mockResolvedValue('owner');
  });

  async function buildApp() {
    const { terminalRoutes } = await import('../src/routes/terminal.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: object } }).env = { DB: {} };
      await next();
    });
    app.route('/api/server', terminalRoutes);
    return app;
  }

  it('returns the expected auth/access/upgrade responses', async () => {
    const app = await buildApp();

    getServerByIdMock.mockResolvedValueOnce(null);
    expect((await app.request('/api/server/missing/terminal/deck_a/ws')).status).toBe(404);

    resolveServerRoleMock.mockResolvedValueOnce('none');
    expect((await app.request('/api/server/srv-1/terminal/deck_a/ws')).status).toBe(403);

    expect((await app.request('/api/server/srv-1/terminal/deck_a/ws')).status).toBe(426);

    const upgraded = await app.request('/api/server/srv-1/terminal/deck_a/ws', {
      headers: { Upgrade: 'websocket' },
    });
    expect(upgraded.status).toBe(500);
    expect(await upgraded.json()).toEqual({ error: 'internal_error' });
    expect(loggerDebugMock).toHaveBeenCalledWith(
      { serverId: 'srv-1', sessionName: 'deck_a' },
      'Terminal WS route reached — upgrade handled upstream',
    );
  });
});
