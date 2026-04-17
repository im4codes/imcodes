/**
 * Trivial recall filter tests.
 *
 * Protects against pollution where single-word continuation queries
 * ("continue", "继续", "好", "ok", ...) return irrelevant top matches.
 * Language-agnostic via token count + content-char thresholds.
 */
import { describe, it, expect } from 'vitest';
import { isTrivialRecallQuery } from '../../src/context/memory-search.js';

describe('isTrivialRecallQuery', () => {
  describe('trivial (should skip recall)', () => {
    it.each([
      // English single words / common continuations
      ['continue'],
      ['ok'],
      ['yes'],
      ['go'],
      ['next'],
      ['done'],
      ['proceed'],
      // Chinese continuations
      ['继续'],
      ['好'],
      ['好的'],
      ['对'],
      ['嗯'],
      ['是'],
      ['行'],
      // Japanese
      ['はい'],
      ['次'],
      // Korean
      ['네'],
      // Russian
      ['да'],
      // Spanish
      ['si'],
      // Empty / whitespace / punctuation
      [''],
      ['   '],
      ['?'],
      ['。'],
      ['!!'],
      // Single emoji
      ['👍'],
      // Very short
      ['ab'],
    ])('skips query: %s', (input) => {
      expect(isTrivialRecallQuery(input)).toBe(true);
    });

    it('treats null/undefined as trivial', () => {
      expect(isTrivialRecallQuery(null)).toBe(true);
      expect(isTrivialRecallQuery(undefined)).toBe(true);
    });
  });

  describe('non-trivial (should recall)', () => {
    it.each([
      ['fix CSRF bug'],
      ['修复登录问题'],
      ['add iOS support'],
      ['continue implementing the feature'],
      ['好的，我们下一步做什么'],
      ['how to handle auth'],
      ['はい、次のステップは'],
    ])('runs recall for: %s', (input) => {
      expect(isTrivialRecallQuery(input)).toBe(false);
    });
  });
});
