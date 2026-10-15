/**
 * Owner decision (audit tsk_854675e1e2, Q3c): a turn a shared-session PARTICIPANT started must not receive the project's open-pair
 * titles and models. Names, labels and state of sibling sessions stay (an agent needs them to address one). The question "is this a
 * participant turn?" is the one the tool gate already asks (`participantTurnRequired`); an unanswerable question reads as a participant
 * turn, no turn context at all reads as an owner turn exactly like the gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer } from '../../../src/daemon/memory-mcp-server.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../../shared/mcp-tool-discovery.js';
import type { ContextNamespace } from '../../../shared/context-types.js';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { getTaskPairStore, setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';

const PROJECT = 'participant-view-project';
const BRAIN = 'deck_pview_brain';
const EXEC = 'deck_sub_pview_exec';
const AUD = 'deck_sub_pview_aud';
const SECRET_TITLE = 'Rotate the production signing key';
const SECRET_BRIEF = '## Goal\nRotate the production signing key before Friday';
const SECRET_MODEL = 'secret-model-x1';

const caller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: PROJECT } as ContextNamespace,
  sessionName: BRAIN, projectName: PROJECT, projectRoot: '/tmp/pview', serverId: 'srv', transport: 'in_process',
};

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir: '/tmp/pview', state: 'idle', restarts: 0, restartTimestamps: [],
    createdAt: 1, updatedAt: 2, label: `${name} label`, ...extra,
  } as SessionRecord;
}
const SESSIONS = [
  session(BRAIN, 'brain'),
  session(EXEC, 'w1', { requestedModel: SECRET_MODEL, activeModel: SECRET_MODEL, modelDisplay: SECRET_MODEL }),
  session(AUD, 'w2'),
];

function pair(taskId: string): TaskPairState {
  return {
    taskId, brain: BRAIN, executor: EXEC, auditor: AUD, title: SECRET_TITLE, status: 'working', flags: [], flagSides: {}, round: 1, blocking: ['P0'],
    previousAuditors: [], capCounts: {}, capRound: 1, createdAt: 10, updatedAt: 20, executorModel: SECRET_MODEL, auditorModel: SECRET_MODEL, brief: SECRET_BRIEF,
  } as TaskPairState;
}

function handlers(participantTurnRequired?: () => Promise<boolean>) {
  return createMemoryMcpToolHandlers(caller, {
    sendDeps: { listSessions: () => SESSIONS },
    ...(participantTurnRequired ? { participantTurnRequired } : {}),
  });
}
const text = (value: unknown) => JSON.stringify(value);

describe('a participant-started turn gets no open-pair titles, models or briefs', () => {
  beforeEach(() => {
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    getTaskPairStore().savePair(PROJECT, pair('task-1'));
    getTaskPairStore().recordEvent({
      id: 'event-1', project: PROJECT, taskId: 'task-1', writer: BRAIN, role: 'brain', verb: 'DISPATCH',
      attrs: { title: SECRET_TITLE, executorModel: SECRET_MODEL, auditorModel: SECRET_MODEL, brief: SECRET_BRIEF },
      effect: 'recorded', unusual: false, source: 'explicit_marker', fromStatus: 'queued', toStatus: 'working', at: 15,
    });
  });
  afterEach(() => setTaskPairStoreForTests(undefined));

  describe.each([BRAIN, EXEC, AUD])('pair_task_get through MCP for authorized session %s', (sessionName) => {
    it.each([
      ['owner origin', async () => false, false],
      ['participant origin', async () => true, true],
      ['unavailable origin', async () => { throw new Error('unreachable'); }, true],
    ] as const)('preserves owner access and refuses brief disclosure for %s', async (_name, participantTurnRequired, denied) => {
      const server = createMemoryMcpServer({ ...caller, sessionName }, { participantTurnRequired, sendDeps: { listSessions: () => SESSIONS } });
      const client = new Client({ name: 'pair-brief-origin-test', version: '1' });
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(local), server.connect(remote)]);
      try {
        await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: MEMORY_MCP_TOOL_NAMES.PAIR_TASK_GET } });
        const result = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.PAIR_TASK_GET, arguments: { taskId: 'task-1' } });
        if (denied) {
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({ taskId: 'task-1', title: null, markdown: null });
          expect(text(result)).not.toContain(SECRET_BRIEF);
          expect(text(result)).not.toContain(SECRET_TITLE);
        } else {
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({ title: SECRET_TITLE, markdown: SECRET_BRIEF });
        }
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  const turns: Array<[string, (() => Promise<boolean>) | undefined, boolean]> = [
    ['owner turn', async () => false, false],
    ['no turn context (tests, unscoped callers)', undefined, false],
    ['participant turn', async () => true, true],
    ['turn origin that cannot be established (fails closed)', async () => { throw new Error('daemon unreachable'); }, true],
  ];

  describe.each(turns)('send_list_targets on %s', (_name, turn, narrowed) => {
    it(narrowed ? 'omits openPairs and every model, keeps names, labels and state' : 'is unchanged: openPairs and models are listed', async () => {
      const result = await handlers(turn)[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({}) as { status: string; items: Array<Record<string, unknown>> };
      expect(result.status).toBe('ok');
      const exec = result.items.find((item) => item.sessionName === EXEC)!;
      expect(exec).toMatchObject({ target: EXEC, label: `${EXEC} label`, status: 'idle', role: 'w1', agentType: 'codex-sdk' });
      if (narrowed) {
        expect(text(result)).not.toContain(SECRET_TITLE);
        expect(text(result)).not.toContain(SECRET_MODEL);
        for (const item of result.items) {
          expect(item).not.toHaveProperty('openPairs');
          for (const field of ['model', 'activeModel', 'requestedModel', 'modelDisplay', 'qwenModel']) expect(item, field).not.toHaveProperty(field);
        }
      } else {
        expect(exec.openPairs).toEqual([expect.objectContaining({ taskId: 'task-1', title: SECRET_TITLE, role: 'executor' })]);
        expect(exec).toMatchObject({ requestedModel: SECRET_MODEL, activeModel: SECRET_MODEL });
      }
    });
  });

  it('a participant turn cannot probe a hidden model by searching for it; the owner can search by model', async () => {
    const narrowed = await handlers(async () => true)[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({ query: SECRET_MODEL }) as { items: unknown[] };
    expect(narrowed.items).toEqual([]);
    const owner = await handlers(async () => false)[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({ query: SECRET_MODEL }) as { items: Array<{ sessionName: string }> };
    expect(owner.items.map((item) => item.sessionName)).toEqual([EXEC]);
    // Searching by name still works for a participant turn.
    const byName = await handlers(async () => true)[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({ query: 'pview_exec' }) as { items: Array<{ sessionName: string }> };
    expect(byName.items.map((item) => item.sessionName)).toEqual([EXEC]);
  });

  describe.each(turns)('pair_list / pair_get on %s', (_name, turn, narrowed) => {
    it(narrowed ? 'drop title, models and brief but keep what the pair needs to be operated' : 'are unchanged', async () => {
      const h = handlers(turn);
      const listed = await h[MEMORY_MCP_TOOL_NAMES.PAIR_LIST]({}) as { pairs: Array<Record<string, unknown>> };
      const got = await h[MEMORY_MCP_TOOL_NAMES.PAIR_GET]({ taskId: 'task-1' }) as { pair: Record<string, unknown> };
      expect(got.pair.events).toEqual([expect.objectContaining({
        id: 'event-1', taskId: 'task-1', writer: BRAIN, verb: 'DISPATCH', fromStatus: 'queued', toStatus: 'working',
        attrs: narrowed ? {} : { title: SECRET_TITLE, executorModel: SECRET_MODEL, auditorModel: SECRET_MODEL, brief: SECRET_BRIEF },
      })]);
      for (const view of [listed.pairs[0]!, got.pair]) {
        expect(view).toMatchObject({ taskId: 'task-1', status: 'working', round: 1, blocking: ['P0'], executor: { session: EXEC }, auditor: { session: AUD } });
        if (narrowed) {
          expect(view).toMatchObject({ title: null, executorModel: null, auditorModel: null, brief: null });
        } else {
          expect(view).toMatchObject({ title: SECRET_TITLE, executorModel: SECRET_MODEL, auditorModel: SECRET_MODEL, brief: SECRET_BRIEF });
        }
      }
      if (narrowed) {
        expect(text(listed)).not.toContain(SECRET_TITLE);
        expect(text(got)).not.toContain(SECRET_MODEL);
        expect(text(got)).not.toContain(SECRET_BRIEF);
      }
    });
  });
});

describe('task-authorized participant titles', () => {
  const actor = { serverId: 'srv', userId: 'alice', sessionName: BRAIN, projectName: PROJECT };
  let currentActor: typeof actor | undefined;
  const titledHandlers = (sessionName = BRAIN) => createMemoryMcpToolHandlers({ ...caller, sessionName }, {
    sendDeps: { listSessions: () => SESSIONS },
    participantTurnRequired: async () => true,
    pairTitleTurn: async () => ({ participantView: true, actor: currentActor ? { ...currentActor, sessionName } : undefined }),
  });
  beforeEach(() => {
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    getTaskPairStore().savePair(PROJECT, { ...pair('own-task'), titleAccess: { version: 1, serverId: 'srv', userIds: ['alice'] } });
    getTaskPairStore().savePair(PROJECT, pair('private-task'));
    currentActor = actor;
  });
  afterEach(() => setTaskPairStoreForTests(undefined));

  it.each([BRAIN, EXEC, AUD])('reads own titles through list/get/check/update without exposing brief/models (%s)', async (sessionName) => {
    const h = titledHandlers(sessionName);
    if (sessionName === BRAIN) {
      expect((await h.pair_list!({}) as any).pairs.find((p: any) => p.taskId === 'own-task').title).toBe(SECRET_TITLE);
      expect((await h.pair_list!({}) as any).pairs.find((p: any) => p.taskId === 'private-task').title).toBeNull();
    }
    expect((await h.pair_get!({ taskId: 'own-task' }) as any).pair).toMatchObject({ title: SECRET_TITLE, brief: null, executorModel: null });
    expect(await h.pair_task_get!({ taskId: 'own-task' })).toMatchObject({ title: SECRET_TITLE, markdown: null });
    expect(await h.pair_task_update!({ taskId: 'own-task', markdown: '- [ ][ ] private task work' })).toMatchObject({ title: SECRET_TITLE, markdown: null });
    expect(await h.pair_task_check!({ taskId: 'own-task', items: [1], box: 'implemented', checked: true })).toMatchObject({ title: SECRET_TITLE, markdown: null });
    if (sessionName === BRAIN) expect(await h.pair_task_update!({ taskId: 'own-task', title: '主站BI发布准备' })).toMatchObject({ title: '主站BI发布准备', markdown: null });
  });
  it.each(['bob', undefined])('cannot read another actor\'s title despite sharing the same Brain: %s', async (userId) => {
    currentActor = userId ? { ...actor, userId } : undefined;
    expect(await titledHandlers().pair_task_get!({ taskId: 'own-task' })).toMatchObject({ title: null, markdown: null });
  });
  it('does not trust caller user id, source/project hints or role slots', async () => {
    for (const override of [{ serverId: 'foreign' }, { projectName: 'foreign' }]) {
      currentActor = { ...actor, ...override };
      expect(await titledHandlers().pair_task_get!({ taskId: 'own-task' })).toMatchObject({ title: null });
    }
  });
  it('requires an explicit owner-origin Brain grant for legacy tasks, scoped to that task only', async () => {
    const owner = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => SESSIONS }, pairTitleTurn: async () => ({ participantView: false }) });
    const before = getTaskPairStore().getPair(PROJECT, 'private-task')!.state;
    expect(await titledHandlers().pair_task_update!({ taskId: 'private-task', titleViewerUserIds: ['alice'] })).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    expect(getTaskPairStore().getPair(PROJECT, 'private-task')!.state).toEqual(before);
    await owner.pair_task_update!({ taskId: 'private-task', titleViewerUserIds: ['alice'], title: '测试站升级1.18.15与上线验收' });
    expect(await titledHandlers().pair_task_get!({ taskId: 'private-task' })).toMatchObject({ title: '测试站升级1.18.15与上线验收', markdown: null });
    const saved = getTaskPairStore().getPair(PROJECT, 'private-task')!.state;
    expect(saved.status).toBe(before.status); expect(saved.round).toBe(before.round);
    expect(saved.titleAccess?.userIds).toEqual(['alice']);
    // Owner grants are additive; changing models/roles/restarting does not infer or erase grants.
    await owner.pair_task_update!({ taskId: 'private-task', titleViewerUserIds: ['bob'] });
    expect(getTaskPairStore().getPair(PROJECT, 'private-task')!.state.titleAccess?.userIds).toEqual(['alice', 'bob']);
  });
  it('does not treat a caller-supplied creator/grant as trusted provenance', async () => {
    const h = titledHandlers();
    expect(await h.pair_task_update!({ taskId: 'private-task', markdown: '- [ ][ ] private', titleAccess: { version: 1, serverId: 'srv', userIds: ['alice'] }, creatorUserId: 'alice' })).toMatchObject({ title: null, markdown: null });
    expect(getTaskPairStore().getPair(PROJECT, 'private-task')!.state.titleAccess).toBeUndefined();
  });
  it('grants the maximum audience without reopening a finished task and refuses overflow atomically', async () => {
    const closed = { ...pair('closed-task'), status: 'done' as const };
    getTaskPairStore().savePair(PROJECT, closed);
    const owner = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => SESSIONS } });
    const audience = ['alice', ...Array.from({ length: 63 }, (_, i) => `user-${i}`)];
    await owner.pair_task_update!({ taskId: 'closed-task', titleViewerUserIds: audience });
    const saved = getTaskPairStore().getPair(PROJECT, 'closed-task')!.state;
    expect(saved.status).toBe('done'); expect(saved.titleAccess?.userIds).toHaveLength(64);
    expect(await owner.pair_task_update!({ taskId: 'closed-task', titleViewerUserIds: ['extra'], title: 'Must not change' })).toMatchObject({ status: 'error' });
    expect(getTaskPairStore().getPair(PROJECT, 'closed-task')!.state).toEqual(saved);
    expect(await titledHandlers().pair_task_get!({ taskId: 'closed-task' })).toMatchObject({ title: SECRET_TITLE, markdown: null, status: 'done' });
  });
  it('rejects invalid grants/title before writing either metadata field', async () => {
    const owner = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => SESSIONS } });
    const original = getTaskPairStore().getPair(PROJECT, 'private-task')!.state;
    for (const args of [{ titleViewerUserIds: ['alice'], title: 'private-task' }, { titleViewerUserIds: Array(65).fill('alice'), title: 'Valid' }, { titleViewerUserIds: [''] }]) {
      expect(await owner.pair_task_update!({ taskId: 'private-task', ...args })).toMatchObject({ status: 'error' });
      expect(getTaskPairStore().getPair(PROJECT, 'private-task')!.state).toEqual(original);
    }
  });
});
