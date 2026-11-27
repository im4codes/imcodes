import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadModelTierKnowledge,
  upsertModelTierKnowledge,
} from '../../src/daemon/model-tier-knowledge.js';
import { probeExecutionPoolSdks } from '../../src/daemon/sdk-execution-pool-probe.js';
import { AGY_NATIVE_SESSION_STATE } from '../../shared/agy-agent.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const tempDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-sdk-probe-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('model-tier-knowledge store', () => {
  it('atomically persists learned tiers and reloads across separate reads while gracefully handling missing/corrupt files', async () => {
    const dir = makeTmpDir();
    const knowledgeFile = join(dir, 'model-tier-knowledge.json');

    expect(loadModelTierKnowledge(knowledgeFile)).toEqual([]);

    writeFileSync(knowledgeFile, '{corrupt json', 'utf8');
    expect(loadModelTierKnowledge(knowledgeFile)).toEqual([]);

    await upsertModelTierKnowledge([
      { provider: 'claude-code-sdk', model: 'claude-aurora-7', tier: 'flagship', source: 'web_search', notes: 'Bearer sk-secret-token-12345' },
      { provider: 'codex-sdk', model: 'gpt-7-quasar', tier: 'secondary', source: 'official_docs' },
    ], knowledgeFile, 1_000);

    const reloaded = loadModelTierKnowledge(knowledgeFile);
    expect(reloaded).toHaveLength(2);
    expect(reloaded.find((r) => r.model === 'claude-aurora-7')).toMatchObject({
      provider: 'claude-code-sdk',
      model: 'claude-aurora-7',
      tier: 'flagship',
      source: 'web_search',
    });
    expect(readFileSync(knowledgeFile, 'utf8')).not.toContain('sk-secret-token-12345');

    // Updating the same model overwrites with newer tier and timestamp
    await upsertModelTierKnowledge([
      { provider: 'codex', model: 'gpt-7-quasar', tier: 'flagship', source: 'updated' },
    ], knowledgeFile, 2_000);
    const updated = loadModelTierKnowledge(knowledgeFile);
    expect(updated.filter((r) => r.model === 'gpt-7-quasar')).toHaveLength(1);
    expect(updated.find((r) => r.model === 'gpt-7-quasar')?.tier).toBe('flagship');
  });
});

