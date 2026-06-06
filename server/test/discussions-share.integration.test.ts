import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  createServer,
  createUser,
  upsertDbSession,
  upsertDiscussion,
  upsertOrchestrationRun,
  type DbOrchestrationRun,
} from '../src/db/queries.js';
import { createOrUpdateShare } from '../src/db/tab-sharing.js';
import { discussionRoutes } from '../src/routes/discussions.js';
import { signJwt } from '../src/security/crypto.js';
import {
  evaluateShareCommand,
  SHARE_REASONS,
  type ShareScopedSocketState,
} from '../src/ws/share-policy.js';
import {
  SHARE_BROWSER_COMMANDS,
  type ShareAuthorizationSnapshot,
  SHARE_DISCUSSION_EVENTS,
} from '../../shared/tab-sharing.js';

const JWT_KEY = 'test-signing-key-discussions-share';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  vi.useRealTimers();
  await db.close();
});

beforeEach(() => {
  vi.useRealTimers();
});

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = { DB: db, JWT_SIGNING_KEY: JWT_KEY };
    await next();
  });
  app.route('/api/server', discussionRoutes);
  return app;
}

function authHeaders(userId: string) {
  return {
    Authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`,
    'Content-Type': 'application/json',
  };
}

async function seedServer() {
  const ownerId = id('owner');
  const recipientId = id('recipient');
  const outsiderId = id('outsider');
  const serverId = id('srv');
  const sessionName = `deck_${id('proj').replace(/-/g, '_')}_brain`;
  const otherSessionName = `deck_${id('other').replace(/-/g, '_')}_brain`;
  await createUser(db, ownerId);
  await createUser(db, recipientId);
  await createUser(db, outsiderId);
  await db.execute('UPDATE users SET username = $1, display_name = $2 WHERE id = $3', [`recipient_${recipientId}`, 'Shared Recipient', recipientId]);
  await createServer(db, serverId, ownerId, 'Discussion Share Target', 'token-hash');
  await upsertDbSession(db, id('sess'), serverId, sessionName, 'proj', 'brain', 'codex', '/tmp/proj', 'idle', 'Main');
  await upsertDbSession(db, id('sess'), serverId, otherSessionName, 'other', 'brain', 'codex', '/tmp/other', 'idle', 'Other');
  return { ownerId, recipientId, outsiderId, serverId, sessionName, otherSessionName };
}

function parseJsonField<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function shareState(params: {
  userId: string;
  target: ShareScopedSocketState['target'];
  role?: ShareAuthorizationSnapshot['effectiveRole'];
  primaryShareId?: string | null;
}): ShareScopedSocketState {
  const now = 2_000;
  return {
    userId: params.userId,
    ticketId: id('ticket'),
    target: params.target,
    connectedAt: now,
    snapshot: {
      target: params.target,
      effectiveRole: params.role ?? 'participant',
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: params.primaryShareId ? [params.primaryShareId] : [],
      primaryShareId: params.primaryShareId ?? null,
      authorizedAt: now,
    },
  };
}

function makeRun(params: {
  id: string;
  discussionId: string;
  serverId: string;
  sessionName: string;
  visibleAfterMs?: number | null;
  createdByUserId?: string | null;
}): DbOrchestrationRun {
  const now = new Date(2_000).toISOString();
  return {
    id: params.id,
    discussion_id: params.discussionId,
    server_id: params.serverId,
    main_session: params.sessionName,
    initiator_session: params.sessionName,
    current_target_session: params.sessionName,
    final_return_session: params.sessionName,
    remaining_targets: '[]',
    mode_key: 'review',
    status: 'running',
    request_message_id: null,
    callback_message_id: null,
    context_ref: '{}',
    timeout_ms: 300_000,
    result_summary: null,
    error: null,
    progress_snapshot: JSON.stringify({ id: params.id, discussion_id: params.discussionId, status: 'running' }),
    created_at: now,
    updated_at: now,
    completed_at: null,
    scope_kind: 'main',
    scope_server_id: params.serverId,
    scope_session_name: params.sessionName,
    scope_sub_session_id: null,
    created_by_user_id: params.createdByUserId ?? null,
    authorization_snapshot: null,
    primary_share_id: null,
    covering_share_ids: [],
    visible_after_ms: params.visibleAfterMs ?? 2_000,
    history_cutoff_at_ms: 0,
    share_target_snapshot: { kind: 'main', serverId: params.serverId, sessionName: params.sessionName },
  };
}

describe('share-scoped discussion comments', () => {
  it('allows a viewer to create a non-dispatch comment with server-authored actor metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const app = makeApp();
    const { ownerId, recipientId, serverId } = await seedServer();
    const share = await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'server', serverId },
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      now: 1_000,
    });
    const threadId = id('thread');

    const res = await app.request(`/api/server/${serverId}/discussions/comments`, {
      method: 'POST',
      headers: authHeaders(recipientId),
      body: JSON.stringify({
        type: SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT,
        requestId: 'comment-request-1',
        threadId,
        body: 'Looks good from here.',
        actorEnvelope: { actorUserId: 'spoofed' },
      }),
    });

    expect(res.status).toBe(201);
    const payload = await res.json() as { type: string; comment: { id: string; actor_envelope: unknown } };
    expect(payload.type).toBe(SHARE_DISCUSSION_EVENTS.COMMENT_CREATED);

    const row = await db.queryOne<{ actor_envelope: unknown; created_by_user_id: string }>(
      'SELECT actor_envelope, created_by_user_id FROM discussion_comments WHERE id = $1',
      [payload.comment.id],
    );
    const envelope = parseJsonField<Record<string, unknown>>(row!.actor_envelope as Record<string, unknown> | string);
    expect(row?.created_by_user_id).toBe(recipientId);
    expect(envelope).toMatchObject({
      actorUserId: recipientId,
      actorDisplayName: 'Shared Recipient',
      effectiveActorRole: 'viewer',
      actionId: 'comment-request-1',
      origin: 'shared-server',
      primaryShareId: share.id,
    });
    expect(envelope.actorUserId).not.toBe('spoofed');

    const rounds = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM discussion_rounds WHERE discussion_id = $1',
      [threadId],
    );
    expect(rounds[0]?.count).toBe(0);

    const readRes = await app.request(`/api/server/${serverId}/discussions/comments?kind=server`, {
      headers: authHeaders(recipientId),
    });
    expect(readRes.status).toBe(200);
    const readPayload = await readRes.json() as { comments: Array<{ id: string; body: string }>; targetRef: string };
    expect(readPayload.targetRef).toBe(serverId);
    expect(readPayload.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: payload.comment.id, body: 'Looks good from here.' }),
    ]));
  });

  it('audits invalid share comments before persistence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_500);
    const app = makeApp();
    const { ownerId, recipientId, serverId } = await seedServer();
    const share = await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'server', serverId },
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      now: 1_000,
    });

    const res = await app.request(`/api/server/${serverId}/discussions/comments`, {
      method: 'POST',
      headers: authHeaders(recipientId),
      body: JSON.stringify({
        type: SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT,
        requestId: 'invalid-comment-1',
        body: '   ',
      }),
    });

    expect(res.status).toBe(400);
    const persisted = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM discussion_comments WHERE server_id = $1',
      [serverId],
    );
    expect(persisted[0]?.count).toBe(0);
    const audit = await db.queryOne<{ decision: string; reason: string | null; idempotency_key: string }>(
      `SELECT decision, reason, idempotency_key
         FROM share_audit_events
        WHERE server_id = $1 AND action_type = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [serverId, SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT],
    );
    expect(audit).toMatchObject({
      decision: 'rejected',
      reason: 'share-comment-invalid',
    });
    expect(audit?.idempotency_key).toContain(share.id);
    expect(audit?.idempotency_key).toContain(':rejected:');
    expect(audit?.idempotency_key).not.toContain('invalid-comment-1');
  });
});

