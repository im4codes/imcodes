import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  home: '',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => state.home,
  };
});

describe('cc presets', () => {
  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'imcodes-cc-presets-'));
    await mkdir(join(state.home, '.imcodes'), { recursive: true });
    await writeFile(
      join(state.home, '.imcodes', 'cc-presets.json'),
      JSON.stringify([
        {
          name: 'minimax',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
            ANTHROPIC_AUTH_TOKEN: 'test-token',
            ANTHROPIC_MODEL: 'MiniMax-M2.7',
          },
          contextWindow: 200000,
        },
      ]),
      'utf8',
    );
  });

  afterEach(async () => {
    vi.resetModules();
    if (state.home) await rm(state.home, { recursive: true, force: true });
    state.home = '';
  });

  it('matches preset names case-insensitively', async () => {
    const { getPreset } = await import('../../src/daemon/cc-presets.js');

    await expect(getPreset('minimax')).resolves.toMatchObject({ name: 'minimax' });
    await expect(getPreset('MiniMax')).resolves.toMatchObject({ name: 'minimax' });
  });

  it('resolves env and context hints for mixed-case preset names', async () => {
    const { resolvePresetEnv } = await import('../../src/daemon/cc-presets.js');

    await expect(resolvePresetEnv('MiniMax')).resolves.toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      ANTHROPIC_API_KEY: 'test-token',
      ANTHROPIC_MODEL: 'MiniMax-M2.7',
      ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-M2.7',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.7',
      IMCODES_CONTEXT_WINDOW: '200000',
    });
  });

  it('builds qwen transport config for anthropic-compatible presets', async () => {
    const { getQwenPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

    await expect(getQwenPresetTransportConfig('MiniMax')).resolves.toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: 'test-token',
        ANTHROPIC_MODEL: 'MiniMax-M2.7',
        // qwen CLI reads OPENAI_BASE_URL / OPENAI_API_KEY for --auth-type anthropic
        OPENAI_BASE_URL: 'https://api.minimax.io/anthropic',
        OPENAI_API_KEY: 'test-token',
      },
      model: 'MiniMax-M2.7',
      settings: {
        security: { auth: { selectedType: 'anthropic' } },
        model: { name: 'MiniMax-M2.7' },
        modelProviders: {
          anthropic: [
            {
              id: 'MiniMax-M2.7',
              name: 'minimax',
              envKey: 'ANTHROPIC_API_KEY',
              baseUrl: 'https://api.minimax.io/anthropic',
              generationConfig: {
                contextWindowSize: 200000,
              },
            },
          ],
        },
      },
    });
  });
});