describe('probeExecutionPoolSdks', () => {
  it('detects agy-sdk + codex-sdk + claude-code-sdk login without leaking secrets and surfaces live + unknown models', async () => {
    const dir = makeTmpDir();
    const knowledgeFile = join(dir, 'knowledge.json');
    const codexHome = join(dir, 'codex-home');
    const homeDir = join(dir, 'home');
    const claudeDir = join(homeDir, '.claude');
    const imcodesDir = join(dir, '.imcodes');
    const agyQuotaFile = join(imcodesDir, 'agy-usage-quota.json');
    const claudeCredsFile = join(claudeDir, '.credentials.json');
    const now = Date.now();
    const files = new Map<string, string>([
      [join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ id: 'gpt-7.5-sol' }, { id: 'gpt-7.5-luna' }] })],
      [agyQuotaFile, JSON.stringify({ at: now, value: { quotaMeta: { groups: [] } } })],
      [claudeCredsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'super-secret-oauth-token', expiresAt: now + 60_000 } })],
    ]);

    const brainSession = {
      name: 'deck_brain',
      projectName: 'p',
      role: 'brain',
      agentType: 'agy-sdk',
      projectDir: '/p',
      state: 'idle',
      activeModel: 'gemini-5-hydrogen-high',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord;

    const prevImcodesHome = process.env.IMCODES_HOME;
    process.env.IMCODES_HOME = imcodesDir;
    try {
      const result = await probeExecutionPoolSdks({
        callerSessionName: 'deck_brain',
        deps: {
          env: { CODEX_HOME: codexHome, HOME: homeDir, OPENAI_API_KEY: 'sk-openai-secret-999' },
          homeDir,
          listSessions: () => [brainSession],
          getSession: (name) => (name === 'deck_brain' ? brainSession : undefined),
          detectInstalledAgents: async () => ({
            'agy-sdk': { installed: true },
            'codex-sdk': { installed: true },
            'claude-code-sdk': { installed: true },
          } as any),
          detectLocalAuthContext: async (providerId) => ({
            providerId,
            method: 'env-token',
            source: 'env:OPENAI_API_KEY',
            authenticated: providerId === 'codex-sdk',
            reusable: providerId === 'codex-sdk',
            env: providerId === 'codex-sdk' ? { OPENAI_API_KEY: 'sk-openai-secret-999' } : {},
          }),
          getProvider: (id) => id === 'agy-sdk'
            ? {
                id: 'agy-sdk',
                getCachedModels: () => ({
                  isAuthenticated: true,
                  models: [
                    { id: 'gemini-5-hydrogen-high' },
                    { id: 'gemini-3.8-flash-high' },
                    { id: 'nova-x1' },
                  ],
                }),
              }
            : undefined,
          getCodexRuntimeConfig: async () => ({
            availableModels: ['gpt-7.5-sol', 'gpt-7.5-luna'],
            planLabel: 'Pro',
          }),
          fileExists: (p) => files.has(p),
          readFile: (p) => files.get(p) ?? '',
          loadKnowledge: () => loadModelTierKnowledge(knowledgeFile),
        },
      });

      expect(result.currentBrain).toEqual({
        provider: 'agy-sdk',
        providerFamily: 'google',
        model: 'gemini-5-hydrogen-high',
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('sk-openai-secret-999');
      expect(serialized).not.toContain('super-secret-oauth-token');

      const agy = result.sdks.find((s) => s.provider === 'agy-sdk');
      expect(agy).toMatchObject({
        provider: 'agy-sdk',
        providerFamily: 'google',
        loggedIn: true,
        source: 'live_catalog',
        tiers: { secondary: 'gemini-5-hydrogen-high', flagship: 'gemini-5-hydrogen-high', economy: 'gemini-3.8-flash-high' },
        unknownModels: ['nova-x1'],
      });

      const codex = result.sdks.find((s) => s.provider === 'codex-sdk');
      expect(codex).toMatchObject({
        provider: 'codex-sdk',
        providerFamily: 'openai',
        loggedIn: true,
        source: 'live_catalog',
        tiers: { secondary: 'gpt-7.5-sol', flagship: 'gpt-7.5-sol', economy: 'gpt-7.5-luna' },
      });

      const claude = result.sdks.find((s) => s.provider === 'claude-code-sdk');
      expect(claude).toMatchObject({
        provider: 'claude-code-sdk',
        providerFamily: 'anthropic',
        loggedIn: true,
      });
    } finally {
      if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
      else process.env.IMCODES_HOME = prevImcodesHome;
    }
  });

  it('does not infer loggedIn from stopped/requestedModel-only sessions, expired quota caches (>24h), or explicit isAuthenticated=false', async () => {
    const dir = makeTmpDir();
    const homeDir = join(dir, 'home');
    const imcodesDir = join(dir, '.imcodes');
    const now = 2_000_000_000_000;
    const staleAt = now - 25 * 60 * 60 * 1000; // >24h old
    const files = new Map<string, string>([
      [join(imcodesDir, 'agy-usage-quota.json'), JSON.stringify({ at: staleAt, value: { quotaMeta: { groups: [] } } })],
      [join(imcodesDir, 'claude-usage-quota.json'), JSON.stringify({ at: staleAt, value: { quotaMeta: { groups: [] } } })],
    ]);

    const brainSession = {
      name: 'deck_brain',
      projectName: 'p',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/p',
      state: 'running',
      activeModel: 'sonnet',
      sessionInstanceId: 'inst-brain',
      runtimeEpoch: 'epoch-brain',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord;

    const stoppedCodexSession = {
      name: 'deck_sub_stopped_codex',
      projectName: 'p',
      role: 'w1',
      agentType: 'codex-sdk',
      projectDir: '/p',
      state: 'stopped',
      requestedModel: 'gpt-6-sol',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord;

    const prevImcodesHome = process.env.IMCODES_HOME;
    process.env.IMCODES_HOME = imcodesDir;
    try {
      const result = await probeExecutionPoolSdks({
        callerSessionName: 'deck_brain',
        deps: {
          env: { HOME: homeDir },
          homeDir,
          now: () => now,
          listSessions: () => [brainSession, stoppedCodexSession],
          getSession: (name) => (name === 'deck_brain' ? brainSession : stoppedCodexSession),
          detectInstalledAgents: async () => ({
            'claude-code-sdk': { installed: true },
            'codex-sdk': { installed: true },
            'agy-sdk': { installed: true },
            'copilot-sdk': { installed: true },
          } as any),
          detectLocalAuthContext: async (providerId) => ({
            providerId,
            method: 'unsupported',
            source: 'none',
            authenticated: false,
            reusable: false,
            env: {},
          }),
          getProvider: (id) => {
            if (id === 'agy-sdk') {
              return {
                id: 'agy-sdk',
                getCachedModels: () => ({ isAuthenticated: false, models: [{ id: 'gemini-4-hydrogen-high' }] }),
              };
            }
            if (id === 'copilot-sdk') {
              return {
                id: 'copilot-sdk',
                listModels: async () => ({ isAuthenticated: false, models: [{ id: 'gpt-5' }] }),
              };
            }
            return undefined;
          },
          getCodexRuntimeConfig: async () => ({ availableModels: ['gpt-6-sol'] }),
          fileExists: (p) => files.has(p),
          readFile: (p) => files.get(p) ?? '',
          loadKnowledge: () => [],
        },
      });

      expect(result.sdks.find((s) => s.provider === 'claude-code-sdk')?.loggedIn).toBe(true);
      expect(result.sdks.find((s) => s.provider === 'codex-sdk')?.loggedIn).toBe(false);
      expect(result.sdks.find((s) => s.provider === 'agy-sdk')?.loggedIn).toBe(false);
      expect(result.sdks.find((s) => s.provider === 'copilot-sdk')?.loggedIn).toBe(false);
    } finally {
      if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
      else process.env.IMCODES_HOME = prevImcodesHome;
    }
  });

  it('discovers listModels(false) providers (opencode-sdk, copilot-sdk) without cold-spawning agy-sdk, and keeps live_catalog clean of historical session models', async () => {
    const dir = makeTmpDir();
    const codexHome = join(dir, 'codex-home');
    const homeDir = join(dir, 'home');
    const imcodesDir = join(dir, '.imcodes');
    const files = new Map<string, string>([
      [join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ id: 'gpt-7.5' }] })],
    ]);

    const brainSession = {
      name: 'deck_brain',
      projectName: 'p',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/p',
      state: 'running',
      activeModel: 'sonnet',
      sessionInstanceId: 'inst-brain',
      runtimeEpoch: 'epoch-brain',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord;

    const historicalCodexSession = {
      name: 'deck_sub_old_codex',
      projectName: 'p',
      role: 'w1',
      agentType: 'codex-sdk',
      projectDir: '/p',
      state: 'idle',
      activeModel: 'gpt-8-sol',
      sessionInstanceId: 'inst-codex',
      runtimeEpoch: 'epoch-codex',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord;

    const agyListModelsSpy = vi.fn(async () => ({ isAuthenticated: true, models: [{ id: 'should-not-spawn' }] }));
    const prevImcodesHome = process.env.IMCODES_HOME;
    process.env.IMCODES_HOME = imcodesDir;
    try {
      const result = await probeExecutionPoolSdks({
        callerSessionName: 'deck_brain',
        deps: {
          env: { CODEX_HOME: codexHome, HOME: homeDir },
          homeDir,
          listSessions: () => [brainSession, historicalCodexSession],
          getSession: (name) => (name === 'deck_brain' ? brainSession : historicalCodexSession),
          detectInstalledAgents: async () => ({
            'claude-code-sdk': { installed: true },
            'codex-sdk': { installed: true },
            'opencode-sdk': { installed: true },
            'copilot-sdk': { installed: true },
            'agy-sdk': { installed: true },
          } as any),
          detectLocalAuthContext: async () => ({
            providerId: 'codex-sdk', method: 'auth-file', source: 'auth.json', authenticated: true, reusable: true, env: {},
          }),
          getProvider: (id) => {
            if (id === 'opencode-sdk') {
              return {
                id: 'opencode-sdk',
                listModels: async () => ({
                  isAuthenticated: true,
                  models: [{ id: 'openrouter/nova-next-2' }, { id: 'openai/gpt-7.5-mini' }],
                }),
              };
            }
            if (id === 'copilot-sdk') {
              return {
                id: 'copilot-sdk',
                listModels: async () => {
                  throw new Error('copilot listModels must not be called passively');
                },
              };
            }
            if (id === 'agy-sdk') {
              return {
                id: 'agy-sdk',
                getCachedModels: () => null,
                listModels: agyListModelsSpy,
              };
            }
            return undefined;
          },
          getCopilotRuntimeConfig: async (opts) => {
            expect(opts).toEqual({ probe: false });
            return {
              isAuthenticated: true,
              availableModels: ['claude-sonnet-6', 'gpt-5-mini'],
              models: [{ id: 'claude-sonnet-6' }, { id: 'gpt-5-mini' }],
            };
          },
          getCodexRuntimeConfig: async () => ({ availableModels: ['gpt-7.5'], planLabel: 'Pro' }),
          fileExists: (p) => files.has(p),
          readFile: (p) => files.get(p) ?? '',
          loadKnowledge: () => [],
        },
      });

      expect(agyListModelsSpy).not.toHaveBeenCalled();

      const codex = result.sdks.find((s) => s.provider === 'codex-sdk');
      expect(codex?.source).toBe('live_catalog');
      expect(codex?.models).toEqual(['gpt-7.5']);
      expect(codex?.models).not.toContain('gpt-8-sol');

      const opencode = result.sdks.find((s) => s.provider === 'opencode-sdk');
      expect(opencode).toMatchObject({
        provider: 'opencode-sdk',
        loggedIn: true,
        source: 'live_catalog',
        models: ['openrouter/nova-next-2', 'openai/gpt-7.5-mini'],
        unknownModels: ['openrouter/nova-next-2'],
      });

      const copilot = result.sdks.find((s) => s.provider === 'copilot-sdk');
      expect(copilot).toMatchObject({
        provider: 'copilot-sdk',
        loggedIn: true,
        source: 'live_catalog',
        tiers: { secondary: 'claude-sonnet-6', economy: 'gpt-5-mini' },
      });
    } finally {
      if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
      else process.env.IMCODES_HOME = prevImcodesHome;
    }
  });

  it('preserves concurrent writes to model-tier-knowledge.json across two separate OS processes', async () => {
    const dir = makeTmpDir();
    const knowledgeFile = join(dir, 'model-tier-knowledge.json');
    const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/daemon/model-tier-knowledge.ts')).href;
    const tsxLoader = pathToFileURL(resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href;

    const runWorker = (provider: string, model: string, tier: string) => new Promise<void>((resolveWorker, rejectWorker) => {
      const script = [
        `import { upsertModelTierKnowledge } from ${JSON.stringify(moduleUrl)};`,
        `await upsertModelTierKnowledge([{ provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(model)}, tier: ${JSON.stringify(tier)}, source: 'proc_test' }], ${JSON.stringify(knowledgeFile)});`,
      ].join('\n');
      const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', rejectWorker);
      child.on('exit', (code) => {
        if (code === 0) resolveWorker();
        else rejectWorker(new Error(`Worker ${model} exited with ${code}: ${stderr}`));
      });
    });

    await Promise.all([
      runWorker('claude-code-sdk', 'claude-proc-alpha', 'flagship'),
      runWorker('codex-sdk', 'gpt-proc-beta', 'secondary'),
    ]);

    const reloaded = loadModelTierKnowledge(knowledgeFile);
    expect(reloaded.map((r) => r.model).sort()).toEqual(['claude-proc-alpha', 'gpt-proc-beta']);
  });

  it('excludes UNSTARTED native AGY sessions and cold copilot/cursor caches without spawning headless CLIs', async () => {
    const dir = makeTmpDir();
    const homeDir = join(dir, 'home');
    const imcodesDir = join(dir, '.imcodes');
    const brainSession = {
      name: 'deck_brain',
      projectName: 'p',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/p',
      state: 'running',
      activeModel: 'gpt-6-sol',
      codexSessionId: 'codex-thread-1',
      sessionInstanceId: 'inst-brain',
      runtimeEpoch: 'epoch-brain',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord;

    // Exact session-manager.ts:4322-4356 shape for a newly created UNSTARTED AGY session
    const unstartedAgy = {
      name: 'deck_sub_agy_unstarted',
      projectName: 'p',
      role: 'w1',
      agentType: 'agy-sdk',
      providerId: 'agy-sdk',
      runtimeType: 'transport',
      projectDir: '/p',
      state: 'idle',
      requestedModel: 'gemini-4-hydrogen-high',
      activeModel: 'gemini-4-hydrogen-high',
      modelDisplay: 'gemini-4-hydrogen-high',
      agyNativeSessionState: AGY_NATIVE_SESSION_STATE.UNSTARTED,
      sessionInstanceId: 'inst-agy-unstarted',
      runtimeEpoch: 'epoch-agy-unstarted',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as SessionRecord;

    const copilotListSpy = vi.fn(async () => ({ isAuthenticated: true, models: [{ id: 'should-not-spawn-copilot' }] }));
    const cursorListSpy = vi.fn(async () => ({ isAuthenticated: true, models: [{ id: 'should-not-spawn-cursor' }] }));
    const { __copilotRuntimeConfigInternals, getCopilotRuntimeConfig } = await import('../../src/agent/copilot-runtime-config.js');
    const { __cursorRuntimeConfigInternals, getCursorRuntimeConfig } = await import('../../src/agent/cursor-runtime-config.js');
    __copilotRuntimeConfigInternals.clearCache();
    __cursorRuntimeConfigInternals.clearCache();

    const prevImcodesHome = process.env.IMCODES_HOME;
    process.env.IMCODES_HOME = imcodesDir;
    try {
      const coldResult = await probeExecutionPoolSdks({
        callerSessionName: 'deck_brain',
        deps: {
          env: { HOME: homeDir },
          homeDir,
          listSessions: () => [brainSession, unstartedAgy],
          getSession: (name) => (name === 'deck_brain' ? brainSession : unstartedAgy),
          detectInstalledAgents: async () => ({
            'codex-sdk': { installed: true },
            'agy-sdk': { installed: true },
            'copilot-sdk': { installed: true },
            'cursor-headless': { installed: true },
          } as any),
          detectLocalAuthContext: async (providerId) => ({
            providerId,
            method: 'unsupported',
            source: 'none',
            authenticated: providerId === 'codex-sdk',
            reusable: providerId === 'codex-sdk',
            env: {},
          }),
          getProvider: (id) => {
            if (id === 'copilot-sdk') return { id: 'copilot-sdk', listModels: copilotListSpy };
            if (id === 'cursor-headless') return { id: 'cursor-headless', listModels: cursorListSpy };
            return undefined;
          },
          getCodexRuntimeConfig: async () => ({ availableModels: ['gpt-6.2-sol', 'gpt-6-luna'], planLabel: 'Pro' }),
          getCopilotRuntimeConfig,
          getCursorRuntimeConfig,
          fileExists: () => false,
          readFile: () => '',
          loadKnowledge: () => [],
        },
      });

      expect(copilotListSpy).not.toHaveBeenCalled();
      expect(cursorListSpy).not.toHaveBeenCalled();
      expect(coldResult.sdks.find((s) => s.provider === 'codex-sdk')?.loggedIn).toBe(true);
      expect(coldResult.sdks.find((s) => s.provider === 'agy-sdk')?.loggedIn).toBe(false);
      expect(coldResult.sdks.find((s) => s.provider === 'copilot-sdk')?.loggedIn).toBe(false);
      expect(coldResult.sdks.find((s) => s.provider === 'cursor-headless')?.loggedIn).toBe(false);

      // Conversely, an explicitly STARTED native AGY session IS counted as loggedIn
      const startedAgy = { ...unstartedAgy, agyNativeSessionState: AGY_NATIVE_SESSION_STATE.STARTED } as unknown as SessionRecord;
      const startedResult = await probeExecutionPoolSdks({
        callerSessionName: 'deck_brain',
        deps: {
          env: { HOME: homeDir },
          homeDir,
          listSessions: () => [brainSession, startedAgy],
          getSession: (name) => (name === 'deck_brain' ? brainSession : startedAgy),
          detectInstalledAgents: async () => ({ 'codex-sdk': { installed: true }, 'agy-sdk': { installed: true } } as any),
          detectLocalAuthContext: async (providerId) => ({
            providerId, method: 'unsupported', source: 'none', authenticated: providerId === 'codex-sdk', reusable: false, env: {},
          }),
          getCodexRuntimeConfig: async () => ({ availableModels: ['gpt-6.2-sol'], planLabel: 'Pro' }),
          getCopilotRuntimeConfig,
          getCursorRuntimeConfig,
          fileExists: () => false,
          readFile: () => '',
          loadKnowledge: () => [],
        },
      });
      expect(startedResult.sdks.find((s) => s.provider === 'agy-sdk')?.loggedIn).toBe(true);
    } finally {
      if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
      else process.env.IMCODES_HOME = prevImcodesHome;
    }
  });

  it('distinguishes cold unprobed Copilot/Cursor caches from explicit auth refusals and uses local credentials when cold', async () => {
    const dir = makeTmpDir();
    const homeDir = join(dir, 'home');
    const brainSession = {
      name: 'deck_brain',
      projectName: 'p',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/p',
      state: 'running',
      activeModel: 'sonnet',
      ccSessionId: 'cc-sess-1',
      sessionInstanceId: 'inst-brain',
      runtimeEpoch: 'epoch-brain',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    } as SessionRecord;

    const { __copilotRuntimeConfigInternals, COPILOT_FALLBACK_MODEL_IDS, getCopilotRuntimeConfig } = await import('../../src/agent/copilot-runtime-config.js');
    const { __cursorRuntimeConfigInternals, getCursorRuntimeConfig } = await import('../../src/agent/cursor-runtime-config.js');
    __copilotRuntimeConfigInternals.clearCache();
    __cursorRuntimeConfigInternals.clearCache();

    // 1. Cold cache + local GITHUB_TOKEN -> copilot-sdk uses local auth check & surfaces COPILOT_FALLBACK_MODEL_IDS as static_fallback
    const coldWithToken = await probeExecutionPoolSdks({
      callerSessionName: 'deck_brain',
      deps: {
        env: { HOME: homeDir, GITHUB_TOKEN: 'ghp_test_token_123', ANTHROPIC_API_KEY: 'sk-ant-test' },
        homeDir,
        listSessions: () => [brainSession],
        getSession: () => brainSession,
        detectInstalledAgents: async () => ({
          'claude-code-sdk': { installed: true },
          'copilot-sdk': { installed: true },
          'cursor-headless': { installed: true },
        } as any),
        getCopilotRuntimeConfig,
        getCursorRuntimeConfig,
        fileExists: () => false,
        readFile: () => '',
        loadKnowledge: () => [],
      },
    });
    const copilotColdAuth = coldWithToken.sdks.find((s) => s.provider === 'copilot-sdk');
    expect(copilotColdAuth).toMatchObject({
      provider: 'copilot-sdk',
      loggedIn: true,
      source: 'static_fallback',
      models: [...COPILOT_FALLBACK_MODEL_IDS],
    });
    expect(coldWithToken.sdks.find((s) => s.provider === 'cursor-headless')?.loggedIn).toBe(false);

    // 2. Explicit probed auth refusal (isColdFallback absent, isAuthenticated: false) -> stays loggedIn: false even with GITHUB_TOKEN
    const explicitRefusal = await probeExecutionPoolSdks({
      callerSessionName: 'deck_brain',
      deps: {
        env: { HOME: homeDir, GITHUB_TOKEN: 'ghp_test_token_123', ANTHROPIC_API_KEY: 'sk-ant-test' },
        homeDir,
        listSessions: () => [brainSession],
        getSession: () => brainSession,
        detectInstalledAgents: async () => ({
          'claude-code-sdk': { installed: true },
          'copilot-sdk': { installed: true },
          'cursor-headless': { installed: true },
        } as any),
        getCopilotRuntimeConfig: async () => ({
          availableModels: [...COPILOT_FALLBACK_MODEL_IDS],
          models: COPILOT_FALLBACK_MODEL_IDS.map((id) => ({ id })),
          isAuthenticated: false,
        }),
        getCursorRuntimeConfig: async () => ({
          availableModels: [],
          isAuthenticated: false,
        }),
        detectLocalAuthContext: async (providerId) => ({
          providerId,
          method: 'env-token',
          source: 'env:GITHUB_TOKEN',
          authenticated: true,
          reusable: true,
          env: {},
        }),
        fileExists: () => false,
        readFile: () => '',
        loadKnowledge: () => [],
      },
    });
    expect(explicitRefusal.sdks.find((s) => s.provider === 'copilot-sdk')?.loggedIn).toBe(false);
    expect(explicitRefusal.sdks.find((s) => s.provider === 'cursor-headless')?.loggedIn).toBe(false);
  });

  it('serializes across live paused holders and recovers cleanly across interleaved post-crash processes without breaking live locks', async () => {
    const dir = makeTmpDir();
    const knowledgeFile = join(dir, 'model-tier-knowledge.json');
    const lockDbPath = `${knowledgeFile}.lock.db`;
    const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/daemon/model-tier-knowledge.ts')).href;
    const tsxLoader = pathToFileURL(resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href;
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

    // 1. Live holder in another OS process pauses inside BEGIN IMMEDIATE -> waiting writer with short timeout fails boundedly without breaking live lock
    const holderReadyScript = [
      `import { createRequire } from 'node:module';`,
      `const require = createRequire(import.meta.url);`,
      `const { DatabaseSync } = require('node:sqlite');`,
      `const db = new DatabaseSync(${JSON.stringify(lockDbPath)});`,
      `db.exec('BEGIN IMMEDIATE;');`,
      `process.stdout.write('LOCKED\\n');`,
      `await new Promise((r) => setTimeout(r, 350));`,
      `db.exec('COMMIT;');`,
      `db.close();`,
    ].join('\n');
    const holder = spawn(process.execPath, ['--input-type=module', '-e', holderReadyScript], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const holderExitPromise = new Promise<void>((resolveExit, rejectExit) => {
      holder.on('exit', (code) => (code === 0 ? resolveExit() : rejectExit(new Error(`holder exited ${code}`))));
    });
    await new Promise<void>((resolveReady, rejectReady) => {
      holder.stdout.on('data', (chunk) => {
        if (String(chunk).includes('LOCKED')) resolveReady();
      });
      holder.on('error', rejectReady);
    });

    await expect(upsertModelTierKnowledge(
      [{ provider: 'codex-sdk', model: 'gpt-blocked-by-live-holder', tier: 'secondary' }],
      knowledgeFile,
      1_000,
      { lockTimeoutMs: 60 },
    )).rejects.toThrow(/Timed out acquiring model-tier-knowledge lock/);

    // Wait for live holder to finish cleanly
    await holderExitPromise;

    // 2. Simulated crash: holder acquires BEGIN IMMEDIATE and dies with SIGKILL;
    // two concurrent recovery workers C & D interleave immediately — OS kernel releases dead lock,
    // SQLite serializes C & D strictly so neither steals the other's live lock and both records survive.
    const crashHolder = spawn(process.execPath, ['--input-type=module', '-e', [
      `import { createRequire } from 'node:module';`,
      `const require = createRequire(import.meta.url);`,
      `const { DatabaseSync } = require('node:sqlite');`,
      `const db = new DatabaseSync(${JSON.stringify(lockDbPath)});`,
      `db.exec('CREATE TABLE IF NOT EXISTS _k (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE; INSERT INTO _k (id) VALUES (1);');`,
      `process.stdout.write('CRASH_READY\\n');`,
      `setInterval(() => {}, 1000);`,
    ].join('\n')], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolveReady, rejectReady) => {
      crashHolder.stdout.on('data', (chunk) => {
        if (String(chunk).includes('CRASH_READY')) resolveReady();
      });
      crashHolder.on('error', rejectReady);
    });
    crashHolder.kill('SIGKILL');
    await new Promise<void>((resolveExit) => { crashHolder.on('exit', () => resolveExit()); });
    expect(typeof DatabaseSync).toBe('function');

    const runRecoveryWorker = (provider: string, model: string, tier: string) => new Promise<void>((resolveWorker, rejectWorker) => {
      const script = [
        `import { upsertModelTierKnowledge } from ${JSON.stringify(moduleUrl)};`,
        `await upsertModelTierKnowledge([{ provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(model)}, tier: ${JSON.stringify(tier)}, source: 'recovery' }], ${JSON.stringify(knowledgeFile)});`,
      ].join('\n');
      const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += String(c); });
      child.on('error', rejectWorker);
      child.on('exit', (code) => (code === 0 ? resolveWorker() : rejectWorker(new Error(`recovery ${model} failed ${code}: ${stderr}`))));
    });

    await Promise.all([
      runRecoveryWorker('claude-code-sdk', 'claude-recovery-c', 'flagship'),
      runRecoveryWorker('codex-sdk', 'gpt-recovery-d', 'secondary'),
    ]);

    expect(loadModelTierKnowledge(knowledgeFile).map((r) => r.model).sort()).toEqual(['claude-recovery-c', 'gpt-recovery-d']);
  });
});
