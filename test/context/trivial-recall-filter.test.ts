/**
 * Trivial recall filter tests.
 *
 * Protects against pollution where single-word continuation queries
 * ("continue", "继续", "好", "ok", ...) return irrelevant top matches.
 * Language-agnostic via token count + content-char thresholds.
 */
import { describe, it, expect } from 'vitest';
import { isTrivialRecallQuery, isP2pOrchestrationPrompt } from '../../src/context/memory-search.js';

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

  describe('P2P orchestration prompts (should skip)', () => {
    it('detects [Round N/M] round header', () => {
      const prompt = '[Round 1/3 — Audit Phase — Initial Analysis] Provide your analysis.';
      expect(isP2pOrchestrationPrompt(prompt)).toBe(true);
      expect(isTrivialRecallQuery(prompt)).toBe(true);
    });

    it('detects [P2P Discussion Task — run XXX]', () => {
      const prompt = 'Work on [P2P Discussion Task — run 6e5f4c30-b3b] carefully.';
      expect(isP2pOrchestrationPrompt(prompt)).toBe(true);
      expect(isTrivialRecallQuery(prompt)).toBe(true);
    });

    it('detects identity assignment phrase', () => {
      const prompt = 'Your identity for this discussion run is "abc:codex-sdk".';
      expect(isP2pOrchestrationPrompt(prompt)).toBe(true);
    });

    it('detects .imc/discussions path reference', () => {
      const prompt = 'Append to /Users/k/project/.imc/discussions/6e5f4c30-b3b.md now.';
      expect(isP2pOrchestrationPrompt(prompt)).toBe(true);
    });

    it('does not flag unrelated text mentioning rounds or P2P', () => {
      expect(isP2pOrchestrationPrompt('How does P2P work?')).toBe(false);
      expect(isP2pOrchestrationPrompt('Round up the results.')).toBe(false);
      expect(isP2pOrchestrationPrompt('Going for round 2')).toBe(false);
    });
  });
});
