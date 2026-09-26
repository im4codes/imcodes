import { describe, expect, it } from 'vitest';

import { evaluateUpgradeDeferralBackstop } from '../../src/daemon/command-handler.js';

// The session-busy gate prevents a daemon self-upgrade from killing a session
// mid-turn. This tracker measures CONTINUOUS deferral across upgrade attempts
// for observability, but it must never force an upgrade through active work.
// Past the cap it signals `drain` instead: the caller stops starting NEW
// queued pairs (the one form of admission the daemon itself controls), so a
// perpetually busy set of sessions gets a real chance to drain to idle
// instead of being refilled forever by the daemon's own auto-dispatch.

describe('evaluateUpgradeDeferralBackstop', () => {
  const MAX = 30 * 60 * 1000; // 30 min

  it('proceeds and clears the tracker when nothing is blocking', () => {
    expect(
      evaluateUpgradeDeferralBackstop({ blocked: false, deferredSince: 123, now: 1_000, maxDeferMs: MAX }),
    ).toEqual({ proceed: true, forced: false, nextDeferredSince: null, deferredMs: 0, drain: false });
  });

  it('starts the deferral clock on the first blocked attempt (does not proceed, does not drain)', () => {
    const r = evaluateUpgradeDeferralBackstop({ blocked: true, deferredSince: null, now: 5_000, maxDeferMs: MAX });
    expect(r.proceed).toBe(false);
    expect(r.forced).toBe(false);
    expect(r.nextDeferredSince).toBe(5_000); // remembers when blocking began
    expect(r.deferredMs).toBe(0);
    expect(r.drain).toBe(false);
  });

  it('keeps deferring while under the cap, preserving the original since marker, without draining', () => {
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
    expect(r.drain).toBe(false);
  });

  it('keeps blocking (never forces) but starts draining once deferral reaches the cap', () => {
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
    expect(r.drain).toBe(true);
  });

  it('keeps draining well past the cap, not just at the exact boundary', () => {
    const since = 5_000;
    const r = evaluateUpgradeDeferralBackstop({
      blocked: true,
      deferredSince: since,
      now: since + MAX * 3,
      maxDeferMs: MAX,
    });
    expect(r.proceed).toBe(false);
    expect(r.drain).toBe(true);
  });

  it('clamps negative elapsed (clock skew) to 0, keeps deferring, and does not drain', () => {
    const r = evaluateUpgradeDeferralBackstop({
      blocked: true,
      deferredSince: 10_000,
      now: 9_000, // now < since (clock went backwards)
      maxDeferMs: MAX,
    });
    expect(r.proceed).toBe(false);
    expect(r.deferredMs).toBe(0);
    expect(r.nextDeferredSince).toBe(10_000);
    expect(r.drain).toBe(false);
  });

  it('never forces and never drains when the cap is disabled (maxDeferMs <= 0)', () => {
    const r = evaluateUpgradeDeferralBackstop({
      blocked: true,
      deferredSince: 1,
      now: 10_000_000_000,
      maxDeferMs: 0,
    });
    expect(r.proceed).toBe(false);
    expect(r.forced).toBe(false);
    expect(r.drain).toBe(false);
  });
});
