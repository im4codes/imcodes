import { describe, expect, it } from 'vitest';
import { coreLaneBlockedMs, shouldRequestCoreLaneRestart } from '../../shared/core-lane-liveness.js';

describe('core-lane liveness decisions', () => {
  it('marks a stale main-thread progress sample busy and requests restart at the bound', () => {
    const lastProgress = 1_000;
    expect(coreLaneBlockedMs(31_000, lastProgress)).toBe(30_000);
    expect(shouldRequestCoreLaneRestart(30_999, lastProgress, 30_000)).toBe(false);
    expect(shouldRequestCoreLaneRestart(31_000, lastProgress, 30_000)).toBe(true);
  });

  it('never requests a restart when the kill switch threshold is disabled', () => {
    expect(shouldRequestCoreLaneRestart(999_999, 1, 0)).toBe(false);
    expect(shouldRequestCoreLaneRestart(999_999, 0, 1)).toBe(false);
  });
});
