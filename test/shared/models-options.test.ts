import { describe, expect, it } from 'vitest';
import { AGY_FALLBACK_MODEL_IDS, isAgyModelId } from '../../shared/agy-agent.js';
import { AGY_MODEL_IDS, CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS, DEFAULT_CODEX_SESSION_MODEL, GEMINI_MODEL_IDS, looksLikeCodexModelId, mergeModelSuggestions, normalizeClaudeCodeModelId } from '../../src/shared/models/options.js';

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
    expect(normalizeClaudeCodeModelId('claude-haiku-5-5')).toBe('haiku');
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

// Backend identifiers are not literal launchable model ids.
describe('provider model classification', () => {
  it.each(['codex-sdk', 'CODEX-SDK', ' codex-sdk '])('rejects bare backend %s as a Codex model', (model) => {
    expect(looksLikeCodexModelId(model)).toBe(false);
  });
  it.each(['codex-mini-latest', 'gpt-6.2-sol'])('keeps real Codex model %s', (model) => {
    expect(looksLikeCodexModelId(model)).toBe(true);
  });
  it('includes gpt-6.2-sol in CODEX_MODEL_IDS while preserving the default Codex session model first', () => {
    expect(CODEX_MODEL_IDS[0]).toBe(DEFAULT_CODEX_SESSION_MODEL);
    expect(CODEX_MODEL_IDS).toContain('gpt-6.2-sol');
  });
  it.each(['high', 'medium', 'low'])('includes Carbon %s in both AGY catalogs', (tier) => {
    const model = `gemini-4-carbon-${tier}`;
    expect(AGY_MODEL_IDS).toContain(model);
    expect(AGY_FALLBACK_MODEL_IDS).toContain(model);
    expect(isAgyModelId(model)).toBe(true);
    expect(isAgyModelId(`gemini-carbon-${tier}`)).toBe(true);
  });
});
