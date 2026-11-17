/**
 * E2E simulation of shared-host authority propagation, fail-closed mixing isolation,
 * multi-participant isolation, and clean idle recovery across:
 *   - Real server JWT signing & admission: issueOwnerMachineAuthorityForSession,
 *     issueSharedMachineAuthorityForSession, resolveSharedMachineAuthority,
 *     admitMachineAction (server/src/share/shared-machine-authority.ts),
 *     resolveDaemonCallerAuthority (server/src/security/daemon-scope.ts)
 *   - Real daemon HTTP hook server: /shared-machine-authority (src/daemon/hook-server.ts)
 *   - Real TransportSessionRuntime, session-dispatch, delegation_reply ingress/store,
 *     task-pairs (create, dispatch, READY_FOR_AUDIT, REWORK, PASS, update, pause,
 *     resume, next_round, decision), cron-executor, and lifecycle Codex watchdog.
 *
 * Only underlying provider I/O and the Postgres SQL client are backed by in-memory/temp fixtures;
 * ZERO permission checks or security gates are stubbed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type http from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-shared-host-e2e-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return { home, previousHome };
});

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  runtimes: new Map<string, unknown>(),
}));

vi.mock('../../src/store/session-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/store/session-store.js')>();
  return {
    ...orig,
    getSession: (name: string) => mocks.sessions.get(name) as never,
    listSessions: () => [...mocks.sessions.values()] as never,
    upsertSession: (rec: Record<string, unknown>) => {
      if (typeof rec.name === 'string') mocks.sessions.set(rec.name, rec);
    },
  };
});

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: (name: string) => mocks.runtimes.get(name) as never,
  getSessionRuntime: () => undefined,
  ensureTransportRuntimeAvailable: async (name: string) => mocks.runtimes.get(name) as never,
  ensureTransportRuntimeForPendingResend: async (name: string) => mocks.runtimes.get(name) as never,
  drainTransportResendQueueForDispatch: async (sessionName: string) => {
    const runtime = mocks.runtimes.get(sessionName) as TransportSessionRuntime | undefined;
    if (!runtime?.providerSessionId) return;
    const { drainResend, RESEND_DISPATCH_CONTROL } = await import('../../src/daemon/transport-resend-queue.js');
    const { resolveTransportQueueEntryAdmission } = await import('../../src/daemon/delegation-reply-task-liveness.js');
    const { deliverTransportResendEntry } = await import('../../src/agent/transport-resend-delivery.js');
    await drainResend(
      sessionName,
      async (entry, ownership) => {
        const admission = resolveTransportQueueEntryAdmission(sessionName, entry);
        if (admission === 'stale') return RESEND_DISPATCH_CONTROL.STALE;
        if (admission === 'retry') return RESEND_DISPATCH_CONTROL.RETRY;
        return await deliverTransportResendEntry(runtime, entry, ownership);
      },
      undefined,
      undefined,
      undefined,
      runtime.recipientIdentity ?? null,
    );
  },
  launchSession: vi.fn().mockResolvedValue(undefined),
  launchTransportSession: vi.fn().mockResolvedValue(undefined),
  stopTransportRuntimeSession: vi.fn().mockResolvedValue(undefined),
  restartSession: vi.fn().mockResolvedValue(true),
  respawnSession: vi.fn().mockResolvedValue(undefined),
  persistSessionRecord: vi.fn(),
  persistSessionRecordAwaited: vi.fn().mockResolvedValue(undefined),
  stopProject: vi.fn().mockResolvedValue(undefined),
  restoreFromStore: vi.fn().mockResolvedValue(undefined),
  setSessionEventCallback: vi.fn(),
  setSessionPersistCallback: vi.fn(),
  setTransportSessionRestoredCallback: vi.fn(),
  initOnStartup: vi.fn().mockResolvedValue(undefined),
  rebuildProviderRoutes: vi.fn(),
  unregisterProviderRoute: vi.fn(),
  resyncTransportSessionStatesAfterLinkRestore: vi.fn().mockResolvedValue(undefined),
  resolveSessionName: (name: string) => name,
  isEphemeralProviderSid: () => false,
  markEphemeralProviderSid: vi.fn(),
  unmarkEphemeralProviderSid: vi.fn(),
  getDriver: vi.fn(),
  collectTransportQueueDiagnostics: vi.fn(() => ({})),
  applyEffectiveSessionIdentity: vi.fn().mockResolvedValue(undefined),
  isProviderSessionBound: (name: string) => Boolean((mocks.runtimes.get(name) as { providerSessionId?: string } | undefined)?.providerSessionId),
  relaunchSessionWithSettings: vi.fn().mockResolvedValue(undefined),
}));

import type { Context } from 'hono';
import type { Database } from '../../server/src/db/client.js';
import type { Env } from '../../server/src/env.js';
import {
  admitMachineAction,
  issueOwnerMachineAuthorityForSession,
  issueSharedMachineAuthorityForSession,
  resolveSharedMachineAuthority,
} from '../../server/src/share/shared-machine-authority.js';
import { resolveDaemonCallerAuthority } from '../../server/src/security/daemon-scope.js';
import { MACHINE_ACTION, type MachineAction } from '../../shared/machine-access-policy.js';
import { CHAT_MESSAGE_ORIGINS } from '../../shared/chat-message-origin.js';
import { AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES } from '../../shared/agent-delegation.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { SHARED_MACHINE_AUTHORITY_HEADER, SHARED_MACHINE_AUTHORITY_HOOK_PATH } from '../../shared/shared-machine-authority.js';
import { TASK_PAIR_ENGINE_ENV } from '../../shared/task-pair.js';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';
import type { SharedActorEnvelope } from '../../shared/shared-context-types.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import type {
  AgentMessage,
  MessageDelta,
  ProviderError,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  ToolCallEvent,
  TransportProvider,
} from '../../src/agent/transport-provider.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { startHookServer } from '../../src/daemon/hook-server.js';
import {
  dispatchDelegatedSessionSend,
  dispatchSessionMessage,
} from '../../src/daemon/session-dispatch.js';
import {
  clearDelegationReplyIngressForTests,
  submitDelegationReply,
} from '../../src/daemon/delegation-reply-ingress.js';
import { getDelegationReplyStore, resetDelegationReplyStoreForTests } from '../../src/daemon/delegation-reply-store.js';
import { executeCronJob } from '../../src/daemon/cron-executor.js';
import { recoverCodexStalledSession } from '../../src/daemon/lifecycle.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { clearSendIdempotencyCacheForTests, dispatchSendMessage } from '../../src/daemon/send-tool.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../src/daemon/task-pairs/scheduler.js';
import { resetSupervisionTaskRegistryForTests } from '../../src/daemon/supervision-state-store.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

const JWT_KEY = 'e2e-shared-host-jwt-signing-secret-32b!';
const OWNER = 'usr_owner';
const PART_A = 'usr_part_a';
const PART_B = 'usr_part_b';

const SOURCE_SERVER = 'srv_shared_host';
const OWNER_NODE = 'srv_owner_node';
const PART_A_NODE = 'srv_part_a_node';

const PROJECT = 'e2eauth';
const BRAIN = 'deck_e2eauth_brain';
const WORKER = 'deck_sub_worker1';
const EXEC = 'deck_sub_exec1';
const AUD = 'deck_sub_aud1';

interface MockProviderHarness {
  provider: TransportProvider;
  sends: Array<{ sid: string; text: string }>;
  notifyCalls: unknown[];
  setBusy: (busy: boolean) => void;
  setActiveDelegationMode: (mode: 'native' | 'unsupported') => void;
  fireComplete: (text?: string) => void;
  fireStatus: (status: ProviderStatusUpdate) => void;
}

function makeProvider(providerSessionId: string): MockProviderHarness {
  let completeCb: ((sid: string, msg: AgentMessage) => void) | null = null;
  let deltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
  let errorCb: ((sid: string, e: ProviderError) => void) | null = null;
  let statusCb: ((sid: string, s: ProviderStatusUpdate) => void) | null = null;
  let usageCb: ((sid: string, u: ProviderUsageUpdate) => void) | null = null;
  let toolCb: ((sid: string, t: ToolCallEvent) => void) | null = null;
  let busy = false;
  const sends: Array<{ sid: string; text: string }> = [];
  const notifyCalls: unknown[] = [];

  const capabilities: Record<string, unknown> = {
    streaming: true,
    toolCalling: false,
    approval: false,
    sessionRestore: false,
    multiTurn: true,
    attachments: false,
    contextSupport: 'full-normalized-context-injection',
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
  };

  const provider = {
    id: `mock-${providerSessionId}`,
    connectionMode: 'persistent',
    sessionOwnership: 'provider',
    capabilities,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(providerSessionId),
    endSession: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (sid: string, payload: unknown) => {
      const userMessage = typeof payload === 'string'
        ? payload
        : String((payload as { userMessage?: string }).userMessage ?? '');
      sends.push({ sid, text: userMessage });
    }),
    cancel: vi.fn(async () => { busy = false; }),
    cancelAndWait: vi.fn(async () => { busy = false; }),
    notifyActiveDelegation: vi.fn(async (_sid: string, notif: unknown) => {
      notifyCalls.push(notif);
      return 'delivered';
    }),
    getActiveWorkSnapshot: vi.fn(() => (
      busy
        ? { status: 'current', activeWorkCount: 1, activeToolCount: 1, busyReasons: ['provider_tool_item'], updatedAt: Date.now() }
        : { status: 'current', activeWorkCount: 0, activeToolCount: 0, busyReasons: [], updatedAt: Date.now() }
    )),
    onDelta: (cb: (sid: string, d: MessageDelta) => void) => { deltaCb = cb; return () => { deltaCb = null; }; },
    onComplete: (cb: (sid: string, msg: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = null; }; },
    onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = null; }; },
    onApprovalRequest: () => () => {},
    onStatus: (cb: (sid: string, s: ProviderStatusUpdate) => void) => { statusCb = cb; return () => { statusCb = null; }; },
    onUsage: (cb: (sid: string, u: ProviderUsageUpdate) => void) => { usageCb = cb; return () => { usageCb = null; }; },
    onToolCall: (cb: (sid: string, t: ToolCallEvent) => void) => { toolCb = cb; return () => { toolCb = null; }; },
    respondApproval: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;

  void deltaCb; void errorCb; void usageCb; void toolCb;

  return {
    provider,
    sends,
    notifyCalls,
    setBusy: (next: boolean) => { busy = next; },
    setActiveDelegationMode: (mode) => {
      capabilities.activeDelegationNotification = mode;
    },
    fireComplete: (text = 'done') => {
      busy = false;
      completeCb?.(providerSessionId, {
        id: `msg-${Math.random().toString(16).slice(2, 8)}`,
        sessionId: providerSessionId,
        kind: 'text',
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        status: 'complete',
      });
    },
    fireStatus: (status) => { statusCb?.(providerSessionId, status); },
  };
}

/**
 * In-memory relational server DB faithfully answering SQL from:
 *   - server/src/share/shared-machine-authority.ts
 *   - server/src/security/server-share-boundary.ts
 *   - server/src/db/tab-sharing.ts
 *   - server/src/share/machine-access.ts
 *   - server/src/security/user-status.ts
 */
