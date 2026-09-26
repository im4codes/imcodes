import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../src/daemon/task-pairs/store.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { TaskPairState } from '../../shared/task-pair.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const caller: McpRuntimeCaller = { userId: 'u', namespace: { scope: 'user_private', projectId: 'p' }, sessionName: 'brain', projectName: 'p', projectRoot: null, serverId: null, providerId: null, transport: 'in_process' };
const state = { taskId: 'tsk_pair_test', title: 'pair', status: 'working', brain: 'brain', executor: 'exec', auditor: 'audit', round: 1, flags: [], blocking: [], brief: '- [ ][ ] first\n- [x][ ] second', workspace: { kind: 'worktree', path: '/tmp/pair', base: 'base', branch: 'pair/test', status: 'active', createdAt: 1, lastHead: 'abc', lastHeadAt: 2 }, material: { worktree: '/tmp/pair', head: 'abc', base: 'base', at: 2 }, output: { path: 'result.md' }, createdAt: 1, updatedAt: 1 } as unknown as TaskPairState;

function session(name: string, projectName: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName, role: 'brain', agentType: 'claude-code-sdk', projectDir: `/tmp/${projectName}`, state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

const sessions: SessionRecord[] = [
  session('brain', 'p'),
  session('exec', 'p', { role: 'w1' }),
  session('audit', 'p', { role: 'w2' }),
  session('sibling-not-in-pair', 'p', { role: 'w3' }),
];
const deps = { sendDeps: { listSessions: () => sessions } };

describe('pair checklist MCP tools', () => {
  beforeEach(() => { const store = new TaskPairStore(':memory:'); setTaskPairStoreForTests(store); store.savePair('p', state); });
  afterEach(() => setTaskPairStoreForTests(undefined));
  it('gets, updates and checks the whole Markdown brief', async () => {
    const handlers = createMemoryMcpToolHandlers(caller, deps);
    const got = await handlers.pair_task_get!({});
    expect(got).toMatchObject({ status: 'working', markdown: state.brief, total: 2, workspace: state.workspace, material: state.material, output: state.output });
    const updated = await handlers.pair_task_update!({ taskId: state.taskId, markdown: 'Intro\n- [ ][ ] changed' });
    expect(updated).toMatchObject({ status: 'working', markdown: 'Intro\n- [ ][ ] changed' });
    const checked = await handlers.pair_task_check!({ taskId: state.taskId, items: [1], box: 'audited', checked: true });
    expect(checked).toMatchObject({ status: 'working', markdown: 'Intro\n- [ ][x] changed', audited: 1 });
  });

  it('resolves the pair by the caller session\'s real project even when caller.namespace.projectId is stale or wrong', async () => {
    // The exact 215/jdzj shape: a Brain/participant's namespace.projectId
    // disagrees with the session record's actual project (e.g. a stale
    // namespace, or a sub-session whose effective project is its parent's).
    // Resolution must follow the session record, not the namespace field, or
    // this reports "task pair not found" for a real participant.
    const staleNamespaceCaller: McpRuntimeCaller = { ...caller, namespace: { scope: 'user_private', projectId: 'stale-unrelated-project' } };
    const handlers = createMemoryMcpToolHandlers(staleNamespaceCaller, deps);
    const got = await handlers.pair_task_get!({});
    expect(got).toMatchObject({ status: 'working', taskId: state.taskId });
  });

  it('refuses a caller from another project: not found, brief untouched', async () => {
    const otherProjectCaller: McpRuntimeCaller = { ...caller, sessionName: 'other-project-brain', namespace: { scope: 'user_private', projectId: 'other-project' }, projectName: 'other-project' };
    const otherDeps = { sendDeps: { listSessions: () => [...sessions, session('other-project-brain', 'other-project')] } };
    const handlers = createMemoryMcpToolHandlers(otherProjectCaller, otherDeps);
    const got = await handlers.pair_task_get!({ taskId: state.taskId });
    expect(got).toMatchObject({ reason: MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE });
    const updated = await handlers.pair_task_update!({ taskId: state.taskId, markdown: 'from another project' });
    expect(updated).toMatchObject({ reason: MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE });
    // Never overwritten by the refused write.
    expect(getTaskPairStore().getPair('p', state.taskId)?.state.brief).toBe(state.brief);
  });

  it('refuses a same-project session that is not the pair\'s brain, executor or auditor: not found, brief untouched', async () => {
    const siblingCaller: McpRuntimeCaller = { ...caller, sessionName: 'sibling-not-in-pair' };
    const handlers = createMemoryMcpToolHandlers(siblingCaller, deps);
    const got = await handlers.pair_task_get!({ taskId: state.taskId });
    expect(got).toMatchObject({ reason: MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE });
    const updated = await handlers.pair_task_update!({ taskId: state.taskId, markdown: 'from a non-participant' });
    expect(updated).toMatchObject({ reason: MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE });
    const checked = await handlers.pair_task_check!({ taskId: state.taskId, items: [1], box: 'audited', checked: true });
    expect(checked).toMatchObject({ reason: MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE });
    expect(getTaskPairStore().getPair('p', state.taskId)?.state.brief).toBe(state.brief);
  });
});
