import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
  DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
  DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL,
  LEGACY_SHARED_CONTEXT_RUNTIME_BACKENDS,
  SHARED_CONTEXT_RUNTIME_BACKENDS,
  SHARED_CONTEXT_RUNTIME_CAPABILITY_PROTOCOL,
  SHARED_CONTEXT_RUNTIME_CONFIG_MSG,
} from '../../shared/shared-context-runtime-config.js';

const getServersByUserIdMock = vi.fn();
const getServerByIdMock = vi.fn();
const getServerSharedContextRuntimeConfigMock = vi.fn();
const updateServerSharedContextRuntimeConfigMock = vi.fn();
const patchServerSharedContextMemorySettingsMock = vi.fn();
const getUserPrefMock = vi.fn();
const setUserPrefMock = vi.fn();
const sendToDaemonMock = vi.fn();
const getSupportedSharedContextRuntimeBackendsMock = vi.fn();
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
  patchServerSharedContextMemorySettings: (...args: unknown[]) => patchServerSharedContextMemorySettingsMock(...args),
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  setUserPref: (...args: unknown[]) => setUserPrefMock(...args),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: sendToDaemonMock,
      getSupportedSharedContextRuntimeBackends: getSupportedSharedContextRuntimeBackendsMock,
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
    let persistedConfig: Record<string, unknown> | null = {
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextPreset: undefined,
      backupContextBackend: undefined,
      backupContextModel: undefined,
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
    };
    let personalSyncPref: string | undefined;
    getSupportedSharedContextRuntimeBackendsMock.mockReturnValue([...SHARED_CONTEXT_RUNTIME_BACKENDS]);
    getServerByIdMock.mockResolvedValue({ id: 'srv-1', user_id: 'user-1' });
    getServerSharedContextRuntimeConfigMock.mockImplementation(async () => persistedConfig);
    updateServerSharedContextRuntimeConfigMock.mockImplementation(async (_db: unknown, _serverId: string, _userId: string, cfg: Record<string, unknown>) => {
      persistedConfig = { ...cfg };
      return true;
    });
    patchServerSharedContextMemorySettingsMock.mockImplementation(
      async (_db: unknown, _serverId: string, _userId: string, defaultBase: Record<string, unknown>, patch: Record<string, unknown>) => {
        persistedConfig = {
          ...(persistedConfig ?? defaultBase),
          ...patch,
        };
        return persistedConfig;
      },
    );
    getUserPrefMock.mockImplementation(async (_db: unknown, _userId: string, key: string) => (
      key === 'shared_context.personal_memory_sync.v2' ? personalSyncPref : undefined
    ));
    setUserPrefMock.mockImplementation(async (_db: unknown, _userId: string, key: string, value: string) => {
      if (key === 'shared_context.personal_memory_sync.v2') personalSyncPref = value;
    });
    queryOneMock.mockResolvedValue({ id: 'srv-1', user_id: 'user-1', owner_status: 'active' });
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
        persisted: {
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'sonnet',
          memoryRecallMinScore: 0.4,
          memoryScoringWeights: {
            similarity: 0.4,
            recency: 0.25,
            frequency: 0.15,
            project: 0.2,
          },
          enablePersonalMemorySync: true,
        },
        effective: {
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'sonnet',
          memoryRecallMinScore: 0.4,
          memoryScoringWeights: {
            similarity: 0.4,
            recency: 0.25,
            frequency: 0.15,
            project: 0.2,
          },
          enablePersonalMemorySync: true,
        },
      },
    });
  });

  it('returns memory-processing defaults when the server has no saved config', async () => {
    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce(null);
    const app = await buildApp();
    const response = await app.request('/api/server/srv-1/shared-context/runtime-config');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snapshot.persisted).toMatchObject({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL,
      backupContextBackend: DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
      backupContextModel: DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
    });
    expect(body.snapshot.effective).toMatchObject(body.snapshot.persisted);
  });

  it('normalizes the daemon-facing config with the same defaults', async () => {
    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
    });
    const app = await buildApp();
    const response = await app.request('/api/server/srv-1/shared-context/runtime-config/daemon', {
      headers: { Authorization: 'Bearer daemon-token' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.config).toMatchObject({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
      backupContextModel: DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
    });
  });

  it('treats legacy false personal sync prefs as default-enabled until explicitly disabled in v2', async () => {
    getUserPrefMock.mockImplementation(async (_db, _userId, key) => (
      key === 'shared_context.personal_memory_sync' ? 'false' : undefined
    ));

    const app = await buildApp();
    const response = await app.request('/api/server/srv-1/shared-context/runtime-config');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snapshot.persisted.enablePersonalMemorySync).toBe(true);
    expect(body.snapshot.effective.enablePersonalMemorySync).toBe(true);
  });

  it('respects an explicit v2 personal sync opt-out', async () => {
    getUserPrefMock.mockImplementation(async (_db, _userId, key) => (
      key === 'shared_context.personal_memory_sync.v2' ? 'false' : 'true'
    ));

    const app = await buildApp();
    const response = await app.request('/api/server/srv-1/shared-context/runtime-config');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snapshot.persisted.enablePersonalMemorySync).toBe(false);
    expect(body.snapshot.effective.enablePersonalMemorySync).toBe(false);
  });

  it('updates the cloud config and relays apply to the daemon', async () => {
    const app = await buildApp();
    const response = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primaryContextBackend: 'agy-sdk',
        primaryContextModel: 'gemini-3.8-flash-low',
        backupContextBackend: 'opencode-sdk',
        backupContextModel: 'opencode/big-pickle',
        memoryRecallMinScore: 0.37,
        memoryScoringWeights: {
          similarity: 0.5,
          recency: 0.2,
          frequency: 0.1,
          project: 0.2,
        },
        enablePersonalMemorySync: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(updateServerSharedContextRuntimeConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      'srv-1',
      'user-1',
      {
        modelSelectionMode: 'manual',
        primaryContextBackend: 'agy-sdk',
        primaryContextModel: 'gemini-3.8-flash-low',
        primaryContextPreset: undefined,
        backupContextBackend: 'opencode-sdk',
        backupContextModel: 'opencode/big-pickle',
        backupContextPreset: undefined,
        memoryRecallMinScore: 0.37,
        memoryScoringWeights: {
          similarity: 0.5,
          recency: 0.2,
          frequency: 0.1,
          project: 0.2,
        },
        enablePersonalMemorySync: undefined,
      },
    );
    expect(setUserPrefMock).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'shared_context.personal_memory_sync.v2',
      'true',
    );
    expect(sendToDaemonMock).toHaveBeenCalledWith(JSON.stringify({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'manual',
        primaryContextBackend: 'agy-sdk',
        primaryContextModel: 'gemini-3.8-flash-low',
        primaryContextPreset: undefined,
        backupContextBackend: 'opencode-sdk',
        backupContextModel: 'opencode/big-pickle',
        backupContextPreset: undefined,
        memoryRecallMinScore: 0.37,
        memoryScoringWeights: {
          similarity: 0.5,
          recency: 0.2,
          frequency: 0.1,
          project: 0.2,
        },
        enablePersonalMemorySync: true,
      },
    }));
  });

  it('rejects removed qwen backend on PUT and normalizes legacy persisted qwen + non-Luna codex models on GET/daemon sync', async () => {
    const app = await buildApp();
    const putRejected = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primaryContextBackend: 'qwen',
        primaryContextModel: 'qwen3-coder-plus',
      }),
    });
    expect(putRejected.status).toBe(400);

    const putCodex = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.3-codex-spark',
      }),
    });
    expect(putCodex.status).toBe(200);
    await expect(putCodex.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-6-luna',
        },
      },
    });

    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen3-coder-plus',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-5.3-codex-spark',
    });
    const getLegacy = await app.request('/api/server/srv-1/shared-context/runtime-config');
    expect(getLegacy.status).toBe(200);
    await expect(getLegacy.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-6-luna',
          backupContextBackend: 'codex-sdk',
          backupContextModel: 'gpt-6-luna',
        },
      },
    });

    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.3-codex-spark',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
    });
    const daemonLegacy = await app.request('/api/server/srv-1/shared-context/runtime-config/daemon', {
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(daemonLegacy.status).toBe(200);
    await expect(daemonLegacy.json()).resolves.toMatchObject({
      config: {
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-6-luna',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-6-luna',
      },
    });
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
        modelSelectionMode: 'manual',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'sonnet',
        primaryContextPreset: undefined,
        backupContextBackend: DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
        backupContextModel: DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
        backupContextPreset: undefined,
        memoryRecallMinScore: 0.4,
        memoryScoringWeights: {
          similarity: 0.4,
          recency: 0.25,
          frequency: 0.15,
          project: 0.2,
        },
        enablePersonalMemorySync: true,
      },
    });
    expect(queryOneMock).toHaveBeenCalled();
  });

  it('keeps canonical opencode-sdk/agy-sdk on PUT enqueue while isolating HTTP pull compatibility strictly to the HTTP header', async () => {
    const app = await buildApp();

    // Even when WS bridge reports legacy backends or offline (null), PUT saves canonical backends
    // and passes the canonical config into WsBridge so WsBridge adapts per connection on send/replay.
    getSupportedSharedContextRuntimeBackendsMock.mockReturnValue(null);
    const putOffline = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primaryContextBackend: 'opencode-sdk',
        primaryContextModel: 'anthropic/claude-sonnet-4-6',
        backupContextBackend: 'agy-sdk',
        backupContextModel: 'gemini-3.8-flash-low',
        enablePersonalMemorySync: true,
      }),
    });
    expect(putOffline.status).toBe(200);
    await expect(putOffline.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          primaryContextBackend: 'opencode-sdk',
          primaryContextModel: 'anthropic/claude-sonnet-4-6',
          backupContextBackend: 'agy-sdk',
          backupContextModel: 'gemini-3.8-flash-low',
        },
      },
    });
    expect(updateServerSharedContextRuntimeConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      'srv-1',
      'user-1',
      expect.objectContaining({
        primaryContextBackend: 'opencode-sdk',
        primaryContextModel: 'anthropic/claude-sonnet-4-6',
        backupContextBackend: 'agy-sdk',
        backupContextModel: 'gemini-3.8-flash-low',
      }),
    );
    expect(sendToDaemonMock).toHaveBeenLastCalledWith(JSON.stringify({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'manual',
        primaryContextBackend: 'opencode-sdk',
        primaryContextModel: 'anthropic/claude-sonnet-4-6',
        primaryContextPreset: undefined,
        backupContextBackend: 'agy-sdk',
        backupContextModel: 'gemini-3.8-flash-low',
        backupContextPreset: undefined,
        memoryRecallMinScore: 0.4,
        memoryScoringWeights: {
          similarity: 0.4,
          recency: 0.25,
          frequency: 0.15,
          project: 0.2,
        },
        enablePersonalMemorySync: true,
      },
    }));

    // HTTP pull without capability header receives legacy fallback even when WS bridge advertises new backends
    // (HTTP pull does not borrow WS socket generation state).
    getSupportedSharedContextRuntimeBackendsMock.mockReturnValue([...SHARED_CONTEXT_RUNTIME_BACKENDS]);
    getServerSharedContextRuntimeConfigMock.mockResolvedValue({
      primaryContextBackend: 'opencode-sdk',
      primaryContextModel: 'opencode/claude-sonnet-4-6',
      backupContextBackend: 'agy-sdk',
      backupContextModel: 'gemini-3.8-flash-low',
    });
    const oldDaemonPull = await app.request('/api/server/srv-1/shared-context/runtime-config/daemon', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(oldDaemonPull.status).toBe(200);
    await expect(oldDaemonPull.json()).resolves.toMatchObject({
      config: {
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-6-luna',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-6-luna',
      },
    });

    // HTTP pull WITH capability header receives selected opencode-sdk/agy-sdk even if WS bridge is offline/legacy.
    getSupportedSharedContextRuntimeBackendsMock.mockReturnValue([...LEGACY_SHARED_CONTEXT_RUNTIME_BACKENDS]);
    const newDaemonPull = await app.request('/api/server/srv-1/shared-context/runtime-config/daemon', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer token-1',
        [SHARED_CONTEXT_RUNTIME_CAPABILITY_PROTOCOL.HTTP_BACKENDS_HEADER]: SHARED_CONTEXT_RUNTIME_BACKENDS.join(','),
      },
    });
    expect(newDaemonPull.status).toBe(200);
    await expect(newDaemonPull.json()).resolves.toMatchObject({
      config: {
        primaryContextBackend: 'opencode-sdk',
        primaryContextModel: 'opencode/claude-sonnet-4-6',
        backupContextBackend: 'agy-sdk',
        backupContextModel: 'gemini-3.8-flash-low',
      },
    });
  });

  it('defaults unconfigured servers to auto mode and round-trips explicit auto/manual selection', async () => {
    const app = await buildApp();
    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce(null);
    const initialRes = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(initialRes.status).toBe(200);
    await expect(initialRes.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
        },
        effective: {
          modelSelectionMode: 'auto',
        },
      },
    });

    const manualPut = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-1',
      },
      body: JSON.stringify({
        modelSelectionMode: 'manual',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'opus[1M]',
      }),
    });
    expect(manualPut.status).toBe(200);
    await expect(manualPut.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'manual',
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'opus[1M]',
        },
        effective: {
          modelSelectionMode: 'manual',
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'opus[1M]',
        },
      },
    });
    expect(updateServerSharedContextRuntimeConfigMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'srv-1',
      'user-1',
      expect.objectContaining({
        modelSelectionMode: 'manual',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'opus[1M]',
      }),
    );
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'manual',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'opus[1M]',
      },
    });

    const autoPut = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-1',
      },
      body: JSON.stringify({
        modelSelectionMode: 'auto',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'opus[1M]',
      }),
    });
    expect(autoPut.status).toBe(200);
    await expect(autoPut.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
        },
        effective: {
          modelSelectionMode: 'auto',
        },
      },
    });
  });

  it('preserves manual codex-sdk gpt-5.4 across PUT/GET/daemon sync and handles legacy no-mode PUT compatibility safely', async () => {
    const app = await buildApp();

    // 1. Explicit manual non-Luna Codex models on primary + backup are preserved end-to-end.
    const manualCodexPut = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        modelSelectionMode: 'manual',
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.4',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-5.6',
      }),
    });
    expect(manualCodexPut.status).toBe(200);
    await expect(manualCodexPut.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'manual',
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-5.4',
          backupContextBackend: 'codex-sdk',
          backupContextModel: 'gpt-5.6',
        },
      },
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'manual',
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.4',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-5.6',
      },
    });

    // 2. Legacy no-mode PUT preserves an already-persisted manual config (e.g. Claude/MiniMax when toggling personal sync).
    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M2.7',
      primaryContextPreset: 'MiniMax',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-6-luna',
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: { similarity: 0.4, recency: 0.25, frequency: 0.15, project: 0.2 },
    });
    const legacySyncToggle = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'MiniMax-M2.7',
        primaryContextPreset: 'MiniMax',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-6-luna',
        enablePersonalMemorySync: false,
      }),
    });
    expect(legacySyncToggle.status).toBe(200);
    await expect(legacySyncToggle.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'manual',
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'MiniMax-M2.7',
          primaryContextPreset: 'MiniMax',
          enablePersonalMemorySync: false,
        },
      },
    });

    // 3. Unconfigured server + legacy no-mode PUT saving default model fields stays 'auto',
    // while explicitly changing to a non-default model becomes 'manual'.
    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce(null);
    const legacyDefaultSave = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-6-luna',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-6-luna',
        enablePersonalMemorySync: false,
      }),
    });
    expect(legacyDefaultSave.status).toBe(200);
    await expect(legacyDefaultSave.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
          enablePersonalMemorySync: false,
        },
      },
    });

    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce(null);
    const legacyCustomSave = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.4',
      }),
    });
    expect(legacyCustomSave.status).toBe(200);
    await expect(legacyCustomSave.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'manual',
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-5.4',
        },
      },
    });

    // 4. Existing Auto config WITH non-default backend/preset/backup: legacy no-mode PUT
    // toggling sync/recall while echoing the same model fields preserves Auto + original preset.
    getServerSharedContextRuntimeConfigMock.mockResolvedValueOnce({
      modelSelectionMode: 'auto',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M2.7',
      primaryContextPreset: 'MiniMax',
      backupContextBackend: 'agy-sdk',
      backupContextModel: 'gemini-3.8-flash-low',
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: { similarity: 0.4, recency: 0.25, frequency: 0.15, project: 0.2 },
    });
    const legacyAutoPresetSyncSave = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'MiniMax-M2.7',
        primaryContextPreset: 'MiniMax',
        backupContextBackend: 'agy-sdk',
        backupContextModel: 'gemini-3.8-flash-low',
        memoryRecallMinScore: 0.55,
        enablePersonalMemorySync: false,
      }),
    });
    expect(legacyAutoPresetSyncSave.status).toBe(200);
    await expect(legacyAutoPresetSyncSave.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'MiniMax-M2.7',
          primaryContextPreset: 'MiniMax',
          backupContextBackend: 'agy-sdk',
          backupContextModel: 'gemini-3.8-flash-low',
          memoryRecallMinScore: 0.55,
          enablePersonalMemorySync: false,
        },
      },
    });
    expect(updateServerSharedContextRuntimeConfigMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'srv-1',
      'user-1',
      expect.objectContaining({
        modelSelectionMode: 'auto',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'MiniMax-M2.7',
        primaryContextPreset: 'MiniMax',
      }),
    );
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'auto',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'MiniMax-M2.7',
        primaryContextPreset: 'MiniMax',
      },
    });
  });

  it('keeps concurrent Auto and preset writes intact when a stale client saves memory settings via narrow PATCH', async () => {
    let dbRuntimeConfig: Record<string, unknown> | null = {
      modelSelectionMode: 'manual',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextPreset: 'Old Preset',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-6-luna',
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: { similarity: 0.4, recency: 0.25, frequency: 0.15, project: 0.2 },
    };
    let dbPersonalSyncPref = 'true';

    getServerSharedContextRuntimeConfigMock.mockImplementation(async () => dbRuntimeConfig);
    updateServerSharedContextRuntimeConfigMock.mockImplementation(async (_db: unknown, _serverId: string, _userId: string, cfg: Record<string, unknown>) => {
      dbRuntimeConfig = { ...cfg };
      return true;
    });
    patchServerSharedContextMemorySettingsMock.mockImplementation(
      async (_db: unknown, _serverId: string, _userId: string, defaultBase: Record<string, unknown>, patch: Record<string, unknown>) => {
        dbRuntimeConfig = {
          ...(dbRuntimeConfig ?? defaultBase),
          ...patch,
        };
        return dbRuntimeConfig;
      },
    );
    getUserPrefMock.mockImplementation(async (_db: unknown, _userId: string, key: string) => (
      key === 'shared_context.personal_memory_sync.v2' ? dbPersonalSyncPref : undefined
    ));
    setUserPrefMock.mockImplementation(async (_db: unknown, _userId: string, key: string, value: string) => {
      if (key === 'shared_context.personal_memory_sync.v2') dbPersonalSyncPref = value;
    });

    const app = await buildApp();

    // 1. Client A loads stale Manual + Old Preset snapshot.
    const clientAGet = await app.request('/api/server/srv-1/shared-context/runtime-config');
    expect(clientAGet.status).toBe(200);
    await expect(clientAGet.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'manual',
          primaryContextPreset: 'Old Preset',
        },
      },
    });

    // 2. Client B concurrently switches to Auto + Current Preset.
    const clientBPut = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        modelSelectionMode: 'auto',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'MiniMax-M2.7',
        primaryContextPreset: 'Current Preset',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-6-luna',
        enablePersonalMemorySync: true,
        memoryRecallMinScore: 0.4,
        memoryScoringWeights: { similarity: 0.4, recency: 0.25, frequency: 0.15, project: 0.2 },
      }),
    });
    expect(clientBPut.status).toBe(200);

    updateServerSharedContextRuntimeConfigMock.mockClear();
    patchServerSharedContextMemorySettingsMock.mockClear();
    sendToDaemonMock.mockClear();

    // 3a. Client A (without re-fetching) toggles enablePersonalMemorySync -> only writes user pref, never touches model config DB.
    const patchSync = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({ enablePersonalMemorySync: false }),
    });
    expect(patchSync.status).toBe(200);
    await expect(patchSync.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'MiniMax-M2.7',
          primaryContextPreset: 'Current Preset',
          enablePersonalMemorySync: false,
        },
      },
    });
    expect(updateServerSharedContextRuntimeConfigMock).not.toHaveBeenCalled();
    expect(patchServerSharedContextMemorySettingsMock).not.toHaveBeenCalled();
    expect(dbRuntimeConfig).toMatchObject({
      modelSelectionMode: 'auto',
      primaryContextPreset: 'Current Preset',
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'auto',
        primaryContextPreset: 'Current Preset',
        enablePersonalMemorySync: false,
      },
    });

    // 3b. Client A saves memoryRecallMinScore via PATCH -> merges via atomic SQL without overwriting Auto + Current Preset.
    const patchRecall = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({ memoryRecallMinScore: 0.62 }),
    });
    expect(patchRecall.status).toBe(200);
    await expect(patchRecall.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'MiniMax-M2.7',
          primaryContextPreset: 'Current Preset',
          memoryRecallMinScore: 0.62,
          enablePersonalMemorySync: false,
        },
      },
    });
    expect(patchServerSharedContextMemorySettingsMock).toHaveBeenCalledTimes(1);
    expect(updateServerSharedContextRuntimeConfigMock).not.toHaveBeenCalled();
    expect(dbRuntimeConfig).toMatchObject({
      modelSelectionMode: 'auto',
      primaryContextPreset: 'Current Preset',
      memoryRecallMinScore: 0.62,
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'auto',
        primaryContextPreset: 'Current Preset',
        memoryRecallMinScore: 0.62,
        enablePersonalMemorySync: false,
      },
    });

    // 3c. Client A saves memoryScoringWeights via PATCH -> preserves Auto + Current Preset + recall 0.62 + sync false.
    const patchWeights = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        memoryScoringWeights: { similarity: 0.5, recency: 0.2, frequency: 0.15, project: 0.15 },
      }),
    });
    expect(patchWeights.status).toBe(200);
    await expect(patchWeights.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'MiniMax-M2.7',
          primaryContextPreset: 'Current Preset',
          memoryRecallMinScore: 0.62,
          memoryScoringWeights: { similarity: 0.5, recency: 0.2, frequency: 0.15, project: 0.15 },
          enablePersonalMemorySync: false,
        },
      },
    });
    expect(patchServerSharedContextMemorySettingsMock).toHaveBeenCalledTimes(2);
    expect(updateServerSharedContextRuntimeConfigMock).not.toHaveBeenCalled();
    expect(dbRuntimeConfig).toMatchObject({
      modelSelectionMode: 'auto',
      primaryContextPreset: 'Current Preset',
      memoryRecallMinScore: 0.62,
      memoryScoringWeights: { similarity: 0.5, recency: 0.2, frequency: 0.15, project: 0.15 },
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'auto',
        primaryContextPreset: 'Current Preset',
        memoryRecallMinScore: 0.62,
        memoryScoringWeights: { similarity: 0.5, recency: 0.2, frequency: 0.15, project: 0.15 },
        enablePersonalMemorySync: false,
      },
    });
  });

  it('rejects model fields, empty bodies, and unauthorized servers on memory settings PATCH', async () => {
    const app = await buildApp();

    const withModelField = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        memoryRecallMinScore: 0.5,
        modelSelectionMode: 'manual',
      }),
    });
    expect(withModelField.status).toBe(400);

    const emptyPatch = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(400);

    getServerByIdMock.mockResolvedValueOnce(null);
    const syncMissingServer = await app.request('/api/server/srv-missing/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({ enablePersonalMemorySync: false }),
    });
    expect(syncMissingServer.status).toBe(404);
    expect(setUserPrefMock).not.toHaveBeenCalled();

    patchServerSharedContextMemorySettingsMock.mockResolvedValueOnce(null);
    const patchMissingServer = await app.request('/api/server/srv-missing/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({ memoryRecallMinScore: 0.5 }),
    });
    expect(patchMissingServer.status).toBe(404);
  });

  it('serializes overlapped PUT and PATCH publishing so neither stale model config nor stale WS APPLY overwrites concurrent Auto + preset', async () => {
    let dbRuntimeConfig: Record<string, unknown> | null = {
      modelSelectionMode: 'manual',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextPreset: 'Old Preset',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-6-luna',
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: { similarity: 0.4, recency: 0.25, frequency: 0.15, project: 0.2 },
    };
    let dbPersonalSyncPref = 'true';

    getServerSharedContextRuntimeConfigMock.mockImplementation(async () => dbRuntimeConfig);
    updateServerSharedContextRuntimeConfigMock.mockImplementation(async (_db: unknown, _serverId: string, _userId: string, cfg: Record<string, unknown>) => {
      dbRuntimeConfig = { ...cfg };
      return true;
    });
    patchServerSharedContextMemorySettingsMock.mockImplementation(
      async (_db: unknown, _serverId: string, _userId: string, defaultBase: Record<string, unknown>, patch: Record<string, unknown>) => {
        dbRuntimeConfig = {
          ...(dbRuntimeConfig ?? defaultBase),
          ...patch,
        };
        return dbRuntimeConfig;
      },
    );
    getUserPrefMock.mockImplementation(async (_db: unknown, _userId: string, key: string) => (
      key === 'shared_context.personal_memory_sync.v2' ? dbPersonalSyncPref : undefined
    ));
    setUserPrefMock.mockImplementation(async (_db: unknown, _userId: string, key: string, value: string) => {
      if (key === 'shared_context.personal_memory_sync.v2') dbPersonalSyncPref = value;
    });

    const app = await buildApp();

    // Case A: PATCH writes threshold onto Manual/Old Preset, then pauses on reading user sync pref while PUT finishes Auto/Current Preset.
    let releasePatchPrefRead!: () => void;
    let signalPatchEnteredPrefRead!: () => void;
    const patchEnteredPrefRead = new Promise<void>((resolve) => {
      signalPatchEnteredPrefRead = resolve;
    });
    getUserPrefMock.mockImplementationOnce(async (_db: unknown, _userId: string, key: string) => {
      signalPatchEnteredPrefRead();
      await new Promise<void>((resolve) => {
        releasePatchPrefRead = resolve;
      });
      return key === 'shared_context.personal_memory_sync.v2' ? dbPersonalSyncPref : undefined;
    });

    const patchPromise = app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({ memoryRecallMinScore: 0.62 }),
    });
    await patchEnteredPrefRead;

    const putPromise = app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        modelSelectionMode: 'auto',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'MiniMax-M2.7',
        primaryContextPreset: 'Current Preset',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-6-luna',
        enablePersonalMemorySync: true,
        memoryRecallMinScore: 0.4,
        memoryScoringWeights: { similarity: 0.4, recency: 0.25, frequency: 0.15, project: 0.2 },
      }),
    });

    // Wait until PUT finishes its DB write and queues behind PATCH's serialized publish.
    await vi.waitFor(() => expect(dbRuntimeConfig).toMatchObject({
      modelSelectionMode: 'auto',
      primaryContextPreset: 'Current Preset',
    }));

    releasePatchPrefRead();
    const [patchRes, putRes] = await Promise.all([patchPromise, putPromise]);
    expect(patchRes.status).toBe(200);
    expect(putRes.status).toBe(200);
    await expect(patchRes.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
          primaryContextPreset: 'Current Preset',
        },
      },
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'auto',
        primaryContextPreset: 'Current Preset',
      },
    });

    // Case B: Reverse overlap — PUT writes Auto/Current Preset, pauses inside publish while PATCH merges sync=false & recall=0.71.
    sendToDaemonMock.mockClear();
    let releasePutPrefRead!: () => void;
    let signalPutEnteredPrefRead!: () => void;
    const putEnteredPrefRead = new Promise<void>((resolve) => {
      signalPutEnteredPrefRead = resolve;
    });
    getUserPrefMock.mockImplementationOnce(async (_db: unknown, _userId: string, key: string) => {
      signalPutEnteredPrefRead();
      await new Promise<void>((resolve) => {
        releasePutPrefRead = resolve;
      });
      return key === 'shared_context.personal_memory_sync.v2' ? dbPersonalSyncPref : undefined;
    });

    const reversePutPromise = app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        modelSelectionMode: 'auto',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'MiniMax-M2.7',
        primaryContextPreset: 'Current Preset',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-6-luna',
        enablePersonalMemorySync: true,
        memoryRecallMinScore: 0.4,
        memoryScoringWeights: { similarity: 0.4, recency: 0.25, frequency: 0.15, project: 0.2 },
      }),
    });
    await putEnteredPrefRead;

    const reversePatchPromise = app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({ enablePersonalMemorySync: false, memoryRecallMinScore: 0.71 }),
    });
    await vi.waitFor(() => expect(dbRuntimeConfig).toMatchObject({
      memoryRecallMinScore: 0.71,
    }));

    releasePutPrefRead();
    const [reversePutRes, reversePatchRes] = await Promise.all([reversePutPromise, reversePatchPromise]);
    expect(reversePutRes.status).toBe(200);
    expect(reversePatchRes.status).toBe(200);
    expect(dbRuntimeConfig).toMatchObject({
      modelSelectionMode: 'auto',
      primaryContextPreset: 'Current Preset',
      memoryRecallMinScore: 0.71,
    });
    expect(dbPersonalSyncPref).toBe('false');
    await expect(reversePatchRes.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
          primaryContextPreset: 'Current Preset',
          memoryRecallMinScore: 0.71,
          enablePersonalMemorySync: false,
        },
      },
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'auto',
        primaryContextPreset: 'Current Preset',
        memoryRecallMinScore: 0.71,
        enablePersonalMemorySync: false,
      },
    });

    // Case C: Sync-only PATCH paused while writing user pref, as PUT commits Auto/Updated Preset -> sync-only PATCH reads latest Auto/Updated Preset on publish.
    sendToDaemonMock.mockClear();
    let releaseSyncPrefWrite!: () => void;
    let signalSyncPrefWriteStarted!: () => void;
    const syncPrefWriteStarted = new Promise<void>((resolve) => {
      signalSyncPrefWriteStarted = resolve;
    });
    setUserPrefMock.mockImplementationOnce(async (_db: unknown, _userId: string, key: string, value: string) => {
      signalSyncPrefWriteStarted();
      await new Promise<void>((resolve) => {
        releaseSyncPrefWrite = resolve;
      });
      if (key === 'shared_context.personal_memory_sync.v2') dbPersonalSyncPref = value;
    });

    const syncOnlyPatchPromise = app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({ enablePersonalMemorySync: true }),
    });
    await syncPrefWriteStarted;

    const concurrentPresetPutRes = await app.request('/api/server/srv-1/shared-context/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify({
        modelSelectionMode: 'auto',
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'MiniMax-M2.7',
        primaryContextPreset: 'Updated Preset',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-6-luna',
        enablePersonalMemorySync: false,
        memoryRecallMinScore: 0.71,
        memoryScoringWeights: { similarity: 0.4, recency: 0.25, frequency: 0.15, project: 0.2 },
      }),
    });
    expect(concurrentPresetPutRes.status).toBe(200);

    releaseSyncPrefWrite();
    const syncOnlyPatchRes = await syncOnlyPatchPromise;
    expect(syncOnlyPatchRes.status).toBe(200);
    await expect(syncOnlyPatchRes.json()).resolves.toMatchObject({
      snapshot: {
        persisted: {
          modelSelectionMode: 'auto',
          primaryContextPreset: 'Updated Preset',
          enablePersonalMemorySync: true,
        },
      },
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: {
        modelSelectionMode: 'auto',
        primaryContextPreset: 'Updated Preset',
        enablePersonalMemorySync: true,
      },
    });
  });
});
