/**
 * Which signed tokens are a user's LOGIN. Every token the server mints is signed with the same key and carries a `sub`, so "is this a
 * valid signature for a user" says nothing about what the token is for: the 24 h shared-session machine authority (sub = the share
 * participant), the capability blob token (sub = the owner), the ws tickets and the relay token all verify. Account auth therefore
 * accepts a token only when it IS a login token -- an allowlist, so a token type added later is not an account session by accident
 * (a deny-list of ticket names drifted: a participant's machine-authority token, which the owner's daemon sees, was accepted as the
 * participant's login and could mint a permanent API key).
 */
import { ACCOUNT_SESSION_JWT_TYPE } from '../../../shared/auth-token-types.js';

export function isAccountSessionJwt(payload: Record<string, unknown> | null | undefined): payload is Record<string, unknown> & { sub: string } {
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) return false;
  return payload.type === undefined || payload.type === ACCOUNT_SESSION_JWT_TYPE;
}
