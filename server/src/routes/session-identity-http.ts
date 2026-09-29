import { createHash, randomUUID } from 'node:crypto';
import type { Context, Input } from 'hono';
import type { Env } from '../env.js';
import {
  deleteSessionIdentityProfile,
  deleteSessionIdentityMetadata,
  getSessionIdentityProfile,
  getSessionIdentityMetadata,
  upsertSessionIdentityMetadata,
  upsertSessionIdentityProfile,
} from '../db/session-identity-queries.js';
import { WsBridge } from '../ws/bridge.js';
import { SESSION_IDENTITY_LOCAL_RPC_TIMEOUT_MS } from '../../../shared/session-identity-ws.js';
import {
  SESSION_IDENTITY_SCOPES,
  SESSION_IDENTITY_SOURCE_FILE_MAX_CHARS,
  isSessionIdentityScope,
  normalizeSessionIdentityContent,
  sessionIdentityContentLength,
  type SessionIdentityScope,
  sessionIdentityContentError,
  sessionIdentityScopeKeyError,
} from '../../../shared/session-identity.js';

type IdentityHttpEnv<TVariables extends object> = { Bindings: Env; Variables: TVariables };

function readScope<TVariables extends object, TPath extends string, TInput extends Input>(
  c: Context<IdentityHttpEnv<TVariables>, TPath, TInput>,
) {
  const scope = c.req.query('scope');
  return isSessionIdentityScope(scope) ? scope : null;
}

function normalizedScopeKey(scope: ReturnType<typeof readScope>, raw: unknown): string | null {
  if (!scope || sessionIdentityScopeKeyError(scope, raw) !== null) return null;
  return scope === SESSION_IDENTITY_SCOPES.USER ? '' : String(raw).trim();
}

/**
 * Resolves the authoritative scope key for a session-bound request. A string
 * replaces whatever key the browser sent; null keeps the browser's key.
 */
export type SessionIdentityCanonicalScopeKey = (scope: SessionIdentityScope) => string | null;

function resolveScopeKey(
  scope: ReturnType<typeof readScope>,
  raw: unknown,
  canonical?: SessionIdentityCanonicalScopeKey,
): string | null {
  const resolved = scope && canonical ? canonical(scope) : null;
  return normalizedScopeKey(scope, resolved ?? raw);
}

/**
 * A PROJECT/SESSION daemon-local RPC call, shared by get/set/delete below.
 * Never HTTP: the daemon is reached only over its existing WebSocket, so a
 * flaky daemon<->server HTTP link can never make this hang or 502.
 */
async function callDaemonLocal<
  TVariables extends object, TPath extends string, TInput extends Input,
>(
  c: Context<IdentityHttpEnv<TVariables>, TPath, TInput>,
  serverId: string | undefined,
  payload: { op: 'get' | 'set' | 'delete'; scope: 'project' | 'session'; scopeKey: string; content?: string; source?: 'web' | 'mcp'; sourceFile?: string },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  if (!serverId) {
    return { ok: false, response: c.json({ error: 'identity_server_required' }, 400) };
  }
  const bridge = WsBridge.get(serverId);
  if (!bridge.isDaemonConnected()) {
    return { ok: false, response: c.json({ error: 'daemon_offline' }, 409) };
  }
  try {
    const body = await bridge.sendSessionIdentityLocalRequest(
      `identity-${randomUUID()}`,
      payload,
      SESSION_IDENTITY_LOCAL_RPC_TIMEOUT_MS,
    );
    if (body.status !== 'ok') {
      return { ok: false, response: c.json({ error: typeof body.error === 'string' ? body.error : 'identity_local_failed' }, 502) };
    }
    return { ok: true, body };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'daemon_offline';
    const status = reason === 'timeout' ? 504 : 409;
    return { ok: false, response: c.json({ error: reason === 'timeout' ? 'daemon_timeout' : 'daemon_offline' }, status) };
  }
}

/** Shared HTTP implementation; callers supply the authoritative profile owner. */
export async function handleSessionIdentityGet<
  TVariables extends object,
  TPath extends string,
  TInput extends Input,
