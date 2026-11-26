/**
 * Live connections must not outlive the account behind them.
 *
 * Request-time checks (security/user-status.ts) stop a disabled user's NEXT request, but a WebSocket stays open for hours: the browser
 * terminal, a share participant's session, the daemon of an owner who was disabled. Each replica holds only the sockets that connected to
 * it, so the disable route can close only its own; this watcher is how every other replica learns. Once per interval it asks the database
 * ONE question for every user behind its live connections ("which of these may no longer act?") and closes theirs. Cost per tick: one
 * statement per pod, none when nobody is connected, whatever the number of connections.
 */
import type { Database } from '../db/client.js';
import { isEmailAuthEnabled, type EnvConfig } from '../env.js';
import { ACCOUNT_CONNECTION_WATCH_INTERVAL_MS, USER_STATUS, userStatusDenialCode } from '../../../shared/user-status.js';
import { findInactiveUsers, loadUserSessionValidAfters } from '../security/user-status.js';
import logger from '../util/logger.js';
import { WsBridge } from './bridge.js';
import { globalTaskHub } from '../services/global-task-hub.js';
import { remoteVoiceHub } from '../services/remote-voice-hub.js';

export interface AccountWatchResult {
  inactiveUsers: number;
  browserSockets: number;
  daemons: number;
}

/**
 * Immediately close live browser sockets for a user whose session epoch advanced (e.g. password reset/change),
 * while preserving independent daemon connections. Other replicas learn on the next `closeConnectionsOfInactiveUsers` tick.
 */
export function evictStaleUserBrowserSockets(
  userId: string,
  sessionsValidAfter: number,
  bridges: Iterable<WsBridge> = WsBridge.getAll().values(),
  reason = 'session_revoked',
): number {
  if (!userId || sessionsValidAfter <= 0) return 0;
  const epochMap = new Map([[userId, sessionsValidAfter]]);
  let closed = 0;
  closed += globalTaskHub.closeBrowserSocketsForSessionReset(epochMap, reason);
  closed += remoteVoiceHub.closeBrowserSocketsForSessionReset(epochMap, reason);
  for (const bridge of bridges) {
    closed += bridge.closeBrowserSocketsForSessionReset(epochMap, reason);
  }
  return closed;
}

/** Close the live connections of every connected user whose account is not active, and stale browser sockets when email auth is enabled. Idempotent. */
export async function closeConnectionsOfInactiveUsers(
  db: Database,
  bridges: Iterable<WsBridge> = WsBridge.getAll().values(),
  options?: { emailAuthEnabled?: boolean },
): Promise<AccountWatchResult> {
  const all = [...bridges];
  const live = new Set<string>();
  for (const bridge of all) bridge.collectLiveUserIds(live);
  globalTaskHub.collectLiveUserIds(live);
  remoteVoiceHub.collectLiveUserIds(live);
  if (live.size === 0) return { inactiveUsers: 0, browserSockets: 0, daemons: 0 };
  const liveIds = [...live];
  const inactive = await findInactiveUsers(db, liveIds);
  const result: AccountWatchResult = { inactiveUsers: inactive.size, browserSockets: 0, daemons: 0 };
  if (inactive.size > 0) {
    result.browserSockets += globalTaskHub.closeInactiveUserSockets(inactive);
    result.browserSockets += remoteVoiceHub.closeInactiveUserSockets(inactive);
    for (const bridge of all) {
      const closed = bridge.closeConnectionsOfUsers(inactive, userStatusDenialCode(USER_STATUS.DISABLED));
      result.browserSockets += closed.browserSockets;
      if (closed.daemon) result.daemons += 1;
    }
    logger.warn({ ...result }, 'closed live connections of accounts that may no longer act');
  }

  const shouldEvictSessionReset = options?.emailAuthEnabled ?? isEmailAuthEnabled(process.env);
  if (shouldEvictSessionReset) {
    const activeLiveIds = liveIds.filter((id) => !inactive.has(id));
    const sessionValidAfters = await loadUserSessionValidAfters(db, activeLiveIds);
    if (sessionValidAfters.size > 0) {
      let evicted = 0;
      evicted += globalTaskHub.closeBrowserSocketsForSessionReset(sessionValidAfters);
      evicted += remoteVoiceHub.closeBrowserSocketsForSessionReset(sessionValidAfters);
      for (const bridge of all) {
        evicted += bridge.closeBrowserSocketsForSessionReset(sessionValidAfters);
      }
      if (evicted > 0) {
        result.browserSockets += evicted;
        logger.warn({ evictedBrowserSockets: evicted }, 'closed stale browser connections after session epoch advance');
      }
    }
  }
  return result;
}

/** Start the periodic check; returns the stop function. The timer never keeps the process alive. */
export function startAccountConnectionWatch(
  db: Database,
  intervalMs: number = ACCOUNT_CONNECTION_WATCH_INTERVAL_MS,
  env: Partial<EnvConfig> = process.env,
): () => void {
  let running = false;
  const emailAuthEnabled = isEmailAuthEnabled(env);
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    closeConnectionsOfInactiveUsers(db, undefined, { emailAuthEnabled })
      .catch((err) => logger.warn({ err }, 'account connection watch failed (retried next tick)'))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
