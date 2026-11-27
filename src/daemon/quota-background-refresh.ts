const EMPTY_RESULT_COOLDOWN_MS = 60_000;

const inFlightRefreshes = new Set<string>();
const emptyRefreshCooldownUntil = new Map<string, number>();

/**
 * Trigger a best-effort quota/runtime refresh in the background without blocking
 * `buildSessionList()` or `buildSubSessionSyncPayload()`.
 *
 * Deduplicates concurrent refreshes for the same provider key and backs off
 * briefly when a probe returns null/errors (e.g. missing local credentials).
 */
export function scheduleBackgroundQuotaRefresh(
  key: string,
  refreshFn: () => Promise<unknown>,
  now = Date.now(),
): void {
  if (inFlightRefreshes.has(key)) return;
  const cooldownUntil = emptyRefreshCooldownUntil.get(key) ?? 0;
  if (now < cooldownUntil) return;

  inFlightRefreshes.add(key);
  void Promise.resolve()
    .then(() => refreshFn())
    .then((result) => {
      if (result === null || result === undefined) {
        emptyRefreshCooldownUntil.set(key, Date.now() + EMPTY_RESULT_COOLDOWN_MS);
      } else {
        emptyRefreshCooldownUntil.delete(key);
      }
    })
    .catch(() => {
      emptyRefreshCooldownUntil.set(key, Date.now() + EMPTY_RESULT_COOLDOWN_MS);
    })
    .finally(() => {
      inFlightRefreshes.delete(key);
    });
}

/** Test seam — clear in-flight and cooldown tracking. */
export function __resetBackgroundQuotaRefreshForTests(): void {
  inFlightRefreshes.clear();
  emptyRefreshCooldownUntil.clear();
}
