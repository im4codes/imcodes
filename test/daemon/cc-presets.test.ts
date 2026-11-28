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
    vi.stubEnv('HOME', state.home);
    vi.stubEnv('USERPROFILE', state.home);
    vi.stubEnv('IMCODES_HOME', join(state.home, '.imcodes'));
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
    vi.unstubAllEnvs();
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
    const overrides = await getPresetTransportOverrides('MiniMax', 'MiniMax-M3');
    expect(overrides).toMatchObject({
      model: 'MiniMax-M3',
      systemPrompt: expect.stringContaining('Authoritative runtime model: MiniMax-M3.'),
    });
    expect(overrides.systemPrompt).toContain('They never override Claude Code tool definitions, input schemas, required parameters, enums, or defaults.');
    expect(overrides.systemPrompt).toContain('Follow every provided tool input schema exactly and never omit required fields.');
    expect(overrides.systemPrompt).not.toContain('override any generic Claude Code tool schema');
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

  it('routes a deliberately selected model from the preset catalog', async () => {
    const { getQwenPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

    const result = await getQwenPresetTransportConfig('MiniMax', 'MiniMax-M2.5');

    expect(result.model).toBe('MiniMax-M2.5');
    expect(result.env).toMatchObject({ ANTHROPIC_MODEL: 'MiniMax-M2.5' });
    expect(result.settings).toMatchObject({ model: { name: 'MiniMax-M2.5' } });
    expect(result.systemPrompt).toContain('MiniMax-M2.5');
  });

  it('builds a dsh route config without placing the preset key in generic env', async () => {
    const { getDshPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

    const result = await getDshPresetTransportConfig('MiniMax');
    expect(result).toMatchObject({
      env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
      model: 'MiniMax-M2.7',
      contextWindow: 200_000,
      llm: {
        provider: 'minimax',
        model: 'MiniMax-M2.7',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: 'test-token',
        contextWindow: 200_000,
      },
    });
    expect(result.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('builds a Pi provider route without exposing the preset key in argv or generic env', async () => {
    const { getPiPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

    const result = await getPiPresetTransportConfig('MiniMax');
    expect(result).toMatchObject({
      env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
      model: 'MiniMax-M2.7',
      contextWindow: 200_000,
      piLlm: {
        provider: 'minimax',
        model: 'MiniMax-M2.7',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: 'test-token',
        contextWindow: 200_000,
      },
    });
    expect(result.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('builds Kimi preset transport config for Anthropic and OpenAI presets without leaking secrets in env', async () => {
    const { savePresets, getKimiPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

    const anthropicRes = await getKimiPresetTransportConfig('MiniMax', 'MiniMax-M2.7');
    expect(anthropicRes).toMatchObject({
      env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
      model: 'MiniMax-M2.7',
      contextWindow: 200_000,
      kimiLlm: {
        provider: 'minimax',
        providerType: 'anthropic',
        model: 'MiniMax-M2.7',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: 'test-token',
        contextWindow: 200_000,
      },
    });
    expect(anthropicRes?.kimiLlm.models).toEqual([
      expect.objectContaining({ id: 'MiniMax-M2.7', contextWindow: 200_000 }),
    ]);
    expect(anthropicRes?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(anthropicRes?.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(anthropicRes?.env).not.toHaveProperty('KIMI_API_KEY');

    await savePresets([
      {
        name: 'GLM-OpenAI',
        env: {
          OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
          OPENAI_API_KEY: 'oa-secret-123',
          OPENAI_MODEL: 'glm-5.3',
        },
        authType: 'openai',
        defaultModel: 'glm-5.3',
        contextWindow: 1_000_000,
        availableModels: [
          { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash' },
          { id: 'glm-5.3', label: 'GLM-5.3' },
        ],
      },
    ]);

    const openaiRes = await getKimiPresetTransportConfig('GLM-OpenAI', 'glm-5.3-flash');
    expect(openaiRes).toMatchObject({
      model: 'glm-5.3-flash',
      contextWindow: 1_000_000,
      kimiLlm: {
        provider: 'glm-openai',
        providerType: 'openai_legacy',
        model: 'glm-5.3-flash',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'oa-secret-123',
        contextWindow: 1_000_000,
      },
    });
    expect(openaiRes?.kimiLlm.models.map((m) => m.id)).toEqual(['glm-5.3-flash', 'glm-5.3']);
    expect(openaiRes?.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(openaiRes?.env).not.toHaveProperty('KIMI_API_KEY');

    // Legacy OPENAI_BASE_URL-only preset without authType MUST resolve to openai_legacy (not anthropic)
    await savePresets([
      {
        name: 'LegacyOpenAIOnly',
        env: {
          OPENAI_BASE_URL: 'https://legacy-openai.invalid/v1',
          OPENAI_API_KEY: 'oa-legacy-key',
          OPENAI_MODEL: 'legacy-oai-model',
        },
        defaultModel: 'legacy-oai-model',
      },
      {
        name: 'AnthropicOnly',
        env: {
          ANTHROPIC_BASE_URL: 'https://anthropic-only.invalid/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'anth-only-key',
          ANTHROPIC_MODEL: 'anth-model',
        },
        defaultModel: 'anth-model',
      },
    ]);

    const legacyOpenAiRes = await getKimiPresetTransportConfig('LegacyOpenAIOnly');
    expect(legacyOpenAiRes?.kimiLlm).toMatchObject({
      providerType: 'openai_legacy',
      baseUrl: 'https://legacy-openai.invalid/v1',
      apiKey: 'oa-legacy-key',
      model: 'legacy-oai-model',
    });

    const anthOnlyRes = await getKimiPresetTransportConfig('AnthropicOnly');
    expect(anthOnlyRes?.kimiLlm).toMatchObject({
      providerType: 'anthropic',
      baseUrl: 'https://anthropic-only.invalid/anthropic',
      apiKey: 'anth-only-key',
      model: 'anth-model',
    });
  });

  it('clamps a previous provider model to the newly selected preset catalogue', async () => {
    const { selectPresetModel } = await import('../../src/daemon/cc-presets.js');
    const nextPreset = {
      env: { ANTHROPIC_MODEL: 'next-default' },
      defaultModel: 'next-default',
      availableModels: [{ id: 'shared-model' }, { id: 'next-default' }],
    };

    expect(selectPresetModel(nextPreset, 'old-provider-only')).toBe('next-default');
    // A deliberately selected overlapping id is valid inside this preset; the
    // web route-identity hook is responsible for resetting it at switch time.
    expect(selectPresetModel(nextPreset, 'shared-model')).toBe('shared-model');
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

  describe('OpenAI-compatible presets and Codex transport config', () => {
    it('builds codex transport config for anthropic preset (cross-protocol alignment)', async () => {
      const { getCodexPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

      const result = await getCodexPresetTransportConfig('MiniMax');
      expect(result).toMatchObject({
        model: 'MiniMax-M2.7',
        contextWindow: 200_000,
        env: expect.objectContaining({
          OPENAI_BASE_URL: 'https://api.minimax.io/v1',
          OPENAI_API_KEY: 'test-token',
          OPENAI_MODEL: 'MiniMax-M2.7',
          CODEX_BASE_URL: 'https://api.minimax.io/v1',
          CODEX_API_KEY: 'test-token',
          CODEX_MODEL: 'MiniMax-M2.7',
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_API_KEY: 'test-token',
          ANTHROPIC_MODEL: 'MiniMax-M2.7',
        }),
        codexModelProvider: {
          providerId: 'minimax',
          baseUrl: 'https://api.minimax.io/v1',
          apiKey: 'test-token',
          wireApi: 'responses',
        },
      });
      expect(result.systemPrompt).toContain('MiniMax');
      expect(result.systemPrompt).toContain('Authoritative runtime model: MiniMax-M2.7');
    });

    it('builds codex transport config for native openai preset', async () => {
      const { savePresets, getCodexPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

      await savePresets([
        {
          name: 'minimax-openai',
          authType: 'openai',
          env: {
            OPENAI_BASE_URL: 'https://api.minimax.chat/v1',
            OPENAI_API_KEY: 'openai-test-key',
            OPENAI_MODEL: 'MiniMax-Text-01',
          },
          contextWindow: 128_000,
          defaultModel: 'MiniMax-Text-01',
        },
      ]);

      const result = await getCodexPresetTransportConfig('minimax-openai');
      expect(result).toMatchObject({
        model: 'MiniMax-Text-01',
        contextWindow: 128_000,
        env: expect.objectContaining({
          OPENAI_BASE_URL: 'https://api.minimax.chat/v1',
          OPENAI_API_KEY: 'openai-test-key',
          OPENAI_MODEL: 'MiniMax-Text-01',
          CODEX_BASE_URL: 'https://api.minimax.chat/v1',
          CODEX_API_KEY: 'openai-test-key',
          CODEX_MODEL: 'MiniMax-Text-01',
        }),
        codexModelProvider: {
          providerId: 'minimax-openai',
          baseUrl: 'https://api.minimax.chat/v1',
          apiKey: 'openai-test-key',
          wireApi: 'responses',
        },
      });
      expect(result.systemPrompt).toContain('MiniMax');
    });

    it('discovers models from OpenAI-compatible endpoint with Bearer auth', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'MiniMax-Text-01', name: 'MiniMax Text 01' },
            { id: 'MiniMax-VL-01' },
          ],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { savePresets, refreshPresetModels, getPreset } = await import('../../src/daemon/cc-presets.js');

      await savePresets([
        {
          name: 'custom-openai',
          authType: 'openai',
          env: {
            OPENAI_BASE_URL: 'https://api.example.com/v1',
            OPENAI_API_KEY: 'sk-bearer-token',
            OPENAI_MODEL: 'MiniMax-Text-01',
          },
          defaultModel: 'MiniMax-Text-01',
        },
      ]);

      const catalog = await refreshPresetModels('custom-openai');

      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0];
      const url = String(call[0]);
      expect(url).toBe('https://api.example.com/v1/models');
      expect(call[1]).toMatchObject({
        headers: {
          Authorization: 'Bearer sk-bearer-token',
        },
      });
      expect(catalog.models).toEqual([
        { id: 'MiniMax-Text-01', name: 'MiniMax Text 01' },
        { id: 'MiniMax-VL-01' },
      ]);
      expect(catalog.defaultModel).toBe('MiniMax-Text-01');

      const saved = await getPreset('custom-openai');
      expect(saved?.authType).toBe('openai');
      expect(saved?.availableModels).toHaveLength(2);
    });

    it('handles 401 error from OpenAI-compatible model discovery without swallowing error', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });
      vi.stubGlobal('fetch', fetchMock);

      const { savePresets, discoverPresetModels, getPreset } = await import('../../src/daemon/cc-presets.js');

      await savePresets([
        {
          name: 'unauth-openai',
          authType: 'openai',
          env: {
            OPENAI_BASE_URL: 'https://api.example.com/v1',
            OPENAI_API_KEY: 'invalid-key',
          },
        },
      ]);

      const preset = await getPreset('unauth-openai');
      await expect(discoverPresetModels(preset!)).rejects.toThrow('HTTP 401 Unauthorized');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        headers: { Authorization: 'Bearer invalid-key' },
      });
    });
  });

  it('passes availableModels and openai authType to both DSH and Pi preset transport configs without leaking keys in env', async () => {
    const { savePresets, getDshPresetTransportConfig, getPiPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');
    await savePresets([
      {
        name: 'openai-compat',
        authType: 'openai',
        env: {
          OPENAI_BASE_URL: 'https://open.example.com/v1',
          OPENAI_API_KEY: 'sk-openai-only-secret',
          OPENAI_MODEL: 'model-a',
        },
        availableModels: [{ id: 'model-a' }, { id: 'model-b' }],
        contextWindow: 128_000,
      },
    ]);

    const dsh = await getDshPresetTransportConfig('openai-compat', 'model-b');
    expect(dsh).toMatchObject({
      env: { ANTHROPIC_MODEL: 'model-b', OPENAI_MODEL: 'model-b' },
      model: 'model-b',
      availableModels: ['model-a', 'model-b'],
      llm: {
        provider: 'openai-compat',
        model: 'model-b',
        authType: 'openai',
        availableModels: ['model-a', 'model-b'],
        baseUrl: 'https://open.example.com/v1',
        apiKey: 'sk-openai-only-secret',
        contextWindow: 128_000,
      },
    });
    expect(dsh.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(dsh.env).not.toHaveProperty('ANTHROPIC_API_KEY');

    const pi = await getPiPresetTransportConfig('openai-compat', 'model-b');
    expect(pi).toMatchObject({
      env: { ANTHROPIC_MODEL: 'model-b', OPENAI_MODEL: 'model-b' },
      model: 'model-b',
      availableModels: ['model-a', 'model-b'],
      piLlm: {
        provider: 'openai-compat',
        model: 'model-b',
        authType: 'openai',
        availableModels: ['model-a', 'model-b'],
        baseUrl: 'https://open.example.com/v1',
        apiKey: 'sk-openai-only-secret',
        contextWindow: 128_000,
      },
    });
    expect(pi.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(pi.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('omits retired DuckDuckGo default initMessage, strips legacy persisted copies, and keeps custom messages', async () => {
    const { RETIRED_DEFAULT_CC_PRESET_INIT_MESSAGE } = await import('../../shared/cc-presets.js');
    const { savePresets, getPreset, getPresetInitMessage, invalidateCache } = await import('../../src/daemon/cc-presets.js');

    await savePresets([
      {
        name: 'NoInit',
        env: { ANTHROPIC_BASE_URL: 'https://a.test', ANTHROPIC_MODEL: 'm1' },
      },
      {
        name: 'LegacyDuckDuckGo',
        env: { ANTHROPIC_BASE_URL: 'https://b.test', ANTHROPIC_MODEL: 'm1' },
        initMessage: RETIRED_DEFAULT_CC_PRESET_INIT_MESSAGE,
      },
      {
        name: 'CustomInit',
        env: { ANTHROPIC_BASE_URL: 'https://c.test', ANTHROPIC_MODEL: 'm1' },
        initMessage: 'Use internal docs endpoint first.',
      },
    ]);

    invalidateCache();

    const noInit = await getPreset('NoInit');
    const legacy = await getPreset('LegacyDuckDuckGo');
    const custom = await getPreset('CustomInit');

    expect(noInit?.initMessage).toBeUndefined();
    expect(legacy?.initMessage).toBeUndefined();
    expect(custom?.initMessage).toBe('Use internal docs endpoint first.');

    expect(getPresetInitMessage(noInit!)).toBeUndefined();
    expect(getPresetInitMessage(legacy!)).toBeUndefined();
    expect(getPresetInitMessage({ ...legacy!, initMessage: RETIRED_DEFAULT_CC_PRESET_INIT_MESSAGE })).toBeUndefined();
    expect(getPresetInitMessage(custom!)).toBe('Use internal docs endpoint first.');
  });

  it('syncs and clears cached session contextWindow when switching or clearing presets', async () => {
    const { resolvePresetEnv, getSessionContextWindow, syncSessionContextWindow } = await import('../../src/daemon/cc-presets.js');

    await resolvePresetEnv('MiniMax', 'cc-uuid-1');
    expect(getSessionContextWindow('cc-uuid-1')).toBe(200_000);

    syncSessionContextWindow('cc-uuid-1', undefined);
    expect(getSessionContextWindow('cc-uuid-1')).toBeUndefined();
  });

  it('keeps explicit modelOverride authoritative in resolvePresetEnv even when discovered catalog is stale', async () => {
    const { savePresets, resolvePresetEnv, getPresetTransportOverrides } = await import('../../src/daemon/cc-presets.js');
    await savePresets([
      {
        name: 'StaleCatalog',
        env: { ANTHROPIC_BASE_URL: 'https://a.test', ANTHROPIC_MODEL: 'm1' },
        defaultModel: 'm1',
        availableModels: [{ id: 'm1' }],
      },
    ]);

    const env = await resolvePresetEnv('StaleCatalog', undefined, 'm2');
    const overrides = await getPresetTransportOverrides('StaleCatalog', 'm2');
    expect(env.ANTHROPIC_MODEL).toBe('m2');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('m2');
    expect(overrides.model).toBe('m2');
  });

  it('rejects stale expectedVersion writes via CcPresetConflictError and keeps newer concurrent presets', async () => {
    const {
      savePresetsVersioned,
      loadPresetsWithVersion,
      CcPresetConflictError,
    } = await import('../../src/daemon/cc-presets.js');

    const initial = await loadPresetsWithVersion();
    const afterB = await savePresetsVersioned(
      [...initial.presets, { name: 'PresetB', env: { ANTHROPIC_MODEL: 'b1' } }],
      initial.version,
    );
    expect(afterB.presets.map((p) => p.name)).toContain('PresetB');

    await expect(
      savePresetsVersioned(
        [...initial.presets, { name: 'PresetC', env: { ANTHROPIC_MODEL: 'c1' } }],
        initial.version,
      ),
    ).rejects.toBeInstanceOf(CcPresetConflictError);

    const latest = await loadPresetsWithVersion();
    expect(latest.presets.map((p) => p.name)).toEqual(['minimax', 'PresetB']);
  });

  it('merges refreshPresetModels atomically under saveMutex without overwriting concurrent PresetB saves', async () => {
    const {
      savePresetsVersioned,
      loadPresetsWithVersion,
      refreshPresetModels,
      getPreset,
    } = await import('../../src/daemon/cc-presets.js');

    let resolveFetch!: (res: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));

    try {
      const initial = await loadPresetsWithVersion();
      const discoverPromise = refreshPresetModels('MiniMax');

      // Wait for fetch to be initiated so discovery is in flight
      await vi.waitFor(() => expect(resolveFetch).toBeDefined());

      // Concurrently save PresetB while MiniMax model discovery is awaiting network
      const afterB = await savePresetsVersioned(
        [...initial.presets, { name: 'PresetB', env: { ANTHROPIC_MODEL: 'b1' }, defaultModel: 'b1' }],
        initial.version,
      );

      // Complete discovery fetch
      resolveFetch(new Response(JSON.stringify({ data: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

      const catalog = await discoverPromise;
      expect(catalog.version).toBeDefined();
      expect(catalog.version).not.toBe(afterB.version);
      expect(catalog.presets?.map((p) => p.name)).toEqual(['minimax', 'PresetB']);

      // Both PresetB and MiniMax's updated catalog persist cleanly on disk
      const disk = await loadPresetsWithVersion();
      expect(disk.version).toBe(catalog.version);
      expect(disk.presets.map((p) => p.name)).toEqual(['minimax', 'PresetB']);
      const minimax = await getPreset('MiniMax');
      expect(minimax?.availableModels?.map((m) => m.id)).toEqual(['MiniMax-M3', 'MiniMax-M2.7']);

      // Immediate follow-up save using returned catalog.version succeeds without conflict
      const afterC = await savePresetsVersioned(
        [...disk.presets, { name: 'PresetC', env: { ANTHROPIC_MODEL: 'c1' }, defaultModel: 'c1' }],
        catalog.version,
      );
      expect(afterC.presets.map((p) => p.name)).toEqual(['minimax', 'PresetB', 'PresetC']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aborts refreshPresetModels merge if target preset was deleted or its endpoint changed while discovery ran', async () => {
    const {
      savePresetsVersioned,
      loadPresetsWithVersion,
      refreshPresetModels,
      CcPresetDiscoveryStaleError,
    } = await import('../../src/daemon/cc-presets.js');

    let resolveFetch!: (res: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));

    try {
      // 1) Deleted concurrently -> never resurrect
      const s1 = await loadPresetsWithVersion();
      const discoverDeleted = refreshPresetModels('MiniMax');
      await vi.waitFor(() => expect(resolveFetch).toBeDefined());
      await savePresetsVersioned([
        {
          name: 'Other',
          env: { ANTHROPIC_BASE_URL: 'https://other.test/v1', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'o1' },
        },
      ], s1.version);
      resolveFetch(new Response(JSON.stringify({ data: [{ id: 'MiniMax-M3' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      await expect(discoverDeleted).rejects.toBeInstanceOf(CcPresetDiscoveryStaleError);
      expect((await loadPresetsWithVersion()).presets.map((p) => p.name)).toEqual(['Other']);

      // 2) Provider endpoint edited concurrently -> never attach old catalog onto new provider URL
      const s2 = await loadPresetsWithVersion();
      resolveFetch = undefined as any;
      const discoverChanged = refreshPresetModels('Other');
      await vi.waitFor(() => expect(resolveFetch).toBeDefined());
      await savePresetsVersioned([
        {
          name: 'Other',
          env: { ANTHROPIC_BASE_URL: 'https://new-endpoint.example/v1', ANTHROPIC_MODEL: 'new-1' },
        },
      ], s2.version);
      resolveFetch(new Response(JSON.stringify({ data: [{ id: 'stale-old-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      await expect(discoverChanged).rejects.toBeInstanceOf(CcPresetDiscoveryStaleError);
      const after = await loadPresetsWithVersion();
      expect(after.presets[0].env.ANTHROPIC_BASE_URL).toBe('https://new-endpoint.example/v1');
      expect(after.presets[0].availableModels).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aborts refreshPresetModels when active credential rotates in a dual-credential preset during deferred discovery', async () => {
    const {
      savePresetsVersioned,
      loadPresetsWithVersion,
      refreshPresetModels,
      CcPresetDiscoveryStaleError,
    } = await import('../../src/daemon/cc-presets.js');

    let resolveFetch!: (res: Response) => void;
    let rejectFetch!: (err: Error) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => {
      resolveFetch = resolve;
      rejectFetch = reject;
    })));

    try {
      // Case 1: OpenAI preset with both ANTHROPIC_API_KEY and OPENAI_API_KEY — rotate OPENAI_API_KEY during fetch success
      await savePresetsVersioned([
        {
          name: 'DualOpenAI',
          authType: 'openai',
          env: {
            OPENAI_BASE_URL: 'https://dual.test/v1',
            OPENAI_API_KEY: 'o-old',
            ANTHROPIC_API_KEY: 'a-unchanged',
            OPENAI_MODEL: 'm1',
          },
        },
        {
          name: 'DualAnthropic',
          authType: 'anthropic',
          env: {
            ANTHROPIC_BASE_URL: 'https://anth.test',
            ANTHROPIC_AUTH_TOKEN: 'tok-old',
            OPENAI_API_KEY: 'o-unchanged',
            ANTHROPIC_MODEL: 'c1',
          },
        },
      ]);

      const snap1 = await loadPresetsWithVersion();
      const discoverOpenAi = refreshPresetModels('DualOpenAI');
      await vi.waitFor(() => expect(resolveFetch).toBeDefined());

      // Concurrently rotate OPENAI_API_KEY + add PresetOther while ANTHROPIC_API_KEY stays identical
      await savePresetsVersioned([
        {
          ...snap1.presets[0],
          env: { ...snap1.presets[0].env, OPENAI_API_KEY: 'o-new' },
        },
        snap1.presets[1],
        { name: 'PresetOther', env: { ANTHROPIC_MODEL: 'x1' } },
      ], snap1.version);

      resolveFetch(new Response(JSON.stringify({ data: [{ id: 'stale-old-key-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      await expect(discoverOpenAi).rejects.toBeInstanceOf(CcPresetDiscoveryStaleError);

      const after1 = await loadPresetsWithVersion();
      const dualOai = after1.presets.find((p) => p.name === 'DualOpenAI')!;
      expect(dualOai.env.OPENAI_API_KEY).toBe('o-new');
      expect(dualOai.availableModels).toBeUndefined();
      expect(dualOai.modelDiscoveryError).toBeUndefined();
      expect(after1.presets.map((p) => p.name)).toContain('PresetOther');

      // Case 2: Anthropic preset using ANTHROPIC_AUTH_TOKEN + OPENAI_API_KEY — rotate ANTHROPIC_AUTH_TOKEN during fetch failure
      resolveFetch = undefined as any;
      rejectFetch = undefined as any;
      const discoverAnthropic = refreshPresetModels('DualAnthropic');
      await vi.waitFor(() => expect(rejectFetch).toBeDefined());

      await savePresetsVersioned([
        after1.presets[0],
        {
          ...after1.presets[1],
          env: { ...after1.presets[1].env, ANTHROPIC_AUTH_TOKEN: 'tok-new' },
        },
        after1.presets[2],
      ], after1.version);

      rejectFetch(new Error('old token unauthorized'));
      await expect(discoverAnthropic).rejects.toThrow('old token unauthorized');

      const after2 = await loadPresetsWithVersion();
      const dualAnth = after2.presets.find((p) => p.name === 'DualAnthropic')!;
      expect(dualAnth.env.ANTHROPIC_AUTH_TOKEN).toBe('tok-new');
      expect(dualAnth.modelDiscoveryError).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
