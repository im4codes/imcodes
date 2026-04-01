import { describe, it, expect } from 'vitest';
import { inferContextWindow, resolveContextWindow } from '../../src/util/model-context.js';

describe('model context inference', () => {
  it('maps GPT-5.4 family to 1M context', () => {
    expect(inferContextWindow('gpt-5.4')).toBe(1_000_000);
    expect(inferContextWindow('gpt-5.4-pro')).toBe(1_000_000);
    expect(inferContextWindow('gpt-5.4-2026-03-01')).toBe(1_000_000);
  });

  it('maps older GPT-5 families to 400k context', () => {
    expect(inferContextWindow('gpt-5')).toBe(400_000);
    expect(inferContextWindow('gpt-5.1')).toBe(400_000);
    expect(inferContextWindow('gpt-5.2-codex')).toBe(400_000);
    expect(inferContextWindow('gpt-5.3-codex')).toBe(400_000);
    expect(inferContextWindow('gpt-5-mini')).toBe(400_000);
  });

  it('maps GPT-4.1 family to 1M context', () => {
    expect(inferContextWindow('gpt-4.1')).toBe(1_000_000);
    expect(inferContextWindow('gpt-4.1-mini')).toBe(1_000_000);
  });

  it('prefers model mapping over stale explicit fallback values', () => {
    expect(resolveContextWindow(400_000, 'gpt-5.4')).toBe(1_000_000);
  });
});
