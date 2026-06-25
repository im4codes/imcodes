import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_MODEL_IDS, GEMINI_MODEL_IDS, mergeModelSuggestions, normalizeClaudeCodeModelId } from '../../src/shared/models/options.js';

describe('normalizeClaudeCodeModelId', () => {
  it('maps opus alias to opus[1M]', () => {
    expect(normalizeClaudeCodeModelId('opus')).toBe('opus[1M]');
  });

  it('keeps explicit supported model ids', () => {
    expect(normalizeClaudeCodeModelId('opus[1M]')).toBe('opus[1M]');
    expect(normalizeClaudeCodeModelId('sonnet')).toBe('sonnet');
    expect(normalizeClaudeCodeModelId('haiku')).toBe('haiku');
  });

  it('maps version-bearing / full Claude ids to their canonical option by family', () => {
    expect(normalizeClaudeCodeModelId('claude-opus-4-8[1m]')).toBe('opus[1M]');
    expect(normalizeClaudeCodeModelId('claude-opus-4-8')).toBe('opus[1M]');
    expect(normalizeClaudeCodeModelId('claude-3-5-sonnet-20241022')).toBe('sonnet');
    expect(normalizeClaudeCodeModelId('claude-haiku-4')).toBe('haiku');
  });

  it('maps Claude Fable 5 / Mythos 5 to the fable picker option', () => {
    expect(normalizeClaudeCodeModelId('fable')).toBe('fable');
    expect(normalizeClaudeCodeModelId('claude-fable-5')).toBe('fable');
    expect(normalizeClaudeCodeModelId('claude-fable-5-20260609')).toBe('fable');
    expect(normalizeClaudeCodeModelId('claude-mythos-5')).toBe('fable');
  });

  it('rejects unknown values', () => {
    expect(normalizeClaudeCodeModelId('')).toBeUndefined();
    expect(normalizeClaudeCodeModelId('foo')).toBeUndefined();
  });
});

describe('CLAUDE_CODE_MODEL_IDS', () => {
  it('lists fable (Mythos-class) first as the top-tier option', () => {
    expect(CLAUDE_CODE_MODEL_IDS[0]).toBe('fable');
    expect(CLAUDE_CODE_MODEL_IDS).toContain('opus[1M]');
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
