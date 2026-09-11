import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { createOrUpdateShare } from '../src/db/tab-sharing.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { createMachineExecRoutes } from '../src/routes/machine-exec.js';
import { createMachineComputerUseRoutes } from '../src/routes/machine-computer-use.js';
import { tabSharingRoutes } from '../src/routes/tab-sharing.js';
import { sessionMgmtRoutes } from '../src/routes/session-mgmt.js';
import { fileTransferRoutes } from '../src/routes/file-transfer.js';
import { WsBridge } from '../src/ws/bridge.js';
import { signJwt } from '../src/security/crypto.js';
import { COOKIE_SESSION } from '../../shared/cookie-names.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import { generateControlledNodeId } from '../src/services/controlled-node-identity.js';
import {
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
} from '../../shared/transport/file-transfer.js';
import {
  SHARED_MACHINE_AUTHORITY_HEADER,
  SHARED_MACHINE_AUTHORITY_TYPE,
} from '../../shared/shared-machine-authority.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import {
  DELEGATION_AUTHORITY_MCP_SERVER,
  projectDelegationClaim,
  readMachineControlDispatchFact,
} from '../../shared/delegation-claim.js';
import { createDaemonMachineToolDeps } from '../../src/daemon/machine-mcp-deps.js';
import { listMachines as daemonListMachines } from '../../src/daemon/machine-exec-client.js';
import { registerMemoryMcpTools } from '../../src/daemon/memory-mcp-tools.js';
import {
  bindProcessSharedMachineAuthority,
  clearProcessSharedMachineAuthoritiesForTests,
  readProcessSharedMachineAuthority,
} from '../../src/daemon/shared-machine-authority-context.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

const JWT_KEY = 'controlled-machine-sharing-test-key';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let db: Database;

class CaptureDaemonSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  constructor(private readonly onSend?: (message: Record<string, unknown>) => void) { super(); }
  send(data: string | Buffer, _options?: unknown, callback?: (error?: Error) => void): void {
    if (typeof data === 'string') {
      this.sent.push(data);
      this.onSend?.(JSON.parse(data) as Record<string, unknown>);
    }
    callback?.();
  }
  close(): void { this.readyState = 3; this.emit('close'); }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!predicate()) throw new Error('condition_timeout');
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => { await db.close(); });

