export const CORE_LANE_STALL_RESTART_DEFAULT_MS = 120_000;
export const CORE_LANE_BUSY_THRESHOLD_MS = 500;

/** Pure decision used by the worker so a stalled parent cannot suppress restart. */
export function shouldRequestCoreLaneRestart(
  nowMs: number,
  lastMainProgressAt: number,
  thresholdMs = CORE_LANE_STALL_RESTART_DEFAULT_MS,
): boolean {
  return Number.isFinite(thresholdMs)
    && thresholdMs > 0
    && lastMainProgressAt > 0
    && nowMs - lastMainProgressAt >= thresholdMs;
}

export function coreLaneBlockedMs(nowMs: number, lastMainProgressAt: number): number {
  return lastMainProgressAt > 0 ? Math.max(0, nowMs - lastMainProgressAt) : 0;
}
