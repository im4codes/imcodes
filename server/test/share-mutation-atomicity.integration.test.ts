/** Regression class: denied share writes are inert; role/expiry/execute commit atomically. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, randomInt } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer, upsertDbSession, createSubSession } from '../src/db/queries.js';
import { createOrUpdateShare, updateShare } from '../src/db/tab-sharing.js';
import { tabSharingRoutes } from '../src/routes/tab-sharing.js';
import { signJwt } from '../src/security/crypto.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { ShareTarget } from '../../shared/tab-sharing.js';

const key = 'share-mutation-test-only-signing-key';
let db: Database;
beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await runMigrations(db); });
afterAll(async () => { vi.restoreAllMocks(); await db.close(); });
const id = () => randomBytes(8).toString('hex');

async function seed(kind: ShareTarget['kind'] = 'server', controlled = true, expiresAt: number | null = Date.now() + 60000) {
  const owner = id(), recipient = id(), serverId = id(), shareId = id();
  await createUser(db, owner); await createUser(db, recipient);
  await createServer(db, serverId, owner, 'Mutation Test', 'test-unused-hash');
  if (controlled) await db.execute("UPDATE servers SET node_role='controlled', node_id=$2 WHERE id=$1", [serverId, String(randomInt(1000000000, 2000000000))]);
  const sessionName = `deck_test_${id()}_brain`, subSessionId = id();
  await upsertDbSession(db, id(), serverId, sessionName, 'test', 'brain', 'codex', '/var/tmp/imcodes-test-2c9a9d10d7', 'idle');
  await createSubSession(db, subSessionId, serverId, 'codex', null, '/var/tmp/imcodes-test-2c9a9d10d7', 'Sub', null, null, sessionName);
  const target: ShareTarget = kind === 'server' ? { kind, serverId } : kind === 'main' ? { kind, serverId, sessionName } : { kind, serverId, subSessionId };
  await createOrUpdateShare(db, { id: shareId, target, targetUserId: recipient, role: 'participant', createdBy: owner, expiresAt, now: Date.now() - 1000 });
  // Seed independently of the mutation implementation, so the same causal spec runs on the old head.
  if (kind === 'server' && controlled) await db.execute('UPDATE server_shares SET exec_granted=true WHERE id=$1', [shareId]);
  const table = kind === 'server' ? 'server_shares' : kind === 'main' ? 'session_shares' : 'sub_session_shares';
  const row = () => db.queryOne<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id=$1`, [shareId]);
  const app = new Hono(); app.route('/api', tabSharingRoutes);
  const revalidate = vi.spyOn(WsBridge.get(serverId), 'revalidateShareSocketsForUser').mockResolvedValue(undefined);
  const request = (method: 'PATCH' | 'POST', body: Record<string, unknown>, database = db) => app.request(
    `/api/server/${serverId}/shares${method === 'PATCH' ? `/${shareId}` : ''}`,
    { method, headers: { authorization: `Bearer ${signJwt({ sub: owner, type: 'web' }, key, 60)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { DB: database, JWT_SIGNING_KEY: key },
  );
  const auditCount = () => db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM share_audit_events WHERE server_id=$1', [serverId]);
  return { owner, recipient, serverId, shareId, target, table, row, request, revalidate, auditCount };
}

it.each([
  ['server', true, 'viewer'], ['server', false, 'participant'], ['main', false, 'viewer'], ['subsession', false, 'viewer'],
] as const)('invalid PATCH combination leaves %s (controlled=%s) row/audit/notifications unchanged', async (kind, controlled, role) => {
  const s = await seed(kind, controlled), before = await s.row();
  const response = await s.request('PATCH', { role, execGranted: true });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ reason: 'exec_grant_requires_controlled_device_participant' });
  expect(await s.row()).toEqual(before);
  expect((await s.auditCount())?.n).toBe(0);
  expect(s.revalidate).not.toHaveBeenCalled();
});

it.each(['server', 'main', 'subsession'] as const)('invalid POST combination leaves existing %s row/audit unchanged', async (kind) => {
  const s = await seed(kind, kind === 'server'), before = await s.row();
  const response = await s.request('POST', { target: s.target, targetUserId: s.recipient, role: 'viewer', execGranted: true });
  expect(response.status).toBe(400); expect(await s.row()).toEqual(before);
  expect((await s.auditCount())?.n).toBe(0); expect(s.revalidate).not.toHaveBeenCalled();
});

it.each(['server', 'main', 'subsession'] as const)('PATCH %s omission preserves expiry; explicit null clears it', async (kind) => {
  for (const expiry of [Date.now() + 60000, Date.now() - 1000]) {
    const s = await seed(kind, kind === 'server', expiry);
    expect((await s.request('PATCH', { execGranted: false })).status).toBe(200);
    expect((await s.row())?.expires_at).toBe(expiry);
    expect((await s.request('PATCH', { role: 'viewer' })).status).toBe(200);
    expect((await s.row())?.expires_at).toBe(expiry);
    expect((await s.request('PATCH', { expiresAt: null })).status).toBe(200);
    expect((await s.row())?.expires_at).toBeNull();
  }
});

it('POST omitted grant is revoked in the same SQL write, and returns that mutation', async () => {
  const s = await seed(), expiry = Date.now() + 90000;
  const response = await s.request('POST', { target: s.target, targetUserId: s.recipient, role: 'participant', expiresAt: expiry });
  expect(response.status).toBe(200);
  expect((await response.json()).share).toMatchObject({ execGranted: false, expiresAt: expiry });
  expect(await s.row()).toMatchObject({ role: 'participant', exec_granted: false, expires_at: expiry });
  expect((await s.auditCount())?.n).toBe(1); expect(s.revalidate).toHaveBeenCalledOnce();
});

it.each(['PATCH', 'POST'] as const)('%s injected grant-write failure cannot leave role/expiry changed or audit/notify', async (method) => {
  const s = await seed(), before = await s.row(), fn = `reject_grant_${id()}`, trigger = `reject_grant_${id()}`;
  // A real PG trigger faults the complete statement (on old code, POST/PATCH's second grant write).
  await db.exec(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id = '${s.shareId}' AND NOT NEW.exec_granted THEN RAISE EXCEPTION 'injected grant failure'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE UPDATE ON server_shares FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
  try {
    const response = await s.request(method, { ...(method === 'POST' ? { target: s.target, targetUserId: s.recipient } : {}), role: 'participant', expiresAt: null, execGranted: false });
    expect(response.status).toBe(500);
    expect(await s.row()).toEqual(before);
    expect((await s.auditCount())?.n).toBe(0); expect(s.revalidate).not.toHaveBeenCalled();
  } finally { await db.exec(`DROP TRIGGER ${trigger} ON server_shares; DROP FUNCTION ${fn}();`); }
});

it('concurrent role-only and grant-only PATCHes validate against the locked current role', async () => {
  const s = await seed();
  // Force the role update to win; the blocked grant updater must reread, not resurrect participant.
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { release = r; });
  const downgrade = db.transaction(async (tx) => {
    await tx.queryOne('SELECT id FROM server_shares WHERE id=$1 FOR UPDATE', [s.shareId]);
    entered(); await gate;
    return updateShare(tx, { shareId: s.shareId, serverId: s.serverId, role: 'viewer', now: Date.now() });
  });
  await ready;
  const grant = updateShare(db, { shareId: s.shareId, serverId: s.serverId, execGranted: true, now: Date.now() });
  // Attach rejection handler before releasing the lock; no unhandled promise failures.
  const checked = expect(grant).rejects.toThrow('exec_grant_requires_controlled_device_participant');
  release(); await downgrade; await checked;
  expect(await s.row()).toMatchObject({ role: 'viewer', exec_granted: false });
});

it('concurrent POST and role/expiry PATCH retain a valid committed role/grant pair', async () => {
  const s = await seed(), expiry = Date.now() + 120000;
  const [posted, patched] = await Promise.all([
    s.request('POST', { target: s.target, targetUserId: s.recipient, role: 'participant' }),
    s.request('PATCH', { role: 'viewer', expiresAt: expiry }),
  ]);
  expect(posted.status).toBe(200); expect(patched.status).toBe(200);
  expect((await posted.json()).share).toMatchObject({ role: 'participant', execGranted: false });
  expect((await patched.json()).share).toMatchObject({ role: 'viewer', expiresAt: expiry, execGranted: false });
  const row = await s.row(); expect(row?.exec_granted).toBe(false);
  expect(['viewer', 'participant']).toContain(row?.role);
});

it('PATCH omission keeps the existing grant; role downgrade revokes it with expiry intact', async () => {
  const s = await seed(), before = await s.row();
  expect((await s.request('PATCH', { role: 'participant' })).status).toBe(200);
  expect(await s.row()).toMatchObject({ role: 'participant', exec_granted: true, expires_at: before?.expires_at });
  expect((await s.request('PATCH', { expiresAt: null })).status).toBe(200);
  expect(await s.row()).toMatchObject({ role: 'participant', exec_granted: true, expires_at: null });
  expect((await s.request('PATCH', { role: 'viewer' })).status).toBe(200);
  expect(await s.row()).toMatchObject({ role: 'viewer', exec_granted: false, expires_at: null });
});
