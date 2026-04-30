import { afterEach, describe, expect, it } from 'vitest';
import { incrementCounter, getCounter, resetMetricsForTests } from '../../src/util/metrics.js';
import { resetRateLimitedWarnForTests, warnOncePerHour } from '../../src/util/rate-limited-warn.js';

describe('rate-limited diagnostics', () => {
  afterEach(() => {
    resetRateLimitedWarnForTests();
    resetMetricsForTests();
  });

  it('emits a warn at most once per signature/hour while counters increment every time', () => {
    const t0 = 1_700_000_000_000;
    incrementCounter('mem.test');
    expect(warnOncePerHour('sig-a', {}, t0)).toBe(true);
    incrementCounter('mem.test');
    expect(warnOncePerHour('sig-a', {}, t0 + 1000)).toBe(false);
    incrementCounter('mem.test');
    expect(warnOncePerHour('sig-b', {}, t0 + 1000)).toBe(true);
    expect(warnOncePerHour('sig-a', {}, t0 + 3_600_000)).toBe(true);
    expect(getCounter('mem.test')).toBe(3);
  });
});
