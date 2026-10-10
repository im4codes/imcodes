/**
 * tsk_9a8c291594 — operate is not execute. Real PostgreSQL, the real resolvers and routes; only the dispatchers (the socket to the node)
 * are injected.
 *
 * Before: ANY group member of ANY group that contained the machine, and every explicit share participant, could run commands as
 * SYSTEM/root on it (operate == exec). Now execute-class actions need the node's exec switch ON and the device OWNER or an explicit
 * per-device share participant carrying the owner's execute grant, on a turn the owner's own request started.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { createMachineExecRoutes, machineExecAuditIntentStore, type ExecDispatcher } from '../src/routes/machine-exec.js';
import { createMachineComputerUseRoutes, type ComputerUseDispatcher } from '../src/routes/machine-computer-use.js';
import { admitMachineAction, issueSharedMachineAuthority } from '../src/share/shared-machine-authority.js';
import { listControlledMachines, machinesRoutes } from '../src/routes/machines.js';
import { resetMachineActionGateForTests } from '../src/security/machine-action-gate.js';
import { SHARED_MACHINE_AUTHORITY_HEADER, SHARED_MACHINE_AUTHORITY_TYPE } from '../../shared/shared-machine-authority.js';
import { MACHINE_ACTION, type MachineAction } from '../../shared/machine-access-policy.js';
import { USER_STATUS } from '../../shared/user-status.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const KEY = 'machine-execute-matrix-signing-key-at-least-32-bytes';
const tag = hex(3);

interface Actor { userId: string; serverId: string; token: string }
const actors: Record<string, Actor> = {};
let nodeId = '';
let execCalls = 0;
let guiCalls = 0;

const execDispatcher: ExecDispatcher = async () => {
  execCalls += 1;
  return { online: true, result: { ok: true, exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 1 } };
};
const computerUseDispatcher: ComputerUseDispatcher = async () => {
  guiCalls += 1;
  return { online: true, result: { ok: true, content: [{ type: 'text', text: 'ok' }] } as never };
};

async function seedActor(name: string): Promise<Actor> {
  const userId = `u_${name}_${tag}`;
  await createUser(db, userId);
  const token = hex(16);
  const serverId = `s_${name}_${tag}`;
  await createServer(db, serverId, userId, `daemon-${name}`, sha(token));
  actors[name] = { userId, serverId, token };
  return actors[name]!;
}

async function share(target: string, role: 'viewer' | 'participant', options: { exec?: boolean; revoked?: boolean; expired?: boolean } = {}) {
  await db.execute(
    `INSERT INTO server_shares (id, server_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at, exec_granted)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
    [hex(8), nodeId, actors[target]!.userId, role, actors.owner!.userId, Date.now(),
      options.expired ? Date.now() - 1000 : null, options.revoked ? Date.now() : null, options.exec === true],
  );
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

beforeEach(async () => {
  resetMachineActionGateForTests();
  execCalls = 0;
  guiCalls = 0;
});

const NAMES = ['owner', 'pNo', 'pYes', 'viewer', 'gMember', 'gAdmin', 'other', 'revoked', 'expired', 'viewerAndGroup', 'groupAndGrant'] as const;

beforeAll(async () => {
  for (const name of NAMES) await seedActor(name);
  nodeId = `n_${tag}`;
  const nodeToken = hex(16);
  await createServer(db, nodeId, actors.owner!.userId, 'controlled-node', sha(nodeToken), undefined, NODE_ROLE.CONTROLLED);
  await db.execute('UPDATE servers SET exec_enabled = true WHERE id = $1', [nodeId]);
  await share('pNo', 'participant');
  await share('pYes', 'participant', { exec: true });
  await share('viewer', 'viewer');
  await share('revoked', 'participant', { exec: true, revoked: true });
  await share('expired', 'participant', { exec: true, expired: true });
  await share('viewerAndGroup', 'viewer');
  await share('groupAndGrant', 'participant', { exec: true });
  // One group that contains the machine; two ordinary members (one of them an admin of the group) and the two combination users.
  const teamId = `t_${tag}`;
  await db.execute('INSERT INTO teams (id, name, owner_id, created_at) VALUES ($1,$2,$3,$4)', [teamId, 'ops', actors.owner!.userId, Date.now()]);
  for (const [name, role] of [['gMember', 'member'], ['gAdmin', 'admin'], ['viewerAndGroup', 'member'], ['groupAndGrant', 'member']] as const) {
    await db.execute('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4)', [teamId, actors[name]!.userId, role, Date.now()]);
  }
  await db.execute('INSERT INTO machine_groups (server_id, team_id, added_at) VALUES ($1,$2,$3)', [nodeId, teamId, Date.now()]);
});

function execApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { (c as unknown as { env: unknown }).env = { DB: db, JWT_SIGNING_KEY: KEY }; await next(); });
  app.route('/api/machines', machinesRoutes);
  app.route('/api/machine/exec', createMachineExecRoutes(execDispatcher, machineExecAuditIntentStore));
  app.route('/api/machine/computer-use', createMachineComputerUseRoutes(computerUseDispatcher));
  return app;
}

function call(path: string, actor: Actor, body: unknown, headers: Record<string, string> = {}) {
  return execApp().request(`${path}?serverId=${nodeId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Server-Id': actor.serverId, authorization: `Bearer ${actor.token}`, ...headers },
    body: JSON.stringify(body),
  });
}

const EXEC = (actor: Actor, headers?: Record<string, string>) => call('/api/machine/exec', actor, { command: 'echo hi' }, headers);
const SHELL = (actor: Actor, headers?: Record<string, string>) => call('/api/machine/computer-use', actor, { tool: 'shell_session1', arguments: { command: 'whoami' } }, headers);
const CLICK = (actor: Actor, headers?: Record<string, string>) => call('/api/machine/computer-use', actor, { tool: 'click', arguments: { x: 1, y: 2 } }, headers);
const VIEW = (actor: Actor, headers?: Record<string, string>) => call('/api/machine/computer-use', actor, { tool: 'list_apps', arguments: {} }, headers);

async function admits(name: string, action: MachineAction, token?: string): Promise<boolean> {
  const actor = actors[name]!;
  const admission = await admitMachineAction(db, {
    token, signingKey: KEY, authenticatedSourceServerId: actor.serverId, sourceOwnerUserId: actor.userId,
    targetServerId: nodeId, action, now: Date.now(),
  });
  return admission.ok;
}

/** Who may EXECUTE (exec, shell, GUI input, file send / fetch / list): the owner and the explicit participant WITH the grant. */
const MAY_EXECUTE = ['owner', 'pYes', 'groupAndGrant'];
/** Who may merely operate (view-class): every access that is not a viewer / nothing. */
const MAY_VIEW = ['owner', 'pNo', 'pYes', 'gMember', 'gAdmin', 'groupAndGrant'];

