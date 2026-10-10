import { afterAll, beforeAll, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { createOrUpdateShare } from '../src/db/tab-sharing.js';
import { resolveControlledMachineReadActors } from '../src/share/machine-access.js';
import { WsBridge } from '../src/ws/bridge.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const id = () => randomBytes(8).toString('hex');
class Socket extends EventEmitter {
  readyState = 1; sent: string[] = []; closed = false;
  send(data: string | Buffer, _options?: unknown, callback?: (error?: Error) => void) { if (typeof data === 'string') this.sent.push(data); callback?.(); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.emit('close'); }
}
const wait = async (test: () => boolean) => { const deadline = Date.now() + 2000; while (!test()) { if (Date.now() > deadline) throw Error('metadata_timeout'); await new Promise(r => setTimeout(r, 5)); } };
beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await runMigrations(db); });
afterAll(async () => { await db.close(); });

async function fixture() {
  const owner = `meta-owner-${id()}`, a = `meta-a-${id()}`, b = `meta-b-${id()}`;
  for (const user of [owner, a, b]) await createUser(db, user);
  const sockets: Socket[] = [];
  const nodes = [] as Array<{ serverId: string; bridge: WsBridge; daemon: Socket }>;
  for (let i = 0; i < 2; i++) {
    const serverId = `meta-node-${id()}`, token = id();
    await createServer(db, serverId, owner, 'metadata', createHash('sha256').update(token).digest('hex'), undefined, NODE_ROLE.CONTROLLED);
    const bridge = WsBridge.get(serverId), daemon = new Socket(); sockets.push(daemon);
    bridge.handleDaemonConnection(daemon as never, db, { JWT_SIGNING_KEY: 'metadata-test-only' } as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token })), false);
    await wait(() => bridge.isDaemonConnected());
    // Seed sanitized cached metadata, including a pre-upgrade cache. The controlled
    // wire allowlist intentionally rejects arbitrary daemon.hello; do not weaken it.
    (bridge as unknown as { handleDaemonP2pWorkflowHello(msg: Record<string, unknown>): void })
      .handleDaemonP2pWorkflowHello({ type: 'daemon.hello', daemonId: serverId, capabilities: [], helloEpoch: 1, sentAt: Date.now() });
    // Refresh is genuinely accepted on the controlled-node wire and persisted in PG.
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'controlled_node.worker_refresh_status',
      attemptId: `meta-refresh-${id()}`, phase: 'succeeded', installedVersion: '2026.10.5371-dev.5816',
      targetVersion: '2026.10.5371-dev.5816', artifactSha256: 'a'.repeat(64), recordedAt: Date.now() })), false);
    await wait(() => bridge.getControlledNodeWorkerRefreshStatus() !== null);
    await (bridge as unknown as { controlledNodeWorkerRefreshPersistence: Promise<unknown> }).controlledNodeWorkerRefreshPersistence;
    nodes.push({ serverId, bridge, daemon });
  }
  const share = async (node: typeof nodes[number], actor: string, expiresAt: number | null = null) => {
    return createOrUpdateShare(db, { id: `share_${id()}`, target: { kind: 'server', serverId: node.serverId }, targetUserId: actor,
      role: 'participant', createdBy: owner, expiresAt, now: Date.now() });
  };
  for (const node of nodes) for (const actor of [a, b]) await share(node, actor);
  const connect = (node: typeof nodes[number], actor: string) => {
    const socket = new Socket(); sockets.push(socket);
    node.bridge.handleBrowserConnection(socket as never, actor, db, false, true); return socket;
  };
  const broadcast = (node: typeof nodes[number], type: string) => {
    (node.bridge as unknown as { broadcastToBrowsers(json: string): void }).broadcastToBrowsers(JSON.stringify({ type, metadataFixture: true }));
  };
  return { owner, a, b, nodes, share, connect, broadcast, cleanup: () => sockets.forEach(socket => socket.close()) };
}

