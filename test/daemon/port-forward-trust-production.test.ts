import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { CONTROLLED_NODE_INSTALL_SUBCOMMAND, CONTROLLED_NODE_ENROLL_STDIN_FLAG } from '../../shared/controlled-node-install.js';
import { PORT_FORWARD_API_PATH, PORT_FORWARD_ERRORS, PORT_FORWARD_TRANSPORT, PORT_FORWARD_TRANSPORT_PREF, isPortForwardMessageType } from '../../shared/port-forward.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { closeDaemonPortForwards, handleWebCommand, setRouterContext } from '../../src/daemon/command-handler.js';
import { createDaemonMachineToolDeps } from '../../src/daemon/machine-mcp-deps.js';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';
import { runPortForwardCliCommand } from '../../src/daemon/port-forward-trust-cli.js';
import { openPortForward, listPortForwards, closePortForward } from '../../src/daemon/port-forward-client.js';
import type { ServerLink } from '../../src/daemon/server-link.js';
import { bootstrapControlledNodeWithDisposition } from '../../src/node/bootstrap.js';
import { parseInstallSubcommandArgs, parseInstallTrustPeers } from '../../src/node/install-cli.js';
import { createControlledNodeRuntime } from '../../src/node/runtime.js';
import { createPortForwardRoutes } from '../../server/src/routes/port-forward.js';
import { WsBridge } from '../../server/src/ws/bridge.js';
import { PortForwardRouter } from '../../server/src/ws/port-forward-router.js';
import type { Database } from '../../server/src/db/client.js';
import { mcpToolPayload } from '../helpers/mcp-tool-result.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const cleanupFns: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  closeDaemonPortForwards('test_cleanup');
  while (cleanupFns.length > 0) {
    const fn = cleanupFns.pop()!;
    await fn();
  }
});

