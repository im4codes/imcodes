import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PORT_FORWARD_API_PATH,
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_MSG,
  PORT_FORWARD_TRANSPORT,
  PORT_FORWARD_TRANSPORT_PREF,
} from '../../shared/port-forward.js';
import { CONTROLLED_NODE_ABI_MODERN, CONTROLLED_NODE_ABI_PROFILE_FIELD } from '../../shared/controlled-node-abi.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { OWNER_MACHINE_AUTHORITY_TYPE, SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { generateEndpointIdentityKeyPair } from '../../src/daemon/port-forward-crypto.js';
import { PortForwardEngine } from '../../src/daemon/port-forward-engine.js';
import { signJwt } from '../src/security/crypto.js';
import { issueOwnerMachineAuthority } from '../src/share/shared-machine-authority.js';
import { createPortForwardRoutes } from '../src/routes/port-forward.js';
import { WsBridge } from '../src/ws/bridge.js';
import { InMemoryPortForwardClusterStore } from '../src/ws/port-forward-cluster.js';
import { PortForwardRouter, defaultPortForwardRouter, type PortForwardBridgeEndpoint } from '../src/ws/port-forward-router.js';
import type { Database } from '../src/db/client.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface MockUser {
  id: string;
  status: string;
}

interface MockServer {
  id: string;
  user_id: string;
  node_role: 'full' | 'controlled';
  node_id: string | null;
  ref_name: string | null;
  exec_enabled: boolean;
  revoked_at: number | null;
  token_hash: string;
  team_id: string | null;
}

function createFakeNodeSocket(
  serverId: string,
  token: string,
  router: PortForwardRouter,
  engineOpts: Partial<ConstructorParameters<typeof PortForwardEngine>[0]> = {},
) {
  const emitter = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: (raw: string | Buffer) => void;
    close: () => void;
  };
  emitter.readyState = 1;
  const bridge = WsBridge.get(serverId);
  const engine = new PortForwardEngine({
    sendWs: (msg) => {
      emitter.emit('message', Buffer.from(JSON.stringify(msg)), false);
    },
    collectInterfaceAddresses: () => ['127.0.0.1'],
    timeouts: {
      directTcpMs: 250,
      directTcpPreferenceWaitMs: 50,
      directTcpTargetDialDelayMs: 20,
      udpPunchMs: 400,
      udpPunchIntervalMs: 30,
      stunProbeMs: 80,
    },
    ...engineOpts,
  });

  emitter.send = (raw: string | Buffer) => {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    void engine.handleMessage(parsed);
  };
  emitter.close = () => {
    emitter.readyState = 3;
    engine.closeAll('ws_closed');
    emitter.emit('close', 1000, Buffer.alloc(0));
  };

  return { bridge, emitter, engine, token };
}

function createInMemoryDb(users: MockUser[], servers: MockServer[], sharedServerIds = new Set<string>()): Database {
  const auditInserts: unknown[] = [];

  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('FROM servers s') && s.includes('token_hash = $1')) {
      const tokenHash = String(params[0] ?? '');
      const serverId = String(params[1] ?? '');
      const row = servers.find((x) => x.id === serverId && x.token_hash === tokenHash && x.revoked_at == null);
      if (!row) return [];
      const user = users.find((u) => u.id === row.user_id);
      return [{ id: row.id, user_id: row.user_id, role: 'owner', node_role: row.node_role, user_status: user?.status ?? 'active' }] as T[];
    }

    if (s.includes('FROM servers') && s.includes("node_role = 'controlled' AND node_id = $1")) {
      const value = String(params[0] ?? '');
      return servers
        .filter((x) => x.id === value || (x.node_role === 'controlled' && x.node_id === value))
        .map((x) => ({ id: x.id, node_id: x.node_id, node_role: x.node_role, revoked_at: x.revoked_at })) as T[];
    }

    if (s.includes('FROM servers WHERE id = $1') && s.includes('token_hash')) {
      const id = String(params[0] ?? '');
      const row = servers.find((x) => x.id === id);
      if (!row) return [] as T[];
      const user = users.find((u) => u.id === row.user_id);
      return [{
        token_hash: row.token_hash,
        user_id: row.user_id,
        name: row.ref_name ?? row.id,
        node_role: row.node_role,
        revoked_at: row.revoked_at,
        os: 'linux',
        arch: 'x64',
        node_id: row.node_id,
        abi_profile: row.node_role === NODE_ROLE.CONTROLLED ? CONTROLLED_NODE_ABI_MODERN : null,
        owner_status: user?.status ?? 'active',
        controlled_upgrade_status: 'current',
        controlled_upgrade_target_version: null,
        controlled_upgrade_reason: null,
        controlled_worker_refresh_attempt_id: null,
        controlled_worker_refresh_phase: null,
        controlled_worker_refresh_installed_version: null,
        controlled_worker_refresh_target_version: null,
        controlled_worker_refresh_artifact_sha256: null,
        controlled_worker_refresh_reason: null,
        controlled_worker_refresh_recorded_at: null,
      }] as T[];
    }

    if (s.includes('SELECT id, user_id, node_role, node_id, revoked_at FROM servers WHERE id = $1')) {
      const id = String(params[0] ?? '');
      const row = servers.find((x) => x.id === id);
      return (row ? [{ id: row.id, user_id: row.user_id, node_role: row.node_role, node_id: row.node_id, revoked_at: row.revoked_at }] : []) as T[];
    }

    if (s.includes('FROM servers s') && s.includes('s.node_role = $4')) {
      // listAccessibleControlledMachines or resolveControlledMachineAccess
      const userId = String(params[0] ?? '');
      const serverIdFilter = params.length >= 4 && typeof params[2] === 'string' ? params[2] : null;
      return servers
        .filter((x) => x.node_role === 'controlled'
          && x.revoked_at == null
          && x.user_id === userId
          && (!serverIdFilter || x.id === serverIdFilter))
        .map((x) => ({
          id: x.id,
          user_id: x.user_id,
          node_id: x.node_id,
          ref_name: x.ref_name,
          display_name: x.ref_name ?? x.node_id,
          status: 'online',
          last_heartbeat_at: Date.now(),
          exec_enabled: x.exec_enabled,
          os: 'linux',
          arch: 'x64',
          abi_profile: 'modern',
          daemon_version: '0.1.2',
          auto_unlock_configured: false,
          revoked_at: x.revoked_at,
          access_role: 'owner',
          access_source: 'owner',
          exec_granted: false,
          can_rename: true,
          access_expires_at: null,
          controlled_capabilities: [],
          node_role: x.node_role,
          host_server_id: null,
          remote_desktop_host_id: null,
          team_ids: [],
          team_names: [],
        })) as T[];
    }

    if (s.includes('SELECT status FROM users WHERE id = $1')) {
      const id = String(params[0] ?? '');
      const u = users.find((x) => x.id === id);
      return (u ? [{ status: u.status }] : []) as T[];
    }

    if (s.includes('FROM server_shares ss') && s.includes('ss.target_user_id = $2')) {
      return [{ shared: false }] as T[];
    }

    if (s.includes('AS shared') && s.includes('FROM server_shares')) {
      const serverId = String(params[0] ?? '');
      return [{ shared: sharedServerIds.has(serverId) }] as T[];
    }

    if (s.includes('SELECT s.user_id, u.status AS user_status') && s.includes('FROM servers s')) {
      const serverId = String(params[0] ?? '');
      const actorId = String(params[1] ?? '');
      const row = servers.find((x) => x.id === serverId);
      const user = users.find((u) => u.id === actorId);
      return (row ? [{ user_id: row.user_id, user_status: user?.status ?? 'active' }] : []) as T[];
    }

    if (s.includes('SELECT project_name FROM sessions WHERE server_id = $1')) {
      return [{ project_name: 'demo-proj' }] as T[];
    }

    if (s.includes('SELECT 1 FROM server_shares')) {
      const serverId = String(params[0] ?? '');
      return (sharedServerIds.has(serverId) ? [{ 1: 1 }] : []) as T[];
    }

    if (s.includes('SELECT id FROM servers WHERE id = $1 AND team_id IS NOT NULL')) {
      const serverId = String(params[0] ?? '');
      return (sharedServerIds.has(serverId) ? [{ id: serverId }] : []) as T[];
    }

    if (s.includes('SELECT 1 FROM machine_groups')) {
      return [] as T[];
    }

    return [] as T[];
  };

  return {
    query,
    queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const rows = await query<T>(sql, params);
      return rows[0] ?? null;
    },
    execute: async (sql: string, params: unknown[] = []) => {
      auditInserts.push({ sql, params });
      return { changes: 1 };
    },
    close: async () => {},
  } as unknown as Database;
}

