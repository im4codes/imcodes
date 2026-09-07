import { applyEffectiveSessionIdentity } from '../agent/session-manager.js';
import { listSessions, type SessionRecord } from '../store/session-store.js';
import {
  SESSION_IDENTITY_SCOPES,
  renderSessionIdentityProfiles,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';
import {
  listSessionIdentityProfiles,
  type SessionIdentityClientOptions,
} from './session-identity-mcp-client.js';

export const SESSION_IDENTITY_SYNC_INTERVAL_MS = 60_000;

export interface SessionIdentitySyncResult {
  status: 'ok' | 'error' | 'skipped';
  checked: number;
  changed: number;
  message?: string;
}

export interface SessionIdentitySyncDeps {
  listProfiles?: typeof listSessionIdentityProfiles;
  listLocalSessions?: typeof listSessions;
  applyIdentity?: typeof applyEffectiveSessionIdentity;
}

let syncInFlight: Promise<SessionIdentitySyncResult> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

function profilesForSession(
  profiles: readonly SessionIdentityProfile[],
  session: SessionRecord,
  serverId: string,
): SessionIdentityProfile[] {
  const sessionKey = `${serverId}:${session.name}`;
  const projectKey = session.contextNamespace?.projectId?.trim() || session.projectName;
  return profiles.filter((profile) => (
    (profile.scope === SESSION_IDENTITY_SCOPES.USER && profile.scopeKey === '')
    || (profile.scope === SESSION_IDENTITY_SCOPES.PROJECT && profile.scopeKey === projectKey)
    || (profile.scope === SESSION_IDENTITY_SCOPES.SESSION && profile.scopeKey === sessionKey)
  ));
}

/**
 * Fetch one user-scoped snapshot and converge every local session. This is
 * deliberately one HTTP request per daemon rather than three per session.
 */
export async function syncSessionIdentities(
  options: SessionIdentityClientOptions = {},
  deps: SessionIdentitySyncDeps = {},
): Promise<SessionIdentitySyncResult> {
  if (syncInFlight) return { status: 'skipped', checked: 0, changed: 0 };
  syncInFlight = (async () => {
    const snapshot = await (deps.listProfiles ?? listSessionIdentityProfiles)(options);
    if (snapshot.status !== 'ok') {
      return { status: 'error', checked: 0, changed: 0, message: snapshot.message };
    }
    const sessions = (deps.listLocalSessions ?? listSessions)().filter((session) => session.state !== 'stopped');
    let changed = 0;
    for (const session of sessions) {
      const prompt = renderSessionIdentityProfiles(
        profilesForSession(snapshot.profiles, session, snapshot.serverId),
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
