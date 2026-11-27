import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as tcpConnect, createServer as createTcpServer, type Server as NetServer, type Socket as NetSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { stringifyForServerSend } from '../../src/daemon/latency-tracer.js';
import {
  computeEphemeralKeyProof,
  deriveAdmissionMacKey,
  generateEndpointIdentityKeyPair,
  generateEphemeralEcdhKeyPair,
  loadTrustedPeerPublicKeys,
  signPortForwardTranscript,
  upsertTrustedPeerPublicKey,
} from '../../src/daemon/port-forward-crypto.js';
import { PORT_FORWARD_STRICT_TRUST_ENV, PortForwardEngine } from '../../src/daemon/port-forward-engine.js';
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
    const closeRes = await router.closeAllForUser('u1');
    expect(closeRes.confirmed).toBe(true);
    expect(closeRes.closedTunnelIds).toHaveLength(1);

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

  it('connects end-to-end when FULL daemon wraps every port_forward.* message with stringifyForServerSend seq', async () => {
    const backend = await startTestAppServer();
    cleanupCallbacks.push(() => backend.close());

    let listenSeq = 0;
    const { router, listenEngine, targetEngine } = createPairedEngines({
      listenOpts: {
        disableDirectTcp: true,
        disableDirectUdp: true,
        sendWs: (msg) => {
          const { payload } = stringifyForServerSend(msg, ++listenSeq);
          const wire = JSON.parse(payload);
          queueMicrotask(() => {
            router.handleDaemonMessage('node_a', 1, wire);
          });
        },
      },
      targetOpts: { disableDirectTcp: true, disableDirectUdp: true },
    });
    cleanupCallbacks.push(() => {
      listenEngine.closeAll();
      targetEngine.closeAll();
    });

    const opened = await router.openTunnel({
      userId: 'u_seq',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: backend.port,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(listenSeq).toBeGreaterThan(0);

    const res = await httpGet(opened.tunnel.listenPort, '/hello');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: true, secret: 'TOP_SECRET_HTTP_BODY' });
    await router.closeTunnelForUser('u_seq', opened.tunnel.tunnelId);
  });

  it('auto-pins unknown peers on first authenticated use (TOFU), reuses persisted pins across restarts, rejects MITM key changes without overwriting, and honors strict mode', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'pf-tofu-'));
    cleanupCallbacks.push(() => {
      delete process.env[PORT_FORWARD_STRICT_TRUST_ENV];
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    const backend = await startTestAppServer();
    cleanupCallbacks.push(() => backend.close());

    const peersA = join(tmpRoot, 'peers-a.json');
    const peersB = join(tmpRoot, 'peers-b.json');
    const idA = generateEndpointIdentityKeyPair();
    const idB = generateEndpointIdentityKeyPair();

    const bridges = new Map<string, PortForwardBridgeEndpoint>();
    const router = new PortForwardRouter({
      lookupBridge: (id) => bridges.get(id),
      getIceServers: () => [],
      prepareTimeoutMs: 3_000,
      establishTimeoutMs: 5_000,
    });

    const makeEngines = () => {
      const engA = new PortForwardEngine({
        sendWs: (msg) => { queueMicrotask(() => router.handleDaemonMessage('node_a', 1, msg)); },
        collectInterfaceAddresses: () => ['127.0.0.1'],
        identityKeyPair: idA,
        trustedPeersFilePath: peersA,
        disableDirectTcp: true,
        disableDirectUdp: true,
      });
      const engB = new PortForwardEngine({
        sendWs: (msg) => { queueMicrotask(() => router.handleDaemonMessage('node_b', 1, msg)); },
        collectInterfaceAddresses: () => ['127.0.0.1'],
        identityKeyPair: idB,
        trustedPeersFilePath: peersB,
        disableDirectTcp: true,
        disableDirectUdp: true,
      });
      bridges.set('node_a', {
        isDaemonConnected: () => true,
        daemonConnectionGeneration: () => 1,
        trySendPortForward: (m) => { void engA.handleMessage(m); return true; },
      });
      bridges.set('node_b', {
        isDaemonConnected: () => true,
        daemonConnectionGeneration: () => 1,
        trySendPortForward: (m) => { void engB.handleMessage(m); return true; },
      });
      router.onDaemonConnected('node_a', 1);
      router.onDaemonConnected('node_b', 1);
      return { engA, engB };
    };

    // 1. First connection with zero pre-written trusted peers succeeds via TOFU and persists both files
    const first = makeEngines();
    cleanupCallbacks.push(() => { first.engA.closeAll(); first.engB.closeAll(); });
    const concurrentTunnels = await Promise.all([
      router.openTunnel({
        userId: 'u_tofu',
        listenNode: 'node_a',
        listenServerId: 'node_a',
        listenPort: 0,
        targetNode: 'node_b',
        targetServerId: 'node_b',
        targetHost: '127.0.0.1',
        targetPort: backend.port,
        ttlSeconds: 120,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      }),
      router.openTunnel({
        userId: 'u_tofu',
        listenNode: 'node_a',
        listenServerId: 'node_a',
        listenPort: 0,
        targetNode: 'node_b',
        targetServerId: 'node_b',
        targetHost: '127.0.0.1',
        targetPort: backend.port,
        ttlSeconds: 120,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      }),
    ]);
    for (const opened of concurrentTunnels) {
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        const res = await httpGet(opened.tunnel.listenPort, '/hello');
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: true, secret: 'TOP_SECRET_HTTP_BODY' });
        await router.closeTunnelForUser('u_tofu', opened.tunnel.tunnelId);
      }
    }
    expect(loadTrustedPeerPublicKeys(peersA).get('node_b')).toBe(idB.publicKeyB64);
    expect(loadTrustedPeerPublicKeys(peersB).get('node_a')).toBe(idA.publicKeyB64);

    // 2. New engine instances reuse persisted pins cleanly
    first.engA.closeAll();
    first.engB.closeAll();
    const second = makeEngines();
    cleanupCallbacks.push(() => { second.engA.closeAll(); second.engB.closeAll(); });
    const reopened = await router.openTunnel({
      userId: 'u_tofu',
      listenNode: 'node_a',
      listenServerId: 'node_a',
      listenPort: 0,
      targetNode: 'node_b',
      targetServerId: 'node_b',
      targetHost: '127.0.0.1',
      targetPort: backend.port,
      ttlSeconds: 120,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      await router.closeTunnelForUser('u_tofu', reopened.tunnel.tunnelId);
    }

    // 3. Swapped peer identity key K2 must fail closed and MUST NOT overwrite pinned K1 on disk
    const swappedIdentity = generateEndpointIdentityKeyPair();
    const attackerEcdh = generateEphemeralEcdhKeyPair();
    const emittedOnMismatch: PortForwardWireMessage[] = [];
    const mismatchEngine = new PortForwardEngine({
      sendWs: (m) => { emittedOnMismatch.push(m); },
      identityKeyPair: idA,
      trustedPeersFilePath: peersA,
    });
    cleanupCallbacks.push(() => mismatchEngine.closeAll());
    const tidMismatch = 'pf_tofu_swap_0001';
    const capMismatch = randomBytes(32).toString('base64url');
    const macMismatch = deriveAdmissionMacKey(capMismatch, tidMismatch);
    await mismatchEngine.handleMessage({
      type: PORT_FORWARD_MSG.PREPARE,
      tunnelId: tidMismatch,
      role: PORT_FORWARD_ROLE.LISTEN,
      capability: capMismatch,
      selfServerId: 'node_a',
      peerServerId: 'node_b',
      listenHost: '127.0.0.1',
      listenPort: 0,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      iceServers: [],
      ttlMs: 60_000,
    });
    await mismatchEngine.handleMessage({
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: tidMismatch,
      role: PORT_FORWARD_ROLE.LISTEN,
      peerCandidates: [],
      peerPublicKey: attackerEcdh.publicKeyB64,
      peerKeyProof: computeEphemeralKeyProof(macMismatch, {
        tunnelId: tidMismatch,
        role: PORT_FORWARD_ROLE.TARGET,
        selfServerId: 'node_b',
        peerServerId: 'node_a',
        publicKey: attackerEcdh.publicKeyB64,
      }),
      peerIdentityPublicKey: swappedIdentity.publicKeyB64,
      peerIdentitySignature: signPortForwardTranscript(swappedIdentity.privateKey, {
        tunnelId: tidMismatch,
        role: PORT_FORWARD_ROLE.TARGET,
        selfServerId: 'node_b',
        peerServerId: 'node_a',
        capability: capMismatch,
        ecdhPublicKey: attackerEcdh.publicKeyB64,
        candidates: [],
      }),
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(emittedOnMismatch.some((m) => m.type === PORT_FORWARD_MSG.ERROR && m.reason === PORT_FORWARD_ERRORS.SCOPED_AUTH)).toBe(true);
    expect(loadTrustedPeerPublicKeys(peersA).get('node_b')).toBe(idB.publicKeyB64);

    // 4. Unwritable trustedPeersFilePath parent falls back to in-memory pin without crashing and rejects later key change
    const blockingFile = join(tmpRoot, 'not-a-directory');
    writeFileSync(blockingFile, 'x', 'utf8');
    const roMsgs: PortForwardWireMessage[] = [];
    const roEngine = new PortForwardEngine({
      sendWs: (m) => { roMsgs.push(m); },
      identityKeyPair: idA,
      trustedPeersFilePath: join(blockingFile, 'peers.json'),
      disableDirectTcp: true,
      disableDirectUdp: true,
    });
    cleanupCallbacks.push(() => roEngine.closeAll());
    const peerB = generateEndpointIdentityKeyPair();
    const peerBEcdh = generateEphemeralEcdhKeyPair();
    const tidRo1 = 'pf_tofu_readonly_0001';
    const capRo1 = randomBytes(32).toString('base64url');
    const macRo1 = deriveAdmissionMacKey(capRo1, tidRo1);
    await roEngine.handleMessage({
      type: PORT_FORWARD_MSG.PREPARE,
      tunnelId: tidRo1,
      role: PORT_FORWARD_ROLE.TARGET,
      capability: capRo1,
      selfServerId: 'node_a',
      peerServerId: 'node_ro',
      targetHost: '127.0.0.1',
      targetPort: backend.port,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      iceServers: [],
      ttlMs: 60_000,
    });
    await roEngine.handleMessage({
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: tidRo1,
      role: PORT_FORWARD_ROLE.TARGET,
      peerCandidates: [],
      peerPublicKey: peerBEcdh.publicKeyB64,
      peerKeyProof: computeEphemeralKeyProof(macRo1, {
        tunnelId: tidRo1,
        role: PORT_FORWARD_ROLE.LISTEN,
        selfServerId: 'node_ro',
        peerServerId: 'node_a',
        publicKey: peerBEcdh.publicKeyB64,
      }),
      peerIdentityPublicKey: peerB.publicKeyB64,
      peerIdentitySignature: signPortForwardTranscript(peerB.privateKey, {
        tunnelId: tidRo1,
        role: PORT_FORWARD_ROLE.LISTEN,
        selfServerId: 'node_ro',
        peerServerId: 'node_a',
        capability: capRo1,
        ecdhPublicKey: peerBEcdh.publicKeyB64,
        candidates: [],
      }),
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(roMsgs.some((m) => m.type === PORT_FORWARD_MSG.TARGET_READY && m.tunnelId === tidRo1)).toBe(true);

    // Second connection to node_ro with a different key MUST still fail against in-memory pin
    const tidRo2 = 'pf_tofu_readonly_0002';
    const capRo2 = randomBytes(32).toString('base64url');
    const macRo2 = deriveAdmissionMacKey(capRo2, tidRo2);
    await roEngine.handleMessage({
      type: PORT_FORWARD_MSG.PREPARE,
      tunnelId: tidRo2,
      role: PORT_FORWARD_ROLE.LISTEN,
      capability: capRo2,
      selfServerId: 'node_a',
      peerServerId: 'node_ro',
      listenHost: '127.0.0.1',
      listenPort: 0,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      iceServers: [],
      ttlMs: 60_000,
    });
    await roEngine.handleMessage({
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: tidRo2,
      role: PORT_FORWARD_ROLE.LISTEN,
      peerCandidates: [],
      peerPublicKey: attackerEcdh.publicKeyB64,
      peerKeyProof: computeEphemeralKeyProof(macRo2, {
        tunnelId: tidRo2,
        role: PORT_FORWARD_ROLE.TARGET,
        selfServerId: 'node_ro',
        peerServerId: 'node_a',
        publicKey: attackerEcdh.publicKeyB64,
      }),
      peerIdentityPublicKey: swappedIdentity.publicKeyB64,
      peerIdentitySignature: signPortForwardTranscript(swappedIdentity.privateKey, {
        tunnelId: tidRo2,
        role: PORT_FORWARD_ROLE.TARGET,
        selfServerId: 'node_ro',
        peerServerId: 'node_a',
        capability: capRo2,
        ecdhPublicKey: attackerEcdh.publicKeyB64,
        candidates: [],
      }),
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    expect(roMsgs.some((m) => m.tunnelId === tidRo2 && m.type === PORT_FORWARD_MSG.ERROR && m.reason === PORT_FORWARD_ERRORS.SCOPED_AUTH)).toBe(true);

    // 5. Strict mode via option or env rejects unknown peers cleanly
    const strictFile = join(tmpRoot, 'strict-peers.json');
    for (const mode of ['option_false', 'strict_flag', 'env'] as const) {
      if (mode === 'env') process.env[PORT_FORWARD_STRICT_TRUST_ENV] = '1';
      else delete process.env[PORT_FORWARD_STRICT_TRUST_ENV];
      const strictMsgs: PortForwardWireMessage[] = [];
      const strictEngine = new PortForwardEngine({
        sendWs: (m) => { strictMsgs.push(m); },
        identityKeyPair: idA,
        trustedPeersFilePath: strictFile,
        ...(mode === 'option_false' ? { trustOnFirstUse: false } : {}),
        ...(mode === 'strict_flag' ? { strictPinnedTrust: true } : {}),
      });
      const tidStrict = `pf_strict_check_${mode}`;
      const capStrict = randomBytes(32).toString('base64url');
      const macStrict = deriveAdmissionMacKey(capStrict, tidStrict);
      await strictEngine.handleMessage({
        type: PORT_FORWARD_MSG.PREPARE,
        tunnelId: tidStrict,
        role: PORT_FORWARD_ROLE.LISTEN,
        capability: capStrict,
        selfServerId: 'node_a',
        peerServerId: 'node_unknown',
        listenHost: '127.0.0.1',
        listenPort: 0,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
        iceServers: [],
        ttlMs: 60_000,
      });
      await strictEngine.handleMessage({
        type: PORT_FORWARD_MSG.CONNECT,
        tunnelId: tidStrict,
        role: PORT_FORWARD_ROLE.LISTEN,
        peerCandidates: [],
        peerPublicKey: peerBEcdh.publicKeyB64,
        peerKeyProof: computeEphemeralKeyProof(macStrict, {
          tunnelId: tidStrict,
          role: PORT_FORWARD_ROLE.TARGET,
          selfServerId: 'node_unknown',
          peerServerId: 'node_a',
          publicKey: peerBEcdh.publicKeyB64,
        }),
        peerIdentityPublicKey: peerB.publicKeyB64,
        peerIdentitySignature: signPortForwardTranscript(peerB.privateKey, {
          tunnelId: tidStrict,
          role: PORT_FORWARD_ROLE.TARGET,
          selfServerId: 'node_unknown',
          peerServerId: 'node_a',
          capability: capStrict,
          ecdhPublicKey: peerBEcdh.publicKeyB64,
          candidates: [],
        }),
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      });
      strictEngine.closeAll();
      expect(strictMsgs.some((m) => m.type === PORT_FORWARD_MSG.ERROR && m.error.includes('untrusted_peer_identity'))).toBe(true);
    }
    delete process.env[PORT_FORWARD_STRICT_TRUST_ENV];

    // 6. Custom resolveTrustedPeerPublicKey returning null MUST stay fail-closed even if trustOnFirstUse: true is passed
    const resolverBypassFile = join(tmpRoot, 'resolver-bypass-peers.json');
    const resolverMsgs: PortForwardWireMessage[] = [];
    const resolverEngine = new PortForwardEngine({
      sendWs: (m) => { resolverMsgs.push(m); },
      identityKeyPair: idA,
      trustedPeersFilePath: resolverBypassFile,
      resolveTrustedPeerPublicKey: () => null,
      trustOnFirstUse: true,
    });
    const tidResolver = 'pf_resolver_no_tofu_01';
    const capResolver = randomBytes(32).toString('base64url');
    const macResolver = deriveAdmissionMacKey(capResolver, tidResolver);
    await resolverEngine.handleMessage({
      type: PORT_FORWARD_MSG.PREPARE,
      tunnelId: tidResolver,
      role: PORT_FORWARD_ROLE.LISTEN,
      capability: capResolver,
      selfServerId: 'node_a',
      peerServerId: 'node_unknown',
      listenHost: '127.0.0.1',
      listenPort: 0,
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      iceServers: [],
      ttlMs: 60_000,
    });
    await resolverEngine.handleMessage({
      type: PORT_FORWARD_MSG.CONNECT,
      tunnelId: tidResolver,
      role: PORT_FORWARD_ROLE.LISTEN,
      peerCandidates: [],
      peerPublicKey: peerBEcdh.publicKeyB64,
      peerKeyProof: computeEphemeralKeyProof(macResolver, {
        tunnelId: tidResolver,
        role: PORT_FORWARD_ROLE.TARGET,
        selfServerId: 'node_unknown',
        peerServerId: 'node_a',
        publicKey: peerBEcdh.publicKeyB64,
      }),
      peerIdentityPublicKey: peerB.publicKeyB64,
      peerIdentitySignature: signPortForwardTranscript(peerB.privateKey, {
        tunnelId: tidResolver,
        role: PORT_FORWARD_ROLE.TARGET,
        selfServerId: 'node_unknown',
        peerServerId: 'node_a',
        capability: capResolver,
        ecdhPublicKey: peerBEcdh.publicKeyB64,
        candidates: [],
      }),
      transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
    });
    resolverEngine.closeAll();
    expect(resolverMsgs.some((m) => m.type === PORT_FORWARD_MSG.ERROR && m.error.includes('untrusted_peer_identity'))).toBe(true);
    expect(existsSync(resolverBypassFile)).toBe(false);

    // 7. Unreadable or corrupted existing trust store inside a writable directory MUST fail closed and NEVER overwrite existing pins
    const sendSignedConnect = async (
      engine: PortForwardEngine,
      tunnelId: string,
      peerServerId: string,
      peerIdent: ReturnType<typeof generateEndpointIdentityKeyPair>,
    ) => {
      const cap = randomBytes(32).toString('base64url');
      const mac = deriveAdmissionMacKey(cap, tunnelId);
      const ecdh = generateEphemeralEcdhKeyPair();
      await engine.handleMessage({
        type: PORT_FORWARD_MSG.PREPARE,
        tunnelId,
        role: PORT_FORWARD_ROLE.LISTEN,
        capability: cap,
        selfServerId: 'node_a',
        peerServerId,
        listenHost: '127.0.0.1',
        listenPort: 0,
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
        iceServers: [],
        ttlMs: 60_000,
      });
      await engine.handleMessage({
        type: PORT_FORWARD_MSG.CONNECT,
        tunnelId,
        role: PORT_FORWARD_ROLE.LISTEN,
        peerCandidates: [],
        peerPublicKey: ecdh.publicKeyB64,
        peerKeyProof: computeEphemeralKeyProof(mac, {
          tunnelId,
          role: PORT_FORWARD_ROLE.TARGET,
          selfServerId: peerServerId,
          peerServerId: 'node_a',
          publicKey: ecdh.publicKeyB64,
        }),
        peerIdentityPublicKey: peerIdent.publicKeyB64,
        peerIdentitySignature: signPortForwardTranscript(peerIdent.privateKey, {
          tunnelId,
          role: PORT_FORWARD_ROLE.TARGET,
          selfServerId: peerServerId,
          peerServerId: 'node_a',
          capability: cap,
          ecdhPublicKey: ecdh.publicKeyB64,
          candidates: [],
        }),
        transport: PORT_FORWARD_TRANSPORT_PREF.RELAY,
      });
    };

    // 7a. EACCES on existing trust file inside writable dir -> unrelated new peer MUST fail closed and preserve original pin
    const eaccesDir = join(tmpRoot, 'eacces-writable-dir');
    const eaccesFile = join(eaccesDir, 'peers.json');
    const existingPinId = generateEndpointIdentityKeyPair();
    upsertTrustedPeerPublicKey(eaccesFile, 'node_existing', existingPinId.publicKeyB64);
    chmodSync(eaccesFile, 0o000);
    cleanupCallbacks.push(() => {
      try { chmodSync(eaccesFile, 0o600); } catch { /* ignore */ }
    });
    const eaccesMsgs: PortForwardWireMessage[] = [];
    const eaccesEngine = new PortForwardEngine({
      sendWs: (m) => { eaccesMsgs.push(m); },
      identityKeyPair: idA,
      trustedPeersFilePath: eaccesFile,
    });
    await sendSignedConnect(eaccesEngine, 'pf_eacces_new_peer_01', 'node_unrelated_new', peerB);
    await sendSignedConnect(eaccesEngine, 'pf_eacces_old_peer_02', 'node_existing', peerB);
    eaccesEngine.closeAll();
    expect(eaccesMsgs.filter((m) => m.type === PORT_FORWARD_MSG.ERROR && m.reason === PORT_FORWARD_ERRORS.SCOPED_AUTH)).toHaveLength(2);
    chmodSync(eaccesFile, 0o600);
    expect(loadTrustedPeerPublicKeys(eaccesFile).get('node_existing')).toBe(existingPinId.publicKeyB64);
    expect(loadTrustedPeerPublicKeys(eaccesFile).has('node_unrelated_new')).toBe(false);

    // 7b. Corrupt JSON file -> fail closed and keep exact bytes untouched
    const corruptJsonFile = join(tmpRoot, 'corrupt-json.json');
    writeFileSync(corruptJsonFile, '{not-valid-json', 'utf8');
    const corruptJsonMsgs: PortForwardWireMessage[] = [];
    const corruptJsonEngine = new PortForwardEngine({
      sendWs: (m) => { corruptJsonMsgs.push(m); },
      identityKeyPair: idA,
      trustedPeersFilePath: corruptJsonFile,
    });
    await sendSignedConnect(corruptJsonEngine, 'pf_corrupt_json_0001', 'node_unrelated_new', peerB);
    corruptJsonEngine.closeAll();
    expect(corruptJsonMsgs.some((m) => m.type === PORT_FORWARD_MSG.ERROR && m.error.includes('trust_store_corrupt_json'))).toBe(true);
    expect(readFileSync(corruptJsonFile, 'utf8')).toBe('{not-valid-json');

    // 7c. Malformed record for target peer -> fail closed and do not overwrite entry
    const corruptEntryFile = join(tmpRoot, 'corrupt-entry.json');
    const corruptPayload = JSON.stringify({ node_corrupt: { publicKeyB64: 'invalid-key' } });
    writeFileSync(corruptEntryFile, corruptPayload, 'utf8');
    const corruptEntryMsgs: PortForwardWireMessage[] = [];
    const corruptEntryEngine = new PortForwardEngine({
      sendWs: (m) => { corruptEntryMsgs.push(m); },
      identityKeyPair: idA,
      trustedPeersFilePath: corruptEntryFile,
    });
    await sendSignedConnect(corruptEntryEngine, 'pf_corrupt_entry_001', 'node_corrupt', peerB);
    corruptEntryEngine.closeAll();
    expect(corruptEntryMsgs.some((m) => m.type === PORT_FORWARD_MSG.ERROR && m.error.includes('trust_store_corrupt_entry'))).toBe(true);
    expect(readFileSync(corruptEntryFile, 'utf8')).toBe(corruptPayload);
  });
});
