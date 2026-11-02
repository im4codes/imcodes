import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../src/daemon/task-pairs/service.js';
import { taskPairDecisionReminderDue } from '../../src/daemon/task-pairs/scheduler.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { TaskPairState } from '../../shared/task-pair.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const caller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', projectId: 'p' }, sessionName: 'brain', projectName: 'p',
  projectRoot: null, serverId: null, providerId: null, transport: 'in_process',
};
const state = {
  taskId: 'decision-task', title: 'decision', status: 'in_audit', brain: 'brain', executor: 'exec', auditor: 'audit', round: 1,
  flags: [], blocking: [], brief: '- [ ][ ] item', createdAt: 1, updatedAt: 1,
} as unknown as TaskPairState;
const sessions = (['brain', 'exec', 'audit'] as const).map((name) => ({
  name, projectName: 'p', role: name === 'brain' ? 'brain' : name === 'exec' ? 'w1' : 'w2', agentType: 'claude-code-sdk',
  projectDir: '/tmp/p', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
} as unknown as SessionRecord));

describe('pair decision MCP', () => {
  beforeEach(() => { const store = new TaskPairStore(':memory:'); setTaskPairStoreForTests(store); store.savePair('p', state); });
  afterEach(async () => { await taskPairService.waitForIdle(); setTaskPairDeliveryDepsForTests(undefined); setTaskPairStoreForTests(undefined); });

  it('writes final Brain decisions idempotently and reads bounded stable history', async () => {
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => sessions } });
    const first = await handlers.pair_decision_record!({ taskId: state.taskId, round: 1, conclusion: 'PASS', summary: 'all checks passed', idempotencyKey: 'k1' });
    const retry = await handlers.pair_decision_record!({ taskId: state.taskId, round: 1, conclusion: 'PASS', summary: 'all checks passed', idempotencyKey: 'k1' });
    expect(first).toMatchObject({ status: 'ok', created: true, decision: { kind: 'decision', author: 'brain' } });
    expect(retry).toMatchObject({ status: 'ok', created: false });
    const history = await handlers.pair_decision_history!({ taskId: state.taskId });
    expect(history).toMatchObject({ status: 'ok', requested: 20, decisions: [{ conclusion: 'PASS' }] });
    expect(getTaskPairStore().listDecisions('p', [state.taskId], 20)).toHaveLength(1);
  });

  it('accepts structured question fields through the actual MCP wire schema', async () => {
    const server = createMemoryMcpServer(caller, { sendDeps: { listSessions: () => sessions } }, {}, {}, { toolCatalogMode: 'static_full' });
    const client = new Client({ name: 'decision-schema-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.PAIR_DECISION_RECORD, arguments: {
        taskId: state.taskId, kind: 'request', round: 1, deliveryRound: 1,
        conclusion: 'Choose source', summary: 'Use a fixture?', question: 'Which source?',
        options: [{ id: 'test', label: 'Use test data' }], recommendation: 'Use test data',
      } });
      expect(result.isError).not.toBe(true);
      expect(getTaskPairStore().listDecisions('p', [state.taskId])[0]).toMatchObject({
        question: 'Which source?', options: [{ id: 'test', label: 'Use test data' }], recommendation: 'Use test data',
      });
    } finally { await client.close(); }
  });

  it('preserves structured questions/options and links the Brain ruling to the exact question', async () => {
    const worker = createMemoryMcpToolHandlers({ ...caller, sessionName: 'exec' }, { sendDeps: { listSessions: () => sessions } });
    const request = await worker.pair_decision_record!({ taskId: state.taskId, kind: 'request', round: 1,
      conclusion: 'Choose source', summary: 'Approval needed', question: 'Use test data?',
      options: [{ id: 'test', label: 'Use test fixture' }], recommendation: 'Use test fixture' }) as any;
    expect(request).toMatchObject({ status: 'ok', decision: { question: 'Use test data?', options: [{ id: 'test', label: 'Use test fixture' }] } });
    const brain = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => sessions } });
    expect(await brain.pair_decision_record!({ taskId: state.taskId, kind: 'decision', round: 1,
      conclusion: 'Approved', summary: 'Fixture only', requestId: request.decision.id, selectedOptionId: 'test' }))
      .toMatchObject({ status: 'ok', decision: { requestId: request.decision.id, selectedOptionId: 'test' } });
    expect(await brain.pair_decision_record!({ taskId: state.taskId, kind: 'decision', round: 1,
      conclusion: 'Wrong', summary: 'Wrong question', requestId: 'missing', selectedOptionId: 'test' }))
      .toMatchObject({ status: 'error' });
  });

  it('allows participant requests but refuses participant final decisions', async () => {
    const requestCaller = { ...caller, sessionName: 'exec' };
    const handlers = createMemoryMcpToolHandlers(requestCaller, { sendDeps: { listSessions: () => sessions } });
    const request = await handlers.pair_decision_record!({ taskId: state.taskId, kind: 'request', round: 1, conclusion: 'BLOCKED', summary: 'need Brain choice', idempotencyKey: 'r1' });
    expect(request).toMatchObject({ status: 'ok', decision: { kind: 'request', author: 'exec' } });
    const refused = await handlers.pair_decision_record!({ taskId: state.taskId, round: 1, conclusion: 'PASS', summary: 'not authorized' });
    expect(refused).toMatchObject({ status: 'error' });
  });

  it('keeps records across store restart and concurrent idempotent retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pair-decision-'));
    const path = join(dir, 'pairs.sqlite');
    try {
      const first = new TaskPairStore(path);
      first.savePair('p', state);
      const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve(first.recordDecision({
        project: 'p', taskId: state.taskId, round: 1, kind: 'decision', conclusion: 'PASS', summary: 'same', author: 'brain', at: 10, idempotencyKey: 'same-key',
      }))));
      expect(new Set(results.map((result) => result.record.id)).size).toBe(1);
      first.close();
      const reopened = new TaskPairStore(path);
      expect(reopened.listDecisions('p', [state.taskId], 20)).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists both notification targets and retries a failed delivery without losing the decision', async () => {
    let attempts = 0;
    setTaskPairDeliveryDepsForTests({ send: async () => { attempts += 1; if (attempts === 1) throw new Error('temporary'); } });
    const result = taskPairService.recordDecision({ project: 'p', taskId: state.taskId, round: 1, kind: 'decision', conclusion: 'PASS', summary: 'notify both', author: 'brain', at: 10, idempotencyKey: 'notify-1' });
    await taskPairService.waitForIdle();
    expect(result.notified).toEqual(['brain', 'exec', 'audit']);
    expect(getTaskPairStore().listPendingDecisionNotifications()).toHaveLength(1);
    await taskPairService.retryDecisionNotifications(20);
    expect(getTaskPairStore().listPendingDecisionNotifications()).toHaveLength(0);
    expect(attempts).toBeGreaterThan(3);
    setTaskPairDeliveryDepsForTests(undefined);
  });

  it('uses a five-minute fake-clock boundary, throttles reminders, and resets after a decision', () => {
    const base = 1_000_000;
    expect(taskPairDecisionReminderDue({ status: 'in_audit', now: base + 299_999, pairUpdatedAt: base })).toBe(false);
    expect(taskPairDecisionReminderDue({ status: 'in_audit', now: base + 300_000, pairUpdatedAt: base })).toBe(true);
    expect(taskPairDecisionReminderDue({ status: 'in_audit', now: base + 360_000, pairUpdatedAt: base, reminderAt: base + 300_000 })).toBe(false);
    expect(taskPairDecisionReminderDue({ status: 'in_audit', now: base + 600_000, pairUpdatedAt: base, reminderAt: base + 300_000 })).toBe(true);
    const requestAt = base;
    expect(taskPairDecisionReminderDue({ status: 'in_audit', now: base + 600_000, pairUpdatedAt: base, latestRequestAt: requestAt, latestDecisionAt: base + 1 })).toBe(false);
    expect(taskPairDecisionReminderDue({ status: 'working', now: base + 600_000, pairUpdatedAt: base })).toBe(false);
  });

});