describe('server port-forward router & HTTP control plane', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    // fresh bridges via unique serverIds per test
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  async function setupTopology(options: {
    prepareTimeoutMs?: number;
    closeAckTimeoutMs?: number;
    useLegacySilentTarget?: boolean;
    useDefaultRouter?: boolean;
    sharedServerIds?: string[];
  } = {}) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const full1Token = `tok_full1_${suffix}`;
    const full2Token = `tok_full2_${suffix}`;
    const ctl1Token = `tok_ctl1_${suffix}`;
    const ctl2Token = `tok_ctl2_${suffix}`;
    const foreignToken = `tok_foreign_${suffix}`;

    const full1Id = `srv_full1_${suffix}`;
    const full2Id = `srv_full2_${suffix}`;
    const ctl1Id = `srv_ctl1_${suffix}`;
    const ctl2Id = `srv_ctl2_${suffix}`;
    const ctlDisabledId = `srv_ctldis_${suffix}`;
    const foreignFullId = `srv_foreign_${suffix}`;

    const ctl1NodeId = String(1000000000 + Math.floor(Math.random() * 8000000000)).slice(0, 10);
    const ctl2NodeId = String(1000000000 + Math.floor(Math.random() * 8000000000)).slice(0, 10);
    const ctlDisabledNodeId = String(1000000000 + Math.floor(Math.random() * 8000000000)).slice(0, 10);

    const users: MockUser[] = [
      { id: 'user_a', status: 'active' },
      { id: 'user_b', status: 'active' },
    ];
    const servers: MockServer[] = [
      { id: full1Id, user_id: 'user_a', node_role: 'full', node_id: null, ref_name: null, exec_enabled: true, revoked_at: null, token_hash: sha256(full1Token), team_id: null },
      { id: full2Id, user_id: 'user_a', node_role: 'full', node_id: null, ref_name: null, exec_enabled: true, revoked_at: null, token_hash: sha256(full2Token), team_id: null },
      { id: ctl1Id, user_id: 'user_a', node_role: 'controlled', node_id: ctl1NodeId, ref_name: 'ctl-1', exec_enabled: true, revoked_at: null, token_hash: sha256(ctl1Token), team_id: null },
      { id: ctl2Id, user_id: 'user_a', node_role: 'controlled', node_id: ctl2NodeId, ref_name: 'ctl-2', exec_enabled: true, revoked_at: null, token_hash: sha256(ctl2Token), team_id: null },
      { id: ctlDisabledId, user_id: 'user_a', node_role: 'controlled', node_id: ctlDisabledNodeId, ref_name: 'ctl-dis', exec_enabled: false, revoked_at: null, token_hash: sha256(`tok_dis_${suffix}`), team_id: null },
      { id: foreignFullId, user_id: 'user_b', node_role: 'full', node_id: null, ref_name: null, exec_enabled: true, revoked_at: null, token_hash: sha256(foreignToken), team_id: null },
    ];

    const sharedSet = new Set(options.sharedServerIds ?? []);
    const db = createInMemoryDb(users, servers, sharedSet);
    const signingKey = 'test-signing-key-32-chars-minimum-x';
    const router = options.useDefaultRouter
      ? defaultPortForwardRouter
      : new PortForwardRouter({
          lookupBridge: (id) => WsBridge.find(id),
          prepareTimeoutMs: options.prepareTimeoutMs ?? 2_000,
          establishTimeoutMs: 4_000,
          ...(options.closeAckTimeoutMs !== undefined ? { closeAckTimeoutMs: options.closeAckTimeoutMs } : {}),
        });

    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = { DB: db, JWT_SIGNING_KEY: signingKey };
      await next();
    });
    app.route(PORT_FORWARD_API_PATH, createPortForwardRoutes(router));

    // Attach node sockets directly to WsBridge + router (when not using defaultPortForwardRouter)
    const trustedKeys = new Map<string, string>();
    const resolveTrustedPeerPublicKey = (id: string) => trustedKeys.get(id) ?? null;
    const makeNode = (id: string, tok: string, opts: Partial<ConstructorParameters<typeof PortForwardEngine>[0]> = {}) => {
      const kp = generateEndpointIdentityKeyPair();
      trustedKeys.set(id, kp.publicKeyB64);
      return createFakeNodeSocket(id, tok, router, {
        identityKeyPair: kp,
        resolveTrustedPeerPublicKey,
        ...opts,
      });
    };
    const nodes = {
      full1: makeNode(full1Id, full1Token),
      full2: makeNode(full2Id, full2Token),
      ctl1: makeNode(ctl1Id, ctl1Token, { disableDirectTcp: true }),
      ctl2: makeNode(ctl2Id, ctl2Token, { disableDirectTcp: true }),
      ctlDisabled: makeNode(ctlDisabledId, `tok_dis_${suffix}`),
      foreignFull: makeNode(foreignFullId, foreignToken),
    };

    const connectNode = async (
      node: ReturnType<typeof createFakeNodeSocket>,
      serverId: string,
      token: string,
      role: 'full' | 'controlled',
      silent = false,
    ) => {
      if (silent) {
        // Simulate an older node binary that drops unknown port_forward.* messages.
        node.emitter.send = () => {};
      }
      if (!options.useDefaultRouter && !silent) {
        node.emitter.on('message', (raw: Buffer) => {
          try {
            const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
            if (typeof parsed.type === 'string' && parsed.type.startsWith('port_forward.')) {
              router.handleDaemonMessage(serverId, node.bridge.daemonConnectionGeneration(), parsed);
            }
          } catch { /* ignore */ }
        });
      }
      node.bridge.handleDaemonConnection(node.emitter as never, db, {} as never);
      node.emitter.emit('message', Buffer.from(JSON.stringify({
        type: 'auth',
        serverId,
        token,
        daemonVersion: '0.1.2',
        ...(role === 'controlled' ? { [CONTROLLED_NODE_ABI_PROFILE_FIELD]: CONTROLLED_NODE_ABI_MODERN } : {}),
      })), false);
      for (let i = 0; i < 40 && !node.bridge.isDaemonConnected(); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(node.bridge.isDaemonConnected()).toBe(true);
      void role;
    };

    await connectNode(nodes.full1, full1Id, full1Token, 'full');
    await connectNode(nodes.full2, full2Id, full2Token, 'full');
    await connectNode(nodes.ctl1, ctl1Id, ctl1Token, 'controlled');
    await connectNode(nodes.ctl2, ctl2Id, ctl2Token, 'controlled', options.useLegacySilentTarget);
    await connectNode(nodes.ctlDisabled, ctlDisabledId, `tok_dis_${suffix}`, 'controlled');
    await connectNode(nodes.foreignFull, foreignFullId, foreignToken, 'full');

    cleanups.push(async () => {
      await router.closeAllForUser('user_a');
      await router.closeAllForUser('user_b');
      for (const n of Object.values(nodes)) n.emitter.close();
    });

    return {
      app,
      router,
      signingKey,
      full1Id,
      full1Token,
      full2Id,
      ctl1Id,
      ctl1NodeId,
      ctl2Id,
      ctl2NodeId,
      ctlDisabledNodeId,
      foreignFullId,
      nodes,
    };
  }

  it('routes all 4 topologies (FULL<->Controlled, Controlled<->FULL, Controlled<->Controlled, FULL<->FULL) with real HTTP traffic', async () => {
    const httpSrv = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok-port-forward-payload');
    });
    await new Promise<void>((r) => httpSrv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => httpSrv.close(() => r())));
    const targetPort = (httpSrv.address() as { port: number }).port;

    const env = await setupTopology();

    const topologies = [
      { name: 'FULL->Controlled', listenNode: 'self', targetNode: env.ctl1NodeId, transport: PORT_FORWARD_TRANSPORT_PREF.AUTO },
      { name: 'Controlled->FULL', listenNode: `^^(${env.ctl1NodeId})`, targetNode: 'self', transport: PORT_FORWARD_TRANSPORT_PREF.AUTO },
      { name: 'Controlled->Controlled', listenNode: env.ctl1NodeId, targetNode: env.ctl2NodeId, transport: PORT_FORWARD_TRANSPORT_PREF.AUTO },
      { name: 'FULL->FULL', listenNode: 'self', targetNode: env.full2Id, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY },
    ];

    for (const topo of topologies) {
      const res = await env.app.request(`${PORT_FORWARD_API_PATH}?serverId=${env.full1Id}`, {
        method: 'POST',
        headers: {
          'X-Server-Id': env.full1Id,
          authorization: `Bearer ${env.full1Token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          listenNode: topo.listenNode,
          targetNode: topo.targetNode,
          targetPort,
          transport: topo.transport,
          label: topo.name,
        }),
      });
      expect(res.status, topo.name).toBe(200);
      const data = await res.json() as { ok: boolean; tunnel: { tunnelId: string; listenPort: number; transportMode: string } };
      expect(data.ok).toBe(true);

      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: data.tunnel.listenPort, path: '/' }, (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('ok-port-forward-payload');

      // List and close
      const listRes = await env.app.request(`${PORT_FORWARD_API_PATH}?serverId=${env.full1Id}`, {
        method: 'GET',
        headers: { 'X-Server-Id': env.full1Id, authorization: `Bearer ${env.full1Token}` },
      });
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json() as { tunnels: Array<{ tunnelId: string }> };
      expect(listJson.tunnels.some((t) => t.tunnelId === data.tunnel.tunnelId)).toBe(true);
      expect(JSON.stringify(listJson)).not.toContain('capability');

      const delRes = await env.app.request(`${PORT_FORWARD_API_PATH}/${data.tunnel.tunnelId}?serverId=${env.full1Id}`, {
        method: 'DELETE',
        headers: { 'X-Server-Id': env.full1Id, authorization: `Bearer ${env.full1Token}` },
      });
      expect(delRes.status).toBe(200);
    }
  });

  it('enforces fail-closed authz (cross-user FULL, exec_disabled controlled, participant turn, controlled caller)', async () => {
    const env = await setupTopology();

    // 1. Cross-user FULL target -> 403 target_forbidden
    const foreignRes = await env.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': env.full1Id,
        authorization: `Bearer ${env.full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: env.foreignFullId, targetPort: 8080 }),
    });
    expect(foreignRes.status).toBe(403);
    expect(await foreignRes.json()).toMatchObject({ ok: false, reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN });

    // 2. exec_enabled=false controlled node -> 403 exec_disabled
    const disabledRes = await env.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': env.full1Id,
        authorization: `Bearer ${env.full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: env.ctlDisabledNodeId, targetPort: 8080 }),
    });
    expect(disabledRes.status).toBe(403);
    expect(await disabledRes.json()).toMatchObject({ ok: false, reason: PORT_FORWARD_ERRORS.EXEC_DISABLED });

    // 3. Controlled node credential calling HTTP open -> 403 scoped_auth
    const ctlCallerRes = await env.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': env.ctl1Id,
        authorization: `Bearer tok_ctl1_${env.ctl1Id.split('_').pop()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: env.full1Id, targetPort: 8080 }),
    });
    expect(ctlCallerRes.status).toBe(403);

    // 4. Shared participant turn header cannot bridge a FULL daemon
    const participantJwt = signJwt({
      type: 'shared_machine_authority',
      sub: 'participant_user',
      sourceServerId: env.full1Id,
      sessionName: 'deck_app_brain',
      projectName: 'app',
      shareTarget: { kind: 'server', serverId: env.full1Id },
      actionId: 'act_1',
    }, env.signingKey, 600);
    const partRes = await env.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': env.full1Id,
        authorization: `Bearer ${env.full1Token}`,
        'x-imcodes-shared-machine-authority': participantJwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: env.ctl1NodeId, targetPort: 8080 }),
    });
    expect(partRes.status).toBe(403);
  });

  it('auto-cleans peer tunnel immediately on WS disconnect and returns target_unsupported on silent/old node', async () => {
    const unsupportedEnv = await setupTopology({ prepareTimeoutMs: 150, useLegacySilentTarget: true });

    // Silent legacy node ctl2 does not respond to PREPARE -> target_unsupported
    const unsupported = await unsupportedEnv.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': unsupportedEnv.full1Id,
        authorization: `Bearer ${unsupportedEnv.full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: unsupportedEnv.ctl2NodeId, targetPort: 8080 }),
    });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ ok: false, reason: PORT_FORWARD_ERRORS.TARGET_UNSUPPORTED });

    // Open healthy tunnel full1 <-> ctl1 on the REAL production defaultPortForwardRouter,
    // then disconnect ctl1 -> WsBridge invokes defaultPortForwardRouter.onDaemonDisconnected!
    const env = await setupTopology({ useDefaultRouter: true });
    const openRes = await env.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': env.full1Id,
        authorization: `Bearer ${env.full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: env.ctl1NodeId, targetPort: 8080, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(openRes.status).toBe(200);
    const { tunnel } = await openRes.json() as { tunnel: { tunnelId: string; listenPort: number } };
    expect(await env.router.listTunnels('user_a')).toHaveLength(1);

    env.nodes.ctl1.emitter.close();
    await new Promise((r) => setTimeout(r, 30));

    expect(await env.router.listTunnels('user_a')).toHaveLength(0);
    expect(env.nodes.full1.engine.listTunnels()).toHaveLength(0);
    void tunnel;
  });

  it('drops RELAY_FRAME on p2p_only tunnels and rejects tunnels past MAX_TUNNELS_PER_USER', async () => {
    const env = await setupTopology();
    const openedIds: string[] = [];

    for (let i = 0; i < PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_USER; i++) {
      const res = await env.app.request(PORT_FORWARD_API_PATH, {
        method: 'POST',
        headers: {
          'X-Server-Id': env.full1Id,
          authorization: `Bearer ${env.full1Token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ targetNode: env.full2Id, targetPort: 8000 + i, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { tunnel: { tunnelId: string } };
      openedIds.push(data.tunnel.tunnelId);
    }

    const extra = await env.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': env.full1Id,
        authorization: `Bearer ${env.full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: env.full2Id, targetPort: 9000, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(extra.status).toBe(429);
    expect(await extra.json()).toMatchObject({ ok: false, reason: PORT_FORWARD_ERRORS.LIMIT_EXCEEDED });

    // Even if a compromised node tries sending RELAY_FRAME on a p2p_only tunnel, router never forwards it
    const closeOne = await env.app.request(`${PORT_FORWARD_API_PATH}/${openedIds[0]}`, {
      method: 'DELETE',
      headers: { 'X-Server-Id': env.full1Id, authorization: `Bearer ${env.full1Token}` },
    });
    expect(closeOne.status).toBe(200);

    const p2pOnly = await env.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': env.full1Id,
        authorization: `Bearer ${env.full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: env.full2Id, targetPort: 9001, transport: PORT_FORWARD_TRANSPORT_PREF.P2P_ONLY }),
    });
    expect(p2pOnly.status).toBe(200);
    const { tunnel } = await p2pOnly.json() as { tunnel: { tunnelId: string } };

    let forwardedToTarget = false;
    const origSend = env.nodes.full2.bridge.trySendPortForward.bind(env.nodes.full2.bridge);
    env.nodes.full2.bridge.trySendPortForward = (msg, gen) => {
      if (msg.type === PORT_FORWARD_MSG.RELAY_FRAME) forwardedToTarget = true;
      return origSend(msg, gen);
    };
    env.router.handleDaemonMessage(env.full1Id, env.nodes.full1.bridge.daemonConnectionGeneration(), {
      type: PORT_FORWARD_MSG.RELAY_FRAME,
      tunnelId: tunnel.tunnelId,
      data: Buffer.from('forged-relay-data').toString('base64'),
    });
    expect(forwardedToTarget).toBe(false);
    void PORT_FORWARD_TRANSPORT;
  });

  it('routes tunnels, RELAY_FRAME, list/close, quota, and disconnects across 3 completely isolated pods (P0 #2)', async () => {
    const backend = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok-multipod');
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', () => resolve()));
    const backendPort = (backend.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((resolve) => backend.close(() => resolve())));

    const suffix = Math.random().toString(36).slice(2, 8);
    const full1Id = `mp_listen_${suffix}`;
    const full2Id = `mp_target_${suffix}`;
    const full1Token = `mp_tok1_${suffix}`;
    const full2Token = `mp_tok2_${suffix}`;

    const db = createInMemoryDb(
      [{ id: 'user_mp', status: 'active' }],
      [
        { id: full1Id, user_id: 'user_mp', node_role: 'full', node_id: null, ref_name: null, exec_enabled: true, revoked_at: null, token_hash: sha256(full1Token), team_id: null },
        { id: full2Id, user_id: 'user_mp', node_role: 'full', node_id: null, ref_name: null, exec_enabled: true, revoked_at: null, token_hash: sha256(full2Token), team_id: null },
      ],
    );

    const clusterStore = new InMemoryPortForwardClusterStore();
    const podCallerBridges = new Map<string, PortForwardBridgeEndpoint>();
    const podListenBridges = new Map<string, PortForwardBridgeEndpoint>();
    const podTargetBridges = new Map<string, PortForwardBridgeEndpoint>();

    const podCaller = new PortForwardRouter({
      podId: 'pod_caller',
      clusterStore,
      lookupBridge: (id) => podCallerBridges.get(id),
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const podListen = new PortForwardRouter({
      podId: 'pod_listen',
      clusterStore,
      lookupBridge: (id) => podListenBridges.get(id),
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const podTarget = new PortForwardRouter({
      podId: 'pod_target',
      clusterStore,
      lookupBridge: (id) => podTargetBridges.get(id),
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    cleanups.push(async () => {
      await podCaller.closeAllForUser('user_mp');
      await podListen.stopCluster();
      await podTarget.stopCluster();
      await podCaller.stopCluster();
    });

    const id1 = generateEndpointIdentityKeyPair();
    const id2 = generateEndpointIdentityKeyPair();
    const mpTrusted = new Map<string, string>([
      [full1Id, id1.publicKeyB64],
      [full2Id, id2.publicKeyB64],
    ]);

    const listenEngine = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: id1,
      resolveTrustedPeerPublicKey: (id) => mpTrusted.get(id) ?? null,
      sendWs: (msg) => {
        queueMicrotask(() => podListen.handleDaemonMessage(full1Id, 1, msg));
      },
    });
    const targetEngine = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: id2,
      resolveTrustedPeerPublicKey: (id) => mpTrusted.get(id) ?? null,
      sendWs: (msg) => {
        queueMicrotask(() => podTarget.handleDaemonMessage(full2Id, 1, msg));
      },
    });
    cleanups.push(() => {
      listenEngine.closeAll('test_end');
      targetEngine.closeAll('test_end');
    });

    let listenConnected = true;
    let targetConnected = true;
    podListenBridges.set(full1Id, {
      isDaemonConnected: () => listenConnected,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (msg) => {
        if (!listenConnected) return false;
        void listenEngine.handleMessage(msg);
        return true;
      },
    });
    podTargetBridges.set(full2Id, {
      isDaemonConnected: () => targetConnected,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (msg) => {
        if (!targetConnected) return false;
        void targetEngine.handleMessage(msg);
        return true;
      },
    });
    podListen.onDaemonConnected(full1Id, 1);
    podTarget.onDaemonConnected(full2Id, 1);

    const makeApp = (router: PortForwardRouter) => {
      const app = new Hono();
      app.use('*', async (c, next) => {
        (c as unknown as { env: { DB: Database } }).env = { DB: db };
        await next();
      });
      app.route(PORT_FORWARD_API_PATH, createPortForwardRoutes(router));
      return app;
    };

    const appCaller = makeApp(podCaller);
    const appListen = makeApp(podListen);
    const appTarget = makeApp(podTarget);

    // Allocate a fixed port, open tunnel on it, close via podListen, and IMMEDIATELY rebind with ZERO sleep (P0 #3)!
    const fixedPort = await new Promise<number>((resolve) => {
      const s = createTcpServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });

    // podCaller owns NEITHER listen WS NOR target WS, yet opens tunnel via cluster bus -> podListen <-> podTarget!
    const openRes = await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1Id,
        authorization: `Bearer ${full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        listenNode: full1Id,
        listenPort: fixedPort,
        targetNode: full2Id,
        targetPort: backendPort,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      }),
    });
    expect(openRes.status).toBe(200);
    const { tunnel } = await openRes.json() as { tunnel: { tunnelId: string; listenPort: number; transportMode: string } };
    expect(tunnel.transportMode).toBe(PORT_FORWARD_TRANSPORT.RELAY);
    expect(tunnel.listenPort).toBe(fixedPort);

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: tunnel.listenPort, path: '/' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe('ok-multipod');

    // list via podTarget sees authoritative tunnel coordinated by podCaller.
    const listRes = await appTarget.request(PORT_FORWARD_API_PATH, {
      headers: { 'X-Server-Id': full2Id, authorization: `Bearer ${full2Token}` },
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as { tunnels: Array<{ tunnelId: string }> };
    expect(listData.tunnels.map((t) => t.tunnelId)).toContain(tunnel.tunnelId);

    // Close via podListen -> awaits BOTH endpoints CLOSE_ACK before returning 200, so immediate rebind succeeds with 0ms wait!
    const delRes = await appListen.request(`${PORT_FORWARD_API_PATH}/${tunnel.tunnelId}`, {
      method: 'DELETE',
      headers: { 'X-Server-Id': full1Id, authorization: `Bearer ${full1Token}` },
    });
    expect(delRes.status).toBe(200);
    expect(await podCaller.listTunnels('user_mp')).toHaveLength(0);
    expect(listenEngine.listTunnels()).toHaveLength(0);

    // Open second tunnel on EXACT same fixedPort immediately after DELETE returns!
    const openRes2 = await appCaller.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1Id,
        authorization: `Bearer ${full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        listenNode: full1Id,
        listenPort: fixedPort,
        targetNode: full2Id,
        targetPort: backendPort,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      }),
    });
    expect(openRes2.status).toBe(200);
    targetConnected = false;
    podTarget.onDaemonDisconnected(full2Id, 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(await podCaller.listTunnels('user_mp')).toHaveLength(0);
    expect(listenEngine.listTunnels()).toHaveLength(0);
    listenConnected = false;
    void PORT_FORWARD_TRANSPORT;
  });

  it('fails closed on shared/contributed hosts for POST, GET, DELETE /:id, and DELETE / without owner authority (P0 #3)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const full1Id = `sh_full1_${suffix}`;
    const full2Id = `sh_full2_${suffix}`;
    const full1Token = `sh_tok1_${suffix}`;
    const full2Token = `sh_tok2_${suffix}`;
    const signingKey = 'shared-auth-signing-key-32-chars-xxx';
    const db = createInMemoryDb(
      [{ id: 'user_owner', status: 'active' }],
      [
        { id: full1Id, user_id: 'user_owner', node_role: 'full', node_id: null, ref_name: null, exec_enabled: true, revoked_at: null, token_hash: sha256(full1Token), team_id: 'team_1' },
        { id: full2Id, user_id: 'user_owner', node_role: 'full', node_id: null, ref_name: null, exec_enabled: true, revoked_at: null, token_hash: sha256(full2Token), team_id: null },
      ],
      new Set([full1Id]),
    );
    const router = new PortForwardRouter({
      lookupBridge: (id) => WsBridge.find(id),
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const shId1 = generateEndpointIdentityKeyPair();
    const shId2 = generateEndpointIdentityKeyPair();
    const shTrusted = new Map<string, string>([
      [full1Id, shId1.publicKeyB64],
      [full2Id, shId2.publicKeyB64],
    ]);
    const n1 = createFakeNodeSocket(full1Id, full1Token, router, {
      disableDirectTcp: true,
      identityKeyPair: shId1,
      resolveTrustedPeerPublicKey: (id) => shTrusted.get(id) ?? null,
    });
    const n2 = createFakeNodeSocket(full2Id, full2Token, router, {
      disableDirectTcp: true,
      identityKeyPair: shId2,
      resolveTrustedPeerPublicKey: (id) => shTrusted.get(id) ?? null,
    });
    for (const [sid, tok, node] of [[full1Id, full1Token, n1], [full2Id, full2Token, n2]] as const) {
      node.emitter.on('message', (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        if (typeof parsed.type === 'string' && parsed.type.startsWith('port_forward.')) {
          router.handleDaemonMessage(sid, node.bridge.daemonConnectionGeneration(), parsed);
        }
      });
      node.bridge.handleDaemonConnection(node.emitter as never, db, {} as never);
      node.emitter.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId: sid, token: tok, daemonVersion: '0.1.2' })), false);
      for (let i = 0; i < 40 && !node.bridge.isDaemonConnected(); i++) await new Promise((r) => setTimeout(r, 10));
    }
    cleanups.push(async () => {
      await router.closeAllForUser('user_owner');
      n1.emitter.close();
      n2.emitter.close();
    });

    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = { DB: db, JWT_SIGNING_KEY: signingKey };
      await next();
    });
    app.route(PORT_FORWARD_API_PATH, createPortForwardRoutes(router));

    // All 4 routes MUST fail closed (403 target_forbidden) when authority header is absent on a shared host!
    const postAbsent = await app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: { 'X-Server-Id': full1Id, authorization: `Bearer ${full1Token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetNode: full2Id, targetPort: 8080, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(postAbsent.status).toBe(403);
    expect((await postAbsent.json() as { reason: string }).reason).toBe(PORT_FORWARD_ERRORS.TARGET_FORBIDDEN);

    const getAbsent = await app.request(PORT_FORWARD_API_PATH, {
      headers: { 'X-Server-Id': full1Id, authorization: `Bearer ${full1Token}` },
    });
    expect(getAbsent.status).toBe(403);

    const delOneAbsent = await app.request(`${PORT_FORWARD_API_PATH}/pf_missing`, {
      method: 'DELETE',
      headers: { 'X-Server-Id': full1Id, authorization: `Bearer ${full1Token}` },
    });
    expect(delOneAbsent.status).toBe(403);

    const delAllAbsent = await app.request(PORT_FORWARD_API_PATH, {
      method: 'DELETE',
      headers: { 'X-Server-Id': full1Id, authorization: `Bearer ${full1Token}` },
    });
    expect(delAllAbsent.status).toBe(403);

    // With valid signed owner turn authority header, all routes work normally!
    const ownerAuthJwt = issueOwnerMachineAuthority({
      type: OWNER_MACHINE_AUTHORITY_TYPE,
      sub: 'user_owner',
      sourceServerId: full1Id,
      sessionName: 'deck_owner_brain',
      projectName: 'demo-proj',
      actionId: 'act_pf_1',
    }, signingKey);

    const postAllowed = await app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': full1Id,
        authorization: `Bearer ${full1Token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerAuthJwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: full2Id, targetPort: 8080, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(postAllowed.status).toBe(200);
    const { tunnel } = await postAllowed.json() as { tunnel: { tunnelId: string } };

    const getAllowed = await app.request(PORT_FORWARD_API_PATH, {
      headers: {
        'X-Server-Id': full1Id,
        authorization: `Bearer ${full1Token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerAuthJwt,
      },
    });
    expect(getAllowed.status).toBe(200);
    expect((await getAllowed.json() as { tunnels: unknown[] }).tunnels).toHaveLength(1);

    const delOneAllowed = await app.request(`${PORT_FORWARD_API_PATH}/${tunnel.tunnelId}`, {
      method: 'DELETE',
      headers: {
        'X-Server-Id': full1Id,
        authorization: `Bearer ${full1Token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerAuthJwt,
      },
    });
    expect(delOneAllowed.status).toBe(200);

    const delAllAllowed = await app.request(PORT_FORWARD_API_PATH, {
      method: 'DELETE',
      headers: {
        'X-Server-Id': full1Id,
        authorization: `Bearer ${full1Token}`,
        [SHARED_MACHINE_AUTHORITY_HEADER]: ownerAuthJwt,
      },
    });
    expect(delAllAllowed.status).toBe(200);
  });

  it('settles openTunnel immediately on mid-PREPARE close, tears down on listen disconnect, and expires on TTL (P0 #5/#8)', async () => {
    const env = await setupTopology({ useLegacySilentTarget: true, prepareTimeoutMs: 5_000, closeAckTimeoutMs: 80 });
    const started = Date.now();
    const pendingOpen = env.router.openTunnel({
      userId: 'user_a',
      listenNode: env.full1Id,
      listenServerId: env.full1Id,
      listenPort: 0,
      targetNode: env.ctl2NodeId,
      targetServerId: env.ctl2Id,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.AUTO,
    });
    await new Promise((r) => setTimeout(r, 30));
    const closeRes = await env.router.closeAllForUser('user_a', undefined, 'user_abort');
    expect(closeRes.confirmed).toBe(false);
    expect(closeRes.unconfirmedTunnelIds).toHaveLength(1);
    const result = await pendingOpen;
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await env.router.listTunnels('user_a')).toHaveLength(0);

    // Listen-side disconnect tears down target engine cleanly + short TTL closes both sides.
    const healthy = await setupTopology({ useDefaultRouter: true });
    const resListenDrop = await healthy.app.request(PORT_FORWARD_API_PATH, {
      method: 'POST',
      headers: {
        'X-Server-Id': healthy.full1Id,
        authorization: `Bearer ${healthy.full1Token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ targetNode: healthy.ctl1NodeId, targetPort: 8080, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY }),
    });
    expect(resListenDrop.status).toBe(200);
    healthy.nodes.full1.emitter.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(await healthy.router.listTunnels('user_a')).toHaveLength(0);
    expect(healthy.nodes.ctl1.engine.listTunnels()).toHaveLength(0);

    // TTL auto-expiration closes router and engine cleanly.
    const ttlEnv = await setupTopology();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const ttlRes = await ttlEnv.router.openTunnel({
        userId: 'user_a',
        listenNode: ttlEnv.full2Id,
        listenServerId: ttlEnv.full2Id,
        listenPort: 0,
        targetNode: ttlEnv.ctl1NodeId,
        targetServerId: ttlEnv.ctl1Id,
        targetHost: '127.0.0.1',
        targetPort: 8080,
        ttlSeconds: PORT_FORWARD_LIMITS.MIN_TTL_SECONDS,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      });
      expect(ttlRes.ok).toBe(true);
      await vi.advanceTimersByTimeAsync((PORT_FORWARD_LIMITS.MIN_TTL_SECONDS + 1) * 1000);
      expect(await ttlEnv.router.listTunnels('user_a')).toHaveLength(0);
      expect(ttlEnv.nodes.full2.engine.listTunnels()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes cross-pod relay delivery under injected DB latency and bounds paused-pod queues (P0 #2/#4)', async () => {
    const bigPayload = Buffer.allocUnsafe(384 * 1024);
    for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = (i * 29 + 7) & 0xff;
    const expectedHash = createHash('sha256').update(bigPayload).digest('hex');

    const echoServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ len: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
      });
    });
    await new Promise<void>((r) => echoServer.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echoServer.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((r) => echoServer.close(() => r())));

    const baseStore = new InMemoryPortForwardClusterStore();
    let injectLatency = true;
    const origGetTunnel = baseStore.getTunnel.bind(baseStore);
    const origEnqueue = baseStore.enqueueBusMessage.bind(baseStore);
    let delayStep = 0;
    baseStore.getTunnel = async (tid) => {
      if (injectLatency) {
        // Odd calls delayed 18ms, even calls 2ms -> naive unserialized forwarding would reorder frames!
        const ms = (++delayStep % 2 === 1) ? 18 : 2;
        await new Promise((r) => setTimeout(r, ms));
      }
      return origGetTunnel(tid);
    };
    baseStore.enqueueBusMessage = async (podId, msg) => {
      if (injectLatency && (msg.kind === 'to_coordinator' || msg.kind === 'to_endpoint')) {
        const ms = (++delayStep % 2 === 1) ? 14 : 1;
        await new Promise((r) => setTimeout(r, ms));
      }
      return origEnqueue(podId, msg);
    };

    const suffix = Math.random().toString(36).slice(2, 8);
    const s1 = `ord_l_${suffix}`;
    const s2 = `ord_t_${suffix}`;
    const bridgesA = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesB = new Map<string, PortForwardBridgeEndpoint>();

    const podCoord = new PortForwardRouter({ podId: 'pod_c_ord', clusterStore: baseStore, prepareTimeoutMs: 5_000, establishTimeoutMs: 10_000 });
    const podA = new PortForwardRouter({ podId: 'pod_a_ord', clusterStore: baseStore, lookupBridge: (id) => bridgesA.get(id) });
    const podB = new PortForwardRouter({ podId: 'pod_b_ord', clusterStore: baseStore, lookupBridge: (id) => bridgesB.get(id) });

    const idA = generateEndpointIdentityKeyPair();
    const idB = generateEndpointIdentityKeyPair();
    const trusted = new Map([[s1, idA.publicKeyB64], [s2, idB.publicKeyB64]]);

    const engA = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idA,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podA.handleDaemonMessage(s1, 1, m)); },
    });
    const engB = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idB,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podB.handleDaemonMessage(s2, 1, m)); },
    });
    cleanups.push(async () => {
      injectLatency = false;
      await podCoord.closeAllForUser('user_ord');
      engA.closeAll();
      engB.closeAll();
      await podA.stopCluster();
      await podB.stopCluster();
      await podCoord.stopCluster();
    });

    bridgesA.set(s1, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engA.handleMessage(m); return true; },
    });
    bridgesB.set(s2, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engB.handleMessage(m); return true; },
    });
    podA.onDaemonConnected(s1, 1);
    podB.onDaemonConnected(s2, 1);

    // Under uneven DB delays, auto -> relay handshake and 384 KiB multi-frame POST arrive 100% in exact byte order!
    const opened = await podCoord.openTunnel({
      userId: 'user_ord',
      listenNode: s1,
      listenServerId: s1,
      listenPort: 0,
      targetNode: s2,
      targetServerId: s2,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.AUTO,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const postEcho = (port: number) => new Promise<{ len: number; sha256: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/echo', method: 'POST' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      req.on('error', reject);
      req.end(bigPayload);
    });
    expect(await postEcho(opened.tunnel.listenPort)).toEqual({ len: bigPayload.length, sha256: expectedHash });

    // P0 #4: Pause target pod queue drain mid-transfer -> backlog hits HIGH_WATER, propagates RELAY_BACKPRESSURE,
    // stays strictly <= CLUSTER_RELAY_HARD_CAP_BYTES, then recovers intact on resume!
    injectLatency = false;
    await baseStore.setPodDrainPausedForTests('pod_b_ord', true);
    const pausedPromise = postEcho(opened.tunnel.listenPort);

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const q = await baseStore.getQueuedBytes(opened.tunnel.tunnelId, 'l2t');
      expect(q).toBeLessThanOrEqual(PORT_FORWARD_LIMITS.CLUSTER_RELAY_HARD_CAP_BYTES);
      if (q >= PORT_FORWARD_LIMITS.CLUSTER_RELAY_HIGH_WATER_BYTES) break;
    }

    await new Promise((r) => setTimeout(r, 80));
    const peakQueued = await baseStore.getQueuedBytes(opened.tunnel.tunnelId, 'l2t');
    expect(peakQueued).toBeLessThanOrEqual(PORT_FORWARD_LIMITS.CLUSTER_RELAY_HARD_CAP_BYTES);

    await baseStore.setPodDrainPausedForTests('pod_b_ord', false);
    expect(await pausedPromise).toEqual({ len: bigPayload.length, sha256: expectedHash });

    // Orphan/close cleanup clears queued entries cleanly.
    await baseStore.setPodDrainPausedForTests('pod_b_ord', true);
    const overflowReject = await baseStore.enqueueBusMessage('pod_b_ord', {
      kind: 'to_endpoint',
      serverId: s2,
      expectedGeneration: 1,
      tunnelId: opened.tunnel.tunnelId,
      direction: 'l2t',
      frame: {
        type: PORT_FORWARD_MSG.RELAY_FRAME,
        tunnelId: opened.tunnel.tunnelId,
        data: Buffer.alloc(PORT_FORWARD_LIMITS.CLUSTER_RELAY_HARD_CAP_BYTES + 128, 0x41).toString('base64'),
      },
    });
    expect(overflowReject.ok).toBe(false);
    await podCoord.closeTunnelForUser('user_ord', opened.tunnel.tunnelId);
    expect(await baseStore.getQueuedBytes(opened.tunnel.tunnelId, 'l2t')).toBe(0);
    await baseStore.setPodDrainPausedForTests('pod_b_ord', false);
  });

  it('rejects close with 504 timeout when an online endpoint delays CLOSE_ACK, keeps tunnel retryable, and rebinds immediately once delivery resumes (P0 #2)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sListen = `close_l_${suffix}`;
    const sTarget = `close_t_${suffix}`;
    const store = new InMemoryPortForwardClusterStore();
    const listenBridges = new Map<string, PortForwardBridgeEndpoint>();
    const targetBridges = new Map<string, PortForwardBridgeEndpoint>();

    const podCoord = new PortForwardRouter({
      podId: 'pod_c_close',
      clusterStore: store,
      closeAckTimeoutMs: 60,
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const podListen = new PortForwardRouter({
      podId: 'pod_l_close',
      clusterStore: store,
      closeAckTimeoutMs: 60,
      lookupBridge: (id) => listenBridges.get(id),
    });
    const podTarget = new PortForwardRouter({
      podId: 'pod_t_close',
      clusterStore: store,
      closeAckTimeoutMs: 60,
      lookupBridge: (id) => targetBridges.get(id),
    });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sListen, idL.publicKeyB64], [sTarget, idT.publicKeyB64]]);

    const engListen = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podListen.handleDaemonMessage(sListen, 1, m)); },
    });
    const engTarget = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podTarget.handleDaemonMessage(sTarget, 1, m)); },
    });
    cleanups.push(async () => {
      engListen.closeAll();
      engTarget.closeAll();
      await podListen.stopCluster();
      await podTarget.stopCluster();
      await podCoord.stopCluster();
    });

    let dropCloseToListen = true;
    const delayedCloseFrames: Record<string, unknown>[] = [];
    listenBridges.set(sListen, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.CLOSE && dropCloseToListen) {
          delayedCloseFrames.push(m);
          return true; // WS accepted/delayed delivery, endpoint is still online!
        }
        void engListen.handleMessage(m);
        return true;
      },
    });
    targetBridges.set(sTarget, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engTarget.handleMessage(m); return true; },
    });
    podListen.onDaemonConnected(sListen, 1);
    podTarget.onDaemonConnected(sTarget, 1);

    const fixedProbe = createTcpServer();
    await new Promise<void>((r) => fixedProbe.listen(0, '127.0.0.1', () => r()));
    const fixedPort = (fixedProbe.address() as { port: number }).port;
    await new Promise<void>((r) => fixedProbe.close(() => r()));

    const opened = await podCoord.openTunnel({
      userId: 'user_close',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: fixedPort,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(engListen.listTunnels()).toHaveLength(1);

    // 1. Single-close from remote pod while CLOSE delivery to listen endpoint is delayed past closeAckTimeoutMs:
    //    MUST NOT return fake success (`confirmed: false`, status 504), and listener stays alive (`liveListenerCount === 1`).
    const firstClose = await podTarget.closeTunnelForUser('user_close', opened.tunnel.tunnelId);
    expect(firstClose.ok).toBe(false);
    if (!firstClose.ok) {
      expect(firstClose.status).toBe(504);
      expect(firstClose.reason).toBe(PORT_FORWARD_ERRORS.TIMEOUT);
      expect(firstClose.unconfirmedTunnelIds).toEqual([opened.tunnel.tunnelId]);
    }
    expect(engListen.listTunnels()).toHaveLength(1);
    expect(delayedCloseFrames.length).toBeGreaterThanOrEqual(1);

    // Bulk close ALSO reports unconfirmed timeout rather than fake closed=true.
    const bulkTimeout = await podTarget.closeAllForUser('user_close');
    expect(bulkTimeout.confirmed).toBe(false);
    expect(bulkTimeout.unconfirmedTunnelIds).toEqual([opened.tunnel.tunnelId]);
    expect(bulkTimeout.closedTunnelIds).toEqual([]);
    expect(engListen.listTunnels()).toHaveLength(1);

    // 2. Restore WS delivery and retry close -> confirmed, listener count drops to 0, immediate fixed-port rebind succeeds!
    dropCloseToListen = false;
    const retryClose = await podTarget.closeTunnelForUser('user_close', opened.tunnel.tunnelId);
    expect(retryClose).toEqual({ ok: true, closedTunnelIds: [opened.tunnel.tunnelId] });
    expect(engListen.listTunnels()).toHaveLength(0);

    const rebound = await podCoord.openTunnel({
      userId: 'user_close',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: fixedPort,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(rebound.ok).toBe(true);
    if (rebound.ok) {
      expect(rebound.tunnel.listenPort).toBe(fixedPort);
      await podCoord.closeTunnelForUser('user_close', rebound.tunnel.tunnelId);
    }

    // 3. Also verify a live target still in PREPARE (!targetReady) is NOT treated as offline during close.
    let dropTargetAll = true;
    targetBridges.set(sTarget, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (dropTargetAll) return true;
        void engTarget.handleMessage(m);
        return true;
      },
    });
    const pendingMid = podCoord.openTunnel({
      userId: 'user_close',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: 0,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    await new Promise((r) => setTimeout(r, 25));
    const listBefore = await podCoord.closeAllForUser('user_close');
    expect(listBefore.confirmed).toBe(false);
    expect(listBefore.unconfirmedTunnelIds).toHaveLength(1);
    expect(engListen.listTunnels()).toHaveLength(0);
    dropTargetAll = false;
    const retryMid = await podCoord.closeAllForUser('user_close');
    expect(retryMid.confirmed).toBe(true);
    expect(retryMid.closedTunnelIds).toHaveLength(1);
    const midRes = await pendingMid;
    expect(midRes.ok).toBe(false);
  });

  it('bounds in-process ingress FIFO before blocked DB enqueue, propagates backpressure, and closes cleanly on overflow (P0 #3)', async () => {
    const baseStore = new InMemoryPortForwardClusterStore();
    const origEnqueue = baseStore.enqueueBusMessage.bind(baseStore);
    let gateResolve: (() => void) | null = null;
    let blockHop1Db = false;

    baseStore.enqueueBusMessage = async (podId, msg) => {
      if (blockHop1Db && msg.kind === 'to_coordinator' && msg.frame.type === PORT_FORWARD_MSG.RELAY_FRAME) {
        await new Promise<void>((resolve) => {
          const prev = gateResolve;
          gateResolve = () => {
            prev?.();
            resolve();
          };
        });
      }
      return origEnqueue(podId, msg);
    };

    const suffix = Math.random().toString(36).slice(2, 8);
    const s1 = `bp_l_${suffix}`;
    const s2 = `bp_t_${suffix}`;
    const senderEvents: Array<Record<string, unknown>> = [];
    const targetEvents: Array<Record<string, unknown>> = [];
    const bridgesA = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesB = new Map<string, PortForwardBridgeEndpoint>();

    const podCoord = new PortForwardRouter({ podId: 'pod_c_bp', clusterStore: baseStore, prepareTimeoutMs: 2_000, establishTimeoutMs: 4_000 });
    const podA = new PortForwardRouter({ podId: 'pod_a_bp', clusterStore: baseStore, lookupBridge: (id) => bridgesA.get(id) });
    const podB = new PortForwardRouter({ podId: 'pod_b_bp', clusterStore: baseStore, lookupBridge: (id) => bridgesB.get(id) });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[s1, idL.publicKeyB64], [s2, idT.publicKeyB64]]);

    const engL = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podA.handleDaemonMessage(s1, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podB.handleDaemonMessage(s2, 1, m)); },
    });
    cleanups.push(async () => {
      gateResolve?.();
      engL.closeAll();
      engT.closeAll();
      await podA.stopCluster();
      await podB.stopCluster();
      await podCoord.stopCluster();
    });

    bridgesA.set(s1, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        senderEvents.push(m);
        void engL.handleMessage(m);
        return true;
      },
    });
    bridgesB.set(s2, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        targetEvents.push(m);
        void engT.handleMessage(m);
        return true;
      },
    });
    podA.onDaemonConnected(s1, 1);
    podB.onDaemonConnected(s2, 1);

    const opened = await podCoord.openTunnel({
      userId: 'user_bp',
      listenNode: s1,
      listenServerId: s1,
      listenPort: 0,
      targetNode: s2,
      targetServerId: s2,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const tid = opened.tunnel.tunnelId;

    // 1. Block hop-1 DB enqueue completely; push valid multi-frame burst crossing HIGH_WATER while DB is blocked ->
    //    ingress FIFO MUST synchronously fire RELAY_BACKPRESSURE { paused: true } without waiting on DB!
    blockHop1Db = true;
    senderEvents.length = 0;
    const chunkB64 = Buffer.alloc(32 * 1024, 0x5a).toString('base64');
    for (let i = 0; i < 16; i++) {
      podA.handleDaemonMessage(s1, 1, {
        type: PORT_FORWARD_MSG.RELAY_FRAME,
        tunnelId: tid,
        data: chunkB64,
      });
    }
    expect(senderEvents.some((m) => m.type === PORT_FORWARD_MSG.RELAY_BACKPRESSURE && m.paused === true)).toBe(true);

    // Release DB gate and allow drain below LOW_WATER -> emits RELAY_BACKPRESSURE { paused: false }!
    blockHop1Db = false;
    const releaseFirst = gateResolve;
    gateResolve = null;
    releaseFirst?.();
    await new Promise((r) => setTimeout(r, 80));
    expect(senderEvents.some((m) => m.type === PORT_FORWARD_MSG.RELAY_BACKPRESSURE && m.paused === false)).toBe(true);

    // 2. Block hop-1 DB enqueue again and push valid multi-frame burst exceeding HARD_CAP -> bounded overflow immediately
    //    closes tunnel (BOTH endpoints receive CLOSE; no silent dropped frame hanging until TTL!).
    blockHop1Db = true;
    senderEvents.length = 0;
    targetEvents.length = 0;
    for (let i = 0; i < 64; i++) {
      podA.handleDaemonMessage(s1, 1, {
        type: PORT_FORWARD_MSG.RELAY_FRAME,
        tunnelId: tid,
        data: chunkB64,
      });
    }
    blockHop1Db = false;
    gateResolve?.();
    gateResolve = null;
    await new Promise((r) => setTimeout(r, 100));
    expect(senderEvents.some((m) => m.type === PORT_FORWARD_MSG.CLOSE && m.reason === 'ingress_queue_overflow')).toBe(true);
    expect(targetEvents.some((m) => m.type === PORT_FORWARD_MSG.CLOSE && m.reason === 'ingress_queue_overflow')).toBe(true);
    expect(await podCoord.listTunnels('user_bp')).toHaveLength(0);
    expect(engL.listTunnels()).toHaveLength(0);
    expect(engT.listTunnels()).toHaveLength(0);
  });

  it('never reports close confirmed on live WS send rejection or cross-pod DB enqueue throw, succeeding only on ACK or real disconnect (R4 P0 #1)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sListen = `r4c_l_${suffix}`;
    const sTarget = `r4c_t_${suffix}`;
    const baseStore = new InMemoryPortForwardClusterStore();
    const origEnqueue = baseStore.enqueueBusMessage.bind(baseStore);
    let failRemoteCloseEnqueue = false;
    baseStore.enqueueBusMessage = async (podId, msg) => {
      if (failRemoteCloseEnqueue && msg.kind === 'to_endpoint' && msg.frame.type === PORT_FORWARD_MSG.CLOSE) {
        throw new Error('simulated_db_bus_enqueue_failure');
      }
      return origEnqueue(podId, msg);
    };

    const bridgesListen = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesTarget = new Map<string, PortForwardBridgeEndpoint>();
    const podCoord = new PortForwardRouter({
      podId: 'pod_r4_c',
      clusterStore: baseStore,
      closeAckTimeoutMs: 60,
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
      lookupBridge: (id) => bridgesListen.get(id),
    });
    const podTarget = new PortForwardRouter({
      podId: 'pod_r4_t',
      clusterStore: baseStore,
      closeAckTimeoutMs: 60,
      lookupBridge: (id) => bridgesTarget.get(id),
    });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sListen, idL.publicKeyB64], [sTarget, idT.publicKeyB64]]);

    const engL = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podCoord.handleDaemonMessage(sListen, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podTarget.handleDaemonMessage(sTarget, 1, m)); },
    });
    cleanups.push(async () => {
      failRemoteCloseEnqueue = false;
      engL.closeAll();
      engT.closeAll();
      await podTarget.stopCluster();
      await podCoord.stopCluster();
    });

    let rejectListenCloseWrite = false;
    let listenConnected = true;
    bridgesListen.set(sListen, {
      isDaemonConnected: () => listenConnected,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.CLOSE && rejectListenCloseWrite) return false;
        void engL.handleMessage(m);
        return true;
      },
    });
    bridgesTarget.set(sTarget, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engT.handleMessage(m); return true; },
    });
    podCoord.onDaemonConnected(sListen, 1);
    podTarget.onDaemonConnected(sTarget, 1);

    const openOne = async () => {
      const opened = await podCoord.openTunnel({
        userId: 'user_r4_close',
        listenNode: sListen,
        listenServerId: sListen,
        listenPort: 0,
        targetNode: sTarget,
        targetServerId: sTarget,
        targetHost: '127.0.0.1',
        targetPort: 9999,
        ttlSeconds: 60,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error);
      return opened.tunnel.tunnelId;
    };

    // Case 1: Live listen bridge rejects CLOSE write (returns false while connected) -> 504 unconfirmed, liveListenerCount === 1!
    const tid1 = await openOne();
    rejectListenCloseWrite = true;
    const liveRejectClose = await podCoord.closeTunnelForUser('user_r4_close', tid1);
    expect(liveRejectClose.ok).toBe(false);
    if (!liveRejectClose.ok) {
      expect(liveRejectClose.status).toBe(504);
      expect(liveRejectClose.unconfirmedTunnelIds).toEqual([tid1]);
    }
    expect(engL.listTunnels()).toHaveLength(1);

    // Case 2: Cross-pod enqueueBusMessage throws on CLOSE -> 504 unconfirmed as well; retry once both recover succeeds cleanly!
    rejectListenCloseWrite = false;
    failRemoteCloseEnqueue = true;
    const tid2 = await openOne();
    const enqueueErrClose = await podCoord.closeTunnelForUser('user_r4_close', tid2);
    expect(enqueueErrClose.ok).toBe(false);
    if (!enqueueErrClose.ok) {
      expect(enqueueErrClose.status).toBe(504);
      expect(enqueueErrClose.unconfirmedTunnelIds).toEqual([tid2]);
    }
    expect(engL.listTunnels().map((t) => t.tunnelId)).toEqual([tid1]);
    expect(engT.listTunnels().map((t) => t.tunnelId)).toEqual([tid2]);

    failRemoteCloseEnqueue = false;
    expect(await podCoord.closeTunnelForUser('user_r4_close', tid1)).toEqual({ ok: true, closedTunnelIds: [tid1] });
    expect(await podCoord.closeTunnelForUser('user_r4_close', tid2)).toEqual({ ok: true, closedTunnelIds: [tid2] });
    expect(engL.listTunnels()).toHaveLength(0);
    expect(engT.listTunnels()).toHaveLength(0);

    // Case 3: Genuine disconnect on listen side (`isDaemonConnected() === false`) is provably offline and settles close cleanly.
    const tid3 = await openOne();
    rejectListenCloseWrite = true;
    listenConnected = false;
    const offlineClose = await podCoord.closeTunnelForUser('user_r4_close', tid3);
    expect(offlineClose).toEqual({ ok: true, closedTunnelIds: [tid3] });
    expect(engT.listTunnels()).toHaveLength(0);
  });

  it('rejects unauthorized or stale-generation RELAY_FRAME/CLOSE bursts before touching queues, backpressure, or tunnel state (R4 P0 #2)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sListen = `r4a_l_${suffix}`;
    const sTarget = `r4a_t_${suffix}`;
    const sRogue = `r4a_rogue_${suffix}`;
    const echoServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((r) => echoServer.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echoServer.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((r) => echoServer.close(() => r())));

    const store = new InMemoryPortForwardClusterStore();
    const bridgesA = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesB = new Map<string, PortForwardBridgeEndpoint>();
    const podCoord = new PortForwardRouter({ podId: 'pod_r4a_c', clusterStore: store, prepareTimeoutMs: 2_000, establishTimeoutMs: 4_000 });
    const podA = new PortForwardRouter({ podId: 'pod_r4a_a', clusterStore: store, lookupBridge: (id) => bridgesA.get(id) });
    const podB = new PortForwardRouter({ podId: 'pod_r4a_b', clusterStore: store, lookupBridge: (id) => bridgesB.get(id) });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sListen, idL.publicKeyB64], [sTarget, idT.publicKeyB64]]);
    const engL = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podA.handleDaemonMessage(sListen, 5, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podB.handleDaemonMessage(sTarget, 7, m)); },
    });
    cleanups.push(async () => {
      await podCoord.closeAllForUser('user_r4_auth').catch(() => {});
      engL.closeAll();
      engT.closeAll();
      await podA.stopCluster();
      await podB.stopCluster();
      await podCoord.stopCluster();
    });

    const listenCtrlEvents: Array<Record<string, unknown>> = [];
    bridgesA.set(sListen, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 5,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.RELAY_BACKPRESSURE || m.type === PORT_FORWARD_MSG.CLOSE) {
          listenCtrlEvents.push(m);
        }
        void engL.handleMessage(m);
        return true;
      },
    });
    bridgesB.set(sTarget, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 7,
      trySendPortForward: (m) => { void engT.handleMessage(m); return true; },
    });
    podA.onDaemonConnected(sListen, 5);
    podB.onDaemonConnected(sTarget, 7);

    const opened = await podCoord.openTunnel({
      userId: 'user_r4_auth',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: 0,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const tid = opened.tunnel.tunnelId;
    listenCtrlEvents.length = 0;

    // Attack 1: Unrelated rogue node floods oversized RELAY_FRAME burst & forged CLOSE on BOTH remote podA and coordinator podCoord.
    const bigBurst = Buffer.alloc(32 * 1024, 0x71).toString('base64');
    for (let i = 0; i < 64; i++) {
      podA.handleDaemonMessage(sRogue, 1, { type: PORT_FORWARD_MSG.RELAY_FRAME, tunnelId: tid, data: bigBurst });
      podCoord.handleDaemonMessage(sRogue, 1, { type: PORT_FORWARD_MSG.RELAY_FRAME, tunnelId: tid, data: bigBurst });
    }
    podA.handleDaemonMessage(sRogue, 1, { type: PORT_FORWARD_MSG.CLOSE, tunnelId: tid, role: 'listen' });
    podCoord.handleDaemonMessage(sRogue, 1, { type: PORT_FORWARD_MSG.CLOSE, tunnelId: tid, role: 'listen' });

    // Attack 2: Stale generation on listen server (gen=4 != gen=5) floods RELAY_FRAME burst & CLOSE.
    for (let i = 0; i < 64; i++) {
      podA.handleDaemonMessage(sListen, 4, { type: PORT_FORWARD_MSG.RELAY_FRAME, tunnelId: tid, data: bigBurst });
      podCoord.handleDaemonMessage(sListen, 4, { type: PORT_FORWARD_MSG.RELAY_FRAME, tunnelId: tid, data: bigBurst });
    }
    podA.handleDaemonMessage(sListen, 4, { type: PORT_FORWARD_MSG.CLOSE, tunnelId: tid, role: 'listen' });

    await new Promise((r) => setTimeout(r, 60));
    expect(listenCtrlEvents).toEqual([]);
    expect(await podCoord.listTunnels('user_r4_auth')).toHaveLength(1);
    expect(engL.listTunnels()).toHaveLength(1);

    // Legitimate traffic still flows intact!
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: opened.tunnel.listenPort, path: '/', method: 'POST' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end('auth-guard-intact');
    });
    expect(echoed).toBe('auth-guard-intact');
  });

  it('retries transient hop-1 SQL errors in order and explicitly aborts tunnel on persistent enqueue failure or unconsumed row expiry (R4 P0 #3)', async () => {
    const echoServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((r) => echoServer.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echoServer.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((r) => echoServer.close(() => r())));

    const suffix = Math.random().toString(36).slice(2, 8);
    const s1 = `r4d_l_${suffix}`;
    const s2 = `r4d_t_${suffix}`;
    const baseStore = new InMemoryPortForwardClusterStore();
    const origEnqueue = baseStore.enqueueBusMessage.bind(baseStore);
    let failCountRemaining = 0;
    let persistentHop1Fail = false;

    baseStore.enqueueBusMessage = async (podId, msg) => {
      if (msg.kind === 'to_coordinator' && msg.frame.type === PORT_FORWARD_MSG.RELAY_FRAME) {
        if (persistentHop1Fail) {
          throw new Error('persistent_sql_failure');
        }
        if (failCountRemaining > 0) {
          failCountRemaining -= 1;
          throw new Error('transient_sql_failure');
        }
      }
      return origEnqueue(podId, msg);
    };

    const bridgesA = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesB = new Map<string, PortForwardBridgeEndpoint>();
    const podCoord = new PortForwardRouter({ podId: 'pod_r4d_c', clusterStore: baseStore, prepareTimeoutMs: 2_000, establishTimeoutMs: 4_000 });
    const podA = new PortForwardRouter({ podId: 'pod_r4d_a', clusterStore: baseStore, lookupBridge: (id) => bridgesA.get(id) });
    const podB = new PortForwardRouter({ podId: 'pod_r4d_b', clusterStore: baseStore, lookupBridge: (id) => bridgesB.get(id) });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[s1, idL.publicKeyB64], [s2, idT.publicKeyB64]]);
    const engL = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podA.handleDaemonMessage(s1, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podB.handleDaemonMessage(s2, 1, m)); },
    });
    cleanups.push(async () => {
      persistentHop1Fail = false;
      failCountRemaining = 0;
      await podCoord.closeAllForUser('user_r4_data').catch(() => {});
      engL.closeAll();
      engT.closeAll();
      await podA.stopCluster();
      await podB.stopCluster();
      await podCoord.stopCluster();
    });

    bridgesA.set(s1, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engL.handleMessage(m); return true; },
    });
    bridgesB.set(s2, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engT.handleMessage(m); return true; },
    });
    podA.onDaemonConnected(s1, 1);
    podB.onDaemonConnected(s2, 1);

    const opened = await podCoord.openTunnel({
      userId: 'user_r4_data',
      listenNode: s1,
      listenServerId: s1,
      listenPort: 0,
      targetNode: s2,
      targetServerId: s2,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      ttlSeconds: 1800,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // 1. Transient hop-1 failure (2 errors before succeeding) MUST retry cleanly & deliver complete payload in exact byte order!
    failCountRemaining = 2;
    const payload = randomBytes(192 * 1024);
    const postPayload = (port: number) => new Promise<Buffer>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end(payload);
    });
    const echoed = await postPayload(opened.tunnel.listenPort);
    expect(echoed.equals(payload)).toBe(true);

    // 2. Persistent hop-1 SQL failure MUST explicitly abort/close the tunnel instead of silently dropping frames until 30m TTL!
    persistentHop1Fail = true;
    await expect(postPayload(opened.tunnel.listenPort)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 150));
    expect(engL.listTunnels()).toHaveLength(0);
    expect(engT.listTunnels()).toHaveLength(0);
    expect(await podCoord.listTunnels('user_r4_data')).toHaveLength(0);
    persistentHop1Fail = false;

    // 3. Expired unconsumed relay data row during reclaimStaleMessages MUST notify coordinator to close active tunnel!
    const opened2 = await podCoord.openTunnel({
      userId: 'user_r4_data',
      listenNode: s1,
      listenServerId: s1,
      listenPort: 0,
      targetNode: s2,
      targetServerId: s2,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      ttlSeconds: 1800,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened2.ok).toBe(true);
    if (!opened2.ok) return;
    await baseStore.setPodDrainPausedForTests('pod_r4d_c', true);
    await origEnqueue('pod_r4d_c', {
      kind: 'to_coordinator',
      tunnelId: opened2.tunnel.tunnelId,
      fromServerId: s1,
      fromGeneration: 1,
      direction: 'l2t',
      frame: {
        type: PORT_FORWARD_MSG.RELAY_FRAME,
        tunnelId: opened2.tunnel.tunnelId,
        data: Buffer.from('will-expire').toString('base64'),
      },
    });
    // Advance clock past CLUSTER_RELAY_MSG_TTL_MS when reclaiming -> expires queued relay frame & triggers close!
    const reclaimed = await baseStore.reclaimStaleMessages(Date.now() + PORT_FORWARD_LIMITS.CLUSTER_RELAY_MSG_TTL_MS + 10);
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    await baseStore.setPodDrainPausedForTests('pod_r4d_c', false);
    await new Promise((r) => setTimeout(r, 80));
    expect(engL.listTunnels()).toHaveLength(0);
    expect(engT.listTunnels()).toHaveLength(0);
    expect(await podCoord.listTunnels('user_r4_data')).toHaveLength(0);
  });

  it('retries transient hop-2 live WS write rejection in order and aborts explicitly on persistent rejection (R5 P0 #1)', async () => {
    const echoServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((r) => echoServer.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echoServer.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((r) => echoServer.close(() => r())));

    const suffix = Math.random().toString(36).slice(2, 8);
    const sL = `r5h2_l_${suffix}`;
    const sT = `r5h2_t_${suffix}`;
    const store = new InMemoryPortForwardClusterStore();
    const bridgesL = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesT = new Map<string, PortForwardBridgeEndpoint>();
    const podCoord = new PortForwardRouter({ podId: 'pod_r5h2_c', clusterStore: store, prepareTimeoutMs: 2_000, establishTimeoutMs: 4_000 });
    const podL = new PortForwardRouter({ podId: 'pod_r5h2_l', clusterStore: store, lookupBridge: (id) => bridgesL.get(id) });
    const podT = new PortForwardRouter({ podId: 'pod_r5h2_t', clusterStore: store, lookupBridge: (id) => bridgesT.get(id) });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sL, idL.publicKeyB64], [sT, idT.publicKeyB64]]);
    const engL = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podL.handleDaemonMessage(sL, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podT.handleDaemonMessage(sT, 1, m)); },
    });
    cleanups.push(async () => {
      await podCoord.closeAllForUser('user_r5_h2').catch(() => {});
      engL.closeAll();
      engT.closeAll();
      await podL.stopCluster();
      await podT.stopCluster();
      await podCoord.stopCluster();
    });

    let rejectTargetWriteCount = 0;
    let persistentTargetReject = false;
    let actualRejected = 0;

    bridgesL.set(sL, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engL.handleMessage(m); return true; },
    });
    bridgesT.set(sT, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.RELAY_FRAME && (persistentTargetReject || rejectTargetWriteCount > 0)) {
          if (rejectTargetWriteCount > 0) rejectTargetWriteCount -= 1;
          actualRejected += 1;
          return false; // live WS rejects write while connected!
        }
        void engT.handleMessage(m);
        return true;
      },
    });
    podL.onDaemonConnected(sL, 1);
    podT.onDaemonConnected(sT, 1);

    const opened = await podCoord.openTunnel({
      userId: 'user_r5_h2',
      listenNode: sL,
      listenServerId: sL,
      listenPort: 0,
      targetNode: sT,
      targetServerId: sT,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      ttlSeconds: 1800,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const postBuf = (port: number, body: Buffer) => new Promise<Buffer>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end(body);
    });

    // Warmup succeeds cleanly.
    const warmup = await postBuf(opened.tunnel.listenPort, Buffer.from('warmup'));
    expect(warmup.toString('utf8')).toBe('warmup');

    // Case 1: Inject SINGLE live WS write rejection on target bridge -> MUST retry & deliver complete payload cleanly!
    rejectTargetWriteCount = 1;
    const payload = randomBytes(128 * 1024);
    const echoed = await postBuf(opened.tunnel.listenPort, payload);
    expect(actualRejected).toBe(1);
    expect(echoed.equals(payload)).toBe(true);
    expect(engL.listTunnels()).toHaveLength(1);
    expect(engT.listTunnels()).toHaveLength(1);
    expect(await podCoord.listTunnels('user_r5_h2')).toHaveLength(1);

    // Case 2: Persistent hop-2 write rejection on live bridge MUST abort/close tunnel explicitly rather than stalling!
    persistentTargetReject = true;
    await expect(postBuf(opened.tunnel.listenPort, Buffer.from('fail-closed'))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 120));
    expect(engL.listTunnels()).toHaveLength(0);
    expect(engT.listTunnels()).toHaveLength(0);
    expect(await podCoord.listTunnels('user_r5_h2')).toHaveLength(0);
  });

  it('binds tunnels strictly to (podId, generation) so a same-generation replacement on another pod cannot hijack close or ACK while old listener stays bound (R5 P0 #2)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sListen = `r5p_l_${suffix}`;
    const sTarget = `r5p_t_${suffix}`;
    const store = new InMemoryPortForwardClusterStore();
    const bridgesA = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesB = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesT = new Map<string, PortForwardBridgeEndpoint>();

    const podCoord = new PortForwardRouter({
      podId: 'pod_r5p_c',
      clusterStore: store,
      closeAckTimeoutMs: 60,
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const podA = new PortForwardRouter({ podId: 'pod_r5p_a', clusterStore: store, lookupBridge: (id) => bridgesA.get(id) });
    const podB = new PortForwardRouter({ podId: 'pod_r5p_b', clusterStore: store, lookupBridge: (id) => bridgesB.get(id) });
    const podT = new PortForwardRouter({ podId: 'pod_r5p_t', clusterStore: store, lookupBridge: (id) => bridgesT.get(id) });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sListen, idL.publicKeyB64], [sTarget, idT.publicKeyB64]]);

    const engA = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podA.handleDaemonMessage(sListen, 1, m)); },
    });
    const engB = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podB.handleDaemonMessage(sListen, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podT.handleDaemonMessage(sTarget, 1, m)); },
    });
    cleanups.push(async () => {
      engA.closeAll();
      engB.closeAll();
      engT.closeAll();
      await podA.stopCluster();
      await podB.stopCluster();
      await podT.stopCluster();
      await podCoord.stopCluster();
    });

    let podAConnected = true;
    let rejectCloseOnPodA = true;
    let podBCloseReceived = 0;

    bridgesA.set(sListen, {
      isDaemonConnected: () => podAConnected,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.CLOSE && rejectCloseOnPodA) return false;
        void engA.handleMessage(m);
        return true;
      },
    });
    bridgesB.set(sListen, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.CLOSE) podBCloseReceived += 1;
        void engB.handleMessage(m);
        return true;
      },
    });
    bridgesT.set(sTarget, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engT.handleMessage(m); return true; },
    });
    podA.onDaemonConnected(sListen, 1);
    podT.onDaemonConnected(sTarget, 1);

    const fixedProbe = createTcpServer();
    await new Promise<void>((r) => fixedProbe.listen(0, '127.0.0.1', () => r()));
    const fixedPort = (fixedProbe.address() as { port: number }).port;
    await new Promise<void>((r) => fixedProbe.close(() => r()));

    const opened = await podCoord.openTunnel({
      userId: 'user_r5_pod',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: fixedPort,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const tid = opened.tunnel.tunnelId;
    expect(engA.listTunnels()).toHaveLength(1);

    // Same serverId connects on ANOTHER Pod (podB) with the EXACT SAME local numeric generation (1),
    // overwriting port_forward_endpoints(sListen) -> { podId: 'pod_r5p_b', generation: 1 } while engA stays alive!
    podB.onDaemonConnected(sListen, 1);

    // Even if podB disconnects, it MUST NOT tear down podA's tunnel!
    podB.onDaemonDisconnected(sListen, 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(engA.listTunnels()).toHaveLength(1);
    podB.onDaemonConnected(sListen, 1);

    // Even if engB on podB attempts to spoof CLOSE_ACK for tid, podA's tunnel MUST NOT close!
    podB.handleDaemonMessage(sListen, 1, {
      type: PORT_FORWARD_MSG.CLOSE_ACK,
      tunnelId: tid,
      role: 'listen',
    });

    // Close while podA rejects CLOSE delivery MUST return 504 TIMEOUT, MUST NEVER deliver CLOSE to podB,
    // and engA's listener MUST stay bound on fixedPort!
    const unconfirmed = await podCoord.closeTunnelForUser('user_r5_pod', tid);
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) {
      expect(unconfirmed.status).toBe(504);
      expect(unconfirmed.unconfirmedTunnelIds).toEqual([tid]);
    }
    expect(podBCloseReceived).toBe(0);
    expect(engA.listTunnels()).toHaveLength(1);

    // Restore delivery on original podA -> retry close now closes engA cleanly & allows immediate rebind!
    rejectCloseOnPodA = false;
    const confirmed = await podCoord.closeTunnelForUser('user_r5_pod', tid);
    expect(confirmed).toEqual({ ok: true, closedTunnelIds: [tid] });
    expect(podBCloseReceived).toBe(0);
    expect(engA.listTunnels()).toHaveLength(0);

    // Also verify when podA genuinely disconnects (`isDaemonConnected() === false`) even after podB replaced DB endpoint:
    // close cleanly settles 'offline' rather than asking podB!
    podAConnected = true;
    podA.onDaemonConnected(sListen, 1);
    const opened2 = await podCoord.openTunnel({
      userId: 'user_r5_pod',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: fixedPort,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened2.ok).toBe(true);
    if (!opened2.ok) return;
    podB.onDaemonConnected(sListen, 1);
    podAConnected = false;
    rejectCloseOnPodA = true;
    const offlineOk = await podCoord.closeTunnelForUser('user_r5_pod', opened2.tunnel.tunnelId);
    expect(offlineOk).toEqual({ ok: true, closedTunnelIds: [opened2.tunnel.tunnelId] });
    expect(podBCloseReceived).toBe(0);
    expect(engT.listTunnels()).toHaveLength(0);
  });

  it('cancels queued hop-2 relay backlog and late bus RELAY_FRAMEs immediately upon CLOSE with zero post-close writes (R6 P0 #1)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sL = `r6c_l_${suffix}`;
    const sT = `r6c_t_${suffix}`;
    const store = new InMemoryPortForwardClusterStore();
    const bridgesL = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesT = new Map<string, PortForwardBridgeEndpoint>();

    const podCoord = new PortForwardRouter({
      podId: 'pod_r6c_c',
      clusterStore: store,
      closeAckTimeoutMs: 120,
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const podL = new PortForwardRouter({ podId: 'pod_r6c_l', clusterStore: store, lookupBridge: (id) => bridgesL.get(id) });
    const podT = new PortForwardRouter({ podId: 'pod_r6c_t', clusterStore: store, lookupBridge: (id) => bridgesT.get(id) });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sL, idL.publicKeyB64], [sT, idT.publicKeyB64]]);

    const engL = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podL.handleDaemonMessage(sL, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podT.handleDaemonMessage(sT, 1, m)); },
    });
    cleanups.push(async () => {
      await podCoord.closeAllForUser('user_r6_cancel').catch(() => {});
      engL.closeAll();
      engT.closeAll();
      await podL.stopCluster();
      await podT.stopCluster();
      await podCoord.stopCluster();
    });

    let rejectTargetRelay = false;
    let closeDelivered = false;
    let relayWritesAfterClose = 0;

    bridgesL.set(sL, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engL.handleMessage(m); return true; },
    });
    bridgesT.set(sT, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.CLOSE) {
          closeDelivered = true;
          void engT.handleMessage(m);
          return true;
        }
        if (m.type === PORT_FORWARD_MSG.RELAY_FRAME) {
          if (closeDelivered) {
            relayWritesAfterClose += 1;
            return true;
          }
          if (rejectTargetRelay) {
            return false; // force in-flight retry backoff while next frames queue!
          }
        }
        void engT.handleMessage(m);
        return true;
      },
    });
    podL.onDaemonConnected(sL, 1);
    podT.onDaemonConnected(sT, 1);

    const opened = await podCoord.openTunnel({
      userId: 'user_r6_cancel',
      listenNode: sL,
      listenServerId: sL,
      listenPort: 0,
      targetNode: sT,
      targetServerId: sT,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 1800,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const tid = opened.tunnel.tunnelId;

    // 1. Trigger in-flight retry on frame #1 + queue frames #2..#5 behind it on podT's remoteDeliveryQueues.
    rejectTargetRelay = true;
    const fakeData = Buffer.from('queued-relay-chunk').toString('base64');
    for (let i = 0; i < 5; i++) {
      await store.enqueueBusMessage('pod_r6c_t', {
        kind: 'to_endpoint',
        serverId: sT,
        expectedPodId: 'pod_r6c_t',
        expectedGeneration: 1,
        tunnelId: tid,
        direction: 'l2t',
        coordinatorPodId: 'pod_r6c_c',
        frame: { type: PORT_FORWARD_MSG.RELAY_FRAME, tunnelId: tid, data: fakeData },
      });
    }
    await new Promise((r) => setTimeout(r, 8));

    // 2. Deliver CLOSE to podT -> must immediately abort retry timer & purge backlog, even if bridge recovers!
    const closeRes = await podCoord.closeTunnelForUser('user_r6_cancel', tid);
    expect(closeRes).toEqual({ ok: true, closedTunnelIds: [tid] });
    expect(closeDelivered).toBe(true);
    rejectTargetRelay = false;

    // 3. Even if a late stale bus RELAY_FRAME for the closed tunnel arrives afterwards, it is dropped cleanly!
    await store.enqueueBusMessage('pod_r6c_t', {
      kind: 'to_endpoint',
      serverId: sT,
      expectedPodId: 'pod_r6c_t',
      expectedGeneration: 1,
      tunnelId: tid,
      direction: 'l2t',
      coordinatorPodId: 'pod_r6c_c',
      frame: { type: PORT_FORWARD_MSG.RELAY_FRAME, tunnelId: tid, data: fakeData },
    });

    await new Promise((r) => setTimeout(r, 280));
    expect(relayWritesAfterClose).toBe(0);
  });

  it('adopts recovery close onto original bound pods when coordinator is dead even after another pod overwrote presence with the same generation (R6 P0 #2)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sListen = `r6f_l_${suffix}`;
    const sTarget = `r6f_t_${suffix}`;
    const store = new InMemoryPortForwardClusterStore();
    const bridgesA = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesB = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesT = new Map<string, PortForwardBridgeEndpoint>();

    const podCoord = new PortForwardRouter({
      podId: 'pod_r6f_coord',
      clusterStore: store,
      closeAckTimeoutMs: 60,
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const podA = new PortForwardRouter({ podId: 'pod_r6f_a', clusterStore: store, lookupBridge: (id) => bridgesA.get(id), closeAckTimeoutMs: 60 });
    const podB = new PortForwardRouter({ podId: 'pod_r6f_b', clusterStore: store, lookupBridge: (id) => bridgesB.get(id), closeAckTimeoutMs: 60 });
    const podT = new PortForwardRouter({ podId: 'pod_r6f_t', clusterStore: store, lookupBridge: (id) => bridgesT.get(id), closeAckTimeoutMs: 60 });
    const podFallback = new PortForwardRouter({
      podId: 'pod_r6f_fb',
      clusterStore: store,
      closeAckTimeoutMs: 60,
    });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sListen, idL.publicKeyB64], [sTarget, idT.publicKeyB64]]);

    const engA = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podA.handleDaemonMessage(sListen, 1, m)); },
    });
    const engB = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podB.handleDaemonMessage(sListen, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podT.handleDaemonMessage(sTarget, 1, m)); },
    });
    cleanups.push(async () => {
      engA.closeAll();
      engB.closeAll();
      engT.closeAll();
      await podA.stopCluster();
      await podB.stopCluster();
      await podT.stopCluster();
      await podFallback.stopCluster();
      await podCoord.stopCluster();
    });

    let rejectCloseOnPodA = true;
    let podTConnected = true;
    let podBCloseReceived = 0;

    bridgesA.set(sListen, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.CLOSE && rejectCloseOnPodA) return false;
        void engA.handleMessage(m);
        return true;
      },
    });
    bridgesB.set(sListen, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.CLOSE) podBCloseReceived += 1;
        void engB.handleMessage(m);
        return true;
      },
    });
    bridgesT.set(sTarget, {
      isDaemonConnected: () => podTConnected,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engT.handleMessage(m); return true; },
    });
    podA.onDaemonConnected(sListen, 1);
    podT.onDaemonConnected(sTarget, 1);

    const fixedProbe = createTcpServer();
    await new Promise<void>((r) => fixedProbe.listen(0, '127.0.0.1', () => r()));
    const fixedPort = (fixedProbe.address() as { port: number }).port;
    await new Promise<void>((r) => fixedProbe.close(() => r()));

    const opened = await podCoord.openTunnel({
      userId: 'user_r6_fb',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: fixedPort,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const tid = opened.tunnel.tunnelId;
    expect(engA.listTunnels()).toHaveLength(1);

    // Simulate coordinator becoming unreachable AFTER tunnel open!
    await podCoord.stopCluster();

    // Another pod registers the SAME serverId + SAME local generation (1), overwriting endpoints presence!
    podB.onDaemonConnected(sListen, 1);
    // Target also goes offline without reaching dead coordinator.
    podTConnected = false;

    // Fallback pod MUST NOT mark closed because of overwritten presence! Must contact bound podA -> 504 TIMEOUT, listener still alive!
    const unconfirmed = await podFallback.closeTunnelForUser('user_r6_fb', tid);
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) {
      expect(unconfirmed.status).toBe(504);
      expect(unconfirmed.unconfirmedTunnelIds).toEqual([tid]);
    }
    expect(podBCloseReceived).toBe(0);
    expect(engA.listTunnels()).toHaveLength(1);

    // Restore delivery on podA -> retry on fallback pod closes via podA's real CLOSE_ACK -> confirmed 200, rebind succeeds!
    rejectCloseOnPodA = false;
    const confirmed = await podFallback.closeTunnelForUser('user_r6_fb', tid);
    expect(confirmed).toEqual({ ok: true, closedTunnelIds: [tid] });
    expect(podBCloseReceived).toBe(0);
    expect(engA.listTunnels()).toHaveLength(0);

    // Confirm fixedPort is genuinely released and rebindable immediately!
    podTConnected = true;
    podT.onDaemonConnected(sTarget, 1);
    const rebound = await podFallback.openTunnel({
      userId: 'user_r6_fb',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: fixedPort,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(rebound.ok).toBe(true);
    if (rebound.ok) {
      expect(rebound.tunnel.listenPort).toBe(fixedPort);
    }
  });

  it('never fakes close on restarted coordinator read failure or adoption write failure, and serializes concurrent cross-pod DELETEs via atomic CAS (R7 P0)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sListen = `r7_l_${suffix}`;
    const sTarget = `r7_t_${suffix}`;
    const baseStore = new InMemoryPortForwardClusterStore();
    const origGetTunnel = baseStore.getTunnel.bind(baseStore);
    const origTryAdopt = baseStore.tryAdoptCoordinator.bind(baseStore);

    let failCoordinatorGetTunnel = false;
    let coordinatorRestartedInstance = false;
    let failAdoptWrite = false;
    let slowAdoptMs = 0;

    // Wrap clusterStore separately for the restarted coordinator vs adoption pods so we can inject exact storage faults!
    const makeStoreProxy = (opts: { isRestartedCoord?: boolean } = {}): InMemoryPortForwardClusterStore =>
      new Proxy(baseStore, {
        get(target, prop, receiver) {
          if (prop === 'getTunnel') {
            return async (id: string) => {
              if (opts.isRestartedCoord && failCoordinatorGetTunnel) {
                throw new Error('simulated_db_read_error');
              }
              return origGetTunnel(id);
            };
          }
          if (prop === 'tryAdoptCoordinator') {
            return async (
              tid: string,
              expCoord: string,
              expUpdated: number,
              newCoord: string,
              now?: number,
            ) => {
              if (failAdoptWrite) {
                throw new Error('simulated_cas_write_error');
              }
              if (slowAdoptMs > 0) {
                await new Promise((r) => setTimeout(r, slowAdoptMs));
              }
              return origTryAdopt(tid, expCoord, expUpdated, newCoord, now);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

    const bridgesA = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesT = new Map<string, PortForwardBridgeEndpoint>();

    const podCoordLive = new PortForwardRouter({
      podId: 'pod_r7_coord',
      clusterStore: baseStore,
      closeAckTimeoutMs: 60,
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const podA = new PortForwardRouter({ podId: 'pod_r7_a', clusterStore: baseStore, lookupBridge: (id) => bridgesA.get(id), closeAckTimeoutMs: 60 });
    const podT = new PortForwardRouter({ podId: 'pod_r7_t', clusterStore: baseStore, lookupBridge: (id) => bridgesT.get(id), closeAckTimeoutMs: 60 });
    const podFbX = new PortForwardRouter({ podId: 'pod_r7_fbx', clusterStore: makeStoreProxy(), closeAckTimeoutMs: 60 });
    const podFbY = new PortForwardRouter({ podId: 'pod_r7_fby', clusterStore: makeStoreProxy(), closeAckTimeoutMs: 60 });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sListen, idL.publicKeyB64], [sTarget, idT.publicKeyB64]]);

    const engA = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podA.handleDaemonMessage(sListen, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podT.handleDaemonMessage(sTarget, 1, m)); },
    });

    let podCoordRestarted: PortForwardRouter | undefined;
    cleanups.push(async () => {
      failCoordinatorGetTunnel = false;
      failAdoptWrite = false;
      slowAdoptMs = 0;
      engA.closeAll();
      engT.closeAll();
      await podA.stopCluster();
      await podT.stopCluster();
      await podFbX.stopCluster();
      await podFbY.stopCluster();
      await podCoordRestarted?.stopCluster();
      await podCoordLive.stopCluster();
    });

    let closeAttemptsToA = 0;
    bridgesA.set(sListen, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => {
        if (m.type === PORT_FORWARD_MSG.CLOSE) closeAttemptsToA += 1;
        void engA.handleMessage(m);
        return true;
      },
    });
    bridgesT.set(sTarget, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engT.handleMessage(m); return true; },
    });
    podA.onDaemonConnected(sListen, 1);
    podT.onDaemonConnected(sTarget, 1);

    const opened = await podCoordLive.openTunnel({
      userId: 'user_r7',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: 0,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const tid = opened.tunnel.tunnelId;
    expect(engA.listTunnels()).toHaveLength(1);

    // Replace pod_r7_coord's subscriber with a freshly restarted coordinator instance (same podId, empty memory, DB still active!).
    podCoordRestarted = new PortForwardRouter({
      podId: 'pod_r7_coord',
      clusterStore: makeStoreProxy({ isRestartedCoord: true }),
      closeAckTimeoutMs: 60,
    });
    coordinatorRestartedInstance = true;
    void coordinatorRestartedInstance;

    // 1. Coordinator DB read error on close_tunnel MUST return unconfirmed 504, persisted state MUST stay active, ZERO endpoints closed!
    failCoordinatorGetTunnel = true;
    const readErrClose = await podFbX.closeTunnelForUser('user_r7', tid);
    expect(readErrClose.ok).toBe(false);
    if (!readErrClose.ok) {
      expect(readErrClose.status).toBe(504);
      expect(readErrClose.unconfirmedTunnelIds).toEqual([tid]);
    }
    expect((await origGetTunnel(tid))?.status).toBe('active');
    expect(engA.listTunnels()).toHaveLength(1);
    expect(closeAttemptsToA).toBe(0);
    failCoordinatorGetTunnel = false;

    // 2. CAS takeover write failure MUST abort before constructing closing tunnel or sending CLOSE -> unconfirmed 504!
    failAdoptWrite = true;
    const writeErrClose = await podFbX.closeTunnelForUser('user_r7', tid);
    expect(writeErrClose.ok).toBe(false);
    if (!writeErrClose.ok) {
      expect(writeErrClose.status).toBe(504);
      expect(readErrClose.ok ? [] : writeErrClose.unconfirmedTunnelIds).toEqual([tid]);
    }
    expect((await origGetTunnel(tid))?.status).toBe('active');
    expect(closeAttemptsToA).toBe(0);
    expect(engA.listTunnels()).toHaveLength(1);
    failAdoptWrite = false;

    // 3. Concurrent cross-pod DELETEs race for CAS takeover: EXACTLY ONE winner adopts coordinatorPodId,
    //    both receive clean confirmed close, endpoints receive single coordinated CLOSE & release cleanly!
    (podCoordRestarted as unknown as { unsubscribeBus?: () => void }).unsubscribeBus?.();
    slowAdoptMs = 15;
    const [resX, resY] = await Promise.all([
      podFbX.closeTunnelForUser('user_r7', tid),
      podFbY.closeTunnelForUser('user_r7', tid),
    ]);
    expect(resX.ok).toBe(true);
    expect(resY.ok).toBe(true);
    expect(engA.listTunnels()).toHaveLength(0);
    expect(engT.listTunnels()).toHaveLength(0);
    expect((await origGetTunnel(tid))?.status).toBe('closed');
    // Only ONE winner pod should have dispatched CLOSE to podA (loser followed winner rather than double-adopting).
    expect(closeAttemptsToA).toBe(1);
  });

  it('settles DELETE with retryable 504 without self-deadlock when CAS winner is unreachable and allows clean subsequent retry (R8 P0)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sListen = `r8_l_${suffix}`;
    const sTarget = `r8_t_${suffix}`;
    const baseStore = new InMemoryPortForwardClusterStore();
    const origTryAdopt = baseStore.tryAdoptCoordinator.bind(baseStore);

    let stealCasOnce = false;
    const storeWithRaceStealer = new Proxy(baseStore, {
      get(target, prop, receiver) {
        if (prop === 'tryAdoptCoordinator') {
          return async (
            tid: string,
            expCoord: string,
            expUpdated: number,
            newCoord: string,
            now?: number,
          ) => {
            if (stealCasOnce) {
              stealCasOnce = false;
              // Unreachable ghost pod wins CAS right before caller, leaving coordinatorPodId = pod_r8_ghost (unsubscribed/offline).
              await origTryAdopt(tid, expCoord, expUpdated, 'pod_r8_ghost', now);
            }
            return origTryAdopt(tid, expCoord, expUpdated, newCoord, now);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const bridgesA = new Map<string, PortForwardBridgeEndpoint>();
    const bridgesT = new Map<string, PortForwardBridgeEndpoint>();
    const podCoordLive = new PortForwardRouter({
      podId: 'pod_r8_coord',
      clusterStore: baseStore,
      closeAckTimeoutMs: 20,
      prepareTimeoutMs: 2_000,
      establishTimeoutMs: 4_000,
    });
    const podA = new PortForwardRouter({ podId: 'pod_r8_a', clusterStore: baseStore, lookupBridge: (id) => bridgesA.get(id), closeAckTimeoutMs: 20 });
    const podT = new PortForwardRouter({ podId: 'pod_r8_t', clusterStore: baseStore, lookupBridge: (id) => bridgesT.get(id), closeAckTimeoutMs: 20 });
    const podCaller = new PortForwardRouter({ podId: 'pod_r8_caller', clusterStore: storeWithRaceStealer, closeAckTimeoutMs: 20 });

    const idL = generateEndpointIdentityKeyPair();
    const idT = generateEndpointIdentityKeyPair();
    const trusted = new Map([[sListen, idL.publicKeyB64], [sTarget, idT.publicKeyB64]]);

    const engA = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idL,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podA.handleDaemonMessage(sListen, 1, m)); },
    });
    const engT = new PortForwardEngine({
      disableDirectTcp: true,
      disableDirectUdp: true,
      identityKeyPair: idT,
      resolveTrustedPeerPublicKey: (id) => trusted.get(id) ?? null,
      sendWs: (m) => { queueMicrotask(() => podT.handleDaemonMessage(sTarget, 1, m)); },
    });

    cleanups.push(async () => {
      stealCasOnce = false;
      engA.closeAll();
      engT.closeAll();
      await podA.stopCluster();
      await podT.stopCluster();
      await podCaller.stopCluster();
      await podCoordLive.stopCluster();
    });

    bridgesA.set(sListen, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engA.handleMessage(m); return true; },
    });
    bridgesT.set(sTarget, {
      isDaemonConnected: () => true,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (m) => { void engT.handleMessage(m); return true; },
    });
    podA.onDaemonConnected(sListen, 1);
    podT.onDaemonConnected(sTarget, 1);

    const opened = await podCoordLive.openTunnel({
      userId: 'user_r8',
      listenNode: sListen,
      listenServerId: sListen,
      listenPort: 0,
      targetNode: sTarget,
      targetServerId: sTarget,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 60,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const tid = opened.tunnel.tunnelId;
    expect(engA.listTunnels()).toHaveLength(1);

    // Crash original coordinator cleanly from the cluster bus without tearing down endpoints (simulates ungraceful pod crash).
    (podCoordLive as unknown as { unsubscribeBus?: () => void }).unsubscribeBus?.();
    stealCasOnce = true;

    const firstStart = Date.now();
    const firstDelete = await Promise.race([
      podCaller.closeTunnelForUser('user_r8', tid),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    expect(firstDelete).not.toBe('hung');
    expect(Date.now() - firstStart).toBeLessThan(1_800);
    expect(typeof firstDelete === 'object' && !firstDelete.ok ? firstDelete.status : null).toBe(504);
    expect(typeof firstDelete === 'object' && !firstDelete.ok ? firstDelete.unconfirmedTunnelIds : null).toEqual([tid]);
    expect(engA.listTunnels()).toHaveLength(1);

    // Subsequent independent retry must NOT inherit the old inFlightAdoptions promise; it adopts from ghost winner & closes cleanly!
    const retryDelete = await Promise.race([
      podCaller.closeTunnelForUser('user_r8', tid),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    expect(retryDelete).not.toBe('hung');
    expect(typeof retryDelete === 'object' && retryDelete.ok).toBe(true);
    expect(engA.listTunnels()).toHaveLength(0);
    expect(engT.listTunnels()).toHaveLength(0);
    expect((await baseStore.getTunnel(tid))?.status).toBe('closed');
  });
});
