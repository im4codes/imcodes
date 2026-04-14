import { afterEach, describe, expect, it, vi } from 'vitest';
import { getContextModelConfig, setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';

describe('context-model-config', () => {
  afterEach(() => {
    setContextModelRuntimeConfig(null);
    vi.unstubAllEnvs();
  });

  it('uses runtime config overrides ahead of defaults', () => {
    setContextModelRuntimeConfig({
      primaryContextModel: 'gpt-5.4',
      backupContextModel: 'haiku',
    });
    expect(getContextModelConfig()).toEqual({
      primaryContextModel: 'gpt-5.4',
      backupContextModel: 'haiku',
    });
  });

  it('does not let env vars override the synced runtime config', () => {
    vi.stubEnv('IMCODES_PRIMARY_CONTEXT_MODEL', 'env-model');
    setContextModelRuntimeConfig({
      primaryContextModel: 'synced-model',
    });
    expect(getContextModelConfig().primaryContextModel).toBe('synced-model');
  });
});
