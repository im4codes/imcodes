import { describe, it, expect } from 'vitest';
import { shortModelLabel, bestModelLabel } from '../src/model-label.js';

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
    expect(shortModelLabel('claude-fable-5-20260609')).toBe('fable-5');
    expect(shortModelLabel('claude-mythos-5')).toBe('mythos-5');
    expect(shortModelLabel('fable')).toBe('fable');
  });

  it('preserves Qwen and compatible provider model labels', () => {
    expect(shortModelLabel('coder-model')).toBe('coder-model');
    expect(shortModelLabel('qwen3-coder-next')).toBe('qwen3-coder-next');
    expect(shortModelLabel('glm-4.7')).toBe('glm-4.7');
    expect(shortModelLabel('kimi-k2.5')).toBe('kimi-k2.5');
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

  it('falls back to the first non-empty label when none have a version', () => {
    expect(bestModelLabel('opus[1M]', undefined)).toBe('opus');
    expect(bestModelLabel(null, 'opus[1M]')).toBe('opus');
    expect(bestModelLabel(null, undefined)).toBeNull();
  });
});
