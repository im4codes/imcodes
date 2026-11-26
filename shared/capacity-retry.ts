/**
 * Backoff for a transient provider failure ("model at capacity", overloaded, rate limit, 5xx, dropped connection).
 *
 * Owner rule (2026-09-30): keep retrying with NO give-up window, starting at 1 s and never waiting more than 15 s between
 * attempts: 1 → 2 → 4 → 8 → 15 → 15 … Only a successful turn, the user's /stop or a permanent error ends it.
 *
 * Jitter only ever SHORTENS a delay (by up to 20 %), so no interval can exceed the cap and the first retry stays close to 1 s,
 * while sessions that hit the same saturated model still spread out instead of all retrying in the same instant.
 */
export const CAPACITY_RETRY_BASE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const CAPACITY_RETRY_MAX_DELAY_MS = 15_000;
export const CAPACITY_RETRY_JITTER_SPREAD = 0.2;
/**
 * A retried turn that runs this long without another capacity failure has gone through: the episode ends (notice cleared,
 * backoff restarts at 1 s for the next one). Shorter than any realistic failure latency, longer than the 15 s cap.
 */
export const CAPACITY_RETRY_SUCCESS_AFTER_MS = 30_000;
/** Progress log line every N attempts inside one episode (the first attempt of an episode always logs). */
export const CAPACITY_RETRY_LOG_EVERY_ATTEMPTS = 40;

/** Delay before retry number `attempt` (1-based). `random` returns [0,1); 0 gives the exact base delay. */
export function capacityRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(1, Math.trunc(attempt)), CAPACITY_RETRY_BASE_DELAYS_MS.length) - 1;
  const base = CAPACITY_RETRY_BASE_DELAYS_MS[index]!;
  const jitter = 1 - CAPACITY_RETRY_JITTER_SPREAD * Math.min(Math.max(random(), 0), 1);
  return Math.min(CAPACITY_RETRY_MAX_DELAY_MS, Math.max(1, Math.round(base * jitter)));
}

/** Prefix of the live-status activity detail while a session is in a capacity-retry episode (`capacity_retry:<attempt>`). */
export const CAPACITY_RETRY_ACTIVITY_DETAIL_PREFIX = 'capacity_retry:' as const;
