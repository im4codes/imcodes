import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';
import { MEMORY_WS } from '../../shared/memory-ws.js';
import { MEMORY_MANAGEMENT_CONTEXT_FIELD } from '../../shared/memory-management-context.js';
import {
  MEMORY_FEATURE_CONFIG_MSG,
  MEMORY_FEATURE_CONFIG_PREF_KEY,
  MEMORY_FEATURE_FLAGS_BY_NAME,
} from '../../shared/feature-flags.js';

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
    return this.sent.filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

function makeDb(queryOne?: (sql: string, params?: unknown[]) => Promise<unknown>) {
  return {
    queryOne: queryOne ?? (async () => ({ token_hash: 'valid-hash' })),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

vi.mock('../src/security/crypto.js', () => ({ sha256Hex: () => 'valid-hash' }));
vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => process.nextTick(resolve));
}

async function setup(db = makeDb()) {
  const serverId = `memory-management-${Math.random().toString(36).slice(2)}`;
  const bridge = WsBridge.get(serverId);
  const daemon = new MockWs();
  bridge.handleDaemonConnection(daemon as never, db, {} as never);
  daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'token' }));
  await flush();
  const browserA = new MockWs();
  const browserB = new MockWs();
  bridge.handleBrowserConnection(browserA as never, 'user-a', db);
  bridge.handleBrowserConnection(browserB as never, 'user-b', db);
  return { bridge, daemon, browserA, browserB };
}

