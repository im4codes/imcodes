import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { PortForwardEngine } from '../../src/daemon/port-forward-engine.js';
import { signJwt } from '../src/security/crypto.js';
import { createPortForwardRoutes } from '../src/routes/port-forward.js';
import { WsBridge } from '../src/ws/bridge.js';
import { PortForwardRouter, defaultPortForwardRouter } from '../src/ws/port-forward-router.js';
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

function createInMemoryDb(users: MockUser[], servers: MockServer[]): Database {
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

    if (s.includes('SELECT 1 FROM server_shares')) {
      return [] as T[];
    }

    if (s.includes('SELECT id FROM servers WHERE id = $1 AND team_id IS NOT NULL')) {
      return [] as T[];
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
    useLegacySilentTarget?: boolean;
    useDefaultRouter?: boolean;
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

    const db = createInMemoryDb(users, servers);
    const signingKey = 'test-signing-key-32-chars-minimum-x';
    const router = options.useDefaultRouter
      ? defaultPortForwardRouter
      : new PortForwardRouter({
          lookupBridge: (id) => WsBridge.find(id),
          prepareTimeoutMs: options.prepareTimeoutMs ?? 2_000,
          establishTimeoutMs: 4_000,
        });

    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = { DB: db, JWT_SIGNING_KEY: signingKey };
      await next();
    });
    app.route(PORT_FORWARD_API_PATH, createPortForwardRoutes(router));

    // Attach node sockets directly to WsBridge + router (when not using defaultPortForwardRouter)
    const nodes = {
      full1: createFakeNodeSocket(full1Id, full1Token, router),
      full2: createFakeNodeSocket(full2Id, full2Token, router),
      ctl1: createFakeNodeSocket(ctl1Id, ctl1Token, router, { disableDirectTcp: true }),
      ctl2: createFakeNodeSocket(ctl2Id, ctl2Token, router, { disableDirectTcp: true }),
      ctlDisabled: createFakeNodeSocket(ctlDisabledId, `tok_dis_${suffix}`, router),
      foreignFull: createFakeNodeSocket(foreignFullId, foreignToken, router),
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

    cleanups.push(() => {
      router.closeAllForUser('user_a');
      router.closeAllForUser('user_b');
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
    expect(env.router.listTunnels('user_a')).toHaveLength(1);

    env.nodes.ctl1.emitter.close();
    await new Promise((r) => setTimeout(r, 30));

    expect(env.router.listTunnels('user_a')).toHaveLength(0);
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
});
