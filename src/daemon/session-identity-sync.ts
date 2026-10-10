import { applyEffectiveSessionIdentity } from '../agent/session-manager.js';
import { listSessions } from '../store/session-store.js';
import { listLocalSessionIdentityProfiles } from './session-identity-local-store.js';
import { resolveEffectiveIdentities, type IdentityResolverDeps } from './session-identity-resolver.js';

/**
 * Periodic LOCAL reconciliation only -- a safety net that recomputes every
 * live session's rendered identity prompt from the daemon's own local cache
 * and applies it if it drifted. No network call of any kind: PROJECT/SESSION
 * content lives on this daemon already (session-identity-local-store.ts),
 * and USER-scope content arrives by server push (see WsBridge's
 * SESSION_IDENTITY_WS.PUSH handling), never a poll. Owner rule,
 * tsk_cd_identity_daemon_storage: the daemon must never call the server over
 * HTTP for identity.
 */
export const SESSION_IDENTITY_SYNC_INTERVAL_MS = 60_000;

export interface SessionIdentitySyncResult {
  status: 'ok' | 'error' | 'skipped';
  checked: number;
  changed: number;
  message?: string;
}

export interface SessionIdentitySyncDeps {
  listLocalProfiles?: typeof listLocalSessionIdentityProfiles;
  listLocalSessions?: typeof listSessions;
  applyIdentity?: typeof applyEffectiveSessionIdentity;
  /** This daemon's own bound serverId (for the SESSION-scope key). */
  boundServerId?: () => Promise<string | undefined>;
}

function resolverDeps(deps: SessionIdentitySyncDeps): IdentityResolverDeps {
  return {
    listProfiles: deps.listLocalProfiles ?? listLocalSessionIdentityProfiles,
    ...(deps.boundServerId ? { boundServerId: deps.boundServerId } : {}),
  };
}

export interface SessionIdentityRefreshAck {
  commandId: string;
  sessionName: string;
  status: 'ok' | 'error';
  error?: string;
}

let syncInFlight: Promise<SessionIdentitySyncResult> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

/** Recompute every live session's identity prompt from the local cache and apply on drift. */
export async function syncSessionIdentities(
  deps: SessionIdentitySyncDeps = {},
): Promise<SessionIdentitySyncResult> {
  // An explicit UI/MCP refresh must join an already-running periodic sync,
  // rather than report a false success before that sync has applied anything.
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const sessions = (deps.listLocalSessions ?? listSessions)().filter((session) => session.state !== 'stopped');
    // Throws when the identity store is unreadable: nothing is applied on a failed read (never "no identity").
    const resolved = await resolveEffectiveIdentities(sessions, resolverDeps(deps));
    let changed = 0;
    for (const session of sessions) {
      const identity = resolved.get(session.name);
      if (!identity || session.appliedIdentityHash === identity.hash) continue;
      (deps.applyIdentity ?? applyEffectiveSessionIdentity)(session.name, identity.prompt, { refresh: true });
      changed += 1;
    }
    return { status: 'ok', checked: sessions.length, changed };
  })();
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

/** Refresh one exact session from the local cache. */
export async function syncSessionIdentity(
  sessionName: string,
  deps: SessionIdentitySyncDeps = {},
): Promise<SessionIdentitySyncResult> {
  const session = (deps.listLocalSessions ?? listSessions)()
    .find((candidate) => candidate.name === sessionName && candidate.state !== 'stopped');
  if (!session) return { status: 'error', checked: 0, changed: 0, message: 'session identity target is unavailable' };
  const identity = (await resolveEffectiveIdentities([session], resolverDeps(deps))).get(session.name);
  if (!identity || session.appliedIdentityHash === identity.hash) {
    return { status: 'ok', checked: 1, changed: 0 };
  }
  (deps.applyIdentity ?? applyEffectiveSessionIdentity)(session.name, identity.prompt, { refresh: true });
  return { status: 'ok', checked: 1, changed: 1 };
}

/** Translate an explicit browser refresh into an acknowledgement only after
 * the runtime convergence has settled. Legacy fire-and-forget callers without
 * a command id still run the sync but do not receive an unsolicited ack. */
export async function syncSessionIdentitiesForCommand(
  command: Record<string, unknown>,
  runSync?: () => Promise<SessionIdentitySyncResult>,
): Promise<SessionIdentityRefreshAck | null> {
  const commandId = typeof command.commandId === 'string' ? command.commandId : '';
  const sessionName = typeof command.sessionName === 'string' ? command.sessionName : '';
  try {
    const result = await (runSync
      ? runSync()
      : sessionName ? syncSessionIdentity(sessionName) : syncSessionIdentities());
    if (!commandId || !sessionName) return null;
    return {
      commandId,
      sessionName,
      status: result.status === 'ok' ? 'ok' : 'error',
      ...(result.message ? { error: result.message } : {}),
    };
  } catch (reason) {
    if (!commandId || !sessionName) throw reason;
    return {
      commandId,
      sessionName,
      status: 'error',
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}

export function startSessionIdentitySync(
  onError: (message: string) => void = () => undefined,
): void {
  if (syncTimer) return;
  void syncSessionIdentities().then((result) => {
    if (result.status === 'error' && result.message) onError(result.message);
  });
  syncTimer = setInterval(() => {
    void syncSessionIdentities().then((result) => {
      if (result.status === 'error' && result.message) onError(result.message);
    });
  }, SESSION_IDENTITY_SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}

export function stopSessionIdentitySync(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}
