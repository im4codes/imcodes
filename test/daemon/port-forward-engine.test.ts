import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as tcpConnect, createServer as createTcpServer, type Server as NetServer, type Socket as NetSocket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_MSG,
  PORT_FORWARD_ROLE,
  PORT_FORWARD_TRANSPORT,
  PORT_FORWARD_TRANSPORT_PREF,
  type PortForwardCandidate,
  type PortForwardWireMessage,
} from '../../shared/port-forward.js';
import {
  computeEphemeralKeyProof,
  deriveAdmissionMacKey,
  generateEndpointIdentityKeyPair,
  generateEphemeralEcdhKeyPair,
  signPortForwardTranscript,
} from '../../src/daemon/port-forward-crypto.js';
import { PortForwardEngine } from '../../src/daemon/port-forward-engine.js';
import { probeStunCandidates } from '../../src/daemon/port-forward-stun.js';
import { PortForwardRouter, type PortForwardBridgeEndpoint } from '../../server/src/ws/port-forward-router.js';

const cleanupCallbacks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const fn = cleanupCallbacks.pop()!;
    await fn();
  }
});

function createPairedEngines(options: {
  listenOpts?: Partial<ConstructorParameters<typeof PortForwardEngine>[0]>;
  targetOpts?: Partial<ConstructorParameters<typeof PortForwardEngine>[0]>;
  prepareTimeoutMs?: number;
  establishTimeoutMs?: number;
} = {}) {
  const bridges = new Map<string, PortForwardBridgeEndpoint>();
  const router = new PortForwardRouter({
    lookupBridge: (id) => bridges.get(id),
    getIceServers: () => [],
    prepareTimeoutMs: options.prepareTimeoutMs ?? 3_000,
    establishTimeoutMs: options.establishTimeoutMs ?? 5_000,
  });

  const capturedMessages: Array<{ from: string; msg: PortForwardWireMessage }> = [];
  const identityA = options.listenOpts?.identityKeyPair ?? generateEndpointIdentityKeyPair();
  const identityB = options.targetOpts?.identityKeyPair ?? generateEndpointIdentityKeyPair();

  const listenEngine = new PortForwardEngine({
    sendWs: (msg) => {
      capturedMessages.push({ from: 'node_a', msg });
      queueMicrotask(() => {
        router.handleDaemonMessage('node_a', 1, msg);
      });
    },
    collectInterfaceAddresses: () => ['127.0.0.1'],
    identityKeyPair: identityA,
    resolveTrustedPeerPublicKey: (id) => (id === 'node_b' ? identityB.publicKeyB64 : null),
    timeouts: {
      directTcpMs: 300,
      directTcpPreferenceWaitMs: 60,
      directTcpTargetDialDelayMs: 25,
      udpPunchMs: 500,
      udpPunchIntervalMs: 30,
      stunProbeMs: 100,
    },
    ...options.listenOpts,
  });

  const targetEngine = new PortForwardEngine({
    sendWs: (msg) => {
      capturedMessages.push({ from: 'node_b', msg });
      queueMicrotask(() => {
        router.handleDaemonMessage('node_b', 1, msg);
      });
    },
    collectInterfaceAddresses: () => ['127.0.0.1'],
    identityKeyPair: identityB,
    resolveTrustedPeerPublicKey: (id) => (id === 'node_a' ? identityA.publicKeyB64 : null),
    timeouts: {
      directTcpMs: 300,
      directTcpPreferenceWaitMs: 60,
      directTcpTargetDialDelayMs: 25,
      udpPunchMs: 500,
      udpPunchIntervalMs: 30,
      stunProbeMs: 100,
    },
    ...options.targetOpts,
  });

  const makeBridge = (serverId: string, engine: PortForwardEngine): PortForwardBridgeEndpoint => {
    let connected = true;
    return {
      isDaemonConnected: () => connected,
      daemonConnectionGeneration: () => 1,
      trySendPortForward: (message) => {
        if (!connected) return false;
        void engine.handleMessage(message);
        return true;
      },
      // helper attached for disconnect tests
      ...({ disconnect: () => { connected = false; router.onDaemonDisconnected(serverId, 1); } } as object),
    };
  };

  const bridgeA = makeBridge('node_a', listenEngine);
  const bridgeB = makeBridge('node_b', targetEngine);
  bridges.set('node_a', bridgeA);
  bridges.set('node_b', bridgeB);

  cleanupCallbacks.push(() => {
    listenEngine.closeAll('test_end');
    targetEngine.closeAll('test_end');
  });

  return { router, listenEngine, targetEngine, capturedMessages, bridgeA, bridgeB };
}

