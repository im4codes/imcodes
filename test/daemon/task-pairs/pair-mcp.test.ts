import { putTaskPairFixture } from '../../helpers/task-pair-fixture.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../../shared/memory-mcp-errors.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { getTaskPairStore, setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { defaultHasActiveSupervisionLease, provisionSupervisionTarget } from '../../../src/daemon/supervision-auto-provision.js';
import { listTaskPairCandidates } from '../../../src/daemon/task-pairs/pool.js';
import { setPairSessionCreationDepsForTests } from '../../../src/daemon/task-pairs/session-creation.js';
import { setTaskPairWorkspaceDepsForTests } from '../../../src/daemon/task-pairs/workspace.js';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../../shared/supervision-config.js';

const PROJECT = 'pair-mcp-project';
const BRAIN = 'deck_pair_mcp_brain';
const EXEC = 'deck_sub_pair_mcp_exec';
const AUD = 'deck_sub_pair_mcp_aud';

const caller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: PROJECT } as ContextNamespace,
  sessionName: BRAIN, projectName: PROJECT, projectRoot: '/tmp/pair-mcp', serverId: 'srv', transport: 'in_process',
};

function session(name: string, role: SessionRecord['role'], state: SessionRecord['state'] = 'idle'): SessionRecord {
  return { name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir: '/tmp/pair-mcp', state, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2, sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}` } as SessionRecord;
}

function pair(taskId: string, status: TaskPairState['status']): TaskPairState {
  return { taskId, brain: BRAIN, executor: EXEC, auditor: AUD, title: taskId, status, flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 1, createdAt: 10, updatedAt: 20 };
}

describe('pair MCP projections', () => {
  beforeEach(() => setTaskPairStoreForTests(new TaskPairStore(':memory:')));
  afterEach(() => setTaskPairStoreForTests(undefined));

  it('lists running and queued pairs and gets one pair with recent events', async () => {
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair('running-1', 'working'));
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair('queued-1', 'queued'));
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

  it('reads pair_history for both roles or one role and reports a missing auditor', async () => {
    const taskId = 'history-1';
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair(taskId, 'working'));
    const sessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')];
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: sessions } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_HISTORY]({ taskId })).resolves.toMatchObject({
      status: 'ok', taskId, kind: 'text', requested: 20,
      participants: [
        { role: 'executor', session: EXEC, status: 'ok', count: 0, messages: [] },
        { role: 'auditor', session: AUD, status: 'ok', count: 0, messages: [] },
      ],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_HISTORY]({ taskId, role: 'executor', kind: 'tool', limit: 3 })).resolves.toMatchObject({
      status: 'ok', participants: [{ role: 'executor', session: EXEC, kind: 'tool', requested: 3, events: [] }],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_HISTORY]({ taskId, kind: 'summary', limit: 2 })).resolves.toMatchObject({
      status: 'ok', participants: [{ role: 'executor', kind: 'summary', requested: 2, items: [] }, { role: 'auditor', kind: 'summary', requested: 2, items: [] }],
    });
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair('history-none', 'done'), auditor: 'none' });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_HISTORY]({ taskId: 'history-none', role: 'auditor' })).resolves.toMatchObject({
      status: 'ok', participants: [{ role: 'auditor', session: null, status: 'missing', requested: 20, messages: [] }],
    });
  });

  it('keeps pair_history Brain-only and rejects invalid bounds or unknown tasks', async () => {
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair('history-auth', 'working'));
    const sessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')];
    const executorHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: EXEC }, { sendDeps: { listSessions: sessions } });
    await expect(executorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_HISTORY]({ taskId: 'history-auth' })).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: sessions } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_HISTORY]({ taskId: 'missing' })).resolves.toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_HISTORY]({ taskId: 'history-auth', limit: 201 })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_HISTORY]({ taskId: 'history-auth', kind: 'invalid' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
  });

  it('orders pair_list queue positions urgent-first, matching what the scheduler will start next', async () => {
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair('normal-1', 'queued'));
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair('normal-2', 'queued'));
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair('urgent-1', 'queued'), urgent: true });
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
    putTaskPairFixture(getTaskPairStore(), PROJECT, {
      ...pair('models-1', 'queued'), executor: undefined, auditor: 'none',
      executorModel: 'gpt-6-luna', auditorModel: undefined,
    });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain')] } });
    const listed = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_LIST]({});
    expect((listed.pairs as Array<Record<string, unknown>>)[0]).toMatchObject({ executorModel: 'gpt-6-luna', auditorModel: 'none' });
  });

  it('lets the project Brain set a title without replacing the brief', async () => {
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair('title-1', 'queued'), title: '(untitled task)', brief: 'Fix the retry path.' });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_TASK_UPDATE]({ taskId: 'title-1', title: 'Fix retry backoff' })).resolves.toMatchObject({
      taskId: 'title-1', title: 'Fix retry backoff', markdown: 'Fix the retry path.',
    });
    expect(getTaskPairStore().getPair(PROJECT, 'title-1')?.state.brief).toBe('Fix the retry path.');
  });

  it('lets current executor and auditor read pair_get while rejecting same-project nonparticipants explicitly', async () => {
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair('participant-read', 'working'));
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
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair(taskId, 'queued'), brief: 'queued brief' });
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
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair(taskId, 'working'), auditor: 'none' });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1')] } });
    const first = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId, action: 'done', idempotencyKey: 'close-once' });
    expect(first).toMatchObject({ status: 'ok', taskId, state: 'done', effect: 'status', idempotentReplay: false });
    const second = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId, action: 'done', idempotencyKey: 'close-once' });
    expect(second).toMatchObject({ status: 'ok', taskId, state: 'done', idempotentReplay: true });
    expect(getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === 'DONE')).toHaveLength(1);
    removeSession(BRAIN); removeSession(EXEC);
  });

  it('makes plain pair_close(action=done) idempotent on already-done pairs while preserving cancel, output/dest, and scope guards', async () => {
    const doneByExecId = 'already-done-by-exec';
    const cancelledId = 'already-cancelled';
    upsertSession(session(BRAIN, 'brain')); upsertSession(session(EXEC, 'w1'));
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair(doneByExecId, 'done'), executor: EXEC });
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair(cancelledId, 'cancelled'), executor: EXEC });
    const sessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w1')];
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: sessions } });

    // Plain done without idempotencyKey succeeds idempotently (even after executor DONE).
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: doneByExecId, action: 'done' })).resolves.toMatchObject({
      status: 'ok', taskId: doneByExecId, state: 'done', effect: 'noop', idempotentReplay: true,
    });
    // Plain done with a new idempotencyKey also succeeds idempotently.
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: doneByExecId, action: 'done', idempotencyKey: 'late-brain-done' })).resolves.toMatchObject({
      status: 'ok', taskId: doneByExecId, state: 'done', effect: 'noop', idempotentReplay: true,
    });
    // output / dest / invalid integration remain rejected on already-done pairs unless replaying exact eventKey.
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: doneByExecId, action: 'done', output: 'dist/out.txt' })).resolves.toMatchObject({
      status: 'error', reason: 'validation_failed',
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: doneByExecId, action: 'done', dest: 'out.txt' })).resolves.toMatchObject({
      status: 'error', reason: 'validation_failed',
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: doneByExecId, action: 'done', integration: 'keep' })).resolves.toMatchObject({
      status: 'error', reason: 'validation_failed',
    });
    // action=cancel on done and action=done on cancelled remain rejected.
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: doneByExecId, action: 'cancel' })).resolves.toMatchObject({
      status: 'error', reason: 'validation_failed',
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: cancelledId, action: 'done' })).resolves.toMatchObject({
      status: 'error', reason: 'validation_failed',
    });
    // integration=dismiss on done still works and records dismissal.
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: doneByExecId, action: 'done', integration: 'dismiss' })).resolves.toMatchObject({
      status: 'ok', taskId: doneByExecId, state: 'done',
    });
    expect(getTaskPairStore().getPair(PROJECT, doneByExecId)?.state.integrationDismissedAt).toBeDefined();
    // Non-Brain session remains rejected even on already-done pairs.
    const execHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: EXEC }, { sendDeps: { listSessions: sessions } });
    await expect(execHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: doneByExecId, action: 'done' })).resolves.toMatchObject({
      status: 'error', reason: 'scope_forbidden',
    });
    removeSession(BRAIN); removeSession(EXEC);
  });

  it('enforces Brain-only reassignment and persists the REASSIGN effect', async () => {
    const taskId = 'structured-reassign';
    const replacement = 'deck_sub_pair_mcp_exec2';
    upsertSession(session(BRAIN, 'brain')); upsertSession(session(EXEC, 'w1')); upsertSession(session(AUD, 'w2')); upsertSession(session(replacement, 'w3'));
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair(taskId, 'working'));
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
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair(nextRoundId, 'passed'), material: { path: '/tmp/pair-mcp', head: 'abcdef1', at: 30 }, passRound: 1 });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    const next = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]({ taskId: nextRoundId, base: 'abcdef1', note: 'round two', idempotencyKey: 'next-once' }); expect(next).toMatchObject({ status: 'ok', taskId: nextRoundId, state: 'working', effect: 'next_round' });

    const verdictId = 'structured-verdict';
    putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair(verdictId, 'in_audit'), material: { path: '/tmp/pair-mcp', head: 'abcdef1', at: 30 }, round: 1 });
    const auditorHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: AUD }, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    await expect(auditorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT]({ taskId: verdictId, verdict: 'PASS', idempotencyKey: 'verdict-once' })).resolves.toMatchObject({ status: 'ok', taskId: verdictId, state: 'passed', effect: 'verdict', judgement: 'implicit_zero', counts: { P0: 0 } });
    const replay = await auditorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT]({ taskId: verdictId, verdict: 'PASS', idempotencyKey: 'verdict-once' });
    expect(replay).toMatchObject({ status: 'ok', idempotentReplay: true, state: 'passed' });
    removeSession(BRAIN); removeSession(EXEC); removeSession(AUD);
  });

  it('replays reassignment and next-round requests after a later terminal close', async () => {
    upsertSession(session(BRAIN, 'brain')); upsertSession(session(EXEC, 'w1')); upsertSession(session(AUD, 'w2'));
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    const replacement = 'deck_sub_pair_mcp_exec2';
    upsertSession(session(replacement, 'w3'));
    try {
      const reassignId = 'structured-reassign-terminal-replay';
      putTaskPairFixture(getTaskPairStore(), PROJECT, pair(reassignId, 'working'));
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN]({ taskId: reassignId, executor: replacement, idempotencyKey: 'reassign-terminal-replay' })).resolves.toMatchObject({ status: 'ok', effect: 'reassigned', idempotentReplay: false });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: reassignId, action: 'done', force: true, idempotencyKey: 'close-after-reassign' })).resolves.toMatchObject({ status: 'ok', state: 'done' });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN]({ taskId: reassignId, executor: replacement, idempotencyKey: 'reassign-terminal-replay' })).resolves.toMatchObject({ status: 'ok', state: 'done', idempotentReplay: true });
      expect(getTaskPairStore().listEvents(PROJECT, reassignId).filter((event) => event.verb === 'REASSIGN')).toHaveLength(1);

      const nextRoundId = 'structured-next-round-terminal-replay';
      putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair(nextRoundId, 'passed'), material: { path: '/tmp/pair-mcp', head: 'abcdef1', at: 30 }, passRound: 1 });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]({ taskId: nextRoundId, base: 'abcdef1', note: 'round two', idempotencyKey: 'next-terminal-replay' })).resolves.toMatchObject({ status: 'ok', effect: 'next_round', idempotentReplay: false });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: nextRoundId, action: 'done', force: true, idempotencyKey: 'close-after-next-round' })).resolves.toMatchObject({ status: 'ok', state: 'done' });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]({ taskId: nextRoundId, base: 'abcdef1', note: 'round two', idempotencyKey: 'next-terminal-replay' })).resolves.toMatchObject({ status: 'ok', state: 'done', idempotentReplay: true });
      expect(getTaskPairStore().listEvents(PROJECT, nextRoundId).filter((event) => event.verb === 'NEXT_ROUND')).toHaveLength(1);
    } finally {
      removeSession(BRAIN); removeSession(EXEC); removeSession(AUD); removeSession(replacement);
    }
  });

  it('rejects unknown/terminal or wrong-state lifecycle requests and releases claims once on cancel', async () => {
    upsertSession(session(BRAIN, 'brain')); upsertSession(session(EXEC, 'w1')); upsertSession(session(AUD, 'w2'));
    const cancelId = 'structured-cancel';
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair(cancelId, 'working'));
    expect(taskPairService.claimResource({ project: PROJECT, taskId: cancelId, owner: EXEC, resource: 'port:43123', mode: 'exclusive', ttlMs: 60000 }).ok).toBe(true);
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: 'missing', action: 'cancel' })).resolves.toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: cancelId, action: 'cancel', idempotencyKey: 'cancel-once' })).resolves.toMatchObject({ status: 'ok', state: 'cancelled', effect: 'status' });
    expect(getTaskPairStore().getPair(PROJECT, cancelId)?.state.resourceClaims).toEqual([]);
    expect(getTaskPairStore().getPair(PROJECT, cancelId)?.state.resourceCleanup?.resources).toEqual(['port:43123']);
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: cancelId, action: 'cancel', idempotencyKey: 'cancel-again' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });

    const wrongState = 'structured-wrong-state';
    putTaskPairFixture(getTaskPairStore(), PROJECT, pair(wrongState, 'working'));
    const auditorHandlers = createMemoryMcpToolHandlers({ ...caller, sessionName: AUD }, { sendDeps: { listSessions: () => [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')] } });
    await expect(auditorHandlers[MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT]({ taskId: wrongState, verdict: 'PASS' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]({ taskId: wrongState })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    removeSession(BRAIN); removeSession(EXEC); removeSession(AUD);
  });

  it('rejects reusing an executor or auditor already in a concurrent open pair while allowing dependsOn', async () => {
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const exec2 = 'deck_sub_pair_mcp_exec_free';
    const aud2 = 'deck_sub_pair_mcp_aud_free';
    const brain = session(BRAIN, 'brain');
    const exec = session(EXEC, 'w1', 'idle');
    const aud = session(AUD, 'w2', 'idle');
    const freeExec = session(exec2, 'w3', 'idle');
    const freeAud = session(aud2, 'w4', 'idle');
    upsertSession(brain); upsertSession(exec); upsertSession(aud); upsertSession(freeExec); upsertSession(freeAud);
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    try {
      putTaskPairFixture(getTaskPairStore(), PROJECT, pair('open-in-audit', 'in_audit'));
      const handlers = createMemoryMcpToolHandlers(caller, {
        sendDeps: { listSessions: () => [brain, exec, aud, freeExec, freeAud] },
      });

      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        brief: '- [ ][ ] 1. reuse idle executor from open pair', executor: EXEC, auditor: aud2, idempotencyKey: 'reuse-exec',
      })).resolves.toMatchObject({
        status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message: expect.stringContaining('open-in-audit'),
      });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        brief: '- [ ][ ] 1. reuse idle auditor from open pair', executor: exec2, auditor: AUD, idempotencyKey: 'reuse-aud',
      })).resolves.toMatchObject({
        status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message: expect.stringContaining('open-in-audit'),
      });
      // Dependency wait referencing the holder pair remains valid.
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        brief: '- [ ][ ] 1. depends on holder', executor: EXEC, auditor: AUD, dependsOn: ['open-in-audit'], idempotencyKey: 'dep-ok',
      })).resolves.toMatchObject({ status: 'ok', state: 'queued' });

      const second = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        brief: '- [ ][ ] 1. dedicated sessions', executor: exec2, auditor: aud2, idempotencyKey: 'second-ok',
      });
      expect(second).toMatchObject({ status: 'ok', state: 'working' });
      const secondId = String(second.taskId);
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN]({
        taskId: secondId, executor: EXEC, idempotencyKey: 'reassign-reuse-exec',
      })).resolves.toMatchObject({
        status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message: expect.stringContaining('open-in-audit'),
      });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN]({
        taskId: secondId, auditor: AUD, idempotencyKey: 'reassign-reuse-aud',
      })).resolves.toMatchObject({
        status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message: expect.stringContaining('open-in-audit'),
      });
      expect(getTaskPairStore().getPair(PROJECT, secondId)?.state).toMatchObject({ executor: exec2, auditor: aud2 });
    } finally {
      setTaskPairDeliveryDepsForTests(undefined);
      removeSession(BRAIN); removeSession(EXEC); removeSession(AUD); removeSession(exec2); removeSession(aud2);
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    }
  });

  it('obeys configured pool entry roles on omitted pair_create roles and when only executor is named, and surfaces inOpenPair/poolRole', async () => {
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const execCfg = {
      capabilityId: 'supervision-exec-v1:transport:agy-sdk:google:gemini-4-hydrogen-high',
      agentType: 'agy-sdk',
      runtimeType: 'transport' as const,
      providerFamily: 'google',
      model: 'gemini-4-hydrogen-high',
      role: 'executor' as const,
    };
    const audCfg = {
      capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-6.2-sol',
      agentType: 'codex-sdk',
      runtimeType: 'transport' as const,
      providerFamily: 'openai',
      model: 'gpt-6.2-sol',
      role: 'auditor' as const,
    };
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: { configs: [execCfg, audCfg], controls: { leaseMs: 1_800_000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
        economyTaskPool: { configs: [], controls: { leaseMs: 900_000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
      },
    });
    const brain: SessionRecord = {
      ...session(BRAIN, 'brain'),
      transportConfig: { supervision: snapshot },
    };
    const execA: SessionRecord = {
      ...session('deck_sub_pool_exec_a', 'w1'), parentSession: BRAIN, agentType: 'agy-sdk', runtimeType: 'transport', activeModel: 'gemini-4-hydrogen-high',
    };
    const execB: SessionRecord = {
      ...session('deck_sub_pool_exec_b', 'w2'), parentSession: BRAIN, agentType: 'agy-sdk', runtimeType: 'transport', activeModel: 'gemini-4-hydrogen-high',
    };
    const audPool: SessionRecord = {
      ...session('deck_sub_pool_aud', 'w3'), parentSession: BRAIN, agentType: 'codex-sdk', runtimeType: 'transport', activeModel: 'gpt-6.2-sol',
    };
    const outside: SessionRecord = {
      ...session('deck_sub_outside_astra', 'w4'), parentSession: BRAIN, agentType: 'codex-sdk', runtimeType: 'transport', activeModel: 'gpt-6.2-astra',
    };
    const all = [brain, execA, execB, audPool, outside];
    all.forEach(upsertSession);
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    try {
      const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => all } });
      const createdAuto = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Pool auto selection', brief: '# auto\n- [ ][ ] 1. Verify auto selection', idempotencyKey: 'pool-auto-1',
      });
      expect(createdAuto).toMatchObject({ status: 'ok', state: 'working' });
      const autoPair = getTaskPairStore().getPair(PROJECT, String(createdAuto.taskId))?.state;
      expect([execA.name, execB.name]).toContain(autoPair?.executor);
      expect(autoPair?.auditor).toBe(audPool.name);

      const listed = await handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({}) as {
        status: string;
        items: Array<{ sessionName: string; inOpenPair?: boolean; poolRole?: string | null; poolRoles?: Record<string, string> }>;
      };
      expect(listed.status).toBe('ok');
      const byName = new Map(listed.items.map((item) => [item.sessionName, item]));
      expect(byName.get(autoPair!.executor!)).toMatchObject({ inOpenPair: true, poolRole: 'executor', poolRoles: { primary: 'executor' } });
      expect(byName.get(audPool.name)).toMatchObject({ inOpenPair: true, poolRole: 'auditor', poolRoles: { primary: 'auditor' } });
      expect(byName.get(outside.name)).toMatchObject({ inOpenPair: false, poolRole: null });

      // Free the auditor by closing the first pair, then name only executor so pool still supplies the auditor.
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(createdAuto.taskId), action: 'done', force: true, idempotencyKey: 'close-auto-1' });
      const namedExecOmittedAud = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Pool auditor for named executor', brief: '# partial\n- [ ][ ] 1. Verify partial selection', executor: execB.name, idempotencyKey: 'pool-partial-1',
      });
      expect(namedExecOmittedAud).toMatchObject({ status: 'ok', state: 'working' });
      expect(getTaskPairStore().getPair(PROJECT, String(namedExecOmittedAud.taskId))?.state).toMatchObject({
        executor: execB.name,
        auditor: audPool.name,
      });
    } finally {
      setTaskPairDeliveryDepsForTests(undefined);
      all.forEach((record) => removeSession(record.name));
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    }
  });

  it('never steals or reuses idle sessions belonging to a paused/queued pair in pool picking, provisioning, or lease checks', async () => {
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const execCfg = {
      capabilityId: 'supervision-exec-v1:transport:agy-sdk:google:gemini-4-hydrogen-high',
      agentType: 'agy-sdk',
      runtimeType: 'transport' as const,
      providerFamily: 'google',
      model: 'gemini-4-hydrogen-high',
      role: 'executor' as const,
    };
    const audCfg = {
      capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-6.2-sol',
      agentType: 'codex-sdk',
      runtimeType: 'transport' as const,
      providerFamily: 'openai',
      model: 'gpt-6.2-sol',
      role: 'auditor' as const,
    };
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: { configs: [execCfg, audCfg], controls: { leaseMs: 1_800_000, maxSpawned: 4, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
        economyTaskPool: { configs: [], controls: { leaseMs: 900_000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
      },
    });
    const brain: SessionRecord = {
      ...session(BRAIN, 'brain'),
      transportConfig: { supervision: snapshot },
    };
    const execHeld: SessionRecord = {
      ...session('deck_sub_q_exec_held', 'w1'), parentSession: BRAIN, agentType: 'agy-sdk', runtimeType: 'transport', activeModel: 'gemini-4-hydrogen-high',
    };
    const audHeld: SessionRecord = {
      ...session('deck_sub_q_aud_held', 'w2'), parentSession: BRAIN, agentType: 'codex-sdk', runtimeType: 'transport', activeModel: 'gpt-6.2-sol',
    };
    const execFree: SessionRecord = {
      ...session('deck_sub_q_exec_free', 'w3'), parentSession: BRAIN, agentType: 'agy-sdk', runtimeType: 'transport', activeModel: 'gemini-4-hydrogen-high',
    };
    const all = [brain, execHeld, audHeld, execFree];
    all.forEach(upsertSession);
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    try {
      putTaskPairFixture(getTaskPairStore(), PROJECT, {
        taskId: 'tsk_paused_queued_holder',
        brain: BRAIN,
        executor: execHeld.name,
        auditor: audHeld.name,
        title: 'Paused queued holder',
        brief: '# hold',
        status: 'queued',
        flags: [],
        flagSides: {},
        round: 0,
        blocking: ['P0'],
        previousAuditors: [],
        capCounts: {},
        capRound: 0,
        createdAt: 10,
        updatedAt: 20,
        scheduling: { epoch: 1, manual: true, dependsOn: [], since: 20, writer: BRAIN },
        workspaceKind: 'none',
      });

      // Slot predicate stays false for queued pairs, while open-pair lease & candidate checks protect both reserved sessions.
      expect(getTaskPairStore().isParticipantOfOpenPair(execHeld.name)).toBe(false);
      await expect(defaultHasActiveSupervisionLease(execHeld.name)).resolves.toBe(true);
      await expect(defaultHasActiveSupervisionLease(audHeld.name)).resolves.toBe(true);

      const execCandidates = listTaskPairCandidates({
        brain: BRAIN, role: 'executor', pool: 'primary', exclude: new Set([BRAIN]), exceptTaskId: 'tsk_other',
      });
      expect(execCandidates.map((s) => s.name)).toEqual([execFree.name]);
      const ownCandidates = listTaskPairCandidates({
        brain: BRAIN, role: 'executor', pool: 'primary', exclude: new Set([BRAIN]), exceptTaskId: 'tsk_paused_queued_holder',
      });
      expect(ownCandidates.map((s) => s.name).sort()).toEqual([execFree.name, execHeld.name].sort());

      const reusedProvision = await provisionSupervisionTarget({
        parentSessionName: BRAIN,
        pool: 'primary',
        requestedCapabilityId: execCfg.capabilityId,
        idempotencyKey: 'prov-should-not-reuse-held',
        pairTaskId: 'tsk_other',
      }, {
        listSessions: () => [brain, execHeld, audHeld],
        getSession: (name) => [brain, execHeld, audHeld].find((s) => s.name === name),
        startSubSession: async () => { throw new Error('stop_before_spawn'); },
      });
      expect(reusedProvision).toMatchObject({ ok: false, reason: 'launch_failed' });

      const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => all } });
      // Auto pair_create omitting both roles MUST stay queued (never steal execHeld or audHeld; no free auditor exists yet).
      const autoBoth = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Independent auto pair', brief: '# auto\n- [ ][ ] 1. Verify isolation', workspace: 'none', idempotencyKey: 'q-auto-both',
      });
      expect(autoBoth).toMatchObject({ status: 'ok', state: 'queued' });
      const autoBothState = getTaskPairStore().getPair(PROJECT, String(autoBoth.taskId))?.state;
      expect([autoBothState?.executor, autoBothState?.auditor].filter((name) => name === execHeld.name || name === audHeld.name)).toEqual([]);
      expect(autoBothState?.status).toBe('queued');

      // Partial pair_create naming execFree and omitting auditor stays queued without stealing audHeld.
      const partialNoSteal = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Partial pair must not steal queued auditor', brief: '# partial-2\n- [ ][ ] 1. Verify no steal', executor: execFree.name, workspace: 'none', idempotencyKey: 'q-partial-2',
      });
      expect(partialNoSteal).toMatchObject({ status: 'ok', state: 'queued' });
      const partialState = getTaskPairStore().getPair(PROJECT, String(partialNoSteal.taskId))?.state;
      expect(partialState).toMatchObject({ executor: execFree.name });
      expect(partialState?.auditor).toBeUndefined();

      // With execFree now owned by queued partialNoSteal, a second pair naming execFree is rejected as concurrent open-pair reuse.
      const reuseQueued = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Reuse queued execFree', brief: '# dup\n- [ ][ ] 1. Verify queued reuse rejection', executor: execFree.name, workspace: 'none', idempotencyKey: 'q-reuse-free',
      });
      expect(reuseQueued).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });

      // Cancel pending autoBoth/partialNoSteal, add a free auditor audFree, and verify auto pair_create picks ONLY [execFree, audFree].
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(autoBoth.taskId), action: 'cancel', idempotencyKey: 'cancel-both' });
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(partialNoSteal.taskId), action: 'cancel', idempotencyKey: 'cancel-partial' });
      const audFree: SessionRecord = {
        ...session('deck_sub_q_aud_free', 'w4'), parentSession: BRAIN, agentType: 'codex-sdk', runtimeType: 'transport', activeModel: 'gpt-6.2-sol',
      };
      upsertSession(audFree);
      all.push(audFree);
      const autoWithFreeAud = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Auto pair with free pool sessions', brief: '# auto-free\n- [ ][ ] 1. Verify free pool pick', workspace: 'none', idempotencyKey: 'q-auto-free',
      });
      expect(autoWithFreeAud).toMatchObject({ status: 'ok', state: 'working' });
      expect(getTaskPairStore().getPair(PROJECT, String(autoWithFreeAud.taskId))?.state).toMatchObject({
        executor: execFree.name,
        auditor: audFree.name,
      });
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(autoWithFreeAud.taskId), action: 'done', force: true, idempotencyKey: 'close-auto-free' });
      removeSession(execFree.name);
      removeSession(audFree.name);

      // Downstream dependsOn pair MAY reference the holder's participants.
      const dependent = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Dependent downstream', brief: '# dep\n- [ ][ ] 1. Verify dependsOn', executor: execHeld.name, auditor: audHeld.name,
        dependsOn: ['tsk_paused_queued_holder'], workspace: 'none', idempotencyKey: 'q-dep',
      });
      expect(dependent).toMatchObject({ status: 'ok', state: 'queued' });

      // Resuming the paused queued holder itself immediately resumes and dispatches with its own reserved participants.
      const resumed = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_RESUME]({ taskId: 'tsk_paused_queued_holder' });
      expect(resumed).toMatchObject({ status: 'ok', state: 'working' });
      expect(getTaskPairStore().getPair(PROJECT, 'tsk_paused_queued_holder')?.state).toMatchObject({
        status: 'working',
        executor: execHeld.name,
        auditor: audHeld.name,
      });

      // Closing holder leaves dependent in queued holding execHeld/audHeld, so another auto pair still stays queued without stealing them.
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: 'tsk_paused_queued_holder', action: 'done', force: true, idempotencyKey: 'close-holder' });
      const whileDepQueued = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Fresh pair while dependent queued', brief: '# dep-holds\n- [ ][ ] 1. Verify held by dep', workspace: 'none', idempotencyKey: 'q-while-dep',
      });
      expect(whileDepQueued).toMatchObject({ status: 'ok', state: 'queued' });
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(whileDepQueued.taskId), action: 'cancel', idempotencyKey: 'cancel-while-dep' });

      // Closing dependent frees both participants, so a fresh auto pair_create starts working with [execHeld, audHeld].
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(dependent.taskId), action: 'cancel', idempotencyKey: 'close-dep' });
      const afterClose = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Fresh pair after holder close', brief: '# free\n- [ ][ ] 1. Verify reuse after close', workspace: 'none', idempotencyKey: 'q-after-close',
      });
      expect(afterClose).toMatchObject({ status: 'ok', state: 'working' });
      expect(getTaskPairStore().getPair(PROJECT, String(afterClose.taskId))?.state).toMatchObject({
        executor: execHeld.name,
        auditor: audHeld.name,
      });
    } finally {
      setTaskPairDeliveryDepsForTests(undefined);
      all.forEach((record) => removeSession(record.name));
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    }
  });

  it('allows an upstream pair to auto-pick omitted auditor or executor reserved by its waiting downstream dependsOn pair, without masking unrelated holders', async () => {
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const execCfg = {
      capabilityId: 'supervision-exec-v1:transport:agy-sdk:google:gemini-4-hydrogen-high',
      agentType: 'agy-sdk',
      runtimeType: 'transport' as const,
      providerFamily: 'google',
      model: 'gemini-4-hydrogen-high',
      role: 'executor' as const,
    };
    const audCfg = {
      capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-6.2-sol',
      agentType: 'codex-sdk',
      runtimeType: 'transport' as const,
      providerFamily: 'openai',
      model: 'gpt-6.2-sol',
      role: 'auditor' as const,
    };
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: { configs: [execCfg, audCfg], controls: { leaseMs: 1_800_000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
        economyTaskPool: { configs: [], controls: { leaseMs: 900_000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
      },
    });
    const brain: SessionRecord = {
      ...session(BRAIN, 'brain'),
      transportConfig: { supervision: snapshot },
    };
    const execS: SessionRecord = {
      ...session('deck_sub_dep_exec', 'w1'), parentSession: BRAIN, agentType: 'agy-sdk', runtimeType: 'transport', activeModel: 'gemini-4-hydrogen-high',
    };
    const audS: SessionRecord = {
      ...session('deck_sub_dep_aud', 'w2'), parentSession: BRAIN, agentType: 'codex-sdk', runtimeType: 'transport', activeModel: 'gpt-6.2-sol',
    };
    const all = [brain, execS, audS];
    all.forEach(upsertSession);
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    const automation = new TaskPairAutomation({
      isBusy: () => false,
      isLimited: () => false,
      pickCandidate: (input) => listTaskPairCandidates(input)[0]?.name,
      provision: async () => undefined,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    taskPairService.setScheduler(automation);
    try {
      const store = getTaskPairStore();
      // Case 1: upstream U has executor=execS & omitted auditor; downstream D waits on U with executor=execS & auditor=audS.
      putTaskPairFixture(store, PROJECT, {
        taskId: 'tsk_dep_up_1',
        brain: BRAIN,
        executor: execS.name,
        title: 'Upstream omitted auditor',
        brief: '# up 1',
        status: 'queued',
        flags: [],
        flagSides: {},
        round: 0,
        blocking: ['P0'],
        previousAuditors: [],
        capCounts: {},
        capRound: 0,
        createdAt: 10,
        updatedAt: 10,
        workspaceKind: 'none',
      });
      putTaskPairFixture(store, PROJECT, {
        taskId: 'tsk_dep_down_1',
        brain: BRAIN,
        executor: execS.name,
        auditor: audS.name,
        title: 'Downstream reserving auditor',
        brief: '# down 1',
        status: 'queued',
        flags: [],
        flagSides: {},
        round: 0,
        blocking: ['P0'],
        previousAuditors: [],
        capCounts: {},
        capRound: 0,
        createdAt: 20,
        updatedAt: 20,
        scheduling: { epoch: 1, manual: false, dependsOn: ['tsk_dep_up_1'], since: 20, writer: BRAIN },
        workspaceKind: 'none',
      });

      await automation.runQueue(PROJECT, BRAIN);
      await taskPairService.waitForIdle();
      expect(store.getPair(PROJECT, 'tsk_dep_up_1')?.state).toMatchObject({
        status: 'working',
        executor: execS.name,
        auditor: audS.name,
      });
      expect(store.getPair(PROJECT, 'tsk_dep_down_1')?.state.status).toBe('queued');

      // Closing upstream U unlocks downstream D in order with the same dedicated participants.
      const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => all } });
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: 'tsk_dep_up_1', action: 'done', force: true, idempotencyKey: 'close-dep-up-1' });
      await automation.reconcileSuspensions();
      await automation.runQueue(PROJECT, BRAIN);
      await taskPairService.waitForIdle();
      expect(store.getPair(PROJECT, 'tsk_dep_down_1')?.state).toMatchObject({
        status: 'working',
        executor: execS.name,
        auditor: audS.name,
      });
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: 'tsk_dep_down_1', action: 'done', force: true, idempotencyKey: 'close-dep-down-1' });

      // Case 2: upstream U2 has omitted executor & named auditor=audS; downstream D2 waits on U2 reserving execS+audS;
      // while independent paused-queued H_other ALSO holds execS, the exempted D2 must NOT mask H_other.
      putTaskPairFixture(store, PROJECT, {
        taskId: 'tsk_dep_up_2',
        brain: BRAIN,
        auditor: audS.name,
        title: 'Upstream omitted executor',
        brief: '# up 2',
        status: 'queued',
        flags: [],
        flagSides: {},
        round: 0,
        blocking: ['P0'],
        previousAuditors: [],
        capCounts: {},
        capRound: 0,
        createdAt: 30,
        updatedAt: 30,
        workspaceKind: 'none',
      });
      putTaskPairFixture(store, PROJECT, {
        taskId: 'tsk_dep_down_2',
        brain: BRAIN,
        executor: execS.name,
        auditor: audS.name,
        title: 'Downstream 2',
        brief: '# down 2',
        status: 'queued',
        flags: [],
        flagSides: {},
        round: 0,
        blocking: ['P0'],
        previousAuditors: [],
        capCounts: {},
        capRound: 0,
        createdAt: 40,
        updatedAt: 40,
        scheduling: { epoch: 1, manual: false, dependsOn: ['tsk_dep_up_2'], since: 40, writer: BRAIN },
        workspaceKind: 'none',
      });
      putTaskPairFixture(store, PROJECT, {
        taskId: 'tsk_independent_holder',
        brain: BRAIN,
        executor: execS.name,
        title: 'Independent paused holder',
        brief: '# indep',
        status: 'queued',
        flags: [],
        flagSides: {},
        round: 0,
        blocking: ['P0'],
        previousAuditors: [],
        capCounts: {},
        capRound: 0,
        createdAt: 50,
        updatedAt: 50,
        scheduling: { epoch: 1, manual: true, dependsOn: [], since: 50, writer: BRAIN },
        workspaceKind: 'none',
      });

      // Because H_other independently holds execS, U2 must NOT pick execS even though D2 was exempted.
      expect(listTaskPairCandidates({
        brain: BRAIN, role: 'executor', pool: 'primary', exclude: new Set([BRAIN, audS.name]), exceptTaskId: 'tsk_dep_up_2',
      })).toEqual([]);
      await automation.runQueue(PROJECT, BRAIN);
      await taskPairService.waitForIdle();
      expect(store.getPair(PROJECT, 'tsk_dep_up_2')?.state.status).toBe('queued');

      // Cancelling the unrelated holder (while D2 STILL waits on U2) immediately lets U2 acquire execS and start!
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: 'tsk_independent_holder', action: 'cancel', idempotencyKey: 'cancel-indep' });
      await automation.runQueue(PROJECT, BRAIN);
      await taskPairService.waitForIdle();
      expect(store.getPair(PROJECT, 'tsk_dep_up_2')?.state).toMatchObject({
        status: 'working',
        executor: execS.name,
        auditor: audS.name,
      });
      expect(store.getPair(PROJECT, 'tsk_dep_down_2')?.state.status).toBe('queued');
    } finally {
      await taskPairService.waitForIdle();
      taskPairService.setScheduler(undefined);
      setTaskPairDeliveryDepsForTests(undefined);
      all.forEach((record) => removeSession(record.name));
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    }
  });

  it('requires at least one unchecked non-empty dual-box "- [ ][ ]" line on audited pair_create without side effects, while preserving auditor="none" and legacy replays', async () => {
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-pair-gate-')));
    const gitProject = join(base, 'repo');
    const worktreesRoot = join(base, 'worktrees');
    const worksRoot = join(base, 'works');
    execFileSync('git', ['init', '-q', gitProject]);
    execFileSync('git', ['-C', gitProject, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', gitProject, 'config', 'user.name', 'Test']);
    writeFileSync(join(gitProject, 'README.md'), 'hello\n');
    execFileSync('git', ['-C', gitProject, 'add', '-A']);
    execFileSync('git', ['-C', gitProject, 'commit', '-qm', 'base']);

    const gateCaller: McpRuntimeCaller = {
      ...caller,
      projectRoot: gitProject,
    };
    const brain: SessionRecord = {
      ...session(BRAIN, 'brain'),
      agentType: 'claude-code-sdk',
      activeModel: 'opus[1M]',
      projectDir: gitProject,
    };
    const exec: SessionRecord = { ...session(EXEC, 'w1'), parentSession: BRAIN, agentType: 'claude-code-sdk', activeModel: 'sonnet', projectDir: gitProject };
    const aud: SessionRecord = { ...session(AUD, 'w2'), parentSession: BRAIN, agentType: 'claude-code-sdk', activeModel: 'sonnet', projectDir: gitProject };
    upsertSession(brain); upsertSession(exec); upsertSession(aud);

    let spawnAttempts = 0;
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    setTaskPairWorkspaceDepsForTests({ env: { ...process.env, IMCODES_WORKTREES_ROOT: worktreesRoot, IMCODES_WORKS_ROOT: worksRoot } });
    setPairSessionCreationDepsForTests({
      createSession: async () => {
        spawnAttempts += 1;
        return { ok: true, sessionName: `deck_sub_unexpected_${spawnAttempts}` };
      },
    });
    try {
      const handlers = createMemoryMcpToolHandlers(gateCaller, { sendDeps: { listSessions: () => [brain, exec, aud] } });
      const badBriefs: Array<[string, string]> = [
        ['no checklist', '## Goal\nShort 2-sentence brief without checklist.'],
        ['single box only', '## Acceptance\n- [ ] 1. Single box item'],
        ['fenced backtick only', '## Example\n```md\n- [ ][ ] 1. Example inside fence\n```'],
        ['nested 4-backtick fence with 3-backtick inner', '````markdown\n```\n- [ ][ ] only code example\n```\n````'],
        ['3-backtick fence with ```js info line', '```md\n```js\n- [ ][ ] 1. Inside code fence\n```'],
        ['fenced tilde only', '## Example\n~~~\n- [ ][ ] 1. Example inside tilde fence\n~~~'],
        ['nested 4-tilde fence with 3-tilde inner', '~~~~\r\n~~~\r\n- [ ][ ] 1. Tilde nested example\r\n~~~\r\n~~~~'],
        ['unclosed fence', '```md\n- [ ][ ] 1. Never closed'],
        ['blank dual box', '## Acceptance\n- [ ][ ]   '],
        ['pre-checked both', '## Acceptance\n- [x][x] 1. Already checked'],
        ['pre-checked implemented', '## Acceptance\n- [x][ ] 1. Half checked'],
        ['pre-checked audited', '## Acceptance\n- [ ][x] 1. Half audited'],
      ];

      for (const [label, badBrief] of badBriefs) {
        const resExplicit = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
          title: `Reject ${label}`, brief: badBrief, executor: EXEC, auditor: AUD, workspace: 'worktree', idempotencyKey: `gate-exp-${label}`,
        });
        expect(resExplicit, label).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
      }

      // Omitted auditor (auto-pick / auto-create) and createAuditor are also audited and rejected without side effects.
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Reject omitted auditor', brief: 'No checklist', executor: EXEC, workspace: 'worktree', idempotencyKey: 'gate-omit-aud',
      })).resolves.toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Reject createAuditor', brief: '- [ ] single box', executor: EXEC, createAuditor: { model: 'sonnet' }, workspace: 'worktree', idempotencyKey: 'gate-create-aud',
      })).resolves.toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });

      // Explicit non-'none' auditor combined with auditorModel='none' still resolves to an audited pair and MUST fail without checklist.
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Reject explicit auditor + none model without checklist', brief: 'No checklist', executor: EXEC, auditor: AUD, auditorModel: 'none', workspace: 'worktree', idempotencyKey: 'gate-explicit-aud-none-model',
      })).resolves.toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED });

      expect(spawnAttempts).toBe(0);
      expect(getTaskPairStore().listActivePairs()).toHaveLength(0);
      expect(existsSync(worktreesRoot)).toBe(false);

      // Valid audited pair (including CRLF + nested fence followed by real acceptance item) succeeds cleanly.
      const okAudited = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Accept valid CRLF checklist after nested fence',
        brief: '## Goal\r\nFix gate\r\n\r\n````markdown\r\n```\r\n- [ ][ ] example\r\n```\r\n````\r\n\r\n## Acceptance\r\n- [ ][ ] 1. Verify gate passes\r\n',
        executor: EXEC, auditor: AUD, workspace: 'none', idempotencyKey: 'gate-ok-crlf',
      });
      expect(okAudited).toMatchObject({ status: 'ok', state: 'working' });
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(okAudited.taskId), action: 'done', force: true, idempotencyKey: 'close-gate-ok' });

      // Explicit non-'none' auditor + auditorModel='none' WITH valid checklist keeps explicit auditor priority and succeeds.
      const okExplicitAudWithNoneModel = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Keep explicit auditor priority when valid checklist is provided',
        brief: '## Acceptance\n- [ ][ ] 1. Verify explicit auditor preserved',
        executor: EXEC, auditor: AUD, auditorModel: 'none', workspace: 'none', idempotencyKey: 'gate-ok-explicit-aud-none-model',
      });
      expect(okExplicitAudWithNoneModel).toMatchObject({ status: 'ok', state: 'working' });
      expect(getTaskPairStore().getPair(PROJECT, String(okExplicitAudWithNoneModel.taskId))?.state.auditor).toBe(AUD);
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(okExplicitAudWithNoneModel.taskId), action: 'done', force: true, idempotencyKey: 'close-gate-ok-exp-aud' });

      // Unaudited pair_create (auditor='none' and auditorModel='none') succeeds without checklist.
      const okNoneAuditor = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Unaudited none auditor', brief: 'Quick edit without checklist.', executor: EXEC, auditor: 'none', workspace: 'none', idempotencyKey: 'gate-none-aud',
      });
      expect(okNoneAuditor).toMatchObject({ status: 'ok', state: 'working' });
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(okNoneAuditor.taskId), action: 'done', force: true, idempotencyKey: 'close-gate-none-aud' });

      const okNoneModel = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        title: 'Unaudited none auditorModel', brief: 'Quick edit without checklist.', executor: EXEC, auditorModel: 'none', workspace: 'none', idempotencyKey: 'gate-none-model',
      });
      expect(okNoneModel).toMatchObject({ status: 'ok' });
      await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]({ taskId: String(okNoneModel.taskId), action: 'done', force: true, idempotencyKey: 'close-gate-none-model' });

      // Legacy persisted pair replay without checklist stays idempotent instead of being blocked by the new gate.
      const legacyId = 'tsk_legacy_no_checklist';
      const legacyKey = 'legacy-replay-key';
      putTaskPairFixture(getTaskPairStore(), PROJECT, { ...pair(legacyId, 'working'), brief: 'Legacy brief with no checklist' });
      getTaskPairStore().recordEvent({
        id: `mcp:pair-create:${PROJECT}:${legacyKey}`,
        project: PROJECT, taskId: legacyId, writer: BRAIN, role: 'brain', verb: 'PAIR_CREATE', attrs: {}, effect: 'created', unusual: false, source: 'mcp', at: 15,
      });
      const replay = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
        taskId: legacyId, title: 'Legacy', brief: 'Legacy brief with no checklist', executor: EXEC, auditor: AUD, idempotencyKey: legacyKey,
      });
      expect(replay).toMatchObject({ status: 'ok', taskId: legacyId, idempotentReplay: true, state: 'working' });
    } finally {
      setPairSessionCreationDepsForTests(undefined);
      setTaskPairWorkspaceDepsForTests(undefined);
      setTaskPairDeliveryDepsForTests(undefined);
      removeSession(BRAIN); removeSession(EXEC); removeSession(AUD);
      rmSync(base, { recursive: true, force: true });
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    }
  });

});
