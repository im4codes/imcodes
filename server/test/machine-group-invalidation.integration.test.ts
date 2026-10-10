import { beforeAll, afterAll, it, expect } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { signJwt } from '../src/security/crypto.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { REMOTE_DESKTOP_CAPABILITY, REMOTE_DESKTOP_MSG, REMOTE_DESKTOP_PROTOCOL_VERSION, REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import { ControlledBrowserReadGate } from '../src/ws/controlled-browser-read-gate.js';
import { ensureCanonicalHostForServer } from '../src/services/remote-desktop-host-identity.js';
import { GROUP_TEST_IPC as IPC } from './fixtures/machine-group-invalidation-control.js';
import { MACHINE_GROUP_INVALIDATION as POLICY } from '../../shared/machine-group-invalidation.js';
import { MachineGroupInvalidationRuntime, mutateMachineGroupAccess, MachineGroupRevalidationPending, machineGroupInvalidationReady, machineGroupInvalidationRevision } from '../src/services/machine-group-invalidation.js';

let db: Database;
const children: ChildProcess[] = [];
const sockets: WebSocket[] = [];
const daemonFrames = new WeakMap<WebSocket, Record<string,unknown>[]>();
const key = randomBytes(32).toString('hex');
const id = () => randomUUID();
const wait = async (fn: () => boolean | Promise<boolean>, ms = 6000) => {
  const end = Date.now() + ms;
  while (!await fn()) { if (Date.now() > end) throw new Error('condition_timeout'); await new Promise(r => setTimeout(r, 10)); }
};
const ipc = (child: ChildProcess, type: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', receive); reject(new Error('ipc_timeout')); }, 6000);
  function receive(message: Record<string, unknown>) { if (message.type === type) { clearTimeout(timer); child.off('message', receive); resolve(message); } }
  child.on('message', receive);
});
beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await runMigrations(db); });
afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null) return;
    const stopped = new Promise<void>(r => child.once('exit', () => r())); child.send({ type: IPC.STOP });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer);
  }));
  await db.close();
});
async function pod(listen = true) {
  const child = fork(fileURLToPath(new URL('./fixtures/machine-group-invalidation-process.ts', import.meta.url)), [], {
    execPath: process.execPath,
    execArgv: ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))],
    env: { ...process.env, IMCODES_REMOTE_DESKTOP_ENABLED: '1', TEST_GROUP_KEY: key, TEST_GROUP_LISTEN: listen ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child); child.stderr!.on('data', (chunk) => process.stderr.write(chunk));
  child.stdout!.on('data', (chunk) => process.stderr.write(chunk));
  const ready = await ipc(child, IPC.READY);
  return { child, url: `http://127.0.0.1:${ready.port}`, receiverId: ready.receiverId as string };
}
const auth = (user: string) => ({ authorization: `Bearer ${signJwt({ sub: user, type: 'web' }, key, 3600)}`, 'content-type': 'application/json' });
async function fixture() {
  const owner = id(), actor = id(), other = id(), team = id(), second = id();
  for (const user of [owner, actor, other]) await createUser(db, user);
  for (const group of [team, second]) {
    await db.execute('INSERT INTO teams(id,name,owner_id,plan,created_at) VALUES($1,$2,$3,$4,$5)', [group, 'test', owner, 'free', Date.now()]);
    for (const user of [owner, actor, other]) await db.execute('INSERT INTO team_members(team_id,user_id,role,joined_at) VALUES($1,$2,$3,$4)', [group, user, user === owner ? 'owner' : 'member', Date.now()]);
  }
  const nodes = [];
  for (let i = 0; i < 2; i++) {
    const server = id(), token = randomBytes(24).toString('hex');
    await createServer(db, server, owner, 'node', createHash('sha256').update(token).digest('hex'), undefined, NODE_ROLE.CONTROLLED);
    await db.execute("UPDATE servers SET os='win',exec_enabled=true WHERE id=$1", [server]);
    await ensureCanonicalHostForServer({db,serverId:server,now:Date.now()});
    await db.execute('INSERT INTO machine_groups(server_id,team_id,added_at) VALUES($1,$2,$3)', [server, team, Date.now()]);
    nodes.push({ server, token });
  }
  return { owner, actor, other, team, second, nodes };
}
async function daemon(url: string, serverId: string, token: string) {
  const ws = new WebSocket(url.replace('http', 'ws') + `/api/server/${serverId}/ws`); sockets.push(ws);
  const frames=[] as Record<string,unknown>[]; daemonFrames.set(ws,frames); ws.on('message',raw=>frames.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve,reject) => { ws.once('open',resolve); ws.once('error',reject); });
  ws.send(JSON.stringify({ type: 'auth', serverId, token, capabilities:[REMOTE_DESKTOP_CAPABILITY] }));
  await new Promise(r => setTimeout(r, 60));
  refresh(ws, 'initial-refresh');
  await wait(async () => (await db.queryOne<{controlled_worker_refresh_attempt_id:string}>(
    'SELECT controlled_worker_refresh_attempt_id FROM servers WHERE id=$1', [serverId]))?.controlled_worker_refresh_attempt_id != null);
  return ws;
}
async function browser(url: string, serverId: string, user: string) {
  const response = await fetch(url+'/api/auth/ws-ticket', { method:'POST', headers:auth(user), body:JSON.stringify({serverId}) });
  expect(response.status).toBe(200); const ticket = (await response.json() as {ticket:string}).ticket;
  const ws = new WebSocket(url.replace('http','ws')+`/api/server/${serverId}/ws?ticket=${encodeURIComponent(ticket)}`, { origin:'http://127.0.0.1' }); sockets.push(ws);
  const frames: Record<string,unknown>[] = []; let closed = false;
  ws.on('message', raw => frames.push(JSON.parse(String(raw)))); ws.on('close', () => closed=true);
  await new Promise<void>((resolve,reject) => { ws.once('open',resolve); ws.once('error',reject); });
  await wait(() => frames.some(f => f.type===DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS));
  return { ws, frames, isClosed: () => closed };
}
const refresh = (ws: WebSocket, marker: string) => ws.send(JSON.stringify({ type:DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS,
  attemptId:marker, phase:'succeeded', installedVersion:'2026.10.5371-dev.5816', targetVersion:'2026.10.5371-dev.5816', artifactSha256:'a'.repeat(64), recordedAt:Date.now() }));
