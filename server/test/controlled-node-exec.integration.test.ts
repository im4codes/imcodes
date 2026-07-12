/**
 * Exec relay authz matrix + outcome mapping — real PostgreSQL.
 * The live WsBridge round-trip is E2E-verified separately; here the dispatcher is
 * injected so the authorization, identity, validation, and outcome logic are
 * deterministically testable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { createMachineExecRoutes, type ExecDispatcher } from '../src/routes/machine-exec.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let dispatcher: ExecDispatcher = async () => ({ online: false });

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
  app.route('/api/machine/exec', createMachineExecRoutes((t, f, d) => dispatcher(t, f, d)));
  return app;
}

async function fullCredential(userId: string): Promise<{ serverId: string; token: string }> {
  const token = hex(16); const serverId = hex(8);
  await createServer(db, serverId, userId, 'full', sha256(token));
  return { serverId, token };
}
async function controlledServer(userId: string, opts: { execEnabled?: boolean; revoked?: boolean } = {}): Promise<{ serverId: string; token: string }> {
  const token = hex(16); const serverId = hex(8);
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, revoked_at, ref_name)
     VALUES ($1,$2,'ctl',$3,'offline',$4,$5,$6,$7,$8)`,
    [serverId, userId, sha256(token), Date.now(), NODE_ROLE.CONTROLLED, opts.execEnabled ?? true, opts.revoked ? Date.now() : null, `ref-${serverId}`],
  );
  return { serverId, token };
}
function post(app: ReturnType<typeof buildApp>, source: { serverId: string; token: string }, target: string, body: unknown) {
  return app.request(`/api/machine/exec?serverId=${target}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Server-Id': source.serverId, authorization: `Bearer ${source.token}` },
    body: JSON.stringify(body),
  });
}

describe('exec relay authorization matrix', () => {
  it('full → owned controlled + online → completed, outcome + fields passed through', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: 'hi', stderr: '', durationMs: 5 } });
    const r = await post(app, src, tgt.serverId, { command: 'echo hi' });
    expect(r.status).toBe(200);
    const b = await r.json() as { outcome: string; stdout: string; exitCode: number };
    expect(b.outcome).toBe('completed'); expect(b.stdout).toBe('hi'); expect(b.exitCode).toBe(0);
  });

  it('offline target → not_dispatched (retry-safe)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: false });
    const r = await post(app, src, tgt.serverId, { command: 'echo hi' });
    expect((await r.json() as { outcome: string }).outcome).toBe('not_dispatched');
  });

  it('dispatched but no result → dispatched_no_result (indeterminate)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true });
    expect((await (await post(app, src, tgt.serverId, { command: 'x' })).json() as { outcome: string }).outcome).toBe('dispatched_no_result');
  });

  it('node timeout maps to node_timeout', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 1000, timedOut: true } });
    expect((await (await post(app, src, tgt.serverId, { command: 'x' })).json() as { outcome: string }).outcome).toBe('node_timeout');
  });

  it('controlled source is denied (403)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await controlledServer(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true });
    expect((await post(app, src, tgt.serverId, { command: 'x' })).status).toBe(403);
  });

  it('cross-account target is denied (403, not 404)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; const other = `u_${hex(4)}`;
    await createUser(db, u); await createUser(db, other);
    const src = await fullCredential(u); const tgt = await controlledServer(other);
    expect((await post(app, src, tgt.serverId, { command: 'x' })).status).toBe(403);
  });

  it('target that is a full node is denied (403)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgtFull = await fullCredential(u);
    expect((await post(app, src, tgtFull.serverId, { command: 'x' })).status).toBe(403);
  });

  it('revoked target is denied (403)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u, { revoked: true });
    expect((await post(app, src, tgt.serverId, { command: 'x' })).status).toBe(403);
  });

  it('exec-disabled target is denied (403, D-E default off)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u, { execEnabled: false });
    expect((await post(app, src, tgt.serverId, { command: 'x' })).status).toBe(403);
  });

  it('source == target is denied (403)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u);
    expect((await post(app, src, src.serverId, { command: 'x' })).status).toBe(403);
  });

  it('malformed payload (unknown shell) is rejected before dispatch (400)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    expect((await post(app, src, tgt.serverId, { command: 'x', shell: 'zsh' })).status).toBe(400);
  });
});
