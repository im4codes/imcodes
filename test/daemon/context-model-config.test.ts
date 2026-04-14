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
});
