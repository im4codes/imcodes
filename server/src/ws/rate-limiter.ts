/**
 * In-memory rate limiter: sliding window, JTI single-use, auth lockout.
 * Replaces the CF RateLimiter Durable Object.
 */

export interface LockoutResult {
  locked: boolean;
  lockedUntil?: number;
}

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 min
const CLEANUP_INTERVAL_MS = 60_000;

interface LockoutEntry {
  failedAttempts: number;
  lockedUntil: number | null;
  lastAttemptAt: number;
}

export class MemoryRateLimiter {
  /** key → sorted timestamps in window */
  private windows = new Map<string, number[]>();
  /** jti → expireAt epoch ms */
  private consumedJtis = new Map<string, number>();
  /** identity → lockout state */
  private lockouts = new Map<string, LockoutEntry>();

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /** Sliding window check. Returns true if under limit, records timestamp. */
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;
    let entries = this.windows.get(key) ?? [];
    entries = entries.filter((t) => t > cutoff);
    if (entries.length >= limit) {
      this.windows.set(key, entries);
      return false;
    }
    entries.push(now);
    this.windows.set(key, entries);
    return true;
  }

  /** Consume a JTI. Returns true if new (not yet consumed), false if replay. */
  consumeJti(jti: string, ttlMs: number): boolean {
    const now = Date.now();
    const existing = this.consumedJtis.get(jti);
    if (existing !== undefined && existing > now) return false;
    this.consumedJtis.set(jti, now + ttlMs);
    return true;
  }

  /** Record an auth failure. Returns current lockout state. */
  recordAuthFailure(identity: string): LockoutResult {
    const now = Date.now();
    const entry = this.lockouts.get(identity) ?? { failedAttempts: 0, lockedUntil: null, lastAttemptAt: now };

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

    this.lockouts.set(identity, entry);

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

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow process to exit even if this timer is running
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  cleanup(): void {
    const now = Date.now();

    // Prune expired sliding window entries
    for (const [key, entries] of this.windows) {
      // We don't know the window size here, so keep last 60s as a safe bound.
      // Each call to check() already handles pruning per-window.
      // Just remove empty entries.
      if (entries.length === 0) this.windows.delete(key);
    }

    // Prune expired JTIs
    for (const [jti, expireAt] of this.consumedJtis) {
      if (expireAt <= now) this.consumedJtis.delete(jti);
    }

    // Prune expired lockouts
    for (const [identity, entry] of this.lockouts) {
      if (entry.lockedUntil !== null && entry.lockedUntil <= now) {
        this.lockouts.delete(identity);
      }
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

