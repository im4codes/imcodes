/**
 * E2E regression for live chat push / typewriter updates.
 *
 * This uses the real daemon ServerLink, real server WsBridge, and a real
 * browser websocket. The contract being locked: live `timeline.event`
 * messages must bypass bulk history/data sends so the UI can update without a
 * page refresh while large history payloads are still draining.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { Database } from '../../server/src/db/client.js';
import { WsBridge } from '../../server/src/ws/bridge.js';
import { ServerLink } from '../../src/daemon/server-link.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';

vi.mock('../../server/src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../../server/src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

const SERVER_ID = 'live-push-e2e-server';
const SESSION_ID = 'deck_live_push_e2e';

type JsonMessage = Record<string, unknown>;

interface LivePushRig {
  httpServer: HttpServer;
  wss: WebSocketServer;
  port: number;
  shutdown(): Promise<void>;
}

function makeDb(): Database {
  const db = {
    queryOne: async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT token_hash')) {
        return { token_hash: 'valid-hash', user_id: 'test-user' };
      }
      if (sql.includes('FROM sessions WHERE')) {
        return params[0] === SERVER_ID && params[1] === SESSION_ID ? { ok: 1 } : null;
      }
      if (sql.includes('FROM sub_sessions WHERE')) return null;
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database),
    close: () => {},
  };
  return db as unknown as Database;
}

async function buildRig(): Promise<LivePushRig> {
  const db = makeDb();
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = url.pathname.match(/^\/api\/server\/([^/]+)\/ws$/);
    const serverId = match?.[1];
    if (!serverId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const bridge = WsBridge.get(serverId);
      if (url.searchParams.get('browser') === '1') {
        bridge.handleBrowserConnection(ws, 'test-user', db);
      } else {
        bridge.handleDaemonConnection(ws, db, {} as never);
      }
    });
  });

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      resolve((httpServer.address() as AddressInfo).port);
    });
  });

  return {
    httpServer,
    wss,
    port,
    shutdown: async () => {
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      WsBridge.getAll().clear();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

async function waitForWsOpen(ws: WebSocket, label: string): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} open timed out`)), 5_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('live timeline push over daemon ServerLink and server WsBridge', () => {
  let rig: LivePushRig;

  beforeAll(async () => {
    rig = await buildRig();
  });

  afterAll(async () => {
    await rig.shutdown();
  });

  it('delivers typewriter timeline events to chat subscribers before queued bulk history', async () => {
    const link = new ServerLink({
      workerUrl: `http://127.0.0.1:${rig.port}`,
      serverId: SERVER_ID,
      token: 'test-token',
    });
    const daemonInbox: JsonMessage[] = [];
    link.onMessage((msg) => daemonInbox.push(msg as JsonMessage));

    const browser = new WebSocket(`ws://127.0.0.1:${rig.port}/api/server/${SERVER_ID}/ws?browser=1`);
    const browserMessages: JsonMessage[] = [];
    browser.on('message', (raw) => {
      browserMessages.push(JSON.parse(raw.toString()) as JsonMessage);
    });

    try {
      link.connect();
      await waitForWsOpen(browser, 'browser');
      await waitFor(() => link.isConnected() && WsBridge.get(SERVER_ID).isAuthenticated, 5_000, 'daemon authenticated');

      browser.send(JSON.stringify({ type: TRANSPORT_MSG.CHAT_SUBSCRIBE, sessionId: SESSION_ID }));
      await waitFor(
        () => daemonInbox.some((msg) => msg.type === TRANSPORT_MSG.CHAT_SUBSCRIBE && msg.sessionId === SESSION_ID),
        5_000,
        'chat subscription reached daemon',
      );
      browserMessages.length = 0;

      link.send({
        type: TRANSPORT_MSG.CHAT_HISTORY,
        sessionId: SESSION_ID,
        events: [
          {
            id: 'history-1',
            role: 'assistant',
            text: 'bulk-history'.repeat(32 * 1024),
          },
        ],
      });
      link.sendTimelineEvent({
        eventId: 'evt-typewriter',
        sessionId: SESSION_ID,
        ts: Date.now(),
        seq: 1,
        epoch: 1,
        type: 'assistant.text',
        payload: { text: 'H', streaming: true },
      });
      link.sendTimelineEvent({
        eventId: 'evt-typewriter',
        sessionId: SESSION_ID,
        ts: Date.now() + 1,
        seq: 2,
        epoch: 1,
        type: 'assistant.text',
        payload: { text: 'Hello live', streaming: true },
      });

      await waitFor(
        () => browserMessages.filter((msg) => msg.type === TIMELINE_MESSAGES.EVENT).length >= 2
          && browserMessages.some((msg) => msg.type === TRANSPORT_MSG.CHAT_HISTORY),
        5_000,
        'live timeline events and bulk history delivered',
      );

      const receivedTypes = browserMessages.map((msg) => msg.type);
      const firstTimelineIndex = receivedTypes.indexOf(TIMELINE_MESSAGES.EVENT);
      const historyIndex = receivedTypes.indexOf(TRANSPORT_MSG.CHAT_HISTORY);
      expect(firstTimelineIndex).toBeGreaterThanOrEqual(0);
      expect(historyIndex).toBeGreaterThanOrEqual(0);
      expect(firstTimelineIndex).toBeLessThan(historyIndex);

      const typewriterEvents = browserMessages
        .filter((msg) => msg.type === TIMELINE_MESSAGES.EVENT)
        .map((msg) => msg.event as JsonMessage)
        .filter((event) => event.eventId === 'evt-typewriter');
      expect(typewriterEvents.map((event) => (event.payload as JsonMessage).text)).toEqual(['H', 'Hello live']);
      expect(typewriterEvents.every((event) => event.type === 'assistant.text')).toBe(true);
    } finally {
      browser.close();
      link.disconnect();
    }
  });
});
