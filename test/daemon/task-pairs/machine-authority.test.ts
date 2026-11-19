import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../../shared/memory-mcp-contracts.js';
import { OWNER_MACHINE_AUTHORITY_FIELD, SHARED_MACHINE_ACTIVITY_KIND, SHARED_MACHINE_AUTHORITY_FIELD } from '../../../shared/shared-machine-authority.js';
import { TASK_PAIR_DECISION_MSG } from '../../../shared/task-pair-decision.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import type { AgentProvider } from '../../../src/agent/provider.js';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(),
  runtimes: new Map<string, any>(),
  processSend: vi.fn(async (_name: string, _text: string, options?: { onTyped?: () => void }) => {
    options?.onTyped?.();
    return 'sent';
  }),
  timelineEvents: [] as Array<{ sessionId: string; type: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../../src/daemon/command-handler.js', () => ({
  clearTransportConversation: vi.fn(),
  handoffSessionConversation: vi.fn(async () => undefined),
  supportsTransportClear: () => true,
  supportsProcessClear: () => false,
  switchSessionModelNow: vi.fn(),
  sendProcessSessionMessageForAutomation: mocks.processSend,
  stopSessionNow: vi.fn(() => true),
}));

vi.mock('../../../src/store/session-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: (name: string) => mocks.sessions.get(name),
  listSessions: () => [...mocks.sessions.values()],
  loadStore: async () => undefined,
}));

vi.mock('../../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTransportRuntime: (name: string) => mocks.runtimes.get(name),
  drainTransportResendQueueForDispatch: async (name: string) => {
    const rt = mocks.runtimes.get(name);
    if (!rt?.providerSessionId) return;
    const { drainResend } = await import('../../../src/daemon/transport-resend-queue.js');
    const { deliverTransportResendEntry } = await import('../../../src/agent/transport-resend-delivery.js');
    await drainResend(
      name,
      async (entry, ownership) => deliverTransportResendEntry(rt, entry, ownership),
      undefined,
      undefined,
      undefined,
      rt.recipientIdentity ?? null,
    );
  },
}));

vi.mock('../../../src/daemon/timeline-emitter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/daemon/timeline-emitter.js')>();
  return {
    ...actual,
    timelineEmitter: {
      ...actual.timelineEmitter,
      epoch: actual.timelineEmitter.epoch,
      emit: (sessionId: string, type: string, payload: Record<string, unknown>, opts?: unknown) => {
        mocks.timelineEvents.push({ sessionId, type, payload });
        return actual.timelineEmitter.emit(sessionId, type, payload, opts as never);
      },
      on: actual.timelineEmitter.on.bind(actual.timelineEmitter),
    },
  };
});

// session-dispatch first: it and session-manager import each other, and the mocked session-manager must be what both bind to.
await import('../../../src/daemon/session-dispatch.js');
const { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } = await import('../../../src/daemon/task-pairs/store.js');
const { taskPairService, captureTaskPairCallerAuthority } = await import('../../../src/daemon/task-pairs/service.js');
const { sendTaskPairMessage, setTaskPairDeliveryDepsForTests } = await import('../../../src/daemon/task-pairs/delivery.js');
const { createMemoryMcpToolHandlers } = await import('../../../src/daemon/memory-mcp-tools.js');
const { taskPairDecisionApi } = await import('../../../src/daemon/task-pairs/decision-api.js');
const { taskPairDecisionRevision } = await import('../../../src/daemon/task-pairs/decision-context.js');
const { clearResend, getResendEntries } = await import('../../../src/daemon/transport-resend-queue.js');
const { TransportSessionRuntime } = await import('../../../src/agent/transport-session-runtime.js');
const { clearProcessSharedMachineAuthoritiesForTests, readProcessSharedMachineAuthority } =
  await import('../../../src/daemon/shared-machine-authority-context.js');

