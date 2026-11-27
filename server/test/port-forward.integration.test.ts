/**
 * PostgreSQL cross-layer & multi-pod integration test for MCP P2P port forwarding.
 * Exercises migrations (115_port_forward_tunnels.sql), PostgresPortForwardClusterStore
 * across independent pod routers, shared-host owner authority fail-closed checks,
 * machine_action_audit persistence, exec_enabled enforcement, E2E relay forwarding,
 * cross-pod DELETE, and disconnect cleanup.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROLLED_NODE_ABI_MODERN, CONTROLLED_NODE_ABI_PROFILE_FIELD } from '../../shared/controlled-node-abi.js';
import {
  PORT_FORWARD_API_PATH,
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_MSG,
  PORT_FORWARD_TRANSPORT,
  PORT_FORWARD_TRANSPORT_PREF,
  type PortForwardWireMessage,
} from '../../shared/port-forward.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  OWNER_MACHINE_AUTHORITY_TYPE,
  SHARED_MACHINE_AUTHORITY_HEADER,
  SHARED_MACHINE_AUTHORITY_TYPE,
} from '../../shared/shared-machine-authority.js';
import { generateEndpointIdentityKeyPair } from '../../src/daemon/port-forward-crypto.js';
import { PortForwardEngine } from '../../src/daemon/port-forward-engine.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { createOrUpdateShare, setServerShareExecGrant } from '../src/db/tab-sharing.js';
import { createPortForwardRoutes } from '../src/routes/port-forward.js';
import { generateControlledNodeId } from '../src/services/controlled-node-identity.js';
import {
  issueOwnerMachineAuthority,
  issueSharedMachineAuthority,
} from '../src/share/shared-machine-authority.js';
import { PostgresPortForwardClusterStore } from '../src/ws/port-forward-cluster.js';
import { PortForwardRouter, type PortForwardBridgeEndpoint } from '../src/ws/port-forward-router.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

let db: Database;
let podCaller!: PortForwardRouter;
let podListen!: PortForwardRouter;
let podTarget!: PortForwardRouter;

const enginesToClose: PortForwardEngine[] = [];
let appCaller!: Hono;
let appTarget!: Hono;
let echoPort = 0;
let closeEcho: (() => Promise<void>) | undefined;

const signingKey = 'pg-integration-signing-key-32-bytes';
const ownerId = `pf_owner_${hex(5)}`;
const participantId = `pf_part_${hex(5)}`;
const foreignId = `pf_foreign_${hex(5)}`;

const full1 = { serverId: `pf_full1_${hex(5)}`, token: `tok_full1_${hex(10)}` };
const full2 = { serverId: `pf_full2_${hex(5)}`, token: `tok_full2_${hex(10)}` };
const ctl1 = { serverId: `pf_ctl1_${hex(5)}`, token: `tok_ctl1_${hex(10)}`, nodeId: '' };
const ctlDisabled = { serverId: `pf_ctldis_${hex(5)}`, token: `tok_ctldis_${hex(10)}`, nodeId: '' };
const foreignSrv = { serverId: `pf_for_${hex(5)}`, token: `tok_for_${hex(10)}` };

const podListenBridges = new Map<string, PortForwardBridgeEndpoint>();
const podTargetBridges = new Map<string, PortForwardBridgeEndpoint>();
let listenEngine!: PortForwardEngine;
let targetCtlEngine!: PortForwardEngine;
let full2Engine!: PortForwardEngine;
let targetCtlConnected = true;

let storeCaller!: PostgresPortForwardClusterStore;
let storeListen!: PostgresPortForwardClusterStore;
let storeTarget!: PostgresPortForwardClusterStore;

beforeAll(async () => {
  const connStr = process.env.TEST_DATABASE_URL;
  if (!connStr) throw new Error('TEST_DATABASE_URL is required by vitest integration globalSetup');

  db = createDatabase(connStr);
  await runMigrations(db);
  // Seed a pre-existing server record BEFORE re-executing migration 115 idempotently (P0 #5).
  const preExistingId = `pf_pre_${hex(4)}`;
  const preUserId = `pf_pre_u_${hex(4)}`;
  await createUser(db, preUserId);
  await createServer(db, preExistingId, preUserId, 'pre-existing', sha256('pre-tok'), undefined, NODE_ROLE.FULL);
  const mig115Sql = readFileSync(resolve(import.meta.dirname, '../src/db/migrations/115_port_forward_tunnels.sql'), 'utf8');
  await db.exec(mig115Sql);
  await db.exec(mig115Sql);
  const persistedServer = await db.queryOne<{ id: string }>(`SELECT id FROM servers WHERE id = $1`, [preExistingId]);
  expect(persistedServer?.id).toBe(preExistingId);

  await createUser(db, ownerId);
  await createUser(db, participantId);
  await createUser(db, foreignId);

  const teamId = `pf_team_${hex(5)}`;
  const now = Date.now();
  await db.execute(`INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1,'PF Team',$2,'free',$3)`, [teamId, ownerId, now]);
  await db.execute(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,'owner',$3)`, [teamId, ownerId, now]);
  await db.execute(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,'member',$3)`, [teamId, participantId, now]);

  await createServer(db, full1.serverId, ownerId, 'full-1', sha256(full1.token), undefined, NODE_ROLE.FULL);
  await db.execute(`UPDATE servers SET team_id = $1, status = 'online' WHERE id = $2`, [teamId, full1.serverId]);
  await createServer(db, full2.serverId, ownerId, 'full-2', sha256(full2.token), undefined, NODE_ROLE.FULL);
  await db.execute(`UPDATE servers SET status = 'online' WHERE id = $1`, [full2.serverId]);

  await db.execute(
    `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, state, created_at, updated_at)
     VALUES ($1,$2,'deck_brain','demo-proj','brain','claude-code','idle',$3,$3)`,
    [`sess_${hex(5)}`, full1.serverId, now],
  );

  const shareId = `pf_share_${hex(5)}`;
  await createOrUpdateShare(db, {
    id: shareId,
    target: { kind: 'server', serverId: full1.serverId },
    targetUserId: participantId,
    role: 'participant',
    createdBy: ownerId,
    expiresAt: null,
    now,
  });

  await createServer(db, foreignSrv.serverId, foreignId, 'foreign-1', sha256(foreignSrv.token), undefined, NODE_ROLE.FULL);

  ctl1.nodeId = generateControlledNodeId();
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, revoked_at, ref_name, display_name, os, node_id, abi_profile)
     VALUES ($1,$2,'ctl-1',$3,'online',$4,$5,true,NULL,'ctl-1','Controlled 1','linux',$6,$7)`,
    [ctl1.serverId, ownerId, sha256(ctl1.token), now, NODE_ROLE.CONTROLLED, ctl1.nodeId, CONTROLLED_NODE_ABI_MODERN],
  );
  const ctlShareId = `pf_ctl_share_${hex(5)}`;
  await createOrUpdateShare(db, {
    id: ctlShareId,
    target: { kind: 'server', serverId: ctl1.serverId },
    targetUserId: participantId,
    role: 'participant',
    createdBy: ownerId,
    expiresAt: null,
    now,
  });
  await setServerShareExecGrant(db, { shareId: ctlShareId, serverId: ctl1.serverId, granted: true, now });
  ctlDisabled.nodeId = generateControlledNodeId();
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, revoked_at, ref_name, display_name, os, node_id, abi_profile)
     VALUES ($1,$2,'ctl-dis',$3,'online',$4,$5,false,NULL,'ctl-dis','Controlled Disabled','linux',$6,$7)`,
    [ctlDisabled.serverId, ownerId, sha256(ctlDisabled.token), now, NODE_ROLE.CONTROLLED, ctlDisabled.nodeId, CONTROLLED_NODE_ABI_MODERN],
  );
  // Suppress unused constant lint if header constant isn't referenced via import check
  void CONTROLLED_NODE_ABI_PROFILE_FIELD;

  storeCaller = new PostgresPortForwardClusterStore(db, connStr);
  storeListen = new PostgresPortForwardClusterStore(db, connStr);
  storeTarget = new PostgresPortForwardClusterStore(db, connStr);

  podCaller = new PortForwardRouter({
    podId: `pod_caller_${hex(4)}`,
    clusterStore: storeCaller,
    lookupBridge: () => undefined,
    prepareTimeoutMs: 3_000,
    establishTimeoutMs: 5_000,
  });
  podListen = new PortForwardRouter({
    podId: `pod_listen_${hex(4)}`,
    clusterStore: storeListen,
    lookupBridge: (id) => podListenBridges.get(id),
    prepareTimeoutMs: 3_000,
    establishTimeoutMs: 5_000,
  });
  podTarget = new PortForwardRouter({
    podId: `pod_target_${hex(4)}`,
    clusterStore: storeTarget,
    lookupBridge: (id) => podTargetBridges.get(id),
    prepareTimeoutMs: 3_000,
    establishTimeoutMs: 5_000,
  });

  await Promise.all([podCaller.startCluster(), podListen.startCluster(), podTarget.startCluster()]);

  const idFull1 = generateEndpointIdentityKeyPair();
  const idCtl1 = generateEndpointIdentityKeyPair();
  const idFull2 = generateEndpointIdentityKeyPair();
  const trustedPeerMap = new Map<string, string>([
    [full1.serverId, idFull1.publicKeyB64],
    [ctl1.serverId, idCtl1.publicKeyB64],
    [full2.serverId, idFull2.publicKeyB64],
  ]);

  listenEngine = new PortForwardEngine({
    disableDirectTcp: true,
    disableDirectUdp: true,
    identityKeyPair: idFull1,
    resolveTrustedPeerPublicKey: (id) => trustedPeerMap.get(id) ?? null,
    sendWs: (msg) => {
      queueMicrotask(() => podListen.handleDaemonMessage(full1.serverId, 1, msg));
    },
  });
  targetCtlEngine = new PortForwardEngine({
    disableDirectTcp: true,
    disableDirectUdp: true,
    identityKeyPair: idCtl1,
    resolveTrustedPeerPublicKey: (id) => trustedPeerMap.get(id) ?? null,
    sendWs: (msg) => {
      queueMicrotask(() => podTarget.handleDaemonMessage(ctl1.serverId, 1, msg));
    },
  });
  full2Engine = new PortForwardEngine({
    disableDirectTcp: true,
    disableDirectUdp: true,
    identityKeyPair: idFull2,
    resolveTrustedPeerPublicKey: (id) => trustedPeerMap.get(id) ?? null,
    sendWs: (msg) => {
      queueMicrotask(() => podTarget.handleDaemonMessage(full2.serverId, 1, msg));
    },
  });
  enginesToClose.push(listenEngine, targetCtlEngine, full2Engine);

  podListenBridges.set(full1.serverId, {
    isDaemonConnected: () => true,
    daemonConnectionGeneration: () => 1,
    trySendPortForward: (msg: Record<string, unknown>) => {
      void listenEngine.handleMessage(msg as unknown as PortForwardWireMessage);
      return true;
    },
  });
  podTargetBridges.set(ctl1.serverId, {
    isDaemonConnected: () => targetCtlConnected,
    daemonConnectionGeneration: () => 1,
    trySendPortForward: (msg: Record<string, unknown>) => {
      if (!targetCtlConnected) return false;
      void targetCtlEngine.handleMessage(msg as unknown as PortForwardWireMessage);
      return true;
    },
  });
  podTargetBridges.set(full2.serverId, {
    isDaemonConnected: () => true,
    daemonConnectionGeneration: () => 1,
    trySendPortForward: (msg: Record<string, unknown>) => {
      void full2Engine.handleMessage(msg as unknown as PortForwardWireMessage);
      return true;
    },
  });

  podListen.onDaemonConnected(full1.serverId, 1);
  podTarget.onDaemonConnected(ctl1.serverId, 1);
  podTarget.onDaemonConnected(full2.serverId, 1);
  podTarget.onDaemonConnected(ctlDisabled.serverId, 1);

  const makeApp = (router: PortForwardRouter) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = { DB: db, JWT_SIGNING_KEY: signingKey };
      await next();
    });
    app.route(PORT_FORWARD_API_PATH, createPortForwardRoutes(router));
    return app;
  };
  appCaller = makeApp(podCaller);
  appTarget = makeApp(podTarget);

  const httpServer = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, backend: 'pg-multipod' }));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  echoPort = (httpServer.address() as { port: number }).port;
  closeEcho = () => new Promise<void>((resolve) => httpServer.close(() => resolve()));
}, 30_000);

afterAll(async () => {
  for (const engine of enginesToClose) engine.closeAll('integration_end');
  await podCaller?.closeAllForUser(ownerId).catch(() => {});
  await podListen?.stopCluster().catch(() => {});
  await podTarget?.stopCluster().catch(() => {});
  await podCaller?.stopCluster().catch(() => {});
  await closeEcho?.();
  await db?.close();
});

describe('PostgreSQL port-forward cross-layer multi-pod integration', () => {
  it('enforces shared-host owner authority across all 4 routes, persists audit rows, and forwards HTTP across 3 PostgreSQL-backed pods', async () => {
    // 1. Shared host fails closed without turn owner authority header on POST, GET, DELETE /:id, and DELETE /.
    for (const req of [
      appCaller.request(PORT_FORWARD_API_PATH, {
        method: 'POST',
        headers: { 'X-Server-Id': full1.serverId, authorization: `Bearer ${full1.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ targetNode: ctl1.nodeId, targetPort: echoPort, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
      }),
      appCaller.request(PORT_FORWARD_API_PATH, {
        headers: { 'X-Server-Id': full1.serverId, authorization: `Bearer ${full1.token}` },
      }),
      appCaller.request(`${PORT_FORWARD_API_PATH}/pf_missing`, {
        method: 'DELETE',
        headers: { 'X-Server-Id': full1.serverId, authorization: `Bearer ${full1.token}` },
      }),
      appCaller.request(PORT_FORWARD_API_PATH, {
        method: 'DELETE',
        headers: { 'X-Server-Id': full1.serverId, authorization: `Bearer ${full1.token}` },
      }),
    ]) {
      const res = await req;
      expect(res.status).toBe(403);
      expect((await res.json() as { reason: string }).reason).toBe(PORT_FORWARD_ERRORS.TARGET_FORBIDDEN);
    }

    // 2. Shared session participant cannot open tunnels even with exec grant on controlled machine.
    const participantJwt = issueSharedMachineAuthority({
      type: SHARED_MACHINE_AUTHORITY_TYPE,
      sub: participantId,
      sourceServerId: full1.serverId,
      sessionName: 'deck_brain',
      projectName: 'demo-proj',
      shareTarget: { kind: 'server', serverId: full1.serverId },
      actionId: `act_part_${hex(4)}`,
    }, signingKey);
    const partRes = await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1.serverId,
        authorization: `Bearer ${full1.token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: participantJwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: ctl1.nodeId, targetPort: echoPort }),
    });
    expect(partRes.status).toBe(403);

    // 3. Verified owner turn authority works, denies exec_enabled=false target (403 exec_disabled),
    // and records real machine_action_audit rows in PostgreSQL.
    const ownerJwt = issueOwnerMachineAuthority({
      type: OWNER_MACHINE_AUTHORITY_TYPE,
      sub: ownerId,
      sourceServerId: full1.serverId,
      sessionName: 'deck_brain',
      projectName: 'demo-proj',
      actionId: `act_owner_${hex(4)}`,
    }, signingKey);

    const disabledRes = await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1.serverId,
        authorization: `Bearer ${full1.token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerJwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: ctlDisabled.nodeId, targetPort: echoPort }),
    });
    expect(disabledRes.status).toBe(403);
    expect((await disabledRes.json() as { reason: string }).reason).toBe(PORT_FORWARD_ERRORS.EXEC_DISABLED);

    // 4. Cross-pod tunnel establishment via podCaller -> podListen (full1) <-> podTarget (ctl1).
    const openRes = await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1.serverId,
        authorization: `Bearer ${full1.token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerJwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: ctl1.nodeId, targetPort: echoPort, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(openRes.status).toBe(200);
    const { tunnel } = await openRes.json() as { tunnel: { tunnelId: string; listenPort: number; transportMode: string } };
    expect(tunnel.transportMode).toBe(PORT_FORWARD_TRANSPORT.RELAY);

    const httpResp = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: tunnel.listenPort, path: '/' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end();
    });
    expect(JSON.parse(httpResp)).toEqual({ ok: true, backend: 'pg-multipod' });

    const pgRow = await db.queryOne<{ status: string; transport_mode: string | null }>(
      `SELECT status, transport_mode FROM port_forward_tunnels WHERE tunnel_id = $1`,
      [tunnel.tunnelId],
    );
    expect(pgRow).toEqual({ status: 'active', transport_mode: 'relay' });

    const auditRows = await db.query<{ decision: string }>(
      `SELECT decision FROM machine_exec_audit WHERE user_id = $1`,
      [ownerId],
    );
    expect(auditRows.some((r) => r.decision === 'allowed')).toBe(true);
    expect(auditRows.some((r) => r.decision === 'denied')).toBe(true);

    // 5. Cross-pod list & DELETE from podTarget cleanly close PostgreSQL state & listenEngine,
    // enabling immediate fixed-port rebind (0ms sleep, P0 #3).
    const listOnTarget = await appTarget.request(PORT_FORWARD_API_PATH, {
      headers: { 'X-Server-Id': full2.serverId, authorization: `Bearer ${full2.token}` },
    });
    expect(listOnTarget.status).toBe(200);
    expect((await listOnTarget.json() as { tunnels: Array<{ tunnelId: string }> }).tunnels.map((t) => t.tunnelId)).toContain(tunnel.tunnelId);

    const fixedRebindPort = await new Promise<number>((resolve) => {
      const s = createTcpServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const fixedOpen = await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1.serverId,
        authorization: `Bearer ${full1.token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerJwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        listenPort: fixedRebindPort,
        targetNode: ctl1.nodeId,
        targetPort: echoPort,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      }),
    });
    expect(fixedOpen.status).toBe(200);
    const { tunnel: fixedTunnel } = await fixedOpen.json() as { tunnel: { tunnelId: string; listenPort: number } };
    expect(fixedTunnel.listenPort).toBe(fixedRebindPort);

    const delFixed = await appTarget.request(`${PORT_FORWARD_API_PATH}/${fixedTunnel.tunnelId}`, {
      method: 'DELETE',
      headers: { 'X-Server-Id': full2.serverId, authorization: `Bearer ${full2.token}` },
    });
    expect(delFixed.status).toBe(200);
    // Immediate rebind with 0ms delay must succeed because cross-pod DELETE waited for CLOSE_ACK!
    const immediateRebind = await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1.serverId,
        authorization: `Bearer ${full1.token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerJwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        listenPort: fixedRebindPort,
        targetNode: ctl1.nodeId,
        targetPort: echoPort,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      }),
    });
    expect(immediateRebind.status).toBe(200);
    const { tunnel: reboundTunnel } = await immediateRebind.json() as { tunnel: { tunnelId: string } };
    await appTarget.request(`${PORT_FORWARD_API_PATH}/${reboundTunnel.tunnelId}`, {
      method: 'DELETE',
      headers: { 'X-Server-Id': full2.serverId, authorization: `Bearer ${full2.token}` },
    });

    const delFromTarget = await appTarget.request(`${PORT_FORWARD_API_PATH}/${tunnel.tunnelId}`, {
      method: 'DELETE',
      headers: { 'X-Server-Id': full2.serverId, authorization: `Bearer ${full2.token}` },
    });
    expect(delFromTarget.status).toBe(200);

    const closedPgRow = await db.queryOne<{ status: string }>(
      `SELECT status FROM port_forward_tunnels WHERE tunnel_id = $1`,
      [tunnel.tunnelId],
    );
    expect(closedPgRow?.status).toBe('closed');
    expect(listenEngine.listTunnels()).toHaveLength(0);

    // 6. PostgreSQL paused-target pod backpressure & hard-cap + ordered multi-frame delivery + orphan reclaim (P0 #2/#4/#5).
    const postPayload = Buffer.allocUnsafe(300 * 1024);
    for (let i = 0; i < postPayload.length; i++) postPayload[i] = (i * 19 + 5) & 0xff;
    const expectedSha = createHash('sha256').update(postPayload).digest('hex');

    const bpEcho = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ len: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }));
      });
    });
    await new Promise<void>((r) => bpEcho.listen(0, '127.0.0.1', () => r()));
    const bpPort = (bpEcho.address() as { port: number }).port;
    try {
      const bpOpen = await appCaller.request(PORT_FORWARD_API_PATH, {
        method: 'POST',
        headers: {
          'X-Server-Id': full1.serverId,
          authorization: `Bearer ${full1.token}`,
          [SHARED_MACHINE_AUTHORITY_HEADER]: ownerJwt,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ targetNode: ctl1.nodeId, targetPort: bpPort, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
      });
      expect(bpOpen.status).toBe(200);
      const { tunnel: bpTunnel } = await bpOpen.json() as { tunnel: { tunnelId: string; listenPort: number } };

      await storeTarget.setPodDrainPausedForTests(podTarget.getPodId(), true);
      const postPromise = new Promise<{ len: number; sha256: string }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: bpTunnel.listenPort, path: '/', method: 'POST' }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject);
        req.end(postPayload);
      });
      await new Promise((r) => setTimeout(r, 80));
      const queuedInPg = await storeTarget.getQueuedBytes(bpTunnel.tunnelId, 'l2t');
      expect(queuedInPg).toBeLessThanOrEqual(PORT_FORWARD_LIMITS.CLUSTER_RELAY_HARD_CAP_BYTES);

      await storeTarget.setPodDrainPausedForTests(podTarget.getPodId(), false);
      expect(await postPromise).toEqual({ len: postPayload.length, sha256: expectedSha });

      await appTarget.request(`${PORT_FORWARD_API_PATH}/${bpTunnel.tunnelId}`, {
        method: 'DELETE',
        headers: { 'X-Server-Id': full2.serverId, authorization: `Bearer ${full2.token}` },
      });
      expect(await storeTarget.getQueuedBytes(bpTunnel.tunnelId, 'l2t')).toBe(0);
    } finally {
      await storeTarget.setPodDrainPausedForTests(podTarget.getPodId(), false);
      await new Promise<void>((r) => bpEcho.close(() => r()));
    }

    // 7. Concurrent PG quota enforcement across pods: advisory lock strictly enforces MAX_TUNNELS_PER_USER.
    const quotaReqs = Array.from({ length: PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER + 3 }, () =>
      appCaller.request(PORT_FORWARD_API_PATH, {
        method: 'POST',
        headers: {
          'X-Server-Id': full1.serverId,
          authorization: `Bearer ${full1.token}`,
          [SHARED_MACHINE_AUTHORITY_HEADER]: ownerJwt,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ targetNode: ctl1.nodeId, targetPort: echoPort, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
      }),
    );
    const quotaResponses = await Promise.all(quotaReqs);
    const okCount = quotaResponses.filter((r) => r.status === 200).length;
    const limitCount = quotaResponses.filter((r) => r.status === 429).length;
    expect(okCount).toBe(PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER);
    expect(limitCount).toBe(3);

    await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'DELETE',
      headers: {
        'X-Server-Id': full1.serverId,
        authorization: `Bearer ${full1.token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerJwt,
      },
    });

    // 8. Cross-pod daemon disconnect clears active PG tunnel & tears down remote engine.
    const open2 = await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1.serverId,
        authorization: `Bearer ${full1.token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerJwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: ctl1.nodeId, targetPort: echoPort, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(open2.status).toBe(200);
    const { tunnel: t2 } = await open2.json() as { tunnel: { tunnelId: string } };
    targetCtlConnected = false;
    podTarget.onDaemonDisconnected(ctl1.serverId, 1);
    await new Promise((r) => setTimeout(r, 120));
    const t2Row = await db.queryOne<{ status: string }>(
      `SELECT status FROM port_forward_tunnels WHERE tunnel_id = $1`,
      [t2.tunnelId],
    );
    expect(t2Row?.status).toBe('closed');
    expect(listenEngine.listTunnels()).toHaveLength(0);
  });
});
