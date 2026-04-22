/**
 * Push notification integration tests — real PostgreSQL via testcontainers.
 *
 * Tests that push notifications include human-readable server name,
 * session metadata (project, agent type), and last assistant text.
 * Also verifies mobile suppression logic.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { sha256Hex, randomHex } from '../src/security/crypto.js';
import { WsBridge } from '../src/ws/bridge.js';

// Mock push dispatch to capture payloads without sending real notifications
vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

// ── Mock WebSocket ──────────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void) {
    if (!this.closed) this.sent.push(typeof data === 'string' ? data : data.toString());
    cb?.();
  }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
}

async function flushAsync(ms = 500) {
  // Real DB queries need actual time, not just microtask flushes
  await new Promise((r) => setTimeout(r, ms));
}

// ── DB lifecycle ────────────────────────────────────────────────────────────

let db: Database;
let userId: string;
let serverId: string;
const serverToken = randomHex(32);

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);

  // Create test user + server + session
  userId = randomHex(16);
  serverId = randomHex(16);
  await createUser(db, userId, 'push-test');
  await createServer(db, serverId, userId, 'my-dev-machine', sha256Hex(serverToken));

  // Insert a session record so push can look up metadata
  const now = Date.now();
  await db.execute(
    `INSERT INTO sessions (id, server_id, name, project_name, project_dir, role, agent_type, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [randomHex(16), serverId, 'deck_cd_brain', 'my-project', '/home/dev/project', 'brain', 'claude-code', 'running', now, now],
  );
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  WsBridge.getAll().clear();
  vi.clearAllMocks();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function setupAuthenticatedDaemon() {
  const env = { DB: db } as never;
  const bridge = WsBridge.get(serverId);
  const daemonWs = new MockWs();
  bridge.handleDaemonConnection(daemonWs as never, db, env);
  daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: serverToken }));
  await flushAsync();
  return { bridge, daemonWs, env };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('push notification content', () => {
  it('includes server name, project name, and agent type in title', async () => {
    const { dispatchPush } = await import('../src/routes/push.js');
    const { daemonWs } = await setupAuthenticatedDaemon();

    daemonWs.emit('message', JSON.stringify({
      type: 'session.idle',
      session: 'deck_cd_brain',
    }));
    await flushAsync();

    expect(dispatchPush).toHaveBeenCalled();
    const payload = vi.mocked(dispatchPush).mock.calls[0][0];
    expect(payload.title).toContain('my-dev-machine');
    expect(payload.title).toContain('my-project');
    expect(payload.title).toContain('claude-code');
    expect(payload.userId).toBe(userId);
  });

  it('uses lastText as push body when provided', async () => {
    const { dispatchPush } = await import('../src/routes/push.js');
    const { daemonWs } = await setupAuthenticatedDaemon();

    daemonWs.emit('message', JSON.stringify({
      type: 'session.idle',
      session: 'deck_cd_brain',
      lastText: 'All 42 tests passing. Ready for review.',
    }));
    await flushAsync();

    const payload = vi.mocked(dispatchPush).mock.calls[0][0];
    expect(payload.body).toBe('All 42 tests passing. Ready for review.');
  });

  it('falls back to default body when no lastText', async () => {
    const { dispatchPush } = await import('../src/routes/push.js');
    const { daemonWs } = await setupAuthenticatedDaemon();

    daemonWs.emit('message', JSON.stringify({
      type: 'session.idle',
      session: 'deck_cd_brain',
    }));
    await flushAsync();

    const payload = vi.mocked(dispatchPush).mock.calls[0][0];
    expect(payload.body).toContain('ready for input');
  });

  it('sends push for session.error with error message', async () => {
    const { dispatchPush } = await import('../src/routes/push.js');
    const { daemonWs } = await setupAuthenticatedDaemon();

    daemonWs.emit('message', JSON.stringify({
      type: 'session.error',
      session: 'deck_cd_brain',
      error: 'Process exited with code 1',
    }));
    await flushAsync();

    const payload = vi.mocked(dispatchPush).mock.calls[0][0];
    expect(payload.title).toContain('my-dev-machine');
    expect(payload.body).toContain('Process exited with code 1');
  });
});

describe('push with mobile connected', () => {
  it('suppresses push when mobile client is connected', async () => {
    const { dispatchPush } = await import('../src/routes/push.js');
    const { bridge, daemonWs } = await setupAuthenticatedDaemon();

    const mobileWs = new MockWs();
    bridge.handleBrowserConnection(mobileWs as never, userId, db, true);

    daemonWs.emit('message', JSON.stringify({
      type: 'session.idle',
      session: 'deck_cd_brain',
    }));
    await flushAsync();

    expect(dispatchPush).not.toHaveBeenCalled();
  });

  it('sends push when only desktop browser is connected', async () => {
    const { dispatchPush } = await import('../src/routes/push.js');
    const { bridge, daemonWs } = await setupAuthenticatedDaemon();

    const desktopWs = new MockWs();
    bridge.handleBrowserConnection(desktopWs as never, userId, db, false);

    daemonWs.emit('message', JSON.stringify({
      type: 'session.idle',
      session: 'deck_cd_brain',
      lastText: 'Done.',
    }));
    await flushAsync();

    expect(dispatchPush).toHaveBeenCalled();
  });

});