const PROJECT = 'auth-proj';
const BRAIN = 'deck_auth_brain';
const EXEC = 'deck_sub_auth_exec';
const AUDIT = 'deck_sub_auth_aud';

function sessionRecord(name: string, role: SessionRecord['role'], patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    projectName: PROJECT,
    projectDir: '/tmp/auth-proj',
    role,
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    sessionInstanceId: `inst-${name}`,
    runtimeEpoch: `epoch-${name}`,
    ...patch,
  } as SessionRecord;
}

interface CapturedSend {
  target: string;
  mode: 'send' | 'append';
  text: string;
  metadata: Record<string, unknown>;
}

function makeMockTransportRuntime(
  sessionName: string,
  captured: CapturedSend[],
  options: {
    ownerAuthority?: string | null;
    participantActors?: string[];
    participantAuthority?: string | null;
  } = {},
) {
  const actors = options.participantActors ?? [];
  const runtime: any = {
    providerSessionId: `prov-${sessionName}`,
    recipientIdentity: { sessionInstanceId: `inst-${sessionName}`, runtimeEpoch: `epoch-${sessionName}` },
    pendingEntries: [] as Array<{ clientMessageId: string }>,
    pendingCount: 0,
    pendingVersion: 0,
    sending: false,
    requiresSharedMachineAuthority: () => actors.length > 0,
    activeTurnParticipantUserIds: () => actors,
    getActiveSharedMachineAuthority: () => (actors.length > 0 ? (options.participantAuthority ?? null) : null),
    getActiveOwnerMachineAuthority: () => (actors.length === 0 ? (options.ownerAuthority ?? null) : null),
    activeDispatchEntries: actors.map((actorUserId) => ({ sharedActor: { actorUserId, effectiveActorRole: 'participant' } })),
    send: vi.fn((text: string, clientMessageId?: string, _supervision?: unknown, _origin?: unknown, metadata?: Record<string, unknown>) => {
      captured.push({ target: sessionName, mode: 'send', text, metadata: metadata ?? {} });
      return 'sent';
    }),
    appendExternalMessageToActiveTurn: vi.fn(async (text: string, clientMessageId?: string, _supervision?: unknown, _origin?: unknown, metadata?: Record<string, unknown>) => {
      captured.push({ target: sessionName, mode: 'append', text, metadata: metadata ?? {} });
      return 'appended';
    }),
    setPendingResend: () => undefined,
  };
  return runtime;
}

function callerOf(over: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  return {
    userId: 'owner-1',
    namespace: { scope: 'user_private', userId: 'owner-1', projectId: PROJECT } as ContextNamespace,
    sessionName: BRAIN,
    projectName: PROJECT,
    projectRoot: '/tmp/auth-proj',
    serverId: 'srv-1',
    providerId: null,
    transport: 'in_process',
    ...over,
  };
}

