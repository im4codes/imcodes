import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  getDiscussionCommentsByThread,
  getDiscussionCommentsByScope,
  getDiscussionsByServer,
  getDiscussionById,
  getDiscussionRounds,
  getOrchestrationRunsByDiscussion,
  getOrchestrationRunById,
  getRecentOrchestrationRuns,
  getShareScopedOrchestrationRunById,
  getShareScopedOrchestrationRunsByDiscussion,
  getShareScopedRecentOrchestrationRuns,
  getUserById,
  insertDiscussionComment,
  type DbOrchestrationRun,
} from '../db/queries.js';
import { sanitizeLegacyP2pProgressSnapshot } from '../p2p-workflow-sanitize.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import {
  deriveShareTransitionKey,
  listActiveSharesForUser,
  normalizeExistingShareTarget,
  resolveEffectiveShareCoverage,
  shareTargetRef,
  writeShareAuditEvent,
  type EffectiveActorRole,
  type ShareAuthorizationSnapshot,
  type ShareTarget,
  type ShareTargetInput,
} from '../db/tab-sharing.js';
import {
  SHARE_BROWSER_COMMANDS,
  SHARE_DISCUSSION_EVENTS,
  shareTargetKey,
  type SharedActorEnvelope,
} from '../../../shared/tab-sharing.js';
import { toDiscussionCommentView } from '../share/discussion-comment-view.js';

type SanitizedDbOrchestrationRun = DbOrchestrationRun & {
  progress_snapshot_diagnostics: string[];
};

/**
 * Sanitize a single DB row's `progress_snapshot` JSON string at read time
 * (read-only — does not mutate the row in the database). Replaces the row's
 * `progress_snapshot` field with the sanitized persisted snapshot JSON, and
 * attaches a sibling `progress_snapshot_diagnostics: string[]` listing any
 * diagnostic codes (currently only `legacy_progress_snapshot_sanitized`).
 */
function sanitizeRunRow(row: DbOrchestrationRun): SanitizedDbOrchestrationRun {
  const result = sanitizeLegacyP2pProgressSnapshot(row.progress_snapshot ?? '', {
    runId: row.id,
    workflowId: row.discussion_id,
  });
  return {
    ...row,
    progress_snapshot: JSON.stringify(result.snapshot),
    progress_snapshot_diagnostics: result.diagnostic ? [result.diagnostic.code] : [],
  };
}

export const discussionRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

discussionRoutes.use('/*', requireAuth());

const MAX_COMMENT_BODY_CHARS = 20_000;

