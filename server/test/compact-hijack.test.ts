import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import {
  COMPACT_HIJACK_GLOBAL_PREF_KEY,
  COMPACT_HIJACK_MSG,
} from '../../shared/compact-hijack.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

const mockDb = {
  query: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  execute: vi.fn(async () => ({ changes: 1 })),
  exec: vi.fn(async () => {}),
  transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({})),
  close: vi.fn(),
};

const mockSetUserPref = vi.fn();
const mockDeleteUserPref = vi.fn();
const mockGetDbSessionByName = vi.fn();
const mockGetDbSessionsByServer = vi.fn(async () => []);
const mockGetSubSessionById = vi.fn();
const mockGetSubSessionsByServer = vi.fn(async () => []);
const mockUpdateSession = vi.fn();
const mockUpdateSubSession = vi.fn();
const mockResolveHttpShareAccess = vi.fn();
const mockResolveHttpShareAccessForCoveredSession = vi.fn();
const mockResolveServerMemberAccessOrShareDeny = vi.fn();
const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');

const authUser = { id: 'owner-user', role: 'owner' };

vi.mock('../src/security/authorization.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/security/authorization.js')>(),
  requireAuth: () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', authUser.id);
    c.set('role', authUser.role);
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/security/crypto.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/security/crypto.js')>(),
  sha256Hex: () => 'valid-hash',
  randomHex: () => 'sid-test',
}));

vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

vi.mock('../src/db/queries.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/db/queries.js')>(),
  getServerById: vi.fn(async () => ({ id: 'srv-1', user_id: 'owner-user', node_role: NODE_ROLE.FULL })),
  setUserPref: (...args: unknown[]) => mockSetUserPref(...args),
  deleteUserPref: (...args: unknown[]) => mockDeleteUserPref(...args),
  getDbSessionsByServer: (...args: unknown[]) => mockGetDbSessionsByServer(...args),
  getDbSessionByName: (...args: unknown[]) => mockGetDbSessionByName(...args),
  getSubSessionById: (...args: unknown[]) => mockGetSubSessionById(...args),
  getSubSessionsByServer: (...args: unknown[]) => mockGetSubSessionsByServer(...args),
  upsertDbSession: vi.fn(),
  deleteDbSession: vi.fn(),
  updateSessionLabel: vi.fn(),
  updateProjectName: vi.fn(),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  updateSubSession: (...args: unknown[]) => mockUpdateSubSession(...args),
  updateServerHeartbeat: vi.fn(async () => {}),
  getServerSharesByServer: vi.fn(async () => []),
}));

vi.mock('../src/routes/share-http-auth.js', () => ({
  resolveHttpShareAccess: (...args: unknown[]) => mockResolveHttpShareAccess(...args),
  resolveHttpShareAccessForCoveredSession: (...args: unknown[]) => mockResolveHttpShareAccessForCoveredSession(...args),
  resolveServerMemberAccessOrShareDeny: (...args: unknown[]) => mockResolveServerMemberAccessOrShareDeny(...args),
}));

import { WsBridge } from '../src/ws/bridge.js';
import { preferencesRoutes } from '../src/routes/preferences.js';
import { sessionMgmtRoutes } from '../src/routes/session-mgmt.js';
import { subSessionRoutes } from '../src/routes/sub-sessions.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(data);
    callback?.();
  }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((r) => process.nextTick(r));
}

function buildApp() {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = { DB: mockDb };
    await next();
  });
  app.route('/api/preferences', preferencesRoutes);
  app.route('/api/server', sessionMgmtRoutes);
  app.route('/api/server', subSessionRoutes);
  return app;
}

