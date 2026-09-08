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
async function bindDesk(app: ReturnType<typeof buildApp>, actorId: string, serverId: string, teamId: string) {
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
    // Desk scope: a controlled node grants share access only inside its bound
    // Desk, so this pre-existing role/isolation contract is now exercised on a
    // properly bound machine with the recipient a member of the same Desk.
    const deskId = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);
    await joinDesk(deskId, recipientId);

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
    await joinDesk(deskId, recipientId);
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

describe('controlled-node Desk scope fails closed', () => {
  it('keeps a legacy unbound machine owner-only and makes pre-existing shares inert', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const recipientId = `recipient-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, recipientId)]);
    // A machine enrolled before Desk scope: team_id stays NULL and is never
    // guessed or backfilled from the owner's teams.
    const serverId = await controlledNode(ownerId);
    expect(await db.queryOne<{ team_id: string | null }>(
      'SELECT team_id FROM servers WHERE id = $1', [serverId],
    )).toEqual({ team_id: null });

    // A historical direct share row survives in the table...
    await createMachineGrant({ ownerId, recipientId, serverId, role: 'participant' });
    expect(await db.queryOne<{ present: number }>(
      'SELECT 1 AS present FROM server_shares WHERE server_id = $1 AND target_user_id = $2',
      [serverId, recipientId],
    )).toEqual({ present: 1 });

    // ...but grants nothing until the owner explicitly binds a Desk.
    expect(await (await app.request('/api/machines', { headers: webAuth(recipientId) })).json())
      .toEqual({ machines: [] });
    // The owner keeps access to their own machine.
    expect((await (await app.request('/api/machines', { headers: webAuth(ownerId) })).json() as {
      machines: { serverId: string }[];
    }).machines.map((m) => m.serverId)).toContain(serverId);
  });

  it('binds a Desk only for an eligible owner and refuses every other shape', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const outsiderId = `outsider-${hex(4)}`;
    const strangerId = `stranger-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, outsiderId), createUser(db, strangerId)]);
    const serverId = await controlledNode(ownerId);
    const deskId = await createDesk(ownerId);
    const foreignDesk = await createDesk(strangerId);

    // Non-owner of the machine cannot bind it anywhere.
    expect((await bindDesk(app, outsiderId, serverId, deskId)).status).toBe(404);
    // Owner cannot bind to a Desk they are not a member of.
    expect((await bindDesk(app, ownerId, serverId, foreignDesk)).status).toBe(403);
    // Unknown Desk is refused rather than created.
    expect((await bindDesk(app, ownerId, serverId, `desk-${hex(6)}`)).status).toBe(403);
    // Missing/blank Desk is refused; ambiguity never falls back to a default.
    expect((await app.request(`/api/machines/desk-binding?serverId=${encodeURIComponent(serverId)}`, {
      method: 'POST', headers: webAuth(ownerId), body: JSON.stringify({}),
    })).status).toBe(400);
    // Still unbound after every rejection.
    expect(await db.queryOne<{ team_id: string | null }>(
      'SELECT team_id FROM servers WHERE id = $1', [serverId],
    )).toEqual({ team_id: null });

    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);
    expect(await db.queryOne<{ team_id: string | null }>(
      'SELECT team_id FROM servers WHERE id = $1', [serverId],
    )).toEqual({ team_id: deskId });
    // Rebinding is refused even when the owner is fully eligible for the other
    // Desk -- eligibility is not the question, moving authorization domains is.
    const secondDesk = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, serverId, secondDesk)).status).toBe(409);
    // Re-binding to the SAME Desk stays idempotent so a retried install is safe.
    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);
    expect(await db.queryOne<{ team_id: string | null }>(
      'SELECT team_id FROM servers WHERE id = $1', [serverId],
    )).toEqual({ team_id: deskId });
  });

  it('admits same-Desk grants by permission and denies cross-Desk ones', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const memberId = `member-${hex(4)}`;
    const outsiderId = `outsider-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, memberId), createUser(db, outsiderId)]);
    const serverId = await controlledNode(ownerId);
    const deskId = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);

    // Same Desk + viewer: authorized, but NOT control-capable.
    await joinDesk(deskId, memberId);
    await createMachineGrant({ ownerId, recipientId: memberId, serverId, role: 'viewer' });
    expect(await (await app.request('/api/machines', { headers: webAuth(memberId) })).json())
      .toEqual({ machines: [expect.objectContaining({ serverId, accessRole: 'viewer', execEnabled: false })] });

    // Same Desk + participant: control-capable.
    await createMachineGrant({ ownerId, recipientId: memberId, serverId, role: 'participant' });
    expect(await (await app.request('/api/machines', { headers: webAuth(memberId) })).json())
      .toEqual({ machines: [expect.objectContaining({ serverId, accessRole: 'participant', execEnabled: true })] });

    // A share row for someone outside the Desk grants nothing, even at
    // participant role -- this is the cross-Desk case that must fail closed.
    await createMachineGrant({ ownerId, recipientId: outsiderId, serverId, role: 'participant' });
    expect(await (await app.request('/api/machines', { headers: webAuth(outsiderId) })).json())
      .toEqual({ machines: [] });

    // Losing Desk membership revokes access even though the share row remains.
    await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [deskId, memberId]);
    expect(await (await app.request('/api/machines', { headers: webAuth(memberId) })).json())
      .toEqual({ machines: [] });
  });
});

describe('controlled-node share creation refuses grants it could never honour', () => {
  it('rejects a share on an unbound machine and to anyone outside the Desk', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const memberId = `member-${hex(4)}`;
    const outsiderId = `outsider-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, memberId), createUser(db, outsiderId)]);
    const serverId = await controlledNode(ownerId);
    const share = (targetUserId: string) => app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: webAuth(ownerId),
      body: JSON.stringify({ target: { kind: 'server', serverId }, targetUserId, role: 'viewer' }),
    });

    // Unbound machine: there is no Desk to share within yet.
    const unbound = await share(memberId);
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toMatchObject({ reason: 'desk_unbound' });

    const deskId = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);

    // Bound, but the target is outside the Desk. Admission would refuse this
    // grant anyway, so writing the row would only mislead the owner into
    // believing the machine had been shared.
    const outside = await share(outsiderId);
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ reason: 'desk_membership_required' });
    expect(await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM server_shares WHERE server_id = $1 AND target_user_id = $2',
      [serverId, outsiderId],
    )).toEqual({ count: 0 });

    // Same Desk: accepted.
    await joinDesk(deskId, memberId);
    expect((await share(memberId)).status).toBe(201);
  });
});

