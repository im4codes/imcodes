import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadCredentialsMock = vi.fn();

vi.mock('../../src/bind/bind-flow.js', () => ({
  loadCredentials: () => loadCredentialsMock(),
}));

const {
  __resetSupervisorDefaultsCacheForTests,
  getCachedSupervisorDefaults,
  refreshSupervisorDefaultsCache,
} = await import('../../src/daemon/supervisor-defaults-cache.js');

describe('supervisor defaults cache', () => {
  beforeEach(() => {
    __resetSupervisorDefaultsCacheForTests();
    loadCredentialsMock.mockReset();
    loadCredentialsMock.mockResolvedValue({
      workerUrl: 'https://worker.example',
      serverId: 'server-1',
      token: 'server-token',
    });
  });

  afterEach(() => {
    __resetSupervisorDefaultsCacheForTests();
    vi.unstubAllGlobals();
  });

  it('loads and normalizes the account-level primary and backup runtime', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        defaults: {
          backend: 'qwen',
          model: 'qwen3-coder-plus',
          preset: 'Qwen Team',
          backupBackend: 'codex-sdk',
          backupModel: 'gpt-5.3-codex-spark',
          timeoutMs: 45_000,
          promptVersion: 'supervision_decision_v1',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await refreshSupervisorDefaultsCache();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example/api/server/server-1/supervision/user-defaults/daemon',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer server-token' },
      }),
    );
    expect(getCachedSupervisorDefaults()).toMatchObject({
      backend: 'qwen',
      model: 'qwen3-coder-plus',
      preset: 'Qwen Team',
      backupBackend: 'codex-sdk',
      backupModel: 'gpt-5.3-codex-spark',
      timeoutMs: 45_000,
    });
  });
});
