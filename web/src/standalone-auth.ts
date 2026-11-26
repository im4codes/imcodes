import { configure, configureExpectedUserId } from './api.js';

/**
 * Hydrate API base URL and expected user identity from `localStorage['rcc_auth']`
 * for detached standalone windows. Missing, expired, or malformed `rcc_auth`
 * degrades gracefully to same-origin cookie session authentication without throwing.
 */
export function hydrateStandaloneAuthFromStorage(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null,
): void {
  if (!storage) return;
  try {
    const raw = storage.getItem('rcc_auth');
    if (!raw) return;
    const auth = JSON.parse(raw) as { userId?: unknown; baseUrl?: unknown } | null;
    if (typeof auth?.baseUrl === 'string' && auth.baseUrl) configure(auth.baseUrl);
    if (typeof auth?.userId === 'string' && auth.userId) configureExpectedUserId(auth.userId);
  } catch { /* API falls back to same-origin session authentication. */ }
}
