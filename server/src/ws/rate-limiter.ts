/**
 * In-memory rate limiter: sliding window, JTI single-use, auth lockout.
 * Replaces the CF RateLimiter Durable Object.
 */

export interface LockoutResult {
  locked: boolean;
  lockedUntil?: number;
}

export interface MemoryRateLimiterOptions {
  maxWindows?: number;
  maxJtis?: number;
  maxLockouts?: number;
}

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 min
const CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_WINDOWS = 50_000;
const DEFAULT_MAX_JTIS = 100_000;
const DEFAULT_MAX_LOCKOUTS = 50_000;

interface WindowEntry {
  ts: number[];
  expiresAt: number;
}

interface LockoutEntry {
  failedAttempts: number;
  lockedUntil: number | null;
  lastAttemptAt: number;
}

export class MemoryRateLimiter {
  /** key → sliding window timestamps and bucket expiration epoch ms */
  private windows = new Map<string, WindowEntry>();
  /** jti → expireAt epoch ms */
  private consumedJtis = new Map<string, number>();
  /** identity → lockout state */
  private lockouts = new Map<string, LockoutEntry>();

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxWindows: number;
  private readonly maxJtis: number;
  private readonly maxLockouts: number;

  constructor(options: MemoryRateLimiterOptions = {}) {
    this.maxWindows = Math.max(1, options.maxWindows ?? DEFAULT_MAX_WINDOWS);
    this.maxJtis = Math.max(1, options.maxJtis ?? DEFAULT_MAX_JTIS);
    this.maxLockouts = Math.max(1, options.maxLockouts ?? DEFAULT_MAX_LOCKOUTS);
  }

  /** Sliding window check. Returns true if under limit, records timestamp. */
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const safeWindowMs = Math.max(0, windowMs);
    const cutoff = now - safeWindowMs;
    const existing = this.windows.get(key);

    if (existing !== undefined) {
      const entries = existing.ts.filter((t) => t > cutoff);
      if (entries.length >= limit) {
        if (entries.length === 0) {
          this.windows.delete(key);
          this.stopIfEmpty();
        } else {
          this.windows.delete(key);
          this.windows.set(key, {
            ts: entries,
            expiresAt: entries[entries.length - 1]! + safeWindowMs,
          });
          this.ensureCleanupRunning();
        }
        return false;
      }

      entries.push(now);
      this.windows.delete(key);
      this.windows.set(key, {
        ts: entries,
        expiresAt: now + safeWindowMs,
      });
      this.ensureCleanupRunning();
      return true;
    }

    if (limit <= 0) {
      return false;
    }

    if (this.windows.size >= this.maxWindows) {
      this.pruneExpiredWindows(now);
      if (this.windows.size >= this.maxWindows) {
        // Capacity saturated by unexpired windows: fail closed without evicting active rate limits.
        return false;
      }
    }

    this.windows.set(key, {
      ts: [now],
      expiresAt: now + safeWindowMs,
    });
    this.ensureCleanupRunning();
    return true;
  }

  /** Reset one tracked window key or clear all tracked limiter state. */
  reset(key?: string): void {
    if (key !== undefined) {
      this.windows.delete(key);
    } else {
      this.windows.clear();
      this.consumedJtis.clear();
      this.lockouts.clear();
    }
    this.stopIfEmpty();
  }

  /** Number of active window keys currently retained in memory. */
  windowCount(): number {
    return this.windows.size;
  }

  /** Consume a JTI. Returns true if new (not yet consumed), false if replay. */
  consumeJti(jti: string, ttlMs: number): boolean {
    const now = Date.now();
    const existing = this.consumedJtis.get(jti);
    if (existing !== undefined && existing > now) return false;
    if (existing !== undefined) {
      this.consumedJtis.delete(jti);
    } else if (this.consumedJtis.size >= this.maxJtis) {
      this.pruneExpiredJtis(now);
      if (this.consumedJtis.size >= this.maxJtis) {
        // Capacity saturated by unexpired JTIs: fail closed so live replay protection is never evicted.
        return false;
      }
    }
    this.consumedJtis.set(jti, now + Math.max(0, ttlMs));
    this.ensureCleanupRunning();
    return true;
  }

  /** Record an auth failure. Returns current lockout state. */
  recordAuthFailure(identity: string): LockoutResult {
    const now = Date.now();
    const existing = this.lockouts.get(identity);
    if (!existing && this.lockouts.size >= this.maxLockouts) {
      this.pruneExpiredLockouts(now);
      if (this.lockouts.size >= this.maxLockouts) {
        // Capacity saturated by active lockouts/failure counters: fail closed without evicting live state.
        return { locked: true, lockedUntil: now + LOCKOUT_DURATION_MS };
      }
    }
    const entry = existing ?? { failedAttempts: 0, lockedUntil: null, lastAttemptAt: now };

    // Reset if previous lockout has expired
    if (entry.lockedUntil !== null && entry.lockedUntil <= now) {
      entry.failedAttempts = 0;
      entry.lockedUntil = null;
    }

    entry.failedAttempts += 1;
    entry.lastAttemptAt = now;

    if (entry.failedAttempts >= LOCKOUT_THRESHOLD) {
      entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    }

    this.lockouts.delete(identity);
    this.lockouts.set(identity, entry);
    this.ensureCleanupRunning();

    if (entry.lockedUntil !== null) {
      return { locked: true, lockedUntil: entry.lockedUntil };
    }
    return { locked: false };
  }

  /** Check lockout state without incrementing counter. */
  checkLockout(identity: string): LockoutResult {
    const now = Date.now();
    const entry = this.lockouts.get(identity);
    if (!entry) return { locked: false };
    if (entry.lockedUntil !== null && entry.lockedUntil > now) {
      return { locked: true, lockedUntil: entry.lockedUntil };
    }
    return { locked: false };
  }

  private stopIfEmpty(): void {
    if (this.windows.size === 0 && this.consumedJtis.size === 0 && this.lockouts.size === 0) {
      this.stop();
    }
  }

  private ensureCleanupRunning(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow process to exit even if this timer is running
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private pruneExpiredWindows(now: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.expiresAt <= now) this.windows.delete(key);
    }
  }

  private pruneExpiredJtis(now: number): void {
    for (const [jti, expireAt] of this.consumedJtis) {
      if (expireAt <= now) this.consumedJtis.delete(jti);
    }
  }

  private pruneExpiredLockouts(now: number): void {
    for (const [identity, entry] of this.lockouts) {
      const lockedExpired = entry.lockedUntil !== null && entry.lockedUntil <= now;
      const staleAttempt = entry.lockedUntil === null && entry.lastAttemptAt + LOCKOUT_DURATION_MS <= now;
      if (lockedExpired || staleAttempt) {
        this.lockouts.delete(identity);
      }
    }
  }

  cleanup(now = Date.now()): void {
    this.pruneExpiredWindows(now);
    this.pruneExpiredJtis(now);
    this.pruneExpiredLockouts(now);

    if (this.windows.size === 0 && this.consumedJtis.size === 0 && this.lockouts.size === 0) {
      this.stop();
    }
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// ── IP extraction ─────────────────────────────────────────────────────────────

