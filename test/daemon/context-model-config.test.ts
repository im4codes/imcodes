import { afterEach, describe, expect, it, vi } from 'vitest';
import { getContextModelConfig, setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';

describe('context-model-config', () => {
  afterEach(() => {
    setContextModelRuntimeConfig(null);
    vi.unstubAllEnvs();
  });

  it('preserves explicit manual codex-sdk models while coercing deprecated spark and auto mode to gpt-6-luna', () => {
    setContextModelRuntimeConfig({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-5.6',
    });
    expect(getContextModelConfig()).toEqual({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      primaryContextPreset: undefined,
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-5.6',
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
      enablePersonalMemorySync: true,
    });

    setContextModelRuntimeConfig({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.3-codex-spark',
      backupContextBackend: 'claude-code-sdk',
      backupContextModel: 'haiku',
    });
    expect(getContextModelConfig().primaryContextModel).toBe('gpt-6-luna');

    setContextModelRuntimeConfig({
      modelSelectionMode: 'auto',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-5.6',
    });
    expect(getContextModelConfig().primaryContextModel).toBe('gpt-6-luna');
    expect(getContextModelConfig().backupContextModel).toBe('gpt-6-luna');
  });

  it('does not let env vars override the synced runtime config', () => {
    vi.stubEnv('IMCODES_PRIMARY_CONTEXT_MODEL', 'env-model');
    setContextModelRuntimeConfig({
      primaryContextBackend: 'agy-sdk',
      primaryContextModel: 'gemini-3.8-flash-low',
    });
    expect(getContextModelConfig().primaryContextModel).toBe('gemini-3.8-flash-low');
    expect(getContextModelConfig().primaryContextBackend).toBe('agy-sdk');
  });

  it('fills the backup model from the selected backup backend when runtime config omits it', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'agy-sdk',
    });
    expect(getContextModelConfig()).toEqual({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextPreset: undefined,
      backupContextBackend: 'agy-sdk',
      backupContextModel: 'gemini-3.8-flash-low',
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
      enablePersonalMemorySync: true,
    });
  });

  it('preserves explicit manual modelSelectionMode', () => {
    setContextModelRuntimeConfig({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'opus[1M]',
    });
    expect(getContextModelConfig().modelSelectionMode).toBe('manual');
    expect(getContextModelConfig().primaryContextModel).toBe('opus[1M]');
  });

  it('keeps the synced personal memory cloud-sync flag', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      enablePersonalMemorySync: true,
    });
    expect(getContextModelConfig().enablePersonalMemorySync).toBe(true);
  });

  it('keeps the synced memory recall threshold', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      memoryRecallMinScore: 0.33,
    });
    expect(getContextModelConfig().memoryRecallMinScore).toBe(0.33);
  });

  it('keeps the synced advanced memory scoring weights', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      memoryScoringWeights: {
        similarity: 0.5,
        recency: 0.2,
        frequency: 0.1,
        project: 0.2,
      },
    });
    expect(getContextModelConfig().memoryScoringWeights).toEqual({
      similarity: 0.5,
      recency: 0.2,
      frequency: 0.1,
      project: 0.2,
    });
  });

  it('keeps synced presets for primary and backup processing paths', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'haiku',
      primaryContextPreset: 'Claude Team',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'MiniMax-M2.7',
      backupContextPreset: 'Codex Backup',
    });
    expect(getContextModelConfig().primaryContextPreset).toBe('Claude Team');
    expect(getContextModelConfig().backupContextPreset).toBe('Codex Backup');
    expect(getContextModelConfig().backupContextModel).toBe('MiniMax-M2.7');
  });
});
