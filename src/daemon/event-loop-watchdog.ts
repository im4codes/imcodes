import logger from '../util/logger.js';
import { recordDaemonEventLoopStall } from '../util/daemon-status.js';

const WATCHDOG_INTERVAL_MS = 100;
const WATCHDOG_THRESHOLD_MS = 75;
export const EVENT_LOOP_WATCHDOG_IDLE_PHASE = 'daemon-main-loop';

let timer: ReturnType<typeof setInterval> | undefined;
let expectedAt = 0;
let phase = EVENT_LOOP_WATCHDOG_IDLE_PHASE;

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
 * phase. A stall is therefore attributed to a named phase only when it was
 * actually running; work outside any scope reports as the idle phase.
 */
export function withEventLoopWatchdogPhase<T>(name: string, fn: () => T): T {
  const previous = phase;
  setEventLoopWatchdogPhase(name);
  try {
    return fn();
  } finally {
    phase = previous;
  }
}

/** Always-on, allocation-light stall detector; detailed traces remain opt-in. */
export function startEventLoopWatchdog(): void {
  if (timer) return;
  expectedAt = Date.now() + WATCHDOG_INTERVAL_MS;
  timer = setInterval(() => {
    const now = Date.now();
    const driftMs = now - expectedAt;
    expectedAt = now + WATCHDOG_INTERVAL_MS;
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
}
