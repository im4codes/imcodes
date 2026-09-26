import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import { TASK_PAIR_MAX_CONCURRENCY_CAP, type TaskPairState } from '../../../shared/task-pair.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { getTaskPairStore, setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';

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
    expect(listedPairs.find((item) => item.taskId === 'running-1')).toMatchObject({ executor: { session: EXEC, state: 'idle' } });
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
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_SET_MAX_CONCURRENCY]({ maxConcurrency: 7 })).resolves.toEqual({ status: 'ok', maxConcurrency: 7 });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET_MAX_CONCURRENCY]({})).resolves.toEqual({ status: 'ok', maxConcurrency: 7 });
  });

  it('accepts the cap itself but rejects one past it, never silently clamping a caller-supplied value', async () => {
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session(BRAIN, 'brain')] } });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_SET_MAX_CONCURRENCY]({ maxConcurrency: TASK_PAIR_MAX_CONCURRENCY_CAP }))
      .resolves.toEqual({ status: 'ok', maxConcurrency: TASK_PAIR_MAX_CONCURRENCY_CAP });
    const rejected = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_SET_MAX_CONCURRENCY]({ maxConcurrency: TASK_PAIR_MAX_CONCURRENCY_CAP + 1 });
    expect(rejected.status).toBe('error');
    // The stored value must still be the last one that was actually accepted.
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_GET_MAX_CONCURRENCY]({})).resolves.toEqual({ status: 'ok', maxConcurrency: TASK_PAIR_MAX_CONCURRENCY_CAP });
  });
});
