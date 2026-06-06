import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createSubSession, createUser, updateSessionLabel, upsertDbSession } from '../src/db/queries.js';
import {
  createOrUpdateShare,
  deriveShareTransitionKey,
  listActiveSharesForUser,
  resolveEffectiveShareCoverage,
  revokeShare,
  writeShareAuditEvent,
} from '../src/db/tab-sharing.js';
import { tabSharingRoutes } from '../src/routes/tab-sharing.js';
import { resolveHttpShareAccess } from '../src/routes/share-http-auth.js';
import { resolveServerRole } from '../src/security/authorization.js';
import { signJwt, verifyJwt } from '../src/security/crypto.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';

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

async function seedShareTarget() {
  const ownerId = id('owner');
  const recipientId = id('recipient');
  const outsiderId = id('outsider');
  const serverId = id('srv');
  const sessionName = `deck_${id('proj').replace(/-/g, '_')}_brain`;
  const subSessionId = id('sub');
  await createUser(db, ownerId);
  await createUser(db, recipientId);
  await createUser(db, outsiderId);
  await createServer(db, serverId, ownerId, 'Share Target', 'token-hash');
  await upsertDbSession(db, id('sess'), serverId, sessionName, 'proj', 'brain', 'codex', '/tmp/proj', 'idle', 'Main Label');
  await createSubSession(db, subSessionId, serverId, 'codex', null, '/tmp/proj', 'Sub Label', null, null, sessionName);
  return { ownerId, recipientId, outsiderId, serverId, sessionName, subSessionId };
}

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = { DB: db, JWT_SIGNING_KEY: JWT_KEY };
    await next();
  });
  app.route('/api', tabSharingRoutes);
  return app;
}