describe('Compact Hijack server routes & owner-only WS daemon push', () => {
  beforeEach(() => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
    authUser.id = 'owner-user';
    authUser.role = 'owner';
    mockResolveServerRole.mockResolvedValue('owner');
    const ownerAccess = {
      ok: true,
      allowed: true,
      actor: { kind: 'member', role: 'owner', userId: 'owner-user' },
    };
    mockResolveHttpShareAccess.mockResolvedValue(ownerAccess);
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue(ownerAccess);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockGetDbSessionByName.mockResolvedValue({
      id: 'sess-1',
      name: 'deck_proj_brain',
      role: 'brain',
      transport_config: JSON.stringify({ compactHijack: 'on', uiLocale: 'zh-CN' }),
    });
    mockGetSubSessionById.mockResolvedValue({
      id: 'sub1',
      server_id: 'srv-1',
      transport_config: JSON.stringify({ compactHijack: 'on', uiLocale: 'en' }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    WsBridge.getAll().clear();
  });

  it('pushes compact_hijack.apply ONLY to authenticated Full Daemons owned by user (never controlled or other users)', async () => {
    const ownedFullBridge = WsBridge.get('srv-owned-full');
    const ownedFullWs = new MockWs();
    const controlledBridge = WsBridge.get('srv-owned-ctrl');
    const controlledWs = new MockWs();
    const otherUserBridge = WsBridge.get('srv-other-full');
    const otherUserWs = new MockWs();

    const dbByServer = (serverId: string) => ({
      ...mockDb,
      queryOne: async (sql: string) => {
        if (sql.includes('FROM servers')) {
          if (serverId === 'srv-owned-full') return { token_hash: 'valid-hash', owner_status: 'active', user_id: 'owner-user', node_role: NODE_ROLE.FULL };
          if (serverId === 'srv-owned-ctrl') return { token_hash: 'valid-hash', owner_status: 'active', user_id: 'owner-user', node_role: NODE_ROLE.CONTROLLED };
          return { token_hash: 'valid-hash', owner_status: 'active', user_id: 'other-user', node_role: NODE_ROLE.FULL };
        }
        if (sql.includes('FROM user_preferences')) {
          return { value: JSON.stringify({ enabled: true }) };
        }
        return null;
      },
    }) as unknown as import('../src/db/client.js').Database;

    ownedFullBridge.handleDaemonConnection(ownedFullWs as never, dbByServer('srv-owned-full'), {} as never);
    ownedFullWs.emit('message', JSON.stringify({ type: 'auth', serverId: 'srv-owned-full', token: 'tok', nodeRole: NODE_ROLE.FULL }));

    controlledBridge.handleDaemonConnection(controlledWs as never, dbByServer('srv-owned-ctrl'), {} as never);
    controlledWs.emit('message', JSON.stringify({ type: 'auth', serverId: 'srv-owned-ctrl', token: 'tok', nodeRole: NODE_ROLE.CONTROLLED }));

    otherUserBridge.handleDaemonConnection(otherUserWs as never, dbByServer('srv-other-full'), {} as never);
    otherUserWs.emit('message', JSON.stringify({ type: 'auth', serverId: 'srv-other-full', token: 'tok', nodeRole: NODE_ROLE.FULL }));

    await flush();

    // On auth connect: owned Full Daemon gets compact_hijack.apply, controlled does NOT
    expect(ownedFullWs.sentJson().some((m) => m.type === COMPACT_HIJACK_MSG.APPLY && m.enabled === true)).toBe(true);
    expect(controlledWs.sentJson().some((m) => m.type === COMPACT_HIJACK_MSG.APPLY)).toBe(false);

    ownedFullWs.sent.length = 0;
    controlledWs.sent.length = 0;
    otherUserWs.sent.length = 0;

    // Via PUT /api/preferences/compact_hijack.global.v1
    const app = buildApp();
    const res = await app.request(`/api/preferences/${COMPACT_HIJACK_GLOBAL_PREF_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { enabled: false } }),
    });
    expect(res.status).toBe(200);
    expect(mockSetUserPref).toHaveBeenCalledWith(mockDb, 'owner-user', COMPACT_HIJACK_GLOBAL_PREF_KEY, JSON.stringify({ enabled: false }));
    expect(ownedFullWs.sentJson().some((m) => m.type === COMPACT_HIJACK_MSG.APPLY && m.enabled === false)).toBe(true);
    expect(controlledWs.sentJson().some((m) => m.type === COMPACT_HIJACK_MSG.APPLY)).toBe(false);
    expect(otherUserWs.sentJson().some((m) => m.type === COMPACT_HIJACK_MSG.APPLY)).toBe(false);

    // Invalid payload -> 400
    const badRes = await app.request(`/api/preferences/${COMPACT_HIJACK_GLOBAL_PREF_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { enabled: 'not-bool' } }),
    });
    expect(badRes.status).toBe(400);

    // DELETE resets to disabled & pushes false to owned Full Daemons
    ownedFullWs.sent.length = 0;
    const delRes = await app.request(`/api/preferences/${COMPACT_HIJACK_GLOBAL_PREF_KEY}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(ownedFullWs.sentJson().some((m) => m.type === COMPACT_HIJACK_MSG.APPLY && m.enabled === false)).toBe(true);
  });

  it('rejects share participants modifying compactHijack with 403 and preserves owner compactHijack on whole-server share updates', async () => {
    const app = buildApp();
    const serverShareAccess = {
      ok: true,
      allowed: true,
      shareProvenance: 'server',
      actor: {
        kind: 'share',
        role: 'participant',
        effectiveActorRole: 'participant',
        shareId: 'sh-1',
        grantKind: 'server',
        userId: 'guest-user',
        coverage: {
          grantIds: ['sh-1'],
          effectiveRole: 'participant',
          actorUserId: 'guest-user',
          target: { kind: 'server', serverId: 'srv-1' },
        },
      },
    };
    mockResolveHttpShareAccess.mockResolvedValue(serverShareAccess);
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue(serverShareAccess);

    // Share participant explicitly supplying compactHijack -> 403
    const forbiddenRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transportConfig: { compactHijack: 'off', uiLocale: 'en' } }),
    });
    expect(forbiddenRes.status).toBe(403);
    expect(mockUpdateSession).not.toHaveBeenCalled();

    // Whole-server share participant updating non-compactHijack transportConfig -> 200, preserves owner's compactHijack: 'on'
    const preserveRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transportConfig: { uiLocale: 'en' } }),
    });
    expect(preserveRes.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledWith(
      mockDb,
      'srv-1',
      'deck_proj_brain',
      expect.objectContaining({
        transport_config: { uiLocale: 'en', compactHijack: 'on' },
      }),
    );

    // Owner setting invalid compactHijack -> 400
    const ownerAccess = {
      ok: true,
      allowed: true,
      actor: { kind: 'member', role: 'owner', userId: 'owner-user' },
    };
    mockResolveHttpShareAccess.mockResolvedValue(ownerAccess);
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue(ownerAccess);
    const invalidRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transportConfig: { compactHijack: 'bogus' } }),
    });
    expect(invalidRes.status).toBe(400);

    // Owner setting inherit canonicalizes compactHijack out of transportConfig
    const inheritRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transportConfig: { compactHijack: 'inherit', uiLocale: 'zh-CN' } }),
    });
    expect(inheritRes.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenLastCalledWith(
      mockDb,
      'srv-1',
      'deck_proj_brain',
      expect.objectContaining({
        transport_config: { uiLocale: 'zh-CN' },
      }),
    );
  });

  it('strips compactHijack from share sub-session listings and rejects share setting it on POST', async () => {
    const app = buildApp();
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      ok: true,
      allowed: true,
      actor: { kind: 'share', role: 'participant', shareId: 'sh-1', grantKind: 'server', userId: 'guest-user' },
    });
    mockGetSubSessionsByServer.mockResolvedValue([
      { id: 'sub1', server_id: 'srv-1', transport_config: JSON.stringify({ compactHijack: 'on', uiLocale: 'en' }) },
    ] as never);

    const listRes = await app.request('/api/server/srv-1/sub-sessions');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { subSessions: Array<{ transport_config?: string | null }> };
    expect(JSON.parse(listBody.subSessions[0].transport_config ?? '{}')).toEqual({ uiLocale: 'en' });

    const postRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'claude-code-sdk',
        cwd: '/tmp/proj',
        transport_config: { compactHijack: 'on' },
      }),
    });
    expect(postRes.status).toBe(403);
  });

  it('strips compactHijack from GET /sessions, /session-snapshot, and whole-server share GET /sub-sessions while keeping owner rows intact', async () => {
    const app = buildApp();
    const sessionRow = {
      id: 'sess-1',
      server_id: 'srv-1',
      name: 'deck_proj_brain',
      project_name: 'proj',
      role: 'brain',
      agent_type: 'claude-code-sdk',
      project_dir: '/tmp/proj',
      state: 'idle',
      transport_config: JSON.stringify({ compactHijack: 'on', uiLocale: 'zh-CN' }),
    };
    const subRow = {
      id: 'sub1',
      server_id: 'srv-1',
      type: 'claude-code-sdk',
      cwd: '/tmp/proj',
      parent_session: 'deck_proj_brain',
      transport_config: JSON.stringify({ compactHijack: 'off', uiLocale: 'en' }),
    };
    mockGetDbSessionsByServer.mockResolvedValue([sessionRow] as never);
    mockGetSubSessionsByServer.mockResolvedValue([subRow] as never);

    // Whole-server share participant: resolveServerMemberAccessOrShareDeny maps them to role='owner',
    // while resolveHttpShareAccess preserves actor.kind === 'share'.
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccess.mockResolvedValue({
      ok: true,
      allowed: true,
      shareProvenance: 'server',
      actor: { kind: 'share', role: 'participant', shareId: 'sh-1', grantKind: 'server', userId: 'guest-user' },
    });

    const shareSessRes = await app.request('/api/server/srv-1/sessions');
    expect(shareSessRes.status).toBe(200);
    const shareSessBody = await shareSessRes.json() as { sessions: Array<{ transport_config?: string | null }> };
    expect(JSON.parse(shareSessBody.sessions[0].transport_config ?? '{}')).toEqual({ uiLocale: 'zh-CN' });

    const shareSnapRes = await app.request('/api/server/srv-1/session-snapshot');
    expect(shareSnapRes.status).toBe(200);
    const shareSnapBody = await shareSnapRes.json() as {
      sessions: Array<{ transport_config?: Record<string, unknown> | null }>;
      subSessions: Array<{ transport_config?: Record<string, unknown> | null }>;
    };
    expect(shareSnapBody.sessions[0].transport_config).toEqual({ uiLocale: 'zh-CN' });
    expect(shareSnapBody.subSessions[0].transport_config).toEqual({ uiLocale: 'en' });

    const shareSubRes = await app.request('/api/server/srv-1/sub-sessions');
    expect(shareSubRes.status).toBe(200);
    const shareSubBody = await shareSubRes.json() as { subSessions: Array<{ transport_config?: string | null }> };
    expect(JSON.parse(shareSubBody.subSessions[0].transport_config ?? '{}')).toEqual({ uiLocale: 'en' });

    // Real owner preserves compactHijack on all three endpoints
    mockResolveHttpShareAccess.mockResolvedValue({
      ok: true,
      allowed: true,
      shareProvenance: null,
      actor: { kind: 'server-member', effectiveActorRole: 'server-manager', role: 'owner', userId: 'owner-user' },
    });

    const ownerSessRes = await app.request('/api/server/srv-1/sessions');
    expect(ownerSessRes.status).toBe(200);
    const ownerSessBody = await ownerSessRes.json() as { sessions: Array<{ transport_config?: string | null }> };
    expect(JSON.parse(ownerSessBody.sessions[0].transport_config ?? '{}')).toEqual({ compactHijack: 'on', uiLocale: 'zh-CN' });

    const ownerSnapRes = await app.request('/api/server/srv-1/session-snapshot');
    expect(ownerSnapRes.status).toBe(200);
    const ownerSnapBody = await ownerSnapRes.json() as {
      sessions: Array<{ transport_config?: Record<string, unknown> | null }>;
      subSessions: Array<{ transport_config?: Record<string, unknown> | null }>;
    };
    expect(ownerSnapBody.sessions[0].transport_config).toEqual({ compactHijack: 'on', uiLocale: 'zh-CN' });
    expect(ownerSnapBody.subSessions[0].transport_config).toEqual({ compactHijack: 'off', uiLocale: 'en' });
  });

  it('validates, pushes, and share-sanitizes global & session Handoff limit overrides', async () => {
    const ownedFullBridge = WsBridge.get('srv-handoff-full');
    const ownedFullWs = new MockWs();
    const db = {
      ...mockDb,
      queryOne: async (sql: string) => {
        if (sql.includes('FROM servers')) {
          return { token_hash: 'valid-hash', owner_status: 'active', user_id: 'owner-user', node_role: NODE_ROLE.FULL };
        }
        if (sql.includes('FROM user_preferences')) {
          return { value: JSON.stringify({ enabled: true, handoffTextLimit: 60, handoffSummaryLimit: 8, handoffMaxChars: 90_000 }) };
        }
        return null;
      },
    } as unknown as import('../src/db/client.js').Database;

    ownedFullBridge.handleDaemonConnection(ownedFullWs as never, db, {} as never);
    ownedFullWs.emit('message', JSON.stringify({ type: 'auth', serverId: 'srv-handoff-full', token: 'tok', nodeRole: NODE_ROLE.FULL }));
    await flush();
    expect(ownedFullWs.sentJson().some((m) =>
      m.type === COMPACT_HIJACK_MSG.APPLY
      && m.enabled === true
      && m.handoffTextLimit === 60
      && m.handoffSummaryLimit === 8
      && m.handoffMaxChars === 90_000,
    )).toBe(true);

    ownedFullWs.sent.length = 0;
    const app = buildApp();
    const putOk = await app.request(`/api/preferences/${COMPACT_HIJACK_GLOBAL_PREF_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { enabled: true, handoffTextLimit: 0, handoffSummaryLimit: 12, handoffMaxChars: 200_000 } }),
    });
    expect(putOk.status).toBe(200);
    expect(ownedFullWs.sentJson().some((m) =>
      m.type === COMPACT_HIJACK_MSG.APPLY
      && m.handoffTextLimit === 0
      && m.handoffSummaryLimit === 12
      && m.handoffMaxChars === 200_000,
    )).toBe(true);

    const putBad = await app.request(`/api/preferences/${COMPACT_HIJACK_GLOBAL_PREF_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { enabled: true, handoffMaxChars: 100 } }),
    });
    expect(putBad.status).toBe(400);

    // Session PATCH rejects invalid Handoff limits
    const badPatch = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transportConfig: { handoffTextLimit: 201 } }),
    });
    expect(badPatch.status).toBe(400);

    // Share responses strip handoff limit fields while owner keeps them
    mockGetDbSessionsByServer.mockResolvedValue([{
      id: 'sess-1',
      name: 'deck_proj_brain',
      role: 'brain',
      transport_config: JSON.stringify({
        compactHijack: 'on',
        handoffTextLimit: 50,
        handoffSummaryLimit: 5,
        handoffMaxChars: 40_000,
        uiLocale: 'en',
      }),
    }] as never);
    mockResolveHttpShareAccess.mockResolvedValue({
      ok: true,
      allowed: true,
      shareProvenance: 'server',
      actor: { kind: 'share', role: 'participant', shareId: 'sh-1', grantKind: 'server', userId: 'guest-user' },
    });
    const shareRes = await app.request('/api/server/srv-1/sessions');
    expect(shareRes.status).toBe(200);
    const shareBody = await shareRes.json() as { sessions: Array<{ transport_config?: string | null }> };
    expect(JSON.parse(shareBody.sessions[0].transport_config ?? '{}')).toEqual({ uiLocale: 'en' });
  });
});
