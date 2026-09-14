import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSupervisionExecutionCapabilityId, DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS } from '../../shared/supervision-execution-pool.js';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';

const loadCredentialsMock = vi.fn();

vi.mock('../../src/bind/bind-flow.js', () => ({
  loadCredentials: () => loadCredentialsMock(),
}));

const {
  __resetSupervisorDefaultsCacheForTests,
  __setCachedSupervisorDefaultsForTests,
  getCachedSupervisorDefaults,
  overlayCachedExecutionPools,
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

  describe('overlayCachedExecutionPools', () => {
    const sessionSnapshot = normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF });
    const claudeConfig = {
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
      runtimeType: 'transport' as const,
      model: 'sonnet',
    };
    const accountConfiguredPools = {
      state: 'configured' as const,
      primaryDevelopmentPool: {
        configs: [{ ...claudeConfig, capabilityId: buildSupervisionExecutionCapabilityId(claudeConfig) }],
        controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.primary,
      },
      economyTaskPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.economy },
    };

    it('leaves the snapshot untouched when nothing has been fetched yet', () => {
      expect(overlayCachedExecutionPools(sessionSnapshot)).toBe(sessionSnapshot);
    });

    it('leaves a real session-level pool alone when the account default was never configured', () => {
      const sessionWithOwnPool = { ...sessionSnapshot, executionPools: accountConfiguredPools };
      __setCachedSupervisorDefaultsForTests({ backend: 'codex-sdk', model: 'gpt-5.3-codex-spark' });
      expect(getCachedSupervisorDefaults()?.executionPools.state).toBe('legacy_unconfigured');
      expect(overlayCachedExecutionPools(sessionWithOwnPool).executionPools).toBe(sessionWithOwnPool.executionPools);
    });

    it('applies the account-level pool once it is genuinely configured, regardless of the session snapshot', () => {
      __setCachedSupervisorDefaultsForTests({
        backend: 'codex-sdk',
        model: 'gpt-5.6-sol',
        executionPools: accountConfiguredPools,
      });
      const result = overlayCachedExecutionPools(sessionSnapshot);
      expect(result.executionPools).toEqual(accountConfiguredPools);
      // Every other field survives untouched -- this helper only ever
      // touches executionPools, unlike enrichSnapshotWithGlobalDefaults.
      expect(result.mode).toBe(sessionSnapshot.mode);
    });
  });
});
