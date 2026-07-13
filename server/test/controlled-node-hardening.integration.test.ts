/**
 * Controlled-node hardening — real PostgreSQL (testcontainers via integration-global).
 * Covers D-A transactional/idempotent redeem, global node_role default-deny,
 * default-enabled controlled-node execution, revocation kill-switch, and the
 * owner-scoped DB-backed machine listing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { enrollRoutes } from '../src/routes/enroll.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { WsBridge } from '../src/ws/bridge.js';
import { MACHINE_LIST_MAX_ITEMS, NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database } }).env = { DB: db };
    await next();
  });
  app.route('/api/enroll', enrollRoutes);
  app.route('/api/machines', machinesRoutes);
  return app;
}

async function seedV2Enrollment(code: string, userId: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO controlled_node_enrollments_v2
       (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
        encrypted_code, ticket_expires_at, expires_at, created_at)
     VALUES ($1, $2, $3, 'linux', 'x64', $4, 'test-only', $5, $5, $6)`,
    [sha256(hex(16)), sha256(code), userId, sha256(hex(32)), now + 60_000, now],
  );
}

/** A FULL server credential for `userId`, usable as X-Server-Id + Bearer. */
async function fullCredential(userId: string): Promise<{ serverId: string; token: string }> {
  const token = hex(16);
  const serverId = hex(8);
  await createServer(db, serverId, userId, 'full-box', sha256(token)); // node_role defaults to full
  return { serverId, token };
}

describe('D-A transactional / idempotent redeem', () => {
  it('returns the same server for a repeated installId and creates no second machine', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const code = `tok_${hex(6)}`;
    await seedV2Enrollment(code, userId);
    const nodeToken = hex(16);
    const payload = { version: 2, enrollToken: code, installId: 'install-1', nodeTokenHash: sha256(nodeToken), hostname: 'win桌面 (x64)', os: 'linux', arch: 'x64' };

    const r1 = await app.request('/api/enroll/v2/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as { serverId: string; token?: string; refName: string; nodeRole: string };
    expect(b1.nodeRole).toBe(NODE_ROLE.CONTROLLED);
    expect(b1.token).toBeUndefined(); // D-A: server does not return an unrecoverable raw token
    expect(b1.refName).toMatch(/^[\p{L}\p{N}._-]{1,40}$/u);

    const r2 = await app.request('/api/enroll/v2/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as { serverId: string };
    expect(b2.serverId).toBe(b1.serverId); // idempotent

    const count = await db.queryOne<{ n: string }>('SELECT COUNT(*)::text AS n FROM servers WHERE user_id = $1 AND node_role = $2', [userId, NODE_ROLE.CONTROLLED]);
    expect(count?.n).toBe('1');
  });
});

describe('global node_role default-deny', () => {
  it('denies a controlled credential on a normal REST API (GET /api/machines)', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const code = `tok_${hex(6)}`;
    await seedV2Enrollment(code, userId);
    const nodeToken = hex(16);
    const r = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: code, installId: 'i1', nodeTokenHash: sha256(nodeToken), hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    const { serverId } = await r.json() as { serverId: string };

    // The controlled node's own credential must NOT reach a normal REST API.
    const denied = await app.request('/api/machines', {
      headers: { 'X-Server-Id': serverId, authorization: `Bearer ${nodeToken}` },
    });
    expect(denied.status).toBe(403);
  });
});

