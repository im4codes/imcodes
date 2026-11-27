import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionPoolMcpToolHandlers } from '../../src/daemon/execution-pool-mcp-tools.js';
import { loadModelTierKnowledge, upsertModelTierKnowledge } from '../../src/daemon/model-tier-knowledge.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { SUPERVISION_MODE, normalizeSupervisorDefaultConfig } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';

const tmpKnowledgeDirs: string[] = [];
function makeKnowledgeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-pool-mcp-'));
  tmpKnowledgeDirs.push(dir);
  return join(dir, 'model-tier-knowledge.json');
}
afterEach(() => {
  while (tmpKnowledgeDirs.length > 0) {
    rmSync(tmpKnowledgeDirs.pop()!, { recursive: true, force: true });
  }
});

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
  it('maps generic google provider to agy-sdk transport and rejects explicit deprecated gemini/gemini-sdk providers', async () => {
    let saved = defaults();
    const setDefaults = vi.fn(async (_caller, mutate) => { saved = mutate(saved); return saved; });
    const handlers = createExecutionPoolMcpToolHandlers(caller, { getDefaults: () => saved, setDefaults, isProjectBrain: () => true });

    // 1. Generic google maps to agy-sdk transport even for legacy Gemini model names
    const res1 = await handlers.execution_pool_set({
      entries: [{ model: 'gemini-2.5-pro', provider: 'google', role: 'executor' }],
    });
    expect(res1).toMatchObject({ status: 'ok', entries: [{ role: 'executor' }] });
    expect(saved.executionPools.primaryDevelopmentPool.configs[0]).toMatchObject({
      agentType: 'agy-sdk',
      providerFamily: 'google',
      runtimeType: 'transport',
      model: 'gemini-2.5-pro',
      role: 'executor',
    });

    // 2. Explicit deprecated 'gemini' / 'gemini-sdk' providers are rejected cleanly
    await expect(handlers.execution_pool_set({
      entries: [{ model: 'gemini-3.8-flash-high', provider: 'gemini', role: 'executor' }],
    })).resolves.toMatchObject({ status: 'error' });
    await expect(handlers.execution_pool_set({
      entries: [{ model: 'gemini-3.8-flash-high', provider: 'gemini-sdk', role: 'executor' }],
    })).resolves.toMatchObject({ status: 'error' });

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

  it('supports unknown-model detection -> learnedModelTiers disk persistence -> cross-instance recommendation & atomic batch pool save', async () => {
    const knowledgeFile = makeKnowledgeFile();
    let saved = normalizeSupervisorDefaultConfig({
      backend: 'claude-code-sdk',
      model: 'sonnet',
      executionPools: {
        state: 'legacy_unconfigured',
        primaryDevelopmentPool: { configs: [] },
        economyTaskPool: { configs: [] },
      },
    });
    const setDefaults = vi.fn(async (_caller, mutate) => { saved = mutate(saved); return saved; });

    const makeHandlers = () => createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: () => saved,
      setDefaults,
      isProjectBrain: () => true,
      loadKnowledge: () => loadModelTierKnowledge(knowledgeFile),
      saveKnowledge: (updates) => upsertModelTierKnowledge(updates, knowledgeFile),
      probeSdks: () => ({
        currentBrain: { provider: 'claude-code-sdk', providerFamily: 'anthropic', model: 'sonnet' },
        sdks: [
          {
            provider: 'claude-code-sdk',
            providerFamily: 'anthropic',
            loggedIn: true,
            models: ['claude-aurora-7', 'sonnet', 'haiku'],
            tiers: { secondary: 'sonnet', flagship: 'sonnet', economy: 'haiku' },
            unknownModels: ['claude-aurora-7'],
            source: 'live_catalog',
          },
          {
            provider: 'codex-sdk',
            providerFamily: 'openai',
            loggedIn: true,
            models: ['gpt-7-quasar', 'gpt-8-sol', 'gpt-8-luna'],
            tiers: { secondary: 'gpt-8-sol', flagship: 'gpt-8-sol', economy: 'gpt-8-luna' },
            unknownModels: ['gpt-7-quasar'],
            source: 'live_catalog',
          },
        ],
      }),
    });

    // 1. Initial get flags both unknown models and sets needsModelResearch: true
    const firstGet = await makeHandlers().execution_pool_get();
    expect(firstGet).toMatchObject({
      status: 'ok',
      configured: false,
      needsModelResearch: true,
      unknownModels: [
        { provider: 'claude-code-sdk', model: 'claude-aurora-7' },
        { provider: 'codex-sdk', model: 'gpt-7-quasar' },
      ],
      customAllowed: true,
    });

    // 2. Learning model tiers ONLY must NOT touch or mutate existing pool defaults
    const learnResult = await makeHandlers().execution_pool_set({
      learnedModelTiers: [
        { provider: 'claude-code-sdk', model: 'claude-aurora-7', tier: 'flagship', source: 'web_search' },
        { provider: 'codex-sdk', model: 'gpt-7-quasar', tier: 'secondary', source: 'web_search' },
      ],
    });
    expect(setDefaults).not.toHaveBeenCalled();
    expect(learnResult).toMatchObject({
      status: 'ok',
      configured: false,
      learnedModelsUpdated: 2,
      needsModelResearch: false,
      unknownModels: [],
    });

    // 3. New handler instance reloads persisted knowledge from disk and surfaces newly learned models in presets
    const reloadedGet = await makeHandlers().execution_pool_get();
    expect(reloadedGet).toMatchObject({
      status: 'ok',
      needsModelResearch: false,
      unknownModels: [],
      recommendedPresets: expect.arrayContaining([
        expect.objectContaining({
          id: 'balanced_cross_vendor',
          recommended: true,
          primaryEntries: [
            { provider: 'claude-code-sdk', model: 'sonnet', role: 'executor', enabled: true },
            { provider: 'codex-sdk', model: 'gpt-8-sol', role: 'auditor', enabled: true },
          ],
          economyEntries: [
            { provider: 'claude-code-sdk', model: 'haiku', role: 'both', enabled: true },
          ],
        }),
      ]),
    });

    // 4. Atomic batch write of primaryEntries + economyEntries accepts completely new/unknown model IDs
    const batchResult = await makeHandlers().execution_pool_set({
      primaryEntries: [
        { provider: 'claude-code-sdk', model: 'claude-aurora-7', role: 'executor' },
        { provider: 'codex-sdk', model: 'gpt-7-quasar', role: 'auditor' },
      ],
      economyEntries: [
        { provider: 'codex-sdk', model: 'nova-x1', role: 'both' },
      ],
      autoPairingEnabled: true,
      auditByDefault: true,
    });
    expect(setDefaults).toHaveBeenCalledOnce();
    expect(batchResult).toMatchObject({
      status: 'ok',
      configured: true,
      autoPairingEnabled: true,
      auditByDefault: true,
      entries: [
        { provider: 'claude-code-sdk', model: 'claude-aurora-7', role: 'executor', pool: 'primary', enabled: true },
        { provider: 'codex-sdk', model: 'gpt-7-quasar', role: 'auditor', pool: 'primary', enabled: true },
        { provider: 'codex-sdk', model: 'nova-x1', role: 'both', pool: 'economy', enabled: true },
      ],
    });
  });

  it('rejects ambiguous entries + primaryEntries combination and invalid learnedModelTiers payloads', async () => {
    let saved = defaults();
    const handlers = createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: () => saved,
      setDefaults: async (_caller, mutate) => { saved = mutate(saved); return saved; },
      isProjectBrain: () => true,
    });
    await expect(handlers.execution_pool_set({
      entries: [{ provider: 'codex-sdk', model: 'gpt-6-sol' }],
      primaryEntries: [{ provider: 'codex-sdk', model: 'gpt-6-sol' }],
    })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(handlers.execution_pool_set({
      learnedModelTiers: [{ provider: 'codex-sdk', model: 'x', tier: 'invalid-tier' }],
    })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
  });
});
