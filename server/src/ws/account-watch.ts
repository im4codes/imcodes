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
import { ACCOUNT_CONNECTION_WATCH_INTERVAL_MS, USER_STATUS, userStatusDenialCode } from '../../../shared/user-status.js';
import { findInactiveUsers } from '../security/user-status.js';
import logger from '../util/logger.js';
import { WsBridge } from './bridge.js';

export interface AccountWatchResult {
  inactiveUsers: number;
  browserSockets: number;
  daemons: number;
}

/** Close the live connections of every connected user whose account is not active. Idempotent; safe to call from the disable route. */
export async function closeConnectionsOfInactiveUsers(
  db: Database,
  bridges: Iterable<WsBridge> = WsBridge.getAll().values(),
): Promise<AccountWatchResult> {
  const all = [...bridges];
  const live = new Set<string>();
  for (const bridge of all) bridge.collectLiveUserIds(live);
  if (live.size === 0) return { inactiveUsers: 0, browserSockets: 0, daemons: 0 };
  const inactive = await findInactiveUsers(db, [...live]);
  if (inactive.size === 0) return { inactiveUsers: 0, browserSockets: 0, daemons: 0 };
  const result: AccountWatchResult = { inactiveUsers: inactive.size, browserSockets: 0, daemons: 0 };
  for (const bridge of all) {
    const closed = bridge.closeConnectionsOfUsers(inactive, userStatusDenialCode(USER_STATUS.DISABLED));
    result.browserSockets += closed.browserSockets;
    if (closed.daemon) result.daemons += 1;
  }
  logger.warn({ ...result }, 'closed live connections of accounts that may no longer act');
  return result;
}

/** Start the periodic check; returns the stop function. The timer never keeps the process alive. */
export function startAccountConnectionWatch(
  db: Database,
  intervalMs: number = ACCOUNT_CONNECTION_WATCH_INTERVAL_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    closeConnectionsOfInactiveUsers(db)
      .catch((err) => logger.warn({ err }, 'account connection watch failed (retried next tick)'))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