describe('task-pairs machine authority capture, private persistence, and delivery propagation', () => {
  let capturedSends: CapturedSend[];
  let tempDirs: string[];

  beforeEach(() => {
    capturedSends = [];
    tempDirs = [];
    mocks.sessions.clear();
    mocks.runtimes.clear();
    mocks.processSend.mockClear();
    mocks.timelineEvents.length = 0;
    for (const name of [BRAIN, EXEC, AUDIT]) clearResend(name, 'test_setup');
    clearProcessSharedMachineAuthoritiesForTests();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  });

  afterEach(async () => {
    await taskPairService.waitForIdle();
    for (const name of [BRAIN, EXEC, AUDIT]) clearResend(name, 'test_cleanup');
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    clearProcessSharedMachineAuthoritiesForTests();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('captures ownerMachineAuthority on pair_create, delivers it to executor/auditor/Brain across store reload, and never leaks JWT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-auth-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'pairs.sqlite');
    setTaskPairStoreForTests(new TaskPairStore(dbPath));

    const ownerJwt = 'eyJ.owner.secret.jwt.token';
    mocks.sessions.set(BRAIN, sessionRecord(BRAIN, 'brain'));
    mocks.sessions.set(EXEC, sessionRecord(EXEC, 'w1'));
    mocks.sessions.set(AUDIT, sessionRecord(AUDIT, 'w2'));
    mocks.runtimes.set(BRAIN, makeMockTransportRuntime(BRAIN, capturedSends, { ownerAuthority: ownerJwt }));
    mocks.runtimes.set(EXEC, makeMockTransportRuntime(EXEC, capturedSends));
    mocks.runtimes.set(AUDIT, makeMockTransportRuntime(AUDIT, capturedSends));

    const handlers = createMemoryMcpToolHandlers(callerOf(), {
      sendDeps: { listSessions: () => [...mocks.sessions.values()] },
    });

    const created = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]!({
      taskId: 'tsk_owner_1',
      title: 'Verify owner authority propagation',
      brief: '- [ ][ ] 1. Test item',
      executor: EXEC,
      auditor: AUDIT,
    }) as Record<string, unknown>;
    expect(created.status).toBe('ok');

    // Executor and auditor initial briefs carry ownerMachineAuthority and no sharedActor.
    const execBrief = capturedSends.find((s) => s.target === EXEC);
    const audBrief = capturedSends.find((s) => s.target === AUDIT);
    expect(execBrief?.metadata.ownerMachineAuthority).toBe(ownerJwt);
    expect(execBrief?.metadata.sharedActor).toBeUndefined();
    expect(audBrief?.metadata.ownerMachineAuthority).toBe(ownerJwt);
    expect(audBrief?.metadata.sharedActor).toBeUndefined();

    // Simulate daemon restart: reopen TaskPairStore from disk.
    setTaskPairStoreForTests(new TaskPairStore(dbPath));
    capturedSends.length = 0;

    // NEEDS_INPUT notice to Brain carries ownerMachineAuthority.
    await sendTaskPairMessage(BRAIN, 'tsk_owner_1', 'brain-needs_input', 'Needs Brain ruling');
    // Non-Brain DECISION recorded by human notifies Brain with ownerMachineAuthority.
    taskPairService.recordDecision({
      project: PROJECT,
      taskId: 'tsk_owner_1',
      round: 1,
      kind: 'decision',
      conclusion: 'Approved',
      summary: 'Proceed',
      author: 'human',
      idempotencyKey: 'dec-1',
    });
    await taskPairService.waitForIdle();
    // PASS completion notice to Brain carries ownerMachineAuthority.
    await sendTaskPairMessage(BRAIN, 'tsk_owner_1', 'brain-line-pass-done', 'PASS ready');
    // Aggregate Brain heartbeat carries freshest ownerMachineAuthority.
    await sendTaskPairMessage(
      BRAIN,
      '__aggregate__',
      'brain-heartbeat',
      '1 open pair',
      undefined,
      [{ project: PROJECT, taskId: 'tsk_owner_1', epoch: 0 }],
    );

    const brainDeliveries = capturedSends.filter((s) => s.target === BRAIN);
    expect(brainDeliveries).toHaveLength(4);
    for (const msg of brainDeliveries) {
      expect(msg.metadata.ownerMachineAuthority).toBe(ownerJwt);
      expect(msg.metadata.sharedActor).toBeUndefined();
    }

    // Zero JWT leakage across store state, events, MCP projections, and timeline payloads.
    const pairGet = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET]!({ taskId: 'tsk_owner_1' });
    const pairList = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_LIST]!({});
    const taskGet = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_TASK_GET]!({ taskId: 'tsk_owner_1' });
    const storedPair = getTaskPairStore().getPair(PROJECT, 'tsk_owner_1');
    const events = getTaskPairStore().listEvents(PROJECT, 'tsk_owner_1', 50);

    for (const payload of [pairGet, pairList, taskGet, storedPair, events, mocks.timelineEvents]) {
      expect(JSON.stringify(payload)).not.toContain(ownerJwt);
    }
  });

  it('appending an owner-authorized pair nudge into Brain running turn preserves TransportSessionRuntime.getActiveOwnerMachineAuthority()', async () => {
    const ownerJwt = 'eyJ.owner.live.turn.jwt';
    const provider: AgentProvider = {
      id: 'fake',
      capabilities: {
        streaming: false,
        persistentSession: true,
        supportsAppendToActiveTurn: true,
        activeDelegationNotification: 'native',
        supportsTurnCancel: false,
        supportsStructuredMessages: false,
      } as any,
      createSession: async () => 'prov-session',
      send: async () => undefined,
      sendWithExternalAppend: async () => 'sent',
      appendToActiveTurn: async () => true,
      notifyActiveDelegation: async () => 'delivered',
      endSession: async () => undefined,
      killSession: async () => undefined,
      onDelta: () => () => undefined,
      onComplete: () => () => undefined,
      onError: () => () => undefined,
    } as any;

    const runtime = new TransportSessionRuntime(provider, BRAIN, {
      sessionInstanceId: `inst-${BRAIN}`,
      runtimeEpoch: `epoch-${BRAIN}`,
    });
    // Simulate active owner turn on Brain (active dispatch entry + turn state)
    (runtime as any)._status = 'streaming';
    (runtime as any)._sending = true;
    (runtime as any)._activeDispatchProviderAccepted = true;
    (runtime as any)._providerSessionId = 'prov-session';
    (runtime as any)._activeTurn = { resolve: () => undefined, reject: () => undefined };
    (runtime as any)._activeDispatchId = 'dispatch-owner-1';
    (runtime as any)._activeDispatchEntries = [{
      clientMessageId: 'owner-msg-1',
      text: 'Do owner work',
      ownerMachineAuthority: ownerJwt,
    }];

    mocks.sessions.set(BRAIN, sessionRecord(BRAIN, 'brain'));
    mocks.runtimes.set(BRAIN, runtime);

    expect(runtime.getActiveOwnerMachineAuthority()).toBe(ownerJwt);

    const store = getTaskPairStore();
    store.savePair(PROJECT, {
      taskId: 'tsk_live_owner',
      title: 'Live turn pair',
      brain: BRAIN,
      executor: EXEC,
      auditor: AUDIT,
      status: 'working',
      round: 1,
      flags: [],
      flagSides: {},
      blocking: ['P0'],
      previousAuditors: [],
      capCounts: {},
      resourceClaims: [],
      createdAt: 10,
      updatedAt: 10,
    });
    store.recordPrivateAuthority(PROJECT, 'tsk_live_owner', { kind: 'owner', authority: ownerJwt });

    const delivery = await sendTaskPairMessage(BRAIN, 'tsk_live_owner', 'brain-needs_input', 'Worker finished step');
    expect(delivery).toBe('queued');
    // Delivery from owner-authorized pair carries ownerMachineAuthority (either queued or flushed into _appendedTurnOrigins),
    // never poisoning Brain's active owner turn!
    expect(runtime.getActiveOwnerMachineAuthority()).toBe(ownerJwt);
    const queuedForTurn = runtime.pendingEntriesForResend.find((entry: { clientMessageId?: string }) =>
      entry.clientMessageId?.includes('tsk_live_owner:brain-needs_input'),
    );
    const appendedOrigins = ((runtime as any)._appendedTurnOrigins?.entries ?? []) as Array<{ ownerMachineAuthority?: string }>;
    expect(
      queuedForTurn?.ownerMachineAuthority === ownerJwt
      || (appendedOrigins.length > 0 && appendedOrigins.every((entry) => entry.ownerMachineAuthority === ownerJwt)),
    ).toBe(true);

    // Direct append with ownerMachineAuthority also preserves getActiveOwnerMachineAuthority().
    await runtime.appendExternalMessageToActiveTurn('Worker follow-up', 'direct-owner-append', undefined, undefined, {
      ownerMachineAuthority: ownerJwt,
    });
    expect(runtime.getActiveOwnerMachineAuthority()).toBe(ownerJwt);

    // Contrast: an unstamped pre-upgrade pair natively appends without ownerMachineAuthority and fails closed to null.
    store.savePair(PROJECT, {
      taskId: 'tsk_legacy_unstamped',
      title: 'Legacy unstamped pair',
      brain: BRAIN,
      executor: EXEC,
      auditor: AUDIT,
      status: 'working',
      round: 1,
      flags: [],
      flagSides: {},
      blocking: ['P0'],
      previousAuditors: [],
      capCounts: {},
      resourceClaims: [],
      createdAt: 11,
      updatedAt: 11,
    });
    await sendTaskPairMessage(BRAIN, 'tsk_legacy_unstamped', 'brain-needs_input', 'Legacy unstamped nudge');
    expect(runtime.getActiveOwnerMachineAuthority()).toBeNull();

    await runtime.kill();
  });

  it('binds process sessions safely without breaking non-participant owner or fail-closed participant delivery', async () => {
    const ownerJwt = 'eyJ.proc.owner.jwt';
    const partJwt = 'eyJ.proc.part.jwt';
    const procExec = sessionRecord(EXEC, 'w1', { runtimeType: 'process', agentType: 'claude-code', state: 'running' });
    mocks.sessions.set(BRAIN, sessionRecord(BRAIN, 'brain'));
    mocks.sessions.set(EXEC, procExec);

    const store = getTaskPairStore();
    store.savePair(PROJECT, {
      taskId: 'tsk_proc_owner',
      title: 'Process owner',
      brain: BRAIN,
      executor: EXEC,
      auditor: 'none',
      status: 'working',
      round: 1,
      flags: [],
      flagSides: {},
      blocking: [],
      previousAuditors: [],
      capCounts: {},
      resourceClaims: [],
      createdAt: 1,
      updatedAt: 1,
    });
    store.recordPrivateAuthority(PROJECT, 'tsk_proc_owner', { kind: 'owner', authority: ownerJwt });
    await sendTaskPairMessage(EXEC, 'tsk_proc_owner', 'pair-brief', 'Run check');
    expect(readProcessSharedMachineAuthority(EXEC, { sessionInstanceId: procExec.sessionInstanceId!, runtimeEpoch: procExec.runtimeEpoch! }))
      .toEqual({ required: false, actorKind: 'owner', authority: ownerJwt });

    clearProcessSharedMachineAuthoritiesForTests();
    store.savePair(PROJECT, {
      taskId: 'tsk_proc_part',
      title: 'Process participant',
      brain: BRAIN,
      executor: EXEC,
      auditor: 'none',
      status: 'working',
      round: 1,
      flags: [],
      flagSides: {},
      blocking: [],
      previousAuditors: [],
      capCounts: {},
      resourceClaims: [],
      createdAt: 2,
      updatedAt: 2,
    });
    store.recordPrivateAuthority(PROJECT, 'tsk_proc_part', { kind: 'participant', actorUserId: 'part-1', authority: partJwt });
    await sendTaskPairMessage(EXEC, 'tsk_proc_part', 'pair-brief', 'Run restricted check');
    // Participant pair uses deliveryMode='queue' (never auto-stops running process) and binds participant authority
    expect(mocks.processSend).toHaveBeenLastCalledWith(
      EXEC,
      'Run restricted check',
      expect.objectContaining({ deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE }),
    );
    expect(readProcessSharedMachineAuthority(EXEC, { sessionInstanceId: procExec.sessionInstanceId!, runtimeEpoch: procExec.runtimeEpoch! }))
      .toEqual({ required: true, authority: partJwt });
  });

  it('keeps participant pairs fail-closed, queues their deliveries, prevents upgrade to owner, and isolates aggregate notices', async () => {
    const partJwt = 'eyJ.participant.secret.jwt';
    const ownerJwt = 'eyJ.owner.should.never.upgrade';

    mocks.sessions.set(BRAIN, sessionRecord(BRAIN, 'brain'));
    mocks.sessions.set(EXEC, sessionRecord(EXEC, 'w1'));
    mocks.sessions.set(AUDIT, sessionRecord(AUDIT, 'w2'));
    mocks.runtimes.set(BRAIN, makeMockTransportRuntime(BRAIN, capturedSends, {
      participantActors: ['participant-u1'],
      participantAuthority: partJwt,
    }));
    mocks.runtimes.set(EXEC, makeMockTransportRuntime(EXEC, capturedSends));
    mocks.runtimes.set(AUDIT, makeMockTransportRuntime(AUDIT, capturedSends));

    const handlers = createMemoryMcpToolHandlers(callerOf(), {
      sendDeps: { listSessions: () => [...mocks.sessions.values()] },
    });

    const created = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]!({
      taskId: 'tsk_part_1',
      title: 'Participant pair',
      brief: '- [ ][ ] 1. Restricted work',
      executor: EXEC,
      auditor: AUDIT,
    }) as Record<string, unknown>;
    expect(created.status).toBe('ok');

    // Deliveries go through send (never append because deliveryMode='queue'), carry sharedActor + sharedMachineAuthority, and NO ownerMachineAuthority.
    const execSend = capturedSends.find((s) => s.target === EXEC);
    expect(execSend?.mode).toBe('send');
    expect(execSend?.metadata.ownerMachineAuthority).toBeUndefined();
    expect(execSend?.metadata.sharedMachineAuthority).toBe(partJwt);
    expect(execSend?.metadata.sharedActor).toMatchObject({ effectiveActorRole: 'participant', actorUserId: 'participant-u1' });

    // Switch Brain live runtime to an owner turn and invoke lifecycle updates — participant pair MUST NEVER upgrade to owner.
    mocks.runtimes.set(BRAIN, makeMockTransportRuntime(BRAIN, capturedSends, { ownerAuthority: ownerJwt }));
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_TASK_UPDATE]!({ taskId: 'tsk_part_1', markdown: '- [ ][ ] 1. Updated by owner' });
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_PAUSE]!({ taskId: 'tsk_part_1', mode: 'manual' });
    await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_RESUME]!({ taskId: 'tsk_part_1' });

    capturedSends.length = 0;
    await sendTaskPairMessage(EXEC, 'tsk_part_1', 'nudge-executor', 'Resumed ping');
    const nudgeSend = capturedSends.find((s) => s.target === EXEC);
    expect(nudgeSend?.mode).toBe('send');
    expect(nudgeSend?.metadata.ownerMachineAuthority).toBeUndefined();
    expect(nudgeSend?.metadata.sharedMachineAuthority).toBe(partJwt);
    expect(nudgeSend?.metadata.sharedActor).toMatchObject({ effectiveActorRole: 'participant', actorUserId: 'participant-u1' });

    // Verify ambiguous/null participant authority fails closed (no sharedMachineAuthority, still queued + sharedActor).
    getTaskPairStore().savePair(PROJECT, {
      taskId: 'tsk_part_null',
      title: 'Ambiguous participant pair',
      brain: BRAIN,
      executor: EXEC,
      auditor: 'none',
      status: 'working',
      round: 1,
      flags: [],
      flagSides: {},
      blocking: [],
      previousAuditors: [],
      capCounts: {},
      resourceClaims: [],
      createdAt: 15,
      updatedAt: 15,
    });
    getTaskPairStore().recordPrivateAuthority(PROJECT, 'tsk_part_null', {
      kind: 'participant',
      actorUserId: 'participant',
      authority: null,
    });
    capturedSends.length = 0;
    await sendTaskPairMessage(EXEC, 'tsk_part_null', 'nudge-executor', 'Ambiguous ping');
    expect(capturedSends[0]?.mode).toBe('send');
    expect(capturedSends[0]?.metadata.ownerMachineAuthority).toBeUndefined();
    expect(capturedSends[0]?.metadata.sharedMachineAuthority).toBeUndefined();
    expect(capturedSends[0]?.metadata.sharedActor).toMatchObject({ effectiveActorRole: 'participant', actorUserId: 'participant' });

    // Aggregate Brain notices: mixed owner + participant fails closed with ambiguous participant & queued delivery!
    getTaskPairStore().savePair(PROJECT, {
      taskId: 'tsk_owner_mix',
      title: 'Owner mix pair',
      brain: BRAIN,
      executor: 'deck_sub_other',
      auditor: 'none',
      status: 'working',
      round: 1,
      flags: [],
      flagSides: {},
      blocking: [],
      previousAuditors: [],
      capCounts: {},
      resourceClaims: [],
      createdAt: 20,
      updatedAt: 20,
    });
    getTaskPairStore().recordPrivateAuthority(PROJECT, 'tsk_owner_mix', { kind: 'owner', authority: ownerJwt, updatedAt: 500 });

    capturedSends.length = 0;
    const part1Epoch = getTaskPairStore().getPair(PROJECT, 'tsk_part_1')?.state.scheduling?.epoch ?? 0;
    await sendTaskPairMessage(
      BRAIN,
      '__aggregate__',
      'brain-heartbeat',
      'mixed digest',
      undefined,
      [
        { project: PROJECT, taskId: 'tsk_owner_mix', epoch: 0 },
        { project: PROJECT, taskId: 'tsk_part_1', epoch: part1Epoch },
      ],
    );
    expect(capturedSends[0]?.mode).toBe('send');
    expect(capturedSends[0]?.metadata.ownerMachineAuthority).toBeUndefined();
    expect(capturedSends[0]?.metadata.sharedMachineAuthority).toBeUndefined();
    expect(capturedSends[0]?.metadata.sharedActor).toMatchObject({ effectiveActorRole: 'participant', actorUserId: 'participant' });

    // Never expose JWTs in Brain / worker projections or timeline events.
    expect(JSON.stringify(mocks.timelineEvents)).not.toContain(partJwt);
    expect(JSON.stringify(mocks.timelineEvents)).not.toContain(ownerJwt);
  });

  it('captures stamped WS human feedback safely (participant stays participant even if owner field injected) and migrates/prunes legacy sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-legacy-mig-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'legacy-pairs.sqlite');

    // Create a pre-migration DB without task_pair_private_authority
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE task_pairs (
        project TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        brain TEXT NOT NULL,
        executor TEXT,
        auditor TEXT,
        queue_order INTEGER NOT NULL DEFAULT 0,
        legacy_task_id TEXT,
        state_json TEXT NOT NULL,
        liveness_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project, task_id)
      );
    `);
    const oldState = {
      taskId: 'tsk_old_done',
      title: 'Old terminal pair',
      brain: BRAIN,
      executor: EXEC,
      auditor: 'none',
      status: 'done',
      round: 1,
      flags: [],
      flagSides: {},
      blocking: [],
      previousAuditors: [],
      capCounts: {},
      resourceClaims: [],
      createdAt: 1,
      updatedAt: 1,
    };
    rawDb.prepare(`INSERT INTO task_pairs VALUES (?, ?, 'done', ?, ?, 'none', 1, NULL, ?, ?, 1)`).run(
      PROJECT, 'tsk_old_done', BRAIN, EXEC, JSON.stringify(oldState), JSON.stringify({
        silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1, progressAuditorAt: 1, lastTickAt: 1, notified: [],
      }),
    );
    rawDb.close();

    // Opening TaskPairStore migrates cleanly, keeps old pair, and allows unstamped delivery without crashing.
    const migrated = new TaskPairStore(dbPath);
    setTaskPairStoreForTests(migrated);
    expect(migrated.getPair(PROJECT, 'tsk_old_done')).toBeDefined();

    mocks.sessions.set(BRAIN, sessionRecord(BRAIN, 'brain'));
    mocks.runtimes.set(BRAIN, makeMockTransportRuntime(BRAIN, capturedSends));
    await expect(sendTaskPairMessage(BRAIN, 'tsk_old_done', 'brain-workspace-kept', 'Legacy kept')).resolves.toBe('queued');
    expect(capturedSends[0]?.metadata.ownerMachineAuthority).toBeUndefined();

    // Stamped WS feedback: participant stamp overrides any spurious ownerMachineAuthority field.
    const feedbackPair = {
      ...oldState,
      taskId: 'tsk_feedback',
      status: 'working' as const,
      flags: ['needs_input' as const],
      blockedNote: 'Clarify?',
    };
    migrated.savePair(PROJECT, feedbackPair);
    taskPairService.recordDecision({
      project: PROJECT,
      taskId: 'tsk_feedback',
      round: 1,
      kind: 'request',
      conclusion: 'Ask',
      summary: 'Need ruling',
      question: 'Proceed?',
      author: EXEC,
      idempotencyKey: 'req-fb-1',
    });
    await taskPairService.waitForIdle();
    capturedSends.length = 0;

    taskPairDecisionApi(
      { projectName: PROJECT, coordinatorSessionName: BRAIN },
      {
        type: TASK_PAIR_DECISION_MSG.FEEDBACK,
        taskId: 'tsk_feedback',
        requestId: 'fb-req-1',
        round: 1,
        revision: taskPairDecisionRevision(feedbackPair),
        questionId: getTaskPairStore().listDecisions(PROJECT, ['tsk_feedback'])[0]!.id,
        feedback: 'Use sandbox only',
        sharedActor: { effectiveActorRole: 'participant', actorUserId: 'ws-part-2' },
        [SHARED_MACHINE_AUTHORITY_FIELD]: 'ws-part-jwt-2',
        [OWNER_MACHINE_AUTHORITY_FIELD]: 'forged-owner-jwt',
      },
    );
    await taskPairService.waitForIdle();
    expect(capturedSends[0]?.mode).toBe('send');
    expect(capturedSends[0]?.metadata.ownerMachineAuthority).toBeUndefined();
    expect(capturedSends[0]?.metadata.sharedMachineAuthority).toBe('ws-part-jwt-2');
    expect(capturedSends[0]?.metadata.sharedActor).toMatchObject({ effectiveActorRole: 'participant', actorUserId: 'ws-part-2' });

    // Stamped owner feedback works on non-participant pairs, and prune() cleans private authority alongside pruned pairs.
    const ownerFbPair = { ...feedbackPair, taskId: 'tsk_owner_fb' };
    migrated.savePair(PROJECT, ownerFbPair);
    captureTaskPairCallerAuthority(PROJECT, 'tsk_owner_fb', undefined, {
      stamped: { [OWNER_MACHINE_AUTHORITY_FIELD]: 'stamped-owner-jwt' },
    });
    expect(migrated.getPrivateAuthority(PROJECT, 'tsk_owner_fb')).toMatchObject({ kind: 'owner', authority: 'stamped-owner-jwt' });

    migrated.recordPrivateAuthority(PROJECT, 'tsk_old_done', { kind: 'owner', authority: 'old-jwt-to-prune' });
    migrated.prune(Date.now());
    expect(migrated.getPair(PROJECT, 'tsk_old_done')).toBeUndefined();
    expect(migrated.getPrivateAuthority(PROJECT, 'tsk_old_done')).toBeUndefined();
    expect(getResendEntries(BRAIN)).toEqual([]);
  });
});