describe('controlled-node Desk authority binds every actor, owner included', () => {
  it('revokes the owning enroller once they leave the Desk, and only spares unbound machines', async () => {
    // R4 audit P0. Membership used to be checked only inside the share JOIN, so
    // the owner arm admitted `s.user_id = $1` unconditionally: an admin who
    // enrolled a machine and was then removed from the Desk kept owner-level
    // exec / remote-desktop / file authority forever. That is the most
    // dangerous actor to leave behind, not the least.
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const bound = await controlledNode(ownerId);
    const legacy = await controlledNode(ownerId);
    const deskId = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, bound, deskId)).status).toBe(200);

    const visible = async () => ((await (await app.request('/api/machines', {
      headers: webAuth(ownerId),
    })).json()) as { machines: { serverId: string }[] }).machines.map((m) => m.serverId);

    // While a member, the owner sees both machines.
    expect(await visible()).toEqual(expect.arrayContaining([bound, legacy]));

    // Remove the owner from the Desk their machine is bound to.
    await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [deskId, ownerId]);
    const after = await visible();
    expect(after, 'a bound machine must follow current Desk authority').not.toContain(bound);
    // The narrow bootstrap exception: an unbound legacy machine stays
    // owner-only so its owner can still reach the bind step at all.
    expect(after, 'an unbound legacy machine stays owner-reachable').toContain(legacy);

    // Rejoining the Desk restores authority, since membership is read live.
    await joinDesk(deskId, ownerId);
    expect(await visible()).toEqual(expect.arrayContaining([bound, legacy]));
  });
});

