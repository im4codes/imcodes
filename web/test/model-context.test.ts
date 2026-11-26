import { describe, it, expect } from 'vitest';
import { inferContextWindow, resolveContextWindow } from '../src/model-context.js';

describe('web model context resolution', () => {
  it('resolves GPT-5.5 to API input-budget 922k', () => {
    expect(inferContextWindow('gpt-5.5')).toBe(922_000);
    expect(inferContextWindow('gpt5.5')).toBe(922_000);
    expect(inferContextWindow('GPT-5.5 (high)')).toBe(922_000);
    expect(resolveContextWindow(400_000, 'gpt-5.5')).toBe(922_000);
  });

  it('resolves GPT-5.4 to 1M', () => {
    expect(resolveContextWindow(undefined, 'gpt-5.4')).toBe(1_000_000);
  });

  it('resolves claude sonnet 4 and 5 family to 1M', () => {
    expect(inferContextWindow('sonnet')).toBe(1_000_000);
    expect(resolveContextWindow(200_000, 'claude-sonnet-4-6')).toBe(1_000_000);
    expect(inferContextWindow('claude-sonnet-5-5-high')).toBe(1_000_000);
  });

  it('resolves claude opus 4 and 5 family to 1M', () => {
    expect(inferContextWindow('claude-opus-4-1')).toBe(1_000_000);
    expect(resolveContextWindow(200_000, 'claude-opus-4-6')).toBe(1_000_000);
    expect(inferContextWindow('claude-opus-5-5-high')).toBe(1_000_000);
  });

  it('resolves gemini flash to 1M and pro to 2M', () => {
    expect(inferContextWindow('flash')).toBe(1_000_000);
    expect(inferContextWindow('gemini-3.8-flash-high')).toBe(1_000_000);
    expect(inferContextWindow('gemini-4-argon-medium')).toBe(1_000_000);
    expect(inferContextWindow('gemini-4-argon-low')).toBe(1_000_000);
    expect(inferContextWindow('pro')).toBe(2_000_000);
    expect(inferContextWindow('gemini-3.8-pro')).toBe(2_000_000);
  });

  it('resolves GPT-5.x pre-5.4 families to 400k', () => {
    expect(inferContextWindow('gpt-5.1')).toBe(400_000);
    expect(inferContextWindow('gpt-5.2-codex')).toBe(400_000);
  });

  it('honors provider-sourced explicit context windows when requested', () => {
    expect(resolveContextWindow(258_400, 'gpt-5.4-mini', 1_000_000, { preferExplicit: true })).toBe(258_400);
  });

  it('honors provider-sourced explicit context windows for GPT-5.5', () => {
    expect(resolveContextWindow(258_400, 'gpt-5.5', 1_000_000, { preferExplicit: true })).toBe(258_400);
    expect(resolveContextWindow(1_000_000, 'gpt-5.5', 1_000_000, { preferExplicit: true })).toBe(1_000_000);
  });
});
