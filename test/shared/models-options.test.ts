import { describe, expect, it } from 'vitest';
import { normalizeClaudeCodeModelId } from '../../src/shared/models/options.js';

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
