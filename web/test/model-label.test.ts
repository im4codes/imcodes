import { describe, it, expect } from 'vitest';
import { shortModelLabel } from '../src/model-label.js';

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

  it('preserves Claude/Gemini shorthand behavior', () => {
    expect(shortModelLabel('claude-opus-4-1')).toBe('opus');
    expect(shortModelLabel('gemini-3-flash-preview')).toBe('flash');
  });

  it('preserves Qwen and compatible provider model labels', () => {
    expect(shortModelLabel('coder-model')).toBe('coder-model');
    expect(shortModelLabel('qwen3-coder-next')).toBe('qwen3-coder-next');
    expect(shortModelLabel('glm-4.7')).toBe('glm-4.7');
    expect(shortModelLabel('kimi-k2.5')).toBe('kimi-k2.5');
  });
});
