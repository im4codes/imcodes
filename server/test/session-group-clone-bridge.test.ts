import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsBridge } from '../src/ws/bridge.js';
import { P2P_CONFIG_MSG } from '../../shared/p2p-config-events.js';
import { p2pSessionConfigPrefKey } from '../../shared/p2p-config-scope.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import {
  SESSION_GROUP_CLONE_CAPABILITY_V1,
  SESSION_GROUP_CLONE_MSG,
} from '../../shared/session-group-clone.js';

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('closed');
      if (callback) {
        callback(err);
        return;
      }
      throw err;
    }
    this.sent.push(data);
    callback?.();
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  clearSent() {
    this.sent = [];
  }
}

function makeDb(options: {
  ownerUserId?: string;
  teamId?: string | null;
  teamRole?: string | null;
  dbSessionNames?: string[];
  skippedCronJobs?: number;
  skippedOrchestrationRuns?: number;
  failUserPreferenceWrites?: boolean;
} = {}) {
  const ownerUserId = options.ownerUserId ?? 'user-owner';
  const teamId = options.teamId ?? null;
  const auditRows: unknown[][] = [];
  const userPrefs = new Map<string, string>();
  const dbSessionNames = new Set(options.dbSessionNames ?? []);
  const prefKey = (userId: unknown, key: unknown) => `${String(userId)}:${String(key)}`;
  const db = {
    queryOne: async (sql: string, params?: unknown[]) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash', user_id: ownerUserId };
      if (sql.includes('SELECT team_id, user_id FROM servers')) return { team_id: teamId, user_id: ownerUserId };
      if (sql.includes('FROM team_members') && params?.[0] === teamId && options.teamRole) {
        return { role: options.teamRole };
      }
      if (sql.includes('FROM user_preferences') && params) {
        const value = userPrefs.get(prefKey(params[0], params[1]));
        return value === undefined ? null : { value };
      }
      if (sql.includes('FROM sessions') && params && dbSessionNames.has(String(params[1]))) return { exists: 1 };
      if (sql.includes('FROM cron_jobs')) return { count: options.skippedCronJobs ?? 0 };
      if (sql.includes('FROM discussion_orchestration_runs')) return { count: options.skippedOrchestrationRuns ?? 0 };
      return null;
    },
    query: async (sql: string) => {
      if (sql.includes('FROM sessions')) {
        return [...dbSessionNames].map((name) => ({ name }));
      }
      return [];
    },
    execute: async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO audit_log') && params) auditRows.push(params);
      if (sql.includes('user_preferences') && params) {
        if (sql.startsWith('DELETE')) {
          userPrefs.delete(prefKey(params[0], params[1]));
        } else {
          if (options.failUserPreferenceWrites) throw new Error('user preference write failed');
          userPrefs.set(prefKey(params[0], params[1]), String(params[2]));
        }
      }
      return { changes: 1 };
    },
    exec: async () => {},
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
  return { db, auditRows, userPrefs };
}

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: () => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => process.nextTick(resolve));
}

async function setup(
  capabilities: string[] = [SESSION_GROUP_CLONE_CAPABILITY_V1],
  dbOptions: Parameters<typeof makeDb>[0] = {},
) {
  const serverId = `clone-bridge-${Math.random().toString(36).slice(2)}`;
  const { db, auditRows, userPrefs } = makeDb({ ownerUserId: 'user-owner', ...dbOptions });
  const bridge = WsBridge.get(serverId);
  const daemon = new MockWs();
  bridge.handleDaemonConnection(daemon as never, db, {} as never);
  daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'token' }));
  await flush();
  daemon.emit('message', JSON.stringify({
    type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
    daemonId: serverId,
    capabilities,
    helloEpoch: 1,
    sentAt: Date.now(),
  }));
  await flush();
  const browserA = new MockWs();
  const browserB = new MockWs();
  bridge.handleBrowserConnection(browserA as never, 'user-owner', db);
  bridge.handleBrowserConnection(browserB as never, 'user-owner', db);
  await flush();
  daemon.clearSent();
  browserA.clearSent();
  browserB.clearSent();
  return { serverId, bridge, daemon, browserA, browserB, auditRows, userPrefs };
}

