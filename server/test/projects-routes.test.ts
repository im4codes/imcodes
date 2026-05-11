import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const getServerByIdMock = vi.fn();
const resolveServerRoleMock = vi.fn();
const sendToDaemonMock = vi.fn();
const loggerErrorMock = vi.fn();

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

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: vi.fn(() => ({
      sendToDaemon: sendToDaemonMock,
    })),
  },
}));

vi.mock('../src/util/logger.js', () => ({
  default: {
    error: (...args: unknown[]) => loggerErrorMock(...args),
  },
}));

describe('project routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerByIdMock.mockResolvedValue({ id: 'srv-1' });
    resolveServerRoleMock.mockResolvedValue('owner');
  });

  async function buildApp() {
    const { projectRoutes } = await import('../src/routes/projects.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: object } }).env = { DB: {} };
      await next();
    });
    app.route('/api/server', projectRoutes);
    return app;
  }

  it('relays project CRUD and tracker operations to the daemon', async () => {
    const app = await buildApp();

    const requests: Array<[string, RequestInit | undefined]> = [
      ['/api/server/srv-1/projects', undefined],
      ['/api/server/srv-1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alpha', cwd: '/repo' }),
      }],
      ['/api/server/srv-1/projects/Alpha%20One', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracker: 'github' }),
      }],
      ['/api/server/srv-1/projects/Alpha%20One', undefined],
      ['/api/server/srv-1/projects/Alpha%20One/autofix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueId: '42' }),
      }],
      ['/api/server/srv-1/projects/Alpha%20One/autofix', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'user' }),
      }],
      ['/api/server/srv-1/projects/Alpha%20One/issues', undefined],
      ['/api/server/srv-1/tracker/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test' }),
      }],
    ];

    for (const [url, init] of requests) {
      const res = await app.request(url, init);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }

    expect(sendToDaemonMock.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { type: 'http.relay', method: 'GET', path: '/projects' },
      { type: 'http.relay', method: 'POST', path: '/projects', body: { name: 'Alpha', cwd: '/repo' } },
      { type: 'http.relay', method: 'PUT', path: '/projects/Alpha%20One', body: { tracker: 'github' } },
      { type: 'http.relay', method: 'GET', path: '/projects/Alpha%20One' },
      { type: 'http.relay', method: 'POST', path: '/projects/Alpha%20One/autofix', body: { issueId: '42' } },
      { type: 'http.relay', method: 'DELETE', path: '/projects/Alpha%20One/autofix', body: { reason: 'user' } },
      { type: 'http.relay', method: 'GET', path: '/projects/Alpha%20One/issues' },
      { type: 'http.relay', method: 'POST', path: '/tracker/validate', body: { url: 'https://example.test' } },
    ]);
  });

  it('rejects missing servers, forbidden users, invalid bodies, and relay failures', async () => {
    const app = await buildApp();

    getServerByIdMock.mockResolvedValueOnce(null);
    expect((await app.request('/api/server/missing/projects')).status).toBe(404);

    resolveServerRoleMock.mockResolvedValueOnce('none');
    expect((await app.request('/api/server/srv-1/projects')).status).toBe(403);

    const invalid = await app.request('/api/server/srv-1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(invalid.status).toBe(400);

    sendToDaemonMock.mockImplementationOnce(() => {
      throw new Error('bridge down');
    });
    const failedRelay = await app.request('/api/server/srv-1/projects');
    expect(failedRelay.status).toBe(502);
    expect(await failedRelay.json()).toEqual({ error: 'relay_failed' });
    expect(loggerErrorMock).toHaveBeenCalled();
  });
});
