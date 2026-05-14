import { describe, expect, it } from 'vitest';
import {
  CODEX_MODEL_IDS,
  DEFAULT_CODEX_MODEL_ID,
  GEMINI_MODEL_IDS,
  mergeModelSuggestions,
  normalizeClaudeCodeModelId,
  normalizeCodexSdkModelSuggestion,
  sanitizeCodexSdkRequestedModel,
} from '../../src/shared/models/options.js';

describe('normalizeClaudeCodeModelId', () => {
  it('maps opus alias to opus[1M]', () => {
    expect(normalizeClaudeCodeModelId('opus')).toBe('opus[1M]');
  });

  it('keeps explicit supported model ids', () => {
    expect(normalizeClaudeCodeModelId('opus[1M]')).toBe('opus[1M]');
    expect(normalizeClaudeCodeModelId('sonnet')).toBe('sonnet');
    expect(normalizeClaudeCodeModelId('haiku')).toBe('haiku');
  });

  it('rejects unknown values', () => {
    expect(normalizeClaudeCodeModelId('')).toBeUndefined();
    expect(normalizeClaudeCodeModelId('foo')).toBeUndefined();
  });
});

describe('gemini model options', () => {
  it('includes auto as the first Gemini SDK option', () => {
    expect(GEMINI_MODEL_IDS[0]).toBe('auto');
  });
});

describe('codex model options', () => {
  it('uses gpt-5.5 as the static Codex SDK default', () => {
    expect(DEFAULT_CODEX_MODEL_ID).toBe('gpt-5.5');
    expect(CODEX_MODEL_IDS[0]).toBe(DEFAULT_CODEX_MODEL_ID);
  });

  it('prevents Claude-family model ids from being used for Codex SDK launches', () => {
    expect(sanitizeCodexSdkRequestedModel('opus')).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(sanitizeCodexSdkRequestedModel('opus[1M]')).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(sanitizeCodexSdkRequestedModel('opus-4.1')).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(sanitizeCodexSdkRequestedModel('claude-sonnet-4.6')).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(sanitizeCodexSdkRequestedModel('sonnet')).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(sanitizeCodexSdkRequestedModel('')).toBeUndefined();
    expect(sanitizeCodexSdkRequestedModel('gpt-5.6')).toBe('gpt-5.6');
  });

  it('drops forbidden Codex SDK suggestions instead of rendering them', () => {
    expect(normalizeCodexSdkModelSuggestion('opus')).toBeUndefined();
    expect(normalizeCodexSdkModelSuggestion('claude-opus-4-1')).toBeUndefined();
    expect(normalizeCodexSdkModelSuggestion(' gpt-5.5 ')).toBe('gpt-5.5');
  });
});

describe('mergeModelSuggestions', () => {
  it('preserves first-seen order and removes duplicates', () => {
    expect(mergeModelSuggestions(['auto', 'gemini-2.5-pro'], ['gemini-2.5-pro', 'gemini-3'])).toEqual([
      'auto',
      'gemini-2.5-pro',
      'gemini-3',
    ]);
  });
});
