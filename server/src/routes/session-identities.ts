import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import {
  deleteSessionIdentityProfile,
  getSessionIdentityProfile,
  listSessionIdentityProfiles,
  upsertSessionIdentityProfile,
} from '../db/session-identity-queries.js';
import {
  SESSION_IDENTITY_SCOPES,
  isSessionIdentityScope,
  normalizeSessionIdentityContent,
  sessionIdentityContentError,
  sessionIdentityScopeKeyError,
} from '../../../shared/session-identity.js';

export const sessionIdentityRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
sessionIdentityRoutes.use('/*', requireAuth());

function readScope(c: { req: { query(name: string): string | undefined } }) {
  const scope = c.req.query('scope');
  return isSessionIdentityScope(scope) ? scope : null;
}

function normalizedScopeKey(scope: ReturnType<typeof readScope>, raw: unknown): string | null {
  if (!scope) return null;
  if (sessionIdentityScopeKeyError(scope, raw) !== null) return null;
  return scope === SESSION_IDENTITY_SCOPES.USER ? '' : String(raw).trim();
}

/** One bounded snapshot lets every daemon synchronize all of its local sessions. */
sessionIdentityRoutes.get('/all', async (c) => {
  const profiles = await listSessionIdentityProfiles(c.env.DB, c.get('userId' as never) as string);
  return c.json({ profiles });
});

sessionIdentityRoutes.get('/', async (c) => {
  const scope = readScope(c);
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = normalizedScopeKey(scope, c.req.query('scopeKey'));
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  const profile = await getSessionIdentityProfile(
    c.env.DB,
    c.get('userId' as never) as string,
    scope,
    scopeKey,
  );
  return c.json({ profile });
});

sessionIdentityRoutes.put('/', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'identity_request_invalid' }, 400);
  const scope = isSessionIdentityScope(body.scope) ? body.scope : null;
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = normalizedScopeKey(scope, body.scopeKey);
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  const contentReason = sessionIdentityContentError(body.content);
  if (contentReason) return c.json({ error: contentReason }, 400);
  const content = normalizeSessionIdentityContent(String(body.content));
  const expectedRevision = typeof body.expectedRevision === 'number'
    && Number.isSafeInteger(body.expectedRevision)
    && body.expectedRevision >= 0
    ? body.expectedRevision
    : undefined;
  const result = await upsertSessionIdentityProfile(c.env.DB, {
    userId: c.get('userId' as never) as string,
    scope,
    scopeKey,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    source: c.req.header('X-Server-Id') ? 'mcp' : 'web',
    expectedRevision,
  });
  if (result === 'revision_conflict') return c.json({ error: result }, 409);
  return c.json({ profile: result });
});

sessionIdentityRoutes.delete('/', async (c) => {
  const scope = readScope(c);
  if (!scope) return c.json({ error: 'identity_scope_invalid' }, 400);
  const scopeKey = normalizedScopeKey(scope, c.req.query('scopeKey'));
  if (scopeKey === null) return c.json({ error: 'identity_scope_key_invalid' }, 400);
  const revisionText = c.req.query('expectedRevision');
  const expectedRevision = revisionText && /^\d+$/.test(revisionText) ? Number(revisionText) : undefined;
  const result = await deleteSessionIdentityProfile(
    c.env.DB,
    c.get('userId' as never) as string,
    scope,
    scopeKey,
    expectedRevision,
  );
  if (result === 'revision_conflict') return c.json({ error: result }, 409);
  return c.json({ deleted: result === 'deleted' });
});
