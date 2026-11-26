import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
  DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
  DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL,
  DEFAULT_MEMORY_SCORING_WEIGHTS,
  DEFAULT_MEMORY_RECALL_MIN_SCORE,
  DEFAULT_PRIMARY_CONTEXT_BACKEND,
  DEFAULT_PRIMARY_CONTEXT_RUNTIME_MODEL,
  LEGACY_SHARED_CONTEXT_RUNTIME_BACKENDS,
  SHARED_CONTEXT_RUNTIME_BACKENDS,
  adaptSharedContextRuntimeConfigForSupportedBackends,
  defaultSharedContextRuntimeConfig,
  getDefaultSharedContextModelForBackend,
  inferSharedContextRuntimeBackend,
  isKnownSharedContextModelForBackend,
  mapAgentTypeToSharedContextRuntimeSelection,
  normalizeMemoryScoringWeights,
  normalizeMemoryRecallMinScore,
  normalizeOptionalSharedContextRuntimeSelection,
  normalizeSharedContextRuntimeConfig,
  resolveEffectiveSharedContextRuntimeConfig,
  resolveIncomingSharedContextModelSelectionMode,
} from '../shared/shared-context-runtime-config.js';

describe('shared-context-runtime-config', () => {
  it('defaults memory compression to Codex gpt-6-luna for both primary and backup, with claude haiku, agy 3.8-flash-low, and opencode big-pickle defaults', () => {
    const result = defaultSharedContextRuntimeConfig();

    expect(DEFAULT_PRIMARY_CONTEXT_BACKEND).toBe('codex-sdk');
    expect(DEFAULT_PRIMARY_CONTEXT_RUNTIME_MODEL).toBe(DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL);
    expect(DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND).toBe('codex-sdk');
    expect(DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL).toBe('gpt-6-luna');
    expect(getDefaultSharedContextModelForBackend('claude-code-sdk')).toBe('haiku');
    expect(getDefaultSharedContextModelForBackend('codex-sdk')).toBe('gpt-6-luna');
    expect(getDefaultSharedContextModelForBackend('agy-sdk')).toBe('gemini-3.8-flash-low');
    expect(getDefaultSharedContextModelForBackend('opencode-sdk')).toBe('opencode/big-pickle');
    expect(result.primaryContextBackend).toBe('codex-sdk');
    expect(result.primaryContextModel).toBe(DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL);
    expect(result.backupContextBackend).toBe('codex-sdk');
    expect(result.backupContextModel).toBe('gpt-6-luna');
  });

  it('uses backend-specific defaults when model is missing', () => {
    const agyResult = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'agy-sdk',
    });
    expect(agyResult.primaryContextBackend).toBe('agy-sdk');
    expect(agyResult.primaryContextModel).toBe('gemini-3.8-flash-low');
    expect(agyResult.backupContextBackend).toBe(DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND);
    expect(agyResult.backupContextModel).toBe(DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL);
    expect(agyResult.memoryRecallMinScore).toBe(DEFAULT_MEMORY_RECALL_MIN_SCORE);
    expect(agyResult.memoryScoringWeights).toEqual(DEFAULT_MEMORY_SCORING_WEIGHTS);
    expect(agyResult.enablePersonalMemorySync).toBe(true);

    const openCodeResult = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'opencode-sdk',
    });
    expect(openCodeResult.primaryContextBackend).toBe('opencode-sdk');
    expect(openCodeResult.primaryContextModel).toBe('opencode/big-pickle');

    const claudeResult = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
    });
    expect(claudeResult.primaryContextBackend).toBe('claude-code-sdk');
    expect(claudeResult.primaryContextModel).toBe('haiku');
  });

  it('replaces incompatible saved models with the backend default', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'agy-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'opencode-sdk',
      backupContextModel: 'haiku',
    });
    expect(result.primaryContextBackend).toBe('agy-sdk');
    expect(result.primaryContextModel).toBe('gemini-3.8-flash-low');
    expect(result.backupContextBackend).toBe('opencode-sdk');
    expect(result.backupContextModel).toBe('opencode/big-pickle');
  });

  it('normalizes legacy persisted qwen primary and backup configs gracefully to codex-sdk gpt-6-luna', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'qwen3-coder-plus',
      primaryContextPreset: 'Legacy Qwen Preset',
      backupContextBackend: 'qwen',
      backupContextModel: 'sonnet',
      backupContextPreset: 'Legacy Backup Preset',
    });
    expect(result.primaryContextBackend).toBe('codex-sdk');
    expect(result.primaryContextModel).toBe('gpt-6-luna');
    expect(result.primaryContextPreset).toBeUndefined();
    expect(result.backupContextBackend).toBe('codex-sdk');
    expect(result.backupContextModel).toBe('gpt-6-luna');
    expect(result.backupContextPreset).toBeUndefined();
  });

  it('forces non-Luna codex-sdk models to gpt-6-luna in auto mode and coerces deprecated spark, while preserving manual supported models', () => {
    for (const nonLunaModel of ['gpt-5.6', 'gpt-5.4', 'gpt-6-sol', 'gpt-4.1-mini', 'gpt-5.3-codex-spark']) {
      const autoResult = normalizeSharedContextRuntimeConfig({
        modelSelectionMode: 'auto',
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: nonLunaModel,
        backupContextBackend: 'codex-sdk',
        backupContextModel: nonLunaModel,
      });
      expect(autoResult.primaryContextBackend).toBe('codex-sdk');
      expect(autoResult.primaryContextModel).toBe('gpt-6-luna');
      expect(autoResult.backupContextBackend).toBe('codex-sdk');
      expect(autoResult.backupContextModel).toBe('gpt-6-luna');
    }

    const deprecatedManual = normalizeSharedContextRuntimeConfig({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.3-codex-spark',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-5.3-codex-spark',
    });
    expect(deprecatedManual.primaryContextModel).toBe('gpt-6-luna');
    expect(deprecatedManual.backupContextModel).toBe('gpt-6-luna');

    for (const manualModel of ['gpt-5.6', 'gpt-5.4', 'gpt-6-sol', 'gpt-4.1-mini']) {
      const manualResult = normalizeSharedContextRuntimeConfig({
        modelSelectionMode: 'manual',
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: manualModel,
        backupContextBackend: 'codex-sdk',
        backupContextModel: manualModel,
      });
      expect(manualResult.modelSelectionMode).toBe('manual');
      expect(manualResult.primaryContextBackend).toBe('codex-sdk');
      expect(manualResult.primaryContextModel).toBe(manualModel);
      expect(manualResult.backupContextBackend).toBe('codex-sdk');
      expect(manualResult.backupContextModel).toBe(manualModel);
    }
  });

  it('keeps a configured backup backend by filling its default model when the model is omitted', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'agy-sdk',
    });
    expect(result.primaryContextBackend).toBe('claude-code-sdk');
    expect(result.primaryContextModel).toBe('sonnet');
    expect(result.backupContextBackend).toBe('agy-sdk');
    expect(result.backupContextModel).toBe('gemini-3.8-flash-low');
  });

  it('fills only missing runtime selections while preserving saved primary values', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'opus[1M]',
    });
    expect(result.primaryContextBackend).toBe('claude-code-sdk');
    expect(result.primaryContextModel).toBe('opus[1M]');
    expect(result.backupContextBackend).toBe(DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND);
    expect(result.backupContextModel).toBe(DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL);
  });

  it('passes through primaryContextSdk and backupContextSdk when provided', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextSdk: 'anthropic-sdk',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-6-luna',
      backupContextSdk: 'openai-sdk',
    });
    expect(result.primaryContextSdk).toBe('anthropic-sdk');
    expect(result.backupContextSdk).toBe('openai-sdk');
  });

  it('passes through primaryContextPreset and backupContextPreset for preset-capable backends', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'custom-claude-model',
      primaryContextPreset: 'Claude Team',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'MiniMax-M2.7',
      backupContextPreset: 'Codex Backup',
    });
    expect(result.primaryContextModel).toBe('custom-claude-model');
    expect(result.backupContextModel).toBe('MiniMax-M2.7');
    expect(result.primaryContextPreset).toBe('Claude Team');
    expect(result.backupContextPreset).toBe('Codex Backup');
  });

  it('drops preset selections for backends that do not support presets', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'openclaw',
      primaryContextModel: 'gpt-5.4',
      primaryContextPreset: 'Should Not Persist',
      backupContextBackend: 'openclaw',
      backupContextModel: 'haiku',
      backupContextPreset: 'Also Ignored',
    });
    expect(result.primaryContextPreset).toBeUndefined();
    expect(result.backupContextPreset).toBeUndefined();
  });

  it('keeps preset selections for claude-code-sdk (third-party CC SDK)', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M3',
      primaryContextPreset: 'minimax',
    });
    expect(result.primaryContextBackend).toBe('claude-code-sdk');
    expect(result.primaryContextPreset).toBe('minimax');
    expect(result.primaryContextModel).toBe('MiniMax-M3');
  });

  it('keeps preset selections for codex-sdk (third-party OpenAI SDK)', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-4o',
      primaryContextPreset: 'openai-preset',
    });
    expect(result.primaryContextBackend).toBe('codex-sdk');
    expect(result.primaryContextPreset).toBe('openai-preset');
    expect(result.primaryContextModel).toBe('gpt-4o');
  });

  it('omits sdk fields when not provided', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'agy-sdk',
    });
    expect(result.primaryContextSdk).toBeUndefined();
    expect(result.backupContextSdk).toBeUndefined();
    expect(result.primaryContextPreset).toBeUndefined();
    expect(result.backupContextPreset).toBeUndefined();
  });

  it('passes through materializationMinIntervalMs when positive', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      materializationMinIntervalMs: 15000,
    });
    expect(result.materializationMinIntervalMs).toBe(15000);
  });

  it('omits materializationMinIntervalMs when zero or negative', () => {
    expect(normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      materializationMinIntervalMs: 0,
    }).materializationMinIntervalMs).toBeUndefined();

    expect(normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      materializationMinIntervalMs: -1,
    }).materializationMinIntervalMs).toBeUndefined();
  });

  it('preserves enablePersonalMemorySync when true', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      enablePersonalMemorySync: true,
    });
    expect(result.enablePersonalMemorySync).toBe(true);
  });

  it('preserves enablePersonalMemorySync when explicitly false', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      enablePersonalMemorySync: false,
    });
    expect(result.enablePersonalMemorySync).toBe(false);
  });

  it('preserves a configured memory recall threshold when valid', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      memoryRecallMinScore: 0.37,
    });
    expect(result.memoryRecallMinScore).toBe(0.37);
  });

  it('normalizes memory scoring weights so they sum to 1.0', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      memoryScoringWeights: {
        similarity: 2,
        recency: 1,
        frequency: 1,
        project: 0,
      },
    });
    expect(result.memoryScoringWeights).toEqual({
      similarity: 0.5,
      recency: 0.25,
      frequency: 0.25,
      project: 0,
    });
    expect(
      result.memoryScoringWeights.similarity
      + result.memoryScoringWeights.recency
      + result.memoryScoringWeights.frequency
      + result.memoryScoringWeights.project,
    ).toBeCloseTo(1, 4);
  });

  it('defaults memory recall threshold when undefined and clamps invalid values', () => {
    expect(normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
    }).memoryRecallMinScore).toBe(DEFAULT_MEMORY_RECALL_MIN_SCORE);

    expect(normalizeMemoryRecallMinScore(-1)).toBe(0);
    expect(normalizeMemoryRecallMinScore(2)).toBe(1);
    expect(normalizeMemoryRecallMinScore(Number.NaN)).toBe(DEFAULT_MEMORY_RECALL_MIN_SCORE);
    expect(normalizeMemoryScoringWeights({ similarity: -1, recency: -1, frequency: -1, project: -1 })).toEqual(DEFAULT_MEMORY_SCORING_WEIGHTS);
  });

  it('defaults enablePersonalMemorySync to true when undefined', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
    });
    expect(result.enablePersonalMemorySync).toBe(true);
  });

  // tsk_cd_model_list_unified: a model released after this file's static
  // lists were last updated must still classify to its real backend by
  // naming pattern, and must still validate under that backend, instead of
  // silently falling back to the wrong default and getting rejected there.
  describe('classifies and validates live models the static lists do not know about', () => {
    it.each([
      ['gpt-6-luna', 'codex-sdk'],
      ['gpt-6-astra', 'codex-sdk'],
      ['claude-opus-4-7', 'claude-code-sdk'],
      ['gemini-3.8-flash-low', 'agy-sdk'],
      ['opencode/big-pickle', 'opencode-sdk'],
    ] as const)('infers %s as %s', (model, backend) => {
      expect(inferSharedContextRuntimeBackend(model)).toBe(backend);
    });

    it.each([
      ['gpt-6-luna', 'codex-sdk'],
      ['gpt-6-astra', 'codex-sdk'],
      ['claude-opus-4-7', 'claude-code-sdk'],
      ['gemini-3.8-flash-low', 'agy-sdk'],
      ['opencode/big-pickle', 'opencode-sdk'],
    ] as const)('accepts %s under %s', (model, backend) => {
      expect(isKnownSharedContextModelForBackend(backend, model)).toBe(true);
    });

    it('still rejects a model shaped like a different backend, even though it is unknown to any static list', () => {
      expect(isKnownSharedContextModelForBackend('agy-sdk', 'gpt-6-luna')).toBe(false);
      expect(isKnownSharedContextModelForBackend('opencode-sdk', 'claude-opus-4-7')).toBe(false);
      expect(isKnownSharedContextModelForBackend('codex-sdk', 'claude-opus-4-7')).toBe(false);
      expect(isKnownSharedContextModelForBackend('codex-sdk', 'gemini-3.8-flash-low')).toBe(false);
      expect(isKnownSharedContextModelForBackend('codex-sdk', 'opencode/big-pickle')).toBe(false);
      expect(isKnownSharedContextModelForBackend('claude-code-sdk', 'gpt-6-astra')).toBe(false);
    });

    it('a live Codex model id round-trips through normalizeSharedContextRuntimeConfig without a backend hint', () => {
      const result = normalizeSharedContextRuntimeConfig({ primaryContextModel: 'gpt-6-luna' });
      expect(result.primaryContextBackend).toBe('codex-sdk');
      expect(result.primaryContextModel).toBe('gpt-6-luna');
    });

    it('a live Claude model id round-trips through normalizeSharedContextRuntimeConfig without a backend hint', () => {
      const result = normalizeSharedContextRuntimeConfig({ primaryContextModel: 'claude-opus-4-7' });
      expect(result.primaryContextBackend).toBe('claude-code-sdk');
      expect(result.primaryContextModel).toBe('claude-opus-4-7');
    });
  });
});