describe('role x action matrix (real resolvers, real routes)', () => {
  it.each(NAMES)('%s: exec_remote / shell_session1 / click -> only the owner and an explicit execute grant run', async (name) => {
    const actor = actors[name]!;
    const mayExecute = MAY_EXECUTE.includes(name);
    for (const attempt of [EXEC, SHELL, CLICK]) {
      const before = execCalls + guiCalls;
      const response = await attempt(actor);
      expect(response.status, `${name}`).toBe(mayExecute ? 200 : 403);
      expect(execCalls + guiCalls - before, `${name} reached the node`).toBe(mayExecute ? 1 : 0);
    }
  });

  it.each(NAMES)('%s: read-only computer_use (list_apps) follows operate access', async (name) => {
    const response = await VIEW(actors[name]!);
    expect(response.status, name).toBe(MAY_VIEW.includes(name) ? 200 : 403);
  });

  it.each(NAMES)('%s: file send / fetch / list are execute-class too', async (name) => {
    for (const action of [MACHINE_ACTION.FILE_SEND, MACHINE_ACTION.FILE_FETCH, MACHINE_ACTION.FILE_LIST]) {
      expect(await admits(name, action), `${name} ${action}`).toBe(MAY_EXECUTE.includes(name));
    }
  });

  it.each(NAMES)('%s: list_machines visibility is unchanged', async (name) => {
    const visible = (await listControlledMachines(db, actors[name]!.userId, Date.now())).machines.some((m) => m.serverId === nodeId);
    expect(visible, name).toBe(['owner', 'pNo', 'pYes', 'viewer', 'gMember', 'gAdmin', 'viewerAndGroup', 'groupAndGrant'].includes(name));
  });

  it('the listing tells an actor whether THEY can execute, and a daemon-facing flag follows it', async () => {
    const forMember = (await listControlledMachines(db, actors.gMember!.userId, Date.now())).machines.find((m) => m.serverId === nodeId)!;
    expect(forMember).toMatchObject({ execEnabled: true, canExecute: false, execGranted: false, accessSource: 'group' });
    const forGrantee = (await listControlledMachines(db, actors.pYes!.userId, Date.now())).machines.find((m) => m.serverId === nodeId)!;
    expect(forGrantee).toMatchObject({ canExecute: true, execGranted: true, accessSource: 'share' });
    const forOwner = (await listControlledMachines(db, actors.owner!.userId, Date.now())).machines.find((m) => m.serverId === nodeId)!;
    expect(forOwner).toMatchObject({ canExecute: true, accessSource: 'owner' });
  });

  it('a viewer or a group member who also holds a grant row keeps exactly what that row says (explicit share wins, in both directions)', async () => {
    expect(await admits('viewerAndGroup', MACHINE_ACTION.EXEC)).toBe(false);
    expect(await admits('viewerAndGroup', MACHINE_ACTION.VIEW)).toBe(false);
    expect(await admits('groupAndGrant', MACHINE_ACTION.EXEC)).toBe(true);
  });

  it('the database refuses an execute grant on a viewer row', async () => {
    await expect(db.execute(
      `INSERT INTO server_shares (id, server_id, target_user_id, role, created_by, created_at, updated_at, exec_granted)
       VALUES ($1,$2,$3,'viewer',$4,$5,$5,true)`,
      [hex(8), nodeId, actors.other!.userId, actors.owner!.userId, Date.now()],
    )).rejects.toThrow();
  });
});

