import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProcessingProviderSessionConfig } from '../../src/context/processing-provider-config.js';

const getQwenPresetTransportConfigMock = vi.fn();
const resolvePresetEnvMock = vi.fn();

vi.mock('../../src/daemon/cc-presets.js', () => ({
  getQwenPresetTransportConfig: (...args: unknown[]) => getQwenPresetTransportConfigMock(...args),
  resolvePresetEnv: (...args: unknown[]) => resolvePresetEnvMock(...args),
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

  it('applies claude-code-sdk preset env (third-party endpoint) when a preset is configured', async () => {
    resolvePresetEnvMock.mockResolvedValue({
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_MODEL: 'MiniMax-M3',
    });

    await expect(resolveProcessingProviderSessionConfig({
      backend: 'claude-code-sdk',
      model: 'sonnet',
      preset: 'minimax',
    })).resolves.toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_MODEL: 'MiniMax-M3',
      },
      agentId: 'MiniMax-M3',
    });
    expect(resolvePresetEnvMock).toHaveBeenCalledWith('minimax');
    expect(getQwenPresetTransportConfigMock).not.toHaveBeenCalled();
  });

  it('falls back to the configured model when no claude-code-sdk preset is selected', async () => {
    await expect(resolveProcessingProviderSessionConfig({
      backend: 'claude-code-sdk',
      model: 'sonnet',
    })).resolves.toEqual({
      cacheKey: JSON.stringify({ backend: 'claude-code-sdk', model: 'sonnet' }),
      agentId: 'sonnet',
    });
    expect(resolvePresetEnvMock).not.toHaveBeenCalled();
  });
});
