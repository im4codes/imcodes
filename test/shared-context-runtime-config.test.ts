import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_SCORING_WEIGHTS,
  DEFAULT_MEMORY_RECALL_MIN_SCORE,
  getDefaultSharedContextModelForBackend,
  normalizeMemoryScoringWeights,
  normalizeMemoryRecallMinScore,
  normalizeSharedContextRuntimeConfig,
} from '../shared/shared-context-runtime-config.js';

describe('shared-context-runtime-config', () => {
  it('uses backend-specific defaults when model is missing', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
    });
    expect(result.primaryContextBackend).toBe('qwen');
    expect(result.primaryContextModel).toBe(getDefaultSharedContextModelForBackend('qwen'));
    expect(result.backupContextBackend).toBeUndefined();
    expect(result.backupContextModel).toBeUndefined();
    expect(result.memoryRecallMinScore).toBe(DEFAULT_MEMORY_RECALL_MIN_SCORE);
    expect(result.memoryScoringWeights).toEqual(DEFAULT_MEMORY_SCORING_WEIGHTS);
    expect(result.enablePersonalMemorySync).toBe(false);
  });

  it('replaces incompatible saved models with the backend default', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'haiku',
    });
    expect(result.primaryContextBackend).toBe('qwen');
    expect(result.primaryContextModel).toBe(getDefaultSharedContextModelForBackend('qwen'));
    expect(result.backupContextBackend).toBe('codex-sdk');
    expect(result.backupContextModel).toBe(getDefaultSharedContextModelForBackend('codex-sdk'));
  });

  it('keeps a configured backup backend by filling its default model when the model is omitted', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'qwen',
    });
    expect(result.primaryContextBackend).toBe('claude-code-sdk');
    expect(result.primaryContextModel).toBe('sonnet');
    expect(result.backupContextBackend).toBe('qwen');
    expect(result.backupContextModel).toBe(getDefaultSharedContextModelForBackend('qwen'));
  });

  it('passes through primaryContextSdk and backupContextSdk when provided', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextSdk: 'anthropic-sdk',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-4.1-mini',
      backupContextSdk: 'openai-sdk',
    });
    expect(result.primaryContextSdk).toBe('anthropic-sdk');
    expect(result.backupContextSdk).toBe('openai-sdk');
  });

  it('passes through primaryContextPreset and backupContextPreset when provided', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'custom-qwen-model',
      primaryContextPreset: 'Qwen Team',
      backupContextBackend: 'qwen',
      backupContextModel: 'custom-qwen-backup-model',
      backupContextPreset: 'Qwen Backup',
    });
    expect(result.primaryContextModel).toBe('custom-qwen-model');
    expect(result.backupContextModel).toBe('custom-qwen-backup-model');
    expect(result.primaryContextPreset).toBe('Qwen Team');
    expect(result.backupContextPreset).toBe('Qwen Backup');
  });

  it('drops preset selections for backends that do not support presets', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      primaryContextPreset: 'Should Not Persist',
      backupContextBackend: 'claude-code-sdk',
      backupContextModel: 'haiku',
      backupContextPreset: 'Also Ignored',
    });
    expect(result.primaryContextPreset).toBeUndefined();
    expect(result.backupContextPreset).toBeUndefined();
  });

  it('omits sdk fields when not provided', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
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

  it('defaults enablePersonalMemorySync to false when undefined', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
    });
    expect(result.enablePersonalMemorySync).toBe(false);
  });
});
