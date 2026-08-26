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
import { serverRoutes } from '../src/routes/server.js';
import { bindRoutes } from '../src/routes/bind.js';
import { WsBridge } from '../src/ws/bridge.js';
import { MACHINE_LIST_MAX_ITEMS, NODE_ROLE, NODE_ROLE_REFUSAL } from '../../shared/remote-exec.js';
import { MACHINE_REASONS } from '../../shared/machine-reference.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import { CONTROLLED_NODE_AUTO_UNLOCK_ERROR } from '../../shared/controlled-node-auto-unlock.js';
import { REMOTE_DESKTOP_INSTALLABLE_CAPABILITY } from '../../shared/remote-desktop-install.js';
import { signJwt } from '../src/security/crypto.js';

let db: Database;
const JWT_KEY = 'test-signing-key-32chars-padding!!';
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
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = { DB: db, JWT_SIGNING_KEY: JWT_KEY };
    await next();
  });
  app.route('/api/enroll', enrollRoutes);
  app.route('/api/machines', machinesRoutes);
  app.route('/api/server', serverRoutes);
  app.route('/api/bind', bindRoutes);
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

describe('owner-scoped machine rename', () => {
  it('updates display_name while preserving the stable ref_name', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const owner = await fullCredential(userId);
    const controlledId = `ctl_${hex(8)}`;
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os)
       VALUES ($1,$2,'controlled',$3,'offline',$4,$5,true,'stable-ref','Old name','linux')`,
      [controlledId, userId, sha256(hex(16)), Date.now(), NODE_ROLE.CONTROLLED],
    );

    const response = await app.request(`/api/machines/${controlledId}/display-name`, {
      method: 'POST',
      headers: {
        'X-Server-Id': owner.serverId,
        authorization: `Bearer ${owner.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: '  Office PC  ' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, displayName: 'Office PC' });
    expect(await db.queryOne<{ display_name: string; ref_name: string }>(
      'SELECT display_name, ref_name FROM servers WHERE id = $1',
      [controlledId],
    )).toEqual({ display_name: 'Office PC', ref_name: 'stable-ref' });
  });

  it('rejects invalid names and machines owned by another account', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    const otherUserId = `u_${hex(4)}`;
    await createUser(db, userId);
    await createUser(db, otherUserId);
    const owner = await fullCredential(userId);
    const otherOwner = await fullCredential(otherUserId);
    const controlledId = `ctl_${hex(8)}`;
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os)
       VALUES ($1,$2,'controlled',$3,'offline',$4,$5,true,'stable-ref','Old name','linux')`,
      [controlledId, userId, sha256(hex(16)), Date.now(), NODE_ROLE.CONTROLLED],
    );
    const headers = {
      'X-Server-Id': owner.serverId,
      authorization: `Bearer ${owner.token}`,
      'content-type': 'application/json',
    };

    for (const displayName of ['   ', `bad\u202ename`, 'x'.repeat(121)]) {
      const response = await app.request(`/api/machines/${controlledId}/display-name`, {
        method: 'POST', headers, body: JSON.stringify({ displayName }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: MACHINE_REASONS.INVALID_DISPLAY_NAME });
    }

    const denied = await app.request(`/api/machines/${controlledId}/display-name`, {
      method: 'POST',
      headers: {
        'X-Server-Id': otherOwner.serverId,
        authorization: `Bearer ${otherOwner.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Hijacked' }),
    });
    expect(denied.status).toBe(404);
    expect(await db.queryOne<{ display_name: string }>('SELECT display_name FROM servers WHERE id = $1', [controlledId]))
      .toEqual({ display_name: 'Old name' });
  });
});

describe('auto unlock capability gate', () => {
  it('refuses a node that never advertised auto unlock instead of waiting it out', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const owner = await fullCredential(userId);
    const controlledId = `ctl_${hex(8)}`;
    // Advertises remote desktop but not auto unlock: an older Windows build.
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os, controlled_capabilities)
       VALUES ($1,$2,'controlled',$3,'online',$4,$5,true,'win-ref','Win box','win',$6)`,
      [controlledId, userId, sha256(hex(16)), Date.now(), NODE_ROLE.CONTROLLED,
        JSON.stringify([REMOTE_DESKTOP_CAPABILITY])],
    );

    const started = Date.now();
    const response = await app.request(`/api/machines/${controlledId}/auto-unlock`, {
      method: 'POST',
      headers: {
        'X-Server-Id': owner.serverId,
        authorization: `Bearer ${owner.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ secret: 'hunter2' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: CONTROLLED_NODE_AUTO_UNLOCK_ERROR.UNSUPPORTED_PLATFORM,
    });
    // Refused on the spot, not after the node-reply timeout.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await db.queryOne<{ auto_unlock_configured: boolean }>(
      'SELECT auto_unlock_configured FROM servers WHERE id = $1',
      [controlledId],
    )).toEqual({ auto_unlock_configured: false });
  });
});

