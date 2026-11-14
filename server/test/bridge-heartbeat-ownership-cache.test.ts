/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import { sha256Hex } from '../src/security/crypto.js';
import { REMOTE_DESKTOP_NODE_CONTEXT_MSG } from '../../shared/remote-desktop-access.js';
import { CONTROLLED_NODE_OS_WIN } from '../../shared/controlled-node-artifacts.js';
import type { EffectiveCoverage, ShareTarget } from '../src/ws/share-policy.js';

class MockWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  closed = false;
  closeCode?: number;
  closeReason?: string;
  sent: Array<string | Buffer> = [];

  send(data: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit('close');
  }

  get sentFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item) as Record<string, unknown>);
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeTicketCoverage(target: ShareTarget): EffectiveCoverage {
  return {
    shareId: 'share-1',
    serverId: target.serverId,
    ownerUserId: 'owner-1',
    target,
    effectiveRole: 'viewer',
    permission: 'read',
    coveringShareIds: ['share-1'],
    primaryShareId: 'share-1',
    nextCoverageRecheckAt: Date.now() + 60_000,
    serverParticipantAuthority: false,
  } as unknown as EffectiveCoverage;
}

describe('WsBridge Batch B-2: heartbeat throttling, node context cache, ownership cache, parallel auth & shared share sweep', () => {
  const tokenHash = sha256Hex('test-token');

  beforeEach(() => {
    WsBridge.disposeAll();
  });

  afterEach(() => {
    WsBridge.disposeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('1. updateServerHeartbeat DB write throttling', () => {
    function makeHeartbeatDb(nodeRole: 'full' | 'controlled' = 'full') {
      const heartbeatWrites: Array<{ sql: string; params?: unknown[] }> = [];
      const db: Database = {
        queryOne: async (sql: string) => {
          if (sql.includes('FROM servers')) {
            return {
              token_hash: tokenHash,
              user_id: 'owner-1',
              owner_status: 'active',
              node_role: nodeRole,
              revoked_at: null,
              os: nodeRole === 'controlled' ? CONTROLLED_NODE_OS_WIN : 'linux',
            };
          }
          return null;
        },
        query: async () => [],
        execute: async (sql: string, params?: unknown[]) => {
          if (/UPDATE\s+servers[\s\S]*last_heartbeat_at\s*=/i.test(sql)) {
            heartbeatWrites.push({ sql, params });
          }
          return { changes: 1 };
        },
        exec: async () => {},
        transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
        close: () => {},
      } as unknown as Database;
      return { db, heartbeatWrites };
    }

    it('throttles repeated FULL daemon heartbeat DB writes while still sending immediate heartbeat_ack, flushing on version change, timeout, and reconnect', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const { db, heartbeatWrites } = makeHeartbeatDb('full');
      const serverId = 'srv-hb-full';
      const bridge = WsBridge.get(serverId);
      const ws1 = new MockWs();
      bridge.handleDaemonConnection(ws1 as never, db, {} as never);
      ws1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'test-token', daemonVersion: '1.0.0' }));
      await flush();
      expect(heartbeatWrites).toHaveLength(1);

      // Heartbeat within 45s with unchanged version: must still ack immediately, 0 extra DB writes.
      await vi.advanceTimersByTimeAsync(15_000);
      ws1.emit('message', JSON.stringify({ type: 'heartbeat', daemonVersion: '1.0.0', sentAt: 111 }));
      await flush();
      expect(heartbeatWrites).toHaveLength(1);
      expect(ws1.sentFrames.filter((f) => f.type === 'heartbeat_ack')).toHaveLength(1);

      // Another heartbeat at 30s (< 45s): still throttled, still acks.
      await vi.advanceTimersByTimeAsync(15_000);
      ws1.emit('message', JSON.stringify({ type: 'heartbeat', daemonVersion: '1.0.0', sentAt: 222 }));
      await flush();
      expect(heartbeatWrites).toHaveLength(1);
      expect(ws1.sentFrames.filter((f) => f.type === 'heartbeat_ack')).toHaveLength(2);

      // daemonVersion change within throttle window forces immediate DB write.
      await vi.advanceTimersByTimeAsync(5_000);
      ws1.emit('message', JSON.stringify({ type: 'heartbeat', daemonVersion: '1.0.1', sentAt: 333 }));
      await flush();
      expect(heartbeatWrites).toHaveLength(2);
      expect(ws1.sentFrames.filter((f) => f.type === 'heartbeat_ack')).toHaveLength(3);

      // Crossing >= 45s threshold writes DB again even with unchanged version.
      await vi.advanceTimersByTimeAsync(45_000);
      ws1.emit('message', JSON.stringify({ type: 'heartbeat', daemonVersion: '1.0.1', sentAt: 444 }));
      await flush();
      expect(heartbeatWrites).toHaveLength(3);
      expect(ws1.sentFrames.filter((f) => f.type === 'heartbeat_ack')).toHaveLength(4);

      // Disconnect & reconnect immediately resets throttle so reconnect writes immediately.
      ws1.close();
      await flush();
      const ws2 = new MockWs();
      bridge.handleDaemonConnection(ws2 as never, db, {} as never);
      ws2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'test-token', daemonVersion: '1.0.1' }));
      await flush();
      expect(heartbeatWrites).toHaveLength(4);
    });

    it('throttles repeated CONTROLLED node heartbeat DB writes while still returning heartbeat_ack immediately', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const { db, heartbeatWrites } = makeHeartbeatDb('controlled');
      const serverId = 'srv-hb-ctrl';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, db, {} as never);
      ws.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'test-token',
        daemonVersion: '2.0.0',
        capabilities: [],
      }));
      await flush();
      expect(heartbeatWrites).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(20_000);
      ws.emit('message', JSON.stringify({ type: 'heartbeat', daemonVersion: '2.0.0' }));
      await flush();
      expect(heartbeatWrites).toHaveLength(1);
      expect(ws.sentFrames.filter((f) => f.type === 'heartbeat_ack')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(25_000);
      ws.emit('message', JSON.stringify({ type: 'heartbeat', daemonVersion: '2.0.0' }));
      await flush();
      expect(heartbeatWrites).toHaveLength(2);
      expect(ws.sentFrames.filter((f) => f.type === 'heartbeat_ack')).toHaveLength(2);
    });
  });

  describe('2. sendRemoteDesktopNodeContext connection-scoped cache & invalidation', () => {
    it('caches hostId within a connection generation, refreshes promptly when initially unavailable, and honors explicit invalidation', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      let currentHostId: string | null = null;
      let throwHostQuery = false;
      let hostQueries = 0;

      const db: Database = {
        queryOne: async (sql: string) => {
          if (sql.includes('remote_desktop_host_endpoints')) {
            hostQueries += 1;
            if (throwHostQuery) throw new Error('transient db failure');
            return currentHostId ? { host_id: currentHostId } : null;
          }
          if (sql.includes('FROM servers')) {
            return {
              token_hash: tokenHash,
              user_id: 'owner-1',
              owner_status: 'active',
              node_role: 'controlled',
              revoked_at: null,
              os: CONTROLLED_NODE_OS_WIN,
            };
          }
          return null;
        },
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
        close: () => {},
      } as unknown as Database;

      const serverId = 'srv-rd-ctx';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      throwHostQuery = true;
      bridge.handleDaemonConnection(ws as never, db, {} as never);
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'test-token', capabilities: [] }));
      await flush();

      const gen1 = bridge.daemonConnectionGeneration();
      expect(hostQueries).toBe(1);
      expect(ws.sentFrames.filter((f) => f.type === REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE)).toHaveLength(1);

      // Recovery: because previous state was unavailable/error, next heartbeat immediately refreshes & caches CURRENT.
      throwHostQuery = false;
      currentHostId = 'host-00000000000000000001';
      ws.emit('message', JSON.stringify({ type: 'heartbeat' }));
      await flush();
      expect(hostQueries).toBe(2);
      expect(ws.sentFrames.filter((f) => f.type === REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT)).toEqual([
        {
          type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
          hostId: 'host-00000000000000000001',
          daemonGeneration: gen1,
        },
      ]);

      // Subsequent heartbeat within cache window skips both DB query and duplicate WS push.
      await vi.advanceTimersByTimeAsync(20_000);
      ws.emit('message', JSON.stringify({ type: 'heartbeat' }));
      await flush();
      expect(hostQueries).toBe(2);
      expect(ws.sentFrames.filter((f) => f.type === REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT)).toHaveLength(1);

      // Explicit invalidation forces fresh lookup and pushes updated hostId on next heartbeat.
      currentHostId = 'host-00000000000000000002';
      WsBridge.invalidateRemoteDesktopNodeContext(serverId);
      ws.emit('message', JSON.stringify({ type: 'heartbeat' }));
      await flush();
      expect(hostQueries).toBe(3);
      expect(ws.sentFrames.filter((f) => f.type === REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT)).toHaveLength(2);

      // Fallback recheck after 60s with unchanged hostId updates cache timestamp without duplicating WS frame.
      await vi.advanceTimersByTimeAsync(60_000);
      ws.emit('message', JSON.stringify({ type: 'heartbeat' }));
      await flush();
      expect(hostQueries).toBe(4);
      expect(ws.sentFrames.filter((f) => f.type === REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT)).toHaveLength(2);
    });
  });

  describe('3. verifySessionOwnership main-session positive cache & invalidation', () => {
    function makeOwnershipDb(ownedByServer: Map<string, Set<string>>, options: { failDb?: boolean } = {}) {
      let sessionOwnershipQueries = 0;
      const db: Database = {
        queryOne: async (sql: string, params?: unknown[]) => {
          if (sql.includes('FROM servers')) {
            return {
              token_hash: tokenHash,
              user_id: 'owner-1',
              owner_status: 'active',
              node_role: 'full',
              revoked_at: null,
            };
          }
          if (sql.includes('FROM sessions WHERE server_id = $1 AND name = $2')) {
            sessionOwnershipQueries += 1;
            if (options.failDb) throw new Error('db down');
            const [sid, sname] = params as [string, string];
            return ownedByServer.get(sid)?.has(sname) ? { ok: 1 } : null;
          }
          return null;
        },
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
        close: () => {},
      } as unknown as Database;
      return { db, getQueryCount: () => sessionOwnershipQueries };
    }

    it('hits activeMainSessions from session_list and caches DB-verified main sessions per server, invalidating on deletion/session_list/dispose and failing closed on DB error', async () => {
      const owned = new Map<string, Set<string>>([
        ['srv-own-a', new Set(['deck_proj_a_brain', 'deck_proj_cached_brain'])],
        ['srv-own-b', new Set()],
      ]);
      const failFlag = { failDb: false };
      const { db, getQueryCount } = makeOwnershipDb(owned, failFlag);

      const bridgeA = WsBridge.get('srv-own-a');
      const daemonA = new MockWs();
      bridgeA.handleDaemonConnection(daemonA as never, db, {} as never);
      daemonA.emit('message', JSON.stringify({ type: 'auth', serverId: 'srv-own-a', token: 'test-token' }));
      await flush();

      // session_list marks deck_proj_a_brain active -> 0 DB queries on terminal.subscribe.
      daemonA.emit('message', JSON.stringify({
        type: 'session_list',
        sessions: [{ name: 'deck_proj_a_brain', project: 'proj_a', state: 'idle', agentType: 'claude' }],
      }));
      await flush();

      const browserA1 = new MockWs();
      bridgeA.handleBrowserConnection(browserA1 as never, 'owner-1', db);
      browserA1.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_a_brain' }));
      await flush();
      expect(getQueryCount()).toBe(0);
      expect(daemonA.sentFrames.some((f) => f.type === 'terminal.subscribe' && f.session === 'deck_proj_a_brain')).toBe(true);

      // Session not in session_list falls back to DB once, then hits positive cache on second subscribe.
      browserA1.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_cached_brain' }));
      await flush();
      expect(getQueryCount()).toBe(1);
      const browserA2 = new MockWs();
      bridgeA.handleBrowserConnection(browserA2 as never, 'owner-1', db);
      browserA2.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_cached_brain' }));
      await flush();
      expect(getQueryCount()).toBe(1);

      // Cross-server isolation: srv-own-b must NOT borrow srv-own-a's cache.
      const bridgeB = WsBridge.get('srv-own-b');
      const daemonB = new MockWs();
      bridgeB.handleDaemonConnection(daemonB as never, db, {} as never);
      daemonB.emit('message', JSON.stringify({ type: 'auth', serverId: 'srv-own-b', token: 'test-token' }));
      await flush();
      const browserB = new MockWs();
      bridgeB.handleBrowserConnection(browserB as never, 'owner-1', db);
      browserB.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_cached_brain' }));
      await flush();
      expect(getQueryCount()).toBe(2);
      expect(daemonB.sentFrames.some((f) => f.type === 'terminal.subscribe' && f.session === 'deck_proj_cached_brain')).toBe(false);

      // Deletion via revalidateShareSocketsForTarget invalidates main-session cache -> next check hits DB and denies.
      owned.get('srv-own-a')!.delete('deck_proj_cached_brain');
      await bridgeA.revalidateShareSocketsForTarget({
        kind: 'main',
        serverId: 'srv-own-a',
        sessionName: 'deck_proj_cached_brain',
      });
      const browserA3 = new MockWs();
      bridgeA.handleBrowserConnection(browserA3 as never, 'owner-1', db);
      browserA3.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_cached_brain' }));
      await flush();
      expect(getQueryCount()).toBe(3);
      expect(daemonA.sentFrames.filter((f) => f.type === 'terminal.subscribe' && f.session === 'deck_proj_cached_brain')).toHaveLength(1);

      // Full session_list replacement drops removed active session from ownership cache too.
      owned.get('srv-own-a')!.delete('deck_proj_a_brain');
      daemonA.emit('message', JSON.stringify({ type: 'session_list', sessions: [] }));
      await flush();
      const browserA4 = new MockWs();
      bridgeA.handleBrowserConnection(browserA4 as never, 'owner-1', db);
      browserA4.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_a_brain' }));
      await flush();
      expect(getQueryCount()).toBe(4);

      // DB error fails closed and never poisons positive cache.
      failFlag.failDb = true;
      owned.get('srv-own-a')!.add('deck_proj_recovered_brain');
      browserA4.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_recovered_brain' }));
      await flush();
      expect(getQueryCount()).toBe(5);
      expect(daemonA.sentFrames.some((f) => f.type === 'terminal.subscribe' && f.session === 'deck_proj_recovered_brain')).toBe(false);

      failFlag.failDb = false;
      browserA4.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_recovered_brain' }));
      await flush();
      expect(getQueryCount()).toBe(6);
      expect(daemonA.sentFrames.some((f) => f.type === 'terminal.subscribe' && f.session === 'deck_proj_recovered_brain')).toBe(true);

      // bridge.dispose() clears cached ownership.
      bridgeA.dispose();
    });
  });

  describe('4. Parallel post-auth reads & single process-wide shareExpirySweepHandle', () => {
    it('runs readUserMemoryFeatureFlags, getSessionIdentityProfile, and sendCapabilitySnapshot concurrently after auth', async () => {
      const started: string[] = [];
      let releaseAll!: () => void;
      const gate = new Promise<void>((resolve) => { releaseAll = resolve; });

      const db: Database = {
        queryOne: async (sql: string) => {
          if (sql.includes('FROM servers')) {
            return {
              token_hash: tokenHash,
              user_id: 'owner-1',
              owner_status: 'active',
              node_role: 'full',
              revoked_at: null,
            };
          }
          if (sql.includes('FROM user_preferences')) {
            started.push('memory_flags');
            await gate;
            return null;
          }
          if (sql.includes('FROM session_identity_profiles')) {
            started.push('user_identity');
            await gate;
            return null;
          }
          return null;
        },
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        transaction: async <T>(fn: (tx: Database) => Promise<T>) => {
          started.push('capability_snapshot');
          await gate;
          return fn(db);
        },
        close: () => {},
      } as unknown as Database;

      const serverId = 'srv-parallel-auth';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, db, { JWT_SIGNING_KEY: 'secret-key' } as never);
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'test-token' }));
      await flush();

      // Both user-config reads and capability snapshot start before any of them resolves.
      expect(started).toContain('memory_flags');
      expect(started).toContain('user_identity');
      expect(started).toContain('capability_snapshot');

      releaseAll();
      await flush();
    });

    it('uses a single shared 30s interval timer across multiple share bridges and clears all timers on close/disposeAll', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const db: Database = {
        queryOne: async () => null,
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
        close: () => {},
      } as unknown as Database;

      // Without share/controlled sockets, creating bridges does not start any share sweep timer.
      const b1 = WsBridge.get('srv-share-1');
      const b2 = WsBridge.get('srv-share-2');
      const b3 = WsBridge.get('srv-share-3');
      const baselineTimers = vi.getTimerCount();

      const spy1 = vi.spyOn(b1 as unknown as { sweepShareSockets: () => Promise<void> }, 'sweepShareSockets').mockResolvedValue(undefined);
      const spy2 = vi.spyOn(b2 as unknown as { sweepShareSockets: () => Promise<void> }, 'sweepShareSockets').mockResolvedValue(undefined);
      const spy3 = vi.spyOn(b3 as unknown as { sweepShareSockets: () => Promise<void> }, 'sweepShareSockets').mockResolvedValue(undefined);

      const s1 = new MockWs();
      const s2 = new MockWs();
      const target1: ShareTarget = { kind: 'main', serverId: 'srv-share-1', sessionName: 'deck_a_brain' };
      const target2: ShareTarget = { kind: 'main', serverId: 'srv-share-2', sessionName: 'deck_b_brain' };
      b1.handleShareBrowserConnection(s1 as never, 'guest-1', db, {
        ticketId: 't1',
        target: target1,
        snapshot: makeTicketCoverage(target1),
      });
      b2.handleShareBrowserConnection(s2 as never, 'guest-2', db, {
        ticketId: 't2',
        target: target2,
        snapshot: makeTicketCoverage(target2),
      });
      await flush();

      // Multiple share bridges add only 1 shared sweep interval timer (not 2).
      expect(vi.getTimerCount()).toBe(baselineTimers + 1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);
      // b3 has no active share state so it is skipped.
      expect(spy3).not.toHaveBeenCalled();

      // Closing both share sockets stops the shared sweep timer cleanly (and disposes idle bridges).
      const timersBeforeClose = vi.getTimerCount();
      s1.close();
      s2.close();
      await flush();
      expect(vi.getTimerCount()).toBeLessThan(timersBeforeClose);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);

      // Re-attaching a share socket restarts the timer, and disposeAll() clears all bridge timers.
      const b1Reopened = WsBridge.get('srv-share-1');
      const spy1Reopened = vi.spyOn(b1Reopened as unknown as { sweepShareSockets: () => Promise<void> }, 'sweepShareSockets').mockResolvedValue(undefined);
      const timersBeforeReattach = vi.getTimerCount();
      const s3 = new MockWs();
      b1Reopened.handleShareBrowserConnection(s3 as never, 'guest-3', db, {
        ticketId: 't3',
        target: target1,
        snapshot: makeTicketCoverage(target1),
      });
      await flush();
      expect(vi.getTimerCount()).toBe(timersBeforeReattach + 1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(spy1Reopened).toHaveBeenCalledTimes(1);

      WsBridge.disposeAll();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(spy1Reopened).toHaveBeenCalledTimes(1);
    });
  });
});
