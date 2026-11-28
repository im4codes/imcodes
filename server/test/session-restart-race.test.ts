/**
 * @vitest-environment node
 */

import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';

vi.mock('../src/security/crypto.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/security/crypto.js')>(),
  sha256Hex: () => 'valid-hash',
}));
vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));
vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: async () => 'owner',
  resolveServerMembershipRole: async () => 'owner',
}));
vi.mock('../src/routes/share-http-auth.js', () => ({
  resolveServerMemberAccessOrShareDeny: async () => ({ ok: true, role: 'owner' }),
  resolveHttpShareAccess: async () => ({ membership: 'owner', actor: { kind: 'server-member', effectiveActorRole: 'server-manager' } }),
  resolveHttpShareAccessForCoveredSession: async () => ({ membership: 'owner', actor: { kind: 'server-member', effectiveActorRole: 'server-manager' } }),
}));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }
  close(): void { this.readyState = 3; this.emit('close'); }
  get sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

interface StoredRow {
  agentType?: string;
  type?: string;
  cc_preset_id?: string | null;
  requested_model?: string | null;
  active_model?: string | null;
}

function makeTrackedDb() {
  const mainSessions = new Map<string, StoredRow>([
    ['deck_proj_brain', { agentType: 'claude-code-sdk', requested_model: 'init', active_model: 'init' }],
  ]);
  const subSessions = new Map<string, StoredRow>([
    ['sub-race-1', { type: 'claude-code-sdk', cc_preset_id: 'InitPreset', requested_model: 'init', active_model: 'init' }],
  ]);
  const updates: Array<{ table: 'sessions' | 'sub_sessions'; key: string; patch: Record<string, unknown> }> = [];

  const db = {
    queryOne: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM servers')) {
        return { token_hash: 'valid-hash', owner_status: 'active', node_role: 'full', revoked_at: null };
      }
      if (sql.includes('FROM sub_sessions')) {
        const id = String(params[0] ?? '');
        const row = subSessions.get(id);
        return row ? { id, server_id: 'srv-race', ...row } : null;
      }
      if (sql.includes('FROM sessions')) {
        const name = String(params[1] ?? params[0] ?? '');
        const row = mainSessions.get(name);
        return row ? { name, ...row } : null;
      }
      return null;
    },
    query: async () => [],
    execute: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('UPDATE sessions SET')) {
        const name = String(params[params.length - 1]);
        const row = mainSessions.get(name) ?? {};
        const setClause = sql.slice('UPDATE sessions SET '.length, sql.indexOf(' WHERE '));
        const cols = setClause.split(',').map((s) => s.trim().split(' = ')[0]);
        const patch: Record<string, unknown> = {};
        cols.forEach((col, i) => {
          if (col && col !== 'updated_at') {
            patch[col] = params[i];
            (row as Record<string, unknown>)[col] = params[i];
          }
        });
        mainSessions.set(name, row);
        updates.push({ table: 'sessions', key: name, patch });
      } else if (sql.startsWith('UPDATE sub_sessions SET')) {
        const id = String(params[params.length - 2]);
        const row = subSessions.get(id) ?? {};
        const setClause = sql.slice('UPDATE sub_sessions SET '.length, sql.indexOf(' WHERE '));
        const cols = setClause.split(',').map((s) => s.trim().split(' = ')[0]);
        const patch: Record<string, unknown> = {};
        cols.forEach((col, i) => {
          if (col && col !== 'updated_at') {
            patch[col] = params[i];
            (row as Record<string, unknown>)[col] = params[i];
          }
        });
        subSessions.set(id, row);
        updates.push({ table: 'sub_sessions', key: id, patch });
      }
      return { changes: 1 };
    },
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;

  return { db, mainSessions, subSessions, updates };
}

const flushAsync = () => new Promise<void>((resolve) => { setImmediate(resolve); });

