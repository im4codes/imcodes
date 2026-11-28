import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { createOrUpdateShare, setServerShareExecGrant } from '../src/db/tab-sharing.js';
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
import { PortForwardRouter } from '../src/ws/port-forward-router.js';
import {
  InMemoryPortForwardClusterStore,
  type PortForwardClusterStatus,
  type PortForwardClusterTunnelRecord,
} from '../src/ws/port-forward-cluster.js';

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

async function seedControlledNode(
  userId: string,
  name = 'ctrl-node',
  options?: { hostServerId?: string | null },
) {
  const serverId = `ctl-${hex(6)}`;
  const nodeId = generateControlledNodeId();
  await db.execute(
    `INSERT INTO servers
       (id, user_id, name, token_hash, status, last_heartbeat_at, created_at, node_role,
        exec_enabled, ref_name, display_name, os, node_id, host_server_id)
     VALUES ($1,$2,$3,$4,'online',$5,$5,$6,true,$7,$3,'linux',$8,$9)`,
    [serverId, userId, name, sha256(hex(16)), Date.now(), NODE_ROLE.CONTROLLED, `ref-${hex(4)}`, nodeId, options?.hostServerId ?? null],
  );
  return { serverId, nodeId };
}

async function createTeamWithMembers(name: string, ownerId: string, extraMemberIds: string[] = []) {
  const teamId = `team-${hex(6)}`;
  const now = Date.now();
  await db.execute(
    `INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1, $2, $3, 'free', $4)`,
    [teamId, name, ownerId, now],
  );
  await db.execute(
    `INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
    [teamId, ownerId, now],
  );
  for (const memberId of extraMemberIds) {
    await db.execute(
      `INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)`,
      [teamId, memberId, now],
    );
  }
  return teamId;
}

async function addServerToGroup(serverId: string, teamId: string) {
  await db.execute(
    'INSERT INTO machine_groups (server_id, team_id, added_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [serverId, teamId, Date.now()],
  );
}

async function removeServerFromGroup(serverId: string, teamId: string) {
  await db.execute('DELETE FROM machine_groups WHERE server_id = $1 AND team_id = $2', [serverId, teamId]);
}

async function createApp(
  initialTunnels: Array<Partial<PortForwardClusterTunnelRecord> & {
    tunnelId: string;
    userId: string;
    listenServerId: string;
    listenNode: string;
    targetServerId: string;
    targetNode: string;
    status: PortForwardClusterStatus;
  }> = [],
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = {
      DB: db,
      JWT_SIGNING_KEY: JWT_KEY,
    };
    await next();
  });

  const clusterStore = new InMemoryPortForwardClusterStore();
  const now = Date.now();
  for (const t of initialTunnels) {
    await clusterStore.tryCreateTunnel({
      coordinatorPodId: 'pod-test',
      listenPodId: 'pod-test',
      listenGeneration: 1,
      requestedListenPort: t.listenPort ?? 9100,
      boundListenPort: t.listenPort ?? 9100,
      targetPodId: 'pod-test',
      targetGeneration: 1,
      targetHost: '127.0.0.1',
      targetPort: 80,
      transportPref: 'auto',
      transportMode: 'relay',
      activeConnections: 0,
      bytesSent: 0,
      bytesReceived: 0,
      createdAt: now,
      expiresAt: now + 60_000,
      updatedAt: now,
      ...t,
    } as PortForwardClusterTunnelRecord);
  }

  const router = new PortForwardRouter({
    podId: 'pod-test',
    clusterStore,
    closeAckTimeoutMs: 50,
  });
  const closedByRouter: string[] = [];
  router.openTunnel = async (req) => ({
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
  });
  (router as unknown as {
    closeTunnelRecordAndAwait: (r: { tunnelId: string }, reason: string) => Promise<{ confirmed: boolean; tunnelId: string }>;
  }).closeTunnelRecordAndAwait = async (rec, _reason) => {
    closedByRouter.push(rec.tunnelId);
    await clusterStore.markTunnelClosed(rec.tunnelId);
    return { confirmed: true, tunnelId: rec.tunnelId };
  };

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
  app.route('/api/port-forwards', createPortForwardRoutes(router));
  app.route('/api/verification-machines', verificationMachineRoutes);
  return { app, router, clusterStore, closedByRouter };
}

describe('Symmetric per-user per-host private device blocks ("各自保护自己")', () => {
  it('enforces common-shared-group boundary, multi-group overlap, host_server_id union, and dual-identity symmetry across all daemon routes', async () => {
    const owner = await createUser(db, `owner-${hex(4)}`, 'Owner', 'owner@test.local');
    const participant = await createUser(db, `part-${hex(4)}`, 'Participant', 'part@test.local');
    const stranger = await createUser(db, `stranger-${hex(4)}`, 'Stranger', 'stranger@test.local');

    // Groups:
    // G1, G2: shared between Owner & Participant (Host A is in {G1, G2})
    // G3, G4: shared between Owner & Stranger ONLY (disjoint from Host A's groups!)
    // G_solo: solo group with ONLY Owner (must NOT qualify as a shared group)
    const g1 = await createTeamWithMembers('Team G1', owner.id, [participant.id]);
    const g2 = await createTeamWithMembers('Team G2', owner.id, [participant.id]);
    const g3 = await createTeamWithMembers('Team G3', owner.id, [stranger.id]);
    const g4 = await createTeamWithMembers('Team G4', owner.id, [stranger.id]);
    const gSolo = await createTeamWithMembers('Solo Group', owner.id);

    // Owner hosts: Host A (in G1 & G2) and unblocked Host D
    const hostA = await seedFullHost(owner.id, 'Host A');
    const hostD = await seedFullHost(owner.id, 'Host D');
    await addServerToGroup(hostA.serverId, g1);
    await addServerToGroup(hostA.serverId, g2);
    await addServerToGroup(hostA.serverId, gSolo);

    // Owner targets:
    // 1. Completely unshared private controlled node & private FULL node
    const unsharedB = await seedControlledNode(owner.id, 'Unshared B');
    const fullF = await seedFullHost(owner.id, 'Private Full F');
    // 2. Direct share ONLY with Participant (NO common group with Host A) -> MUST BE BLOCKED!
    const directOnlyC = await seedControlledNode(owner.id, 'Direct Share Only C');
    await createOrUpdateShare(db, {
      id: `share-${hex(6)}`,
      target: { kind: 'server', serverId: directOnlyC.serverId },
      targetUserId: participant.id,
      role: 'participant',
      createdBy: owner.id,
      now: Date.now(),
    });
    await setServerShareExecGrant(db, {
      serverId: directOnlyC.serverId,
      targetUserId: participant.id,
      execGranted: true,
      now: Date.now(),
    });
    // 3. Solo group only (both Host A and soloNode are in gSolo, but ONLY owner is a member) -> MUST BE BLOCKED!
    const soloGroupNode = await seedControlledNode(owner.id, 'Solo Group Node');
    await addServerToGroup(soloGroupNode.serverId, gSolo);
    // 4. Disjoint multi-group ({G3, G4} vs Host A {G1, G2}) -> MUST BE BLOCKED!
    const disjointGroupNode = await seedControlledNode(owner.id, 'Disjoint Group Node');
    await addServerToGroup(disjointGroupNode.serverId, g3);
    await addServerToGroup(disjointGroupNode.serverId, g4);
    // 5. Overlapping multi-group ({G2, G3} overlaps Host A {G1, G2} at G2) -> MUST BE ALLOWED!
    const overlapGroupNode = await seedControlledNode(owner.id, 'Overlap Group Node');
    await addServerToGroup(overlapGroupNode.serverId, g2);
    await addServerToGroup(overlapGroupNode.serverId, g3);

    // Companion host_server_id test on Host H2 (no direct machine_groups on H2; companion node is in gLink)
    const gLink = await createTeamWithMembers('Team Link', owner.id, [participant.id]);
    const hostH2 = await seedFullHost(owner.id, 'Host H2 Companion');
    const companionOnH2 = await seedControlledNode(owner.id, 'Companion Node', { hostServerId: hostH2.serverId });
    await addServerToGroup(companionOnH2.serverId, gLink);
    const linkTarget = await seedControlledNode(owner.id, 'Target In Link Group');
    await addServerToGroup(linkTarget.serverId, gLink);

    // Group-only Host G (FULL server in g1 only, NO direct shares) for checking group-only GET /api/server + policy access
    const groupOnlyMemberResSeed = await seedFullHost(owner.id, 'Group Only Host');
    await addServerToGroup(groupOnlyMemberResSeed.serverId, g1);

    // Participant targets & own host P2
    const pUnshared = await seedControlledNode(participant.id, 'Participant Unshared E');
    const pInG1 = await seedControlledNode(participant.id, 'Participant G1 Shared');
    await addServerToGroup(pInG1.serverId, g1);
    const hostP2 = await seedFullHost(participant.id, 'Participant Own Host P2');

    // Direct session share on Host A for Participant's shared-session live turn
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

    const { app } = await createApp();

    // 1. Daemon token and stranger rejected on self-only policy endpoints
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

    // Group-only member Participant CAN read/toggle policy on Group Only Host (even without direct shares!)
    const partServersRes = await app.request('/api/server', { headers: webAuth(participant.id) });
    expect(partServersRes.status).toBe(200);
    const partServers = (await partServersRes.json() as {
      servers: Array<{ id: string; isOwner?: boolean; blockMyPrivateDevices?: boolean }>;
    }).servers;
    const groupOnlyEntry = partServers.find((s) => s.id === groupOnlyMemberResSeed.serverId);
    expect(groupOnlyEntry).toMatchObject({ isOwner: false, blockMyPrivateDevices: false });

    // Seed verification machine profiles for unsharedB, directOnlyC, and overlapGroupNode
    const mkVmProfile = async (alias: string, nodeId: string) => {
      const res = await app.request('/api/verification-machines', {
        method: 'PUT',
        headers: webAuth(owner.id),
        body: JSON.stringify({ scope: 'user', scopeKey: '', alias, kind: 'controlled_node', target: nodeId }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { profile: { id: string } }).profile.id;
    };
    const vmUnsharedId = await mkVmProfile('vm-unshared', unsharedB.nodeId);
    const vmDirectId = await mkVmProfile('vm-direct-only', directOnlyC.nodeId);
    const vmOverlapId = await mkVmProfile('vm-overlap-g2', overlapGroupNode.nodeId);

    // Live turn tokens on Host A (Owner turn first; Participant turn is minted when handoff happens in section 5
    // because Stage 2 revokes prior turn grants on the same session tree upon sender switch) and Host H2
    const ownerTurnA = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: owner.id,
      sourceServerId: hostA.serverId,
      sessionName: 'deck_main_brain',
      actionId: `act-o-${hex(4)}`,
      signingKey: JWT_KEY,
    });
    const ownerTurnH2 = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: owner.id,
      sourceServerId: hostH2.serverId,
      sessionName: 'deck_h2',
      actionId: `act-h2-${hex(4)}`,
      signingKey: JWT_KEY,
    });

    // 2. Owner enables blockPrivateDevices on Host A (Participant stays false on Host A)
    const patchOwnerRes = await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(owner.id),
      body: JSON.stringify({ blockPrivateDevices: true }),
    });
    expect(patchOwnerRes.status).toBe(200);

    // Owner's GET /api/machines on Host A hides: unsharedB, directOnlyC, soloGroupNode, disjointGroupNode!
    // Allows: overlapGroupNode (shares G2 with Host A) AND participant's pInG1 (non-owner device shared via G1)!
    const ownerListedIds = (
      (await (await app.request('/api/machines', { headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!) })).json()) as {
        machines: Array<{ serverId: string }>;
      }
    ).machines.map((m) => m.serverId);
    expect(ownerListedIds).not.toContain(unsharedB.serverId);
    expect(ownerListedIds).not.toContain(directOnlyC.serverId);
    expect(ownerListedIds).not.toContain(soloGroupNode.serverId);
    expect(ownerListedIds).not.toContain(disjointGroupNode.serverId);
    expect(ownerListedIds).toContain(overlapGroupNode.serverId);
    expect(ownerListedIds).toContain(pInG1.serverId);

    // Action routes block unshared, direct-only, solo-group, disjoint-group (403) while allowing overlapping group G2 (200)
    for (const blockedTarget of [unsharedB.serverId, directOnlyC.serverId, soloGroupNode.serverId, disjointGroupNode.serverId]) {
      expect((await app.request(`/api/machine/exec?serverId=${blockedTarget}`, {
        method: 'POST',
        headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
        body: JSON.stringify({ command: 'echo blocked' }),
      })).status).toBe(403);
      expect((await app.request(`/api/machine/computer-use?serverId=${blockedTarget}`, {
        method: 'POST',
        headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
        body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
      })).status).toBe(403);
      expect((await app.request(`/api/server/${blockedTarget}/machine-file-handle`, {
        method: 'POST',
        headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
        body: JSON.stringify({ path: '/tmp/secret.txt' }),
      })).status).toBe(403);
    }
    expect((await app.request(`/api/machine/exec?serverId=${overlapGroupNode.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ command: 'echo ok' }),
    })).status).toBe(200);

    // port-forward creation checks BOTH controlled and FULL endpoints against common group boundary
    expect((await app.request('/api/port-forwards', {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ listenNode: 'self', listenPort: 9001, targetNode: directOnlyC.nodeId, targetPort: 80 }),
    })).status).toBe(403);
    expect((await app.request('/api/port-forwards', {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ listenNode: fullF.serverId, listenPort: 9002, targetNode: overlapGroupNode.nodeId, targetPort: 80 }),
    })).status).toBe(403);
    expect((await app.request('/api/port-forwards', {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ listenNode: 'self', listenPort: 9003, targetNode: overlapGroupNode.nodeId, targetPort: 80 }),
    })).status).toBe(200);

    // verification-machines hides unshared & directOnly, keeps overlapGroupNode
    const vmList = (await (await app.request('/api/verification-machines?includeAllProjects=1', {
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
    })).json() as { profiles: Array<{ id: string }> }).profiles.map((p) => p.id);
    expect(vmList).toEqual([vmOverlapId]);
    expect((await app.request(`/api/verification-machines/${vmUnsharedId}/verification`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ status: 'verified' }),
    })).status).toBe(403);
    expect((await app.request(`/api/verification-machines/${vmDirectId}/verification`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ status: 'verified' }),
    })).status).toBe(403);

    // Dynamic overlap removal: removing overlapGroupNode from unique overlapping G2 immediately blocks it!
    await removeServerFromGroup(overlapGroupNode.serverId, g2);
    expect((await app.request(`/api/machine/exec?serverId=${overlapGroupNode.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnA!),
      body: JSON.stringify({ command: 'echo now-blocked' }),
    })).status).toBe(403);

    // 3. Companion host_server_id union & revocation test on Host H2
    await app.request(`/api/server/${hostH2.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(owner.id),
      body: JSON.stringify({ blockPrivateDevices: true }),
    });
    expect((await app.request(`/api/machine/exec?serverId=${linkTarget.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostH2.serverId, hostH2.token, ownerTurnH2!),
      body: JSON.stringify({ command: 'echo via-companion' }),
    })).status).toBe(200);
    await db.execute('UPDATE servers SET revoked_at = $2 WHERE id = $1', [companionOnH2.serverId, Date.now()]);
    expect((await app.request(`/api/machine/exec?serverId=${linkTarget.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostH2.serverId, hostH2.token, ownerTurnH2!),
      body: JSON.stringify({ command: 'echo companion-revoked' }),
    })).status).toBe(403);

    // 4. Browser UI & unblocked Host D unaffected for Owner
    const uiMachines = (await (await app.request('/api/machines', { headers: webAuth(owner.id) })).json() as {
      machines: Array<{ serverId: string }>;
    }).machines.map((m) => m.serverId);
    expect(uiMachines).toEqual(expect.arrayContaining([unsharedB.serverId, directOnlyC.serverId, soloGroupNode.serverId, disjointGroupNode.serverId]));
    const hostDMachines = (await (await app.request('/api/machines', {
      headers: daemonAuth(hostD.serverId, hostD.token),
    })).json() as { machines: Array<{ serverId: string }> }).machines.map((m) => m.serverId);
    expect(hostDMachines).toContain(unsharedB.serverId);

    // 5. Dual-identity symmetry: Participant's unshared device STILL works until Participant enables toggle on Host A
    const partTurnA = await issueSharedMachineAuthorityForSession(db, {
      actorUserId: participant.id,
      sourceServerId: hostA.serverId,
      sessionName: 'deck_main_brain',
      shareTarget: { kind: 'main', serverId: hostA.serverId, sessionName: 'deck_main_brain' },
      actionId: `act-p-${hex(4)}`,
      signingKey: JWT_KEY,
    });
    expect((await app.request(`/api/machine/computer-use?serverId=${pUnshared.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, partTurnA!),
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    })).status).toBe(200);

    await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(participant.id),
      body: JSON.stringify({ blockPrivateDevices: true }),
    });
    const partIdsAfter = (await (await app.request('/api/machines', {
      headers: daemonAuth(hostA.serverId, hostA.token, partTurnA!),
    })).json() as { machines: Array<{ serverId: string }> }).machines.map((m) => m.serverId);
    expect(partIdsAfter).not.toContain(pUnshared.serverId);
    expect(partIdsAfter).toContain(pInG1.serverId);
    expect((await app.request(`/api/machine/computer-use?serverId=${pUnshared.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, partTurnA!),
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    })).status).toBe(403);
    expect((await app.request(`/api/machine/computer-use?serverId=${pInG1.serverId}`, {
      method: 'POST',
      headers: daemonAuth(hostA.serverId, hostA.token, partTurnA!),
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    })).status).toBe(200);
    // Unblocked Participant Host P2 still sees pUnshared
    const hostP2Ids = (await (await app.request('/api/machines', {
      headers: daemonAuth(hostP2.serverId, hostP2.token),
    })).json() as { machines: Array<{ serverId: string }> }).machines.map((m) => m.serverId);
    expect(hostP2Ids).toContain(pUnshared.serverId);
  });

  it('blocks DELETE /:tunnelId and atomic batch DELETE / (with and without ?node=) on either blocked endpoint, while allowing when toggle is off', async () => {
    const owner = await createUser(db, `pf-o-${hex(4)}`, 'PF Owner', 'pfo@test.local');
    const colleague = await createUser(db, `pf-c-${hex(4)}`, 'PF Colleague', 'pfc@test.local');
    const g1 = await createTeamWithMembers('PF Team', owner.id, [colleague.id]);
    const hostA = await seedFullHost(owner.id, 'PF Host A');
    const allowedShared = await seedControlledNode(owner.id, 'PF Allowed C');
    const blockedPriv = await seedControlledNode(owner.id, 'PF Blocked B');
    const blockedFull = await seedFullHost(owner.id, 'PF Blocked Full F');
    await addServerToGroup(hostA.serverId, g1);
    await addServerToGroup(allowedShared.serverId, g1);

    const { app, clusterStore, closedByRouter } = await createApp([
      {
        tunnelId: 't-allowed',
        userId: owner.id,
        status: 'active',
        listenNode: 'self',
        listenServerId: hostA.serverId,
        requestedListenPort: 9101,
        boundListenPort: 9101,
        targetNode: allowedShared.nodeId,
        targetServerId: allowedShared.serverId,
      },
      {
        tunnelId: 't-blocked-target',
        userId: owner.id,
        status: 'active',
        listenNode: allowedShared.nodeId,
        listenServerId: allowedShared.serverId,
        requestedListenPort: 9102,
        boundListenPort: 9102,
        targetNode: blockedPriv.nodeId,
        targetServerId: blockedPriv.serverId,
      },
      {
        tunnelId: 't-blocked-listen',
        userId: owner.id,
        status: 'preparing',
        listenNode: blockedFull.serverId,
        listenServerId: blockedFull.serverId,
        requestedListenPort: 9103,
        boundListenPort: 9103,
        targetNode: allowedShared.nodeId,
        targetServerId: allowedShared.serverId,
      },
    ]);

    const turnToken = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: owner.id,
      sourceServerId: hostA.serverId,
      sessionName: 'deck_pf',
      actionId: `act-pf-${hex(4)}`,
      signingKey: JWT_KEY,
    });

    await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(owner.id),
      body: JSON.stringify({ blockPrivateDevices: true }),
    });

    // GET list returns only t-allowed
    const listRes = await app.request('/api/port-forwards', {
      headers: daemonAuth(hostA.serverId, hostA.token, turnToken!),
    });
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as { tunnels: Array<{ tunnelId: string }> }).tunnels.map((t) => t.tunnelId)).toEqual(['t-allowed']);

    // DELETE /:tunnelId blocks on either blocked targetServerId or blocked listenServerId, closing ZERO tunnels
    for (const id of ['t-blocked-target', 't-blocked-listen']) {
      const delOne = await app.request(`/api/port-forwards/${id}`, {
        method: 'DELETE',
        headers: daemonAuth(hostA.serverId, hostA.token, turnToken!),
      });
      expect(delOne.status).toBe(403);
      expect(((await delOne.json()) as { error: string }).error).toBe(MACHINE_DENIAL_REASON.PRIVATE_DEVICE_BLOCKED_FOR_HOST);
    }
    expect(closedByRouter).toEqual([]);

    // Batch DELETE / without ?node= blocks with 403 and performs ZERO partial closes!
    const delAll = await app.request('/api/port-forwards', {
      method: 'DELETE',
      headers: daemonAuth(hostA.serverId, hostA.token, turnToken!),
    });
    expect(delAll.status).toBe(403);
    expect(((await delAll.json()) as { error: string }).error).toBe(MACHINE_DENIAL_REASON.PRIVATE_DEVICE_BLOCKED_FOR_HOST);
    expect(closedByRouter).toEqual([]);
    expect((await clusterStore.listOpenTunnelsForUser(owner.id)).map((t) => t.tunnelId).sort()).toEqual([
      't-allowed',
      't-blocked-listen',
      't-blocked-target',
    ]);

    // Batch DELETE /?node=allowedShared also fails atomically because t-blocked-target/listen bridge allowedShared <-> blocked!
    const delFiltered = await app.request(`/api/port-forwards?node=${allowedShared.nodeId}`, {
      method: 'DELETE',
      headers: daemonAuth(hostA.serverId, hostA.token, turnToken!),
    });
    expect(delFiltered.status).toBe(403);
    expect(closedByRouter).toEqual([]);
    expect(await clusterStore.listOpenTunnelsForUser(owner.id)).toHaveLength(3);

    // When toggle is turned OFF, normal DELETE /:tunnelId and DELETE / work!
    await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(owner.id),
      body: JSON.stringify({ blockPrivateDevices: false }),
    });
    const delOneOk = await app.request('/api/port-forwards/t-blocked-listen', {
      method: 'DELETE',
      headers: daemonAuth(hostA.serverId, hostA.token, turnToken!),
    });
    expect(delOneOk.status).toBe(200);
    const delAllOk = await app.request('/api/port-forwards', {
      method: 'DELETE',
      headers: daemonAuth(hostA.serverId, hostA.token, turnToken!),
    });
    expect(delAllOk.status).toBe(200);
    expect(await clusterStore.listOpenTunnelsForUser(owner.id)).toHaveLength(0);
    expect(closedByRouter.sort()).toEqual(['t-allowed', 't-blocked-listen', 't-blocked-target']);
  });

  it('filters private controlled nodes BEFORE LIMIT cap (>200 machines) in both /api/machines and /api/verification-machines', async () => {
    const owner = await createUser(db, `cap-o-${hex(4)}`, 'Cap Owner', 'capo@test.local');
    const teammate = await createUser(db, `cap-t-${hex(4)}`, 'Cap Teammate', 'capt@test.local');
    const g1 = await createTeamWithMembers('Cap Team', owner.id, [teammate.id]);
    const hostA = await seedFullHost(owner.id, 'Cap Host A');
    await addServerToGroup(hostA.serverId, g1);

    // Seed 202 alphabetically-earlier private nodes + 1 alphabetically-last shared-group node #203 + 1 alphabetically-last private node #204
    const privateNodes: Array<{ serverId: string; nodeId: string }> = [];
    for (let i = 1; i <= 202; i += 1) {
      privateNodes.push(await seedControlledNode(owner.id, `aaa-priv-${String(i).padStart(3, '0')}`));
    }
    const lastShared = await seedControlledNode(owner.id, 'zzz-shared-203');
    await addServerToGroup(lastShared.serverId, g1);
    const lastPrivate = await seedControlledNode(owner.id, 'zzz-priv-204');

    const { app } = await createApp();
    // Register verification profiles for the >200 nodes (priv #202, shared #203, priv #204) via browser
    for (const [alias, nodeId] of [
      ['p-priv-001', privateNodes[0]!.nodeId],
      ['p-priv-204', lastPrivate.nodeId],
      ['p-shared-203', lastShared.nodeId],
    ] as const) {
      const putRes = await app.request('/api/verification-machines', {
        method: 'PUT',
        headers: webAuth(owner.id),
        body: JSON.stringify({ scope: 'user', scopeKey: '', alias, kind: 'controlled_node', target: nodeId }),
      });
      expect(putRes.status).toBe(200);
    }

    const ownerTurnCap = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: owner.id,
      sourceServerId: hostA.serverId,
      sessionName: 'deck_cap',
      actionId: `act-cap-${hex(4)}`,
      signingKey: JWT_KEY,
    });

    // With toggle OFF: GET /api/machines hits 200-cap -> 413
    const offList = await app.request('/api/machines', { headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnCap!) });
    expect(offList.status).toBe(413);

    // Enable blockPrivateDevices on Host A
    await app.request(`/api/server/${hostA.serverId}/my-private-device-policy`, {
      method: 'PATCH',
      headers: webAuth(owner.id),
      body: JSON.stringify({ blockPrivateDevices: true }),
    });

    // GET /api/machines returns 200 with ONLY [lastShared] (no false 413, no hiding past 201!)
    const onList = await app.request('/api/machines', { headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnCap!) });
    expect(onList.status).toBe(200);
    const listedIds = ((await onList.json()) as { machines: Array<{ serverId: string }> }).machines.map((m) => m.serverId);
    expect(listedIds).toEqual([lastShared.serverId]);

    // GET /api/verification-machines hides BOTH p-priv-001 AND p-priv-204 (item >200!), keeps ONLY p-shared-203!
    const vmRes = await app.request('/api/verification-machines?includeAllProjects=1', {
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnCap!),
    });
    expect(vmRes.status).toBe(200);
    const vmAliases = ((await vmRes.json()) as { profiles: Array<{ alias: string }> }).profiles.map((p) => p.alias);
    expect(vmAliases).toEqual(['p-shared-203']);

    // PUT /api/verification-machines past 200-cap: allowed shared node #203 -> 200, blocked private node #204 -> 403 private_device_blocked_for_host
    const putAllowedRes = await app.request('/api/verification-machines', {
      method: 'PUT',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnCap!),
      body: JSON.stringify({ scope: 'user', scopeKey: '', alias: 'daemon-shared-203', kind: 'controlled_node', target: lastShared.nodeId }),
    });
    expect(putAllowedRes.status).toBe(200);
    const putBlockedRes = await app.request('/api/verification-machines', {
      method: 'PUT',
      headers: daemonAuth(hostA.serverId, hostA.token, ownerTurnCap!),
      body: JSON.stringify({ scope: 'user', scopeKey: '', alias: 'daemon-priv-204', kind: 'controlled_node', target: lastPrivate.nodeId }),
    });
    expect(putBlockedRes.status).toBe(403);
    expect(((await putBlockedRes.json()) as { error: string }).error).toBe(MACHINE_DENIAL_REASON.PRIVATE_DEVICE_BLOCKED_FOR_HOST);
  });

  it('uses a single cluster-store snapshot for batch DELETE /api/port-forwards so newly opened private tunnels cannot slip into execution', async () => {
    const owner = await createUser(db, `snap-o-${hex(4)}`, 'Snap Owner', 'snapo@test.local');
    const colleague = await createUser(db, `snap-c-${hex(4)}`, 'Snap Colleague', 'snapc@test.local');
    const g1 = await createTeamWithMembers('Snap Team', owner.id, [colleague.id]);
    const hostA = await seedFullHost(owner.id, 'Snap Host A');
    const allowedShared = await seedControlledNode(owner.id, 'Snap Allowed C');
    const blockedPriv = await seedControlledNode(owner.id, 'Snap Blocked B');
    await addServerToGroup(hostA.serverId, g1);
    await addServerToGroup(allowedShared.serverId, g1);

    await appRequestPatchBlock(owner.id, hostA.serverId, true);

    async function appRequestPatchBlock(uid: string, sid: string, val: boolean) {
      await db.execute(
        `INSERT INTO server_private_device_blocks (server_id, user_id, block_private_devices, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (server_id, user_id) DO UPDATE SET block_private_devices = excluded.block_private_devices`,
        [sid, uid, val, Date.now()],
      );
    }

    const now = Date.now();
    const clusterStore = new InMemoryPortForwardClusterStore();
    const checkedTunnel = {
      tunnelId: 'checked-tunnel',
      userId: owner.id,
      coordinatorPodId: 'pod-test',
      listenNode: 'self',
      listenServerId: hostA.serverId,
      listenPodId: 'pod-test',
      listenGeneration: 1,
      requestedListenPort: 9201,
      boundListenPort: 9201,
      targetNode: allowedShared.nodeId,
      targetServerId: allowedShared.serverId,
      targetPodId: 'pod-test',
      targetGeneration: 1,
      targetHost: '127.0.0.1',
      targetPort: 80,
      transportPref: 'auto' as const,
      transportMode: 'relay' as const,
      status: 'active' as const,
      activeConnections: 0,
      bytesSent: 0,
      bytesReceived: 0,
      createdAt: now,
      expiresAt: now + 60_000,
      updatedAt: now,
    };
    const newUncheckedTunnel = {
      ...checkedTunnel,
      tunnelId: 'new-unchecked-tunnel',
      targetNode: blockedPriv.nodeId,
      targetServerId: blockedPriv.serverId,
      requestedListenPort: 9202,
      boundListenPort: 9202,
    };
    await clusterStore.tryCreateTunnel(checkedTunnel);

    let listOpenCalls = 0;
    const origListOpen = clusterStore.listOpenTunnelsForUser.bind(clusterStore);
    clusterStore.listOpenTunnelsForUser = async (userId: string, nodeServerId?: string) => {
      listOpenCalls += 1;
      if (listOpenCalls === 1) {
        return origListOpen(userId, nodeServerId);
      }
      // If a buggy 2nd read occurred, this newly opened blocked tunnel would appear and get closed!
      return [checkedTunnel, newUncheckedTunnel];
    };

    const closedByRouter: string[] = [];
    const realRouter = new PortForwardRouter({
      podId: 'pod-test',
      clusterStore,
      closeAckTimeoutMs: 50,
    });
    const origCloseRecord = (realRouter as unknown as {
      closeTunnelRecordAndAwait: (r: { tunnelId: string }, reason: string) => Promise<{ confirmed: boolean; tunnelId: string }>;
    }).closeTunnelRecordAndAwait.bind(realRouter);
    (realRouter as unknown as {
      closeTunnelRecordAndAwait: (r: { tunnelId: string }, reason: string) => Promise<{ confirmed: boolean; tunnelId: string }>;
    }).closeTunnelRecordAndAwait = async (rec, _reason) => {
      closedByRouter.push(rec.tunnelId);
      void origCloseRecord;
      return { confirmed: true, tunnelId: rec.tunnelId };
    };

    const routeApp = new Hono();
    routeApp.use('*', async (c, next) => {
      (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string } }).env = {
        DB: db,
        JWT_SIGNING_KEY: JWT_KEY,
      };
      await next();
    });
    routeApp.route('/api/port-forwards', createPortForwardRoutes(realRouter));

    const turnToken = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: owner.id,
      sourceServerId: hostA.serverId,
      sessionName: 'deck_snap',
      actionId: `act-snap-${hex(4)}`,
      signingKey: JWT_KEY,
    });

    // 1. Clean 1st snapshot [checked-tunnel]: clusterStore.listOpenTunnelsForUser called ONLY ONCE; new-unchecked-tunnel NEVER closed!
    const okRes = await routeApp.request('/api/port-forwards', {
      method: 'DELETE',
      headers: daemonAuth(hostA.serverId, hostA.token, turnToken!),
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true, closedCount: 1, closedTunnelIds: ['checked-tunnel'] });
    expect(listOpenCalls).toBe(1);
    expect(closedByRouter).toEqual(['checked-tunnel']);

    // 2. When the single snapshot includes newUncheckedTunnel, authorizeBatch rejects 403 and closes ZERO tunnels!
    closedByRouter.length = 0;
    listOpenCalls = 0;
    await clusterStore.tryCreateTunnel(newUncheckedTunnel);
    clusterStore.listOpenTunnelsForUser = origListOpen;
    const blockedRes = await routeApp.request('/api/port-forwards', {
      method: 'DELETE',
      headers: daemonAuth(hostA.serverId, hostA.token, turnToken!),
    });
    expect(blockedRes.status).toBe(403);
    expect(((await blockedRes.json()) as { error: string }).error).toBe(MACHINE_DENIAL_REASON.PRIVATE_DEVICE_BLOCKED_FOR_HOST);
    expect(closedByRouter).toEqual([]);
  });
});