type EffectiveDiscussionActor =
  | {
      kind: 'member';
      effectiveActorRole: EffectiveActorRole;
      snapshot: ShareAuthorizationSnapshot;
    }
  | {
      kind: 'share';
      effectiveActorRole: EffectiveActorRole;
      snapshot: ShareAuthorizationSnapshot;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function runScopeTarget(run: DbOrchestrationRun): ShareTarget | null {
  if (run.scope_kind === 'server') {
    return { kind: 'server', serverId: run.scope_server_id ?? run.server_id };
  }
  if (run.scope_kind === 'main' && run.scope_server_id && run.scope_session_name) {
    return { kind: 'main', serverId: run.scope_server_id, sessionName: run.scope_session_name };
  }
  if (run.scope_kind === 'subsession' && run.scope_server_id && run.scope_sub_session_id) {
    return { kind: 'subsession', serverId: run.scope_server_id, subSessionId: run.scope_sub_session_id };
  }
  return null;
}

async function filterShareVisibleRuns(
  db: Env['DB'],
  userId: string,
  runs: DbOrchestrationRun[],
  now: number,
): Promise<DbOrchestrationRun[]> {
  const visible: DbOrchestrationRun[] = [];
  for (const run of runs) {
    const target = runScopeTarget(run);
    if (!target || typeof run.visible_after_ms !== 'number') continue;
    const coverage = await resolveEffectiveShareCoverage(db, { userId, target, now });
    if (!coverage) continue;
    visible.push(run);
  }
  return visible;
}

function memberSnapshot(target: ShareTarget, now: number): ShareAuthorizationSnapshot {
  return {
    target,
    effectiveRole: 'participant',
    historyCutoffAt: 0,
    nextCoverageRecheckAt: null,
    coveringShareIds: [],
    primaryShareId: null,
    authorizedAt: now,
  };
}

async function resolveDiscussionActor(
  db: Env['DB'],
  serverId: string,
  userId: string,
  target: ShareTarget,
  now: number,
): Promise<EffectiveDiscussionActor | null> {
  const serverRole = await resolveServerRole(db, serverId, userId);
  if (serverRole === 'owner' || serverRole === 'admin') {
    return { kind: 'member', effectiveActorRole: 'server-manager', snapshot: memberSnapshot(target, now) };
  }
  if (serverRole === 'member') {
    return { kind: 'member', effectiveActorRole: 'server-member', snapshot: memberSnapshot(target, now) };
  }

  const coverage = await resolveEffectiveShareCoverage(db, { userId, target, now });
  if (!coverage) return null;
  return { kind: 'share', effectiveActorRole: coverage.effectiveRole, snapshot: coverage };
}

async function buildActorEnvelope(
  db: Env['DB'],
  params: {
    userId: string;
    target: ShareTarget;
    actor: EffectiveDiscussionActor;
    actionId: string;
    now: number;
  },
): Promise<SharedActorEnvelope> {
  const user = await getUserById(db, params.userId);
  return {
    actorUserId: params.userId,
    actorDisplayName: user?.display_name ?? user?.username ?? params.userId,
    snapshot: params.actor.snapshot,
    primaryShareId: params.actor.snapshot.primaryShareId,
    effectiveActorRole: params.actor.effectiveActorRole,
    actionId: params.actionId,
    origin: params.actor.kind === 'member'
      ? 'server-member'
      : params.target.kind === 'server'
        ? 'shared-server'
        : 'shared-tab',
    authorizedAt: params.actor.snapshot.authorizedAt,
    queuedAt: params.now,
  };
}

async function auditShareComment(
  db: Env['DB'],
  params: {
    userId: string;
    target: ShareTarget;
    actor: EffectiveDiscussionActor;
    actionId: string;
    decision: 'accepted' | 'rejected';
    reason?: 'share-comment-invalid' | 'share-target-unavailable' | 'share-role-denied';
    now: number;
  },
): Promise<void> {
  if (params.actor.kind !== 'share') return;
  const auditEventId = randomHex(16);
  await writeShareAuditEvent(db, {
    id: auditEventId,
    serverId: params.target.serverId,
    actorKind: 'user',
    actorUserId: params.userId,
    effectiveActorRole: params.actor.effectiveActorRole,
    target: params.target,
    actionType: SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT,
    decision: params.decision,
    reason: params.reason ?? null,
    snapshot: params.actor.snapshot,
    primaryShareId: params.actor.snapshot.primaryShareId,
    actionId: params.actionId,
    idempotencyKey: deriveShareTransitionKey({
      actionType: SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT,
      target: params.target,
      primaryShareId: params.actor.snapshot.primaryShareId,
      transitionEpochMs: params.now,
      decision: params.decision,
      attemptId: auditEventId,
    }),
    createdAt: params.now,
  });
}

async function resolveReadRole(db: Env['DB'], serverId: string, userId: string): Promise<'member' | 'share' | 'none'> {
  const role = await resolveServerRole(db, serverId, userId);
  if (role !== 'none') return 'member';
  const shares = await listActiveSharesForUser(db, userId, Date.now());
  return shares.some((share) => share.serverId === serverId) ? 'share' : 'none';
}

/** GET /api/server/:id/discussions — list discussions for a server */
discussionRoutes.get('/:id/discussions', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveReadRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);
  if (role === 'share') return c.json({ discussions: [] });

  const discussions = await getDiscussionsByServer(c.env.DB, serverId);
  return c.json({ discussions });
});

/** GET /api/server/:id/discussions/comments — list scoped non-dispatch comments */
discussionRoutes.get('/:id/discussions/comments', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const kind = c.req.query('kind') ?? 'server';
  let scopeInput: ShareTargetInput | null = null;
  if (kind === 'main') {
    scopeInput = { kind, serverId, sessionName: c.req.query('sessionName') ?? '' };
  } else if (kind === 'subsession') {
    const subSessionId = c.req.query('subSessionId')?.trim();
    const sessionName = c.req.query('sessionName')?.trim();
    if (subSessionId) {
      scopeInput = { kind, serverId, subSessionId };
    } else if (sessionName?.startsWith('deck_sub_')) {
      scopeInput = { kind, serverId, sessionName: sessionName as `deck_sub_${string}` };
    }
  } else if (kind === 'server') {
    scopeInput = { kind: 'server', serverId };
  }
  if (!scopeInput) return c.json({ error: 'invalid_target' }, 400);
  const target = await normalizeExistingShareTarget(c.env.DB, scopeInput);
  if (!target) return c.json({ error: 'forbidden', reason: 'share-target-unavailable' }, 403);
  const actor = await resolveDiscussionActor(c.env.DB, serverId, userId, target, Date.now());
  if (!actor) return c.json({ error: 'forbidden', reason: 'share-target-unavailable' }, 403);
  const comments = await getDiscussionCommentsByScope(c.env.DB, serverId, target);
  return c.json({ comments: comments.map(toDiscussionCommentView), targetRef: shareTargetRef(target) });
});

/** GET /api/server/:id/discussions/:discussionId — get discussion detail with rounds */
discussionRoutes.get('/:id/discussions/:discussionId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const discussionId = c.req.param('discussionId')!;
  const role = await resolveReadRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);
  if (role === 'share') return c.json({ error: 'not_found' }, 404);

  const discussion = await getDiscussionById(c.env.DB, discussionId, serverId);
  if (!discussion) {
    return c.json({ error: 'not_found' }, 404);
  }

  const rounds = await getDiscussionRounds(c.env.DB, discussionId, serverId);
  const comments = await getDiscussionCommentsByThread(c.env.DB, serverId, discussionId);
  return c.json({ discussion, rounds, comments: comments.map(toDiscussionCommentView) });
});