describe('real WsBridge + HTTP route session restart race & confirmation scoping', () => {
  let serverId: string;

  beforeEach(() => {
    serverId = `srv-race-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
  });

  async function buildApp(db: import('../src/db/client.js').Database) {
    const { sessionMgmtRoutes } = await import('../src/routes/session-mgmt.js');
    const { subSessionRoutes } = await import('../src/routes/sub-sessions.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: typeof db } }).env = { DB: db };
      await next();
    });
    app.route('/api/server', sessionMgmtRoutes);
    app.route('/api/server', subSessionRoutes);
    return app;
  }

  it('keeps plain agentType/type PATCH on legacy fire-and-forget path even with modern daemon', async () => {
    const { db, updates } = makeTrackedDb();
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db as never, {} as never);
    daemon.emit('message', JSON.stringify({
      type: 'auth',
      serverId,
      token: 'tok',
      supportsSessionRestartResponse: true,
    }));
    await flushAsync();
    daemon.sent.length = 0;

    const app = await buildApp(db);

    const mainRes = await app.request(`/api/server/${serverId}/sessions/deck_proj_brain`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'codex-sdk', requestedModel: 'gpt-5' }),
    });
    expect(mainRes.status).toBe(200);
    expect(await mainRes.json()).toEqual({ ok: true });

    const subRes = await app.request(`/api/server/${serverId}/sub-sessions/sub-race-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'codex-sdk', requestedModel: 'gpt-5' }),
    });
    expect(subRes.status).toBe(200);
    expect(await subRes.json()).toEqual({ ok: true });

    expect(daemon.sentJson).toEqual([
      { type: 'session.restart', sessionName: 'deck_proj_brain', agentType: 'codex-sdk', requestedModel: 'gpt-5' },
      { type: 'subsession.restart', sessionName: 'deck_sub_sub-race-1', agentType: 'codex-sdk', requestedModel: 'gpt-5' },
    ]);
    expect(updates).toHaveLength(2);
  });

  it('prevents interleaved concurrent preset PATCHes from committing/returning superseded state and preserves earlier valid request when newer rejects', async () => {
    const { db, mainSessions, subSessions, updates } = makeTrackedDb();
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, db as never, {} as never);
    daemon.emit('message', JSON.stringify({
      type: 'auth',
      serverId,
      token: 'tok',
      supportsSessionRestartResponse: true,
    }));
    await flushAsync();
    const app = await buildApp(db);

    // ── Main session: two concurrent preset PATCHes, Req 2 commits FIRST, Req 1 finishes SECOND ──
    daemon.sent.length = 0;
    const req1 = app.request(`/api/server/${serverId}/sessions/deck_proj_brain`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code-sdk',
        ccPreset: 'PresetA',
        requestedModel: 'm-a',
        activeModel: null,
      }),
    });
    await flushAsync();
    const req2 = app.request(`/api/server/${serverId}/sessions/deck_proj_brain`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code-sdk',
        ccPreset: 'PresetB',
        requestedModel: 'm-b',
        activeModel: null,
      }),
    });
    await vi.waitFor(() => {
      expect(daemon.sentJson.filter((m) => m.type === 'session.restart')).toHaveLength(2);
    });
    const [m1, m2] = daemon.sentJson.filter((m) => m.type === 'session.restart');

    const appliedB = {
      agentType: 'claude-code-sdk',
      ccPreset: 'PresetB',
      requestedModel: 'm-b',
      activeModel: 'm-b',
      modelDisplay: 'm-b',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      cwd: '/proj',
      label: null,
      description: null,
      effort: null,
      transportConfig: null,
      runtimeEpoch: 'ep-main-2',
    };
    const appliedA = { ...appliedB, ccPreset: 'PresetA', requestedModel: 'm-a', activeModel: 'm-a', modelDisplay: 'm-a', runtimeEpoch: 'ep-main-1' };

    // Resolve Req 2 FIRST, then Req 1 SECOND
    daemon.emit('message', JSON.stringify({ type: 'session.restart_response', requestId: m2!.requestId, ok: true, applied: appliedB }));
    const res2 = await req2;
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, applied: appliedB });

    daemon.emit('message', JSON.stringify({ type: 'session.restart_response', requestId: m1!.requestId, ok: true, applied: appliedA }));
    const res1 = await req1;
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ ok: false, superseded: true });
    expect(mainSessions.get('deck_proj_brain')).toMatchObject({ requested_model: 'm-b', active_model: 'm-b' });
    expect(updates.filter((u) => u.table === 'sessions')).toHaveLength(1);

    // ── Sub-session: concurrent preset + explicit null PATCHes, Req 2 commits null FIRST, Req 1 superseded ──
    daemon.sent.length = 0;
    const subReq1 = app.request(`/api/server/${serverId}/sub-sessions/sub-race-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'claude-code-sdk', ccPresetId: 'PresetOld', requestedModel: 'm-old', activeModel: null }),
    });
    await flushAsync();
    const subReq2 = app.request(`/api/server/${serverId}/sub-sessions/sub-race-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'codex-sdk', ccPresetId: null, requestedModel: 'gpt-5', activeModel: null }),
    });
    await vi.waitFor(() => {
      expect(daemon.sentJson.filter((m) => m.type === 'subsession.restart')).toHaveLength(2);
    });
    const [s1, s2] = daemon.sentJson.filter((m) => m.type === 'subsession.restart');
    const subAppliedClear = {
      agentType: 'codex-sdk',
      ccPreset: null,
      requestedModel: 'gpt-5',
      activeModel: 'gpt-5',
      modelDisplay: 'gpt-5',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      cwd: '/proj',
      label: null,
      description: null,
      effort: null,
      transportConfig: null,
      runtimeEpoch: 'ep-sub-2',
    };
    const subAppliedOld = { ...subAppliedClear, agentType: 'claude-code-sdk', ccPreset: 'PresetOld', requestedModel: 'm-old', activeModel: 'm-old', runtimeEpoch: 'ep-sub-1' };

    daemon.emit('message', JSON.stringify({ type: 'subsession.restart_response', requestId: s2!.requestId, ok: true, applied: subAppliedClear }));
    expect(await (await subReq2).json()).toEqual({ ok: true, applied: subAppliedClear });

    daemon.emit('message', JSON.stringify({ type: 'subsession.restart_response', requestId: s1!.requestId, ok: true, applied: subAppliedOld }));
    expect(await (await subReq1).json()).toEqual({ ok: false, superseded: true });
    expect(subSessions.get('sub-race-1')).toMatchObject({ type: 'codex-sdk', cc_preset_id: null, requested_model: 'gpt-5', active_model: 'gpt-5' });
    expect(updates.filter((u) => u.table === 'sub_sessions')).toHaveLength(1);

    // ── Newer request rejected by preflight MUST NOT block an earlier valid request from committing ──
    daemon.sent.length = 0;
    const validReq = app.request(`/api/server/${serverId}/sub-sessions/sub-race-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'claude-code', ccPresetId: 'PresetKeep', requestedModel: 'm-keep', activeModel: null }),
    });
    await flushAsync();
    const rejectedReq = app.request(`/api/server/${serverId}/sub-sessions/sub-race-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'claude-code', ccPresetId: 'BadPreset', requestedModel: 'm %TEMP%', activeModel: null }),
    });
    await vi.waitFor(() => {
      expect(daemon.sentJson.filter((m) => m.type === 'subsession.restart')).toHaveLength(2);
    });
    const [sv, sr] = daemon.sentJson.filter((m) => m.type === 'subsession.restart');
    daemon.emit('message', JSON.stringify({ type: 'subsession.restart_response', requestId: sr!.requestId, ok: false, rejected: true, error: 'preflight_bad' }));
    const rejectedRes = await rejectedReq;
    expect(rejectedRes.status).toBe(422);

    const appliedKeep = { ...subAppliedOld, agentType: 'claude-code', ccPreset: 'PresetKeep', requestedModel: 'm-keep', activeModel: 'm-keep', runtimeEpoch: 'ep-sub-3' };
    daemon.emit('message', JSON.stringify({ type: 'subsession.restart_response', requestId: sv!.requestId, ok: true, applied: appliedKeep }));
    const validRes = await validReq;
    expect(validRes.status).toBe(200);
    expect(await validRes.json()).toEqual({ ok: true, applied: appliedKeep });
    expect(subSessions.get('sub-race-1')).toMatchObject({ type: 'claude-code', cc_preset_id: 'PresetKeep', requested_model: 'm-keep' });
  });
});