describe('WsBridge session group clone routing', () => {
  beforeEach(() => {
    WsBridge.getAll().clear();
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.clearAllMocks();
  });

  it('broadcasts sanitized daemon clone events to browsers', async () => {
    const { daemon, browserA, browserB, auditRows } = await setup();
    daemon.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-1',
      idempotencyKey: 'idem-1',
      state: 'succeeded',
      sourceMainSessionName: 'deck_cd_brain',
      clonedMainSessionName: 'deck_cd_1_brain',
      transportConfig: { apiKey: 'raw-secret' },
      result: {
        operationId: 'op-1',
        idempotencyKey: 'idem-1',
        sourceMainSession: 'deck_cd_brain',
        clonedMainSession: 'deck_cd_1_brain',
        targetProjectName: 'cd_1',
        targetProjectSlug: 'cd_1',
        sessionNameMap: { deck_cd_brain: 'deck_cd_1_brain' },
        copiedSubSessionIds: [],
        skippedMembers: [],
        skippedCronJobs: 0,
        skippedOrchestrationRuns: 0,
        warnings: [],
        transportConfig: { authorization: 'raw-secret' },
      },
    }));
    await flush();

    const eventA = browserA.sentJson().find((msg) => msg.type === SESSION_GROUP_CLONE_MSG.EVENT);
    const eventB = browserB.sentJson().find((msg) => msg.type === SESSION_GROUP_CLONE_MSG.EVENT);
    expect(eventA).toMatchObject({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-1',
      idempotencyKey: 'idem-1',
      state: 'succeeded',
      clonedMainSessionName: 'deck_cd_1_brain',
    });
    expect(eventB).toMatchObject(eventA ?? {});
    expect(JSON.stringify(eventA)).not.toContain('raw-secret');
    expect(JSON.stringify(auditRows)).toContain('session_group_clone.succeeded');
    expect(JSON.stringify(auditRows)).toContain('deck_cd_1_brain');
    expect(JSON.stringify(auditRows)).not.toContain('raw-secret');
  });

  it('rejects browser clone commands that do not carry the matching serverId', async () => {
    const { daemon, browserA } = await setup();
    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-no-server',
    }));
    await flush();

    expect(daemon.sentJson().some((msg) => msg.type === SESSION_GROUP_CLONE_MSG.START)).toBe(false);
    expect(browserA.sentJson()).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'invalid_request',
      originalType: SESSION_GROUP_CLONE_MSG.START,
      reason: 'serverId_required',
    }));
  });

  it('routes authorized browser clone commands only to the matching daemon', async () => {
    const { serverId, daemon, browserA, auditRows } = await setup();
    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-ws',
      targetProjectName: 'P2P Design Review',
      cwdOverride: '/do/not/audit',
    }));
    await flush();

    const forwarded = daemon.sentJson().find((msg) => msg.type === SESSION_GROUP_CLONE_MSG.START);
    expect(forwarded).toEqual({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-ws',
      targetProjectName: 'P2P Design Review',
      cwdOverride: '/do/not/audit',
    });
    expect(JSON.stringify(auditRows)).toContain('session_group_clone.accepted');
    expect(JSON.stringify(auditRows)).toContain('p2p_design_review');
    expect(JSON.stringify(auditRows)).not.toContain('/do/not/audit');
  });

  it('adds server-visible session names to browser clone commands for daemon default allocation', async () => {
    const { serverId, daemon, browserA } = await setup(
      [SESSION_GROUP_CLONE_CAPABILITY_V1],
      { dbSessionNames: ['deck_cd_1_brain', 'deck_other_brain'] },
    );
    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-ws-default-db-visible',
    }));
    await flush();

    expect(daemon.sentJson()).toContainEqual(expect.objectContaining({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-ws-default-db-visible',
      unavailableSessionNames: ['deck_cd_1_brain', 'deck_other_brain'],
    }));
  });

  it('replays an existing operation event for duplicate browser idempotency keys without forwarding again', async () => {
    const { serverId, daemon, browserA, browserB } = await setup();
    daemon.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-duplicate',
      idempotencyKey: 'idem-duplicate',
      state: 'creating_main',
      sourceMainSessionName: 'deck_cd_brain',
    }));
    await flush();
    daemon.clearSent();
    browserA.clearSent();
    browserB.clearSent();

    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-duplicate',
      targetProjectName: 'cd_1',
    }));
    await flush();

    expect(daemon.sentJson().some((msg) => msg.type === SESSION_GROUP_CLONE_MSG.START)).toBe(false);
    expect(browserA.sentJson()).toContainEqual(expect.objectContaining({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-duplicate',
      idempotencyKey: 'idem-duplicate',
      state: 'creating_main',
    }));
    expect(browserB.sentJson()).toContainEqual(expect.objectContaining({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-duplicate',
      idempotencyKey: 'idem-duplicate',
      state: 'creating_main',
    }));
  });

  it('rejects explicit target project names that collide with server-visible sessions', async () => {
    const { serverId, daemon, browserA, auditRows } = await setup(
      [SESSION_GROUP_CLONE_CAPABILITY_V1],
      { dbSessionNames: ['deck_p2p_design_review_brain'] },
    );
    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-name-taken',
      targetProjectName: 'P2P Design Review',
    }));
    await flush();

    expect(daemon.sentJson().some((msg) => msg.type === SESSION_GROUP_CLONE_MSG.START)).toBe(false);
    expect(browserA.sentJson()).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'name_taken',
      originalType: SESSION_GROUP_CLONE_MSG.START,
      targetMainSessionName: 'deck_p2p_design_review_brain',
    }));
    expect(JSON.stringify(auditRows)).toContain('name_taken');
    expect(JSON.stringify(auditRows)).toContain('p2p_design_review');
  });

  it('copies server-synced P2P preference on successful clone and forwards the daemon-local save', async () => {
    const { serverId, daemon, browserA, userPrefs, auditRows } = await setup();
    const sourceKey = p2pSessionConfigPrefKey('deck_cd_brain', serverId);
    userPrefs.set(`user-owner:${sourceKey}`, JSON.stringify({
      sessions: {
        deck_cd_brain: { enabled: true, mode: 'audit' },
        deck_sub_a: { enabled: true, mode: 'review' },
      },
      rounds: 2,
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_sub_a',
      },
    }));

    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-p2p-pref',
      targetProjectName: 'cd_1',
    }));
    await flush();
    daemon.clearSent();

    daemon.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-p2p-pref',
      idempotencyKey: 'idem-p2p-pref',
      state: 'succeeded',
      sourceMainSessionName: 'deck_cd_brain',
      clonedMainSessionName: 'deck_cd_1_brain',
      result: {
        operationId: 'op-p2p-pref',
        idempotencyKey: 'idem-p2p-pref',
        sourceMainSession: 'deck_cd_brain',
        clonedMainSession: 'deck_cd_1_brain',
        targetProjectName: 'cd_1',
        targetProjectSlug: 'cd_1',
        sessionNameMap: {
          deck_cd_brain: 'deck_cd_1_brain',
          deck_sub_a: 'deck_sub_b',
        },
        copiedSubSessionIds: [{ sourceId: 'a', clonedId: 'b' }],
        skippedMembers: [],
        skippedCronJobs: 0,
        skippedOrchestrationRuns: 0,
        warnings: [],
      },
    }));
    await flush();

    const targetKey = p2pSessionConfigPrefKey('deck_cd_1_brain', serverId);
    expect(JSON.parse(userPrefs.get(`user-owner:${targetKey}`) ?? 'null')).toMatchObject({
      sessions: {
        deck_cd_1_brain: { enabled: true, mode: 'audit' },
        deck_sub_b: { enabled: true, mode: 'review' },
      },
      rounds: 2,
      contextReducer: {
        sessionName: 'deck_sub_b',
      },
    });
    expect(daemon.sentJson()).toContainEqual(expect.objectContaining({
      type: P2P_CONFIG_MSG.SAVE,
      scopeSession: 'deck_cd_1_brain',
      config: expect.objectContaining({
        sessions: {
          deck_cd_1_brain: { enabled: true, mode: 'audit' },
          deck_sub_b: { enabled: true, mode: 'review' },
        },
      }),
    }));
    expect(JSON.stringify(auditRows)).toContain('session_group_clone.p2p_config_copied');
  });

  it('converts server-synced P2P preference write failure into cleanup_required instead of success', async () => {
    const { serverId, daemon, browserA, userPrefs, auditRows } = await setup(
      [SESSION_GROUP_CLONE_CAPABILITY_V1],
      { failUserPreferenceWrites: true },
    );
    const sourceKey = p2pSessionConfigPrefKey('deck_cd_brain', serverId);
    userPrefs.set(`user-owner:${sourceKey}`, JSON.stringify({
      sessions: {
        deck_cd_brain: { enabled: true, mode: 'audit' },
      },
      rounds: 1,
    }));

    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-p2p-pref-fail',
      targetProjectName: 'cd_1',
    }));
    await flush();
    daemon.clearSent();
    browserA.clearSent();

    daemon.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-p2p-pref-fail',
      idempotencyKey: 'idem-p2p-pref-fail',
      state: 'succeeded',
      sourceMainSessionName: 'deck_cd_brain',
      clonedMainSessionName: 'deck_cd_1_brain',
      result: {
        operationId: 'op-p2p-pref-fail',
        idempotencyKey: 'idem-p2p-pref-fail',
        sourceMainSession: 'deck_cd_brain',
        clonedMainSession: 'deck_cd_1_brain',
        targetProjectName: 'cd_1',
        targetProjectSlug: 'cd_1',
        sessionNameMap: { deck_cd_brain: 'deck_cd_1_brain' },
        copiedSubSessionIds: [],
        skippedMembers: [],
        skippedCronJobs: 0,
        skippedOrchestrationRuns: 0,
        warnings: [],
      },
    }));
    await flush();

    expect(browserA.sentJson()).toContainEqual(expect.objectContaining({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-p2p-pref-fail',
      state: 'cleanup_required',
      errorCode: 'server_p2p_commit_failed',
      cleanupRequired: true,
      cleanupResources: [expect.objectContaining({
        kind: 'server_p2p_pref',
        sessionName: 'deck_cd_1_brain',
        serverId,
        retriable: true,
      })],
    }));
    expect(daemon.sentJson().some((msg) => msg.type === P2P_CONFIG_MSG.SAVE)).toBe(false);
    expect(JSON.stringify(auditRows)).toContain('session_group_clone.p2p_config_failed');
    expect(JSON.stringify(auditRows)).toContain('session_group_clone.cleanup_required');
    expect(JSON.stringify(auditRows)).not.toContain('"state":"succeeded"');
  });

  it('replays cloned-root daemon-local P2P save when daemon reconnects after server preference success', async () => {
    const { serverId, daemon, browserA, userPrefs, auditRows } = await setup();
    const sourceKey = p2pSessionConfigPrefKey('deck_cd_brain', serverId);
    userPrefs.set(`user-owner:${sourceKey}`, JSON.stringify({
      sessions: {
        deck_cd_brain: { enabled: true, mode: 'audit' },
      },
      rounds: 1,
    }));

    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-p2p-reconnect',
      targetProjectName: 'cd_1',
    }));
    await flush();
    daemon.clearSent();
    browserA.clearSent();

    daemon.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-p2p-reconnect',
      idempotencyKey: 'idem-p2p-reconnect',
      state: 'succeeded',
      sourceMainSessionName: 'deck_cd_brain',
      clonedMainSessionName: 'deck_cd_1_brain',
      result: {
        operationId: 'op-p2p-reconnect',
        idempotencyKey: 'idem-p2p-reconnect',
        sourceMainSession: 'deck_cd_brain',
        clonedMainSession: 'deck_cd_1_brain',
        targetProjectName: 'cd_1',
        targetProjectSlug: 'cd_1',
        sessionNameMap: { deck_cd_brain: 'deck_cd_1_brain' },
        copiedSubSessionIds: [],
        skippedMembers: [],
        skippedCronJobs: 0,
        skippedOrchestrationRuns: 0,
        warnings: [],
      },
    }));
    daemon.close();
    await flush();

    expect(JSON.parse(userPrefs.get(`user-owner:${p2pSessionConfigPrefKey('deck_cd_1_brain', serverId)}`) ?? 'null')).toMatchObject({
      sessions: { deck_cd_1_brain: { enabled: true, mode: 'audit' } },
    });
    expect(daemon.sentJson().some((msg) => msg.type === P2P_CONFIG_MSG.SAVE)).toBe(false);

    const reconnectedDaemon = new MockWs();
    const bridge = WsBridge.get(serverId);
    bridge.handleDaemonConnection(reconnectedDaemon as never, makeDb({ ownerUserId: 'user-owner' }).db, {} as never);
    reconnectedDaemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'token' }));
    await flush();
    reconnectedDaemon.emit('message', JSON.stringify({
      type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
      daemonId: serverId,
      capabilities: [SESSION_GROUP_CLONE_CAPABILITY_V1],
      helloEpoch: 2,
      sentAt: Date.now(),
    }));
    await flush();

    expect(reconnectedDaemon.sentJson()).toContainEqual(expect.objectContaining({
      type: P2P_CONFIG_MSG.SAVE,
      scopeSession: 'deck_cd_1_brain',
      config: expect.objectContaining({
        sessions: { deck_cd_1_brain: { enabled: true, mode: 'audit' } },
      }),
    }));
    expect(browserA.sentJson()).toContainEqual(expect.objectContaining({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-p2p-reconnect',
      state: 'succeeded',
    }));
    expect(JSON.stringify(auditRows)).toContain('session_group_clone.p2p_config_copied');
  });

  it('merges skipped scheduled-work counts into succeeded clone broadcasts, result payloads, and audit metadata', async () => {
    const { daemon, browserA, auditRows } = await setup(
      [SESSION_GROUP_CLONE_CAPABILITY_V1],
      { skippedCronJobs: 2, skippedOrchestrationRuns: 3 },
    );

    daemon.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-scheduled-counts',
      idempotencyKey: 'idem-scheduled-counts',
      state: 'succeeded',
      sourceMainSessionName: 'deck_cd_brain',
      clonedMainSessionName: 'deck_cd_1_brain',
      result: {
        operationId: 'op-scheduled-counts',
        idempotencyKey: 'idem-scheduled-counts',
        sourceMainSession: 'deck_cd_brain',
        clonedMainSession: 'deck_cd_1_brain',
        targetProjectName: 'cd_1',
        targetProjectSlug: 'cd_1',
        sessionNameMap: {
          deck_cd_brain: 'deck_cd_1_brain',
          deck_sub_a: 'deck_sub_b',
        },
        copiedSubSessionIds: [{ sourceId: 'a', clonedId: 'b' }],
        skippedMembers: [],
        skippedCronJobs: 0,
        skippedOrchestrationRuns: 0,
        warnings: [],
      },
    }));
    await flush();

    expect(browserA.sentJson()).toContainEqual(expect.objectContaining({
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-scheduled-counts',
      skippedCronJobs: 2,
      skippedOrchestrationRuns: 3,
      result: expect.objectContaining({
        skippedCronJobs: 2,
        skippedOrchestrationRuns: 3,
      }),
    }));
    const succeededAudit = auditRows.find((row) => row[3] === 'session_group_clone.succeeded');
    expect(JSON.parse(String(succeededAudit?.[4] ?? '{}'))).toMatchObject({
      skippedCronJobs: 2,
      skippedOrchestrationRuns: 3,
    });
  });

  it('rejects browser clone commands when daemon capability is missing', async () => {
    const { serverId, daemon, browserA } = await setup([]);
    browserA.emit('message', JSON.stringify({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId,
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-missing-capability',
    }));
    await flush();

    expect(daemon.sentJson().some((msg) => msg.type === SESSION_GROUP_CLONE_MSG.START)).toBe(false);
    expect(browserA.sentJson()).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'unsupported_command',
      originalType: SESSION_GROUP_CLONE_MSG.START,
      missingCapability: SESSION_GROUP_CLONE_CAPABILITY_V1,
    }));
  });
});
