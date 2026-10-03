/**
 * Owner-only link between a controlled node and the daemon it shares a
 * computer with. That daemon's remote-desktop button opens the linked node,
 * so the link must only ever point one owner's node at the same owner's daemon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { signJwt } from '../src/security/crypto.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  MACHINE_API_PATH,
  MACHINE_HOST_LINK_ERROR,
  MACHINE_HOST_LINK_ROUTE,
} from '../../shared/machine-reference.js';
import { CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME } from '../../shared/controlled-node-host-link.js';
import { autoLinkControlledNodeHost } from '../src/services/controlled-node-host-link.js';

const JWT_KEY = 'machine-host-link-test-key';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => { await db.close(); });

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string; SERVER_URL: string } }).env = {
      DB: db,
      JWT_SIGNING_KEY: JWT_KEY,
      SERVER_URL: 'https://relay.example',
    };
    await next();
  });
  app.route(MACHINE_API_PATH, machinesRoutes);
  return app;
}

function webAuth(userId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`,
    'content-type': 'application/json',
  };
}

async function owner(): Promise<string> {
  const userId = `user-${hex(6)}`;
  await createUser(db, userId);
  return userId;
}

async function daemon(userId: string): Promise<string> {
  const serverId = `full-${hex(6)}`;
  await createServer(db, serverId, userId, 'daemon', sha256(hex(16)));
  return serverId;
}

async function node(userId: string): Promise<string> {
  const serverId = `ctl-${hex(6)}`;
  await createServer(db, serverId, userId, 'node', sha256(hex(16)), undefined, NODE_ROLE.CONTROLLED);
  return serverId;
}

async function hostOf(serverId: string): Promise<string | null> {
  const row = await db.queryOne<{ host_server_id: string | null }>(
    'SELECT host_server_id FROM servers WHERE id = $1',
    [serverId],
  );
  return row?.host_server_id ?? null;
}

function link(app: ReturnType<typeof buildApp>, actorId: string, serverId: string, body: unknown) {
  return app.request(
    `${MACHINE_API_PATH}${MACHINE_HOST_LINK_ROUTE}?serverId=${encodeURIComponent(serverId)}`,
    { method: 'POST', headers: webAuth(actorId), body: JSON.stringify(body) },
  );
}

async function attachCanonicalHost(userId: string, serverId: string, role: 'full' | 'controlled') {
  const hostId = randomUUID();
  const now = Date.now();
  await db.execute(
    `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
     VALUES ($1, $2, 'resolved', $3, $3)`,
    [hostId, userId, now],
  );
  await db.execute(
    `INSERT INTO remote_desktop_host_endpoints (server_id, host_id, owner_user_id, endpoint_role, linked_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [serverId, hostId, userId, role, now],
  );
  return hostId;
}

describe('POST /api/machines/host-link', () => {
  it('links an owned node to an owned daemon, and the machine list carries the link', async () => {
    const app = buildApp();
    const userId = await owner();
    const daemonId = await daemon(userId);
    const nodeId = await node(userId);

    const res = await link(app, userId, nodeId, { hostServerId: daemonId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hostServerId: daemonId });
    expect(await hostOf(nodeId)).toBe(daemonId);

    const list = await app.request(MACHINE_API_PATH, { headers: webAuth(userId) });
    expect(list.status).toBe(200);
    const machines = (await list.json() as { machines: Array<{ serverId: string; hostServerId?: string }> }).machines;
    expect(machines.find((machine) => machine.serverId === nodeId)?.hostServerId).toBe(daemonId);

    const audit = await db.queryOne<{ action: string }>(
      `SELECT action FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(audit?.action).toBe('machine.host_link');
  });

  it('keeps one node per daemon: linking another node replaces the previous link', async () => {
    const app = buildApp();
    const userId = await owner();
    const daemonId = await daemon(userId);
    const first = await node(userId);
    const second = await node(userId);

    expect((await link(app, userId, first, { hostServerId: daemonId })).status).toBe(200);
    expect((await link(app, userId, second, { hostServerId: daemonId })).status).toBe(200);
    expect(await hostOf(first)).toBeNull();
    expect(await hostOf(second)).toBe(daemonId);
  });

  it('clears the link with an explicit null, and refuses an omitted key', async () => {
    const app = buildApp();
    const userId = await owner();
    const daemonId = await daemon(userId);
    const nodeId = await node(userId);
    await link(app, userId, nodeId, { hostServerId: daemonId });

    expect((await link(app, userId, nodeId, {})).status).toBe(400);
    expect(await hostOf(nodeId)).toBe(daemonId);

    const cleared = await link(app, userId, nodeId, { hostServerId: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true, hostServerId: null });
    expect(await hostOf(nodeId)).toBeNull();
  });

  it("never points at another owner's daemon or at a controlled node", async () => {
    const app = buildApp();
    const userId = await owner();
    const otherId = await owner();
    const nodeId = await node(userId);
    const foreignDaemon = await daemon(otherId);
    const anotherNode = await node(userId);

    const foreign = await link(app, userId, nodeId, { hostServerId: foreignDaemon });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: MACHINE_HOST_LINK_ERROR.INVALID_HOST_SERVER });

    const controlled = await link(app, userId, nodeId, { hostServerId: anotherNode });
    expect(controlled.status).toBe(403);
    expect(await hostOf(nodeId)).toBeNull();
  });

  it("lets nobody but the node's owner change its link", async () => {
    const app = buildApp();
    const userId = await owner();
    const otherId = await owner();
    const nodeId = await node(userId);
    const otherDaemon = await daemon(otherId);

    const res = await link(app, otherId, nodeId, { hostServerId: otherDaemon });
    expect(res.status).toBe(404);
    expect(await hostOf(nodeId)).toBeNull();
  });

  it('refuses to join two endpoints that already carry different desktop identities', async () => {
    const app = buildApp();
    const userId = await owner();
    const daemonId = await daemon(userId);
    const nodeId = await node(userId);
    await attachCanonicalHost(userId, daemonId, 'full');
    await attachCanonicalHost(userId, nodeId, 'controlled');

    const res = await link(app, userId, nodeId, { hostServerId: daemonId });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: MACHINE_HOST_LINK_ERROR.HOST_CONFLICT });
    expect(await hostOf(nodeId)).toBeNull();
  });
});

describe('autoLinkControlledNodeHost (the node reports the daemons on its computer)', () => {
  it('links the one daemon of its owner that the node reports', async () => {
    const userId = await owner();
    const otherId = await owner();
    const daemonId = await daemon(userId);
    const foreign = await daemon(otherId);
    const nodeId = await node(userId);

    const outcome = await autoLinkControlledNodeHost(db, {
      nodeServerId: nodeId,
      reportedServerIds: [foreign, daemonId, 'not-a-server'],
    });
    expect(outcome).toBe(CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.LINKED);
    expect(await hostOf(nodeId)).toBe(daemonId);
    const audit = await db.queryOne<{ action: string; details: string }>(
      `SELECT action, details FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(audit?.action).toBe('machine.host_link');
    expect(JSON.stringify(audit?.details)).toContain('automatic');
  });

  it("never links another owner's daemon", async () => {
    const userId = await owner();
    const otherId = await owner();
    const nodeId = await node(userId);
    const foreign = await daemon(otherId);
    expect(await autoLinkControlledNodeHost(db, { nodeServerId: nodeId, reportedServerIds: [foreign] }))
      .toBe(CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.NONE);
    expect(await hostOf(nodeId)).toBeNull();
  });

  it("keeps a link the owner chose, even when the node reports a different daemon", async () => {
    const app = buildApp();
    const userId = await owner();
    const chosen = await daemon(userId);
    const reported = await daemon(userId);
    const nodeId = await node(userId);
    await link(app, userId, nodeId, { hostServerId: chosen });

    expect(await autoLinkControlledNodeHost(db, { nodeServerId: nodeId, reportedServerIds: [reported] }))
      .toBe(CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.KEPT);
    expect(await hostOf(nodeId)).toBe(chosen);
  });

  it('replaces a link whose daemon is gone', async () => {
    const userId = await owner();
    const gone = await daemon(userId);
    const current = await daemon(userId);
    const nodeId = await node(userId);
    await db.execute('UPDATE servers SET host_server_id = $2 WHERE id = $1', [nodeId, gone]);
    await db.execute('UPDATE servers SET revoked_at = $2 WHERE id = $1', [gone, Date.now()]);

    expect(await autoLinkControlledNodeHost(db, { nodeServerId: nodeId, reportedServerIds: [current] }))
      .toBe(CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.LINKED);
    expect(await hostOf(nodeId)).toBe(current);
  });

  it('leaves the choice to the owner when two of their daemons share the computer', async () => {
    const userId = await owner();
    const first = await daemon(userId);
    const second = await daemon(userId);
    const nodeId = await node(userId);
    expect(await autoLinkControlledNodeHost(db, { nodeServerId: nodeId, reportedServerIds: [first, second] }))
      .toBe(CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.AMBIGUOUS);
    expect(await hostOf(nodeId)).toBeNull();
  });

  it('does not take a daemon another node already claims', async () => {
    const userId = await owner();
    const daemonId = await daemon(userId);
    const existing = await node(userId);
    const newcomer = await node(userId);
    await db.execute('UPDATE servers SET host_server_id = $2 WHERE id = $1', [existing, daemonId]);

    expect(await autoLinkControlledNodeHost(db, { nodeServerId: newcomer, reportedServerIds: [daemonId] }))
      .toBe(CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.TAKEN);
    expect(await hostOf(newcomer)).toBeNull();
    expect(await hostOf(existing)).toBe(daemonId);
  });

  it('does not join two endpoints with different desktop identities', async () => {
    const userId = await owner();
    const daemonId = await daemon(userId);
    const nodeId = await node(userId);
    await attachCanonicalHost(userId, daemonId, 'full');
    await attachCanonicalHost(userId, nodeId, 'controlled');
    expect(await autoLinkControlledNodeHost(db, { nodeServerId: nodeId, reportedServerIds: [daemonId] }))
      .toBe(CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.CONFLICT);
    expect(await hostOf(nodeId)).toBeNull();
  });

  it('ignores a report from anything but a live controlled node', async () => {
    const userId = await owner();
    const daemonId = await daemon(userId);
    const other = await daemon(userId);
    expect(await autoLinkControlledNodeHost(db, { nodeServerId: daemonId, reportedServerIds: [other] }))
      .toBe(CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.NOT_FOUND);
  });
});