function webAuth(userId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600)}`,
    'content-type': 'application/json',
  };
}

function cookieAuthWithSpoofedServerHeader(userId: string): Record<string, string> {
  const token = signJwt({ sub: userId, type: 'web' }, JWT_KEY, 3600);
  return {
    cookie: `${COOKIE_SESSION}=${encodeURIComponent(token)}`,
    'X-Server-Id': 'browser-controlled-header',
  };
}

async function fullCredential(userId: string) {
  const serverId = `full-${hex(6)}`;
  const token = hex(16);
  await createServer(db, serverId, userId, 'full', sha256(token));
  return { serverId, token };
}

async function controlledNode(userId: string) {
  const serverId = `ctl-${hex(6)}`;
  await db.execute(
    `INSERT INTO servers
       (id, user_id, name, token_hash, status, created_at, node_role,
        exec_enabled, ref_name, display_name, os, node_id)
     VALUES ($1,$2,'controlled',$3,'online',$4,$5,true,$6,'Shared machine','linux',$7)`,
    [serverId, userId, sha256(hex(16)), Date.now(), NODE_ROLE.CONTROLLED, `ref-${hex(4)}`, generateControlledNodeId()],
  );
  return serverId;
}

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database; JWT_SIGNING_KEY: string; SERVER_URL: string } }).env = {
      DB: db,
      JWT_SIGNING_KEY: JWT_KEY,
      SERVER_URL: 'https://relay.example',
    };
    await next();
  });
  app.route('/api/machines', machinesRoutes);
  app.route('/api', tabSharingRoutes);
  app.route('/api/server', sessionMgmtRoutes);
  app.route('/api/server', fileTransferRoutes);
  app.route('/api/machine/exec', createMachineExecRoutes(async () => ({
    online: true,
    result: { requestId: 'exec', ok: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 },
  })));
  app.route('/api/machine/computer-use', createMachineComputerUseRoutes(async (_target, frame) => ({
    online: true,
    result: {
      correlationId: frame.correlationId,
      ok: true,
      tool: frame.tool,
      content: [{ type: 'text', text: 'ok' }],
      durationMs: 1,
    },
  })));
  return app;
}

async function createDesk(ownerId: string, role: 'owner' | 'admin' | 'member' = 'owner') {
  const teamId = `desk-${hex(6)}`;
  await db.execute(
    'INSERT INTO teams (id, name, owner_id, plan, created_at) VALUES ($1,$2,$3,$4,$5)',
    [teamId, 'AI Desk', ownerId, 'free', Date.now()],
  );
  await db.execute(
    'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4)',
    [teamId, ownerId, role, Date.now()],
  );
  return teamId;
}

async function joinDesk(teamId: string, userId: string, role = 'member') {
  await db.execute(
    'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [teamId, userId, role, Date.now()],
  );
}

/** Bind through the authorized route, never by writing servers.team_id directly. */
async function bindDesk(app: ReturnType<typeof buildApp>, actorId: string, serverId: string, teamId: string | null) {
  return app.request(`/api/machines/desk-binding?serverId=${encodeURIComponent(serverId)}`, {
    method: 'POST',
    headers: webAuth(actorId),
    body: JSON.stringify({ teamId }),
  });
}

async function createMachineGrant(params: {
  ownerId: string;
  recipientId: string;
  serverId: string;
  role: 'viewer' | 'participant';
  expiresAt?: number | null;
}) {
  return createOrUpdateShare(db, {
    id: `share-${hex(8)}`,
    target: { kind: 'server', serverId: params.serverId },
    targetUserId: params.recipientId,
    role: params.role,
    createdBy: params.ownerId,
    expiresAt: params.expiresAt ?? null,
    now: Date.now(),
  });
}

describe('controlled-node sharing reuses grants without becoming a shared Tab', () => {
  it('lists active grants as machines, applies role changes, and isolates shared-session routes', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const recipientId = `recipient-${hex(4)}`;
    const outsiderId = `outsider-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, recipientId), createUser(db, outsiderId)]);
    const serverId = await controlledNode(ownerId);
    // The machine is in a team the recipient does not belong to, which is the
    // point: an individual share stands on its own.
    const deskId = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);
    // Deliberately NOT a member of the machine's team: the individual grant
    // is the only thing under test, so expiry and downgrade are visible.

    const create = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: webAuth(ownerId),
      body: JSON.stringify({
        target: { kind: 'server', serverId },
        targetUserId: recipientId,
        role: 'viewer',
      }),
    });
    expect(create.status).toBe(201);

    const viewerList = await app.request('/api/machines', { headers: webAuth(recipientId) });
    expect(await viewerList.json()).toEqual({
      machines: [expect.objectContaining({
        serverId,
        displayName: 'Shared machine',
        accessRole: 'viewer',
        execEnabled: false,
      })],
    });
    const spoofedBrowserList = await app.request('/api/machines', {
      headers: cookieAuthWithSpoofedServerHeader(recipientId),
    });
    expect(spoofedBrowserList.status).toBe(200);
    expect(await spoofedBrowserList.json()).toEqual({
      machines: [expect.objectContaining({ accessRole: 'viewer', execEnabled: false })],
    });
    expect(await (await app.request('/api/machines', { headers: webAuth(outsiderId) })).json())
      .toEqual({ machines: [] });

    const sharedTabs = await app.request('/api/shares', { headers: webAuth(recipientId) });
    expect(await sharedTabs.json()).toEqual({ shares: [] });
    for (const path of ['/api/shares/open', '/api/shares/ws-ticket']) {
      const response = await app.request(path, {
        method: 'POST',
        headers: webAuth(recipientId),
        body: JSON.stringify({ target: { kind: 'server', serverId } }),
      });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ reason: 'share-target-unavailable' });
    }

    const share = await create.json() as { share: { id: string } };
    const promote = await app.request(`/api/server/${serverId}/shares/${share.share.id}`, {
      method: 'PATCH',
      headers: webAuth(ownerId),
      body: JSON.stringify({ role: 'participant' }),
    });
    expect(promote.status).toBe(200);
    const participantList = await app.request('/api/machines', { headers: webAuth(recipientId) });
    expect(await participantList.json()).toEqual({
      machines: [expect.objectContaining({ serverId, accessRole: 'participant', execEnabled: true })],
    });

    const nonOwnerManage = await app.request(`/api/server/${serverId}/shares`, {
      headers: webAuth(recipientId),
    });
    expect(nonOwnerManage.status).toBe(403);

    for (const request of [
      app.request(`/api/server/${serverId}/shares`, {
        method: 'POST', headers: webAuth(recipientId),
        body: JSON.stringify({
          target: { kind: 'server', serverId }, targetUserId: outsiderId, role: 'viewer',
        }),
      }),
      app.request(`/api/server/${serverId}/shares/${share.share.id}`, {
        method: 'PATCH', headers: webAuth(recipientId), body: JSON.stringify({ role: 'viewer' }),
      }),
      app.request(`/api/server/${serverId}/shares/${share.share.id}`, {
        method: 'DELETE', headers: webAuth(recipientId),
      }),
    ]) {
      expect((await request).status, 'Participant must not manage the sharing relationship').toBe(403);
    }

    const operationMatrix = [
      ['/api/machines/' + serverId + '/display-name', { displayName: 'Participant renamed' }, 200],
      ['/api/machines/' + serverId + '/exec-enabled', { enabled: false }, 200],
      ['/api/machines/' + serverId + '/exec-enabled', { enabled: true }, 200],
      ['/api/machines/' + serverId + '/auto-unlock', { secret: 'participant-supplied' }, 409],
      ['/api/machines/' + serverId + '/remote-desktop-worker', {}, 409],
    ] as const;
    for (const [path, body, expectedStatus] of operationMatrix) {
      const response = await app.request(path, {
        method: 'POST', headers: webAuth(recipientId), body: JSON.stringify(body),
      });
      expect(response.status, `${path} must pass Participant authorization`).toBe(expectedStatus);
      expect(response.status, `${path} must not retain an owner-only guard`).not.toBe(404);
    }

    const revoke = await app.request(`/api/machines/${serverId}/revoke`, {
      method: 'POST',
      headers: webAuth(recipientId),
    });
    expect(revoke.status).toBe(200);
    expect(await (await app.request('/api/machines', { headers: webAuth(recipientId) })).json())
      .toEqual({ machines: [] });
  });
});