function createServerDb(): Database {
  const activeUsers = new Set([OWNER, PART_A, PART_B]);
  const servers = new Map([
    [SOURCE_SERVER, { id: SOURCE_SERVER, user_id: OWNER, node_id: null as string | null, node_role: 'full', exec_enabled: true }],
    [OWNER_NODE, { id: OWNER_NODE, user_id: OWNER, node_id: '1000000001', node_role: 'controlled', exec_enabled: true }],
    [PART_A_NODE, { id: PART_A_NODE, user_id: PART_A, node_id: '1000000002', node_role: 'controlled', exec_enabled: true }],
  ]);
  const sessionShares = [
    { id: 'sh_part_a_brain', server_id: SOURCE_SERVER, session_name: BRAIN, target_user_id: PART_A, role: 'participant', created_by: OWNER, created_at: 1, updated_at: 1, expires_at: null, revoked_at: null },
    { id: 'sh_part_b_brain', server_id: SOURCE_SERVER, session_name: BRAIN, target_user_id: PART_B, role: 'participant', created_by: OWNER, created_at: 1, updated_at: 1, expires_at: null, revoked_at: null },
  ];
  const subSessions = new Map([
    ['worker1', { id: 'worker1', server_id: SOURCE_SERVER, parent_session: BRAIN }],
    ['exec1', { id: 'exec1', server_id: SOURCE_SERVER, parent_session: BRAIN }],
    ['aud1', { id: 'aud1', server_id: SOURCE_SERVER, parent_session: BRAIN }],
  ]);

  return {
    queryOne: async <T>(sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT user_id FROM servers WHERE id = $1')) {
        const s = servers.get(String(params[0] ?? ''));
        return (s ? { user_id: s.user_id } : null) as T | null;
      }
      if (sql.includes('SELECT status FROM users WHERE id = $1')) {
        return (activeUsers.has(String(params[0] ?? '')) ? { status: 'active' } : null) as T | null;
      }
      if (sql.includes('actor_status') && sql.includes('owner_status')) {
        const actor = String(params[0] ?? '');
        const srv = servers.get(String(params[1] ?? ''));
        return {
          actor_status: activeUsers.has(actor) ? 'active' : null,
          owner_status: srv && activeUsers.has(srv.user_id) ? 'active' : null,
        } as T;
      }
      if (sql.includes('FROM sub_sessions ss') && sql.includes('JOIN sessions s')) {
        const sid = String(params[0] ?? '');
        const subId = String(params[1] ?? '');
        const sub = subSessions.get(subId);
        return (sub && sub.server_id === sid ? { project_name: PROJECT, parent_session: sub.parent_session } : null) as T | null;
      }
      if (sql.includes('SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2')) {
        return (String(params[0] ?? '') === SOURCE_SERVER && String(params[1] ?? '') === BRAIN
          ? { project_name: PROJECT }
          : null) as T | null;
      }
      if (sql.includes('SELECT EXISTS (SELECT 1 FROM servers WHERE id = $1) AS exists')) {
        return { exists: servers.has(String(params[0] ?? '')) } as T;
      }
      if (sql.includes('SELECT EXISTS (SELECT 1 FROM sessions WHERE server_id = $1 AND name = $2) AS exists')) {
        return { exists: String(params[0] ?? '') === SOURCE_SERVER && String(params[1] ?? '') === BRAIN } as T;
      }
      if (sql.includes('SELECT EXISTS (SELECT 1 FROM sub_sessions WHERE server_id = $1 AND id = $2')) {
        return { exists: subSessions.has(String(params[1] ?? '')) } as T;
      }
      if (sql.includes('access_role') && sql.includes('FROM servers s')) {
        const actorUserId = String(params[0] ?? '');
        const targetServerId = String(params[2] ?? '');
        const s = servers.get(targetServerId);
        if (!s || !activeUsers.has(actorUserId) || !activeUsers.has(s.user_id)) return null;
        if (s.user_id === actorUserId) {
          return {
            id: s.id,
            node_id: s.node_id,
            user_id: s.user_id,
            ref_name: null,
            display_name: s.id,
            status: 'online',
            node_role: s.node_role,
            host_server_id: SOURCE_SERVER,
            last_heartbeat_at: Date.now(),
            exec_enabled: s.exec_enabled,
            os: 'linux',
            daemon_version: '1.0.0',
            revoked_at: null,
            auto_unlock_configured: false,
            controlled_capabilities: null,
            controlled_upgrade_status: null,
            controlled_upgrade_target_version: null,
            controlled_upgrade_reason: null,
            controlled_worker_refresh_attempt_id: null,
            controlled_worker_refresh_phase: null,
            controlled_worker_refresh_installed_version: null,
            controlled_worker_refresh_target_version: null,
            controlled_worker_refresh_artifact_sha256: null,
            controlled_worker_refresh_reason: null,
            controlled_worker_refresh_recorded_at: null,
            remote_desktop_host_id: null,
            team_ids: [],
            team_names: [],
            access_role: 'owner',
            access_source: 'owner',
            exec_granted: false,
            can_rename: true,
            access_expires_at: null,
          } as T;
        }
        return null;
      }
      return null;
    },
    query: async <T>(sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM server_shares ss') && sql.includes('AS shared')) {
        return [{ shared: false }] as T[];
      }
      if (sql.includes('FROM server_shares') && sql.includes('EXISTS') && sql.includes('AS shared')) {
        const sid = String(params[0] ?? '');
        return [{ shared: sessionShares.some((row) => row.server_id === sid && row.revoked_at === null) }] as T[];
      }
      if (sql.includes("'main' AS target_kind") && sql.includes('FROM session_shares')) {
        const userId = String(params[1] ?? '');
        const serverId = String(params[2] ?? '');
        const sessionName = String(params[3] ?? '');
        return sessionShares.filter(
          (row) => row.target_user_id === userId && row.server_id === serverId && row.session_name === sessionName && row.revoked_at === null,
        ).map((row) => ({ target_kind: 'main', ...row })) as T[];
      }
      return [] as T[];
    },
    execute: async () => ({ changes: 1 }),
  } as unknown as Database;
}

