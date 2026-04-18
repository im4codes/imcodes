import { afterEach, describe, expect, it, vi } from 'vitest';
import { getContextModelConfig, setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';

describe('context-model-config', () => {
  afterEach(() => {
    setContextModelRuntimeConfig(null);
    vi.unstubAllEnvs();
  });

  it('uses runtime config overrides ahead of defaults', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      backupContextBackend: 'claude-code-sdk',
      backupContextModel: 'haiku',
    });
    expect(getContextModelConfig()).toEqual({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      primaryContextPreset: undefined,
      backupContextBackend: 'claude-code-sdk',
      backupContextModel: 'haiku',
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
      enablePersonalMemorySync: false,
    });
  });

  it('does not let env vars override the synced runtime config', () => {
    vi.stubEnv('IMCODES_PRIMARY_CONTEXT_MODEL', 'env-model');
    setContextModelRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4-mini',
    });
    expect(getContextModelConfig().primaryContextModel).toBe('gpt-5.4-mini');
    expect(getContextModelConfig().primaryContextBackend).toBe('codex-sdk');
  });

  it('fills the backup model from the selected backup backend when runtime config omits it', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'qwen',
    });
    expect(getContextModelConfig()).toEqual({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextPreset: undefined,
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      backupContextPreset: undefined,
      memoryRecallMinScore: 0.4,
      memoryScoringWeights: {
        similarity: 0.4,
        recency: 0.25,
        frequency: 0.15,
        project: 0.2,
      },
      enablePersonalMemorySync: false,
    });
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

  it('keeps the synced qwen presets for primary and backup processing paths', () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen3-coder-plus',
      primaryContextPreset: 'Qwen Team',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      backupContextPreset: 'Qwen Backup',
    });
    expect(getContextModelConfig().primaryContextPreset).toBe('Qwen Team');
    expect(getContextModelConfig().backupContextPreset).toBe('Qwen Backup');
  });
});
