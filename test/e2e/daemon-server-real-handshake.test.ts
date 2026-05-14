/**
 * E2E regression: real `ServerLink` ↔ real `WsBridge` over a real
 * `ws` server. The previous bridge-auth-race-e2e test synthesized
 * auth + daemon.hello directly, which only proved the server-side
 * gate. This file exercises the FULL daemon→server handshake the
 * way it actually flows in production:
 *
 *   - real `ServerLink` (`src/daemon/server-link.ts`) connecting via
 *     `globalThis.WebSocket` to
 *   - a real in-process `http.Server` + `WebSocketServer` mounting
 *   - the real `WsBridge.handleDaemonConnection` (`server/src/ws/bridge.ts`).
 *
 * If a future change in either side's handshake protocol re-introduces
 * the auth-storm (e.g. a new "send X immediately after open before auth"
 * step), this catches it because the real ServerLink IS sending those
 * messages.
 *
 * Two scenarios:
 *
 *   1. Cold start: ServerLink connects to a fresh server, completes
 *      handshake, and stays connected with EXACTLY ONE underlying WS
 *      connection. Any 4001-close cascade would manifest as N>>1
 *      connections accepted by the server within the observe window.
 *
 *   2. Server restart: server closes (simulating
 *      `docker compose restart server`), waits 200 ms, then comes
 *      back on the same port. ServerLink must reconnect cleanly with
 *      no auth flap.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'node:net';
import { WsBridge } from '../../server/src/ws/bridge.js';
import { ServerLink } from '../../src/daemon/server-link.js';
import { vi } from 'vitest';

vi.mock('../../server/src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));
vi.mock('../../server/src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

// ── Test rig ──────────────────────────────────────────────────────────────────

interface TestRig {
  /** Currently bound HTTP server. Replaced when we simulate a server restart. */
  httpServer: HttpServer;
  /** Currently bound WS server. Replaced alongside httpServer. */
  wss: WebSocketServer;
  /** Stable port across restart so ServerLink can find us again. */
  port: number;
  /** Number of WS connections the server accepted since the last reset. */
  connectionsAccepted: number;
  /** Auth events observed since the last reset (one per successful auth). */
  authsCompleted: number;
  /** Set artificial DB latency for the next handshake (ms). */
  setDbLatency(ms: number): void;
  /** Reset connection + auth counters. */
  resetCounters(): void;
  /** Close the current server (simulates `docker compose stop server`). */
  stop(): Promise<void>;
  /** Restart the server on the same port (simulates restart-up phase). */
  restart(): Promise<void>;
  /** Tear down for good. */
  shutdown(): Promise<void>;
}

