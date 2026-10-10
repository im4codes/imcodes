import { mcpToolPayload } from '../../test/helpers/mcp-tool-result.js';
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
import { createOrUpdateShare, setServerShareExecGrant } from '../src/db/tab-sharing.js';
import { issueSharedMachineAuthorityForSession } from '../src/share/shared-machine-authority.js';
import { machinesRoutes } from '../src/routes/machines.js';
import { createMachineExecRoutes, machineExecAuditIntentStore } from '../src/routes/machine-exec.js';
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
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
} from '../../shared/transport/file-transfer.js';
import {
  SHARED_MACHINE_AUTHORITY_HEADER,
  SHARED_MACHINE_AUTHORITY_TYPE,
} from '../../shared/shared-machine-authority.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { createDaemonMachineToolDeps } from '../../src/daemon/machine-mcp-deps.js';
import { listMachines as daemonListMachines } from '../../src/daemon/machine-exec-client.js';
import { registerMemoryMcpTools } from '../../src/daemon/memory-mcp-tools.js';
import {
  bindProcessSharedMachineCommand,
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
/** Join or leave ONE group. A machine can be in several at once. */
async function bindDesk(
  app: ReturnType<typeof buildApp>,
  actorId: string,
  serverId: string,
  teamId: string,
  member = true,
) {
  return app.request(`/api/machines/desk-binding?serverId=${encodeURIComponent(serverId)}`, {
    method: 'POST',
    headers: webAuth(actorId),
    body: JSON.stringify({ teamId, member }),
  });
}

async function groupsOf(serverId: string): Promise<string[]> {
  const rows = await db.query<{ team_id: string }>(
    'SELECT team_id FROM machine_groups WHERE server_id = $1 ORDER BY team_id',
    [serverId],
  );
  return rows.map((row) => row.team_id);
}

async function createMachineGrant(params: {
  ownerId: string;
  recipientId: string;
  serverId: string;
  role: 'viewer' | 'participant';
  expiresAt?: number | null;
  /**
   * The owner's per-device EXECUTE grant. Operating a device is not executing on it (tsk_9a8c291594): these fixtures exercise the
   * delegation and expiry mechanics, so a participant share carries the grant unless a test says `exec: false`.
   */
  exec?: boolean;
}) {
  const share = await createOrUpdateShare(db, {
    id: `share-${hex(8)}`,
    target: { kind: 'server', serverId: params.serverId },
    targetUserId: params.recipientId,
    role: params.role,
    createdBy: params.ownerId,
    expiresAt: params.expiresAt ?? null,
    now: Date.now(),
  });
  await setServerShareExecGrant(db, {
    shareId: share.id, serverId: params.serverId, granted: params.role === 'participant' && (params.exec ?? true), now: Date.now(),
  });
  return share;
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

    // Device management (rename, exec switch, auto-unlock, worker, revoke) is the OWNER's alone: a Participant is refused with 404, the
    // same as a stranger, and nothing about the device changes (F-02).
    const operationMatrix = [
      ['/api/machines/' + serverId + '/display-name', { displayName: 'Participant renamed' }],
      ['/api/machines/' + serverId + '/exec-enabled', { enabled: false }],
      ['/api/machines/' + serverId + '/exec-enabled', { enabled: true }],
      ['/api/machines/' + serverId + '/auto-unlock', { secret: 'participant-supplied' }],
      ['/api/machines/' + serverId + '/remote-desktop-worker', {}],
      ['/api/machines/' + serverId + '/revoke', {}],
    ] as const;
    for (const [path, body] of operationMatrix) {
      const response = await app.request(path, {
        method: 'POST', headers: webAuth(recipientId), body: JSON.stringify(body),
      });
      expect(response.status, `${path} must be owner-only`).toBe(404);
    }
    expect(await db.queryOne<{ revoked_at: number | null; display_name: string | null }>(
      'SELECT revoked_at, display_name FROM servers WHERE id = $1', [serverId],
    )).toMatchObject({ revoked_at: null });
    const listed = await (await app.request('/api/machines', { headers: webAuth(recipientId) })).json() as { machines: { serverId: string }[] };
    expect(listed.machines.map((machine) => machine.serverId)).toContain(serverId);
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
  it('lets a participant in the owner shared session operate an owner node only once the node is shared with them', async () => {
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
    // The same participant re-binding with a different token replaces the token
    // (one window, one actor); an unusable token must still fail at the server.
    const bindAdmittedCommand = (token: string): void => bindProcessSharedMachineCommand(
      sessionName,
      runtimeIdentity,
      { sharedActor: admitted?.sharedActor, sharedMachineAuthority: token },
    );
    bindAdmittedCommand(authority as string);
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
    await mcpClient.listTools(); // Hydrate real SDK output validators before every typed call.
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
    const targetSocket = new CaptureDaemonSocket((message) => {
      if (message.type !== FILE_TRANSFER_MSG.PATH_HANDLE) return;
      queueMicrotask(() => targetSocket.emit('message', Buffer.from(JSON.stringify({
        type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
        requestId: message.requestId,
        attachment: {
          id: 'f'.repeat(32), source: 'local', serverId: '', daemonPath: 'C:\\Temp\\shared.txt',
          createdAt: new Date().toISOString(), downloadable: true,
        },
        sourceIdentity: { size: 10, mtimeMs: 1, device: 2, inode: 3 },
      })), false));
    });
    const targetBridge = WsBridge.get(targetId);
    targetBridge.handleDaemonConnection(targetSocket as never, db, { JWT_SIGNING_KEY: JWT_KEY } as never);
    targetSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'auth', serverId: targetId, token: targetToken,
      capabilities: [FILE_TRANSFER_PATH_HANDLE_CAPABILITY],
    })), false);
    await waitFor(() => targetBridge.isDaemonConnected());

    // A session share grants no device access: with no share of the node to the
    // participant, the owner's agent must not act on it for them, and must not
    // even list it (tsk_d5053704ad).
    const noDeviceShare = await app.request('/api/machines', { headers });
    expect(noDeviceShare.status).toBe(200);
    expect(await noDeviceShare.json()).toEqual({ machines: [] });
    for (const [path, body] of [
      [`/api/machine/exec?serverId=${targetId}`, { command: 'echo no-share' }],
      [`/api/machine/computer-use?serverId=${targetId}`, { tool: 'list_apps', arguments: {} }],
      [`/api/server/${targetId}/machine-file-handle`, { path: 'C:\\Temp\\shared.txt' }],
    ] as const) {
      const denied = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(denied.status, path).toBe(403);
    }
    await createMachineGrant({ ownerId, recipientId: participantId, serverId: targetId, role: 'participant' });

    const list = await app.request('/api/machines', { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      machines: [expect.objectContaining({ serverId: targetId })],
    });

    // A turn the participant started never EXECUTES (tsk_9a8c291594), even though the participant holds an execute grant of their own:
    // the owner's agent must not be a confused deputy. Looking (below) still follows the participant's own access.
    const exec = await app.request(`/api/machine/exec?serverId=${targetId}`, {
      method: 'POST', headers, body: JSON.stringify({ command: 'echo shared' }),
    });
    expect(exec.status).toBe(403);
    expect(await exec.json()).toMatchObject({ outcome: 'not_dispatched', reason: 'target_forbidden' });

    const computer = await app.request(`/api/machine/computer-use?serverId=${targetId}`, {
      method: 'POST', headers, body: JSON.stringify({ tool: 'list_apps', arguments: {} }),
    });
    expect(computer.status).toBe(200);
    expect(await computer.json()).toMatchObject({ outcome: 'completed' });

    // File access is allowed by the participant's own execute grant, independently of exec_remote.
    const file = await app.request(`/api/server/${targetId}/machine-file-handle`, {
      method: 'POST', headers, body: JSON.stringify({ path: 'C:\\Temp\\shared.txt' }),
    });
    expect(file.status).toBe(200);

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
    expect(mcpToolPayload(downgradedLocal)).toMatchObject({
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
    bindAdmittedCommand(`${authority as string}x`);
    expect((await callLocal()).isError).toBe(true);
    expect(localComputerUse).toHaveBeenCalledTimes(1);
    bindAdmittedCommand(authority as string);

    callerIdentity = { ...runtimeIdentity, runtimeEpoch: `${runtimeIdentity.runtimeEpoch}-stale` };
    const staleRuntimeLocal = await callLocal();
    expect(staleRuntimeLocal.isError).toBe(true);
    expect(mcpToolPayload(staleRuntimeLocal)).toMatchObject({
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

    bindAdmittedCommand(wrongProject);
    expect((await callLocal()).isError).toBe(true);
    expect(localComputerUse).toHaveBeenCalledTimes(1);
    bindAdmittedCommand(authority as string);

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
      'GET /:serverId/exec-audit',
      'POST /:serverId/auto-unlock',
      'POST /:serverId/display-name',
      'POST /:serverId/exec-enabled',
      'POST /:serverId/remote-desktop-permissions',
      'POST /:serverId/remote-desktop-worker',
      'POST /:serverId/remote-desktop-worker/refresh',
      'POST /:serverId/revoke',
      'POST /:serverId/upgrade',
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

describe('putting a machine in groups, and taking it back out', () => {
  it('joins several groups at once, and leaving one keeps the others', async () => {
    // The whole point of the join table: shared with ops AND support, without
    // either displacing the other.
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const serverId = await controlledNode(ownerId);
    const ops = await createDesk(ownerId);
    const support = await createDesk(ownerId);

    expect((await bindDesk(app, ownerId, serverId, ops)).status).toBe(200);
    expect((await bindDesk(app, ownerId, serverId, support)).status).toBe(200);
    expect(await groupsOf(serverId)).toEqual([ops, support].sort());

    expect((await bindDesk(app, ownerId, serverId, ops, false)).status).toBe(200);
    expect(await groupsOf(serverId)).toEqual([support]);
  });

  it('is idempotent in both directions', async () => {
    // A retried click must not fail, and must not double-file.
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const serverId = await controlledNode(ownerId);
    const ops = await createDesk(ownerId);

    expect((await bindDesk(app, ownerId, serverId, ops)).status).toBe(200);
    expect((await bindDesk(app, ownerId, serverId, ops)).status).toBe(200);
    expect(await groupsOf(serverId)).toEqual([ops]);

    expect((await bindDesk(app, ownerId, serverId, ops, false)).status).toBe(200);
    expect((await bindDesk(app, ownerId, serverId, ops, false)).status).toBe(200);
    expect(await groupsOf(serverId)).toEqual([]);
  });

  it('lets an owner removed from the group still take their machine out', async () => {
    // Otherwise a group admin takes the machine hostage: remove the owner from
    // the group and they can never get it back out.
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const serverId = await controlledNode(ownerId);
    const deskId = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, serverId, deskId)).status).toBe(200);

    await db.execute('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [deskId, ownerId]);

    expect((await bindDesk(app, ownerId, serverId, deskId, false)).status).toBe(200);
    expect(await groupsOf(serverId)).toEqual([]);
  });

  it('refuses a group the caller does not manage, and someone else s machine', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const strangerId = `stranger-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, strangerId)]);
    const serverId = await controlledNode(ownerId);
    const foreignDesk = await createDesk(strangerId);
    const ownDesk = await createDesk(ownerId);

    expect((await bindDesk(app, ownerId, serverId, foreignDesk)).status).toBe(403);
    expect((await bindDesk(app, ownerId, serverId, `desk-${hex(6)}`)).status).toBe(403);
    expect((await bindDesk(app, strangerId, serverId, foreignDesk)).status).toBe(404);
    expect(await groupsOf(serverId)).toEqual([]);

    // A plain member of a group may not file machines into it either.
    const memberOnly = `member-${hex(4)}`;
    await createUser(db, memberOnly);
    await joinDesk(ownDesk, memberOnly);
    const theirMachine = await controlledNode(memberOnly);
    expect((await bindDesk(app, memberOnly, theirMachine, ownDesk)).status).toBe(403);
    expect(await groupsOf(theirMachine)).toEqual([]);
  });

  it('refuses a malformed body rather than changing membership by omission', async () => {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    await createUser(db, ownerId);
    const serverId = await controlledNode(ownerId);
    const ownDesk = await createDesk(ownerId);
    expect((await bindDesk(app, ownerId, serverId, ownDesk)).status).toBe(200);

    for (const body of [{}, { teamId: ownDesk }, { member: false }, { teamId: '', member: false }]) {
      const malformed = await app.request(`/api/machines/desk-binding?serverId=${encodeURIComponent(serverId)}`, {
        method: 'POST', headers: webAuth(ownerId), body: JSON.stringify(body),
      });
      expect(malformed.status, JSON.stringify(body)).toBe(400);
    }
    // Membership is exactly as it was.
    expect(await groupsOf(serverId)).toEqual([ownDesk]);
  });
});

describe('a shared-session participant reaches only the machines shared with them (tsk_d5053704ad)', () => {
  /**
   * The owner's agent, driven by a participant of one shared session. Four
   * nodes of the owner's: none shared with the participant, shared as
   * participant, shared as viewer, and in a group the participant belongs to.
   */
  async function scene() {
    const app = buildApp();
    const ownerId = `owner-${hex(4)}`;
    const participantId = `participant-${hex(4)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, participantId)]);
    const source = await fullCredential(ownerId);
    const sessionName = `deck_actor_${hex(4)}`;
    await db.execute(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, project_dir, state, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'executor','codex-sdk','/tmp/shared','idle',$5,$5)`,
      [hex(16), source.serverId, sessionName, `actor-project-${hex(4)}`, Date.now()],
    );
    const shareTarget = { kind: 'main' as const, serverId: source.serverId, sessionName };
    const sessionShare = await createOrUpdateShare(db, {
      id: `share_${hex(8)}`, target: shareTarget, targetUserId: participantId,
      role: 'participant', createdBy: ownerId, expiresAt: null, now: Date.now(),
    });
    const authority = await issueSharedMachineAuthorityForSession(db, {
      actorUserId: participantId, sourceServerId: source.serverId, sessionName,
      shareTarget, actionId: `action-${hex(4)}`, signingKey: JWT_KEY,
    });
    expect(authority).toEqual(expect.any(String));
    const delegated = {
      'X-Server-Id': source.serverId,
      authorization: `Bearer ${source.token}`,
      'content-type': 'application/json',
      [SHARED_MACHINE_AUTHORITY_HEADER]: authority as string,
    };
    const ownerTurn = {
      'X-Server-Id': source.serverId,
      authorization: `Bearer ${source.token}`,
      'content-type': 'application/json',
    };
    const unshared = await controlledNode(ownerId);
    const participantShared = await controlledNode(ownerId);
    const viewerShared = await controlledNode(ownerId);
    const grouped = await controlledNode(ownerId);
    await createMachineGrant({ ownerId, recipientId: participantId, serverId: participantShared, role: 'participant' });
    await createMachineGrant({ ownerId, recipientId: participantId, serverId: viewerShared, role: 'viewer' });
    const desk = await createDesk(ownerId);
    await joinDesk(desk, participantId);
    expect((await bindDesk(app, ownerId, grouped, desk)).status).toBe(200);
    return { app, ownerId, participantId, source, delegated, ownerTurn, unshared, participantShared, viewerShared, grouped, sessionShare };
  }

  const listed = async (app: ReturnType<typeof buildApp>, headers: Record<string, string>) => {
    const response = await app.request('/api/machines', { headers });
    expect(response.status).toBe(200);
    return ((await response.json()) as { machines: Array<{ serverId: string }> }).machines.map((m) => m.serverId).sort();
  };
  const exec = (app: ReturnType<typeof buildApp>, headers: Record<string, string>, target: string) => app.request(
    `/api/machine/exec?serverId=${target}`,
    { method: 'POST', headers, body: JSON.stringify({ command: 'echo x' }) },
  );
  const computerUse = (app: ReturnType<typeof buildApp>, headers: Record<string, string>, target: string) => app.request(
    `/api/machine/computer-use?serverId=${target}`,
    { method: 'POST', headers, body: JSON.stringify({ tool: 'list_apps', arguments: {} }) },
  );
  const fileHandle = (app: ReturnType<typeof buildApp>, headers: Record<string, string>, target: string) => app.request(
    `/api/server/${target}/machine-file-handle`,
    { method: 'POST', headers, body: JSON.stringify({ path: '/tmp/x.txt' }) },
  );

  it('hides and denies every owner node that is not shared with the participant, on every device surface', async () => {
    const t = await scene();
    expect(await listed(t.app, t.delegated)).toEqual([t.grouped, t.participantShared].sort());
    for (const [name, target] of [['unshared', t.unshared], ['viewer share', t.viewerShared]] as const) {
      const execDenied = await exec(t.app, t.delegated, target);
      expect(execDenied.status, `exec ${name}`).toBe(403);
      expect(await execDenied.json()).toMatchObject({ reason: 'target_forbidden' });
      expect((await computerUse(t.app, t.delegated, target)).status, `computer-use ${name}`).toBe(403);
      expect((await fileHandle(t.app, t.delegated, target)).status, `file ${name}`).toBe(403);
    }
  });

  it('participant-origin exec_remote is refused, while View and file access follow the real grant', async () => {
    const t = await scene();
    for (const target of [t.participantShared, t.grouped]) {
      // Read-only computer use follows the participant's own access (a machine share, or the group)...
      expect((await computerUse(t.app, t.delegated, target)).status, `computer-use ${target}`).toBe(200);
      // Only exec_remote is participant-gated. A granted file request reaches the offline node (503), not a policy refusal.
      // A group-only actor still lacks the file grant (403).
      const execDenied = await exec(t.app, t.delegated, target);
      expect(execDenied.status, `exec ${target}`).toBe(403);
      expect(await execDenied.json()).toMatchObject({ outcome: 'not_dispatched', reason: 'target_forbidden' });
      expect((await fileHandle(t.app, t.delegated, target)).status, `file ${target}`).toBe(target === t.participantShared ? 503 : 403);
    }
  });

  it('leaves the owner\'s own turns unchanged: every node, no participant involved', async () => {
    const t = await scene();
    expect(await listed(t.app, t.ownerTurn)).toEqual([t.grouped, t.participantShared, t.unshared, t.viewerShared].sort());
    for (const target of [t.unshared, t.viewerShared, t.participantShared, t.grouped]) {
      expect((await exec(t.app, t.ownerTurn, target)).status, `owner exec ${target}`).toBe(200);
      expect((await computerUse(t.app, t.ownerTurn, target)).status, `owner computer-use ${target}`).toBe(200);
    }
  });

  it('denies again as soon as the participant\'s own access ends, with no fallback to the owner', async () => {
    const t = await scene();
    expect((await computerUse(t.app, t.delegated, t.participantShared)).status).toBe(200);
    // Expired, then revoked, then downgraded: each is read live on the next action.
    await db.execute('UPDATE server_shares SET expires_at = $3 WHERE server_id = $1 AND target_user_id = $2', [t.participantShared, t.participantId, Date.now() - 1]);
    expect((await computerUse(t.app, t.delegated, t.participantShared)).status).toBe(403);
    expect(await listed(t.app, t.delegated)).toEqual([t.grouped]);
    await db.execute('UPDATE server_shares SET expires_at = NULL, revoked_at = $3 WHERE server_id = $1 AND target_user_id = $2', [t.participantShared, t.participantId, Date.now()]);
    expect((await computerUse(t.app, t.delegated, t.participantShared)).status).toBe(403);
    await db.execute('UPDATE server_shares SET revoked_at = NULL, role = $3, exec_granted = false WHERE server_id = $1 AND target_user_id = $2', [t.participantShared, t.participantId, 'viewer']);
    expect((await fileHandle(t.app, t.delegated, t.participantShared)).status).toBe(403);
    // Leaving the group removes the group path too.
    await db.execute('DELETE FROM team_members WHERE user_id = $1', [t.participantId]);
    expect((await computerUse(t.app, t.delegated, t.grouped)).status).toBe(403);
    expect(await listed(t.app, t.delegated)).toEqual([]);
    // The owner turn is untouched by any of it.
    expect((await exec(t.app, t.ownerTurn, t.participantShared)).status).toBe(200);
  });

  it('still refuses a forged, foreign or revoked-session authority even on a node shared with the participant', async () => {
    const t = await scene();
    const forged = { ...t.delegated, [SHARED_MACHINE_AUTHORITY_HEADER]: `${t.delegated[SHARED_MACHINE_AUTHORITY_HEADER]}x` };
    expect((await exec(t.app, forged, t.participantShared)).status).toBe(403);
    expect((await app403List(t.app, forged))).toBe(403);
    await db.execute('UPDATE session_shares SET revoked_at = $2 WHERE id = $1', [t.sessionShare.id, Date.now()]);
    expect((await exec(t.app, t.delegated, t.participantShared)).status).toBe(403);
    expect((await app403List(t.app, t.delegated))).toBe(403);
  });

  it('audits a refused participant-turn exec with the participant as the delegated actor, and an unshared target as no_access', async () => {
    const t = await scene();
    const audited = new Hono();
    audited.use('*', async (c, next) => {
      (c as unknown as { env: unknown }).env = { DB: db, JWT_SIGNING_KEY: JWT_KEY, SERVER_URL: 'https://relay.example' };
      await next();
    });
    audited.route('/api/machine/exec', createMachineExecRoutes(async () => ({
      online: true,
      result: { requestId: 'exec', ok: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 },
    }), machineExecAuditIntentStore));
    expect((await exec(audited as never, t.delegated, t.participantShared)).status).toBe(403);
    const refused = await db.queryOne<{ user_id: string; delegated_actor_user_id: string | null; decision: string; reason: string; outcome: string }>(
      'SELECT user_id, delegated_actor_user_id, decision, reason, outcome FROM machine_exec_audit WHERE source_server_id = $1 AND target_server_id = $2',
      [t.source.serverId, t.participantShared],
    );
    expect(refused).toEqual({
      user_id: t.ownerId, delegated_actor_user_id: t.participantId, decision: 'denied', reason: 'participant_turn', outcome: 'denied',
    });
    // An owner turn is audited as the owner (allowed), with no delegated actor.
    expect((await exec(audited as never, t.ownerTurn, t.participantShared)).status).toBe(200);
    const allowed = await db.queryOne<{ user_id: string; delegated_actor_user_id: string | null; decision: string }>(
      `SELECT user_id, delegated_actor_user_id, decision FROM machine_exec_audit
        WHERE source_server_id = $1 AND target_server_id = $2 AND decision = 'allowed'`,
      [t.source.serverId, t.participantShared],
    );
    expect(allowed).toEqual({ user_id: t.ownerId, delegated_actor_user_id: null, decision: 'allowed' });
    // A target that is not shared with the participant at all is refused as no_access, and that is audited too.
    expect((await exec(audited as never, t.delegated, t.unshared)).status).toBe(403);
    expect(await db.queryOne<{ reason: string }>('SELECT reason FROM machine_exec_audit WHERE target_server_id = $1', [t.unshared]))
      .toEqual({ reason: 'no_access' });
  });

  it.each([false, true])('re-reads the participant execute grant when a staged upload is redeemed (delegated=%s)', async (delegated) => {
    const t = await scene();
    const participantDaemon = await fullCredential(t.participantId);
    const ownDaemon = { 'X-Server-Id': participantDaemon.serverId, authorization: `Bearer ${participantDaemon.token}`, 'content-type': 'application/json' };
    const targetToken = hex(16);
    await db.execute('UPDATE servers SET token_hash = $2 WHERE id = $1', [t.participantShared, sha256(targetToken)]);
    const redeemed: number[] = [];
    let revokeBeforeRedeem = false;
    // The daemon redeems a staged file with the one-time URL alone: an app with only the file routes, as the daemon sees it.
    const redeemApp = new Hono();
    redeemApp.use('*', async (c, next) => {
      (c as unknown as { env: unknown }).env = { DB: db, JWT_SIGNING_KEY: JWT_KEY, SERVER_URL: 'https://relay.example' };
      await next();
    });
    redeemApp.route('/api/server', fileTransferRoutes);
    const targetSocket = new CaptureDaemonSocket((message) => {
      if (message.type !== FILE_TRANSFER_MSG.UPLOAD_FETCH) return;
      const url = new URL(String(message.downloadUrl));
      void (async () => {
        if (revokeBeforeRedeem) {
          await db.execute('UPDATE server_shares SET exec_granted = false WHERE server_id = $1 AND target_user_id = $2', [t.participantShared, t.participantId]);
        }
        const staged = await redeemApp.request(`${url.pathname}${url.search}`);
        redeemed.push(staged.status);
        await staged.arrayBuffer().catch(() => undefined);
        targetSocket.emit('message', Buffer.from(JSON.stringify({
          type: FILE_TRANSFER_MSG.UPLOAD_ERROR, uploadId: message.uploadId, message: 'stop',
        })), false);
      })();
    });
    const targetBridge = WsBridge.get(t.participantShared);
    targetBridge.handleDaemonConnection(targetSocket as never, db, { JWT_SIGNING_KEY: JWT_KEY } as never);
    targetSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'auth', serverId: t.participantShared, token: targetToken,
      capabilities: [FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY],
    })), false);
    await waitFor(() => targetBridge.isDaemonConnected());
    const upload = async () => {
      const form = new FormData();
      form.append('file', new File(['payload'], 'payload.txt', { type: 'text/plain' }));
      // The participant's OWN daemon (a turn they did not hand to the owner's agent): they hold the share with the execute grant.
      const { 'content-type': _ignored, ...headers } = delegated ? t.delegated : ownDaemon;
      await t.app.request(`/api/server/${t.participantShared}/upload`, { method: 'POST', headers, body: form });
    };
    await upload();
    await waitFor(() => redeemed.length === 1);
    expect(redeemed[0], 'control: access still held, the daemon redeems the staged file').toBe(200);
    revokeBeforeRedeem = true;
    await upload();
    await waitFor(() => redeemed.length === 2);
    expect(redeemed[1], 'participant execute grant revoked between staging and redeem').toBe(403);
    targetSocket.close();
  });
});

async function app403List(app: ReturnType<typeof buildApp>, headers: Record<string, string>): Promise<number> {
  return (await app.request('/api/machines', { headers })).status;
}
