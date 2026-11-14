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

    it('evicts expired sliding window keys even though entries.length >= 1 (regression for permanent map leak)', () => {
      expect(rl.check('ip-1', 5, 10_000)).toBe(true);
      expect(rl.check('ip-2', 5, 20_000)).toBe(true);
      expect(rl.windowCount()).toBe(2);

      // Before ip-1 expires, cleanup keeps both active windows
      vi.advanceTimersByTime(5_000);
      rl.cleanup();
      expect(rl.windowCount()).toBe(2);

      // Refresh ip-2 so its expiresAt extends; let ip-1 expire at +10_000
      expect(rl.check('ip-2', 5, 20_000)).toBe(true);
      vi.advanceTimersByTime(5_001);
      rl.cleanup();
      expect(rl.windowCount()).toBe(1);

      // Eventually ip-2 expires as well
      vi.advanceTimersByTime(20_000);
      rl.cleanup();
      expect(rl.windowCount()).toBe(0);
    });

    it('evicts stale partial lockout entries below lockout threshold', () => {
      rl.recordAuthFailure('partial-user');
      expect(rl.checkLockout('partial-user').locked).toBe(false);
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      rl.cleanup();
      // After cleanup, 4 more failures must not trigger immediate lockout (counter started fresh)
      for (let i = 0; i < 4; i++) {
        expect(rl.recordAuthFailure('partial-user').locked).toBe(false);
      }
    });

    it('enforces maxWindows bound when unique keys flood within an active window', () => {
      const capped = new MemoryRateLimiter({ maxWindows: 3 });
      try {
        expect(capped.check('k1', 2, 10_000)).toBe(true);
        expect(capped.check('k2', 2, 10_000)).toBe(true);
        expect(capped.check('k3', 2, 10_000)).toBe(true);
        expect(capped.windowCount()).toBe(3);

        // Accessing k1 refreshes LRU order so k2 becomes oldest and gets evicted when k4 arrives
        expect(capped.check('k1', 2, 10_000)).toBe(true);
        expect(capped.check('k4', 2, 10_000)).toBe(true);
        expect(capped.windowCount()).toBe(3);

        // k1 still remembers 2 requests (limit 2 -> next rejected), whereas evicted k2 starts fresh
        expect(capped.check('k1', 2, 10_000)).toBe(false);
        expect(capped.check('k2', 2, 10_000)).toBe(true);
      } finally {
        capped.stop();
      }
    });

    it('does not run an idle interval until written to, and stops interval once cleaned empty', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const lazy = new MemoryRateLimiter();
      try {
        expect(setIntervalSpy).not.toHaveBeenCalled();
        lazy.check('temp', 5, 1_000);
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(60_000);
        // Periodic timer fired cleanup, deleted 'temp', and stopped the idle timer
        expect(lazy.windowCount()).toBe(0);
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      } finally {
        lazy.stop();
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });
  });
});

// IP extraction is now handled by proxy-addr (used in both HTTP middleware
// and WS upgrade handler). Tests live in test/proxy-addr.test.ts.
