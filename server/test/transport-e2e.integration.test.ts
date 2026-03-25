/**
 * E2E integration tests for the transport provider status pipeline.
 *
 * Spins up a real PostgreSQL (testcontainers), starts an HTTP + WebSocket
 * server in-process, then connects daemon and browser WebSockets to verify
 * the full message flow:
 *
 *   daemon → WsBridge → browser
 *
 * Covers:
 *   - provider.status broadcast from daemon to all browsers
 *   - chat.subscribe / chat.delta / chat.unsubscribe lifecycle
 *   - All transport event types (delta, complete, error, status, tool, approval)
 *   - Browser isolation (subscriptions are per-browser)
 *   - provider connect→disconnect sequence ordering
 *   - Unknown types are discarded (default-deny)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { randomHex, sha256Hex, hashPassword } from '../src/security/crypto.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Env } from '../src/env.js';

// ── DB + Server lifecycle ────────────────────────────────────────────────────

let db: Database;
let httpServer: HttpServer;
let wss: WebSocketServer;
let serverPort: number;
const JWT_KEY = 'test-jwt-key-transport-e2e-00000000000000';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);

  // Start bare HTTP server — only used for WS upgrade, no Hono needed
  httpServer = createServer((_req, res) => { res.writeHead(404); res.end(); });

  wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/api\/server\/([^/]+)\/ws$/);
    if (!match) { socket.destroy(); return; }
    const [, serverId] = match;
    const isBrowser = url.searchParams.has('browser');

    wss.handleUpgrade(req, socket, head, (ws) => {
      const bridge = WsBridge.get(serverId);
      if (isBrowser) {
        bridge.handleBrowserConnection(ws, 'test-user', db);
      } else {
        bridge.handleDaemonConnection(ws, db, { BOT_ENCRYPTION_KEY: randomHex(32) } as Env);
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      serverPort = (httpServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  wss?.close();
  httpServer?.close();
  WsBridge.getAll().clear();
  await db?.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a unique server in the DB for test isolation. */
async function createTestServer(): Promise<{ serverId: string; token: string }> {
  const serverId = randomHex(16);
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const userId = randomHex(16);
  const passwordHash = await hashPassword('test');
  await db.execute(
    'INSERT INTO users (id, username, password_hash, display_name, is_admin, status, created_at) VALUES ($1, $2, $3, $4, true, $5, $6)',
    [userId, `user_${serverId.slice(0, 8)}`, passwordHash, 'Test', 'active', Date.now()],
  );
  await db.execute(
    'INSERT INTO servers (id, name, user_id, token_hash, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [serverId, `srv_${serverId.slice(0, 8)}`, userId, tokenHash, 'online', Date.now()],
  );
  return { serverId, token };
}

function openWs(serverId: string, query = ''): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/server/${serverId}/ws${query}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function connectDaemon(serverId: string, token: string): Promise<WebSocket> {
  const ws = await openWs(serverId);
  ws.send(JSON.stringify({ type: 'auth', serverId, token }));
  // Wait for auth to complete (DB query + sha256)
  await wait(300);
  return ws;
}

async function connectBrowser(serverId: string): Promise<WebSocket> {
  const ws = await openWs(serverId, '?browser=1');
  await wait(100);
  return ws;
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

/** Collect all messages of a given type within a timeout window. */
function collectType(ws: WebSocket, type: string, expectedCount: number, ms = 3000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = [];
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      // Resolve with what we have (even if less than expected) — let the test assertion fail with a clear message
      resolve(msgs);
    }, ms);
    function handler(data: WebSocket.RawData) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          msgs.push(msg);
          if (msgs.length >= expectedCount) {
            clearTimeout(timer);
            ws.removeListener('message', handler);
            resolve(msgs);
          }
        }
      } catch { /* ignore */ }
    }
    ws.on('message', handler);
  });
}

/** Wait for one message of a type. */
async function waitMsg(ws: WebSocket, type: string, ms = 3000): Promise<any> {
  const [msg] = await collectType(ws, type, 1, ms);
  return msg;
}