describe('share-scoped Team and P2P command policy', () => {
  it('allows participant Team discussions when all participant targets are in server scope and stamps actor metadata', async () => {
    const { recipientId, serverId, sessionName, otherSessionName } = await seedServer();
    const decision = evaluateShareCommand({
      msg: {
        type: 'discussion.start',
        requestId: 'team-start-1',
        topic: 'Coordinate this',
        participants: [
          { sessionName },
          { sessionName: otherSessionName },
        ],
        sharedActor: { actorUserId: 'spoofed' },
      },
      state: shareState({
        userId: recipientId,
        target: { kind: 'server', serverId },
        primaryShareId: 'share-team-1',
      }),
      now: 2_500,
      runtimeType: 'transport',
      activeDispatchId: null,
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('expected command to be allowed');
    expect(decision.stampedMessage?.sharedActor).toMatchObject({
      actorUserId: recipientId,
      effectiveActorRole: 'participant',
      actionId: 'team-start-1',
      origin: 'shared-server',
      primaryShareId: 'share-team-1',
    });
    expect((decision.stampedMessage?.sharedActor as Record<string, unknown>).actorUserId).not.toBe('spoofed');
    expect(decision.stampedMessage?.shareScope).toMatchObject({
      target: { kind: 'server', serverId },
      historyCutoffAt: 0,
      primaryShareId: 'share-team-1',
      coveringShareIds: ['share-team-1'],
    });
  });

  it('allows bounded __all__ P2P sends when enabled config targets are covered by a concrete share', async () => {
    const { recipientId, serverId, sessionName, otherSessionName } = await seedServer();
    const decision = evaluateShareCommand({
      msg: {
        type: 'session.send',
        commandId: 'p2p-all-1',
        sessionName,
        text: 'review this',
        p2pAtTargets: [{ session: '__all__', mode: 'discuss' }],
        p2pSessionConfig: {
          [sessionName]: { enabled: true, mode: 'discuss' },
          [otherSessionName]: { enabled: false, mode: 'skip' },
        },
      },
      state: shareState({
        userId: recipientId,
        target: { kind: 'main', serverId, sessionName },
      }),
      now: 2_500,
      runtimeType: 'transport',
      activeDispatchId: null,
    });

    expect(decision.allowed).toBe(true);
  });

  it('denies unbounded or out-of-scope P2P expansion for concrete shares', async () => {
    const { recipientId, serverId, sessionName, otherSessionName } = await seedServer();
    const state = shareState({
      userId: recipientId,
      target: { kind: 'main', serverId, sessionName },
    });

    const unbounded = evaluateShareCommand({
      msg: {
        type: 'session.send',
        commandId: 'p2p-all-unbounded',
        sessionName,
        text: 'review this',
        p2pAtTargets: [{ session: '__all__', mode: 'discuss' }],
      },
      state,
      now: 2_500,
      runtimeType: 'transport',
      activeDispatchId: null,
    });
    expect(unbounded).toEqual({ allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED });

    const outOfScope = evaluateShareCommand({
      msg: {
        type: 'session.send',
        commandId: 'p2p-all-outside',
        sessionName,
        text: 'review this',
        p2pAtTargets: [{ session: '__all__', mode: 'discuss' }],
        p2pSessionConfig: {
          [otherSessionName]: { enabled: true, mode: 'discuss' },
        },
      },
      state,
      now: 2_500,
      runtimeType: 'transport',
      activeDispatchId: null,
    });
    expect(outOfScope).toEqual({ allowed: false, reason: SHARE_REASONS.DIRECT_SURFACE_DENIED });
  });
});

describe('share-scoped P2P run reads', () => {
  it('filters list/detail results to covered scoped targets only while preserving pre-invite scoped runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_500);
    const app = makeApp();
    const { ownerId, recipientId, serverId, sessionName, otherSessionName } = await seedServer();
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'main', serverId, sessionName },
      targetUserId: recipientId,
      role: 'participant',
      createdBy: ownerId,
      now: 1_000,
    });
    const discussionId = id('discussion');
    await upsertDiscussion(db, {
      id: discussionId,
      serverId,
      topic: 'Scoped run',
      state: 'running',
      maxRounds: 1,
      startedAt: 1_500,
    });
    const coveredRun = makeRun({ id: id('run'), discussionId, serverId, sessionName, createdByUserId: recipientId, visibleAfterMs: 500 });
    const outsideRun = makeRun({ id: id('run'), discussionId, serverId, sessionName: otherSessionName, createdByUserId: recipientId });
    await upsertOrchestrationRun(db, coveredRun);
    await upsertOrchestrationRun(db, outsideRun);

    const list = await app.request(`/api/server/${serverId}/p2p/runs`, {
      headers: authHeaders(recipientId),
    });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { runs: Array<{ id: string }> };
    expect(listBody.runs.map((run) => run.id)).toEqual([coveredRun.id]);

    const coveredDetail = await app.request(`/api/server/${serverId}/p2p/runs/${coveredRun.id}`, {
      headers: authHeaders(recipientId),
    });
    expect(coveredDetail.status).toBe(200);

    const outsideDetail = await app.request(`/api/server/${serverId}/p2p/runs/${outsideRun.id}`, {
      headers: authHeaders(recipientId),
    });
    expect(outsideDetail.status).toBe(404);
  });

  it('preserves server-authored share scope metadata across P2P run updates', async () => {
    const { ownerId, recipientId, serverId, sessionName } = await seedServer();
    const share = await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'main', serverId, sessionName },
      targetUserId: recipientId,
      role: 'participant',
      createdBy: ownerId,
      now: 1_000,
    });
    const discussionId = id('discussion');
    await upsertDiscussion(db, {
      id: discussionId,
      serverId,
      topic: 'Scoped update',
      state: 'running',
      maxRounds: 1,
      startedAt: 1_500,
    });
    const snapshot: ShareAuthorizationSnapshot = {
      target: { kind: 'main', serverId, sessionName },
      effectiveRole: 'participant',
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: [share.id],
      primaryShareId: share.id,
      authorizedAt: 2_000,
    };
    const run = makeRun({
      id: id('run'),
      discussionId,
      serverId,
      sessionName,
      createdByUserId: recipientId,
    });
    await upsertOrchestrationRun(db, {
      ...run,
      authorization_snapshot: snapshot,
      primary_share_id: share.id,
      covering_share_ids: [share.id],
      share_target_snapshot: snapshot.target,
    });
    await upsertOrchestrationRun(db, {
      ...run,
      status: 'completed',
      updated_at: new Date(3_000).toISOString(),
      completed_at: new Date(3_000).toISOString(),
      scope_kind: null,
      scope_server_id: null,
      scope_session_name: null,
      scope_sub_session_id: null,
      created_by_user_id: null,
      authorization_snapshot: null,
      primary_share_id: null,
      covering_share_ids: null,
      visible_after_ms: null,
      history_cutoff_at_ms: null,
      share_target_snapshot: null,
    });

    const row = await db.queryOne<DbOrchestrationRun>(
      'SELECT * FROM discussion_orchestration_runs WHERE id = $1 AND server_id = $2',
      [run.id, serverId],
    );
    expect(row).toMatchObject({
      status: 'completed',
      scope_kind: 'main',
      scope_server_id: serverId,
      scope_session_name: sessionName,
      created_by_user_id: recipientId,
      primary_share_id: share.id,
      visible_after_ms: 2_000,
      history_cutoff_at_ms: 0,
    });
    expect(parseJsonField<ShareAuthorizationSnapshot>(row!.authorization_snapshot as ShareAuthorizationSnapshot | string)).toMatchObject({
      primaryShareId: share.id,
      target: { kind: 'main', serverId, sessionName },
    });
    expect(parseJsonField<string[]>(row!.covering_share_ids as string[] | string)).toEqual([share.id]);
  });
});