describe('controlled-node version reporting', () => {
  it('exposes canonical remote-desktop host identity to browsers but not strict daemon clients', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const source = await fullCredential(ownerId);
    const controlledId = await controlledNode(ownerId);
    await db.execute(
      'UPDATE servers SET controlled_capabilities = $2::jsonb WHERE id = $1',
      [controlledId, JSON.stringify([REMOTE_DESKTOP_CAPABILITY])],
    );

    const browser = await (await app.request('/api/machines', { headers: webAuth(ownerId) })).json() as {
      machines: { serverId: string; remoteDesktopHostId?: string }[];
    };
    const browserMachine = browser.machines.find((machine) => machine.serverId === controlledId);
    expect(browserMachine?.remoteDesktopHostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.queryOne<{ public_id: string }>(
      `SELECT public_id FROM remote_desktop_public_ids
        WHERE host_id = $1 AND status = 'active'`,
      [browserMachine?.remoteDesktopHostId],
    )).toMatchObject({ public_id: expect.stringMatching(/^[5-9][0-9]{9}$/) });

    const daemon = await (await app.request('/api/machines', {
      headers: { 'X-Server-Id': source.serverId, authorization: `Bearer ${source.token}` },
    })).json() as { machines: Record<string, unknown>[] };
    expect(daemon.machines.find((machine) => machine.serverId === controlledId))
      .not.toHaveProperty('remoteDesktopHostId');
  });

  it('shows a parseable node version to browsers, flags stale ones, and hides both from daemons', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const source = await fullCredential(ownerId);
    const current = await controlledNode(ownerId);
    const stale = await controlledNode(ownerId);
    const garbled = await controlledNode(ownerId);
    const silent = await controlledNode(ownerId);
    await db.execute('UPDATE servers SET daemon_version = $2 WHERE id = $1', [current, '2026.8.3447-dev.3884']);
    await db.execute('UPDATE servers SET daemon_version = $2 WHERE id = $1', [stale, '2026.8.3400-dev.3800']);
    // A node is free to report anything; only a parseable release is echoed on.
    await db.execute('UPDATE servers SET daemon_version = $2 WHERE id = $1', [garbled, 'not a version']);

    const previousAppVersion = process.env.APP_VERSION;
    process.env.APP_VERSION = '2026.8.3447-dev.3884';
    try {
      const browser = await (await app.request('/api/machines', { headers: webAuth(ownerId) })).json() as {
        machines: { serverId: string; daemonVersion?: string; updateAvailable?: boolean }[];
      };
      const byId = new Map(browser.machines.map((m) => [m.serverId, m]));
      expect(byId.get(current)).toMatchObject({ daemonVersion: '2026.8.3447-dev.3884' });
      expect(byId.get(current)!.updateAvailable).toBeUndefined();
      expect(byId.get(stale)).toMatchObject({
        daemonVersion: '2026.8.3400-dev.3800',
        updateAvailable: true,
      });
      expect(byId.get(garbled)!.daemonVersion).toBeUndefined();
      expect(byId.get(silent)!.daemonVersion).toBeUndefined();

      // Older daemons strictly reject unknown machine-list keys, so the
      // display-only fields must not appear on the daemon-authenticated DTO.
      const daemon = await (await app.request('/api/machines', {
        headers: { 'X-Server-Id': source.serverId, authorization: `Bearer ${source.token}` },
      })).json() as { machines: Record<string, unknown>[] };
      expect(daemon.machines.length).toBeGreaterThan(0);
      for (const machine of daemon.machines) {
        expect(machine).not.toHaveProperty('daemonVersion');
        expect(machine).not.toHaveProperty('updateAvailable');
      }
    } finally {
      if (previousAppVersion === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = previousAppVersion;
    }
  });
});