describe('only exec_remote is refused on participant-origin turns', () => {
  async function delegatedHeader(participant: string): Promise<Record<string, string>> {
    // The owner's FULL daemon runs a shared session; the participant's message drives it (server-minted, signed turn authority).
    const owner = actors.owner!;
    const sessionName = `deck_proj_${hex(2)}`;
    await db.execute(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, project_dir, state, created_at, updated_at)
       VALUES ($1,$2,$3,'proj','brain','claude-code','/tmp','idle',$4,$4) ON CONFLICT DO NOTHING`,
      [hex(8), owner.serverId, sessionName, Date.now()],
    ).catch(() => undefined);
    await db.execute(
      `INSERT INTO session_shares (id, server_id, session_name, target_user_id, role, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'participant',$5,$6,$6) ON CONFLICT DO NOTHING`,
      [hex(8), owner.serverId, sessionName, actors[participant]!.userId, owner.userId, Date.now()],
    ).catch(() => undefined);
    return {
      [SHARED_MACHINE_AUTHORITY_HEADER]: issueSharedMachineAuthority({
        type: SHARED_MACHINE_AUTHORITY_TYPE, sub: actors[participant]!.userId, sourceServerId: owner.serverId, sessionName,
        projectName: 'proj', shareTarget: { kind: 'main', serverId: owner.serverId, sessionName }, actionId: hex(4),
      } as never, KEY),
    };
  }

  it.each(NAMES)('%s: participant-origin refuses only exec_remote; other actions use the participant grant', async (name) => {
    const headers = await delegatedHeader(name);
    const owner = actors.owner!;
    const before = execCalls;
    expect((await EXEC(owner, headers)).status).toBe(403);
    expect(execCalls).toBe(before);
    for (const attempt of [SHELL, CLICK]) {
      const calls = guiCalls;
      expect((await attempt(owner, headers)).status).toBe(MAY_EXECUTE.includes(name) ? 200 : 403);
      expect(guiCalls - calls).toBe(MAY_EXECUTE.includes(name) ? 1 : 0);
    }
    for (const action of [MACHINE_ACTION.FILE_SEND, MACHINE_ACTION.FILE_FETCH, MACHINE_ACTION.FILE_LIST]) {
      const admission = await admitMachineAction(db, {
        token: headers[SHARED_MACHINE_AUTHORITY_HEADER], signingKey: KEY, authenticatedSourceServerId: owner.serverId,
        sourceOwnerUserId: owner.userId, targetServerId: nodeId, action, now: Date.now(),
      });
      expect(admission.ok, action).toBe(MAY_EXECUTE.includes(name));
    }
  });

  it.each(['pNo', 'pYes', 'gMember'])('%s: daemon list keeps the raw switch for non-EXEC consumers without owner-grant substitution', async (name) => {
    const delegated = await delegatedHeader(name);
    const owner = actors.owner!;
    const projected = (await listControlledMachines(db, owner.userId, Date.now(), actors[name]!.userId)).machines.find((m) => m.serverId === nodeId)!;
    expect(projected).toMatchObject({ execEnabled: true, canExecute: false, accessSource: name === 'gMember' ? 'group' : 'share', execGranted: name === 'pYes' });
    const response = await execApp().request('/api/machines', {
      headers: { 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}`, ...delegated },
    });
    expect(response.status).toBe(200);
    const listed = await response.json();
    expect(listed.machines.find((m: { serverId: string }) => m.serverId === nodeId)).toMatchObject({ execEnabled: true });
    expect(listed.machines.find((m: { serverId: string }) => m.serverId === nodeId)).not.toHaveProperty('canExecute');
  });

  it('a read-only view still follows the participant\'s OWN access (a group member may look, a stranger may not)', async () => {
    expect((await VIEW(actors.owner!, await delegatedHeader('gMember'))).status).toBe(200);
    expect((await VIEW(actors.owner!, await delegatedHeader('other'))).status).toBe(403);
  });

  it('a tampered, foreign-source or replayed-for-another-target token never falls back to the owner', async () => {
    const good = (await delegatedHeader('pYes'))[SHARED_MACHINE_AUTHORITY_HEADER]!;
    const owner = actors.owner!;
    for (const token of [`${good}x`, good.slice(0, -4), 'not-a-token']) {
      const response = await EXEC(owner, { [SHARED_MACHINE_AUTHORITY_HEADER]: token });
      expect(response.status).toBe(403);
    }
    // The same token presented by a DIFFERENT source daemon (another account's) is refused, not honoured.
    expect((await EXEC(actors.pYes!, { [SHARED_MACHINE_AUTHORITY_HEADER]: good })).status).toBe(403);
    expect(execCalls).toBe(0);
  });
});