function authHeaders(userId: string) {
  return {
    Authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`,
    'Content-Type': 'application/json',
  };
}

function expectNoKeysDeep(value: unknown, forbiddenKeys: string[], path = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) expectNoKeysDeep(item, forbiddenKeys, `${path}[${index}]`);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    expect(forbiddenKeys, `${path}.${key}`).not.toContain(key);
    expectNoKeysDeep(nested, forbiddenKeys, `${path}.${key}`);
  }
}

describe('tab sharing migrations', () => {
  it('creates FK-backed share tables and the FK-valid sessions constraint', async () => {
    for (const table of ['server_shares', 'session_shares', 'sub_session_shares', 'share_audit_events']) {
      const row = await db.queryOne<{ oid: string | null }>('SELECT to_regclass($1) AS oid', [`public.${table}`]);
      expect(row?.oid, `${table} should exist`).not.toBeNull();
    }

    const sessionConstraint = await db.queryOne<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conname = 'sessions_server_name_key'",
    );
    expect(sessionConstraint?.conname).toBe('sessions_server_name_key');

    const subPk = await db.queryOne<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'sub_sessions'::regclass
          AND contype = 'p'
          AND conkey = ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'sub_sessions'::regclass AND attname = 'id'),
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'sub_sessions'::regclass AND attname = 'server_id')
          ]::smallint[]`,
    );
    expect(subPk?.conname).toBeTruthy();

    const fks = await db.query<{ source_table: string; referenced_table: string; delete_action: string }>(
      `SELECT conrelid::regclass::text AS source_table,
              confrelid::regclass::text AS referenced_table,
              confdeltype AS delete_action
         FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN ('server_shares'::regclass, 'session_shares'::regclass, 'sub_session_shares'::regclass)
        ORDER BY source_table, referenced_table`,
    );
    expect(fks.map((fk) => `${fk.source_table}->${fk.referenced_table}`)).toEqual(expect.arrayContaining([
      'server_shares->servers',
      'server_shares->users',
      'session_shares->sessions',
      'session_shares->users',
      'sub_session_shares->sub_sessions',
      'sub_session_shares->users',
    ]));
    expect(fks).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_table: 'server_shares', referenced_table: 'servers', delete_action: 'c' }),
      expect.objectContaining({ source_table: 'session_shares', referenced_table: 'sessions', delete_action: 'c' }),
      expect.objectContaining({ source_table: 'sub_session_shares', referenced_table: 'sub_sessions', delete_action: 'c' }),
    ]));
  });

  it('enforces audit actor/reason constraints and idempotent transition keys', async () => {
    const { ownerId, recipientId, serverId } = await seedShareTarget();
    const target = { kind: 'server' as const, serverId };
    const now = Date.now();
    await expect(db.execute(
      `INSERT INTO share_audit_events (id, server_id, actor_kind, actor_user_id, effective_actor_role, target_kind, target_ref, action_type, decision, snapshot, created_at)
       VALUES ($1, $2, 'system', $3, 'system', 'server', $2, 'share.expire', 'teardown', '{}'::jsonb, $4)`,
      [id('bad-audit'), serverId, ownerId, now],
    )).rejects.toThrow();

    const cases = [
      { actionType: 'session.send', decision: 'accepted', effectiveActorRole: 'participant', actorKind: 'user', actorUserId: recipientId, reason: null },
      { actionType: 'session.send', decision: 'rejected', effectiveActorRole: 'participant', actorKind: 'user', actorUserId: recipientId, reason: 'share-rate-limited' },
      { actionType: 'session.cancel', decision: 'accepted', effectiveActorRole: 'participant', actorKind: 'user', actorUserId: recipientId, reason: null },
      { actionType: 'session.cancel', decision: 'rejected', effectiveActorRole: 'participant', actorKind: 'user', actorUserId: recipientId, reason: 'share-target-unavailable' },
      { actionType: 'discussion.comment', decision: 'accepted', effectiveActorRole: 'viewer', actorKind: 'user', actorUserId: recipientId, reason: null },
      { actionType: 'discussion.comment', decision: 'rejected', effectiveActorRole: 'viewer', actorKind: 'user', actorUserId: recipientId, reason: 'share-comment-invalid' },
      { actionType: 'rate_limit', decision: 'rejected', effectiveActorRole: 'participant', actorKind: 'user', actorUserId: recipientId, reason: 'share-rate-limited' },
      { actionType: 'share.revoke', decision: 'updated', effectiveActorRole: 'server-manager', actorKind: 'user', actorUserId: ownerId, reason: null },
      { actionType: 'share.expire', decision: 'teardown', effectiveActorRole: 'system', actorKind: 'system', actorUserId: null, reason: 'share-expired' },
      { actionType: 'share.downgrade', decision: 'teardown', effectiveActorRole: 'system', actorKind: 'system', actorUserId: null, reason: 'share-role-changed' },
      { actionType: 'share.target_delete', decision: 'teardown', effectiveActorRole: 'system', actorKind: 'system', actorUserId: null, reason: 'share-target-unavailable' },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const transitionEpochMs = now + index;
      const key = deriveShareTransitionKey({
        actionType: item.actionType,
        target,
        primaryShareId: 'share-1',
        transitionEpochMs,
      });
      const base = {
        serverId,
        actorKind: item.actorKind,
        actorUserId: item.actorUserId,
        targetUserId: recipientId,
        effectiveActorRole: item.effectiveActorRole,
        target,
        actionType: item.actionType,
        decision: item.decision,
        reason: item.reason,
        snapshot: {},
        primaryShareId: 'share-1',
        idempotencyKey: key,
        createdAt: transitionEpochMs,
      };
      const first = await writeShareAuditEvent(db, { id: id('audit'), ...base });
      const second = await writeShareAuditEvent(db, { id: id('audit'), ...base });
      expect(first.inserted, item.actionType).toBe(true);
      expect(second.inserted, item.actionType).toBe(false);
    }

    const count = await db.queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM share_audit_events WHERE server_id = $1',
      [serverId],
    );
    expect(Number(count?.count ?? 0)).toBe(cases.length);
  });
});

