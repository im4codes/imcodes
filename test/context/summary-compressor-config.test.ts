import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProcessingProviderSessionConfig } from '../../src/context/processing-provider-config.js';

const getQwenPresetTransportConfigMock = vi.fn();

vi.mock('../../src/daemon/cc-presets.js', () => ({
  getQwenPresetTransportConfig: (...args: unknown[]) => getQwenPresetTransportConfigMock(...args),
}));

describe('summary-compressor provider session config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses qwen preset transport settings when a qwen processing preset is configured', async () => {
    getQwenPresetTransportConfigMock.mockResolvedValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://example.test',
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_MODEL: 'qwen-preset-model',
      },
      settings: {
        model: { name: 'qwen-preset-model' },
      },
      model: 'qwen-preset-model',
    });

    await expect(resolveProcessingProviderSessionConfig({
      backend: 'qwen',
      model: 'qwen3-coder-plus',
      preset: 'Qwen Team',
    })).resolves.toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: 'https://example.test',
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_MODEL: 'qwen-preset-model',
      },
      settings: {
        model: { name: 'qwen-preset-model' },
      },
      agentId: 'qwen-preset-model',
    });
    expect(getQwenPresetTransportConfigMock).toHaveBeenCalledWith('Qwen Team');
  });

  it('falls back to the configured model when no qwen preset is selected', async () => {
    await expect(resolveProcessingProviderSessionConfig({
      backend: 'qwen',
      model: 'qwen3-coder-plus',
    })).resolves.toEqual({
      cacheKey: JSON.stringify({ backend: 'qwen', model: 'qwen3-coder-plus' }),
      agentId: 'qwen3-coder-plus',
    });
    expect(getQwenPresetTransportConfigMock).not.toHaveBeenCalled();
  });
});
