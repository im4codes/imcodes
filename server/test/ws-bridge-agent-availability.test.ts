/**
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import { AGENT_AVAILABILITY_MSG } from '../../shared/agent-availability.js';
import { SUBSESSION_CREATED_BATCH_MSG, SUBSESSION_SYNC_BATCH_MSG } from '../../shared/scale-limits.js';

vi.mock('../src/security/crypto.js', () => ({ sha256Hex: (_s: string) => 'valid-hash' }));
vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }
  close(): void { this.closed = true; this.readyState = 3; this.emit('close'); }
  get sentJson(): Array<Record<string, unknown>> {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash', owner_status: 'active', node_role: 'full', revoked_at: null }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

const flushAsync = () => new Promise<void>((resolve) => { setImmediate(resolve); });

describe('WsBridge: agent availability relay', () => {
  let serverId: string;

  beforeEach(() => { serverId = `test-avail-${Math.random().toString(36).slice(2)}`; });
  afterEach(() => { WsBridge.getAll().clear(); vi.clearAllMocks(); });

  it('forwards session.detect_agents from browser to daemon and broadcasts session.agents_availability to browsers', async () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    const browser = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb() as never, {} as never);
    bridge.handleBrowserConnection(browser as never, { id: 'user-a' } as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();

    browser.emit('message', JSON.stringify({ type: AGENT_AVAILABILITY_MSG.DETECT, forceRefresh: true }));
    await flushAsync();

    expect(daemon.sentJson).toContainEqual({
      type: AGENT_AVAILABILITY_MSG.DETECT,
      forceRefresh: true,
    });

    const availabilityPayload = {
      type: AGENT_AVAILABILITY_MSG.RESULT,
      agents: { 'agy-sdk': { installed: false }, 'codex-sdk': { installed: true } },
      checkedAt: 1_700_000_000_000,
    };
    daemon.emit('message', JSON.stringify(availabilityPayload));
    await flushAsync();

    expect(browser.sentJson).toContainEqual(availabilityPayload);
  });

  it('correlates session/subsession restart responses, commits late acks on timeout with explicit null clearing, guards epochs, and falls back for legacy daemons', async () => {
    const bridge = WsBridge.get(serverId);
    const executeQueries: Array<{ sql: string; params: unknown[] }> = [];
    const trackedDb = {
      queryOne: async () => ({ token_hash: 'valid-hash', owner_status: 'active', node_role: 'full', revoked_at: null }),
      query: async () => [],
      execute: async (sql: string, params: unknown[] = []) => {
        executeQueries.push({ sql, params });
        return { changes: 1 };
      },
      exec: async () => {},
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
        queryOne: trackedDb.queryOne,
        query: trackedDb.query,
        execute: trackedDb.execute,
      }),
      close: () => {},
    } as unknown as import('../src/db/client.js').Database;

    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, trackedDb as never, {} as never);

    // 1) Legacy daemon without supportsSessionRestartResponse -> fire-and-forget sendToDaemon, returns legacy_sent
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
    await flushAsync();
    await expect(bridge.sendSessionRestartCommand({ type: 'session.restart', sessionName: 'deck_p_brain' })).resolves.toEqual({ status: 'legacy_sent' });
    expect(daemon.sentJson).toContainEqual({ type: 'session.restart', sessionName: 'deck_p_brain' });

    // 2) Modern daemon advertising supportsSessionRestartResponse -> awaits correlated restart_response
    const daemon2 = new MockWs();
    bridge.handleDaemonConnection(daemon2 as never, trackedDb as never, {} as never);
    daemon2.emit('message', JSON.stringify({
      type: 'auth',
      serverId,
      token: 'my-token',
      supportsSessionRestartResponse: true,
    }));
    await flushAsync();

    const pendingReject = bridge.sendSessionRestartCommand({
      type: 'subsession.restart',
      sessionName: 'deck_sub_1',
      agentType: 'claude-code',
      requestedModel: 'm %TEMP%',
    });
    const sentRestart = daemon2.sentJson.find((m) => m.type === 'subsession.restart');
    expect(typeof sentRestart?.requestId).toBe('string');
    expect(typeof sentRestart?.deadlineAt).toBe('number');
    expect(typeof sentRestart?.restartEpoch).toBe('number');

    daemon2.emit('message', JSON.stringify({
      type: 'subsession.restart_response',
      requestId: sentRestart!.requestId,
      ok: false,
      rejected: true,
      error: 'Cannot safely forward model',
    }));
    await expect(pendingReject).resolves.toEqual({
      status: 'rejected',
      error: 'Cannot safely forward model',
    });

    // 3) Timeout returns pending, and late ok=true response STILL invokes persistApplied with explicit null clearing
    const latePersisted: Array<Record<string, unknown>> = [];
    const timeoutRes = await bridge.sendSessionRestartCommand(
      {
        type: 'subsession.restart',
        sessionName: 'deck_sub_clear1',
        agentType: 'claude-code',
        ccPreset: null,
      },
      {
        timeoutMs: 20,
        persistApplied: async (applied) => {
          latePersisted.push(applied as unknown as Record<string, unknown>);
        },
      },
    );
    expect(timeoutRes).toMatchObject({ status: 'pending' });
    const sentTimeoutRestart = daemon2.sentJson.find((m) => m.sessionName === 'deck_sub_clear1');

    // Emit initial sync for old runtimeEpoch, then commit late restart with cleared nulls + new runtimeEpoch
    daemon2.emit('message', JSON.stringify({
      type: 'subsession.sync',
      id: 'clear1',
      sessionType: 'claude-code',
      runtimeEpoch: 'epoch-old',
      ccPresetId: 'OldPreset',
      requestedModel: 'm2',
      activeModel: 'm2',
    }));
    await flushAsync();

    daemon2.emit('message', JSON.stringify({
      type: 'subsession.restart_response',
      requestId: sentTimeoutRestart!.requestId,
      ok: true,
      applied: {
        agentType: 'claude-code',
        ccPreset: null,
        requestedModel: null,
        activeModel: null,
        modelDisplay: null,
        runtimeType: 'process',
        providerId: null,
        cwd: '/proj',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'epoch-new',
      },
    }));
    await vi.waitFor(() => {
      expect(latePersisted).toHaveLength(1);
    });
    expect(latePersisted[0]).toMatchObject({
      ccPreset: null,
      requestedModel: null,
      activeModel: null,
      runtimeEpoch: 'epoch-new',
    });

    const browser = new MockWs();
    bridge.handleBrowserConnection(browser as never, 'user-sync-check', trackedDb as never);
    browser.emit('message', JSON.stringify({ type: 'subsession.rebuild_all', subSessions: [], supportsCreatedBatch: true }));
    await flushAsync();
    browser.sent.length = 0;

    // 4) Delayed stale subsession.sync AND subsession.sync.batch with superseded runtimeEpoch ('epoch-old') are both dropped
    // without DB writes, memory cache overwrite, or browser broadcast.
    executeQueries.length = 0;
    daemon2.emit('message', JSON.stringify({
      type: 'subsession.sync',
      id: 'clear1',
      sessionType: 'codex-sdk',
      runtimeEpoch: 'epoch-old',
      ccPresetId: 'OldPreset',
      requestedModel: 'm2',
      activeModel: 'm2',
    }));
    daemon2.emit('message', JSON.stringify({
      type: SUBSESSION_SYNC_BATCH_MSG,
      items: [
        {
          id: 'clear1',
          sessionType: 'codex-sdk',
          runtimeEpoch: 'epoch-old',
          ccPresetId: 'OldPreset',
          requestedModel: 'm2',
          activeModel: 'm2',
        },
      ],
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(executeQueries).toHaveLength(0);
    expect(
      browser.sentJson.filter((m) => m.type === 'subsession.created' || m.type === SUBSESSION_CREATED_BATCH_MSG),
    ).toEqual([]);
    await expect(bridge.resolveSessionAgentType('deck_sub_clear1')).resolves.toBe('claude-code');

    // 5) Mixed multi-session subsession.sync.batch containing BOTH stale ('clear1') and fresh ('fresh1') commits ONLY 'fresh1'
    daemon2.emit('message', JSON.stringify({
      type: SUBSESSION_SYNC_BATCH_MSG,
      items: [
        {
          id: 'clear1',
          sessionType: 'codex-sdk',
          runtimeEpoch: 'epoch-old',
          ccPresetId: 'OldPreset',
          requestedModel: 'm2',
          activeModel: 'm2',
        },
        {
          id: 'fresh1',
          sessionType: 'qwen',
          runtimeEpoch: 'epoch-fresh-1',
          ccPresetId: null,
          requestedModel: null,
          activeModel: null,
        },
      ],
    }));
    await vi.waitFor(() => {
      expect(browser.sentJson.some((m) => m.type === SUBSESSION_CREATED_BATCH_MSG)).toBe(true);
    });
    const batchBroadcast = browser.sentJson.find((m) => m.type === SUBSESSION_CREATED_BATCH_MSG);
    expect(batchBroadcast?.items).toHaveLength(1);
    expect((batchBroadcast?.items as Array<Record<string, unknown>>)[0]?.id).toBe('fresh1');
    expect(executeQueries.some((q) => q.params.includes('fresh1'))).toBe(true);
    expect(executeQueries.some((q) => q.params.includes('clear1'))).toBe(false);
    await expect(bridge.resolveSessionAgentType('deck_sub_clear1')).resolves.toBe('claude-code');
    await expect(bridge.resolveSessionAgentType('deck_sub_fresh1')).resolves.toBe('qwen');

    // 6) Late-arriving valid subsession.sync for 'clear1' with current runtimeEpoch ('epoch-new') clears DB
    executeQueries.length = 0;
    daemon2.emit('message', JSON.stringify({
      type: 'subsession.sync',
      id: 'clear1',
      sessionType: 'claude-code',
      runtimeEpoch: 'epoch-new',
      ccPresetId: null,
      requestedModel: null,
      activeModel: null,
    }));
    await vi.waitFor(() => {
      expect(executeQueries.some((q) => q.sql.includes('UPDATE sub_sessions SET'))).toBe(true);
    });

    // 7) Late ok=true after 202 timeout STILL commits if a newer dispatched restart was rejected (not committed)
    const latePreserved: Array<Record<string, unknown>> = [];
    const reqTimeout = await bridge.sendSessionRestartCommand(
      { type: 'subsession.restart', sessionName: 'deck_sub_keep1', agentType: 'claude-code', ccPreset: 'KeepMe' },
      { timeoutMs: 20, persistApplied: async (applied) => { latePreserved.push(applied as unknown as Record<string, unknown>); } },
    );
    expect(reqTimeout).toMatchObject({ status: 'pending' });
    const reqKeepSent = daemon2.sentJson.find((m) => m.sessionName === 'deck_sub_keep1');

    const reqNewerRejectPromise = bridge.sendSessionRestartCommand({
      type: 'subsession.restart',
      sessionName: 'deck_sub_keep1',
      agentType: 'claude-code',
      ccPreset: 'BadNext',
    });
    const reqNewerSent = [...daemon2.sentJson].reverse().find((m) => m.sessionName === 'deck_sub_keep1');
    daemon2.emit('message', JSON.stringify({
      type: 'subsession.restart_response',
      requestId: reqNewerSent!.requestId,
      ok: false,
      rejected: true,
      error: 'bad_preflight',
    }));
    await expect(reqNewerRejectPromise).resolves.toEqual({ status: 'rejected', error: 'bad_preflight' });

    daemon2.emit('message', JSON.stringify({
      type: 'subsession.restart_response',
      requestId: reqKeepSent!.requestId,
      ok: true,
      applied: {
        agentType: 'claude-code',
        ccPreset: 'KeepMe',
        requestedModel: 'm-keep',
        activeModel: 'm-keep',
        modelDisplay: 'm-keep',
        runtimeType: 'process',
        providerId: null,
        cwd: '/proj',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'ep-keep-1',
      },
    }));
    await vi.waitFor(() => {
      expect(latePreserved).toHaveLength(1);
    });
    expect(latePreserved[0]).toMatchObject({ ccPreset: 'KeepMe', requestedModel: 'm-keep' });
  });

  it('rejects unwarmed stale subsession.sync.batch on a fresh bridge via previousRuntimeEpoch and reserves all batch keys in enqueue order', async () => {
    const freshServerId = `test-fresh-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(freshServerId);
    const executeCalls: Array<{ sql: string; params: unknown[] }> = [];
    let releaseSlowPersist!: () => void;
    const slowPersistGate = new Promise<void>((resolve) => { releaseSlowPersist = resolve; });

    const freshDb = {
      queryOne: async () => ({ token_hash: 'valid-hash', owner_status: 'active', node_role: 'full', revoked_at: null }),
      query: async () => [],
      execute: async (sql: string, params: unknown[] = []) => {
        executeCalls.push({ sql, params });
        return { changes: 1 };
      },
      exec: async () => {},
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
        queryOne: freshDb.queryOne,
        query: freshDb.query,
        execute: freshDb.execute,
      }),
      close: () => {},
    } as unknown as import('../src/db/client.js').Database;

    const daemon = new MockWs();
    const browser = new MockWs();
    bridge.handleDaemonConnection(daemon as never, freshDb as never, {} as never);
    bridge.handleBrowserConnection(browser as never, 'owner-fresh', freshDb as never);
    daemon.emit('message', JSON.stringify({
      type: 'auth',
      serverId: freshServerId,
      token: 'my-token',
      supportsSessionRestartResponse: true,
    }));
    await flushAsync();
    browser.emit('message', JSON.stringify({ type: 'subsession.rebuild_all', subSessions: [], supportsCreatedBatch: true }));
    await flushAsync();

    // 1) Fresh bridge has NEVER seen any prior subsession.sync for 'unwarmed1' (no epoch-old in cache).
    // Commit a restart clearing ccPreset with previousRuntimeEpoch='epoch-old-unwarmed' -> runtimeEpoch='epoch-new-unwarmed'.
    const persistedOrder: string[] = [];
    const clearPromise = bridge.sendSessionRestartCommand(
      { type: 'subsession.restart', sessionName: 'deck_sub_unwarmed1', agentType: 'claude-code', ccPreset: null },
      {
        persistApplied: async (applied) => {
          persistedOrder.push(`clear:${applied.runtimeEpoch}`);
        },
      },
    );
    const clearSent = daemon.sentJson.find((m) => m.sessionName === 'deck_sub_unwarmed1');
    daemon.emit('message', JSON.stringify({
      type: 'subsession.restart_response',
      requestId: clearSent!.requestId,
      ok: true,
      previousRuntimeEpoch: 'epoch-old-unwarmed',
      applied: {
        agentType: 'claude-code',
        ccPreset: null,
        requestedModel: null,
        activeModel: null,
        modelDisplay: null,
        runtimeType: 'process',
        providerId: null,
        cwd: '/proj',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'epoch-new-unwarmed',
      },
    }));
    await expect(clearPromise).resolves.toMatchObject({ status: 'committed' });

    // 2) Stale subsession.sync.batch (alone and mixed) carrying NEVER-before-seen 'epoch-old-unwarmed' MUST produce 0 DB writes for unwarmed1
    executeCalls.length = 0;
    browser.sent.length = 0;
    daemon.emit('message', JSON.stringify({
      type: SUBSESSION_SYNC_BATCH_MSG,
      items: [
        {
          id: 'unwarmed1',
          sessionType: 'codex-sdk',
          runtimeEpoch: 'epoch-old-unwarmed',
          ccPresetId: 'OldPreset',
          requestedModel: 'stale-m',
          activeModel: 'stale-m',
        },
      ],
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(executeCalls).toHaveLength(0);
    expect(browser.sentJson.filter((m) => m.type === 'subsession.created' || m.type === SUBSESSION_CREATED_BATCH_MSG)).toEqual([]);
    await expect(bridge.resolveSessionAgentType('deck_sub_unwarmed1')).resolves.toBe('claude-code');

    // Mixed batch: only 'freshOnly' persists & broadcasts, 'unwarmed1' is dropped
    daemon.emit('message', JSON.stringify({
      type: SUBSESSION_SYNC_BATCH_MSG,
      items: [
        {
          id: 'unwarmed1',
          sessionType: 'codex-sdk',
          runtimeEpoch: 'epoch-old-unwarmed',
          ccPresetId: 'OldPreset',
          requestedModel: 'stale-m',
          activeModel: 'stale-m',
        },
        {
          id: 'freshOnly',
          sessionType: 'qwen',
          runtimeEpoch: 'epoch-fresh-only',
          ccPresetId: null,
          requestedModel: null,
          activeModel: null,
        },
      ],
    }));
    await vi.waitFor(() => {
      expect(browser.sentJson.some((m) => m.type === SUBSESSION_CREATED_BATCH_MSG)).toBe(true);
    });
    expect(executeCalls.some((c) => c.params.includes('freshOnly'))).toBe(true);
    expect(executeCalls.some((c) => c.params.includes('unwarmed1'))).toBe(false);
    await expect(bridge.resolveSessionAgentType('deck_sub_unwarmed1')).resolves.toBe('claude-code');

    // 3) Multi-session queue reservation on enqueue:
    // While 'deck_sub_a_first' holds its serialized lock, enqueue batch ['a_first', 'z_later'],
    // THEN immediately enqueue a restart commit on 'deck_sub_z_later'.
    // 'z_later' MUST wait for the earlier batch (batch runs first with ep-z-1, restart runs second with ep-z-2).
    const orderEvents: string[] = [];
    const slowRestart = bridge.sendSessionRestartCommand(
      { type: 'subsession.restart', sessionName: 'deck_sub_a_first', agentType: 'claude-code', ccPreset: null },
      {
        persistApplied: async () => {
          orderEvents.push('a_slow_start');
          await slowPersistGate;
          orderEvents.push('a_slow_end');
        },
      },
    );
    const aSent = daemon.sentJson.find((m) => m.sessionName === 'deck_sub_a_first');
    daemon.emit('message', JSON.stringify({
      type: 'subsession.restart_response',
      requestId: aSent!.requestId,
      ok: true,
      applied: {
        agentType: 'claude-code',
        ccPreset: null,
        requestedModel: null,
        activeModel: null,
        modelDisplay: null,
        runtimeType: 'process',
        providerId: null,
        cwd: '/proj',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'ep-a-1',
      },
    }));
    await vi.waitFor(() => expect(orderEvents).toContain('a_slow_start'));

    // Enqueue batch FIRST while a_first is still holding its lock
    daemon.emit('message', JSON.stringify({
      type: SUBSESSION_SYNC_BATCH_MSG,
      items: [
        { id: 'a_first', sessionType: 'claude-code', runtimeEpoch: 'ep-a-1' },
        { id: 'z_later', sessionType: 'qwen', runtimeEpoch: 'ep-z-1', ccPresetId: 'OldZ', requestedModel: 'old-z', activeModel: 'old-z' },
      ],
    }));

    // Enqueue newer restart for z_later SECOND (while batch is still blocked behind a_first!)
    const zRestart = bridge.sendSessionRestartCommand(
      { type: 'subsession.restart', sessionName: 'deck_sub_z_later', agentType: 'claude-code', ccPreset: null },
      {
        persistApplied: async (applied) => {
          orderEvents.push(`z_restart:${applied.runtimeEpoch}`);
        },
      },
    );
    const zSent = daemon.sentJson.find((m) => m.sessionName === 'deck_sub_z_later');
    daemon.emit('message', JSON.stringify({
      type: 'subsession.restart_response',
      requestId: zSent!.requestId,
      ok: true,
      previousRuntimeEpoch: 'ep-z-1',
      applied: {
        agentType: 'claude-code',
        ccPreset: null,
        requestedModel: null,
        activeModel: null,
        modelDisplay: null,
        runtimeType: 'process',
        providerId: null,
        cwd: '/proj',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'ep-z-2',
      },
    }));
    // Wait briefly — z_restart MUST NOT have bypassed the queued batch
    await new Promise((r) => setTimeout(r, 20));
    expect(orderEvents).toEqual(['a_slow_start']);

    releaseSlowPersist();
    await Promise.all([slowRestart, zRestart]);
    expect(orderEvents).toEqual(['a_slow_start', 'a_slow_end', 'z_restart:ep-z-2']);
    await expect(bridge.resolveSessionAgentType('deck_sub_z_later')).resolves.toBe('claude-code');
  });
});