it('revocation fences hello/refresh/upgrade broadcasts, preserves other actors/nodes and refuses cached reconnect', async () => {
  const t = await fixture(); const [n, other] = t.nodes;
  const a = t.connect(n!, t.a), b = t.connect(n!, t.b), owner = t.connect(n!, t.owner), otherA = t.connect(other!, t.a);
  try {
    await n!.bridge.revalidateShareSocketsForUser(t.a); await other!.bridge.revalidateShareSocketsForUser(t.a);
    expect(a.sent.some(raw => JSON.parse(raw).type === 'daemon.hello')).toBe(true);
    expect(a.sent.some(raw => JSON.parse(raw).type === 'controlled_node.worker_refresh_status')).toBe(true);
    a.sent = []; b.sent = []; owner.sent = []; otherA.sent = [];
    await db.execute('UPDATE server_shares SET revoked_at = $3 WHERE server_id = $1 AND target_user_id = $2', [n!.serverId, t.a, Date.now()]);
    // No revoke notification needed: every publisher reads current node permission itself.
    for (const type of ['daemon.hello', 'controlled_node.worker_refresh_status', 'daemon.upgrade_status']) t.broadcast(n!, type);
    await n!.bridge.revalidateShareSocketsForUser(t.a);
    expect(a.sent).toEqual([]); expect(a.closed).toBe(true);
    expect(b.closed).toBe(false); expect(owner.closed).toBe(false);
    expect(b.sent).toHaveLength(3); expect(owner.sent).toHaveLength(3);
    t.broadcast(other!, 'daemon.hello'); await other!.bridge.revalidateShareSocketsForUser(t.a);
    expect(otherA.closed).toBe(false); expect(otherA.sent).toHaveLength(1);
    const reconnect = t.connect(n!, t.a); await n!.bridge.revalidateShareSocketsForUser(t.a);
    expect(reconnect.closed).toBe(true); expect(reconnect.sent).toEqual([]);
    await t.share(n!, t.a);
    const restored = t.connect(n!, t.a); await n!.bridge.revalidateShareSocketsForUser(t.a);
    expect(restored.closed).toBe(false); expect(restored.sent.some(raw => JSON.parse(raw).type === 'daemon.hello')).toBe(true);
  } finally { t.cleanup(); }
});

it('expiry sweep closes only lost read coverage, but a renewed direct share and revoked execute grant preserve reads', async () => {
  const t = await fixture(); const n = t.nodes[0]!;
  const a = t.connect(n, t.a), b = t.connect(n, t.b);
  try {
    await n.bridge.revalidateShareSocketsForUser(t.a);
    await db.execute('UPDATE server_shares SET expires_at = $3 WHERE server_id = $1 AND target_user_id = $2', [n.serverId, t.a, Date.now() - 1]);
    await db.execute('UPDATE server_shares SET exec_granted = false WHERE server_id = $1 AND target_user_id = $2', [n.serverId, t.b]);
    await n.bridge.sweepShareSocketsForTests();
    expect(a.closed).toBe(true); expect(b.closed).toBe(false);
    await t.share(n, t.a, Date.now() + 60000);
    const renewed = t.connect(n, t.a); await n.bridge.sweepShareSocketsForTests();
    expect(renewed.closed).toBe(false);
    t.broadcast(n, 'daemon.hello'); await n.bridge.revalidateShareSocketsForUser(t.b);
    expect(b.closed).toBe(false); expect(renewed.closed).toBe(false);
  } finally { t.cleanup(); }
});