async function startTestAppServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const bigPayload = Buffer.allocUnsafe(1_500_000);
  for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = (i * 17 + 3) & 0xff;
  const bigHash = createHash('sha256').update(bigPayload).digest('hex');

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, secret: 'TOP_SECRET_HTTP_BODY' }));
      return;
    }
    if (req.url === '/large') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-sha256': bigHash,
        'content-length': String(bigPayload.length),
      });
      res.end(bigPayload);
      return;
    }
    if (req.url === '/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      ws.send(isBinary ? data : `echo:${data.toString()}`);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    close: () => new Promise<void>((resolve) => {
      wss.close(() => httpServer.close(() => resolve()));
    }),
  };
}

function httpGet(port: number, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function runFullTrafficSuite(listenPort: number): Promise<void> {
  // 1. HTTP GET JSON
  const hello = await httpGet(listenPort, '/hello');
  expect(hello.status).toBe(200);
  expect(JSON.parse(hello.body.toString('utf8'))).toEqual({ ok: true, secret: 'TOP_SECRET_HTTP_BODY' });

  // 2. WebSocket bidirectional communication
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${listenPort}/ws`);
    ws.once('error', reject);
    ws.once('open', () => ws.send('hello-tunnel'));
    ws.once('message', (data) => {
      expect(data.toString()).toBe('echo:hello-tunnel');
      ws.close();
      resolve();
    });
  });

  // 3. Concurrent multi-stream large payload integrity
  const parallelResponses = await Promise.all(
    Array.from({ length: 5 }, () => httpGet(listenPort, '/large')),
  );
  for (const res of parallelResponses) {
    expect(res.status).toBe(200);
    const actualHash = createHash('sha256').update(res.body).digest('hex');
    expect(actualHash).toBe(res.headers['x-sha256']);
  }
}

describe('PortForwardEngine 3-tier transport & mux suites', () => {
  it.each([
    { label: 'direct_tcp (auto LAN)', pref: PORT_FORWARD_TRANSPORT_PREF.AUTO, expected: PORT_FORWARD_TRANSPORT.DIRECT_TCP, disableTcp: false, disableUdp: false },
    { label: 'direct_udp_p2p (STUN/UDP)', pref: PORT_FORWARD_TRANSPORT_PREF.AUTO, expected: PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P, disableTcp: true, disableUdp: false },
    { label: 'relay fallback (auto when P2P blocked)', pref: PORT_FORWARD_TRANSPORT_PREF.AUTO, expected: PORT_FORWARD_TRANSPORT.RELAY, disableTcp: true, disableUdp: true },
    { label: 'explicit relay', pref: PORT_FORWARD_TRANSPORT_PREF.RELAY, expected: PORT_FORWARD_TRANSPORT.RELAY, disableTcp: false, disableUdp: false },
  ])('forwards HTTP, WebSocket, and concurrent 1.5MB binary streams over $label', async ({ pref, expected, disableTcp, disableUdp }) => {
    const appServer = await startTestAppServer();
    cleanupCallbacks.push(appServer.close);

    // Note: in `PortForwardEngine`, candidates omit 127.0.0.1 by default unless injected in `collectInterfaceAddresses`.
    // Test overriding `collectInterfaceAddresses` to `['127.0.0.1']` drives real loopback direct TCP / UDP!
    const { router, capturedMessages } = createPairedEngines({
      listenOpts: { disableDirectTcp: disableTcp, disableDirectUdp: disableUdp },
      targetOpts: { disableDirectTcp: disableTcp, disableDirectUdp: disableUdp },
    });

    const opened = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: appServer.port,
      ttlSeconds: 120,
      transport: pref,
      label: expected,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.tunnel.transportMode).toBe(expected);
    expect(opened.tunnel.listenHost).toBe(PORT_FORWARD_LIMITS.LISTEN_HOST);
    expect(opened.tunnel.localEndpoint).toBe(`127.0.0.1:${opened.tunnel.listenPort}`);

    await runFullTrafficSuite(opened.tunnel.listenPort);

    if (expected === PORT_FORWARD_TRANSPORT.RELAY) {
      // Relay ciphertext must never leak plaintext HTTP body on WS wire!
      const relayPayloads = capturedMessages
        .filter((e) => e.msg.type === PORT_FORWARD_MSG.RELAY_FRAME)
        .map((e) => (e.msg as { data: string }).data);
      expect(relayPayloads.length).toBeGreaterThan(0);
      for (const b64 of relayPayloads) {
        expect(Buffer.from(b64, 'base64').toString('utf8')).not.toContain('TOP_SECRET_HTTP_BODY');
      }
    }
  }, 20_000);

  it('rejects with p2p_failed and does not fall back to relay when transport=p2p_only fails', async () => {
    const { router } = createPairedEngines({
      listenOpts: { disableDirectTcp: true, disableDirectUdp: true },
      targetOpts: { disableDirectTcp: true, disableDirectUdp: true },
    });

    const opened = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: 9999,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.P2P_ONLY,
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe(PORT_FORWARD_ERRORS.P2P_FAILED);
  });

  it('supports symmetrical reverse direction (node_b listens -> node_a targets) and rejects unreachable target port cleanly per stream', async () => {
    const appServer = await startTestAppServer();
    cleanupCallbacks.push(appServer.close);

    const { router } = createPairedEngines({
      listenOpts: { disableDirectTcp: true, disableDirectUdp: false },
      targetOpts: { disableDirectTcp: true, disableDirectUdp: false },
    });

    // B listens, A hosts target
    const opened = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_b',
      listenServerId: 'node_b',
      listenPort: 0,
      targetNode: 'node_a',
      targetServerId: 'node_a',
      targetHost: '127.0.0.1',
      targetPort: appServer.port,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.AUTO,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.tunnel.transportMode).toBe(PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P);

    const hello = await httpGet(opened.tunnel.listenPort, '/hello');
    expect(hello.status).toBe(200);

    // Also test OPEN_ERR on a separate tunnel targeting an unused port: client socket closes cleanly without crashing tunnel
    const badTarget = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: 59997,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(badTarget.ok).toBe(true);
    if (!badTarget.ok) return;
    await new Promise<void>((resolve) => {
      const s = tcpConnect({ host: '127.0.0.1', port: badTarget.tunnel.listenPort });
      s.once('close', () => resolve());
      s.once('error', () => resolve());
    });
  });

  it('releases listenPort immediately upon close so the exact same port can be rebound, and fails fast on EADDRINUSE', async () => {
    const occupiedServer: NetServer = createTcpServer();
    cleanupCallbacks.push(() => new Promise<void>((r) => occupiedServer.close(() => r())));
    const occupiedPort = await new Promise<number>((resolve) => {
      occupiedServer.listen(0, '127.0.0.1', () => {
        const addr = occupiedServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const { router } = createPairedEngines();
    const conflict = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: occupiedPort,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: 80,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe(PORT_FORWARD_ERRORS.LISTEN_PORT_IN_USE);

    // Open ephemeral, close, and immediately rebind the exact released port!
    const opened = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: 80,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const port = opened.tunnel.listenPort;
    const closed = await router.closeTunnelForUser('u1', opened.tunnel.tunnelId);
    expect(closed.ok).toBe(true);

    // Wait one tick for async socket close in engine
    await new Promise((r) => setTimeout(r, 30));

    const rebindServer = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      rebindServer.once('error', reject);
      rebindServer.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((r) => rebindServer.close(() => r()));
  });

  it('drops injected invalid candidates gracefully in validation and handles valid unknown tunnelId', async () => {
    const engine = new PortForwardEngine({
      sendWs: () => {},
    });
    const handled = await engine.handleMessage({
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: 'pf_unknown_00000001',
      role: PORT_FORWARD_ROLE.LISTEN,
      peerCandidates: [{ host: '127.0.0.1', port: 1234, transport: 'tcp', kind: 'host' } satisfies PortForwardCandidate],
      peerPublicKey: 'A'.repeat(44),
      peerKeyProof: 'B'.repeat(43),
      peerIdentityPublicKey: 'C'.repeat(44),
      peerIdentitySignature: 'D'.repeat(86),
      transport: PORT_FORWARD_TRANSPORT_PREF.AUTO,
    });
    expect(handled).toBe(true);
    engine.closeAll();
  });

  it('keeps relay traffic unreadable to server despite complete wire transcript (P0 #1)', async () => {
    const appServer = await startTestAppServer();
    cleanupCallbacks.push(appServer.close);

    const { router, capturedMessages } = createPairedEngines();
    const opened = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: appServer.port,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const hello = await httpGet(opened.tunnel.listenPort, '/hello');
    expect(hello.status).toBe(200);
    expect(JSON.parse(hello.body.toString('utf8')).secret).toBe('TOP_SECRET_HTTP_BODY');

    // Server saw capability in PREPARE, publicKeys in READY/CONNECT, and RELAY_FRAME ciphertext:
    const prepareListen = capturedMessages.length;
    expect(prepareListen).toBeGreaterThan(0);
    const relayFrames = capturedMessages
      .filter((e) => e.msg.type === PORT_FORWARD_MSG.RELAY_FRAME)
      .map((e) => (e.msg as { tunnelId: string; data: string }).data);
    expect(relayFrames.length).toBeGreaterThan(0);

    // Attempt naive decryption from capability + tunnelId alone (v1 bug) -> must fail!
    const capGuess = Buffer.alloc(32, 0x01);
    const guessedKey = Buffer.from(hkdfSync('sha256', capGuess, Buffer.from(opened.tunnel.tunnelId), Buffer.from('imcodes-pf-v1:target->listen'), 32));
    for (const b64 of relayFrames) {
      const pkt = Buffer.from(b64, 'base64');
      expect(pkt.toString('utf8')).not.toContain('TOP_SECRET_HTTP_BODY');
      if (pkt.length > 24) {
        const counter = pkt.readBigUInt64BE(0);
        const iv = Buffer.allocUnsafe(12);
        iv.writeUInt32BE(0x524c544c, 0);
        iv.writeBigUInt64BE(counter, 4);
        const decipher = createDecipheriv('aes-256-gcm', guessedKey, iv);
        decipher.setAAD(Buffer.from(`${opened.tunnel.tunnelId}:relay:${counter.toString()}`));
        decipher.setAuthTag(pkt.subarray(-16));
        expect(() => {
          decipher.update(pkt.subarray(8, -16));
          decipher.final();
        }).toThrow();
      }
    }
    void createHmac;
  });

  it.each([
    { label: 'direct_tcp', pref: PORT_FORWARD_TRANSPORT_PREF.AUTO, disableTcp: false, disableUdp: false },
    { label: 'direct_udp_p2p', pref: PORT_FORWARD_TRANSPORT_PREF.AUTO, disableTcp: true, disableUdp: false },
    { label: 'relay', pref: PORT_FORWARD_TRANSPORT_PREF.RELAY, disableTcp: true, disableUdp: true },
  ])('preserves half-open TCP when client sends FIN before server delayed response over $label (P0 #4)', async ({ pref, disableTcp, disableUdp }) => {
    const delayedServer = createTcpServer({ allowHalfOpen: true }, (sock: NetSocket) => {
      const chunks: Buffer[] = [];
      sock.on('data', (c: Buffer) => chunks.push(c));
      sock.on('end', () => {
        const req = Buffer.concat(chunks).toString('utf8');
        setTimeout(() => {
          sock.end(`DELAYED_ACK:${req}`);
        }, 50);
      });
    });
    await new Promise<void>((r) => delayedServer.listen(0, '127.0.0.1', () => r()));
    cleanupCallbacks.push(() => new Promise<void>((r) => delayedServer.close(() => r())));
    const targetPort = (delayedServer.address() as { port: number }).port;

    const { router } = createPairedEngines({
      listenOpts: { disableDirectTcp: disableTcp, disableDirectUdp: disableUdp },
      targetOpts: { disableDirectTcp: disableTcp, disableDirectUdp: disableUdp },
    });
    const opened = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort,
      ttlSeconds: 120,
      transport: pref,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const response = await new Promise<string>((resolve, reject) => {
      const client = tcpConnect({ host: '127.0.0.1', port: opened.tunnel.listenPort, allowHalfOpen: true });
      const rx: Buffer[] = [];
      client.once('error', reject);
      client.on('data', (c: Buffer) => rx.push(c));
      client.on('end', () => {
        client.destroy();
        resolve(Buffer.concat(rx).toString('utf8'));
      });
      client.once('connect', () => {
        client.end('PING_THEN_FIN');
      });
    });
    expect(response).toBe('DELAYED_ACK:PING_THEN_FIN');
  });

  it('settles openTunnel immediately on mid-PREPARE/CONNECT cancel and releases fixed listenPort (P0 #5)', async () => {
    const { router, listenEngine } = createPairedEngines({
      prepareTimeoutMs: 5_000,
      establishTimeoutMs: 5_000,
      listenOpts: {
        // Delay STUN probe so cancel happens mid-PREPARE
        probeStun: async () => {
          await new Promise((r) => setTimeout(r, 250));
          return [];
        },
      },
    });

    const probePort = await new Promise<number>((resolve) => {
      const s = createTcpServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });

    const openPromise = router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: probePort,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: 8080,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.AUTO,
    });

    await new Promise((r) => setTimeout(r, 40));
    const closedIds = await router.closeAllForUser('u1');
    expect(closedIds).toHaveLength(1);

    // P0 #5: openPromise MUST settle promptly rather than staying pending!
    const openResult = await openPromise;
    expect(openResult.ok).toBe(false);

    await new Promise((r) => setTimeout(r, 300));
    expect(listenEngine.listTunnels()).toHaveLength(0);

    // Port must be completely free to rebind!
    const rebound = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(probePort, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((r) => rebound.close(() => r()));
  });

  it('never drops first pending client connection on fixed port during auto->relay fallback (P0 #6)', async () => {
    const appServer = await startTestAppServer();
    cleanupCallbacks.push(appServer.close);

    const fixedPort = await new Promise<number>((resolve) => {
      const s = createTcpServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });

    const { router } = createPairedEngines({
      listenOpts: {
        disableDirectTcp: true,
        disableDirectUdp: true,
      },
      targetOpts: {
        disableDirectTcp: true,
        disableDirectUdp: true,
      },
    });

    const openPromise = router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: fixedPort,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: appServer.port,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.AUTO,
    });

    // Connect client right after listener binds while auto->relay handshake is still in progress!
    let clientPromise: Promise<{ status: number; body: Buffer }> | null = null;
    for (let i = 0; i < 40; i++) {
      try {
        await new Promise((r) => setTimeout(r, 5));
        clientPromise = httpGet(fixedPort, '/hello');
        break;
      } catch {
        // Retry until bound
      }
    }
    expect(clientPromise).not.toBeNull();
    const [openRes, firstHttp] = await Promise.all([openPromise, clientPromise!]);
    expect(openRes.ok).toBe(true);
    if (openRes.ok) expect(openRes.tunnel.transportMode).toBe(PORT_FORWARD_TRANSPORT.RELAY);
    expect(firstHttp.status).toBe(200);
    expect(JSON.parse(firstHttp.body.toString('utf8')).secret).toBe('TOP_SECRET_HTTP_BODY');
  });

  it('isolates slow consumer stream backpressure so concurrent fast stream proceeds with bounded memory (P0 #7)', async () => {
    let slowServerSocket: NetSocket | null = null;
    const rawSrv = createTcpServer((sock: NetSocket) => {
      sock.once('data', (first: Buffer) => {
        if (first.toString('utf8').startsWith('SLOW')) {
          slowServerSocket = sock;
          sock.pause(); // Deliberately stall reading so kernel recv window fills -> backpressure!
        } else {
          sock.end('FAST_OK');
        }
      });
    });
    await new Promise<void>((r) => rawSrv.listen(0, '127.0.0.1', () => r()));
    cleanupCallbacks.push(() => {
      slowServerSocket?.destroy();
      return new Promise<void>((r) => rawSrv.close(() => r()));
    });
    const targetPort = (rawSrv.address() as { port: number }).port;

    let wsBackpressured = false;
    const { router } = createPairedEngines({
      listenOpts: {
        getWsBufferedAmount: () => (wsBackpressured ? PORT_FORWARD_LIMITS.RELAY_WS_HIGH_WATER_BYTES + 1 : 0),
      },
    });
    const opened = await router.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // 1. Open slow stream & flood 600 KiB into it (exceeds 256 KiB stream window).
    const slowClient = tcpConnect({ host: '127.0.0.1', port: opened.tunnel.listenPort });
    cleanupCallbacks.push(() => { slowClient.destroy(); });
    await new Promise<void>((resolve) => slowClient.once('connect', () => resolve()));
    slowClient.write('SLOW');
    await new Promise((r) => setTimeout(r, 30));
    slowClient.write(Buffer.alloc(600 * 1024, 0x41));

    // 2. Concurrent fast stream on the exact same tunnel completes promptly while slow stream is paused!
    const fastResp = await new Promise<string>((resolve, reject) => {
      const fc = tcpConnect({ host: '127.0.0.1', port: opened.tunnel.listenPort });
      const chunks: Buffer[] = [];
      fc.once('error', reject);
      fc.on('data', (c: Buffer) => chunks.push(c));
      fc.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      fc.once('connect', () => fc.write('FAST'));
    });
    expect(fastResp).toBe('FAST_OK');
    wsBackpressured = false;
  });

  it('rejects untrusted or server-substituted peer identities even with valid server capability proof (P0 #1)', async () => {
    // Case 1: missing local trusted peer identity fails closed with explicit untrusted_peer_identity error.
    const { router: untrustedRouter } = createPairedEngines({
      listenOpts: { resolveTrustedPeerPublicKey: () => null },
    });
    const missingTrustRes = await untrustedRouter.openTunnel({
      userId: 'u1',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: 9000,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(missingTrustRes.ok).toBe(false);
    if (!missingTrustRes.ok) {
      expect(missingTrustRes.reason).toBe(PORT_FORWARD_ERRORS.SCOPED_AUTH);
      expect(missingTrustRes.error).toContain('untrusted_peer_identity');
    }

    // Case 2: compromised relay knowing `capability` swaps peer X25519 key + mints valid `keyProof` + signs with attacker Ed25519 key.
    // Endpoint trusting node_b's real Ed25519 key MUST reject it cleanly.
    const emitted: PortForwardWireMessage[] = [];
    const listenIdentity = generateEndpointIdentityKeyPair();
    const realTargetIdentity = generateEndpointIdentityKeyPair();
    const attackerIdentity = generateEndpointIdentityKeyPair();
    const attackerEcdh = generateEphemeralEcdhKeyPair();

    const engineA = new PortForwardEngine({
      sendWs: (m) => { emitted.push(m); },
      identityKeyPair: listenIdentity,
      resolveTrustedPeerPublicKey: (id) => (id === 'node_b' ? realTargetIdentity.publicKeyB64 : null),
    });
    cleanupCallbacks.push(() => engineA.closeAll());

    const capability = randomBytes(32).toString('base64url');
    const tunnelId = 'pf_mitm_forged_0001';
    const admissionMacKey = deriveAdmissionMacKey(capability, tunnelId);

    await engineA.handleMessage({
      type: PORT_FORWARD_MSG.PREPARE,
      tunnelId,
      role: PORT_FORWARD_ROLE.LISTEN,
      capability,
      selfServerId: 'node_a',
      peerServerId: 'node_b',
      listenHost: '127.0.0.1',
      listenPort: 0,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      iceServers: [],
      ttlMs: 60_000,
    });

    const forgedProof = computeEphemeralKeyProof(admissionMacKey, {
      tunnelId,
      role: PORT_FORWARD_ROLE.TARGET,
      selfServerId: 'node_b',
      peerServerId: 'node_a',
      publicKey: attackerEcdh.publicKeyB64,
    });
    const forgedSig = signPortForwardTranscript(attackerIdentity.privateKey, {
      tunnelId,
      role: PORT_FORWARD_ROLE.TARGET,
      selfServerId: 'node_b',
      peerServerId: 'node_a',
      capability,
      ecdhPublicKey: attackerEcdh.publicKeyB64,
      candidates: [],
    });

    await engineA.handleMessage({
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId,
      role: PORT_FORWARD_ROLE.LISTEN,
      peerCandidates: [],
      peerPublicKey: attackerEcdh.publicKeyB64,
      peerKeyProof: forgedProof,
      peerIdentityPublicKey: attackerIdentity.publicKeyB64,
      peerIdentitySignature: forgedSig,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });

    const errorMsg = emitted.find((m) => m.type === PORT_FORWARD_MSG.ERROR);
    expect(errorMsg).toBeDefined();
    if (errorMsg && errorMsg.type === PORT_FORWARD_MSG.ERROR) {
      expect(errorMsg.reason).toBe(PORT_FORWARD_ERRORS.SCOPED_AUTH);
      expect(errorMsg.error).toContain('signature verification failed');
    }
    expect(engineA.listTunnels()).toHaveLength(0);
  });

  it('aborts hung STUN probe timers & socket listeners immediately on tunnel cancel mid-PREPARE (P0 #3)', async () => {
    // Bind a UDP sinkhole that never replies to STUN binding requests
    const blackhole = createSocket('udp4');
    await new Promise<void>((r) => blackhole.bind(0, '127.0.0.1', () => r()));
    cleanupCallbacks.push(() => { try { blackhole.close(); } catch { /* ignore */ } });
    const blackholePort = blackhole.address().port;

    const probeSock = createSocket('udp4');
    await new Promise<void>((r) => probeSock.bind(0, '127.0.0.1', () => r()));
    cleanupCallbacks.push(() => { try { probeSock.close(); } catch { /* ignore */ } });

    const abortController = new AbortController();
    const start = Date.now();
    const probePromise = probeStunCandidates(
      probeSock,
      [{ urls: `stun:127.0.0.1:${blackholePort}` }],
      { timeoutMs: 10_000, signal: abortController.signal },
    );
    expect(probeSock.listenerCount('message')).toBeGreaterThan(0);

    setTimeout(() => abortController.abort(), 30);
    const eps = await probePromise;
    expect(eps).toEqual([]);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(probeSock.listenerCount('message')).toBe(0);
  });
});
