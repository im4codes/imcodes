import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { randomHex, signJwt } from '../security/crypto.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { getDbSessionsByServer, getSubSessionsByServer } from '../db/queries.js';
import { WsBridge } from '../ws/bridge.js';
import {
  createOrUpdateShare,
  deriveShareTransitionKey,
  listActiveSharesForUser,
  listManagedShares,
  normalizeExistingShareTarget,
  normalizeShareTargetInput,
  resolveEffectiveShareCoverage,
  revokeShare,
  shareTargetRef,
  shareTargetSessionName,
  updateShare,
  writeShareAuditEvent,
  type ShareRole,
  type ShareScopedTicketClaims,
  type ShareTarget,
  type ShareTargetInput,
} from '../db/tab-sharing.js';

export const tabSharingRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const shareRoleSchema = z.enum(['viewer', 'participant']);

const shareTargetInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server'), serverId: z.string().min(1) }),
  z.object({ kind: z.literal('main'), serverId: z.string().min(1), sessionName: z.string().min(1) }),
  z.object({
    kind: z.literal('subsession'),
    serverId: z.string().min(1),
    subSessionId: z.string().min(1).optional(),
    sessionName: z.string().min(1).optional(),
    subSessionDisplayName: z.string().optional(),
  }),
]);

const createShareSchema = z.object({
  target: shareTargetInputSchema,
  targetUserId: z.string().min(1),
  role: shareRoleSchema,
  expiresAt: z.number().int().positive().nullable().optional(),
});

const updateShareSchema = z.object({
  role: shareRoleSchema.optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
}).refine((body) => body.role !== undefined || Object.prototype.hasOwnProperty.call(body, 'expiresAt'), {
  message: 'empty_update',
});

const openShareSchema = z.object({ target: shareTargetInputSchema });
const ticketSchema = z.object({ target: shareTargetInputSchema });

function managedShareView(share: Awaited<ReturnType<typeof listManagedShares>>[number], user?: { id: string; display_name: string | null; username: string | null } | null) {
  return {
    id: share.id,
    target: share.target,
    targetRef: shareTargetRef(share.target),
    targetUser: user ? {
      id: user.id,
      displayName: user.display_name ?? user.username ?? user.id,
    } : { id: share.targetUserId, displayName: share.targetUserId },
    role: share.role,
    status: share.revokedAt !== null ? 'revoked' : 'active',
    expiresAt: share.expiresAt,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
    revokedAt: share.revokedAt,
  };
}

function recipientShareEntry(share: Awaited<ReturnType<typeof listActiveSharesForUser>>[number]) {
  return {
    id: share.id,
    serverId: share.serverId,
    target: share.target,
    targetRef: shareTargetRef(share.target),
    targetSessionName: shareTargetSessionName(share.target),
    role: share.role,
    availability: 'available',
    status: 'active',
    historyCutoffAt: 0,
    expiresAt: share.expiresAt,
  };
}

async function requireServerManager(db: Env['DB'], serverId: string, userId: string): Promise<boolean> {
  const role = await resolveServerRole(db, serverId, userId);
  return role === 'owner' || role === 'admin';
}

async function auditShareLifecycle(c: Context<{ Bindings: Env; Variables: { userId: string; role: string } }>, params: {
  actionType: 'share.create' | 'share.update' | 'share.revoke';
  decision: 'accepted' | 'rejected' | 'updated';
  actorUserId: string;
  targetUserId?: string | null;
  target: ShareTarget;
  shareId?: string | null;
  reason?: 'share-role-denied' | 'share-target-unavailable' | null;
  snapshot?: Record<string, unknown>;
  createdAt: number;
}): Promise<void> {
  const idempotencyKey = deriveShareTransitionKey({
    actionType: params.actionType,
    target: params.target,
    primaryShareId: params.shareId ?? null,
    transitionEpochMs: params.createdAt,
  });
  await writeShareAuditEvent(c.env.DB, {
    id: randomHex(16),
    serverId: params.target.serverId,
    actorKind: 'user',
    actorUserId: params.actorUserId,
    targetUserId: params.targetUserId ?? null,
    effectiveActorRole: 'server-manager',
    target: params.target,
    actionType: params.actionType,
    decision: params.decision,
    reason: params.reason ?? null,
    snapshot: params.snapshot ?? {},
    primaryShareId: params.shareId ?? null,
    idempotencyKey,
    createdAt: params.createdAt,
  });
}

tabSharingRoutes.get('/shares', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const shares = await listActiveSharesForUser(c.env.DB, userId, Date.now());
  return c.json({ shares: shares.map(recipientShareEntry) });
});