it('unknown authority closes controlled metadata subscriptions but ordinary FULL delivery remains synchronous', async () => {
  const t = await fixture(); const n = t.nodes[0]!;
  const a = t.connect(n, t.a);
  const fullId = `meta-full-${id()}`; await createServer(db, fullId, t.owner, 'full', 'a'.repeat(64));
  const full = WsBridge.get(fullId), owner = new Socket();
  full.handleBrowserConnection(owner as never, t.owner, db);
  try {
    await n.bridge.revalidateShareSocketsForUser(t.a); a.sent = [];
    (n.bridge as unknown as { db: Database | null }).db = null;
    t.broadcast(n, 'daemon.hello'); await n.bridge.revalidateShareSocketsForUser(t.a);
    expect(a.sent).toEqual([]); expect(a.closed).toBe(true);
    (full as unknown as { broadcastToBrowsers(json: string): void }).broadcastToBrowsers('{"type":"daemon.hello","full":true}');
    expect(owner.closed).toBe(false); expect(JSON.parse(owner.sent.at(-1)!)).toMatchObject({ full: true });
  } finally { owner.close(); t.cleanup(); }
});

it('batched read permission denies group/viewer/disabled/revoked nodes without borrowing owner identity (200-actor cost)', async () => {
  const t = await fixture(); const n = t.nodes[0]!;
  try {
    const groupOnly = `meta-group-${id()}`, team = `meta-team-${id()}`;
    await createUser(db, groupOnly);
    await db.execute('INSERT INTO teams (id,name,owner_id,plan,created_at) VALUES ($1,$2,$3,$4,$5)', [team, 'metadata', t.owner, 'free', Date.now()]);
    for (const actor of [t.owner, groupOnly]) await db.execute('INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [team, actor, actor === t.owner ? 'owner' : 'member', Date.now()]);
    await db.execute('INSERT INTO machine_groups (server_id,team_id,added_at) VALUES ($1,$2,$3)', [n.serverId, team, Date.now()]);
    expect(await resolveControlledMachineReadActors(db, n.serverId, [groupOnly], Date.now())).toEqual(new Set());
    const actors = [t.owner, t.a, t.b];
    for (let i = 0; i < 197; i++) { const user = `meta-scale-${id()}`; await createUser(db, user); await t.share(n, user); actors.push(user); }
    const start = performance.now(); const allowed = await resolveControlledMachineReadActors(db, n.serverId, actors, Date.now());
    console.log(JSON.stringify({ controlledReadActors: actors.length, lookupMs: performance.now() - start }));
    expect(allowed.size).toBe(200);
    await db.execute('UPDATE server_shares SET role = $3 WHERE server_id = $1 AND target_user_id = $2', [n.serverId, t.a, 'viewer']);
    await db.execute('UPDATE users SET status = $2 WHERE id = $1', [t.b, 'disabled']);
    expect(await resolveControlledMachineReadActors(db, n.serverId, [t.owner, t.a, t.b, 'unknown'], Date.now())).toEqual(new Set([t.owner]));
    await db.execute('UPDATE servers SET revoked_at = $2 WHERE id = $1', [n.serverId, Date.now()]);
    expect(await resolveControlledMachineReadActors(db, n.serverId, actors, Date.now())).toEqual(new Set());
  } finally { t.cleanup(); }
});

it('revoking another source share does not remove still-valid direct node read coverage', async () => {
  const t = await fixture(), n = t.nodes[0]!;
  const source = `meta-source-${id()}`;
  await createServer(db, source, t.owner, 'full', 'b'.repeat(64));
  await createOrUpdateShare(db, { id: `share_${id()}`, target: { kind: 'server', serverId: source }, targetUserId: t.a,
    role: 'participant', createdBy: t.owner, expiresAt: null, now: Date.now() });
  const a = t.connect(n, t.a);
  try {
    await n.bridge.revalidateShareSocketsForUser(t.a); a.sent = [];
    await db.execute('UPDATE server_shares SET revoked_at=$3 WHERE server_id=$1 AND target_user_id=$2', [source, t.a, Date.now()]);
    await n.bridge.revalidateShareSocketsForUser(t.a);
    t.broadcast(n, 'daemon.upgrade_status'); await n.bridge.revalidateShareSocketsForUser(t.a);
    expect(a.closed).toBe(false); expect(a.sent).toHaveLength(1);
  } finally { t.cleanup(); }
});
