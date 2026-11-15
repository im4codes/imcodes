import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import type { SessionRecord } from '../../../src/store/session-store.js';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES, MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { OWNER_MACHINE_AUTHORITY_FIELD, OWNER_MACHINE_AUTHORITY_TYPE, SHARED_MACHINE_AUTHORITY_FIELD, SHARED_MACHINE_AUTHORITY_TYPE } from '../../../shared/shared-machine-authority.js';
import { TASK_PAIR_DECISION_BRAIN_NOTICE_REASON, TASK_PAIR_DECISION_MSG } from '../../../shared/task-pair-decision.js';
import { CHAT_MESSAGE_ORIGINS } from '../../../shared/chat-message-origin.js';
import { signJwt } from '../../../server/src/security/crypto.js';
import { admitMachineAction } from '../../../server/src/share/shared-machine-authority.js';
import { MACHINE_ACTION, MACHINE_DENIAL_REASON } from '../../../shared/machine-access-policy.js';

const SIGNING_KEY = 'task-pair-machine-authority-test-key-32';
const SOURCE_SERVER_ID = 'srv-shared-host';
const TARGET_NODE_ID = '7454097385';
const OWNER_USER = 'owner-1';
const PARTICIPANT_USER = 'participant-1';
const PROJECT = 'proj-auth';
const BRAIN = 'deck_projauth_brain';
const EXEC = 'deck_sub_exec_auth';
const AUD = 'deck_sub_aud_auth';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(),
  runtimes: new Map<string, Record<string, unknown>>(),
  timelineEvents: [] as Array<{ session: string; type: string; payload: Record<string, unknown> }>,
  dispatches: [] as Array<{ target: string; message: string; options: Record<string, unknown> }>,
}));

vi.mock('../../../src/store/session-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: (name: string) => mocks.sessions.get(name),
  listSessions: () => [...mocks.sessions.values()],
}));

vi.mock('../../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTransportRuntime: (name: string) => mocks.runtimes.get(name),
  drainTransportResendQueueForDispatch: vi.fn(),
  ensureTransportRuntimeForPendingResend: vi.fn(),
}));

vi.mock('../../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: (session: string, type: string, payload: Record<string, unknown>) => {
      mocks.timelineEvents.push({ session, type, payload });
    },
  },
}));

vi.mock('../../../src/daemon/session-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/daemon/session-dispatch.js')>();
  return {
    ...actual,
    dispatchSessionMessage: vi.fn(async (target: SessionRecord, message: string, options: Record<string, unknown>) => {
      mocks.dispatches.push({ target: target.name, message, options });
      return 'sent';
    }),
  };
});

const { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } = await import('../../../src/daemon/task-pairs/store.js');
const { taskPairService } = await import('../../../src/daemon/task-pairs/service.js');
const { taskPairAutomation } = await import('../../../src/daemon/task-pairs/scheduler.js');
const { setTaskPairDeliveryDepsForTests, sendTaskPairMessage } = await import('../../../src/daemon/task-pairs/delivery.js');
const { taskPairDecisionApi } = await import('../../../src/daemon/task-pairs/decision-api.js');
const { taskPairDecisionRevision } = await import('../../../src/daemon/task-pairs/decision-context.js');
const { captureInboundCommandAuthority, mergePairAuthority, resolveAggregatePairAuthority } = await import('../../../src/daemon/task-pairs/authority.js');
const { AMBIGUOUS_PARTICIPANT_ACTOR } = await import('../../../src/daemon/sender-participant-turn.js');
const { createMemoryMcpToolHandlers } = await import('../../../src/daemon/memory-mcp-tools.js');
const { buildPairConsoleRow } = await import('../../../src/daemon/supervision-console-pair-projection.js');

function makeSession(name: string, role: SessionRecord['role'], state: SessionRecord['state'] = 'idle'): SessionRecord {
  return {
    name,
    projectName: PROJECT,
    projectDir: '/tmp/proj-auth',
    role,
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    state,
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    sessionInstanceId: `inst-${name}`,
    runtimeEpoch: `epoch-${name}`,
  } as SessionRecord;
}

