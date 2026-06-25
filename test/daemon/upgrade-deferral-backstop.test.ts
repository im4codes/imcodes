import { describe, expect, it } from 'vitest';

import { evaluateUpgradeDeferralBackstop } from '../../src/daemon/command-handler.js';

// The session-busy gate prevents a daemon self-upgrade from killing a session
// mid-turn. This tracker measures CONTINUOUS deferral across upgrade attempts
// for observability, but it must never force an upgrade through active work.

describe('evaluateUpgradeDeferralBackstop', () => {
  const MAX = 30 * 60 * 1000; // 30 min

  it('proceeds and clears the tracker when nothing is blocking', () => {
    expect(
      evaluateUpgradeDeferralBackstop({ blocked: false, deferredSince: 123, now: 1_000, maxDeferMs: MAX }),
    ).toEqual({ proceed: true, forced: false, nextDeferredSince: null, deferredMs: 0 });
  });

  it('starts the deferral clock on the first blocked attempt (does not proceed)', () => {
    const r = evaluateUpgradeDeferralBackstop({ blocked: true, deferredSince: null, now: 5_000, maxDeferMs: MAX });
    expect(r.proceed).toBe(false);
    expect(r.forced).toBe(false);
    expect(r.nextDeferredSince).toBe(5_000); // remembers when blocking began
    expect(r.deferredMs).toBe(0);
  });

  it('keeps deferring while under the cap, preserving the original since marker', () => {
    const since = 5_000;
    const r = evaluateUpgradeDeferralBackstop({
      blocked: true,
      deferredSince: since,
      now: since + MAX - 1, // 1ms short of the cap
      maxDeferMs: MAX,
    });
    expect(r.proceed).toBe(false);
    expect(r.nextDeferredSince).toBe(since);
    expect(r.deferredMs).toBe(MAX - 1);
  });

  it('keeps blocking once deferral reaches the cap and preserves the tracker', () => {
    const since = 5_000;
    const r = evaluateUpgradeDeferralBackstop({
      blocked: true,
      deferredSince: since,
      now: since + MAX, // exactly at the cap
      maxDeferMs: MAX,
    });
    expect(r.proceed).toBe(false);
    expect(r.forced).toBe(false);
    expect(r.nextDeferredSince).toBe(since);
    expect(r.deferredMs).toBe(MAX);
  });

  it('clamps negative elapsed (clock skew) to 0 and keeps deferring', () => {
    const r = evaluateUpgradeDeferralBackstop({
      blocked: true,
      deferredSince: 10_000,
      now: 9_000, // now < since (clock went backwards)
      maxDeferMs: MAX,
    });
    expect(r.proceed).toBe(false);
    expect(r.deferredMs).toBe(0);
    expect(r.nextDeferredSince).toBe(10_000);
  });

  it('never forces when the cap is disabled (maxDeferMs <= 0)', () => {
    const r = evaluateUpgradeDeferralBackstop({
      blocked: true,
      deferredSince: 1,
      now: 10_000_000_000,
      maxDeferMs: 0,
    });
    expect(r.proceed).toBe(false);
    expect(r.forced).toBe(false);
  });
});
