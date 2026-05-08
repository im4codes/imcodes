import { describe, it, expect } from 'vitest';
import { inferContextWindow, resolveContextWindow } from '../../src/util/model-context.js';

describe('model context inference', () => {
  it('maps GPT-5.5 family to API input-budget 922k context', () => {
    expect(inferContextWindow('gpt-5.5')).toBe(922_000);
    expect(inferContextWindow('gpt5.5')).toBe(922_000);
    expect(inferContextWindow('GPT-5.5 (high)')).toBe(922_000);
    expect(inferContextWindow('gpt-5.5-pro')).toBe(922_000);
    expect(inferContextWindow('gpt-5.5-2026-04-24')).toBe(922_000);
  });

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

  it('maps claude opus family to 1M context', () => {
    expect(inferContextWindow('opus[1M]')).toBe(1_000_000);
    expect(inferContextWindow('claude-opus-4-1')).toBe(1_000_000);
    expect(inferContextWindow('claude-opus-4-6')).toBe(1_000_000);
  });

  it('maps claude sonnet 4 family to 1M context', () => {
    expect(inferContextWindow('sonnet')).toBe(1_000_000);
    expect(inferContextWindow('claude-sonnet-4')).toBe(1_000_000);
    expect(inferContextWindow('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('prefers model mapping over stale explicit fallback values', () => {
    expect(resolveContextWindow(400_000, 'gpt-5.4')).toBe(1_000_000);
    expect(resolveContextWindow(1_000_000, 'gpt-5.5')).toBe(922_000);
    expect(resolveContextWindow(200_000, 'claude-opus-4-1')).toBe(1_000_000);
    expect(resolveContextWindow(200_000, 'claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('honors provider-sourced explicit context windows when requested', () => {
    expect(resolveContextWindow(258_400, 'gpt-5.4-mini', 1_000_000, { preferExplicit: true })).toBe(258_400);
    expect(resolveContextWindow(0, 'gpt-5.4-mini', 1_000_000, { preferExplicit: true })).toBe(1_000_000);
  });

  it('honors provider-sourced explicit context windows for GPT-5.5', () => {
    expect(resolveContextWindow(258_400, 'gpt-5.5', 1_000_000, { preferExplicit: true })).toBe(258_400);
    expect(resolveContextWindow(1_000_000, 'gpt-5.5', 1_000_000, { preferExplicit: true })).toBe(1_000_000);
    expect(resolveContextWindow(258_400, 'gpt-5.5-pro', 1_000_000, { preferExplicit: true })).toBe(258_400);
  });
});