describe('port-forward production identity & trust enrollment (P0 #1)', () => {
  it('registers trust for existing/upgraded FULL + controlled nodes with zero pre-written JSON or injected resolvers and connects end-to-end from MCP', async () => {
    const fullHome = mkdtempSync(join(tmpdir(), 'imc-pf-full-'));
    const ctlDir = mkdtempSync(join(tmpdir(), 'imc-pf-ctl-'));
    const prevImcodesHome = process.env.IMCODES_HOME;
    process.env.IMCODES_HOME = fullHome;
    cleanupFns.push(() => {
      if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
      else process.env.IMCODES_HOME = prevImcodesHome;
      rmSync(fullHome, { recursive: true, force: true });
      rmSync(ctlDir, { recursive: true, force: true });
    });

    const fullId = 'srv_full_prod_1';
    const fullToken = 'tok_full_prod_1';
    const ctlId = 'ctl_prod_1';
    const ctlNodeId = '2519154400';
    const ctlToken = 'tok_ctl_prod_1';
    const userId = 'owner_prod';

    // Real backend HTTP service behind controlled node
    const backend = createHttpServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, via: 'production-trust-cli' }));
    });
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
    const backendPort = (backend.address() as { port: number }).port;
    cleanupFns.push(() => new Promise<void>((r) => backend.close(() => r())));

    // Production DB / HTTP + WS relay server (signaling relay has ZERO knowledge of Ed25519 keys)
    const servers = [
      { id: fullId, user_id: userId, owner_status: 'active', token_hash: sha256(fullToken), status: 'online', node_role: NODE_ROLE.FULL, node_id: null, ref_name: 'full-1', exec_enabled: true, revoked_at: null },
      { id: ctlId, user_id: userId, owner_status: 'active', token_hash: sha256(ctlToken), status: 'online', node_role: NODE_ROLE.CONTROLLED, node_id: ctlNodeId, ref_name: 'ctl-1', exec_enabled: true, revoked_at: null },
    ];
    const queryFn = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FROM servers s') && s.includes('token_hash = $1')) {
        const tokenHash = String(params[0] ?? '');
        const serverId = String(params[1] ?? '');
        const row = servers.find((x) => x.id === serverId && x.token_hash === tokenHash && x.revoked_at == null);
        return (row ? [{ id: row.id, user_id: row.user_id, role: 'owner', node_role: row.node_role, user_status: 'active' }] : []) as T[];
      }
      if (s.includes('FROM servers') && s.includes("node_role = 'controlled' AND node_id = $1")) {
        const value = String(params[0] ?? '');
        return servers
          .filter((x) => x.id === value || (x.node_role === NODE_ROLE.CONTROLLED && x.node_id === value))
          .map((x) => ({ id: x.id, node_id: x.node_id, node_role: x.node_role, revoked_at: x.revoked_at })) as T[];
      }
      if (s.includes('FROM servers WHERE id = $1') && s.includes('token_hash')) {
        const id = String(params[0] ?? '');
        const row = servers.find((x) => x.id === id);
        return (row ? [{
          ...row,
          name: row.ref_name,
          os: 'linux',
          arch: 'x64',
          abi_profile: 'modern',
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
        }] : []) as T[];
      }
      if (s.includes('SELECT id, user_id, node_role, node_id, revoked_at FROM servers WHERE id = $1')) {
        const id = String(params[0] ?? '');
        const row = servers.find((x) => x.id === id);
        return (row ? [row] : []) as T[];
      }
      if (s.includes('FROM servers s') && s.includes('s.node_role = $4')) {
        const uid = String(params[0] ?? '');
        const sidFilter = params.length >= 4 && typeof params[2] === 'string' ? params[2] : null;
        return servers
          .filter((x) => x.node_role === NODE_ROLE.CONTROLLED && x.user_id === uid && (!sidFilter || x.id === sidFilter))
          .map((x) => ({
            id: x.id,
            user_id: x.user_id,
            node_id: x.node_id,
            ref_name: x.ref_name,
            display_name: x.ref_name,
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
      if (s.includes('SELECT status FROM users WHERE id = $1')) return [{ status: 'active' }] as T[];
      if (s.includes('FROM server_shares ss') && s.includes('ss.target_user_id = $2')) return [{ shared: false }] as T[];
      if (s.includes('AS shared') && s.includes('FROM server_shares')) return [{ shared: false }] as T[];
      if (s.includes('SELECT s.user_id, u.status AS user_status') && s.includes('FROM servers s')) {
        return [{ user_id: userId, user_status: 'active' }] as T[];
      }
      if (s.includes('FROM api_keys')) return [] as T[];
      return [] as T[];
    };
    const db = {
      query: queryFn,
      queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const rows = await queryFn<T>(sql, params);
        return rows[0] ?? null;
      },
      execute: async () => ({ changes: 1 }),
      transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(db),
    } as unknown as Database;

    const router = new PortForwardRouter({
      podId: 'pod_prod',
      lookupBridge: (id) => WsBridge.find(id),
    });

    const app = new Hono<{ Bindings: { DB: Database; JWT_SIGNING_KEY: string }; Variables: { userId: string; role: string } }>();
    app.use('*', async (c, next) => {
      c.env = { DB: db, JWT_SIGNING_KEY: 'prod-test-secret' };
      await next();
    });
    app.route(PORT_FORWARD_API_PATH, createPortForwardRoutes(router));

    const httpServer = createHttpServer((req, res) => {
      void (async () => {
        const url = `http://127.0.0.1${req.url ?? '/'}`;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v);
        }
        const fetchReq = new Request(url, {
          method: req.method,
          headers,
          body: req.method && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined,
        });
        const resp = await app.fetch(fetchReq);
        res.statusCode = resp.status;
        resp.headers.forEach((val, key) => res.setHeader(key, val));
        res.end(Buffer.from(await resp.arrayBuffer()));
      })();
    });
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => {
      const m = /^\/api\/server\/([^/]+)\/ws/.exec(req.url ?? '');
      const sid = m?.[1];
      if (!sid) { ws.close(); return; }
      const bridge = WsBridge.get(sid);
      const emitter = Object.assign(new EventEmitter(), {
        get readyState() { return ws.readyState; },
        get bufferedAmount() { return ws.bufferedAmount; },
        send: (data: string) => { if (ws.readyState === ws.OPEN) ws.send(data); },
        close: () => ws.close(),
      });
      ws.on('message', (buf) => {
        const raw = buf.toString('utf8');
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.type === 'string' && parsed.type.startsWith('port_forward.')) {
            router.handleDaemonMessage(sid, bridge.daemonConnectionGeneration(), parsed);
          }
        } catch { /* ignore */ }
        emitter.emit('message', Buffer.from(raw), false);
      });
      ws.on('close', () => {
        emitter.emit('close', 1000, Buffer.alloc(0));
      });
      bridge.handleDaemonConnection(emitter as never, db, {} as never);
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
    const serverPort = (httpServer.address() as { port: number }).port;
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    cleanupFns.push(async () => {
      for (const sid of [fullId, ctlId]) WsBridge.get(sid).kickDaemon();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    });

    // 1. Start FULL daemon production startup hook (setRouterContext -> creates port-forward-identity.json; zero pre-written JSON!).
    setRouterContext({
      sendToUser: () => {},
      sendToServer: () => {},
      hasServer: () => false,
    });
    expect(existsSync(join(fullHome, 'port-forward-identity.json'))).toBe(true);
    expect(existsSync(join(fullHome, 'port-forward-trusted-peers.json'))).toBe(false);

    // Connect FULL daemon WS over production handleWebCommand -> getDaemonPortForwardEngine (NO resolveTrustedPeerPublicKey!).
    const { default: WebSocketClient } = await import('ws');
    const fullWs = new WebSocketClient(`ws://127.0.0.1:${serverPort}/api/server/${fullId}/ws`);
    await new Promise<void>((resolve, reject) => {
      fullWs.once('open', () => {
        fullWs.send(JSON.stringify({ type: 'auth', serverId: fullId, token: fullToken, daemonVersion: '0.1.2' }));
      });
      fullWs.once('error', reject);
      const deadline = Date.now() + 3_000;
      const poll = setInterval(() => {
        if (WsBridge.find(fullId)?.isDaemonConnected()) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error('fullWs auth timeout'));
        }
      }, 15);
      poll.unref?.();
    });
    const serverLinkShim = {
      trySend: (msg: Record<string, unknown>) => {
        if (fullWs.readyState !== fullWs.OPEN) return false;
        fullWs.send(JSON.stringify(msg));
        return true;
      },
      getWsBufferedAmount: () => fullWs.bufferedAmount,
    } as unknown as ServerLink;
    fullWs.on('message', (buf) => {
      const msg = JSON.parse(buf.toString('utf8')) as { type?: string };
      if (msg.type && isPortForwardMessageType(msg.type)) {
        handleWebCommand(msg, serverLinkShim);
      }
    });
    cleanupFns.push(() => { fullWs.close(); });

    // Start controlled node via REAL production createControlledNodeRuntime (no resolver injection, no pre-written JSON!).
    const ctlCredentialPath = join(ctlDir, 'credential.json');
    let ctlAuthError: unknown = null;
    const ctlRuntime = createControlledNodeRuntime(
      { serverId: ctlId, nodeId: ctlNodeId, token: ctlToken, serverUrl, nodeRole: NODE_ROLE.CONTROLLED },
      (url) => new WebSocketClient(url),
      {
        credentialPath: ctlCredentialPath,
        portForwardStateDir: ctlDir,
        discoverLocalDaemons: async () => [],
        onAuthenticationError: (err) => { ctlAuthError = err; },
        remoteDesktopWorker: {
          available: () => false,
          handle: async () => false,
          close: () => {},
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      ctlRuntime.start();
      const deadline = Date.now() + 3_000;
      const poll = setInterval(() => {
        if (WsBridge.find(ctlId)?.isDaemonConnected()) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error(`ctlRuntime failed to connect: ${JSON.stringify({ status: ctlRuntime.connectionStatus(), authErr: String(ctlAuthError) })}`));
        }
      }, 15);
      poll.unref?.();
    });
    cleanupFns.push(() => { ctlRuntime.stop(); });
    expect(existsSync(join(ctlDir, 'port-forward-identity.json'))).toBe(true);
    expect(existsSync(join(ctlDir, 'port-forward-trusted-peers.json'))).toBe(false);

    // Build real MCP server using FULL daemon machine deps talking to our HTTP server.
    const machineDeps = createDaemonMachineToolDeps({
      loadCredential: async () => ({ serverUrl, serverId: fullId, token: fullToken }),
      openPortForward: (opts) => openPortForward(opts),
      listPortForwards: (opts) => listPortForwards(opts),
      closePortForward: (opts) => closePortForward(opts),
    });
    const mcpServer = createMemoryMcpServerFromEnv({
      env: {
        IMCODES_MCP_SESSION_NAME: 'deck_prod_brain',
        IMCODES_MCP_BACKEND: 'claude-code-sdk',
        IMCODES_MCP_PROVIDER_ID: 'claude-code',
        IMCODES_MCP_SERVER_ID: fullId,
      },
      toolDeps: { machineDeps },
    });
    const mcpClient = new Client({ name: 'prod-pf-mcp', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(ct), mcpServer.connect(st)]);
    cleanupFns.push(() => mcpClient.close());

    // Discover group:port-forwarding via production MCP discovery tool before invoking port_forward_open.
    const discoverRes = await mcpClient.callTool({
      name: MCP_TOOL_DISCOVERY_NAME,
      arguments: { query: 'group:port-forwarding' },
    });
    expect(discoverRes.isError).not.toBe(true);

    // 2. BEFORE trust registration: MCP port_forward_open MUST fail closed (relay-independent trust not established!).
    const untrustedOpen = await mcpClient.callTool({
      name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN,
      arguments: { listenNode: 'local', targetNode: ctlNodeId, targetPort: backendPort, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY },
    });
    expect(untrustedOpen.isError).toBe(true);
    expect(JSON.stringify(untrustedOpen.structuredContent ?? untrustedOpen.content)).toContain('identity');

    // 3. Run REAL production CLI (`port-forward identity --json` and `port-forward trust add`) on BOTH sides
    //    (simulating existing/upgraded online nodes with zero daemon restart required!).
    let fullIdentityOut = '';
    expect(await runPortForwardCliCommand(['identity', '--json'], {
      role: 'full',
      stateDir: fullHome,
      credentialPath: join(fullHome, 'server.json'),
      stdout: (t) => { fullIdentityOut += t; },
      stderr: () => {},
    })).toBe(0);
    const fullIdent = JSON.parse(fullIdentityOut) as { identityPublicKey: string };

    let ctlIdentityOut = '';
    expect(await runPortForwardCliCommand(['identity', '--json'], {
      role: 'controlled',
      stateDir: ctlDir,
      credentialPath: ctlCredentialPath,
      stdout: (t) => { ctlIdentityOut += t; },
      stderr: () => {},
    })).toBe(0);
    const ctlIdent = JSON.parse(ctlIdentityOut) as { identityPublicKey: string };

    // Mismatched/wrong key fails closed first!
    const rogueKey = Buffer.from(fullIdent.identityPublicKey, 'base64url');
    rogueKey[rogueKey.length - 1] ^= 0xff;
    expect(await runPortForwardCliCommand(['trust', 'add', ctlId, rogueKey.toString('base64url')], {
      role: 'full',
      stateDir: fullHome,
      credentialPath: join(fullHome, 'server.json'),
      stdout: () => {},
      stderr: () => {},
    })).toBe(0);
    expect(await runPortForwardCliCommand(['trust', 'add', fullId, fullIdent.identityPublicKey], {
      role: 'controlled',
      stateDir: ctlDir,
      credentialPath: ctlCredentialPath,
      stdout: () => {},
      stderr: () => {},
    })).toBe(0);

    const mismatchedOpen = await mcpClient.callTool({
      name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN,
      arguments: { listenNode: 'local', targetNode: ctlNodeId, targetPort: backendPort, transport: PORT_FORWARD_TRANSPORT_PREF.RELAY },
    });
    expect(mismatchedOpen.isError).toBe(true);
    expect(JSON.stringify(mismatchedOpen.structuredContent ?? mismatchedOpen.content)).toContain('identity');

    // Now register the authentic controlled node key via production trust CLI and verify MCP opens & forwards traffic!
    expect(await runPortForwardCliCommand(['trust', 'add', ctlId, ctlIdent.identityPublicKey], {
      role: 'full',
      stateDir: fullHome,
      credentialPath: join(fullHome, 'server.json'),
      stdout: () => {},
      stderr: () => {},
    })).toBe(0);

    const openOk = await mcpClient.callTool({
      name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_OPEN,
      arguments: {
        listenNode: 'local',
        targetNode: ctlNodeId,
        targetPort: backendPort,
        transport: PORT_FORWARD_TRANSPORT_PREF.AUTO,
      },
    });
    expect(openOk.isError).not.toBe(true);
    const openedPayload = mcpToolPayload<{
      status: string;
      tunnelId: string;
      listenPort: number;
      transportMode: string;
    }>(openOk);
    expect(openedPayload.status).toBe('ok');
    expect([
      PORT_FORWARD_TRANSPORT.DIRECT_TCP,
      PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P,
      PORT_FORWARD_TRANSPORT.RELAY,
    ]).toContain(openedPayload.transportMode);

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: openedPayload.listenPort, path: '/' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({ ok: true, via: 'production-trust-cli' });

    const closeOk = await mcpClient.callTool({
      name: MEMORY_MCP_TOOL_NAMES.PORT_FORWARD_CLOSE,
      arguments: { tunnelId: openedPayload.tunnelId },
    });
    expect(closeOk.isError).not.toBe(true);
    expect(PORT_FORWARD_ERRORS.SCOPED_AUTH).toBe('scoped_auth');
  });

  it('pins owner-supplied --trust-peer during controlled-node enrollment bootstrap cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imc-pf-enroll-'));
    cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));

    let out = '';
    expect(await runPortForwardCliCommand(['identity', '--json'], {
      role: 'full',
      stateDir: dir,
      credentialPath: join(dir, 'server.json'),
      stdout: (t) => { out += t; },
      stderr: () => {},
    })).toBe(0);
    const fullPub = (JSON.parse(out) as { identityPublicKey: string }).identityPublicKey;

    const argv = [
      'node',
      'imcodes-node',
      CONTROLLED_NODE_INSTALL_SUBCOMMAND,
      CONTROLLED_NODE_ENROLL_STDIN_FLAG,
      '--trust-peer',
      `srv_owner_1=${fullPub}`,
    ];
    expect(parseInstallSubcommandArgs(argv)).toBe(true);
    const trustedPeers = parseInstallTrustPeers(argv);
    expect(trustedPeers).toEqual([{ peerServerId: 'srv_owner_1', publicKey: fullPub }]);

    const ctlStateDir = join(dir, 'ctl-state');
    const journalPath = join(ctlStateDir, 'install-journal.json');
    const credentialPath = join(ctlStateDir, 'credential.json');
    let persistedJournal: Record<string, unknown> = { phase: 'uninstalled', history: [], installId: 'inst_1' };
    const bootstrapRes = await bootstrapControlledNodeWithDisposition({
      enrollmentBlob: { serverUrl: 'https://relay.example.com', enrollToken: 'tok_x' },
      trustedPeers,
      portForwardStateDir: ctlStateDir,
      loadCredential: async () => null,
      openVerifiedEnrollmentSource: async () => ({
        sourcePath: '/tmp/imcodes-node-src',
        identity: { size: 1, mtimeMs: 1, ctimeMs: 1 },
        statSize: async () => 1,
        readExactly: async () => Buffer.alloc(1),
        readEnrollmentBlobWithRange: async () => null,
        stageTrailerFreeExecutable: async (dest) => ({
          path: dest,
          size: 1,
          sha256: 'abc',
          sourceIdentity: { size: 1, mtimeMs: 1, ctimeMs: 1 },
          stagedIdentity: { size: 1, mtimeMs: 1, ctimeMs: 1 },
        }),
        cleanupEnrollmentSource: async () => 'skipped',
        close: async () => {},
      }),
      loadInstallIdentity: async () => null,
      persistInstallIdentity: async () => {},
      generateInstallIdentity: () => ({ installId: 'inst_1', nodeToken: 'ntok', nodeTokenHash: 'nhash', sourceExePath: '/tmp/src' }),
      redeemEnrollmentV2: async () => ({
        serverId: 'ctl_enrolled_1',
        nodeId: '9988776655',
        token: 'tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: NODE_ROLE.CONTROLLED,
      }),
      persistCredential: async () => {},
      installDefinition: async (exePath) => ({ serviceName: 'imcodes-node', definitionPath: '/tmp/svc', executablePath: exePath }),
      inspectDefinition: async () => ({ serviceName: 'imcodes-node', definitionPath: '/tmp/svc', executablePath: '/tmp/staged' }),
      inspectServiceState: async () => ({ matchesReceipt: true, installed: true, enabledOnBoot: true, running: true, privilegedPrincipal: true, restartPolicy: true, detail: 'ok' }),
      startService: async () => {},
      verifyStagedExecutable: async () => {},
      isStableRuntime: async () => false,
      assertElevated: () => {},
      ensureReleasePublisherTrust: async () => {},
      inspectSourceArtifact: async () => ({ sha256: 'abc', size: 1 }),
      prepareCredentialDir: async () => {},
      loadInstallJournal: async () => persistedJournal as never,
      writeInstallPhase: async (_p, phase, patch) => {
        persistedJournal = { ...persistedJournal, ...(patch as Record<string, unknown>), phase };
        return persistedJournal as never;
      },
      journalPath,
      credentialPath,
      stagedExecutablePath: '/tmp/staged',
      sourceExecutablePath: '/tmp/src',
      now: Date.now(),
      warn: () => {},
    });

    expect(bootstrapRes.disposition).toBe('handoff_complete');
    expect(bootstrapRes.portForwardIdentityPublicKey).toBeTruthy();

    let listOut = '';
    expect(await runPortForwardCliCommand(['trust', 'list', '--json'], {
      role: 'controlled',
      stateDir: ctlStateDir,
      credentialPath,
      stdout: (t) => { listOut += t; },
      stderr: () => {},
    })).toBe(0);
    const listJson = JSON.parse(listOut) as { peers: Array<{ peerServerId: string; publicKey: string }> };
    expect(listJson.peers.some((p) => p.peerServerId === 'srv_owner_1' && p.publicKey === fullPub)).toBe(true);
  });
});
