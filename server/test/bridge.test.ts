import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { WsBridge, __setIdlePushSettleMsForTests, __setTimelineDataPlaneQueueConfigForTests } from '../src/ws/bridge.js';
import { getCounter, resetMetricsForTests } from '../src/util/metrics.js';
import {
  markDaemonUpgradeTargetVersionPublishedForTest,
  resetDaemonUpgradePublicationGateForTest,
} from '../src/ws/daemon-upgrade-publication-gate.js';
import * as dbQueries from '../src/db/queries.js';
import { PUSH_TIMELINE_EVENT_MAX_AGE_MS, TIMELINE_SUPPRESS_PUSH_FIELD } from '../../shared/push-notifications.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { P2P_CONFIG_MSG } from '../../shared/p2p-config-events.js';
import {
  P2P_BRIDGE_ERROR_CODES,
  P2P_BRIDGE_PENDING_REQUESTS_GLOBAL,
  P2P_BRIDGE_PENDING_REQUESTS_PER_SOCKET,
  P2P_CAPABILITY_FRESHNESS_TTL_MS,
  P2P_SANITIZE_MAX_STRING_BYTES,
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
} from '../../shared/p2p-workflow-constants.js';
import { REPO_MSG } from '../../shared/repo-types.js';
import { FS_TRANSPORT_MSG } from '../../shared/fs-transport-messages.js';
import {
  TIMELINE_MESSAGES,
  TIMELINE_PROTOCOL_CAPABILITY,
  TIMELINE_PROTOCOL_REVISION,
  TIMELINE_RESPONSE_SOURCES,
  TIMELINE_RESPONSE_STATUS,
} from '../../shared/timeline-protocol.js';
import { TIMELINE_REQUEST_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import { OPENSPEC_AUTO_DELIVER_MSG } from '../../shared/openspec-auto-deliver-constants.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  REMOTE_EXEC_MAX_ERROR_BYTES,
  REMOTE_EXEC_MAX_OUTPUT_BYTES,
} from '../../shared/remote-exec.js';
import {
  cancelPendingExec,
  machineExecRegistryStats,
  registerPendingExec,
} from '../src/ws/machine-exec-registry.js';

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

function makeOpenSpecAutoDeliverProjection(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'auto-run-1',
    changeName: 'openspec-auto-delivery',
    owningMainSessionName: 'deck_proj_brain',
    launchedFromSessionName: 'deck_sub_launcher',
    targetImplementationSessionName: 'deck_sub_worker',
    projectionVersion: 1,
    generation: 1,
    presetId: 'standard',
    materializedLimits: {
      specAuditRepairRounds: 1,
      implementationAuditRepairRounds: 2,
      maxImplementationPrompts: 12,
      maxElapsedMinutes: 240,
    },
    status: 'implementation_task_loop',
    stage: 'implementation_task_loop',
    elapsedMs: 0,
    implementationPromptCount: 0,
    taskStats: { total: 0, checked: 0, unchecked: 0 },
    specAuditRepairRound: 0,
    implementationAuditRepairRound: 0,
    selectedTeamComboId: 'audit>review>plan',
    activeOpenSpecPromptId: 'implementation_audit',
    ...overrides,
  };
}

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1; // WebSocket.OPEN
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3; // WebSocket.CLOSED
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  /** Sent strings only (excludes binary frames) */
  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
}

class SlowMockWs extends MockWs {
  private pendingSendCallbacks: Array<(err?: Error) => void> = [];

  override send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(data);
    if (callback) this.pendingSendCallbacks.push(callback);
  }

  releaseNextSend(err?: Error): void {
    this.pendingSendCallbacks.shift()?.(err);
  }

  releaseAllSends(err?: Error): void {
    while (this.pendingSendCallbacks.length > 0) {
      this.releaseNextSend(err);
    }
  }
}

// ── Build v1 binary frame ─────────────────────────────────────────────────────

function packFrame(sessionName: string, payload: Buffer): Buffer {
  const nameBytes = Buffer.from(sessionName, 'utf8');
  const header = Buffer.allocUnsafe(3 + nameBytes.length);
  header[0] = 0x01;
  header.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(header, 3);
  return Buffer.concat([header, payload]);
}

// ── Mock DB ────────────────────────────────────────────────────────────────────

