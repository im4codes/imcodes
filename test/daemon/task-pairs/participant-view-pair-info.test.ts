/** Shared participants use the same Pair projections and authority as owners. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer } from '../../../src/daemon/memory-mcp-server.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../../shared/mcp-tool-discovery.js';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { MEMORY_MCP_TOOL_NAMES as N } from '../../../shared/memory-mcp-contracts.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { getTaskPairStore, setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';

const PROJECT = 'participant-view-project';
const BRAIN = 'deck_pview_brain', EXEC = 'deck_sub_pview_exec', AUD = 'deck_sub_pview_aud';
const TITLE = '测试站升级1.18.15与上线验收';
const BRIEF = '## Goal\n- [ ][ ] 主站BI发布准备';
const MODEL = 'pair-model-x1';
const caller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: PROJECT },
  sessionName: BRAIN, projectName: PROJECT, projectRoot: '/tmp/pview', serverId: 'srv', transport: 'in_process',
};
const sessions = [[BRAIN, 'brain'], [EXEC, 'w1'], [AUD, 'w2']].map(([name, role]) => ({
  name, role, projectName: PROJECT, agentType: 'codex-sdk', projectDir: '/tmp/pview', state: 'idle',
  restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2, requestedModel: MODEL, activeModel: MODEL,
}) as SessionRecord);
const pair = (taskId: string): TaskPairState => ({
  taskId, brain: BRAIN, executor: EXEC, auditor: AUD, title: TITLE, brief: BRIEF,
  status: 'working', flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [],
  capCounts: {}, capRound: 1, createdAt: 10, updatedAt: 20, executorModel: MODEL, auditorModel: MODEL,
} as TaskPairState);
const turns = [
  ['participant', async () => true], ['owner', async () => false],
  ['unavailable provenance', async () => { throw new Error('unreachable'); }],
] as const;
function handlers(sessionName = BRAIN, participantTurnRequired: () => Promise<boolean> = async () => true) {
  return createMemoryMcpToolHandlers({ ...caller, sessionName }, {
    sendDeps: { listSessions: () => sessions }, participantTurnRequired,
    // Separate title-actor lookup must not gate or delay Pair operations.
    pairTitleTurn: async () => { throw new Error('obsolete title authority must not be called'); },
  });
}

beforeEach(() => {
  setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  getTaskPairStore().savePair(PROJECT, pair('legacy-task'));
  getTaskPairStore().savePair(PROJECT, { ...pair('old-grant-task'), titleAccess: { version: 1, serverId: 'other-server', userIds: ['someone-else'] } });
  getTaskPairStore().recordEvent({
    id: 'event-1', project: PROJECT, taskId: 'legacy-task', writer: BRAIN, role: 'brain', verb: 'DISPATCH',
    attrs: { title: TITLE, executorModel: MODEL, brief: BRIEF }, effect: 'recorded', unusual: false,
    source: 'explicit_marker', fromStatus: 'queued', toStatus: 'working', at: 15,
  });
});
afterEach(() => setTaskPairStoreForTests(undefined));

for (const [origin, turn] of turns) describe(`Pair access from ${origin}`, () => {
  it('lists full names/models/briefs for legacy and stale-grant tasks without a backfill', async () => {
    const listed = await handlers(BRAIN, turn).pair_list!({}) as any;
    expect(listed.pairs).toHaveLength(2);
    for (const p of listed.pairs) expect(p).toMatchObject({ title: TITLE, brief: BRIEF, executorModel: MODEL, auditorModel: MODEL });
  });
  it.each([BRAIN, EXEC, AUD])('reads full Pair metadata, checklist and event attributes (%s)', async (sessionName) => {
    const h = handlers(sessionName, turn);
    const got = await h.pair_get!({ taskId: 'legacy-task' }) as any;
    expect(got.pair).toMatchObject({ title: TITLE, brief: BRIEF, executorModel: MODEL, auditorModel: MODEL });
    expect(got.pair.events[0].attrs).toEqual({ title: TITLE, executorModel: MODEL, brief: BRIEF });
    expect(await h.pair_task_get!({ taskId: 'legacy-task' })).toMatchObject({ title: TITLE, markdown: BRIEF });
    expect(await h.pair_task_update!({ taskId: 'legacy-task', markdown: '- [ ][ ] updated work' })).toMatchObject({ title: TITLE, markdown: '- [ ][ ] updated work' });
    expect(await h.pair_task_check!({ taskId: 'legacy-task', items: [1], box: 'implemented', checked: true })).toMatchObject({ title: TITLE, markdown: '- [x][ ] updated work' });
  });
  it('keeps normal Brain-only title updates, without an owner-origin requirement', async () => {
    expect(await handlers(BRAIN, turn).pair_task_update!({ taskId: 'legacy-task', title: '主站BI发布准备' })).toMatchObject({ title: '主站BI发布准备', markdown: BRIEF });
    expect(await handlers(EXEC, turn).pair_task_update!({ taskId: 'legacy-task', title: 'Not Brain' })).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
  });
});

it.each([BRAIN, EXEC, AUD])('does not expand project/task membership (%s)', async (sessionName) => {
  getTaskPairStore().savePair(PROJECT, { ...pair('outside-task'), brain: 'other-brain', executor: 'other-executor', auditor: 'other-auditor', title: 'Outside title' });
  getTaskPairStore().savePair('other-project', { ...pair('other-project-task'), title: 'Other project title' });
  for (const taskId of ['outside-task', 'other-project-task']) {
    expect(await handlers(sessionName).pair_get!({ taskId })).toMatchObject({ status: 'error' });
    expect(await handlers(sessionName).pair_task_get!({ taskId })).toMatchObject({ status: 'error' });
    expect(await handlers(sessionName).pair_task_update!({ taskId, markdown: 'cannot write' })).toMatchObject({ status: 'error' });
  }
  if (sessionName === BRAIN) {
    const result = JSON.stringify(await handlers().pair_list!({}));
    expect(result).not.toContain('Outside title'); expect(result).not.toContain('Other project title');
  }
});

it('keeps Pair discovery metadata in participant target lists without changing unrelated session-model discovery', async () => {
  const result = await handlers()[N.SEND_LIST_TARGETS]({}) as any;
  const exec = result.items.find((item: any) => item.sessionName === EXEC);
  expect(exec.openPairs).toContainEqual(expect.objectContaining({ taskId: 'legacy-task', title: TITLE }));
  expect(exec).not.toHaveProperty('activeModel');
});

it.each([BRAIN, EXEC, AUD])('returns complete Pair data through the real MCP protocol (%s)', async (sessionName) => {
  const server = createMemoryMcpServer({ ...caller, sessionName }, { participantTurnRequired: async () => true, sendDeps: { listSessions: () => sessions } });
  const client = new Client({ name: 'pair-participant-parity', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: N.PAIR_TASK_GET } });
    const result = await client.callTool({ name: N.PAIR_TASK_GET, arguments: { taskId: 'legacy-task' } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ taskId: 'legacy-task', title: TITLE, markdown: BRIEF });
  } finally { await client.close(); await server.close(); }
});