describe('token rows: another target, a replayed token', () => {
  it('a participant token is not a key to every device: a node the participant cannot reach themselves stays closed (view too)', async () => {
    const otherNode = `n2_${tag}`;
    await createServer(db, otherNode, actors.owner!.userId, 'second-node', sha(hex(8)), undefined, NODE_ROLE.CONTROLLED);
    await db.execute('UPDATE servers SET exec_enabled = true WHERE id = $1', [otherNode]);
    // pNo is a participant on the FIRST node only. Same token, other target:
    const sessionName = `deck_proj_${hex(2)}`;
    await db.execute(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, project_dir, state, created_at, updated_at)
       VALUES ($1,$2,$3,'proj','brain','claude-code','/tmp','idle',$4,$4)`,
      [hex(8), actors.owner!.serverId, sessionName, Date.now()],
    );
    await db.execute(
      `INSERT INTO session_shares (id, server_id, session_name, target_user_id, role, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'participant',$5,$6,$6)`,
      [hex(8), actors.owner!.serverId, sessionName, actors.pNo!.userId, actors.owner!.userId, Date.now()],
    );
    const token = issueSharedMachineAuthority({
      type: SHARED_MACHINE_AUTHORITY_TYPE, sub: actors.pNo!.userId, sourceServerId: actors.owner!.serverId, sessionName,
      projectName: 'proj', shareTarget: { kind: 'main', serverId: actors.owner!.serverId, sessionName }, actionId: hex(4),
    } as never, KEY);
    const headers = { [SHARED_MACHINE_AUTHORITY_HEADER]: token };
    const viewOn = (target: string) => execApp().request(`/api/machine/computer-use?serverId=${target}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': actors.owner!.serverId, authorization: `Bearer ${actors.owner!.token}`, ...headers },
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    });
    expect((await viewOn(nodeId)).status).toBe(200);
    expect((await viewOn(otherNode)).status).toBe(403);

    // A replayed token is only an authenticated context: when the share behind it ends, it stops working on the next action.
    await db.execute('UPDATE session_shares SET revoked_at = $2 WHERE server_id = $1 AND session_name = $3', [actors.owner!.serverId, Date.now(), sessionName]);
    expect((await viewOn(nodeId)).status).toBe(403);
    // Replaying it can never raise authority: it is participant-origin, so exec is refused even before the share ends.
    expect((await EXEC(actors.owner!, headers)).status).toBe(403);
  });
});

