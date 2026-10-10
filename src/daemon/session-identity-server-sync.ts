/**
 * Daemon-side handling of the server<->daemon WS identity protocol
 * (shared/session-identity-ws.ts). Never HTTP (owner rule,
 * tsk_cd_identity_daemon_storage) -- the daemon is the sole content owner
 * for PROJECT/SESSION scope and answers the server's requests locally; for
 * USER scope (content stays server-side) it applies whatever the server
 * pushes and reports its own local writes back.
 */
import { SESSION_IDENTITY_WS } from '../../shared/session-identity-ws.js';
import {
  SESSION_IDENTITY_SCOPES,
  sessionIdentityProjectKey,
  sessionIdentitySessionKey,
  type SessionIdentityScope,
} from '../../shared/session-identity.js';
import { listSessions } from '../store/session-store.js';
import type { ServerLink } from './server-link.js';
import {
  getLocalSessionIdentityProfile,
  isSessionIdentityMigrated,
  markSessionIdentityMigrated,
  putLocalSessionIdentityProfile,
  putLocalSessionIdentityProfileExact,
  removeLocalSessionIdentityProfile,
  removeLocalSessionIdentityProfileQuiet,
} from './session-identity-local-store.js';
import { syncSessionIdentities } from './session-identity-sync.js';

/** Server -> daemon: get/set/delete a PROJECT/SESSION profile on local disk. */
export async function handleSessionIdentityLocalRequest(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
  const op = cmd.op;
  const scope = cmd.scope === 'project' || cmd.scope === 'session' ? cmd.scope : undefined;
  const scopeKey = typeof cmd.scopeKey === 'string' ? cmd.scopeKey : undefined;
  const reply = (payload: Record<string, unknown>) => {
    serverLink.send({ type: SESSION_IDENTITY_WS.LOCAL_RESPONSE, requestId, op, scope, scopeKey, ...payload });
  };
  if (!requestId || !scope || !scopeKey) {
    reply({ status: 'error', error: 'identity_local_request_invalid' });
    return;
  }
  try {
    if (op === 'get') {
      const profile = await getLocalSessionIdentityProfile(scope, scopeKey);
      if (!profile) { reply({ status: 'ok' }); return; }
      reply({
        status: 'ok', content: profile.content, contentHash: profile.contentHash,
        revision: profile.revision, updatedAt: profile.updatedAt,
      });
      return;
    }
    if (op === 'set') {
      if (typeof cmd.content !== 'string') { reply({ status: 'error', error: 'identity_content_required' }); return; }
      const profile = await putLocalSessionIdentityProfile({
        scope, scopeKey, content: cmd.content,
        source: cmd.source === 'mcp' ? 'mcp' : 'web',
        sourceFile: typeof cmd.sourceFile === 'string' ? cmd.sourceFile : undefined,
      });
      reply({ status: 'ok', contentHash: profile.contentHash, revision: profile.revision, updatedAt: profile.updatedAt });
      void syncSessionIdentities();
      return;
    }
    if (op === 'delete') {
      await removeLocalSessionIdentityProfile(scope, scopeKey);
      reply({ status: 'ok' });
      void syncSessionIdentities();
      return;
    }
    reply({ status: 'error', error: 'identity_op_invalid' });
  } catch (err) {
    reply({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** Server -> daemon: USER-scope content changed (or was cleared) -- apply it locally. */
export async function handleSessionIdentityPush(cmd: Record<string, unknown>): Promise<void> {
  if (cmd.scope !== 'user') return;
  try {
    if (cmd.deleted === true) {
      await removeLocalSessionIdentityProfileQuiet(SESSION_IDENTITY_SCOPES.USER, '');
    } else if (typeof cmd.content === 'string' && typeof cmd.contentHash === 'string'
      && typeof cmd.revision === 'number' && typeof cmd.updatedAt === 'number') {
      await putLocalSessionIdentityProfileExact({
        scope: SESSION_IDENTITY_SCOPES.USER, scopeKey: '', content: cmd.content, contentHash: cmd.contentHash,
        revision: cmd.revision, updatedAt: cmd.updatedAt, source: 'web',
      });
    } else {
      return;
    }
    await syncSessionIdentities();
  } catch {
    // Best-effort: the next push or the periodic local reconciliation catches up.
  }
}

/** Daemon -> server, once at startup: propose the scope keys this daemon owns for migration. */
export async function requestSessionIdentityMigration(serverLink: ServerLink): Promise<void> {
  if (await isSessionIdentityMigrated()) return;
  const sessions = listSessions().filter((session) => session.state !== 'stopped');
  const candidates = new Map<string, { scope: SessionIdentityScope; scopeKey: string }>();
  for (const session of sessions) {
    const projectKey = sessionIdentityProjectKey({ contextNamespace: session.contextNamespace, project: session.projectName });
    if (projectKey) candidates.set(`project\0${projectKey}`, { scope: SESSION_IDENTITY_SCOPES.PROJECT, scopeKey: projectKey });
    // SESSION scope needs this daemon's own bound serverId; resolved lazily below.
  }
  const { loadCredentials } = await import('../bind/bind-flow.js');
  const serverId = (await loadCredentials().catch(() => undefined))?.serverId;
  if (serverId) {
    for (const session of sessions) {
      const sessionKey = sessionIdentitySessionKey(serverId, session.name);
      candidates.set(`session\0${sessionKey}`, { scope: SESSION_IDENTITY_SCOPES.SESSION, scopeKey: sessionKey });
    }
  }
  if (candidates.size === 0) {
    // Nothing local to migrate yet (no sessions at first boot); try again
    // once real sessions exist rather than marking done prematurely.
    return;
  }
  serverLink.send({
    type: SESSION_IDENTITY_WS.MIGRATE_REQUEST,
    requestId: `identity-migrate-${Date.now()}`,
    candidates: [...candidates.values()],
  });
}

/** Server -> daemon: the content it still had for our proposed candidates. */
export async function handleSessionIdentityMigrateResponse(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rows = Array.isArray(cmd.rows) ? cmd.rows : [];
  const confirmed: Array<{ scope: SessionIdentityScope; scopeKey: string; contentHash: string }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const scope = entry.scope === 'project' || entry.scope === 'session' ? entry.scope : undefined;
    const scopeKey = typeof entry.scopeKey === 'string' ? entry.scopeKey : undefined;
    const content = typeof entry.content === 'string' ? entry.content : undefined;
    const contentHash = typeof entry.contentHash === 'string' ? entry.contentHash : undefined;
    const revision = typeof entry.revision === 'number' ? entry.revision : undefined;
    const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : undefined;
    if (!scope || !scopeKey || content === undefined || !contentHash || revision === undefined || updatedAt === undefined) continue;
    // Never clobber content this daemon already has locally (e.g. it wrote
    // its own copy between requesting and receiving this migrate response).
    const existing = await getLocalSessionIdentityProfile(scope, scopeKey);
    if (existing) continue;
    const persisted = await putLocalSessionIdentityProfileExact({
      scope, scopeKey, content, contentHash, revision, updatedAt, source: 'mcp',
    });
    if (persisted.contentHash === contentHash) confirmed.push({ scope, scopeKey, contentHash });
  }
  // Mark done regardless of `rows.length` -- an empty response means the
  // server had nothing left for these candidates, which is success too.
  await markSessionIdentityMigrated();
  if (confirmed.length > 0) {
    serverLink.send({ type: SESSION_IDENTITY_WS.MIGRATE_CONFIRM, confirmed });
  }
  void syncSessionIdentities();
}