function ownerTurnRuntime(token: string) {
  return {
    pendingEntries: [],
    requiresSharedMachineAuthority: () => false,
    getActiveSharedMachineAuthority: () => null,
    getActiveOwnerMachineAuthority: () => token,
    activeDispatchEntries: [{ ownerMachineAuthority: token }],
  };
}

function participantTurnRuntime(actorUserId: string, token: string | null) {
  return {
    pendingEntries: [],
    requiresSharedMachineAuthority: () => true,
    getActiveSharedMachineAuthority: () => token,
    getActiveOwnerMachineAuthority: () => null,
    activeTurnParticipantUserIds: () => [actorUserId],
    activeDispatchEntries: [{ sharedActor: { actorUserId, effectiveActorRole: 'participant' }, ...(token ? { sharedMachineAuthority: token } : {}) }],
  };
}

function mintOwnerJwt(sessionName: string, actionId = 'act-owner'): string {
  return signJwt({
    type: OWNER_MACHINE_AUTHORITY_TYPE,
    sub: OWNER_USER,
    sourceServerId: SOURCE_SERVER_ID,
    sessionName,
    projectName: PROJECT,
    actionId,
  }, SIGNING_KEY, 3600);
}

function mintParticipantJwt(actorUserId: string, sessionName: string, actionId = 'act-part'): string {
  return signJwt({
    type: SHARED_MACHINE_AUTHORITY_TYPE,
    sub: actorUserId,
    sourceServerId: SOURCE_SERVER_ID,
    sessionName,
    projectName: PROJECT,
    shareTarget: { kind: 'main', serverId: SOURCE_SERVER_ID, sessionName },
    actionId,
  }, SIGNING_KEY, 3600);
}

/** Minimal DB mock exercising the real `admitMachineAction` server admission logic on a shared source host. */
function makeServerAdmissionDb() {
  return {
    queryOne: async (sql: string, params?: unknown[]) => {
      if (sql.includes('access_role')) {
        const userId = String(params?.[0] ?? '');
        if (userId === OWNER_USER) {
          return {
            id: TARGET_NODE_ID,
            node_id: TARGET_NODE_ID,
            user_id: OWNER_USER,
            access_role: 'owner',
            access_source: 'owner',
            exec_granted: true,
            exec_enabled: true,
          };
        }
        return null;
      }
      if (sql.includes('FROM servers') && sql.includes('owner_user_id')) {
        const id = String(params?.[0] ?? '');
        if (id === SOURCE_SERVER_ID) return { id: SOURCE_SERVER_ID, user_id: OWNER_USER, owner_user_id: OWNER_USER };
        return null;
      }
      if (sql.includes('SELECT user_id FROM servers')) return { user_id: OWNER_USER };
      if (sql.includes('SELECT status FROM users')) return { status: 'active' };
      if (sql.includes('SELECT project_name FROM sessions')) return { project_name: PROJECT };
      if (sql.includes('FROM sub_sessions ss') && sql.includes('JOIN sessions')) {
        const subId = String(params?.[1] ?? '');
        const full = `deck_sub_${subId}`;
        if (full === EXEC || full === AUD) return { project_name: PROJECT, parent_session: BRAIN };
        return null;
      }
      if (sql.includes('FROM tab_shares') && sql.includes('LIMIT 1')) {
        // Shared source host (isSharedOrContributedServer === true) unless user_id filter excludes it
        if (sql.includes('user_id =')) return null;
        return { id: 'active-share-1' };
      }
      if (sql.includes('FROM server_shares')) return null;
      if (sql.includes('FROM team_members')) return null;
      if (sql.includes('FROM shared_context_groups')) return null;
      return null;
    },
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('ss.target_user_id =')) return [{ shared: false }];
      if (sql.includes('AS shared')) return [{ shared: true }];
      if (sql.includes('FROM tab_shares')) {
        const userId = String(params?.[0] ?? '');
        if (userId === PARTICIPANT_USER) {
          return [{
            id: 'tab-share-1',
            target_kind: 'main',
            target_server_id: SOURCE_SERVER_ID,
            target_session_name: BRAIN,
            target_sub_session_id: null,
            role: 'participant',
            created_at: 1,
            expires_at: null,
            revoked_at: null,
          }];
        }
      }
      return [];
    },
    execute: async () => ({ changes: 1 }),
  };
}

