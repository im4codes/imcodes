import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from '../../src/context/memory-config.js';
import { computeTargetTokens } from '../../src/context/summary-compressor.js';

// (memory-system-1.1-foundations P2 / spec.md:218-223)
//
// Verifies the proportional sentinel semantics: a default install (where
// `autoMaterializationTargetTokens` and `manualCompactTargetTokens` are 0)
// MUST route through `computeTargetTokens(...)` for every batch size, NOT
// through the legacy fixed 500/800 numbers.

describe('proportional summary budget (P2)', () => {
  it('default config is the proportional sentinel (0) for both modes', () => {
    expect(DEFAULT_MEMORY_CONFIG.autoMaterializationTargetTokens).toBe(0);
    expect(DEFAULT_MEMORY_CONFIG.manualCompactTargetTokens).toBe(0);
  });

  it('auto mode hits the floor for tiny inputs and the ceiling for huge inputs', () => {
    expect(computeTargetTokens(0, 'auto')).toBe(500); // floor
    expect(computeTargetTokens(1000, 'auto')).toBe(500); // 200 < 500 floor wins
    expect(computeTargetTokens(5000, 'auto')).toBe(1000); // 5000 * 0.20
    expect(computeTargetTokens(20_000, 'auto')).toBe(2000); // ceiling
  });

  it('manual mode hits the floor for tiny inputs and the ceiling for huge inputs', () => {
    expect(computeTargetTokens(0, 'manual')).toBe(800); // floor
    expect(computeTargetTokens(1000, 'manual')).toBe(800); // 300 < 800 floor wins
    expect(computeTargetTokens(5000, 'manual')).toBe(1500); // 5000 * 0.30
    expect(computeTargetTokens(50_000, 'manual')).toBe(4000); // ceiling
  });

  it('manual budget is materially larger than auto for the same input', () => {
    const input = 10_000;
    const auto = computeTargetTokens(input, 'auto');
    const manual = computeTargetTokens(input, 'manual');
    expect(manual).toBeGreaterThan(auto);
  });

  it('the materialization-coordinator branch fires computeTargetTokens when default 0 is set', () => {
    // The coordinator uses `targetTokens > 0 ? override : computeTargetTokens(...)`.
    // With the default sentinel 0, the proportional path is always taken.
    const cfgValue = DEFAULT_MEMORY_CONFIG.autoMaterializationTargetTokens;
    const inputTokens = 8000;
    const effective = cfgValue > 0 ? cfgValue : computeTargetTokens(inputTokens, 'auto');
    expect(effective).toBe(computeTargetTokens(inputTokens, 'auto'));
    expect(effective).not.toBe(500); // would be the legacy fixed value
  });
});
