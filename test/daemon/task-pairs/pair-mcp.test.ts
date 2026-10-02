import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { getTaskPairStore, setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';

const PROJECT = 'pair-mcp-project';
const BRAIN = 'deck_pair_mcp_brain';
const EXEC = 'deck_sub_pair_mcp_exec';
const AUD = 'deck_sub_pair_mcp_aud';

const caller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: PROJECT } as ContextNamespace,
  sessionName: BRAIN, projectName: PROJECT, projectRoot: '/tmp/pair-mcp', serverId: 'srv', transport: 'in_process',
};

function session(name: string, role: SessionRecord['role'], state: SessionRecord['state'] = 'idle'): SessionRecord {
  return { name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir: '/tmp/pair-mcp', state, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2 } as SessionRecord;
}

function pair(taskId: string, status: TaskPairState['status']): TaskPairState {
  return { taskId, brain: BRAIN, executor: EXEC, auditor: AUD, title: taskId, status, flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 1, createdAt: 10, updatedAt: 20 };
}

describe('pair MCP projections', () => {
  beforeEach(() => setTaskPairStoreForTests(new TaskPairStore(':memory:')));
  afterEach(() => setTaskPairStoreForTests(undefined));

  it('lists running and queued pairs and gets one pair with recent events', async () => {
    getTaskPairStore().savePair(PROJECT, pair('running-1', 'working'));
    getTaskPairStore().savePair(PROJECT, pair('queued-1', 'queued'));
    getTaskPairStore().recordEvent({ id: 'evt-1', project: PROJECT, taskId: 'running-1', writer: BRAIN, role: 'brain', verb: 'DISPATCH', attrs: {}, effect: 'created', unusual: false, source: 'marker', at: 20 });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    const listed = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_LIST]({});
    expect(listed.status).toBe('ok');
    const listedPairs = listed.pairs as Array<Record<string, unknown>>;
    expect(listedPairs.find((item) => item.taskId === 'running-1')).toMatchObject({ executor: { session: EXEC, state: 'idle' }, executorModel: null, auditorModel: null });
    expect(listedPairs.find((item) => item.taskId === 'queued-1')).toMatchObject({ status: 'queued', queuePosition: expect.any(Number) });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId: 'running-1' })).resolves.toMatchObject({
      status: 'ok', pair: { taskId: 'running-1', brief: null, events: [expect.objectContaining({ id: 'evt-1' })] },
    });
  });

  it('orders pair_list queue positions urgent-first, matching what the scheduler will start next', async () => {
    getTaskPairStore().savePair(PROJECT, pair('normal-1', 'queued'));
    getTaskPairStore().savePair(PROJECT, pair('normal-2', 'queued'));
    getTaskPairStore().savePair(PROJECT, { ...pair('urgent-1', 'queued'), urgent: true });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });

    const listed = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_LIST]({});
    const listedPairs = listed.pairs as Array<Record<string, unknown>>;
    const queuedOrder = listedPairs.filter((item) => item.status === 'queued').map((item) => item.taskId);
    expect(queuedOrder).toEqual(['urgent-1', 'normal-1', 'normal-2']);
    expect(listedPairs.find((item) => item.taskId === 'urgent-1')).toMatchObject({ queuePosition: 1 });
    expect(listedPairs.find((item) => item.taskId === 'normal-1')).toMatchObject({ queuePosition: 2 });
    expect(listedPairs.find((item) => item.taskId === 'normal-2')).toMatchObject({ queuePosition: 3 });

    const gotUrgent = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId: 'urgent-1' });
    expect(gotUrgent).toMatchObject({ status: 'ok', pair: { queuePosition: 1 } });
    const gotNormal2 = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId: 'normal-2' });
    expect(gotNormal2).toMatchObject({ status: 'ok', pair: { queuePosition: 3 } });
  });

  it('persists the Brain queue limit through pair MCP tools', async () => {
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain')] } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_SET_MAX_CONCURRENCY]({ maxConcurrency: 7 })).resolves.toEqual({ status: 'ok', requestedMaxConcurrency: 7, maxConcurrency: 7, effectiveMaxConcurrency: 7 });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET_MAX_CONCURRENCY]({})).resolves.toEqual({ status: 'ok', maxConcurrency: 7 });
  });

  it('projects requested role models and the explicit no-audit value for queued work', async () => {
    getTaskPairStore().savePair(PROJECT, {
      ...pair('models-1', 'queued'), executor: undefined, auditor: 'none',
      executorModel: 'gpt-6-luna', auditorModel: undefined,
    });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain')] } });
    const listed = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_LIST]({});
    expect((listed.pairs as Array<Record<string, unknown>>)[0]).toMatchObject({ executorModel: 'gpt-6-luna', auditorModel: 'none' });
  });

  it('lets the project Brain set a title without replacing the brief', async () => {
    getTaskPairStore().savePair(PROJECT, { ...pair('title-1', 'queued'), title: '(untitled task)', brief: 'Fix the retry path.' });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_TASK_UPDATE]({ taskId: 'title-1', title: 'Fix retry backoff' })).resolves.toMatchObject({
      taskId: 'title-1', title: 'Fix retry backoff', markdown: 'Fix the retry path.',
    });
    expect(getTaskPairStore().getPair(PROJECT, 'title-1')?.state.brief).toBe('Fix the retry path.');
  });

  it('lets current executor and auditor read pair_get while rejecting same-project nonparticipants explicitly', async () => {
    getTaskPairStore().savePair(PROJECT, pair('participant-read', 'working'));
    const sessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2'), session('sibling', 'w3')];
    const executorHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: EXEC }, { sendDeps: { listSessions: sessions } });
    await expect(executorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId: 'participant-read' })).resolves.toMatchObject({
      status: 'ok', pair: { taskId: 'participant-read' },
    });
    await expect(executorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_TASK_GET]({ taskId: 'participant-read' })).resolves.toMatchObject({
      status: 'working', taskId: 'participant-read',
    });
    const siblingHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: 'sibling' }, { sendDeps: { listSessions: sessions } });
    await expect(siblingHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId: 'participant-read' })).resolves.toMatchObject({
      status: 'error', reason: 'scope_forbidden', message: expect.stringContaining('current pair participant'),
    });
    await expect(siblingHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_TASK_GET]({ taskId: 'participant-read' })).resolves.toMatchObject({
      status: 'error', reason: 'scope_forbidden', message: expect.stringContaining('current pair participant'),
    });
  });

  it('creates a structured pair once and rejects stopped targets before persistence', async () => {
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const brain = session(BRAIN, 'brain');
    const exec = session(EXEC, 'w1');
    const stopped = session('deck_sub_pair_mcp_stopped', 'w3', 'stopped');
    upsertSession(brain); upsertSession(exec); upsertSession(stopped);
    const sent: string[] = [];
    setTaskPairDeliveryDepsForTests({ send: async (target) => { sent.push(target); } });
    try {
      const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [brain, exec, stopped] } });
      const created = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        brief: '# Structured brief\n- [ ][ ] verify replay', executor: EXEC, auditor: 'none',
        title: '结构化创建', idempotencyKey: 'create-once',
      });
      expect(created).toMatchObject({ status: 'ok', idempotentReplay: false, created: true, taskId: expect.any(String) });
      const taskId = String(created.taskId);
      expect(getTaskPairStore().getPair(PROJECT, taskId)?.state.brief).toContain('verify replay');
      const replay = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        brief: '# Structured brief\n- [ ][ ] verify replay', executor: EXEC, auditor: 'none', idempotencyKey: 'create-once',
      });
      expect(replay).toMatchObject({ status: 'ok', taskId, idempotentReplay: true, deliveries: [] });
      const rejected = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({ brief: 'bad', executor: 'deck_sub_pair_mcp_stopped', auditor: 'none', idempotencyKey: 'stopped' });
      expect(rejected).toMatchObject({ status: 'error', reason: 'control_plane_unavailable' });
      expect(getTaskPairStore().listActivePairs().some((item) => item.state.executor === 'deck_sub_pair_mcp_stopped')).toBe(false);
      expect(sent).not.toContain('deck_sub_pair_mcp_stopped');
    } finally {
      setTaskPairDeliveryDepsForTests(undefined);
      removeSession(BRAIN); removeSession(EXEC); removeSession('deck_sub_pair_mcp_stopped');
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    }
  });

  it('dispatches an existing queued pair with a durable replay event', async () => {
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const brain = session(BRAIN, 'brain');
    const exec = session(EXEC, 'w1');
    const aud = session(AUD, 'w2');
    upsertSession(brain); upsertSession(exec); upsertSession(aud);
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    const taskId = 'queued-structured-dispatch';
    getTaskPairStore().savePair(PROJECT, { ...pair(taskId, 'queued'), brief: 'queued brief' });
    try {
      const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [brain, exec, aud] } });
      const first = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_DISPATCH]({ taskId, idempotencyKey: 'dispatch-once' });
      expect(first).toMatchObject({ status: 'ok', taskId, idempotentReplay: false });
      const second = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_DISPATCH]({ taskId, idempotencyKey: 'dispatch-once' });
      expect(second).toMatchObject({ status: 'ok', taskId, idempotentReplay: true, deliveries: [] });
      expect(getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === 'PAIR_DISPATCH')).toHaveLength(1);
    } finally {
      setTaskPairDeliveryDepsForTests(undefined);
      removeSession(BRAIN); removeSession(EXEC); removeSession(AUD);
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    }
  });

  it('queues a running target without interrupting its active turn', async () => {
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const brain = session(BRAIN, 'brain');
    const running = session(EXEC, 'w1', 'running');
    upsertSession(brain); upsertSession(running);
    try {
      const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [brain, running] } });
      const result = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({ brief: 'do not interrupt', executor: EXEC, auditor: 'none', idempotencyKey: 'busy-queue' });
      expect(result).toMatchObject({ status: 'ok', state: 'queued' });
      expect(getTaskPairStore().listActivePairs()[0]?.state.status).toBe('queued');
    } finally {
      removeSession(BRAIN); removeSession(EXEC);
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    }
  });

  it('closes through the shared marker state machine and replays idempotently', async () => {
    const taskId = 'structured-close';
    upsertSession(session(BRAIN, 'brain')); upsertSession(session(EXEC, 'w1'));
    getTaskPairStore().savePair(PROJECT, { ...pair(taskId, 'working'), auditor: 'none' });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1')] } });
    const first = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId, action: 'done', idempotencyKey: 'close-once' });
    expect(first).toMatchObject({ status: 'ok', taskId, state: 'done', effect: 'status', idempotentReplay: false });
    const second = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId, action: 'done', idempotencyKey: 'close-once' });
    expect(second).toMatchObject({ status: 'ok', taskId, state: 'done', idempotentReplay: true });
    expect(getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === 'DONE')).toHaveLength(1);
    removeSession(BRAIN); removeSession(EXEC);
  });

  it('enforces Brain-only reassignment and persists the REASSIGN effect', async () => {
    const taskId = 'structured-reassign';
    const replacement = 'deck_sub_pair_mcp_exec2';
    upsertSession(session(BRAIN, 'brain')); upsertSession(session(EXEC, 'w1')); upsertSession(session(AUD, 'w2')); upsertSession(session(replacement, 'w3'));
    getTaskPairStore().savePair(PROJECT, pair(taskId, 'working'));
    const sessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2'), session(replacement, 'w3')];
    const executorHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: EXEC }, { sendDeps: { listSessions: sessions } });
    await expect(executorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN]({ taskId, executor: replacement })).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: sessions } });
    const reassigned = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN]({ taskId, executor: replacement, idempotencyKey: 'reassign-once' }); expect(reassigned).toMatchObject({ status: 'ok', taskId, effect: 'reassigned' });
    expect(getTaskPairStore().getPair(PROJECT, taskId)?.state.executor).toBe(replacement);
    removeSession(BRAIN); removeSession(EXEC); removeSession(AUD); removeSession(replacement);
  });

  it('opens only a passed next round and applies auditor verdicts to material-backed rounds', async () => {
    const nextRoundId = 'structured-next-round';
    upsertSession(session(BRAIN, 'brain')); upsertSession(session(EXEC, 'w1')); upsertSession(session(AUD, 'w2'));
    getTaskPairStore().savePair(PROJECT, { ...pair(nextRoundId, 'passed'), material: { path: '/tmp/pair-mcp', head: 'abcdef1', at: 30 }, passRound: 1 });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    const next = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]({ taskId: nextRoundId, base: 'abcdef1', note: 'round two', idempotencyKey: 'next-once' }); expect(next).toMatchObject({ status: 'ok', taskId: nextRoundId, state: 'working', effect: 'next_round' });

    const verdictId = 'structured-verdict';
    getTaskPairStore().savePair(PROJECT, { ...pair(verdictId, 'in_audit'), material: { path: '/tmp/pair-mcp', head: 'abcdef1', at: 30 }, round: 1 });
    const auditorHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: AUD }, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    await expect(auditorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT]({ taskId: verdictId, verdict: 'PASS', idempotencyKey: 'verdict-once' })).resolves.toMatchObject({ status: 'ok', taskId: verdictId, state: 'passed', effect: 'verdict', judgement: 'implicit_zero', counts: { P0: 0 } });
    const replay = await auditorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT]({ taskId: verdictId, verdict: 'PASS', idempotencyKey: 'verdict-once' });
    expect(replay).toMatchObject({ status: 'ok', idempotentReplay: true, state: 'passed' });
    removeSession(BRAIN); removeSession(EXEC); removeSession(AUD);
  });

  it('rejects unknown/terminal or wrong-state lifecycle requests and releases claims once on cancel', async () => {
    upsertSession(session(BRAIN, 'brain')); upsertSession(session(EXEC, 'w1')); upsertSession(session(AUD, 'w2'));
    const cancelId = 'structured-cancel';
    getTaskPairStore().savePair(PROJECT, pair(cancelId, 'working'));
    expect(taskPairService.claimResource({ project: PROJECT, taskId: cancelId, owner: EXEC, resource: 'port:43123', mode: 'exclusive', ttlMs: 60000 }).ok).toBe(true);
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: 'missing', action: 'cancel' })).resolves.toMatchObject({ status: 'error', reason: 'projection_unavailable' });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: cancelId, action: 'cancel', idempotencyKey: 'cancel-once' })).resolves.toMatchObject({ status: 'ok', state: 'cancelled', effect: 'status' });
    expect(getTaskPairStore().getPair(PROJECT, cancelId)?.state.resourceClaims).toEqual([]);
    expect(getTaskPairStore().getPair(PROJECT, cancelId)?.state.resourceCleanup?.resources).toEqual(['port:43123']);
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: cancelId, action: 'cancel', idempotencyKey: 'cancel-again' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });

    const wrongState = 'structured-wrong-state';
    getTaskPairStore().savePair(PROJECT, pair(wrongState, 'working'));
    const auditorHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: AUD }, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    await expect(auditorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT]({ taskId: wrongState, verdict: 'PASS' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]({ taskId: wrongState })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    removeSession(BRAIN); removeSession(EXEC); removeSession(AUD);
  });

});
