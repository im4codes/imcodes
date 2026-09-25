import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { TaskPairState } from '../../shared/task-pair.js';

const caller: McpRuntimeCaller = { userId: 'u', namespace: { scope: 'user_private', projectId: 'p' }, sessionName: 'brain', projectName: 'p', projectRoot: null, serverId: null, providerId: null, transport: 'in_process' };
const state = { taskId: 'tsk_pair_test', title: 'pair', status: 'working', brain: 'brain', executor: 'exec', auditor: 'audit', round: 1, flags: [], blocking: [], brief: '- [ ][ ] first\n- [x][ ] second', workspace: { kind: 'worktree', path: '/tmp/pair', base: 'base', branch: 'pair/test', status: 'active', createdAt: 1, lastHead: 'abc', lastHeadAt: 2 }, material: { worktree: '/tmp/pair', head: 'abc', base: 'base', at: 2 }, output: { path: 'result.md' }, createdAt: 1, updatedAt: 1 } as unknown as TaskPairState;

describe('pair checklist MCP tools', () => {
  beforeEach(() => { const store = new TaskPairStore(':memory:'); setTaskPairStoreForTests(store); store.savePair('p', state); });
  afterEach(() => setTaskPairStoreForTests(undefined));
  it('gets, updates and checks the whole Markdown brief', async () => {
    const handlers = createMemoryMcpToolHandlers(caller);
    const got = await handlers.pair_task_get!({});
    expect(got).toMatchObject({ status: 'working', markdown: state.brief, total: 2, workspace: state.workspace, material: state.material, output: state.output });
    const updated = await handlers.pair_task_update!({ taskId: state.taskId, markdown: 'Intro\n- [ ][ ] changed' });
    expect(updated).toMatchObject({ status: 'working', markdown: 'Intro\n- [ ][ ] changed' });
    const checked = await handlers.pair_task_check!({ taskId: state.taskId, items: [1], box: 'audited', checked: true });
    expect(checked).toMatchObject({ status: 'working', markdown: 'Intro\n- [ ][x] changed', audited: 1 });
  });
});