function makeParticipantEnvelope(
  actorUserId: string,
  displayName: string,
  actionId: string,
): SharedActorEnvelope {
  return {
    actorUserId,
    actorDisplayName: displayName,
    effectiveActorRole: 'participant',
    origin: 'shared-tab',
    actionId,
    primaryShareId: `sh_${actorUserId}`,
    authorizedAt: 1000,
    queuedAt: 1001,
    snapshot: {
      target: { kind: 'main', serverId: SOURCE_SERVER, sessionName: BRAIN },
      effectiveRole: 'participant',
      historyCutoffAt: 0,
      authorizedAt: 1000,
      primaryShareId: `sh_${actorUserId}`,
      coveringShareIds: [`sh_${actorUserId}`],
      expiresAt: null,
      nextCoverageRecheckAt: null,
    },
  };
}

function makeServerCallerContext(db: Database, authorityHeader: string | undefined): Context<{ Bindings: Env; Variables: Record<string, unknown> }> {
  const vars: Record<string, unknown> = {
    userId: OWNER,
    authServerId: SOURCE_SERVER,
  };
  return {
    env: { DB: db, JWT_SIGNING_KEY: JWT_KEY } as unknown as Env,
    get: (key: string) => vars[key],
    req: {
      header: (name: string) => (name.toLowerCase() === SHARED_MACHINE_AUTHORITY_HEADER.toLowerCase() ? authorityHeader : undefined),
    },
  } as unknown as Context<{ Bindings: Env; Variables: Record<string, unknown> }>;
}

