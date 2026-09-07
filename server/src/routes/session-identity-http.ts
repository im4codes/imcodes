import { createHash } from 'node:crypto';
import type { Context, Input } from 'hono';
import type { Env } from '../env.js';
import {
  deleteSessionIdentityProfile,
  getSessionIdentityProfile,
  upsertSessionIdentityProfile,
} from '../db/session-identity-queries.js';
import {
  SESSION_IDENTITY_SCOPES,
  SESSION_IDENTITY_SOURCE_FILE_MAX_CHARS,
  isSessionIdentityScope,
  normalizeSessionIdentityContent,
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

/** Shared HTTP implementation; callers supply the authoritative profile owner. */
export async function handleSessionIdentityGet<
  TVariables extends object,
  TPath extends string,
  TInput extends Input,
>(c: Context<IdentityHttpEnv<TVariables>, TPath, TInput>, ownerUserId: string): Promise<Response> {
  const scope = readScope(c);
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = normalizedScopeKey(scope, c.req.query('scopeKey'));
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  const profile = await getSessionIdentityProfile(c.env.DB, ownerUserId, scope, scopeKey);
  return c.json({ profile });
}

export async function handleSessionIdentityPut<
  TVariables extends object,
  TPath extends string,
  TInput extends Input,
>(c: Context<IdentityHttpEnv<TVariables>, TPath, TInput>, ownerUserId: string): Promise<Response> {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'identity_request_invalid' }, 400);
  const scope = isSessionIdentityScope(body.scope) ? body.scope : null;
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = normalizedScopeKey(scope, body.scopeKey);
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  const contentReason = sessionIdentityContentError(body.content, scope);
  if (contentReason) return c.json({ error: contentReason }, 400);
  const content = normalizeSessionIdentityContent(String(body.content));
  const sourceFile = typeof body.sourceFile === 'string' ? body.sourceFile.trim() : '';
  if (Array.from(sourceFile).length > SESSION_IDENTITY_SOURCE_FILE_MAX_CHARS || sourceFile.includes('\0')) {
    return c.json({ error: 'identity_source_file_invalid' }, 400);
  }
  const result = await upsertSessionIdentityProfile(c.env.DB, {
    userId: ownerUserId,
    scope,
    scopeKey,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    source: c.req.header('X-Server-Id') ? 'mcp' : 'web',
    sourceFile: sourceFile || undefined,
  });
  // No expected revision is supplied: identity edits are explicit
  // last-write-wins operations. Keep the impossible defensive branch from
  // masquerading as an optimistic-lock conflict to the UI.
  if (result === 'revision_conflict') return c.json({ error: 'identity_write_failed' }, 500);
  return c.json({ profile: result });
}

export async function handleSessionIdentityDelete<
  TVariables extends object,
  TPath extends string,
  TInput extends Input,
>(c: Context<IdentityHttpEnv<TVariables>, TPath, TInput>, ownerUserId: string): Promise<Response> {
  const scope = readScope(c);
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = normalizedScopeKey(scope, c.req.query('scopeKey'));
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  const result = await deleteSessionIdentityProfile(c.env.DB, ownerUserId, scope, scopeKey);
  return c.json({ deleted: result === 'deleted' });
}
