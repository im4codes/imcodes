import { describe, expect, it, beforeEach } from 'vitest';
import { __testing__, resetFailureTracking, getCircuitBreakerStats } from '../../src/context/summary-compressor.js';

const { canCall, recordSuccess, recordFailure } = __testing__;

describe('Circuit breaker state machine', () => {
  beforeEach(() => {
    resetFailureTracking();
  });

  it('starts empty', () => {
    expect(Object.keys(getCircuitBreakerStats())).toHaveLength(0);
  });

  it('canCall returns true when breaker is closed (initial state)', () => {
    expect(canCall('test-backend', Date.now())).toBe(true);
    // Accessing creates the breaker
    expect(getCircuitBreakerStats()['test-backend']?.state).toBe('closed');
  });

  it('opens after 3 consecutive failures', () => {
    const now = Date.now();
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    expect(getCircuitBreakerStats()['test-backend']?.state).toBe('closed');

    recordFailure('test-backend', now);
    const stats = getCircuitBreakerStats()['test-backend'];
    expect(stats?.state).toBe('open');
    expect(stats?.consecutiveFailures).toBe(3);
    expect(stats?.cooldownMs).toBe(60_000);
  });

  it('canCall returns false when open and cooldown not elapsed', () => {
    const now = 1_000_000;
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);

    // Within cooldown → cannot call
    expect(canCall('test-backend', now + 10_000)).toBe(false);
    expect(canCall('test-backend', now + 59_000)).toBe(false);
  });

  it('transitions to half_open when cooldown elapses', () => {
    const now = 1_000_000;
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);

    // After cooldown → canCall returns true and state is half_open
    const canCallAfter = canCall('test-backend', now + 61_000);
    expect(canCallAfter).toBe(true);
    expect(getCircuitBreakerStats()['test-backend']?.state).toBe('half_open');
  });

  it('half_open success closes circuit and resets cooldown', () => {
    const now = 1_000_000;
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    canCall('test-backend', now + 61_000); // transition to half_open

    recordSuccess('test-backend');
    const stats = getCircuitBreakerStats()['test-backend'];
    expect(stats?.state).toBe('closed');
    expect(stats?.consecutiveFailures).toBe(0);
    expect(stats?.cooldownMs).toBe(60_000); // reset to base
  });

  it('half_open failure reopens with doubled cooldown', () => {
    const now = 1_000_000;
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    canCall('test-backend', now + 61_000); // half_open

    recordFailure('test-backend', now + 62_000);
    const stats = getCircuitBreakerStats()['test-backend'];
    expect(stats?.state).toBe('open');
    expect(stats?.cooldownMs).toBe(120_000); // doubled from 60s
    expect(stats?.consecutiveHalfOpenFailures).toBe(1);
  });

  it('repeated half_open failures exponentially extend cooldown', () => {
    const now = 1_000_000;
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);

    let cooldown = 60_000;
    let t = now;
    for (let i = 0; i < 5; i++) {
      t += cooldown + 1000;
      canCall('test-backend', t); // half_open
      recordFailure('test-backend', t); // probe fails
      cooldown = Math.min(cooldown * 2, 30 * 60_000);
      expect(getCircuitBreakerStats()['test-backend']?.cooldownMs).toBe(cooldown);
    }
  });

  it('caps cooldown at 30 minutes', () => {
    const now = 1_000_000;
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);

    // Run many failed probes until cap
    let t = now;
    let prevCooldown = 0;
    for (let i = 0; i < 20; i++) {
      const current = getCircuitBreakerStats()['test-backend']?.cooldownMs ?? 60_000;
      t += current + 1000;
      canCall('test-backend', t);
      recordFailure('test-backend', t);
      const newCooldown = getCircuitBreakerStats()['test-backend']?.cooldownMs ?? 0;
      if (newCooldown === prevCooldown) break; // hit cap
      prevCooldown = newCooldown;
    }

    const final = getCircuitBreakerStats()['test-backend']?.cooldownMs ?? 0;
    expect(final).toBe(30 * 60_000);
  });

  it('recordSuccess before opening resets failure count', () => {
    const now = Date.now();
    recordFailure('test-backend', now);
    recordFailure('test-backend', now);
    recordSuccess('test-backend');

    const stats = getCircuitBreakerStats()['test-backend'];
    expect(stats?.state).toBe('closed');
    expect(stats?.consecutiveFailures).toBe(0);
  });

  it('tracks independent breakers per backend', () => {
    const now = Date.now();
    recordFailure('claude-code-sdk', now);
    recordFailure('claude-code-sdk', now);
    recordFailure('claude-code-sdk', now);
    recordFailure('codex-sdk', now);

    const stats = getCircuitBreakerStats();
    expect(stats['claude-code-sdk']?.state).toBe('open');
    expect(stats['codex-sdk']?.state).toBe('closed');
    expect(stats['codex-sdk']?.consecutiveFailures).toBe(1);
  });

  it('resetFailureTracking clears all state', () => {
    recordFailure('a', Date.now());
    recordFailure('b', Date.now());
    expect(Object.keys(getCircuitBreakerStats())).toHaveLength(2);

    resetFailureTracking();
    expect(Object.keys(getCircuitBreakerStats())).toHaveLength(0);
  });
});
