import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HOOK_SESSION_CREDENTIAL_ENV, HOOK_SESSION_CREDENTIAL_HEADER } from '../../shared/hook-session-credential.js';
import { getSession } from '../store/session-store.js';

/** A fresh per-launch credential for a process session. */
export function mintHookCredential(): string {
  return randomBytes(32).toString('hex');
}

/** Environment entries carrying the credential into the launched process (empty when there is none). */
export function hookCredentialEnv(credential: string | undefined): Record<string, string> {
  return credential ? { [HOOK_SESSION_CREDENTIAL_ENV]: credential } : {};
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sameSecret(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * May this request speak as `claimedSession`? A session with a stored credential only accepts a request that presents it; a session
 * without one (unknown name, transport session, legacy process) keeps the existing name-only behaviour, which the route handlers
 * still validate against the session store.
 */
export function hookClaimAllowed(
  claimedSession: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!claimedSession) return true;
  const expected = getSession(claimedSession)?.hookCredential;
  if (!expected) return true;
  const presented = headerValue(headers[HOOK_SESSION_CREDENTIAL_HEADER]);
  return typeof presented === 'string' && presented.length > 0 && sameSecret(expected, presented);
}