function makeDb(tokenHash: string, nodeRole: 'full' | 'controlled' = 'full') {
  const db = {
    queryOne: async () => ({
      token_hash: tokenHash,
      node_role: nodeRole,
      revoked_at: null,
    }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
    close: () => {},
  };
  return db as unknown as import('../src/db/client.js').Database;
}

function makeOpenSpecAutoDeliverOwnershipDb(allowedSessionNames: string[] = []) {
  const allowed = new Set(allowedSessionNames);
  const db = {
    queryOne: async (sql: string, params?: unknown[]) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash', user_id: 'test-user' };
      if (sql.includes('FROM sessions WHERE')) {
        const sessionName = typeof params?.[1] === 'string' ? params[1] : '';
        return allowed.has(sessionName) ? { ok: 1 } : null;
      }
      if (sql.includes('FROM sub_sessions WHERE')) {
        const subId = typeof params?.[1] === 'string' ? params[1] : '';
        return allowed.has(`deck_sub_${subId}`) ? { ok: 1 } : null;
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
    close: () => {},
  };
  return db as unknown as import('../src/db/client.js').Database;
}

function makeSubSessionOwnershipRaceDb(options: {
  subId: string;
  allowAfterChecks?: number;
}) {
  let subChecks = 0;
  const allowAfterChecks = options.allowAfterChecks ?? 2;
  const db = {
    queryOne: async (sql: string, params?: unknown[]) => {
      if (sql.includes('token_hash')) return { token_hash: 'valid-hash', user_id: 'test-user' };
      if (sql.includes('FROM sessions WHERE')) return null;
      if (sql.includes('FROM sub_sessions WHERE')) {
        subChecks += 1;
        return params?.[1] === options.subId && subChecks >= allowAfterChecks ? { ok: 1 } : null;
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
    close: () => {},
    getSubChecks: () => subChecks,
  };
  return db as unknown as import('../src/db/client.js').Database & { getSubChecks: () => number };
}

function makeRepoCheckoutDb(options: {
  allowMain?: boolean;
  allowSub?: boolean;
  throwOnAuthorization?: boolean;
} = {}) {
  const db = {
    queryOne: async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT token_hash')) {
        return { token_hash: 'valid-hash', user_id: 'test-user' };
      }
      if (options.throwOnAuthorization && (sql.includes('FROM sessions s') || sql.includes('FROM sub_sessions ss'))) {
        throw new Error('authz unavailable');
      }
      if (sql.includes('FROM sessions s')) {
        const [, sessionName, projectDir, userId] = params;
        return options.allowMain
          && sessionName === 'deck_proj_brain'
          && projectDir === '/work/proj'
          && userId === 'test-user'
          ? { ok: 1 }
          : null;
      }
      if (sql.includes('FROM sub_sessions ss')) {
        const [, subId, projectDir, userId] = params;
        return options.allowSub
          && subId === 'abc123'
          && projectDir === '/work/sub'
          && userId === 'test-user'
          ? { ok: 1 }
          : null;
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
    close: () => {},
  };
  return db as unknown as import('../src/db/client.js').Database;
}

function makeTimelineOwnershipDb(options: {
  allowMain?: boolean;
  allowSub?: boolean;
  throwOnOwnership?: boolean;
} = {}) {
  const db = {
    queryOne: async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT token_hash')) {
        return { token_hash: 'valid-hash', user_id: 'test-user' };
      }
      if (options.throwOnOwnership && (sql.includes('FROM sessions WHERE') || sql.includes('FROM sub_sessions WHERE'))) {
        throw new Error('ownership db down');
      }
      if (sql.includes('FROM sessions WHERE')) {
        return options.allowMain
          && params[0] === 'srv-owned'
          && params[1] === 'deck_proj_brain'
          ? { ok: 1 }
          : null;
      }
      if (sql.includes('FROM sub_sessions WHERE')) {
        return options.allowSub
          && params[0] === 'srv-owned'
          && params[1] === 'abc-123'
          ? { ok: 1 }
          : null;
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
    close: () => {},
  };
  return db as unknown as import('../src/db/client.js').Database;
}

// ── Mock crypto + push ─────────────────────────────────────────────────────────

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

// Flush all pending microtasks/promises
async function flushAsync() {
  // Multiple rounds to handle promise chains inside async message handlers
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

async function flushBridgeDataPlane() {
  await flushAsync();
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    await flushAsync();
  }
}

async function flushOneBridgeDataPlaneTurn() {
  await flushAsync();
  await new Promise((r) => setImmediate(r));
  await flushAsync();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WsBridge', () => {
  let serverId: string;

  beforeEach(() => {
    serverId = `test-${Math.random().toString(36).slice(2)}`;
    resetDaemonUpgradePublicationGateForTest();
    markDaemonUpgradeTargetVersionPublishedForTest('2026.4.905-dev.877');
    markDaemonUpgradeTargetVersionPublishedForTest('2026.4.905');
    resetMetricsForTests();
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    resetDaemonUpgradePublicationGateForTest();
    resetMetricsForTests();
    vi.clearAllMocks();
  });

  describe('daemon auth', () => {
    const originalAppVersion = process.env.APP_VERSION;

    afterEach(() => {
      if (originalAppVersion == null) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = originalAppVersion;
      vi.useRealTimers();
    });

    it('authenticates with valid token', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
      await flushAsync();
      expect(bridge.isAuthenticated).toBe(true);
    });

    it('closes on auth timeout', async () => {
      vi.useFakeTimers();
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('hash') as never, {} as never);

      vi.advanceTimersByTime(5001);
      await flushAsync();
      vi.useRealTimers();
      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(4001);
    });

    it('closes on invalid token', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('different-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'bad-token' }));
      await flushAsync();
      expect(ws.closed).toBe(true);
    });

    // Audit fix (78-server reconnect-storm investigation, 2026-05-11) —
    // pinned regression for the auth-handshake race that produced
    // "Daemon authenticated" log entries every ~500 ms in production
    // (and `code:4001 reason:auth_required` on the daemon side). Daemon
    // sends `auth` immediately followed by `daemon.hello` on every WS
    // connect, and the previous async message handler let the second
    // message race the DB lookup of the first.
    it('does NOT 4001-close when auth and daemon.hello arrive back-to-back during DB lookup', async () => {
      // Build a DB whose token-hash lookup is deferred so we can emit
      // both messages BEFORE the query resolves — this is the production
      // race window. Without the fix, daemon.hello hits
      // `if (msg.type !== 'auth') ws.close(4001, 'auth_required')`
      // because `this.authenticated` is still false at that moment.
      let resolveQuery: (value: { token_hash: string } | null) => void = () => {};
      const queryPromise = new Promise<{ token_hash: string } | null>((res) => { resolveQuery = res; });
      const db = {
        queryOne: () => queryPromise,
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, db, {} as never);

      // Emit BOTH messages before the query resolves. The race only
      // shows up under `await db.queryOne(...)` being pending when the
      // second message handler runs.
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
      ws.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: [P2P_WORKFLOW_CAPABILITY_V1],
        helloEpoch: 1,
        sentAt: Date.now(),
      }));
      // Let microtasks settle so the auth handler is parked at its
      // `await db.queryOne(...)` and the daemon.hello handler has had a
      // chance to run if the bug were present.
      await flushAsync();

      // Pre-fix expectation: ws.closed === true with code 4001. Post-fix
      // expectation: socket stays open and waits for auth to complete.
      expect(ws.closed).toBe(false);
      expect(ws.closeCode).toBeUndefined();

      // Now resolve the DB query and let auth complete.
      resolveQuery({ token_hash: 'valid-hash' });
      await flushAsync();

      expect(bridge.isAuthenticated).toBe(true);
      expect(ws.closed).toBe(false);
    });

    it('sends daemon.upgrade when daemon is older than server version', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.some((msg) => msg.includes('"type":"daemon.upgrade"') && msg.includes('2026.4.905-dev.877'))).toBe(true);
    });

    it('sends daemon.upgrade when daemon is newer than server version so versions converge exactly', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.906-dev.1' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.some((msg) => msg.includes('"type":"daemon.upgrade"') && msg.includes('2026.4.905-dev.877'))).toBe(true);
    });

    it('sends daemon.upgrade when server is dev and daemon is stable', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.905' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.some((msg) => msg.includes('"type":"daemon.upgrade"') && msg.includes('2026.4.905-dev.877'))).toBe(true);
    });

    it('sends daemon.upgrade when server is stable and daemon is dev', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.905-dev.877' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.some((msg) => msg.includes('"type":"daemon.upgrade"') && msg.includes('2026.4.905'))).toBe(true);
    });

    it('rate-limits auto daemon.upgrade to at most once every 15 minutes', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const firstWs = new MockWs();
      bridge.handleDaemonConnection(firstWs as never, makeDb('valid-hash'), {} as never);

      firstWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(firstWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(1);

      const secondWs = new MockWs();
      bridge.handleDaemonConnection(secondWs as never, makeDb('valid-hash'), {} as never);
      secondWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(secondWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      const thirdWs = new MockWs();
      bridge.handleDaemonConnection(thirdWs as never, makeDb('valid-hash'), {} as never);
      thirdWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(thirdWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(1);
    });

    it('retries auto daemon.upgrade after transient daemon upgrade blockers clear without waiting for reconnect', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(1);

      ws.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: 'auto_deliver_active' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(59_999);
      await flushAsync();
      expect(ws.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();

      expect(ws.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(2);
    });

    it('does not retry auto daemon.upgrade after non-retryable daemon upgrade blockers', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(1);

      ws.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: 'toolchain_unavailable' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsync();

      expect(ws.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(1);
    });

    it('does not send a stale scheduled daemon.upgrade after the daemon socket is replaced', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const staleWs = new MockWs();
      bridge.handleDaemonConnection(staleWs as never, makeDb('valid-hash'), {} as never);
      staleWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();

      const replacementWs = new MockWs();
      bridge.handleDaemonConnection(replacementWs as never, makeDb('valid-hash'), {} as never);
      replacementWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(staleWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);
      expect(replacementWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);
    });
  });

  describe('message relay daemon→browser', () => {
    async function setupAuthenticatedBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { bridge, daemonWs, browserWs };
    }

    it('translates terminal_update → terminal.diff (with sessionName)', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      // Browser must be subscribed to the session for the routed message to arrive
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-tu' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({ type: 'terminal_update', diff: { sessionName: 'sess-tu', a: 1 } }));
      await flushAsync();
      expect(JSON.parse(browserWs.sentStrings[0]).type).toBe('terminal.diff');
    });

    it('relays additive p2p.run_update payload fields without stripping legacy fields', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      const run = {
        id: 'run-1',
        discussion_id: 'dsc-1',
        status: 'running',
        mode_key: 'audit',
        current_round: 1,
        total_rounds: 2,
        active_phase: 'hop',
        completed_hops_count: 1,
        total_hops: 2,
        all_nodes: [],
        run_phase: 'round_execution',
        summary_phase: null,
        hop_states: [
          { hop_index: 1, round_index: 1, session: 'deck_proj_w1', mode: 'audit', status: 'completed', started_at: 1, completed_at: null, error: null },
          { hop_index: 2, round_index: 1, session: 'deck_proj_w2', mode: 'audit', status: 'running', started_at: 2, completed_at: null, error: null },
        ],
        hop_counts: { total: 2, queued: 0, dispatched: 0, running: 1, completed: 1, timed_out: 0, failed: 0, cancelled: 0 },
      };

      daemonWs.emit('message', JSON.stringify({ type: 'p2p.run_save', run }));
      await flushAsync();

      const update = browserWs.sentStrings
        .map((msg) => JSON.parse(msg))
        .find((msg) => msg.type === 'p2p.run_update');

      expect(update).toBeTruthy();
      expect(update.run.status).toBe('running');
      expect(update.run.active_phase).toBe('hop');
      expect(update.run.run_phase).toBe('round_execution');
      expect(update.run.hop_states).toHaveLength(2);
      expect(update.run.hop_counts.completed).toBe(1);
    });

    it('translates session_event → session.event', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({ type: 'session_event', session: 'x' }));
      await flushAsync();
      expect(JSON.parse(browserWs.sent[0]).type).toBe('session.event');
    });

    it('passes through session.idle to subscribed browser', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-idle' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({ type: 'session.idle', session: 'sess-idle' }));
      await flushAsync();
      expect(JSON.parse(browserWs.sentStrings[0]).type).toBe('session.idle');
    });

    it('removes erroring browser socket on send failure', async () => {
      const { bridge, daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.closed = true; // next send throws
      // Use a broadcast type (session_event) so the closed socket is detected via broadcastToBrowsers
      daemonWs.emit('message', JSON.stringify({ type: 'session_event', event: 'started', session: 'x' }));
      await flushAsync();
      expect(bridge.browserCount).toBe(0);
    });
  });

  describe('browser→daemon whitelist', () => {
    async function setupBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { daemonWs, browserWs };
    }

    it('forwards whitelisted type', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'x' }));
      await flushAsync(); // terminal.subscribe ownership check is async
      expect(daemonWs.sentStrings.some((s) => s.includes('terminal.subscribe'))).toBe(true);
    });

    it('forwards any valid message type to daemon (no whitelist)', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'admin.shutdown' }));
      expect(daemonWs.sentStrings.some((s) => s.includes('admin.shutdown'))).toBe(true);
    });

    it('rejects browser-origin legacy transport queue evidence instead of forwarding or offline replaying it', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: 'session.state',
        sessionName: 'deck_test_brain',
        pendingMessages: ['legacy text'],
        transportPendingMessages: ['legacy text'],
        pendingCount: 1,
      }));
      await flushAsync();

      expect(daemonWs.sentStrings).toHaveLength(0);
    });

    it('authorizes repo.checkout_branch against the browser user session/project binding before forwarding', async () => {
      const bridge = WsBridge.get(serverId);
      const db = makeRepoCheckoutDb({ allowMain: true });
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', db);
      browserWs.emit('message', JSON.stringify({
        type: REPO_MSG.CHECKOUT_BRANCH,
        requestId: 'checkout-main',
        projectDir: '/work/proj',
        branch: 'feature/a',
        sessionId: 'deck_proj_brain',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings
        .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
        .find((msg) => msg?.type === REPO_MSG.CHECKOUT_BRANCH);
      expect(forwarded).toMatchObject({
        requestId: 'checkout-main',
        projectDir: '/work/proj',
        branch: 'feature/a',
        sessionId: 'deck_proj_brain',
      });
    });

    it('authorizes repo.checkout_branch for a bound sub-session cwd', async () => {
      const bridge = WsBridge.get(serverId);
      const db = makeRepoCheckoutDb({ allowSub: true });
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', db);
      browserWs.emit('message', JSON.stringify({
        type: REPO_MSG.CHECKOUT_BRANCH,
        requestId: 'checkout-sub',
        projectDir: '/work/sub',
        branch: 'feature/sub',
        sessionId: 'deck_sub_abc123',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => {
        try {
          const msg = JSON.parse(s) as Record<string, unknown>;
          return msg.type === REPO_MSG.CHECKOUT_BRANCH && msg.requestId === 'checkout-sub';
        } catch {
          return false;
        }
      })).toBe(true);
    });

    it('rejects repo.checkout_branch for unbound projectDir before daemon forwarding', async () => {
      const bridge = WsBridge.get(serverId);
      const db = makeRepoCheckoutDb();
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', db);
      browserWs.emit('message', JSON.stringify({
        type: REPO_MSG.CHECKOUT_BRANCH,
        requestId: 'checkout-denied',
        projectDir: '/work/other',
        branch: 'feature/a',
        sessionId: 'deck_proj_brain',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => {
        try { return (JSON.parse(s) as Record<string, unknown>).type === REPO_MSG.CHECKOUT_BRANCH; } catch { return false; }
      })).toBe(false);
      expect(browserWs.sentStrings.some((s) => {
        try {
          const msg = JSON.parse(s) as Record<string, unknown>;
          return msg.type === REPO_MSG.ERROR
            && msg.requestId === 'checkout-denied'
            && msg.projectDir === '/work/other'
            && msg.error === 'unauthorized';
        } catch {
          return false;
        }
      })).toBe(true);
    });

    it('rejects malformed repo.checkout_branch requests before daemon forwarding', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({
        type: REPO_MSG.CHECKOUT_BRANCH,
        projectDir: '/work/proj',
        branch: 'feature/a',
        sessionId: 'deck_proj_brain',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => {
        try { return (JSON.parse(s) as Record<string, unknown>).type === REPO_MSG.CHECKOUT_BRANCH; } catch { return false; }
      })).toBe(false);
      expect(browserWs.sentStrings.some((s) => {
        try {
          const msg = JSON.parse(s) as Record<string, unknown>;
          return msg.type === REPO_MSG.ERROR && msg.error === 'invalid_params';
        } catch {
          return false;
        }
      })).toBe(true);
    });

    it('rejects browser raw daemon.upgrade commands', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'daemon.upgrade', targetVersion: '2026.4.905-dev.877', requestId: 'r1' }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => s.includes('daemon.upgrade'))).toBe(false);
      expect(browserWs.sentStrings.some((s) => s.includes('server_only_command') && s.includes('r1'))).toBe(true);
    });

    it('rejects browser raw server.delete commands', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'server.delete', requestId: 'r2' }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => s.includes('server.delete'))).toBe(false);
      expect(browserWs.sentStrings.some((s) => s.includes('server_only_command') && s.includes('r2'))).toBe(true);
    });

    it('drops oversized payload', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'session.send', text: 'x'.repeat(TIMELINE_PAYLOAD_BUDGET_BYTES.CHAT_HISTORY_TRACE_HARD_LIMIT + 1) }));
      expect(daemonWs.sent).toHaveLength(0);
    });

    it('forwards every message when BROWSER_RATE_LIMIT_ENABLED is off (current default)', async () => {
      // The browser-side rate limiter is currently DISABLED by feature flag
      // (BROWSER_RATE_LIMIT_ENABLED in server/src/ws/bridge.ts). Reasoning is
      // documented at the constant: a desktop tab with pinned panels +
      // multi-session reconnects fires 60–300 messages within ~2 s, blowing
      // through the 300 / 10s window during normal init bursts. Dropped
      // `session.send` messages then surface as instant `command.failed`,
      // turning the optimistic bubble red within milliseconds — the wall-of-
      // `rate_limited` symptom. Until the burst is reduced at source
      // (coalescing fs.git_status / repo.detect, debouncing subscribe
      // replays), the limiter stays off.
      //
      // This test asserts the disabled behaviour: 1000 messages all forward
      // and no `rate_limited` error is ever emitted. Flip the flag back on
      // and revert this test (see git log) when the burst-source fix lands.
      const { daemonWs, browserWs } = await setupBridge();
      for (let i = 0; i < 1000; i++) {
        browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));
      }
      // Every message reaches the daemon (the bridge serialises `get_sessions`
      // into `daemon.get_sessions` so length matches input count).
      expect(daemonWs.sent.length).toBeGreaterThanOrEqual(1000);
      // No browser ever received a `rate_limited` error.
      const rateLimitedHits = browserWs.sent
        .map((s) => { try { return JSON.parse(s as string); } catch { return null; } })
        .filter((m) => m && m.type === 'error' && m.code === 'rate_limited');
      expect(rateLimitedHits).toHaveLength(0);
    });
  });

  describe('queue drain on reconnect', () => {
    it('drains queued browser messages when daemon authenticates', async () => {
      const bridge = WsBridge.get(serverId);

      // Browser sends message before daemon connects (goes to queue)
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'get_sessions' }));

      // Daemon connects and authenticates
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => s.includes('get_sessions'))).toBe(true);
    });

    it('keeps offline daemon.upgrade out of the ordinary queue and flushes it once on auth', async () => {
      const bridge = WsBridge.get(serverId);

      bridge.sendToDaemon(JSON.stringify({ type: 'daemon.upgrade', targetVersion: '2026.4.905-dev.877' }));
      bridge.sendToDaemon(JSON.stringify({ type: 'daemon.upgrade', targetVersion: '2026.4.905-dev.877' }));

      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const upgradeMessages = daemonWs.sentStrings.filter((s) => s.includes('"type":"daemon.upgrade"'));
      expect(upgradeMessages).toHaveLength(1);
      expect(upgradeMessages[0]).toContain('2026.4.905-dev.877');
    });

    it('drops daemon.upgrade with an invalid targetVersion before it reaches the daemon', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      bridge.sendToDaemon(JSON.stringify({ type: 'daemon.upgrade', targetVersion: '2026.4.905-dev.877;touch /tmp/pwn' }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => s.includes('daemon.upgrade'))).toBe(false);
    });

    it('drops MACHINE_EXEC sent via generic sendToDaemon even when the daemon is connected (no bypass of trySendMachineExec)', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      daemonWs.sent.length = 0;

      // Generic path must NEVER carry a one-shot exec — connected or not.
      bridge.sendToDaemon(JSON.stringify({ type: 'machine.exec', correlationId: 'c1', command: 'id' }));
      await flushAsync();
      expect(daemonWs.sentStrings.some((s) => s.includes('machine.exec'))).toBe(false);

      // The generation-bound send DOES deliver it on the current generation…
      const gen = bridge.daemonConnectionGeneration();
      expect(bridge.trySendMachineExec(JSON.stringify({ type: 'machine.exec', correlationId: 'c2', command: 'id' }), gen)).toBe('sent');
      expect(daemonWs.sentStrings.some((s) => s.includes('"correlationId":"c2"'))).toBe(true);

      // …but refuses a stale generation (would be a late cross-generation exec).
      daemonWs.sent.length = 0;
      expect(bridge.trySendMachineExec(JSON.stringify({ type: 'machine.exec', correlationId: 'c3', command: 'id' }), gen + 1)).toBe('generation_changed');
      expect(daemonWs.sentStrings.some((s) => s.includes('"correlationId":"c3"'))).toBe(false);
    });

    it('trySendMachineExec reports offline (never queues) when the daemon is not connected', () => {
      const bridge = WsBridge.get(serverId);
      expect(bridge.trySendMachineExec(JSON.stringify({ type: 'machine.exec', correlationId: 'c4', command: 'id' }), 0)).toBe('offline');
    });
  });

  describe('machine exec result trust boundary', () => {
    async function setupResultBridge(nodeRole: 'full' | 'controlled') {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash', nodeRole), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      expect(bridge.isAuthenticated).toBe(true);
      return { bridge, daemonWs, generation: bridge.daemonConnectionGeneration() };
    }

    const validResult = (correlationId: string, overrides: Record<string, unknown> = {}) => ({
      type: DAEMON_MSG.MACHINE_EXEC_RESULT,
      correlationId,
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      ...overrides,
    });

    it('drops malformed, oversized, and identity-injecting CONTROLLED results before pending resolution', async () => {
      const { daemonWs, generation } = await setupResultBridge('controlled');
      const invalidFrames = [
        validResult('bad-types', { ok: 'true' }),
        validResult('bad-exit-code', { exitCode: 0.5 }),
        validResult('bad-stdout-type', { stdout: 7 }),
        validResult('bad-duration', { durationMs: -1 }),
        validResult('bad-timeout-flag', { timedOut: 'false' }),
        validResult('large-stdout', { stdout: 'x'.repeat(REMOTE_EXEC_MAX_OUTPUT_BYTES + 1) }),
        validResult('large-stderr', { stderr: 'x'.repeat(REMOTE_EXEC_MAX_OUTPUT_BYTES + 1) }),
        validResult('large-error', { ok: false, exitCode: null, error: 'x'.repeat(REMOTE_EXEC_MAX_ERROR_BYTES + 1) }),
        validResult('identity-field', { serverId: 'attacker-selected-target' }),
      ];
      const invalidBefore = WsBridge.invalidMachineExecResultsDropped;
      const controlledBefore = WsBridge.controlledInboundDropped;

      for (const frame of invalidFrames) {
        const correlationId = frame.correlationId;
        const pending = registerPendingExec(serverId, correlationId, generation, 60_000);
        const inFlightBefore = machineExecRegistryStats().inFlight;
        daemonWs.emit('message', JSON.stringify(frame));
        await flushAsync();

        // Invalid bytes never settle/remove the HTTP pending RPC. Clean it up
        // explicitly so the test does not leak a minute-long timer.
        expect(machineExecRegistryStats().inFlight).toBe(inFlightBefore);
        expect(cancelPendingExec(correlationId)).toBe(true);
        await expect(pending).resolves.toBeNull();
      }

      expect(WsBridge.invalidMachineExecResultsDropped - invalidBefore).toBe(invalidFrames.length);
      expect(WsBridge.controlledInboundDropped - controlledBefore).toBe(invalidFrames.length);
    });

    it('accepts a valid CONTROLLED result at the exact stdout/stderr byte boundary', async () => {
      const { daemonWs, generation } = await setupResultBridge('controlled');
      const correlationId = 'valid-byte-boundary';
      const pending = registerPendingExec(serverId, correlationId, generation, 60_000);
      daemonWs.emit('message', JSON.stringify(validResult(correlationId, {
        stdout: 'a'.repeat(REMOTE_EXEC_MAX_OUTPUT_BYTES),
        stderr: 'b'.repeat(REMOTE_EXEC_MAX_OUTPUT_BYTES),
        truncated: true,
      })));

      const result = await pending;
      expect(Buffer.byteLength(result?.stdout ?? '', 'utf8')).toBe(REMOTE_EXEC_MAX_OUTPUT_BYTES);
      expect(Buffer.byteLength(result?.stderr ?? '', 'utf8')).toBe(REMOTE_EXEC_MAX_OUTPUT_BYTES);
      expect(result?.truncated).toBe(true);
    });

    it('applies the same validator to FULL-node compatibility results', async () => {
      const { daemonWs, generation } = await setupResultBridge('full');
      const correlationId = 'full-invalid-result';
      const pending = registerPendingExec(serverId, correlationId, generation, 60_000);
      const invalidBefore = WsBridge.invalidMachineExecResultsDropped;

      daemonWs.emit('message', JSON.stringify(validResult(correlationId, { userId: 'forged-user' })));
      await flushAsync();

      expect(WsBridge.invalidMachineExecResultsDropped).toBe(invalidBefore + 1);
      expect(cancelPendingExec(correlationId)).toBe(true);
      await expect(pending).resolves.toBeNull();
    });
  });

  // ── PP4: alias value secrecy on the browser→daemon session.send relay ───────
  //
  // The browser attaches an out-of-band `resolvedAliases` (alias name → alias
  // plaintext, i.e. user secrets) map to a session.send. The bridge MUST forward
  // that payload to the daemon INTACT (agent expansion depends on it) while never
  // letting an alias value reach a server log/metric/diagnostic.
  describe('alias resolvedAliases relay secrecy (PP4)', () => {
    it('forwards resolvedAliases to the daemon intact but never logs the alias value', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      const secretValue = 'ssh secret-host';
      browserWs.emit('message', JSON.stringify({
        type: 'session.send',
        sessionName: 'deck_proj_brain',
        commandId: 'send-1',
        text: 'deploy now ;;(prod)',
        resolvedAliases: { prod: secretValue },
      }));
      await flushAsync();

      // (a) daemon received the payload with the alias value intact.
      const forwarded = daemonWs.sentStrings.find((s) => s.includes('"type":"session.send"'));
      expect(forwarded).toBeDefined();
      const parsed = JSON.parse(forwarded!) as { resolvedAliases?: Record<string, string> };
      expect(parsed.resolvedAliases).toEqual({ prod: secretValue });

      // (b) the alias value never appears in ANY server log line.
      const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls]
        .map((call) => String(call[0]))
        .join('\n');
      expect(allLogs).not.toContain(secretValue);
    });
  });

  // ── Helpers shared by subscription / binary tests ─────────────────────────

  async function setupAuth() {
    const bridge = WsBridge.get(serverId);
    const daemonWs = new MockWs();
    bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
    daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
    await flushAsync();
    return { bridge, daemonWs };
  }

  // ── Multi-browser ref counting ─────────────────────────────────────────────

  describe('per-session daemon subscription ref counting', () => {
    it('sends terminal.subscribe to daemon only on 0→1', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const b1 = new MockWs();
      const b2 = new MockWs();
      bridge.handleBrowserConnection(b1 as never);
      bridge.handleBrowserConnection(b2 as never);

      // First browser subscribes → 0→1, should forward to daemon
      const sentBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      b1.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess1' }));
      await flushAsync();
      const afterFirst = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      expect(afterFirst).toBe(sentBefore + 1);

      // Second browser subscribes same session → 1→2, must NOT forward again
      b2.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess1' }));
      await flushAsync();
      const afterSecond = daemonWs.sentStrings.filter((s) => s.includes('terminal.subscribe')).length;
      expect(afterSecond).toBe(sentBefore + 1); // no additional forward
    });

    it('sends terminal.unsubscribe to daemon only on 1→0', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const b1 = new MockWs();
      const b2 = new MockWs();
      bridge.handleBrowserConnection(b1 as never);
      bridge.handleBrowserConnection(b2 as never);

      b1.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess2' }));
      b2.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess2' }));
      await flushAsync();

      const unsubBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length;

      // First unsubscribe → 2→1, must NOT forward
      b1.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sess2' }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore);

      // Second unsubscribe → 1→0, must forward
      b2.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sess2' }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore + 1);
    });

    it('browser disconnect drives 1→0 and sends terminal.unsubscribe', async () => {
      const { daemonWs } = await setupAuth();
      const bridge = WsBridge.get(serverId);

      const b = new MockWs();
      bridge.handleBrowserConnection(b as never);
      b.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess3' }));
      await flushAsync();

      const unsubBefore = daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length;

      // Simulate browser disconnect
      b.emit('close');
      await flushAsync();

      expect(daemonWs.sentStrings.filter((s) => s.includes('terminal.unsubscribe')).length).toBe(unsubBefore + 1);
    });

    it('keeps same-mode resubscribe idempotent and forwards effective raw mode changes', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-mode', raw: false }));
      await flushAsync();
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-mode', raw: false }));
      await flushAsync();

      const initialSubscribes = daemonWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.subscribe'; } catch { return false; }
      });
      expect(initialSubscribes).toHaveLength(1);

      browserWs.sent.length = 0;
      daemonWs.emit('message', JSON.stringify({
        type: 'terminal_update',
        diff: { sessionName: 'sess-mode', rows: ['line-1'] },
      }));
      await flushAsync();
      expect(browserWs.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.diff'; } catch { return false; }
      })).toBe(true);

      browserWs.sent.length = 0;
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-mode', raw: true }));
      await flushAsync();

      const subscribesAfterUpgrade = daemonWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.subscribe'; } catch { return false; }
      });
      expect(subscribesAfterUpgrade).toHaveLength(2);
      expect(JSON.parse(subscribesAfterUpgrade[1]!)).toEqual({
        type: 'terminal.subscribe',
        session: 'sess-mode',
        raw: true,
      });

      browserWs.sent.length = 0;
      daemonWs.emit('message', packFrame('sess-mode', Buffer.from('abc')), true);
      await flushAsync();
      expect(browserWs.sent.some((s) => Buffer.isBuffer(s))).toBe(true);

      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-mode', raw: false }));
      await flushAsync();

      const subscribesAfterDowngrade = daemonWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.subscribe'; } catch { return false; }
      });
      expect(subscribesAfterDowngrade).toHaveLength(3);
      expect(JSON.parse(subscribesAfterDowngrade[2]!)).toEqual({
        type: 'terminal.subscribe',
        session: 'sess-mode',
        raw: false,
      });
    });

    it('forwards binary only to raw-enabled subscribers while text reaches all subscribers', async () => {
      const { daemonWs, bridge } = await setupAuth();

      const passive = new MockWs();
      const active = new MockWs();
      bridge.handleBrowserConnection(passive as never, 'passive-user', makeDb('valid-hash'));
      bridge.handleBrowserConnection(active as never, 'active-user', makeDb('valid-hash'));

      passive.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-bin', raw: false }));
      active.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-bin', raw: true }));
      await flushAsync();

      passive.sent.length = 0;
      active.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'terminal_update',
        diff: { sessionName: 'sess-bin', rows: ['text-line'] },
      }));
      await flushAsync();

      expect(passive.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.diff'; } catch { return false; }
      })).toBe(true);
      expect(active.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.diff'; } catch { return false; }
      })).toBe(true);

      passive.sent.length = 0;
      active.sent.length = 0;

      daemonWs.emit('message', packFrame('sess-bin', Buffer.from('raw-bytes')), true);
      await flushAsync();

      expect(passive.sent.some((s) => Buffer.isBuffer(s))).toBe(false);
      expect(active.sent.some((s) => Buffer.isBuffer(s))).toBe(true);
    });

    it('treats missing raw as raw-enabled for backward compatibility', async () => {
      const { daemonWs, bridge } = await setupAuth();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'legacy-user', makeDb('valid-hash'));

      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-legacy' }));
      await flushAsync();

      browserWs.sent.length = 0;
      daemonWs.emit('message', packFrame('sess-legacy', Buffer.from('legacy-raw')), true);
      await flushAsync();

      expect(browserWs.sent.some((s) => Buffer.isBuffer(s))).toBe(true);
    });

    it('ignores stale async subscribe results after a later unsubscribe wins', async () => {
      let resolveOwnership: ((value: Record<string, unknown> | null) => void) | null = null;
      const ownershipPending = new Promise<Record<string, unknown> | null>((resolve) => {
        resolveOwnership = resolve;
      });
      const delayedDb = {
        queryOne: async (sql: string) => {
          if (sql.includes('FROM servers')) return { token_hash: 'valid-hash' };
          if (sql.includes('FROM sessions')) return ownershipPending;
          return null;
        },
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;

      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, delayedDb, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', delayedDb);

      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-late', raw: true }));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sess-late' }));
      resolveOwnership?.({ name: 'owned' });
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string; session?: string }).type === 'terminal.subscribe' && (JSON.parse(s) as { type: string; session?: string }).session === 'sess-late'; } catch { return false; }
      })).toBe(false);

      daemonWs.emit('message', JSON.stringify({
        type: 'terminal_update',
        diff: { sessionName: 'sess-late', rows: ['late-line'] },
      }));
      await flushAsync();

      expect(browserWs.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.diff'; } catch { return false; }
      })).toBe(false);
    });
  });

  // ── bufferedBytes balance ──────────────────────────────────────────────────

  describe('TerminalForwardQueue bufferedBytes balance', () => {
    it('reclaims bytes after each successful send — no overflow after many frames', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess4' }));
      await flushAsync();

      // Send 600 frames × 1 KB each = 600 KB total dispatched.
      // QUEUE_MAX_BYTES = 512 KB. If bufferedBytes weren't reclaimed, this would overflow.
      // Since MockWs invokes the send callback synchronously (success), bytes are reclaimed immediately.
      const payload = Buffer.alloc(1024, 0x41); // 1 KB
      const frame = packFrame('sess4', payload);

      for (let i = 0; i < 600; i++) {
        daemonWs.emit('message', frame, true);
      }
      await flushAsync();

      // No stream_reset should have been sent to the browser
      const resets = browserWs.sentStrings.filter((s) => s.includes('stream_reset'));
      expect(resets).toHaveLength(0);

      // All 600 frames should have been forwarded as binary
      const binaryFrames = browserWs.sent.filter((s) => Buffer.isBuffer(s));
      expect(binaryFrames).toHaveLength(600);
    });
  });

  // ── Backpressure overflow keeps subscription alive ────────────────────────
  //
  // Regression: previously `handleQueueOverflow` called
  // `removeBrowserSessionSubscription` on every overflow. Heavy shell output
  // (or a slow browser socket) created a churn cycle:
  //   stdout flood → 1MB queue → overflow → server unsubscribes → daemon
  //   stops pipe-pane → client receives stream_reset → re-subscribes → daemon
  //   restarts pipe → flood begins again → overflow again …
  // Each cycle the client's `resetState` count climbed; once cooldown engaged
  // the terminal sat frozen until the user manually refreshed. The fix keeps
  // the subscription alive across overflow and only resets the per-(session,
  // ws) queue's accounting state. Tests below lock in that behavior.

  describe('backpressure overflow keeps subscription alive (no churn)', () => {
    /**
     * Simulate a slow / blocked browser socket: ws.send NEVER fires its
     * delivery callback, so `bufferedBytes` accumulates monotonically until
     * QUEUE_MAX_BYTES is exceeded. This is the realistic shape of a browser
     * that's stalled (tab backgrounded on mobile, transient backpressure on
     * the underlying TCP, etc.).
     */
    class StallingMockWs extends MockWs {
      override send(data: string | Buffer, _opts?: unknown, _callback?: (err?: Error) => void): void {
        if (this.closed) return;
        // Record the send but DO NOT invoke the callback — bufferedBytes
        // never gets reclaimed, eventually triggering overflow.
        this.sent.push(data);
      }
    }

    it('on overflow: sends terminal.stream_reset to browser but does NOT send terminal.unsubscribe to daemon', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const browserWs = new StallingMockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessOverflow' }));
      await flushAsync();
      // Drain the initial subscribe forwarded to the daemon so we can assert
      // on what arrives AFTER overflow.
      daemonWs.sent.length = 0;

      // Push >4 MB of binary frame data (well past 4 MB QUEUE_MAX_BYTES).
      // Because StallingMockWs never calls the send callback, bufferedBytes
      // monotonically climbs until overflow fires.
      const chunk = Buffer.alloc(64 * 1024, 0x42); // 64 KB per frame
      const frame = packFrame('sessOverflow', chunk);
      for (let i = 0; i < 80; i++) {
        daemonWs.emit('message', frame, true);
      }
      await flushAsync();

      // Browser must have received exactly one stream_reset (overflow signal).
      const resets = browserWs.sentStrings
        .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
        .filter((m): m is Record<string, unknown> => m?.type === 'terminal.stream_reset' && m.session === 'sessOverflow');
      expect(resets.length).toBeGreaterThanOrEqual(1);
      expect(resets[0]?.reason).toBe('backpressure');

      // Daemon must NOT have received terminal.unsubscribe — subscription
      // stays alive across the overflow event.
      const unsubs = daemonWs.sentStrings
        .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
        .filter((m): m is Record<string, unknown> => m?.type === 'terminal.unsubscribe' && m.session === 'sessOverflow');
      expect(unsubs).toHaveLength(0);

      // The bridge's internal subscription bookkeeping still has this
      // session at refs.totalRefs >= 1 (browser is still considered a
      // subscriber). Verifying through behavior: send a small frame from
      // the daemon and confirm a fresh queue forwards it without another
      // overflow event firing.
      const followupBrowser = new MockWs();
      bridge.handleBrowserConnection(followupBrowser as never, 'test-user', makeDb('valid-hash'));
      followupBrowser.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessOverflow' }));
      await flushAsync();

      const smallFrame = packFrame('sessOverflow', Buffer.alloc(64, 0x43));
      daemonWs.emit('message', smallFrame, true);
      await flushAsync();
      const followupBinary = followupBrowser.sent.filter((s) => Buffer.isBuffer(s));
      expect(followupBinary.length).toBeGreaterThanOrEqual(1);

      // Bridge ref-count for the session is still >= 1 (the stalled browser
      // remained subscribed; followupBrowser added a second ref). No
      // terminal.unsubscribe sent at any point in this scenario.
      const allUnsubsAfter = daemonWs.sentStrings
        .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
        .filter((m): m is Record<string, unknown> => m?.type === 'terminal.unsubscribe' && m.session === 'sessOverflow');
      expect(allUnsubsAfter).toHaveLength(0);
    });

    it('post-overflow: a fresh queue accepts new sends to the same browser', async () => {
      const { bridge, daemonWs } = await setupAuth();

      // Use a non-stalling browser this time. Force overflow by sending a
      // single >4 MB frame in one shot (the queue checks size before
      // dispatching to ws.send, so this directly exceeds QUEUE_MAX_BYTES).
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessFreshQueue' }));
      await flushAsync();
      browserWs.sent.length = 0;

      const huge = Buffer.alloc(4 * 1024 * 1024 + 100, 0x44); // > 4 MB
      const hugeFrame = packFrame('sessFreshQueue', huge);
      daemonWs.emit('message', hugeFrame, true);
      await flushAsync();

      const resets = browserWs.sentStrings.filter((s) => s.includes('"terminal.stream_reset"'));
      expect(resets.length).toBeGreaterThanOrEqual(1);

      // After overflow: subsequent normal-sized frame should still flow.
      // (Queue was reset, subscription is intact.)
      const normalFrame = packFrame('sessFreshQueue', Buffer.alloc(64, 0x45));
      daemonWs.emit('message', normalFrame, true);
      await flushAsync();

      const binarySent = browserWs.sent.filter((s) => Buffer.isBuffer(s));
      // The huge frame was DROPPED at overflow detection (never sent), but
      // the normal-sized one MUST flow because subscription is still alive.
      expect(binarySent.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Daemon reconnect subscription replay ──────────────────────────────────

  describe('daemon reconnect subscription replay', () => {
    it('replays active subscriptions to daemon after reconnect', async () => {
      const bridge = WsBridge.get(serverId);

      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessR' }));
      await flushAsync();

      // Daemon disconnects
      daemonWs1.emit('close');
      await flushAsync();

      // New daemon connects and authenticates
      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      daemonWs2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      // Bridge should have re-sent terminal.subscribe for sessR to the new daemon
      expect(daemonWs2.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string; session: string }).session === 'sessR'; } catch { return false; }
      })).toBe(true);
    });

    it('replays explicit raw=false for passive subscribers after reconnect', async () => {
      const bridge = WsBridge.get(serverId);

      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessPassive', raw: false }));
      await flushAsync();

      daemonWs1.emit('close');
      await flushAsync();

      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      daemonWs2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const replay = daemonWs2.sentStrings.map((s) => {
        try { return JSON.parse(s) as { type?: string; session?: string; raw?: boolean }; } catch { return null; }
      }).find((msg) => msg?.type === 'terminal.subscribe' && msg.session === 'sessPassive');

      expect(replay?.raw).toBe(false);
    });

    it('replays explicit raw mode after reconnect and ignores stale queued terminal unsubscribe', async () => {
      const bridge = WsBridge.get(serverId);

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessRaw', raw: false }));
      await flushAsync();
      browserWs.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sessRaw' }));
      await flushAsync();

      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const terminalMessages = daemonWs.sentStrings.flatMap((s) => {
        try {
          const parsed = JSON.parse(s) as { type?: string };
          return parsed.type === 'terminal.subscribe' || parsed.type === 'terminal.unsubscribe' ? [parsed] : [];
        } catch {
          return [];
        }
      });

      expect(terminalMessages).toHaveLength(0);
    });

    it('does not replay terminal.subscribe from offline queue (prevents duplicates)', async () => {
      const bridge = WsBridge.get(serverId);

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // Browser subscribes while daemon is offline → goes to queue
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessD' }));
      await flushAsync();

      // Daemon connects and authenticates
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      // Should send exactly ONE terminal.subscribe (from refs replay, not from queue replay)
      const subscribes = daemonWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'terminal.subscribe'; } catch { return false; }
      });
      expect(subscribes).toHaveLength(1);
    });
  });

  // ── Daemon disconnect notification ─────────────────────────────────────────

  describe('daemon disconnect broadcasts daemon.disconnected to browsers', () => {
    it('sends daemon.disconnected when daemon socket closes', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.sent.length = 0;

      // Daemon disconnects
      daemonWs.emit('close');
      await flushAsync();

      const disconnectMsg = browserWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'daemon.disconnected'; } catch { return false; }
      });
      expect(disconnectMsg).toBeDefined();
    });

    it('does NOT send daemon.disconnected when a replaced daemon closes', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // New daemon replaces old one (closes daemonWs1)
      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      browserWs.sent.length = 0;

      // Old daemon's close fires — but bridge.daemonWs is now daemonWs2, so guard prevents broadcast
      daemonWs1.emit('close');
      await flushAsync();

      const disconnectMsg = browserWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'daemon.disconnected'; } catch { return false; }
      });
      // The close of the replaced daemon should NOT trigger daemon.disconnected because
      // bridge.daemonWs !== daemonWs1 (it's already daemonWs2)
      expect(disconnectMsg).toBeUndefined();
    });

    it('sends daemon.reconnected after daemon re-authenticates', async () => {
      const bridge = WsBridge.get(serverId);

      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // Daemon disconnects
      daemonWs1.emit('close');
      await flushAsync();
      browserWs.sent.length = 0;

      // New daemon connects and authenticates
      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      daemonWs2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const reconnectMsg = browserWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'daemon.reconnected'; } catch { return false; }
      });
      expect(reconnectMsg).toBeDefined();
    });
  });

  // ── Daemon rapid reconnect (flapping) does not crash ────────────────────

  describe('daemon rapid reconnect (flapping) resilience', () => {
    it('survives 10 rapid daemon reconnects without crashing', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      for (let i = 0; i < 10; i++) {
        const dws = new MockWs();
        bridge.handleDaemonConnection(dws as never, makeDb('valid-hash'), {} as never);
        dws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
        await flushAsync();
        dws.emit('close');
        await flushAsync();
      }

      // Bridge is still functional — connect a final daemon and verify it works
      const finalDaemon = new MockWs();
      bridge.handleDaemonConnection(finalDaemon as never, makeDb('valid-hash'), {} as never);
      finalDaemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      expect(bridge.isAuthenticated).toBe(true);
      expect(bridge.browserCount).toBe(1);
    });

    it('browser receives daemon.reconnected after each reconnect cycle', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      let reconnectCount = 0;
      let disconnectCount = 0;

      for (let i = 0; i < 5; i++) {
        browserWs.sent.length = 0;
        const dws = new MockWs();
        bridge.handleDaemonConnection(dws as never, makeDb('valid-hash'), {} as never);
        dws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
        await flushAsync();

        reconnectCount += browserWs.sentStrings.filter((s) => {
          try { return (JSON.parse(s) as { type: string }).type === 'daemon.reconnected'; } catch { return false; }
        }).length;

        browserWs.sent.length = 0;
        dws.emit('close');
        await flushAsync();

        disconnectCount += browserWs.sentStrings.filter((s) => {
          try { return (JSON.parse(s) as { type: string }).type === 'daemon.disconnected'; } catch { return false; }
        }).length;
      }

      expect(reconnectCount).toBe(5);
      expect(disconnectCount).toBe(5);
    });

    it('preserves final subscription state while mixed storm traffic is in flight across reconnect', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      const daemonWs1 = new MockWs();
      bridge.handleDaemonConnection(daemonWs1 as never, makeDb('valid-hash'), {} as never);
      daemonWs1.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessStorm', raw: false }));
      await flushAsync();
      browserWs.emit('message', JSON.stringify({ type: 'terminal.unsubscribe', session: 'sessStorm' }));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessStorm', raw: true }));
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'sessStorm' }));
      browserWs.emit('message', JSON.stringify({ type: 'fs.ls', requestId: 'fs-storm', path: '/tmp' }));
      browserWs.emit('message', JSON.stringify({ type: 'fs.git_status', requestId: 'git-storm', path: '/tmp' }));
      browserWs.emit('message', JSON.stringify({ type: 'transport.list_models', requestId: 'models-storm', agentType: 'codex-sdk' }));
      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'sessStorm',
        requestId: 'hist-storm',
        limit: 10,
      }));
      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.REPLAY_REQUEST,
        sessionName: 'sessStorm',
        requestId: 'replay-storm',
        afterSeq: 0,
        epoch: 1,
      }));
      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.PAGE_REQUEST,
        sessionName: 'sessStorm',
        requestId: 'page-storm',
        limit: 10,
        cursor: { epoch: 1, beforeTs: 2, direction: 'older' },
      }));
      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.DETAIL_REQUEST,
        sessionName: 'sessStorm',
        requestId: 'detail-storm',
        detailId: 'td_synthetic',
        eventId: 'event-storm',
        fieldPath: 'payload.output',
        epoch: 1,
      }));
      browserWs.emit('message', JSON.stringify({
        type: 'session.send',
        session: 'sessStorm',
        text: 'interleaved storm send',
        commandId: 'cmd-storm',
      }));
      await flushAsync();

      const forwardedTypes = daemonWs1.sentStrings.flatMap((raw) => {
        try { return [(JSON.parse(raw) as { type?: string }).type]; } catch { return []; }
      });
      expect(forwardedTypes).toEqual(expect.arrayContaining([
        'terminal.subscribe',
        'terminal.unsubscribe',
        'chat.subscribe',
        'fs.ls',
        'fs.git_status',
        'transport.list_models',
        TIMELINE_MESSAGES.HISTORY_REQUEST,
        TIMELINE_MESSAGES.REPLAY_REQUEST,
        TIMELINE_MESSAGES.PAGE_REQUEST,
        TIMELINE_MESSAGES.DETAIL_REQUEST,
        'session.send',
      ]));

      daemonWs1.emit('message', JSON.stringify({ type: 'fs.ls_response', requestId: 'fs-storm', path: '/tmp', status: 'ok', entries: [] }));
      daemonWs1.emit('message', JSON.stringify({ type: 'fs.git_status_response', requestId: 'git-storm', path: '/tmp', status: 'ok', files: [] }));
      daemonWs1.emit('message', JSON.stringify({ type: 'command.ack', session: 'sessStorm', commandId: 'cmd-storm', status: 'accepted' }));
      daemonWs1.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'sessStorm',
        requestId: 'hist-storm',
        events: [{ eventId: 'event-storm', sessionId: 'sessStorm', ts: 1, type: 'tool.result', payload: { output: 'preview' } }],
        epoch: 1,
      }));
      await flushBridgeDataPlane();

      const browserTypes = browserWs.sentStrings.flatMap((raw) => {
        try { return [(JSON.parse(raw) as { type?: string }).type]; } catch { return []; }
      });
      expect(browserTypes).toEqual(expect.arrayContaining([
        'fs.ls_response',
        'fs.git_status_response',
        'command.ack',
        TIMELINE_MESSAGES.HISTORY,
      ]));

      daemonWs1.emit('close');
      await flushAsync();
      const daemonWs2 = new MockWs();
      bridge.handleDaemonConnection(daemonWs2 as never, makeDb('valid-hash'), {} as never);
      daemonWs2.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const terminalReplay = daemonWs2.sentStrings.flatMap((raw) => {
        try {
          const parsed = JSON.parse(raw) as { type?: string; session?: string; raw?: boolean };
          return parsed.type === 'terminal.subscribe' || parsed.type === 'terminal.unsubscribe' ? [parsed] : [];
        } catch {
          return [];
        }
      });
      expect(terminalReplay).toEqual([expect.objectContaining({
        type: 'terminal.subscribe',
        session: 'sessStorm',
        raw: true,
      })]);
    });

    it('rapid replace without auth does not crash or leak', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // Rapid daemon connections that never authenticate
      for (let i = 0; i < 20; i++) {
        const dws = new MockWs();
        bridge.handleDaemonConnection(dws as never, makeDb('valid-hash'), {} as never);
        // Don't send auth — immediately replaced by next iteration
      }

      // Final daemon authenticates successfully
      const finalDaemon = new MockWs();
      bridge.handleDaemonConnection(finalDaemon as never, makeDb('valid-hash'), {} as never);
      finalDaemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      expect(bridge.isAuthenticated).toBe(true);
    });
  });

  // ── Whitelist completeness ────────────────────────────────────────────────

  describe('browser→daemon whitelist completeness', () => {
    async function setupBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { daemonWs, browserWs };
    }

    it('forwards subsession.set_model to daemon', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'subsession.set_model', sessionName: 's', model: 'gpt-4' }));
      await flushAsync();
      expect(daemonWs.sentStrings.some((s) => s.includes('subsession.set_model'))).toBe(true);
    });

    it('forwards ask.answer to daemon', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      browserWs.emit('message', JSON.stringify({ type: 'ask.answer', sessionName: 's', answer: 'yes' }));
      await flushAsync();
      expect(daemonWs.sentStrings.some((s) => s.includes('ask.answer'))).toBe(true);
    });
  });

  // ── P0: session-scoped privacy routing ────────────────────────────────────
  // These tests verify that session-private messages (timeline history/replay,
  // notifications, tool state, command acks) are NEVER broadcast to browsers
  // subscribed to a different session.

  describe('session-scoped privacy routing (P0)', () => {
    /** Set up bridge with daemon + two browsers each subscribed to a different session */
    async function setupTwoBrowsers() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserA = new MockWs();
      const browserB = new MockWs();
      bridge.handleBrowserConnection(browserA as never, 'user-a', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browserB as never, 'user-b', makeDb('valid-hash'));

      browserA.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'session-a' }));
      browserB.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'session-b' }));
      await flushAsync();

      // Clear setup noise
      browserA.sent.length = 0;
      browserB.sent.length = 0;

      return { bridge, daemonWs, browserA, browserB };
    }

    const sessionScopedCases: Array<[string, Record<string, unknown>, string]> = [
      [TIMELINE_MESSAGES.HISTORY, { type: TIMELINE_MESSAGES.HISTORY, sessionName: 'session-a', events: [{ eventId: 'e1' }], epoch: 1 }, 'session-a'],
      [TIMELINE_MESSAGES.REPLAY, { type: TIMELINE_MESSAGES.REPLAY, sessionName: 'session-a', events: [], truncated: false, epoch: 1 }, 'session-a'],
      [TIMELINE_MESSAGES.EVENT, { type: TIMELINE_MESSAGES.EVENT, event: { sessionId: 'session-a', eventId: 'e2', type: 'test' } }, 'session-a'],
      ['transport.queue.snapshot', {
        type: 'transport.queue.snapshot',
        sessionName: 'session-a',
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        pendingMessageVersion: 1,
        pendingMessageEntries: [{
          clientMessageId: 'msg-1',
          text: 'line one\nline two',
          status: 'queued',
          placement: 'normal',
          ordinal: 0,
          createdAt: 100,
          updatedAt: 100,
        }],
        failedMessageEntries: [],
        source: 'server-test',
      }, 'session-a'],
      ['transport.queue.delivery', {
        type: 'transport.queue.delivery',
        sessionName: 'session-a',
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        pendingMessageVersion: 2,
        clientMessageId: 'msg-1',
        deliveryFrameId: 'frame-1',
        deliveryFrameVersion: 2,
      }, 'session-a'],
      ['transport.queue.failure', {
        type: 'transport.queue.failure',
        sessionName: 'session-a',
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        pendingMessageVersion: 3,
        clientMessageId: 'msg-2',
        dropReason: 'user_stopped',
      }, 'session-a'],
      ['transport.queue.reset', {
        type: 'transport.queue.reset',
        sessionName: 'session-a',
        queueEpoch: 'epoch-2',
        queueAuthorityId: 'authority-2',
        pendingMessageVersion: 1,
        resetReason: 'user_clear',
      }, 'session-a'],
      ['command.ack', { type: 'command.ack', session: 'session-a', commandId: 'c1', status: 'ok' }, 'session-a'],
      ['subsession.response', { type: 'subsession.response', sessionName: 'session-a', status: 'idle' }, 'session-a'],
      ['session.idle', { type: 'session.idle', session: 'session-a', project: 'p', agentType: 'claude-code' }, 'session-a'],
      ['session.notification', { type: 'session.notification', session: 'session-a', project: 'p', title: 't', message: 'm' }, 'session-a'],
      ['session.tool', { type: 'session.tool', session: 'session-a', tool: 'bash' }, 'session-a'],
    ];

    for (const [label, daemonMsg, targetSession] of sessionScopedCases) {
      it(`${label}: delivered only to ${targetSession} subscriber, not to other session`, async () => {
        const { daemonWs, browserA, browserB } = await setupTwoBrowsers();

        daemonWs.emit('message', JSON.stringify(daemonMsg));
        if (label === TIMELINE_MESSAGES.HISTORY || label === TIMELINE_MESSAGES.REPLAY) {
          await flushBridgeDataPlane();
        } else {
          await flushAsync();
        }

        // browserA (subscribed to session-a) must receive it
        expect(browserA.sentStrings.length).toBeGreaterThan(0);
        // browserB (subscribed to session-b) must NOT receive it — privacy violation
        expect(browserB.sentStrings.length).toBe(0);
      });
    }

    it('timeline.history for session-b is NOT delivered to session-a subscriber', async () => {
      const { daemonWs, browserA, browserB } = await setupTwoBrowsers();

      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY, sessionName: 'session-b', events: [{ secret: 'data' }], epoch: 1,
      }));
      await flushBridgeDataPlane();

      expect(browserA.sentStrings.length).toBe(0); // session-a browser must be silent
      expect(browserB.sentStrings.length).toBeGreaterThan(0);
    });

    it('invalid transport queue wire events are rejected instead of default-broadcast', async () => {
      const { daemonWs, browserA, browserB } = await setupTwoBrowsers();

      daemonWs.emit('message', JSON.stringify({
        type: 'transport.queue.snapshot',
        sessionName: 'session-a',
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        pendingMessageVersion: 1,
        pendingMessageEntries: [],
        failedMessageEntries: [],
        source: 'server-test',
        pendingCount: 1,
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'transport.queue.snapshot',
        sessionName: 'session-a',
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        pendingMessageVersion: 1,
        pendingMessageEntries: [{
          clientMessageId: 'msg-1',
          text: 'safe',
          status: 'queued',
          placement: 'normal',
          ordinal: 0,
          createdAt: 100,
          updatedAt: 100,
          messagePreamble: 'private',
        }],
        failedMessageEntries: [],
        source: 'server-test',
      }));
      await flushAsync();

      expect(browserA.sentStrings).toHaveLength(0);
      expect(browserB.sentStrings).toHaveLength(0);
    });

    it('server bridge remains relay-only and does not import queue SQLite authority', () => {
      const bridgeSource = readFileSync(new URL('../src/ws/bridge.ts', import.meta.url), 'utf8');

      expect(bridgeSource).not.toContain('transport-queue-store');
      expect(bridgeSource).not.toContain('transport-queue-projection');
      expect(bridgeSource).not.toContain('node:sqlite');
      expect(bridgeSource).not.toContain('transport-queue.sqlite');
    });

    it('session_event (lifecycle) is broadcast to all browsers', async () => {
      const { daemonWs, browserA, browserB } = await setupTwoBrowsers();

      daemonWs.emit('message', JSON.stringify({ type: 'session_event', event: 'started', session: 'session-a' }));
      await flushAsync();

      // session lifecycle events (connected/disconnected) are intentionally broadcast
      expect(browserA.sentStrings.length).toBeGreaterThan(0);
      expect(browserB.sentStrings.length).toBeGreaterThan(0);
    });

    it('timeline.event still reaches subscribers when text-tail cache write fails', async () => {
      const spy = vi.spyOn(dbQueries, 'upsertSessionTextTailCacheEvent').mockRejectedValueOnce(new Error('db down'));
      const { daemonWs, browserA, browserB } = await setupTwoBrowsers();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          sessionId: 'session-a',
          eventId: 'tail-fail-1',
          ts: 123,
          type: 'assistant.text',
          payload: { text: 'still delivered' },
        },
      }));
      await flushAsync();

      expect(browserA.sentStrings.some((msg) => msg.includes('tail-fail-1'))).toBe(true);
      expect(browserB.sentStrings.length).toBe(0);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ── P0: default-deny — missing session identifier → discard, NOT broadcast ─
  // These tests verify the "fail-closed" routing policy:
  // any session-scoped message that omits its session identifier must be
  // silently discarded, never broadcast to unrelated browsers.

  describe('default-deny: missing session ID → discard, not broadcast (P0)', () => {
    async function setupBrowserNoSub() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      // Intentionally NOT subscribed to any session
      return { daemonWs, browserWs };
    }

    it('terminal_update without sessionName in diff → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'terminal_update', diff: { rows: [] } }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('command.ack without session → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'command.ack', commandId: 'c1', status: 'ok' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('subsession.response without sessionName → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'subsession.response', status: 'idle' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('timeline.history without sessionName → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'timeline.history', events: [{ secret: 'data' }] }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('timeline.replay without sessionName → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'timeline.replay', events: [], truncated: false }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('timeline.event without sessionId in event → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'timeline.event', event: { type: 'assistant.text' } }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('session.idle without session → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'session.idle' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('session.notification without session → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'session.notification', title: 'done' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('session.tool without session → discarded, not broadcast', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'session.tool', tool: 'bash' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('unknown message type → broadcast to all browsers (default-allow)', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      daemonWs.emit('message', JSON.stringify({ type: 'future.unknown.type', data: 'secret' }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(1);
      expect(JSON.parse(browserWs.sentStrings[0]).type).toBe('future.unknown.type');
    });

    it('session_list → broadcast to all browsers (whitelist)', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const b1 = new MockWs();
      const b2 = new MockWs();
      bridge.handleBrowserConnection(b1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(b2 as never, 'user-2', makeDb('valid-hash'));

      daemonWs.emit('message', JSON.stringify({ type: 'session_list', sessions: [] }));
      await flushAsync();

      expect(b1.sentStrings.length).toBeGreaterThan(0);
      expect(b2.sentStrings.length).toBeGreaterThan(0);
      expect(JSON.parse(b1.sentStrings[0]).type).toBe('session_list');
    });

    it('terminal_update for wrong session → not delivered to unsubscribed browser', async () => {
      const { daemonWs, browserWs } = await setupBrowserNoSub();
      // browser is not subscribed to any session
      daemonWs.emit('message', JSON.stringify({
        type: 'terminal_update', diff: { sessionName: 'other-session', rows: [] },
      }));
      await flushAsync();
      expect(browserWs.sentStrings).toHaveLength(0);
    });
  });

  // ── Repo message relay ──────────────────────────────────────────────────────

  describe('repo message relay', () => {
    async function setupBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { bridge, daemonWs, browserWs };
    }

    it('repo.detect from browser reaches daemon (not rate-limited)', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      // Send many repo.detect messages — they should not be rate-limited
      for (let i = 0; i < 35; i++) {
        browserWs.emit('message', JSON.stringify({
          type: 'repo.detect',
          requestId: `detect-${i}`,
          projectDir: '/home/user/myproject',
        }));
      }
      await flushAsync();

      // All 35 should have reached the daemon (repo.detect is rate-limit exempt)
      const detectMessages = daemonWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'repo.detect'; } catch { return false; }
      });
      expect(detectMessages).toHaveLength(35);
    });

    it('repo.detect_response from daemon reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.detect_response',
        requestId: 'req-1',
        projectDir: '/home/user/myproject',
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets' },
        cliVersion: '2.50.0',
        cliAuth: true,
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.detect_response');
      expect(msg.requestId).toBe('req-1');
      expect(msg.status).toBe('ok');
      expect(msg.info.platform).toBe('github');
    });

    it('repo.error from daemon reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.error',
        requestId: 'req-2',
        error: 'gh CLI not found',
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.error');
      expect(msg.error).toBe('gh CLI not found');
    });

    it('repo.detected (push) from daemon reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.detected',
        projectDir: '/home/user/myproject',
        context: {
          status: 'ok',
          info: { platform: 'github', owner: 'acme', repo: 'widgets' },
        },
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.detected');
      expect(msg.projectDir).toBe('/home/user/myproject');
      expect(msg.context.status).toBe('ok');
    });

    it('repo.issues_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.issues_response',
        requestId: 'req-issues',
        projectDir: '/home/user/myproject',
        items: [{ number: 1, title: 'Bug', state: 'open' }],
        page: 1,
        hasMore: false,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.issues_response');
      expect(msg.items).toHaveLength(1);
      expect(msg.items[0].title).toBe('Bug');
    });

    it('repo.prs_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.prs_response',
        requestId: 'req-prs',
        projectDir: '/home/user/myproject',
        items: [{ number: 10, title: 'Feature PR', state: 'open' }],
        page: 1,
        hasMore: true,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.prs_response');
      expect(msg.items[0].title).toBe('Feature PR');
      expect(msg.hasMore).toBe(true);
    });

    it('repo.branches_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.branches_response',
        requestId: 'req-branches',
        projectDir: '/home/user/myproject',
        items: [{ name: 'main', current: true }, { name: 'dev', current: false }],
        page: 1,
        hasMore: false,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.branches_response');
      expect(msg.items).toHaveLength(2);
    });

    it('repo.commits_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.commits_response',
        requestId: 'req-commits',
        projectDir: '/home/user/myproject',
        items: [{ sha: 'abc123', message: 'initial commit' }],
        page: 1,
        hasMore: false,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('repo.commits_response');
      expect(msg.items[0].sha).toBe('abc123');
    });

    it('repo.checkout_branch_response reaches browser', async () => {
      const { daemonWs, browserWs } = await setupBridge();

      daemonWs.emit('message', JSON.stringify({
        type: REPO_MSG.CHECKOUT_BRANCH_RESPONSE,
        requestId: 'req-checkout',
        projectDir: '/home/user/myproject',
        ok: true,
        previousBranch: 'main',
        currentBranch: 'dev',
        repoGeneration: 2,
        detectedAt: 123456,
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe(REPO_MSG.CHECKOUT_BRANCH_RESPONSE);
      expect(msg.previousBranch).toBe('main');
      expect(msg.currentBranch).toBe('dev');
      expect(msg.repoGeneration).toBe(2);
    });

    it('repo messages are broadcast to all connected browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));

      daemonWs.emit('message', JSON.stringify({
        type: 'repo.detect_response',
        requestId: 'req-bc',
        projectDir: '/proj',
        status: 'ok',
        info: { platform: 'github', owner: 'x', repo: 'y' },
      }));
      await flushAsync();

      // Both browsers should receive the message
      expect(browser1.sentStrings.length).toBeGreaterThan(0);
      expect(browser2.sentStrings.length).toBeGreaterThan(0);
      expect(JSON.parse(browser1.sentStrings[0]).type).toBe('repo.detect_response');
      expect(JSON.parse(browser2.sentStrings[0]).type).toBe('repo.detect_response');
    });
  });

  // ── Sub-session sync + P2P conflict relay ─────────────────────────────────

  describe('sub-session sync and P2P conflict relay', () => {
    async function setupAuthBridge(db = makeDb('valid-hash')) {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', db);
      browserWs.sent.length = 0;

      return { bridge, daemonWs, browserWs };
    }

    it('subsession.sync from daemon → persists to DB + broadcasts subsession.created to browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync',
        id: 'sub-123',
        sessionType: 'claude-code',
        shellBin: '/bin/bash',
        cwd: '/home/user/project',
        label: 'worker-1',
        ccSessionId: 'cc-abc',
        parentSession: 'deck_myapp_brain',
        requestedModel: 'sonnet',
        activeModel: 'sonnet',
        effort: 'high',
        transportConfig: { provider: { mode: 'safe' } },
        queueSnapshot: {
          type: 'transport.queue.snapshot',
          sessionName: 'deck_sub_sub-123',
          queueEpoch: 'epoch-sub',
          queueAuthorityId: 'authority-sub',
          pendingMessageVersion: 7,
          pendingMessageEntries: [{
            clientMessageId: 'msg-sub',
            text: 'queued',
            status: 'queued',
            placement: 'normal',
            ordinal: 0,
            createdAt: 100,
            updatedAt: 100,
          }],
          failedMessageEntries: [],
          source: 'subsession_sync',
        },
        queueEpoch: 'epoch-sub',
        queueAuthorityId: 'authority-sub',
        pendingMessageVersion: 7,
        pendingMessageEntries: [{
          clientMessageId: 'msg-sub',
          text: 'queued',
          status: 'queued',
          placement: 'normal',
          ordinal: 0,
          createdAt: 100,
          updatedAt: 100,
        }],
        failedMessageEntries: [],
        transportPendingMessages: [],
        transportPendingMessageEntries: [],
        transportPendingMessageVersion: 7,
        pendingCount: 1,
      }));
      await flushAsync();

      // Browser should receive subsession.created broadcast
      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('subsession.created');
      expect(msg.id).toBe('sub-123');
      expect(msg.sessionName).toBe('deck_sub_sub-123');
      expect(msg.sessionType).toBe('claude-code');
      expect(msg.cwd).toBe('/home/user/project');
      expect(msg.label).toBe('worker-1');
      expect(msg.parentSession).toBe('deck_myapp_brain');
      expect(msg.requestedModel).toBe('sonnet');
      expect(msg.activeModel).toBe('sonnet');
      expect(msg.effort).toBe('high');
      expect(msg.transportConfig).toEqual({ provider: { mode: 'safe' } });
      expect(msg.queueSnapshot).toMatchObject({
        type: 'transport.queue.snapshot',
        sessionName: 'deck_sub_sub-123',
        queueEpoch: 'epoch-sub',
        queueAuthorityId: 'authority-sub',
        pendingMessageVersion: 7,
      });
      expect(msg.queueEpoch).toBe('epoch-sub');
      expect(msg.queueAuthorityId).toBe('authority-sub');
      expect(msg.pendingMessageVersion).toBe(7);
      expect(msg.pendingMessageEntries).toEqual([expect.objectContaining({ clientMessageId: 'msg-sub', text: 'queued' })]);
      expect(msg.failedMessageEntries).toEqual([]);
      expect(msg.transportPendingMessages).toBeUndefined();
      expect(msg.transportPendingMessageEntries).toBeUndefined();
      expect(msg.transportPendingMessageVersion).toBeUndefined();
      expect(msg.pendingCount).toBeUndefined();
      expect(msg.state).toBe('idle');
    });

    it('projects execution clone discriminants to browsers without leaking full metadata', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync',
        id: 'clone-123',
        sessionType: 'codex-sdk',
        cwd: '/home/user/project',
        label: 'clone-worker',
        parentSession: 'deck_myapp_brain',
        executionCloneMetadata: {
          kind: EXECUTION_CLONE_KIND,
          parentRunId: 'run-clone-parent',
          sourceTemplateSessionName: 'deck_sub_template',
          createdBySessionName: 'deck_myapp_brain',
        },
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('subsession.created');
      expect(msg.id).toBe('clone-123');
      expect(msg.executionCloneKind).toBe(EXECUTION_CLONE_KIND);
      expect(msg.parentRunId).toBe('run-clone-parent');
      expect(msg.executionCloneMetadata).toBeUndefined();
      expect(msg.sourceTemplateSessionName).toBeUndefined();
      expect(msg.createdBySessionName).toBeUndefined();
    });

    it('infers transport runtime for sdk subsession.sync payloads that omit runtimeType', async () => {
      const executeCalls: unknown[][] = [];
      const db = makeDb('valid-hash') as unknown as {
        execute: (sql: string, params: unknown[]) => Promise<{ changes: number }>;
      };
      db.execute = async (_sql: string, params: unknown[]) => {
        executeCalls.push(params);
        return { changes: 1 };
      };
      const { daemonWs, browserWs } = await setupAuthBridge(db as never);

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync',
        id: 'sdk-no-runtime',
        sessionType: 'claude-code-sdk',
        shellBin: null,
        cwd: '/home/user/project',
        label: 'sdk worker',
        parentSession: 'deck_myapp_brain',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('subsession.created');
      expect(msg.sessionName).toBe('deck_sub_sdk-no-runtime');
      expect(msg.sessionType).toBe('claude-code-sdk');
      expect(msg.runtimeType).toBe('transport');
      const createSubSessionCall = executeCalls.find((params) => params[0] === 'sdk-no-runtime');
      expect(createSubSessionCall?.[9]).toBe('transport');
    });

    it('ignores leaked test subsession.sync payloads', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync',
        id: 'ignored-sub',
        sessionType: 'codex-sdk',
        cwd: '/tmp/cxsdk-sub-e2e',
        parentSession: 'deck_bootmainabc123_brain',
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('subsession.closed from daemon → updates DB + broadcasts subsession.removed to browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.closed',
        id: 'sub-456',
        sessionName: 'deck_sub_sub-456',
      }));
      await flushAsync();

      // Browser should receive subsession.removed broadcast
      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('subsession.removed');
      expect(msg.id).toBe('sub-456');
      expect(msg.sessionName).toBe('deck_sub_sub-456');
    });

    it('subsession.closed does not broadcast removal when DB persistence fails', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      const failingDb = {
        ...makeDb('valid-hash'),
        execute: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('UPDATE sub_sessions SET closed_at')) {
            throw new Error('db write failed');
          }
          return { changes: 1 };
        }),
      } as unknown as import('../src/db/client.js').Database;
      bridge.handleDaemonConnection(daemonWs as never, failingDb, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', failingDb);
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.closed',
        id: 'sub-456',
        sessionName: 'deck_sub_sub-456',
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('subsession.closed without id → no broadcast', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.closed',
        // no id
        sessionName: 'deck_sub_missing',
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('subsession.closed clears only the matching descendant cache while preserving other sub-sessions', async () => {
      const { bridge, daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'sub-a-1',
          sessionId: 'deck_sub_alpha',
          ts: 1,
          type: 'assistant.text',
          payload: { text: 'alpha text' },
        },
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'sub-b-1',
          sessionId: 'deck_sub_beta',
          ts: 2,
          type: 'assistant.text',
          payload: { text: 'beta text' },
        },
      }));
      await flushAsync();
      expect(bridge.getRecentText('deck_sub_alpha')).toHaveLength(1);
      expect(bridge.getRecentText('deck_sub_beta')).toHaveLength(1);

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.closed',
        id: 'alpha',
        sessionName: 'deck_sub_alpha',
      }));
      await flushAsync();

      expect(bridge.getRecentText('deck_sub_alpha')).toHaveLength(0);
      expect(bridge.getRecentText('deck_sub_beta')).toHaveLength(1);
      const msg = JSON.parse(browserWs.sentStrings.at(-1) ?? '{}');
      expect(msg).toMatchObject({ type: 'subsession.removed', id: 'alpha', sessionName: 'deck_sub_alpha' });
    });

    it('p2p.conflict from daemon → broadcasts to all browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));
      browser1.sent.length = 0;
      browser2.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'p2p.conflict',
        topic: 'review code',
        existingRunId: 'run-old',
      }));
      await flushAsync();

      // Both browsers should receive the p2p.conflict message
      expect(browser1.sentStrings.length).toBeGreaterThan(0);
      expect(browser2.sentStrings.length).toBeGreaterThan(0);
      const msg1 = JSON.parse(browser1.sentStrings[0]);
      const msg2 = JSON.parse(browser2.sentStrings[0]);
      expect(msg1.type).toBe('p2p.conflict');
      expect(msg1.topic).toBe('review code');
      expect(msg2.type).toBe('p2p.conflict');
    });

    it('p2p.conflict is not session-scoped — reaches unsubscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      // browserWs is not subscribed to any session

      daemonWs.emit('message', JSON.stringify({
        type: 'p2p.conflict',
        topic: 'refactor',
        existingRunId: 'run-x',
      }));
      await flushAsync();

      expect(browserWs.sentStrings.length).toBeGreaterThan(0);
      expect(JSON.parse(browserWs.sentStrings[0]).type).toBe('p2p.conflict');
    });

    it('drops unknown p2p messages from daemon instead of broadcasting', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'p2p.future_secret',
        rawPrompt: 'do not leak',
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('requires valid requestId before forwarding request-scoped p2p browser messages', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.STATUS,
        requestId: 'é',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((raw) => JSON.parse(raw).type === P2P_WORKFLOW_MSG.STATUS)).toBe(false);
      expect(browserWs.sentStrings.some((raw) => JSON.parse(raw).code === P2P_BRIDGE_ERROR_CODES.INVALID_REQUEST_ID)).toBe(true);
    });

    it('rejects browser p2p messages that are daemon-only or responses', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.RUN_UPDATE,
        run: { rawPrompt: 'do not forward' },
      }));
      browserWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
        requestId: 'p2p-response-from-browser',
        runs: [],
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((raw) => JSON.parse(raw).type === P2P_WORKFLOW_MSG.RUN_UPDATE)).toBe(false);
      expect(daemonWs.sentStrings.some((raw) => JSON.parse(raw).type === P2P_WORKFLOW_MSG.STATUS_RESPONSE)).toBe(false);
      expect(browserWs.sentStrings.filter((raw) => JSON.parse(raw).code === P2P_BRIDGE_ERROR_CODES.WRONG_PEER)).toHaveLength(2);
    });

    it('single-casts request-scoped p2p responses to the pending requester only', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));

      browser1.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.READ_DISCUSSION,
        requestId: 'p2p-read-1',
        id: 'discussion-1',
      }));
      await flushAsync();
      browser1.sent.length = 0;
      browser2.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
        requestId: 'p2p-read-1',
        id: 'discussion-1',
        content: 'private discussion',
      }));
      await flushAsync();

      expect(browser1.sentStrings).toHaveLength(1);
      expect(browser2.sentStrings).toHaveLength(0);
      expect(JSON.parse(browser1.sentStrings[0])).toMatchObject({
        type: P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE,
        requestId: 'p2p-read-1',
      });
    });

    it('drops mismatched p2p response types without clearing the pending request', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      browserWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.STATUS,
        requestId: 'p2p-status-1',
      }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE,
        requestId: 'p2p-status-1',
        discussions: [],
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);

      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
        requestId: 'p2p-status-1',
        runs: [],
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(1);
      expect(JSON.parse(browserWs.sentStrings[0]).type).toBe(P2P_WORKFLOW_MSG.STATUS_RESPONSE);
    });

    it('rejects duplicate active p2p requestIds without replacing the original requester', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));

      browser1.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.STATUS,
        requestId: 'p2p-duplicate-1',
      }));
      browser2.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.STATUS,
        requestId: 'p2p-duplicate-1',
      }));
      await flushAsync();

      expect(browser2.sentStrings.some((raw) => JSON.parse(raw).code === P2P_BRIDGE_ERROR_CODES.DUPLICATE_REQUEST_ID)).toBe(true);
      browser1.sent.length = 0;
      browser2.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
        requestId: 'p2p-duplicate-1',
        runs: [],
      }));
      await flushAsync();

      expect(browser1.sentStrings).toHaveLength(1);
      expect(browser2.sentStrings).toHaveLength(0);
    });

    it('drops request-scoped p2p responses without a pending requester', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE,
        requestId: 'p2p-missing',
        discussions: [],
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('enforces per-socket pending caps before forwarding p2p requests', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      daemonWs.sent.length = 0;

      for (let i = 0; i < P2P_BRIDGE_PENDING_REQUESTS_PER_SOCKET + 1; i += 1) {
        browserWs.emit('message', JSON.stringify({
          type: P2P_WORKFLOW_MSG.STATUS,
          requestId: `p2p-cap-${i}`,
        }));
      }
      await flushAsync();

      const forwarded = daemonWs.sentStrings
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === P2P_WORKFLOW_MSG.STATUS);
      expect(forwarded).toHaveLength(P2P_BRIDGE_PENDING_REQUESTS_PER_SOCKET);
      expect(browserWs.sentStrings.some((raw) => JSON.parse(raw).code === P2P_BRIDGE_ERROR_CODES.PENDING_LIMIT_EXCEEDED)).toBe(true);
    });

    it('enforces the global pending cap before forwarding p2p requests', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      daemonWs.sent.length = 0;

      const socketCount = Math.ceil(P2P_BRIDGE_PENDING_REQUESTS_GLOBAL / P2P_BRIDGE_PENDING_REQUESTS_PER_SOCKET);
      for (let socketIndex = 0; socketIndex < socketCount; socketIndex += 1) {
        const browserWs = new MockWs();
        bridge.handleBrowserConnection(browserWs as never, `user-${socketIndex}`, makeDb('valid-hash'));
        browserWs.sent.length = 0;
        for (let requestIndex = 0; requestIndex < P2P_BRIDGE_PENDING_REQUESTS_PER_SOCKET; requestIndex += 1) {
          browserWs.emit('message', JSON.stringify({
            type: P2P_WORKFLOW_MSG.STATUS,
            requestId: `p2p-global-${socketIndex}-${requestIndex}`,
          }));
        }
      }
      await flushAsync();

      const extraBrowser = new MockWs();
      bridge.handleBrowserConnection(extraBrowser as never, 'user-extra', makeDb('valid-hash'));
      extraBrowser.sent.length = 0;
      extraBrowser.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.STATUS,
        requestId: 'p2p-global-overflow',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === P2P_WORKFLOW_MSG.STATUS);
      expect(forwarded).toHaveLength(P2P_BRIDGE_PENDING_REQUESTS_GLOBAL);
      expect(extraBrowser.sentStrings.some((raw) => {
        const msg = JSON.parse(raw);
        return msg.code === P2P_BRIDGE_ERROR_CODES.PENDING_LIMIT_EXCEEDED && msg.scope === 'global';
      })).toBe(true);
    });

    it('handles p2p.run_complete and p2p.run_error as registered daemon messages', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.RUN_COMPLETE,
        run: { id: 'run-complete', status: 'running', mode_key: 'audit' },
      }));
      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.RUN_ERROR,
        run: { id: 'run-error', status: 'failed', mode_key: 'audit', error: 'failed' },
      }));
      await flushAsync();

      const updates = browserWs.sentStrings.map((raw) => JSON.parse(raw));
      expect(updates.filter((msg) => msg.type === P2P_WORKFLOW_MSG.RUN_UPDATE)).toHaveLength(2);
      expect(updates.find((msg) => msg.run.id === 'run-complete')?.run.status).toBe('completed');
      expect(updates.find((msg) => msg.run.id === 'run-error')?.run.error).toBe('failed');
    });

    it('writes the same diagnostic code set to DB upsert and to the browser broadcast', async () => {
      // Regression for PR-D: the canonical sanitize result must be shared
      // between the DB-bound `upsertOrchestrationRun` payload and the
      // broadcast payload so the diagnostic code set the browser sees is
      // byte-identical to what the DB row records.
      const upsertSpy = vi.spyOn(dbQueries, 'upsertOrchestrationRun').mockResolvedValue();
      try {
        const { daemonWs, browserWs } = await setupAuthBridge();

        // Force the bridge into the truncation branch via oversized routing_history.
        const oversized = 'x'.repeat(P2P_SANITIZE_MAX_STRING_BYTES + 100);
        daemonWs.emit('message', JSON.stringify({
          type: P2P_WORKFLOW_MSG.RUN_SAVE,
          run: {
            id: 'run-parity',
            discussion_id: 'disc-1',
            mode_key: 'audit',
            status: 'running',
            diagnostics: [
              { code: 'daemon_busy', phase: 'bind', severity: 'error', summary: 'busy' },
              { code: 'missing_required_capability', phase: 'execute', summary: 'missing cap' },
            ],
            routing_history: Array.from({ length: 80 }, (_, idx) => ({
              step: idx,
              nested: { value: oversized },
            })),
          },
        }));
        await flushAsync();

        expect(upsertSpy).toHaveBeenCalledTimes(1);
        const persistedArg = upsertSpy.mock.calls[0]?.[1] as {
          progress_snapshot: string;
          workflow_projection: { diagnostics: Array<{ code: string }> };
        };
        const persistedSnap = JSON.parse(persistedArg.progress_snapshot) as {
          diagnostics: Array<{ code: string }>;
        };

        const broadcasts = browserWs.sentStrings
          .map((raw) => JSON.parse(raw))
          .filter((msg) => msg.type === P2P_WORKFLOW_MSG.RUN_UPDATE);
        expect(broadcasts).toHaveLength(1);
        const broadcastDiagnostics = broadcasts[0].run.workflow_projection.diagnostics as Array<{ code: string }>;

        const persistedCodes = [...persistedArg.workflow_projection.diagnostics.map((d) => d.code)].sort();
        const persistedSnapCodes = [...persistedSnap.diagnostics.map((d) => d.code)].sort();
        const broadcastCodes = [...broadcastDiagnostics.map((d) => d.code)].sort();

        expect(broadcastCodes).toEqual(persistedCodes);
        expect(broadcastCodes).toEqual(persistedSnapCodes);
        expect(broadcastCodes).toContain('daemon_busy');
        expect(broadcastCodes).toContain('missing_required_capability');
        expect(broadcastCodes).toContain('private_projection_field_dropped');
      } finally {
        upsertSpy.mockRestore();
      }
    });

    it('caches daemon.hello capabilities and clears stale/disconnected snapshots', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: [P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1, P2P_WORKFLOW_CAPABILITY_V1, TIMELINE_PROTOCOL_CAPABILITY],
        timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
        timelineProtocolRevision: TIMELINE_PROTOCOL_REVISION,
        helloEpoch: 2,
        sentAt: 123,
      }));
      await flushAsync();

      expect(bridge.getDaemonP2pWorkflowCapabilities()?.capabilities).toEqual([
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
        P2P_WORKFLOW_CAPABILITY_V1,
        TIMELINE_PROTOCOL_CAPABILITY,
      ].sort());
      expect(bridge.getDaemonP2pWorkflowCapabilities()?.timelineProtocolRevision).toBe(TIMELINE_PROTOCOL_REVISION);
      expect(bridge.getDaemonP2pWorkflowCapabilities(Date.now() + P2P_CAPABILITY_FRESHNESS_TTL_MS + 1)).toBeNull();

      daemonWs.close();
      await flushAsync();

      expect(bridge.getDaemonP2pWorkflowCapabilities()).toBeNull();
    });

    /*
     * R3 v2 PR-σ — User feedback: "daemon 是正常的 一直报失联". The
     * daemon only sends `daemon.hello` on (a) WS connect/reconnect and
     * (b) capability change. The bridge forwarded each as it arrived
     * but never replayed cached state, so any browser that opened
     * AFTER the daemon's most recent hello never received one and its
     * 30 s `capability_stale` TTL fired as a false-positive
     * "lost contact with the daemon" banner — even though the daemon
     * was healthy. The bridge now replays the cached hello to every
     * newly-connected browser so the capability picture is consistent
     * across late-joiners.
     */
    it('R3 v2 PR-σ — replays cached daemon.hello to a browser that connects AFTER the daemon hello arrived', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      // Daemon publishes capabilities BEFORE any browser connects.
      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: [P2P_WORKFLOW_CAPABILITY_V1, TIMELINE_PROTOCOL_CAPABILITY],
        timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
        timelineProtocolRevision: TIMELINE_PROTOCOL_REVISION,
        helloEpoch: 1,
        sentAt: 555,
      }));
      await flushAsync();

      // Now a browser connects — it must receive the cached hello as
      // an opening message.
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'late-user', makeDb('valid-hash'));
      await flushAsync();

      const helloMessages = browserWs.sentStrings
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === P2P_WORKFLOW_MSG.DAEMON_HELLO);
      expect(helloMessages).toHaveLength(1);
      expect(helloMessages[0]).toMatchObject({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: [P2P_WORKFLOW_CAPABILITY_V1, TIMELINE_PROTOCOL_CAPABILITY].sort(),
        timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
        timelineProtocolRevision: TIMELINE_PROTOCOL_REVISION,
        helloEpoch: 1,
        sentAt: 555,
      });
    });

    it('R3 v2 PR-σ — does NOT replay daemon.hello when no daemon is connected yet', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'first-user', makeDb('valid-hash'));
      await flushAsync();

      const helloMessages = browserWs.sentStrings
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === P2P_WORKFLOW_MSG.DAEMON_HELLO);
      expect(helloMessages).toHaveLength(0);
    });

    it('forwards p2p.config.save from browser to daemon and registers a pending response', async () => {
      // PR-E: p2p.config.save must be registered alongside workflow messages
      // so the bridge default-deny no longer drops it. The browser ingress
      // forwards via the generic forward_to_daemon path, and a pending entry
      // is created so the SAVE_RESPONSE can be singlecast back.
      const { daemonWs, browserWs } = await setupAuthBridge();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: P2P_CONFIG_MSG.SAVE,
        requestId: 'p2p-config-save-1',
        scopeSession: 'deck_demo_brain',
        config: { participants: [] },
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === P2P_CONFIG_MSG.SAVE);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({
        type: P2P_CONFIG_MSG.SAVE,
        requestId: 'p2p-config-save-1',
        scopeSession: 'deck_demo_brain',
      });
      // Browser must not receive any error code (route policy / wrong peer / unknown).
      expect(browserWs.sentStrings.some((raw) => 'code' in JSON.parse(raw))).toBe(false);
    });

    it('singlecasts p2p.config.save_response to the requesting browser only', async () => {
      // PR-E: SAVE_RESPONSE flows through the generic singlecast_response
      // handler — only the browser that registered the requestId receives it.
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));

      browser1.emit('message', JSON.stringify({
        type: P2P_CONFIG_MSG.SAVE,
        requestId: 'p2p-config-save-singlecast',
        scopeSession: 'deck_demo_brain',
        config: { participants: [] },
      }));
      await flushAsync();
      browser1.sent.length = 0;
      browser2.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: P2P_CONFIG_MSG.SAVE_RESPONSE,
        requestId: 'p2p-config-save-singlecast',
        scopeSession: 'deck_demo_brain',
        ok: true,
      }));
      await flushAsync();

      expect(browser1.sentStrings).toHaveLength(1);
      expect(browser2.sentStrings).toHaveLength(0);
      expect(JSON.parse(browser1.sentStrings[0])).toMatchObject({
        type: P2P_CONFIG_MSG.SAVE_RESPONSE,
        requestId: 'p2p-config-save-singlecast',
        ok: true,
      });
    });

    it('keeps unknown p2p.* messages dropped after registering p2p.config.*', async () => {
      // Default-deny safeguard: registering p2p.config.* must NOT widen the
      // bridge to forward arbitrary p2p.* messages. Any unregistered p2p.*
      // type from the daemon still drops, no broadcast.
      const { daemonWs, browserWs } = await setupAuthBridge();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'p2p.future_secret',
        rawPrompt: 'do not leak',
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'p2p.config.future_secret',
        scopeSession: 'deck_demo_brain',
        ok: true,
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('default-denies unknown OpenSpec Auto Deliver namespace messages from browser and daemon', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      daemonWs.sent.length = 0;
      browserWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: 'openspec_auto_deliver.future_secret',
        requestId: 'auto-unknown-browser',
        rawPrompt: 'do not leak',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((raw) => raw.includes('openspec_auto_deliver.future_secret'))).toBe(false);
      expect(browserWs.sentStrings.some((raw) => {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        return msg.type === 'error'
          && msg.code === 'unknown_openspec_auto_deliver_type'
          && msg.originalType === 'openspec_auto_deliver.future_secret'
          && msg.requestId === 'auto-unknown-browser';
      })).toBe(true);

      browserWs.sent.length = 0;
      daemonWs.emit('message', JSON.stringify({
        type: 'openspec_auto_deliver.future_secret',
        projection: {
          runId: 'run-secret',
          changeName: 'change-secret',
          owningMainSessionName: 'deck_proj_brain',
          projectionVersion: 1,
          generation: 1,
          rawPrompt: 'do not leak',
        },
      }));
      await flushAsync();

      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it.each([
      OPENSPEC_AUTO_DELIVER_MSG.LAUNCH,
      OPENSPEC_AUTO_DELIVER_MSG.STOP,
      OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST,
      OPENSPEC_AUTO_DELIVER_MSG.LIST_REQUEST,
    ])('rejects %s for the wrong serverId before daemon forwarding', async (type) => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      daemonWs.sent.length = 0;
      browserWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type,
        requestId: `auto-wrong-server-${type}`,
        serverId: 'other-server',
        changeName: 'openspec-auto-delivery',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((raw) => raw.includes(type))).toBe(false);
      expect(browserWs.sentStrings.some((raw) => {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        return msg.type === 'error'
          && msg.code === 'wrong_server'
          && msg.originalType === type
          && msg.requestId === `auto-wrong-server-${type}`;
      })).toBe(true);
    });

    it('stamps allowed OpenSpec Auto Deliver requests with the bridge serverId before forwarding', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST,
        requestId: 'auto-status-forward',
        sessionName: 'deck_sub_launcher',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST);
      expect(forwarded).toMatchObject({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST,
        requestId: 'auto-status-forward',
        serverId,
        sessionName: 'deck_sub_launcher',
      });
    });

    it('rejects forged OpenSpec Auto Deliver STOP built from conflict metadata before daemon forwarding', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge(makeOpenSpecAutoDeliverOwnershipDb());
      const bridge = WsBridge.get(serverId);
      daemonWs.sent.length = 0;
      browserWs.sent.length = 0;

      bridge.rememberOpenSpecAutoDeliverProjectionForTests({
        runId: 'auto-forged-stop-run',
        changeName: 'openspec-auto-delivery',
        owningMainSessionName: 'deck_proj_brain',
        launchedFromSessionName: 'deck_sub_launcher',
        targetImplementationSessionName: 'deck_sub_worker',
        projectionVersion: 12,
        generation: 3,
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        selectedTeamComboId: 'audit>review>plan',
      });

      browserWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
        requestId: 'auto-forged-stop',
        sessionName: 'deck_proj_brain',
        runId: 'auto-forged-stop-run',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((raw) => {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        return msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP;
      })).toBe(false);
      const stopAck = browserWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK);
      expect(stopAck).toMatchObject({
        requestId: 'auto-forged-stop',
        ok: false,
        error: 'unauthorized_session',
      });
    });

    it('allows OpenSpec Auto Deliver STOP through owner fallback before chat subscription is ready', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge(makeOpenSpecAutoDeliverOwnershipDb(['deck_proj_brain']));
      daemonWs.sent.length = 0;
      browserWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
        requestId: 'auto-stop-owner-fallback',
        sessionName: 'deck_proj_brain',
        runId: 'auto-stop-run',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.STOP);
      expect(forwarded).toMatchObject({
        type: OPENSPEC_AUTO_DELIVER_MSG.STOP,
        requestId: 'auto-stop-owner-fallback',
        serverId,
        sessionName: 'deck_proj_brain',
        runId: 'auto-stop-run',
      });
    });

    it('returns OpenSpec Auto Deliver list rows from bridge cache without daemon forwarding', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      const bridge = WsBridge.get(serverId);
      daemonWs.sent.length = 0;
      browserWs.sent.length = 0;

      bridge.rememberOpenSpecAutoDeliverProjectionForTests({
        runId: 'auto-list-run',
        changeName: 'openspec-auto-delivery',
        owningMainSessionName: 'deck_proj_brain',
        launchedFromSessionName: 'deck_sub_launcher',
        targetImplementationSessionName: 'deck_sub_worker',
        projectionVersion: 11,
        generation: 2,
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        selectedTeamComboId: 'audit>review>plan',
      });

      browserWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.LIST_REQUEST,
        requestId: 'auto-list-1',
        sessionName: 'deck_sub_worker',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((raw) => raw.includes(OPENSPEC_AUTO_DELIVER_MSG.LIST_REQUEST))).toBe(false);
      const listResponse = browserWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LIST_RESPONSE);
      expect(listResponse).toMatchObject({
        requestId: 'auto-list-1',
        rows: [
          {
            runId: 'auto-list-run',
            visibility: 'full',
            changeName: 'openspec-auto-delivery',
            selectedTeamComboId: 'audit>review>plan',
            targetImplementationSessionName: 'deck_sub_worker',
          },
        ],
      });
    });

    it('returns all OpenSpec Auto Deliver rows for the global list page without requiring a sessionName', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      const bridge = WsBridge.get(serverId);
      daemonWs.sent.length = 0;
      browserWs.sent.length = 0;

      bridge.rememberOpenSpecAutoDeliverProjectionForTests({
        runId: 'auto-list-main',
        changeName: 'main-change',
        owningMainSessionName: 'deck_main_brain',
        targetImplementationSessionName: 'deck_main_worker',
        projectionVersion: 21,
        generation: 1,
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        selectedTeamComboId: 'audit>review>plan',
      });
      bridge.rememberOpenSpecAutoDeliverProjectionForTests({
        runId: 'auto-list-other',
        changeName: 'other-change',
        owningMainSessionName: 'deck_other_brain',
        targetImplementationSessionName: 'deck_other_worker',
        projectionVersion: 22,
        generation: 1,
        status: 'needs_human',
        stage: 'needs_human',
        terminal: true,
        terminalReason: 'missing_authoritative_json',
      });

      browserWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.LIST_REQUEST,
        requestId: 'auto-list-global',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((raw) => raw.includes(OPENSPEC_AUTO_DELIVER_MSG.LIST_REQUEST))).toBe(false);
      const listResponse = browserWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((msg) => msg.type === OPENSPEC_AUTO_DELIVER_MSG.LIST_RESPONSE);
      expect(listResponse).toMatchObject({
        requestId: 'auto-list-global',
        rows: [
          {
            runId: 'auto-list-other',
            visibility: 'full',
            changeName: 'other-change',
            targetImplementationSessionName: 'deck_other_worker',
            terminalReason: 'missing_authoritative_json',
          },
          {
            runId: 'auto-list-main',
            visibility: 'full',
            changeName: 'main-change',
            selectedTeamComboId: 'audit>review>plan',
            targetImplementationSessionName: 'deck_main_worker',
          },
        ],
      });
    });

    it('does not overwrite OpenSpec Auto Deliver pending requests when sockets reuse the same requestId', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const participant = new MockWs();
      const sibling = new MockWs();
      bridge.handleBrowserConnection(participant as never, 'participant', makeDb('valid-hash'));
      bridge.handleBrowserConnection(sibling as never, 'sibling', makeDb('valid-hash'));
      participant.sent.length = 0;
      sibling.sent.length = 0;

      for (const [socket, sessionName] of [[participant, 'deck_sub_launcher'], [sibling, 'deck_sub_sibling']] as const) {
        socket.emit('message', JSON.stringify({
          type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST,
          requestId: 'auto-status-shared',
          sessionName,
        }));
      }
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION,
        requestId: 'auto-status-shared',
        projection: {
          runId: 'auto-run-shared',
          changeName: 'openspec-auto-delivery',
          owningMainSessionName: 'deck_proj_brain',
          launchedFromSessionName: 'deck_sub_launcher',
          targetImplementationSessionName: 'deck_sub_worker',
          projectionVersion: 9,
          generation: 3,
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          latestRepairSummary: 'private repair summary',
          taskStats: { total: 1, checked: 0, unchecked: 1, items: [{ checked: false, label: 'private task' }] },
        },
      }));
      await flushAsync();

      const participantMessages = participant.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      const siblingMessages = sibling.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      expect(participantMessages).toHaveLength(1);
      expect(participantMessages[0]).toMatchObject({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION,
        requestId: 'auto-status-shared',
        projection: {
          runId: 'auto-run-shared',
          visibility: 'full',
          changeName: 'openspec-auto-delivery',
        },
      });
      expect(siblingMessages).toHaveLength(1);
      expect(siblingMessages[0]).toMatchObject({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION,
        requestId: 'auto-status-shared',
        projection: null,
        error: 'duplicate_request_id',
      });
      expect(JSON.stringify(siblingMessages[0])).not.toContain('openspec-auto-delivery');
      expect(JSON.stringify(siblingMessages[0])).not.toContain('private task');
      expect(JSON.stringify(siblingMessages[0])).not.toContain('private repair summary');
    });

    it('does not return full OpenSpec Auto Deliver status when the request has no sessionName', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const requester = new MockWs();
      bridge.handleBrowserConnection(requester as never, 'requester', makeDb('valid-hash'));
      requester.sent.length = 0;

      requester.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST,
        requestId: 'auto-status-no-session',
      }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION,
        requestId: 'auto-status-no-session',
        projection: {
          runId: 'auto-run-no-session',
          changeName: 'openspec-auto-delivery',
          owningMainSessionName: 'deck_proj_brain',
          launchedFromSessionName: 'deck_sub_launcher',
          targetImplementationSessionName: 'deck_sub_worker',
          projectionVersion: 10,
          generation: 4,
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          latestRepairSummary: 'private repair summary',
        },
      }));
      await flushAsync();

      const messages = requester.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION,
        requestId: 'auto-status-no-session',
        projection: null,
        error: 'unauthorized_session',
      });
      expect(JSON.stringify(messages[0])).not.toContain('openspec-auto-delivery');
      expect(JSON.stringify(messages[0])).not.toContain('private repair summary');
    });

    it('singlecasts OpenSpec Auto Deliver status replies and broadcasts projections only to participating sessions', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const requester = new MockWs();
      const worker = new MockWs();
      const outsider = new MockWs();
      bridge.handleBrowserConnection(requester as never, 'requester', makeDb('valid-hash'));
      bridge.handleBrowserConnection(worker as never, 'worker', makeDb('valid-hash'));
      bridge.handleBrowserConnection(outsider as never, 'outsider', makeDb('valid-hash'));

      worker.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_sub_worker' }));
      outsider.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_sub_sibling' }));
      await flushAsync();
      requester.sent.length = 0;
      worker.sent.length = 0;
      outsider.sent.length = 0;

      requester.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST,
        requestId: 'auto-status-recover',
        sessionName: 'deck_sub_launcher',
      }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION,
        requestId: 'auto-status-recover',
        projection: makeOpenSpecAutoDeliverProjection({
          runId: 'auto-run-1',
          changeName: 'openspec-auto-delivery',
          owningMainSessionName: 'deck_proj_brain',
          launchedFromSessionName: 'deck_sub_launcher',
          targetImplementationSessionName: 'deck_sub_worker',
          projectionVersion: 7,
          generation: 4,
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          latestRepairSummary: 'fixed token=abc1234567890abcdef',
          rawPrompt: 'do not leak',
        }),
      }));
      await flushAsync();

      const requesterMessages = requester.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      const workerMessages = worker.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      const outsiderMessages = outsider.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);

      expect(requesterMessages).toHaveLength(1);
      expect(requesterMessages[0]).toMatchObject({
        type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION,
        requestId: 'auto-status-recover',
        projection: {
          runId: 'auto-run-1',
          projectionVersion: 7,
        },
      });
      expect(JSON.stringify(requesterMessages[0])).not.toContain('rawPrompt');
      expect(JSON.stringify(requesterMessages[0])).not.toContain('abc1234567890abcdef');

      expect(workerMessages).toHaveLength(0);
      expect(outsiderMessages).toHaveLength(0);
    });

    it('proactively broadcasts redacted OpenSpec Auto Deliver conflict summaries to subscribed sibling sessions', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      for (const id of ['worker', 'sibling']) {
        daemonWs.emit('message', JSON.stringify({
          type: 'subsession.sync',
          id,
          parentSession: 'deck_proj_brain',
          sessionType: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
        }));
      }
      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync',
        id: 'other',
        parentSession: 'deck_other_brain',
        sessionType: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
      }));
      await flushAsync();

      const worker = new MockWs();
      const sibling = new MockWs();
      const unrelated = new MockWs();
      bridge.handleBrowserConnection(worker as never, 'worker', makeDb('valid-hash'));
      bridge.handleBrowserConnection(sibling as never, 'sibling', makeDb('valid-hash'));
      bridge.handleBrowserConnection(unrelated as never, 'unrelated', makeDb('valid-hash'));
      worker.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'deck_sub_worker' }));
      sibling.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'deck_sub_sibling' }));
      unrelated.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'deck_sub_other' }));
      await flushAsync();
      worker.sent.length = 0;
      sibling.sent.length = 0;
      unrelated.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.PROJECTION,
        projection: makeOpenSpecAutoDeliverProjection({
          runId: 'auto-run-1',
          changeName: 'openspec-auto-delivery',
          owningMainSessionName: 'deck_proj_brain',
          launchedFromSessionName: 'deck_sub_launcher',
          targetImplementationSessionName: 'deck_sub_worker',
          projectionVersion: 8,
          generation: 5,
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          latestRepairSummary: 'private repair summary token=abc123',
        }),
      }));
      await flushAsync();

      const workerMessages = worker.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      const siblingMessages = sibling.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      const unrelatedMessages = unrelated.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);

      expect(workerMessages).toHaveLength(1);
      expect(workerMessages[0]).toMatchObject({
        type: OPENSPEC_AUTO_DELIVER_MSG.PROJECTION,
        projection: {
          runId: 'auto-run-1',
          visibility: 'full',
          targetImplementationSessionName: 'deck_sub_worker',
        },
      });
      expect(siblingMessages).toHaveLength(1);
      expect(siblingMessages[0]).toMatchObject({
        type: OPENSPEC_AUTO_DELIVER_MSG.CONFLICT_SUMMARY,
        projection: {
          runId: 'auto-run-1',
          visibility: 'conflict',
          conflictReason: 'auto_deliver_active',
          canStop: false,
        },
      });
      expect(JSON.stringify(siblingMessages[0])).not.toContain('private repair summary');
      expect(JSON.stringify(siblingMessages[0])).not.toContain('abc123');
      expect(unrelatedMessages).toHaveLength(0);
    });

    it('keeps newer OpenSpec Auto Deliver projections when stale daemon updates arrive', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.PROJECTION,
        projection: makeOpenSpecAutoDeliverProjection({
          runId: 'auto-run-versioned',
          changeName: 'openspec-auto-delivery',
          owningMainSessionName: 'deck_proj_brain',
          launchedFromSessionName: 'deck_proj_brain',
          targetImplementationSessionName: 'deck_proj_brain',
          projectionVersion: 5,
          generation: 5,
          status: 'implementation_audit_repair',
          stage: 'implementation_audit_repair',
          activeOpenSpecPromptId: 'implementation_audit',
        }),
      }));
      daemonWs.emit('message', JSON.stringify({
        type: OPENSPEC_AUTO_DELIVER_MSG.PROJECTION,
        projection: makeOpenSpecAutoDeliverProjection({
          runId: 'auto-run-versioned',
          changeName: 'openspec-auto-delivery',
          owningMainSessionName: 'deck_proj_brain',
          launchedFromSessionName: 'deck_proj_brain',
          targetImplementationSessionName: 'deck_proj_brain',
          projectionVersion: 4,
          generation: 4,
          status: 'spec_audit_repair',
          stage: 'spec_audit_repair',
          activeOpenSpecPromptId: 'proposal_audit',
        }),
      }));
      await flushAsync();

      expect(bridge.getOpenSpecAutoDeliverProjectionForSessionForTests('deck_proj_brain')).toMatchObject({
        runId: 'auto-run-versioned',
        projectionVersion: 5,
        stage: 'implementation_audit_repair',
      });
    });

    it('clears active OpenSpec Auto Deliver projections on daemon disconnect but retains terminal projections', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      bridge.rememberOpenSpecAutoDeliverProjectionForTests(makeOpenSpecAutoDeliverProjection({
        runId: 'active-run',
        changeName: 'active-change',
        owningMainSessionName: 'deck_active_brain',
        launchedFromSessionName: 'deck_active_brain',
        targetImplementationSessionName: 'deck_active_brain',
        projectionVersion: 1,
        generation: 1,
      }));
      bridge.rememberOpenSpecAutoDeliverProjectionForTests(makeOpenSpecAutoDeliverProjection({
        runId: 'terminal-run',
        changeName: 'terminal-change',
        owningMainSessionName: 'deck_terminal_brain',
        launchedFromSessionName: 'deck_terminal_brain',
        targetImplementationSessionName: 'deck_terminal_brain',
        projectionVersion: 1,
        generation: 1,
        status: 'passed',
        stage: 'passed',
        terminal: true,
      }));

      daemonWs.close();
      await flushAsync();

      expect(bridge.getOpenSpecAutoDeliverProjectionForSessionForTests('deck_active_brain')).toBeNull();
      expect(bridge.getOpenSpecAutoDeliverProjectionForSessionForTests('deck_terminal_brain')?.runId).toBe('terminal-run');
      expect(bridge.getOpenSpecAutoDeliverConflictSummaryForTests('deck_active_brain')).toBeNull();
    });
  });

  describe('push notifications', () => {
    function makePushDb(tokenHash: string) {
      return {
        queryOne: async (sql: string, params?: unknown[]) => {
          if (sql.includes('FROM servers')) return { token_hash: tokenHash, user_id: 'user-1', name: 'my-server' };
          if (sql.includes('FROM sessions') && params?.[1] === 'deck_cd_brain') {
            return { project_name: 'codedeck', agent_type: 'claude-code', label: null };
          }
          if (sql.includes('FROM sessions') && params?.[1] === 'bootmainxowfy6') {
            return { project_name: 'codedeck', agent_type: 'claude-code', label: 'Boot Main' };
          }
          if (sql.includes('FROM sub_sessions')) {
            if (params?.[1] === 'unlabeled') {
              return { type: 'codex', label: null, parent_session: '' };
            }
            if (params?.[1] === 'needs-main-label') {
              return { type: 'codex', label: null, parent_session: 'bootmainxowfy6' };
            }
            if (params?.[1] === 'nested') {
              return { type: 'shell', label: null, parent_session: 'deck_sub_parent' };
            }
            if (params?.[1] === 'parent') {
              return { type: 'codex', label: null, parent_session: 'deck_cd_brain' };
            }
            return { type: 'codex', label: 'worker-1', parent_session: 'deck_cd_brain' };
          }
          return null;
        },
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;
    }

    async function setupPushBridge() {
      const db = makePushDb('valid-hash');
      const env = { APNS_KEY: 'test', APNS_KEY_ID: 'kid', APNS_TEAM_ID: 'tid' } as never;
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, env);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      return { bridge, daemonWs, db, env };
    }

    it('includes server name and session metadata in push title', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain', lastText: 'Done implementing the feature.',
      }));
      await flushAsync();

      expect(dispatchPush).toHaveBeenCalled();
      const call = vi.mocked(dispatchPush).mock.calls[0];
      const payload = call[0];
      expect(payload.title).toBe('my-server · codedeck · claude-code');
      expect(payload.body).toContain('Done implementing');
    });

    it('prefers sub-session label over session name in push title', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle',
        session: 'deck_sub_ab12cd34',
        lastText: 'Stopped early.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls[0][0];
      expect(payload.title).toBe('my-server · worker-1 · codex');
      expect(payload.title).not.toContain('deck_sub_ab12cd34');
    });

    it('resolves hyphenated sub-session ids before falling back to internal session names', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle',
        session: 'deck_sub_sub-123',
        lastText: 'Done.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls[0][0];
      expect(payload.title).toBe('my-server · worker-1 · codex');
      expect(payload.title).not.toContain('deck_sub_sub-123');
    });

    it('prefers active session snapshot labels over internal main session names in push title', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session_list',
        sessions: [{
          name: 'bootmainxowfy6',
          project: 'codedeck',
          state: 'idle',
          agentType: 'claude-code',
          label: 'Boot Main',
        }],
      }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle',
        session: 'bootmainxowfy6',
        lastText: 'Ready.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.title).toBe('my-server · Boot Main · claude-code');
      expect(payload?.title).not.toContain('bootmainxowfy6');
    });

    it('prefers stored main-session labels before daemon project fallbacks in push title', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle',
        session: 'bootmainxowfy6',
        project: 'Readable Main',
        agentType: 'claude-code',
        lastText: 'Ready.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.title).toBe('my-server · Boot Main · claude-code');
      expect(payload?.title).not.toContain('bootmainxowfy6');
    });

    it('uses parent/project fallback before internal sub-session names in push title', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle',
        session: 'deck_sub_unlabeled',
        project: 'Readable Main',
        agentType: 'codex',
        lastText: 'Ready.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.title).toBe('my-server · Readable Main · codex');
      expect(payload?.title).not.toContain('deck_sub_unlabeled');
    });

    it('walks nested sub-session parents until it finds a readable main-session title', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle',
        session: 'deck_sub_nested',
        project: 'deck_sub_nested',
        parentLabel: 'deck_sub_parent',
        agentType: 'shell',
        lastText: 'Ready.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.title).toBe('my-server · codedeck · shell');
      expect(payload?.title).not.toContain('deck_sub_nested');
      expect(payload?.title).not.toContain('deck_sub_parent');
    });

    it('prefers stored parent labels over opaque daemon parent/project names in push title', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle',
        session: 'deck_sub_needs-main-label',
        parentLabel: 'bootmainxowfy6',
        project: 'bootmainxowfy6',
        agentType: 'codex',
        lastText: 'Ready.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.title).toBe('my-server · Boot Main · codex');
      expect(payload?.title).not.toContain('bootmainxowfy6');
    });

    it('uses cached sub-session labels for timeline idle pushes before explicit session.idle arrives', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync',
        id: 'timeline-worker',
        sessionType: 'codex',
        label: 'Worker Timeline',
        parentSession: 'deck_cd_brain',
      }));
      await flushAsync();
      vi.mocked(dispatchPush).mockClear();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          sessionId: 'deck_sub_timeline-worker',
          eventId: 'evt-1',
          ts: Date.now(),
          type: 'session.state',
          payload: { state: 'idle' },
        },
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.title).toBe('my-server · Worker Timeline · codex');
      expect(payload?.title).not.toContain('deck_sub_timeline-worker');
    });

    it('pushes ask.question timeline events with the actual question text', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          sessionId: 'deck_cd_brain',
          eventId: 'evt-ask-question',
          ts: Date.now(),
          type: 'ask.question',
          payload: {
            toolUseId: 'tool-ask-1',
            questions: [{ question: 'Should I continue with the risky migration?' }],
          },
        },
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.title).toBe('my-server · codedeck · claude-code');
      expect(payload?.body).toBe('Should I continue with the risky migration?');
      expect(payload?.data).toMatchObject({
        serverId,
        session: 'deck_cd_brain',
        type: 'ask.question',
      });
    });

    it('does not push stale timeline idle events replayed on daemon restart', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          sessionId: 'deck_cd_brain',
          eventId: 'evt-stale-idle',
          ts: Date.now() - PUSH_TIMELINE_EVENT_MAX_AGE_MS - 1_000,
          type: 'session.state',
          payload: { state: 'idle' },
        },
      }));
      await flushAsync();

      expect(dispatchPush).not.toHaveBeenCalled();
    });

    it('does not push timeline idle events explicitly marked as restore-only', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          sessionId: 'deck_cd_brain',
          eventId: 'evt-restore-idle',
          ts: Date.now(),
          type: 'session.state',
          payload: { state: 'idle', [TIMELINE_SUPPRESS_PUSH_FIELD]: true },
        },
      }));
      await flushAsync();

      expect(dispatchPush).not.toHaveBeenCalled();
    });

    it('uses lastText as push body for session.idle', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain', lastText: 'All tests passing.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls[0][0];
      expect(payload.body).toBe('All tests passing.');
    });

    it('prefers current assistant timeline text over stale idle lastText', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'user-current-turn',
          sessionId: 'deck_cd_brain',
          ts: 10,
          type: 'user.message',
          payload: { text: 'please run the checks' },
        },
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'assistant-current-turn',
          sessionId: 'deck_cd_brain',
          ts: 20,
          type: 'assistant.text',
          payload: { text: 'Current turn result: all checks passed.', streaming: false },
        },
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain', lastText: 'Previous turn text.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.body).toBe('Current turn result: all checks passed.');
    });

    it('does not reuse stale idle lastText after a newer user message without an assistant response', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'assistant-previous-turn',
          sessionId: 'deck_cd_brain',
          ts: 10,
          type: 'assistant.text',
          payload: { text: 'Previous turn text.', streaming: false },
        },
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'user-new-turn',
          sessionId: 'deck_cd_brain',
          ts: 20,
          type: 'user.message',
          payload: { text: 'new request' },
        },
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain', lastText: 'Previous turn text.',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
      expect(payload?.body).toContain('ready for input');
      expect(payload?.body).not.toBe('Previous turn text.');
    });

    it('settles idle push briefly so final assistant text can arrive after idle', async () => {
      vi.useFakeTimers();
      const restoreIdlePushSettle = __setIdlePushSettleMsForTests(300);
      try {
        const { dispatchPush } = await import('../src/routes/push.js');
        const { daemonWs } = await setupPushBridge();

        daemonWs.emit('message', JSON.stringify({
          type: 'timeline.event',
          event: {
            eventId: 'user-race-turn',
            sessionId: 'deck_cd_brain',
            ts: Date.now(),
            type: 'user.message',
            payload: { text: 'current request' },
          },
        }));
        daemonWs.emit('message', JSON.stringify({
          type: 'session.idle', session: 'deck_cd_brain', lastText: 'Previous turn text.',
        }));
        await flushAsync();
        expect(dispatchPush).not.toHaveBeenCalled();

        daemonWs.emit('message', JSON.stringify({
          type: 'timeline.event',
          event: {
            eventId: 'assistant-race-turn',
            sessionId: 'deck_cd_brain',
            ts: Date.now() + 1,
            type: 'assistant.text',
            payload: { text: 'Current response arrived after idle.', streaming: false },
          },
        }));

        await vi.advanceTimersByTimeAsync(300);
        await flushAsync();

        const payload = vi.mocked(dispatchPush).mock.calls.at(-1)?.[0];
        expect(payload?.body).toBe('Current response arrived after idle.');
      } finally {
        restoreIdlePushSettle();
        vi.useRealTimers();
      }
    });

    it('falls back to default body when no lastText', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { daemonWs } = await setupPushBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain',
      }));
      await flushAsync();

      const payload = vi.mocked(dispatchPush).mock.calls[0][0];
      expect(payload.body).toContain('ready for input');
    });

    it('suppresses push when a mobile client is connected', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { bridge, daemonWs } = await setupPushBridge();

      // Connect a mobile browser
      const mobileWs = new MockWs();
      bridge.handleBrowserConnection(mobileWs as never, 'user-1', makePushDb('valid-hash'), true);

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain',
      }));
      await flushAsync();

      expect(dispatchPush).not.toHaveBeenCalled();
    });

    it('sends push when only desktop browser is connected', async () => {
      const { dispatchPush } = await import('../src/routes/push.js');
      const { bridge, daemonWs } = await setupPushBridge();

      // Connect a desktop browser (isMobile = false)
      const desktopWs = new MockWs();
      bridge.handleBrowserConnection(desktopWs as never, 'user-1', makePushDb('valid-hash'), false);

      daemonWs.emit('message', JSON.stringify({
        type: 'session.idle', session: 'deck_cd_brain', lastText: 'Completed.',
      }));
      await flushAsync();

      expect(dispatchPush).toHaveBeenCalled();
    });
  });

  describe('transport provider relay', () => {
    async function setupAuthenticatedBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { bridge, daemonWs, browserWs };
    }

    it('relays provider.status to all browsers (broadcast)', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: true,
      }));
      await flushAsync();
      const msg = JSON.parse(browserWs.sentStrings.at(-1)!);
      expect(msg.type).toBe('provider.status');
      expect(msg.providerId).toBe('openclaw');
      expect(msg.connected).toBe(true);
    });

    it('relays provider.status disconnected', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: false,
      }));
      await flushAsync();
      const msg = JSON.parse(browserWs.sentStrings.at(-1)!);
      expect(msg.type).toBe('provider.status');
      expect(msg.connected).toBe(false);
    });

    it('relays transport chat events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      // Subscribe browser to transport session
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-123' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'ts-123', delta: 'hello',
      }));
      await flushAsync();
      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.delta');
      expect(msg.sessionId).toBe('ts-123');
    });

    it('does NOT relay transport chat events to unsubscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      // Don't subscribe
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'ts-456', delta: 'nope',
      }));
      await flushAsync();
      // Should not receive transport event (only provider.status is broadcast)
      const transportMsgs = browserWs.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta');
      expect(transportMsgs.length).toBe(0);
    });

    it('forwards unknown message types to browsers (default-allow)', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.sent.length = 0;
      daemonWs.emit('message', JSON.stringify({ type: 'totally.unknown.type', foo: 'bar' }));
      await flushAsync();
      // Default-allow: unknown types are broadcast to all browsers
      const msgs = browserWs.sentStrings.filter(s => JSON.parse(s).type === 'totally.unknown.type');
      expect(msgs.length).toBe(1);
    });

    it('provider.status broadcasts to ALL connected browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      const browser3 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser3 as never, 'user-3', makeDb('valid-hash'));
      browser1.sent.length = 0;
      browser2.sent.length = 0;
      browser3.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: true,
      }));
      await flushAsync();

      for (const browser of [browser1, browser2, browser3]) {
        const msg = JSON.parse(browser.sentStrings.at(-1)!);
        expect(msg.type).toBe('provider.status');
        expect(msg.providerId).toBe('openclaw');
        expect(msg.connected).toBe(true);
      }
    });

    it('chat.subscribe → receive events → chat.unsubscribe → stop receiving', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();

      // Subscribe to transport session
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-sub-test' }));
      await flushAsync();
      browserWs.sent.length = 0;

      // Should receive events for subscribed session
      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'ts-sub-test', delta: 'hello',
      }));
      await flushAsync();
      expect(browserWs.sentStrings.some(s => JSON.parse(s).type === 'chat.delta')).toBe(true);
      browserWs.sent.length = 0;

      // Unsubscribe
      browserWs.emit('message', JSON.stringify({ type: 'chat.unsubscribe', sessionId: 'ts-sub-test' }));
      await flushAsync();
      browserWs.sent.length = 0;

      // Should NOT receive events after unsubscribe
      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'ts-sub-test', delta: 'should not arrive',
      }));
      await flushAsync();
      expect(browserWs.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(0);
    });

    it('does not forward duplicate chat.subscribe history replays unless forced', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-repeat' }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => JSON.parse(s).type === 'chat.subscribe')).toHaveLength(1);
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-repeat' }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => JSON.parse(s).type === 'chat.subscribe')).toHaveLength(0);

      browserWs.emit('message', JSON.stringify({
        type: 'chat.subscribe',
        sessionId: 'ts-repeat',
        forceHistory: true,
      }));
      await flushAsync();
      const forced = daemonWs.sentStrings
        .map((s) => JSON.parse(s))
        .filter((msg) => msg.type === 'chat.subscribe');
      expect(forced).toEqual([{ type: 'chat.subscribe', sessionId: 'ts-repeat', forceHistory: true }]);
    });

    it('accepts forceHistory:false as a live transport subscription without daemon history replay', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: 'chat.subscribe',
        sessionId: 'ts-live-only',
        forceHistory: false,
      }));
      await flushAsync();
      expect(daemonWs.sentStrings.filter((s) => JSON.parse(s).type === 'chat.subscribe')).toHaveLength(0);

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'evt-live-only',
          sessionId: 'ts-live-only',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          type: 'assistant.text',
          payload: { text: 'live repair works', streaming: true },
        },
      }));
      await flushAsync();

      const timelineEvents = browserWs.sentStrings
        .map((s) => JSON.parse(s))
        .filter((msg) => msg.type === 'timeline.event');
      expect(timelineEvents).toHaveLength(1);
      expect(timelineEvents[0].event.payload.text).toBe('live repair works');
    });

    it('retries live transport subscription ownership for newly created sub-sessions', async () => {
      const bridge = WsBridge.get(serverId);
      const db = makeSubSessionOwnershipRaceDb({ subId: 'race-live' });
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', db);
      daemonWs.sent.length = 0;
      browserWs.emit('message', JSON.stringify({
        type: 'chat.subscribe',
        sessionId: 'deck_sub_race-live',
        forceHistory: false,
      }));

      await new Promise((resolve) => setTimeout(resolve, 80));
      await flushAsync();
      expect(db.getSubChecks()).toBeGreaterThanOrEqual(2);
      expect(daemonWs.sentStrings.filter((s) => JSON.parse(s).type === 'chat.subscribe')).toHaveLength(0);

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'evt-race-live',
          sessionId: 'deck_sub_race-live',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          type: 'assistant.text',
          payload: { text: 'sub live stream', streaming: true },
        },
      }));
      await flushAsync();

      const timelineEvents = browserWs.sentStrings
        .map((s) => JSON.parse(s))
        .filter((msg) => msg.type === 'timeline.event');
      expect(timelineEvents).toHaveLength(1);
      expect(timelineEvents[0].event.payload).toMatchObject({ text: 'sub live stream', streaming: true });
    });

    it('retries terminal subscription ownership for newly created process sub-sessions', async () => {
      const bridge = WsBridge.get(serverId);
      const db = makeSubSessionOwnershipRaceDb({ subId: 'race-term' });
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', db);
      daemonWs.sent.length = 0;
      browserWs.emit('message', JSON.stringify({
        type: 'terminal.subscribe',
        session: 'deck_sub_race-term',
        raw: false,
      }));

      await new Promise((resolve) => setTimeout(resolve, 80));
      await flushAsync();
      expect(db.getSubChecks()).toBeGreaterThanOrEqual(2);
      expect(daemonWs.sentStrings.map((s) => JSON.parse(s))).toContainEqual({
        type: 'terminal.subscribe',
        session: 'deck_sub_race-term',
        raw: false,
      });

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'evt-race-term',
          sessionId: 'deck_sub_race-term',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          type: 'assistant.text',
          payload: { text: 'process sub stream', streaming: true },
        },
      }));
      await flushAsync();

      const timelineEvents = browserWs.sentStrings
        .map((s) => JSON.parse(s))
        .filter((msg) => msg.type === 'timeline.event');
      expect(timelineEvents).toHaveLength(1);
      expect(timelineEvents[0].event.payload).toMatchObject({ text: 'process sub stream', streaming: true });
    });

    it('forwards chat.subscribe again after unsubscribe', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-resub' }));
      await flushAsync();
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({ type: 'chat.unsubscribe', sessionId: 'ts-resub' }));
      await flushAsync();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-resub' }));
      await flushAsync();

      expect(daemonWs.sentStrings.filter((s) => JSON.parse(s).type === 'chat.subscribe')).toHaveLength(1);
    });

    it('relays chat.complete events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-complete' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.complete', sessionId: 'ts-complete', messageId: 'msg-1',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.complete');
      expect(msg.sessionId).toBe('ts-complete');
      expect(msg.messageId).toBe('msg-1');
    });

    it('relays chat.error events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-err' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.error', sessionId: 'ts-err', error: 'rate limited', code: 'RATE_LIMITED',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.error');
      expect(msg.error).toBe('rate limited');
      expect(msg.code).toBe('RATE_LIMITED');
    });

    it('relays chat.status events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-status' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.status', sessionId: 'ts-status', status: 'streaming',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.status');
      expect(msg.status).toBe('streaming');
    });

    it('relays chat.tool events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-tool' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.tool', sessionId: 'ts-tool', messageId: 'msg-1',
        tool: { name: 'read_file', status: 'started' },
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.tool');
      expect(msg.tool.name).toBe('read_file');
    });

    it('relays chat.approval events to subscribed browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-approval' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.approval', sessionId: 'ts-approval', requestId: 'req-1',
        description: 'Write to file /etc/passwd',
      }));
      await flushAsync();

      const msg = JSON.parse(browserWs.sentStrings[0]);
      expect(msg.type).toBe('chat.approval');
      expect(msg.requestId).toBe('req-1');
      expect(msg.description).toBe('Write to file /etc/passwd');
    });

    it('relays chat.history only to subscribed browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const subscribedBrowser = new MockWs();
      const unsubscribedBrowser = new MockWs();
      bridge.handleBrowserConnection(subscribedBrowser as never, 'user-sub', makeDb('valid-hash'));
      bridge.handleBrowserConnection(unsubscribedBrowser as never, 'user-unsub', makeDb('valid-hash'));
      subscribedBrowser.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-history' }));
      await flushAsync();
      subscribedBrowser.sent.length = 0;
      unsubscribedBrowser.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.history',
        sessionId: 'ts-history',
        events: [{ type: 'assistant.text', text: 'hello', _ts: 10 }],
      }));
      await flushAsync();

      expect(subscribedBrowser.sentStrings.some((raw) => {
        const msg = JSON.parse(raw);
        return msg.type === 'chat.history' && msg.sessionId === 'ts-history';
      })).toBe(true);
      expect(unsubscribedBrowser.sentStrings.some((raw) => JSON.parse(raw).type === 'chat.history')).toBe(false);
    });

    it('relays chat.approval_response only to subscribed browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const subscribedBrowser = new MockWs();
      const unsubscribedBrowser = new MockWs();
      bridge.handleBrowserConnection(subscribedBrowser as never, 'user-sub', makeDb('valid-hash'));
      bridge.handleBrowserConnection(unsubscribedBrowser as never, 'user-unsub', makeDb('valid-hash'));
      subscribedBrowser.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'ts-approval-response' }));
      await flushAsync();
      subscribedBrowser.sent.length = 0;
      unsubscribedBrowser.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'chat.approval_response',
        sessionId: 'ts-approval-response',
        requestId: 'req-2',
        approved: true,
      }));
      await flushAsync();

      expect(subscribedBrowser.sentStrings.some((raw) => {
        const msg = JSON.parse(raw);
        return msg.type === 'chat.approval_response' && msg.requestId === 'req-2' && msg.approved === true;
      })).toBe(true);
      expect(unsubscribedBrowser.sentStrings.some((raw) => JSON.parse(raw).type === 'chat.approval_response')).toBe(false);
    });

    it('isolates transport subscriptions between browsers', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browser1 = new MockWs();
      const browser2 = new MockWs();
      bridge.handleBrowserConnection(browser1 as never, 'user-1', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browser2 as never, 'user-2', makeDb('valid-hash'));

      // browser1 subscribes to session A, browser2 subscribes to session B
      browser1.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'sess-A' }));
      browser2.emit('message', JSON.stringify({ type: 'chat.subscribe', sessionId: 'sess-B' }));
      await flushAsync();
      browser1.sent.length = 0;
      browser2.sent.length = 0;

      // Delta for session A — only browser1 should get it
      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'sess-A', delta: 'for-browser-1',
      }));
      await flushAsync();

      expect(browser1.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(1);
      expect(browser2.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(0);

      browser1.sent.length = 0;
      browser2.sent.length = 0;

      // Delta for session B — only browser2 should get it
      daemonWs.emit('message', JSON.stringify({
        type: 'chat.delta', sessionId: 'sess-B', delta: 'for-browser-2',
      }));
      await flushAsync();

      expect(browser1.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(0);
      expect(browser2.sentStrings.filter(s => JSON.parse(s).type === 'chat.delta')).toHaveLength(1);
    });

    it('provider.status still reaches browsers that have no transport subscriptions', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      // Browser has NOT subscribed to any transport session
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: true,
      }));
      await flushAsync();

      // provider.status is broadcast (not subscription-gated)
      const msg = JSON.parse(browserWs.sentStrings.at(-1)!);
      expect(msg.type).toBe('provider.status');
      expect(msg.connected).toBe(true);
    });

    it('provider connect → disconnect sequence reaches browser in order', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: true,
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'provider.status', providerId: 'openclaw', connected: false,
      }));
      await flushAsync();

      const statusMsgs = browserWs.sentStrings
        .map(s => JSON.parse(s))
        .filter((m: Record<string, unknown>) => m.type === 'provider.status');

      expect(statusMsgs).toHaveLength(2);
      expect(statusMsgs[0].connected).toBe(true);
      expect(statusMsgs[1].connected).toBe(false);
    });
  });

  // ── fs.write routing ──────────────────────────────────────────────────────

  describe('fs.write routing', () => {
    async function setupAuthBridge() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      return { bridge, daemonWs, browserWs };
    }

    it('relays fs.write from browser to daemon', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();

      browserWs.emit('message', JSON.stringify({
        type: 'fs.write',
        requestId: 'write-req-1',
        path: '/home/user/test.txt',
        content: 'hello',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === 'fs.write'; } catch { return false; }
      });
      expect(forwarded).toBeDefined();
      const msg = JSON.parse(forwarded!);
      expect(msg.requestId).toBe('write-req-1');
      expect(msg.content).toBe('hello');
    });

    it('single-casts fs.write_response back to originating browser only', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs1 = new MockWs();
      bridge.handleBrowserConnection(browserWs1 as never, 'user-1', makeDb('valid-hash'));

      const browserWs2 = new MockWs();
      bridge.handleBrowserConnection(browserWs2 as never, 'user-2', makeDb('valid-hash'));

      // Browser 1 sends fs.write
      browserWs1.emit('message', JSON.stringify({
        type: 'fs.write',
        requestId: 'write-req-single',
        path: '/home/user/file.txt',
        content: 'data',
      }));
      await flushAsync();

      // Reset sent arrays
      browserWs1.sent.length = 0;
      browserWs2.sent.length = 0;

      // Daemon sends back fs.write_response
      daemonWs.emit('message', JSON.stringify({
        type: 'fs.write_response',
        requestId: 'write-req-single',
        path: '/home/user/file.txt',
        status: 'ok',
        mtime: 1700000000000,
      }));
      await flushAsync();

      // Only browser 1 should receive the response
      expect(browserWs1.sentStrings.length).toBe(1);
      expect(browserWs2.sentStrings.length).toBe(0);

      const resp = JSON.parse(browserWs1.sentStrings[0]);
      expect(resp.type).toBe('fs.write_response');
      expect(resp.status).toBe('ok');
      expect(resp.mtime).toBe(1700000000000);
    });

    it('does not broadcast fs.write_response (no pending map entry = silent drop)', async () => {
      const { daemonWs, browserWs } = await setupAuthBridge();
      browserWs.sent.length = 0;

      // Daemon sends response for an unknown requestId (not in pending map)
      daemonWs.emit('message', JSON.stringify({
        type: 'fs.write_response',
        requestId: 'unknown-req',
        path: '/home/user/file.txt',
        status: 'ok',
        mtime: 1700000000000,
      }));
      await flushAsync();

      // Should not be broadcast to any browser
      expect(browserWs.sentStrings.filter(s => s.includes('fs.write_response'))).toHaveLength(0);
    });

    it('relays fs.rename from browser to daemon and single-casts response', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs1 = new MockWs();
      bridge.handleBrowserConnection(browserWs1 as never, 'user-1', makeDb('valid-hash'));
      const browserWs2 = new MockWs();
      bridge.handleBrowserConnection(browserWs2 as never, 'user-2', makeDb('valid-hash'));

      browserWs1.emit('message', JSON.stringify({
        type: FS_TRANSPORT_MSG.RENAME,
        requestId: 'rename-req-single',
        path: '/home/user/old.txt',
        newPath: '/home/user/new.txt',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === FS_TRANSPORT_MSG.RENAME; } catch { return false; }
      });
      expect(forwarded).toBeDefined();
      browserWs1.sent.length = 0;
      browserWs2.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: FS_TRANSPORT_MSG.RENAME_RESPONSE,
        requestId: 'rename-req-single',
        path: '/home/user/old.txt',
        newPath: '/home/user/new.txt',
        status: 'ok',
      }));
      await flushAsync();

      expect(browserWs1.sentStrings).toHaveLength(1);
      expect(browserWs2.sentStrings).toHaveLength(0);
      expect(JSON.parse(browserWs1.sentStrings[0]).type).toBe(FS_TRANSPORT_MSG.RENAME_RESPONSE);
    });

    it('relays fs.delete from browser to daemon and single-casts response', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs1 = new MockWs();
      bridge.handleBrowserConnection(browserWs1 as never, 'user-1', makeDb('valid-hash'));
      const browserWs2 = new MockWs();
      bridge.handleBrowserConnection(browserWs2 as never, 'user-2', makeDb('valid-hash'));

      browserWs1.emit('message', JSON.stringify({
        type: FS_TRANSPORT_MSG.DELETE,
        requestId: 'delete-req-single',
        path: '/home/user/old.txt',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings.find((s) => {
        try { return (JSON.parse(s) as { type: string }).type === FS_TRANSPORT_MSG.DELETE; } catch { return false; }
      });
      expect(forwarded).toBeDefined();
      browserWs1.sent.length = 0;
      browserWs2.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: FS_TRANSPORT_MSG.DELETE_RESPONSE,
        requestId: 'delete-req-single',
        path: '/home/user/old.txt',
        status: 'ok',
      }));
      await flushAsync();

      expect(browserWs1.sentStrings).toHaveLength(1);
      expect(browserWs2.sentStrings).toHaveLength(0);
      expect(JSON.parse(browserWs1.sentStrings[0]).type).toBe(FS_TRANSPORT_MSG.DELETE_RESPONSE);
    });
  });

  describe('cron command result persistence', () => {
    it('updates the exact execution row when executionId is provided', async () => {
      const execSpy = vi.fn(async () => ({ changes: 1 }));
      const db = {
        queryOne: async () => ({ token_hash: 'valid-hash' }),
        query: async () => [],
        execute: execSpy,
        exec: async () => {},
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;

      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: 'cron.command_result',
        jobId: 'job-1',
        executionId: 'exec-1',
        status: 'skipped_busy',
        detail: 'busy',
      }));
      await flushAsync();

      expect(execSpy).toHaveBeenCalledWith(
        'UPDATE cron_executions SET detail = $1, status = $2 WHERE id = $3',
        ['busy', 'skipped_busy', 'exec-1'],
      );
    });
  });

  // ── Timeline history requestId unicast ────────────────────────────────────

  describe('timeline history requestId unicast', () => {
    async function setupAuth() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      return { bridge, daemonWs };
    }

    it('routes timeline.history response to requesting browser via requestId even without subscription', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // Browser sends timeline.history_request with requestId — NO terminal.subscribe first
      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'req-123',
        limit: 500,
      }));
      await flushAsync();

      // Daemon responds with timeline.history
      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestId: 'req-123',
        events: [{ type: 'user.message', text: 'hello', ts: 1000 }],
        epoch: 1,
      }));
      await flushBridgeDataPlane();

      // Browser should receive the response (routed by requestId, not subscription)
      const received = browserWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === TIMELINE_MESSAGES.HISTORY; } catch { return false; }
      });
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]).requestId).toBe('req-123');
    });

    it('rejects unauthorized browser timeline requests with a request-scoped error and does not forward daemon', async () => {
      serverId = 'srv-owned';
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeTimelineOwnershipDb({ allowMain: true }), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeTimelineOwnershipDb({ allowMain: true }));
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_other_brain',
        requestId: 'unauthorized-history',
        limit: 50,
      }));
      await flushAsync();

      expect(daemonWs.sentStrings).toHaveLength(0);
      const responses = browserWs.sentStrings.map((s) => JSON.parse(s) as Record<string, unknown>);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: TIMELINE_MESSAGES.HISTORY,
        requestId: 'unauthorized-history',
        sessionName: 'deck_other_brain',
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        source: TIMELINE_RESPONSE_SOURCES.ERROR,
        errorReason: TIMELINE_REQUEST_ERROR_REASONS.REQUEST_UNAUTHORIZED,
        events: [],
        payloadTruncated: false,
        hasMore: false,
      });
      expect(typeof responses[0].actualPayloadBytes).toBe('number');
    });

    it('checks deck_sub ownership before forwarding browser timeline page/detail requests', async () => {
      serverId = 'srv-owned';
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      const db = makeTimelineOwnershipDb({ allowSub: true });
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', db);
      daemonWs.sent.length = 0;

      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.PAGE_REQUEST,
        sessionName: 'deck_sub_abc-123',
        requestId: 'page-ok',
      }));
      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.DETAIL_REQUEST,
        sessionName: 'deck_sub_other',
        requestId: 'detail-denied',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings.map((s) => JSON.parse(s) as Record<string, unknown>);
      expect(forwarded).toEqual([{
        type: TIMELINE_MESSAGES.PAGE_REQUEST,
        sessionName: 'deck_sub_abc-123',
        requestId: 'page-ok',
      }]);
      const responses = browserWs.sentStrings.map((s) => JSON.parse(s) as Record<string, unknown>);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: TIMELINE_MESSAGES.DETAIL,
        requestId: 'detail-denied',
        sessionName: 'deck_sub_other',
        status: TIMELINE_RESPONSE_STATUS.ERROR,
        source: TIMELINE_RESPONSE_SOURCES.ERROR,
        errorReason: TIMELINE_REQUEST_ERROR_REASONS.REQUEST_UNAUTHORIZED,
        payloadTruncated: false,
        hasMore: false,
      });
      expect(typeof responses[0].actualPayloadBytes).toBe('number');
    });

    it('routes timeline.replay response via requestId', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.REPLAY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'replay-456',
      }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.REPLAY,
        sessionName: 'deck_sub_qwen',
        requestId: 'replay-456',
        events: [],
        epoch: 1,
      }));
      await flushBridgeDataPlane();

      const received = browserWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === TIMELINE_MESSAGES.REPLAY; } catch { return false; }
      });
      expect(received).toHaveLength(1);
    });

    it('routes timeline.page and timeline.detail responses via requestId', async () => {
      const { daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      const bridge = WsBridge.get(serverId);
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      const cases = [
        [TIMELINE_MESSAGES.PAGE_REQUEST, TIMELINE_MESSAGES.PAGE, 'page-1'],
        [TIMELINE_MESSAGES.DETAIL_REQUEST, TIMELINE_MESSAGES.DETAIL, 'detail-1'],
      ] as const;

      for (const [requestType, responseType, requestId] of cases) {
        browserWs.emit('message', JSON.stringify({
          type: requestType,
          sessionName: 'deck_sub_qwen',
          requestId,
        }));
        await flushAsync();

        daemonWs.emit('message', JSON.stringify({
          type: responseType,
          sessionName: 'deck_sub_qwen',
          requestId,
          events: responseType === TIMELINE_MESSAGES.PAGE ? [] : undefined,
          detail: responseType === TIMELINE_MESSAGES.DETAIL ? { text: 'ok' } : undefined,
          epoch: 1,
        }));
        await flushBridgeDataPlane();

        const received = browserWs.sentStrings
          .map((s) => JSON.parse(s) as { type: string; requestId?: string })
          .filter((msg) => msg.type === responseType && msg.requestId === requestId);
        expect(received).toHaveLength(1);
      }
    });

    it('cleans up pending request after 30s timeout', async () => {
      vi.useFakeTimers();
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'req-timeout',
        limit: 500,
      }));
      await flushAsync();

      // Advance past timeout
      vi.advanceTimersByTime(31_000);

      // Late response after timeout — should NOT reach browser
      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestId: 'req-timeout',
        events: [{ type: 'user.message', text: 'late', ts: 2000 }],
        epoch: 1,
      }));
      await flushAsync();

      const received = browserWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === TIMELINE_MESSAGES.HISTORY; } catch { return false; }
      });
      expect(received).toHaveLength(0);
      vi.useRealTimers();
    });

    it('cleans up pending requests on socket close', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'req-close',
        limit: 500,
      }));
      await flushAsync();

      // Close browser socket
      browserWs.close();
      await flushAsync();

      // Response arrives after close — should NOT throw
      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestId: 'req-close',
        events: [],
        epoch: 1,
      }));
      await flushAsync();

      // No crash, no sent messages
      expect(browserWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === TIMELINE_MESSAGES.HISTORY; } catch { return false; }
      })).toHaveLength(0);
    });

    it('falls back to session subscribers when response has no requestId', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      // Subscribe to session first
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_sub_qwen' }));
      await flushAsync();

      browserWs.sent.length = 0;

      // Daemon sends timeline.history WITHOUT requestId (legacy)
      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        events: [{ type: 'assistant.text', text: 'hi', ts: 1000 }],
        epoch: 1,
      }));
      await flushBridgeDataPlane();

      const received = browserWs.sentStrings.filter((s) => {
        try { return (JSON.parse(s) as { type: string }).type === TIMELINE_MESSAGES.HISTORY; } catch { return false; }
      });
      expect(received).toHaveLength(1);
    });

    it('fans out a coalesced timeline response to browser and HTTP requestIds without subscriber leakage', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserA = new MockWs();
      const browserB = new MockWs();
      const unrelatedSubscriber = new MockWs();
      bridge.handleBrowserConnection(browserA as never, 'test-user', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browserB as never, 'test-user', makeDb('valid-hash'));
      bridge.handleBrowserConnection(unrelatedSubscriber as never, 'test-user', makeDb('valid-hash'));

      unrelatedSubscriber.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_sub_qwen' }));
      await flushAsync();
      unrelatedSubscriber.sent.length = 0;

      browserA.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'browser-a',
        limit: 50,
      }));
      browserB.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'browser-b',
        limit: 50,
      }));
      const httpPending = bridge.requestTimelineHistory({
        sessionName: 'deck_sub_qwen',
        limit: 50,
        budgetBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE,
      });
      await flushAsync();

      const httpOutbound = daemonWs.sentStrings
        .map((s) => JSON.parse(s) as { type?: string; requestId?: string })
        .find((msg) => msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST && msg.requestId?.startsWith('watch-hist-'));
      expect(httpOutbound?.requestId).toBeTruthy();
      const httpRequestId = httpOutbound!.requestId!;

      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestIds: ['browser-a', 'browser-b', httpRequestId],
        events: [{ eventId: 'e1', sessionId: 'deck_sub_qwen', ts: 100, type: 'assistant.text', payload: { text: 'hi' } }],
        epoch: 2,
      }));
      await flushBridgeDataPlane();

      for (const [socket, requestId] of [[browserA, 'browser-a'], [browserB, 'browser-b']] as const) {
        const responses = socket.sentStrings
          .map((s) => JSON.parse(s) as { type: string; requestId?: string })
          .filter((msg) => msg.type === TIMELINE_MESSAGES.HISTORY);
        expect(responses).toHaveLength(1);
        expect(responses[0].requestId).toBe(requestId);
      }
      await expect(httpPending).resolves.toMatchObject({
        type: TIMELINE_MESSAGES.HISTORY,
        requestId: httpRequestId,
        epoch: 2,
      });
      expect(unrelatedSubscriber.sentStrings.some((s) => {
        try { return (JSON.parse(s) as { type: string }).type === TIMELINE_MESSAGES.HISTORY; } catch { return false; }
      })).toBe(false);
    });

    it('serializes coalesced timeline fan-out one browser payload at a time and records backlog metrics', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const slowBrowser = new SlowMockWs();
      const fastBrowser = new MockWs();
      bridge.handleBrowserConnection(slowBrowser as never, 'test-user', makeDb('valid-hash'));
      bridge.handleBrowserConnection(fastBrowser as never, 'test-user', makeDb('valid-hash'));

      slowBrowser.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_sub_qwen' }));
      fastBrowser.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_sub_qwen' }));
      await flushAsync();

      slowBrowser.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'slow-browser-history',
      }));
      fastBrowser.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'fast-browser-history',
      }));
      const httpPending = bridge.requestTimelineHistory({
        sessionName: 'deck_sub_qwen',
        budgetBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE,
      });
      await flushAsync();

      const httpOutbound = daemonWs.sentStrings
        .map((s) => JSON.parse(s) as { type?: string; requestId?: string })
        .find((msg) => msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST && msg.requestId?.startsWith('watch-hist-'));
      expect(httpOutbound?.requestId).toBeTruthy();

      slowBrowser.sent.length = 0;
      fastBrowser.sent.length = 0;

      const largeText = 'x'.repeat(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE + 2048);
      const rawCoalescedResponse = JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestIds: ['slow-browser-history', 'fast-browser-history', httpOutbound!.requestId],
        payloadBytes: Buffer.byteLength(largeText, 'utf8'),
        events: [{
          eventId: 'large-fanout-e1',
          sessionId: 'deck_sub_qwen',
          ts: 100,
          type: 'assistant.text',
          payload: { text: largeText },
        }],
        epoch: 4,
      });
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stringifySpy = vi.spyOn(JSON, 'stringify');
      const historyStringifyCalls = () => stringifySpy.mock.calls.filter(([value]) => {
        const msg = value as { type?: unknown; events?: unknown } | null;
        return msg?.type === TIMELINE_MESSAGES.HISTORY && Array.isArray(msg.events);
      });

      try {
        daemonWs.emit('message', rawCoalescedResponse);
        await flushAsync();

        const enqueueStringifyCount = historyStringifyCalls().length;
        expect(getCounter('ws_bridge_timeline_data_plane_enqueue', {
          type: TIMELINE_MESSAGES.HISTORY,
          route: 'browser_request',
          backlog: 'empty',
        })).toBe(1);

        await flushOneBridgeDataPlaneTurn();
        await expect(httpPending).resolves.toMatchObject({
          type: TIMELINE_MESSAGES.HISTORY,
          requestId: httpOutbound!.requestId,
        });
        const afterHttpStringifyCount = historyStringifyCalls().length;
        expect(afterHttpStringifyCount).toBeGreaterThanOrEqual(enqueueStringifyCount);

        await flushOneBridgeDataPlaneTurn();
        const afterSlowBrowserStringifyCount = historyStringifyCalls().length;
        expect(afterSlowBrowserStringifyCount).toBeGreaterThanOrEqual(afterHttpStringifyCount);
        expect(slowBrowser.sentStrings.some((s) => JSON.parse(s).type === TIMELINE_MESSAGES.HISTORY)).toBe(true);
        expect(fastBrowser.sentStrings.some((s) => JSON.parse(s).type === TIMELINE_MESSAGES.HISTORY)).toBe(false);

        daemonWs.emit('message', JSON.stringify({
          type: 'command.ack',
          session: 'deck_sub_qwen',
          commandId: 'cmd-during-slow-fanout',
          status: 'ok',
        }));
        await flushAsync();

        expect(fastBrowser.sentStrings.map((s) => JSON.parse(s).type)).toContain('command.ack');

        slowBrowser.releaseNextSend();
        await flushOneBridgeDataPlaneTurn();
        expect(historyStringifyCalls().length).toBeGreaterThanOrEqual(afterSlowBrowserStringifyCount);
        expect(fastBrowser.sentStrings.map((s) => JSON.parse(s).type)).toContain(TIMELINE_MESSAGES.HISTORY);

        expect(getCounter('ws_bridge_timeline_data_plane_send', {
          type: TIMELINE_MESSAGES.HISTORY,
          route: 'browser_request',
          result: 'ok',
        })).toBeGreaterThanOrEqual(2);

        const sendLogs = consoleLogSpy.mock.calls.flatMap(([line]) => {
          if (typeof line !== 'string') return [];
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            return entry.msg === 'WsBridge timeline data-plane send' && entry.type === TIMELINE_MESSAGES.HISTORY ? [entry] : [];
          } catch {
            return [];
          }
        });
        const browserBacklogLog = sendLogs.find((entry) => entry.route === 'browser_request');
        expect(browserBacklogLog).toMatchObject({
          dataPlaneClass: 'timeline',
          recipientCount: 3,
          requestIdFanoutCount: 3,
          httpCallerCount: 1,
          queueDepthAtEnqueue: 1,
          queueDepthBeforeDrain: 1,
          attachmentCount: 3,
        });
        expect(typeof browserBacklogLog?.backlogAgeMs).toBe('number');
      } finally {
        slowBrowser.releaseAllSends();
        stringifySpy.mockRestore();
        consoleLogSpy.mockRestore();
      }
    });

    it('skips queued browser timeline delivery when the requester closes before data-plane drain', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const slowBrowser = new SlowMockWs();
      const closingBrowser = new MockWs();
      bridge.handleBrowserConnection(slowBrowser as never, 'test-user', makeDb('valid-hash'));
      bridge.handleBrowserConnection(closingBrowser as never, 'test-user', makeDb('valid-hash'));

      slowBrowser.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'slow-drain-history',
      }));
      closingBrowser.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'closing-drain-history',
      }));
      await flushAsync();
      slowBrowser.sent.length = 0;
      closingBrowser.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestIds: ['slow-drain-history', 'closing-drain-history'],
        events: [{ eventId: 'e1', sessionId: 'deck_sub_qwen', ts: 100, type: 'assistant.text', payload: { text: 'hi' } }],
        epoch: 2,
      }));
      closingBrowser.close();
      await flushOneBridgeDataPlaneTurn();
      slowBrowser.releaseNextSend();
      await flushBridgeDataPlane();

      expect(closingBrowser.sentStrings).toHaveLength(0);
      expect(getCounter('ws_bridge_timeline_data_plane_canceled', {
        type: TIMELINE_MESSAGES.HISTORY,
        route: 'browser_request',
      })).toBe(1);
    });

    it('rejects queued HTTP timeline delivery when bridge data-plane deadline expires', async () => {
      const nowSpy = vi.spyOn(performance, 'now');
      let now = 0;
      nowSpy.mockImplementation(() => now);
      // Pin a short deadline for the test — the production default was bumped
      // to 60s as part of the commit-42dfabec regression fix, so this scenario
      // would otherwise require simulating a minute of wall-clock passage.
      const resetQueueConfig = __setTimelineDataPlaneQueueConfigForTests({ deadlineMs: 15_000 });
      try {
        const { bridge, daemonWs } = await setupAuth();
        const slowBrowser = new SlowMockWs();
        bridge.handleBrowserConnection(slowBrowser as never, 'test-user', makeDb('valid-hash'));

        slowBrowser.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY_REQUEST,
          sessionName: 'deck_sub_qwen',
          requestId: 'slow-before-http',
        }));
        await flushAsync();
        slowBrowser.sent.length = 0;

        daemonWs.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY,
          sessionName: 'deck_sub_qwen',
          requestId: 'slow-before-http',
          events: [{ eventId: 'slow-e1', sessionId: 'deck_sub_qwen', ts: 100, type: 'assistant.text', payload: { text: 'hi' } }],
          epoch: 2,
        }));
        await flushOneBridgeDataPlaneTurn();

        const pending = bridge.requestTimelineHistory({
          sessionName: 'deck_sub_qwen',
          limit: 10,
        });
        const outbound = daemonWs.sentStrings
          .map((s) => JSON.parse(s) as { type?: string; requestId?: string })
          .find((msg) => msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST && msg.requestId?.startsWith('watch-hist-'));
        expect(outbound?.requestId).toBeTruthy();

        daemonWs.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY,
          sessionName: 'deck_sub_qwen',
          requestId: outbound!.requestId,
          events: [{ eventId: 'http-e1', sessionId: 'deck_sub_qwen', ts: 101, type: 'assistant.text', payload: { text: 'after' } }],
          epoch: 2,
        }));
        await flushAsync();

        const assertion = expect(pending).rejects.toThrow(TIMELINE_REQUEST_ERROR_REASONS.DEADLINE_EXCEEDED);
        now = 16_000;
        slowBrowser.releaseNextSend();
        await flushBridgeDataPlane();

        await assertion;
        expect(getCounter('ws_bridge_timeline_data_plane_deadline_exceeded', {
          type: TIMELINE_MESSAGES.HISTORY,
          route: 'http_request',
        })).toBe(1);
      } finally {
        resetQueueConfig();
        nowSpy.mockRestore();
      }
    });

    it('returns a request-scoped queue_full error when bridge data-plane queue capacity is exhausted', async () => {
      const resetQueueConfig = __setTimelineDataPlaneQueueConfigForTests({ queueCap: 1 });
      try {
        const { bridge, daemonWs } = await setupAuth();
        const browserOk = new MockWs();
        const browserQueueFull = new MockWs();
        bridge.handleBrowserConnection(browserOk as never, 'test-user', makeDb('valid-hash'));
        bridge.handleBrowserConnection(browserQueueFull as never, 'test-user', makeDb('valid-hash'));

        browserOk.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY_REQUEST,
          sessionName: 'deck_sub_qwen',
          requestId: 'queue-ok',
        }));
        browserQueueFull.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY_REQUEST,
          sessionName: 'deck_sub_qwen',
          requestId: 'queue-full',
        }));
        await flushAsync();

        daemonWs.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY,
          sessionName: 'deck_sub_qwen',
          requestId: 'queue-ok',
          events: [{ eventId: 'queue-e1', sessionId: 'deck_sub_qwen', ts: 100, type: 'assistant.text', payload: { text: 'ok' } }],
          epoch: 2,
        }));
        daemonWs.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY,
          sessionName: 'deck_sub_qwen',
          requestId: 'queue-full',
          events: [{ eventId: 'queue-e2', sessionId: 'deck_sub_qwen', ts: 101, type: 'assistant.text', payload: { text: 'queued' } }],
          epoch: 2,
        }));
        await flushAsync();

        expect(browserOk.sentStrings.some((s) => JSON.parse(s).type === TIMELINE_MESSAGES.HISTORY)).toBe(false);
        const queueFullResponses = browserQueueFull.sentStrings
          .map((s) => JSON.parse(s) as Record<string, unknown>)
          .filter((msg) => msg.type === TIMELINE_MESSAGES.HISTORY);
        expect(queueFullResponses).toHaveLength(1);
        expect(queueFullResponses[0]).toMatchObject({
          type: TIMELINE_MESSAGES.HISTORY,
          requestId: 'queue-full',
          status: TIMELINE_RESPONSE_STATUS.ERROR,
          errorReason: TIMELINE_REQUEST_ERROR_REASONS.QUEUE_FULL,
          events: [],
        });
        // Section-10 (post-deploy audit fix, commit f25f72e7) — transient
        // backpressure errors MUST carry `recoverable: true` so the web
        // `useTimeline.shouldRetryTimelineHistoryResponse` allow-list
        // triggers an auto-retry instead of stalling until manual refresh.
        expect(queueFullResponses[0].recoverable).toBe(true);

        await flushBridgeDataPlane();
        const okResponses = browserOk.sentStrings
          .map((s) => JSON.parse(s) as Record<string, unknown>)
          .filter((msg) => msg.type === TIMELINE_MESSAGES.HISTORY);
        expect(okResponses).toHaveLength(1);
        expect(okResponses[0]).toMatchObject({ requestId: 'queue-ok' });
        expect(getCounter('ws_bridge_timeline_data_plane_queue_full', {
          type: TIMELINE_MESSAGES.HISTORY,
          route: 'browser_request',
        })).toBe(1);
      } finally {
        resetQueueConfig();
      }
    });

    it('cancels queued HTTP timeline delivery on abort and never resolves a late success', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const slowBrowser = new SlowMockWs();
      bridge.handleBrowserConnection(slowBrowser as never, 'test-user', makeDb('valid-hash'));

      slowBrowser.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'slow-before-http-abort',
      }));
      await flushAsync();
      slowBrowser.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestId: 'slow-before-http-abort',
        events: [{ eventId: 'slow-abort-e1', sessionId: 'deck_sub_qwen', ts: 100, type: 'assistant.text', payload: { text: 'hold' } }],
        epoch: 2,
      }));
      await flushOneBridgeDataPlaneTurn();
      expect(slowBrowser.sentStrings.some((s) => JSON.parse(s).type === TIMELINE_MESSAGES.HISTORY)).toBe(true);

      const abortController = new AbortController();
      const pending = bridge.requestTimelineHistory({
        sessionName: 'deck_sub_qwen',
        limit: 10,
        abortSignal: abortController.signal,
      });
      await flushAsync();
      const outbound = daemonWs.sentStrings
        .map((s) => JSON.parse(s) as { type?: string; requestId?: string })
        .find((msg) => msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST && msg.requestId?.startsWith('watch-hist-'));
      expect(outbound?.requestId).toBeTruthy();

      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestId: outbound!.requestId,
        events: [{ eventId: 'http-abort-e1', sessionId: 'deck_sub_qwen', ts: 101, type: 'assistant.text', payload: { text: 'late' } }],
        epoch: 2,
      }));
      await flushAsync();

      const assertion = expect(pending).rejects.toThrow(TIMELINE_REQUEST_ERROR_REASONS.REQUEST_CANCELED);
      abortController.abort();
      await assertion;
      expect(getCounter('ws_bridge_timeline_data_plane_http_abort', {
        type: TIMELINE_MESSAGES.HISTORY,
        route: 'http_request',
      })).toBe(1);

      slowBrowser.releaseNextSend();
      await flushBridgeDataPlane();
      expect(getCounter('ws_bridge_timeline_data_plane_canceled', {
        type: TIMELINE_MESSAGES.HISTORY,
        route: 'http_request',
      })).toBe(1);
    });

    it('defers large timeline data-plane sends so command.ack can pass first', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_sub_qwen' }));
      browserWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId: 'large-history',
        limit: 50,
      }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestId: 'large-history',
        events: [{
          eventId: 'large-e1',
          sessionId: 'deck_sub_qwen',
          ts: 100,
          type: 'assistant.text',
          payload: { text: 'x'.repeat(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE + 1024) },
        }],
        epoch: 3,
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'command.ack',
        session: 'deck_sub_qwen',
        commandId: 'cmd-after-large',
        status: 'ok',
      }));
      await flushAsync();

      let sentTypes = browserWs.sentStrings.map((s) => JSON.parse(s) as { type: string });
      expect(sentTypes.map((msg) => msg.type)).toEqual(['command.ack']);

      await flushBridgeDataPlane();
      sentTypes = browserWs.sentStrings.map((s) => JSON.parse(s) as { type: string });
      expect(sentTypes.map((msg) => msg.type)).toEqual(['command.ack', TIMELINE_MESSAGES.HISTORY]);
    });
  });

  describe('HTTP timeline history relay', () => {
    async function setupAuth() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      return { bridge, daemonWs };
    }

    it('resolves HTTP timeline history requests without browser subscriptions', async () => {
      const { bridge, daemonWs } = await setupAuth();

      const pending = bridge.requestTimelineHistory({
        sessionName: 'deck_sub_qwen',
        limit: 50,
        beforeTs: 200,
      });

      const outbound = daemonWs.sentStrings.find((s) => s.includes('"type":"timeline.history_request"'));
      expect(outbound).toBeTruthy();
      const requestId = JSON.parse(outbound!).requestId as string;

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.history',
        sessionName: 'deck_sub_qwen',
        requestId,
        events: [{ eventId: 'e1', sessionId: 'deck_sub_qwen', ts: 100, type: 'assistant.text', payload: { text: 'hi' } }],
        epoch: 2,
      }));
      await expect(pending).resolves.toMatchObject({
        type: 'timeline.history',
        requestId,
        epoch: 2,
      });
    });

    it('rejects pending HTTP history requests when daemon disconnects', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const pending = bridge.requestTimelineHistory({ sessionName: 'deck_sub_qwen' });
      daemonWs.close();
      await expect(pending).rejects.toThrow('daemon_disconnected');
    });

    it('rejects HTTP history requests on timeout and cleans pending state', async () => {
      vi.useFakeTimers();
      try {
        const { bridge, daemonWs } = await setupAuth();
        const pending = bridge.requestTimelineHistory({
          sessionName: 'deck_sub_qwen',
          timeoutMs: 25,
        });
        const assertion = expect(pending).rejects.toThrow('timeout');

        const outbound = daemonWs.sentStrings.find((s) => s.includes('"type":"timeline.history_request"'));
        expect(outbound).toBeTruthy();

        await vi.advanceTimersByTimeAsync(26);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('watch recentText cache', () => {
    async function setupAuth() {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      return { bridge, daemonWs };
    }

    it('keeps only the newest 5 user/assistant events per session', async () => {
      const { bridge, daemonWs } = await setupAuth();
      for (let i = 1; i <= 6; i++) {
        daemonWs.emit('message', JSON.stringify({
          type: 'timeline.event',
          event: {
            eventId: `e${i}`,
            sessionId: 'deck_proj_brain',
            ts: i,
            type: i % 2 === 0 ? 'assistant.text' : 'user.message',
            payload: { text: `message ${i}` },
          },
        }));
      }
      await flushAsync();

      expect(bridge.getRecentText('deck_proj_brain')).toEqual([
        { eventId: 'e2', type: 'assistant.text', text: 'message 2', ts: 2 },
        { eventId: 'e3', type: 'user.message', text: 'message 3', ts: 3 },
        { eventId: 'e4', type: 'assistant.text', text: 'message 4', ts: 4 },
        { eventId: 'e5', type: 'user.message', text: 'message 5', ts: 5 },
        { eventId: 'e6', type: 'assistant.text', text: 'message 6', ts: 6 },
      ]);
    });

    it('clears cached recentText on sub-session removal and daemon reconnect', async () => {
      const { bridge, daemonWs } = await setupAuth();
      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'e1',
          sessionId: 'deck_sub_worker',
          ts: 1,
          type: 'assistant.text',
          payload: { text: 'worker text' },
        },
      }));
      await flushAsync();
      expect(bridge.getRecentText('deck_sub_worker')).toHaveLength(1);

      daemonWs.emit('message', JSON.stringify({ type: 'subsession.closed', id: 'worker', sessionName: 'deck_sub_worker' }));
      await flushAsync();
      expect(bridge.getRecentText('deck_sub_worker')).toHaveLength(0);

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'e2',
          sessionId: 'deck_proj_brain',
          ts: 2,
          type: 'assistant.text',
          payload: { text: 'before reconnect' },
        },
      }));
      await flushAsync();
      expect(bridge.getRecentText('deck_proj_brain')).toHaveLength(1);

      daemonWs.close();
      await flushAsync();
      expect(bridge.getRecentText('deck_proj_brain')).toHaveLength(0);

      const newDaemonWs = new MockWs();
      bridge.handleDaemonConnection(newDaemonWs as never, makeDb('valid-hash'), {} as never);
      newDaemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      expect(bridge.getRecentText('deck_proj_brain')).toHaveLength(0);
    });

    it('backfills recentText from timeline history when the hot cache is empty', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const pending = bridge.getRecentTextForWatch('deck_proj_brain', 1000);

      const outbound = daemonWs.sentStrings.find((s) => s.includes('"type":"timeline.history_request"'));
      expect(outbound).toBeTruthy();
      const requestId = JSON.parse(outbound!).requestId as string;

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.history',
        sessionName: 'deck_proj_brain',
        requestId,
        events: [
          { eventId: 'e1', sessionId: 'deck_proj_brain', ts: 1, type: 'assistant.text', payload: { text: 'first' } },
          { eventId: 'e2', sessionId: 'deck_proj_brain', ts: 2, type: 'tool.call', payload: { raw: { noisy: true } } },
          { eventId: 'e3', sessionId: 'deck_proj_brain', ts: 3, type: 'user.message', payload: { text: 'second' } },
        ],
        epoch: 1,
      }));

      await expect(pending).resolves.toEqual([
        { eventId: 'e1', type: 'assistant.text', text: 'first', ts: 1 },
        { eventId: 'e3', type: 'user.message', text: 'second', ts: 3 },
      ]);
      expect(bridge.getRecentText('deck_proj_brain')).toEqual([
        { eventId: 'e1', type: 'assistant.text', text: 'first', ts: 1 },
        { eventId: 'e3', type: 'user.message', text: 'second', ts: 3 },
      ]);
    });

    it('fails open when session_text_tail_cache update throws', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      const db = makeDb('valid-hash') as import('../src/db/client.js').Database & { transaction: ReturnType<typeof vi.fn> };
      db.transaction = vi.fn(async () => { throw new Error('write failed'); }) as never;
      const browserWs = new MockWs();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      bridge.handleBrowserConnection(browserWs as never, 'user-1', db);
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'deck_proj_brain' }));
      await flushAsync();
      browserWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'timeline.event',
        event: {
          eventId: 'e1',
          sessionId: 'deck_proj_brain',
          ts: 1,
          type: 'assistant.text',
          payload: { text: 'still delivered' },
        },
      }));
      await flushAsync();

      expect(browserWs.sentStrings.some((msg) => msg.includes('"type":"timeline.event"'))).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