describe('tab sharing persistence helpers', () => {
  it('updates duplicate active grants and recreates revoked grants without duplicate rows', async () => {
    const { ownerId, recipientId, serverId } = await seedShareTarget();
    const target = { kind: 'server' as const, serverId };

    const first = await createOrUpdateShare(db, {
      id: id('share'),
      target,
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      now: 1_000,
    });
    const updated = await createOrUpdateShare(db, {
      id: id('share'),
      target,
      targetUserId: recipientId,
      role: 'participant',
      createdBy: ownerId,
      expiresAt: 10_000,
      now: 2_000,
    });
    expect(updated.id).toBe(first.id);
    expect(updated.role).toBe('participant');
    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBe(2_000);

    await revokeShare(db, { shareId: first.id, serverId, now: 3_000 });
    const recreated = await createOrUpdateShare(db, {
      id: id('share'),
      target,
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      now: 4_000,
    });
    expect(recreated.id).toBe(first.id);
    expect(recreated.role).toBe('viewer');
    expect(recreated.createdAt).toBe(4_000);
    expect(recreated.revokedAt).toBeNull();

    const rows = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM server_shares WHERE server_id = $1 AND target_user_id = $2', [serverId, recipientId]);
    expect(rows[0]?.count).toBe(1);
  });

  it('resolves overlapping coverage and treats expiresAt == now as expired', async () => {
    const { ownerId, recipientId, serverId, sessionName } = await seedShareTarget();
    const serverTarget = { kind: 'server' as const, serverId };
    const mainTarget = { kind: 'main' as const, serverId, sessionName };
    const serverShare = await createOrUpdateShare(db, {
      id: id('share'),
      target: serverTarget,
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      expiresAt: 10_000,
      now: 1_000,
    });
    const mainShare = await createOrUpdateShare(db, {
      id: id('share'),
      target: mainTarget,
      targetUserId: recipientId,
      role: 'participant',
      createdBy: ownerId,
      expiresAt: 8_000,
      now: 2_000,
    });

    const coverage = await resolveEffectiveShareCoverage(db, { userId: recipientId, target: mainTarget, now: 7_999 });
    expect(coverage).toMatchObject({
      effectiveRole: 'participant',
      historyCutoffAt: 0,
      nextCoverageRecheckAt: 8_000,
      primaryShareId: mainShare.id,
    });
    expect(coverage?.coveringShareIds.sort()).toEqual([mainShare.id, serverShare.id].sort());

    const atBoundary = await resolveEffectiveShareCoverage(db, { userId: recipientId, target: mainTarget, now: 8_000 });
    expect(atBoundary?.effectiveRole).toBe('viewer');
    expect(atBoundary?.coveringShareIds).toEqual([serverShare.id]);

    const afterAllExpired = await resolveEffectiveShareCoverage(db, { userId: recipientId, target: mainTarget, now: 10_000 });
    expect(afterAllExpired).toBeNull();
  });
});