describe('revocation kill-switch', () => {
  it('rejects a revoked controlled credential', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const owner = await fullCredential(userId);
    const code = `tok_${hex(6)}`;
    await seedV2Enrollment(code, userId);
    const nodeToken = hex(16);
    const r = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: code, installId: 'i1', nodeTokenHash: sha256(nodeToken), hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    const { serverId } = await r.json() as { serverId: string };
    const kickSpy = vi.spyOn(WsBridge.get(serverId), 'kickDaemon');

    const revoke = await app.request(`/api/machines/${serverId}/revoke`, {
      method: 'POST', headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` },
    });
    expect(revoke.status).toBe(200);
    expect(kickSpy).toHaveBeenCalledOnce();
    kickSpy.mockRestore();

    // After revoke the controlled credential is rejected outright (resolveAuth → null → 401).
    const after = await app.request('/api/machines', {
      headers: { 'X-Server-Id': serverId, authorization: `Bearer ${nodeToken}` },
    });
    expect(after.status).toBe(401);
  });
});

describe('owner-scoped machine listing (DB presence)', () => {
  it('returns an empty list when the owner has zero controlled machines', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const owner = await fullCredential(userId);

    const response = await app.request('/api/machines', { headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ machines: [] });
  });

  it('lists the owner controlled machines (offline by default) and hides other accounts', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    const otherId = `u_${hex(4)}`;
    await createUser(db, userId);
    await createUser(db, otherId);
    const owner = await fullCredential(userId);
    const other = await fullCredential(otherId);
    const code = `tok_${hex(6)}`;
    await seedV2Enrollment(code, userId);
    await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: code, installId: 'i1', nodeTokenHash: sha256(hex(16)), hostname: 'mybox', os: 'linux', arch: 'x64' }),
    });

    const mine = await app.request('/api/machines', { headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` } });
    expect(mine.status).toBe(200);
    const list = (await mine.json() as { machines: { serverId: string; online: boolean; execEnabled: boolean; os?: string; nodeRole: string }[] }).machines;
    expect(list.length).toBe(1);
    expect(list[0].online).toBe(false); // no heartbeat yet
    expect(list[0].execEnabled).toBe(true); // installation is explicit consent; owner can still disable later
    expect(list[0].nodeRole).toBe(NODE_ROLE.CONTROLLED);
    expect(list[0].os).toBe('linux');

    const theirs = await app.request('/api/machines', { headers: { 'X-Server-Id': other.serverId, authorization: `Bearer ${other.token}` } });
    expect(((await theirs.json() as { machines: unknown[] }).machines).length).toBe(0);
  });

  it('returns exactly max owner machines with canonical OS and role', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const owner = await fullCredential(userId);
    const now = Date.now();
    for (let i = 0; i < MACHINE_LIST_MAX_ITEMS; i++) {
      const id = `ctl_${hex(8)}_${i}`;
      await db.execute(
        `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os)
         VALUES ($1,$2,$3,$4,'offline',$5,$6,true,$3,$3,$7)`,
        [id, userId, `ctl-${String(i).padStart(3, '0')}`, sha256(hex(16)), now, NODE_ROLE.CONTROLLED, i === 0 ? 'plan9' : 'mac'],
      );
    }
    const response = await app.request('/api/machines', { headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` } });
    expect(response.status).toBe(200);
    const machines = (await response.json() as { machines: { os?: string; nodeRole: string }[] }).machines;
    expect(machines).toHaveLength(MACHINE_LIST_MAX_ITEMS);
    expect(machines.every((machine) => machine.nodeRole === NODE_ROLE.CONTROLLED)).toBe(true);
    expect(machines[0]).not.toHaveProperty('os');
    expect(machines[1].os).toBe('mac');
  });

  it('returns an explicit overload when owner machine listing exceeds max', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const owner = await fullCredential(userId);
    const now = Date.now();
    for (let i = 0; i < MACHINE_LIST_MAX_ITEMS + 1; i++) {
      const id = `ctl_${hex(8)}_${i}`;
      await db.execute(
        `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os)
         VALUES ($1,$2,$3,$4,'offline',$5,$6,true,$3,$3,$7)`,
        [id, userId, `ctl-over-${String(i).padStart(3, '0')}`, sha256(hex(16)), now, NODE_ROLE.CONTROLLED, 'linux'],
      );
    }
    const response = await app.request('/api/machines', { headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` } });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'machine_list_over_limit', maxItems: MACHINE_LIST_MAX_ITEMS });
  });
});