describe('remote desktop worker quick install', () => {
  it('dispatches only for an owned, fresh Windows node that advertised repair support', async () => {
    const originalAppVersion = process.env.APP_VERSION;
    process.env.APP_VERSION = '2026.8.4000-dev.1';
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    const otherUserId = `u_${hex(4)}`;
    await createUser(db, userId);
    await createUser(db, otherUserId);
    const owner = await fullCredential(userId);
    const other = await fullCredential(otherUserId);
    const controlledId = `ctl_${hex(8)}`;
    await db.execute(
      `INSERT INTO servers
         (id, user_id, name, token_hash, status, last_heartbeat_at, created_at,
          node_role, exec_enabled, ref_name, display_name, os, daemon_version, controlled_capabilities)
       VALUES ($1,$2,'controlled',$3,'online',$4,$4,$5,true,'win-ref','Win box','win','2026.8.4000-dev.1',$6)`,
      [controlledId, userId, sha256(hex(16)), Date.now(), NODE_ROLE.CONTROLLED,
        JSON.stringify([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY])],
    );
    const bridge = WsBridge.get(controlledId);
    const install = vi.spyOn(bridge, 'tryInstallControlledNodeRemoteDesktopWorker')
      .mockReturnValue('sent');
    try {
      const headers = {
        'X-Server-Id': owner.serverId,
        authorization: `Bearer ${owner.token}`,
      };
      const response = await app.request(`/api/machines/${controlledId}/remote-desktop-worker`, {
        method: 'POST', headers,
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true });
      expect(install).toHaveBeenCalledWith(bridge.daemonConnectionGeneration());

      const denied = await app.request(`/api/machines/${controlledId}/remote-desktop-worker`, {
        method: 'POST',
        headers: {
          'X-Server-Id': other.serverId,
          authorization: `Bearer ${other.token}`,
        },
      });
      expect(denied.status).toBe(404);

      await db.execute(
        'UPDATE servers SET controlled_capabilities = $2 WHERE id = $1',
        [controlledId, JSON.stringify([])],
      );
      const unsupported = await app.request(`/api/machines/${controlledId}/remote-desktop-worker`, {
        method: 'POST', headers,
      });
      expect(unsupported.status).toBe(409);
      expect(install).toHaveBeenCalledTimes(1);

      await db.execute(
        'UPDATE servers SET controlled_capabilities = $2, daemon_version = $3 WHERE id = $1',
        [controlledId, JSON.stringify([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]), '2026.8.3999-dev.1'],
      );
      const updating = await app.request(`/api/machines/${controlledId}/remote-desktop-worker`, {
        method: 'POST', headers,
      });
      expect(updating.status).toBe(409);
      expect(await updating.json()).toEqual({ error: 'node_update_pending' });
      expect(install).toHaveBeenCalledTimes(1);
    } finally {
      install.mockRestore();
      if (originalAppVersion === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = originalAppVersion;
    }
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
    const redeem = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: code, installId: 'i1', nodeTokenHash: sha256(hex(16)), hostname: 'mybox', os: 'linux', arch: 'x64' }),
    });
    const controlledId = (await redeem.json() as { serverId: string }).serverId;
    await db.execute(
      'UPDATE servers SET controlled_capabilities = $2::jsonb WHERE id = $1',
      [controlledId, JSON.stringify([REMOTE_DESKTOP_CAPABILITY])],
    );

    const browser = await app.request('/api/machines', {
      headers: { authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3_600)}` },
    });
    expect(browser.status).toBe(200);
    const browserList = (await browser.json() as { machines: { capabilities?: string[]; accessRole?: string }[] }).machines;
    expect(browserList[0]?.capabilities).toEqual([REMOTE_DESKTOP_CAPABILITY]);
    expect(browserList[0]?.accessRole).toBe('owner');

    const mine = await app.request('/api/machines', { headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` } });
    expect(mine.status).toBe(200);
    const list = (await mine.json() as { machines: { serverId: string; online: boolean; execEnabled: boolean; os?: string; nodeRole: string; accessRole?: string }[] }).machines;
    expect(list.length).toBe(1);
    expect(list[0].online).toBe(false); // no heartbeat yet
    expect(list[0].execEnabled).toBe(true); // installation is explicit consent; owner can still disable later
    expect(list[0].nodeRole).toBe(NODE_ROLE.CONTROLLED);
    expect(list[0].os).toBe('linux');
    expect(list[0]).not.toHaveProperty('accessRole'); // rolling-upgrade compatibility with strict old daemons
    expect(list[0]).not.toHaveProperty('capabilities');

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