describe('the exec switch and the kill switch', () => {
  it('a device with exec off runs nothing for anyone, the owner included, and nothing reaches the node', async () => {
    await db.execute('UPDATE servers SET exec_enabled = false WHERE id = $1', [nodeId]);
    try {
      for (const name of ['owner', 'pYes']) {
        for (const attempt of [EXEC, SHELL, VIEW]) expect((await attempt(actors[name]!)).status).toBe(403);
      }
      expect(execCalls + guiCalls).toBe(0);
    } finally {
      await db.execute('UPDATE servers SET exec_enabled = true WHERE id = $1', [nodeId]);
    }
  });

  it('flipping the switch off between admission and dispatch stops the command (nothing is sent after the switch)', async () => {
    const racing: ExecDispatcher = async () => { execCalls += 1; return { online: true }; };
    const intentStore = {
      ...machineExecAuditIntentStore,
      // The switch is flipped while the durable intent is being written: the last chance to stop a command that was already admitted.
      record: async (database: Database, intent: Parameters<typeof machineExecAuditIntentStore.record>[1]) => {
        await machineExecAuditIntentStore.record(database, intent);
        await database.execute('UPDATE servers SET exec_enabled = false WHERE id = $1', [nodeId]);
      },
    };
    const app = new Hono();
    app.use('*', async (c, next) => { (c as unknown as { env: unknown }).env = { DB: db, JWT_SIGNING_KEY: KEY }; await next(); });
    app.route('/api/machines', machinesRoutes);
  app.route('/api/machine/exec', createMachineExecRoutes(racing, intentStore));
    try {
      const owner = actors.owner!;
      const response = await app.request(`/api/machine/exec?serverId=${nodeId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Server-Id': owner.serverId, authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({ command: 'echo hi' }),
      });
      expect(response.status).toBe(403);
      expect(execCalls).toBe(0);
      const audit = await db.queryOne<{ outcome: string }>(
        `SELECT outcome FROM machine_exec_audit WHERE target_server_id = $1 ORDER BY created_at DESC LIMIT 1`, [nodeId]);
      expect(audit?.outcome).toBe('not_dispatched');
    } finally {
      await db.execute('UPDATE servers SET exec_enabled = true WHERE id = $1', [nodeId]);
    }
  });
});

describe('audit and rate limit', () => {
  it('records refused AND allowed attempts durably: actor, delegated actor, reason, hash and length, never the command', async () => {
    const secretCommand = `echo ${hex(8)}-SECRET`;
    await call('/api/machine/exec', actors.gMember!, { command: secretCommand });
    await call('/api/machine/exec', actors.owner!, { command: secretCommand });
    const rows = await db.query<Record<string, unknown>>(
      `SELECT * FROM machine_exec_audit WHERE target_server_id = $1 AND command_sha256 = $2 ORDER BY created_at`, [nodeId, sha(secretCommand)]);
    expect(rows.map((r) => [r.user_id, r.decision, r.reason ?? null, r.action])).toEqual([
      [actors.gMember!.userId, 'denied', 'execute_not_granted', 'exec'],
      [actors.owner!.userId, 'allowed', null, 'exec'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(Number(rows[0]!.command_length)).toBe(Buffer.byteLength(secretCommand));
    expect(rows[1]!.access_source).toBe('owner');
    expect(rows[0]!.access_source).toBe('group');
  });

  it('rate limits an actor per device with 429 and Retry-After, audits it, and never lets strangers starve the owner', async () => {
    const owner = actors.owner!;
    // A stranger hammering refused requests uses no device budget.
    for (let i = 0; i < 300; i += 1) await EXEC(actors.other!);
    expect((await EXEC(owner)).status).toBe(200);
    // The owner's own runaway loop is limited per actor.
    let limited = 0;
    for (let i = 0; i < 130; i += 1) {
      const response = await EXEC(owner);
      if (response.status === 429) { limited += 1; expect(response.headers.get('retry-after')).toBeTruthy(); }
    }
    expect(limited).toBeGreaterThan(0);
    const audited = await db.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM machine_exec_audit WHERE target_server_id = $1 AND reason = 'rate_limited'`, [nodeId]);
    expect(Number(audited!.n)).toBeGreaterThan(0);
  });
});

// Combined integration boundary: grants do not outlive either account's active status.
describe('active-account admission AND execute admission', () => {
  it.each(['owner', 'pYes'])('%s being disabled denies every machine action despite stored execute grants', async (disabled) => {
    expect((await EXEC(actors.owner!)).status).toBe(200);
    expect((await EXEC(actors.pYes!)).status).toBe(200);
    const before = execCalls + guiCalls;
    await db.execute('UPDATE users SET status = $2 WHERE id = $1', [actors[disabled]!.userId, USER_STATUS.DISABLED]);
    try {
      const names = disabled === 'owner' ? ['owner', 'pYes', 'gMember'] : ['pYes'];
      for (const name of names) {
        for (const attempt of [EXEC, SHELL, CLICK, VIEW]) {
          const response = await attempt(actors[name]!);
          expect(response.status).toBe(name === disabled ? 401 : 403);
        }
        for (const action of [MACHINE_ACTION.FILE_SEND, MACHINE_ACTION.FILE_FETCH, MACHINE_ACTION.FILE_LIST]) {
          expect(await admits(name, action)).toBe(false);
        }
      }
      expect(execCalls + guiCalls).toBe(before);
      // A grantee's disable does not lock out an unrelated active owner.
      if (disabled === 'pYes') expect((await EXEC(actors.owner!)).status).toBe(200);
    } finally {
      await db.execute('UPDATE users SET status = $2 WHERE id = $1', [actors[disabled]!.userId, USER_STATUS.ACTIVE]);
    }
    expect((await EXEC(actors.owner!)).status).toBe(200);
    expect((await EXEC(actors.pYes!)).status).toBe(200);
  });
});
