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
import { globalTaskHub } from '../services/global-task-hub.js';
import { pushStreamHub, type PushStreamHub } from '../services/push-stream-hub.js';
import { remoteVoiceHub } from '../services/remote-voice-hub.js';

export interface AccountWatchResult {
  inactiveUsers: number;
  browserSockets: number;
  daemons: number;
}

/** Close live SSE push streams whose backing API key was revoked/grace-expired or whose JWT session ended. */
export async function closeRevokedPushStreams(
  db: Database,
  streamHub: PushStreamHub = pushStreamHub,
  now = Date.now(),
): Promise<number> {
  const live = streamHub.collectLiveCredentials();
  if (live.length === 0) return 0;

  const keyIds = new Set<string>();
  const jwtUserIds = new Set<string>();
  const jwtHashes = new Set<string>();
  for (const { userId, credential } of live) {
    if (credential.kind === 'api_key' && credential.keyId) keyIds.add(credential.keyId);
    if (credential.kind === 'jwt') {
      jwtUserIds.add(userId);
      if (credential.sessionHash) jwtHashes.add(credential.sessionHash);
    }
  }

  const invalidKeyIds = new Set<string>();
  if (keyIds.size > 0) {
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM api_keys
        WHERE id = ANY($1::text[])
          AND (revoked_at IS NOT NULL OR (grace_expires_at IS NOT NULL AND grace_expires_at <= $2))`,
      [[...keyIds], now],
    );
    for (const r of rows) invalidKeyIds.add(r.id);
  }

  const minValidAfterByUser = new Map<string, number>();
  if (jwtUserIds.size > 0) {
    const rows = await db.query<{ id: string; sessions_valid_after: string | number }>(
      'SELECT id, sessions_valid_after FROM users WHERE id = ANY($1::text[])',
      [[...jwtUserIds]],
    );
    for (const r of rows) {
      const val = Number(r.sessions_valid_after ?? 0) || 0;
      if (val > 0) minValidAfterByUser.set(r.id, val);
    }
  }

  const revokedSessionHashes = new Set<string>();
  if (jwtHashes.size > 0) {
    const rows = await db.query<{ session_hash: string }>(
      `SELECT session_hash FROM remote_desktop_web_session_revocations
        WHERE session_hash = ANY($1::text[]) AND expires_at > $2`,
      [[...jwtHashes], now],
    );
    for (const r of rows) revokedSessionHashes.add(r.session_hash);
  }

  if (invalidKeyIds.size === 0 && minValidAfterByUser.size === 0 && revokedSessionHashes.size === 0) {
    return 0;
  }

  return streamHub.closeMatchingSubscriptions((userId, sub) => {
    const cred = sub.credential;
    if (!cred) return false;
    if (cred.kind === 'api_key' && cred.keyId && invalidKeyIds.has(cred.keyId)) {
      return true;
    }
    if (cred.kind === 'jwt') {
      if (cred.sessionHash && revokedSessionHashes.has(cred.sessionHash)) return true;
      const validAfter = minValidAfterByUser.get(userId);
      if (validAfter && typeof cred.issuedAt === 'number' && cred.issuedAt * 1000 < validAfter) return true;
    }
    return false;
  });
}

/** Close the live connections of every connected user whose account is not active. Idempotent; safe to call from the disable route. */
export async function closeConnectionsOfInactiveUsers(
  db: Database,
  bridges: Iterable<WsBridge> = WsBridge.getAll().values(),
): Promise<AccountWatchResult> {
  const all = [...bridges];
  const live = new Set<string>();
  for (const bridge of all) bridge.collectLiveUserIds(live);
  globalTaskHub.collectLiveUserIds(live);
  pushStreamHub.collectLiveUserIds(live);
  remoteVoiceHub.collectLiveUserIds(live);
  if (live.size === 0) return { inactiveUsers: 0, browserSockets: 0, daemons: 0 };
  const inactive = await findInactiveUsers(db, [...live]);
  let closed = 0;
  if (inactive.size > 0) {
    const result: AccountWatchResult = { inactiveUsers: inactive.size, browserSockets: 0, daemons: 0 };
    result.browserSockets += globalTaskHub.closeInactiveUserSockets(inactive);
    result.browserSockets += pushStreamHub.closeInactiveUsers(inactive);
    result.browserSockets += remoteVoiceHub.closeInactiveUserSockets(inactive);
    for (const bridge of all) {
      const bridgeClosed = bridge.closeConnectionsOfUsers(inactive, userStatusDenialCode(USER_STATUS.DISABLED));
      result.browserSockets += bridgeClosed.browserSockets;
      if (bridgeClosed.daemon) result.daemons += 1;
    }
    await closeRevokedPushStreams(db).catch((err) =>
      logger.warn({ err }, 'push stream credential watch failed'),
    );
    logger.warn({ ...result }, 'closed live connections of accounts that may no longer act');
    return result;
  }
  closed = await closeRevokedPushStreams(db).catch((err) => {
    logger.warn({ err }, 'push stream credential watch failed');
    return 0;
  });
  return { inactiveUsers: 0, browserSockets: closed, daemons: 0 };
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
