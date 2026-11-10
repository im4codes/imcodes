import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSupervisionExecutionCapabilityId, DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS } from '../../shared/supervision-execution-pool.js';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';

const loadCredentialsMock = vi.fn();

vi.mock('../../src/bind/bind-flow.js', () => ({
  loadCredentials: () => loadCredentialsMock(),
}));

const {
  __reloadSupervisorDefaultsCacheFromDiskForTests,
  __resetSupervisorDefaultsCacheForTests,
  __setCachedSupervisorDefaultsForTests,
  getCachedSupervisorDefaults,
  getSupervisorDefaultsCacheAgeMs,
  overlayCachedExecutionPools,
  refreshSupervisorDefaultsCache,
  updateSupervisorDefaultsCache,
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

  it('does not roll back a saved role when an older poll finishes late, including on disk', async () => {
    let resolveOld!: (value: unknown) => void;
    const old = new Promise((r) => { resolveOld = r; });
    const fetchMock = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce({
      ok: true, json: async () => ({ defaults: { model: 'new' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const poll = refreshSupervisorDefaultsCache();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const normalized = (await import('../../shared/supervision-config.js')).normalizeSupervisorDefaultConfig({ model: 'new' });
    await updateSupervisorDefaultsCache(normalized);
    resolveOld({ ok: true, json: async () => ({ defaults: { model: 'old' } }) });
    await poll;
    expect(getCachedSupervisorDefaults()?.model).toBe('new');
    __setCachedSupervisorDefaultsForTests(null);
    __reloadSupervisorDefaultsCacheFromDiskForTests();
    expect(getCachedSupervisorDefaults()?.model).toBe('new');
  });

  it('does not poll a pre-commit snapshot during an outstanding write', async () => {
    let resolveWrite!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((r) => { resolveWrite = r; })));
    const normalized = (await import('../../shared/supervision-config.js')).normalizeSupervisorDefaultConfig({ model: 'saved' });
    const write = updateSupervisorDefaultsCache(normalized);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await refreshSupervisorDefaultsCache();
    expect(fetch).toHaveBeenCalledOnce();
    resolveWrite({ ok: true, json: async () => ({ defaults: normalized }) });
    await write;
    expect(getCachedSupervisorDefaults()?.model).toBe('saved');
  });

  it('orders overlapping writes so an older response cannot replace the newer preference', async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((r) => { resolveFirst = r; });
    const fetchMock = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ ok: true, json: async () => ({ defaults: { model: 'new' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const { normalizeSupervisorDefaultConfig: normalize } = await import('../../shared/supervision-config.js');
    const older = updateSupervisorDefaultsCache(normalize({ model: 'old' }));
    const newer = updateSupervisorDefaultsCache(normalize({ model: 'new' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolveFirst({ ok: true, json: async () => ({ defaults: { model: 'old' } }) });
    await Promise.all([older, newer]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCachedSupervisorDefaults()?.model).toBe('new');
    __setCachedSupervisorDefaultsForTests(null);
    __reloadSupervisorDefaultsCacheFromDiskForTests();
    expect(getCachedSupervisorDefaults()?.model).toBe('new');
  });

  it('accepts a slow poll despite a newer in-flight poll, but never a superseded response', async () => {
    const resolves: Array<(value: unknown) => void> = [];
    const fetchMock = vi.fn(() => new Promise((r) => resolves.push(r)));
    vi.stubGlobal('fetch', fetchMock);
    const first = refreshSupervisorDefaultsCache();
    const second = refreshSupervisorDefaultsCache();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolves[0]({ ok: true, json: async () => ({ defaults: { model: 'first-slow' } }) });
    await first;
    expect(getCachedSupervisorDefaults()?.model).toBe('first-slow');
    resolves[1]({ ok: true, json: async () => ({ defaults: { model: 'second' } }) });
    await second;
    const older = refreshSupervisorDefaultsCache();
    const newer = refreshSupervisorDefaultsCache();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    resolves[3]({ ok: true, json: async () => ({ defaults: { model: 'newer' } }) });
    await newer;
    resolves[2]({ ok: true, json: async () => ({ defaults: { model: 'superseded' } }) });
    await older;
    expect(getCachedSupervisorDefaults()?.model).toBe('newer');
  });

  it('bounds a stuck write and releases the queue for the next preference', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')))))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ defaults: { model: 'recovered' } }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { normalizeSupervisorDefaultConfig: normalize } = await import('../../shared/supervision-config.js');
      const stalled = updateSupervisorDefaultsCache(normalize({ model: 'stalled' }));
      const next = updateSupervisorDefaultsCache(normalize({ model: 'recovered' }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(timeout).toHaveBeenCalledWith(15000);
      controller.abort();
      expect(await stalled).toBeNull();
      expect((await next)?.model).toBe('recovered');
      expect(getCachedSupervisorDefaults()?.model).toBe('recovered');
    } finally { timeout.mockRestore(); }
  });

  describe('local SQLite mirror (survives a daemon restart)', () => {
    it('is empty before any successful fetch, exactly like a fresh install', () => {
      expect(getCachedSupervisorDefaults()).toBeNull();
      __reloadSupervisorDefaultsCacheFromDiskForTests();
      expect(getCachedSupervisorDefaults()).toBeNull();
    });

    it('recovers the last synced value from disk without a network round trip, simulating a restart', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ defaults: { backend: 'qwen', model: 'qwen3-coder-plus', timeoutMs: 60_000 } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      await refreshSupervisorDefaultsCache();
      expect(getCachedSupervisorDefaults()).toMatchObject({ backend: 'qwen', model: 'qwen3-coder-plus' });

      // Simulate the process restarting: the in-memory value is gone, but a
      // fresh fetch has NOT happened yet (getSupervisorDefaultsCacheAgeMs
      // would report Infinity). The disk mirror must still answer.
      __setCachedSupervisorDefaultsForTests(null);
      expect(getSupervisorDefaultsCacheAgeMs()).toBe(Infinity);
      __reloadSupervisorDefaultsCacheFromDiskForTests();

      expect(getCachedSupervisorDefaults()).toMatchObject({ backend: 'qwen', model: 'qwen3-coder-plus', timeoutMs: 60_000 });
    });

    it('overwrites the disk mirror with each new synced value rather than accumulating stale rows', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ defaults: { backend: 'qwen', model: 'qwen3-coder-plus' } }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ defaults: { backend: 'codex-sdk', model: 'gpt-5.6-sol' } }) });
      vi.stubGlobal('fetch', fetchMock);

      await refreshSupervisorDefaultsCache();
      await refreshSupervisorDefaultsCache();
      __reloadSupervisorDefaultsCacheFromDiskForTests();

      expect(getCachedSupervisorDefaults()).toMatchObject({ backend: 'codex-sdk', model: 'gpt-5.6-sol' });
    });

    it('does not overwrite the disk mirror on a failed fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ defaults: { backend: 'qwen', model: 'qwen3-coder-plus' } }),
      }));
      await refreshSupervisorDefaultsCache();

      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));
      await refreshSupervisorDefaultsCache();

      __reloadSupervisorDefaultsCacheFromDiskForTests();
      expect(getCachedSupervisorDefaults()).toMatchObject({ backend: 'qwen', model: 'qwen3-coder-plus' });
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

    it('retains executor/auditor roles across daemon sync and restart hydration', async () => {
      const roleConfig = {
        ...claudeConfig,
        model: 'gpt-6-luna',
        agentType: 'codex-sdk',
        providerFamily: 'openai',
        role: 'executor' as const,
      };
      const rolePools = {
        state: 'configured' as const,
        primaryDevelopmentPool: {
          configs: [{ ...roleConfig, capabilityId: buildSupervisionExecutionCapabilityId(roleConfig) }],
          controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.primary,
        },
        economyTaskPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.economy },
      };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ defaults: { backend: 'codex-sdk', model: 'gpt-6-luna', executionPools: rolePools } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      await refreshSupervisorDefaultsCache();
      __setCachedSupervisorDefaultsForTests(null);
      __reloadSupervisorDefaultsCacheFromDiskForTests();
      expect(getCachedSupervisorDefaults()?.executionPools.primaryDevelopmentPool.configs[0]?.role).toBe('executor');
    });
  });
});
