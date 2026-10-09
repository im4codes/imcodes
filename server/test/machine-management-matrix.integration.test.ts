/**
 * tsk_9a8c291594 (finding F-02 of the pron3 strict verification) — real PostgreSQL, the real routes.
 *
 * Before: a user holding an explicit device share role=participant could, with only their own login, re-enable SYSTEM exec the owner
 * had switched off, force a node upgrade, REVOKE the node's credential (offline until re-enrolled) and rename it; a group owner/admin
 * could do the same through the group. Management that changes the device's security or availability is now the OWNER's alone; a group
 * owner/admin keeps only the display name (a label).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { tabSharingRoutes } from '../src/routes/tab-sharing.js';
import { signJwt } from '../src/security/crypto.js';
import { generateControlledNodeId } from '../src/services/controlled-node-identity.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const KEY = 'machine-management-matrix-signing-key-0123456789';
const tag = hex(3);

const ACTORS = ['owner', 'participant', 'viewer', 'groupMember', 'groupAdmin', 'groupOwner', 'stranger', 'revokedShare'] as const;
type ActorName = typeof ACTORS[number];
const userIds = {} as Record<ActorName, string>;
let teamId = '';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => { (c as unknown as { env: unknown }).env = { DB: db, JWT_SIGNING_KEY: KEY, SERVER_URL: 'https://relay.example' }; await next(); });
  hono.route('/api/machines', machinesRoutes);
  hono.route('/api', tabSharingRoutes);
  return hono;
}
const as = (name: ActorName) => ({ authorization: `Bearer ${signJwt({ sub: userIds[name], type: 'web' }, KEY, 3600)}`, 'content-type': 'application/json' });

/** A fresh online controlled node of the owner's with every actor wired to it, so one test cannot disturb another. */
async function freshNode(): Promise<string> {
  const id = `ctl_${hex(5)}`;
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os, node_id, last_heartbeat_at)
     VALUES ($1,$2,'n',$3,'online',$4,$5,true,$6,'Original name','linux',$7,$4)`,
    [id, userIds.owner, sha(hex(8)), Date.now(), NODE_ROLE.CONTROLLED, `ref-${hex(4)}`, generateControlledNodeId()],
  );
  const share = async (name: ActorName, role: 'viewer' | 'participant', revoked = false) => db.execute(
    `INSERT INTO server_shares (id, server_id, target_user_id, role, created_by, created_at, updated_at, revoked_at, exec_granted)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8)`,
    [hex(8), id, userIds[name], role, userIds.owner, Date.now(), revoked ? Date.now() : null, role === 'participant'],
  );
  await share('participant', 'participant');
  await share('viewer', 'viewer');
  await share('revokedShare', 'participant', true);
  await db.execute('INSERT INTO machine_groups (server_id, team_id, added_at) VALUES ($1,$2,$3)', [id, teamId, Date.now()]);
  return id;
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  for (const name of ACTORS) { userIds[name] = `u_${name}_${tag}`; await createUser(db, userIds[name]); }
  teamId = `t_${tag}`;
  await db.execute('INSERT INTO teams (id, name, owner_id, created_at) VALUES ($1,$2,$3,$4)', [teamId, 'ops', userIds.groupOwner, Date.now()]);
  for (const [name, role] of [['groupMember', 'member'], ['groupAdmin', 'admin'], ['groupOwner', 'owner']] as const) {
    await db.execute('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4)', [teamId, userIds[name], role, Date.now()]);
  }
});
afterAll(async () => { await db.close(); });

const stateOf = async (id: string) => (await db.queryOne<{ exec_enabled: boolean; revoked_at: number | null; display_name: string; upgrade: string | null }>(
  'SELECT exec_enabled, revoked_at, display_name, controlled_upgrade_status AS upgrade FROM servers WHERE id = $1', [id]))!;

interface Route { name: string; method: 'POST' | 'GET'; path: (id: string) => string; body?: unknown }
const SECURITY_ROUTES: Route[] = [
  { name: 'revoke', method: 'POST', path: (id) => `/api/machines/${id}/revoke` },
  { name: 'exec-enabled off', method: 'POST', path: (id) => `/api/machines/${id}/exec-enabled`, body: { enabled: false } },
  { name: 'exec-enabled on', method: 'POST', path: (id) => `/api/machines/${id}/exec-enabled`, body: { enabled: true } },
  { name: 'upgrade', method: 'POST', path: (id) => `/api/machines/${id}/upgrade` },
  { name: 'auto-unlock', method: 'POST', path: (id) => `/api/machines/${id}/auto-unlock`, body: { secret: 'participant-supplied' } },
  { name: 'remote-desktop-permissions', method: 'POST', path: (id) => `/api/machines/${id}/remote-desktop-permissions`, body: {} },
  { name: 'remote-desktop-worker', method: 'POST', path: (id) => `/api/machines/${id}/remote-desktop-worker`, body: {} },
  { name: 'remote-desktop-worker refresh', method: 'POST', path: (id) => `/api/machines/${id}/remote-desktop-worker/refresh`, body: {} },
  { name: 'exec-audit', method: 'GET', path: (id) => `/api/machines/${id}/exec-audit` },
];
const NON_OWNERS = ACTORS.filter((a) => a !== 'owner');

describe('security-relevant management is the OWNER\'s alone', () => {
  for (const route of SECURITY_ROUTES) {
    it.each(NON_OWNERS)(`${route.name}: %s is refused (404) and the device is untouched`, async (actor) => {
      const id = await freshNode();
      const before = await stateOf(id);
      const response = await app().request(route.path(id), {
        method: route.method, headers: as(actor), ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
      });
      expect(response.status, `${actor} ${route.name}`).toBe(404);
      expect(await stateOf(id)).toEqual(before);
    });
  }

  it('the owner reaches every one of them (past authorization: no 404/403)', async () => {
    for (const route of SECURITY_ROUTES) {
      const id = await freshNode();
      const response = await app().request(route.path(id), {
        method: route.method, headers: as('owner'), ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
      });
      expect([404, 403], route.name).not.toContain(response.status);
    }
  });

  it('the owner can switch exec off and on, and revoke', async () => {
    const id = await freshNode();
    expect((await app().request(`/api/machines/${id}/exec-enabled`, { method: 'POST', headers: as('owner'), body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await stateOf(id)).exec_enabled).toBe(false);
    expect((await app().request(`/api/machines/${id}/exec-enabled`, { method: 'POST', headers: as('owner'), body: JSON.stringify({ enabled: true }) })).status).toBe(200);
    expect((await stateOf(id)).exec_enabled).toBe(true);
    expect((await app().request(`/api/machines/${id}/revoke`, { method: 'POST', headers: as('owner') })).status).toBe(200);
    expect((await stateOf(id)).revoked_at).not.toBeNull();
  });
});

describe('the display name (a label): the owner and a group owner/admin only', () => {
  it.each(ACTORS)('%s', async (actor) => {
    const id = await freshNode();
    const response = await app().request(`/api/machines/${id}/display-name`, { method: 'POST', headers: as(actor), body: JSON.stringify({ displayName: 'Renamed' }) });
    const allowed = ['owner', 'groupAdmin', 'groupOwner'].includes(actor);
    expect(response.status, actor).toBe(allowed ? 200 : 404);
    expect((await stateOf(id)).display_name).toBe(allowed ? 'Renamed' : 'Original name');
  });
});

describe('the kill switch for all devices only touches the caller\'s own devices', () => {
  it('a participant or group admin calling it switches nothing of the owner\'s off; the owner switches every device of theirs off', async () => {
    const id = await freshNode();
    for (const actor of ['participant', 'groupAdmin', 'stranger'] as const) {
      const response = await app().request('/api/machines/exec-enabled', { method: 'POST', headers: as(actor), body: JSON.stringify({ enabled: false }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ devicesSwitchedOff: 0 });
    }
    expect((await stateOf(id)).exec_enabled).toBe(true);
    const owner = await app().request('/api/machines/exec-enabled', { method: 'POST', headers: as('owner'), body: JSON.stringify({ enabled: false }) });
    expect(owner.status).toBe(200);
    expect((await owner.json() as { devicesSwitchedOff: number }).devicesSwitchedOff).toBeGreaterThanOrEqual(1);
    expect((await stateOf(id)).exec_enabled).toBe(false);
    // It can only turn execution OFF.
    expect((await app().request('/api/machines/exec-enabled', { method: 'POST', headers: as('owner'), body: JSON.stringify({ enabled: true }) })).status).toBe(400);
  });
});

describe('execute grants and device shares are managed by the owner alone', () => {
  const create = (actor: ActorName, id: string, body: Record<string, unknown>) => app().request(`/api/server/${id}/shares`, {
    method: 'POST', headers: as(actor), body: JSON.stringify({ target: { kind: 'server', serverId: id }, ...body }),
  });

  it.each(NON_OWNERS)('%s cannot create a share or an execute grant (403)', async (actor) => {
    const id = await freshNode();
    const response = await create(actor, id, { targetUserId: userIds.stranger, role: 'participant', execGranted: true });
    expect(response.status).toBe(403);
    expect(await db.queryOne('SELECT 1 FROM server_shares WHERE server_id = $1 AND target_user_id = $2', [id, userIds.stranger])).toBeNull();
  });

  it('the owner grants execute explicitly; re-posting without the flag takes it away; a role change away from participant clears it', async () => {
    const id = await freshNode();
    const granted = await create('owner', id, { targetUserId: userIds.stranger, role: 'participant', execGranted: true });
    expect(granted.status).toBe(201);
    const shareId = ((await granted.json()) as { share: { id: string; execGranted: boolean } }).share;
    expect(shareId.execGranted).toBe(true);
    const row = () => db.queryOne<{ exec_granted: boolean; role: string }>('SELECT exec_granted, role FROM server_shares WHERE server_id = $1 AND target_user_id = $2', [id, userIds.stranger]);
    expect(await row()).toEqual({ exec_granted: true, role: 'participant' });

    // Participant tries to PATCH their own grant: refused.
    expect((await app().request(`/api/server/${id}/shares/${shareId.id}`, { method: 'PATCH', headers: as('stranger'), body: JSON.stringify({ execGranted: false }) })).status).toBe(403);

    // The owner downgrades the role: the grant goes with it (the database would refuse a viewer row that kept it).
    const patched = await app().request(`/api/server/${id}/shares/${shareId.id}`, { method: 'PATCH', headers: as('owner'), body: JSON.stringify({ role: 'viewer' }) });
    expect(patched.status).toBe(200);
    expect(await row()).toEqual({ exec_granted: false, role: 'viewer' });
    // An execute grant on a viewer is refused outright.
    expect((await app().request(`/api/server/${id}/shares/${shareId.id}`, { method: 'PATCH', headers: as('owner'), body: JSON.stringify({ execGranted: true }) })).status).toBe(400);

    const again = await create('owner', id, { targetUserId: userIds.stranger, role: 'participant', execGranted: true });
    expect(again.status).toBe(200);
    expect((await row())!.exec_granted).toBe(true);
    // Re-posting WITHOUT the flag takes the grant away (it is never kept by accident).
    await create('owner', id, { targetUserId: userIds.stranger, role: 'participant' });
    expect((await row())!.exec_granted).toBe(false);
  });

  it('an execute grant needs a participant share of a CONTROLLED device', async () => {
    const id = await freshNode();
    expect((await create('owner', id, { targetUserId: userIds.stranger, role: 'viewer', execGranted: true })).status).toBe(400);
    const ordinary = `srv_${hex(5)}`;
    await db.execute('INSERT INTO servers (id, user_id, name, token_hash, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [ordinary, userIds.owner, 'daemon', sha(hex(8)), 'offline', Date.now()]);
    expect((await create('owner', ordinary, { targetUserId: userIds.stranger, role: 'participant', execGranted: true })).status).toBe(400);
  });
});
