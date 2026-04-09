import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
const mockUpsertDbSession = vi.fn();
const mockUpdateSession = vi.fn();
const sendToDaemonMock = vi.fn();

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
      sendToDaemon: sendToDaemonMock,
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

  it('PATCH /sessions/:name relays session.restart when agentType changes', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'codex-sdk',
        cwd: '/tmp/next',
        description: 'next persona',
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledWith(
      {},
      'srv-1',
      'deck_proj_brain',
      {
        description: 'next persona',
        project_dir: '/tmp/next',
      },
    );
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.restart',
      sessionName: 'deck_proj_brain',
      agentType: 'codex-sdk',
      cwd: '/tmp/next',
      description: 'next persona',
    });
  });

  it('PATCH /sessions/:name/rename updates the project name and relays session.rename', async () => {
    const { updateProjectName } = await import('../src/db/queries.js');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/rename', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-proj' }),
    });

    expect(res.status).toBe(200);
    expect(updateProjectName).toHaveBeenCalledWith({}, 'srv-1', 'deck_proj_brain', 'new-proj');
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.rename',
      sessionName: 'deck_proj_brain',
      projectName: 'new-proj',
    });
  });

  it('PATCH /sessions/:name/label updates the label and relays session.relabel', async () => {
    const { updateSessionLabel } = await import('../src/db/queries.js');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/label', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Main Label' }),
    });

    expect(res.status).toBe(200);
    expect(updateSessionLabel).toHaveBeenCalledWith({}, 'srv-1', 'deck_proj_brain', 'Main Label');
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.relabel',
      sessionName: 'deck_proj_brain',
      label: 'Main Label',
    });
  });

  it('PATCH /sessions/:name/label allows clearing the label and still relays session.relabel', async () => {
    const { updateSessionLabel } = await import('../src/db/queries.js');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/label', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '' }),
    });

    expect(res.status).toBe(200);
    expect(updateSessionLabel).toHaveBeenCalledWith({}, 'srv-1', 'deck_proj_brain', null);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.relabel',
      sessionName: 'deck_proj_brain',
      label: null,
    });
  });
});
