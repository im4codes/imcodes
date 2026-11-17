import { describe, expect, it, vi } from 'vitest';
import { createExecutionPoolMcpToolHandlers } from '../../src/daemon/execution-pool-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { SUPERVISION_MODE, normalizeSupervisorDefaultConfig } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';

const caller = { sessionName: 'deck_brain', projectName: 'p', userId: 'u', serverId: 's', providerId: 'p', projectRoot: '/p', transport: 'in_process', namespace: { scope: 'user_private', userId: 'u' } } as McpRuntimeCaller;
function defaults() {
  const config = { agentType: 'codex', providerFamily: 'openai', runtimeType: 'process' as const, model: 'gpt-5.4' };
  return normalizeSupervisorDefaultConfig({ backend: 'codex', model: 'gpt-5.4', executionPools: {
    state: 'configured', primaryDevelopmentPool: { configs: [{ ...config, role: 'executor', capabilityId: buildSupervisionExecutionCapabilityId(config) }], controls: { maxConcurrency: 8 } }, economyTaskPool: { configs: [], controls: { maxConcurrency: 2 } },
  }, mode: SUPERVISION_MODE.SUPERVISED, pairEngine: 'pairs', pairMaxConcurrency: 8 });
}

describe('execution pool MCP tools', () => {
  it('gets the configured pool and preserves explicit role', async () => {
    const handlers = createExecutionPoolMcpToolHandlers(caller, { getDefaults: defaults, isProjectBrain: () => true });
    await expect(handlers.execution_pool_get()).resolves.toMatchObject({ status: 'ok', configured: true, entries: [{ role: 'executor', enabled: true }], autoPairingEnabled: true });
  });
  it('sets entries and policy through the Brain-only gate', async () => {
    let saved = defaults();
    const setDefaults = vi.fn(async (_caller, mutate) => { saved = mutate(saved); return saved; });
    const handlers = createExecutionPoolMcpToolHandlers(caller, { getDefaults: () => saved, setDefaults, isProjectBrain: () => true });
    const result = await handlers.execution_pool_set({ entries: [{ model: 'gpt-5.4', provider: 'codex', role: 'auditor' }], autoPairingEnabled: true, auditByDefault: true, concurrencyCap: 4 });
    expect(result).toMatchObject({ status: 'ok', entries: [{ role: 'auditor' }], auditByDefault: true, concurrencyCap: 4 });
    expect(setDefaults).toHaveBeenCalledOnce();
  });
  it('sets gemini-3.8-flash-high executor and gpt-6.1-sol auditor entries and maps to modern transport runtimes', async () => {
    let saved = defaults();
    const setDefaults = vi.fn(async (_caller, mutate) => { saved = mutate(saved); return saved; });
    const handlers = createExecutionPoolMcpToolHandlers(caller, { getDefaults: () => saved, setDefaults, isProjectBrain: () => true });
    const result = await handlers.execution_pool_set({
      entries: [
        { model: 'gemini-3.8-flash-high', provider: 'google', role: 'executor' },
        { model: 'gpt-6.1-sol', provider: 'openai', role: 'auditor' },
      ],
      autoPairingEnabled: true,
    });
    expect(result).toMatchObject({
      status: 'ok',
      entries: [
        { model: 'gemini-3.8-flash-high', role: 'executor' },
        { model: 'gpt-6.1-sol', role: 'auditor' },
      ],
      autoPairingEnabled: true,
    });
    expect(saved.executionPools.primaryDevelopmentPool.configs).toMatchObject([
      { agentType: 'agy-sdk', providerFamily: 'google', runtimeType: 'transport', model: 'gemini-3.8-flash-high', role: 'executor' },
      { agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport', model: 'gpt-6.1-sol', role: 'auditor' },
    ]);
  });
  it('preserves legacy Google Gemini process runtime and respects authoritative provider over model name (F2)', async () => {
    let saved = defaults();
    const setDefaults = vi.fn(async (_caller, mutate) => { saved = mutate(saved); return saved; });
    const handlers = createExecutionPoolMcpToolHandlers(caller, { getDefaults: () => saved, setDefaults, isProjectBrain: () => true });

    // 1. Generic google with legacy model keeps gemini process runtime
    const res1 = await handlers.execution_pool_set({
      entries: [{ model: 'gemini-2.5-pro', provider: 'google', role: 'executor' }],
    });
    expect(res1).toMatchObject({ status: 'ok', entries: [{ role: 'executor' }] });
    expect(saved.executionPools.primaryDevelopmentPool.configs[0]).toMatchObject({
      agentType: 'gemini',
      providerFamily: 'google',
      runtimeType: 'process',
      model: 'gemini-2.5-pro',
      role: 'executor',
    });

    // 2. Explicit provider 'gemini' is not overridden by AGY model name
    const res2 = await handlers.execution_pool_set({
      entries: [{ model: 'gemini-3.8-flash-high', provider: 'gemini', role: 'executor' }],
    });
    expect(res2).toMatchObject({ status: 'ok' });
    expect(saved.executionPools.primaryDevelopmentPool.configs[0]).toMatchObject({
      agentType: 'gemini',
      providerFamily: 'google',
      runtimeType: 'process',
      model: 'gemini-3.8-flash-high',
      role: 'executor',
    });

    // 3. Explicit provider 'agy-sdk' maps to agy-sdk transport regardless of model
    const res3 = await handlers.execution_pool_set({
      entries: [{ model: 'gemini-2.5-pro', provider: 'agy-sdk', role: 'executor' }],
    });
    expect(res3).toMatchObject({ status: 'ok' });
    expect(saved.executionPools.primaryDevelopmentPool.configs[0]).toMatchObject({
      agentType: 'agy-sdk',
      providerFamily: 'google',
      runtimeType: 'transport',
      model: 'gemini-2.5-pro',
      role: 'executor',
    });

    // 4. Whitespace trimming and case-insensitivity
    const res4 = await handlers.execution_pool_set({
      entries: [{ model: '  gemini-4-argon-medium  ', provider: '  Google  ', role: 'auditor' }],
    });
    expect(res4).toMatchObject({ status: 'ok' });
    expect(saved.executionPools.primaryDevelopmentPool.configs[0]).toMatchObject({
      agentType: 'agy-sdk',
      providerFamily: 'google',
      runtimeType: 'transport',
      model: 'gemini-4-argon-medium',
      role: 'auditor',
    });
  });
  it('reports persistence failure rather than projecting an unsaved role as success', async () => {
    const handlers = createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: defaults, setDefaults: async () => null, isProjectBrain: () => true,
    });
    await expect(handlers.execution_pool_set({ entries: [{ model: 'gpt-5.4', provider: 'codex', role: 'auditor' }] }))
      .resolves.toMatchObject({ status: 'error', reason: 'internal_error' });
    await expect(handlers.execution_pool_get()).resolves.toMatchObject({ entries: [{ role: 'executor' }] });
  });
  it('refuses mutation from a non-Brain and reports unconfigured pools', async () => {
    const handlers = createExecutionPoolMcpToolHandlers(caller, { getDefaults: () => null, isProjectBrain: () => true });
    await expect(handlers.execution_pool_get()).resolves.toMatchObject({ status: 'ok', configured: false, askUser: expect.stringContaining('Ask the user') });
    const unauthorized = createExecutionPoolMcpToolHandlers(caller, { getDefaults: () => defaults(), isProjectBrain: () => false });
    await expect(unauthorized.execution_pool_set({ autoPairingEnabled: true })).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    await expect(unauthorized.execution_pool_get()).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
  });
});