function brainCaller() {
  return {
    userId: OWNER_USER,
    namespace: { scope: 'user_private', userId: OWNER_USER, projectId: PROJECT } as ContextNamespace,
    sessionName: BRAIN,
    projectName: PROJECT,
    projectRoot: '/tmp/proj-auth',
    serverId: SOURCE_SERVER_ID,
    transport: 'in_process' as const,
  };
}

function mcpHandlers() {
  return createMemoryMcpToolHandlers(brainCaller(), {
    sendDeps: { listSessions: () => [...mocks.sessions.values()] },
  });
}

describe('task-pairs shared-host machine authority propagation & anti-escalation', () => {
  beforeEach(() => {
    mocks.sessions.clear();
    mocks.runtimes.clear();
    mocks.timelineEvents.length = 0;
    mocks.dispatches.length = 0;
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    mocks.sessions.set(BRAIN, makeSession(BRAIN, 'brain', 'running'));
    mocks.sessions.set(EXEC, makeSession(EXEC, 'w1', 'idle'));
    mocks.sessions.set(AUD, makeSession(AUD, 'w2', 'idle'));
  });

  afterEach(async () => {
    await taskPairService.waitForIdle();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
  });

  it('preserves ownerMachineAuthority across immediate/queued pair_create, READY_FOR_AUDIT, PASS/heartbeat, and refreshes on next_round/resume so server admitMachineAction allows exec_remote', async () => {
    const ownerJwt1 = mintOwnerJwt(BRAIN, 'act-1');
    const ownerJwt2 = mintOwnerJwt(BRAIN, 'act-2');
    const serverDb = makeServerAdmissionDb();
    mocks.runtimes.set(BRAIN, ownerTurnRuntime(ownerJwt1));
    mocks.runtimes.set(EXEC, ownerTurnRuntime(ownerJwt1));
    mocks.runtimes.set(AUD, ownerTurnRuntime(ownerJwt1));

    // Control baseline: shared host with absent token MUST be rejected (403 no_access)
    const absentCheck = await admitMachineAction(serverDb as never, {
      token: undefined,
      signingKey: SIGNING_KEY,
      authenticatedSourceServerId: SOURCE_SERVER_ID,
      sourceOwnerUserId: OWNER_USER,
      targetServerId: TARGET_NODE_ID,
      action: MACHINE_ACTION.EXEC,
      now: Date.now(),
    });
    expect(absentCheck).toMatchObject({ ok: false, reason: MACHINE_DENIAL_REASON.NO_ACCESS });

    const handlers = mcpHandlers();

    // 1. Immediate pair_create -> Executor brief receives ownerMachineAuthority
    const createRes = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
      taskId: 'tsk_auth_1',
      title: 'Check remote node',
      brief: 'Verify controlled node exec_remote',
      executor: EXEC,
      auditor: AUD,
      workspace: 'none',
    });
    expect(createRes.status).toBe('ok');
    await taskPairService.waitForIdle();

    const execBrief = mocks.dispatches.find((d) => d.target === EXEC && d.options.ownerMachineAuthority);
    expect(execBrief).toBeDefined();
    expect(execBrief!.options.ownerMachineAuthority).toBe(ownerJwt1);
    expect(execBrief!.options.messageOrigin).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
    expect(execBrief!.options).not.toHaveProperty('sharedActor');

    const execAdmission = await admitMachineAction(serverDb as never, {
      token: String(execBrief!.options.ownerMachineAuthority),
      signingKey: SIGNING_KEY,
      authenticatedSourceServerId: SOURCE_SERVER_ID,
      sourceOwnerUserId: OWNER_USER,
      targetServerId: TARGET_NODE_ID,
      action: MACHINE_ACTION.EXEC,
      now: Date.now(),
    });
    expect(execAdmission.ok).toBe(true);

    // 2. READY_FOR_AUDIT -> Auditor notification carries ownerMachineAuthority and passes admitMachineAction
    mocks.dispatches.length = 0;
    taskPairService.applyMarker({
      project: PROJECT,
      writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'tsk_auth_1', attrs: {} },
      source: 'assistant',
      eventId: 'evt-ready-1',
    });
    await taskPairService.waitForIdle();
    const auditReq = mocks.dispatches.find((d) => d.target === AUD);
    expect(auditReq?.options.ownerMachineAuthority).toBe(ownerJwt1);
    const audAdmission = await admitMachineAction(serverDb as never, {
      token: String(auditReq!.options.ownerMachineAuthority),
      signingKey: SIGNING_KEY,
      authenticatedSourceServerId: SOURCE_SERVER_ID,
      sourceOwnerUserId: OWNER_USER,
      targetServerId: TARGET_NODE_ID,
      action: MACHINE_ACTION.EXEC,
      now: Date.now(),
    });
    expect(audAdmission.ok).toBe(true);

    // 3. PASS -> Brain notice carries ownerMachineAuthority; Brain heartbeat aggregate carries ownerMachineAuthority
    mocks.dispatches.length = 0;
    taskPairService.applyMarker({
      project: PROJECT,
      writer: AUD,
      marker: { verb: 'PASS', knownVerb: 'PASS', taskId: 'tsk_auth_1', attrs: {} },
      source: 'assistant',
      eventId: 'evt-pass-1',
    });
    await taskPairService.waitForIdle();
    const passNotice = mocks.dispatches.find((d) => d.target === BRAIN);
    expect(passNotice?.options.ownerMachineAuthority).toBe(ownerJwt1);

    mocks.dispatches.length = 0;
    await sendTaskPairMessage(BRAIN, '__aggregate__', 'brain-heartbeat', 'Check pair status');
    const hbNotice = mocks.dispatches.find((d) => d.target === BRAIN);
    expect(hbNotice?.options.ownerMachineAuthority).toBe(ownerJwt1);

    // 4. Multi-round refresh: Owner sends a new turn with ownerJwt2 -> pair_next_round refreshes persisted token
    mocks.runtimes.set(BRAIN, ownerTurnRuntime(ownerJwt2));
    mocks.dispatches.length = 0;
    const nextRes = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]({
      taskId: 'tsk_auth_1',
      note: 'Round 2 with refreshed token',
    });
    expect(nextRes.status).toBe('ok');
    await taskPairService.waitForIdle();
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_auth_1')?.authority).toEqual({
      kind: 'owner',
      ownerMachineAuthority: ownerJwt2,
    });
    const round2Exec = mocks.dispatches.find((d) => d.target === EXEC);
    expect(round2Exec?.options.ownerMachineAuthority).toBe(ownerJwt2);
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: 'tsk_auth_1', action: 'done', accept: true });
    await taskPairService.waitForIdle();

    // 5. Queued pair_create (busy executor) -> pair_dispatch later preserves & refreshes Owner authority
    mocks.sessions.set(EXEC, makeSession(EXEC, 'w1', 'running'));
    const qRes = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
      taskId: 'tsk_auth_q',
      title: 'Queued check',
      brief: 'Verify queued pair retains owner authority',
      executor: EXEC,
      auditor: 'none',
      workspace: 'none',
    });
    expect(qRes.state).toBe('queued');
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_auth_q')?.authority).toEqual({
      kind: 'owner',
      ownerMachineAuthority: ownerJwt2,
    });

    mocks.sessions.set(EXEC, makeSession(EXEC, 'w1', 'idle'));
    mocks.dispatches.length = 0;
    await taskPairAutomation.runQueue(PROJECT, BRAIN);
    await taskPairService.waitForIdle();
    const queuedExecNotice = mocks.dispatches.find((d) => d.target === EXEC && d.message.includes('tsk_auth_q'));
    expect(queuedExecNotice?.options.ownerMachineAuthority).toBe(ownerJwt2);

    // 6. Explicitly queued pair (via dependsOn) dispatched with pair_dispatch + pair_pause -> pair_resume refreshes Owner token
    const ownerJwt3 = mintOwnerJwt(BRAIN, 'act-3');
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
      taskId: 'tsk_auth_dep',
      title: 'Pause and resume check',
      brief: 'Verify pair_dispatch and pair_resume refresh owner authority',
      executor: EXEC,
      auditor: 'none',
      workspace: 'none',
      dependsOn: ['tsk_auth_q'],
    });
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: 'tsk_auth_q', action: 'done', accept: true });
    await taskPairService.waitForIdle();

    mocks.runtimes.set(BRAIN, ownerTurnRuntime(ownerJwt3));
    mocks.dispatches.length = 0;
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_PAUSE]({ taskId: 'tsk_auth_dep', mode: 'manual', note: 'Hold' });
    const resumeRes = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_RESUME]({ taskId: 'tsk_auth_dep' });
    expect(resumeRes.status).toBe('ok');
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_auth_dep')?.authority).toEqual({
      kind: 'owner',
      ownerMachineAuthority: ownerJwt3,
    });
  });

  it('delivers Owner TASK_PAIR_DECISION_MSG.FEEDBACK with ownerMachineAuthority and Participant FEEDBACK with strict participant QUEUE isolation', async () => {
    const ownerJwt = mintOwnerJwt(BRAIN, 'act-feedback-owner');
    const ownerJwtFresh = mintOwnerJwt(BRAIN, 'act-feedback-owner-fresh');
    const participantJwt = mintParticipantJwt(PARTICIPANT_USER, BRAIN, 'act-feedback-part');
    const serverDb = makeServerAdmissionDb();
    const store = getTaskPairStore();
    const blockedState: TaskPairState = {
      taskId: 'tsk_feedback_1',
      title: 'Decision pair',
      brain: BRAIN,
      executor: EXEC,
      auditor: AUD,
      status: 'working',
      round: 1,
      deliveryRound: 1,
      flags: ['needs_input'],
      flagSides: { needs_input: 'executor' },
      blocking: ['P0'],
      blockedNote: 'Should we run remote test?',
      previousAuditors: [],
      createdAt: 10,
      updatedAt: 20,
    };
    store.savePair(PROJECT, blockedState, { authority: { kind: 'owner', ownerMachineAuthority: ownerJwt } });
    const req = taskPairService.recordDecision({
      project: PROJECT,
      taskId: 'tsk_feedback_1',
      round: 1,
      kind: 'request',
      conclusion: 'Need approval',
      summary: 'Confirm remote test',
      question: 'Run exec_remote?',
      options: [{ id: 'yes', label: 'Yes' }],
      recommendation: 'Yes',
      author: EXEC,
      at: 30,
      idempotencyKey: 'q-feedback-1',
    }).record;
    await taskPairService.waitForIdle();
    mocks.dispatches.length = 0;

    // 1. Participant submits FEEDBACK (even if forged ownerMachineAuthority were present, inbound parser rejects it in favor of sharedActor)
    const scope = { projectName: PROJECT, coordinatorSessionName: BRAIN };
    const sharedActor = {
      actorUserId: PARTICIPANT_USER,
      actorDisplayName: 'Participant User',
      snapshot: {
        target: { kind: 'main' as const, serverId: SOURCE_SERVER_ID, sessionName: BRAIN },
        effectiveRole: 'participant' as const,
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['tab-share-1'],
        primaryShareId: 'tab-share-1',
        authorizedAt: 1,
      },
      primaryShareId: 'tab-share-1',
      effectiveActorRole: 'participant' as const,
      actionId: 'pair-feedback-part-1',
      origin: 'shared-tab' as const,
      authorizedAt: 1,
    };
    expect(captureInboundCommandAuthority({
      sharedActor,
      [SHARED_MACHINE_AUTHORITY_FIELD]: participantJwt,
      [OWNER_MACHINE_AUTHORITY_FIELD]: ownerJwt,
    })).toEqual({
      kind: 'participant',
      sharedActor,
      sharedMachineAuthority: participantJwt,
    });

    taskPairDecisionApi(scope, {
      type: TASK_PAIR_DECISION_MSG.FEEDBACK,
      taskId: 'tsk_feedback_1',
      requestId: 'human-part-1',
      round: 1,
      revision: taskPairDecisionRevision(blockedState),
      questionId: req.id,
      optionId: 'yes',
      feedback: 'Participant says yes',
      sharedActor,
      [SHARED_MACHINE_AUTHORITY_FIELD]: participantJwt,
    });
    await taskPairService.waitForIdle();

    const partWake = mocks.dispatches.find((d) => d.target === BRAIN);
    expect(partWake).toBeDefined();
    expect(partWake!.options.deliveryMode).toBe(MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE);
    expect(partWake!.options.sharedActor).toMatchObject({ actorUserId: PARTICIPANT_USER, effectiveActorRole: 'participant' });
    expect(partWake!.options.sharedMachineAuthority).toBe(participantJwt);
    expect(partWake!.options).not.toHaveProperty('ownerMachineAuthority');
    // Participant token MUST fail admitMachineAction for host controlled nodes
    const partAdmission = await admitMachineAction(serverDb as never, {
      token: String(partWake!.options.sharedMachineAuthority),
      signingKey: SIGNING_KEY,
      authenticatedSourceServerId: SOURCE_SERVER_ID,
      sourceOwnerUserId: OWNER_USER,
      targetServerId: TARGET_NODE_ID,
      action: MACHINE_ACTION.EXEC,
      now: Date.now(),
    });
    expect(partAdmission.ok).toBe(false);
    // Pair's stored authority remains untouched Owner authority
    expect(store.getPair(PROJECT, 'tsk_feedback_1')?.authority).toEqual({
      kind: 'owner',
      ownerMachineAuthority: ownerJwt,
    });

    // 2. Owner submits second FEEDBACK -> refreshes pair authority & wakes Brain with fresh ownerMachineAuthority
    const req2 = taskPairService.recordDecision({
      project: PROJECT,
      taskId: 'tsk_feedback_1',
      round: 1,
      kind: 'request',
      conclusion: 'Confirm again',
      summary: 'Need owner greenlight',
      question: 'Proceed now?',
      options: [{ id: 'go', label: 'Go' }],
      recommendation: 'Go',
      author: EXEC,
      at: Date.now() + 10,
      idempotencyKey: 'q-feedback-2',
    }).record;
    await taskPairService.waitForIdle();
    mocks.dispatches.length = 0;

    taskPairDecisionApi(scope, {
      type: TASK_PAIR_DECISION_MSG.FEEDBACK,
      taskId: 'tsk_feedback_1',
      requestId: 'human-owner-1',
      round: 1,
      revision: taskPairDecisionRevision(store.getPair(PROJECT, 'tsk_feedback_1')!.state),
      questionId: req2.id,
      optionId: 'go',
      feedback: 'Owner approved',
      [OWNER_MACHINE_AUTHORITY_FIELD]: ownerJwtFresh,
    });
    await taskPairService.waitForIdle();

    const ownerWake = mocks.dispatches.find((d) => d.target === BRAIN);
    expect(ownerWake).toBeDefined();
    expect(ownerWake!.options.ownerMachineAuthority).toBe(ownerJwtFresh);
    expect(ownerWake!.options).not.toHaveProperty('sharedActor');
    expect(ownerWake!.options.deliveryMode).toBe(MEMORY_MCP_SEND_DELIVERY_MODES.APPEND);
    expect(store.getPair(PROJECT, 'tsk_feedback_1')?.authority).toEqual({
      kind: 'owner',
      ownerMachineAuthority: ownerJwtFresh,
    });
    const ownerAdmission = await admitMachineAction(serverDb as never, {
      token: String(ownerWake!.options.ownerMachineAuthority),
      signingKey: SIGNING_KEY,
      authenticatedSourceServerId: SOURCE_SERVER_ID,
      sourceOwnerUserId: OWNER_USER,
      targetServerId: TARGET_NODE_ID,
      action: MACHINE_ACTION.EXEC,
      now: Date.now(),
    });
    expect(ownerAdmission.ok).toBe(true);
  });

  it('prevents participant-created pair escalation across background markers and aggregate notices', async () => {
    const participantJwt = mintParticipantJwt(PARTICIPANT_USER, BRAIN, 'act-part-pair');
    const ownerJwt = mintOwnerJwt(BRAIN, 'act-owner-later');
    mocks.runtimes.set(BRAIN, participantTurnRuntime(PARTICIPANT_USER, participantJwt));

    const handlers = mcpHandlers();
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
      taskId: 'tsk_part_1',
      title: 'Participant task',
      brief: 'Must stay participant scoped',
      executor: EXEC,
      auditor: AUD,
      workspace: 'none',
    });
    await taskPairService.waitForIdle();

    const initialAuth = getTaskPairStore().getPair(PROJECT, 'tsk_part_1')?.authority;
    expect(initialAuth).toMatchObject({
      kind: 'participant',
      sharedActor: { actorUserId: PARTICIPANT_USER, effectiveActorRole: 'participant' },
      sharedMachineAuthority: participantJwt,
    });

    // Later an owner turn runs in Brain; background markers / non-override savePairAuthority MUST NOT upgrade participant -> owner
    mocks.runtimes.set(EXEC, ownerTurnRuntime(ownerJwt));
    taskPairService.applyMarker({
      project: PROJECT,
      writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'tsk_part_1', attrs: {} },
      source: 'assistant',
      eventId: 'evt-part-ready',
    });
    await taskPairService.waitForIdle();
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_part_1')?.authority?.kind).toBe('participant');

    // Mixed participant + owner aggregate notices fail closed under AMBIGUOUS_PARTICIPANT_ACTOR without any token
    const mixed = resolveAggregatePairAuthority([
      { kind: 'owner', ownerMachineAuthority: ownerJwt },
      initialAuth,
    ]);
    expect(mixed).toMatchObject({
      kind: 'participant',
      sharedActor: { actorUserId: AMBIGUOUS_PARTICIPANT_ACTOR, effectiveActorRole: 'participant' },
    });
    expect(mixed && 'sharedMachineAuthority' in mixed ? mixed.sharedMachineAuthority : undefined).toBeUndefined();

    // Only explicit allowOwnerOverride (e.g. Brain PAIR_RESUME / PAIR_NEXT_ROUND) replaces participant binding
    const overridden = mergePairAuthority(initialAuth, { kind: 'owner', ownerMachineAuthority: ownerJwt }, { allowOwnerOverride: true });
    expect(overridden).toEqual({ kind: 'owner', ownerMachineAuthority: ownerJwt });
  });

  it('never leaks raw JWTs to public snapshots/logs and migrates pre-existing legacy SQLite DBs cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-authority-mig-'));
    const dbPath = join(dir, 'task-pairs.sqlite');
    const secretJwt = mintOwnerJwt(BRAIN, 'act-secret-check');
    try {
      // Simulate an old daemon DB without `authority_json` or `details_json`
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE task_pairs (
          project TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, brain TEXT NOT NULL,
          executor TEXT, auditor TEXT, queue_order INTEGER NOT NULL DEFAULT 0, legacy_task_id TEXT,
          state_json TEXT NOT NULL, liveness_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (project, task_id)
        );
        CREATE TABLE task_pair_events (
          id TEXT PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, writer TEXT NOT NULL,
          role TEXT NOT NULL, verb TEXT NOT NULL, attrs_json TEXT NOT NULL, effect TEXT NOT NULL,
          unusual INTEGER NOT NULL DEFAULT 0, resource_conflict_json TEXT, source TEXT NOT NULL,
          from_status TEXT, to_status TEXT, at INTEGER NOT NULL
        );
        CREATE TABLE task_pair_resources (
          claim_id TEXT PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, owner TEXT NOT NULL,
          resource TEXT NOT NULL, mode TEXT NOT NULL, claimed_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE task_pair_decisions (
          id TEXT PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, round INTEGER NOT NULL,
          kind TEXT NOT NULL, conclusion TEXT NOT NULL, summary TEXT NOT NULL, author TEXT NOT NULL,
          at INTEGER NOT NULL, related_json TEXT, idempotency_key TEXT
        );
        CREATE TABLE task_pair_decision_notifications (
          id TEXT PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, decision_id TEXT NOT NULL,
          target TEXT NOT NULL, reason TEXT NOT NULL, text TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER, delivered_at INTEGER,
          UNIQUE (decision_id, target)
        );
        CREATE TABLE task_pair_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      const legacyPairState: TaskPairState = {
        taskId: 'legacy-pair-1',
        title: 'Legacy pair',
        brain: BRAIN,
        executor: EXEC,
        auditor: 'none',
        status: 'working',
        round: 1,
        flags: [],
        flagSides: {},
        blocking: ['P0'],
        previousAuditors: [],
        createdAt: 1,
        updatedAt: 2,
      };
      legacyDb.prepare(
        `INSERT INTO task_pairs (project, task_id, status, brain, executor, auditor, queue_order, state_json, liveness_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 2)`,
      ).run(PROJECT, 'legacy-pair-1', 'working', BRAIN, EXEC, 'none', JSON.stringify(legacyPairState), JSON.stringify({
        silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1, progressAuditorAt: 1,
        activityExecutorAt: 1, activityAuditorAt: 1, lastTickAt: 1, notified: [],
      }));
      legacyDb.prepare(
        `INSERT INTO task_pair_decision_notifications (id, project, task_id, decision_id, target, reason, text, attempts)
         VALUES ('dec-legacy:deck_projauth_brain', ?, 'legacy-pair-1', 'dec-legacy', ?, ?, 'Old pending decision notice', 0)`,
      ).run(PROJECT, BRAIN, TASK_PAIR_DECISION_BRAIN_NOTICE_REASON);
      legacyDb.close();

      // Reopen with current TaskPairStore twice (verifying idempotent ALTER TABLE migration)
      const migratedStore1 = new TaskPairStore(dbPath);
      expect(migratedStore1.getPair(PROJECT, 'legacy-pair-1')?.state.taskId).toBe('legacy-pair-1');
      expect(migratedStore1.listPendingDecisionNotifications(10)).toHaveLength(1);
      migratedStore1.close();

      const migratedStore2 = new TaskPairStore(dbPath);
      setTaskPairStoreForTests(migratedStore2);

      // Pending old notification drains cleanly without crashing
      await taskPairService.retryDecisionNotifications();
      expect(migratedStore2.listPendingDecisionNotifications(10)).toEqual([]);
      expect(mocks.dispatches.some((d) => d.message === 'Old pending decision notice')).toBe(true);

      // Attach secret JWT to pair & verify NO public projection, timeline event, or MCP output leaks it
      migratedStore2.savePairAuthority(PROJECT, 'legacy-pair-1', { kind: 'owner', ownerMachineAuthority: secretJwt });
      const stored = migratedStore2.getPair(PROJECT, 'legacy-pair-1')!;
      const consoleRow = buildPairConsoleRow(stored, { inlineBrief: true });
      const handlers = mcpHandlers();
      const pairGetRes = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId: 'legacy-pair-1' });
      const pairListRes = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_LIST]({});

      expect(JSON.stringify(consoleRow)).not.toContain(secretJwt);
      expect(JSON.stringify(pairGetRes)).not.toContain(secretJwt);
      expect(JSON.stringify(pairListRes)).not.toContain(secretJwt);
      expect(JSON.stringify(mocks.timelineEvents)).not.toContain(secretJwt);
      migratedStore2.close();
    } finally {
      setTaskPairStoreForTests(new TaskPairStore(':memory:'));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
