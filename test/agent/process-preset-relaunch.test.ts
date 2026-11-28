import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmuxMocks = vi.hoisted(() => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  sessionExists: vi.fn(async () => false),
  isPaneAlive: vi.fn(async () => true),
  respawnPane: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  sendKeys: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  capturePane: vi.fn(async () => []),
  showBuffer: vi.fn(async () => ''),
  getPaneId: vi.fn(async () => '%1'),
  getPaneCwd: vi.fn(async () => '/tmp'),
  getPaneStartCommand: vi.fn(async () => 'bash'),
  cleanupOrphanFifos: vi.fn(async () => {}),
}));

const storeMocks = vi.hoisted(() => {
  const records = new Map<string, any>();
  return {
    records,
    getSession: vi.fn((name: string) => records.get(name) ?? null),
    upsertSession: vi.fn((rec: any) => { records.set(rec.name, rec); }),
    removeSession: vi.fn((name: string) => { records.delete(name); }),
    listSessions: vi.fn(() => [...records.values()]),
    updateSessionState: vi.fn(),
  };
});

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  ...tmuxMocks,
}));

vi.mock('../../src/store/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/session-store.js')>();
  return {
    ...actual,
    getSession: storeMocks.getSession,
    upsertSession: storeMocks.upsertSession,
    removeSession: storeMocks.removeSession,
    listSessions: storeMocks.listSessions,
    updateSessionState: storeMocks.updateSessionState,
  };
});

vi.mock('../../src/daemon/session-identity-resolver.js', () => ({
  resolveEffectiveIdentityPrompt: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    rebindSession: vi.fn(async () => {}),
    stopSession: vi.fn(),
  },
}));

vi.mock('../../src/daemon/session-resource-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/session-resource-service.js')>();
  return {
    ...actual,
    registerTmuxSessionResource: vi.fn(async (record: any) => {
      storeMocks.upsertSession(record);
    }),
    releaseSessionResources: vi.fn(async () => ({ released: 0, failed: 0 })),
    releaseSessionChildResources: vi.fn(async () => ({ released: 0, failed: 0 })),
  };
});

import { launchSession, relaunchSessionWithSettings } from '../../src/agent/session-manager.js';
import { getSessionContextWindow, invalidateCache, savePresets } from '../../src/daemon/cc-presets.js';