async function settle(waitMs = 15): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('E2E shared-host multi-user / multi-session authority isolation & preservation', () => {
  let root: string;
  let db: Database;
  let hookServer: http.Server;
  let hookPort: number;
  let automation: TaskPairAutomation;
  let runCounter = 0;
  const previousEngine = process.env[TASK_PAIR_ENGINE_ENV];

  let brainProv: MockProviderHarness;
  let workerProv: MockProviderHarness;
  let execProv: MockProviderHarness;
  let audProv: MockProviderHarness;

  let brainRt: TransportSessionRuntime;
  let workerRt: TransportSessionRuntime;
  let execRt: TransportSessionRuntime;
  let audRt: TransportSessionRuntime;

  function makeSessionRecord(name: string, role: SessionRecord['role']): SessionRecord {
    return {
      name,
      sessionInstanceId: `inst-${name}`,
      runtimeEpoch: `epoch-${name}`,
      projectName: PROJECT,
      role,
      agentType: role === 'w1' ? 'codex-sdk' : 'claude-code-sdk',
      projectDir: join(root, 'repo'),
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 2,
      requestedModel: 'claude-sonnet-4-6',
      activeModel: 'claude-sonnet-4-6',
      runtimeType: 'transport',
      ...(role === 'brain'
        ? {
            transportConfig: {
              supervision: normalizeSessionSupervisionSnapshot({
                mode: SUPERVISION_MODE.OFF,
                executionPools: {
                  state: 'configured',
                  economyTaskPool: { configs: [], controls: { leaseMs: 900000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
                  primaryDevelopmentPool: {
                    configs: [
                      { model: 'claude-sonnet-4-6', agentType: 'claude-code-sdk', runtimeType: 'transport', capabilityId: 'supervision-exec-v1:transport:claude-code-sdk:anthropic:claude-sonnet-4-6', providerFamily: 'anthropic', role: 'both' },
                    ],
                    controls: { leaseMs: 1800000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 },
                  },
                },
              }),
            },
          }
        : { parentSession: BRAIN, userCreated: true, label: name }),
    } as SessionRecord;
  }

  async function fetchHookAuthority(sessionName: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const sess = mocks.sessions.get(sessionName)!;
    const res = await fetch(`http://127.0.0.1:${hookPort}${SHARED_MACHINE_AUTHORITY_HOOK_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-imcodes-session': sessionName,
      },
      body: JSON.stringify({
        sessionInstanceId: sess.sessionInstanceId,
        runtimeEpoch: sess.runtimeEpoch,
      }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  async function checkServerGate(
    sessionName: string,
    targetServerId = OWNER_NODE,
    action: MachineAction = MACHINE_ACTION.EXEC,
  ) {
    const hook = await fetchHookAuthority(sessionName);
    const token = typeof hook.body.authority === 'string' ? hook.body.authority : undefined;
    const admission = await admitMachineAction(db, {
      token,
      signingKey: JWT_KEY,
      authenticatedSourceServerId: SOURCE_SERVER,
      sourceOwnerUserId: OWNER,
      targetServerId,
      action,
      now: Date.now(),
    });
    const resolved = await resolveSharedMachineAuthority(db, {
      token,
      signingKey: JWT_KEY,
      authenticatedSourceServerId: SOURCE_SERVER,
      sourceOwnerUserId: OWNER,
      now: Date.now(),
    });
    const cronGate = await resolveDaemonCallerAuthority(
      makeServerCallerContext(db, token),
      { denyParticipant: true, targetServerId, allowOwnerCrossServer: true },
    );
    return { hook, admission, resolved, cronGate };
  }

  async function sayAndSettle(sessionName: string, text: string): Promise<void> {
    timelineEmitter.emit(sessionName, 'assistant.text', { text, streaming: false }, {
      source: 'daemon', confidence: 'high', eventId: `e2e-say-${Math.random().toString(16).slice(2)}`,
    });
    await settle();
  }

  beforeEach(async () => {
    process.env[TASK_PAIR_ENGINE_ENV] = 'pairs';
    root = mkdtempSync(join(tmpdir(), 'imcodes-auth-e2e-'));
    process.env.IMCODES_SUPERVISION_STATE_DB_PATH = join(root, 'supervision-state.sqlite');
    mocks.sessions.clear();
    mocks.runtimes.clear();
    resetSupervisionTaskRegistryForTests();
    resetTransportQueueStoreForTests();
    resetDelegationReplyStoreForTests();
    clearDelegationReplyIngressForTests();
    clearSendIdempotencyCacheForTests();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(new TaskPairStore(join(root, 'task-pairs.sqlite')));
    db = createServerDb();

    mocks.sessions.set(BRAIN, makeSessionRecord(BRAIN, 'brain'));
    mocks.sessions.set(WORKER, makeSessionRecord(WORKER, 'w1'));
    mocks.sessions.set(EXEC, makeSessionRecord(EXEC, 'w1'));
    mocks.sessions.set(AUD, makeSessionRecord(AUD, 'w2'));

    const runId = ++runCounter;
    brainProv = makeProvider(`prov-brain-${runId}`);
    workerProv = makeProvider(`prov-worker-${runId}`);
    execProv = makeProvider(`prov-exec-${runId}`);
    audProv = makeProvider(`prov-aud-${runId}`);

    brainRt = new TransportSessionRuntime(brainProv.provider, BRAIN, { sessionInstanceId: `inst-${BRAIN}`, runtimeEpoch: `epoch-${BRAIN}` });
    workerRt = new TransportSessionRuntime(workerProv.provider, WORKER, { sessionInstanceId: `inst-${WORKER}`, runtimeEpoch: `epoch-${WORKER}` });
    execRt = new TransportSessionRuntime(execProv.provider, EXEC, { sessionInstanceId: `inst-${EXEC}`, runtimeEpoch: `epoch-${EXEC}` });
    audRt = new TransportSessionRuntime(audProv.provider, AUD, { sessionInstanceId: `inst-${AUD}`, runtimeEpoch: `epoch-${AUD}` });

    await brainRt.initialize({ sessionKey: BRAIN, fresh: true });
    await workerRt.initialize({ sessionKey: WORKER, fresh: true });
    await execRt.initialize({ sessionKey: EXEC, fresh: true });
    await audRt.initialize({ sessionKey: AUD, fresh: true });

    mocks.runtimes.set(BRAIN, brainRt);
    mocks.runtimes.set(WORKER, workerRt);
    mocks.runtimes.set(EXEC, execRt);
    mocks.runtimes.set(AUD, audRt);

    automation = new TaskPairAutomation({
      isBusy: (s) => (mocks.runtimes.get(s) as TransportSessionRuntime | undefined)?.getStatus() !== 'idle',
      isLimited: () => false,
      importLegacy: () => undefined,
    });
    taskPairService.init();
    taskPairService.setScheduler(automation);

    const started = await startHookServer(() => {}, { authorityHome: root });
    hookServer = started.server;
    hookPort = started.port;
  });

  afterEach(async () => {
    taskPairService.setScheduler(undefined as never);
    clearDelegationReplyIngressForTests();
    resetDelegationReplyStoreForTests();
    if (hookServer) await new Promise<void>((resolve) => hookServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => {
    if (previousEngine === undefined) delete process.env[TASK_PAIR_ENGINE_ENV];
    else process.env[TASK_PAIR_ENGINE_ENV] = previousEngine;
    rmSync(env.home, { recursive: true, force: true });
  });

  it('1) Pure Owner long chain keeps server-admitted authority through cron, send_message, delegation_reply (native/FIFO/idle), autonomous turn, watchdog, and full task-pair lifecycle', async () => {
    const ownerJwtBrain = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: OWNER,
      sourceServerId: SOURCE_SERVER,
      sessionName: BRAIN,
      actionId: 'act-owner-ws-1',
      signingKey: JWT_KEY,
    });
    expect(ownerJwtBrain).toBeTruthy();

    // A. Owner WS turn starts on Brain -> real hook + server admit BOTH exec_remote & cron
    expect(await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Owner starts investigation', {
      messageOrigin: CHAT_MESSAGE_ORIGINS.USER,
      ownerMachineAuthority: ownerJwtBrain!,
    })).toBe('sent');
    await settle();
    const g1 = await checkServerGate(BRAIN);
    expect(g1.hook.status).toBe(200);
    expect(g1.resolved.kind).toBe('owner');
    expect(g1.admission.ok).toBe(true);
    expect(g1.cronGate.ok).toBe(true);

    // B. Owner delegates to Worker via dispatchDelegatedSessionSend (capturing Owner JWT)
    const deleg = await dispatchDelegatedSessionSend({
      caller: { sessionName: BRAIN, sessionInstanceId: `inst-${BRAIN}`, runtimeEpoch: `epoch-${BRAIN}` },
      targetSession: WORKER,
      message: 'Check node health',
    }, {
      listSessions: () => [...mocks.sessions.values()] as unknown as SessionRecord[],
      readTimeline: async () => [],
    });
    expect(deleg.status).toBe('accepted');
    if (deleg.status !== 'accepted') throw new Error(`deleg failed: ${JSON.stringify(deleg)}`);
    await settle();
    const gWorker = await checkServerGate(WORKER);
    expect(gWorker.admission.ok).toBe(true);
    expect(gWorker.resolved.kind).toBe('owner');

    // C1. Sub-session returns via BOTH delegation_reply AND send_message while Brain is BUSY (native activeDelegationNotification)
    expect(await dispatchSendMessage(
      { sessionName: WORKER, sessionInstanceId: `inst-${WORKER}`, runtimeEpoch: `epoch-${WORKER}` },
      { target: BRAIN, message: 'Worker send_message while Brain busy (native append)' },
      { listSessions: () => [...mocks.sessions.values()] as unknown as SessionRecord[], readTimeline: async () => [] },
    )).toMatchObject({ status: 'accepted' });
    await settle();
    expect((await checkServerGate(BRAIN)).admission.ok).toBe(true);

    const nativeSubRes = await submitDelegationReply({
      rawBody: { version: 'agent_delegation_reply_v1', delegationId: deleg.delegationId!, result: 'Native busy report' },
      senderSessionName: WORKER,
    });
    expect(nativeSubRes).toMatchObject({ ok: true });
    await settle();
    expect(getDelegationReplyStore().get(deleg.delegationId!)?.status).toBe('delivered');
    expect(brainProv.notifyCalls.length).toBeGreaterThanOrEqual(1);
    const gNativeReply = await checkServerGate(BRAIN);
    expect(gNativeReply.admission.ok).toBe(true);

    // C2. send_message (queue) & Task-bound delegation_reply while Brain is BUSY -> FIFO queued behind active turn, then drains cleanly on settle
    expect(await dispatchSendMessage(
      { sessionName: WORKER, sessionInstanceId: `inst-${WORKER}`, runtimeEpoch: `epoch-${WORKER}` },
      {
        target: BRAIN,
        message: 'Worker send_message FIFO queue behind busy turn',
        deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
      },
      { listSessions: () => [...mocks.sessions.values()] as unknown as SessionRecord[], readTimeline: async () => [] },
    )).toMatchObject({ status: 'accepted' });
    const taskDeleg = getDelegationReplyStore().create({
      origin: { sessionName: BRAIN, sessionInstanceId: `inst-${BRAIN}`, runtimeEpoch: `epoch-${BRAIN}` },
      target: { sessionName: WORKER, sessionInstanceId: `inst-${WORKER}`, runtimeEpoch: `epoch-${WORKER}` },
      dispatchId: 'disp-fifo',
      messageId: 'msg-fifo',
      taskId: 'tsk_fifo_dlg',
      assignmentId: 'asg_fifo_dlg',
      originAuthority: { kind: 'owner', ownerMachineAuthority: ownerJwtBrain! },
    });
    expect(await submitDelegationReply({
      rawBody: { version: 'agent_delegation_reply_v1', delegationId: taskDeleg.record.delegationId, result: 'FIFO busy task reply' },
      senderSessionName: WORKER,
    })).toMatchObject({ ok: true });
    await settle();
    expect(getDelegationReplyStore().get(taskDeleg.record.delegationId)?.status).toBe('delivered');
    // Finish turn 1 -> FIFO queued message drains cleanly as active turn with Owner JWT!
    brainProv.fireComplete('turn 1 complete');
    await settle();
    const gFifoDrain = await checkServerGate(BRAIN);
    expect(gFifoDrain.admission.ok).toBe(true);

    // C3. Clean settle -> idle has NO authority -> BOTH idle delegation_reply and idle send_message wake Brain with Owner JWT
    brainProv.fireComplete('fifo complete');
    await settle();
    const gIdle = await checkServerGate(BRAIN);
    expect(gIdle.hook.body.authority).toBeNull();
    expect(gIdle.admission.ok).toBe(false); // Shared host MUST deny absent header!

    const idleDeleg = getDelegationReplyStore().create({
      origin: { sessionName: BRAIN, sessionInstanceId: `inst-${BRAIN}`, runtimeEpoch: `epoch-${BRAIN}` },
      target: { sessionName: WORKER, sessionInstanceId: `inst-${WORKER}`, runtimeEpoch: `epoch-${WORKER}` },
      dispatchId: 'disp-idle',
      messageId: 'msg-idle',
      originAuthority: { kind: 'owner', ownerMachineAuthority: ownerJwtBrain! },
    });
    expect(await submitDelegationReply({
      rawBody: { version: 'agent_delegation_reply_v1', delegationId: idleDeleg.record.delegationId, result: 'Idle wake report' },
      senderSessionName: WORKER,
    })).toMatchObject({ ok: true });
    await settle();
    expect(getDelegationReplyStore().get(idleDeleg.record.delegationId)?.status).toBe('delivered');
    const gIdleWake = await checkServerGate(BRAIN);
    expect(gIdleWake.admission.ok).toBe(true);

    // Worker still holds Owner authority until it settles; send_message back to idle Brain also wakes Brain with Owner JWT
    brainProv.fireComplete('idle deleg wake complete');
    await settle();
    expect(await dispatchSendMessage(
      { sessionName: WORKER, sessionInstanceId: `inst-${WORKER}`, runtimeEpoch: `epoch-${WORKER}` },
      { target: BRAIN, message: 'Worker send_message waking idle Brain' },
      { listSessions: () => [...mocks.sessions.values()] as unknown as SessionRecord[], readTimeline: async () => [] },
    )).toMatchObject({ status: 'accepted' });
    await settle();
    expect((await checkServerGate(BRAIN)).admission.ok).toBe(true);
    workerProv.fireComplete('worker done');

    // D. Provider autonomous continuation after idle -> keeps Owner JWT during active work
    brainProv.fireComplete('idle wake complete');
    await settle();
    brainProv.setBusy(true);
    expect((await checkServerGate(BRAIN)).admission.ok).toBe(true);
    brainProv.setBusy(false);

    // E. Cron dispatch as Owner -> retains Owner JWT
    const serverLinkMock = { send: vi.fn(), sendBinary: vi.fn(), isConnected: () => true } as never;
    await executeCronJob({
      type: 'cron.dispatch',
      jobId: 'cron_owner_1',
      jobName: 'Nightly check',
      serverId: SOURCE_SERVER,
      projectName: PROJECT,
      targetRole: 'brain',
      targetSessionName: BRAIN,
      executionId: 'exec-cron-1',
      ownerMachineAuthority: ownerJwtBrain!,
      action: { type: 'command', command: 'Run health check' },
    }, serverLinkMock);
    await settle();
    expect((await checkServerGate(BRAIN)).admission.ok).toBe(true);

    // F. Stalled Codex watchdog continue -> captures Owner JWT BEFORE cancel() and preserves across continue
    (brainRt as unknown as { _lastActivityAt: number })._lastActivityAt = Date.now() - 20 * 60_000;
    const recovered = await recoverCodexStalledSession({ name: BRAIN, agentType: 'codex-sdk' });
    expect(recovered).toBe(true);
    await settle();
    expect((await checkServerGate(BRAIN)).admission.ok).toBe(true);

    // G. Full TaskPair lifecycle (Owner): create -> READY_FOR_AUDIT -> REWORK -> READY_FOR_AUDIT -> PASS -> update/pause/resume/next_round/decision
    const handlers = createMemoryMcpToolHandlers({
      userId: OWNER,
      sessionName: BRAIN,
      projectName: PROJECT,
      projectRoot: join(root, 'repo'),
      serverId: SOURCE_SERVER,
    }, { sendDeps: { listSessions: () => [...mocks.sessions.values()] as unknown as SessionRecord[] } });

    const created = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
      title: 'E2E Owner Pair',
      brief: '## Acceptance\n- [ ][ ] 1. Verify\n',
      executor: EXEC,
      auditor: AUD,
      workspace: 'dir',
      idempotencyKey: 'e2e-pair-owner-1',
    }) as { taskId: string };
    await settle();
    expect((await checkServerGate(EXEC)).admission.ok).toBe(true);
    execProv.fireComplete('implemented');
    await settle();

    await sayAndSettle(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${created.taskId} path=/tmp/dir -->`);
    expect((await checkServerGate(AUD)).admission.ok).toBe(true);
    audProv.fireComplete('rework needed');
    await settle();

    await sayAndSettle(AUD, `<!-- IMCODES_TASK REWORK ${created.taskId} blocking=P0 p0=1 -->`);
    expect((await checkServerGate(EXEC)).admission.ok).toBe(true);
    execProv.fireComplete('rework done');
    await settle();

    await sayAndSettle(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${created.taskId} path=/tmp/dir -->`);
    expect((await checkServerGate(AUD)).admission.ok).toBe(true);
    audProv.fireComplete('audit r2');
    await settle();
    await sayAndSettle(AUD, `<!-- IMCODES_TASK PASS ${created.taskId} -->`);

    // Pause, update, resume, next_round, decision request & decision
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_TASK_UPDATE]({ taskId: created.taskId, markdown: '## Updated' });
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_PAUSE]({ taskId: created.taskId, mode: 'manual', note: 'hold' });
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_RESUME]({ taskId: created.taskId });
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_DECISION_RECORD]({
      taskId: created.taskId, round: 1, kind: 'request',
      question: 'Ship?', options: [{ id: 'yes', label: 'Yes' }], conclusion: 'pending', summary: 'Need confirm',
    });
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_DECISION_RECORD]({
      taskId: created.taskId, round: 1, kind: 'decision',
      selectedOptionId: 'yes', conclusion: 'yes', summary: 'Approved',
    });
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]({ taskId: created.taskId, note: 'Round 2' });
    await settle();
    expect(getTaskPairStore().getPair(PROJECT, created.taskId)?.authority?.kind).toBe('owner');
    expect((await checkServerGate(EXEC)).admission.ok).toBe(true);
  });

  it('2) Multi-user mixing / Participant taint fails closed across delegation, late Owner delegation_reply, autonomous turn, watchdog continue, and task-pairs; Multi-Participant A+B becomes AMBIGUOUS and recovers only on clean idle + new Owner turn', async () => {
    const ownerJwt = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: OWNER, sourceServerId: SOURCE_SERVER, sessionName: BRAIN, actionId: 'act-own', signingKey: JWT_KEY,
    });
    const partAJwt = await issueSharedMachineAuthorityForSession(db, {
      actorUserId: PART_A,
      sourceServerId: SOURCE_SERVER,
      sessionName: BRAIN,
      shareTarget: { kind: 'main', serverId: SOURCE_SERVER, sessionName: BRAIN },
      actionId: 'act-pa',
      signingKey: JWT_KEY,
    });
    const partBJwt = await issueSharedMachineAuthorityForSession(db, {
      actorUserId: PART_B,
      sourceServerId: SOURCE_SERVER,
      sessionName: BRAIN,
      shareTarget: { kind: 'main', serverId: SOURCE_SERVER, sessionName: BRAIN },
      actionId: 'act-pb',
      signingKey: JWT_KEY,
    });
    expect(partAJwt).toBeTruthy();
    expect(partBJwt).toBeTruthy();

    // Start clean Owner turn
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Owner turn', {
      messageOrigin: CHAT_MESSAGE_ORIGINS.USER,
      ownerMachineAuthority: ownerJwt!,
    });
    await settle();
    expect((await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC)).admission.ok).toBe(true);

    // Unprivileged/unstamped non-system message injected into active Owner turn MUST fail closed!
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Unstamped external message', {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      messageOrigin: CHAT_MESSAGE_ORIGINS.USER,
    });
    await settle();
    const unstampedCheck = await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC);
    expect(unstampedCheck.hook.body.authority).toBeNull();
    expect(unstampedCheck.admission.ok).toBe(false);
    expect(unstampedCheck.cronGate.ok).toBe(false);

    // Restart clean Owner turn, then Participant A injects into active Owner turn -> mixed turn fails closed (403, refuses BOTH nodes)!
    brainProv.fireComplete('reset unstamped');
    await settle();
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Owner turn 2', {
      messageOrigin: CHAT_MESSAGE_ORIGINS.USER,
      ownerMachineAuthority: ownerJwt!,
    });
    await settle();
    expect((await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC)).admission.ok).toBe(true);

    const partA = makeParticipantEnvelope(PART_A, 'Alice', 'act-pa');
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Participant A question', {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      sharedActor: partA,
      sharedMachineAuthority: partAJwt!,
    });
    await settle();

    // Mixed Owner + Participant A turn: hook fails closed (403 shared_machine_authority_unavailable), NEVER exposes Owner JWT!
    const mixedCheckOwner = await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC);
    const mixedCheckPartA = await checkServerGate(BRAIN, PART_A_NODE, MACHINE_ACTION.EXEC);
    expect(mixedCheckOwner.hook.status).toBe(403);
    expect(mixedCheckOwner.hook.body.error).toBe('shared_machine_authority_unavailable');
    expect(mixedCheckOwner.admission.ok).toBe(false);
    expect(mixedCheckOwner.cronGate.ok).toBe(false);
    expect(mixedCheckPartA.admission.ok).toBe(false);

    // Late Owner delegation_reply arriving inside mixed/tainted Brain turn MUST NOT escalate back to Owner!
    const lateOwnerDelegMixed = getDelegationReplyStore().create({
      origin: { sessionName: BRAIN, sessionInstanceId: `inst-${BRAIN}`, runtimeEpoch: `epoch-${BRAIN}` },
      target: { sessionName: WORKER, sessionInstanceId: `inst-${WORKER}`, runtimeEpoch: `epoch-${WORKER}` },
      dispatchId: 'disp-late-owner-mixed',
      messageId: 'msg-late-owner-mixed',
      originAuthority: { kind: 'owner', ownerMachineAuthority: ownerJwt! },
    });
    await submitDelegationReply({
      rawBody: { version: 'agent_delegation_reply_v1', delegationId: lateOwnerDelegMixed.record.delegationId, result: 'Late owner completion' },
      senderSessionName: WORKER,
    });
    expect((await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC)).admission.ok).toBe(false);

    // Pure Participant A turn: hook requires PART_A JWT (OWNER_NODE & cron denied; only PART_A's own node admits PART_A)
    brainProv.fireComplete('mixed settled');
    await settle();
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Pure Participant A turn', {
      sharedActor: partA,
      sharedMachineAuthority: partAJwt!,
    });
    await settle();

    const taintedCheck = await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC);
    expect(taintedCheck.hook.status).toBe(200);
    expect(taintedCheck.hook.body.required).toBe(true);
    expect(taintedCheck.resolved.kind).toBe('participant');
    expect(taintedCheck.admission.ok).toBe(false); // Participant A does NOT have access to OWNER_NODE!
    expect(taintedCheck.cronGate.ok).toBe(false); // denyParticipant -> 403!
    const partAOwnNodeCheck = await checkServerGate(BRAIN, PART_A_NODE, MACHINE_ACTION.EXEC);
    expect(partAOwnNodeCheck.resolved.kind).toBe('participant');
    expect((partAOwnNodeCheck.resolved as { actorUserId?: string }).actorUserId).toBe(PART_A);

    // Late Owner delegation_reply arriving inside pure Participant A turn MUST NOT escalate back to Owner
    // (fails closed with 403 shared_machine_authority_unavailable, denying BOTH OWNER_NODE & PART_A_NODE)!
    const lateOwnerDeleg = getDelegationReplyStore().create({
      origin: { sessionName: BRAIN, sessionInstanceId: `inst-${BRAIN}`, runtimeEpoch: `epoch-${BRAIN}` },
      target: { sessionName: WORKER, sessionInstanceId: `inst-${WORKER}`, runtimeEpoch: `epoch-${WORKER}` },
      dispatchId: 'disp-late-owner',
      messageId: 'msg-late-owner',
      originAuthority: { kind: 'owner', ownerMachineAuthority: ownerJwt! },
    });
    await submitDelegationReply({
      rawBody: { version: 'agent_delegation_reply_v1', delegationId: lateOwnerDeleg.record.delegationId, result: 'Late owner completion' },
      senderSessionName: WORKER,
    });
    await settle();
    const afterLateOwner = await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC);
    expect(afterLateOwner.hook.status).toBe(403);
    expect(afterLateOwner.hook.body.error).toBe('shared_machine_authority_unavailable');
    expect(afterLateOwner.admission.ok).toBe(false);
    expect((await checkServerGate(BRAIN, PART_A_NODE, MACHINE_ACTION.EXEC)).admission.ok).toBe(false);

    // Start a fresh pure Participant A turn to verify downstream delegation & PAIR_CREATE propagate Participant A JWT (NEVER Owner JWT)
    brainProv.fireComplete('late owner settled');
    await settle();
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Fresh Participant A turn', {
      sharedActor: partA,
      sharedMachineAuthority: partAJwt!,
    });
    await settle();

    // Downstream dispatchDelegatedSessionSend from tainted Brain must NOT carry Owner JWT!
    const delegFromTainted = await dispatchDelegatedSessionSend({
      caller: { sessionName: BRAIN, sessionInstanceId: `inst-${BRAIN}`, runtimeEpoch: `epoch-${BRAIN}` },
      targetSession: WORKER,
      message: 'Sub-task from tainted turn',
    }, {
      listSessions: () => [...mocks.sessions.values()] as unknown as SessionRecord[],
      readTimeline: async () => [],
    });
    expect(delegFromTainted.status).toBe('accepted');
    await settle();
    expect((await checkServerGate(WORKER, OWNER_NODE, MACHINE_ACTION.EXEC)).admission.ok).toBe(false);
    expect((await checkServerGate(WORKER, OWNER_NODE, MACHINE_ACTION.EXEC)).resolved.kind).toBe('participant');

    // Tainted PAIR_CREATE from Participant A turn must fail closed: never inherits Owner JWT across EXEC / AUD
    const handlers = createMemoryMcpToolHandlers({
      userId: OWNER,
      sessionName: BRAIN,
      projectName: PROJECT,
      projectRoot: join(root, 'repo'),
      serverId: SOURCE_SERVER,
    }, { sendDeps: { listSessions: () => [...mocks.sessions.values()] as unknown as SessionRecord[] } });
    const taintedPair = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
      title: 'Tainted Participant Pair',
      brief: '## Acceptance\n- [ ][ ] 1. Verify\n',
      executor: EXEC,
      auditor: AUD,
      workspace: 'dir',
      idempotencyKey: 'e2e-pair-tainted-1',
    }) as { taskId: string };
    await settle();
    expect(getTaskPairStore().getPair(PROJECT, taintedPair.taskId)?.authority?.kind).not.toBe('owner');
    const taintedExecGate = await checkServerGate(EXEC, OWNER_NODE, MACHINE_ACTION.EXEC);
    expect(taintedExecGate.resolved.kind).toBe('participant');
    expect(taintedExecGate.admission.ok).toBe(false);
    expect(taintedExecGate.cronGate.ok).toBe(false);

    // Stalled Codex watchdog continue on tainted turn MUST fail closed (no Owner JWT)!
    (brainRt as unknown as { _lastActivityAt: number })._lastActivityAt = Date.now() - 20 * 60_000;
    await recoverCodexStalledSession({ name: BRAIN, agentType: 'codex-sdk' });
    await settle();
    // Watchdog cancel cleared turn and queued continue without ownerMachineAuthority -> shared host refuses absent header!
    expect((await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC)).admission.ok).toBe(false);

    // Scenario C: Concurrent Participant A + Participant B -> AMBIGUOUS_PARTICIPANT_ACTOR (403 on hook, refuses BOTH nodes!)
    brainProv.fireComplete('settled');
    await settle();
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Part A turn', {
      sharedActor: partA,
      sharedMachineAuthority: partAJwt!,
    });
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Part B joins', {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      sharedActor: makeParticipantEnvelope(PART_B, 'Bob', 'act-pb'),
      sharedMachineAuthority: partBJwt!,
    });
    await settle();
    const ambigOwner = await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC);
    const ambigPartANode = await checkServerGate(BRAIN, PART_A_NODE, MACHINE_ACTION.VIEW);
    expect(ambigOwner.hook.status).toBe(403);
    expect(ambigOwner.hook.body.error).toBe('shared_machine_authority_unavailable');
    expect(ambigOwner.admission.ok).toBe(false);
    expect(ambigPartANode.admission.ok).toBe(false); // Neither A nor B may borrow the other's node!

    // Scenario D: Clean settle -> autonomous continuation STILL cannot inherit Owner -> fresh Owner turn recovers!
    brainProv.fireComplete('ambiguous done');
    await settle();
    brainProv.setBusy(true);
    expect((await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC)).admission.ok).toBe(false);
    brainProv.setBusy(false);

    const freshOwnerJwt = await issueOwnerMachineAuthorityForSession(db, {
      actorUserId: OWNER, sourceServerId: SOURCE_SERVER, sessionName: BRAIN, actionId: 'act-own-recover', signingKey: JWT_KEY,
    });
    await dispatchSessionMessage(mocks.sessions.get(BRAIN) as unknown as SessionRecord, 'Fresh clean Owner turn', {
      messageOrigin: CHAT_MESSAGE_ORIGINS.USER,
      ownerMachineAuthority: freshOwnerJwt!,
    });
    await settle();
    const recoveredGate = await checkServerGate(BRAIN, OWNER_NODE, MACHINE_ACTION.EXEC);
    expect(recoveredGate.resolved.kind).toBe('owner');
    expect(recoveredGate.admission.ok).toBe(true);
    expect(recoveredGate.cronGate.ok).toBe(true);
  });
});
