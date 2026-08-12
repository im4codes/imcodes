import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { createOrUpdateShare } from '../src/db/tab-sharing.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { createMachineExecRoutes } from '../src/routes/machine-exec.js';
import { createMachineComputerUseRoutes } from '../src/routes/machine-computer-use.js';
import { tabSharingRoutes } from '../src/routes/tab-sharing.js';
import { signJwt } from '../src/security/crypto.js';
import { COOKIE_SESSION } from '../../shared/cookie-names.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

const JWT_KEY = 'controlled-machine-sharing-test-key';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => { await db.close(); });

function webAuth(userId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`,
    'content-type': 'application/json',
  };
}

function cookieAuthWithSpoofedServerHeader(userId: string): Record<string, string> {
  const token = signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600);
  return {
    cookie: `${COOKIE_SESSION}=${encodeURIComponent(token)}`,
    'X-Server-Id': 'browser-controlled-header',
  };
}

async function fullCredential(userId: string) {
  const serverId = `full-${hex(6)}`;
  const token = hex(16);
  await createServer(db, serverId, userId, 'full', sha256(token));
  return { serverId, token };
}

async function controlledNode(userId: string) {
  const serverId = `ctl-${hex(6)}`;
  await db.execute(
    `INSERT INTO servers
       (id, user_id, name, token_hash, status, created_at, node_role,
        exec_enabled, ref_name, display_name, os)
     VALUES ($1,$2,'controlled',$3,'online',$4,$5,true,$6,'Shared machine','linux')`,
    [serverId, userId, sha256(hex(16)), Date.now(), NODE_ROLE.CONTROLLED, `ref-${hex(4)}`],
  );
  return serverId;
}

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = {
      DB: db,
      JWT_SIGNING_KEY: JWT_KEY,
    };
    await next();
  });
  app.route('/api/machines', machinesRoutes);
  app.route('/api', tabSharingRoutes);
  app.route('/api/machine/exec', createMachineExecRoutes(async () => ({
    online: true,
    result: { requestId: 'exec', ok: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 },
  })));
  app.route('/api/machine/computer-use', createMachineComputerUseRoutes(async (_target, frame) => ({
    online: true,
    result: {
      correlationId: frame.correlationId,
      ok: true,
      tool: frame.tool,
      content: [{ type: 'text', text: 'ok' }],
      durationMs: 1,
    },
  })));
  return app;
}

async function createMachineGrant(params: {
  ownerId: string;
  recipientId: string;
  serverId: string;
  role: 'viewer' | 'participant';
  expiresAt?: number | null;
}) {
  return createOrUpdateShare(db, {
    id: `share-${hex(8)}`,
    target: { kind: 'server', serverId: params.serverId },
    targetUserId: params.recipientId,
    role: params.role,
    createdBy: params.ownerId,
    expiresAt: params.expiresAt ?? null,
    now: Date.now(),
  });
}

describe('controlled-node sharing reuses grants without becoming a shared Tab', () => {
  it('lists active grants as machines, applies role changes, and isolates shared-session routes', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const recipientId = `recipient-${hex(4)}`;
    const outsiderId = `outsider-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, recipientId), createUser(db, outsiderId)]);
    const serverId = await controlledNode(ownerId);

    const create = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: webAuth(ownerId),
      body: JSON.stringify({
        target: { kind: 'server', serverId },
        targetUserId: recipientId,
        role: 'viewer',
      }),
    });
    expect(create.status).toBe(201);

    const viewerList = await app.request('/api/machines', { headers: webAuth(recipientId) });
    expect(await viewerList.json()).toEqual({
      machines: [expect.objectContaining({
        serverId,
        displayName: 'Shared machine',
        accessRole: 'viewer',
        execEnabled: false,
      })],
    });
    const spoofedBrowserList = await app.request('/api/machines', {
      headers: cookieAuthWithSpoofedServerHeader(recipientId),
    });
    expect(spoofedBrowserList.status).toBe(200);
    expect(await spoofedBrowserList.json()).toEqual({
      machines: [expect.objectContaining({ accessRole: 'viewer', execEnabled: false })],
    });
    expect(await (await app.request('/api/machines', { headers: webAuth(outsiderId) })).json())
      .toEqual({ machines: [] });

    const sharedTabs = await app.request('/api/shares', { headers: webAuth(recipientId) });
    expect(await sharedTabs.json()).toEqual({ shares: [] });
    for (const path of ['/api/shares/open', '/api/shares/ws-ticket']) {
      const response = await app.request(path, {
        method: 'POST',
        headers: webAuth(recipientId),
        body: JSON.stringify({ target: { kind: 'server', serverId } }),
      });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ reason: 'share-target-unavailable' });
    }

    const share = await create.json() as { share: { id: string } };
    const promote = await app.request(`/api/server/${serverId}/shares/${share.share.id}`, {
      method: 'PATCH',
      headers: webAuth(ownerId),
      body: JSON.stringify({ role: 'participant' }),
    });
    expect(promote.status).toBe(200);
    const participantList = await app.request('/api/machines', { headers: webAuth(recipientId) });
    expect(await participantList.json()).toEqual({
      machines: [expect.objectContaining({ serverId, accessRole: 'participant', execEnabled: true })],
    });

    const nonOwnerManage = await app.request(`/api/server/${serverId}/shares`, {
      headers: webAuth(recipientId),
    });
    expect(nonOwnerManage.status).toBe(403);

    const revoke = await app.request(`/api/server/${serverId}/shares/${share.share.id}`, {
      method: 'DELETE',
      headers: webAuth(ownerId),
    });
    expect(revoke.status).toBe(200);
    expect(await (await app.request('/api/machines', { headers: webAuth(recipientId) })).json())
      .toEqual({ machines: [] });
  });
});

describe('controlled-node shared action admission', () => {
  it('allows Participant exec/computer-use, denies Viewer, and expires immediately', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const recipientId = `recipient-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, recipientId)]);
    const source = await fullCredential(recipientId);
    const targetId = await controlledNode(ownerId);
    const grant = await createMachineGrant({ ownerId, recipientId, serverId: targetId, role: 'participant' });
    const auth = {
      'X-Server-Id': source.serverId,
      authorization: `Bearer ${source.token}`,
      'content-type': 'application/json',
    };

    const exec = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ command: 'echo ok' }),
    });
    expect(exec.status).toBe(200);
    expect(await exec.json()).toMatchObject({ outcome: 'completed', stdout: 'ok' });

    const computer = await app.request(`/api/machine/computer-use?serverId=${targetId}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    });
    expect(computer.status).toBe(200);
    expect(await computer.json()).toMatchObject({ outcome: 'completed' });

    await createMachineGrant({ ownerId, recipientId, serverId: targetId, role: 'viewer' });
    const viewerExec = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ command: 'echo denied' }),
    });
    expect(viewerExec.status).toBe(403);
    expect(await viewerExec.json()).toMatchObject({ reason: 'target_forbidden' });

    await db.execute(
      'UPDATE server_shares SET expires_at = $2 WHERE id = $1',
      [grant.id, Date.now() - 1],
    );
    const expiredExec = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ command: 'echo expired' }),
    });
    expect(expiredExec.status).toBe(403);
    expect(await expiredExec.json()).toMatchObject({ reason: 'target_forbidden' });
    expect(await (await app.request('/api/machines', { headers: webAuth(recipientId) })).json())
      .toEqual({ machines: [] });
  });
});
