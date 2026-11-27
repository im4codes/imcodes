import type { ProviderQuotaMeta } from '../../shared/provider-quota.js';

export type BackgroundQuotaProviderKey =
  | 'claude-usage-quota'
  | 'agy-usage-quota'
  | 'grok-usage-quota'
  | 'muse-usage-quota'
  | 'qwen-runtime-config';

export type BackgroundQuotaChangedListener = (key: BackgroundQuotaProviderKey) => void;

const EMPTY_RESULT_COOLDOWN_MS = 60_000;

const inFlightRefreshes = new Set<BackgroundQuotaProviderKey>();
const emptyRefreshCooldownUntil = new Map<BackgroundQuotaProviderKey, number>();
const lastNotifiedSnapshots = new Map<BackgroundQuotaProviderKey, string>();
const listeners = new Set<BackgroundQuotaChangedListener>();

export function serializeQuotaSnapshot(
  quota: { quotaLabel?: string; quotaMeta?: ProviderQuotaMeta | null } | null | undefined,
): string | null {
  if (!quota) return null;
  if (!quota.quotaLabel && !quota.quotaMeta) return null;
  return JSON.stringify({
    quotaLabel: quota.quotaLabel ?? null,
    quotaMeta: quota.quotaMeta ?? null,
  });
}

export function serializeQwenRuntimeSnapshot(
  config: { authType?: string; authLimit?: string; availableModels?: readonly string[] } | null | undefined,
): string | null {
  if (!config) return null;
  return JSON.stringify({
    authType: config.authType ?? null,
    authLimit: config.authLimit ?? null,
    availableModels: config.availableModels ?? [],
  });
}

export function onBackgroundQuotaChanged(listener: BackgroundQuotaChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ScheduleBackgroundQuotaRefreshOptions<T> {
  beforeSnapshot?: string | null;
  serializeResult?: (result: T) => string | null;
}

/**
 * Trigger a best-effort quota/runtime refresh in the background without blocking
 * `buildSessionList()` or `buildSubSessionSyncPayload()`.
 *
 * Deduplicates concurrent refreshes for the same provider key, backs off
 * briefly when a probe returns null/errors, and notifies listeners ONLY when
 * the serialized snapshot actually changes to a new non-empty value.
 */
export function scheduleBackgroundQuotaRefresh<T>(
  key: BackgroundQuotaProviderKey,
  refreshFn: () => Promise<T>,
  optionsOrNow?: ScheduleBackgroundQuotaRefreshOptions<T> | number,
): void {
  const now = typeof optionsOrNow === 'number' ? optionsOrNow : Date.now();
  const options = typeof optionsOrNow === 'object' && optionsOrNow ? optionsOrNow : undefined;
  const beforeSnapshot = options?.beforeSnapshot ?? null;
  const serializeResult = options?.serializeResult;

  if (inFlightRefreshes.has(key)) return;
  const cooldownUntil = emptyRefreshCooldownUntil.get(key) ?? 0;
  if (now < cooldownUntil) return;

  inFlightRefreshes.add(key);
  void Promise.resolve()
    .then(() => refreshFn())
    .then((result) => {
      if (result === null || result === undefined) {
        emptyRefreshCooldownUntil.set(key, Date.now() + EMPTY_RESULT_COOLDOWN_MS);
        return;
      }
      emptyRefreshCooldownUntil.delete(key);
      if (!serializeResult) return;
      const nextSnapshot = serializeResult(result);
      if (!nextSnapshot || nextSnapshot === beforeSnapshot || nextSnapshot === lastNotifiedSnapshots.get(key)) {
        return;
      }
      lastNotifiedSnapshots.set(key, nextSnapshot);
      for (const listener of [...listeners]) {
        try {
          listener(key);
        } catch {
          // Listener handles its own errors; never poison background cleanup.
        }
      }
    })
    .catch(() => {
      emptyRefreshCooldownUntil.set(key, Date.now() + EMPTY_RESULT_COOLDOWN_MS);
    })
    .finally(() => {
      inFlightRefreshes.delete(key);
    });
}

/** Test seam — clear in-flight, cooldown, and last-notified snapshots (preserves registered command-handler listeners). */
export function __resetBackgroundQuotaRefreshForTests(): void {
  inFlightRefreshes.clear();
  emptyRefreshCooldownUntil.clear();
  lastNotifiedSnapshots.clear();
}