describe('a removed owner loses management, not just visibility', () => {
  it('fails closed on share management and every sensitive machine mutation', async () => {
    // R5 audit P0, reproduced exactly. The previous round fenced only the
    // admission resolver, so an owner removed from the Desk could no longer SEE
    // the machine yet could still hand out access to it and flip SYSTEM exec.
    // Hiding a machine from someone who can still grant control of it is worse
    // than not hiding it, so every management surface is asserted here, not
    // just /api/machines visibility.
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const recipientId = `recipient-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, recipientId)]);
    const serverId = await controlledNode(ownerId);
    const deskId = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);
    await joinDesk(deskId, recipientId);

    // Baseline: while still in the Desk the owner really can manage it, so the
    // assertions below cannot pass merely because the routes are broken.
    const beforeShare = await app.request(`/api/server/${serverId}/shares`, {
      method: 'POST',
      headers: webAuth(ownerId),
      body: JSON.stringify({ target: { kind: 'server', serverId }, targetUserId: recipientId, role: 'viewer' }),
    });
    expect(beforeShare.status).toBe(201);
    const shareId = (await beforeShare.json() as { share: { id: string } }).share.id;
    expect((await app.request(`/api/machines/${serverId}/exec-enabled`, {
      method: 'POST', headers: webAuth(ownerId), body: JSON.stringify({ enabled: true }),
    })).status).toBe(200);

    // The owner is removed from the Desk the machine is bound to.
    await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [deskId, ownerId]);

    const post = (path: string, body: unknown) => app.request(path, {
      method: 'POST', headers: webAuth(ownerId), body: JSON.stringify(body),
    });

    // Share management: create, update and revoke must all fail closed.
    expect((await post(`/api/server/${serverId}/shares`, {
      target: { kind: 'server', serverId }, targetUserId: recipientId, role: 'participant',
    })).status).toBe(403);
    expect((await app.request(`/api/server/${serverId}/shares/${shareId}`, {
      method: 'PATCH', headers: webAuth(ownerId), body: JSON.stringify({ role: 'participant' }),
    })).status).toBe(403);
    expect((await app.request(`/api/server/${serverId}/shares/${shareId}`, {
      method: 'DELETE', headers: webAuth(ownerId),
    })).status).toBe(403);

    // Sensitive machine mutations: none may be performed by a removed owner.
    expect((await post(`/api/machines/${serverId}/exec-enabled`, { enabled: false })).status).toBe(404);
    expect((await post(`/api/machines/${serverId}/display-name`, { displayName: 'renamed by outsider' })).status).toBe(404);
    expect((await post(`/api/machines/${serverId}/auto-unlock`, { secret: 'hunter2' })).status).not.toBe(200);
    expect((await post(`/api/machines/${serverId}/remote-desktop-worker`, {})).status).not.toBe(200);
    expect((await post(`/api/machines/${serverId}/revoke`, {})).status).toBe(404);

    // Nothing was mutated behind the refusals.
    expect(await db.queryOne<{ display_name: string; exec_enabled: boolean; revoked_at: number | null }>(
      'SELECT display_name, exec_enabled, revoked_at FROM servers WHERE id = $1', [serverId],
    )).toMatchObject({ display_name: 'Shared machine', exec_enabled: true, revoked_at: null });
    // The grant made while authorised is untouched as a row, and inert anyway
    // because admission also requires live membership.
    expect(await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM server_shares WHERE server_id = $1 AND revoked_at IS NULL',
      [serverId],
    )).toEqual({ count: 1 });

    // Rejoining restores management, proving the fence tracks live membership
    // rather than permanently burning the owner.
    await joinDesk(deskId, ownerId);
    expect((await post(`/api/machines/${serverId}/display-name`, { displayName: 'renamed by owner' })).status).toBe(200);
  });

  it('still lets the owner of an unbound legacy machine manage it', async () => {
    // The bootstrap exception must survive: an unbound machine has no Desk to
    // check, and its owner must keep management or the bind step is unreachable.
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const legacy = await controlledNode(ownerId);
    expect(await db.queryOne<{ team_id: string | null }>(
      'SELECT team_id FROM servers WHERE id = $1', [legacy],
    )).toEqual({ team_id: null });
    expect((await app.request(`/api/machines/${legacy}/display-name`, {
      method: 'POST', headers: webAuth(ownerId), body: JSON.stringify({ displayName: 'legacy rename' }),
    })).status).toBe(200);
  });
});
