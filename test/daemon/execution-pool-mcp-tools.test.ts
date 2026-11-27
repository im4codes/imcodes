import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionPoolMcpToolHandlers } from '../../src/daemon/execution-pool-mcp-tools.js';
import { mergeDefaultToolDeps, createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import { startHookServer } from '../../src/daemon/hook-server.js';
import { upsertSession, getSession, removeSession } from '../../src/store/session-store.js';
import * as bindFlow from '../../src/bind/bind-flow.js';
import {
  __resetSupervisorDefaultsCacheForTests,
  __setCachedSupervisorDefaultsForTests,
  getCachedSupervisorDefaults,
} from '../../src/daemon/supervisor-defaults-cache.js';
import { configuredPools } from '../../src/daemon/supervision-auto-provision.js';
import { loadModelTierKnowledge, upsertModelTierKnowledge } from '../../src/daemon/model-tier-knowledge.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { SUPERVISION_MODE, normalizeSupervisorDefaultConfig } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import { HOOK_SESSION_CREDENTIAL_ENV } from '../../shared/hook-session-credential.js';
import { IMCODES_RUNTIME_EPOCH_ENV, IMCODES_SESSION_INSTANCE_ID_ENV } from '../../shared/session-resource-lifecycle.js';
import { HookAuthorityUnavailableError } from '../../src/daemon/hook-port.js';

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
    await expect(handlers.execution_pool_get()).resolves.toMatchObject({ status: 'ok', configured: false, askUser: expect.stringContaining('execution_pool_set') });
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

  it('publishes execution_pool_set from stdio MCP through daemon hook RPC so configuredPools sees it immediately without waiting for WS notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-pool-rpc-'));
    tmpKnowledgeDirs.push(dir);
    const rpcSessionName = 'deck_brain_rpc_test';
    const brainRecord = {
      name: rpcSessionName,
      projectName: 'p-rpc',
      role: 'brain' as const,
      agentType: 'claude-code-sdk',
      projectDir: dir,
      state: 'running' as const,
      sessionInstanceId: 'inst-rpc-1',
      runtimeEpoch: 'epoch-rpc-1',
      hookCredential: 'cred-rpc-1',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    };
    upsertSession(brainRecord);
    const persistedBrain = getSession(rpcSessionName)!;
    const sessionInstanceId = persistedBrain.sessionInstanceId ?? 'inst-rpc-1';
    const runtimeEpoch = persistedBrain.runtimeEpoch ?? 'epoch-rpc-1';
    __resetSupervisorDefaultsCacheForTests();
    const initialUnconfigured = normalizeSupervisorDefaultConfig({
      backend: 'claude-code-sdk',
      model: 'sonnet',
      executionPools: {
        state: 'legacy_unconfigured',
        primaryDevelopmentPool: { configs: [] },
        economyTaskPool: { configs: [] },
      },
    });
    __setCachedSupervisorDefaultsForTests(initialUnconfigured);

    let remoteDefaults: Record<string, unknown> = initialUnconfigured;
    vi.spyOn(bindFlow, 'loadCredentials').mockResolvedValue({
      workerUrl: 'http://127.0.0.1:9',
      serverId: 's',
      token: 'tok-test',
    } as any);
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { defaults?: Record<string, unknown> };
        if (body.defaults) remoteDefaults = body.defaults;
      }
      return new Response(JSON.stringify({ defaults: remoteDefaults }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const started = await startHookServer(vi.fn(), {
      authorityHome: dir,
      memoryMcpServerId: 's',
      bindListener: (srv) => new Promise((resolveListen, rejectListen) => {
        srv.once('error', rejectListen);
        srv.listen(0, '127.0.0.1', () => resolveListen());
      }),
    });

    const rpcCaller: McpRuntimeCaller = {
      sessionName: rpcSessionName,
      projectName: 'p-rpc',
      userId: 'u',
      serverId: 's',
      providerId: 'claude-code-sdk',
      projectRoot: dir,
      transport: 'stdio',
      namespace: { scope: 'user_private', userId: 'u' },
    };
    const env = {
      [IMCODES_SESSION_INSTANCE_ID_ENV]: sessionInstanceId,
      [IMCODES_RUNTIME_EPOCH_ENV]: runtimeEpoch,
      [HOOK_SESSION_CREDENTIAL_ENV]: 'cred-rpc-1',
    };
    const mergedDeps = mergeDefaultToolDeps(
      rpcCaller,
      {},
      { sessionName: rpcSessionName, sessionInstanceId, runtimeEpoch },
      {
        env,
        hookCredential: 'cred-rpc-1',
        resolveHookPort: async () => started.port,
        resolveHookAuthority: async () => ({ ok: true, port: started.port, source: 'test' } as any),
      },
    );
    const server = createMemoryMcpServer(rpcCaller, mergedDeps, {}, { isProjectBrain: () => true }, { toolCatalogMode: 'static_full' });
    const client = new Client({ name: 'pool-rpc-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      // Before execution_pool_set: daemon cache is unconfigured
      expect(configuredPools(brainRecord)).toBeUndefined();

      const toolResponse = await client.callTool({
        name: 'execution_pool_set',
        arguments: {
          primaryEntries: [
            { provider: 'claude-code-sdk', model: 'claude-fable-6', role: 'executor' },
            { provider: 'codex-sdk', model: 'gpt-6.2-sol', role: 'auditor' },
          ],
          autoPairingEnabled: true,
          auditByDefault: true,
        },
      });
      if ((toolResponse as { isError?: boolean }).isError) {
        throw new Error(`Unexpected MCP tool error: ${JSON.stringify(toolResponse)}`);
      }
      const structured = (toolResponse as { structuredContent?: Record<string, unknown> }).structuredContent;
      expect(structured).toMatchObject({
        status: 'ok',
        configured: true,
        autoPairingEnabled: true,
        auditByDefault: true,
      });

      // Immediately after execution_pool_set (no WS SUPERVISOR_DEFAULTS_CHANGED received):
      // main daemon cache & configuredPools() already reflect the new cross-SDK pool!
      const poolsAfter = configuredPools(brainRecord);
      expect(poolsAfter?.state).toBe('configured');
      expect(poolsAfter?.primaryDevelopmentPool.configs).toMatchObject([
        { agentType: 'claude-code-sdk', model: 'claude-fable-6', role: 'executor' },
        { agentType: 'codex-sdk', model: 'gpt-6.2-sol', role: 'auditor' },
      ]);
      expect(getCachedSupervisorDefaults()?.executionPools.state).toBe('configured');
    } finally {
      await client.close();
      await new Promise<void>((resolveClose) => started.server.close(() => resolveClose()));
      removeSession(rpcSessionName);
      __resetSupervisorDefaultsCacheForTests();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('falls back to local execution_pool_get on ECONNREFUSED, timeout, and legacy 404 while refusing auth rejections and ambiguous SET commits', async () => {
    let saved = defaults();
    const setDefaults = vi.fn(async (_caller, mutate) => { saved = mutate(saved); return saved; });
    const probeSdks = vi.fn(async () => ({
      currentBrain: { provider: 'claude-code-sdk', providerFamily: 'anthropic', model: 'sonnet' },
      sdks: [],
    }));

    // 1. Legacy 404 -> both GET and SET safely fall back to local handlers
    const handlers404 = createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: () => saved,
      setDefaults,
      probeSdks,
      isProjectBrain: () => true,
      invokeDaemonTool: async () => {
        const err = new Error('hook send failed with status 404') as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      },
    });
    await expect(handlers404.execution_pool_get()).resolves.toMatchObject({ status: 'ok', configured: true });
    await expect(handlers404.execution_pool_set({ autoPairingEnabled: false })).resolves.toMatchObject({ status: 'ok', autoPairingEnabled: false });
    expect(probeSdks).toHaveBeenCalledTimes(2);
    expect(setDefaults).toHaveBeenCalledTimes(1);

    // 2. Hook unreachable (ECONNREFUSED / HookAuthorityUnavailableError) -> GET falls back locally; SET preserves daemon boundary
    setDefaults.mockClear();
    const handlersConnRefused = createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: () => saved,
      setDefaults,
      probeSdks,
      isProjectBrain: () => true,
      invokeDaemonTool: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:59999') as NodeJS.ErrnoException;
        err.code = 'ECONNREFUSED';
        throw err;
      },
    });
    await expect(handlersConnRefused.execution_pool_get()).resolves.toMatchObject({ status: 'ok', configured: true });
    await expect(handlersConnRefused.execution_pool_set({ autoPairingEnabled: true })).resolves.toMatchObject({
      status: 'error',
      reason: 'internal_error',
    });
    expect(setDefaults).not.toHaveBeenCalled();

    const handlersHookUnavailable = createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: () => saved,
      setDefaults,
      probeSdks,
      isProjectBrain: () => true,
      invokeDaemonTool: async () => {
        throw new HookAuthorityUnavailableError('hook_port_missing', '/execution-pool/tool', 'missing');
      },
    });
    await expect(handlersHookUnavailable.execution_pool_get()).resolves.toMatchObject({ status: 'ok', configured: true });

    // 3. Hook request timeout -> GET falls back locally; SET does NOT blindly rewrite ambiguous commit outcome
    const handlersTimeout = createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: () => saved,
      setDefaults,
      probeSdks,
      isProjectBrain: () => true,
      invokeDaemonTool: async () => {
        throw new Error('hook request timed out after 120000ms');
      },
    });
    await expect(handlersTimeout.execution_pool_get()).resolves.toMatchObject({ status: 'ok', configured: true });
    await expect(handlersTimeout.execution_pool_set({ autoPairingEnabled: true })).resolves.toMatchObject({
      status: 'error',
      reason: 'internal_error',
      message: expect.stringContaining('read execution_pool_get before retrying'),
    });
    expect(setDefaults).not.toHaveBeenCalled();

    // 4. Auth / scope refusal (403) -> NEVER falls back on GET or SET
    probeSdks.mockClear();
    const handlersAuthDenied = createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: () => saved,
      setDefaults,
      probeSdks,
      isProjectBrain: () => true,
      invokeDaemonTool: async () => {
        const err = new Error('daemon_execution_pool_identity_unavailable') as Error & { statusCode?: number };
        err.statusCode = 403;
        throw err;
      },
    });
    await expect(handlersAuthDenied.execution_pool_get()).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    await expect(handlersAuthDenied.execution_pool_set({ autoPairingEnabled: true })).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    expect(probeSdks).not.toHaveBeenCalled();
    expect(setDefaults).not.toHaveBeenCalled();
  });

  it('switches askUser guidance to ask-user-first without announcing an active pool when only unknown models exist and recommendedPresets is empty', async () => {
    const { classifySdkModelTiers } = await import('../../shared/supervision-execution-pool.js');
    const classified = classifySdkModelTiers('codex-sdk', ['nova-x1']);
    expect(classified.unknownModels).toEqual(['nova-x1']);
    expect(classified.tiers).toEqual({});

    const handlers = createExecutionPoolMcpToolHandlers(caller, {
      getDefaults: () => normalizeSupervisorDefaultConfig({
        backend: 'codex-sdk',
        model: 'nova-x1',
        executionPools: {
          state: 'legacy_unconfigured',
          primaryDevelopmentPool: { configs: [] },
          economyTaskPool: { configs: [] },
        },
      }),
      isProjectBrain: () => true,
      loadKnowledge: () => [],
      probeSdks: () => ({
        currentBrain: { provider: 'codex-sdk', providerFamily: 'openai', model: 'nova-x1' },
        sdks: [
          {
            provider: 'codex-sdk',
            providerFamily: 'openai',
            loggedIn: true,
            ...classified,
            source: 'live_catalog',
          },
        ],
      }),
    });

    const res = await handlers.execution_pool_get();
    expect(res).toMatchObject({
      status: 'ok',
      configured: false,
      needsModelResearch: true,
      unknownModels: [{ provider: 'codex-sdk', model: 'nova-x1' }],
      recommendedPresets: [],
    });
    expect(String(res.askUser)).toContain('recommendedPresets remains empty');
    expect(String(res.askUser)).toContain('ask the user');
    expect(String(res.askUser)).not.toContain('without waiting for approval');
  });
});