describe('controlled-node shared action admission', () => {
  it('lets a participant in the owner shared session operate an owner node without a direct device share', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const participantId = `participant-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, participantId)]);
    const source = await fullCredential(ownerId);
    const targetId = await controlledNode(ownerId);
    const targetToken = hex(16);
    await db.execute(
      'UPDATE servers SET token_hash = $2, controlled_capabilities = $3::jsonb WHERE id = $1',
      [targetId, sha256(targetToken), JSON.stringify([FILE_TRANSFER_PATH_HANDLE_CAPABILITY])],
    );
    const sessionName = `deck_shared_${hex(4)}`;
    const projectName = `shared-project-${hex(4)}`;
    await db.execute(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, project_dir, state, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'executor','codex-sdk','/tmp/shared','idle',$5,$5)`,
      [hex(16), source.serverId, sessionName, projectName, Date.now()],
    );
    const shareId = `share_${hex(8)}`;
    await createOrUpdateShare(db, {
      id: shareId,
      target: { kind: 'main', serverId: source.serverId, sessionName },
      targetUserId: participantId,
      role: 'participant',
      createdBy: ownerId,
      expiresAt: null,
      now: Date.now(),
    });
    const sourceSocket = new CaptureDaemonSocket();
    const sourceBridge = WsBridge.get(source.serverId);
    sourceBridge.handleDaemonConnection(sourceSocket as never, db, { JWT_SIGNING_KEY: JWT_KEY } as never);
    sourceSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'auth', serverId: source.serverId, token: source.token,
    })), false);
    await waitFor(() => sourceBridge.isDaemonConnected());
    const admission = await app.request(`/api/server/${source.serverId}/session/send`, {
      method: 'POST',
      headers: webAuth(participantId),
      body: JSON.stringify({ sessionName, commandId: `cmd-${hex(4)}`, text: 'run hostname' }),
    });
    expect(admission.status).toBe(200);
    const admitted = sourceSocket.sent.map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((value) => value.type === 'session.send');
    expect(admitted).toMatchObject({
      type: 'session.send', sessionName,
      sharedActor: { actorUserId: participantId, effectiveActorRole: 'participant' },
    });
    const authority = admitted?.sharedMachineAuthority;
    expect(authority).toEqual(expect.any(String));
    const headers = {
      'X-Server-Id': source.serverId,
      authorization: `Bearer ${source.token}`,
      'content-type': 'application/json',
      [SHARED_MACHINE_AUTHORITY_HEADER]: authority as string,
    };

    // Production-shaped owner-local chain:
    // session.send admission above -> daemon runtime bind -> MCP tool ->
    // server /api/machines live revalidation -> local bridge -> UI fact.
    // The local bridge is the only injected edge because a server integration
    // test must not operate the developer workstation's GUI.
    const runtimeIdentity = { sessionInstanceId: `instance-${hex(4)}`, runtimeEpoch: `epoch-${hex(4)}` };
    let callerIdentity = runtimeIdentity;
    bindProcessSharedMachineAuthority(
      sessionName,
      runtimeIdentity,
      authority as string,
      (admitted?.sharedActor as { effectiveActorRole?: unknown } | undefined)?.effectiveActorRole === 'participant',
    );
    const localComputerUse = vi.fn(async ({ tool }: { tool: string }) => ({
      outcome: 'completed' as const,
      result: {
        correlationId: `local-${hex(8)}`,
        ok: true,
        tool,
        content: [{ type: 'text' as const, text: 'local-ok' }],
        durationMs: 1,
      },
    }));
    const daemonFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      return app.request(`${url.pathname}${url.search}`, init);
    };
    const machineDeps = createDaemonMachineToolDeps({
      loadCredential: async () => ({
        serverUrl: 'http://controlled-node-sharing.test',
        serverId: source.serverId,
        token: source.token,
      }),
      loadSharedMachineAuthority: async () => {
        const context = readProcessSharedMachineAuthority(sessionName, callerIdentity);
        if (context.required && !context.authority) throw new Error('shared_machine_authority_unavailable');
        return context.authority;
      },
      listMachines: (input) => daemonListMachines({ ...input, fetchImpl: daemonFetch as typeof fetch }),
      localComputerUseCall: localComputerUse as never,
    });
    const mcpServer = new McpServer({ name: 'shared-local-authority-e2e', version: '1.0.0' });
    registerMemoryMcpTools(mcpServer, {} as McpRuntimeCaller, { machineDeps, nodeRole: NODE_ROLE.FULL });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'shared-local-authority-client', version: '1.0.0' });
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
    const callLocal = () => mcpClient.callTool({
      name: MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
      arguments: { machine: 'local', tool: 'list_apps' },
    });
    const localResult = await callLocal();
    expect(localResult.isError).toBeFalsy();
    expect(localResult.structuredContent).toMatchObject({
      status: 'ok', outcome: 'completed', result: { ok: true, content: [{ text: 'local-ok' }] },
    });
    expect(localComputerUse).toHaveBeenCalledTimes(1);
    const dispatchFact = readMachineControlDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER,
      MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
      { machine: 'local', tool: 'list_apps' },
      localResult.structuredContent,
      'participant-local-call',
    );
    expect(projectDelegationClaim(dispatchFact ? [dispatchFact] : [])).toEqual({
      status: 'substantiated',
      dispatches: [expect.objectContaining({
        dispatchId: 'participant-local-call', machine: 'local', tool: 'computer_use_call',
      })],
    });

    const targetSocket = new CaptureDaemonSocket((message) => {
      if (message.type !== FILE_TRANSFER_MSG.PATH_HANDLE) return;
      queueMicrotask(() => targetSocket.emit('message', Buffer.from(JSON.stringify({
        type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
        requestId: message.requestId,
        attachment: {
          id: 'f'.repeat(32), source: 'local', serverId: '', daemonPath: 'C:\\Temp\\shared.txt',
          createdAt: new Date().toISOString(), downloadable: true,
        },
      })), false));
    });
    const targetBridge = WsBridge.get(targetId);
    targetBridge.handleDaemonConnection(targetSocket as never, db, { JWT_SIGNING_KEY: JWT_KEY } as never);
    targetSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'auth', serverId: targetId, token: targetToken,
      capabilities: [FILE_TRANSFER_PATH_HANDLE_CAPABILITY],
    })), false);
    await waitFor(() => targetBridge.isDaemonConnected());

    const list = await app.request('/api/machines', { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      machines: [expect.objectContaining({ serverId: targetId })],
    });

    const exec = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers, body: JSON.stringify({ command: 'echo shared' }),
    });
    expect(exec.status).toBe(200);
    expect(await exec.json()).toMatchObject({ outcome: 'completed' });

    const computer = await app.request(`/api/machine/computer-use?serverId=${targetId}`, {
      method: 'POST', headers, body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    });
    expect(computer.status).toBe(200);
    expect(await computer.json()).toMatchObject({ outcome: 'completed' });

    const file = await app.request(`/api/server/${targetId}/machine-file-handle`, {
      method: 'POST', headers, body: JSON.stringify({ path: 'C:\\Temp\\shared.txt' }),
    });
    const fileBody = await file.json();
    expect(file.status, JSON.stringify(fileBody)).toBe(200);
    expect(fileBody).toMatchObject({
      ok: true, attachment: { serverId: targetId, daemonPath: 'C:\\Temp\\shared.txt' },
    });

    // The token is only an authenticated admission context. Current role and
    // expiry are re-read at the device action boundary.
    await db.execute('UPDATE session_shares SET role = $2 WHERE id = $1', [shareId, 'viewer']);
    expect((await app.request(`/api/server/${source.serverId}/session/send`, {
      method: 'POST', headers: webAuth(participantId),
      body: JSON.stringify({ sessionName, commandId: `viewer-${hex(4)}`, text: 'must not admit' }),
    })).status).toBe(403);
    const downgraded = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers, body: JSON.stringify({ command: 'echo denied' }),
    });
    expect(downgraded.status).toBe(403);
    expect(await downgraded.json()).toMatchObject({ reason: 'target_forbidden' });
    expect((await app.request('/api/machines', { headers })).status).toBe(403);
    expect((await app.request(`/api/server/${targetId}/machine-file-handle`, {
      method: 'POST', headers, body: JSON.stringify({ path: 'C:\\Temp\\denied.txt' }),
    })).status).toBe(403);
    const downgradedLocal = await callLocal();
    expect(downgradedLocal.isError).toBe(true);
    expect(downgradedLocal.structuredContent).toMatchObject({
      status: 'error', reason: 'control_plane_unavailable',
    });
    expect(localComputerUse, 'role changed after admission must stop before the local bridge')
      .toHaveBeenCalledTimes(1);

    await db.execute('UPDATE session_shares SET role = $2, expires_at = $3 WHERE id = $1', [shareId, 'participant', Date.now() - 1]);
    expect((await app.request(`/api/server/${source.serverId}/session/send`, {
      method: 'POST', headers: webAuth(participantId),
      body: JSON.stringify({ sessionName, commandId: `expired-${hex(4)}`, text: 'must not admit' }),
    })).status).toBe(403);
    expect((await app.request(`/api/machine/computer-use?serverId=${targetId}`, {
      method: 'POST', headers, body: JSON.stringify({ tool: 'list_apps' }),
    })).status).toBe(403);
    expect((await callLocal()).isError).toBe(true);
    expect(localComputerUse).toHaveBeenCalledTimes(1);

    await db.execute('UPDATE session_shares SET expires_at = NULL WHERE id = $1', [shareId]);
    const forgedHeaders = { ...headers, [SHARED_MACHINE_AUTHORITY_HEADER]: `${authority}x` };
    expect((await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers: forgedHeaders, body: JSON.stringify({ command: 'echo forged' }),
    })).status).toBe(403);
    bindProcessSharedMachineAuthority(sessionName, runtimeIdentity, `${authority as string}x`, true);
    expect((await callLocal()).isError).toBe(true);
    expect(localComputerUse).toHaveBeenCalledTimes(1);
    bindProcessSharedMachineAuthority(sessionName, runtimeIdentity, authority as string, true);

    callerIdentity = { ...runtimeIdentity, runtimeEpoch: `${runtimeIdentity.runtimeEpoch}-stale` };
    const staleRuntimeLocal = await callLocal();
    expect(staleRuntimeLocal.isError).toBe(true);
    expect(staleRuntimeLocal.structuredContent).toMatchObject({
      status: 'error', reason: 'internal_error', message: 'shared_machine_authority_unavailable',
    });
    expect(localComputerUse).toHaveBeenCalledTimes(1);
    callerIdentity = runtimeIdentity;

    const wrongProject = signJwt({
      type: SHARED_MACHINE_AUTHORITY_TYPE,
      sub: participantId,
      sourceServerId: source.serverId,
      sessionName,
      projectName: `${projectName}-foreign`,
      shareTarget: { kind: 'main', serverId: source.serverId, sessionName },
      actionId: `action-${hex(4)}`,
    }, JWT_KEY, 300);
    expect((await app.request(`/api/machine/computer-use?serverId=${targetId}`, {
      method: 'POST',
      headers: { ...headers, [SHARED_MACHINE_AUTHORITY_HEADER]: wrongProject },
      body: JSON.stringify({ tool: 'list_apps' }),
    })).status).toBe(403);

    bindProcessSharedMachineAuthority(sessionName, runtimeIdentity, wrongProject, true);
    expect((await callLocal()).isError).toBe(true);
    expect(localComputerUse).toHaveBeenCalledTimes(1);
    bindProcessSharedMachineAuthority(sessionName, runtimeIdentity, authority as string, true);

    const foreignOwnerId = `foreign-owner-${hex(4)}`;
    await createUser(db, foreignOwnerId);
    const foreignTarget = await controlledNode(foreignOwnerId);
    expect((await app.request(`/api/machine/exec?serverId=${foreignTarget}`, {
      method: 'POST', headers, body: JSON.stringify({ command: 'echo foreign' }),
    })).status).toBe(403);

    await db.execute('UPDATE session_shares SET revoked_at = $2 WHERE id = $1', [shareId, Date.now()]);
    expect((await callLocal()).isError).toBe(true);
    expect(localComputerUse).toHaveBeenCalledTimes(1);
    await mcpClient.close();
    clearProcessSharedMachineAuthoritiesForTests();
    sourceSocket.close();
    targetSocket.close();
  });

  it('keeps the registered device-action route matrix explicit for future capability additions', () => {
    const routes = [...new Set(machinesRoutes.routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => route.includes('/:serverId/')))]
      .sort();
    expect(routes).toEqual([
      'POST /:serverId/auto-unlock',
      'POST /:serverId/display-name',
      'POST /:serverId/exec-enabled',
      'POST /:serverId/remote-desktop-worker',
      'POST /:serverId/revoke',
    ]);
  });

  it('allows Participant exec/computer-use, denies Viewer, and expires immediately', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const recipientId = `recipient-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, recipientId)]);
    const source = await fullCredential(recipientId);
    const targetId = await controlledNode(ownerId);
    // Desk scope: exec/computer-use admission is now same-Desk AND role, so the
    // machine is bound and the recipient joined before the role contract below
    // is exercised.
    const deskId = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, targetId, deskId)).status).toBe(200);
    // Deliberately NOT a member of the machine's team: the individual grant
    // is the only thing under test, so expiry and downgrade are visible.
    const grant = await createMachineGrant({ ownerId, recipientId, serverId: targetId, role: 'participant' });
    const auth = {
      'X-Server-Id': source.serverId,
      authorization: `Bearer ${source.token}`,
      'content-type': 'application/json',
    };

    const exec = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ command: 'echo ok' }),
    });
    expect(exec.status).toBe(200);
    expect(await exec.json()).toMatchObject({ outcome: 'completed', stdout: 'ok' });

    const computer = await app.request(`/api/machine/computer-use?serverId=${targetId}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    });
    expect(computer.status).toBe(200);
    expect(await computer.json()).toMatchObject({ outcome: 'completed' });

    await createMachineGrant({ ownerId, recipientId, serverId: targetId, role: 'viewer' });
    const viewerExec = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ command: 'echo denied' }),
    });
    expect(viewerExec.status).toBe(403);
    expect(await viewerExec.json()).toMatchObject({ reason: 'target_forbidden' });
    const viewerComputer = await app.request(`/api/machine/computer-use?serverId=${targetId}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    });
    expect(viewerComputer.status).toBe(403);
    expect(await viewerComputer.json()).toMatchObject({ reason: 'target_forbidden' });
    expect((await app.request(`/api/machines/${targetId}/display-name`, {
      method: 'POST', headers: webAuth(recipientId), body: JSON.stringify({ displayName: 'forbidden' }),
    })).status).toBe(404);

    const outsiderId = `outsider-${hex(4)}`;
    await createUser(db, outsiderId);
    const outsider = await fullCredential(outsiderId);
    const outsiderAuth = {
      'X-Server-Id': outsider.serverId,
      authorization: `Bearer ${outsider.token}`,
      'content-type': 'application/json',
    };
    for (const [path, body] of [
      [`/api/machine/exec?serverId=${targetId}`, { command: 'echo denied' }],
      [`/api/machine/computer-use?serverId=${targetId}`, { tool: 'list_apps', arguments: {} }],
    ] as const) {
      const response = await app.request(path, { method: 'POST', headers: outsiderAuth, body: JSON.stringify(body) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: 'target_forbidden' });
    }

    await db.execute(
      'UPDATE server_shares SET expires_at = $2 WHERE id = $1',
      [grant.id, Date.now() - 1],
    );
    const expiredExec = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ command: 'echo expired' }),
    });
    expect(expiredExec.status).toBe(403);
    expect(await expiredExec.json()).toMatchObject({ reason: 'target_forbidden' });
    const expiredComputer = await app.request(`/api/machine/computer-use?serverId=${targetId}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    });
    expect(expiredComputer.status).toBe(403);
    expect(await expiredComputer.json()).toMatchObject({ reason: 'target_forbidden' });
    expect((await app.request(`/api/machines/${targetId}/auto-unlock`, {
      method: 'POST', headers: webAuth(recipientId), body: JSON.stringify({ secret: null }),
    })).status).toBe(404);
    expect(await (await app.request('/api/machines', { headers: webAuth(recipientId) })).json())
      .toEqual({ machines: [] });
  });
});

