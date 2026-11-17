import { afterEach, expect, it, vi } from 'vitest';
import { normalizeSupervisorDefaultConfig, SUPERVISION_MODE } from '../../shared/supervision-config.js';
import { createExecutionPoolMcpToolHandlers } from '../../src/daemon/execution-pool-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import {
  updateSupervisorDefaultsCache, refreshSupervisorDefaultsCache, getCachedSupervisorDefaults,
  __resetSupervisorDefaultsCacheForTests, __setCachedSupervisorDefaultsForTests,
  __reloadSupervisorDefaultsCacheFromDiskForTests,
} from '../../src/daemon/supervisor-defaults-cache.js';
vi.mock('../../src/bind/bind-flow.js', () => ({
  loadCredentials: async () => ({ workerUrl: 'http://pool-fixture', serverId: 'synthetic', token: 'synthetic' }),
}));
const caller = { sessionName: 'deck_e2e_pool_brain', projectName: 'e2e_pool' } as McpRuntimeCaller;
const defaults = () => normalizeSupervisorDefaultConfig({ executionPools: {
  state: 'configured', primaryDevelopmentPool: { configs: [{
    agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport', model: 'gpt-6-luna',
    capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-6-luna',
  }] }, economyTaskPool: { configs: [] },
} });
const executor = { entries: [{ model: 'gpt-6-luna', provider: 'codex-sdk', role: 'executor' }] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
}
function fixture(failFirst = false) {
  let stored = defaults();
  const begun = deferred();
  const gate = deferred();
  let puts = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.method === 'PUT') {
      if (++puts === 1) {
        begun.resolve(); await gate.promise;
        if (failFirst) return { ok: false };
      }
      stored = JSON.parse(init.body).defaults;
    }
    // Capture the response snapshot at receipt, not after subsequent writes.
    const snapshot = structuredClone(stored);
    return { ok: true, json: async () => ({ defaults: snapshot }) };
  }));
  const handlers = () => createExecutionPoolMcpToolHandlers(caller, {
    isProjectBrain: () => true,
    getDefaults: async () => { await refreshSupervisorDefaultsCache(); return getCachedSupervisorDefaults(); },
    setDefaults: (_caller, update) => updateSupervisorDefaultsCache(update),
  });
  return { handlers, begun, gate, stored: () => stored };
}
afterEach(() => { __resetSupervisorDefaultsCacheForTests(); vi.unstubAllGlobals(); });
it.each(['policy', 'economy', 'role'] as const)('merges overlapping role and %s patches across independent MCP handlers', async (kind) => {
  const f = fixture();
  const first = f.handlers().execution_pool_set(executor);
  await f.begun.promise;
  const patch = kind === 'policy'
    ? { concurrencyCap: 3, autoPairingEnabled: true, auditByDefault: true }
    : kind === 'role' ? { entries: [{ model: 'gpt-6-luna', provider: 'codex-sdk', role: 'auditor' }] }
    : { pool: 'economy', entries: [{ model: 'gpt-6-sol', provider: 'codex-sdk', role: 'auditor' }] };
  const second = f.handlers().execution_pool_set(patch);
  // Let the second SET reach its read/queue while the first PUT is blocked.
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.gate.resolve();
  const results = await Promise.all([first, second]);
  expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
  expect(f.stored().executionPools.primaryDevelopmentPool.configs[0].role).toBe(kind === 'role' ? 'auditor' : 'executor');
  if (kind === 'policy') {
    expect(f.stored()).toMatchObject({ pairMaxConcurrency: 3, pairEngine: 'pairs', mode: SUPERVISION_MODE.SUPERVISED_AUDIT });
  } else if (kind === 'economy') {
    expect(f.stored().executionPools.economyTaskPool.configs[0]).toMatchObject({ model: 'gpt-6-sol', role: 'auditor' });
  }
  expect(getCachedSupervisorDefaults()).toEqual(f.stored());
  __setCachedSupervisorDefaultsForTests(null);
  __reloadSupervisorDefaultsCacheFromDiskForTests();
  expect(getCachedSupervisorDefaults()).toEqual(f.stored());
});
it('releases a failed mutation before applying the next queued patch to current authority', async () => {
  const f = fixture(true);
  const failed = f.handlers().execution_pool_set(executor);
  await f.begun.promise;
  const queued = f.handlers().execution_pool_set({ concurrencyCap: 3 });
  f.gate.resolve();
  expect((await failed).status).toBe('error');
  expect((await queued).status).toBe('ok');
  expect(f.stored().pairMaxConcurrency).toBe(3);
  expect(f.stored().executionPools.primaryDevelopmentPool.configs[0].role).toBeUndefined();
  await expect(f.handlers().execution_pool_set(executor)).resolves.toMatchObject({ status: 'ok', entries: [{ role: 'executor' }] });
});

it('merges against current server authority rather than an older cached Both snapshot', async () => {
  const f = fixture();
  __setCachedSupervisorDefaultsForTests(defaults());
  f.stored().executionPools.primaryDevelopmentPool.configs[0].role = 'executor';
  f.gate.resolve();
  await expect(f.handlers().execution_pool_set({ concurrencyCap: 3 })).resolves.toMatchObject({ status: 'ok', entries: [{ role: 'executor' }] });
  expect(f.stored().pairMaxConcurrency).toBe(3);
});
it('does not PUT a mutation whose authoritative read failed, and then recovers', async () => {
  const f = fixture();
  const fetch = globalThis.fetch as ReturnType<typeof vi.fn>;
  fetch.mockResolvedValueOnce({ ok: false });
  await expect(f.handlers().execution_pool_set({ concurrencyCap: 3 })).resolves.toMatchObject({ status: 'error' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].method).toBe('GET');
  f.gate.resolve();
  await expect(f.handlers().execution_pool_set(executor)).resolves.toMatchObject({ status: 'ok', entries: [{ role: 'executor' }] });
});
it('bounds the read portion of a mutation and releases the same shared queue on abort', async () => {
  const f = fixture();
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
  const fetch = globalThis.fetch as ReturnType<typeof vi.fn>;
  fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('read timeout')));
  }));
  try {
    const stalled = f.handlers().execution_pool_set({ concurrencyCap: 3 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const next = f.handlers().execution_pool_set(executor);
    expect(timeout).toHaveBeenCalledWith(15000);
    controller.abort();
    expect((await stalled).status).toBe('error');
    f.gate.resolve();
    expect((await next).status).toBe('ok');
    expect(f.stored().executionPools.primaryDevelopmentPool.configs[0].role).toBe('executor');
  } finally { timeout.mockRestore(); }
});
