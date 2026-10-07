import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ASK_ANSWER_COMMAND } from '../../shared/ask-answer.js';
import { AGENT_SKILLS_MESSAGE_PREFIX, AGENT_SKILLS_MSG } from '../../shared/agent-skills.js';
import { AGENT_MCP_MESSAGE_PREFIX, AGENT_MCP_MSG } from '../../shared/agent-mcp.js';
import { EventEmitter } from 'node:events';
import logger from '../src/util/logger.js';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import {
  WsBridge,
  __setIdlePushSettleMsForTests,
  __setLegacyUpgradePublisherSignerResolverForTests,
  __setTimelineDataPlaneQueueConfigForTests,
} from '../src/ws/bridge.js';
import { getCounter, resetMetricsForTests } from '../src/util/metrics.js';
import {
  markDaemonUpgradeTargetVersionPublishedForTest,
  resetDaemonUpgradePublicationGateForTest,
} from '../src/ws/daemon-upgrade-publication-gate.js';
import * as dbQueries from '../src/db/queries.js';
import { REMOTE_DESKTOP_LOGIN_SCREEN_MSG } from '../../shared/remote-desktop-login-screen.js';
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
import { DIRECT_FILE_TRANSFER_LEASE_CAPABILITY } from '../../shared/direct-file-transfer.js';
import { REPO_MSG } from '../../shared/repo-types.js';
import { FS_TRANSPORT_MSG } from '../../shared/fs-transport-messages.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import {
  TIMELINE_HISTORY_CANCEL_CAPABILITY,
  TIMELINE_CURSOR_DIRECTIONS,
  TIMELINE_MESSAGES,
  TIMELINE_PROTOCOL_CAPABILITY,
  TIMELINE_PROTOCOL_REVISION,
  TIMELINE_RESPONSE_SOURCES,
  TIMELINE_RESPONSE_STATUS,
} from '../../shared/timeline-protocol.js';
import { TIMELINE_HISTORY_LIMITS } from '../../shared/timeline-history-limits.js';
import { TIMELINE_REQUEST_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import { OPENSPEC_AUTO_DELIVER_MSG } from '../../shared/openspec-auto-deliver-constants.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { DAEMON_STATS_MSG } from '../../shared/daemon-stats.js';
import {
  CONTROLLED_NODE_WORKER_REFRESH_CAPABILITY,
  CONTROLLED_NODE_WORKER_REFRESH_MSG,
  CONTROLLED_NODE_WORKER_REFRESH_PHASE,
} from '../../shared/controlled-node-worker-refresh.js';
import { listControlledMachines } from '../src/routes/machines.js';
import {
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_REQUIRED_CAPABILITIES,
} from '../../shared/direct-file-transfer.js';
import {
  CONTROLLED_NODE_UPGRADE_STAGGER_MAX_MS,
  controlledNodeUpgradeStaggerMs,
  DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION,
  DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL,
  CONTROLLED_NODE_UPGRADE_STATUS,
  CONTROLLED_NODE_UPGRADE_WAIT_REASON,
  DAEMON_UPGRADE_BLOCK_REASON,
  DAEMON_UPGRADE_BUSY_RETRY_INTERVAL_MS,
  DAEMON_UPGRADE_COOLDOWN_RETRY_MIN_MS,
  DAEMON_UPGRADE_DEFERRAL,
  DAEMON_UPGRADE_DEFERRAL_FIELD,
  DAEMON_UPGRADE_DEFERRAL_RETRY_MARGIN_MS,
  DAEMON_UPGRADE_DELIVERY_STATUS,
  DAEMON_UPGRADE_RETRY_AFTER_FIELD,
  DAEMON_UPGRADE_IDLE_EDGE_MIN_INTERVAL_MS,
} from '../../shared/daemon-upgrade.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { CLOCK_SYNC_FIELD } from '../../shared/clock-sync.js';
import { DAEMON_AUTH_RECONCILE_BUDGET_MS, DAEMON_AUTH_RECONCILE_RETRY_DELAYS_MS } from '../../shared/daemon-auth.js';
import { PEER_AUDIT_COMMAND_ERRORS, PEER_AUDIT_MESSAGES } from '../../shared/peer-audit.js';
import {
  REMOTE_EXEC_MAX_CHUNK_BYTES,
  REMOTE_EXEC_MAX_ERROR_BYTES,
  REMOTE_EXEC_MAX_OUTPUT_BYTES,
} from '../../shared/remote-exec.js';
import {
  cancelPendingExec,
  machineExecRegistryStats,
  registerPendingExec,
} from '../src/ws/machine-exec-registry.js';
import { CONTROLLED_NODE_OS_LINUX, CONTROLLED_NODE_OS_WIN, type ControlledNodeOs } from '../../shared/controlled-node-artifacts.js';
import { CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY } from '../../shared/controlled-node-service.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_MSG,
} from '../../shared/remote-desktop-install.js';
import {
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  REMOTE_DESKTOP_NODE_CONTEXT_MSG,
  type RemoteDesktopConsentRequest,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
} from '../../shared/remote-desktop.js';
import {
  LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX,
  LEGACY_WINDOWS_UPGRADE_RESTART_READY_PREFIX,
} from '../src/ws/windows-controlled-node-upgrade-rescue.js';

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

  /** When true, `send` accepts the frame but NEVER invokes the completion
   *  callback — the shape of a peer whose receive side has stopped draining, so
   *  the bridge's in-flight accounting keeps climbing. Off by default. */
  stallSend = false;
  /** Pending completion callbacks captured while `stallSend` is on. */
  stalledCallbacks: Array<(err?: Error) => void> = [];

  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) {
      const err = new Error('socket closed');
      if (callback) { callback(err); return; }
      throw err;
    }
    this.sent.push(data);
    if (this.stallSend) {
      if (callback) this.stalledCallbacks.push(callback);
      return;
    }
    callback?.();
  }

  /** Release every stalled completion callback (peer started reading again). */
  drainStalledSends() {
    const pending = this.stalledCallbacks.splice(0, this.stalledCallbacks.length);
    for (const cb of pending) cb();
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

function makeDb(
  tokenHash: string,
  nodeRole: 'full' | 'controlled' = 'full',
  os: ControlledNodeOs | null = nodeRole === 'controlled' ? CONTROLLED_NODE_OS_LINUX : null,
  ownerUserId?: string,
  controlledUpgrade?: { status: string; target: string | null; reason?: string | null },
  nodeId?: string | null,
) {
  const db = {
    queryOne: async () => ({
      token_hash: tokenHash,
      node_role: nodeRole,
      revoked_at: null,
      os,
      ...(nodeId !== undefined ? { node_id: nodeId } : {}),
      ...(ownerUserId ? { user_id: ownerUserId } : {}),
      ...(controlledUpgrade
        ? {
          controlled_upgrade_status: controlledUpgrade.status,
          controlled_upgrade_target_version: controlledUpgrade.target,
          controlled_upgrade_reason: controlledUpgrade.reason ?? null,
        }
        : {}),
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
  randomHex: (bytes: number) => 'a'.repeat(bytes * 2),
  // The bridge fixture replaces crypto globally; keep its ticket seam
  // structurally valid so the direct-file route tests the actual rebind flow.
  signJwt: (payload: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`,
  verifyJwt: (ticket: string) => {
    try {
      const payload = ticket.split('.')[1];
      return payload ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown> : null;
    } catch {
      return null;
    }
  },
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
  let restoreUpgradePublisherSignerResolver: () => void;

  beforeEach(() => {
    serverId = `test-${Math.random().toString(36).slice(2)}`;
    restoreUpgradePublisherSignerResolver = __setLegacyUpgradePublisherSignerResolverForTests(
      async () => 'a'.repeat(64),
    );
    resetDaemonUpgradePublicationGateForTest();
    markDaemonUpgradeTargetVersionPublishedForTest('2026.4.905-dev.877');
    markDaemonUpgradeTargetVersionPublishedForTest('2026.4.905');
    resetMetricsForTests();
  });

  afterEach(() => {
    restoreUpgradePublisherSignerResolver();
    WsBridge.setRemoteDesktopReconnectRevalidator(null);
    WsBridge.getAll().clear();
    resetDaemonUpgradePublicationGateForTest();
    resetMetricsForTests();
    vi.clearAllMocks();
  });

  it('closes when any second frame arrives before bootstrap redemption', async () => {
    const bridge = WsBridge.get(serverId);
    const ws = new MockWs();
    const redeemGuestBootstrap = vi.fn(async () => true);
    const handleGuestBrowser = vi.fn(async () => true);
    Object.defineProperty(bridge, 'remoteDesktopRouter', {
      value: {
        redeemGuestBootstrap,
        handleGuestBrowser,
        dropSocket: vi.fn(),
      },
    });
    bridge.handleGuestRemoteDesktopConnection(ws as never, makeDb('valid-hash'));

    ws.emit('message', Buffer.from(JSON.stringify({
      ticket: 'A'.repeat(43),
      browserKeyThumbprint: 'B'.repeat(43),
      signature: 'C'.repeat(86),
    })));
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'remote_desktop.start',
      protocolVersion: 'remote-desktop.v1',
      requestId: 'guest_request_123456',
    })));
    await flushAsync();
    expect(redeemGuestBootstrap).not.toHaveBeenCalled();
    expect(handleGuestBrowser).not.toHaveBeenCalled();
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
  });

  it('acknowledges bootstrap redemption before accepting START', async () => {
    const bridge = WsBridge.get(serverId);
    const ws = new MockWs();
    const handleGuestBrowser = vi.fn(async () => true);
    const redeemGuestBootstrap = vi.fn(async () => true);
    Object.defineProperty(bridge, 'remoteDesktopRouter', {
      value: {
        redeemGuestBootstrap,
        handleGuestBrowser,
        dropSocket: vi.fn(),
      },
    });
    bridge.handleGuestRemoteDesktopConnection(ws as never, makeDb('valid-hash'), '203.0.113.55');

    ws.emit('message', Buffer.from(JSON.stringify({
      ticket: 'A'.repeat(43),
      browserKeyThumbprint: 'B'.repeat(43),
      signature: 'C'.repeat(86),
    })));
    await flushAsync();
    expect(redeemGuestBootstrap).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ ticket: 'A'.repeat(43) }),
      '203.0.113.55',
    );
    expect(ws.sentStrings.map((raw) => JSON.parse(raw))).toContainEqual({
      type: 'remote_desktop.bootstrap_redeemed',
    });

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'remote_desktop.start',
      protocolVersion: 'remote-desktop.v1',
      requestId: 'guest_request_123456',
    })));
    await flushAsync();
    expect(handleGuestBrowser).toHaveBeenCalledOnce();
    expect(ws.closed).toBe(false);
  });

  it('admits an exact route resume as the sole first guest frame', async () => {
    const bridge = WsBridge.get(serverId);
    const ws = new MockWs();
    const resumeGuestBrowser = vi.fn(async () => true);
    const handleGuestBrowser = vi.fn(async () => true);
    Object.defineProperty(bridge, 'remoteDesktopRouter', {
      value: {
        resumeGuestBrowser,
        redeemGuestBootstrap: vi.fn(),
        handleGuestBrowser,
        dropSocket: vi.fn(),
      },
    });
    bridge.handleGuestRemoteDesktopConnection(ws as never, makeDb('valid-hash'));
    const resume = {
      type: REMOTE_DESKTOP_MSG.RESUME,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      requestId: 'guest_request_123456',
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
    };

    ws.emit('message', Buffer.from(JSON.stringify(resume)));
    await flushAsync();

    expect(resumeGuestBrowser).toHaveBeenCalledWith(ws, resume);
    expect(ws.closed).toBe(false);
    expect(handleGuestBrowser).not.toHaveBeenCalled();
  });

  it('closes a first-frame guest resume whose exact live authority is absent', async () => {
    const bridge = WsBridge.get(serverId);
    const ws = new MockWs();
    const dropSocket = vi.fn();
    Object.defineProperty(bridge, 'remoteDesktopRouter', {
      value: {
        resumeGuestBrowser: vi.fn(async () => false),
        redeemGuestBootstrap: vi.fn(),
        handleGuestBrowser: vi.fn(),
        dropSocket,
      },
    });
    bridge.handleGuestRemoteDesktopConnection(ws as never, makeDb('valid-hash'));

    ws.emit('message', Buffer.from(JSON.stringify({
      type: REMOTE_DESKTOP_MSG.RESUME,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      requestId: 'guest_request_123456',
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
    })));
    await flushAsync();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(dropSocket).toHaveBeenCalledWith(ws);
  });

  it('closes an anonymous socket that never supplies its bounded first proof', async () => {
    vi.useFakeTimers();
    try {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleGuestRemoteDesktopConnection(ws as never, makeDb('valid-hash'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(1008);
      expect(ws.closeReason).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches consent only on the authenticated authority-ready owning generation', () => {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    const internals = bridge as unknown as {
      daemonWs: MockWs;
      authenticated: boolean;
      daemonGeneration: number;
      remoteDesktopAuthorityReadyGeneration: number | null;
      daemonNodeRole: 'controlled';
      controlledNodeCapabilities: Set<string>;
      trySendRemoteDesktopConsent(command: {
        executionServerId: string;
        daemonGeneration: number;
        message: RemoteDesktopConsentRequest;
      }): boolean;
    };
    internals.daemonWs = daemon;
    internals.authenticated = true;
    internals.daemonGeneration = 4;
    internals.daemonNodeRole = 'controlled';
    internals.controlledNodeCapabilities = new Set([
      REMOTE_DESKTOP_CAPABILITY,
      REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
    ]);
    const message: RemoteDesktopConsentRequest = {
      type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
      approvalId: 'approval-00000000-0000-4000-8000-000000000001',
      hostId: 'host-00000000-0000-4000-8000-000000000001',
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      requesterLabel: 'Remote guest',
      createdAt: 1_800_000_000_000,
      deadlineAt: 1_800_000_030_000,
      daemonGeneration: 4,
    };
    const command = { executionServerId: serverId, daemonGeneration: 4, message };

    internals.remoteDesktopAuthorityReadyGeneration = null;
    expect(internals.trySendRemoteDesktopConsent(command)).toBe(false);
    expect(daemon.sent).toEqual([]);

    internals.remoteDesktopAuthorityReadyGeneration = 4;
    expect(internals.trySendRemoteDesktopConsent(command)).toBe(true);
    expect(daemon.sentStrings.map((value) => JSON.parse(value))).toEqual([message]);
    expect(internals.trySendRemoteDesktopConsent({ ...command, daemonGeneration: 3 })).toBe(false);
    expect(daemon.sent).toHaveLength(1);
  });

  describe('daemon auth', () => {
    const originalAppVersion = process.env.APP_VERSION;
    const originalAutoUpgradeDisable = process.env.IMCODES_DISABLE_AUTO_UPGRADE;

    afterEach(() => {
      if (originalAppVersion == null) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = originalAppVersion;
      if (originalAutoUpgradeDisable == null) delete process.env.IMCODES_DISABLE_AUTO_UPGRADE;
      else process.env.IMCODES_DISABLE_AUTO_UPGRADE = originalAutoUpgradeDisable;
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

    it('keeps remote desktop unavailable until each reconnect revalidates durable authority', async () => {
      const releases: Array<() => void> = [];
      const revalidate = vi.fn(() => new Promise<void>((resolve) => { releases.push(resolve); }));
      WsBridge.setRemoteDesktopReconnectRevalidator(revalidate);
      const bridge = WsBridge.get(serverId);

      const first = new MockWs();
      bridge.handleDaemonConnection(
        first as never,
        makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN),
        {} as never,
      );
      first.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', capabilities: [REMOTE_DESKTOP_CAPABILITY],
      }));
      await flushAsync();
      expect(revalidate).toHaveBeenCalledWith(serverId);
      expect(WsBridge.remoteDesktopGuestOutboxTarget(serverId)?.isAvailable()).toBe(false);
      releases.shift()?.();
      await flushAsync();
      expect(WsBridge.remoteDesktopGuestOutboxTarget(serverId)?.isAvailable()).toBe(true);

      const replacement = new MockWs();
      bridge.handleDaemonConnection(
        replacement as never,
        makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN),
        {} as never,
      );
      replacement.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', capabilities: [REMOTE_DESKTOP_CAPABILITY],
      }));
      await flushAsync();
      expect(revalidate).toHaveBeenCalledTimes(2);
      expect(WsBridge.remoteDesktopGuestOutboxTarget(serverId)?.isAvailable()).toBe(false);
      releases.shift()?.();
      await flushAsync();
      expect(WsBridge.remoteDesktopGuestOutboxTarget(serverId)?.isAvailable()).toBe(true);
    });

    describe('the public node ID in a controlled node\'s heartbeat ack', () => {
      async function ackAfterHeartbeat(db: import('../src/db/client.js').Database) {
        const bridge = WsBridge.get(serverId);
        const ws = new MockWs();
        bridge.handleDaemonConnection(ws as never, db, {} as never);
        ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', capabilities: [] }));
        await flushAsync();
        ws.emit('message', JSON.stringify({ type: 'heartbeat' }));
        await flushAsync();
        const acks = ws.sentStrings.map((value) => JSON.parse(value)).filter((frame) => frame.type === 'heartbeat_ack');
        expect(acks.length).toBeGreaterThan(0);
        return acks[acks.length - 1] as Record<string, unknown>;
      }

      it('carries the node\'s own public ID and the server ID it is for, so a node enrolled before IDs existed can adopt it', async () => {
        const ack = await ackAfterHeartbeat(makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN, undefined, undefined, '9909368908'));
        expect(ack).toMatchObject({ type: 'heartbeat_ack', nodeId: '9909368908', serverId });
      });

      it('carries nothing for a controlled node with no usable ID, and nothing for a full daemon (no change for either)', async () => {
        for (const nodeId of [null, '', 'not-an-id', '99093689', '0909368908']) {
          const ack = await ackAfterHeartbeat(makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN, undefined, undefined, nodeId));
          expect(ack).not.toHaveProperty('nodeId');
          expect(ack).not.toHaveProperty('serverId');
        }
        const full = await ackAfterHeartbeat(makeDb('valid-hash', 'full', null, undefined, undefined, '9909368908'));
        expect(full).not.toHaveProperty('nodeId');
        expect(full).not.toHaveProperty('serverId');
      });

      describe('the deployment\'s public origins (IMCODES_PUBLIC_URLS) for a controlled node\'s fallback', () => {
        const original = process.env.IMCODES_PUBLIC_URLS;
        afterEach(() => {
          if (original === undefined) delete process.env.IMCODES_PUBLIC_URLS; else process.env.IMCODES_PUBLIC_URLS = original;
        });

        it('are advertised to an authenticated controlled node, validated and normalized', async () => {
          process.env.IMCODES_PUBLIC_URLS = 'https://im.example, https://proxy.example http://plain.example https://u:p@x.example/p';
          const ack = await ackAfterHeartbeat(makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN));
          expect(ack.serverUrls).toEqual(['https://im.example', 'https://proxy.example']);
        });

        it('advertise nothing by default (unset or empty = the old behaviour), and never to a full daemon', async () => {
          delete process.env.IMCODES_PUBLIC_URLS;
          expect(await ackAfterHeartbeat(makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN))).not.toHaveProperty('serverUrls');
          process.env.IMCODES_PUBLIC_URLS = '';
          expect(await ackAfterHeartbeat(makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN))).not.toHaveProperty('serverUrls');
          process.env.IMCODES_PUBLIC_URLS = 'https://im.example';
          expect(await ackAfterHeartbeat(makeDb('valid-hash', 'full', null))).not.toHaveProperty('serverUrls');
        });
      });
    });

    it('sends an exact generation-bound worker repair request to an installable controlled node', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(
        ws as never,
        makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN),
        {} as never,
      );
      ws.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        capabilities: [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY],
      }));
      await flushAsync();

      const result = bridge.tryInstallControlledNodeRemoteDesktopWorker(
        bridge.daemonConnectionGeneration(),
      );
      expect(result).toBe('sent');
      expect(ws.sentStrings.map((value) => JSON.parse(value))).toContainEqual({
        type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST,
      });
      expect(bridge.tryInstallControlledNodeRemoteDesktopWorker(
        bridge.daemonConnectionGeneration() - 1,
      )).toBe('generation_changed');
      expect(ws.sentStrings.map((value) => JSON.parse(value))).toContainEqual({
        type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE,
        daemonGeneration: bridge.daemonConnectionGeneration(),
      });
    });

    it('sends an exact generation-bound independent worker refresh request', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(
        ws as never,
        makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN),
        {} as never,
      );
      ws.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', capabilities: [
          REMOTE_DESKTOP_CAPABILITY,
          CONTROLLED_NODE_WORKER_REFRESH_CAPABILITY,
        ],
      }));
      await flushAsync();

      expect(bridge.tryRefreshControlledNodeRemoteDesktopWorker(
        bridge.daemonConnectionGeneration(),
      )).toBe('sent');
      expect(ws.sentStrings.map((value) => JSON.parse(value))).toContainEqual({
        type: CONTROLLED_NODE_WORKER_REFRESH_MSG.REQUEST,
      });
      expect(bridge.tryRefreshControlledNodeRemoteDesktopWorker(
        bridge.daemonConnectionGeneration() - 1,
      )).toBe('generation_changed');
    });

    it('publishes the canonical host context and actively clears it when the mapping disappears', async () => {
      let hostId: string | null = 'host-00000000000000000001';
      const db = {
        queryOne: async (sql: string) => {
          if (sql.includes('remote_desktop_host_endpoints')) return hostId ? { host_id: hostId } : null;
          return {
            token_hash: 'valid-hash',
            node_role: 'controlled',
            revoked_at: null,
            os: CONTROLLED_NODE_OS_WIN,
          };
        },
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => (
          fn(db as unknown as import('../src/db/client.js').Database)
        ),
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, db, {} as never);
      ws.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        capabilities: [],
      }));
      await flushAsync();
      const generation = bridge.daemonConnectionGeneration();
      expect(ws.sentStrings.map((value) => JSON.parse(value))).toContainEqual({
        type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
        hostId: 'host-00000000000000000001',
        daemonGeneration: generation,
      });

      hostId = null;
      ws.emit('message', JSON.stringify({ type: 'heartbeat' }));
      await flushAsync();
      expect(ws.sentStrings.map((value) => JSON.parse(value))).toContainEqual({
        type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE,
        daemonGeneration: generation,
      });
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
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      await flushAsync();
      browserWs.sent = [];
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
      const browserTypes = browserWs.sentStrings.map((raw) => JSON.parse(raw).type as string);
      const reconnectedIndex = browserTypes.indexOf(DAEMON_MSG.RECONNECTED);
      const helloIndex = browserTypes.indexOf(P2P_WORKFLOW_MSG.DAEMON_HELLO);
      expect(reconnectedIndex).toBeGreaterThanOrEqual(0);
      expect(helloIndex).toBeGreaterThan(reconnectedIndex);
    });

    it('persists, broadcasts, restores, and projects controlled worker refresh status', async () => {
      const persisted: Record<string, unknown> = {};
      const writes: Array<{ sql: string; params: unknown[] }> = [];
      const db = {
        queryOne: async () => ({
          token_hash: 'valid-hash',
          node_role: 'controlled',
          revoked_at: null,
          os: CONTROLLED_NODE_OS_LINUX,
          ...persisted,
        }),
        query: async () => [],
        execute: async (sql: string, params: unknown[] = []) => {
          writes.push({ sql, params });
          if (sql.includes('controlled_worker_refresh_attempt_id')) {
            [
              'controlled_worker_refresh_attempt_id',
              'controlled_worker_refresh_phase',
              'controlled_worker_refresh_installed_version',
              'controlled_worker_refresh_target_version',
              'controlled_worker_refresh_artifact_sha256',
              'controlled_worker_refresh_reason',
              'controlled_worker_refresh_recorded_at',
            ].forEach((key, index) => { persisted[key] = params[index]; });
          }
          return { changes: 1 };
        },
        exec: async () => {},
        transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;
      const bridge = WsBridge.get(serverId);
      const daemon = new MockWs();
      const browser = new MockWs();
      bridge.handleBrowserConnection(browser as never, 'test-user', db);
      bridge.handleDaemonConnection(daemon as never, db, {} as never);
      daemon.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.9.1', capabilities: [],
      }));
      await flushAsync();

      const started = {
        type: DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS,
        attemptId: 'attempt-refresh-1',
        phase: CONTROLLED_NODE_WORKER_REFRESH_PHASE.STARTED,
        targetVersion: '2026.10.1',
        recordedAt: 1_700_000_000_000,
      };
      daemon.emit('message', JSON.stringify(started));
      await flushBridgeDataPlane();
      const succeeded = {
        ...started,
        phase: CONTROLLED_NODE_WORKER_REFRESH_PHASE.SUCCEEDED,
        installedVersion: '2026.10.1',
        artifactSha256: 'a'.repeat(64),
        recordedAt: started.recordedAt + 1,
      };
      daemon.emit('message', JSON.stringify(succeeded));
      await flushBridgeDataPlane();

      expect(writes.filter(({ sql }) => sql.includes('controlled_worker_refresh_attempt_id'))).toHaveLength(2);
      expect(browser.sentStrings.map((raw) => JSON.parse(raw)).filter((msg) => msg.type === started.type)).toEqual([
        expect.objectContaining({ phase: 'started', attemptId: started.attemptId }),
        expect.objectContaining({ phase: 'succeeded', installedVersion: '2026.10.1', artifactSha256: 'a'.repeat(64) }),
      ]);

      const beforeInvalid = writes.length;
      daemon.emit('message', JSON.stringify({ ...succeeded, unexpected: true }));
      await flushAsync();
      expect(writes).toHaveLength(beforeInvalid);

      WsBridge.getAll().clear();
      const restoredBridge = WsBridge.get(serverId);
      const restoredDaemon = new MockWs();
      restoredBridge.handleDaemonConnection(restoredDaemon as never, db, {} as never);
      restoredDaemon.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.9.1', capabilities: [],
      }));
      await flushAsync();
      expect(restoredBridge.getControlledNodeWorkerRefreshStatus()).toEqual(expect.objectContaining({
        phase: CONTROLLED_NODE_WORKER_REFRESH_PHASE.SUCCEEDED,
        installedVersion: '2026.10.1',
      }));
      const reconnectedBrowser = new MockWs();
      restoredBridge.handleBrowserConnection(reconnectedBrowser as never, 'test-user', db);
      expect(reconnectedBrowser.sentStrings.map((raw) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
        type: DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS,
        phase: CONTROLLED_NODE_WORKER_REFRESH_PHASE.SUCCEEDED,
        artifactSha256: 'a'.repeat(64),
      }));

      const listDb = {
        query: async () => [{
          id: serverId,
          node_id: '1234567890',
          user_id: 'test-user',
          ref_name: 'worker',
          display_name: 'worker',
          status: 'online',
          last_heartbeat_at: Date.now(),
          exec_enabled: true,
          os: CONTROLLED_NODE_OS_LINUX,
          daemon_version: '2026.9.1',
          auto_unlock_configured: false,
          revoked_at: null,
          access_role: 'owner',
          access_expires_at: null,
          controlled_capabilities: [],
          controlled_upgrade_status: null,
          controlled_upgrade_target_version: null,
          controlled_upgrade_reason: null,
          ...persisted,
          node_role: 'controlled',
          host_server_id: null,
          remote_desktop_host_id: null,
          team_ids: [],
          team_names: [],
        }],
      } as unknown as import('../src/db/client.js').Database;
      const listed = await listControlledMachines(listDb, 'test-user', Date.now());
      expect(listed.machines[0]?.workerRefresh).toEqual(expect.objectContaining({
        phase: CONTROLLED_NODE_WORKER_REFRESH_PHASE.SUCCEEDED,
        installedVersion: '2026.10.1',
      }));
    });

    const STAGGER_MS = CONTROLLED_NODE_UPGRADE_STAGGER_MAX_MS;
    const upgradeFrames = (ws: MockWs) => ws.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'));
    const authControlled = async (
      ws: MockWs,
      daemonVersion = '0.1.2',
      db = makeDb('valid-hash', 'controlled'),
    ) => {
      WsBridge.get(serverId).handleDaemonConnection(ws as never, db, {} as never);
      ws.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', daemonVersion,
        capabilities: [CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY],
      }));
      await flushAsync();
    };

    it('upgrades a controlled node at auth even though it never publishes a session snapshot', async () => {
      // Regression (tsk_043b784d11): imcodes-node has no sessions and never sends
      // `session_list`, but the idle gate demanded one, so every controlled node
      // stayed `deferred` with no reason, forever.
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const ws = new MockWs();
      await authControlled(ws);
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(1);
      expect(WsBridge.get(serverId).getControlledNodeUpgradeStatus()).toMatchObject({ status: 'upgrading' });
    });

    it('holds a controlled-node upgrade while the node reports a busy session, says why, and sends at idle', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled'), {} as never);
      ws.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', daemonVersion: '0.1.2',
        capabilities: [CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY],
      }));
      // Queued behind auth: it is applied before the post-auth upgrade check runs.
      ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [{ name: 'main', state: 'running' }] }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(0);
      expect(bridge.getControlledNodeUpgradeStatus()).toMatchObject({
        status: 'deferred',
        reason: DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY,
      });
      ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [{ name: 'main', state: 'idle' }] }));
      await flushAsync();
      await vi.runOnlyPendingTimersAsync();
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(1);
    });

    it('does not let a persisted failure for an older target block a newer target', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const ws = new MockWs();
      await authControlled(ws, '0.1.2', makeDb('valid-hash', 'controlled', undefined, undefined, {
        status: 'failed',
        target: '2026.7.1000-dev.1',
        reason: 'install_failed',
      }));
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(1);
    });

    it('retries a persisted failure for the same target once a fresh server process sees it', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const ws = new MockWs();
      await authControlled(ws, '0.1.2', makeDb('valid-hash', 'controlled', undefined, undefined, {
        status: 'failed',
        target: process.env.APP_VERSION,
        reason: 'download_failed',
      }));
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(1);
    });

    it('records any node-reported failure reason and retries the same target after a backoff', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      await authControlled(ws);
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      expect(upgradeFrames(ws)).toHaveLength(1);

      // An arbitrary node reason used to change nothing: the lifecycle stayed
      // `sent`, so every later request answered `already_in_progress`.
      ws.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED, reason: 'artifact_download_failed', targetVersion: process.env.APP_VERSION,
      }));
      await flushAsync();
      expect(bridge.getControlledNodeUpgradeStatus()).toMatchObject({ status: 'failed', reason: 'artifact_download_failed' });

      await vi.advanceTimersByTimeAsync(9 * 60_000);
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(2);
      expect(bridge.getControlledNodeUpgradeStatus()).toMatchObject({ status: 'upgrading' });
    });

    it.each([
      DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_INTERRUPTED,
      DAEMON_UPGRADE_BLOCK_REASON.ROLLBACK_FAILED,
    ])('treats a node-reported %s as a failure of that target with the normal backoff', async (reason) => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      await authControlled(ws);
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      expect(upgradeFrames(ws)).toHaveLength(1);
      ws.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason, targetVersion: process.env.APP_VERSION }));
      await flushAsync();
      expect(bridge.getControlledNodeUpgradeStatus()).toMatchObject({ status: 'failed', reason });
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await flushAsync();
      expect(upgradeFrames(ws)).toHaveLength(2);
    });

    it('offers the target again when a node that was sent an upgrade reconnects still on the old version', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const first = new MockWs();
      await authControlled(first);
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      expect(upgradeFrames(first)).toHaveLength(1);

      // Reconnect inside the backoff: the install may still be running.
      await vi.advanceTimersByTimeAsync(60_000);
      const second = new MockWs();
      await authControlled(second);
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      expect(upgradeFrames(second)).toHaveLength(0);

      // Reconnect after the backoff, still old: the install did not complete.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const third = new MockWs();
      await authControlled(third);
      await vi.advanceTimersByTimeAsync(STAGGER_MS);
      expect(upgradeFrames(third)).toHaveLength(1);
    });

    it('says why a controlled node is not upgraded on every early-return path', async () => {
      vi.useFakeTimers();
      const heldBack = () => infoSpy.mock.calls
        .filter(([, message]) => message === 'daemon auto-upgrade is being held back')
        .map(([fields]) => (fields as { reason?: string }).reason);
      const infoSpy = vi.spyOn(logger, 'info');
      try {
        // (1) explicit operator opt-out
        process.env.APP_VERSION = '2026.7.1234-dev.5';
        process.env.IMCODES_DISABLE_AUTO_UPGRADE = '1';
        const optedOut = new MockWs();
        await authControlled(optedOut);
        await vi.advanceTimersByTimeAsync(STAGGER_MS);
        expect(upgradeFrames(optedOut)).toHaveLength(0);
        expect(heldBack()).toContain('auto_upgrade_disabled_by_env');
        delete process.env.IMCODES_DISABLE_AUTO_UPGRADE;

        // (2) the server has no usable target version
        process.env.APP_VERSION = '0.0.0';
        const noTarget = new MockWs();
        await authControlled(noTarget);
        await vi.advanceTimersByTimeAsync(STAGGER_MS);
        expect(upgradeFrames(noTarget)).toHaveLength(0);
        expect(heldBack()).toContain('server_version_unknown');
      } finally {
        infoSpy.mockRestore();
      }
    });

    it('says why a failed target is not retried yet', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const infoSpy = vi.spyOn(logger, 'info');
      try {
        const ws = new MockWs();
        await authControlled(ws);
        await vi.advanceTimersByTimeAsync(STAGGER_MS);
        ws.emit('message', JSON.stringify({
          type: DAEMON_MSG.UPGRADE_BLOCKED, reason: 'artifact_download_failed', targetVersion: process.env.APP_VERSION,
        }));
        await flushAsync();
        // Reconnect inside the backoff, with the failure persisted as production would have it:
        // the node is not offered the target again yet, and the log says why.
        const again = new MockWs();
        await authControlled(again, '0.1.2', makeDb('valid-hash', 'controlled', undefined, undefined, {
          status: 'failed', target: process.env.APP_VERSION, reason: 'artifact_download_failed',
        }));
        await vi.advanceTimersByTimeAsync(STAGGER_MS);
        expect(upgradeFrames(again)).toHaveLength(0);
        expect(infoSpy.mock.calls.some(([fields, message]) => message === 'daemon auto-upgrade is being held back'
          && (fields as { reason?: string }).reason === 'retry_backoff')).toBe(true);
      } finally {
        infoSpy.mockRestore();
      }
    });

    it('does not auto-upgrade a controlled node when the explicit deployment opt-out is set', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      process.env.IMCODES_DISABLE_AUTO_UPGRADE = '1';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled'), {} as never);
      ws.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', daemonVersion: '0.1.2',
        capabilities: [CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY],
      }));
      await flushAsync();
      ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [{ name: 'main', state: 'idle' }] }));
      await flushAsync();
      await vi.runOnlyPendingTimersAsync();
      await flushAsync();
      expect(ws.sentStrings.some((message) => message.includes('\"type\":\"daemon.upgrade\"'))).toBe(false);
    });

    it('defers a controlled-node upgrade while a dispatch is active and flushes once at idle', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const bridge = WsBridge.get(serverId);
      const activeDispatchIds = (bridge as unknown as { activeDispatchIds: Map<string, string> }).activeDispatchIds;
      activeDispatchIds.set('main', 'turn-1');
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled'), {} as never);
      ws.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        daemonVersion: '0.1.2',
        capabilities: [CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY],
      }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();
      expect(ws.sentStrings.filter((msg) => msg.includes('\"type\":\"daemon.upgrade\"'))).toHaveLength(0);

      activeDispatchIds.delete('main');
      ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [{ name: 'main', state: 'idle' }] }));
      await flushAsync();
      await vi.runOnlyPendingTimersAsync();
      await flushAsync();
      expect(ws.sentStrings.filter((msg) => msg.includes('\"type\":\"daemon.upgrade\"'))).toHaveLength(1);
      activeDispatchIds.clear();
    });

    it('does not arm controlled-node rescue when the controlled node has safe self-upgrade', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN), {} as never);
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.7.1233-dev.4', capabilities: [CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY] }));
      await flushAsync();
      ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [] }));
      await flushAsync();
      await vi.runOnlyPendingTimersAsync();
      await flushAsync();
      expect(ws.sentStrings.some((message) => message.includes('\"type\":\"daemon.upgrade\"'))).toBe(true);
      expect(ws.sentStrings.some((message) => message.includes('\"type\":\"machine.exec\"'))).toBe(false);
    });

    it('keeps a controlled node online when it advertises a bounded future capability', async () => {
      const executed: Array<{ sql: string; params: unknown[] }> = [];
      const db = {
        queryOne: async () => ({
          token_hash: 'valid-hash',
          node_role: 'controlled',
          revoked_at: null,
          os: CONTROLLED_NODE_OS_WIN,
        }),
        query: async () => [],
        execute: async (sql: string, params: unknown[] = []) => {
          executed.push({ sql, params });
          return { changes: 1 };
        },
        exec: async () => {},
        transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) => fn(db as unknown as import('../src/db/client.js').Database),
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, db, {} as never);

      ws.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        daemonVersion: '0.1.2',
        capabilities: [CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY, 'remote.desktop.windows.h264.v3'],
      }));
      await flushAsync();

      expect(bridge.isAuthenticated).toBe(true);
      expect(ws.closed).toBe(false);
      expect(executed.some(({ sql, params }) => sql.includes('controlled_capabilities')
        && params.includes(JSON.stringify([CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY])))).toBe(true);
    });

    it('rejects malformed future capability advertisements', async () => {
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled'), {} as never);

      ws.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', daemonVersion: '0.1.2', capabilities: ['remote desktop v3'],
      }));
      await flushAsync();

      expect(bridge.isAuthenticated).toBe(false);
      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(4002);
      expect(ws.closeReason).toBe('invalid_capabilities');
    });

    it('prepares a legacy Windows rescue before automatic upgrade when no safe capability is advertised', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN), {} as never);
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '0.1.2', capabilities: [] }));
      await flushAsync();
      ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [] }));
      await flushAsync();
      await vi.runOnlyPendingTimersAsync();
      await flushAsync();
      expect(ws.sentStrings.some((message) => message.includes('\"type\":\"daemon.upgrade\"'))).toBe(false);
      expect(ws.sentStrings.some((message) => message.includes('\"type\":\"machine.exec\"'))).toBe(true);
    });

    it('keeps legacy Windows rescue bounded while the rescue result is pending', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.1234-dev.5';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN), {} as never);
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '0.1.2', capabilities: [] }));
      await flushAsync();
      ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [] }));
      await flushAsync();
      await vi.runOnlyPendingTimersAsync();
      await flushAsync();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsync();
      expect(ws.sentStrings.filter((message) => message.includes('\"type\":\"machine.exec\"'))).toHaveLength(1);
      expect(ws.sentStrings.filter((message) => message.includes('\"type\":\"daemon.upgrade\"'))).toHaveLength(0);
    });

    it('defers a legacy Windows node after an automatic blocker without rescue', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.8.3409-dev.3847';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN), {} as never);
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '0.1.3-rework.v94', capabilities: [] }));
      await flushAsync();
      ws.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS }));
      await flushAsync();
      expect(ws.sentStrings.some((message) => message.includes('\"type\":\"machine.exec\"'))).toBe(false);
    });

    it('drops controlled-node upgrade blocker frames with extra keys', async () => {
      process.env.APP_VERSION = '2026.8.3409-dev.3847';
      const before = WsBridge.controlledInboundDropped;
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(
        ws as never,
        makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN),
        {} as never,
      );
      ws.emit('message', JSON.stringify({
        type: 'auth', serverId, token: 'my-token', daemonVersion: '0.1.3-rework.v94', capabilities: [],
      }));
      await flushAsync();
      const machineExecCount = ws.sentStrings.filter((message) => message.includes('"type":"machine.exec"')).length;

      ws.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS,
        extra: true,
      }));
      await flushAsync();

      expect(WsBridge.controlledInboundDropped).toBe(before + 1);
      expect(ws.sentStrings.filter((message) => message.includes('"type":"machine.exec"'))).toHaveLength(machineExecCount);
    });

    it('surfaces daemon-newer mismatch without auto-upgrading', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.906-dev.1' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.some((msg) => msg.includes('"type":"daemon.upgrade"') && msg.includes('2026.4.905-dev.877'))).toBe(false);
    });

    it('surfaces dev/stable mismatch without auto-upgrading', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.905' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.some((msg) => msg.includes('"type":"daemon.upgrade"') && msg.includes('2026.4.905-dev.877'))).toBe(false);
    });

    it('surfaces stable/dev mismatch without auto-upgrading', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905';

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.905-dev.877' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(ws.sentStrings.some((msg) => msg.includes('"type":"daemon.upgrade"') && msg.includes('2026.4.905'))).toBe(false);
    });

    describe('full daemon automatic upgrade (the daemon decides when it is idle)', () => {
      const TARGET = '2026.4.905-dev.877';
      const OLD = '2026.4.904-dev.100';
      const frames = (ws: MockWs) => upgradeFrames(ws).map((raw) => JSON.parse(raw) as Record<string, unknown>);
      const authFull = async (ws: MockWs, daemonVersion = OLD, extra: Record<string, unknown> = {}) => {
        WsBridge.get(serverId).handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);
        ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion, ...extra }));
        await flushAsync();
      };
      const boot = () => {
        vi.useFakeTimers();
        process.env.APP_VERSION = TARGET;
        markDaemonUpgradeTargetVersionPublishedForTest(TARGET);
      };
      const blocked = async (ws: MockWs, reason: string, extra: Record<string, unknown> = {}) => {
        ws.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason, ...extra }));
        await flushAsync();
      };
      const advance = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await flushAsync();
      };
      const sessions = async (ws: MockWs, state: string) => {
        ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [{ name: 'deck_a_brain', state }] }));
        await flushAsync();
        await vi.advanceTimersByTimeAsync(0);
      };
      const autoView = () => WsBridge.get(serverId).daemonUpgradeStatus().autoUpgrade;
      const FIRST_SEND = STAGGER_MS;

      it('sends source:auto to a lagging full daemon and never gates it on the server\'s own view of busy', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        // The server sees a running session, yet still asks: the daemon's own
        // gates are the only definition of "busy".
        await sessions(ws, 'running');
        await advance(FIRST_SEND);
        expect(frames(ws)).toEqual([expect.objectContaining({ type: 'daemon.upgrade', source: 'auto', targetVersion: TARGET })]);
        expect(frames(ws)[0]).not.toHaveProperty('force');
        expect(autoView()).toMatchObject({ status: 'upgrading', targetVersion: TARGET });
      });

      it('does nothing for a current daemon', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws, TARGET);
        await advance(FIRST_SEND);
        expect(frames(ws)).toHaveLength(0);
        expect(autoView()).toBeNull();
      });

      it('honors the deployment opt-out and says why, while manual stays available', async () => {
        boot();
        process.env.IMCODES_DISABLE_AUTO_UPGRADE = '1';
        const infoSpy = vi.spyOn(logger, 'info');
        try {
          const ws = new MockWs();
          await authFull(ws);
          await advance(FIRST_SEND);
          expect(frames(ws)).toHaveLength(0);
          expect(infoSpy.mock.calls.some(([fields, message]) => message === 'daemon auto-upgrade is being held back'
            && (fields as { reason?: string }).reason === 'auto_upgrade_disabled_by_env')).toBe(true);
          expect(WsBridge.get(serverId).requestDaemonUpgrade({ targetVersion: TARGET, source: 'manual' }))
            .toMatchObject({ deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT });
        } finally {
          infoSpy.mockRestore();
          delete process.env.IMCODES_DISABLE_AUTO_UPGRADE;
        }
      });

      it.each([
        DAEMON_UPGRADE_BLOCK_REASON.P2P_ACTIVE,
        DAEMON_UPGRADE_BLOCK_REASON.AUTO_DELIVER_ACTIVE,
        DAEMON_UPGRADE_BLOCK_REASON.MASTER_COMPACTION_ACTIVE,
        DAEMON_UPGRADE_BLOCK_REASON.TRANSPORT_BUSY,
        DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY,
      ])('asks again after a bounded interval, not in a tight loop, when the daemon reports %s', async (reason) => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        expect(frames(ws)).toHaveLength(1);
        await blocked(ws, reason);
        expect(autoView()).toMatchObject({ status: 'deferred', reason });
        await advance(DAEMON_UPGRADE_BUSY_RETRY_INTERVAL_MS - 1_000);
        expect(frames(ws)).toHaveLength(1);
        await advance(2_000);
        expect(frames(ws)).toHaveLength(2);
        expect(frames(ws)[1]).toMatchObject({ source: 'auto', targetVersion: TARGET });
      });

      it('schedules the retry from the daemon\'s own cooldown remainder (bounded)', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.COOLDOWN_ACTIVE, { cooldownRemainingMs: 3 * 60_000 });
        await advance(3 * 60_000 - 2_000);
        expect(frames(ws)).toHaveLength(1);
        await advance(4_000);
        expect(frames(ws)).toHaveLength(2);
        // A tiny remainder is clamped up so it cannot become a tight loop.
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.COOLDOWN_ACTIVE, { cooldownRemainingMs: 5 });
        await advance(DAEMON_UPGRADE_COOLDOWN_RETRY_MIN_MS - 2_000);
        expect(frames(ws)).toHaveLength(2);
        await advance(4_000);
        expect(frames(ws)).toHaveLength(3);
      });

      // A daemon that has just (re)started holds an automatic upgrade for its own reasons (settle window, restore,
      // recovery after an unclean exit). On the wire it is a legacy busy reason plus the deferral fields.
      describe.each([DAEMON_UPGRADE_DEFERRAL.STARTING_UP, DAEMON_UPGRADE_DEFERRAL.UNCLEAN_SHUTDOWN_RECOVERY])('daemon deferral %s', (deferral) => {
        const receipt = (ws: MockWs, retryAfterMs: unknown) => blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY, {
          [DAEMON_UPGRADE_DEFERRAL_FIELD]: deferral,
          [DAEMON_UPGRADE_RETRY_AFTER_FIELD]: retryAfterMs,
        });

        it('shows the precise reason and asks again right after the daemon\'s own hold lapses', async () => {
          boot();
          const ws = new MockWs();
          await authFull(ws);
          await advance(FIRST_SEND);
          expect(frames(ws)).toHaveLength(1);
          await receipt(ws, 12 * 60_000);
          expect(autoView()).toMatchObject({ status: 'deferred', reason: deferral });
          await advance(12 * 60_000 + DAEMON_UPGRADE_DEFERRAL_RETRY_MARGIN_MS - 2_000);
          expect(frames(ws)).toHaveLength(1);
          await advance(4_000);
          expect(frames(ws)).toHaveLength(2);
          expect(frames(ws)[1]).toMatchObject({ source: 'auto', targetVersion: TARGET });
        });

        it('never retries faster than the shared floor (no storm from a tiny or bogus hint)', async () => {
          boot();
          const ws = new MockWs();
          await authFull(ws);
          await advance(FIRST_SEND);
          for (const [index, tiny] of [5, -1].entries()) {
            await receipt(ws, tiny);
            await advance(DAEMON_UPGRADE_COOLDOWN_RETRY_MIN_MS - 2_000);
            expect(frames(ws)).toHaveLength(1 + index);
            await advance(4_000);
            expect(frames(ws)).toHaveLength(2 + index);
          }
          // A hint that is not a number is no hint: the plain busy interval. (A negative number is a number: floored.)
          for (const bogus of ['soon', null, Number.NaN]) {
            await receipt(ws, bogus);
            await advance(DAEMON_UPGRADE_BUSY_RETRY_INTERVAL_MS - 2_000);
            const before = frames(ws).length;
            await advance(4_000);
            expect(frames(ws)).toHaveLength(before + 1);
          }
        });

        it('is not asked again at an idle edge meanwhile: the hold ends by the daemon\'s clock, not a session edge', async () => {
          boot();
          const ws = new MockWs();
          await authFull(ws);
          await sessions(ws, 'running');
          await advance(FIRST_SEND);
          await receipt(ws, 10 * 60_000);
          for (let i = 0; i < 4; i += 1) {
            await advance(2 * DAEMON_UPGRADE_IDLE_EDGE_MIN_INTERVAL_MS);
            await sessions(ws, 'idle');
            await sessions(ws, 'running');
          }
          expect(frames(ws)).toHaveLength(1);
        });

        it('does not consume the failure backoff, and an older server\'s view of the same receipt (no deferral fields) is the plain busy retry', async () => {
          boot();
          const ws = new MockWs();
          await authFull(ws);
          await advance(FIRST_SEND);
          await receipt(ws, 60_000);
          await advance(60_000 + DAEMON_UPGRADE_DEFERRAL_RETRY_MARGIN_MS + 1_000);
          expect(frames(ws)).toHaveLength(2);
          // What a server without the deferral fields reads: a legacy busy reason, retried on the busy interval.
          await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
          expect(autoView()).toMatchObject({ status: 'deferred', reason: DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY });
          await advance(DAEMON_UPGRADE_BUSY_RETRY_INTERVAL_MS + 1_000);
          expect(frames(ws)).toHaveLength(3);
          await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED, { targetVersion: TARGET });
          await advance(9 * 60_000);
          expect(frames(ws)).toHaveLength(3);
          await advance(2 * 60_000);
          expect(frames(ws)).toHaveLength(4);
        });
      });

      it('ignores an unknown deferral value: the plain busy reason and interval stand', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY, { [DAEMON_UPGRADE_DEFERRAL_FIELD]: 'from_the_future', [DAEMON_UPGRADE_RETRY_AFTER_FIELD]: 30_000 });
        expect(autoView()).toMatchObject({ status: 'deferred', reason: DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY });
        await advance(DAEMON_UPGRADE_BUSY_RETRY_INTERVAL_MS - 2_000);
        expect(frames(ws)).toHaveLength(1);
        await advance(4_000);
        expect(frames(ws)).toHaveLength(2);
      });

      it('retries at the next idle edge, spaced by the minimum interval, and only after a daemon receipt', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await sessions(ws, 'running');
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        // Edge inside the minimum interval: nothing (the timer still covers it).
        await advance(10_000);
        await sessions(ws, 'idle');
        expect(frames(ws)).toHaveLength(1);
        // A later edge, server view quiet: the daemon is asked again, long before the 5 minute timer.
        await sessions(ws, 'running');
        await advance(DAEMON_UPGRADE_IDLE_EDGE_MIN_INTERVAL_MS);
        await sessions(ws, 'running');
        expect(frames(ws)).toHaveLength(1);
        await sessions(ws, 'idle');
        expect(frames(ws)).toHaveLength(2);
        expect(frames(ws)[1]).toMatchObject({ source: 'auto' });
      });

      it('an idle edge is a trigger, not a gate: with no daemon receipt it never sends', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await sessions(ws, 'running');
        await advance(FIRST_SEND);
        expect(frames(ws)).toHaveLength(1);
        // The daemon accepted (no receipt) — sessions flapping idle/busy must not resend.
        for (let i = 0; i < 3; i += 1) {
          await advance(2 * DAEMON_UPGRADE_IDLE_EDGE_MIN_INTERVAL_MS);
          await sessions(ws, 'idle');
          await sessions(ws, 'running');
        }
        expect(frames(ws)).toHaveLength(1);
      });

      it('a gate receipt that answers nothing we delivered schedules nothing', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        // Before the stagger elapsed no command was delivered.
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        expect(autoView()?.reason ?? null).not.toBe(DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        await advance(FIRST_SEND);
        expect(frames(ws)).toHaveLength(1);
        // Repeated receipts for the one delivered command arm one retry, not several.
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        await advance(DAEMON_UPGRADE_BUSY_RETRY_INTERVAL_MS + 1_000);
        expect(frames(ws)).toHaveLength(2);
      });

      it('busy waits do not consume the failure backoff: the first failure still waits only 10 minutes', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        await advance(DAEMON_UPGRADE_BUSY_RETRY_INTERVAL_MS + 1_000);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        await advance(DAEMON_UPGRADE_BUSY_RETRY_INTERVAL_MS + 1_000);
        expect(frames(ws)).toHaveLength(3);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED, { targetVersion: TARGET });
        expect(autoView()).toMatchObject({ status: 'failed', reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED });
        await advance(9 * 60_000);
        expect(frames(ws)).toHaveLength(3);
        await advance(2 * 60_000);
        expect(frames(ws)).toHaveLength(4);
      });

      it('a failed target backs off 10m, then 30m, and only blocks that target', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED, { targetVersion: TARGET });
        await advance(9 * 60_000);
        expect(frames(ws)).toHaveLength(1);
        await advance(2 * 60_000);
        expect(frames(ws)).toHaveLength(2);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED, { targetVersion: TARGET });
        await advance(29 * 60_000);
        expect(frames(ws)).toHaveLength(2);
        await advance(2 * 60_000);
        expect(frames(ws)).toHaveLength(3);
        // A different (newer) server target is a fresh lifecycle, never blocked by the old failure.
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.TOOLCHAIN_UNAVAILABLE);
        process.env.APP_VERSION = '2026.4.906-dev.1';
        markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);
        const next = new MockWs();
        await authFull(next);
        await advance(FIRST_SEND);
        expect(frames(next)).toEqual([expect.objectContaining({ targetVersion: '2026.4.906-dev.1' })]);
      });

      it('an old daemon that never answers is not asked on every reconnect (version unchanged after delivery)', async () => {
        boot();
        const first = new MockWs();
        await authFull(first);
        await advance(FIRST_SEND);
        expect(frames(first)).toHaveLength(1);

        await advance(60_000);
        const second = new MockWs();
        await authFull(second);
        await advance(FIRST_SEND);
        expect(frames(second)).toHaveLength(0);
        expect(autoView()).toMatchObject({ status: 'failed', reason: 'version_unchanged_after_upgrade' });
        expect(autoView()?.nextRetryAt).toEqual(expect.any(Number));

        // Still connected when the backoff ends: it is asked once more, by the server's own timer.
        await advance(10 * 60_000);
        expect(frames(second)).toHaveLength(1);
      });

      it('the daemon\'s own opt-out receipt stops the automatic trigger without a failure backoff, manual still forced', async () => {
        boot();
        const browser = new MockWs();
        WsBridge.get(serverId).handleBrowserConnection(browser as never, 'test-user', makeDb('valid-hash'));
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.AUTO_UPGRADE_DISABLED, { disabledBy: 'config' });
        expect(autoView()).toMatchObject({ status: 'deferred', reason: DAEMON_UPGRADE_BLOCK_REASON.AUTO_UPGRADE_DISABLED });
        // Not an operator-facing failure.
        expect(browser.sentStrings.some((raw) => raw.includes(DAEMON_MSG.UPGRADE_BLOCKED))).toBe(false);
        // No further asks for as long as the connection lives, however long that is.
        await advance(7 * 60 * 60_000);
        expect(frames(ws)).toHaveLength(1);
        // A manual forced upgrade is unaffected.
        expect(WsBridge.get(serverId).requestDaemonUpgrade({ targetVersion: TARGET, source: 'manual', force: true }))
          .toMatchObject({ deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT });
        expect(frames(ws)[1]).toMatchObject({ source: 'manual', force: true, targetVersion: TARGET });
        // The daemon re-reads its config on reconnect, so the next connection is asked again.
        const reconnected = new MockWs();
        await authFull(reconnected);
        await advance(FIRST_SEND);
        expect(frames(reconnected).filter((frame) => frame.source === 'auto')).toHaveLength(1);
      });

      it('an automatic gate receipt is shown on the card, not toasted; a manual one is relayed', async () => {
        boot();
        const browser = new MockWs();
        WsBridge.get(serverId).handleBrowserConnection(browser as never, 'test-user', makeDb('valid-hash'));
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.TRANSPORT_BUSY);
        const relayed = () => browser.sentStrings.filter((raw) => raw.includes(DAEMON_MSG.UPGRADE_BLOCKED));
        expect(relayed()).toHaveLength(0);

        // The browser learns the wait from the daemon.stats frame.
        ws.emit('message', JSON.stringify({
          type: DAEMON_STATS_MSG, cpu: 1, memUsed: 1, memTotal: 2, load1: 0, load5: 0, load15: 0, uptime: 1,
        }));
        await flushAsync();
        const stats = browser.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>)
          .filter((frame) => frame.type === DAEMON_STATS_MSG);
        expect(stats[stats.length - 1]).toMatchObject({
          autoUpgrade: { status: 'deferred', reason: DAEMON_UPGRADE_BLOCK_REASON.TRANSPORT_BUSY, targetVersion: TARGET },
        });

        // A manual request (an old daemon that predates `force`) answers with a visible block.
        expect(WsBridge.get(serverId).requestDaemonUpgrade({ targetVersion: TARGET, source: 'manual' }))
          .toMatchObject({ deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT });
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.TRANSPORT_BUSY);
        expect(relayed()).toHaveLength(1);
      });

      it('a blocked manual request can be confirmed again at once, and never moves the automatic failure counter', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        const bridge = WsBridge.get(serverId);
        expect(bridge.requestDaemonUpgrade({ targetVersion: TARGET, source: 'manual' }).deliveryStatus)
          .toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.SESSION_BUSY);
        // Not "already in progress": the daemon refused the first manual command.
        expect(bridge.requestDaemonUpgrade({ targetVersion: TARGET, source: 'manual', force: true }).deliveryStatus)
          .toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);
        const sent = frames(ws);
        expect(sent[sent.length - 1]).toMatchObject({ source: 'manual', force: true });
        expect(sent.filter((frame) => frame.source === 'manual' && !('force' in frame))).toHaveLength(1);
      });

      it('a forced manual request outranks an automatic command that is already out', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        expect(frames(ws)).toHaveLength(1);
        const forced = WsBridge.get(serverId).requestDaemonUpgrade({ targetVersion: TARGET, source: 'manual', force: true });
        expect(forced.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.SENT);
        expect(frames(ws)[1]).toMatchObject({ source: 'manual', force: true });
      });

      it('a server restart forgets the counters: one fresh attempt, not a permanent block', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        await advance(FIRST_SEND);
        await blocked(ws, DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED, { targetVersion: TARGET });
        WsBridge.getAll().clear();
        const restarted = new MockWs();
        await authFull(restarted);
        await advance(FIRST_SEND);
        expect(frames(restarted)).toHaveLength(1);
      });

      it('spreads the post-auth trigger: nothing is sent before the stagger window starts to elapse', async () => {
        boot();
        const ws = new MockWs();
        await authFull(ws);
        expect(frames(ws)).toHaveLength(0);
        const stagger = controlledNodeUpgradeStaggerMs(serverId);
        if (stagger > 1) {
          await advance(stagger - 1);
          expect(frames(ws)).toHaveLength(0);
        }
        await advance(STAGGER_MS);
        expect(frames(ws)).toHaveLength(1);
      });

      it('a controlled node never receives force, and a manual upgrade without force stays an ordinary manual one', async () => {
        boot();
        const ws = new MockWs();
        await authControlled(ws);
        await advance(FIRST_SEND);
        WsBridge.get(serverId).requestDaemonUpgrade({ targetVersion: TARGET, source: 'manual' });
        expect(frames(ws).length).toBeGreaterThan(0);
        for (const frame of frames(ws)) expect(frame).not.toHaveProperty('force');
      });
    });

    describe('controlled-node authentication latency (the fixed ~30 s before the first heartbeat_ack)', () => {
      // 34f0bb11 (win-201): five restarts, process_start -> first heartbeat_ack 30.25-30.29 s every time. The node's
      // silence watchdog gives a socket up after 30 s without ANY server frame; the server held its first heartbeat_ack
      // behind the whole post-auth chain, whose remote-desktop route-replacement wait is up to 35 s (a restarted node
      // with a live route has to cold-start its worker first).
      const NODE_VERSION = '2026.10.5479-dev.5940';
      const SLOW_RECONCILE_MS = 35_000;
      const heartbeatAcks = (ws: MockWs) => ws.sentStrings
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .filter((frame) => frame.type === 'heartbeat_ack');
      const authFrame = { type: 'auth', serverId: '', token: 'my-token', daemonVersion: NODE_VERSION, capabilities: [CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY] };
      const heartbeatFrame = { type: 'heartbeat', daemonVersion: NODE_VERSION, [CLOCK_SYNC_FIELD.SENT_AT]: 1234 };
      /** A node that connects the way the real one does: auth, then a heartbeat in the same breath. */
      const connectNode = async (bridge: WsBridge, options: { db?: ReturnType<typeof makeDb>; nodeId?: string } = {}) => {
        const ws = new MockWs();
        bridge.handleDaemonConnection(ws as never, options.db ?? makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN, undefined, undefined, options.nodeId), {} as never);
        ws.emit('message', JSON.stringify({ ...authFrame, serverId }));
        ws.emit('message', JSON.stringify(heartbeatFrame));
        return ws;
      };
      const blockRevalidatorFor = (ms: number) => {
        const calls: number[] = [];
        WsBridge.setRemoteDesktopReconnectRevalidator(async () => {
          calls.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, ms));
        });
        return calls;
      };

      beforeEach(() => { vi.useFakeTimers(); });

      it('acknowledges the first heartbeat within a second even when the remote-desktop reconcile takes 35 s', async () => {
        const bridge = WsBridge.get(serverId);
        const revalidations = blockRevalidatorFor(SLOW_RECONCILE_MS);
        const ws = await connectNode(bridge);
        await vi.advanceTimersByTimeAsync(1_000);
        await flushAsync();
        expect(revalidations).toHaveLength(1);
        expect(heartbeatAcks(ws), 'the ack must not wait for the reconcile tail (the node gives up after 30 s of silence)').toHaveLength(1);
      });

      it('keeps what the ack carries: the node id, the server id and the clock echo', async () => {
        const bridge = WsBridge.get(serverId);
        blockRevalidatorFor(SLOW_RECONCILE_MS);
        const nodeId = '9909368908';
        const ws = await connectNode(bridge, { nodeId });
        await vi.advanceTimersByTimeAsync(1_000);
        await flushAsync();
        const [ack] = heartbeatAcks(ws);
        expect(ack).toMatchObject({ [CLOCK_SYNC_FIELD.SENT_AT]: 1234 });
        expect(typeof ack![CLOCK_SYNC_FIELD.SERVER_TIME]).toBe('number');
        expect(JSON.stringify(ack)).toContain(serverId);
        expect(JSON.stringify(ack)).toContain(nodeId);
      });

      it('a connection replaced while its credentials are still being checked never acknowledges or authenticates', async () => {
        const bridge = WsBridge.get(serverId);
        // Only the credential lookup (the FIRST query of the connection) is held back; the connection's own close
        // handler queries the same database later and must not be mistaken for it.
        const heldLookups: Array<() => void> = [];
        const slowDb = makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN) as unknown as {
          queryOne: (...args: unknown[]) => Promise<unknown>;
        };
        const realQueryOne = slowDb.queryOne.bind(slowDb);
        slowDb.queryOne = (...args: unknown[]) => (heldLookups.length === 0
          ? new Promise((resolve) => { heldLookups.push(() => resolve(realQueryOne(...args))); })
          : realQueryOne(...args));
        const releaseLookup = () => heldLookups[0]!();
        const first = await connectNode(bridge, { db: slowDb as never });
        const firstSends = vi.spyOn(first, 'send');
        const second = await connectNode(bridge);
        await flushAsync();
        releaseLookup();
        await vi.advanceTimersByTimeAsync(1_000);
        await flushAsync();
        expect(heartbeatAcks(first), 'the replaced connection must not be acknowledged').toHaveLength(0);
        // not even an attempt: a closed socket swallows the send, so look at the attempts themselves
        expect(firstSends.mock.calls.some(([data]) => String(data).includes('heartbeat_ack'))).toBe(false);
        expect(heartbeatAcks(second)).toHaveLength(1);
        expect(first.closed).toBe(true);
        expect(bridge.isAuthenticated).toBe(true);
      });

      it('does not acknowledge a heartbeat whose credentials are wrong', async () => {
        const bridge = WsBridge.get(serverId);
        const ws = new MockWs();
        bridge.handleDaemonConnection(ws as never, makeDb('another-hash', 'controlled', CONTROLLED_NODE_OS_WIN), {} as never);
        ws.emit('message', JSON.stringify({ ...authFrame, serverId }));
        ws.emit('message', JSON.stringify(heartbeatFrame));
        await vi.advanceTimersByTimeAsync(1_000);
        await flushAsync();
        expect(heartbeatAcks(ws)).toHaveLength(0);
        expect(ws.closed).toBe(true);
        expect(ws.closeCode).toBe(4001);
      });

      it('every other frame type still waits for the complete authentication chain', async () => {
        const bridge = WsBridge.get(serverId);
        blockRevalidatorFor(SLOW_RECONCILE_MS);
        const ws = await connectNode(bridge);
        const generation = bridge.daemonConnectionGeneration();
        const pending = registerPendingExec(serverId, 'exec-after-auth', generation, 120_000);
        let resolved = false;
        void pending.then(() => { resolved = true; });
        ws.emit('message', JSON.stringify({
          type: DAEMON_MSG.MACHINE_EXEC_RESULT, correlationId: 'exec-after-auth', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1,
        }));
        await vi.advanceTimersByTimeAsync(1_000);
        await flushAsync();
        expect(heartbeatAcks(ws)).toHaveLength(1);
        expect(resolved, 'an exec result is only accepted once authentication has completed').toBe(false);
        // the chain is bounded: it completes at the reconcile budget, not at 35 s
        await vi.advanceTimersByTimeAsync(DAEMON_AUTH_RECONCILE_BUDGET_MS);
        await flushAsync();
        expect(resolved).toBe(true);
        expect(Date.now()).toBeLessThan(Date.now() + 1); // (clock sanity; budget asserted by the line above)
      });

      it('the bounded wait does not turn into a pass: remote desktop stays unavailable until the reconcile really finishes', async () => {
        const bridge = WsBridge.get(serverId);
        blockRevalidatorFor(SLOW_RECONCILE_MS);
        const warn = vi.spyOn(logger, 'warn');
        await connectNode(bridge);
        const generation = bridge.daemonConnectionGeneration();
        const readyGeneration = () => (bridge as unknown as { remoteDesktopAuthorityReadyGeneration: number | null }).remoteDesktopAuthorityReadyGeneration;
        await vi.advanceTimersByTimeAsync(DAEMON_AUTH_RECONCILE_BUDGET_MS + 1_000);
        await flushAsync();
        expect(bridge.isAuthenticated).toBe(true);
        expect(readyGeneration(), 'still reconciling: fail closed').not.toBe(generation);
        expect(JSON.stringify(warn.mock.calls)).toContain('remote desktop reconcile is still running');
        await vi.advanceTimersByTimeAsync(SLOW_RECONCILE_MS);
        await flushAsync();
        expect(readyGeneration()).toBe(generation);
        warn.mockRestore();
      });

      it('a failing reconcile is retried in the background and then reported, never silently left half-done', async () => {
        const bridge = WsBridge.get(serverId);
        let attempts = 0;
        WsBridge.setRemoteDesktopReconnectRevalidator(async () => {
          attempts += 1;
          if (attempts <= 2) throw new Error('database unavailable');
        });
        const warn = vi.spyOn(logger, 'warn');
        await connectNode(bridge);
        const generation = bridge.daemonConnectionGeneration();
        const readyGeneration = () => (bridge as unknown as { remoteDesktopAuthorityReadyGeneration: number | null }).remoteDesktopAuthorityReadyGeneration;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(readyGeneration()).not.toBe(generation);
        for (const delay of DAEMON_AUTH_RECONCILE_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay + 100);
        await flushAsync();
        expect(attempts).toBe(3);
        expect(readyGeneration(), 'the third attempt succeeded: authority is aligned').toBe(generation);
        expect(JSON.stringify(warn.mock.calls)).toContain('will be retried');
        warn.mockRestore();
      });

      it('gives up visibly after the bounded retries (error log + counter) and stays fail-closed', async () => {
        const bridge = WsBridge.get(serverId);
        WsBridge.setRemoteDesktopReconnectRevalidator(async () => { throw new Error('database unavailable'); });
        const error = vi.spyOn(logger, 'error');
        await connectNode(bridge);
        const generation = bridge.daemonConnectionGeneration();
        for (const delay of DAEMON_AUTH_RECONCILE_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay + 100);
        await vi.advanceTimersByTimeAsync(1_000);
        await flushAsync();
        expect((bridge as unknown as { remoteDesktopAuthorityReadyGeneration: number | null }).remoteDesktopAuthorityReadyGeneration).not.toBe(generation);
        expect(JSON.stringify(error.mock.calls)).toContain('remote desktop reconcile gave up');
        expect(getCounter('remote_desktop.reconcile_gave_up')).toBe(1);
        error.mockRestore();
      });

      it('logs the per-phase timing of every authentication (and warns on a slow one) without ever logging the token', async () => {
        const bridge = WsBridge.get(serverId);
        blockRevalidatorFor(3_000);
        const info = vi.spyOn(logger, 'info');
        const warn = vi.spyOn(logger, 'warn');
        await connectNode(bridge);
        await vi.advanceTimersByTimeAsync(5_000);
        await flushAsync();
        const authenticated = info.mock.calls.find((call) => call[1] === 'Daemon authenticated');
        expect(authenticated).toBeTruthy();
        expect(authenticated![0]).toEqual(expect.objectContaining({
          lookupMs: expect.any(Number), credentialMs: expect.any(Number), reconcileMs: expect.any(Number),
          revalidateMs: expect.any(Number), contextMs: expect.any(Number), totalMs: expect.any(Number),
        }));
        expect((authenticated![0] as { revalidateMs: number }).revalidateMs).toBeGreaterThanOrEqual(3_000);
        const slow = warn.mock.calls.find((call) => call[1] === 'slow daemon auth');
        expect(slow, 'a phase above 2 s is a warning').toBeTruthy();
        expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain('my-token');
        info.mockRestore();
        warn.mockRestore();
      });

      it('a normal fast authentication does not warn', async () => {
        const bridge = WsBridge.get(serverId);
        WsBridge.setRemoteDesktopReconnectRevalidator(async () => {});
        const warn = vi.spyOn(logger, 'warn');
        await connectNode(bridge);
        await vi.advanceTimersByTimeAsync(1_000);
        await flushAsync();
        expect(warn.mock.calls.find((call) => call[1] === 'slow daemon auth')).toBeUndefined();
        warn.mockRestore();
      });

      it('a reconnect storm (60 nodes at once, 200 ms revalidation each) is acknowledged in under a second each', async () => {
        WsBridge.setRemoteDesktopReconnectRevalidator(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        const sockets: MockWs[] = [];
        for (let i = 0; i < 60; i += 1) {
          const id = `${serverId}-storm-${i}`;
          const bridge = WsBridge.get(id);
          const ws = new MockWs();
          bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN), {} as never);
          ws.emit('message', JSON.stringify({ ...authFrame, serverId: id }));
          ws.emit('message', JSON.stringify(heartbeatFrame));
          sockets.push(ws);
        }
        await vi.advanceTimersByTimeAsync(900);
        await flushAsync();
        expect(sockets.filter((ws) => heartbeatAcks(ws).length === 1)).toHaveLength(60);
      });

      it('two processes using one credential are detected, not kicked silently in a loop', async () => {
        const bridge = WsBridge.get(serverId);
        WsBridge.setRemoteDesktopReconnectRevalidator(async () => {});
        const warn = vi.spyOn(logger, 'warn');
        for (let i = 0; i < 4; i += 1) {
          await connectNode(bridge);
          await vi.advanceTimersByTimeAsync(600);
          await flushAsync();
        }
        const duel = warn.mock.calls.find((call) => call[1] === 'daemon connection replaced repeatedly');
        expect(duel, 'three authenticated connections replaced within a minute is a duel').toBeTruthy();
        expect(duel![0]).toEqual(expect.objectContaining({ serverId, replacements: expect.any(Number) }));
        warn.mockRestore();
      });

      it('an ordinary single reconnect does not look like a duel', async () => {
        const bridge = WsBridge.get(serverId);
        WsBridge.setRemoteDesktopReconnectRevalidator(async () => {});
        const warn = vi.spyOn(logger, 'warn');
        await connectNode(bridge);
        await vi.advanceTimersByTimeAsync(600);
        await connectNode(bridge);
        await vi.advanceTimersByTimeAsync(600);
        await flushAsync();
        expect(warn.mock.calls.find((call) => call[1] === 'daemon connection replaced repeatedly')).toBeUndefined();
        warn.mockRestore();
      });
    });

    describe('legacy Windows node whose old process still holds the upgrade-in-progress latch', () => {
      // The 7064301582 incident: a node on 2026.9.4537 kept answering `already_in_progress` to every daemon.upgrade
      // (a 9/22 attempt was killed after it set the process-local latch). The rescue restart must clear it.
      const NODE_VERSION = '2026.9.4537-dev.5183';
      const TARGET_VERSION = '2026.9.4544-dev.5197';
      const MINUTE = 60_000;

      const execFrames = (ws: MockWs, prefix: 'upgrade-rescue-' | 'upgrade-restart-') => ws.sentStrings
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .filter((frame) => frame.type === 'machine.exec' && String(frame.correlationId).startsWith(prefix));
      const upgradeFrames = (ws: MockWs) => ws.sentStrings.filter((message) => message.includes('"type":"daemon.upgrade"'));
      const answerExec = async (ws: MockWs, frame: Record<string, unknown>, readyPrefix: string) => {
        const id = String(frame.correlationId).replace(/^upgrade-(rescue|restart)-/, '');
        ws.emit('message', JSON.stringify({
          type: DAEMON_MSG.MACHINE_EXEC_RESULT,
          correlationId: frame.correlationId,
          ok: true,
          exitCode: 0,
          stdout: `${readyPrefix}:${id}`,
          stderr: '',
          durationMs: 1,
        }));
        await flushAsync();
      };
      /** Controlled-upgrade state rows the bridge persisted (status, target, reason), in order. */
      const persisted: Array<{ status: unknown; reason: unknown }> = [];
      const recordingDb = () => {
        const db = makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN) as unknown as {
          execute: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
        };
        const execute = db.execute.bind(db);
        db.execute = async (sql, params = []) => {
          if (sql.includes('controlled_upgrade_status')) persisted.push({ status: params[0], reason: params[2] });
          return execute(sql, params);
        };
        return db as unknown as import('../src/db/client.js').Database;
      };
      const connectLegacyNode = async (bridge: WsBridge, capabilities: string[] = []) => {
        const ws = new MockWs();
        bridge.handleDaemonConnection(ws as never, recordingDb(), {} as never);
        ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: NODE_VERSION, capabilities }));
        await flushAsync();
        ws.emit('message', JSON.stringify({ type: 'session_list', sessions: [] }));
        await flushAsync();
        // past the post-auth stagger, but NOT `runOnlyPendingTimers`: that would also fire the exec deadline
        await vi.advanceTimersByTimeAsync(CONTROLLED_NODE_UPGRADE_STAGGER_MAX_MS + 1_000);
        await flushAsync();
        return ws;
      };
      /** Connect, prepare the rescue, and let the server deliver the upgrade the latched node will refuse. */
      const reachLatchedBlock = async (bridge: WsBridge) => {
        const ws = await connectLegacyNode(bridge);
        const [rescue] = execFrames(ws, 'upgrade-rescue-');
        expect(rescue, 'the rescue is prepared before any upgrade is sent').toBeTruthy();
        expect(upgradeFrames(ws)).toHaveLength(0);
        await answerExec(ws, rescue!, LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX);
        expect(upgradeFrames(ws)).toHaveLength(1);
        ws.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS }));
        await flushAsync();
        return ws;
      };
      const reconnectLatchedNode = async (bridge: WsBridge, previous: MockWs) => {
        previous.close();
        await flushAsync();
        return reachLatchedBlock(bridge);
      };

      beforeEach(() => {
        vi.useFakeTimers();
        process.env.APP_VERSION = TARGET_VERSION;
        persisted.length = 0;
      });

      it('restarts the latched node process (once) instead of failing with legacy_upgrade_restart_lifecycle_not_sent', async () => {
        const bridge = WsBridge.get(serverId);
        const warn = vi.spyOn(logger, 'warn');
        const ws = await reachLatchedBlock(bridge);
        await vi.advanceTimersByTimeAsync(10_000);
        await flushAsync();
        const restarts = execFrames(ws, 'upgrade-restart-');
        expect(restarts, 'the rescue restart runs right after the latch is reported').toHaveLength(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('legacy_upgrade_restart_lifecycle_not_sent');
        // the restart verifies, and the node process is gone (the SYSTEM task replaced it): the server asks again
        await answerExec(ws, restarts[0]!, LEGACY_WINDOWS_UPGRADE_RESTART_READY_PREFIX);
        ws.close();
        await flushAsync();
        const replacement = await connectLegacyNode(bridge);
        const [secondRescue] = execFrames(replacement, 'upgrade-rescue-');
        await answerExec(replacement, secondRescue!, LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX);
        expect(upgradeFrames(replacement), 'the replacement generation is offered the upgrade at once').toHaveLength(1);
        warn.mockRestore();
      });

      it('never restarts the same node more than the shared 10m/30m/2h/6h schedule allows, and says why it is waiting', async () => {
        const bridge = WsBridge.get(serverId);
        let ws = await reachLatchedBlock(bridge);
        await vi.advanceTimersByTimeAsync(10_000);
        await flushAsync();
        expect(execFrames(ws, 'upgrade-restart-')).toHaveLength(1);
        await answerExec(ws, execFrames(ws, 'upgrade-restart-')[0]!, LEGACY_WINDOWS_UPGRADE_RESTART_READY_PREFIX);

        // The restart did not clear the latch: the node comes back and refuses again, every time.
        const startedAt = Date.now();
        const restartTimes: number[] = [startedAt];
        for (const waitMinutes of [10, 30, 120, 360, 360]) {
          ws = await reconnectLatchedNode(bridge, ws);
          // not before the scheduled delay ...
          await vi.advanceTimersByTimeAsync(waitMinutes * MINUTE - 20_000);
          await flushAsync();
          expect(execFrames(ws, 'upgrade-restart-'), `no restart before ${waitMinutes} minutes`).toHaveLength(0);
          // ... and then exactly one
          await vi.advanceTimersByTimeAsync(40_000);
          await flushAsync();
          const restarts = execFrames(ws, 'upgrade-restart-');
          expect(restarts, `one restart at ${waitMinutes} minutes`).toHaveLength(1);
          restartTimes.push(Date.now());
          await answerExec(ws, restarts[0]!, LEGACY_WINDOWS_UPGRADE_RESTART_READY_PREFIX);
        }
        // while the schedule holds the next restart back, the node's persisted state says so (not a silent no-op)
        expect(persisted.some((row) => row.reason === CONTROLLED_NODE_UPGRADE_WAIT_REASON.LEGACY_RESTART_BACKOFF
          && row.status === CONTROLLED_NODE_UPGRADE_STATUS.DEFERRED)).toBe(true);
        expect(restartTimes).toHaveLength(6);
      });

      it('a restart that cannot be verified is reported as legacy_restart_failed and retried on the same schedule, not every minute', async () => {
        const bridge = WsBridge.get(serverId);
        const ws = await reachLatchedBlock(bridge);
        await vi.advanceTimersByTimeAsync(10_000);
        await flushAsync();
        const [first] = execFrames(ws, 'upgrade-restart-');
        expect(first).toBeTruthy();
        // the SYSTEM task ran but its verification output is wrong
        ws.emit('message', JSON.stringify({
          type: DAEMON_MSG.MACHINE_EXEC_RESULT, correlationId: first!.correlationId, ok: true, exitCode: 1,
          stdout: '', stderr: 'access denied', durationMs: 1,
        }));
        await flushAsync();
        expect(persisted.some((row) => row.reason === CONTROLLED_NODE_UPGRADE_WAIT_REASON.LEGACY_RESTART_FAILED)).toBe(true);
        await vi.advanceTimersByTimeAsync(10 * MINUTE - 30_000);
        await flushAsync();
        expect(execFrames(ws, 'upgrade-restart-'), 'the old 1/2/4/5-minute cadence is gone').toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60_000);
        await flushAsync();
        expect(execFrames(ws, 'upgrade-restart-'), 'the second attempt follows the shared schedule').toHaveLength(2);
      });

      it('also reaches the restart for a latched node that advertises safe self-upgrade (rescue prepared after the receipt)', async () => {
        const bridge = WsBridge.get(serverId);
        const ws = await connectLegacyNode(bridge, [CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY]);
        expect(execFrames(ws, 'upgrade-rescue-'), 'no rescue before the first upgrade: the node says it is safe').toHaveLength(0);
        expect(upgradeFrames(ws)).toHaveLength(1);
        ws.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS }));
        await flushAsync();
        const [rescue] = execFrames(ws, 'upgrade-rescue-');
        expect(rescue, 'the latch arms the rescue').toBeTruthy();
        await answerExec(ws, rescue!, LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX);
        await vi.advanceTimersByTimeAsync(10_000);
        await flushAsync();
        expect(execFrames(ws, 'upgrade-restart-'), 'and the restart follows the prepared rescue').toHaveLength(1);
      });

      it('keeps offering nothing to a node that is not latched: a healthy legacy upgrade never triggers a restart', async () => {
        const bridge = WsBridge.get(serverId);
        const ws = await connectLegacyNode(bridge);
        const [rescue] = execFrames(ws, 'upgrade-rescue-');
        await answerExec(ws, rescue!, LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX);
        expect(upgradeFrames(ws)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(30 * MINUTE);
        await flushAsync();
        expect(execFrames(ws, 'upgrade-restart-')).toHaveLength(0);
      });
    });

    it('fences an exact rolled-back controlled-node target instead of retrying the destructive upgrade loop', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.9.4544-dev.5197';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash', 'controlled', CONTROLLED_NODE_OS_WIN), {} as never);
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.9.4537-dev.5183', capabilities: [] }));
      await flushAsync();
      ws.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
        targetVersion: process.env.APP_VERSION,
      }));
      await flushAsync();
      expect(bridge.requestDaemonUpgrade({ targetVersion: process.env.APP_VERSION, source: 'manual' }))
        .toMatchObject({ deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.PREPARING_RESCUE });
    });

    it.each([
      'toolchain_unavailable',
      DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
    ])('does not schedule an automatic upgrade after blocker %s', async (reason) => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';
      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);
      ws.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      ws.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED, reason }));
      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsync();
      expect(ws.sentStrings.filter((msg) => msg.includes('\"type\":\"daemon.upgrade\"'))).toHaveLength(0);
    });

    it('cancels the auth-scheduled auto upgrade when a persisted install failure replays', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.3192-dev.3593';
      markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        daemonVersion: '2026.7.3157-dev.3556',
      }));
      ws.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
        failureId: 'failure-after-link-down',
        fromVersion: '2026.7.3157-dev.3556',
        targetVersion: '2026.7.3192-dev.3593',
        retryReason: 'stale-staging-dir',
        exitCode: 217,
        log: '/tmp/imcodes-upgrade-test/upgrade.log',
        ts: Date.now(),
      }));
      await flushAsync();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();

      expect(ws.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);
      expect(ws.sentStrings.some((raw) => {
        const message = JSON.parse(raw) as Record<string, unknown>;
        return message.type === DAEMON_MSG.UPGRADE_BLOCKED_ACK
          && message.failureId === 'failure-after-link-down'
          && message.disposition === 'accepted';
      })).toBe(true);

      const autoRetry = bridge.requestDaemonUpgrade({
        targetVersion: process.env.APP_VERSION,
        source: 'manual',
      });
      expect(autoRetry).toMatchObject({
        deliveryStatus: DAEMON_UPGRADE_DELIVERY_STATUS.SENT,
      });
    });

    it('does not arm auto upgrade while slow auth replay keeps a persisted blocker waiting', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.3192-dev.3593';
      markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);

      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {
        JWT_SIGNING_KEY: 'bridge-test-signing-key',
      } as never);

      const target = { kind: 'main', serverId, sessionName: 'deck_slow_auth_brain' } as const;
      const liveCoverage = {
        target,
        effectiveRole: 'participant',
        historyCutoffAt: Date.now() - 1_000,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-slow-auth'],
        primaryShareId: 'share-slow-auth',
        authorizedAt: Date.now(),
      } as const;
      bridge.setShareCoverageResolverForTests(async () => liveCoverage);

      const sharedBrowser = new MockWs();
      bridge.handleShareBrowserConnection(sharedBrowser as never, 'shared-user', makeDb('valid-hash'), {
        ticketId: 'share-ticket-slow-auth',
        target,
        snapshot: liveCoverage,
      });
      sharedBrowser.emit('message', JSON.stringify({
        type: 'session.send',
        commandId: 'slow-auth-command',
        sessionName: target.sessionName,
        text: 'hold auth replay',
      }));
      await flushAsync();
      expect(bridge._getInflightCountForTest()).toBe(1);

      let resolveCoverage!: (value: typeof liveCoverage) => void;
      const coveragePending = new Promise<typeof liveCoverage>((resolve) => {
        resolveCoverage = resolve;
      });
      bridge.setShareCoverageResolverForTests(async () => coveragePending);

      daemonWs.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        daemonVersion: '2026.7.3157-dev.3556',
      }));
      daemonWs.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
        failureId: 'failure-during-slow-auth',
        fromVersion: '2026.7.3157-dev.3556',
        targetVersion: process.env.APP_VERSION,
      }));
      await flushAsync();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();
      expect(daemonWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);

      resolveCoverage(liveCoverage);
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();

      expect(daemonWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);
      expect(daemonWs.sentStrings.some((raw) => {
        const message = JSON.parse(raw) as Record<string, unknown>;
        return message.type === DAEMON_MSG.UPGRADE_BLOCKED_ACK
          && message.failureId === 'failure-during-slow-auth'
          && message.disposition === 'accepted';
      })).toBe(true);
    });

    it('waits for daemon outbox sync even when auth finishes more than five seconds earlier', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.3192-dev.3593';
      markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);

      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        daemonVersion: '2026.7.3157-dev.3556',
        [DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.AUTH_REVISION_FIELD]:
          DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.REVISION,
      }));
      await flushAsync();

      await vi.advanceTimersByTimeAsync(10_000);
      await flushAsync();
      expect(daemonWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);

      daemonWs.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
        failureId: 'failure-after-delayed-outbox-read',
        upgradeId: 'old-auto-upgrade',
        fromVersion: '2026.7.3157-dev.3556',
        targetVersion: process.env.APP_VERSION,
      }));
      daemonWs.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED_SYNC,
        revision: DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.REVISION,
      }));
      await vi.advanceTimersByTimeAsync(0);
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();

      expect(daemonWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);
      expect(daemonWs.sentStrings.map((raw) => JSON.parse(raw))).toContainEqual({
        type: DAEMON_MSG.UPGRADE_BLOCKED_ACK,
        failureId: 'failure-after-delayed-outbox-read',
        disposition: DAEMON_UPGRADE_BLOCKED_ACK_DISPOSITION.ACCEPTED,
      });
    });

    it('does not start an automatic upgrade after an empty outbox sync', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.3192-dev.3593';
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.7.3157-dev.3556', [DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.AUTH_REVISION_FIELD]: DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.REVISION }));
      await flushAsync();
      daemonWs.emit('message', JSON.stringify({ type: DAEMON_MSG.UPGRADE_BLOCKED_SYNC, revision: DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.REVISION }));
      await vi.advanceTimersByTimeAsync(10_000);
      await flushAsync();
      expect(daemonWs.sentStrings.filter((msg) => msg.includes('\"type\":\"daemon.upgrade\"'))).toHaveLength(0);
    });

    it('replays an explicitly requested manual upgrade after reconnect', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.3192-dev.3593';
      const bridge = WsBridge.get(serverId);
      const firstWs = new MockWs();
      bridge.handleDaemonConnection(firstWs as never, makeDb('valid-hash'), {} as never);
      firstWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.7.3157-dev.3556' }));
      await flushAsync();
      firstWs.emit('close');
      markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);
      const manual = bridge.requestDaemonUpgrade({ targetVersion: process.env.APP_VERSION, source: 'manual' });
      expect(manual.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE);
      const reconnectWs = new MockWs();
      bridge.handleDaemonConnection(reconnectWs as never, makeDb('valid-hash'), {} as never);
      reconnectWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.7.3157-dev.3556' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(0);
      await flushAsync();
      expect(reconnectWs.sentStrings.map((raw) => JSON.parse(raw)).filter((message) => message.type === DAEMON_COMMAND_TYPES.DAEMON_UPGRADE)).toEqual([{
        type: DAEMON_COMMAND_TYPES.DAEMON_UPGRADE,
        upgradeId: manual.upgradeId,
        targetVersion: process.env.APP_VERSION,
        source: 'manual',
      }]);
    });

    it('acks an old-target install failure as obsolete without blocking the new target', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.3193-dev.3594';
      markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);

      const bridge = WsBridge.get(serverId);
      const ws = new MockWs();
      bridge.handleDaemonConnection(ws as never, makeDb('valid-hash'), {} as never);

      ws.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        daemonVersion: '2026.7.3157-dev.3556',
      }));
      ws.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
        failureId: 'failure-for-old-target',
        fromVersion: '2026.7.3157-dev.3556',
        targetVersion: '2026.7.3192-dev.3593',
      }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(CONTROLLED_NODE_UPGRADE_STAGGER_MAX_MS);
      await flushAsync();

      // The failure belonged to an older target: it is acked as obsolete and the
      // NEW target is still offered (a failure only ever blocks its own target).
      expect(ws.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(1);
      expect(ws.sentStrings.some((raw) => {
        const message = JSON.parse(raw) as Record<string, unknown>;
        return message.type === DAEMON_MSG.UPGRADE_BLOCKED_ACK
          && message.failureId === 'failure-for-old-target'
          && message.disposition === 'obsolete';
      })).toBe(true);
    });

    it('sends a deferred daemon.upgrade only to the replacement socket and ignores stale frames', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.4.905-dev.877';

      const bridge = WsBridge.get(serverId);
      const staleWs = new MockWs();
      bridge.handleDaemonConnection(staleWs as never, makeDb('valid-hash'), {} as never);
      staleWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);
      staleWs.emit('close');
      const manual = bridge.requestDaemonUpgrade({ targetVersion: process.env.APP_VERSION, source: 'manual' });
      expect(manual.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE);

      const replacementWs = new MockWs();
      bridge.handleDaemonConnection(replacementWs as never, makeDb('valid-hash'), {} as never);
      replacementWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token', daemonVersion: '2026.4.904-dev.100' }));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();

      expect(staleWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);
      expect(replacementWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(1);

      const rawBrowser = new MockWs();
      bridge.handleBrowserConnection(rawBrowser as never, 'raw-user', makeDb('valid-hash'));
      rawBrowser.emit('message', JSON.stringify({
        type: 'terminal.subscribe',
        session: 'deck_stale_socket_binary',
        raw: true,
      }));
      await flushAsync();
      rawBrowser.sent.length = 0;

      // ws can emit already-buffered frames while the replaced socket is still
      // CLOSING. Neither binary data nor a terminal blocker from generation 1
      // may borrow generation 2's authenticated bridge state.
      staleWs.emit('message', packFrame('deck_stale_socket_binary', Buffer.from('stale')), true);
      staleWs.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
        failureId: 'failure-from-replaced-socket',
        fromVersion: '2026.4.904-dev.100',
        targetVersion: process.env.APP_VERSION,
      }));
      await flushAsync();
      expect.soft(rawBrowser.sent.filter((item) => Buffer.isBuffer(item))).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
      const nextAuto = bridge.requestDaemonUpgrade({
        targetVersion: process.env.APP_VERSION,
        source: 'auto',
      });
      expect.soft(nextAuto.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.ALREADY_IN_PROGRESS);
    });

    it('tells a cancel-capable daemon to drop the reply when an HTTP history request times out', async () => {
      vi.useFakeTimers();
      try {
        const bridge = WsBridge.get(serverId);
        const daemonWs = new MockWs();
        bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
        daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
        await vi.advanceTimersByTimeAsync(0);
        daemonWs.emit('message', JSON.stringify({
          type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
          daemonId: serverId,
          capabilities: [TIMELINE_HISTORY_CANCEL_CAPABILITY],
          helloEpoch: 1,
          sentAt: Date.now(),
        }));
        await vi.advanceTimersByTimeAsync(0);

        const pending = bridge.requestTimelineHistory({ sessionName: 'deck_slow_uplink', timeoutMs: 1_000 });
        const rejected = expect(pending).rejects.toThrow('timeout');
        const outbound = daemonWs.sentStrings.find((raw) => raw.includes(`"type":"${TIMELINE_MESSAGES.HISTORY_REQUEST}"`));
        const requestId = JSON.parse(outbound!).requestId as string;

        await vi.advanceTimersByTimeAsync(1_001);
        await rejected;
        const cancels = daemonWs.sentStrings
          .map((raw) => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })
          .filter((msg) => msg?.type === TIMELINE_MESSAGES.HISTORY_CANCEL);
        expect(cancels).toEqual([{ type: TIMELINE_MESSAGES.HISTORY_CANCEL, requestId }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('never sends a history cancel to a daemon that does not advertise support', async () => {
      vi.useFakeTimers();
      try {
        const bridge = WsBridge.get(serverId);
        const daemonWs = new MockWs();
        bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
        daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
        await vi.advanceTimersByTimeAsync(0);
        daemonWs.emit('message', JSON.stringify({
          type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
          daemonId: serverId,
          capabilities: [],
          helloEpoch: 1,
          sentAt: Date.now(),
        }));
        await vi.advanceTimersByTimeAsync(0);

        const pending = bridge.requestTimelineHistory({ sessionName: 'deck_old_daemon', timeoutMs: 1_000 });
        const rejected = expect(pending).rejects.toThrow('timeout');
        await vi.advanceTimersByTimeAsync(1_001);
        await rejected;
        expect(daemonWs.sentStrings.some((raw) => raw.includes(TIMELINE_MESSAGES.HISTORY_CANCEL))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('tracks each session\'s identity project key exactly as the daemon derives it', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: 'session_list',
        sessions: [
          { name: 'deck_repo_brain', project: 'repo', state: 'idle', contextNamespace: { projectId: 'github-org/repo' } },
          { name: 'deck_plain_brain', project: 'plain', state: 'idle' },
        ],
      }));
      await flushAsync();
      expect(bridge.resolveSessionIdentityProjectKey('deck_repo_brain')).toBe('github-org/repo');
      expect(bridge.resolveSessionIdentityProjectKey('deck_plain_brain')).toBe('plain');
      expect(bridge.resolveSessionIdentityProjectKey('deck_unknown_brain')).toBeNull();

      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync', id: 'kid1', parentSession: 'deck_repo_brain', sessionType: 'claude-code', cwd: '/home/k/work/repo',
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'subsession.sync', id: 'kid2', parentSession: 'deck_repo_brain', sessionType: 'claude-code', cwd: '/home/k/work/other',
        contextNamespace: { projectId: 'github-org/other' },
      }));
      await flushAsync();
      // Without its own namespace a sub-session shares its parent's project.
      expect(bridge.resolveSessionIdentityProjectKey('deck_sub_kid1')).toBe('github-org/repo');
      expect(bridge.resolveSessionIdentityProjectKey('deck_sub_kid2')).toBe('github-org/other');
    });

    it('does not let an error from a replaced socket reject current-generation requests', async () => {
      const bridge = WsBridge.get(serverId);
      const staleWs = new MockWs();
      bridge.handleDaemonConnection(staleWs as never, makeDb('valid-hash'), {} as never);
      staleWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
      await flushAsync();

      const replacementWs = new MockWs();
      bridge.handleDaemonConnection(replacementWs as never, makeDb('valid-hash'), {} as never);
      replacementWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'my-token' }));
      await flushAsync();

      const pending = bridge.requestTimelineHistory({
        sessionName: 'deck_replacement_request',
        timeoutMs: 10_000,
      });
      const outbound = replacementWs.sentStrings.find((raw) => raw.includes('"type":"timeline.history_request"'));
      expect(outbound).toBeTruthy();
      const requestId = JSON.parse(outbound!).requestId as string;
      let settled = false;
      const observed = pending.then(
        (value) => {
          settled = true;
          return { status: 'resolved' as const, value };
        },
        (error: unknown) => {
          settled = true;
          return { status: 'rejected' as const, error };
        },
      );

      staleWs.emit('error', new Error('stale socket error'));
      await flushAsync();
      expect(settled).toBe(false);

      replacementWs.emit('message', JSON.stringify({
        type: 'timeline.history',
        sessionName: 'deck_replacement_request',
        requestId,
        events: [],
        epoch: 1,
      }));
      await expect(observed).resolves.toMatchObject({
        status: 'resolved',
        value: {
          type: 'timeline.history',
          requestId,
          epoch: 1,
        },
      });
    });

    it('does not let a stale in-flight auth certify or dispatch through its replacement connection', async () => {
      vi.useFakeTimers();
      process.env.APP_VERSION = '2026.7.3192-dev.3593';
      markDaemonUpgradeTargetVersionPublishedForTest(process.env.APP_VERSION);

      type AuthRow = {
        token_hash: string;
        node_role: 'full';
        revoked_at: null;
      };
      const makeDeferredAuthDb = () => {
        let resolveQuery!: (value: AuthRow) => void;
        const queryPromise = new Promise<AuthRow>((resolve) => {
          resolveQuery = resolve;
        });
        const db = {
          queryOne: () => queryPromise,
          query: async () => [],
          execute: async () => ({ changes: 1 }),
          exec: async () => {},
          transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) =>
            fn(db as unknown as import('../src/db/client.js').Database),
          close: () => {},
        } as unknown as import('../src/db/client.js').Database;
        return { db, resolveQuery };
      };

      const bridge = WsBridge.get(serverId);
      const manual = bridge.requestDaemonUpgrade({
        targetVersion: process.env.APP_VERSION,
        source: 'manual',
      });
      expect(manual.deliveryStatus).toBe(DAEMON_UPGRADE_DELIVERY_STATUS.PENDING_OFFLINE);

      const firstAuth = makeDeferredAuthDb();
      const firstWs = new MockWs();
      bridge.handleDaemonConnection(firstWs as never, firstAuth.db, {} as never);
      firstWs.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        daemonVersion: '2026.7.3157-dev.3556',
        [DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.AUTH_REVISION_FIELD]:
          DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.REVISION,
      }));
      await flushAsync();

      const replacementAuth = makeDeferredAuthDb();
      const replacementWs = new MockWs();
      bridge.handleDaemonConnection(replacementWs as never, replacementAuth.db, {} as never);
      replacementWs.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
        daemonVersion: '2026.7.3157-dev.3556',
        [DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.AUTH_REVISION_FIELD]:
          DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.REVISION,
      }));
      await flushAsync();

      // Finish generation 1 after generation 2 has installed its own socket
      // and auth promise. The stale continuation must not authenticate gen 2,
      // clear its promise, or rewrite its blocker-sync generation.
      firstAuth.resolveQuery({
        token_hash: 'valid-hash',
        node_role: 'full',
        revoked_at: null,
      });
      await flushAsync();
      expect(bridge.isAuthenticated).toBe(false);
      expect(replacementWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);

      // Generation 2 may authenticate, but remains unable to dispatch the
      // pending manual upgrade until its own persisted-blocker sync arrives.
      replacementAuth.resolveQuery({
        token_hash: 'valid-hash',
        node_role: 'full',
        revoked_at: null,
      });
      await flushAsync();
      expect(bridge.isAuthenticated).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      await flushAsync();
      expect(replacementWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);

      replacementWs.emit('message', JSON.stringify({
        type: DAEMON_MSG.UPGRADE_BLOCKED_SYNC,
        revision: DAEMON_UPGRADE_BLOCKED_SYNC_PROTOCOL.REVISION,
      }));
      await vi.advanceTimersByTimeAsync(0);
      await flushAsync();

      const upgrades = replacementWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((message) => message.type === DAEMON_COMMAND_TYPES.DAEMON_UPGRADE);
      expect(upgrades).toEqual([{
        type: DAEMON_COMMAND_TYPES.DAEMON_UPGRADE,
        upgradeId: manual.upgradeId,
        targetVersion: process.env.APP_VERSION,
        source: 'manual',
      }]);
      expect(firstWs.sentStrings.filter((msg) => msg.includes('"type":"daemon.upgrade"'))).toHaveLength(0);
    });

    it('does not replay an inflight command through a replacement while stale auth revalidation settles', async () => {
      const bridge = WsBridge.get(serverId);
      const firstWs = new MockWs();
      bridge.handleDaemonConnection(firstWs as never, makeDb('valid-hash'), {
        JWT_SIGNING_KEY: 'bridge-test-signing-key',
      } as never);

      const target = { kind: 'main', serverId, sessionName: 'deck_stale_auth_replay_brain' } as const;
      const liveCoverage = {
        target,
        effectiveRole: 'participant',
        historyCutoffAt: Date.now() - 1_000,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-stale-auth-replay'],
        primaryShareId: 'share-stale-auth-replay',
        authorizedAt: Date.now(),
      } as const;
      bridge.setShareCoverageResolverForTests(async () => liveCoverage);
      const sharedBrowser = new MockWs();
      bridge.handleShareBrowserConnection(sharedBrowser as never, 'shared-user', makeDb('valid-hash'), {
        ticketId: 'share-ticket-stale-auth-replay',
        target,
        snapshot: liveCoverage,
      });
      sharedBrowser.emit('message', JSON.stringify({
        type: 'session.send',
        commandId: 'stale-auth-replay-command',
        sessionName: target.sessionName,
        text: 'must reach only the authenticated replacement',
      }));
      await flushAsync();
      expect(bridge._getInflightCountForTest()).toBe(1);

      let resolveCoverage!: (value: typeof liveCoverage) => void;
      const coveragePending = new Promise<typeof liveCoverage>((resolve) => {
        resolveCoverage = resolve;
      });
      bridge.setShareCoverageResolverForTests(async () => coveragePending);

      firstWs.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
      }));
      await flushAsync();

      let resolveReplacementAuth!: (value: {
        token_hash: string;
        node_role: 'full';
        revoked_at: null;
      }) => void;
      const replacementQuery = new Promise<{
        token_hash: string;
        node_role: 'full';
        revoked_at: null;
      }>((resolve) => {
        resolveReplacementAuth = resolve;
      });
      const replacementDb = {
        queryOne: () => replacementQuery,
        query: async () => [],
        execute: async () => ({ changes: 1 }),
        exec: async () => {},
        transaction: async <T>(fn: (tx: import('../src/db/client.js').Database) => Promise<T>) =>
          fn(replacementDb as unknown as import('../src/db/client.js').Database),
        close: () => {},
      } as unknown as import('../src/db/client.js').Database;
      const replacementWs = new MockWs();
      bridge.handleDaemonConnection(replacementWs as never, replacementDb, {} as never);
      replacementWs.emit('message', JSON.stringify({
        type: 'auth',
        serverId,
        token: 'my-token',
      }));
      await flushAsync();

      // Let generation 1's share revalidation finish after generation 2 owns
      // the bridge. Its auth flow must leave the entry buffered, not send it
      // through generation 2 before that socket authenticates.
      resolveCoverage(liveCoverage);
      await flushAsync();
      expect(bridge.isAuthenticated).toBe(false);
      expect(replacementWs.sentStrings.filter((raw) => raw.includes('"type":"session.send"'))).toHaveLength(0);

      resolveReplacementAuth({
        token_hash: 'valid-hash',
        node_role: 'full',
        revoked_at: null,
      });
      await flushAsync();

      expect(bridge.isAuthenticated).toBe(true);
      expect(replacementWs.sentStrings.filter((raw) => raw.includes('"type":"session.send"'))).toHaveLength(1);
      expect(firstWs.sentStrings.filter((raw) => raw.includes('"type":"session.send"'))).toHaveLength(0);
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

    it('routes a daemon terminal.stream_reset only to browsers subscribed to that session', async () => {
      // A daemon-originated reset (raw_buffer_overflow) previously fell through
      // to the default-allow broadcast, so every connected tab reset a terminal
      // it never subscribed to and that never congested.
      const { bridge, daemonWs, browserWs } = await setupAuthenticatedBridge();
      const otherWs = new MockWs();
      bridge.handleBrowserConnection(otherWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-congested' }));
      otherWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sess-quiet' }));
      await flushAsync();
      browserWs.sent.length = 0;
      otherWs.sent.length = 0;

      daemonWs.emit('message', JSON.stringify({
        type: 'terminal.stream_reset', session: 'sess-congested', reason: 'raw_buffer_overflow',
      }));
      await flushAsync();

      const resets = (ws: typeof browserWs) => ws.sentStrings
        .filter((x) => x.includes('"terminal.stream_reset"'));
      expect(resets(browserWs).length, 'the subscribed tab must receive the reset').toBe(1);
      expect(
        resets(otherWs).length,
        'a tab subscribed to a different session must not be reset',
      ).toBe(0);
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

    it('relays daemon disk capacity stats to desktop browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      const disks = [
        {
          mount: '/',
          totalBytes: 500 * 1024 ** 3,
          usedBytes: 225 * 1024 ** 3,
          usedPercent: 45,
        },
      ];

      daemonWs.emit('message', JSON.stringify({
        type: 'daemon.stats',
        daemonVersion: '1.2.3',
        cpu: 12,
        memUsed: 1,
        memTotal: 2,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptime: 100,
        disks,
      }));
      await flushAsync();

      const stats = browserWs.sentStrings
        .map((message) => JSON.parse(message))
        .find((message) => message.type === 'daemon.stats');
      expect(stats).toMatchObject({ type: 'daemon.stats', disks });
    });

    it('omits malformed daemon disk stats instead of forwarding a non-array value', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'daemon.stats',
        cpu: 12,
        memUsed: 1,
        memTotal: 2,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptime: 100,
        disks: 'not-an-array',
      }));
      await flushAsync();

      const stats = browserWs.sentStrings
        .map((message) => JSON.parse(message))
        .find((message) => message.type === 'daemon.stats');
      expect(stats).toBeDefined();
      expect(stats).not.toHaveProperty('disks');
    });

    it('relays daemon embedding status to browsers', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      const embedding = { state: 'ready', reason: null };

      daemonWs.emit('message', JSON.stringify({
        type: 'daemon.stats',
        cpu: 12,
        memUsed: 1,
        memTotal: 2,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptime: 100,
        embedding,
      }));
      await flushAsync();

      const stats = browserWs.sentStrings
        .map((message) => JSON.parse(message))
        .find((message) => message.type === 'daemon.stats');
      expect(stats).toMatchObject({ type: 'daemon.stats', embedding });
    });

    it('drops malformed daemon embedding status instead of forwarding junk', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();

      daemonWs.emit('message', JSON.stringify({
        type: 'daemon.stats',
        cpu: 12,
        memUsed: 1,
        memTotal: 2,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptime: 100,
        embedding: { state: 'ready', reason: 42 },
      }));
      await flushAsync();

      const stats = browserWs.sentStrings
        .map((message) => JSON.parse(message))
        .find((message) => message.type === 'daemon.stats');
      expect(stats).toBeDefined();
      expect(stats).not.toHaveProperty('embedding');
    });

    it('relays validated direct-connectivity runtime diagnostics and drops malformed values', async () => {
      const { daemonWs, browserWs } = await setupAuthenticatedBridge();
      daemonWs.emit('message', JSON.stringify({
        type: 'daemon.stats',
        cpu: 12,
        memUsed: 1,
        memTotal: 2,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptime: 100,
        directConnectivity: { state: 'runtime_unavailable', error: 'native_module_missing' },
      }));
      daemonWs.emit('message', JSON.stringify({
        type: 'daemon.stats',
        cpu: 12,
        memUsed: 1,
        memTotal: 2,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptime: 100,
        directConnectivity: { state: 'available', targetIp: '192.168.2.145' },
      }));
      await flushAsync();

      const rows = browserWs.sentStrings
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === 'daemon.stats');
      expect(rows.at(-2)).toMatchObject({
        directConnectivity: { state: 'runtime_unavailable', error: 'native_module_missing' },
      });
      expect(rows.at(-1)).not.toHaveProperty('directConnectivity');
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

    it('forwards installs on the daemon\'s own computer, and only from its owner', async () => {
      // The remote-desktop router used to answer these `invalid_request`, so the
      // install buttons never reached the daemon. The controlled-node install
      // runs as root there; someone the daemon is shared with must not be able
      // to enrol a node on it to their own account.
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      const db = makeDb('valid-hash', 'full', null, 'owner-user');
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      const participant = new MockWs();
      bridge.handleBrowserConnection(participant as never, 'participant-user', db);
      const owner = new MockWs();
      bridge.handleBrowserConnection(owner as never, 'owner-user', db);
      const requests = [
        JSON.stringify({ type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST, installCode: 'ABCDEFGHJKMN' }),
        JSON.stringify({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST }),
      ];
      const forwarded = () => daemonWs.sentStrings.filter((s) => (
        s.includes(REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST) || s.includes(REMOTE_DESKTOP_INSTALL_MSG.REQUEST)
      ));

      for (const request of requests) participant.emit('message', request);
      await flushAsync();
      expect(forwarded()).toEqual([]);

      for (const request of requests) owner.emit('message', request);
      await flushAsync();
      expect(forwarded()).toEqual(requests);
      expect(owner.sentStrings.some((s) => s.includes('invalid_request'))).toBe(false);
    });

    it('relays the daemon\'s install progress to its browsers', async () => {
      // The router dropped these as malformed signalling, so a browser never
      // learned how an install it asked for went.
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      const db = makeDb('valid-hash', 'full', null, 'owner-user');
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      const owner = new MockWs();
      bridge.handleBrowserConnection(owner as never, 'owner-user', db);
      const reports = [
        { type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE, state: 'failed', error: 'admin_required' },
        { type: REMOTE_DESKTOP_INSTALL_MSG.STATE, state: 'downloading' },
      ];
      for (const report of reports) daemonWs.emit('message', JSON.stringify(report));
      daemonWs.emit('message', JSON.stringify({ type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE, state: 'made_up' }));
      await flushAsync();
      const relayed = owner.sentStrings
        .map((frame) => JSON.parse(frame) as { type?: string })
        .filter((frame) => frame.type === REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE
          || frame.type === REMOTE_DESKTOP_INSTALL_MSG.STATE);
      expect(relayed).toEqual(reports);
    });

    it('never queues an install for a daemon that is not connected', async () => {
      const bridge = WsBridge.get(serverId);
      const db = makeDb('valid-hash', 'full', null, 'owner-user');
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      const owner = new MockWs();
      bridge.handleBrowserConnection(owner as never, 'owner-user', db);
      daemonWs.close();
      await flushAsync();

      owner.emit('message', JSON.stringify({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST }));
      await flushAsync();
      const reconnected = new MockWs();
      bridge.handleDaemonConnection(reconnected as never, db, {} as never);
      reconnected.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      expect(reconnected.sentStrings.some((s) => s.includes(REMOTE_DESKTOP_INSTALL_MSG.REQUEST))).toBe(false);
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

    it('never lets a browser run the skills CLI on the machine directly', async () => {
      // Only the owner-checked /api/agent-skills route may send these.
      const { daemonWs, browserWs } = await setupBridge();
      for (const type of [AGENT_SKILLS_MSG.RUN_REQUEST, AGENT_SKILLS_MSG.LIST_REQUEST, AGENT_MCP_MSG.RUN_REQUEST, AGENT_MCP_MSG.LIST_REQUEST]) {
        browserWs.emit('message', JSON.stringify({ type, requestId: 'r3', action: 'add', source: 'owner/repo' }));
      }
      await flushAsync();

      expect(daemonWs.sentStrings.some((s) => s.includes(AGENT_SKILLS_MESSAGE_PREFIX) || s.includes(AGENT_MCP_MESSAGE_PREFIX))).toBe(false);
      expect(browserWs.sentStrings.some((s) => s.includes('server_only_command') && s.includes('r3'))).toBe(true);
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

    it('rejects offline peer-audit RPCs immediately and never replays them after reconnect', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));

      browserWs.emit('message', JSON.stringify({
        type: DAEMON_COMMAND_TYPES.PEER_AUDIT_QUICK_START,
        commandId: 'peer_cmd_offline_1234567890',
      }));
      await flushAsync();

      expect(browserWs.sentStrings.map((value) => JSON.parse(value))).toContainEqual({
        type: PEER_AUDIT_MESSAGES.QUICK_RESULT,
        commandId: 'peer_cmd_offline_1234567890',
        ok: false,
        error: PEER_AUDIT_COMMAND_ERRORS.DAEMON_UNAVAILABLE,
      });

      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      expect(daemonWs.sentStrings.some((value) => value.includes('peer_cmd_offline_1234567890'))).toBe(false);
    });

    it('forwards live peer-audit RPCs directly without the generic replay queue', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      daemonWs.sent.length = 0;

      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({
        type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
        commandId: 'peer_cmd_live_1234567890',
      }));
      await flushAsync();

      expect(daemonWs.sentStrings.map((value) => JSON.parse(value))).toContainEqual({
        type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
        commandId: 'peer_cmd_live_1234567890',
      });
      expect(browserWs.sentStrings).toHaveLength(0);
    });

    it('keeps offline daemon.upgrade out of the ordinary queue and flushes it once on auth', async () => {
      const bridge = WsBridge.get(serverId);

      bridge.sendToDaemon(JSON.stringify({ type: 'daemon.upgrade', targetVersion: '2026.4.905-dev.877' }));
      bridge.sendToDaemon(JSON.stringify({ type: 'daemon.upgrade', targetVersion: '2026.4.905-dev.877' }));

      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushOneBridgeDataPlaneTurn();

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

    const validChunk = (correlationId: string, overrides: Record<string, unknown> = {}) => ({
      type: DAEMON_MSG.MACHINE_EXEC_CHUNK,
      correlationId,
      seq: 0,
      stream: 'stdout',
      chunk: 'hello',
      ...overrides,
    });

    it('delivers valid CONTROLLED chunks in order before the terminal result', async () => {
      const { daemonWs, generation } = await setupResultBridge('controlled');
      const correlationId = 'valid-live-output';
      const chunks: Array<{ seq: number; stream: string; chunk: string }> = [];
      const pending = registerPendingExec(serverId, correlationId, generation, 60_000, (chunk) => chunks.push(chunk));

      daemonWs.emit('message', JSON.stringify(validChunk(correlationId, { chunk: 'first' })));
      daemonWs.emit('message', JSON.stringify(validChunk(correlationId, { seq: 1, stream: 'stderr', chunk: 'warn' })));
      daemonWs.emit('message', JSON.stringify(validResult(correlationId, { stdout: 'first', stderr: 'warn' })));

      await expect(pending).resolves.toMatchObject({ ok: true, stdout: 'first', stderr: 'warn' });
      expect(chunks).toEqual([
        { seq: 0, stream: 'stdout', chunk: 'first' },
        { seq: 1, stream: 'stderr', chunk: 'warn' },
      ]);
    });

    it('drops malformed and oversized CONTROLLED chunks without settling the pending exec', async () => {
      const { daemonWs, generation } = await setupResultBridge('controlled');
      const invalidFrames = [
        validChunk('bad-seq', { seq: -1 }),
        validChunk('bad-stream', { stream: 'combined' }),
        validChunk('empty-chunk', { chunk: '' }),
        validChunk('large-chunk', { chunk: 'x'.repeat(REMOTE_EXEC_MAX_CHUNK_BYTES + 1) }),
        validChunk('identity-field', { userId: 'forged-user' }),
      ];
      const invalidBefore = WsBridge.invalidMachineExecChunksDropped;
      const controlledBefore = WsBridge.controlledInboundDropped;

      for (const frame of invalidFrames) {
        const correlationId = frame.correlationId;
        const pending = registerPendingExec(serverId, correlationId, generation, 60_000);
        daemonWs.emit('message', JSON.stringify(frame));
        await flushAsync();
        expect(cancelPendingExec(correlationId)).toBe(true);
        await expect(pending).resolves.toBeNull();
      }

      expect(WsBridge.invalidMachineExecChunksDropped - invalidBefore).toBe(invalidFrames.length);
      expect(WsBridge.controlledInboundDropped - controlledBefore).toBe(invalidFrames.length);
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

    it('an oversize single frame does not swallow the stream_reset of a LATER real overflow', async () => {
      const { bridge, daemonWs } = await setupAuth();

      // A browser that never acknowledges: its ws.send callbacks stay pending,
      // so in-flight bytes accumulate and a real congestion episode can form.
      const browserWs = new MockWs();
      browserWs.stallSend = true;
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessNoticeLatch' }));
      await flushAsync();
      browserWs.sent.length = 0;

      const resetCount = () => browserWs.sentStrings.filter((x) => x.includes('"terminal.stream_reset"')).length;

      // 1. A single frame bigger than the whole budget, with nothing in flight.
      //    This is not congestion — there is no backlog — so it must not open
      //    (or consume) an overflow episode.
      daemonWs.emit('message', packFrame('sessNoticeLatch', Buffer.alloc(4 * 1024 * 1024 + 100, 0x51)), true);
      await flushAsync();
      const afterOversize = resetCount();
      expect(afterOversize).toBeGreaterThanOrEqual(1);

      // 2. Now build REAL congestion: normal frames the stalled browser never
      //    acknowledges, until the high-water mark is crossed.
      for (let i = 0; i < 6; i++) {
        daemonWs.emit('message', packFrame('sessNoticeLatch', Buffer.alloc(1024 * 1024, 0x52)), true);
        await flushAsync();
      }

      // If the oversize drop had consumed the one-shot notice, nothing would
      // ever clear it again (that path never pauses), and the browser would be
      // left with a silent gap it is never told about.
      expect(resetCount()).toBeGreaterThan(afterOversize);
    });

    it('a late callback from a forgiven generation cannot hand the socket extra budget', async () => {
      vi.useFakeTimers();
      try {
        const { bridge, daemonWs } = await setupAuth();
        const browserWs = new MockWs();
        browserWs.stallSend = true;
        bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
        browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessEpoch' }));
        await vi.advanceTimersByTimeAsync(50);
        browserWs.sent.length = 0;

        const binaryCount = () => browserWs.sent.filter((x) => Buffer.isBuffer(x)).length;

        // Fill the budget with frames the peer never acknowledges.
        for (let i = 0; i < 5; i++) {
          daemonWs.emit('message', packFrame('sessEpoch', Buffer.alloc(1024 * 1024, 0x61)), true);
          await vi.advanceTimersByTimeAsync(1);
        }
        const acceptedBeforeGrace = binaryCount();

        // Paused now: further frames are dropped, not sent.
        daemonWs.emit('message', packFrame('sessEpoch', Buffer.alloc(512 * 1024, 0x62)), true);
        await vi.advanceTimersByTimeAsync(1);
        expect(binaryCount()).toBe(acceptedBeforeGrace);

        // Wait past the grace window so the budget is forgiven once, then let
        // the OLD, still-unacknowledged callbacks land.
        await vi.advanceTimersByTimeAsync(2_500);
        daemonWs.emit('message', packFrame('sessEpoch', Buffer.alloc(1024, 0x63)), true);
        await vi.advanceTimersByTimeAsync(1);
        const afterForgiveness = binaryCount();
        expect(afterForgiveness).toBeGreaterThan(acceptedBeforeGrace);

        // The forgiven generation's callbacks arrive late. They refer to bytes
        // already written off; if they decremented the fresh counter it would go
        // negative and the socket would silently regain multi-MB of credit.
        browserWs.drainStalledSends();
        await vi.advanceTimersByTimeAsync(1);

        // Re-fill: the post-forgiveness budget must be the SAME 4MB, not 4MB
        // plus whatever the stale callbacks refunded.
        browserWs.stallSend = true;
        let accepted = 0;
        for (let i = 0; i < 12; i++) {
          const before = binaryCount();
          daemonWs.emit('message', packFrame('sessEpoch', Buffer.alloc(1024 * 1024, 0x64)), true);
          await vi.advanceTimersByTimeAsync(1);
          if (binaryCount() > before) accepted += 1;
        }
        // 4MB budget / 1MB frames => at most 4 accepted before pausing again.
        expect(accepted).toBeLessThanOrEqual(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Slow-socket recovery: the resync must be asked for when it CAN be delivered ──
  //
  // tsk_f2a967730b. A paused queue drops everything, including the snapshot the
  // browser requests in reaction to the (single) reset sent when the drop began.
  // Nothing was ever sent again, so the browser - which discards every byte until
  // a snapshot arrives - sat on its last picture after the socket had drained.

  describe('backpressure recovery: the browser is told again once frames flow', () => {
    const resetsOf = (ws: MockWs, session: string) => ws.sentStrings
      .map((s) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => m?.type === 'terminal.stream_reset' && m.session === session);

    async function congest(session: string) {
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      browserWs.stallSend = true;
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session }));
      await flushAsync();
      browserWs.sent.length = 0;
      // Fill the 4 MB budget with frames the peer never acknowledges, then drop.
      for (let i = 0; i < 6; i++) {
        daemonWs.emit('message', packFrame(session, Buffer.alloc(1024 * 1024, 0x61)), true);
        await flushAsync();
      }
      return { daemonWs, browserWs };
    }

    it('sends a second stream_reset (backpressure_resume) when the socket drains after drops', async () => {
      const { browserWs } = await congest('sessResume');
      expect(resetsOf(browserWs, 'sessResume').map((m) => m.reason)).toEqual(['backpressure']);

      browserWs.drainStalledSends();
      await flushAsync();
      expect(resetsOf(browserWs, 'sessResume').map((m) => m.reason)).toEqual(['backpressure', 'backpressure_resume']);
    });

    it('does not repeat the resume notice for later drains, and sends none when nothing was dropped', async () => {
      const { daemonWs, browserWs } = await congest('sessResumeOnce');
      browserWs.drainStalledSends();
      await flushAsync();
      const afterFirst = resetsOf(browserWs, 'sessResumeOnce').length;
      // Healthy traffic and further drains: no more resets.
      browserWs.stallSend = true;
      daemonWs.emit('message', packFrame('sessResumeOnce', Buffer.alloc(1024, 0x62)), true);
      await flushAsync();
      browserWs.drainStalledSends();
      await flushAsync();
      expect(resetsOf(browserWs, 'sessResumeOnce')).toHaveLength(afterFirst);

      // A socket that never congested never gets one.
      const { bridge, daemonWs: daemon2 } = await setupAuth();
      const calm = new MockWs();
      bridge.handleBrowserConnection(calm as never, 'test-user', makeDb('valid-hash'));
      calm.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessCalm' }));
      await flushAsync();
      for (let i = 0; i < 10; i++) daemon2.emit('message', packFrame('sessCalm', Buffer.alloc(512, 0x63)), true);
      await flushAsync();
      expect(resetsOf(calm, 'sessCalm')).toHaveLength(0);
    });

    it('also notifies when the grace valve forgives a socket that never drained', async () => {
      vi.useFakeTimers();
      try {
        const { bridge, daemonWs } = await setupAuth();
        const browserWs = new MockWs();
        browserWs.stallSend = true;
        bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
        browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessGrace' }));
        await vi.advanceTimersByTimeAsync(50);
        browserWs.sent.length = 0;
        for (let i = 0; i < 6; i++) {
          daemonWs.emit('message', packFrame('sessGrace', Buffer.alloc(1024 * 1024, 0x61)), true);
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(resetsOf(browserWs, 'sessGrace').map((m) => m.reason)).toEqual(['backpressure']);

        await vi.advanceTimersByTimeAsync(2_500);
        daemonWs.emit('message', packFrame('sessGrace', Buffer.alloc(1024, 0x63)), true);
        await vi.advanceTimersByTimeAsync(1);
        expect(resetsOf(browserWs, 'sessGrace').map((m) => m.reason)).toEqual(['backpressure', 'backpressure_resume']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an oversize single frame with nothing in flight needs no resume (nothing is paused)', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({ type: 'terminal.subscribe', session: 'sessOversize' }));
      await flushAsync();
      browserWs.sent.length = 0;
      daemonWs.emit('message', packFrame('sessOversize', Buffer.alloc(4 * 1024 * 1024 + 100, 0x44)), true);
      await flushAsync();
      daemonWs.emit('message', packFrame('sessOversize', Buffer.alloc(64, 0x45)), true);
      await flushAsync();
      expect(resetsOf(browserWs, 'sessOversize').map((m) => m.reason)).toEqual(['backpressure']);
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

    it('bounds legacy browser bulk-read storms without rate-limiting control commands', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      await flushAsync();
      daemonWs.sent.length = 0;
      browserWs.sent.length = 0;

      for (let index = 0; index < 65; index += 1) {
        browserWs.emit('message', JSON.stringify({
          type: 'fs.ls',
          requestId: `bulk-${index}`,
          path: `/tmp/${index}`,
        }));
      }
      browserWs.emit('message', JSON.stringify({
        type: 'session.send', session: 'sessStorm', text: 'control survives', commandId: 'cmd-survives',
      }));
      await flushAsync();

      const forwarded = daemonWs.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      expect(forwarded.filter((message) => message.type === 'fs.ls')).toHaveLength(64);
      expect(forwarded).toContainEqual(expect.objectContaining({ type: 'session.send', commandId: 'cmd-survives' }));
      expect(browserWs.sentStrings.map((raw) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
        type: 'fs.ls_response',
        requestId: 'bulk-64',
        status: 'error',
        error: FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_QUEUE_FULL,
        recoverable: true,
      }));
      expect(getCounter('ws_bridge_browser_data_read_rate_limited', { type: 'fs.ls' })).toBe(1);
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

    it('tracks an ask.answer that carries a commandId until the daemon acks it', async () => {
      const { daemonWs, browserWs } = await setupBridge();
      const bridge = WsBridge.get(serverId);
      browserWs.emit('message', JSON.stringify({
        type: ASK_ANSWER_COMMAND, sessionName: 's', answer: 'yes', commandId: 'ans-1', toolUseId: 'toolu_1',
      }));
      await flushAsync();
      expect(daemonWs.sentStrings.some((s) => s.includes(ASK_ANSWER_COMMAND) && s.includes('ans-1'))).toBe(true);
      expect(bridge._getInflightCountForTest()).toBe(1);

      daemonWs.emit('message', JSON.stringify({
        type: 'command.ack', commandId: 'ans-1', status: 'accepted', session: 's', delivery: 'in_place',
      }));
      await flushAsync();
      expect(bridge._getInflightCountForTest()).toBe(0);
      const acks = browserWs.sent
        .map((raw) => { try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return null; } })
        .filter((msg) => msg?.type === 'command.ack' && msg.commandId === 'ans-1');
      expect(acks).toEqual([expect.objectContaining({ status: 'accepted', delivery: 'in_place' })]);
    });

    it('tells the browser at once when an ask.answer cannot reach an offline daemon', async () => {
      const bridge = WsBridge.get(serverId);
      const browserWs = new MockWs();
      bridge.handleBrowserConnection(browserWs as never, 'test-user', makeDb('valid-hash'));
      browserWs.emit('message', JSON.stringify({
        type: ASK_ANSWER_COMMAND, sessionName: 's', answer: 'yes', commandId: 'ans-offline',
      }));
      await flushAsync();
      const failed = browserWs.sent
        .map((raw) => { try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return null; } })
        .filter((msg) => msg?.type === 'command.failed' && msg.commandId === 'ans-offline');
      expect(failed).toEqual([expect.objectContaining({ reason: 'daemon_offline' })]);
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

    it('R3 v2 PR-σ — also replays cached daemon.hello to a participant who joins a shared session late', async () => {
      // Same bug as the owner case above (a browser that opens after the
      // daemon's hello never receives one), but for a participant share
      // connection: capabilities carries file.transfer.direct.lease.v2,
      // which a participant's own upload/download and the client's "WebRTC
      // runtime" diagnostic both gate on. Excluding every share connection
      // from the replay (meant to withhold owner-only P2P workflow-launch
      // state) left a participant permanently without a capability
      // snapshot, direct transfer never attempted, and the diagnostic
      // panel stuck on "unavailable" -- reported live: "参与者...卡在100%"
      // and "WebRTC 运行时不可用 完全不恢复".
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: [P2P_WORKFLOW_CAPABILITY_V1, DIRECT_FILE_TRANSFER_LEASE_CAPABILITY],
        helloEpoch: 1,
        sentAt: 555,
      }));
      await flushAsync();

      const target = { kind: 'main', serverId, sessionName: 'deck_late_participant_brain' } as const;
      const coverage = {
        target,
        effectiveRole: 'participant',
        historyCutoffAt: Date.now() - 1_000,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-late-participant'],
        primaryShareId: 'share-late-participant',
        authorizedAt: Date.now(),
      } as const;
      const participant = new MockWs();
      bridge.handleShareBrowserConnection(participant as never, 'participant-user', makeDb('valid-hash'), {
        ticketId: 'share-ticket-late-participant',
        target,
        snapshot: coverage,
      });
      await flushAsync();

      const helloMessages = participant.sentStrings
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === P2P_WORKFLOW_MSG.DAEMON_HELLO);
      expect(helloMessages).toHaveLength(1);
      expect(helloMessages[0]).toMatchObject({
        capabilities: [P2P_WORKFLOW_CAPABILITY_V1, DIRECT_FILE_TRANSFER_LEASE_CAPABILITY].sort(),
      });
    });

    it('still withholds the replay from a read-only viewer of a shared session', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, makeDb('valid-hash'), {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: [P2P_WORKFLOW_CAPABILITY_V1],
        helloEpoch: 1,
        sentAt: 555,
      }));
      await flushAsync();

      const target = { kind: 'main', serverId, sessionName: 'deck_late_viewer_brain' } as const;
      const coverage = {
        target,
        effectiveRole: 'viewer',
        historyCutoffAt: Date.now() - 1_000,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-late-viewer'],
        primaryShareId: 'share-late-viewer',
        authorizedAt: Date.now(),
      } as const;
      const viewer = new MockWs();
      bridge.handleShareBrowserConnection(viewer as never, 'viewer-user', makeDb('valid-hash'), {
        ticketId: 'share-ticket-late-viewer',
        target,
        snapshot: coverage,
      });
      await flushAsync();

      expect(viewer.sentStrings.some((raw) => JSON.parse(raw).type === P2P_WORKFLOW_MSG.DAEMON_HELLO)).toBe(false);
    });

    it('accepts a replacement daemon process whose hello epoch restarts while the old socket closes asynchronously', async () => {
      const bridge = WsBridge.get(serverId);
      const firstDaemon = new MockWs();
      bridge.handleDaemonConnection(firstDaemon as never, makeDb('valid-hash'), {} as never);
      firstDaemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      firstDaemon.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: ['old-capability'],
        helloEpoch: 9,
        sentAt: 900,
      }));
      await flushAsync();
      expect(bridge.getDaemonP2pWorkflowCapabilities()?.helloEpoch).toBe(9);

      // Production ws.close() is asynchronous.  Pin the replacement window in
      // which the old identity-guarded close handler cannot clear bridge state.
      vi.spyOn(firstDaemon, 'close').mockImplementation(() => {
        firstDaemon.closed = true;
        firstDaemon.readyState = 3;
      });
      const replacement = new MockWs();
      bridge.handleDaemonConnection(replacement as never, makeDb('valid-hash'), {} as never);
      replacement.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      replacement.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: ['new-capability'],
        helloEpoch: 1,
        sentAt: 1_000,
      }));
      await flushAsync();
      await flushAsync();

      expect(bridge.getDaemonP2pWorkflowCapabilities()).toMatchObject({
        daemonId: serverId,
        capabilities: ['new-capability'],
        helloEpoch: 1,
        sentAt: 1_000,
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

    it('streams the same assistant timeline updates to mobile and desktop even if only mobile has subscribed', async () => {
      const bridge = WsBridge.get(serverId);
      const db = makeDb('valid-hash');
      const daemonWs = new MockWs();
      bridge.handleDaemonConnection(daemonWs as never, db, {} as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();

      const desktop = new MockWs();
      const mobile = new MockWs();
      bridge.handleBrowserConnection(desktop as never, 'same-user', db, false);
      bridge.handleBrowserConnection(mobile as never, 'same-user', db, true);
      mobile.emit('message', JSON.stringify({
        type: 'chat.subscribe',
        sessionId: 'multi-device-stream',
        forceHistory: false,
      }));
      await flushAsync();
      desktop.sent.length = 0;
      mobile.sent.length = 0;

      for (const [seq, text, streaming] of [
        [1, 'one', true],
        [2, 'one two', true],
        [3, 'one two three', false],
      ] as const) {
        daemonWs.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.EVENT,
          event: {
            eventId: 'transport:multi-device-stream:message-1',
            sessionId: 'multi-device-stream',
            ts: 1_000,
            seq,
            epoch: 1,
            type: 'assistant.text',
            payload: { text, streaming },
          },
        }));
      }
      await flushAsync();

      for (const browser of [mobile, desktop]) {
        const updates = browser.sentStrings
          .map((raw) => JSON.parse(raw))
          .filter((msg) => msg.type === TIMELINE_MESSAGES.EVENT)
          .map((msg) => msg.event.payload);
        expect(updates).toEqual([
          { text: 'one', streaming: true },
          { text: 'one two', streaming: true },
          { text: 'one two three', streaming: false },
        ]);
      }
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

    it('collapses cumulative streaming snapshots sent by an older daemon before persistence', async () => {
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
        jobId: 'job-stream',
        executionId: 'exec-stream',
        detail: ['主人开始今日任务', '主人开始今日任务执行', '主人开始今日任务执行并检查', '主人开始今日任务执行并检查结果', '主人开始今日任务执行并检查结果完成。'].join('\n'),
      }));
      await flushAsync();

      expect(execSpy).toHaveBeenCalledWith(
        'UPDATE cron_executions SET detail = $1 WHERE id = $2',
        ['主人开始今日任务执行并检查结果完成。', 'exec-stream'],
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

    it('deduplicates identical in-flight history requests across browser sockets', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserA = new MockWs();
      const browserB = new MockWs();
      bridge.handleBrowserConnection(browserA as never, 'test-user', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browserB as never, 'test-user', makeDb('valid-hash'));
      const request = (requestId: string) => ({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId,
        limit: 200,
        budgetBytes: TIMELINE_HISTORY_LIMITS.MAX_BYTES,
        cursor: { epoch: 2, direction: TIMELINE_CURSOR_DIRECTIONS.OLDER, beforeTs: 10_000 },
      });
      browserA.emit('message', JSON.stringify(request('dedup-a')));
      browserB.emit('message', JSON.stringify(request('dedup-b')));
      await flushAsync();
      const outbound = daemonWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((msg) => msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST);
      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.requestId).toBe('dedup-a');

      daemonWs.emit('message', JSON.stringify({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: 'deck_sub_qwen',
        requestId: 'dedup-a',
        events: [{ eventId: 'dedup-e1', sessionId: 'deck_sub_qwen', ts: 1, type: 'assistant.text', payload: { text: 'ok' } }],
        epoch: 2,
        actualPayloadBytes: 512,
      }));
      await flushBridgeDataPlane();
      for (const [socket, requestId] of [[browserA, 'dedup-a'], [browserB, 'dedup-b']] as const) {
        const responses = socket.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>)
          .filter((msg) => msg.type === TIMELINE_MESSAGES.HISTORY);
        expect(responses).toHaveLength(1);
        expect(responses[0]?.requestId).toBe(requestId);
      }
    });

    it('relays contentFilter to the daemon and never merges a text-only window with an unfiltered one', async () => {
      const { bridge, daemonWs } = await setupAuth();
      const browserA = new MockWs();
      const browserB = new MockWs();
      bridge.handleBrowserConnection(browserA as never, 'test-user', makeDb('valid-hash'));
      bridge.handleBrowserConnection(browserB as never, 'test-user', makeDb('valid-hash'));
      const request = (requestId: string, contentFilter?: string) => ({
        type: TIMELINE_MESSAGES.HISTORY_REQUEST,
        sessionName: 'deck_sub_qwen',
        requestId,
        limit: 30,
        ...(contentFilter ? { contentFilter } : {}),
      });
      browserA.emit('message', JSON.stringify(request('peek-a', 'text')));
      browserB.emit('message', JSON.stringify(request('window-b')));
      await flushAsync();
      const outbound = daemonWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((msg) => msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST);
      // Same session/limit/bounds, different content: two daemon reads, and the filter reached the daemon.
      expect(outbound).toHaveLength(2);
      expect(outbound.find((msg) => msg.requestId === 'peek-a')?.contentFilter).toBe('text');
      expect(outbound.find((msg) => msg.requestId === 'window-b')?.contentFilter).toBeUndefined();

      // Identical peeks (same filter and bounds) still join the read already in flight instead of adding more.
      browserA.emit('message', JSON.stringify(request('peek-c', 'text')));
      browserB.emit('message', JSON.stringify(request('peek-d', 'text')));
      await flushAsync();
      const after = daemonWs.sentStrings
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((msg) => msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST);
      expect(after).toHaveLength(2);
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
          limit: 50,
        }));
        browserQueueFull.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY_REQUEST,
          sessionName: 'deck_sub_qwen',
          requestId: 'queue-full',
          limit: 51,
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

    it('rejects queued history by byte budget and releases bytes when a socket closes', async () => {
      const resetQueueConfig = __setTimelineDataPlaneQueueConfigForTests({
        queueCap: 10,
        maxBytes: 100,
        socketMaxBytes: 100,
        userMaxBytes: 100,
      });
      try {
        const { bridge, daemonWs } = await setupAuth();
        const slowBrowser = new SlowMockWs();
        const queuedBrowser = new MockWs();
        bridge.handleBrowserConnection(slowBrowser as never, 'test-user', makeDb('valid-hash'));
        bridge.handleBrowserConnection(queuedBrowser as never, 'other-user', makeDb('valid-hash'));
        slowBrowser.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY_REQUEST,
          sessionName: 'deck_sub_qwen',
          requestId: 'bytes-first',
          limit: 100,
        }));
        await flushAsync();
        daemonWs.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY,
          sessionName: 'deck_sub_qwen',
          requestId: 'bytes-first',
          events: [{ eventId: 'bytes-first-e1', sessionId: 'deck_sub_qwen', ts: 1, type: 'assistant.text', payload: { text: 'hold' } }],
          epoch: 1,
          actualPayloadBytes: 80,
        }));
        await flushOneBridgeDataPlaneTurn();

        queuedBrowser.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY_REQUEST,
          sessionName: 'deck_sub_qwen',
          requestId: 'bytes-second',
          limit: 101,
        }));
        await flushAsync();
        daemonWs.emit('message', JSON.stringify({
          type: TIMELINE_MESSAGES.HISTORY,
          sessionName: 'deck_sub_qwen',
          requestId: 'bytes-second',
          events: [{ eventId: 'bytes-second-e1', sessionId: 'deck_sub_qwen', ts: 2, type: 'assistant.text', payload: { text: 'reject' } }],
          epoch: 1,
          actualPayloadBytes: 80,
        }));
        await flushAsync();
        expect(queuedBrowser.sentStrings.map((raw) => JSON.parse(raw) as Record<string, unknown>)).toContainEqual(expect.objectContaining({
          requestId: 'bytes-second',
          status: TIMELINE_RESPONSE_STATUS.ERROR,
          errorReason: TIMELINE_REQUEST_ERROR_REASONS.QUEUE_FULL,
        }));

        slowBrowser.close();
        await flushAsync();
        expect(getCounter('ws_bridge_timeline_data_plane_canceled', {
          type: TIMELINE_MESSAGES.HISTORY,
          route: 'browser_request',
        })).toBeGreaterThan(0);
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

    it('wires direct-file signaling through generation-bound daemon and browser unicast routes', async () => {
      const bridge = WsBridge.get(serverId);
      const daemonWs = new MockWs();
      const browserA = new MockWs();
      const browserB = new MockWs();
      const db = makeDb('valid-hash');
      bridge.handleDaemonConnection(daemonWs as never, db, { JWT_SIGNING_KEY: 'test-direct-file-resume-signing-key' } as never);
      daemonWs.emit('message', JSON.stringify({ type: 'auth', serverId, token: 't' }));
      await flushAsync();
      daemonWs.emit('message', JSON.stringify({
        type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
        daemonId: serverId,
        capabilities: [...DIRECT_FILE_TRANSFER_REQUIRED_CAPABILITIES],
        helloEpoch: 1,
        sentAt: Date.now(),
      }));
      await flushAsync();
      bridge.handleBrowserConnection(browserA as never, 'user-a', db);
      bridge.handleBrowserConnection(browserB as never, 'user-b', db);
      browserA.sent.length = 0;
      browserB.sent.length = 0;
      daemonWs.sent.length = 0;

      const requestId = '123e4567-e89b-12d3-a456-426614174000';
      const clientUploadId = '123e4567-e89b-12d3-a456-426614174001';
      const browserTabId = 'browser-tab-a1';
      browserA.emit('message', JSON.stringify({
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_INIT,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        requestId,
        serverId,
        browserTabId,
      }));
      await flushAsync();
      const leasePrepare = daemonWs.sentStrings.map((row) => JSON.parse(row)).find((row) => row.type === DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE);
      expect(leasePrepare).toMatchObject({ requestId, serverId, browserTabId });
      expect(browserA.sentStrings.some((row) => row.includes(DIRECT_FILE_TRANSFER_MSG.LEASE_READY))).toBe(false);

      daemonWs.emit('message', JSON.stringify({
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        requestId,
        serverId,
        browserTabId,
        leaseId: leasePrepare.leaseId,
        leaseGeneration: leasePrepare.leaseGeneration,
        daemonGeneration: leasePrepare.daemonGeneration,
      }));
      await flushAsync();
      const ready = browserA.sentStrings.map((row) => JSON.parse(row)).find((row) => row.type === DIRECT_FILE_TRANSFER_MSG.LEASE_READY);
      expect(ready).toMatchObject({ requestId, serverId, leaseId: leasePrepare.leaseId });

      browserA.emit('message', JSON.stringify({
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        requestId: '123e4567-e89b-12d3-a456-426614174003',
        serverId,
        browserTabId,
        leaseId: ready.leaseId,
        leaseGeneration: ready.leaseGeneration,
        daemonGeneration: ready.daemonGeneration,
        sdp: 'browser-offer',
      }));
      await flushAsync();
      expect(daemonWs.sentStrings.some((row) => row.includes('browser-offer'))).toBe(true);
      daemonWs.emit('message', JSON.stringify({
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        requestId: '123e4567-e89b-12d3-a456-426614174004',
        serverId,
        browserTabId,
        leaseId: ready.leaseId,
        leaseGeneration: ready.leaseGeneration,
        daemonGeneration: ready.daemonGeneration,
        sdp: 'daemon-answer',
      }));
      await flushAsync();
      expect(browserA.sentStrings.some((row) => row.includes('daemon-answer'))).toBe(true);
      expect(browserB.sentStrings.some((row) => row.includes('daemon-answer'))).toBe(false);

      browserA.emit('message', JSON.stringify({
        type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        serverId,
        browserTabId,
        leaseId: ready.leaseId,
        leaseGeneration: ready.leaseGeneration,
        daemonGeneration: ready.daemonGeneration,
        requestId: '123e4567-e89b-12d3-a456-426614174005',
        attemptId: '123e4567-e89b-12d3-a456-426614174006',
        attempt: 1,
        direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
        operationId: clientUploadId,
        clientUploadId,
        filename: 'large.bin',
        size: 5 * 1024 * 1024 * 1024,
      }));
      await flushAsync();
      const prepare = daemonWs.sentStrings.map((row) => JSON.parse(row)).find((row) => row.type === DIRECT_FILE_TRANSFER_MSG.PREPARE);
      const authorized = browserA.sentStrings.map((row) => JSON.parse(row)).find((row) => row.type === DIRECT_FILE_TRANSFER_MSG.AUTHORIZED);
      expect(prepare).toMatchObject({ clientUploadId, size: 5 * 1024 * 1024 * 1024 });
      expect(authorized).toMatchObject({ clientUploadId });
    });
  });
});
