/**
 * Daemon-side cache of the user's global supervision defaults.
 *
 * Why this exists: the web client mirrors `globalCustomInstructions` into the
 * CURRENTLY-edited session's `transportConfig.supervision` when a user saves
 * the Session Settings dialog. Any OTHER session's cached snapshot retains
 * the old (or empty) mirror. When the supervisor fires against those other
 * sessions, `resolveEffectiveCustomInstructions(snapshot)` sees an empty
 * global layer and the user's "Always commit and push if asked!" never
 * reaches the prompt.
 *
 * This cache is the fallback layer: the daemon polls the user's current
 * defaults at startup + on each WS reconnect and stores the parsed result
 * in-process. When a snapshot has no `globalCustomInstructions`, callers
 * read `getCachedGlobalCustomInstructions()` and use that instead. No code
 * path silently loses the user's instruction.
 *
 * The cache is best-effort: fetch failures do not throw; the daemon falls
 * through to the (possibly stale) snapshot mirror and continues operating.
 * A non-null cache is always more recent than a session snapshot that
 * predates a global-defaults edit.
 */
import logger from '../util/logger.js';
import { loadCredentials } from '../bind/bind-flow.js';

let cachedGlobalCustomInstructions: string | null = null;
let lastFetchedAt = 0;

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
    const body = await response.json() as { defaults?: Record<string, unknown> | null };
    const defaults = body?.defaults ?? null;
    const next = typeof defaults?.customInstructions === 'string'
      ? defaults.customInstructions.trim() || null
      : null;
    if (next !== cachedGlobalCustomInstructions) {
      logger.info({
        previousLength: cachedGlobalCustomInstructions?.length ?? 0,
        nextLength: next?.length ?? 0,
      }, 'supervisor-defaults-cache: globalCustomInstructions changed');
    }
    cachedGlobalCustomInstructions = next;
    lastFetchedAt = Date.now();
  } catch (err) {
    logger.debug({ err }, 'supervisor-defaults-cache: fetch failed — keeping previous value');
  }
}

/**
 * Return the cached global custom instructions string. `null` means either
 * not-fetched-yet or the user has no global defaults. Callers use this as a
 * fallback; they should prefer `snapshot.globalCustomInstructions` when set.
 */
export function getCachedGlobalCustomInstructions(): string | null {
  return cachedGlobalCustomInstructions;
}

/** When was the last SUCCESSFUL fetch? 0 means never. */
export function getSupervisorDefaultsCacheAgeMs(): number {
  return lastFetchedAt === 0 ? Infinity : Date.now() - lastFetchedAt;
}

/** Test-only hook. Resets cache state between tests. */
export function __resetSupervisorDefaultsCacheForTests(): void {
  cachedGlobalCustomInstructions = null;
  lastFetchedAt = 0;
}
