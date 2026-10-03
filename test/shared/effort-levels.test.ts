import { describe, expect, it } from 'vitest';
import {
  CODEX_SDK_EFFORT_LEVELS,
  clampTransportEffort,
  normalizeSupportedEffortLevels,
} from '../../shared/effort-levels.js';

describe('provider reasoning effort metadata', () => {
  it('normalizes provider levels without inventing or reordering them', () => {
    expect(normalizeSupportedEffortLevels(['low', 'ultra', 'bogus', 'low', 'max']))
      .toEqual(['low', 'ultra', 'max']);
    expect(normalizeSupportedEffortLevels(undefined)).toBeUndefined();
  });

  it('keeps Max in the Codex fallback while omitting unsupported Minimal', () => {
    expect(CODEX_SDK_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('clamps a persisted effort to the nearest level after a model switch', () => {
    expect(clampTransportEffort('ultra', ['low', 'high', 'max'])).toBe('max');
    expect(clampTransportEffort('medium', ['low', 'high'])).toBe('low');
    expect(clampTransportEffort('max', ['low', 'high', 'max'])).toBe('max');
  });
});
