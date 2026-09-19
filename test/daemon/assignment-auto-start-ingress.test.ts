/**
 * One runtime ingress for every transport provider:
 *   provider callback -> transport relay -> timeline -> supervision automation
 *   -> atomic assignment start.
 *
 * The provider adapters differ (Claude pre-execution gate, Codex app-server,
 * Qwen, Gemini ACP), but their activity reaches the daemon through the same
 * relay, so the delivery -> first activity -> auto-start contract is proven
 * once per provider family through that real chain.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sessions = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const runtimeState = vi.hoisted(() => ({ activeDispatch: [] as string[], generation: 7 }));
const stopSessionNowMock = vi.hoisted(() => vi.fn(() => true));
const escalateMock = vi.hoisted(() => vi.fn(async () => ({ status: 'waiting' })));

vi.mock('../../src/store/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/session-store.js')>();
  return {
    ...actual,
    getSession: (name: string) => sessions.get(name),
    listSessions: () => [...sessions.values()],
    upsertSession: vi.fn(),
    removeSession: vi.fn(),
  };
});
// No importOriginal here: the real session-manager imports the relay, and
// evaluating it inside this factory would bind the relay to the REAL routing
// table instead of this mock. The restart budget is unused by these paths.
vi.mock('../../src/agent/session-manager.js', () => {
  return {
    MAX_RESTARTS: 3,
    RESTART_WINDOW_MS: 5 * 60_000,
    ensureTransportRuntimeAvailable: vi.fn(async () => {}),
    persistSessionRecord: vi.fn(),
    resolveSessionName: (sid: string) => (sid.startsWith('ephemeral-') ? undefined : sid),
    isEphemeralProviderSid: (sid: string) => sid.startsWith('ephemeral-'),
    getTransportRuntime: vi.fn((sessionName: string) => ({
      send: vi.fn(() => 'sent'),
      pendingCount: 0,
      pendingEntries: [],
      get activeDispatchEntries() {
        return runtimeState.activeDispatch.map((clientMessageId) => ({ clientMessageId }));
      },
      getDiagnosticSnapshot: vi.fn(() => ({
        status: 'running', sending: true, pendingCount: 0, activeDispatchCount: 1, blockingWorkCount: 1,
        activeToolCount: 0, lastProviderOutputAt: 0, busyReasons: [],
        activityGeneration: { scope: 'session', sessionName, generation: runtimeState.generation },
      })),
    })),
  };
});
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(), listP2pRuns: vi.fn(() => []),
}));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/peer-audit-service.js', () => ({
  peerAuditService: { cancelAutomatic: vi.fn(), applyAutomaticConfiguration: vi.fn() },
}));
vi.mock('../../src/daemon/transport-history.js', () => ({ appendTransportEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/daemon/cc-presets.js', () => ({ getCachedPresetContextWindow: vi.fn() }));
vi.mock('../../src/daemon/command-handler.js', () => ({ stopSessionNow: stopSessionNowMock }));
vi.mock('../../src/daemon/send-tool.js', () => ({
  escalateImplementationBlocker: escalateMock,
  runSupervisionConvergenceTick: vi.fn(async () => undefined),
}));

const originalHome = process.env.HOME;
const originalProjectionPath = process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;
const testHome = await mkdtemp(path.join(os.tmpdir(), 'imcodes-auto-start-ingress-'));
process.env.HOME = testHome;
process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = path.join(testHome, '.imcodes', 'timeline.sqlite');

const { supervisionAutomation } = await import('../../src/daemon/supervision-automation.js');
const { wireProviderToRelay } = await import('../../src/daemon/transport-relay.js');
const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
const { getSupervisionTaskRegistry, resetSupervisionTaskRegistryForTests } = await import('../../src/daemon/supervision-state-store.js');
const { getDelegationReplyStore, resetDelegationReplyStoreForTests } = await import('../../src/daemon/delegation-reply-store.js');
const { getTransportQueueStore, resetTransportQueueStoreForTests } = await import('../../src/daemon/transport-queue-store.js');
const { clearAssignmentAutoStartStateForTests } = await import('../../src/daemon/assignment-auto-start.js');
const { clearNativeCollaborationGuardForTests } = await import('../../src/daemon/native-collaboration-guard.js');
const { resolvePeerAuditProviderFamily } = await import('../../src/daemon/peer-audit-candidates.js');
const { SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE, SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT } = await import('../../shared/supervision-assignment-start.js');

type ToolCallEvent = import('../../shared/agent-message.js').ToolCallEvent;
type MessageDelta = import('../../shared/agent-message.js').MessageDelta;
type TransportProvider = import('../../src/agent/transport-provider.js').TransportProvider;

const PROJECT = 'alpha';
const BRAIN = 'deck_alpha_brain';
const REVISION = 'rev-ingress';

const PROVIDERS = [
  { providerId: 'claude-code-sdk', agentType: 'claude-code-sdk', capabilities: { nativeCollaborationGate: 'pre_execution' } },
  { providerId: 'codex-sdk', agentType: 'codex-sdk', capabilities: {} },
  { providerId: 'qwen', agentType: 'qwen', capabilities: {} },
  { providerId: 'gemini-sdk', agentType: 'gemini-sdk', capabilities: {} },
] as const;

function workerSession(name: string, agentType: string, runtimeEpoch = `epoch-${name}`) {
  return {
    name, projectName: PROJECT, role: 'w1', agentType, runtimeType: 'transport', parentSession: BRAIN,
    sessionInstanceId: `instance-${name}`, runtimeEpoch, state: 'running', projectDir: `/work/${PROJECT}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  };
}

function identityOf(session: ReturnType<typeof workerSession>) {
  return {
    sessionName: session.name,
    sessionInstanceId: session.sessionInstanceId,
    runtimeEpoch: session.runtimeEpoch,
    agentType: session.agentType,
    providerFamily: resolvePeerAuditProviderFamily(session as never),
  };
}

function makeProvider(providerId: string, capabilities: Record<string, unknown>) {
  let toolCb: ((sid: string, tool: ToolCallEvent) => void) | undefined;
  let deltaCb: ((sid: string, delta: MessageDelta) => void) | undefined;
  const provider = {
    id: providerId,
    capabilities: { streaming: true, toolCalling: true, approval: false, sessionRestore: true, multiTurn: true, attachments: false, ...capabilities },
    onDelta: (cb: (sid: string, delta: MessageDelta) => void) => { deltaCb = cb; return () => {}; },
    onComplete: () => () => {},
    onError: () => () => {},
    onToolCall: (cb: (sid: string, tool: ToolCallEvent) => void) => { toolCb = cb; },
    setNativeCollaborationGate: () => {},
  } as unknown as TransportProvider;
  wireProviderToRelay(provider);
  return {
    tool: (sid: string, tool: ToolCallEvent) => toolCb?.(sid, tool),
    text: (sid: string, messageId: string, text: string) => deltaCb?.(sid, { messageId, type: 'text', delta: text, role: 'assistant' } as MessageDelta),
  };
}

/** A Brain-dispatched task exactly as send-tool leaves it before delivery. */
function dispatchTask(worker: ReturnType<typeof workerSession>, suffix: string, boundIdentity = identityOf(worker)) {
  const taskId = `tsk_ingress_${suffix}`;
  const assignmentId = `asg_ingress_${suffix}`;
  const messageId = `msg_ingress_${suffix}`;
  const registry = getSupervisionTaskRegistry();
  expect(registry.createOrGet({
    taskId, projectName: PROJECT, classification: 'independent_top_level', objective: `ingress ${suffix}`, currentRevision: REVISION,
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    assignmentId: `${assignmentId}_coord`, taskId, role: 'coordinator', required: false,
    identity: { sessionName: BRAIN, sessionInstanceId: 'instance-brain', runtimeEpoch: 'epoch-brain', agentType: 'codex-sdk', providerFamily: 'openai' },
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    assignmentId, taskId, role: 'implementer', identity: boundIdentity, auditRevision: REVISION, scopeFiles: ['src/a.ts'],
  })).toMatchObject({ ok: true });
  getDelegationReplyStore().create({
    origin: { sessionName: BRAIN, sessionInstanceId: 'instance-brain', runtimeEpoch: 'epoch-brain' },
    target: { sessionName: worker.name, sessionInstanceId: boundIdentity.sessionInstanceId, runtimeEpoch: boundIdentity.runtimeEpoch },
    dispatchId: `dispatch_${suffix}`, messageId, taskId, assignmentId, coordinatorAssignmentId: `${assignmentId}_coord`,
  });
  return { taskId, assignmentId, messageId };
}