describe('tab sharing APIs', () => {
  it('enforces manager-only creation, self-share rejection, and sub-session normalization', async () => {
    const app = makeApp();
    const { ownerId, recipientId, outsiderId, serverId, subSessionId } = await seedShareTarget();

    const selfShare = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: authHeaders(ownerId),
      body: JSON.stringify({
        target: { kind: 'server', serverId },
        targetUserId: ownerId,
        role: 'viewer',
      }),
    });
    expect(selfShare.status).toBe(400);

    const nonManager = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: authHeaders(outsiderId),
      body: JSON.stringify({
        target: { kind: 'server', serverId },
        targetUserId: recipientId,
        role: 'viewer',
      }),
    });
    expect(nonManager.status).toBe(403);

    const created = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: authHeaders(ownerId),
      body: JSON.stringify({
        target: { kind: 'subsession', serverId, sessionName: `deck_sub_${subSessionId}`, subSessionDisplayName: 'ignored label' },
        targetUserId: recipientId,
        role: 'viewer',
      }),
    });
    expect(created.status).toBe(201);
    const row = await db.queryOne<{ sub_session_id: string }>('SELECT sub_session_id FROM sub_session_shares WHERE server_id = $1 AND target_user_id = $2', [serverId, recipientId]);
    expect(row?.sub_session_id).toBe(subSessionId);

    const conflicting = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: authHeaders(ownerId),
      body: JSON.stringify({
        target: { kind: 'subsession', serverId, sessionName: `deck_sub_${subSessionId}`, subSessionId },
        targetUserId: recipientId,
        role: 'viewer',
      }),
    });
    expect(conflicting.status).toBe(400);
  });

  it('accepts username recipient aliases and the legacy targetUser create field', async () => {
    const app = makeApp();
    const { ownerId, recipientId, serverId } = await seedShareTarget();
    await db.execute('UPDATE users SET username = $1, display_name = $2 WHERE id = $3', ['emma', 'Emma', recipientId]);

    const created = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: authHeaders(ownerId),
      body: JSON.stringify({
        target: { kind: 'server', serverId },
        targetUser: 'EMMA',
        role: 'viewer',
      }),
    });

    expect(created.status).toBe(201);
    const body = await created.json() as { share: { targetUser: { id: string; displayName: string }; targetUserId: string; targetUserDisplayName: string } };
    expect(body.share.targetUser).toMatchObject({ id: recipientId, displayName: 'Emma' });
    expect(body.share.targetUserId).toBe(recipientId);
    expect(body.share.targetUserDisplayName).toBe('Emma');
    const row = await db.queryOne<{ target_user_id: string }>(
      'SELECT target_user_id FROM server_shares WHERE server_id = $1 AND target_user_id = $2',
      [serverId, recipientId],
    );
    expect(row?.target_user_id).toBe(recipientId);
  });

  it('lets recipients discover/open active shares without becoming server members', async () => {
    const app = makeApp();
    const { ownerId, recipientId, serverId, sessionName } = await seedShareTarget();
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'server', serverId },
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      now: 5_000,
    });

    expect(await resolveServerRole(db, serverId, recipientId)).toBe('none');

    const discover = await app.request('/api/shares', { headers: authHeaders(recipientId) });
    expect(discover.status).toBe(200);
    const discoverBody = await discover.json() as { shares: Array<{ serverId: string; historyCutoffAt: number }> };
    expect(discoverBody.shares).toEqual([expect.objectContaining({ serverId, historyCutoffAt: 0 })]);

    const open = await app.request('/api/shares/open', {
      method: 'POST',
      headers: authHeaders(recipientId),
      body: JSON.stringify({ target: { kind: 'main', serverId, sessionName } }),
    });
    expect(open.status).toBe(200);
    const openBody = await open.json() as { coverage: { effectiveRole: string; historyCutoffAt: number }; sessions: Array<{ sessionName: string }> };
    expect(openBody.coverage).toMatchObject({ effectiveRole: 'viewer', historyCutoffAt: 0 });
    expect(openBody.sessions).toEqual([expect.objectContaining({ sessionName })]);
  });

  it('issues share-scoped websocket tickets with bounded claims', async () => {
    const app = makeApp();
    const { ownerId, recipientId, serverId, sessionName } = await seedShareTarget();
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'main', serverId, sessionName },
      targetUserId: recipientId,
      role: 'participant',
      createdBy: ownerId,
      expiresAt: 25_000,
      now: 20_000,
    });

    const res = await app.request('/api/shares/ws-ticket', {
      method: 'POST',
      headers: authHeaders(recipientId),
      body: JSON.stringify({ target: { kind: 'main', serverId, sessionName } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ticket: string; claims: Record<string, unknown> };
    expect(body.claims).toMatchObject({
      type: 'share-ws-ticket',
      sub: recipientId,
      serverId,
      issuedAt: 20_000,
      expiresAt: 25_000,
      snapshot: {
        effectiveRole: 'participant',
        nextCoverageRecheckAt: 25_000,
      },
    });
    const verified = verifyJwt(body.ticket, JWT_KEY);
    expect(verified).toMatchObject({
      type: 'share-ws-ticket',
      sub: recipientId,
      serverId,
      expiresAt: 25_000,
    });
  });

  it('resolves ordinary members ahead of active share coverage at the HTTP auth boundary', async () => {
    const { ownerId, serverId, sessionName } = await seedShareTarget();
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'main', serverId, sessionName },
      targetUserId: ownerId,
      role: 'participant',
      createdBy: ownerId,
      now: 5_000,
    });

    const access = await resolveHttpShareAccess(db, {
      serverId,
      userId: ownerId,
      target: { kind: 'main', serverId, sessionName },
      now: 6_000,
    });

    expect(access.membership).toBe('owner');
    expect(access.actor).toEqual({
      kind: 'server-member',
      effectiveActorRole: 'server-manager',
    });
  });

  it('omits expired shares from recipient discovery', async () => {
    const { ownerId, recipientId, serverId } = await seedShareTarget();
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'server', serverId },
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      expiresAt: 10_000,
      now: 5_000,
    });

    const activeBefore = await listActiveSharesForUser(db, recipientId, 9_999);
    const activeAtBoundary = await listActiveSharesForUser(db, recipientId, 10_000);
    expect(activeBefore).toHaveLength(1);
    expect(activeAtBoundary).toHaveLength(0);
  });

  it('updates role through the manager API and recomputes active coverage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const app = makeApp();
    const { ownerId, recipientId, serverId, sessionName } = await seedShareTarget();
    const created = await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'main', serverId, sessionName },
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      now: 20_000,
    });

    const update = await app.request(`/api/server/${serverId}/shares/${created.id}`, {
      method: 'PATCH',
      headers: authHeaders(ownerId),
      body: JSON.stringify({ role: 'participant', expiresAt: 30_000 }),
    });
    expect(update.status).toBe(200);
    const updateBody = await update.json() as { share: { role: string; expiresAt: number } };
    expect(updateBody.share).toMatchObject({ role: 'participant', expiresAt: 30_000 });

    const coverage = await resolveEffectiveShareCoverage(db, {
      userId: recipientId,
      target: { kind: 'main', serverId, sessionName },
      now: Date.now(),
    });
    expect(coverage).toMatchObject({
      effectiveRole: 'participant',
      nextCoverageRecheckAt: 30_000,
    });
  });

  it('keeps main-session shares across relabels and server shares cover future tabs', async () => {
    const app = makeApp();
    const { ownerId, recipientId, serverId, sessionName } = await seedShareTarget();
    const futureSessionName = `deck_${id('future').replace(/-/g, '_')}_brain`;
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'main', serverId, sessionName },
      targetUserId: recipientId,
      role: 'viewer',
      createdBy: ownerId,
      now: 10_000,
    });
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'server', serverId },
      targetUserId: recipientId,
      role: 'participant',
      createdBy: ownerId,
      now: 11_000,
    });

    await updateSessionLabel(db, serverId, sessionName, 'Renamed But Same Structural Name');
    await upsertDbSession(db, id('sess'), serverId, futureSessionName, 'future', 'brain', 'codex', '/tmp/future', 'idle', 'Future Main');

    const relabeledCoverage = await resolveEffectiveShareCoverage(db, {
      userId: recipientId,
      target: { kind: 'main', serverId, sessionName },
      now: 12_000,
    });
    expect(relabeledCoverage?.effectiveRole).toBe('participant');
    expect(relabeledCoverage?.historyCutoffAt).toBe(0);
    expect(relabeledCoverage?.coveringShareIds).toHaveLength(2);

    const futureCoverage = await resolveEffectiveShareCoverage(db, {
      userId: recipientId,
      target: { kind: 'main', serverId, sessionName: futureSessionName },
      now: 12_000,
    });
    expect(futureCoverage).toMatchObject({
      effectiveRole: 'participant',
      historyCutoffAt: 0,
    });

    const openServer = await app.request('/api/shares/open', {
      method: 'POST',
      headers: authHeaders(recipientId),
      body: JSON.stringify({ target: { kind: 'server', serverId } }),
    });
    expect(openServer.status).toBe(200);
    const openBody = await openServer.json() as { sessions: Array<{ sessionName: string; title: string }> };
    expect(openBody.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionName, title: 'Renamed But Same Structural Name' }),
      expect.objectContaining({ sessionName: futureSessionName, title: 'Future Main' }),
    ]));
  });

  it('cascades shares when servers, main tabs, or sub-session tabs are deleted', async () => {
    const serverCase = await seedShareTarget();
    const mainCase = await seedShareTarget();
    const subCase = await seedShareTarget();

    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'server', serverId: serverCase.serverId },
      targetUserId: serverCase.recipientId,
      role: 'viewer',
      createdBy: serverCase.ownerId,
      now: 1_000,
    });
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'main', serverId: mainCase.serverId, sessionName: mainCase.sessionName },
      targetUserId: mainCase.recipientId,
      role: 'viewer',
      createdBy: mainCase.ownerId,
      now: 1_000,
    });
    await createOrUpdateShare(db, {
      id: id('share'),
      target: { kind: 'subsession', serverId: subCase.serverId, subSessionId: subCase.subSessionId },
      targetUserId: subCase.recipientId,
      role: 'viewer',
      createdBy: subCase.ownerId,
      now: 1_000,
    });

    await db.execute('DELETE FROM sub_sessions WHERE server_id = $1', [serverCase.serverId]);
    await db.execute('DELETE FROM sessions WHERE server_id = $1', [serverCase.serverId]);
    await db.execute('DELETE FROM servers WHERE id = $1', [serverCase.serverId]);
    await db.execute('DELETE FROM sessions WHERE server_id = $1 AND name = $2', [mainCase.serverId, mainCase.sessionName]);
    await db.execute('DELETE FROM sub_sessions WHERE server_id = $1 AND id = $2', [subCase.serverId, subCase.subSessionId]);

    const serverRows = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM server_shares WHERE server_id = $1', [serverCase.serverId]);
    const mainRows = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM session_shares WHERE server_id = $1 AND session_name = $2',
      [mainCase.serverId, mainCase.sessionName],
    );
    const subRows = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM sub_session_shares WHERE server_id = $1 AND sub_session_id = $2',
      [subCase.serverId, subCase.subSessionId],
    );
    expect(serverRows[0]?.count).toBe(0);
    expect(mainRows[0]?.count).toBe(0);
    expect(subRows[0]?.count).toBe(0);
  });

  it('keeps manager and recipient share metadata minimized and shape-separated', async () => {
    const app = makeApp();
    const { ownerId, recipientId, serverId, sessionName, subSessionId } = await seedShareTarget();
    await db.execute(
      'UPDATE users SET username = $1, display_name = $2, password_hash = $3 WHERE id = $4',
      [`recipient_${recipientId}`, 'Shared Recipient', 'secret-hash', recipientId],
    );
    await db.execute(
      'UPDATE servers SET token_hash = $1 WHERE id = $2',
      ['very-secret-token-hash', serverId],
    );

    const create = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: authHeaders(ownerId),
      body: JSON.stringify({
        target: { kind: 'main', serverId, sessionName },
        targetUserId: recipientId,
        role: 'participant',
      }),
    });
    expect(create.status).toBe(201);
    const createBody = await create.json() as { share: Record<string, unknown> };
    expect(createBody.share).toMatchObject({
      target: { kind: 'main', serverId, sessionName },
      targetRef: sessionName,
      targetUser: {
        id: recipientId,
        displayName: 'Shared Recipient',
      },
      targetUserId: recipientId,
      targetUserDisplayName: 'Shared Recipient',
      role: 'participant',
      status: 'active',
      createdBy: ownerId,
    });
    expectNoKeysDeep(createBody, ['username', 'email', 'password_hash', 'passwordHash', 'token_hash', 'tokenHash']);

    const list = await app.request(`/api/server/${serverId}/shares`, { headers: authHeaders(ownerId) });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { shares: Array<Record<string, unknown>> };
    expect(listBody.shares).toHaveLength(1);
    expect(listBody.shares[0]).toMatchObject({
      targetUser: {
        id: recipientId,
        displayName: 'Shared Recipient',
      },
      targetUserId: recipientId,
      targetUserDisplayName: 'Shared Recipient',
      createdBy: ownerId,
      role: 'participant',
    });
    expectNoKeysDeep(listBody, ['username', 'email', 'password_hash', 'passwordHash', 'token_hash', 'tokenHash']);

    const discover = await app.request('/api/shares', { headers: authHeaders(recipientId) });
    expect(discover.status).toBe(200);
    const discoverBody = await discover.json() as { shares: Array<Record<string, unknown>> };
    expect(discoverBody.shares).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        serverId,
        targetRef: sessionName,
        targetSessionName: sessionName,
        role: 'participant',
        availability: 'available',
        status: 'active',
      }),
    ]);
    expect(discoverBody.shares[0]).not.toHaveProperty('createdBy');
    expect(discoverBody.shares[0]).not.toHaveProperty('targetUser');
    expectNoKeysDeep(discoverBody, ['username', 'displayName', 'email', 'password_hash', 'passwordHash', 'token_hash', 'tokenHash']);

    const open = await app.request('/api/shares/open', {
      method: 'POST',
      headers: authHeaders(recipientId),
      body: JSON.stringify({ target: { kind: 'subsession', serverId, subSessionId } }),
    });
    expect(open.status).toBe(403);
    const openMain = await app.request('/api/shares/open', {
      method: 'POST',
      headers: authHeaders(recipientId),
      body: JSON.stringify({ target: { kind: 'main', serverId, sessionName } }),
    });
    expect(openMain.status).toBe(200);
    const openBody = await openMain.json() as Record<string, unknown>;
    expect(openBody).toMatchObject({
      server: {
        id: serverId,
        name: 'Share Target',
      },
      target: { kind: 'main', serverId, sessionName },
      sessions: [
        {
          sessionName,
          title: 'Main Label',
          state: 'idle',
          agentType: 'codex',
        },
      ],
      subSessions: [],
    });
    expect(openBody).not.toHaveProperty('shares');
    expect(openBody).not.toHaveProperty('targetUser');
    expect(openBody).not.toHaveProperty('createdBy');
    expectNoKeysDeep(openBody, [
      'username',
      'displayName',
      'email',
      'password_hash',
      'passwordHash',
      'token_hash',
      'tokenHash',
      'projectDir',
      'cwd',
      'transportConfig',
      'providerSessionId',
    ]);
  });
});
