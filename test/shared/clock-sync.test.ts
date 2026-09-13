import { describe, expect, it } from 'vitest';
import {
  CLOCK_SYNC_MAX_ROUND_TRIP_MS,
  CLOCK_SYNC_MAX_SAMPLES,
  ServerClockEstimator,
  oneWayServerOffsetMs,
} from '../../shared/clock-sync.js';

describe('ServerClockEstimator', () => {
  it('trusts the local clock until a sample exists', () => {
    const clock = new ServerClockEstimator();
    expect(clock.synchronized).toBe(false);
    expect(clock.offsetMs()).toBe(0);
    expect(clock.serverToLocal(1_000_000)).toBe(1_000_000);
  });

  it('estimates the offset at the round-trip midpoint', () => {
    const clock = new ServerClockEstimator();
    // Sent at 1000 local, received at 1200 local; the Server is 5 minutes ahead.
    expect(clock.addSample(1_000, 1_100 + 300_000, 1_200)).toBe(true);
    expect(clock.synchronized).toBe(true);
    expect(clock.offsetMs()).toBe(300_000);
    expect(clock.serverToLocal(2_000_000)).toBe(1_700_000);
  });

  it('handles a local clock minutes ahead of the Server', () => {
    const clock = new ServerClockEstimator();
    clock.addSample(10_000_000, 10_000_050 - 240_000, 10_000_100);
    expect(clock.offsetMs()).toBe(-240_000);
  });

  it('uses the median so one outlier cannot move the estimate', () => {
    const clock = new ServerClockEstimator();
    clock.addSample(1_000, 1_050 + 400, 1_100);
    clock.addSample(2_000, 2_050 + 410, 2_100);
    clock.addSample(3_000, 3_050 + 90_000, 3_100);
    expect(clock.offsetMs()).toBe(410);
  });

  it('keeps only the most recent samples', () => {
    const clock = new ServerClockEstimator();
    for (let i = 0; i < CLOCK_SYNC_MAX_SAMPLES; i += 1) clock.addSample(1_000, 1_000 + 100_000, 1_000);
    for (let i = 0; i < CLOCK_SYNC_MAX_SAMPLES; i += 1) clock.addSample(1_000, 1_000 + 5, 1_000);
    expect(clock.offsetMs()).toBe(5);
  });

  it('rejects unusable samples', () => {
    const clock = new ServerClockEstimator();
    expect(clock.addSample(undefined, 1_000, 2_000)).toBe(false);
    expect(clock.addSample('1000', 1_000, 2_000)).toBe(false);
    expect(clock.addSample(1_000, Number.NaN, 2_000)).toBe(false);
    expect(clock.addSample(2_000, 1_000, 1_000)).toBe(false);
    expect(clock.addSample(1_000, 1_000, 1_000 + CLOCK_SYNC_MAX_ROUND_TRIP_MS + 1)).toBe(false);
    expect(clock.synchronized).toBe(false);
  });
});

describe('oneWayServerOffsetMs', () => {
  it('derives the offset from one Server-stamped message', () => {
    expect(oneWayServerOffsetMs(1_300_000, 1_000_000)).toBe(300_000);
    expect(oneWayServerOffsetMs(700_000, 1_000_000)).toBe(-300_000);
  });

  it('falls back to zero without a usable Server time', () => {
    expect(oneWayServerOffsetMs(undefined, 1_000_000)).toBe(0);
    expect(oneWayServerOffsetMs(Number.POSITIVE_INFINITY, 1_000_000)).toBe(0);
  });
});
