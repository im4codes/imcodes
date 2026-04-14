import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SHARED_CONTEXT_RUNTIME_CONFIG_MSG } from '../../shared/shared-context-runtime-config.js';

const getServersByUserIdMock = vi.fn();
const getServerByIdMock = vi.fn();
const getServerSharedContextRuntimeConfigMock = vi.fn();
const updateServerSharedContextRuntimeConfigMock = vi.fn();
const sendToDaemonMock = vi.fn();
const queryOneMock = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
}));

vi.mock('../src/db/queries.js', () => ({
  getServersByUserId: (...args: unknown[]) => getServersByUserIdMock(...args),
  updateServerHeartbeat: vi.fn(),
  updateServerName: vi.fn(),
  deleteServer: vi.fn(),
  upsertChannelBinding: vi.fn(),
  getServerById: (...args: unknown[]) => getServerByIdMock(...args),
  getServerSharedContextRuntimeConfig: (...args: unknown[]) => getServerSharedContextRuntimeConfigMock(...args),
  updateServerSharedContextRuntimeConfig: (...args: unknown[]) => updateServerSharedContextRuntimeConfigMock(...args),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: sendToDaemonMock,
    }),
  },
}));

vi.mock('../src/security/crypto.js', async () => {
  const actual = await vi.importActual('../src/security/crypto.js') as Record<string, unknown>;
  return {
    ...actual,
    sha256Hex: vi.fn(() => 'token-hash'),
    randomHex: vi.fn(() => 'nonce'),
  };
});

describe('server shared-context runtime config routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerByIdMock.mockResolvedValue({ id: 'srv-1', user_id: 'user-1' });
    getServerSharedContextRuntimeConfigMock.mockResolvedValue({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextModel: undefined,
    });
    updateServerSharedContextRuntimeConfigMock.mockResolvedValue(true);
    queryOneMock.mockResolvedValue({ id: 'srv-1' });
  });

  async function buildApp() {
    const { serverRoutes } = await import('../src/routes/server.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: { queryOne: typeof queryOneMock } } }).env = { DB: { queryOne: queryOneMock } };
      await next();
    });
    app.route('/api/server', serverRoutes);
    return app;
  }

  it('gets the persisted runtime config for the selected server', async () => {
    const app = await buildApp();
    const response = await app.request('/api/server/srv-1/shared-context/runtime-config');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      snapshot: {
        persisted: { primaryContextBackend: 'claude-code-sdk', primaryContextModel: 'sonnet' },
        effective: { primaryContextBackend: 'claude-code-sdk', primaryContextModel: 'sonnet' },
      },
    });
  });

  it('updates the cloud config and relays apply to the daemon', async () => {
    const app = await buildApp();
    const response = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.4',
        backupContextBackend: 'claude-code-sdk',
        backupContextModel: 'haiku',
      }),
    });
    expect(response.status).toBe(200);
    expect(updateServerSharedContextRuntimeConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      'srv-1',
      'user-1',
      {
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.4',
        backupContextBackend: 'claude-code-sdk',
        backupContextModel: 'haiku',
      },
    );
    expect(sendToDaemonMock).toHaveBeenCalledWith(JSON.stringify({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.4',
        backupContextBackend: 'claude-code-sdk',
        backupContextModel: 'haiku',
      },
    }));
  });

  it('returns cloud config to the daemon using bearer auth', async () => {
    const app = await buildApp();
    const response = await app.request('/api/server/srv-1/shared-context/runtime-config/daemon', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      config: {
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'sonnet',
        backupContextBackend: undefined,
        backupContextModel: undefined,
      },
    });
    expect(queryOneMock).toHaveBeenCalled();
  });
});