describe('WsBridge memory management routing', () => {
  beforeEach(() => { WsBridge.getAll().clear(); });
  afterEach(() => { WsBridge.getAll().clear(); vi.clearAllMocks(); });

  it('single-casts memory management responses to the requesting browser only', async () => {
    const { daemon, browserA, browserB } = await setup();
    browserA.emit('message', JSON.stringify({ type: MEMORY_WS.SKILL_READ, requestId: 'req-skill', key: 'k', layer: 'user_default' }));
    await flush();

    daemon.emit('message', JSON.stringify({ type: MEMORY_WS.SKILL_READ_RESPONSE, requestId: 'req-skill', success: true, key: 'k', layer: 'user_default', content: 'secret skill' }));
    await flush();

    expect(browserA.sentJson().some((msg) => msg.type === MEMORY_WS.SKILL_READ_RESPONSE && msg.content === 'secret skill')).toBe(true);
    expect(browserB.sentJson().some((msg) => msg.type === MEMORY_WS.SKILL_READ_RESPONSE)).toBe(false);
  });

  it('injects server-derived memory management context and does not trust browser actorId', async () => {
    const { daemon, browserA } = await setup();
    browserA.emit('message', JSON.stringify({ type: MEMORY_WS.OBSERVATION_PROMOTE, requestId: 'req-promote', id: 'obs-1', actorId: 'attacker', toScope: 'project_shared' }));
    await flush();

    const forwarded = daemon.sentJson().find((msg) => msg.type === MEMORY_WS.OBSERVATION_PROMOTE) as Record<string, unknown> | undefined;
    expect(forwarded).toBeTruthy();
    const ctx = forwarded?.[MEMORY_MANAGEMENT_CONTEXT_FIELD] as Record<string, unknown> | undefined;
    expect(ctx?.actorId).toBe('user-a');
    expect(ctx?.userId).toBe('user-a');
    expect(ctx?.role).toBe('user');
    expect(forwarded?.actorId).toBe('attacker');
  });

  it('derives elevated memory management role from server membership instead of browser input', async () => {
    const db = makeDb(async (sql: string, params?: unknown[]) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash' };
      if (sql.includes('FROM team_members') && params?.[0] === 'team-1' && params?.[1] === 'user-a') {
        return { role: 'admin' };
      }
      return null;
    });
    const { daemon, browserA } = await setup(db);
    browserA.emit('message', JSON.stringify({
      type: MEMORY_WS.OBSERVATION_PROMOTE,
      requestId: 'req-promote-admin',
      id: 'obs-1',
      role: 'user',
      enterpriseId: 'team-1',
      toScope: 'org_shared',
    }));
    await flush();

    const forwarded = daemon.sentJson().find((msg) => msg.type === MEMORY_WS.OBSERVATION_PROMOTE) as Record<string, unknown> | undefined;
    const ctx = forwarded?.[MEMORY_MANAGEMENT_CONTEXT_FIELD] as Record<string, unknown> | undefined;
    expect(ctx?.actorId).toBe('user-a');
    expect(ctx?.role).toBe('org_admin');
    expect(forwarded?.role).toBe('user');
  });


  it('rejects unauthenticated memory management requests before forwarding to daemon', async () => {
    const serverId = `memory-management-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    const db = makeDb();
    bridge.handleDaemonConnection(daemon as never, db, {} as never);
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'token' }));
    await flush();
    const browser = new MockWs();
    bridge.handleBrowserConnection(browser as never, '', db);

    browser.emit('message', JSON.stringify({ type: MEMORY_WS.SKILL_QUERY, requestId: 'unauth-1' }));
    await flush();

    expect(daemon.sentJson().some((msg) => msg.type === MEMORY_WS.SKILL_QUERY)).toBe(false);
    expect(browser.sentJson().some((msg) => msg.code === 'memory_management_unauthenticated')).toBe(true);
  });

  it('rejects duplicate memory management request ids without forwarding the duplicate', async () => {
    const { daemon, browserA } = await setup();
    browserA.emit('message', JSON.stringify({ type: MEMORY_WS.SKILL_QUERY, requestId: 'dup-1' }));
    browserA.emit('message', JSON.stringify({ type: MEMORY_WS.PREF_QUERY, requestId: 'dup-1' }));
    await flush();

    expect(daemon.sentJson().filter((msg) => msg.requestId === 'dup-1')).toHaveLength(1);
    expect(browserA.sentJson().some((msg) => msg.code === 'duplicate_request_id')).toBe(true);
  });

  it('serves memory feature state from the user-global online preference store instead of daemon-local state', async () => {
    const db = makeDb(async (sql: string, params?: unknown[]) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash', user_id: 'user-a' };
      if (sql.includes('FROM user_preferences')) {
        expect(params).toEqual(['user-a', MEMORY_FEATURE_CONFIG_PREF_KEY]);
        return {
          value: JSON.stringify({
            [MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry]: true,
            [MEMORY_FEATURE_FLAGS_BY_NAME.observationStore]: true,
            [MEMORY_FEATURE_FLAGS_BY_NAME.preferences]: true,
          }),
        };
      }
      return null;
    });
    const { daemon, browserA } = await setup(db);
    daemon.sent = [];

    browserA.emit('message', JSON.stringify({ type: MEMORY_WS.FEATURES_QUERY, requestId: 'features-global' }));
    await flush();

    expect(daemon.sentJson().some((msg) => msg.type === MEMORY_WS.FEATURES_QUERY)).toBe(false);
    const response = browserA.sentJson().find((msg) => msg.type === MEMORY_WS.FEATURES_RESPONSE && msg.requestId === 'features-global');
    expect(response).toBeTruthy();
    const records = response?.records as Array<Record<string, unknown>>;
    expect(records.find((record) => record.flag === MEMORY_FEATURE_FLAGS_BY_NAME.preferences)).toMatchObject({
      requested: true,
      enabled: true,
      source: 'persisted_config',
    });
  });

  it('persists memory feature toggles globally and applies them to every online daemon owned by the user', async () => {
    const writes: Array<{ userId: string; key: string; value: string }> = [];
    const db = makeDb(async (sql: string) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash', user_id: 'user-a' };
      if (sql.includes('SELECT user_id FROM servers WHERE id = $1')) return { user_id: 'user-a' };
      if (sql.includes('FROM user_preferences')) return { value: '{}' };
      return null;
    });
    const executeDb = db as unknown as { execute: (sql: string, params?: unknown[]) => Promise<{ changes: number }> };
    executeDb.execute = async (_sql: string, params?: unknown[]) => {
      writes.push({ userId: String(params?.[0]), key: String(params?.[1]), value: String(params?.[2]) });
      return { changes: 1 };
    };
    const first = await setup(db);
    const second = await setup(db);
    first.daemon.sent = [];
    second.daemon.sent = [];

    first.browserA.emit('message', JSON.stringify({
      type: MEMORY_WS.FEATURES_SET,
      requestId: 'features-set-global',
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
      enabled: true,
    }));
    await flush();

    const featureWrites = writes.filter((write) => write.key === MEMORY_FEATURE_CONFIG_PREF_KEY);
    expect(featureWrites).toHaveLength(1);
    const persisted = JSON.parse(featureWrites[0]?.value ?? '{}') as Record<string, unknown>;
    expect(persisted[MEMORY_FEATURE_FLAGS_BY_NAME.preferences]).toBe(true);
    expect(persisted[MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry]).toBe(true);
    expect(persisted[MEMORY_FEATURE_FLAGS_BY_NAME.observationStore]).toBe(true);
    expect(first.daemon.sentJson().some((msg) => msg.type === MEMORY_WS.FEATURES_SET)).toBe(false);
    const firstApply = first.daemon.sentJson().find((msg) => msg.type === MEMORY_FEATURE_CONFIG_MSG.APPLY);
    const secondApply = second.daemon.sentJson().find((msg) => msg.type === MEMORY_FEATURE_CONFIG_MSG.APPLY);
    expect(firstApply?.flags).toMatchObject({ [MEMORY_FEATURE_FLAGS_BY_NAME.preferences]: true });
    expect(secondApply?.flags).toMatchObject({ [MEMORY_FEATURE_FLAGS_BY_NAME.preferences]: true });
    expect(first.browserA.sentJson().find((msg) => msg.type === MEMORY_WS.FEATURES_SET_RESPONSE)).toMatchObject({
      requestId: 'features-set-global',
      success: true,
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
      enabled: true,
    });
  });

  it('does not apply a user-global memory feature toggle to daemons owned by other users', async () => {
    const makeOwnerDb = (ownerUserId: string) => makeDb(async (sql: string) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash', user_id: ownerUserId };
      if (sql.includes('SELECT user_id FROM servers WHERE id = $1')) return { user_id: ownerUserId };
      if (sql.includes('FROM user_preferences')) return { value: '{}' };
      return null;
    });
    const owner = await setup(makeOwnerDb('user-a'));
    const other = await setup(makeOwnerDb('user-b'));
    owner.daemon.sent = [];
    other.daemon.sent = [];

    owner.browserA.emit('message', JSON.stringify({
      type: MEMORY_WS.FEATURES_SET,
      requestId: 'features-set-owner-only',
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
      enabled: true,
    }));
    await flush();

    expect(owner.daemon.sentJson().some((msg) => msg.type === MEMORY_FEATURE_CONFIG_MSG.APPLY)).toBe(true);
    expect(other.daemon.sentJson().some((msg) => msg.type === MEMORY_FEATURE_CONFIG_MSG.APPLY)).toBe(false);
  });

  it('enforces the per-socket pending memory management request limit', async () => {
    const { daemon, browserA } = await setup();
    for (let i = 0; i < 33; i += 1) {
      browserA.emit('message', JSON.stringify({ type: MEMORY_WS.PREF_QUERY, requestId: `pending-${i}` }));
    }
    await flush();

    expect(daemon.sentJson().filter((msg) => msg.type === MEMORY_WS.PREF_QUERY)).toHaveLength(32);
    expect(browserA.sentJson().some((msg) => msg.code === 'too_many_memory_management_requests')).toBe(true);
  });

  it('strips browser-supplied management context fields before forwarding', async () => {
    const { daemon, browserA } = await setup();
    browserA.emit('message', JSON.stringify({
      type: MEMORY_WS.SKILL_QUERY,
      requestId: 'strip-1',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: { actorId: 'evil', userId: 'evil', role: 'org_admin', source: 'server_bridge' },
      managementContext: { actorId: 'evil', userId: 'evil', role: 'org_admin', source: 'server_bridge' },
    }));
    await flush();

    const forwarded = daemon.sentJson().find((msg) => msg.type === MEMORY_WS.SKILL_QUERY) as Record<string, unknown> | undefined;
    expect(forwarded).toBeTruthy();
    expect(forwarded?.managementContext).toBeUndefined();
    const ctx = forwarded?.[MEMORY_MANAGEMENT_CONTEXT_FIELD] as Record<string, unknown> | undefined;
    expect(ctx?.actorId).toBe('user-a');
    expect(ctx?.role).toBe('user');
  });

  it('does not treat generic projectId as canonicalRepoId for role derivation', async () => {
    const db = makeDb(async (sql: string, params?: unknown[]) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash' };
      if (sql.includes('shared_project_enrollments') && params?.[0] === 'repo-x') return { role: 'admin' };
      return null;
    });
    const { daemon, browserA } = await setup(db);
    browserA.emit('message', JSON.stringify({ type: MEMORY_WS.SKILL_QUERY, requestId: 'alias-1', projectId: 'repo-x' }));
    await flush();

    const forwarded = daemon.sentJson().find((msg) => msg.type === MEMORY_WS.SKILL_QUERY) as Record<string, unknown> | undefined;
    const ctx = forwarded?.[MEMORY_MANAGEMENT_CONTEXT_FIELD] as Record<string, unknown> | undefined;
    expect(ctx?.role).toBe('user');
    expect((ctx?.boundProjects as Array<Record<string, unknown>> | undefined)?.[0]?.canonicalRepoId).toBeUndefined();
  });

  it('does not forward unverified canonical project hints as authorized bindings', async () => {
    const db = makeDb(async (sql: string) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash' };
      return null;
    });
    const { daemon, browserA } = await setup(db);
    browserA.emit('message', JSON.stringify({
      type: MEMORY_WS.SEARCH,
      requestId: 'unauthorized-project',
      canonicalRepoId: 'github.com/acme/private',
      projectDir: '/tmp/acme-private',
      repo: 'github.com/acme/private',
    }));
    await flush();

    const forwarded = daemon.sentJson().find((msg) => msg.type === MEMORY_WS.SEARCH) as Record<string, unknown> | undefined;
    const ctx = forwarded?.[MEMORY_MANAGEMENT_CONTEXT_FIELD] as Record<string, unknown> | undefined;
    expect(ctx?.role).toBe('user');
    expect(ctx?.boundProjects).toEqual([]);
  });

  it('binds canonical memory requests to local visible project directories for daemon-side identity verification', async () => {
    const db = makeDb(async (sql: string, params?: unknown[]) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash' };
      if (sql.includes('shared_project_enrollments')) return null;
      if (sql.includes('FROM sessions') && params?.[1] === '/work/repo') {
        return { name: 'deck_repo_brain' };
      }
      return null;
    });
    const { daemon, browserA } = await setup(db);
    browserA.emit('message', JSON.stringify({
      type: MEMORY_WS.CREATE,
      requestId: 'local-project-create',
      canonicalRepoId: 'github.com/acme/repo',
      projectDir: '/work/repo',
      text: 'Remember the local project decision.',
    }));
    await flush();

    const forwarded = daemon.sentJson().find((msg) => msg.type === MEMORY_WS.CREATE) as Record<string, unknown> | undefined;
    const ctx = forwarded?.[MEMORY_MANAGEMENT_CONTEXT_FIELD] as Record<string, unknown> | undefined;
    expect(ctx?.role).toBe('user');
    expect(ctx?.boundProjects).toEqual([{
      canonicalRepoId: 'github.com/acme/repo',
      projectDir: '/work/repo',
    }]);
  });

  it('forwards active enrolled canonical projects with server-derived workspace/org bindings', async () => {
    const db = makeDb(async (sql: string, params?: unknown[]) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash' };
      if (sql.includes('shared_project_enrollments') && params?.[0] === 'github.com/acme/repo' && params?.[1] === 'user-a') {
        return { role: 'member', workspace_id: 'workspace-1', enterprise_id: 'team-1' };
      }
      return null;
    });
    const { daemon, browserA } = await setup(db);
    browserA.emit('message', JSON.stringify({
      type: MEMORY_WS.SEARCH,
      requestId: 'authorized-project',
      canonicalRepoId: 'github.com/acme/repo',
      projectDir: '/work/repo',
      repo: 'github.com/acme/repo',
    }));
    await flush();

    const forwarded = daemon.sentJson().find((msg) => msg.type === MEMORY_WS.SEARCH) as Record<string, unknown> | undefined;
    const ctx = forwarded?.[MEMORY_MANAGEMENT_CONTEXT_FIELD] as Record<string, unknown> | undefined;
    expect(ctx?.role).toBe('user');
    expect(ctx?.boundProjects).toEqual([{
      canonicalRepoId: 'github.com/acme/repo',
      projectDir: '/work/repo',
      workspaceId: 'workspace-1',
      orgId: 'team-1',
    }]);
  });

  it('cleans up and single-casts an error if management context construction fails', async () => {
    const { bridge, daemon, browserA, browserB } = await setup();
    vi.spyOn(bridge as unknown as { withMemoryManagementContext: (...args: unknown[]) => Promise<Record<string, unknown>> }, 'withMemoryManagementContext')
      .mockRejectedValueOnce(new Error('context unavailable'));

    browserA.emit('message', JSON.stringify({ type: MEMORY_WS.SKILL_QUERY, requestId: 'ctx-fail-1', canonicalRepoId: 'github.com/acme/repo' }));
    await flush();

    expect(daemon.sentJson().some((msg) => msg.requestId === 'ctx-fail-1')).toBe(false);
    expect(browserA.sentJson().some((msg) => (
      msg.type === 'error'
      && msg.code === 'context_injection_failed'
      && msg.requestId === 'ctx-fail-1'
      && msg.originalType === MEMORY_WS.SKILL_QUERY
    ))).toBe(true);
    expect(browserB.sentJson().some((msg) => msg.requestId === 'ctx-fail-1')).toBe(false);

    browserA.emit('message', JSON.stringify({ type: MEMORY_WS.PREF_QUERY, requestId: 'ctx-fail-1' }));
    await flush();
    expect(daemon.sentJson().some((msg) => msg.type === MEMORY_WS.PREF_QUERY && msg.requestId === 'ctx-fail-1')).toBe(true);
  });

  it('drops unrouted memory management responses instead of broadcasting them', async () => {
    const { daemon, browserA, browserB } = await setup();
    daemon.emit('message', JSON.stringify({ type: MEMORY_WS.PREF_RESPONSE, requestId: 'missing', records: [{ text: 'secret' }] }));
    await flush();

    expect(browserA.sentJson().some((msg) => msg.type === MEMORY_WS.PREF_RESPONSE)).toBe(false);
    expect(browserB.sentJson().some((msg) => msg.type === MEMORY_WS.PREF_RESPONSE)).toBe(false);
  });
});
