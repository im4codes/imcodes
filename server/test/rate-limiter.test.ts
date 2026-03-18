import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRateLimiter } from '../src/ws/rate-limiter.js';

describe('MemoryRateLimiter', () => {
  let rl: MemoryRateLimiter;

  beforeEach(() => {
    rl = new MemoryRateLimiter();
    vi.useFakeTimers();
  });
  afterEach(() => {
    rl.stop();
    vi.useRealTimers();
  });

  describe('sliding window check()', () => {
    it('allows requests under limit', () => {
      expect(rl.check('k', 5, 10_000)).toBe(true);
      expect(rl.check('k', 5, 10_000)).toBe(true);
      expect(rl.check('k', 5, 10_000)).toBe(true);
    });

    it('rejects at limit', () => {
      for (let i = 0; i < 5; i++) rl.check('k', 5, 10_000);
      expect(rl.check('k', 5, 10_000)).toBe(false);
    });

    it('allows again after window slides', () => {
      for (let i = 0; i < 5; i++) rl.check('k', 5, 10_000);
      expect(rl.check('k', 5, 10_000)).toBe(false);

      vi.advanceTimersByTime(11_000);
      expect(rl.check('k', 5, 10_000)).toBe(true);
    });
  });

  describe('consumeJti()', () => {
    it('returns true for new JTI', () => {
      expect(rl.consumeJti('jti1', 30_000)).toBe(true);
    });

    it('returns false for replay within TTL', () => {
      rl.consumeJti('jti1', 30_000);
      expect(rl.consumeJti('jti1', 30_000)).toBe(false);
    });

    it('returns true after TTL expires', () => {
      rl.consumeJti('jti1', 30_000);
      vi.advanceTimersByTime(31_000);
      // After TTL the entry is expired — consumeJti checks expiry
      expect(rl.consumeJti('jti1', 30_000)).toBe(true);
    });
  });

  describe('lockout', () => {
    it('not locked below threshold', () => {
      for (let i = 0; i < 4; i++) rl.recordAuthFailure('ip1');
      expect(rl.checkLockout('ip1').locked).toBe(false);
    });

    it('locked after 5 failures', () => {
      for (let i = 0; i < 5; i++) rl.recordAuthFailure('ip1');
      const result = rl.checkLockout('ip1');
      expect(result.locked).toBe(true);
      expect(result.lockedUntil).toBeGreaterThan(Date.now());
    });

    it('unlocked after 15 minutes', () => {
      for (let i = 0; i < 5; i++) rl.recordAuthFailure('ip1');
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      expect(rl.checkLockout('ip1').locked).toBe(false);
    });

    it('recordAuthFailure returns locked state', () => {
      for (let i = 0; i < 4; i++) rl.recordAuthFailure('ip2');
      const result = rl.recordAuthFailure('ip2');
      expect(result.locked).toBe(true);
    });
  });

  describe('cleanup()', () => {
    it('removes expired JTIs', () => {
      rl.consumeJti('old-jti', 100);
      vi.advanceTimersByTime(200);
      rl.cleanup();
      // After cleanup, old-jti is gone — can be consumed again
      expect(rl.consumeJti('old-jti', 100)).toBe(true);
    });
  });
});

// IP extraction is now handled by proxy-addr (used in both HTTP middleware
// and WS upgrade handler). Tests live in test/proxy-addr.test.ts.
