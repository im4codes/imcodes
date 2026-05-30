import { describe, it, expect } from 'vitest';
import { shortModelLabel, bestModelLabel } from '../src/model-label.js';

describe('shortModelLabel', () => {
  it('normalizes GPT-5.4 family labels', () => {
    expect(shortModelLabel('gpt-5.4')).toBe('gpt-5.4');
    expect(shortModelLabel('gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(shortModelLabel('gpt-5.4-nano')).toBe('gpt-5.4-nano');
    expect(shortModelLabel('gpt-5.4-pro')).toBe('gpt-5.4-pro');
  });

  it('keeps older GPT-5/Codex family names stable', () => {
    expect(shortModelLabel('gpt-5.2-codex')).toBe('gpt-5.2-codex');
    expect(shortModelLabel('gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(shortModelLabel('gpt-5-mini')).toBe('gpt-5-mini');
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
