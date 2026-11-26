import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { addCounter, incrementCounter, getCounter, resetMetricsForTests } from '../../shared/metrics.js';
import { resolveServerWebSocketAccess } from '../src/security/authorization.js';
import { dispatchPush } from '../src/routes/push.js';
import { issueOwnerMachineAuthorityForSession } from '../src/share/shared-machine-authority.js';
import {
  scheduleSessionTextTailCacheEvent,
  upsertSessionTextTailCacheEventsBatch,
  flushSessionTextTailCacheForServer,
  flushAllSessionTextTailCacheWrites,
} from '../src/db/queries.js';
import { WsBridge } from '../src/ws/bridge.js';
import { DEFAULT_DB_POOL_MAX } from '../src/db/client.js';
import { sha256Hex } from '../src/security/crypto.js';
import { globalTaskHub } from '../src/services/global-task-hub.js';

class MockSocket extends EventEmitter {
  sent: Array<string | Buffer> = [];
  readyState = 1;
  closed = false;

  send(data: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void) {
    this.sent.push(data);
    cb?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }

  ping() {}
}

function flushAsync(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('1k-concurrency performance optimizations', () => {
  beforeEach(() => {
    resetMetricsForTests();
    WsBridge.disposeAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    WsBridge.disposeAll();
  });

  it('uses an increased default PG pool cap suitable for 1k concurrent bursts', () => {
    expect(DEFAULT_DB_POOL_MAX).toBeGreaterThanOrEqual(50);
  });

  it('produces identical metric keys across 0, 1, 2, and 3+ labels in any insertion order', () => {
    addCounter('ws.test', 1, undefined);
    addCounter('ws.test', 2, {});
    incrementCounter('ws.test');
    expect(getCounter('ws.test')).toBe(4);

    addCounter('ws.test', 4, { route: 'daemon' });
    expect(getCounter('ws.test', { route: 'daemon' })).toBe(4);

    addCounter('ws.test', 5, { b: '2', a: '1' });
    addCounter('ws.test', 6, { a: '1', b: '2' });
    expect(getCounter('ws.test', { a: '1', b: '2' })).toBe(11);

    addCounter('ws.test', 7, { c: '3', a: '1', b: '2' });
    addCounter('ws.test', 8, { b: '2', c: '3', a: '1' });
    expect(getCounter('ws.test', { a: '1', b: '2', c: '3' })).toBe(15);
  });

  it('resolves standard WebSocket access in a single server+status query when user is owner', async () => {
    const queries: string[] = [];
    const db = {
      queryOne: vi.fn(async (sql: string) => {
        queries.push(sql);
        return {
          node_role: 'full',
          user_id: 'u-1',
          owner_status: 'active',
          actor_status: 'active',
        };
      }),
      query: vi.fn(async () => []),
      execute: vi.fn(async () => ({ changes: 1 })),
    } as any;

    const access = await resolveServerWebSocketAccess(db, 'srv-1', 'u-1');
    expect(access).toEqual({ kind: 'standard', role: 'owner' });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('revoked_at IS NULL');
  });

  it('denies disabled owner or disabled actor in resolveServerWebSocketAccess without extra round trips', async () => {
    const db = {
      queryOne: vi.fn(async () => ({
        node_role: 'full',
        user_id: 'u-1',
        owner_status: 'disabled',
        actor_status: 'active',
      })),
    } as any;

    await expect(resolveServerWebSocketAccess(db, 'srv-1', 'u-1')).resolves.toBeNull();
    expect(db.queryOne).toHaveBeenCalledTimes(1);
  });

  it('skips getAccessiblePushServerIds in dispatchPush when neither mobile nor desktop push is allowed', async () => {
    const executedSqls: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        executedSqls.push(sql);
        if (sql.includes('LEFT JOIN push_tokens')) {
          return [{
            user_status: 'active',
            push_enabled_server_ids: null,
            push_notification_types: ['session_error'], // excludes task_complete
            token: null,
            platform: null,
            notification_types: null,
          }];
        }
        throw new Error(`Unexpected extra query: ${sql}`);
      }),
      queryOne: vi.fn(async (sql: string) => {
        throw new Error(`Unexpected queryOne: ${sql}`);
      }),
    } as any;

    const notifySpy = vi.spyOn(globalTaskHub, 'notifyPushNotification').mockResolvedValue();

    await dispatchPush({
      userId: 'u-1',
      serverId: 'srv-1',
      title: 'T',
      body: 'B',
      type: 'task_complete',
    }, db, { DB: db } as any);

    expect(executedSqls).toHaveLength(1);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('bypasses sessions lookup when issueOwnerMachineAuthorityForSession receives projectName while enforcing active owner', async () => {
    const queries: string[] = [];
    const db = {
      queryOne: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { user_id: 'u-1', user_status: 'active' };
      }),
    } as any;

    const token = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: 'u-1',
      sourceServerId: 'srv-1',
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
      actionId: 'act-1',
      signingKey: 'test-signing-key-32-bytes-minimum!!',
    });
    expect(typeof token).toBe('string');
    expect(queries).toHaveLength(1);

    // Disabled user still fails closed immediately.
    db.queryOne.mockResolvedValueOnce({ user_id: 'u-1', user_status: 'disabled' });
    const denied = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: 'u-1',
      sourceServerId: 'srv-1',
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
      actionId: 'act-2',
      signingKey: 'test-signing-key-32-bytes-minimum!!',
    });
    expect(denied).toBeNull();
  });

  it('coalesces rapid session_text_tail_cache events after the first immediate write and flushes batched SQL on disconnect', async () => {
    vi.useFakeTimers();
    const executedBatches: Array<{ sql: string; params: unknown[] }> = [];
    const immediateCalls: string[] = [];
    const db = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        executedBatches.push({ sql, params });
        return { changes: 1 };
      }),
    } as any;

    const immediateWriter = vi.fn(async (_d, _sid, ev: Record<string, unknown>) => {
      immediateCalls.push(String(ev.eventId));
    });

    await scheduleSessionTextTailCacheEvent(db, 'srv-tail-1', {
      sessionId: 'deck_a_brain',
      eventId: 'ev-1',
      ts: 1000,
      type: 'assistant.text',
      payload: { text: 'first' },
    }, immediateWriter);

    // Second and third rapid events within 2500ms coalesce without extra immediate writes
    await scheduleSessionTextTailCacheEvent(db, 'srv-tail-1', {
      sessionId: 'deck_a_brain',
      eventId: 'ev-2',
      ts: 1100,
      type: 'assistant.text',
      payload: { text: 'second' },
    }, immediateWriter);
    await scheduleSessionTextTailCacheEvent(db, 'srv-tail-1', {
      sessionId: 'deck_a_brain',
      eventId: 'ev-2',
      ts: 1200,
      type: 'assistant.text',
      payload: { text: 'second updated' },
    }, immediateWriter);

    expect(immediateCalls).toEqual(['ev-1']);
    expect(executedBatches).toHaveLength(0);

    // Disconnect flush commits the coalesced batch immediately via UNNEST upsert
    await flushSessionTextTailCacheForServer(db, 'srv-tail-1');
    expect(executedBatches).toHaveLength(1);
    expect(executedBatches[0]!.sql).toContain('FROM UNNEST');
    expect(executedBatches[0]!.params[2]).toEqual(['srv-tail-1']);
    expect(executedBatches[0]!.params[3]).toEqual(['deck_a_brain']);
    const payloadJson = JSON.parse((executedBatches[0]!.params[4] as string[])[0]!);
    expect(payloadJson).toEqual([
      { eventId: 'ev-2', ts: 1200, type: 'assistant.text', text: 'second updated' },
    ]);

    // After disconnect cleared cooldown state, next event writes immediately again
    await scheduleSessionTextTailCacheEvent(db, 'srv-tail-1', {
      sessionId: 'deck_a_brain',
      eventId: 'ev-3',
      ts: 1300,
      type: 'assistant.text',
      payload: { text: 'after reconnect' },
    }, immediateWriter);
    expect(immediateCalls).toEqual(['ev-1', 'ev-3']);

    // Shutdown flush handles queued timer writes cleanly
    await scheduleSessionTextTailCacheEvent(db, 'srv-tail-1', {
      sessionId: 'deck_a_brain',
      eventId: 'ev-4',
      ts: 1400,
      type: 'assistant.text',
      payload: { text: 'shutdown pending' },
    }, immediateWriter);
    await flushAllSessionTextTailCacheWrites(db);
    expect(executedBatches).toHaveLength(2);
  });

  it('requeues immediate-write failures, preserves batch entries on transient execute rejection, and awaits in-flight immediate writes on disconnect/shutdown', async () => {
    vi.useFakeTimers();
    const executedBatches: Array<{ params: unknown[] }> = [];
    const db = {
      execute: vi.fn(async (_sql: string, params: unknown[] = []) => {
        executedBatches.push({ params });
        return { changes: 1 };
      }),
    } as any;

    // 1. Immediate writer rejects once -> item is requeued and cooldown timer / flush retries it
    const immediateWriter = vi.fn(async () => {
      throw new Error('transient immediate failure');
    });
    await expect(scheduleSessionTextTailCacheEvent(db, 'srv-fail-1', {
      sessionId: 'deck_r_brain',
      eventId: 'ev-imm-fail',
      ts: 2000,
      type: 'user.message',
      payload: { text: 'must not be lost' },
    }, immediateWriter)).rejects.toThrow('transient immediate failure');

    // Cooldown timer fires and persists the requeued immediate event cleanly
    await vi.advanceTimersByTimeAsync(2_500);
    expect(executedBatches).toHaveLength(1);
    expect(JSON.parse((executedBatches[0]!.params[4] as string[])[0]!)).toEqual([
      { eventId: 'ev-imm-fail', ts: 2000, type: 'user.message', text: 'must not be lost' },
    ]);

    // 2. Advance past cooldown, write immediate event, then batch db.execute rejects once -> entries stay requeued and succeed on retry
    await vi.advanceTimersByTimeAsync(2_500);
    const okWriter = vi.fn(async () => undefined);
    await scheduleSessionTextTailCacheEvent(db, 'srv-fail-1', {
      sessionId: 'deck_r_brain',
      eventId: 'ev-imm-ok',
      ts: 3000,
      type: 'user.message',
      payload: { text: 'baseline' },
    }, okWriter);
    await scheduleSessionTextTailCacheEvent(db, 'srv-fail-1', {
      sessionId: 'deck_r_brain',
      eventId: 'ev-batch-1',
      ts: 3100,
      type: 'assistant.text',
      payload: { text: 'queued batch' },
    }, okWriter);

    db.execute.mockRejectedValueOnce(new Error('transient pg error'));
    await expect(flushSessionTextTailCacheForServer(db, 'srv-fail-1')).rejects.toThrow('transient pg error');
    expect(executedBatches).toHaveLength(1);

    // Retry flush persists the requeued batch entry
    await flushSessionTextTailCacheForServer(db, 'srv-fail-1');
    expect(executedBatches).toHaveLength(2);
    expect(JSON.parse((executedBatches[1]!.params[4] as string[])[0]!)).toEqual([
      { eventId: 'ev-batch-1', ts: 3100, type: 'assistant.text', text: 'queued batch' },
    ]);

    // 3. Unresolved in-flight immediate write that later rejects is awaited and flushed by disconnect & shutdown
    let rejectDisconnectImmediate!: (err: Error) => void;
    const pendingDisconnectImmediate = vi.fn(
      () => new Promise<void>((_resolve, reject) => { rejectDisconnectImmediate = reject; }),
    );
    const inFlightSchedule = scheduleSessionTextTailCacheEvent(db, 'srv-fail-2', {
      sessionId: 'deck_s2_brain',
      eventId: 'ev-inflight-dc',
      ts: 4000,
      type: 'user.message',
      payload: { text: 'inflight disconnect' },
    }, pendingDisconnectImmediate).catch(() => undefined);

    let disconnectResolved = false;
    const disconnectFlush = flushSessionTextTailCacheForServer(db, 'srv-fail-2').then(() => {
      disconnectResolved = true;
    });
    await Promise.resolve();
    expect(disconnectResolved).toBe(false);

    rejectDisconnectImmediate(new Error('mid-disconnect fail'));
    await inFlightSchedule;
    await disconnectFlush;
    expect(disconnectResolved).toBe(true);
    expect(executedBatches).toHaveLength(3);
    expect(JSON.parse((executedBatches[2]!.params[4] as string[])[0]!)).toEqual([
      { eventId: 'ev-inflight-dc', ts: 4000, type: 'user.message', text: 'inflight disconnect' },
    ]);

    let rejectShutdownImmediate!: (err: Error) => void;
    const pendingShutdownImmediate = vi.fn(
      () => new Promise<void>((_resolve, reject) => { rejectShutdownImmediate = reject; }),
    );
    const shutdownSchedule = scheduleSessionTextTailCacheEvent(db, 'srv-fail-3', {
      sessionId: 'deck_s3_brain',
      eventId: 'ev-inflight-sd',
      ts: 5000,
      type: 'assistant.text',
      payload: { text: 'inflight shutdown' },
    }, pendingShutdownImmediate).catch(() => undefined);

    let shutdownResolved = false;
    const shutdownFlush = flushAllSessionTextTailCacheWrites(db).then(() => {
      shutdownResolved = true;
    });
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    rejectShutdownImmediate(new Error('mid-shutdown fail'));
    await shutdownSchedule;
    await shutdownFlush;
    expect(shutdownResolved).toBe(true);
    expect(executedBatches).toHaveLength(4);
    expect(JSON.parse((executedBatches[3]!.params[4] as string[])[0]!)).toEqual([
      { eventId: 'ev-inflight-sd', ts: 5000, type: 'assistant.text', text: 'inflight shutdown' },
    ]);
  });

  it('upsertSessionTextTailCacheEventsBatch skips empty input and groups duplicate session entries', async () => {
    const db = {
      execute: vi.fn(async () => ({ changes: 1 })),
    } as any;
    await upsertSessionTextTailCacheEventsBatch(db, []);
    expect(db.execute).not.toHaveBeenCalled();

    await upsertSessionTextTailCacheEventsBatch(db, [
      { serverId: 's1', sessionName: 'sess1', items: [{ eventId: 'e1', ts: 10, type: 'user.message', text: 'hi' }] },
      { serverId: 's1', sessionName: 'sess1', items: [{ eventId: 'e2', ts: 20, type: 'assistant.text', text: 'ok' }] },
    ]);
    expect(db.execute).toHaveBeenCalledTimes(1);
    const params = db.execute.mock.calls[0]![1] as unknown[];
    expect(params[2]).toEqual(['s1']);
    expect(params[3]).toEqual(['sess1']);
  });

  it('tracks share-active bridges in O(1) and resolves push display + serverName without extra DB lookups', async () => {
    const serverId = 'srv-opt-bridge';
    const token = 'tok-opt';
    const tokenHash = sha256Hex(token);
    const sqlHistory: string[] = [];

    const db = {
      queryOne: vi.fn(async (sql: string) => {
        sqlHistory.push(sql);
        if (sql.includes('SELECT token_hash')) {
          return {
            token_hash: tokenHash,
            user_id: 'u-opt',
            name: 'Initial Host Name',
            node_role: 'full',
            revoked_at: null,
            owner_status: 'active',
          };
        }
        if (sql.includes('FROM servers')) {
          throw new Error(`Unexpected redundant servers query: ${sql}`);
        }
        if (sql.includes('FROM sessions')) {
          throw new Error(`Unexpected redundant sessions query: ${sql}`);
        }
        return null;
      }),
      query: vi.fn(async () => []),
      execute: vi.fn(async () => ({ changes: 1 })),
    } as any;

    const bridge = WsBridge.get(serverId);
    const daemonWs = new MockSocket() as unknown as WebSocket;
    bridge.handleDaemonConnection(daemonWs, db, { DB: db } as any);
    (daemonWs as unknown as MockSocket).emit('message', Buffer.from(JSON.stringify({
      type: 'auth',
      serverId,
      token,
    })));
    await flushAsync();

    // Update activeMainSessions + rename server via setServerName
    (daemonWs as unknown as MockSocket).emit('message', Buffer.from(JSON.stringify({
      type: 'session_list',
      sessions: [{
        name: 'deck_proj_brain',
        project: 'myproj',
        agentType: 'claude',
        state: 'running',
        label: 'Main Brain',
      }],
    })));
    await flushAsync();

    bridge.setServerName('Renamed Host');
    const brainTextSpy = vi.spyOn(globalTaskHub, 'notifyBrainText').mockResolvedValue();

    (daemonWs as unknown as MockSocket).emit('message', Buffer.from(JSON.stringify({
      type: 'timeline.event',
      event: {
        sessionId: 'deck_proj_brain',
        eventId: 'evt-100',
        type: 'assistant.text',
        ts: Date.now(),
        payload: { text: 'Hello from optimized bridge', projectName: 'myproj' },
      },
    })));
    await flushAsync();

    expect(brainTextSpy).toHaveBeenCalledWith(db, expect.objectContaining({
      serverId,
      serverName: 'Renamed Host',
      sessionName: 'deck_proj_brain',
    }));

    // O(1) share sweep tracking: adding non-share browser keeps shareSweepBridges empty
    const shareSet = (WsBridge as unknown as { shareSweepBridges: Set<WsBridge> }).shareSweepBridges;
    const browserWs = new MockSocket() as unknown as WebSocket;
    bridge.handleBrowserConnection(browserWs, 'u-opt', db);
    expect(shareSet.has(bridge)).toBe(false);

    // Adding a share socket registers only this bridge, and disconnecting removes it
    const shareWs = new MockSocket() as unknown as WebSocket;
    bridge.handleShareBrowserConnection(shareWs, 'u-guest', db, {
      ticketId: 't-1',
      target: { kind: 'server', serverId },
      snapshot: { effectiveRole: 'viewer', serverParticipantAuthority: false } as any,
    });
    expect(shareSet.has(bridge)).toBe(true);
    (shareWs as unknown as MockSocket).close();
    expect(shareSet.has(bridge)).toBe(false);
    expect(sqlHistory.filter((s) => s.includes('SELECT token_hash'))).toHaveLength(1);
  });
});