async function buildRig(): Promise<TestRig> {
  let dbLatency = 0;
  const queryOne = async <T = unknown>(): Promise<T | null> => {
    if (dbLatency > 0) await new Promise((r) => setTimeout(r, dbLatency));
    return { token_hash: 'valid-hash', user_id: '' } as T;
  };
  const db = {
    queryOne,
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: import('../../server/src/db/client.js').Database) => Promise<T>) =>
      fn(db as unknown as import('../../server/src/db/client.js').Database),
    close: () => {},
  } as unknown as import('../../server/src/db/client.js').Database;

  let connectionsAccepted = 0;
  let authsCompleted = 0;

  const buildServer = (port: number | undefined): Promise<{ http: HttpServer; wss: WebSocketServer; port: number }> =>
    new Promise((resolve) => {
      const http = createServer();
      const wss = new WebSocketServer({ noServer: true });
      http.on('upgrade', (req, socket, head) => {
        const url = req.url ?? '';
        const match = url.match(/\/api\/server\/([^/]+)\/ws/);
        const serverId = match?.[1];
        if (!serverId) { socket.destroy(); return; }
        connectionsAccepted += 1;
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Wrap onAuthenticated so we can count successful auths
          // without intercepting the bridge's logger.
          WsBridge.get(serverId).handleDaemonConnection(
            ws as never,
            db,
            {} as never,
            () => { authsCompleted += 1; },
          );
        });
      });
      http.listen(port ?? 0, '127.0.0.1', () => {
        const actual = (http.address() as AddressInfo).port;
        resolve({ http, wss, port: actual });
      });
    });

  const initial = await buildServer(undefined);
  const rig: TestRig = {
    httpServer: initial.http,
    wss: initial.wss,
    port: initial.port,
    connectionsAccepted: 0,
    authsCompleted: 0,
    setDbLatency: (ms) => { dbLatency = ms; },
    resetCounters: () => { connectionsAccepted = 0; authsCompleted = 0; },
    stop: async () => {
      // Aggressively terminate all live WS clients so wss.close()
      // doesn't block waiting for them. `terminate` is the immediate
      // ECONNRESET equivalent — exactly what `docker compose stop`
      // does to inflight connections.
      for (const client of rig.wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => rig.wss.close(() => resolve()));
      // Same for any lingering http connections.
      rig.httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => rig.httpServer.close(() => resolve()));
    },
    restart: async () => {
      await rig.stop();
      const next = await buildServer(rig.port);
      rig.httpServer = next.http;
      rig.wss = next.wss;
    },
    shutdown: async () => {
      await rig.stop();
      WsBridge.getAll().clear();
    },
  };

  // Make counters live-readable by getter-like sync from buildServer's
  // closure variables.
  Object.defineProperty(rig, 'connectionsAccepted', { get: () => connectionsAccepted });
  Object.defineProperty(rig, 'authsCompleted', { get: () => authsCompleted });

  return rig;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('daemon ServerLink ↔ WsBridge real handshake (production wire path)', () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await buildRig();
  });

  afterAll(async () => {
    await rig.shutdown();
  });

  it('cold start: full ServerLink handshake completes with EXACTLY ONE accepted connection (no auth flap)', async () => {
    rig.setDbLatency(50); // worst-case race window
    rig.resetCounters();

    const link = new ServerLink({
      workerUrl: `http://127.0.0.1:${rig.port}`,
      serverId: 'real-handshake-cold',
      token: 'my-token',
    });
    link.connect();

    try {
      // Wait for auth to complete on the server side.
      await waitFor(() => rig.authsCompleted >= 1, 5_000, 'first auth');

      // Critical: give the daemon ample time to flap if the bug is back.
      // The pre-fix behaviour was a 4001 close ~135 ms after open,
      // followed by an immediate reconnect every ~500 ms. After 1 s
      // we'd see 2-3 connections under the bug and exactly 1 under the
      // fix.
      await new Promise((r) => setTimeout(r, 1_000));

      expect(link.isConnected()).toBe(true);
      expect(rig.connectionsAccepted, `expected 1 WS connection, got ${rig.connectionsAccepted} — auth-storm regression`).toBe(1);
      expect(rig.authsCompleted, `expected 1 successful auth, got ${rig.authsCompleted}`).toBe(1);
    } finally {
      link.disconnect();
    }
  });

  it('server restart: ServerLink reconnects cleanly with at most one auth per up-cycle', async () => {
    rig.setDbLatency(20);
    rig.resetCounters();

    const link = new ServerLink({
      workerUrl: `http://127.0.0.1:${rig.port}`,
      serverId: 'real-handshake-restart',
      token: 'my-token',
    });
    link.connect();

    try {
      await waitFor(() => rig.authsCompleted >= 1, 5_000, 'pre-restart auth');
      const preRestartConnections = rig.connectionsAccepted;
      const preRestartAuths = rig.authsCompleted;
      expect(preRestartConnections).toBe(1);
      expect(preRestartAuths).toBe(1);

      // Simulate the production restart: stop the server, wait 200 ms
      // (typical container restart window), bring it back on the same
      // port. The daemon will see the existing socket close, retry per
      // backoff, and re-handshake when the server returns.
      await rig.stop();
      // Give the daemon a moment to detect the close and start backing off.
      await new Promise((r) => setTimeout(r, 300));
      await rig.restart();

      // Daemon should reconnect within the observe window. Backoff is
      // capped at 5 s, so 8 s leaves comfortable headroom.
      await waitFor(() => rig.authsCompleted >= preRestartAuths + 1, 8_000, 'post-restart auth');

      // Settle, then assert: the daemon authenticated EXACTLY ONCE per
      // server up-cycle. Pre-fix would log 5-10 auths per second
      // because the 4001 cascade fires on every reconnect.
      await new Promise((r) => setTimeout(r, 1_500));

      expect(link.isConnected()).toBe(true);
      const newAuths = rig.authsCompleted - preRestartAuths;
      const newConnections = rig.connectionsAccepted - preRestartConnections;
      // Allow ≤2 connections post-restart: the daemon's first attempt
      // may land mid-bind (server listening but bridge not ready yet)
      // and ECONNREFUSED a single time before the actual successful
      // attempt. Anything more than that is a regression.
      expect(newConnections, `expected ≤2 reconnect attempts, got ${newConnections}`).toBeLessThanOrEqual(2);
      expect(newAuths, `expected exactly 1 auth post-restart, got ${newAuths} — auth-storm regression`).toBe(1);
    } finally {
      link.disconnect();
    }
  });
});
