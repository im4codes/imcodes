/** Liveness metadata carried by daemon heartbeat/daemon.stats frames. */
export interface CoreLaneStatus {
  /** Event-loop delay observed by the daemon's last completed probe. */
  mainEventLoopLagMs?: number;
  /** Wall time since the main thread last reported progress. */
  mainEventLoopBlockedMs?: number;
  /** True while the main thread has not reported progress for the busy threshold. */
  mainEventLoopBusy?: boolean;
}

export function isCoreLaneStatus(value: unknown): value is CoreLaneStatus {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (record.mainEventLoopLagMs === undefined || typeof record.mainEventLoopLagMs === 'number')
    && (record.mainEventLoopBlockedMs === undefined || typeof record.mainEventLoopBlockedMs === 'number')
    && (record.mainEventLoopBusy === undefined || typeof record.mainEventLoopBusy === 'boolean');
}
