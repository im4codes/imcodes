import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProcessingProviderSessionConfig } from '../../src/context/processing-provider-config.js';

const getCodexPresetTransportConfigMock = vi.fn();
const resolvePresetEnvMock = vi.fn();

vi.mock('../../src/daemon/cc-presets.js', () => ({
  getCodexPresetTransportConfig: (...args: unknown[]) => getCodexPresetTransportConfigMock(...args),
  resolvePresetEnv: (...args: unknown[]) => resolvePresetEnvMock(...args),
}));

describe('summary-compressor provider session config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses codex-sdk preset transport settings when a codex-sdk processing preset is configured', async () => {
    getCodexPresetTransportConfigMock.mockResolvedValue({
      env: {
        OPENAI_BASE_URL: 'https://example.test/v1',
        OPENAI_API_KEY: 'secret',
      },
      model: 'codex-preset-model',
    });

    await expect(resolveProcessingProviderSessionConfig({
      backend: 'codex-sdk',
      model: 'gpt-6-luna',
      preset: 'Codex Team',
    })).resolves.toMatchObject({
      env: {
        OPENAI_BASE_URL: 'https://example.test/v1',
        OPENAI_API_KEY: 'secret',
      },
      agentId: 'codex-preset-model',
    });
    expect(getCodexPresetTransportConfigMock).toHaveBeenCalledWith('Codex Team', 'gpt-6-luna');
  });

  it('falls back to the configured model when no agy-sdk or opencode-sdk preset is selected', async () => {
    await expect(resolveProcessingProviderSessionConfig({
      backend: 'agy-sdk',
      model: 'gemini-3.8-flash-low',
    })).resolves.toEqual({
      cacheKey: JSON.stringify({ backend: 'agy-sdk', model: 'gemini-3.8-flash-low' }),
      agentId: 'gemini-3.8-flash-low',
    });
    await expect(resolveProcessingProviderSessionConfig({
      backend: 'opencode-sdk',
      model: 'opencode/big-pickle',
    })).resolves.toEqual({
      cacheKey: JSON.stringify({ backend: 'opencode-sdk', model: 'opencode/big-pickle' }),
      agentId: 'opencode/big-pickle',
    });
    expect(getCodexPresetTransportConfigMock).not.toHaveBeenCalled();
  });

  it('applies claude-code-sdk preset env (third-party endpoint) when a preset is configured', async () => {
    resolvePresetEnvMock.mockResolvedValue({
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_MODEL: 'MiniMax-M3',
    });

    await expect(resolveProcessingProviderSessionConfig({
      backend: 'claude-code-sdk',
      model: 'haiku',
      preset: 'minimax',
    })).resolves.toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_MODEL: 'MiniMax-M3',
      },
      agentId: 'MiniMax-M3',
    });
    expect(resolvePresetEnvMock).toHaveBeenCalledWith('minimax', undefined, 'haiku');
    expect(getCodexPresetTransportConfigMock).not.toHaveBeenCalled();
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

  it('keeps openclaw agentId unset while passing non-default manual models via sessionModel', async () => {
    await expect(resolveProcessingProviderSessionConfig({
      backend: 'openclaw',
      model: 'default',
    })).resolves.toEqual({
      cacheKey: JSON.stringify({ backend: 'openclaw', model: 'default' }),
    });
    await expect(resolveProcessingProviderSessionConfig({
      backend: 'openclaw',
      model: 'anthropic/claude-opus-4-6',
    })).resolves.toEqual({
      cacheKey: JSON.stringify({ backend: 'openclaw', model: 'anthropic/claude-opus-4-6' }),
      sessionModel: 'anthropic/claude-opus-4-6',
    });
  });
});