const statusOf = (assignmentId: string) => getSupervisionTaskRegistry().getAssignment(assignmentId)?.status;
const autoStartEvents = (taskId: string) => getSupervisionTaskRegistry().listEvents(taskId)
  .filter((event) => event.payload?.source === SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE);

describe('assignment auto-start through the unified transport ingress', () => {
  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    clearNativeCollaborationGuardForTests();
    sessions.clear();
    sessions.set(BRAIN, {
      name: BRAIN, projectName: PROJECT, role: 'brain', agentType: 'codex-sdk', runtimeType: 'transport',
      sessionInstanceId: 'instance-brain', runtimeEpoch: 'epoch-brain', state: 'idle', projectDir: `/work/${PROJECT}`,
      restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    });
    runtimeState.activeDispatch = [];
    stopSessionNowMock.mockClear();
    escalateMock.mockClear();
    supervisionAutomation.init();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    process.env.HOME = originalHome;
    if (originalProjectionPath === undefined) delete process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;
    else process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = originalProjectionPath;
    // A store's debounced write (e.g. sqlite WAL checkpoint or session-store
    // save) can still be settling right as this runs, recreating an entry
    // mid-traversal and failing the final rmdir with ENOTEMPTY. Let Node
    // retry the recursive removal, matching the same real race already
    // handled this way in test/store/session-store.test.ts.
    await rm(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it.each(PROVIDERS)('$providerId: delivery -> first activity -> implementing, with no model start/claim', ({ providerId, agentType, capabilities }) => {
    const worker = workerSession(`deck_sub_alpha_${agentType.replace(/[^a-z]/g, '')}`, agentType);
    sessions.set(worker.name, worker);
    const provider = makeProvider(providerId, capabilities);
    const task = dispatchTask(worker, agentType.replace(/[^a-z]/g, ''));
    const emit = vi.spyOn(timelineEmitter, 'emit');

    // The session is busy with something else; the task is still queued.
    provider.tool(worker.name, { id: `${providerId}-unrelated`, name: 'Grep', status: 'running', input: { pattern: 'x' } });
    provider.text(worker.name, `${providerId}-m0`, 'still working on the previous request');
    expect(statusOf(task.assignmentId)).toBe('delegated');

    // The runtime hands the task message to the provider; its first output starts the task.
    runtimeState.activeDispatch = [task.messageId];
    provider.text(worker.name, `${providerId}-m1`, 'Starting on the retry queue.');
    expect(statusOf(task.assignmentId)).toBe('implementing');
    expect(getSupervisionTaskRegistry().get(task.taskId)?.status).toBe('implementing');
    expect(autoStartEvents(task.taskId)[0]!.payload).toMatchObject({
      evidence: 'provider_activity', signal: 'provider_assistant_output', deliveryMessageId: task.messageId,
    });
    expect(emit.mock.calls.some((call) => call[0] === BRAIN && call[1] === SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT))
      .toBe(true);

    // More activity, then a restarted daemon (fresh in-memory state, durable stores): one lifecycle edge only.
    provider.tool(worker.name, { id: `${providerId}-work`, name: 'Grep', status: 'running', input: { pattern: 'queue' } });
    clearAssignmentAutoStartStateForTests();
    clearNativeCollaborationGuardForTests();
    provider.text(worker.name, `${providerId}-m2`, 'Continuing after restart.');
    expect(autoStartEvents(task.taskId)).toHaveLength(2);
    expect(getSupervisionTaskRegistry().listAssignments(task.taskId)).toHaveLength(2);
  });

  it('never counts a provider-native collaboration agent as the participant executing its task', () => {
    const worker = workerSession('deck_sub_alpha_codex', 'codex-sdk');
    sessions.set(worker.name, worker);
    const provider = makeProvider('codex-sdk', {});
    const task = dispatchTask(worker, 'native');
    runtimeState.activeDispatch = [task.messageId];

    provider.tool(worker.name, {
      id: 'call-spawn', name: 'spawn_agent', status: 'running',
      detail: { kind: 'nativeCollaboration', summary: 'spawn_agent', raw: { type: 'function_call', name: 'spawn_agent', call_id: 'call-spawn', arguments: '{"message":"implement it"}' } },
    } as ToolCallEvent);
    provider.tool(worker.name, { id: 'call-spawn', name: 'tool', status: 'complete', output: 'native agent result' });
    expect(statusOf(task.assignmentId)).toBe('delegated');

    provider.tool(worker.name, { id: 'own-work', name: 'Grep', status: 'running', input: { pattern: 'retry' } });
    expect(statusOf(task.assignmentId)).toBe('implementing');
  });

  it('recovers an offline FIFO delivery drained into the live runtime after the identity rotated', () => {
    // qwen resumes by binding its route key, so that key is the provider conversation.
    const worker = { ...workerSession('deck_sub_alpha_fifo', 'qwen', 'epoch-live'), providerSessionId: 'qwen-conversation-live' };
    sessions.set(worker.name, worker);
    const provider = makeProvider('qwen', {});
    const task = dispatchTask(worker, 'fifo', { ...identityOf(worker), runtimeEpoch: 'epoch-before-provider-session' });
    // The queue drained the message into the live runtime; that turn is over.
    expect(getTransportQueueStore().recordDirectDelivery(worker.name, task.messageId, 'frame-fifo', Date.now(), {
      sessionInstanceId: worker.sessionInstanceId, runtimeEpoch: 'epoch-live',
    })).toBe(true);

    provider.tool(worker.name, { id: 'fifo-work', name: 'Grep', status: 'running', input: { pattern: 'fifo' } });
    expect(getSupervisionTaskRegistry().getAssignment(task.assignmentId)).toMatchObject({
      status: 'implementing', identity: identityOf(worker),
    });
  });

  it('never starts from a delivery into a conversation the live runtime has since reset, and reports it', async () => {
    const worker = { ...workerSession('deck_sub_alpha_reset', 'qwen', 'epoch-live'), providerSessionId: 'qwen-conversation-before-reset' };
    sessions.set(worker.name, worker);
    const provider = makeProvider('qwen', {});
    const task = dispatchTask(worker, 'reset', { ...identityOf(worker), runtimeEpoch: 'epoch-before-reset' });
    expect(getTransportQueueStore().recordDirectDelivery(worker.name, task.messageId, 'frame-reset', Date.now(), {
      sessionInstanceId: worker.sessionInstanceId, runtimeEpoch: 'epoch-live',
    })).toBe(true);
    // A fresh conversation replaces the one that received the task.
    sessions.set(worker.name, { ...worker, providerSessionId: 'qwen-conversation-after-reset' });

    provider.tool(worker.name, { id: 'reset-work', name: 'Grep', status: 'running', input: { pattern: 'unrelated' } });
    expect(statusOf(task.assignmentId)).toBe('delegated');
    await vi.waitFor(() => expect(escalateMock).toHaveBeenCalledOnce());
    expect(escalateMock.mock.calls[0]![0]).toMatchObject({
      taskId: task.taskId, assignmentId: task.assignmentId, eligibleStatus: 'delegated',
      exactError: expect.stringContaining('delivered_to_replaced_runtime'),
    });
    expect(stopSessionNowMock).not.toHaveBeenCalled();
  });

  it('fails closed through the same ingress: refuses, reports, and stops the turn carrying the task', async () => {
    const worker = workerSession('deck_sub_alpha_gemini', 'gemini-sdk');
    sessions.set(worker.name, worker);
    const provider = makeProvider('gemini-sdk', {});
    const task = dispatchTask(worker, 'refused');
    expect(getSupervisionTaskRegistry().updateTask({ taskId: task.taskId, currentRevision: 'rev-moved' })).toMatchObject({ ok: true });
    runtimeState.activeDispatch = [task.messageId];

    provider.text(worker.name, 'gemini-refused', 'Working on the stale revision.');
    expect(statusOf(task.assignmentId)).toBe('delegated');
    await vi.waitFor(() => expect(escalateMock).toHaveBeenCalledOnce());
    expect(escalateMock.mock.calls[0]![0]).toMatchObject({
      taskId: task.taskId, assignmentId: task.assignmentId, eligibleStatus: 'delegated',
      exactError: expect.stringContaining('revision_superseded'),
    });
    await vi.waitFor(() => expect(stopSessionNowMock).toHaveBeenCalledExactlyOnceWith(worker.name));
  });

  it('ignores activity that predates the dispatch, even when replayed after delivery', () => {
    const worker = workerSession('deck_sub_alpha_replay', 'codex-sdk');
    sessions.set(worker.name, worker);
    const task = dispatchTask(worker, 'replay');
    runtimeState.activeDispatch = [task.messageId];
    const createdAt = getSupervisionTaskRegistry().getAssignment(task.assignmentId)!.createdAt;
    timelineEmitter.emit(worker.name, 'tool.call', { toolCallId: 'older-call', tool: 'Grep', input: {} }, {
      source: 'daemon', confidence: 'high', eventId: 'older-call', ts: createdAt - 1_000,
    });
    expect(statusOf(task.assignmentId)).toBe('delegated');
  });

  it('ignores activity from a stale runtime generation', () => {
    const worker = workerSession('deck_sub_alpha_stale', 'codex-sdk');
    sessions.set(worker.name, worker);
    const task = dispatchTask(worker, 'stale');
    runtimeState.activeDispatch = [task.messageId];
    timelineEmitter.emit(worker.name, 'tool.call', {
      toolCallId: 'stale-call', tool: 'Grep', input: {},
      activityGeneration: { scope: 'session', sessionName: worker.name, generation: runtimeState.generation - 1 },
    }, { source: 'daemon', confidence: 'high', eventId: 'stale-call' });
    expect(statusOf(task.assignmentId)).toBe('delegated');
  });
});
