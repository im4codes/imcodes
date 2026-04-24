import { describe, expect, it } from 'vitest';
import { GEMINI_MODEL_IDS, mergeModelSuggestions, normalizeClaudeCodeModelId } from '../../src/shared/models/options.js';

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

describe('mergeModelSuggestions', () => {
  it('preserves first-seen order and removes duplicates', () => {
    expect(mergeModelSuggestions(['auto', 'gemini-2.5-pro'], ['gemini-2.5-pro', 'gemini-3'])).toEqual([
      'auto',
      'gemini-2.5-pro',
      'gemini-3',
    ]);
  });
});