tabSharingRoutes.post('/shares/open', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json().catch(() => null);
  const parsed = openShareSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const target = await normalizeExistingShareTarget(c.env.DB, parsed.data.target as ShareTargetInput);
  if (!target) return c.json({ error: 'forbidden', reason: 'share-target-unavailable' }, 403);
  const coverage = await resolveEffectiveShareCoverage(c.env.DB, { userId, target, now: Date.now() });
  if (!coverage) return c.json({ error: 'forbidden', reason: 'share-revoked' }, 403);

  const server = await c.env.DB.queryOne<{ id: string; name: string; status: string | null; last_heartbeat_at: number | null }>(
    'SELECT id, name, status, last_heartbeat_at FROM servers WHERE id = $1',
    [target.serverId],
  );
  if (!server) return c.json({ error: 'forbidden', reason: 'share-target-unavailable' }, 403);

  const mainRows = await getDbSessionsByServer(c.env.DB, target.serverId);
  const subRows = await getSubSessionsByServer(c.env.DB, target.serverId);
  const sessions = target.kind === 'server'
    ? mainRows
    : target.kind === 'main'
      ? mainRows.filter((session) => session.name === target.sessionName)
      : [];
  const subSessions = target.kind === 'server'
    ? subRows
    : target.kind === 'subsession'
      ? subRows.filter((subSession) => subSession.id === target.subSessionId)
      : [];

  return c.json({
    server: {
      id: server.id,
      name: server.name,
      status: server.status,
      lastHeartbeatAt: server.last_heartbeat_at,
    },
    target,
    coverage,
    sessions: sessions.map((session) => ({
      sessionName: session.name,
      title: session.label?.trim() || session.project_name,
      state: session.state,
      agentType: session.agent_type,
    })),
    subSessions: subSessions.map((subSession) => ({
      subSessionId: subSession.id,
      sessionName: `deck_sub_${subSession.id}`,
      title: subSession.label?.trim() || subSession.type,
      type: subSession.type,
      parentSessionName: subSession.parent_session,
    })),
  });
});

tabSharingRoutes.post('/shares/ws-ticket', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json().catch(() => null);
  const parsed = ticketSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const target = await normalizeExistingShareTarget(c.env.DB, parsed.data.target as ShareTargetInput);
  if (!target) return c.json({ error: 'forbidden', reason: 'share-target-unavailable' }, 403);
  const issuedAt = Date.now();
  const snapshot = await resolveEffectiveShareCoverage(c.env.DB, { userId, target, now: issuedAt });
  if (!snapshot) return c.json({ error: 'forbidden', reason: 'share-revoked' }, 403);
  const maxExpiresAt = issuedAt + 30_000;
  const expiresAt = snapshot.nextCoverageRecheckAt === null
    ? maxExpiresAt
    : Math.min(maxExpiresAt, snapshot.nextCoverageRecheckAt);
  if (expiresAt <= issuedAt) return c.json({ error: 'forbidden', reason: 'share-expired' }, 403);

  const claims: ShareScopedTicketClaims = {
    type: 'share-ws-ticket',
    sub: userId,
    jti: randomHex(16),
    serverId: target.serverId,
    target,
    snapshot,
    issuedAt,
    expiresAt,
  };
  const ttlSeconds = Math.max(1, Math.ceil((expiresAt - issuedAt) / 1000));
  const ticket = signJwt(claims as unknown as Record<string, unknown>, c.env.JWT_SIGNING_KEY, ttlSeconds);
  return c.json({ ticket, claims });
});

tabSharingRoutes.get('/server/:serverId/shares', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId') ?? '';
  if (!await requireServerManager(c.env.DB, serverId, userId)) return c.json({ error: 'forbidden' }, 403);
  const shares = await listManagedShares(c.env.DB, serverId);
  const userIds = [...new Set(shares.map((share) => share.targetUserId))];
  const users = userIds.length === 0 ? [] : await c.env.DB.query<{ id: string; display_name: string | null; username: string | null }>(
    `SELECT id, display_name, username FROM users WHERE id = ANY($1::text[])`,
    [userIds],
  );
  const userById = new Map(users.map((user) => [user.id, user]));
  return c.json({ shares: shares.map((share) => managedShareView(share, userById.get(share.targetUserId))) });
});