/**
 * Daemon-token routes must not answer a controlled node.
 *
 * These routes cannot use `requireAuth()`, because their caller holds a server
 * token rather than a browser session. Each therefore used to resolve the token
 * itself, and in doing so skipped the two checks `requireAuth()` performs: the
 * node's role, and whether the credential was revoked.
 *
 * The consequence was concrete. A controlled node — a machine whose entire
 * contract is that it can be controlled and controls nothing — could read and
 * write its OWNER'S account-scoped memory, because those handlers scope their
 * queries by `user_id`, not by server. Revoking the machine did not stop it.
 */
describe('daemon-token routes reject controlled nodes', () => {
  /** Enrol a real controlled node and return the credential it would hold. */
  async function controlledCredential(userId: string): Promise<{ serverId: string; token: string }> {
    const app = buildApp();
    const code = `tok_${hex(6)}`;
    await seedV2Enrollment(code, userId);
    const nodeToken = hex(16);
    const r = await app.request('/api/enroll/v2/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2, enrollToken: code, installId: `i_${hex(4)}`,
        nodeTokenHash: sha256(nodeToken), hostname: 'h', os: 'linux', arch: 'x64',
      }),
    });
    expect(r.status).toBe(200);
    const { serverId } = await r.json() as { serverId: string };
    return { serverId, token: nodeToken };
  }

  /** Every daemon-token route, with a body valid enough to reach the guard. */
  function daemonRoutes(serverId: string): { name: string; path: string; method: string; body?: unknown }[] {
    return [
      { name: 'owner-private search (read account memory)', method: 'POST', path: `/api/server/${serverId}/shared-context/owner-private/search`, body: { query: '', limit: 100 } },
      { name: 'owner-private write (poison account memory)', method: 'POST', path: `/api/server/${serverId}/shared-context/owner-private`, body: { records: [] } },
      { name: 'processed projections', method: 'POST', path: `/api/server/${serverId}/shared-context/processed`, body: { projections: [] } },
      { name: 'runtime config', method: 'GET', path: `/api/server/${serverId}/shared-context/runtime-config/daemon` },
      { name: 'supervision defaults', method: 'GET', path: `/api/server/${serverId}/supervision/user-defaults/daemon` },
      { name: 'create channel binding', method: 'POST', path: `/api/server/${serverId}/bindings`, body: {} },
      { name: 'delete channel binding', method: 'DELETE', path: `/api/server/${serverId}/bindings`, body: {} },
      { name: 'authored bindings', method: 'POST', path: `/api/server/${serverId}/shared-context/authored-bindings`, body: {} },
      { name: 'resolve namespace', method: 'POST', path: `/api/server/${serverId}/shared-context/resolve-namespace`, body: {} },
    ];
  }

  function call(app: ReturnType<typeof buildApp>, route: { path: string; method: string; body?: unknown }, token: string): Promise<Response> {
    return app.request(route.path, {
      method: route.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
    });
  }

  it('refuses every account-scoped daemon route with controlled_node', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const node = await controlledCredential(userId);

    for (const route of daemonRoutes(node.serverId)) {
      const res = await call(app, route, node.token);
      expect(res.status, `${route.name} must be forbidden`).toBe(403);
      const body = await res.json() as { reason?: string };
      expect(body.reason, `${route.name} must say why`).toBe(NODE_ROLE_REFUSAL.CONTROLLED_NODE);
    }
  });

  it('does not leak owner memory to a controlled node through an empty query', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const secret = `SECRET-${hex(8)}`;
    await db.execute(
      `INSERT INTO owner_private_memories (id, owner_user_id, kind, origin, text, fingerprint, created_at, updated_at)
       VALUES ($1, $2, 'note', 'agent', $3, $4, $5, $5)`,
      [hex(8), userId, secret, hex(16), Date.now()],
    ).catch(() => { /* column set varies by migration; the assertion below is what matters */ });

    const node = await controlledCredential(userId);
    // An empty query skipped the ILIKE and enumerated the whole store.
    const res = await app.request(`/api/server/${node.serverId}/shared-context/owner-private/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${node.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '', limit: 100 }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(secret);
  });

  it('still serves a full daemon on the same routes', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const full = await fullCredential(userId);

    for (const route of daemonRoutes(full.serverId)) {
      const res = await call(app, route, full.token);
      // Payload validation may still reject a stub body; the guard must not.
      expect(res.status, `${route.name} must not be role-forbidden for a full daemon`).not.toBe(403);
      expect(res.status, `${route.name} must authenticate a full daemon`).not.toBe(401);
    }
  });

  it('lets a controlled node heartbeat, because that touches only its own row', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const node = await controlledCredential(userId);
    const res = await app.request(`/api/server/${node.serverId}/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${node.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ daemonVersion: '1.2.3' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a revoked full daemon, which these routes never used to check', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const full = await fullCredential(userId);
    await db.execute('UPDATE servers SET revoked_at = $1 WHERE id = $2', [Date.now(), full.serverId]);

    for (const route of daemonRoutes(full.serverId)) {
      const res = await call(app, route, full.token);
      expect(res.status, `${route.name} must reject a revoked credential`).toBe(401);
    }
    const beat = await app.request(`/api/server/${full.serverId}/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${full.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(beat.status).toBe(401);
  });

  it('rejects a token that addresses a server it does not own', async () => {
    const app = buildApp();
    const userA = `u_${hex(4)}`;
    const userB = `u_${hex(4)}`;
    await createUser(db, userA);
    await createUser(db, userB);
    const a = await fullCredential(userA);
    const b = await fullCredential(userB);

    const res = await app.request(`/api/server/${b.serverId}/shared-context/owner-private/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '', limit: 10 }),
    });
    expect(res.status).toBe(401);
  });
});


