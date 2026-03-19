import { describe, it, expect } from 'vitest';
import { inferContextWindow, resolveContextWindow } from '../src/model-context.js';

describe('web model context resolution', () => {
  it('resolves GPT-5.4 to 1.05M', () => {
    expect(resolveContextWindow(undefined, 'gpt-5.4')).toBe(1_050_000);
  });

  it('resolves GPT-5.x pre-5.4 families to 400k', () => {
    expect(inferContextWindow('gpt-5.1')).toBe(400_000);
    expect(inferContextWindow('gpt-5.2-codex')).toBe(400_000);
  });
});
