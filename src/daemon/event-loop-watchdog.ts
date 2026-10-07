import { performance } from 'node:perf_hooks';
import logger from '../util/logger.js';
import { recordDaemonEventLoopStall } from '../util/daemon-status.js';

const WATCHDOG_INTERVAL_MS = 100;
const WATCHDOG_THRESHOLD_MS = 75;
export const EVENT_LOOP_WATCHDOG_IDLE_PHASE = 'daemon-main-loop';
/** Drift (ms) above which a tick, or a scoped block, counts as a stall. */
export const EVENT_LOOP_WATCHDOG_THRESHOLD_MS = WATCHDOG_THRESHOLD_MS;
/** A periodic pass during which the main thread stalled this long in total is named in a warning (see {@link runPeriodicPass}). */
export const PERIODIC_PASS_STALL_BUDGET_MS = 300;

/** Periodic passes currently running (they overlap only through awaits), with the stall time seen while each one ran. */
const activePeriodicPasses = new Map<symbol, { name: string; startedAt: number; stalledMs: number; stalls: number }>();

/**
 * Every time source the watchdog reads. Production always uses the real clock;
 * a test can install its own so the stall arithmetic never depends on how fast
 * or how loaded the machine running the test is.
 */
export interface EventLoopWatchdogClock {
  /** Wall clock (drives the tick drift). */
  wallNow(): number;
  /** Monotonic clock (measures how long a scoped block ran). */
  monotonicNow(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const REAL_CLOCK: EventLoopWatchdogClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

let clock: EventLoopWatchdogClock = REAL_CLOCK;

/** Test seam: install a controllable clock (or `null` for the real one). Stops a running watchdog first. */
export function setEventLoopWatchdogClockForTests(next: EventLoopWatchdogClock | null): void {
  stopEventLoopWatchdog();
  clock = next ?? REAL_CLOCK;
}

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
  const startedAt = clock.monotonicNow();
  try {
    return fn();
  } finally {
    const durationMs = clock.monotonicNow() - startedAt;
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
  expectedAt = clock.wallNow() + WATCHDOG_INTERVAL_MS;
  attributedScopedStalls = [];
  timer = clock.setInterval(() => {
    const now = clock.wallNow();
    const rawDriftMs = now - expectedAt;
    expectedAt = now + WATCHDOG_INTERVAL_MS;
    // Every scoped block reported since the previous tick is part of this drift.
    const attributedMs = attributedScopedStalls.reduce((sum, stall) => sum + stall.durationMs, 0);
    attributedScopedStalls = [];
    const driftMs = rawDriftMs - attributedMs;
    if (driftMs <= WATCHDOG_THRESHOLD_MS) return;
    // A stall that ends while a periodic pass is in flight is blamed on it when nothing narrower labelled it.
    const passes = [...activePeriodicPasses.values()];
    const blamed = phase === EVENT_LOOP_WATCHDOG_IDLE_PHASE && passes.length > 0 ? `pass:${passes.map((pass) => pass.name).join('+')}` : phase;
    for (const pass of passes) { pass.stalledMs += driftMs; pass.stalls += 1; }
    recordDaemonEventLoopStall({ stallMs: driftMs, phase: blamed });
    logger.warn({ driftMs, phase: blamed }, 'daemon event loop stall detected');
  }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
}

export function stopEventLoopWatchdog(): void {
  if (!timer) return;
  clock.clearInterval(timer);
  timer = undefined;
  attributedScopedStalls = [];
}

/**
 * Runs one periodic background pass (a 60 s watchdog tick, a heartbeat, a sweep) and names it when it stalls the daemon.
 *
 * Why this exists: the stall detector is a timer, so it only sees a block after it ended and can say nothing about its
 * cause; a stall nothing labelled reported as the anonymous `daemon-main-loop`, which is how a 2.4 s freeze every 60 s
 * stayed unexplained on 215 for days (it was one pass forking hundreds of `git` children). A stall that ends while a pass
 * is in flight is now reported as `pass:<name>`, and a pass that accumulated more than `budgetMs` of stall logs one line
 * naming itself, with how long it took and how many stalls it saw. The pass itself is not changed, delayed or bounded.
 */
export async function runPeriodicPass<T>(name: string, fn: () => Promise<T> | T, budgetMs = PERIODIC_PASS_STALL_BUDGET_MS): Promise<T> {
  const key = Symbol(name);
  const entry = { name, startedAt: clock.monotonicNow(), stalledMs: 0, stalls: 0 };
  activePeriodicPasses.set(key, entry);
  try {
    return await fn();
  } finally {
    activePeriodicPasses.delete(key);
    if (entry.stalledMs >= budgetMs) {
      logger.warn({
        pass: name,
        stalledMs: Math.round(entry.stalledMs),
        stalls: entry.stalls,
        wallMs: Math.round(clock.monotonicNow() - entry.startedAt),
        budgetMs,
      }, 'periodic pass stalled the daemon main thread');
    }
  }
}

/** Test seam: forget passes left in flight by a test. */
export function __resetPeriodicPassesForTests(): void {
  activePeriodicPasses.clear();
}
