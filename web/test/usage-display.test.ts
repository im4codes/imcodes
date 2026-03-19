import { describe, it, expect } from 'vitest';
import { resolveContextWindow } from '../src/model-context.js';
import { shortModelLabel } from '../src/model-label.js';

function usageSummary(inputTokens: number, cacheTokens: number, contextWindow: number | undefined, model?: string) {
  const ctx = resolveContextWindow(contextWindow, model);
  const total = inputTokens + cacheTokens;
  const totalPct = Math.min(100, total / ctx * 100);
  const pctStr = totalPct < 1 ? totalPct.toFixed(1) : totalPct.toFixed(0);
  return { ctx, total, pctStr, label: shortModelLabel(model) };
}

describe('usage display behavior', () => {
  it('uses 1.05M context for gpt-5.4 even when explicit context is stale', () => {
    const view = usageSummary(210_000, 105_000, 400_000, 'gpt-5.4');
    expect(view.ctx).toBe(1_050_000);
    expect(view.pctStr).toBe('30');
  });

  it('uses 400k context for gpt-5.2-codex', () => {
    const view = usageSummary(120_000, 80_000, undefined, 'gpt-5.2-codex');
    expect(view.ctx).toBe(400_000);
    expect(view.pctStr).toBe('50');
  });

  it('uses 1M context for gpt-4.1', () => {
    const view = usageSummary(250_000, 250_000, undefined, 'gpt-4.1');
    expect(view.ctx).toBe(1_000_000);
    expect(view.pctStr).toBe('50');
  });

  it('keeps model labels consistent across GPT-5.4 variants', () => {
    expect(usageSummary(1, 1, undefined, 'gpt-5.4').label).toBe('gpt-5.4');
    expect(usageSummary(1, 1, undefined, 'gpt-5.4-mini').label).toBe('gpt-5.4-mini');
    expect(usageSummary(1, 1, undefined, 'gpt-5.4-pro').label).toBe('gpt-5.4-pro');
  });
});
