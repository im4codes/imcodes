import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadModelTierKnowledge,
  upsertModelTierKnowledge,
} from '../../src/daemon/model-tier-knowledge.js';
import { probeExecutionPoolSdks } from '../../src/daemon/sdk-execution-pool-probe.js';
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
    const files = new Map<string, string>([
      [join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ id: 'gpt-7.5-sol' }, { id: 'gpt-7.5-luna' }] })],
      [agyQuotaFile, JSON.stringify({ value: { quotaMeta: { groups: [] } } })],
      [claudeCredsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'super-secret-oauth-token', expiresAt: Date.now() + 60_000 } })],
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
});