describe('bare Codex backend in model field', () => {
  it('does not infer a backend from codex-sdk as if it were a model', () => {
    expect(inferSharedContextRuntimeBackend('codex-sdk')).toBeUndefined();
  });
  it.each([undefined, 'codex-sdk', 'claude-code-sdk'])('falls back to a valid model with backend %s', (backend) => {
    const result = normalizeSharedContextRuntimeConfig({ primaryContextBackend: backend, primaryContextModel: 'codex-sdk' });
    expect(result.primaryContextModel).toBe(getDefaultSharedContextModelForBackend(result.primaryContextBackend!));
    expect(result.primaryContextModel).not.toBe('codex-sdk');
  });
});

describe('deprecated gpt-5.3-codex-spark migration', () => {
  it.each(['gpt-5.3-codex-spark', 'GPT-5.3-CODEX-SPARK', ' gpt-5.3-codex-spark '])(
    'coerces persisted %j on codex-sdk primary and backup context compression to gpt-6-luna',
    (legacyModel) => {
      const result = normalizeSharedContextRuntimeConfig({
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: legacyModel,
        backupContextBackend: 'codex-sdk',
        backupContextModel: legacyModel,
      });
      expect(result.primaryContextBackend).toBe('codex-sdk');
      expect(result.primaryContextModel).toBe('gpt-6-luna');
      expect(result.backupContextBackend).toBe('codex-sdk');
      expect(result.backupContextModel).toBe('gpt-6-luna');

      expect(normalizeOptionalSharedContextRuntimeSelection({
        backend: 'codex-sdk',
        model: legacyModel,
      })).toEqual({
        backend: 'codex-sdk',
        model: 'gpt-6-luna',
      });
    },
  );

  it('infers codex-sdk and coerces legacy spark when backend is omitted', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextModel: 'gpt-5.3-codex-spark',
      backupContextModel: 'gpt-5.3-codex-spark',
    });
    expect(result.primaryContextBackend).toBe('codex-sdk');
    expect(result.primaryContextModel).toBe('gpt-6-luna');
    expect(result.backupContextBackend).toBe('codex-sdk');
    expect(result.backupContextModel).toBe('gpt-6-luna');
  });

  it('forces codex-sdk non-preset models to gpt-6-luna in auto mode while preserving manual supported models and non-codex-sdk backends', () => {
    for (const model of ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.4-mini']) {
      expect(normalizeSharedContextRuntimeConfig({
        modelSelectionMode: 'auto',
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: model,
      }).primaryContextModel).toBe('gpt-6-luna');
    }
    expect(normalizeSharedContextRuntimeConfig({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
    }).primaryContextModel).toBe('gpt-5.4');

    expect(normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'agy-sdk',
      backupContextModel: 'gemini-3.8-flash-low',
    })).toMatchObject({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'agy-sdk',
      backupContextModel: 'gemini-3.8-flash-low',
    });

    expect(normalizeOptionalSharedContextRuntimeSelection({
      backend: 'openclaw',
      model: 'gpt-5.3-codex-spark',
    })).toEqual({
      backend: 'openclaw',
      model: 'gpt-5.3-codex-spark',
    });
  });
});

