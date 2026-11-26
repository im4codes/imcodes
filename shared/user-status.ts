/**
 * Account status: the ONE definition of "this user may act".
 *
 * A user row is `active` (may sign in and use the API), `pending` (registered, waiting for an admin to approve) or `disabled` (an admin
 * switched the account off). Everything that establishes or keeps alive an identity -- API keys, login sessions, tickets, daemon
 * credentials, scheduled jobs, shares -- asks `isUserStatusActive`; anything that is not exactly `active` is refused (fail closed), so a
 * status added later is denied by default instead of silently allowed.
 *
 * The `users.status` column is `NOT NULL DEFAULT 'active'` (migration 019), so a user without a status does not exist: a legacy row got
 * `active` when the column was added, which is the previous meaning of "no status".
 */
import { AUTH_ERROR_CODES } from './auth-error-codes.js';

export const USER_STATUS = {
  ACTIVE: 'active',
  PENDING: 'pending',
  DISABLED: 'disabled',
} as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export function isUserStatusActive(status: unknown): status is typeof USER_STATUS.ACTIVE {
  return status === USER_STATUS.ACTIVE;
}

/** The error code a refused account carries: pending says pending, every other non-active status says disabled. */
export function userStatusDenialCode(status: unknown): typeof AUTH_ERROR_CODES.ACCOUNT_PENDING | typeof AUTH_ERROR_CODES.ACCOUNT_DISABLED {
  return status === USER_STATUS.PENDING ? AUTH_ERROR_CODES.ACCOUNT_PENDING : AUTH_ERROR_CODES.ACCOUNT_DISABLED;
}

/**
 * WebSocket close code of a connection the server ended because its account may no longer act (disabled, pending); the close reason is
 * the account's error code (`account_disabled` / `account_pending`). It is the code a revoked credential gets too, which every client
 * already backs off on, so a refused daemon does not retry in a storm.
 */
export const ACCOUNT_WS_CLOSE_CODE = 4003 as const;

/**
 * How often every server replica re-checks the accounts behind its live connections. A disable is applied at once on the replica that
 * served it and honoured by every OTHER replica within this bound (in-memory state is per pod, so the database is the only shared truth).
 */
export const ACCOUNT_CONNECTION_WATCH_INTERVAL_MS = 5_000;
