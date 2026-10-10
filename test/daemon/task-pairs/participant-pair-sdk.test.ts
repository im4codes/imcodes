import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { createMemoryMcpServer } from '../../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { getTaskPairStore, setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { removeSession, upsertSession, type SessionRecord } from '../../../src/store/session-store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { MEMORY_MCP_TOOL_NAMES as N } from '../../../shared/memory-mcp-contracts.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../../shared/mcp-tool-discovery.js';
import { mcpToolPayload } from '../../helpers/mcp-tool-result.js';

const PROJECT = 'participant-pair-sdk';
const BRAIN = 'deck_e2e_participant_brain';
const EXEC = 'deck_e2e_participant_exec';
const AUD = 'deck_e2e_participant_aud';
const sibling = 'deck_e2e_participant_sibling';
const sessions = [
  [BRAIN, 'brain'], [EXEC, 'w1'], [AUD, 'w2'], [sibling, 'w3'],
].map(([name, role]) => ({ name, role, projectName: PROJECT, agentType: 'codex-sdk', projectDir: process.env.HOME!, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2 }) as SessionRecord);
const caller: McpRuntimeCaller = {
  userId: 'sdk-owner', namespace: { scope: 'user_private', userId: 'sdk-owner', projectId: PROJECT },
  sessionName: BRAIN, projectName: PROJECT, projectRoot: process.env.HOME!, serverId: 'sdk-source', transport: 'in_process',
};
let store: TaskPairStore | undefined;
afterEach(() => {
  setTaskPairStoreForTests(undefined); store = undefined;
  setTaskPairDeliveryDepsForTests(undefined);
  for (const session of sessions) removeSession(session.name);
});

describe.each([true, false])('scoped real SDK pair lifecycle (participant=%s)', (participant) => {
  it.each([false, true])('Brain creates, retries across restart, dispatches, audits and closes (fallback=%s)', async (fallback) => {
    const oldEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    const dbPath = join(process.env.HOME!, `pair-sdk-${participant}-${fallback}.sqlite`);
    store = new TaskPairStore(dbPath); setTaskPairStoreForTests(store);
    sessions.find((entry) => entry.name === EXEC)!.state = 'running';
    sessions.forEach(upsertSession);
    const deliveries: string[] = [];
    setTaskPairDeliveryDepsForTests({ send: async (target) => { deliveries.push(target); } });
    const sdk = async (sessionName: string) => {
      const server = createMemoryMcpServer({ ...caller, sessionName }, { participantTurnRequired: async () => participant, sendDeps: { listSessions: () => sessions } });
      const client = new Client({ name: 'participant-pair-sdk', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      return { server, client };
    };
    const brain = await sdk(BRAIN), auditor = await sdk(AUD), nonBrain = await sdk(EXEC);
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: name } });
      await client.listTools();
      return mcpToolPayload(await client.callTool(fallback ? { name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: name, fallbackCall: { name, arguments: args } } } : { name, arguments: args }));
    };
    try {
      const args = { title: '参与者创建验证', brief: '## Goal\n- [ ][ ] isolated report', executor: EXEC, auditor: AUD, workspace: 'none', idempotencyKey: 'participant-sdk-once' };
      expect(await call(nonBrain.client, N.PAIR_CREATE, args)).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
      const created = await call(brain.client, N.PAIR_CREATE, args);
      expect(created).toMatchObject({ status: 'ok', created: true, idempotentReplay: false, state: 'queued' });
      const taskId = String(created.taskId);
      expect(getTaskPairStore().getPair(PROJECT, taskId)?.state.workspaceKind).toBe('none');
      // Durable idempotency: reopen the same SQLite DB, not an in-memory fake.
      setTaskPairStoreForTests(undefined); store = new TaskPairStore(dbPath); setTaskPairStoreForTests(store);
      expect(await call(brain.client, N.PAIR_CREATE, args)).toMatchObject({ status: 'ok', taskId, idempotentReplay: true });
      expect(getTaskPairStore().listActivePairs()).toHaveLength(1);
      sessions.find((entry) => entry.name === EXEC)!.state = 'idle';
      upsertSession(sessions.find((entry) => entry.name === EXEC)!);
      const dispatch = await call(brain.client, N.PAIR_DISPATCH, { taskId, idempotencyKey: 'sdk-dispatch' });
      expect(dispatch, JSON.stringify(dispatch)).toMatchObject({ status: 'ok' });
      expect(await call(brain.client, N.PAIR_TASK_GET, { taskId })).toMatchObject({ taskId, title: participant ? null : args.title, markdown: participant ? null : args.brief });
      // The executor's normal marker opens a material-backed report audit; no production session or agent is launched.
      taskPairService.applyMarker({ project: PROJECT, writer: EXEC, marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId, attrs: {} }, source: 'explicit_marker', eventId: 'sdk-ready', turnText: 'Scoped validation report: all checks passed.' });
      expect(getTaskPairStore().getPair(PROJECT, taskId)?.state.status).toBe('in_audit');
      expect(await call(auditor.client, N.PAIR_VERDICT, { taskId, verdict: 'PASS', idempotencyKey: 'sdk-pass' })).toMatchObject({ status: 'ok', state: 'passed' });
      expect(await call(brain.client, N.PAIR_NEXT_ROUND, { taskId, note: 'second report', idempotencyKey: 'sdk-next' })).toMatchObject({ status: 'ok', state: 'working' });
      expect(await call(brain.client, N.PAIR_CLOSE, { taskId, action: 'cancel', idempotencyKey: 'sdk-close' })).toMatchObject({ status: 'ok', state: 'cancelled' });
      expect(await call(brain.client, N.PAIR_NEXT_ROUND, { taskId })).toMatchObject({ status: 'error' });
      expect(deliveries).toContain(EXEC);
      expect(deliveries).toContain(AUD);
    } finally {
      for (const endpoint of [brain, auditor, nonBrain]) { await endpoint.client.close(); await endpoint.server.close(); }
      if (oldEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE; else process.env.IMCODES_SUPERVISION_ENGINE = oldEngine;
    }
  });
});