// The four Desk-scope suites that stood here specified the superseded model:
// a controlled node had exactly one authorization domain, its team, and every
// other grant was subordinate to it -- an individual share was inert unless
// the grantee was also a team member, and even the owner lost their own
// machine on leaving the team.
//
// That model is replaced, not relaxed. Sharing one machine with one person and
// sharing a group of machines with a team are two independent grants, and a
// machine belongs to whoever installed it. Every combination of the two --
// including the revocations that matter -- is specified in
// machine-team-sharing.integration.test.ts.

describe('putting a machine in a team, and taking it back out', () => {
  it('moves between teams and out again, always at the owner s word', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const serverId = await controlledNode(ownerId);
    const first = await createDesk(ownerId);
    const second = await createDesk(ownerId);

    expect((await bindDesk(app, ownerId, serverId, first)).status).toBe(200);
    expect(await db.queryOne('SELECT team_id FROM servers WHERE id = $1', [serverId]))
      .toEqual({ team_id: first });

    // Filing a machine under the wrong group used to be unfixable short of
    // reinstalling it: rebinding answered 409 and there was no way out at all.
    expect((await bindDesk(app, ownerId, serverId, second)).status).toBe(200);
    expect(await db.queryOne('SELECT team_id FROM servers WHERE id = $1', [serverId]))
      .toEqual({ team_id: second });

    expect((await bindDesk(app, ownerId, serverId, null)).status).toBe(200);
    expect(await db.queryOne('SELECT team_id FROM servers WHERE id = $1', [serverId]))
      .toEqual({ team_id: null });
  });

  it('lets an owner removed from the team still take their machine back', async () => {
    // Otherwise a team admin takes the machine hostage: remove the owner from
    // the team and they can neither move it out nor manage its shares again.
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const adminId = `admin-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, adminId)]);
    const serverId = await controlledNode(ownerId);
    const deskId = await createDesk(ownerId);
    await joinDesk(deskId, adminId, 'admin');
    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);

    await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [deskId, ownerId]);

    expect((await bindDesk(app, ownerId, serverId, null)).status).toBe(200);
    expect(await db.queryOne('SELECT team_id FROM servers WHERE id = $1', [serverId]))
      .toEqual({ team_id: null });
  });

  it('refuses a team the caller does not manage, and someone else s machine', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const strangerId = `stranger-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, strangerId)]);
    const serverId = await controlledNode(ownerId);
    const foreignDesk = await createDesk(strangerId);
    const ownDesk = await createDesk(ownerId);

    // A team the owner is merely not in.
    expect((await bindDesk(app, ownerId, serverId, foreignDesk)).status).toBe(403);
    // A team that does not exist is refused rather than created.
    expect((await bindDesk(app, ownerId, serverId, `desk-${hex(6)}`)).status).toBe(403);
    // Someone else's machine, even into a team they do manage.
    expect((await bindDesk(app, strangerId, serverId, foreignDesk)).status).toBe(404);
    expect(await db.queryOne('SELECT team_id FROM servers WHERE id = $1', [serverId]))
      .toEqual({ team_id: null });

    // And a blank body still does not silently unfile the machine.
    expect((await bindDesk(app, ownerId, serverId, ownDesk)).status).toBe(200);
    const malformed = await app.request(`/api/machines/desk-binding?serverId=${encodeURIComponent(serverId)}`, {
      method: 'POST', headers: webAuth(ownerId), body: JSON.stringify({}),
    });
    expect(malformed.status).toBe(400);
    expect(await db.queryOne('SELECT team_id FROM servers WHERE id = $1', [serverId]))
      .toEqual({ team_id: ownDesk });
  });
});