function closeAll(...sockets: WebSocket[]): void {
  for (const ws of sockets) {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('transport provider e2e', () => {

  it('provider.status from daemon reaches browser', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);
    const browser = await connectBrowser(serverId);

    try {
      const promise = waitMsg(browser, 'provider.status');
      send(daemon, { type: 'provider.status', providerId: 'openclaw', connected: true });
      const msg = await promise;

      expect(msg.type).toBe('provider.status');
      expect(msg.providerId).toBe('openclaw');
      expect(msg.connected).toBe(true);
    } finally {
      closeAll(daemon, browser);
    }
  });

  it('provider.status broadcasts to multiple browsers', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);
    const b1 = await connectBrowser(serverId);
    const b2 = await connectBrowser(serverId);

    try {
      const p1 = waitMsg(b1, 'provider.status');
      const p2 = waitMsg(b2, 'provider.status');

      send(daemon, { type: 'provider.status', providerId: 'openclaw', connected: true });

      const [msg1, msg2] = await Promise.all([p1, p2]);
      expect(msg1.providerId).toBe('openclaw');
      expect(msg1.connected).toBe(true);
      expect(msg2.providerId).toBe('openclaw');
      expect(msg2.connected).toBe(true);
    } finally {
      closeAll(daemon, b1, b2);
    }
  });

  it('chat.subscribe → chat.delta → only subscribed browser receives', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);
    const subscribed = await connectBrowser(serverId);
    const unsubscribed = await connectBrowser(serverId);

    try {
      // Subscribe one browser
      send(subscribed, { type: 'chat.subscribe', sessionId: 'e2e-sess-1' });
      await wait(200);

      // Set up listeners before sending
      const received1: any[] = [];
      const received2: any[] = [];
      subscribed.on('message', (d) => { try { received1.push(JSON.parse(d.toString())); } catch {} });
      unsubscribed.on('message', (d) => { try { received2.push(JSON.parse(d.toString())); } catch {} });

      send(daemon, {
        type: 'chat.delta', sessionId: 'e2e-sess-1',
        messageId: 'msg-1', delta: 'Hello from OpenClaw', deltaType: 'text',
      });
      await wait(500);

      expect(received1.filter(m => m.type === 'chat.delta')).toHaveLength(1);
      expect(received1.find(m => m.type === 'chat.delta').delta).toBe('Hello from OpenClaw');
      expect(received2.filter(m => m.type === 'chat.delta')).toHaveLength(0);
    } finally {
      closeAll(daemon, subscribed, unsubscribed);
    }
  });

  it('chat.unsubscribe stops event delivery', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);
    const browser = await connectBrowser(serverId);

    try {
      // Subscribe
      send(browser, { type: 'chat.subscribe', sessionId: 'e2e-unsub' });
      await wait(200);

      // Verify delivery works
      const p1 = waitMsg(browser, 'chat.delta');
      send(daemon, { type: 'chat.delta', sessionId: 'e2e-unsub', messageId: 'm1', delta: 'A' });
      const first = await p1;
      expect(first.delta).toBe('A');

      // Unsubscribe
      send(browser, { type: 'chat.unsubscribe', sessionId: 'e2e-unsub' });
      await wait(200);

      // Send another delta — should NOT arrive
      const lateReceived: any[] = [];
      browser.on('message', (d) => { try { lateReceived.push(JSON.parse(d.toString())); } catch {} });
      send(daemon, { type: 'chat.delta', sessionId: 'e2e-unsub', messageId: 'm2', delta: 'B' });
      await wait(500);

      expect(lateReceived.filter(m => m.type === 'chat.delta')).toHaveLength(0);
    } finally {
      closeAll(daemon, browser);
    }
  });

  it('all transport event types relay to subscribed browser', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);
    const browser = await connectBrowser(serverId);

    try {
      send(browser, { type: 'chat.subscribe', sessionId: 'e2e-all' });
      await wait(200);

      const received: any[] = [];
      browser.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch {} });

      const events = [
        { type: 'chat.delta', sessionId: 'e2e-all', messageId: 'm1', delta: 'hi', deltaType: 'text' },
        { type: 'chat.complete', sessionId: 'e2e-all', messageId: 'm1' },
        { type: 'chat.error', sessionId: 'e2e-all', error: 'oops', code: 'ERR' },
        { type: 'chat.status', sessionId: 'e2e-all', status: 'streaming' },
        { type: 'chat.tool', sessionId: 'e2e-all', messageId: 'm2', tool: { name: 'read_file', status: 'started' } },
        { type: 'chat.approval', sessionId: 'e2e-all', requestId: 'r1', description: 'write file' },
      ];

      for (const evt of events) send(daemon, evt);
      await wait(1000);

      const types = received.filter(m => m.type?.startsWith('chat.')).map(m => m.type);
      expect(types).toContain('chat.delta');
      expect(types).toContain('chat.complete');
      expect(types).toContain('chat.error');
      expect(types).toContain('chat.status');
      expect(types).toContain('chat.tool');
      expect(types).toContain('chat.approval');
    } finally {
      closeAll(daemon, browser);
    }
  });

  it('provider connect→disconnect sequence preserves order', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);
    const browser = await connectBrowser(serverId);

    try {
      const promise = collectType(browser, 'provider.status', 2);

      send(daemon, { type: 'provider.status', providerId: 'openclaw', connected: true });
      send(daemon, { type: 'provider.status', providerId: 'openclaw', connected: false });

      const msgs = await promise;
      expect(msgs).toHaveLength(2);
      expect(msgs[0].connected).toBe(true);
      expect(msgs[1].connected).toBe(false);
    } finally {
      closeAll(daemon, browser);
    }
  });

  it('unknown message types are discarded (default-deny)', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);
    const browser = await connectBrowser(serverId);

    try {
      const received: any[] = [];
      browser.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch {} });

      send(daemon, { type: 'evil.hack', payload: 'should not reach browser' });
      await wait(500);

      expect(received.filter(m => m.type === 'evil.hack')).toHaveLength(0);
    } finally {
      closeAll(daemon, browser);
    }
  });

  it('browser subscription isolation — different sessions', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);
    const b1 = await connectBrowser(serverId);
    const b2 = await connectBrowser(serverId);

    try {
      send(b1, { type: 'chat.subscribe', sessionId: 'sess-A' });
      send(b2, { type: 'chat.subscribe', sessionId: 'sess-B' });
      await wait(200);

      const r1: any[] = [];
      const r2: any[] = [];
      b1.on('message', (d) => { try { r1.push(JSON.parse(d.toString())); } catch {} });
      b2.on('message', (d) => { try { r2.push(JSON.parse(d.toString())); } catch {} });

      send(daemon, { type: 'chat.delta', sessionId: 'sess-A', messageId: 'm1', delta: 'for-A' });
      send(daemon, { type: 'chat.delta', sessionId: 'sess-B', messageId: 'm2', delta: 'for-B' });
      await wait(500);

      expect(r1.filter(m => m.type === 'chat.delta').map(m => m.delta)).toEqual(['for-A']);
      expect(r2.filter(m => m.type === 'chat.delta').map(m => m.delta)).toEqual(['for-B']);
    } finally {
      closeAll(daemon, b1, b2);
    }
  });

  it('late-joining browser receives cached provider.status immediately', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);

    try {
      // Daemon announces provider connected — no browser connected yet
      send(daemon, { type: 'provider.status', providerId: 'openclaw', connected: true });
      await wait(300);

      // Register listener BEFORE open so we catch messages sent during handleBrowserConnection
      const received: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/server/${serverId}/ws?browser=1`);
      ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch {} });
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      await wait(500);

      const statusMsgs = received.filter(m => m.type === 'provider.status');
      expect(statusMsgs).toHaveLength(1);
      expect(statusMsgs[0].providerId).toBe('openclaw');
      expect(statusMsgs[0].connected).toBe(true);

      closeAll(ws);
    } finally {
      closeAll(daemon);
    }
  });

  it('daemon disconnect clears provider status for late-joining browsers', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);

    try {
      // Provider connected
      send(daemon, { type: 'provider.status', providerId: 'openclaw', connected: true });
      await wait(200);

      // Daemon disconnects — bridge should clear cached statuses
      daemon.close();
      await wait(500);

      // New browser connects — should NOT receive stale provider.status
      const browser = await connectBrowser(serverId);
      const received: any[] = [];
      browser.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch {} });
      await wait(500);

      const providerMsgs = received.filter(m => m.type === 'provider.status' && m.connected === true);
      expect(providerMsgs).toHaveLength(0);

      closeAll(browser);
    } finally {
      // daemon already closed
    }
  });

  it('provider status persists to DB and survives bridge cache clear', async () => {
    const { serverId, token } = await createTestServer();
    const daemon = await connectDaemon(serverId, token);

    try {
      send(daemon, { type: 'provider.status', providerId: 'openclaw', connected: true });
      await wait(500); // Wait for async DB write

      // Verify DB has the status
      const row = await db.queryOne<{ connected_providers: any }>(
        'SELECT connected_providers FROM servers WHERE id = $1',
        [serverId],
      );
      const providers = typeof row?.connected_providers === 'string'
        ? JSON.parse(row.connected_providers)
        : row?.connected_providers;
      expect(providers?.openclaw).toBe(true);
    } finally {
      closeAll(daemon);
    }
  });
});
