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
import { createMachineExecRoutes, machineExecAuditIntentStore, type ExecDispatcher, type ExecIntentStore } from '../src/routes/machine-exec.js';
import { MACHINE_EXEC_HTTP_ENVELOPE_VERSION, MACHINE_EXEC_HTTP_PROTOCOL, NODE_ROLE } from '../../shared/remote-exec.js';

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
  it('unauthenticated source is denied with the versioned envelope (401)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const tgt = await controlledServer(u);
    const r = await app.request(`/api/machine/exec?serverId=${tgt.serverId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'x' }),
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'scoped_auth' });
  });

  it('invalid source token is denied with the versioned envelope (401)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    const r = await post(app, { serverId: src.serverId, token: 'wrong-token' }, tgt.serverId, { command: 'x' });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'scoped_auth' });
  });


  it('full → owned controlled + online → completed, outcome + fields passed through', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: 'hi', stderr: '', durationMs: 5 } });
    const r = await post(app, src, tgt.serverId, { command: 'echo hi' });
    expect(r.status).toBe(200);
    const b = await r.json() as { protocol: string; version: number; outcome: string; reason: string; stdout: string; exitCode: number };
    expect(b.protocol).toBe(MACHINE_EXEC_HTTP_PROTOCOL);
    expect(b.version).toBe(MACHINE_EXEC_HTTP_ENVELOPE_VERSION);
    expect(b.outcome).toBe('completed'); expect(b.stdout).toBe('hi'); expect(b.exitCode).toBe(0);
    expect(b.reason).toBe('completed');
  });

  it('offline target → not_dispatched (retry-safe)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: false });
    const r = await post(app, src, tgt.serverId, { command: 'echo hi' });
    expect(await r.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'target_unavailable' });
  });

  it('dispatched but no result → dispatched_no_result (indeterminate)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true });
    expect(await (await post(app, src, tgt.serverId, { command: 'x' })).json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'dispatched_no_result', reason: 'relay_deadline' });
  });

  it('node timeout maps to node_timeout', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 1000, timedOut: true, error: 'timeout' } });
    expect(await (await post(app, src, tgt.serverId, { command: 'x' })).json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'node_timeout', reason: 'node_timeout' });
  });

  it('malformed dispatcher result is treated as indeterminate with invalid_result reason', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: 'x'.repeat(1_000_001), stderr: '', durationMs: 1 } });
    const r = await post(app, src, tgt.serverId, { command: 'x' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'dispatched_no_result', reason: 'invalid_result' });
  });

  it('success with a present empty error is indeterminate, never a post-dispatch 500', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, error: '' } });
    const r = await post(app, src, tgt.serverId, { command: 'x' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      protocol: MACHINE_EXEC_HTTP_PROTOCOL,
      version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
      outcome: 'dispatched_no_result',
      reason: 'invalid_result',
    });
  });

  it('dispatcher exceptions after intent persistence return a current indeterminate envelope', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => { throw new Error('unexpected dispatcher failure'); };
    const r = await post(app, src, tgt.serverId, { command: 'x' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      protocol: MACHINE_EXEC_HTTP_PROTOCOL,
      version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
      outcome: 'dispatched_no_result',
      reason: 'invalid_result',
    });
  });

  it('controlled source is denied (403)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await controlledServer(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true });
    const response = await post(app, src, tgt.serverId, { command: 'x' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'scoped_auth' });
  });

  it('cross-account target is denied (403, not 404)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; const other = `u_${hex(4)}`;
    await createUser(db, u); await createUser(db, other);
    const src = await fullCredential(u); const tgt = await controlledServer(other);
    const response = await post(app, src, tgt.serverId, { command: 'x' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'target_forbidden' });
  });

  it('target that is a full node is denied (403)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgtFull = await fullCredential(u);
    const response = await post(app, src, tgtFull.serverId, { command: 'x' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'target_forbidden' });
  });

  it('revoked target is denied (403)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u, { revoked: true });
    const response = await post(app, src, tgt.serverId, { command: 'x' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'target_forbidden' });
  });

  it('exec-disabled target is denied (403, D-E default off)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u, { execEnabled: false });
    const response = await post(app, src, tgt.serverId, { command: 'x' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'exec_disabled' });
  });

  it('source == target is denied (403)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u);
    const response = await post(app, src, src.serverId, { command: 'x' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'scoped_auth' });
  });

  it('malformed payload (unknown shell) is rejected before dispatch (400)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    const response = await post(app, src, tgt.serverId, { command: 'x', shell: 'zsh' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'invalid_request' });
  });

  it('strict body validation: an identity/target field in the body is rejected (400), never dispatched', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    let dispatched = false;
    dispatcher = async () => { dispatched = true; return { online: true }; };
    for (const bad of [
      { command: 'x', serverId: 'OTHER' },
      { command: 'x', targetServerId: 'OTHER' },
      { command: 'x', target: 'OTHER' },
      { command: 'x', userId: 'someone' },
      { command: 'x', correlationId: 'attacker-chosen' },
    ]) {
      const r = await post(app, src, tgt.serverId, bad);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'invalid_request' });
    }
    expect(dispatched).toBe(false);
  });

  it('strict body validation: an unknown field is rejected (400)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    const response = await post(app, src, tgt.serverId, { command: 'x', bogus: 1 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'invalid_request' });
  });

  it('strict body validation: all permitted exec params are accepted', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 } });
    const r = await post(app, src, tgt.serverId, { command: 'echo', shell: 'bash', cwd: '/tmp', timeoutMs: 5000 });
    expect(r.status).toBe(200);
    expect((await r.json() as { outcome: string }).outcome).toBe('completed');
  });

  it('rejects caller-supplied idempotencyKey because v1 offers no dedup guarantee', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    const r = await post(app, src, tgt.serverId, { command: 'echo', idempotencyKey: 'caller-key' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ reason: 'invalid_request' });
  });
});

describe('exec durable intent invariant (audit checklist)', () => {
  function appWithStore(store: ExecIntentStore) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: Database } }).env = { DB: db };
      await next();
    });
    app.route('/api/machine/exec', createMachineExecRoutes((t, f, d) => dispatcher(t, f, d), store));
    return app;
  }

  it('fail-closed: an un-persisted intent STOPS exec before dispatch (503, dispatcher never called)', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    let dispatched = false;
    dispatcher = async () => { dispatched = true; return { online: true }; };
    const store: ExecIntentStore = { record: async () => { throw new Error('intent db down'); }, settle: async () => {} };
    const r = await post(appWithStore(store), src, tgt.serverId, { command: 'echo hi' });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ protocol: MACHINE_EXEC_HTTP_PROTOCOL, version: 1, outcome: 'not_dispatched', reason: 'intent_unavailable' });
    expect(dispatched).toBe(false); // never ran a SYSTEM command without a durable record
  });

  it('records the intent BEFORE dispatch and settles the SAME correlationId with the truthful outcome', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    const order: string[] = [];
    let recorded = '';
    let settled: { correlationId: string; outcome: string } | null = null;
    dispatcher = async (_t, frame) => {
      order.push(`dispatch:${frame.correlationId}`);
      return { online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 3 } };
    };
    const store: ExecIntentStore = {
      record: async (_db, i) => { order.push(`record:${i.correlationId}`); recorded = i.correlationId; },
      settle: async (_db, correlationId, outcome) => { settled = { correlationId, outcome }; },
    };
    const r = await post(appWithStore(store), src, tgt.serverId, { command: 'echo hi' });
    expect(r.status).toBe(200);
    expect(order).toEqual([`record:${recorded}`, `dispatch:${recorded}`]); // persist precedes send
    expect(settled).toEqual({ correlationId: recorded, outcome: 'completed' }); // one record, truthful outcome
  });

  it('settles dispatcher anomalies on the same durable row as indeterminate', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    let recorded = '';
    let settled: { correlationId: string; outcome: string } | null = null;
    dispatcher = async () => { throw new Error('send state became unknowable'); };
    const store: ExecIntentStore = {
      record: async (_db, intent) => { recorded = intent.correlationId; },
      settle: async (_db, correlationId, outcome) => { settled = { correlationId, outcome }; },
    };
    const response = await post(appWithStore(store), src, tgt.serverId, { command: 'echo hi' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'dispatched_no_result', reason: 'invalid_result' });
    expect(settled).toEqual({ correlationId: recorded, outcome: 'dispatched_no_result' });
  });

  it('a settle failure after a completed exec does NOT turn it into a 5xx (no induced retry)', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: 'done', stderr: '', durationMs: 2 } });
    const store: ExecIntentStore = { record: async () => {}, settle: async () => { throw new Error('settle failed'); } };
    const r = await post(appWithStore(store), src, tgt.serverId, { command: 'echo hi' });
    expect(r.status).toBe(200);
    expect((await r.json() as { outcome: string }).outcome).toBe('completed');
  });

  it('production adapter writes exactly ONE machine_exec_audit row: pending → truthful completed outcome', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 7, stdout: 'hi', stderr: '', durationMs: 4 } });
    const r = await post(appWithStore(machineExecAuditIntentStore), src, tgt.serverId, { command: 'echo hi' });
    expect(r.status).toBe(200);
    const rows = await db.query<{ correlation_id: string; outcome: string; exit_code: number | null; command_length: number; command_sha256: string }>(
      'SELECT correlation_id, outcome, exit_code, command_length, command_sha256 FROM machine_exec_audit WHERE target_server_id = $1',
      [tgt.serverId],
    );
    expect(rows.length).toBe(1); // exactly one semantic row (no duplicate logAudit)
    expect(rows[0].outcome).toBe('completed');
    expect(rows[0].exit_code).toBe(7);
    expect(rows[0].command_length).toBe(Buffer.byteLength('echo hi', 'utf8'));
    expect(rows[0].command_sha256).toBe(sha256('echo hi')); // command hashed, never stored raw
  });

  it('production adapter settles an indeterminate dispatch as dispatched_no_result on the same row', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true }); // no result → indeterminate
    const r = await post(appWithStore(machineExecAuditIntentStore), src, tgt.serverId, { command: 'sleep 999' });
    expect((await r.json() as { outcome: string }).outcome).toBe('dispatched_no_result');
    const rows = await db.query<{ outcome: string }>(
      'SELECT outcome FROM machine_exec_audit WHERE target_server_id = $1',
      [tgt.serverId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('dispatched_no_result');
  });

  it('retains source/target serverId after the server row is deleted (immutable attribution, migration 057)', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 } });
    expect((await post(appWithStore(machineExecAuditIntentStore), src, tgt.serverId, { command: 'echo hi' })).status).toBe(200);
    // Remove the controlled node. Pre-057 the FK ON DELETE SET NULL erased the
    // audit serverId; post-057 the columns are immutable denormalized TEXT.
    await db.execute('DELETE FROM servers WHERE id = $1', [tgt.serverId]);
    const rows = await db.query<{ source_server_id: string | null; target_server_id: string | null }>(
      'SELECT source_server_id, target_server_id FROM machine_exec_audit WHERE user_id = $1', [u]);
    expect(rows.length).toBe(1);                          // audit row survives server deletion
    expect(rows[0].target_server_id).toBe(tgt.serverId); // retained (would be NULL pre-057)
    expect(rows[0].source_server_id).toBe(src.serverId);
  });

  it('deleting the user still cascade-purges their exec audit rows (data-subject deletion preserved)', async () => {
    const u = `u_${hex(4)}`; await createUser(db, u);
    const src = await fullCredential(u); const tgt = await controlledServer(u);
    dispatcher = async () => ({ online: true, result: { requestId: 'x', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 } });
    await post(appWithStore(machineExecAuditIntentStore), src, tgt.serverId, { command: 'echo hi' });
    expect((await db.query('SELECT 1 FROM machine_exec_audit WHERE user_id = $1', [u])).length).toBe(1);
    await db.execute('DELETE FROM servers WHERE user_id = $1', [u]);
    await db.execute('DELETE FROM users WHERE id = $1', [u]); // 053 user_id ON DELETE CASCADE
    expect((await db.query('SELECT 1 FROM machine_exec_audit WHERE user_id = $1', [u])).length).toBe(0);
  });
});
