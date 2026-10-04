import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { CONTROLLED_NODE_WORKER_REFRESH_PHASE } from '../../shared/controlled-node-worker-refresh.js';
import type { Database } from '../src/db/client.js';
import { WsBridge } from '../src/ws/bridge.js';
import { sha256Hex } from '../src/security/crypto.js';

class MockWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string | Buffer): void { this.sent.push(typeof data === 'string' ? data : data.toString()); }
  close(): void { this.readyState = 3; this.emit('close'); }
}

function makeDb(execute: Database['execute']): Database {
  return {
    query: async () => [],
    queryOne: async () => ({
      token_hash: sha256Hex('token'),
      node_role: NODE_ROLE.CONTROLLED,
      revoked_at: null,
      user_id: 'owner-1',
      os: 'linux',
    }),
    execute,
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => process.nextTick(resolve));
}

describe('controlled worker refresh bridge contract', () => {
  afterEach(() => { WsBridge.getAll().clear(); vi.restoreAllMocks(); });

  it('validates, persists, broadcasts, and restores the latest refresh status', async () => {
    const execute = vi.fn(async () => ({ changes: 1 }));
    const db = makeDb(execute);
    const serverId = 'controlled-refresh-bridge-1';
    const bridge = WsBridge.get(serverId);
    const browser = new MockWs();
    bridge.handleBrowserConnection(browser as never, 'owner-1', db);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: 'auth', serverId, token: 'token', nodeRole: NODE_ROLE.CONTROLLED,
      capabilities: [], daemonVersion: '2026.9.5113-dev.5644',
    })));
    await flush();

    const status = {
      type: DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS,
      attemptId: 'attempt-refresh-0001',
      phase: CONTROLLED_NODE_WORKER_REFRESH_PHASE.SUCCEEDED,
      installedVersion: '2026.10.5371-dev.5816',
      targetVersion: '2026.10.5371-dev.5816',
      artifactSha256: 'a'.repeat(64),
      recordedAt: 1_700_000_000_000,
    };
    daemon.emit('message', Buffer.from(JSON.stringify(status)));
    await flush();

    expect(bridge.getControlledNodeWorkerRefreshStatus()).toEqual(status);
    expect(browser.sent.map((raw) => JSON.parse(raw))).toContainEqual(status);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('controlled_worker_refresh_attempt_id'),
      expect.arrayContaining([status.attemptId, status.phase, status.artifactSha256, serverId, NODE_ROLE.CONTROLLED]),
    );

    // A replacement bridge/auth reads the durable row and exposes the same
    // status before any new daemon event arrives.
    const restored = WsBridge.get('controlled-refresh-bridge-2');
    const restoredDb: Database = {
      ...db,
      queryOne: async (sql: string) => sql.includes('controlled_worker_refresh_attempt_id')
        ? {
          token_hash: sha256Hex('token'), node_role: NODE_ROLE.CONTROLLED, revoked_at: null,
          user_id: 'owner-1', os: 'linux', controlled_worker_refresh_attempt_id: status.attemptId,
          controlled_worker_refresh_phase: status.phase,
          controlled_worker_refresh_installed_version: status.installedVersion,
          controlled_worker_refresh_target_version: status.targetVersion,
          controlled_worker_refresh_artifact_sha256: status.artifactSha256,
          controlled_worker_refresh_recorded_at: status.recordedAt,
        }
        : await db.queryOne(),
    } as unknown as Database;
    const restoredDaemon = new MockWs();
    restored.handleDaemonConnection(restoredDaemon as never, restoredDb, {} as never);
    restoredDaemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId: 'controlled-refresh-bridge-2', token: 'token', nodeRole: NODE_ROLE.CONTROLLED, capabilities: [] })));
    await flush();
    expect(restored.getControlledNodeWorkerRefreshStatus()).toEqual(status);
  });

  it('drops malformed refresh status before persistence or browser broadcast', async () => {
    const execute = vi.fn(async () => ({ changes: 1 }));
    const db = makeDb(execute);
    const bridge = WsBridge.get('controlled-refresh-bridge-invalid');
    const browser = new MockWs();
    bridge.handleBrowserConnection(browser as never, 'owner-1', db);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId: 'controlled-refresh-bridge-invalid', token: 'token', nodeRole: NODE_ROLE.CONTROLLED, capabilities: [] })));
    await flush();
    const before = browser.sent.length;
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS,
      attemptId: 'not-a-valid-attempt', phase: 'succeeded', recordedAt: 'not-a-number',
    })));
    await flush();
    expect(bridge.getControlledNodeWorkerRefreshStatus()).toBeNull();
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining('controlled_worker_refresh_attempt_id'), expect.anything());
    expect(browser.sent).toHaveLength(before);
  });
});
