import { describe, it, expect } from 'vitest';
import {
  shortModelLabel,
  bestModelLabel,
  subSessionModelPresentation,
  compactSubSessionModelLabel,
} from '../src/model-label.js';

describe('shortModelLabel', () => {
  it('shows the last two parts of any GPT/Codex id, so version and variant both survive', () => {
    expect(shortModelLabel('gpt-5.4')).toBe('gpt-5.4');
    expect(shortModelLabel('gpt-5.4-mini')).toBe('5.4-mini');
    expect(shortModelLabel('gpt-5.4-nano')).toBe('5.4-nano');
    expect(shortModelLabel('gpt-5.4-pro')).toBe('5.4-pro');
    expect(shortModelLabel('gpt-5.2-codex')).toBe('5.2-codex');
    expect(shortModelLabel('gpt-5-mini')).toBe('5-mini');
    expect(shortModelLabel('gpt-5.6-sol')).toBe('5.6-sol');
    expect(shortModelLabel('gpt-5.6-luna')).toBe('5.6-luna');
  });

  it('recognizes GPT-6 and later generations instead of dropping the version', () => {
    expect(shortModelLabel('gpt-6')).toBe('gpt-6');
    expect(shortModelLabel('gpt-6-luna')).toBe('6-luna');
    expect(shortModelLabel('gpt-6.1-sol')).toBe('6.1-sol');
    expect(shortModelLabel('openai/gpt-6-luna')).toBe('6-luna');
  });

  it('keeps GPT-4 family labels stable', () => {
    expect(shortModelLabel('gpt-4o')).toBe('gpt-4o');
    expect(shortModelLabel('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(shortModelLabel('gpt-4.1')).toBe('gpt-4.1');
  });

  it('shows the Claude family with its version, preserves Gemini shorthand', () => {
    expect(shortModelLabel('claude-opus-4-1')).toBe('opus-4.1');
    expect(shortModelLabel('claude-opus-4-8')).toBe('opus-4.8');
    expect(shortModelLabel('claude-opus-4-8-20260514')).toBe('opus-4.8');
    expect(shortModelLabel('claude-sonnet-4-5')).toBe('sonnet-4.5');
    expect(shortModelLabel('claude-3-5-sonnet-20241022')).toBe('sonnet-3.5');
    expect(shortModelLabel('claude-3-opus')).toBe('opus-3');
    expect(shortModelLabel('opus')).toBe('opus');
    expect(shortModelLabel('gemini-3-flash-preview')).toBe('flash');
  });

  it('labels Claude Fable 5 / Mythos 5 (Mythos-class) with their version', () => {
    expect(shortModelLabel('claude-fable-5')).toBe('fable-5');
    expect(shortModelLabel('claude-haiku-5-5')).toBe('haiku-5.5');
    expect(shortModelLabel('claude-haiku-4-5-20251001')).toBe('haiku-4.5');
    expect(shortModelLabel('claude-fable-5-20260609')).toBe('fable-5');
    expect(shortModelLabel('claude-mythos-5')).toBe('mythos-5');
    expect(shortModelLabel('fable')).toBe('fable');
  });

  it('shortens Gemini and other multi-segment model IDs to their last two segments while preserving 2-segment labels', () => {
    expect(shortModelLabel('gemini-4-hydrogen-high')).toBe('hydrogen-high');
    expect(shortModelLabel('gemini-4-argon-high')).toBe('argon-high');
    expect(shortModelLabel('gemini-4-hydrogen-medium')).toBe('hydrogen-medium');
    expect(shortModelLabel('gemini-2.5-pro')).toBe('2.5-pro');
    expect(shortModelLabel('google/gemini-4-hydrogen-high')).toBe('hydrogen-high');
    expect(shortModelLabel('coder-model')).toBe('coder-model');
    expect(shortModelLabel('qwen3-coder-next')).toBe('coder-next');
    expect(shortModelLabel('glm-4.7')).toBe('glm-4.7');
    expect(shortModelLabel('kimi-k2.5')).toBe('kimi-k2.5');
    expect(shortModelLabel('minimax-m2.5-high')).toBe('m2.5-high');
    expect(shortModelLabel('deepseek-v3.2-chat')).toBe('v3.2-chat');
    expect(shortModelLabel('gpt-oss-120b-medium')).toBe('120b-medium');
    expect(shortModelLabel('grok-build')).toBe('grok-build');
    expect(shortModelLabel('grok-build-fast')).toBe('build-fast');
  });

  it('handles null/whitespace, [1m], and trailing date suffixes cleanly', () => {
    expect(shortModelLabel(null)).toBeNull();
    expect(shortModelLabel(undefined)).toBeNull();
    expect(shortModelLabel('')).toBeNull();
    expect(shortModelLabel('   ')).toBeNull();
    expect(shortModelLabel('[1M]')).toBeNull();
    expect(shortModelLabel('gemini-4-hydrogen-high[1m]')).toBe('hydrogen-high');
    expect(shortModelLabel('gemini-4-hydrogen-high[1M]')).toBe('hydrogen-high');
    expect(shortModelLabel('gemini-4-hydrogen-high-20260514')).toBe('hydrogen-high');
    expect(shortModelLabel('gemini-4-hydrogen-high-2024-08-06')).toBe('hydrogen-high');
    expect(shortModelLabel('gpt-5.4-mini-20260514')).toBe('5.4-mini');
  });
});

describe('bestModelLabel', () => {
  it('prefers a version-bearing label over a bare alias', () => {
    // Configured alias has no version, usage event carries the resolved id.
    expect(bestModelLabel('opus[1M]', 'claude-opus-4-8')).toBe('opus-4.8');
    expect(bestModelLabel('opus[1M]', 'claude-opus-4-8[1m]')).toBe('opus-4.8');
  });

  it('keeps the first candidate when it already carries a version', () => {
    expect(bestModelLabel('gpt-5.5', 'gpt-5.4')).toBe('gpt-5.5');
    expect(bestModelLabel('claude-opus-4-8', 'opus[1M]')).toBe('opus-4.8');
  });

  it('preserves pre-cap version priority across multi-segment and bare-alias candidates', () => {
    expect(bestModelLabel('gemini-4-hydrogen-high', 'gemini-2.5-pro')).toBe('hydrogen-high');
    expect(bestModelLabel('auto', 'gemini-4-hydrogen-high')).toBe('hydrogen-high');
    expect(bestModelLabel('qwen3-coder-next', 'glm-4.7')).toBe('coder-next');
    expect(bestModelLabel('deepseek-v3-beta-fast', 'gpt-5.4')).toBe('beta-fast');
    expect(bestModelLabel('gemini-3.8-flash-high', 'gpt-5.4')).toBe('flash');
    expect(bestModelLabel('opus-20260514', 'claude-opus-4-8')).toBe('opus-4.8');
    expect(subSessionModelPresentation('gemini-4-hydrogen-high', 'gemini-2.5-pro')).toEqual({
      label: 'hydrogen-high',
      title: 'gemini-4-hydrogen-high · gemini-2.5-pro',
    });
    expect(subSessionModelPresentation('auto', 'gemini-4-hydrogen-high')).toEqual({
      label: 'hydrogen-high',
      title: 'auto · gemini-4-hydrogen-high',
    });
    expect(subSessionModelPresentation('qwen3-coder-next', 'glm-4.7')).toEqual({
      label: 'coder-next',
      title: 'qwen3-coder-next · glm-4.7',
    });
  });

  it('falls back to the first non-empty label when none have a version', () => {
    expect(bestModelLabel('opus[1M]', undefined)).toBe('opus');
    expect(bestModelLabel(null, 'opus[1M]')).toBe('opus');
    expect(bestModelLabel(null, undefined)).toBeNull();
  });
});

describe('subSessionModelPresentation', () => {
  it.each([
    [undefined, null], [null, null], ['', null], ['   ', null],
    ['opus', 'opus'], ['opus-4.8', 'opus-4.8'], ['flash', 'flash'],
    ['gemini-4-argon-high', 'argon-high'], ['gpt-6.1-sol', '6.1-sol'],
    ['gemini-3-flash-preview', 'flash'], ['gpt-4o', 'gpt-4o'],
    ['qwen3-coder-next', 'coder-next'], ['glm-4.7', 'glm-4.7'],
    ['kimi-k2.5', 'kimi-k2.5'], ['minimax-m2.5-high', 'm2.5-high'],
  ])('caps only the final display label for %s', (model, label) => {
    expect(subSessionModelPresentation(model).label).toBe(label);
  });

  it('keeps full candidates in the tooltip and leaves existing labels/priority unchanged', () => {
    expect(subSessionModelPresentation('opus[1M]', 'claude-opus-4-8')).toEqual({
      label: 'opus-4.8', title: 'opus[1M] · claude-opus-4-8',
    });
    expect(subSessionModelPresentation(' gemini-4-argon-high ', 'gemini-4-argon-high').title).toBe('gemini-4-argon-high');
    expect(subSessionModelPresentation(null, 'gemini-4-argon-high').label).toBe('argon-high');
    expect(subSessionModelPresentation('gpt-6.1-sol', 'gpt-5.4-mini').label).toBe('6.1-sol');
    expect(subSessionModelPresentation(null, '')).toEqual({ label: null, title: undefined });
    // Non-sub-session consumers also get the shortened last-two-segments label.
    expect(bestModelLabel('gemini-4-hydrogen-high')).toBe('hydrogen-high');
    expect(bestModelLabel('gemini-4-argon-high')).toBe('argon-high');
    expect(bestModelLabel('qwen3-coder-next')).toBe('coder-next');
  });
});

describe('compactSubSessionModelLabel', () => {
  it('returns null for empty inputs and leaves labels within the 54px card budget unchanged', () => {
    expect(compactSubSessionModelLabel(null)).toBeNull();
    expect(compactSubSessionModelLabel(undefined)).toBeNull();
    expect(compactSubSessionModelLabel('')).toBeNull();
    expect(compactSubSessionModelLabel('   ')).toBeNull();
    for (const shortLabel of ['a', 'flash', 'gpt-5.4', 'glm-4.7', '6.1-sol', 'opus-4.8', 'beta-fast', 'v3.2-chat', 'm2.5-high']) {
      expect(compactSubSessionModelLabel(shortLabel)).toBe(shortLabel);
    }
  });

  it('shortens long word segments with middle dots while preserving suffixes and version numbers', () => {
    expect(compactSubSessionModelLabel('hydrogen-high')).toBe('hy.n-high');
    expect(compactSubSessionModelLabel('argon-high')).toBe('ar.n-high');
    expect(compactSubSessionModelLabel('coder-next')).toBe('co.r-next');
    expect(compactSubSessionModelLabel('5.4-preview')).toBe('5.4-pr.ew');
    expect(compactSubSessionModelLabel('sonnet-4.6')).toBe('so.et-4.6');
    expect(compactSubSessionModelLabel('hydrogen-medium')).toBe('hy.n-me.m');
  });

  it('elides single long words and multi-segment fallbacks cleanly to fit maxLength', () => {
    expect(compactSubSessionModelLabel('supercalifragilistic')).toBe('supe.stic');
    expect(compactSubSessionModelLabel('qwen3-coder-next')).toBe('qwen.next');
    expect(compactSubSessionModelLabel('deepseek-v3-beta-fast')).toBe('deep.fast');
    expect(compactSubSessionModelLabel('claude-sonnet-4.6')).toBe('clau.-4.6');
    expect(compactSubSessionModelLabel('alpha_omega_gamma')).toBe('alph.amma');
    expect(compactSubSessionModelLabel('abcdef', 0)).toBe('');
    expect(compactSubSessionModelLabel('abcdef', 1)).toBe('.');
    expect(compactSubSessionModelLabel('abcdef', 2)).toBe('a.');
    expect(compactSubSessionModelLabel('abcdef', 5)?.length).toBeLessThanOrEqual(5);
  });

  it('does not alter subSessionModelPresentation or bestModelLabel outputs used by UsageFooter', () => {
    expect(subSessionModelPresentation('gemini-4-hydrogen-high')).toEqual({
      label: 'hydrogen-high',
      title: 'gemini-4-hydrogen-high',
    });
    expect(bestModelLabel('gemini-4-hydrogen-high')).toBe('hydrogen-high');
  });
});
