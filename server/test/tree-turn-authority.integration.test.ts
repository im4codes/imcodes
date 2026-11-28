/**
 * End-to-end PostgreSQL integration test for pure in-memory, server-stateful,
 * opaque tree-scoped turn grants across Owner + multiple Participants (P1, P2).
 *
 * Covers:
 * - Zero DB/SQLite/disk persistence & opaque trg_... token format + redaction
 * - Unified Main + Child + Nested Sub-session tree inheritance & full-tree idle revoke
 * - Stale turn_authority.revoke tokenHash protection (G1 cannot kill fresh G2)
 * - Multi-participant sender switching (O -> P1 -> P2) immediate revocation
 * - Multi-project concurrency on same server (Project 1=O, Project 2=P1, Project 3=P2)
 * - Sender-scoped isolation across /api/machines, /api/machine/exec, /api/machine/computer-use,
 *   /api/port-forwards/*, /api/aliases/*, /api/verification-machines/*
 * - WS disconnect sweep, sliding active TTL, unshared personal host & browser UI parity
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { PORT_FORWARD_API_PATH, PORT_FORWARD_ERRORS, PORT_FORWARD_TRANSPORT_PREF } from '../../shared/port-forward.js';
import { SHARED_MACHINE_AUTHORITY_HEADER, TURN_AUTHORITY_TOKEN_PREFIX } from '../../shared/shared-machine-authority.js';
import { redactSensitiveText } from '../../shared/redact-secrets.js';
import { buildApp } from '../src/index.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser, upsertDbSession } from '../src/db/queries.js';
import { createOrUpdateShare, setServerShareExecGrant } from '../src/db/tab-sharing.js';
import { generateControlledNodeId } from '../src/services/controlled-node-identity.js';
import { randomHex, signJwt, verifyJwt } from '../src/security/crypto.js';
import {
  TURN_AUTHORITY_TTL_MS,
  clearTurnAuthorityGrantsForTests,
  issueOwnerMachineAuthorityForSession,
  issueSharedMachineAuthorityForSession,
  resolveSharedMachineAuthority,
} from '../src/share/shared-machine-authority.js';
import { WsBridge } from '../src/ws/bridge.js';
import { createPortForwardRoutes } from '../src/routes/port-forward.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { createMachineExecRoutes } from '../src/routes/machine-exec.js';
import { createMachineComputerUseRoutes } from '../src/routes/machine-computer-use.js';
import { aliasRoutes } from '../src/routes/aliases.js';
import { verificationMachineRoutes } from '../src/routes/verification-machines.js';
import { PortForwardRouter } from '../src/ws/port-forward-router.js';
import { InMemoryPortForwardClusterStore } from '../src/ws/port-forward-cluster.js';
import type { Env } from '../src/env.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const hex = (n: number) => randomBytes(n).toString('hex');
const JWT_KEY = 'tree-turn-authority-integration-key-32bytes!';
const BOT_KEY = hex(32);

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void) {
    if (typeof data === 'string') this.sent.push(data);
    cb?.();
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

let db: Database;
let app: ReturnType<typeof buildApp>;
let pfApp: Hono;
let pfRouter: PortForwardRouter;

const tag = randomHex(4);
const OWNER_O = `usr-o-${tag}`;
const PART_P1 = `usr-p1-${tag}`;
const PART_P2 = `usr-p2-${tag}`;

const M_SHARED = `srv-sh-${tag}`;
const TOK_SHARED = `tok-sh-${tag}`;
const M_PRIV_HOST = `srv-priv-${tag}`;
const TOK_PRIV_HOST = `tok-priv-${tag}`;
const M_P1_FULL = `srv-p1full-${tag}`;
const TOK_P1_FULL = `tok-p1full-${tag}`;
const M_P2_FULL = `srv-p2full-${tag}`;
const TOK_P2_FULL = `tok-p2full-${tag}`;

const CTL_O = { id: `ctl-o-${tag}`, nodeId: '' };
const CTL_P1_OWN = { id: `ctl-p1own-${tag}`, nodeId: '' };
const CTL_P1_SH = { id: `ctl-p1sh-${tag}`, nodeId: '' };
const CTL_P2_OWN = { id: `ctl-p2own-${tag}`, nodeId: '' };
const CTL_P2_SH = { id: `ctl-p2sh-${tag}`, nodeId: '' };

const PROJ1_MAIN = `deck_p1_${tag}_brain`;
const PROJ1_CHILD = `deck_sub_c1_${tag}`;
const PROJ1_NESTED = `deck_sub_n1_${tag}`;
const PROJ2_MAIN = `deck_p2_${tag}_brain`;
const PROJ2_CHILD = `deck_sub_c2_${tag}`;
const PROJ3_MAIN = `deck_p3_${tag}_brain`;
const PROJ3_CHILD = `deck_sub_c3_${tag}`;
const SOLO_SUB = `deck_sub_solo_${tag}`;

const ALIAS_O = `alias_o_${tag}`;
const ALIAS_P1 = `alias_p1_${tag}`;
const ALIAS_P2 = `alias_p2_${tag}`;

const VM_O = hex(16);
const VM_P1 = hex(16);
const VM_P2 = hex(16);

const SHARE_P1_PROJ1 = { kind: 'main' as const, serverId: M_SHARED, sessionName: PROJ1_MAIN };
const SHARE_P2_PROJ1 = { kind: 'main' as const, serverId: M_SHARED, sessionName: PROJ1_MAIN };
const SHARE_P1_PROJ2 = { kind: 'main' as const, serverId: M_SHARED, sessionName: PROJ2_MAIN };
const SHARE_P2_PROJ3 = { kind: 'main' as const, serverId: M_SHARED, sessionName: PROJ3_MAIN };
const SHARE_P1_SOLO = { kind: 'subsession' as const, serverId: M_SHARED, subSessionId: `solo_${tag}` };

function daemonHeaders(serverId: string, token: string, authority?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Server-Id': serverId,
    ...(authority ? { [SHARED_MACHINE_AUTHORITY_HEADER]: authority } : {}),
  };
}

function userBearer(userId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`,
    'Content-Type': 'application/json',
  };
}

async function seedControlled(id: string, ownerUserId: string, label: string): Promise<string> {
  const nodeId = generateControlledNodeId();
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os, node_id)
     VALUES ($1,$2,$3,$4,'online',$5,$6,true,$7,$3,'linux',$8)`,
    [id, ownerUserId, label, sha256(`tok-${id}`), Date.now(), NODE_ROLE.CONTROLLED, `ref-${id}`, nodeId],
  );
  return nodeId;
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);

  app = buildApp({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: BOT_KEY,
    DB: db,
    NODE_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost',
  } as Env);

  pfRouter = new PortForwardRouter({
    podId: `pod_pf_${tag}`,
    clusterStore: new InMemoryPortForwardClusterStore(),
    lookupBridge: (serverId) => ({
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (msg) => {
        if (msg.type === 'port_forward.prepare') {
          queueMicrotask(() => {
            pfRouter.handleDaemonMessage(serverId, 1, {
              type: 'port_forward.ready',
              tunnelId: msg.tunnelId,
              role: msg.role,
              ...(msg.role === 'listen' ? { listenPort: 45123 } : {}),
              publicKey: 'p'.repeat(44),
              keyProof: 'k'.repeat(43),
              identityPublicKey: 'i'.repeat(44),
              identitySignature: 's'.repeat(86),
              candidates: [],
            });
          });
        } else if (msg.type === 'port_forward.connect') {
          queueMicrotask(() => {
            if (msg.role === 'target') {
              pfRouter.handleDaemonMessage(serverId, 1, {
                type: 'port_forward.target_ready',
                tunnelId: msg.tunnelId,
              });
            }
            pfRouter.handleDaemonMessage(serverId, 1, {
              type: 'port_forward.established',
              tunnelId: msg.tunnelId,
              role: msg.role,
              transportMode: 'relay',
              ...(msg.role === 'listen' ? { listenPort: 45123 } : {}),
            });
          });
        } else if (msg.type === 'port_forward.close') {
          queueMicrotask(() => {
            pfRouter.handleDaemonMessage(serverId, 1, {
              type: 'port_forward.close_ack',
              tunnelId: msg.tunnelId,
            });
          });
        }
        return true;
      },
    }),
  });
  await pfRouter.startCluster();

  pfApp = new Hono();
  pfApp.use('*', async (c, next) => {
    (c as unknown as { env: Env }).env = { DB: db, JWT_SIGNING_KEY: JWT_KEY, BOT_ENCRYPTION_KEY: BOT_KEY } as Env;
    await next();
  });
  pfApp.route('/api/machines', machinesRoutes);
  pfApp.route('/api/aliases', aliasRoutes);
  pfApp.route('/api/verification-machines', verificationMachineRoutes);
  pfApp.route(PORT_FORWARD_API_PATH, createPortForwardRoutes(pfRouter));
  pfApp.route('/api/machine/exec', createMachineExecRoutes(async () => ({
    online: true,
    result: { requestId: 'req', ok: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 },
  })));
  pfApp.route('/api/machine/computer-use', createMachineComputerUseRoutes(async (_target, frame) => ({
    online: true,
    result: { correlationId: frame.correlationId, ok: true, tool: frame.tool, content: [{ type: 'text', text: 'ok' }], durationMs: 1 },
  })));

  await createUser(db, OWNER_O);
  await createUser(db, PART_P1);
  await createUser(db, PART_P2);

  await createServer(db, M_SHARED, OWNER_O, 'Shared FULL', sha256(TOK_SHARED));
  await createServer(db, M_PRIV_HOST, OWNER_O, 'Private FULL', sha256(TOK_PRIV_HOST));
  await createServer(db, M_P1_FULL, PART_P1, 'P1 FULL', sha256(TOK_P1_FULL));
  await createServer(db, M_P2_FULL, PART_P2, 'P2 FULL', sha256(TOK_P2_FULL));
  await db.execute(`UPDATE servers SET status = 'online' WHERE id IN ($1,$2,$3,$4)`, [M_SHARED, M_PRIV_HOST, M_P1_FULL, M_P2_FULL]);

  CTL_O.nodeId = await seedControlled(CTL_O.id, OWNER_O, 'O-Unshared');
  CTL_P1_OWN.nodeId = await seedControlled(CTL_P1_OWN.id, PART_P1, 'P1-Own');
  CTL_P1_SH.nodeId = await seedControlled(CTL_P1_SH.id, OWNER_O, 'O-Shared-P1');
  CTL_P2_OWN.nodeId = await seedControlled(CTL_P2_OWN.id, PART_P2, 'P2-Own');
  CTL_P2_SH.nodeId = await seedControlled(CTL_P2_SH.id, OWNER_O, 'O-Shared-P2');

  const now = Date.now();
  await upsertDbSession(db, `sp1-${tag}`, M_SHARED, PROJ1_MAIN, `p1_${tag}`, 'brain', 'claude-code-sdk', '/p1', 'idle', 'P1');
  await upsertDbSession(db, `sp2-${tag}`, M_SHARED, PROJ2_MAIN, `p2_${tag}`, 'brain', 'claude-code-sdk', '/p2', 'idle', 'P2');
  await upsertDbSession(db, `sp3-${tag}`, M_SHARED, PROJ3_MAIN, `p3_${tag}`, 'brain', 'claude-code-sdk', '/p3', 'idle', 'P3');

  for (const [id, parent] of [
    [`c1_${tag}`, PROJ1_MAIN],
    [`n1_${tag}`, PROJ1_CHILD],
    [`c2_${tag}`, PROJ2_MAIN],
    [`c3_${tag}`, PROJ3_MAIN],
    [`solo_${tag}`, null],
  ] as const) {
    await db.execute(
      `INSERT INTO sub_sessions (id, server_id, type, cwd, label, parent_session, created_at, updated_at)
       VALUES ($1,$2,'claude-code-sdk','/tmp',$1,$3,$4,$4)`,
      [id, M_SHARED, parent, now],
    );
  }

  for (const [sid, target, uid] of [
    [`sh-p1-proj1-${tag}`, SHARE_P1_PROJ1, PART_P1],
    [`sh-p2-proj1-${tag}`, SHARE_P2_PROJ1, PART_P2],
    [`sh-p1-proj2-${tag}`, SHARE_P1_PROJ2, PART_P1],
    [`sh-p2-proj3-${tag}`, SHARE_P2_PROJ3, PART_P2],
    [`sh-p1-solo-${tag}`, SHARE_P1_SOLO, PART_P1],
  ] as const) {
    await createOrUpdateShare(db, {
      id: sid,
      target,
      targetUserId: uid,
      role: 'participant',
      createdBy: OWNER_O,
      now,
    });
  }

  const ctlP1ShId = `sh-ctl-p1-${tag}`;
  await createOrUpdateShare(db, { id: ctlP1ShId, target: { kind: 'server', serverId: CTL_P1_SH.id }, targetUserId: PART_P1, role: 'participant', createdBy: OWNER_O, now });
  await setServerShareExecGrant(db, { shareId: ctlP1ShId, serverId: CTL_P1_SH.id, granted: true, now });

  const ctlP2ShId = `sh-ctl-p2-${tag}`;
  await createOrUpdateShare(db, { id: ctlP2ShId, target: { kind: 'server', serverId: CTL_P2_SH.id }, targetUserId: PART_P2, role: 'participant', createdBy: OWNER_O, now });
  await setServerShareExecGrant(db, { shareId: ctlP2ShId, serverId: CTL_P2_SH.id, granted: true, now });

  // Seed aliases via HTTP browser API so values use real encryption!
  expect((await app.request('/api/aliases', { method: 'POST', headers: userBearer(OWNER_O), body: JSON.stringify({ name: ALIAS_O, value: 'secret-o-val' }) })).status).toBe(200);
  expect((await app.request('/api/aliases', { method: 'POST', headers: userBearer(PART_P1), body: JSON.stringify({ name: ALIAS_P1, value: 'secret-p1-val' }) })).status).toBe(200);
  expect((await app.request('/api/aliases', { method: 'POST', headers: userBearer(PART_P2), body: JSON.stringify({ name: ALIAS_P2, value: 'secret-p2-val' }) })).status).toBe(200);

  for (const [vmId, uid, aliasName, targetId] of [
    [VM_O, OWNER_O, 'vm-o', CTL_O.id],
    [VM_P1, PART_P1, 'vm-p1', CTL_P1_OWN.id],
    [VM_P2, PART_P2, 'vm-p2', CTL_P2_OWN.id],
  ] as const) {
    await db.execute(
      `INSERT INTO verification_machine_profiles (id, user_id, scope, scope_key, alias, kind, target, enabled, revision, created_at, updated_at, last_verification_status, source)
       VALUES ($1,$2,'user',$2,$3,'controlled_node',$4,true,1,$5,$5,'unverified','web')`,
      [vmId, uid, aliasName, targetId, now],
    );
  }
});

afterAll(async () => {
  clearTurnAuthorityGrantsForTests();
  await pfRouter?.stopCluster().catch(() => {});
  await db.close();
});

beforeEach(() => {
  clearTurnAuthorityGrantsForTests();
});

async function connectFakeBridgeDaemon(serverId: string, token: string): Promise<FakeWs> {
  const ws = new FakeWs();
  WsBridge.get(serverId).handleDaemonConnection(ws as never, db, { JWT_SIGNING_KEY: JWT_KEY } as never);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token })), false);
  await new Promise((r) => setTimeout(r, 40));
  return ws;
}

describe('pure in-memory server-stateful opaque tree turn grants', () => {
  it('uses non-JWT opaque trg_ tokens, zero DB persistence, redacts logs, and supports nested & standalone trees', async () => {
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '%turn%grant%'`,
    );
    expect(tables).toEqual([]);

    const tokOwner = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: OWNER_O,
      sourceServerId: M_SHARED,
      sessionName: PROJ1_NESTED,
      actionId: 'a1',
    });
    expect(tokOwner).toBeTruthy();
    expect(tokOwner!.startsWith(TURN_AUTHORITY_TOKEN_PREFIX)).toBe(true);
    expect(tokOwner!.includes('.')).toBe(false);
    expect(verifyJwt(tokOwner!, JWT_KEY)).toBeNull();
    expect(redactSensitiveText(`leaked ${tokOwner}`)).toBe('leaked [REDACTED:turn_grant]');

    const decision = await resolveSharedMachineAuthority(db, {
      token: tokOwner!,
      authenticatedSourceServerId: M_SHARED,
      sourceOwnerUserId: OWNER_O,
      now: Date.now(),
    });
    expect(decision).toMatchObject({
      kind: 'owner',
      actorUserId: OWNER_O,
      rootSessionName: PROJ1_MAIN,
    });

    const tokSolo = await issueSharedMachineAuthorityForSession(db, {
      actorUserId: PART_P1,
      sourceServerId: M_SHARED,
      sessionName: SOLO_SUB,
      shareTarget: SHARE_P1_SOLO,
      actionId: 'a-solo',
    });
    expect(tokSolo!.startsWith(TURN_AUTHORITY_TOKEN_PREFIX)).toBe(true);
    await expect(resolveSharedMachineAuthority(db, {
      token: tokSolo!,
      authenticatedSourceServerId: M_SHARED,
      sourceOwnerUserId: OWNER_O,
      now: Date.now(),
    })).resolves.toMatchObject({
      kind: 'participant',
      actorUserId: PART_P1,
      rootSessionName: SOLO_SUB,
    });
    // Independent standalone tree did NOT clobber Project 1's grant
    await expect(resolveSharedMachineAuthority(db, {
      token: tokOwner!,
      authenticatedSourceServerId: M_SHARED,
      sourceOwnerUserId: OWNER_O,
      now: Date.now(),
    })).resolves.toMatchObject({ kind: 'owner', rootSessionName: PROJ1_MAIN });
  });

  it('revokes tree grant on matching WS turn_authority.revoke, ignores stale tokenHash, and sweeps all grants on WS disconnect', async () => {
    const ws = await connectFakeBridgeDaemon(M_SHARED, TOK_SHARED);
    try {
      const g1 = (await issueOwnerMachineAuthorityForSession(db, {
        actorUserId: OWNER_O,
        sourceServerId: M_SHARED,
        sessionName: PROJ1_MAIN,
        actionId: 'a-g1',
      }))!;
      // Newer turn mints G2 on nested child in same tree -> immediately invalidates G1!
      const g2 = (await issueOwnerMachineAuthorityForSession(db, {
        actorUserId: OWNER_O,
        sourceServerId: M_SHARED,
        sessionName: PROJ1_CHILD,
        actionId: 'a-g2',
      }))!;

      expect((await app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, g1) })).status).toBe(403);
      expect((await app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, g2) })).status).toBe(200);

      // Late stale revoke carrying G1's hash MUST NOT kill G2!
      ws.emit('message', Buffer.from(JSON.stringify({
        type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
        rootSessionName: PROJ1_MAIN,
        tokenHash: sha256(g1),
      })), false);
      await new Promise((r) => setTimeout(r, 20));
      expect((await app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, g2) })).status).toBe(200);

      // Matching full-tree idle revoke carrying G2's hash IMMEDIATELY returns 403 on replay across all routes
      ws.emit('message', Buffer.from(JSON.stringify({
        type: DAEMON_MSG.TURN_AUTHORITY_REVOKE,
        rootSessionName: PROJ1_MAIN,
        tokenHash: sha256(g2),
      })), false);
      await new Promise((r) => setTimeout(r, 20));
      expect((await app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, g2) })).status).toBe(403);
      expect((await app.request('/api/verification-machines', { headers: daemonHeaders(M_SHARED, TOK_SHARED, g2) })).status).toBe(403);
      expect((await app.request('/api/machines', { headers: daemonHeaders(M_SHARED, TOK_SHARED, g2) })).status).toBe(403);
      expect((await pfApp.request(PORT_FORWARD_API_PATH, { headers: daemonHeaders(M_SHARED, TOK_SHARED, g2) })).status).toBe(403);

      // Re-mint two concurrent projects on M_SHARED, then close daemon WS -> BOTH swept immediately!
      const gProj1 = (await issueOwnerMachineAuthorityForSession(db, {
        actorUserId: OWNER_O, sourceServerId: M_SHARED, sessionName: PROJ1_MAIN, actionId: 'a-dc1',
      }))!;
      const gProj2 = (await issueSharedMachineAuthorityForSession(db, {
        actorUserId: PART_P1, sourceServerId: M_SHARED, sessionName: PROJ2_MAIN, shareTarget: SHARE_P1_PROJ2, actionId: 'a-dc2',
      }))!;
      expect((await app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, gProj1) })).status).toBe(200);
      expect((await app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, gProj2) })).status).toBe(200);

      ws.close();
      await new Promise((r) => setTimeout(r, 20));
      expect((await app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, gProj1) })).status).toBe(403);
      expect((await app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, gProj2) })).status).toBe(403);
    } finally {
      ws.close();
    }
  });

  it('enforces O -> P1 -> P2 sender-switch revocation, strict actor-scoped routes, and 3-project concurrency (O, P1, P2)', async () => {
    // 1) Owner O starts on Project 1
    const gO = (await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: OWNER_O,
      sourceServerId: M_SHARED,
      sessionName: PROJ1_MAIN,
      actionId: 'a-o-1',
    }))!;
    const oHdrs = daemonHeaders(M_SHARED, TOK_SHARED, gO);

    const oAliases = await app.request('/api/aliases', { headers: oHdrs });
    expect(oAliases.status).toBe(200);
    expect(((await oAliases.json()) as { aliases: Array<{ name: string }> }).aliases.map((a) => a.name)).toEqual([ALIAS_O]);

    const oMachines = await pfApp.request('/api/machines', { headers: oHdrs });
    expect(oMachines.status).toBe(200);
    expect(((await oMachines.json()) as { machines: Array<{ serverId: string }> }).machines.map((m) => m.serverId)).toContain(CTL_O.id);

    const oPfOpen = await pfApp.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: { ...oHdrs, 'content-type': 'application/json' },
      body: JSON.stringify({ targetNode: CTL_O.nodeId, targetPort: 8080, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(oPfOpen.status).toBe(200);
    const { tunnel: oTunnel } = await oPfOpen.json() as { tunnel: { tunnelId: string } };

    // 2) Participant P1 sends to Project 1 nested sub-session -> O's G_O is IMMEDIATELY deleted (403)!
    const gP1 = (await issueSharedMachineAuthorityForSession(db, {
      actorUserId: PART_P1,
      sourceServerId: M_SHARED,
      sessionName: PROJ1_NESTED,
      shareTarget: SHARE_P1_PROJ1,
      actionId: 'a-p1-1',
    }))!;
    expect((await app.request('/api/aliases', { headers: oHdrs })).status).toBe(403);
    expect((await pfApp.request('/api/machines', { headers: oHdrs })).status).toBe(403);

    const p1Hdrs = daemonHeaders(M_SHARED, TOK_SHARED, gP1);
    const p1Aliases = await app.request('/api/aliases', { headers: p1Hdrs });
    expect(p1Aliases.status).toBe(200);
    expect(((await p1Aliases.json()) as { aliases: Array<{ name: string }> }).aliases.map((a) => a.name)).toEqual([ALIAS_P1]);

    // Participant alias write/delete cannot touch Owner O's or P2's alias, even if name matches ALIAS_O!
    expect((await app.request(`/api/aliases/${ALIAS_O}`, { method: 'DELETE', headers: p1Hdrs })).status).toBe(404);
    expect((await app.request(`/api/aliases/${ALIAS_P2}`, { method: 'DELETE', headers: p1Hdrs })).status).toBe(404);
    const p1CreateSameName = await app.request('/api/aliases', {
      method: 'POST',
      headers: { ...p1Hdrs, 'content-type': 'application/json' },
      body: JSON.stringify({ name: ALIAS_O, value: 'p1-owned-value' }),
    });
    expect(p1CreateSameName.status).toBe(200);
    // Owner O's ALIAS_O value stayed completely untouched!
    const oAliasCheck = await app.request(`/api/aliases/${ALIAS_O}`, { headers: userBearer(OWNER_O) });
    expect((await oAliasCheck.json() as { alias: { value: string } }).alias.value).toBe('secret-o-val');
    await app.request(`/api/aliases/${ALIAS_O}`, { method: 'DELETE', headers: p1Hdrs });

    // P1 verification machines strictly show only VM_P1
    const p1Vms = await pfApp.request('/api/verification-machines', { headers: p1Hdrs });
    expect(p1Vms.status).toBe(200);
    expect(((await p1Vms.json()) as { profiles: Array<{ id: string }> }).profiles.map((p) => p.id)).toEqual([VM_P1]);
    expect((await pfApp.request(`/api/verification-machines/${VM_O}`, { method: 'DELETE', headers: p1Hdrs }).then((r) => r.json()))).toEqual({ deleted: false });

    // P1 machines strictly show P1's own unshared node + shared node — NEVER O's unshared CTL_O or P2's CTL_P2_OWN!
    const p1MachinesRes = await pfApp.request('/api/machines', { headers: p1Hdrs });
    expect(p1MachinesRes.status).toBe(200);
    const p1MachineIds = ((await p1MachinesRes.json()) as { machines: Array<{ serverId: string }> }).machines.map((m) => m.serverId);
    expect(p1MachineIds).toContain(CTL_P1_OWN.id);
    expect(p1MachineIds).toContain(CTL_P1_SH.id);
    expect(p1MachineIds).not.toContain(CTL_O.id);
    expect(p1MachineIds).not.toContain(CTL_P2_OWN.id);

    expect((await pfApp.request(`/api/machine/exec?serverId=${CTL_P1_OWN.id}`, { method: 'POST', headers: { ...p1Hdrs, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'pwd' }) })).status).toBe(200);
    expect((await pfApp.request(`/api/machine/exec?serverId=${CTL_O.id}`, { method: 'POST', headers: { ...p1Hdrs, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'pwd' }) })).status).toBe(403);
    expect((await pfApp.request(`/api/machine/exec?serverId=${CTL_P2_OWN.id}`, { method: 'POST', headers: { ...p1Hdrs, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'pwd' }) })).status).toBe(403);

    // Port-forward under P1: blocked on O's FULL daemon (self / M_SHARED) and CTL_O, NEVER lists/closes O's tunnel, ALLOWED between P1's own endpoints!
    const p1SelfPf = await pfApp.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: { ...p1Hdrs, 'content-type': 'application/json' },
      body: JSON.stringify({ targetNode: CTL_P1_OWN.nodeId, targetPort: 8080 }),
    });
    expect(p1SelfPf.status).toBe(403);
    expect((await p1SelfPf.json() as { reason: string }).reason).toBe(PORT_FORWARD_ERRORS.TARGET_FORBIDDEN);

    const p1ListPf = await pfApp.request(PORT_FORWARD_API_PATH, { headers: p1Hdrs });
    expect(p1ListPf.status).toBe(200);
    expect((await p1ListPf.json() as { tunnels: unknown[] }).tunnels).toEqual([]);
    expect((await pfApp.request(`${PORT_FORWARD_API_PATH}/${oTunnel.tunnelId}`, { method: 'DELETE', headers: p1Hdrs })).status).toBe(403);

    const p1OwnPf = await pfApp.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: { ...p1Hdrs, 'content-type': 'application/json' },
      body: JSON.stringify({ listenNode: CTL_P1_SH.nodeId, targetNode: CTL_P1_OWN.nodeId, targetPort: 8080, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(p1OwnPf.status).toBe(200);
    const { tunnel: p1Tunnel } = await p1OwnPf.json() as { tunnel: { tunnelId: string } };
    expect(p1Tunnel.tunnelId).toBeTruthy();
    const p1ListPfAfter = await pfApp.request(PORT_FORWARD_API_PATH, { headers: p1Hdrs });
    expect(((await p1ListPfAfter.json()) as { tunnels: Array<{ tunnelId: string }> }).tunnels.map((t) => t.tunnelId)).toEqual([p1Tunnel.tunnelId]);
    const ownerTunnels = await pfRouter.listTunnels(OWNER_O);
    expect(ownerTunnels.map((t) => t.tunnelId)).toEqual([oTunnel.tunnelId]);

    // 3) P1 -> P2 switch on SAME tree (Project 1): P1's G_P1 IMMEDIATELY returns 403!
    const gP2 = (await issueSharedMachineAuthorityForSession(db, {
      actorUserId: PART_P2,
      sourceServerId: M_SHARED,
      sessionName: PROJ1_MAIN,
      shareTarget: SHARE_P2_PROJ1,
      actionId: 'a-p2-1',
    }))!;
    expect((await app.request('/api/aliases', { headers: p1Hdrs })).status).toBe(403);
    expect((await pfApp.request('/api/machines', { headers: p1Hdrs })).status).toBe(403);
    expect((await pfApp.request(PORT_FORWARD_API_PATH, { headers: p1Hdrs })).status).toBe(403);

    const p2Hdrs = daemonHeaders(M_SHARED, TOK_SHARED, gP2);
    expect(((await (await app.request('/api/aliases', { headers: p2Hdrs })).json()) as { aliases: Array<{ name: string }> }).aliases.map((a) => a.name)).toEqual([ALIAS_P2]);
    expect(((await (await pfApp.request('/api/verification-machines', { headers: p2Hdrs })).json()) as { profiles: Array<{ id: string }> }).profiles.map((p) => p.id)).toEqual([VM_P2]);
    // P2 cannot see or delete P1's tunnel!
    expect(((await (await pfApp.request(PORT_FORWARD_API_PATH, { headers: p2Hdrs })).json()) as { tunnels: unknown[] }).tunnels).toEqual([]);
    expect((await pfApp.request(`${PORT_FORWARD_API_PATH}/${p1Tunnel.tunnelId}`, { method: 'DELETE', headers: p2Hdrs })).status).toBe(403);
    expect((await pfApp.request(`/api/machine/exec?serverId=${CTL_P2_OWN.id}`, { method: 'POST', headers: { ...p2Hdrs, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'pwd' }) })).status).toBe(200);
    expect((await pfApp.request(`/api/machine/exec?serverId=${CTL_P1_OWN.id}`, { method: 'POST', headers: { ...p2Hdrs, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'pwd' }) })).status).toBe(403);

    // 4) Concurrent 3-project isolation on SAME server M_SHARED: Project 1=O, Project 2=P1, Project 3=P2
    clearTurnAuthorityGrantsForTests();
    const gTree1O = (await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: OWNER_O, sourceServerId: M_SHARED, sessionName: PROJ1_MAIN, actionId: 'c-o',
    }))!;
    const gTree2P1 = (await issueSharedMachineAuthorityForSession(db, {
      actorUserId: PART_P1, sourceServerId: M_SHARED, sessionName: PROJ2_CHILD, shareTarget: SHARE_P1_PROJ2, actionId: 'c-p1',
    }))!;
    const gTree3P2 = (await issueSharedMachineAuthorityForSession(db, {
      actorUserId: PART_P2, sourceServerId: M_SHARED, sessionName: PROJ3_CHILD, shareTarget: SHARE_P2_PROJ3, actionId: 'c-p2',
    }))!;

    const [rO, rP1, rP2] = await Promise.all([
      app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, gTree1O) }),
      app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, gTree2P1) }),
      app.request('/api/aliases', { headers: daemonHeaders(M_SHARED, TOK_SHARED, gTree3P2) }),
    ]);
    expect(rO.status).toBe(200);
    expect(rP1.status).toBe(200);
    expect(rP2.status).toBe(200);
    expect(((await rO.json()) as { aliases: Array<{ name: string }> }).aliases.map((a) => a.name)).toEqual([ALIAS_O]);
    expect(((await rP1.json()) as { aliases: Array<{ name: string }> }).aliases.map((a) => a.name)).toEqual([ALIAS_P1]);
    expect(((await rP2.json()) as { aliases: Array<{ name: string }> }).aliases.map((a) => a.name)).toEqual([ALIAS_P2]);
  });

  it('slides TTL across active long turns and preserves unshared personal hosts + browser UI', async () => {
    const t0 = Date.now();
    const longTok = (await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: OWNER_O,
      sourceServerId: M_SHARED,
      sessionName: PROJ1_MAIN,
      actionId: 'long-1',
      now: t0,
    }))!;
    // Active use near TTL boundary slides deadline cleanly
    const tMid = t0 + TURN_AUTHORITY_TTL_MS - 1_000;
    await expect(resolveSharedMachineAuthority(db, {
      token: longTok,
      authenticatedSourceServerId: M_SHARED,
      sourceOwnerUserId: OWNER_O,
      now: tMid,
    })).resolves.toMatchObject({ kind: 'owner', actorUserId: OWNER_O });

    const tPastInitialButStillActive = t0 + TURN_AUTHORITY_TTL_MS + 10_000;
    await expect(resolveSharedMachineAuthority(db, {
      token: longTok,
      authenticatedSourceServerId: M_SHARED,
      sourceOwnerUserId: OWNER_O,
      now: tPastInitialButStillActive,
    })).resolves.toMatchObject({ kind: 'owner', actorUserId: OWNER_O });

    // Prolonged inactivity > TTL cleanly expires grant
    const tExpired = tPastInitialButStillActive + TURN_AUTHORITY_TTL_MS + 1;
    await expect(resolveSharedMachineAuthority(db, {
      token: longTok,
      authenticatedSourceServerId: M_SHARED,
      sourceOwnerUserId: OWNER_O,
      now: tExpired,
    })).resolves.toMatchObject({ kind: 'invalid' });

    // Unshared personal FULL host (no header) keeps working seamlessly across owner routes
    expect((await app.request('/api/aliases', { headers: daemonHeaders(M_PRIV_HOST, TOK_PRIV_HOST) })).status).toBe(200);
    expect((await pfApp.request('/api/machines', { headers: daemonHeaders(M_PRIV_HOST, TOK_PRIV_HOST) })).status).toBe(200);
    expect((await pfApp.request('/api/verification-machines', { headers: daemonHeaders(M_PRIV_HOST, TOK_PRIV_HOST) })).status).toBe(200);

    // Browser/mobile UI remains untouched
    expect((await app.request('/api/aliases', { headers: userBearer(OWNER_O) })).status).toBe(200);
    expect((await pfApp.request('/api/machines', { headers: userBearer(PART_P1) })).status).toBe(200);
  });
});
