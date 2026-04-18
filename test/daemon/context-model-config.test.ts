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
      backupContextBackend: 'claude-code-sdk',
      backupContextModel: 'haiku',
      memoryRecallMinScore: 0.4,
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
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen3-coder-plus',
      memoryRecallMinScore: 0.4,
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
});