async function desktop(reader: Awaited<ReturnType<typeof browser>>) {
  reader.ws.send(JSON.stringify({type:REMOTE_DESKTOP_MSG.START, protocolVersion:REMOTE_DESKTOP_PROTOCOL_VERSION, requestId:id()}));
  await wait(() => reader.frames.some(f=>f.type===REMOTE_DESKTOP_MSG.AUTHORIZED||f.type===REMOTE_DESKTOP_MSG.ERROR));
  if (!reader.frames.some(f=>f.type===REMOTE_DESKTOP_MSG.AUTHORIZED)) console.error(reader.frames.filter(f=>f.type===REMOTE_DESKTOP_MSG.ERROR));
  expect(reader.frames.find(f=>f.type===REMOTE_DESKTOP_MSG.AUTHORIZED)).toMatchObject({mode:REMOTE_DESKTOP_ACCESS_MODE.VIEW});
}

it('partial additive migration retries retain existing multi-owner event IDs while another connection writes', async () => {
  const sql = await readFile(new URL('../src/db/migrations/102_machine_group_invalidation.sql', import.meta.url), 'utf8');
  const schema = `imcodes_test_group_${id().replaceAll('-', '')}`;
  const scoped = async (work: (tx: Database) => Promise<void>) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL search_path TO ${schema}`); await work(tx);
  });
  await db.exec(`CREATE SCHEMA ${schema}`);
  try {
    await scoped(async tx => {
      await tx.exec(sql.slice(0, sql.indexOf('CREATE INDEX'))); // Partial DDL: tables exist, index has not completed.
      await tx.execute('INSERT INTO machine_group_invalidation_receivers VALUES($1,$2),($3,$2)', ['existing-owner-a', Date.now()+POLICY.RECEIVER_LEASE_MS, 'existing-owner-b']);
      await tx.execute('INSERT INTO machine_group_invalidations(id,created_at,actor_id,recipients,acknowledgements) VALUES($1,$2,$3,$4,$5)',
        ['existing-event', Date.now(), 'existing-actor', ['existing-owner-a','existing-owner-b'], ['existing-owner-a']]);
    });
    await Promise.all([
      scoped(async tx => { await tx.exec(sql); await tx.exec(sql); }),
      scoped(async tx => { for (let n=0;n<12;n++) await tx.execute('INSERT INTO machine_group_invalidations(id,created_at,recipients) VALUES($1,$2,$3)', [`writer-${n}`,Date.now(),['existing-owner-b']]); }),
    ]);
    await scoped(async tx => {
      const row = await tx.queryOne<{actor_id:string;recipients:string[];acknowledgements:string[]}>('SELECT * FROM machine_group_invalidations WHERE id=$1',['existing-event']);
      expect(row).toMatchObject({actor_id:'existing-actor',recipients:['existing-owner-a','existing-owner-b'],acknowledgements:['existing-owner-a']});
      expect((await tx.queryOne<{n:number}>('SELECT count(*)::int AS n FROM machine_group_invalidations'))?.n).toBe(13);
      expect((await tx.queryOne<{n:number}>('SELECT count(*)::int AS n FROM machine_group_invalidation_receivers'))?.n).toBe(2);
    });
  } finally { await db.exec(`DROP SCHEMA ${schema} CASCADE`); } // Only this test's exact generated schema.
});

it('third pod waits for both actual node pods to fence in-flight old SQL; final group removal closes only lost live reads', async () => {
  const t = await fixture(); const pods = [await pod(), await pod(false)]; const publisher = await pod();
  const ds = [], readers = [], owners = [], others = [];
  for (let i=0;i<2;i++) { const n=t.nodes[i]!, p=pods[i]!; ds.push(await daemon(p.url,n.server,n.token)); readers.push(await browser(p.url,n.server,t.actor)); owners.push(await browser(p.url,n.server,t.owner)); others.push(await browser(p.url,n.server,t.other)); await desktop(readers[i]!); }
  for(let i=0;i<2;i++) { const p=pods[i]!; const armed=ipc(p.child,IPC.ARM); p.child.send({type:IPC.ARM,actor:t.actor}); await armed; const held=ipc(p.child,IPC.HELD); refresh(ds[i]!,`stale-refresh-${i}`); await held; }
  let finished=false;
  const responsePromise=fetch(publisher.url+`/api/team/${t.team}/member/${t.actor}`,{method:'DELETE',headers:auth(t.owner)}).then(r=>{finished=true;return r;});
  await wait(async()=>!(await db.queryOne('SELECT user_id FROM team_members WHERE team_id=$1 AND user_id=$2',[t.team,t.actor])));
  await new Promise(r=>setTimeout(r,100)); expect(finished).toBe(false);
  for(const p of pods) p.child.send({type:IPC.RELEASE});
  expect((await responsePromise).status).toBe(200);
  for(let i=0;i<2;i++) { await wait(readers[i]!.isClosed); expect(readers[i]!.frames.some(f=>String(f.attemptId).startsWith('stale-'))).toBe(false); expect(owners[i]!.isClosed()).toBe(false); expect(others[i]!.isClosed()).toBe(false); }
  // Metadata closes the socket synchronously; the actual desktop STOP must still reach each node before its receipt.
  for (const node of ds) await wait(()=>daemonFrames.get(node)!.some(f=>f.type===REMOTE_DESKTOP_MSG.STOP));
  const pending=await db.queryOne<{n:number}>('SELECT count(*)::int AS n FROM machine_group_invalidations WHERE NOT recipients <@ acknowledgements'); expect(pending?.n).toBe(0);
},30000);

it('association mutation on a non-owning pod preserves other group/direct coverage; no LISTEN still recovers via durable poll', async () => {
  const t=await fixture(); const a=await pod(false), b=await pod(), publisher=await pod();
  await wait(async () => Boolean(await db.queryOne('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[`${POLICY.LISTENER_APPLICATION_PREFIX}${b.receiverId}`])));
  const listener = await db.queryOne<{pid:number}>('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[`${POLICY.LISTENER_APPLICATION_PREFIX}${b.receiverId}`]);
  // Kill only this task pod's dedicated LISTEN connection; other pools/pods and users are untouched.
  expect((await db.queryOne<{stopped:boolean}>('SELECT pg_terminate_backend($1) AS stopped',[listener!.pid]))?.stopped).toBe(true);
  await db.execute('INSERT INTO machine_groups(server_id,team_id,added_at) VALUES($1,$2,$3)',[t.nodes[1]!.server,t.second,Date.now()]);
  const ds=[] as WebSocket[];
  for(const [p,n] of [[a,t.nodes[0]!],[b,t.nodes[1]!]] as const) ds.push(await daemon(p.url,n.server,n.token));
  const first=await browser(a.url,t.nodes[0]!.server,t.actor), second=await browser(b.url,t.nodes[1]!.server,t.actor);
  await desktop(first); await desktop(second);
  const role=await fetch(publisher.url+`/api/team/${t.team}/member/${t.actor}/role`,{method:'PUT',headers:auth(t.owner),body:JSON.stringify({role:'admin'})});
  expect(role.status).toBe(200); expect(first.isClosed()).toBe(false); expect(second.isClosed()).toBe(false);
  const removed=await fetch(publisher.url+`/api/team/${t.team}/member/${t.actor}`,{method:'DELETE',headers:auth(t.owner)}); expect(removed.status).toBe(200);
  await wait(first.isClosed); expect(second.isClosed()).toBe(false);
  await wait(()=>daemonFrames.get(ds[0]!)!.some(f=>f.type===REMOTE_DESKTOP_MSG.STOP));
  expect(daemonFrames.get(ds[1]!)!.some(f=>f.type===REMOTE_DESKTOP_MSG.STOP)).toBe(false);
  await wait(async () => Boolean(await db.queryOne('SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND pid<>$2',[`${POLICY.LISTENER_APPLICATION_PREFIX}${b.receiverId}`,listener!.pid])));
  const detached=await fetch(publisher.url+`/api/machines/desk-binding?serverId=${t.nodes[1]!.server}`,{method:'POST',headers:auth(t.owner),body:JSON.stringify({teamId:t.second,member:false})}); expect(detached.status).toBe(200); await wait(second.isClosed);
  await wait(()=>daemonFrames.get(ds[1]!)!.some(f=>f.type===REMOTE_DESKTOP_MSG.STOP));
  // Expired/removed membership does not delete an independent direct grant.
  await db.execute('INSERT INTO server_shares(id,server_id,target_user_id,role,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[id(),t.nodes[0]!.server,t.actor,'participant',t.owner,Date.now()]);
  const restored=await browser(a.url,t.nodes[0]!.server,t.actor);
  expect((await fetch(publisher.url+`/api/machines/desk-binding?serverId=${t.nodes[0]!.server}`,{method:'POST',headers:auth(t.owner),body:JSON.stringify({teamId:t.team,member:false})})).status).toBe(200); expect(restored.isClosed()).toBe(false);
},30000);

it('mutation rollback leaves grants/epoch/events unchanged; concurrent writers commit separate durable revisions', async () => {
  const t=await fixture();const scope={teamId:t.team,actorId:t.actor};
  const runtime=new MachineGroupInvalidationRuntime(db,async()=>{},()=>{});await runtime.start();
  const before=await machineGroupInvalidationRevision(db);
  try {
    await expect(mutateMachineGroupAccess(db,scope,async tx=>{
      await tx.execute('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[t.team,t.actor]);
      throw new Error('task-injected-mutation-failure');
    },async()=>{})).rejects.toThrow('task-injected-mutation-failure');
    expect(await machineGroupInvalidationRevision(db)).toBe(before);
    expect(await db.queryOne('SELECT user_id FROM team_members WHERE team_id=$1 AND user_id=$2',[t.team,t.actor])).not.toBeNull();
    expect((await db.queryOne<{n:number}>('SELECT count(*)::int AS n FROM machine_group_invalidations WHERE team_id=$1',[t.team]))?.n).toBe(0);
    await Promise.all([t.actor,t.other].map(actor=>mutateMachineGroupAccess(db,{teamId:t.team,actorId:actor},
      async tx=>{await tx.execute("UPDATE team_members SET role='admin' WHERE team_id=$1 AND user_id=$2",[t.team,actor]);},async()=>{})));
    expect(await machineGroupInvalidationRevision(db)).toBe(before+2);
    expect((await db.queryOne<{n:number}>('SELECT count(*)::int AS n FROM machine_group_invalidations WHERE team_id=$1 AND recipients <@ acknowledgements',[t.team]))?.n).toBe(2);
  } finally { await runtime.stop(); }
},10000);

it('a missing fleet receipt is applied/pending within the deadline, never a fake successful revocation', async () => {
  const receiver=id(), event=id();
  await db.execute('INSERT INTO machine_group_invalidation_receivers(id,expires_at) VALUES($1,$2)',[receiver,Date.now()+20000]);
  expect(await db.queryOne('SELECT id FROM machine_group_invalidation_receivers WHERE id=$1',[receiver])).not.toBeNull();
  const runtime=new MachineGroupInvalidationRuntime(db,async()=>{},()=>{}); await runtime.start();
  try {
    const mutation=mutateMachineGroupAccess(db,{serverId:event},async(tx)=>{await tx.query('SELECT 1');},async()=>{});
    const started = performance.now();
    await expect(mutation).rejects.toBeInstanceOf(MachineGroupRevalidationPending);
    expect(performance.now()-started).toBeLessThan(POLICY.WAIT_TIMEOUT_MS+1000);
    const row=await db.queryOne<{recipients:string[];acknowledgements:string[]}>('SELECT recipients,acknowledgements FROM machine_group_invalidations WHERE server_id=$1',[event]);
    expect(row?.recipients).toContain(receiver);expect(row?.acknowledgements).not.toContain(receiver);
  } finally { await runtime.stop();await db.execute('DELETE FROM machine_group_invalidation_receivers WHERE id=$1',[receiver]);await db.execute('DELETE FROM machine_group_invalidations WHERE server_id=$1',[event]); }
},15000);

it('200-actor metadata publication is one bounded live batch plus two constant-time revision reads', async () => {
  const t=await fixture(); const users=Array.from({length:200},id);
  for (const user of users) await createUser(db,user);
  await db.execute("INSERT INTO team_members(team_id,user_id,role,joined_at) SELECT $1,unnest($2::text[]),'member',$3",[t.team,users,Date.now()]);
  const runtime=new MachineGroupInvalidationRuntime(db,async()=>{},()=>{});await runtime.start();
  let sends=0; const readers=[] as WebSocket[];
  const gate=new ControlledBrowserReadGate(t.nodes[0]!.server,()=>db,ws=>gate.remove(ws),()=>machineGroupInvalidationReady(db),()=>machineGroupInvalidationRevision(db));
  for (const user of users) { const ws={readyState:1,send:()=>sends++} as unknown as WebSocket; readers.push(ws); gate.register(ws,user); }
  try {
    const started=performance.now(); gate.broadcast('bounded-production-shaped-metadata');
    await wait(()=>sends===200,2000);const durationMs=performance.now()-started;
    expect(durationMs).toBeLessThan(2000);console.log(JSON.stringify({metric:'fleet_revision_metadata_200',durationMs,actors:200,readQueriesPerPacket:3}));
  } finally { readers.forEach(ws=>gate.remove(ws));await runtime.stop(); }
});

it('failed receiver revalidation never acknowledges early; durable retry recovers and stop cannot become embedded allow', async () => {
  let attempts=0, fences=0;
  const scope={serverId:id()};
  const runtime=new MachineGroupInvalidationRuntime(db,async()=>{ if (++attempts===1) throw new Error('task-injected-revalidation-outage'); },()=>{fences++;});
  await runtime.start();
  try {
    await mutateMachineGroupAccess(db,scope,async tx=>{await tx.query('SELECT 1');},async()=>{});
    expect(attempts).toBe(2);expect(fences).toBeGreaterThan(0);expect(machineGroupInvalidationReady(db)).toBe(true);
    const row=await db.queryOne<{complete:boolean}>('SELECT recipients <@ acknowledgements AS complete FROM machine_group_invalidations WHERE server_id=$1',[scope.serverId]);
    expect(row?.complete).toBe(true);
  } finally { await runtime.stop(); }
  expect(machineGroupInvalidationReady(db)).toBe(false);
},10000);
