/** Same real-timer contract for daemon-only and HTTP/server skew cases. */
export const WORKER_SYNC_RETRY_DELAYS = [10_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000] as const;
export const WORKER_SYNC_SCHEDULED_DELAYS = [...WORKER_SYNC_RETRY_DELAYS, 300_000];

export async function advanceCappedWorkerSyncRetries(advance: (ms: number) => Promise<unknown>): Promise<void> {
  for (const delay of WORKER_SYNC_RETRY_DELAYS) await advance(delay);
}
