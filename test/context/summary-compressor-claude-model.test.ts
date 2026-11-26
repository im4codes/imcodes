import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompressionInput } from '../../src/context/summary-compressor.js';

const queryMock = vi.hoisted(() => vi.fn());
const resolvePresetEnvMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('../../src/daemon/cc-presets.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/daemon/cc-presets.js')>('../../src/daemon/cc-presets.js');
  return {
    ...actual,
    resolvePresetEnv: (...args: unknown[]) => resolvePresetEnvMock(...args),
  };
});

function makeClaudeInput(model: string, preset?: string): CompressionInput {
  return {
    events: [
      { type: 'assistant.text', content: 'summarize this turn', createdAt: Date.now() } as unknown as CompressionInput['events'][number],
    ],
    modelConfig: {
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: model,
      ...(preset ? { primaryContextPreset: preset } : {}),
    },
  };
}

describe('summary-compressor — claude-code-sdk model forwarding without preset', () => {
  beforeEach(async () => {
    queryMock.mockReset();
    resolvePresetEnvMock.mockReset();
    queryMock.mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '## Problem\nTest summary' }],
        },
      };
    });
    const { resetFailureTracking, resetActiveCompressionRunsForTests, resumeAcceptingCompression } = await import('../../src/context/summary-compressor.js');
    resetFailureTracking();
    resetActiveCompressionRunsForTests();
    resumeAcceptingCompression();
  });

  afterEach(async () => {
    const { resetFailureTracking, resetActiveCompressionRunsForTests } = await import('../../src/context/summary-compressor.js');
    resetFailureTracking();
    resetActiveCompressionRunsForTests();
  });

  it('forwards auto-adapted haiku model into Claude SDK query options when no preset is configured', async () => {
    const { compressWithSdk } = await import('../../src/context/summary-compressor.js');
    const res = await compressWithSdk(makeClaudeInput('haiku'));
    expect(res.fromSdk).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const callArg = queryMock.mock.calls[0]?.[0] as { options?: { model?: string; env?: unknown } };
    expect(callArg.options?.model).toBe('haiku');
    expect(callArg.options?.env).toBeUndefined();
  });

  it('forwards manual Claude model id cleanly into Claude SDK query options without preset', async () => {
    const { compressWithSdk } = await import('../../src/context/summary-compressor.js');
    const res = await compressWithSdk(makeClaudeInput('opus[1M]'));
    expect(res.fromSdk).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const callArg = queryMock.mock.calls[0]?.[0] as { options?: { model?: string } };
    expect(callArg.options?.model).toBe('opus[1M]');
  });

  it('forwards selected model override into resolvePresetEnv and SDK query options when a Claude preset is configured, falling back to preset default only when model is empty', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const actualPresets = await vi.importActual<typeof import('../../src/daemon/cc-presets.js')>('../../src/daemon/cc-presets.js');

    const prevImcodesHome = process.env.IMCODES_HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'imcodes-cc-preset-model-'));
    process.env.IMCODES_HOME = tempHome;
    try {
      await actualPresets.savePresets([{
        name: 'minimax-team',
        defaultModel: 'MiniMax-M2.7',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.minimax.example/anthropic',
          ANTHROPIC_API_KEY: 'sk-preset-secret',
          ANTHROPIC_MODEL: 'MiniMax-M2.7',
          ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-M2.7',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.7',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.7',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.7',
        },
      }]);
      resolvePresetEnvMock.mockImplementation((...args: Parameters<typeof actualPresets.resolvePresetEnv>) => (
        actualPresets.resolvePresetEnv(...args)
      ));

      const { compressWithSdk } = await import('../../src/context/summary-compressor.js');

      await compressWithSdk(makeClaudeInput('MiniMax-M2.5', 'minimax-team'));
      expect(resolvePresetEnvMock).toHaveBeenNthCalledWith(1, 'minimax-team', undefined, 'MiniMax-M2.5');
      const firstCall = queryMock.mock.calls[0]?.[0] as { options?: { model?: string; env?: Record<string, string> } };
      expect(firstCall.options?.model).toBe('MiniMax-M2.5');
      expect(firstCall.options?.env?.ANTHROPIC_BASE_URL).toBe('https://api.minimax.example/anthropic');
      expect(firstCall.options?.env?.ANTHROPIC_API_KEY).toBe('sk-preset-secret');
      expect(firstCall.options?.env?.ANTHROPIC_MODEL).toBe('MiniMax-M2.5');
      expect(firstCall.options?.env?.ANTHROPIC_SMALL_FAST_MODEL).toBe('MiniMax-M2.5');
      expect(firstCall.options?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.5');
      expect(firstCall.options?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.5');
      expect(firstCall.options?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.5');

      await compressWithSdk(makeClaudeInput('', 'minimax-team'));
      expect(resolvePresetEnvMock).toHaveBeenNthCalledWith(2, 'minimax-team', undefined, undefined);
      const secondCall = queryMock.mock.calls[1]?.[0] as { options?: { model?: string; env?: Record<string, string> } };
      expect(secondCall.options?.model).toBe('MiniMax-M2.7');
      expect(secondCall.options?.env?.ANTHROPIC_MODEL).toBe('MiniMax-M2.7');
    } finally {
      if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
      else process.env.IMCODES_HOME = prevImcodesHome;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });
});
