import { describe, expect, it } from 'vitest';
import { createCcPresetDraftFromPreset } from '../src/components/cc-preset-form.js';

describe('CC preset form', () => {
  it('shows the migrated 1M window for legacy MiniMax-M3 presets', () => {
    const draft = createCcPresetDraftFromPreset({
      name: 'minimax',
      env: { ANTHROPIC_MODEL: 'MiniMax-M3' },
      defaultModel: 'MiniMax-M3',
      contextWindow: 200_000,
    });

    expect(draft.contextWindow).toBe('1000000');
  });

  it('does not rewrite another model\'s explicit 200K window', () => {
    const draft = createCcPresetDraftFromPreset({
      name: 'custom',
      env: { ANTHROPIC_MODEL: 'custom-model' },
      contextWindow: 200_000,
    });

    expect(draft.contextWindow).toBe('200000');
  });

  it('populates OpenAI draft fields when preset authType is openai', () => {
    const draft = createCcPresetDraftFromPreset({
      name: 'openai-preset',
      authType: 'openai',
      env: {
        OPENAI_BASE_URL: 'https://api.example.com/v1',
        OPENAI_API_KEY: 'sk-test-123',
        OPENAI_MODEL: 'gpt-4o-mini',
      },
      contextWindow: 128_000,
    });

    expect(draft.authType).toBe('openai');
    expect(draft.baseUrl).toBe('https://api.example.com/v1');
    expect(draft.token).toBe('sk-test-123');
    expect(draft.model).toBe('gpt-4o-mini');
    expect(draft.contextWindow).toBe('128000');
  });

  it('builds an OpenAI preset with OPENAI_* env vars from draft', async () => {
    const { buildCcPresetFromDraft } = await import('../src/components/cc-preset-form.js');
    const preset = buildCcPresetFromDraft({
      name: 'My OpenAI Endpoint',
      authType: 'openai',
      baseUrl: 'https://api.example.com/v1',
      token: 'sk-secret-key',
      model: 'my-custom-model',
      contextWindow: '256000',
      customEnv: [{ key: 'EXTRA_VAR', value: 'hello' }],
      initMessage: 'init prompt',
      availableModels: [{ id: 'my-custom-model', name: 'My Custom Model' }],
    });

    expect(preset.authType).toBe('openai');
    expect(preset.name).toBe('My OpenAI Endpoint');
    expect(preset.defaultModel).toBe('my-custom-model');
    expect(preset.contextWindow).toBe(256000);
    expect(preset.initMessage).toBe('init prompt');
    expect(preset.env).toMatchObject({
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_API_KEY: 'sk-secret-key',
      OPENAI_MODEL: 'my-custom-model',
      EXTRA_VAR: 'hello',
    });
  });

  it('builds an Anthropic preset with ANTHROPIC_* env vars from draft', async () => {
    const { buildCcPresetFromDraft } = await import('../src/components/cc-preset-form.js');
    const preset = buildCcPresetFromDraft({
      name: 'My Anthropic Endpoint',
      authType: 'anthropic',
      baseUrl: 'https://api.minimax.io/anthropic',
      token: 'anthropic-secret',
      model: 'MiniMax-M2.7',
      contextWindow: '1000000',
      customEnv: [],
      initMessage: '',
      availableModels: [],
    });

    expect(preset.authType).toBe('anthropic');
    expect(preset.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      ANTHROPIC_MODEL: 'MiniMax-M2.7',
    });
  });
});
