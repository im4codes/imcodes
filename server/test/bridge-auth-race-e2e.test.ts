/**
 * E2E integration test for the daemon auth handshake race.
 *
 * Production observation (78 server, 2026-05-11): a single daemon was
 * authenticating ~5 times per 10 seconds, and the daemon side reported
 * `code:4001 reason:auth_required` on every cycle. The user-visible
 * symptom was "server 重启 → daemon reconnect 极慢" plus a permanent
 * "DAEMON 失联" banner that survived all earlier client/UI fixes.
 *
 * Root cause was a race in `WsBridge.handleDaemonConnection`'s async
 * message handler. The daemon sends `auth` immediately followed by
 * `daemon.hello` on every WS open. Both messages reach the server
 * before the auth handler's `await db.queryOne(...)` settles. While
 * the auth flow is parked at the DB await, `this.authenticated` is
 * still `false`, so the `daemon.hello` handler hits
 * `ws.close(4001, 'auth_required')` and kills the freshly-opened
 * connection.
 *
 * The mocked unit test in `bridge.test.ts` covers the deferred-DB
 * scenario, but mocks cannot guarantee the same message-ordering
 * semantics the real `ws` server stack exhibits. This file spins up
 * an in-process `http.Server` + `WebSocketServer` and connects real
 * `ws` clients so the race window is exercised end-to-end.
 *
 * Stability guarantees:
 *   1. Single back-to-back `auth + daemon.hello` flow: connection
 *      stays open, auth completes, hello is processed.
 *   2. Burst-reconnect resilience: 10 sequential reconnect cycles
 *      complete without a single 4001 close — simulating the
 *      production "server restart" reconnect cascade.
 *   3. Slow-DB resilience: even with a 50 ms artificial DB delay
 *      (worst-case for the race window), the bug remains fixed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { AddressInfo } from 'node:net';
import { WsBridge } from '../src/ws/bridge.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { P2P_WORKFLOW_CAPABILITY_V1 } from '../../shared/p2p-workflow-constants.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Match the existing bridge.test.ts crypto stub so the auth path validates.
import { vi } from 'vitest';

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

interface DeferredDb {
  /** Override the DB query latency for the next handshake (ms). 0 = synchronous. */
  setLatency(ms: number): void;
  db: import('../src/db/client.js').Database;
}

function makeDeferredDb(tokenHash: string): DeferredDb {
  let latency = 0;
  const queryOne = async <T = unknown>(): Promise<T | null> => {
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    return { token_hash: tokenHash } as T;
  };
  const db = {
    queryOne,
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) =>
      fn(db as unknown as import('../src/db/client.js').Database),
    close: () => {},
  };
  return {
    setLatency: (ms: number) => { latency = ms; },
    db: db as unknown as import('../src/db/client.js').Database,
  };
}

interface ConnectionOutcome {
  /** Whether the WS closed at any point during the test window. */
  closed: boolean;
  /** Close code, if any. */
  closeCode?: number;
  /** Close reason, if any. */
  closeReason?: string;
  /** Messages received from server (parsed JSON). */
  received: Array<Record<string, unknown>>;
  /** Snapshot of `bridge.isAuthenticated` taken AFTER the observe window
   *  but BEFORE the test closes the socket. We must capture it here
   *  because the bridge's ws.on('close') handler resets `authenticated`
   *  to false — checking after the local close would always observe
   *  false even on a successful auth. */
  authenticatedDuringWindow: boolean;
}

/**
 * Drive the production daemon handshake (`auth` followed immediately by
 * `daemon.hello`) over a real `ws` client and report the outcome after
 * `observeMs`.
 */
async function driveDaemonHandshake(
  url: string,
  serverId: string,
  token: string,
  observeMs: number,
  observeAuth?: () => boolean,
): Promise<ConnectionOutcome> {
  const ws = new WebSocket(url);
  const outcome: ConnectionOutcome = { closed: false, received: [], authenticatedDuringWindow: false };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open timeout')), 2_000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });

  ws.on('message', (raw) => {
    try {
      outcome.received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    } catch { /* ignore */ }
  });
  ws.on('close', (code, reason) => {
    outcome.closed = true;
    outcome.closeCode = code;
    outcome.closeReason = reason.toString();
  });

  // Production daemon order: auth IMMEDIATELY followed by daemon.hello.
  // Both messages hit the server's async message handler before the
  // auth's DB query resolves — this is the race window.
  ws.send(JSON.stringify({ type: 'auth', serverId, token, daemonVersion: 'test-version' }));
  ws.send(JSON.stringify({
    type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
    daemonId: serverId,
    capabilities: [P2P_WORKFLOW_CAPABILITY_V1],
    helloEpoch: 1,
    sentAt: Date.now(),
  }));

  // Poll for authenticated state OR until observeMs elapses, whichever
  // comes first. Polling is more robust than a single sleep+check
  // because the WS round-trip + DB latency can vary by tens of ms in
  // CI. Captures auth state BEFORE we close the socket — the bridge's
  // ws.on('close') handler resets `authenticated` to false, so
  // checking after the local close would always observe false.
  const deadline = Date.now() + observeMs;
  if (observeAuth) {
    while (Date.now() < deadline) {
      if (observeAuth()) {
        outcome.authenticatedDuringWindow = true;
        break;
      }
      // Don't busy-loop — yield once per 10 ms so the bridge's async
      // message handler can run.
      await new Promise((r) => setTimeout(r, 10));
    }
    // If the loop fell through without observing auth, leave the flag
    // false so the assertion fails with diagnostic context.
  } else {
    await new Promise((r) => setTimeout(r, observeMs));
  }
  if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'test_done');
  return outcome;
}

