import logger from '../util/logger.js';
import { recordDaemonEventLoopStall } from '../util/daemon-status.js';

const WATCHDOG_INTERVAL_MS = 100;
const WATCHDOG_THRESHOLD_MS = 75;

let timer: ReturnType<typeof setInterval> | undefined;
let expectedAt = 0;
let phase = 'daemon-main-loop';

export function setEventLoopWatchdogPhase(next: string): void {
  if (next.trim()) phase = next.trim();
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