describe('OpenCode provider/model validation and daemon compatibility negotiation', () => {
  it.each([
    'anthropic/claude-sonnet-4-6',
    'opencode/claude-sonnet-4-6',
    'openrouter/anthropic/claude-3.7-sonnet',
    'openai/gpt-5',
  ])('preserves qualified provider/model id %s under opencode-sdk without bare cross-backend rejection', (model) => {
    expect(isKnownSharedContextModelForBackend('opencode-sdk', model)).toBe(true);
    const normalized = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'opencode-sdk',
      primaryContextModel: model,
      backupContextBackend: 'opencode-sdk',
      backupContextModel: model,
    });
    expect(normalized.primaryContextBackend).toBe('opencode-sdk');
    expect(normalized.primaryContextModel).toBe(model);
    expect(normalized.backupContextBackend).toBe('opencode-sdk');
    expect(normalized.backupContextModel).toBe(model);
  });

  it.each([
    'opencode/',
    '/big-pickle',
    'opencode//big-pickle',
    'sonnet',
    'gpt-6-luna',
    'gemini-3.8-flash-low',
  ])('rejects invalid or cross-backend bare model %s under opencode-sdk and falls back to opencode/big-pickle', (model) => {
    expect(isKnownSharedContextModelForBackend('opencode-sdk', model)).toBe(false);
    const normalized = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'opencode-sdk',
      primaryContextModel: model,
    });
    expect(normalized.primaryContextBackend).toBe('opencode-sdk');
    expect(normalized.primaryContextModel).toBe('opencode/big-pickle');
  });

  it('adapts new backends to executable Codex gpt-6-luna only for legacy daemons without advertising support', () => {
    const selected = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'opencode-sdk',
      primaryContextModel: 'anthropic/claude-sonnet-4-6',
      backupContextBackend: 'agy-sdk',
      backupContextModel: 'gemini-3.8-flash-low',
    });

    const forLegacyDaemon = adaptSharedContextRuntimeConfigForSupportedBackends(
      selected,
      LEGACY_SHARED_CONTEXT_RUNTIME_BACKENDS,
    );
    expect(forLegacyDaemon).toMatchObject({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-6-luna',
      primaryContextPreset: undefined,
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-6-luna',
      backupContextPreset: undefined,
    });

    const forNewDaemon = adaptSharedContextRuntimeConfigForSupportedBackends(
      selected,
      SHARED_CONTEXT_RUNTIME_BACKENDS,
    );
    expect(forNewDaemon).toEqual(selected);
  });

  it('coerces codex-sdk backup/primary to gpt-6-luna in auto mode while manual mode and normalizeOptionalSharedContextRuntimeSelection preserve explicit Codex models', () => {
    const sharedContextAuto = normalizeSharedContextRuntimeConfig({
      modelSelectionMode: 'auto',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-5.4',
    });
    expect(sharedContextAuto.primaryContextModel).toBe('gpt-6-luna');
    expect(sharedContextAuto.backupContextModel).toBe('gpt-6-luna');

    const sharedContextManual = normalizeSharedContextRuntimeConfig({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-5.6',
    });
    expect(sharedContextManual.primaryContextModel).toBe('gpt-5.4');
    expect(sharedContextManual.backupContextModel).toBe('gpt-5.6');

    expect(normalizeOptionalSharedContextRuntimeSelection({
      backend: 'codex-sdk',
      model: 'gpt-5.4',
    })).toEqual({
      backend: 'codex-sdk',
      model: 'gpt-5.4',
    });
  });

  it('maps user agent types to their corresponding low-tier shared-context runtime selections', () => {
    expect(defaultSharedContextRuntimeConfig().modelSelectionMode).toBe('auto');
    expect(mapAgentTypeToSharedContextRuntimeSelection('codex')).toEqual({ backend: 'codex-sdk', model: 'gpt-6-luna' });
    expect(mapAgentTypeToSharedContextRuntimeSelection('codex-sdk')).toEqual({ backend: 'codex-sdk', model: 'gpt-6-luna' });
    expect(mapAgentTypeToSharedContextRuntimeSelection('claude-code')).toEqual({ backend: 'claude-code-sdk', model: 'haiku' });
    expect(mapAgentTypeToSharedContextRuntimeSelection('claude-code-sdk')).toEqual({ backend: 'claude-code-sdk', model: 'haiku' });
    expect(mapAgentTypeToSharedContextRuntimeSelection('agy')).toEqual({ backend: 'agy-sdk', model: 'gemini-3.8-flash-low' });
    expect(mapAgentTypeToSharedContextRuntimeSelection('agy-sdk')).toEqual({ backend: 'agy-sdk', model: 'gemini-3.8-flash-low' });
    expect(mapAgentTypeToSharedContextRuntimeSelection('opencode')).toEqual({ backend: 'opencode-sdk', model: 'opencode/big-pickle' });
    expect(mapAgentTypeToSharedContextRuntimeSelection('opencode-sdk')).toEqual({ backend: 'opencode-sdk', model: 'opencode/big-pickle' });
    expect(mapAgentTypeToSharedContextRuntimeSelection('openclaw')).toEqual({ backend: 'openclaw', model: 'default' });
    for (const unmapped of ['qwen', 'shell', 'gemini', '', null, undefined]) {
      expect(mapAgentTypeToSharedContextRuntimeSelection(unmapped)).toBeUndefined();
    }
  });

  it('keeps empty/metadata-only payloads auto while treating legacy non-empty payloads omitting modelSelectionMode as manual', () => {
    expect(resolveIncomingSharedContextModelSelectionMode(null)).toBe('auto');
    expect(resolveIncomingSharedContextModelSelectionMode({})).toBe('auto');
    expect(resolveIncomingSharedContextModelSelectionMode({ enablePersonalMemorySync: false })).toBe('auto');
    expect(resolveIncomingSharedContextModelSelectionMode({
      modelSelectionMode: 'auto',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M2.7',
    })).toBe('auto');
    expect(resolveIncomingSharedContextModelSelectionMode({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M2.7',
      primaryContextPreset: 'MiniMax',
    })).toBe('manual');
    const legacy = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M2.7',
      primaryContextPreset: 'MiniMax',
    });
    expect(legacy.modelSelectionMode).toBe('manual');
    expect(resolveEffectiveSharedContextRuntimeConfig(legacy, { sessionAgentType: 'codex-sdk' })).toMatchObject({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M2.7',
      primaryContextPreset: 'MiniMax',
    });
  });

  it('auto-adapts runtime selection based on active user agents while honoring manual pinning and avoiding duplicate same-backend backups', () => {
    const baseAuto = normalizeSharedContextRuntimeConfig({
      modelSelectionMode: 'auto',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'opus[1M]',
      primaryContextPreset: 'minimax',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-6-luna',
      backupContextPreset: 'openai-preset',
    });

    // Direct session match + distinct second active agent -> deduplicated by backend, presets cleared.
    expect(resolveEffectiveSharedContextRuntimeConfig(baseAuto, {
      sessionAgentType: 'agy',
      activeSessionAgentTypes: ['agy-sdk', 'opencode-sdk', 'claude-code'],
    })).toMatchObject({
      modelSelectionMode: 'auto',
      primaryContextBackend: 'agy-sdk',
      primaryContextModel: 'gemini-3.8-flash-low',
      primaryContextPreset: undefined,
      backupContextBackend: 'opencode-sdk',
      backupContextModel: 'opencode/big-pickle',
      backupContextPreset: undefined,
    });

    // Unmapped session type falls back to active mapped sessions.
    expect(resolveEffectiveSharedContextRuntimeConfig(baseAuto, {
      sessionAgentType: 'shell',
      activeSessionAgentTypes: ['qwen', 'claude-code-sdk'],
    })).toMatchObject({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'haiku',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-6-luna',
    });

    // No second mapped backend + primary equals default backup (codex-sdk) -> backup cleared to avoid retrying codex-sdk twice.
    expect(resolveEffectiveSharedContextRuntimeConfig(baseAuto, {
      sessionAgentType: 'codex',
      activeSessionAgentTypes: ['codex-sdk', 'shell'],
    })).toMatchObject({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-6-luna',
      backupContextBackend: undefined,
      backupContextModel: undefined,
    });

    // No mapped agents at all -> default codex-sdk + gpt-6-luna with no duplicate backup.
    expect(resolveEffectiveSharedContextRuntimeConfig(baseAuto, {
      sessionAgentType: 'gemini',
      activeSessionAgentTypes: ['qwen'],
    })).toMatchObject({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-6-luna',
      backupContextBackend: undefined,
      backupContextModel: undefined,
    });

    // Manual mode strictly preserves user's configured backend/model/preset.
    const manualConfig = normalizeSharedContextRuntimeConfig({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M3',
      primaryContextPreset: 'minimax',
      backupContextBackend: 'opencode-sdk',
      backupContextModel: 'anthropic/claude-sonnet-4-6',
    });
    expect(resolveEffectiveSharedContextRuntimeConfig(manualConfig, {
      sessionAgentType: 'agy-sdk',
      activeSessionAgentTypes: ['codex-sdk'],
    })).toEqual(manualConfig);
  });
});
