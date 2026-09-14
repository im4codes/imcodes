/**
 * Daemon-side cache of the user's global supervision defaults.
 *
 * Automatic supervision has one account-level runtime selection shared by
 * every session. Session snapshots retain a compatibility mirror, but cannot
 * be authoritative because editing a different session would leave them
 * stale. The daemon therefore refreshes the user's current defaults at
 * startup, on WS reconnect, and every five seconds.
 *
 * The cache is best-effort: fetch failures do not throw; the daemon falls
 * through to the session mirror until a successful fetch. Once populated,
 * the cache is authoritative for primary/backup runtime, timeout, prompt
 * version, and global instructions.
 */
import logger from '../util/logger.js';
import { loadCredentials } from '../bind/bind-flow.js';
import {
  normalizeSupervisorDefaultConfig,
  type SessionSupervisionSnapshot,
  type SupervisorDefaultConfig,
} from '../../shared/supervision-config.js';

let cachedSupervisorDefaults: SupervisorDefaultConfig | null = null;
let lastFetchedAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const SUPERVISOR_DEFAULTS_REFRESH_INTERVAL_MS = 5_000;

/** Exported for tests and for the WS-reconnect hook. */
export async function refreshSupervisorDefaultsCache(): Promise<void> {
  const creds = await loadCredentials();
  if (!creds) {
    // Unbound daemon — nothing to fetch against.
    return;
  }
  try {
    const response = await fetch(
      `${creds.workerUrl}/api/server/${creds.serverId}/supervision/user-defaults/daemon`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${creds.token}` },
      },
    );
    if (!response.ok) {
      logger.debug({ status: response.status }, 'supervisor-defaults-cache: fetch non-ok — keeping previous value');
      return;
    }
    const body = await response.json() as { defaults?: Partial<SupervisorDefaultConfig> | null };
    const next = normalizeSupervisorDefaultConfig(body?.defaults ?? null);
    if (JSON.stringify(next) !== JSON.stringify(cachedSupervisorDefaults)) {
      logger.info({
        backend: next.backend,
        model: next.model,
        backupConfigured: !!next.backupBackend,
        customInstructionsLength: next.customInstructions?.length ?? 0,
      }, 'supervisor-defaults-cache: defaults changed');
    }
    cachedSupervisorDefaults = next;
    lastFetchedAt = Date.now();
  } catch (err) {
    logger.debug({ err }, 'supervisor-defaults-cache: fetch failed — keeping previous value');
  }
}

/** Full global runtime used authoritatively by every supervised session. */
export function getCachedSupervisorDefaults(): SupervisorDefaultConfig | null {
  return cachedSupervisorDefaults;
}

/** When was the last SUCCESSFUL fetch? 0 means never. */
export function getSupervisorDefaultsCacheAgeMs(): number {
  return lastFetchedAt === 0 ? Infinity : Date.now() - lastFetchedAt;
}

/** Keep global runtime edits live without requiring a daemon reconnect. */
export function startSupervisorDefaultsCacheRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshSupervisorDefaultsCache();
  }, SUPERVISOR_DEFAULTS_REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

export function stopSupervisorDefaultsCacheRefresh(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Overlay the cached account-level execution pool onto a snapshot, when the
 * account has actually configured one.
 *
 * The pool is account-level policy keyed by model/agentType capability, not
 * by which session happens to hold it. Unlike backend/model (which
 * normalizeSupervisorDefaultConfig always fills with a concrete value), an
 * account that never configured a pool still reports 'legacy_unconfigured'
 * here; overlaying that state would regress a session whose own
 * transportConfig already has a real pool, so it is applied only once the
 * cache itself is genuinely 'configured'. Kept in this leaf module (no
 * dependency on the daemon's other supervision files) so both the automation
 * loop and send-tool's task-dispatch pool-eligibility check can share it
 * without a static import between those two large, otherwise-decoupled files.
 */
export function overlayCachedExecutionPools<T extends Pick<SessionSupervisionSnapshot, 'executionPools'>>(
  snapshot: T,
): T {
  const cached = cachedSupervisorDefaults;
  if (!cached || cached.executionPools.state !== 'configured') return snapshot;
  return { ...snapshot, executionPools: cached.executionPools };
}

/** Test-only hook. Resets cache state between tests. */
export function __resetSupervisorDefaultsCacheForTests(): void {
  stopSupervisorDefaultsCacheRefresh();
  cachedSupervisorDefaults = null;
  lastFetchedAt = 0;
}

/** Test-only hook for exercising consumers without making an HTTP request. */
export function __setCachedSupervisorDefaultsForTests(
  defaults: Partial<SupervisorDefaultConfig> | null,
): void {
  cachedSupervisorDefaults = defaults ? normalizeSupervisorDefaultConfig(defaults) : null;
  lastFetchedAt = defaults ? Date.now() : 0;
}