/**
 * `POST /api/bind/verify` — found by audit, not by the original inventory.
 *
 * This route was missed because it does not contain a raw
 * `FROM servers WHERE token_hash`: it loads the row with `getServerById()` and
 * compares the hash in TypeScript, so a grep for the SQL shape cannot see it.
 * It accepted a controlled node's token, accepted a revoked credential, and
 * returned the owner's `user_id` to anyone holding a machine token.
 *
 * The lesson the tests encode: authorization coverage must be driven by "which
 * routes accept a daemon token", not by "which routes contain a known query".
 */
describe('POST /api/bind/verify enforces role and revocation', () => {
  async function controlledCredential(userId: string): Promise<{ serverId: string; token: string }> {
    const app = buildApp();
    const code = `tok_${hex(6)}`;
    await seedV2Enrollment(code, userId);
    const nodeToken = hex(16);
    const r = await app.request('/api/enroll/v2/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2, enrollToken: code, installId: `i_${hex(4)}`,
        nodeTokenHash: sha256(nodeToken), hostname: 'h', os: 'linux', arch: 'x64',
      }),
    });
    const { serverId } = await r.json() as { serverId: string };
    return { serverId, token: nodeToken };
  }

  const verify = (app: ReturnType<typeof buildApp>, serverId: string, token: string) =>
    app.request('/api/bind/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId, token }),
    });

  it('refuses a controlled node and never discloses the owner account', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const node = await controlledCredential(userId);

    const res = await verify(app, node.serverId, node.token);
    expect(res.status).toBe(403);
    const body = await res.json() as { reason?: string };
    expect(body.reason).toBe(NODE_ROLE_REFUSAL.CONTROLLED_NODE);
    expect(JSON.stringify(body)).not.toContain(userId);
  });

  it('still verifies a full daemon, and answers without the owner id', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const full = await fullCredential(userId);

    const res = await verify(app, full.serverId, full.token);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // The only caller checks `response.ok`; the account id must not ride along.
    expect(body.userId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(userId);
  });

  it('answers revoked, unknown and wrong-token identically', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);

    const revokedFull = await fullCredential(userId);
    await db.execute('UPDATE servers SET revoked_at = $1 WHERE id = $2', [Date.now(), revokedFull.serverId]);
    const revokedNode = await controlledCredential(userId);
    await db.execute('UPDATE servers SET revoked_at = $1 WHERE id = $2', [Date.now(), revokedNode.serverId]);
    const good = await fullCredential(userId);

    const cases: [string, string, string][] = [
      ['revoked full daemon', revokedFull.serverId, revokedFull.token],
      ['revoked controlled node', revokedNode.serverId, revokedNode.token],
      ['unknown server id', hex(8), good.token],
      ['wrong token', good.serverId, hex(16)],
    ];
    const seen = new Set<string>();
    for (const [label, serverId, token] of cases) {
      const res = await verify(app, serverId, token);
      expect(res.status, `${label} must be 401`).toBe(401);
      seen.add(`${res.status}:${await res.text()}`);
    }
    // One indistinguishable answer: any variation is an existence oracle.
    expect(seen.size).toBe(1);
  });
});
