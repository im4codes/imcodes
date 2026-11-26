/**
 * The counter store had no test at all, and it had already silently drifted into
 * two copies with different APIs. These tests pin the two properties that matter:
 * the cardinality cap actually holds, and the daemon/server entry points are the
 * SAME store rather than two that merely look alike.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  addCounter,
  counterKeyCount,
  getCounter,
  incrementCounter,
  resetMetricsForTests,
  snapshotCounters,
} from '../../shared/metrics.js';
import * as daemonMetrics from '../../src/util/metrics.js';

describe('shared metrics store', () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it('counts per name+labels combination, order-independently', () => {
    incrementCounter('a.b', { x: '1', y: '2' });
    incrementCounter('a.b', { y: '2', x: '1' });
    expect(getCounter('a.b', { x: '1', y: '2' })).toBe(2);
    // A different label value is a different series, not the same counter.
    expect(getCounter('a.b', { x: '9', y: '2' })).toBe(0);
    expect(getCounter('a.b')).toBe(0);
  });

  it('ignores non-positive and non-finite amounts instead of corrupting a total', () => {
    addCounter('c', 5);
    addCounter('c', 0);
    addCounter('c', -3);
    addCounter('c', Number.NaN);
    addCounter('c', Number.POSITIVE_INFINITY);
    expect(getCounter('c')).toBe(5);
  });

  it('caps distinct keys at 10k, but keeps counting keys it already knows', () => {
    for (let i = 0; i < 10_000; i++) incrementCounter('bulk', { i: String(i) });
    expect(counterKeyCount()).toBe(10_000);

    // Past the cap a NEW key is dropped...
    incrementCounter('bulk', { i: 'overflow' });
    expect(getCounter('bulk', { i: 'overflow' })).toBe(0);
    expect(counterKeyCount()).toBe(10_000);

    // ...while an EXISTING key still accumulates, so established series do not
    // freeze just because something noisy filled the map.
    incrementCounter('bulk', { i: '0' });
    expect(getCounter('bulk', { i: '0' })).toBe(2);
  });

  it('exposes the daemon entry point as the same store, not a second copy', () => {
    // The drift that motivated consolidation: two modules with one API each.
    daemonMetrics.incrementCounter('shared.store.check');
    expect(getCounter('shared.store.check')).toBe(1);
    expect(daemonMetrics.getCounter('shared.store.check')).toBe(1);
    expect(typeof daemonMetrics.addCounter).toBe('function');
  });

  it('snapshots as a plain object and is fully cleared by the test reset', () => {
    incrementCounter('snap', { k: 'v' });
    expect(snapshotCounters()).toEqual({ 'snap{k=v}': 1 });
    resetMetricsForTests();
    expect(snapshotCounters()).toEqual({});
    expect(counterKeyCount()).toBe(0);
  });
});
