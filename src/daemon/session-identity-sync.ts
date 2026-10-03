import { applyEffectiveSessionIdentity } from '../agent/session-manager.js';
import { listSessions, type SessionRecord } from '../store/session-store.js';
import {
  SESSION_IDENTITY_SCOPES,
  renderSessionIdentityProfiles,
  sessionIdentityProjectKey,
  sessionIdentitySessionKey,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';
import { listLocalSessionIdentityProfiles } from './session-identity-local-store.js';
import { loadCredentials } from '../bind/bind-flow.js';

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

async function defaultBoundServerId(): Promise<string | undefined> {
  try {
    return (await loadCredentials())?.serverId;
  } catch {
    return undefined;
  }
}

export interface SessionIdentityRefreshAck {
  commandId: string;
  sessionName: string;
  status: 'ok' | 'error';
  error?: string;
}

let syncInFlight: Promise<SessionIdentitySyncResult> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

function profilesForSession(
  profiles: readonly SessionIdentityProfile[],
  session: SessionRecord,
  serverId: string,
): SessionIdentityProfile[] {
  const sessionKey = sessionIdentitySessionKey(serverId, session.name);
  const projectKey = sessionIdentityProjectKey({
    contextNamespace: session.contextNamespace,
    project: session.projectName,
  });
  return profiles.filter((profile) => (
    (profile.scope === SESSION_IDENTITY_SCOPES.USER && profile.scopeKey === '')
    || (profile.scope === SESSION_IDENTITY_SCOPES.PROJECT && profile.scopeKey === projectKey)
    || (profile.scope === SESSION_IDENTITY_SCOPES.SESSION && profile.scopeKey === sessionKey)
  ));
}

/** Recompute every live session's identity prompt from the local cache and apply on drift. */
export async function syncSessionIdentities(
  deps: SessionIdentitySyncDeps = {},
): Promise<SessionIdentitySyncResult> {
  // An explicit UI/MCP refresh must join an already-running periodic sync,
  // rather than report a false success before that sync has applied anything.
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const profiles = await (deps.listLocalProfiles ?? listLocalSessionIdentityProfiles)();
    const sessions = (deps.listLocalSessions ?? listSessions)().filter((session) => session.state !== 'stopped');
    const serverId = (await (deps.boundServerId ?? defaultBoundServerId)()) ?? '';
    let changed = 0;
    for (const session of sessions) {
      const prompt = renderSessionIdentityProfiles(profilesForSession(profiles, session, serverId));
      if ((session.identityPrompt?.trim() || undefined) === prompt) continue;
      (deps.applyIdentity ?? applyEffectiveSessionIdentity)(session.name, prompt, { refresh: true });
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
  const profiles = await (deps.listLocalProfiles ?? listLocalSessionIdentityProfiles)();
  const serverId = (await (deps.boundServerId ?? defaultBoundServerId)()) ?? '';
  const prompt = renderSessionIdentityProfiles(profilesForSession(profiles, session, serverId));
  if ((session.identityPrompt?.trim() || undefined) === prompt) {
    return { status: 'ok', checked: 1, changed: 0 };
  }
  (deps.applyIdentity ?? applyEffectiveSessionIdentity)(session.name, prompt, { refresh: true });
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