tabSharingRoutes.post('/server/:serverId/shares', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId') ?? '';
  const body = await c.req.json().catch(() => null);
  const parsed = createShareSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  if (parsed.data.target.serverId !== serverId) return c.json({ error: 'invalid_body', reason: 'server_mismatch' }, 400);
  const normalizedTarget = normalizeShareTargetInput(parsed.data.target as ShareTargetInput);
  const now = Date.now();
  if (!normalizedTarget) return c.json({ error: 'invalid_body', reason: 'invalid_target' }, 400);
  if (!await requireServerManager(c.env.DB, serverId, userId)) {
    await auditShareLifecycle(c, {
      actionType: 'share.create',
      decision: 'rejected',
      actorUserId: userId,
      targetUserId: parsed.data.targetUserId,
      target: normalizedTarget,
      reason: 'share-role-denied',
      createdAt: now,
    });
    return c.json({ error: 'forbidden' }, 403);
  }
  if (parsed.data.targetUserId === userId) return c.json({ error: 'invalid_body', reason: 'self_share_denied' }, 400);
  const target = await normalizeExistingShareTarget(c.env.DB, parsed.data.target as ShareTargetInput);
  if (!target) return c.json({ error: 'invalid_body', reason: 'share-target-unavailable' }, 400);
  const targetUser = await c.env.DB.queryOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [parsed.data.targetUserId]);
  if (!targetUser) return c.json({ error: 'invalid_body', reason: 'target_user_unavailable' }, 400);

  const share = await createOrUpdateShare(c.env.DB, {
    id: randomHex(16),
    target,
    targetUserId: parsed.data.targetUserId,
    role: parsed.data.role as ShareRole,
    createdBy: userId,
    expiresAt: parsed.data.expiresAt ?? null,
    now,
  });
  await auditShareLifecycle(c, {
    actionType: share.createdAt === now ? 'share.create' : 'share.update',
    decision: share.createdAt === now ? 'accepted' : 'updated',
    actorUserId: userId,
    targetUserId: parsed.data.targetUserId,
    target,
    shareId: share.id,
    snapshot: { role: share.role, expiresAt: share.expiresAt },
    createdAt: now,
  });
  void WsBridge.get(serverId).revalidateShareSocketsForUser(share.targetUserId);
  return c.json({ share: managedShareView(share) }, share.createdAt === now ? 201 : 200);
});

tabSharingRoutes.patch('/server/:serverId/shares/:shareId', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId') ?? '';
  if (!await requireServerManager(c.env.DB, serverId, userId)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => null);
  const parsed = updateShareSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const now = Date.now();
  const share = await updateShare(c.env.DB, {
    shareId: c.req.param('shareId') ?? '',
    serverId,
    role: parsed.data.role,
    expiresAt: parsed.data.expiresAt,
    now,
  });
  if (!share) return c.json({ error: 'not_found' }, 404);
  await auditShareLifecycle(c, {
    actionType: 'share.update',
    decision: 'updated',
    actorUserId: userId,
    targetUserId: share.targetUserId,
    target: share.target,
    shareId: share.id,
    snapshot: { role: share.role, expiresAt: share.expiresAt },
    createdAt: now,
  });
  void WsBridge.get(serverId).revalidateShareSocketsForUser(share.targetUserId);
  return c.json({ share: managedShareView(share) });
});

tabSharingRoutes.delete('/server/:serverId/shares/:shareId', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId') ?? '';
  if (!await requireServerManager(c.env.DB, serverId, userId)) return c.json({ error: 'forbidden' }, 403);
  const now = Date.now();
  const share = await revokeShare(c.env.DB, { shareId: c.req.param('shareId') ?? '', serverId, now });
  if (!share) return c.json({ error: 'not_found' }, 404);
  await auditShareLifecycle(c, {
    actionType: 'share.revoke',
    decision: 'updated',
    actorUserId: userId,
    targetUserId: share.targetUserId,
    target: share.target,
    shareId: share.id,
    snapshot: { revokedAt: share.revokedAt },
    createdAt: now,
  });
  void WsBridge.get(serverId).revalidateShareSocketsForUser(share.targetUserId);
  return c.json({ share: managedShareView(share) });
});

tabSharingRoutes.get('/server/:serverId/share-audit', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId') ?? '';
  if (!await requireServerManager(c.env.DB, serverId, userId)) return c.json({ error: 'forbidden' }, 403);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 100);
  const rows = await c.env.DB.query<Record<string, unknown>>(
    `SELECT id, server_id, actor_kind, actor_user_id, target_user_id, effective_actor_role,
            target_kind, target_ref, action_type, decision, reason, snapshot,
            primary_share_id, action_id, idempotency_key, created_at
       FROM share_audit_events
      WHERE server_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [serverId, limit],
  );
  return c.json({ events: rows });
});
