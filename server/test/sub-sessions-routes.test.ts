import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
const mockCreateSubSession = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/db/queries.js', () => ({
  getSubSessionsByServer: vi.fn(async () => []),
  getSubSessionById: vi.fn(async () => null),
  createSubSession: (...args: unknown[]) => mockCreateSubSession(...args),
  updateSubSession: vi.fn(),
  deleteSubSession: vi.fn(),
  reorderSubSessions: vi.fn(),
}));

describe('sub-session routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
  });

  async function buildApp() {
    const { subSessionRoutes } = await import('../src/routes/sub-sessions.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: object } }).env = { DB: {} };
      await next();
    });
    app.route('/api/server', subSessionRoutes);
    return app;
  }

  it('POST /sub-sessions rejects known test sub-session shapes before DB creation', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'copilot-sdk',
        cwd: '/tmp/bootmain-e2e',
        parent_session: 'deck_bootmainabc123_brain',
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'test_session_blocked' });
    expect(mockCreateSubSession).not.toHaveBeenCalled();
  });
});
