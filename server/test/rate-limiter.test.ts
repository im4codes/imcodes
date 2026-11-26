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

    it('fails closed on new window keys at maxWindows without evicting active rate limits, and recovers after expiry', () => {
      const capped = new MemoryRateLimiter({ maxWindows: 1 });
      try {
        expect(capped.check('A', 1, 30_000)).toBe(true);
        // Capacity saturated with unexpired window A: new key B is denied (fail-closed)
        expect(capped.check('B', 1, 30_000)).toBe(false);
        expect(capped.windowCount()).toBe(1);
        // Active window A is never evicted, so repeat check on A remains rate-limited
        expect(capped.check('A', 1, 30_000)).toBe(false);

        // Once A expires, pruning reclaims capacity and new key B succeeds
        vi.advanceTimersByTime(30_001);
        expect(capped.check('B', 1, 30_000)).toBe(true);
        expect(capped.windowCount()).toBe(1);
      } finally {
        capped.stop();
      }
    });

    it('fails closed on new JTIs at maxJtis without evicting unexpired replay protection, and recovers after expiry', () => {
      const capped = new MemoryRateLimiter({ maxJtis: 1 });
      try {
        expect(capped.consumeJti('jti-A', 30_000)).toBe(true);
        // Unexpired JTI A saturates cap: new JTI B fails closed without evicting A
        expect(capped.consumeJti('jti-B', 30_000)).toBe(false);
        // Replaying JTI A must still be blocked
        expect(capped.consumeJti('jti-A', 30_000)).toBe(false);

        // Once JTI A expires, pruning reclaims capacity and JTI B can be consumed
        vi.advanceTimersByTime(30_001);
        expect(capped.consumeJti('jti-B', 30_000)).toBe(true);
      } finally {
        capped.stop();
      }
    });

    it('fails closed on new identities at maxLockouts without evicting active lockouts, and recovers after expiry', () => {
      const capped = new MemoryRateLimiter({ maxLockouts: 1 });
      try {
        for (let i = 0; i < 4; i++) {
          expect(capped.recordAuthFailure('user-A').locked).toBe(false);
        }
        expect(capped.recordAuthFailure('user-A').locked).toBe(true);
        expect(capped.checkLockout('user-A').locked).toBe(true);

        // Unrelated failure for user-B at capacity must fail closed and must NOT clear user-A lockout
        expect(capped.recordAuthFailure('user-B').locked).toBe(true);
        expect(capped.checkLockout('user-A').locked).toBe(true);

        // Once user-A lockout expires, pruning frees capacity and user-B starts fresh
        vi.advanceTimersByTime(15 * 60 * 1000 + 1);
        expect(capped.checkLockout('user-A').locked).toBe(false);
        expect(capped.recordAuthFailure('user-B').locked).toBe(false);
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
