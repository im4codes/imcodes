import { applyEffectiveSessionIdentity } from '../agent/session-manager.js';
import { listSessions, type SessionRecord } from '../store/session-store.js';
import {
  SESSION_IDENTITY_SCOPES,
  renderSessionIdentityProfiles,
  sessionIdentityProjectKey,
  sessionIdentitySessionKey,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';
import {
  getEffectiveSessionIdentityProfiles,
  listSessionIdentityProfiles,
  type SessionIdentityClientOptions,
} from './session-identity-mcp-client.js';

export const SESSION_IDENTITY_SYNC_INTERVAL_MS = 60_000;
const SESSION_IDENTITY_HYDRATION_CONCURRENCY = 4;

export interface SessionIdentitySyncResult {
  status: 'ok' | 'error' | 'skipped';
  checked: number;
  changed: number;
  message?: string;
}

export interface SessionIdentitySyncDeps {
  listProfiles?: typeof listSessionIdentityProfiles;
  getEffectiveProfiles?: typeof getEffectiveSessionIdentityProfiles;
  listLocalSessions?: typeof listSessions;
  applyIdentity?: typeof applyEffectiveSessionIdentity;
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

async function hydrateTruncatedProfiles(
  sessions: readonly SessionRecord[],
  snapshot: { profiles: SessionIdentityProfile[]; serverId: string },
  options: SessionIdentityClientOptions,
  getEffective: typeof getEffectiveSessionIdentityProfiles,
): Promise<{ profiles: SessionIdentityProfile[]; error?: string }> {
  const merged = new Map(snapshot.profiles.map((profile) => [
    `${profile.scope}\0${profile.scopeKey}`,
    profile,
  ]));
  let next = 0;
  let firstError: string | undefined;
  const worker = async () => {
    while (next < sessions.length) {
      const session = sessions[next++];
      if (!session) continue;
      const result = await getEffective({
        projectKey: sessionIdentityProjectKey({
          contextNamespace: session.contextNamespace,
          project: session.projectName,
        }),
        sessionName: session.name,
      }, options);
      if (result.status !== 'ok') {
        firstError ??= result.message;
        continue;
      }
      for (const profile of result.profiles) {
        merged.set(`${profile.scope}\0${profile.scopeKey}`, profile);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SESSION_IDENTITY_HYDRATION_CONCURRENCY, sessions.length) }, worker));
  return { profiles: [...merged.values()], ...(firstError ? { error: firstError } : {}) };
}

/**
 * Fetch one user-scoped snapshot and converge every local session. This is
 * deliberately one HTTP request per daemon rather than three per session.
 */
export async function syncSessionIdentities(
  options: SessionIdentityClientOptions = {},
  deps: SessionIdentitySyncDeps = {},
): Promise<SessionIdentitySyncResult> {
  // An explicit UI/MCP refresh must join an already-running periodic sync,
  // rather than report a false success before that sync has applied anything.
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const snapshot = await (deps.listProfiles ?? listSessionIdentityProfiles)(options);
    if (snapshot.status !== 'ok') {
      return { status: 'error', checked: 0, changed: 0, message: snapshot.message };
    }
    const sessions = (deps.listLocalSessions ?? listSessions)().filter((session) => session.state !== 'stopped');
    const hydrated = snapshot.truncated
      ? await hydrateTruncatedProfiles(
        sessions,
        snapshot,
        options,
        deps.getEffectiveProfiles ?? getEffectiveSessionIdentityProfiles,
      )
      : { profiles: snapshot.profiles };
    if (hydrated.error) return { status: 'error', checked: sessions.length, changed: 0, message: hydrated.error };
    const profiles = hydrated.profiles;
    let changed = 0;
    for (const session of sessions) {
      const prompt = renderSessionIdentityProfiles(
        profilesForSession(profiles, session, snapshot.serverId),
      );
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

/**
 * Refresh one exact session from a snapshot fetched after the user's write.
 * Do not join the periodic all-session request: that request may already hold
 * a pre-write snapshot and would acknowledge the save without applying it.
 */
export async function syncSessionIdentity(
  sessionName: string,
  options: SessionIdentityClientOptions = {},
  deps: SessionIdentitySyncDeps = {},
): Promise<SessionIdentitySyncResult> {
  const session = (deps.listLocalSessions ?? listSessions)()
    .find((candidate) => candidate.name === sessionName && candidate.state !== 'stopped');
  if (!session) return { status: 'error', checked: 0, changed: 0, message: 'session identity target is unavailable' };
  const snapshot = deps.listProfiles
    ? await deps.listProfiles(options)
    : await (deps.getEffectiveProfiles ?? getEffectiveSessionIdentityProfiles)({
      projectKey: sessionIdentityProjectKey({
        contextNamespace: session.contextNamespace,
        project: session.projectName,
      }),
      sessionName: session.name,
    }, options);
  if (snapshot.status !== 'ok') return { status: 'error', checked: 1, changed: 0, message: snapshot.message };
  const hydrated = ('truncated' in snapshot && snapshot.truncated)
    ? await (deps.getEffectiveProfiles ?? getEffectiveSessionIdentityProfiles)({
      projectKey: sessionIdentityProjectKey({
        contextNamespace: session.contextNamespace,
        project: session.projectName,
      }),
      sessionName: session.name,
    }, options)
    : snapshot;
  if (hydrated.status !== 'ok') return { status: 'error', checked: 1, changed: 0, message: hydrated.message };
  const profiles = deps.listProfiles && !('truncated' in snapshot && snapshot.truncated)
    ? profilesForSession(hydrated.profiles, session, snapshot.serverId)
    : hydrated.profiles;
  const prompt = renderSessionIdentityProfiles(
    profiles,
  );
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
  options: SessionIdentityClientOptions = {},
  onError: (message: string) => void = () => undefined,
): void {
  if (syncTimer) return;
  void syncSessionIdentities(options).then((result) => {
    if (result.status === 'error' && result.message) onError(result.message);
  });
  syncTimer = setInterval(() => {
    void syncSessionIdentities(options).then((result) => {
      if (result.status === 'error' && result.message) onError(result.message);
    });
  }, SESSION_IDENTITY_SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}

export function stopSessionIdentitySync(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}