>(
  c: Context<IdentityHttpEnv<TVariables>, TPath, TInput>,
  ownerUserId: string,
  canonicalScopeKey?: SessionIdentityCanonicalScopeKey,
  serverId?: string,
): Promise<Response> {
  const scope = readScope(c);
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = resolveScopeKey(scope, c.req.query('scopeKey'), canonicalScopeKey);
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  if (scope === SESSION_IDENTITY_SCOPES.USER) {
    const profile = await getSessionIdentityProfile(c.env.DB, ownerUserId, scope, scopeKey);
    return c.json({ profile });
  }
  const daemon = await callDaemonLocal(c, serverId, { op: 'get', scope, scopeKey });
  if (!daemon.ok) {
    // The daemon (the only content source for this scope) is unreachable --
    // fall back to the metadata row so the editor can at least show hash/
    // revision instead of an opaque failure, with no content.
    const metadata = await getSessionIdentityMetadata(c.env.DB, ownerUserId, scope, scopeKey);
    if (metadata) return c.json({ profile: metadata, contentUnavailable: true });
    return daemon.response;
  }
  const body = daemon.body;
  if (body.contentHash === undefined) return c.json({ profile: null });
  return c.json({
    profile: {
      scope, scopeKey,
      content: typeof body.content === 'string' ? body.content : '',
      contentHash: body.contentHash,
      revision: typeof body.revision === 'number' ? body.revision : 1,
      updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now(),
      source: 'mcp',
    },
  });
}

export async function handleSessionIdentityPut<
  TVariables extends object,
  TPath extends string,
  TInput extends Input,
>(
  c: Context<IdentityHttpEnv<TVariables>, TPath, TInput>,
  ownerUserId: string,
  canonicalScopeKey?: SessionIdentityCanonicalScopeKey,
  serverId?: string,
): Promise<Response> {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'identity_request_invalid' }, 400);
  const scope = isSessionIdentityScope(body.scope) ? body.scope : null;
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = resolveScopeKey(scope, body.scopeKey, canonicalScopeKey);
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  const contentReason = sessionIdentityContentError(body.content, scope);
  if (contentReason) return c.json({ error: contentReason }, 400);
  const content = normalizeSessionIdentityContent(String(body.content));
  const sourceFile = typeof body.sourceFile === 'string' ? body.sourceFile.trim() : '';
  if (Array.from(sourceFile).length > SESSION_IDENTITY_SOURCE_FILE_MAX_CHARS || sourceFile.includes('\0')) {
    return c.json({ error: 'identity_source_file_invalid' }, 400);
  }
  if (scope === SESSION_IDENTITY_SCOPES.USER) {
    const result = await upsertSessionIdentityProfile(c.env.DB, {
      userId: ownerUserId,
      scope,
      scopeKey,
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      source: 'web',
      sourceFile: sourceFile || undefined,
    });
    // No expected revision is supplied: identity edits are explicit
    // last-write-wins operations. Keep the impossible defensive branch from
    // masquerading as an optimistic-lock conflict to the UI.
    if (result === 'revision_conflict') return c.json({ error: 'identity_write_failed' }, 500);
    // Deliver to every online daemon of this account over WS -- never a
    // daemon-initiated HTTP poll (owner rule, tsk_cd_identity_daemon_storage).
    void WsBridge.pushSessionIdentityUserToOnlineDaemonsForUser(ownerUserId, result).catch(() => {});
    return c.json({ profile: result });
  }
  const daemon = await callDaemonLocal(c, serverId, {
    op: 'set', scope, scopeKey, content, source: 'web', sourceFile: sourceFile || undefined,
  });
  if (!daemon.ok) return daemon.response;
  const daemonBody = daemon.body;
  const contentHash = typeof daemonBody.contentHash === 'string' ? daemonBody.contentHash : createHash('sha256').update(content, 'utf8').digest('hex');
  const metadata = await upsertSessionIdentityMetadata(c.env.DB, {
    userId: ownerUserId, scope, scopeKey, contentHash,
    contentLength: sessionIdentityContentLength(content),
    source: 'web',
    sourceFile: sourceFile || undefined,
  });
  return c.json({ profile: { ...metadata, content } });
}

export async function handleSessionIdentityDelete<
  TVariables extends object,
  TPath extends string,
  TInput extends Input,
>(
  c: Context<IdentityHttpEnv<TVariables>, TPath, TInput>,
  ownerUserId: string,
  canonicalScopeKey?: SessionIdentityCanonicalScopeKey,
  serverId?: string,
): Promise<Response> {
  const scope = readScope(c);
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = resolveScopeKey(scope, c.req.query('scopeKey'), canonicalScopeKey);
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  if (scope === SESSION_IDENTITY_SCOPES.USER) {
    const result = await deleteSessionIdentityProfile(c.env.DB, ownerUserId, scope, scopeKey);
    if (result === 'deleted') void WsBridge.pushSessionIdentityUserDeleteToOnlineDaemonsForUser(ownerUserId).catch(() => {});
    return c.json({ deleted: result === 'deleted' });
  }
  const daemon = await callDaemonLocal(c, serverId, { op: 'delete', scope, scopeKey });
  if (!daemon.ok) return daemon.response;
  const deleted = await deleteSessionIdentityMetadata(c.env.DB, ownerUserId, scope, scopeKey);
  return c.json({ deleted });
}
