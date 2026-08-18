import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  home: '',
}));

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('../../src/util/logger.js', () => ({
  default: {
    warn: loggerWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
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
    loggerWarn.mockClear();
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
    vi.unstubAllGlobals();
    vi.resetModules();
    if (state.home) await rm(state.home, { recursive: true, force: true });
    state.home = '';
  });

  it('matches preset names case-insensitively', async () => {
    const { getPreset } = await import('../../src/daemon/cc-presets.js');

    await expect(getPreset('minimax')).resolves.toMatchObject({ name: 'minimax' });
    await expect(getPreset('MiniMax')).resolves.toMatchObject({ name: 'minimax' });
  });

  it('upgrades the legacy MiniMax-M3 200K preset window to 1M', async () => {
    const { savePresets, getPreset, resolvePresetEnv } = await import('../../src/daemon/cc-presets.js');

    await savePresets([{
      name: 'minimax',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_MODEL: 'MiniMax-M3',
      },
      defaultModel: 'MiniMax-M3',
      contextWindow: 200_000,
    }]);

    await expect(getPreset('minimax')).resolves.toMatchObject({
      contextWindow: 1_000_000,
    });
    await expect(resolvePresetEnv('minimax')).resolves.toMatchObject({
      IMCODES_CONTEXT_WINDOW: '1000000',
    });
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

  it('applies a per-session model across the provider model aliases and runtime prompt', async () => {
    const { resolvePresetEnv, getPresetTransportOverrides } = await import('../../src/daemon/cc-presets.js');

    await expect(resolvePresetEnv('MiniMax', undefined, 'MiniMax-M3')).resolves.toMatchObject({
      ANTHROPIC_MODEL: 'MiniMax-M3',
      ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-M3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
    });
    await expect(getPresetTransportOverrides('MiniMax', 'MiniMax-M3')).resolves.toMatchObject({
      model: 'MiniMax-M3',
      systemPrompt: expect.stringContaining('Authoritative runtime model: MiniMax-M3.'),
    });
  });

  it('discovers and persists every page from the Anthropic-compatible models API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'MiniMax-M3', display_name: 'MiniMax M3' },
            { id: 'MiniMax-M2.7' },
          ],
          has_more: true,
          last_id: 'MiniMax-M2.7',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'MiniMax-M2.7' },
            { id: 'MiniMax-M2.7-highspeed' },
          ],
          has_more: false,
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { refreshPresetModels, getPreset } = await import('../../src/daemon/cc-presets.js');

    const catalog = await refreshPresetModels('MiniMax');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(`${firstUrl.origin}${firstUrl.pathname}`).toBe('https://api.minimax.io/anthropic/v1/models');
    expect(firstUrl.searchParams.get('limit')).toBe('1000');
    expect(secondUrl.searchParams.get('after_id')).toBe('MiniMax-M2.7');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: {
        'x-api-key': 'test-token',
        'anthropic-version': '2023-06-01',
      },
    });
    expect(catalog.models).toEqual([
      { id: 'MiniMax-M3', name: 'MiniMax M3' },
      { id: 'MiniMax-M2.7' },
      { id: 'MiniMax-M2.7-highspeed' },
    ]);
    expect(catalog.defaultModel).toBe('MiniMax-M2.7');
    await expect(getPreset('minimax')).resolves.toMatchObject({
      env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
      availableModels: catalog.models,
    });
  });

  it('preserves an authenticated models endpoint error instead of masking it with a fallback 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);
    const { discoverPresetModels, getPreset } = await import('../../src/daemon/cc-presets.js');
    const preset = await getPreset('MiniMax');

    await expect(discoverPresetModels(preset!)).rejects.toThrow('HTTP 401 Unauthorized');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/anthropic/v1/models');
  });

  it('builds qwen transport config for anthropic-compatible presets', async () => {
    const { getQwenPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

    const result = await getQwenPresetTransportConfig('MiniMax');
    expect(result).toMatchObject({
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
              name: 'MiniMax-M2.7',
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
    // Identity-override systemPrompt must pin the authoritative model and
    // explicitly deny the Qwen identity baked into the qwen CLI wrapper.
    expect(result.systemPrompt).toBeDefined();
    expect(result.systemPrompt).toContain('MiniMax-M2.7');
    expect(result.systemPrompt).toContain('https://api.minimax.io/anthropic');
    expect(result.systemPrompt).toMatch(/not running on Qwen/i);
  });

  it('uses discovered compatible-api models when building qwen transport config', async () => {
    const { savePresets, getQwenPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

    await savePresets([
      {
        name: 'minimax',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'test-token',
          ANTHROPIC_MODEL: 'MiniMax-M2.7',
        },
        defaultModel: 'MiniMax-M2.7',
        availableModels: [
          { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
          { id: 'MiniMax-Text-01' },
        ],
      },
    ]);

    const result = await getQwenPresetTransportConfig('minimax');
    expect(result.model).toBe('MiniMax-M2.7');
    expect(result.availableModels).toEqual(['MiniMax-M2.7', 'MiniMax-Text-01']);
    expect(result.settings).toMatchObject({
      model: { name: 'MiniMax-M2.7' },
      modelProviders: {
        anthropic: [
          expect.objectContaining({ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' }),
          expect.objectContaining({ id: 'MiniMax-Text-01', name: 'MiniMax-Text-01' }),
        ],
      },
    });
  });

  it('keeps the preset-pinned model authoritative when discovered models are stale', async () => {
    const { savePresets, getQwenPresetTransportConfig, getPresetAvailableModelIds } = await import('../../src/daemon/cc-presets.js');

    await savePresets([
      {
        name: 'minimax',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'test-token',
          ANTHROPIC_MODEL: 'MiniMax-M2.7',
        },
        defaultModel: 'stale-discovered-default',
        availableModels: [
          { id: 'stale-discovered-default' },
          { id: 'MiniMax-Text-01' },
        ],
      },
    ]);

    const result = await getQwenPresetTransportConfig('MiniMax');
    expect(getPresetAvailableModelIds({
      env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
      defaultModel: 'stale-discovered-default',
      availableModels: [{ id: 'MiniMax-Text-01' }],
    })).toEqual(['MiniMax-M2.7', 'stale-discovered-default', 'MiniMax-Text-01']);
    expect(result.model).toBe('MiniMax-M2.7');
    expect(result.availableModels).toEqual(['MiniMax-M2.7', 'stale-discovered-default', 'MiniMax-Text-01']);
    expect(result.settings).toMatchObject({
      model: { name: 'MiniMax-M2.7' },
      modelProviders: {
        anthropic: [
          expect.objectContaining({ id: 'MiniMax-M2.7' }),
          expect.objectContaining({ id: 'stale-discovered-default' }),
          expect.objectContaining({ id: 'MiniMax-Text-01' }),
        ],
      },
    });
  });

  it('deduplicates preset names case-insensitively and keeps the last saved reference', async () => {
    const { savePresets, loadPresets, getPreset } = await import('../../src/daemon/cc-presets.js');

    await savePresets([
      {
        name: 'minimax',
        env: { ANTHROPIC_BASE_URL: 'https://old.example', ANTHROPIC_MODEL: 'old-model' },
      },
      {
        name: 'MiniMax',
        env: { ANTHROPIC_BASE_URL: 'https://new.example', ANTHROPIC_MODEL: 'new-model' },
      },
    ]);

    expect(await loadPresets()).toHaveLength(1);
    await expect(getPreset('minimax')).resolves.toMatchObject({
      name: 'MiniMax',
      env: { ANTHROPIC_BASE_URL: 'https://new.example', ANTHROPIC_MODEL: 'new-model' },
    });
  });

  describe('undiscovered preset model guard', () => {
    // Anthropic-compatible third-party endpoints accept an unknown model id
    // without an error and silently serve their own default, so a typo like
    // `MiniMax-M.27` (for `MiniMax-M2.7`) otherwise runs invisibly on the
    // wrong model.
    async function writePreset(model: string, availableModels?: { id: string }[]): Promise<void> {
      await writeFile(
        join(state.home, '.imcodes', 'cc-presets.json'),
        JSON.stringify([{
          name: 'mm',
          env: { ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_MODEL: model },
          ...(availableModels ? { availableModels } : {}),
        }]),
        'utf8',
      );
    }

    const undiscoveredWarnings = () => loggerWarn.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('discovered model list'),
    );

    it('warns when the configured model is not among the discovered models', async () => {
      await writePreset('MiniMax-M.27', [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' }]);
      const { getPresetTransportOverrides } = await import('../../src/daemon/cc-presets.js');

      await getPresetTransportOverrides('mm');

      expect(undiscoveredWarnings()).toHaveLength(1);
      expect(undiscoveredWarnings()[0][0]).toMatchObject({
        preset: 'mm',
        configuredModel: 'MiniMax-M.27',
      });
    });

    it('warns only once per preset/model pair', async () => {
      await writePreset('MiniMax-M.27', [{ id: 'MiniMax-M2.7' }]);
      const { getPresetTransportOverrides } = await import('../../src/daemon/cc-presets.js');

      await getPresetTransportOverrides('mm');
      await getPresetTransportOverrides('mm');
      await getPresetTransportOverrides('mm');

      expect(undiscoveredWarnings()).toHaveLength(1);
    });

    it('stays quiet when the configured model is discovered', async () => {
      await writePreset('MiniMax-M2.7', [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' }]);
      const { getPresetTransportOverrides } = await import('../../src/daemon/cc-presets.js');

      await getPresetTransportOverrides('mm');

      expect(undiscoveredWarnings()).toHaveLength(0);
    });

    it('stays quiet when the provider advertised no models (nothing to check against)', async () => {
      await writePreset('some-custom-model');
      const { getPresetTransportOverrides } = await import('../../src/daemon/cc-presets.js');

      await getPresetTransportOverrides('mm');

      expect(undiscoveredWarnings()).toHaveLength(0);
    });
  });

});
