import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { createOrUpdateShare, revokeShare, setServerShareExecGrant } from '../src/db/tab-sharing.js';
import {
  issueOwnerMachineAuthorityForSession,
  issueSharedMachineAuthorityForSession,
} from '../src/share/shared-machine-authority.js';
import { serverRoutes } from '../src/routes/server.js';
import { tabSharingRoutes } from '../src/routes/tab-sharing.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { createMachineExecRoutes, machineExecAuditIntentStore } from '../src/routes/machine-exec.js';
import { createMachineComputerUseRoutes } from '../src/routes/machine-computer-use.js';
import { fileTransferRoutes } from '../src/routes/file-transfer.js';
import { createPortForwardRoutes } from '../src/routes/port-forward.js';
import { verificationMachineRoutes } from '../src/routes/verification-machines.js';
import { generateControlledNodeId } from '../src/services/controlled-node-identity.js';
import { signJwt } from '../src/security/crypto.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { MACHINE_DENIAL_REASON } from '../../shared/machine-access-policy.js';
import type { PortForwardRouter } from '../src/ws/port-forward-router.js';

const JWT_KEY = 'private-device-block-test-key';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

function webAuth(userId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`,
    'content-type': 'application/json',
  };
}

function daemonAuth(serverId: string, token: string, turnAuthority?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'X-Server-Id': serverId,
    'content-type': 'application/json',
    ...(turnAuthority ? { [SHARED_MACHINE_AUTHORITY_HEADER]: turnAuthority } : {}),
  };
}

async function seedFullHost(userId: string, name = 'full-host') {
  const serverId = `full-${hex(6)}`;
  const token = hex(16);
  await createServer(db, serverId, userId, name, sha256(token));
  await db.execute("UPDATE servers SET status = 'online', last_heartbeat_at = $2 WHERE id = $1", [serverId, Date.now()]);
  return { serverId, token };
}

async function seedControlledNode(userId: string, name = 'ctrl-node') {
  const serverId = `ctl-${hex(6)}`;
  const nodeId = generateControlledNodeId();
  await db.execute(
    `INSERT INTO servers
       (id, user_id, name, token_hash, status, last_heartbeat_at, created_at, node_role,
        exec_enabled, ref_name, display_name, os, node_id)
     VALUES ($1,$2,$3,$4,'online',$5,$5,$6,true,$7,$3,'linux',$8)`,
    [serverId, userId, name, sha256(hex(16)), Date.now(), NODE_ROLE.CONTROLLED, `ref-${hex(4)}`, nodeId],
  );
  return { serverId, nodeId };
}

function createApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = {
      DB: db,
      JWT_SIGNING_KEY: JWT_KEY,
    };
    await next();
  });

  const mockPortForwardRouter: PortForwardRouter = {
    configure: () => {},
    openTunnel: async (req) => ({
      ok: true,
      tunnel: {
        tunnelId: 'tun-mock-1',
        listenNode: req.listenNode,
        listenServerId: req.listenServerId,
        listenHost: '127.0.0.1',
        listenPort: req.listenPort ?? 8080,
        localEndpoint: `127.0.0.1:${req.listenPort ?? 8080}`,
        targetNode: req.targetNode,
        targetServerId: req.targetServerId,
        targetHost: req.targetHost,
        targetPort: req.targetPort,
        transportMode: 'relay',
        activeConnections: 0,
        bytesSent: 0,
        bytesReceived: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    }),
    listTunnels: async () => [],
    closeTunnelForUser: async () => ({ ok: true, closedTunnelIds: [] }),
    closeAllForUser: async () => ({ confirmed: true, closedTunnelIds: [], unconfirmedTunnelIds: [] }),
  } as unknown as PortForwardRouter;

  app.route('/api/server', serverRoutes);
  app.route('/api', tabSharingRoutes);
  app.route('/api/machines', machinesRoutes);
  app.route('/api/machine/exec', createMachineExecRoutes(async () => ({
    online: true,
    result: { ok: true, exitCode: 0, stdout: 'ok', stderr: '' },
  }), machineExecAuditIntentStore));
  app.route('/api/machine/computer-use', createMachineComputerUseRoutes(async () => ({
    online: true,
    result: { ok: true, content: [{ type: 'text', text: 'apps' }] },
  })));
  app.route('/api/server', fileTransferRoutes);
  app.route('/api/port-forwards', createPortForwardRoutes(mockPortForwardRouter));
  app.route('/api/verification-machines', verificationMachineRoutes);
  return { app, mockPortForwardRouter };
}

describe('Symmetric per-user per-host private device blocks ("各自保护自己")', () => {
  it('enforces self-only policy management and symmetric cross-device isolation across all daemon routes', async () => {
    const owner = await createUser(db, `owner-${hex(4)}`, 'Owner', 'owner@test.local');
    const participant = await createUser(db, `part-${hex(4)}`, 'Participant', 'part@test.local');
    const stranger = await createUser(db, `stranger-${hex(4)}`, 'Stranger', 'stranger@test.local');

    // Owner's shared Host A, other unshared Host D, private Machine B, private Full Machine F, shared Machine C
    const hostA = await seedFullHost(owner.id, 'Host A');
    const hostD = await seedFullHost(owner.id, 'Host D');
    const machineB = await seedControlledNode(owner.id, 'Private Machine B');
    const fullF = await seedFullHost(owner.id, 'Private Full F');
    const machineC = await seedControlledNode(owner.id, 'Shared Team Machine C');

    // Participant's private Machine E and Participant's own Host E2
    const machineE = await seedControlledNode(participant.id, 'Participant Private E');
    const hostE2 = await seedFullHost(participant.id, 'Participant Host E2');

    // Seed session on Host A and grant Participant P session + controlled Machine C shares
    await db.execute(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, project_dir, state, created_at, updated_at)
       VALUES ($1, $2, 'deck_main_brain', 'proj', 'brain', 'claude-code', '/tmp', 'idle', $3, $3)`,
      [`sess-${hex(6)}`, hostA.serverId, Date.now()],
    );
    await createOrUpdateShare(db, {
      id: `share-${hex(6)}`,
      target: { kind: 'main', serverId: hostA.serverId, sessionName: 'deck_main_brain' },
      targetUserId: participant.id,
      role: 'participant',
      createdBy: owner.id,
      now: Date.now(),
    });
    const shareC = await createOrUpdateShare(db, {
      id: `share-${hex(6)}`,
      target: { kind: 'server', serverId: machineC.serverId },
      targetUserId: participant.id,
      role: 'participant',
      createdBy: owner.id,
      now: Date.now(),
    });
    await setServerShareExecGrant(db, {
      shareId: shareC.id,
      serverId: machineC.serverId,
      targetUserId: participant.id,
      execGranted: true,
      now: Date.now(),
    });

    const { app, mockPortForwardRouter } = createApp();

    // 1. Daemon credential and stranger cannot read or toggle my-private-device-policy
    expect((await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'GET',
      headers: daemonAuth(hostA.serverId, hostA.token),
    })).status).toBe(403);
    expect((await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: daemonAuth(hostA.serverId, hostA.token),
      body: JSON.stringify({ blockPrivateDevices: true }),
    })).status).toBe(403);
    expect((await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(stranger.id),
      body: JSON.stringify({ blockPrivateDevices: true }),
    })).status).toBe(403);

    // 2. Seed verification machine profiles for Owner's Machine B (private) and Machine C (shared)
    const vmPrivateRes = await app.request('/api/verification-machines', {
      method: 'PUT',
      headers: webAuth(owner.id),
      body: JSON.stringify({
        scope: 'user',
        scopeKey: '',
        alias: 'vm-private-b',
        kind: 'controlled_node',
        target: machineB.nodeId,
      }),
    });
    expect(vmPrivateRes.status).toBe(200);
    const vmPrivateId = ((await vmPrivateRes.json()) as { profile: { id: string } }).profile.id;

    const vmSharedRes = await app.request('/api/verification-machines', {
      method: 'PUT',
      headers: webAuth(owner.id),
      body: JSON.stringify({
        scope: 'user',
        scopeKey: '',
        alias: 'vm-shared-c',
        kind: 'controlled_node',
        target: machineC.nodeId,
      }),
    });
    expect(vmSharedRes.status).toBe(200);
    const vmSharedId = ((await vmSharedRes.json()) as { profile: { id: string } }).profile.id;

    // Mint turn tokens for Owner and Participant on Host A
    const ownerTurnA = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: owner.id,
      sourceServerId: hostA.serverId,
      sessionName: 'deck_main_brain',
      actionId: `act-o-${hex(4)}`,
      signingKey: JWT_KEY,
    });
    const partTurnA = await issueSharedMachineAuthorityForSession(db, {
      actorUserId: participant.id,
      sourceServerId: hostA.serverId,
      sessionName: 'deck_main_brain',
      shareTarget: { kind: 'main', serverId: hostA.serverId, sessionName: 'deck_main_brain' },
      actionId: `act-p-${hex(4)}`,
      signingKey: JWT_KEY,
    });
    expect(ownerTurnA).toBeTruthy();
    expect(partTurnA).toBeTruthy();

    // 3. ONLY Owner O enables blockPrivateDevices on Host A (Participant P keeps false)
    const patchOwnerRes = await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(owner.id),
      body: JSON.stringify({ blockPrivateDevices: true }),
    });
    expect(patchOwnerRes.status).toBe(200);
    expect(await patchOwnerRes.json()).toEqual({ ok: true, serverId: hostA.serverId, blockPrivateDevices: true });

    // P's own policy on Host A remains false; O's GET /api/server and P's GET /api/shares reflect separation
    const pPolicyRes = await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'GET',
      headers: webAuth(participant.id),
    });
    expect(pPolicyRes.status).toBe(200);
    expect(await pPolicyRes.json()).toEqual({ ok: true, serverId: hostA.serverId, blockPrivateDevices: false });

    const ownerServers = await (await app.request('/api/server', { headers: webAuth(owner.id) })).json() as {
      servers: Array<{ id: string; blockMyPrivateDevices?: boolean }>;
    };
    expect(ownerServers.servers.find((s) => s.id === hostA.serverId)?.blockMyPrivateDevices).toBe(true);
    expect(ownerServers.servers.find((s) => s.id === hostD.serverId)?.blockMyPrivateDevices).toBe(false);

    const partShares = await (await app.request('/api/shares', { headers: webAuth(participant.id) })).json() as {
      shares: Array<{ serverId: string; blockMyPrivateDevices?: boolean }>;
    };
    expect(partShares.shares.find((s) => s.serverId === hostA.serverId)?.blockMyPrivateDevices).toBe(false);

    // Owner's live turn on Host A:
    // - GET /api/machines hides Machine B, still includes shared Machine C
    const ownerListRes = await app.request('/api/machines', {
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
    });
    expect(ownerListRes.status).toBe(200);
    const ownerListedIds = ((await ownerListRes.json()) as { machines: Array<{ serverId: string }> }).machines.map((m) => m.serverId);
    expect(ownerListedIds).not.toContain(machineB.serverId);
    expect(ownerListedIds).toContain(machineC.serverId);

    // - exec, computer_use, file-transfer, port_forward (controlled AND full), verification-machines all block Machine B / Full F
    expect((await app.request(`/api/machine/exec?serverId=${machineB.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ command: 'echo blocked' }),
    })).status).toBe(403);

    expect((await app.request(`/api/machine/computer-use?serverId=${machineB.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    })).status).toBe(403);

    expect((await app.request(`/api/server/${machineB.serverId}/machine-file-handle`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ path: '/tmp/secret.txt' }),
    })).status).toBe(403);

    // port-forward blocks BOTH controlled Machine B and FULL Machine F on listen or target end
    const pfCtrlRes = await app.request('/api/port-forwards', {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ listenNode: 'self', listenPort: 9001, targetNode: machineB.nodeId, targetPort: 80 }),
    });
    expect(pfCtrlRes.status).toBe(403);
    expect(((await pfCtrlRes.json()) as { error: string }).error).toBe(MACHINE_DENIAL_REASON.PRIVATE_DEVICE_BLOCKED_FOR_HOST);

    const pfFullRes = await app.request('/api/port-forwards', {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ listenNode: fullF.serverId, listenPort: 9002, targetNode: machineC.nodeId, targetPort: 80 }),
    });
    expect(pfFullRes.status).toBe(403);
    expect(((await pfFullRes.json()) as { error: string }).error).toBe(MACHINE_DENIAL_REASON.PRIVATE_DEVICE_BLOCKED_FOR_HOST);

    // verification-machines on Host A hides vm-private-b, keeps vm-shared-c, and denies POST verification for vm-private-b
    const vmDaemonList = await (await app.request('/api/verification-machines?includeAllProjects=1', {
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
    })).json() as { profiles: Array<{ id: string }> };
    expect(vmDaemonList.profiles.map((p) => p.id)).toEqual([vmSharedId]);

    expect((await app.request(`/api/verification-machines/${vmPrivateId}/verification`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ status: 'verified' }),
    })).status).toBe(403);

    // Shared Machine C remains accessible for Owner O on Host A
    expect((await app.request(`/api/machine/exec?serverId=${machineC.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ command: 'echo shared-ok' }),
    })).status).toBe(200);

    // Interactive browser UI (no daemon authServerId) AND unblocked Host D still see/access Machine B
    const uiMachines = await (await app.request('/api/machines', { headers: webAuth(owner.id) })).json() as {
      machines: Array<{ serverId: string }>;
    };
    expect(uiMachines.machines.map((m) => m.serverId)).toContain(machineB.serverId);

    const hostDList = await (await app.request('/api/machines', {
      headers: daemonAuth(hostD.serverId, hostD.token),
    })).json() as { machines: Array<{ serverId: string }> };
    expect(hostDList.machines.map((m) => m.serverId)).toContain(machineB.serverId);

    // Crucially: Participant P on Host A STILL accesses Participant P's own unshared Machine E!
    const partListBefore = await (await app.request('/api/machines', {
      headers: daemonAuth(hostA.serverId, hostA.token, partTurnA!),
    })).json() as { machines: Array<{ serverId: string }> };
    expect(partListBefore.machines.map((m) => m.serverId)).toContain(machineE.serverId);
    expect((await app.request(`/api/machine/computer-use?serverId=${machineE.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, partTurnA!),
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    })).status).toBe(200);

    // 4. Participant P enables self-protection on Host A ("参与者也可以关") -> P's Machine E blocked on Host A, O unchanged!
    expect((await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(participant.id),
      body: JSON.stringify({ blockPrivateDevices: true }),
    })).status).toBe(200);

    const partListAfter = await (await app.request('/api/machines', {
      headers: daemonAuth(hostA.serverId, hostA.token, partTurnA!),
    })).json() as { machines: Array<{ serverId: string }> };
    expect(partListAfter.machines.map((m) => m.serverId)).not.toContain(machineE.serverId);
    expect(partListAfter.machines.map((m) => m.serverId)).toContain(machineC.serverId);
    expect((await app.request(`/api/machine/computer-use?serverId=${machineE.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, partTurnA!),
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    })).status).toBe(403);
    // P's own Host E2 STILL sees Machine E
    const pHostE2List = await (await app.request('/api/machines', {
      headers: daemonAuth(hostE2.serverId, hostE2.token),
    })).json() as { machines: Array<{ serverId: string }> };
    expect(pHostE2List.machines.map((m) => m.serverId)).toContain(machineE.serverId);

    // 5. Dynamic re-classification: revoking share on Machine C makes Machine C private & blocked for Owner O on Host A!
    await revokeShare(db, { shareId: shareC.id, serverId: machineC.serverId, now: Date.now() });
    const ownerAfterRevoke = await (await app.request('/api/machines', {
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
    })).json() as { machines: Array<{ serverId: string }> };
    expect(ownerAfterRevoke.machines.map((m) => m.serverId)).not.toContain(machineC.serverId);

    // Silence unused variable warnings cleanly via tunnel list filter assertion
    mockPortForwardRouter.listTunnels = async () => [{
      tunnelId: 't-1',
      listenNode: 'self',
      listenServerId: hostA.serverId,
      listenHost: '127.0.0.1',
      listenPort: 9000,
      localEndpoint: '127.0.0.1:9000',
      targetNode: machineB.nodeId,
      targetServerId: machineB.serverId,
      targetHost: '127.0.0.1',
      targetPort: 80,
      transportMode: 'relay',
      activeConnections: 0,
      bytesSent: 0,
      bytesReceived: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }];
    const pfListRes = await app.request('/api/port-forwards', {
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
    });
    expect(pfListRes.status).toBe(200);
    expect(((await pfListRes.json()) as { tunnels: unknown[] }).tunnels).toEqual([]);
  });
});
