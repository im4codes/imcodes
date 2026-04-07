import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
const mockUpsertDbSession = vi.fn();
const mockUpdateSession = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/db/queries.js', () => ({
  getServerById: vi.fn(async () => ({ id: 'srv-1' })),
  getDbSessionsByServer: vi.fn(async () => []),
  upsertDbSession: (...args: unknown[]) => mockUpsertDbSession(...args),
  deleteDbSession: vi.fn(),
  updateSessionLabel: vi.fn(),
  updateProjectName: vi.fn(),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
}));

vi.mock('../src/security/crypto.js', () => ({
  randomHex: vi.fn(() => 'sid-test'),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: vi.fn(),
    }),
  },
}));

vi.mock('../src/util/pod-identity.js', () => ({
  getPodIdentity: vi.fn(() => 'pod-a'),
}));

describe('session-mgmt persistence routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
  });

  async function buildApp() {
    const { sessionMgmtRoutes } = await import('../src/routes/session-mgmt.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: object } }).env = { DB: {} };
      await next();
    });
    app.route('/api/server', sessionMgmtRoutes);
    return app;
  }

  it('PUT /sessions/:name persists requestedModel/activeModel/effort/transportConfig', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: 'proj',
        projectRole: 'brain',
        agentType: 'claude-code-sdk',
        projectDir: '/tmp/proj',
        state: 'idle',
        runtimeType: 'transport',
        providerId: 'claude-code-sdk',
        providerSessionId: 'route-1',
        description: 'persona',
        requestedModel: 'sonnet',
        activeModel: 'sonnet',
        effort: 'high',
        transportConfig: { provider: { mode: 'safe' } },
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpsertDbSession).toHaveBeenCalledWith(
      {},
      'sid-test',
      'srv-1',
      'deck_proj_brain',
      'proj',
      'brain',
      'claude-code-sdk',
      '/tmp/proj',
      'idle',
      null,
      'transport',
      'claude-code-sdk',
      'route-1',
      'persona',
      'sonnet',
      'sonnet',
      'high',
      { provider: { mode: 'safe' } },
    );
  });

  it('PATCH /sessions/:name updates requestedModel/activeModel/effort/transportConfig', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestedModel: 'gpt-5.4',
        activeModel: 'gpt-5.4',
        effort: 'medium',
        transportConfig: { provider: { mode: 'balanced' } },
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledWith(
      {},
      'srv-1',
      'deck_proj_brain',
      {
        requested_model: 'gpt-5.4',
        active_model: 'gpt-5.4',
        effort: 'medium',
        transport_config: { provider: { mode: 'balanced' } },
      },
    );
  });
});