describe('process-mode claude-code & codex preset/model relaunch', () => {
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    storeMocks.records.clear();
    tmuxMocks.sessionExists.mockResolvedValue(false);
    stateDir = mkdtempSync(join(tmpdir(), 'imcodes-proc-preset-'));
    vi.stubEnv('IMCODES_HOME', stateDir);
    invalidateCache();
    await savePresets([
      {
        name: 'PresetA',
        env: {
          ANTHROPIC_BASE_URL: 'https://preset-a.example/anthropic',
          ANTHROPIC_API_KEY: 'sk-preset-a',
          ANTHROPIC_MODEL: 'm1',
        },
        defaultModel: 'm1',
        availableModels: [{ id: 'm1' }, { id: 'm2' }],
        contextWindow: 300_000,
      },
    ]);
  });

  afterEach(() => {
    invalidateCache();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('claude-code process applies preset default m1, updates launch args/env/watcher cache for m2, and clears preset env/cache while keeping ccSessionId', async () => {
    const name = 'deck_proc_cc_brain';
    await launchSession({
      name,
      projectName: 'proccc',
      role: 'brain',
      agentType: 'claude-code',
      projectDir: stateDir,
      fresh: true,
      ccPreset: 'PresetA',
      ccSessionId: 'cc-proc-111',
    });

    expect(tmuxMocks.newSession).toHaveBeenCalledTimes(1);
    const [launchName1, launchCmd1, launchOpts1] = tmuxMocks.newSession.mock.calls[0] as any[];
    expect(launchName1).toBe(name);
    expect(launchCmd1).toContain("--model 'm1'");
    expect(launchOpts1.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://preset-a.example/anthropic',
      ANTHROPIC_MODEL: 'm1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm1',
      IMCODES_CONTEXT_WINDOW: '300000',
    });
    expect(getSessionContextWindow('cc-proc-111')).toBe(300_000);

    // Same-SDK preset + model selection m2
    const rec1 = storeMocks.records.get(name);
    await relaunchSessionWithSettings(rec1, {
      agentType: 'claude-code',
      ccPreset: 'PresetA',
      requestedModel: 'm2',
    });

    expect(tmuxMocks.newSession).toHaveBeenCalledTimes(2);
    const [, launchCmd2, launchOpts2] = tmuxMocks.newSession.mock.calls[1] as any[];
    expect(launchCmd2).toContain("--model 'm2'");
    expect(launchOpts2.env).toMatchObject({
      ANTHROPIC_MODEL: 'm2',
      ANTHROPIC_SMALL_FAST_MODEL: 'm2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm2',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm2',
      IMCODES_CONTEXT_WINDOW: '300000',
    });
    expect(storeMocks.records.get(name)).toMatchObject({
      ccSessionId: 'cc-proc-111',
      ccPreset: 'PresetA',
      requestedModel: 'm2',
    });
    expect(getSessionContextWindow('cc-proc-111')).toBe(300_000);

    // Clear preset back to Default (ccPreset: null, requestedModel: null)
    const rec2 = storeMocks.records.get(name);
    await relaunchSessionWithSettings(rec2, {
      agentType: 'claude-code',
      ccPreset: null,
      requestedModel: null,
    });

    expect(tmuxMocks.newSession).toHaveBeenCalledTimes(3);
    const [, launchCmd3, launchOpts3] = tmuxMocks.newSession.mock.calls[2] as any[];
    expect(launchCmd3).not.toContain('--model');
    expect(launchOpts3.env).not.toHaveProperty('ANTHROPIC_MODEL');
    expect(launchOpts3.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(launchOpts3.env).not.toHaveProperty('IMCODES_CONTEXT_WINDOW');
    expect(storeMocks.records.get(name).ccSessionId).toBe('cc-proc-111');
    expect(storeMocks.records.get(name).ccPreset).toBeUndefined();
    expect(storeMocks.records.get(name).requestedModel).toBeUndefined();
    expect(getSessionContextWindow('cc-proc-111')).toBeUndefined();
  });

  it('codex process passes codexModel -m for m1 default, m2 selection, and drops -m/env/models when clearing preset', async () => {
    const name = 'deck_proc_codex_brain';
    await launchSession({
      name,
      projectName: 'proccodex',
      role: 'brain',
      agentType: 'codex',
      projectDir: stateDir,
      fresh: true,
      ccPreset: 'PresetA',
      codexSessionId: 'codex-proc-111',
    });

    const [, cmd1, opts1] = tmuxMocks.newSession.mock.calls[0] as any[];
    expect(cmd1).toContain("-m 'm1'");
    expect(opts1.env.OPENAI_MODEL).toBe('m1');
    expect(storeMocks.records.get(name).codexAvailableModels).toEqual(['m1', 'm2']);

    await relaunchSessionWithSettings(storeMocks.records.get(name), {
      agentType: 'codex',
      ccPreset: 'PresetA',
      requestedModel: 'm2',
    });

    const [, cmd2, opts2] = tmuxMocks.newSession.mock.calls[1] as any[];
    expect(cmd2).toContain("-m 'm2'");
    expect(opts2.env.OPENAI_MODEL).toBe('m2');
    expect(storeMocks.records.get(name).requestedModel).toBe('m2');

    await relaunchSessionWithSettings(storeMocks.records.get(name), {
      agentType: 'codex',
      ccPreset: null,
      requestedModel: null,
    });

    const [, cmd3, opts3] = tmuxMocks.newSession.mock.calls[2] as any[];
    expect(cmd3).not.toContain(' -m ');
    expect(opts3.env).not.toHaveProperty('OPENAI_MODEL');
    expect(opts3.env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(storeMocks.records.get(name).ccPreset).toBeUndefined();
    const clearedCodexModels = storeMocks.records.get(name).codexAvailableModels;
    if (clearedCodexModels) {
      expect(clearedCodexModels).not.toContain('m1');
      expect(clearedCodexModels).not.toContain('m2');
    }
  });
});