// ── Test fixture ──────────────────────────────────────────────────────────────

describe('WsBridge daemon auth-handshake race — e2e (real ws server)', () => {
  let httpServer: HttpServer;
  let wss: WebSocketServer;
  let port: number;
  let deferredDb: DeferredDb;
  const TOKEN = 'my-token';
  // Each test/cycle gets its OWN server ID. `WsBridge.maybeCleanup`
  // deletes from the shared instances map by `serverId`, not by
  // instance pointer; if a prior test's connection close fires its
  // cleanup AFTER a new bridge has registered for the same serverId,
  // the new bridge gets evicted from the map and the daemon
  // connection becomes unreachable. In production every serverId
  // hosts a single bridge so the path is harmless, but back-to-back
  // tests rapid-cycle the same id and trip it. Generating fresh ids
  // sidesteps the cross-test eviction.
  const newServerId = (): string =>
    `e2e-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

  beforeAll(async () => {
    deferredDb = makeDeferredDb('valid-hash');
    httpServer = createServer();
    wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      // Extract the serverId from the URL path so each test's
      // connection lands on the right bridge instance even when tests
      // run back-to-back with overlapping close handlers.
      const url = req.url ?? '';
      const match = url.match(/\/api\/server\/([^/]+)\/ws/);
      const serverId = match?.[1];
      if (!serverId) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        WsBridge.get(serverId).handleDaemonConnection(
          ws as never,
          deferredDb.db,
          {} as never,
        );
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    WsBridge.getAll().clear();
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  /** Generous polling timeout. CI hosts add tens of ms of jitter on top
   *  of the deferred-DB latency; 1 s is comfortably above any realistic
   *  successful auth round-trip while still giving a fast failure when
   *  the bug has actually re-introduced 4001-close behaviour. */
  const OBSERVE_MS = 1_000;

  it('single back-to-back auth + daemon.hello stays open and authenticates', async () => {
    deferredDb.setLatency(0);
    const serverId = newServerId();
    const url = `ws://127.0.0.1:${port}/api/server/${serverId}/ws`;
    const outcome = await driveDaemonHandshake(url, serverId, TOKEN, OBSERVE_MS, () => WsBridge.get(serverId).isAuthenticated);

    // Pre-fix: outcome.closeCode === 4001 ('auth_required') because
    // daemon.hello raced the auth's DB lookup. Post-fix: connection
    // survives and authenticates cleanly.
    expect(outcome.closeCode).not.toBe(4001);
    expect(outcome.authenticatedDuringWindow).toBe(true);
  });

  it('survives a 50ms-DB-latency window without 4001-close', async () => {
    // 50 ms of DB latency is the worst-case race window: definitely long
    // enough that BOTH messages are queued in the message handler before
    // auth's DB lookup resolves. Without the `authPromise` serialization
    // this fails 100% of the time (4001 close).
    deferredDb.setLatency(50);
    const serverId = newServerId();
    const url = `ws://127.0.0.1:${port}/api/server/${serverId}/ws`;
    const outcome = await driveDaemonHandshake(url, serverId, TOKEN, OBSERVE_MS, () => WsBridge.get(serverId).isAuthenticated);

    expect(outcome.closeCode).not.toBe(4001);
    expect(outcome.authenticatedDuringWindow).toBe(true);
  });

  it('burst of 10 back-to-back reconnect cycles all authenticate cleanly (server-restart simulation)', { timeout: 30_000 }, async () => {
    // Simulates the production reconnect cascade after a server restart.
    // Each cycle: open → auth + daemon.hello → close. The race must be
    // closed for every single cycle, not just statistically most.
    deferredDb.setLatency(20);
    const cycles: ConnectionOutcome[] = [];
    for (let i = 0; i < 10; i += 1) {
      // Per-cycle unique serverId so stale-bridge close handlers from
      // the previous cycle can't evict the current cycle's bridge from
      // the shared map (see comment on `newServerId`).
      const serverId = newServerId();
      const url = `ws://127.0.0.1:${port}/api/server/${serverId}/ws`;
      const outcome = await driveDaemonHandshake(
        url,
        serverId,
        TOKEN,
        OBSERVE_MS,
        () => WsBridge.get(serverId).isAuthenticated,
      );
      cycles.push(outcome);
    }

    // Every cycle MUST avoid 4001. Counting failures gives a clearer
    // diagnostic than a single .toBe assertion when a flake creeps in.
    const flapped = cycles.filter((c) => c.closeCode === 4001);
    expect(flapped, `expected 0 cycles to 4001-close, got ${flapped.length} of 10`).toHaveLength(0);
    const failedAuth = cycles.filter((c) => !c.authenticatedDuringWindow);
    const diagnostic = JSON.stringify(cycles.map((c) => ({
      closed: c.closed, closeCode: c.closeCode, closeReason: c.closeReason,
      auth: c.authenticatedDuringWindow, received: c.received.length,
    })), null, 2);
    expect(failedAuth, `expected 10 cycles to authenticate, got ${10 - failedAuth.length} of 10. cycles=${diagnostic}`).toHaveLength(0);
  });
});
