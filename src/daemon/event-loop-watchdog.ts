import { performance } from 'node:perf_hooks';
import logger from '../util/logger.js';
import { recordDaemonEventLoopStall } from '../util/daemon-status.js';

const WATCHDOG_INTERVAL_MS = 100;
const WATCHDOG_THRESHOLD_MS = 75;
export const EVENT_LOOP_WATCHDOG_IDLE_PHASE = 'daemon-main-loop';

let timer: ReturnType<typeof setInterval> | undefined;
let expectedAt = 0;
let phase = EVENT_LOOP_WATCHDOG_IDLE_PHASE;

/**
 * Over-threshold scoped blocks already reported under their own phase. The
 * interval callback only runs AFTER the blocking work returns, so it subtracts
 * these from its drift instead of blaming the same milliseconds on whatever
 * phase happens to be current by then.
 */
let attributedScopedStalls: Array<{ durationMs: number }> = [];
/**
 * How many scopes are open right now. A nested scope's milliseconds are already
 * inside the enclosing scope's, so only the outermost scope reports a stall;
 * otherwise the same block would be counted (and discounted) once per level.
 */
let scopeDepth = 0;

/**
 * Low-level setter. Prefer {@link withEventLoopWatchdogPhase}: a phase set here
 * is sticky until something else sets one, so every later stall, whatever its
 * real cause, gets blamed on this label.
 */
export function setEventLoopWatchdogPhase(next: string): void {
  if (next.trim()) phase = next.trim();
}

export function getEventLoopWatchdogPhase(): string {
  return phase;
}

/**
 * Labels only the synchronous work inside `fn`, then restores the previous
 * phase. The stall detector is a timer, so it cannot observe the phase while
 * `fn` blocks the loop -- it fires afterwards. A scope that itself runs longer
 * than the stall threshold therefore reports its stall directly, under its own
 * name, and the following tick discounts those milliseconds; a stall that no
 * scope explains still reports as the idle phase. Nested scopes report once,
 * from the outermost.
 */
export function withEventLoopWatchdogPhase<T>(name: string, fn: () => T): T {
  const previous = phase;
  setEventLoopWatchdogPhase(name);
  scopeDepth += 1;
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = performance.now() - startedAt;
    phase = previous;
    scopeDepth -= 1;
    if (scopeDepth === 0 && timer && durationMs > WATCHDOG_THRESHOLD_MS) {
      const stallMs = Math.round(durationMs);
      attributedScopedStalls.push({ durationMs });
      recordDaemonEventLoopStall({ stallMs, phase: name });
      logger.warn({ driftMs: stallMs, phase: name }, 'daemon event loop stall detected');
    }
  }
}

/** Always-on, allocation-light stall detector; detailed traces remain opt-in. */
export function startEventLoopWatchdog(): void {
  if (timer) return;
  expectedAt = Date.now() + WATCHDOG_INTERVAL_MS;
  attributedScopedStalls = [];
  timer = setInterval(() => {
    const now = Date.now();
    const rawDriftMs = now - expectedAt;
    expectedAt = now + WATCHDOG_INTERVAL_MS;
    // Every scoped block reported since the previous tick is part of this drift.
    const attributedMs = attributedScopedStalls.reduce((sum, stall) => sum + stall.durationMs, 0);
    attributedScopedStalls = [];
    const driftMs = rawDriftMs - attributedMs;
    if (driftMs <= WATCHDOG_THRESHOLD_MS) return;
    recordDaemonEventLoopStall({ stallMs: driftMs, phase });
    logger.warn({ driftMs, phase }, 'daemon event loop stall detected');
  }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
}

export function stopEventLoopWatchdog(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
  attributedScopedStalls = [];
}