/** GET /api/server/:id/discussions/:discussionId/runs — list orchestration runs */
discussionRoutes.get('/:id/discussions/:discussionId/runs', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const discussionId = c.req.param('discussionId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') {
    const rows = await getShareScopedOrchestrationRunsByDiscussion(c.env.DB, discussionId, serverId);
    const runs = await filterShareVisibleRuns(c.env.DB, userId, rows, Date.now());
    const hasServerShare = (await listActiveSharesForUser(c.env.DB, userId, Date.now())).some((share) => share.serverId === serverId);
    if (!hasServerShare) return c.json({ error: 'forbidden' }, 403);
    return c.json({ runs: runs.map(sanitizeRunRow) });
  }

  const runs = await getOrchestrationRunsByDiscussion(c.env.DB, discussionId, serverId);
  return c.json({ runs: runs.map(sanitizeRunRow) });
});

/** POST /api/server/:id/discussions/comments — create a non-dispatch discussion comment */
discussionRoutes.post('/:id/discussions/comments', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const raw = await c.req.json().catch(() => null);
  if (!isRecord(raw)) return c.json({ error: 'invalid_body', reason: 'share-comment-invalid' }, 400);
  const type = typeof raw.type === 'string' ? raw.type : SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT;
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';

  const scopeInput = isRecord(raw.scope)
    ? raw.scope as ShareTargetInput
    : { kind: 'server', serverId } satisfies ShareTargetInput;
  if (scopeInput.serverId !== serverId) return c.json({ error: 'invalid_body', reason: 'server_mismatch' }, 400);

  const target = await normalizeExistingShareTarget(c.env.DB, scopeInput);
  if (!target) return c.json({ error: 'forbidden', reason: 'share-target-unavailable' }, 403);
  const now = Date.now();
  const actor = await resolveDiscussionActor(c.env.DB, serverId, userId, target, now);
  if (!actor) return c.json({ error: 'forbidden', reason: 'share-target-unavailable' }, 403);

  const actionId = typeof raw.requestId === 'string' && raw.requestId.trim()
    ? raw.requestId.trim()
    : randomHex(16);
  if (type !== SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT || !body || body.length > MAX_COMMENT_BODY_CHARS) {
    await auditShareComment(c.env.DB, {
      userId,
      target,
      actor,
      actionId,
      decision: 'rejected',
      reason: 'share-comment-invalid',
      now,
    });
    return c.json({ error: 'invalid_body', reason: 'share-comment-invalid' }, 400);
  }
  const actorEnvelope = await buildActorEnvelope(c.env.DB, { userId, target, actor, actionId, now });
  const comment = await insertDiscussionComment(c.env.DB, {
    id: randomHex(16),
    serverId,
    threadId: typeof raw.threadId === 'string' && raw.threadId.trim() ? raw.threadId.trim() : shareTargetKey(target),
    scope: target,
    createdByUserId: userId,
    actorEnvelope,
    authorizationSnapshot: actor.snapshot,
    body,
    createdAt: now,
  });
  await auditShareComment(c.env.DB, {
    userId,
    target,
    actor,
    actionId,
    decision: 'accepted',
    now,
  });
  void import('../ws/bridge.js').then(({ WsBridge }) => {
    WsBridge.get(serverId).broadcastShareDiscussionComment(target, { type: SHARE_DISCUSSION_EVENTS.COMMENT_CREATED, comment: toDiscussionCommentView(comment), targetRef: shareTargetRef(target) });
  }).catch(() => undefined);
  return c.json({ type: SHARE_DISCUSSION_EVENTS.COMMENT_CREATED, comment: toDiscussionCommentView(comment), targetRef: shareTargetRef(target) }, 201);
});

/** GET /api/server/:id/p2p/runs — list recent P2P orchestration runs */
discussionRoutes.get('/:id/p2p/runs', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') {
    const rows = await getShareScopedRecentOrchestrationRuns(c.env.DB, serverId, 200);
    const runs = (await filterShareVisibleRuns(c.env.DB, userId, rows, Date.now())).slice(0, 50);
    const hasServerShare = (await listActiveSharesForUser(c.env.DB, userId, Date.now())).some((share) => share.serverId === serverId);
    if (!hasServerShare) return c.json({ error: 'forbidden' }, 403);
    return c.json({ runs: runs.map(sanitizeRunRow) });
  }

  const runs = await getRecentOrchestrationRuns(c.env.DB, serverId, 50);
  return c.json({ runs: runs.map(sanitizeRunRow) });
});

/** GET /api/server/:id/p2p/runs/:runId — get single orchestration run */
discussionRoutes.get('/:id/p2p/runs/:runId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const runId = c.req.param('runId')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') {
    const run = await getShareScopedOrchestrationRunById(c.env.DB, runId, serverId);
    if (!run) return c.json({ error: 'not_found' }, 404);
    const visible = await filterShareVisibleRuns(c.env.DB, userId, [run], Date.now());
    if (visible.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ run: sanitizeRunRow(run) });
  }

  const run = await getOrchestrationRunById(c.env.DB, runId, serverId);
  if (!run) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ run: sanitizeRunRow(run) });
});
