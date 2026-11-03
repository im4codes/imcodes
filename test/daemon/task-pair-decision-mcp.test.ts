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
import { taskPairDecisionReminderDue, checkTaskPairMissingExplanation, TaskPairAutomation } from '../../src/daemon/task-pairs/scheduler.js';
import { buildPairConsoleRow } from '../../src/daemon/supervision-console-pair-projection.js';
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

  it('durably requests explanation for unknown blocked tasks once per context and survives restart (F3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'explain-store-'));
    const path = join(dir, 'pairs.sqlite');
    try {
      const first = new TaskPairStore(path);
      const blockedState = {
        ...state,
        taskId: 'unexplained-1',
        status: 'working',
        flags: ['blocked'],
        round: 1,
        deliveryRound: 1,
      } as unknown as TaskPairState;
      first.savePair('p', blockedState);
      setTaskPairStoreForTests(first);

      const stored = first.getPair('p', 'unexplained-1')!;
      // First check: enqueues durable notification into SQLite
      const enqueued = checkTaskPairMissingExplanation(stored, 100);
      expect(enqueued).toBe(true);

      const pending = first.listPendingDecisionNotifications();
      expect(pending).toHaveLength(1);
      expect(pending[0].reason).toBe('missing-explanation-request');
      expect(pending[0].decisionId).toContain('missing-explanation:p:unexplained-1:1:1:blocked');

      // Repeated tick with same context: deduped by SQLite primary key, does NOT re-enqueue
      const secondCheck = checkTaskPairMissingExplanation(stored, 200);
      expect(secondCheck).toBe(false);
      expect(first.listPendingDecisionNotifications()).toHaveLength(1);

      // Reopen store across restart: notification remains in SQLite and dedup holds
      await taskPairService.waitForIdle();
      first.close();
      const reopened = new TaskPairStore(path);
      setTaskPairStoreForTests(reopened);
      expect(reopened.listPendingDecisionNotifications()).toHaveLength(1);

      const reopenedStored = reopened.getPair('p', 'unexplained-1')!;
      const thirdCheck = checkTaskPairMissingExplanation(reopenedStored, 300);
      expect(thirdCheck).toBe(false);
      expect(reopened.listPendingDecisionNotifications()).toHaveLength(1);

      // Exclusions: completed task awaiting Brain does not enqueue
      const completedStored = { ...reopenedStored, state: { ...reopenedStored.state, status: 'passed' as const, flags: [] } };
      expect(checkTaskPairMissingExplanation(completedStored, 400)).toBe(false);

      // Exclusions: task with existing blockedNote does not enqueue
      const notedStored = { ...reopenedStored, state: { ...reopenedStored.state, blockedNote: 'Actual note' } };
      expect(checkTaskPairMissingExplanation(notedStored, 400)).toBe(false);

      // Exclusions: capacity wait does not enqueue
      const capacityStored = { ...reopenedStored, state: { ...reopenedStored.state, blockedNote: undefined, flags: ['waiting_for_capacity'] as any } };
      expect(checkTaskPairMissingExplanation(capacityStored, 400)).toBe(false);

      // Advancing to round 2 with unexplained blocker: allows exactly one notification for new round
      const round2Stored = { ...reopenedStored, state: { ...reopenedStored.state, round: 2, blockedNote: undefined, flags: ['blocked'] as any } };
      const round2Enqueued = checkTaskPairMissingExplanation(round2Stored, 500);
      expect(round2Enqueued).toBe(true);
      expect(reopened.listPendingDecisionNotifications()).toHaveLength(2);

      await taskPairService.waitForIdle();
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes late ruling for question A from new same-round question B in isDecisionResolved (F2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-store-'));
    const path = join(dir, 'pairs.sqlite');
    try {
      const store = new TaskPairStore(path);
      store.savePair('p', state);

      const reqA = {
        id: 'q-a', project: 'p', taskId: state.taskId, round: 1, deliveryRound: 1,
        kind: 'request' as const, conclusion: 'A', summary: 'Question A', author: 'exec', at: 10,
      };
      const reqB = {
        id: 'q-b', project: 'p', taskId: state.taskId, round: 1, deliveryRound: 1,
        kind: 'request' as const, conclusion: 'B', summary: 'Question B', author: 'exec', at: 20,
      };

      store.recordDecision(reqA);
      store.recordDecision(reqB);

      // Prior to any decision: both unresolved
      expect(store.isDecisionResolved(reqA)).toBe(false);
      expect(store.isDecisionResolved(reqB)).toBe(false);

      // Ruling explicitly for A at 30
      store.recordDecision({
        id: 'ruling-a', project: 'p', taskId: state.taskId, round: 1, deliveryRound: 1,
        kind: 'decision' as const, conclusion: 'PASS A', summary: 'Approved A', author: 'brain', at: 30,
        requestId: 'q-a',
      });

      // Question A is resolved; Question B is NOT resolved despite ruling.at >= reqB.at!
      expect(store.isDecisionResolved(reqA)).toBe(true);
      expect(store.isDecisionResolved(reqB)).toBe(false);

      // Ruling explicitly for B resolves B
      store.recordDecision({
        id: 'ruling-b', project: 'p', taskId: state.taskId, round: 1, deliveryRound: 1,
        kind: 'decision' as const, conclusion: 'PASS B', summary: 'Approved B', author: 'brain', at: 40,
        requestId: 'q-b',
      });
      expect(store.isDecisionResolved(reqB)).toBe(true);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F3-R2: bounded in-process feature integration test (tick, failure, reopen, old delivery, note arrival, retirement, 20+ card check)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feature-e2e-'));
    const path = join(dir, 'pairs.sqlite');
    try {
      let store = new TaskPairStore(path);
      setTaskPairStoreForTests(store);

      const sent: string[] = [];
      let failDelivery = true;
      setTaskPairDeliveryDepsForTests({
        send: async (_target, text) => {
          sent.push(text);
          if (failDelivery) throw new Error('simulated network transport failure');
        },
      });

      const blockedBase: TaskPairState = {
        taskId: 'tsk-e2e',
        title: 'integration test',
        brain: 'brain',
        executor: 'exec',
        auditor: 'audit',
        status: 'working',
        round: 1,
        deliveryRound: 1,
        flags: ['blocked'],
        flagSides: { blocked: 'executor' },
        blocking: ['P0'],
        createdAt: 100,
        updatedAt: 100,
        previousAuditors: [],
      } as unknown as TaskPairState;

      store.savePair('p', blockedBase);

      // Step 1: Initial automation tick enqueues notification and attempts delivery (which fails)
      const firstTick = checkTaskPairMissingExplanation(store.getPair('p', 'tsk-e2e')!, 200);
      expect(firstTick).toBe(true);
      await taskPairService.waitForIdle();

      // Delivery failed: exactly 1 pending notification in SQLite outbox with 1 attempt
      const pendingBeforeReopen = store.listPendingDecisionNotifications();
      expect(pendingBeforeReopen).toHaveLength(1);
      expect(pendingBeforeReopen[0].attempts).toBe(1);
      expect(pendingBeforeReopen[0].reason).toBe('missing-explanation-request');
      expect(sent).toHaveLength(1);

      // Step 2: Store reopen across restart preserves the pending notification
      store.close();
      store = new TaskPairStore(path);
      setTaskPairStoreForTests(store);

      const pendingAfterReopen = store.listPendingDecisionNotifications();
      expect(pendingAfterReopen).toHaveLength(1);
      expect(pendingAfterReopen[0].id).toBe(pendingBeforeReopen[0].id);

      // Step 3: Unchanged repeated tick does not re-enqueue duplicate (deduped by stable key)
      const repeatedTick = checkTaskPairMissingExplanation(store.getPair('p', 'tsk-e2e')!, 300);
      expect(repeatedTick).toBe(false);
      expect(store.listPendingDecisionNotifications()).toHaveLength(1);

      // Step 4: Old delivery request does not suppress missing-explanation notice in new delivery round
      store.savePair('p', { ...blockedBase, deliveryRound: 2 });
      store.recordDecision({
        id: 'old-request',
        project: 'p',
        taskId: 'tsk-e2e',
        round: 1,
        deliveryRound: 1,
        kind: 'request',
        conclusion: 'Old question',
        summary: 'From delivery 1',
        author: 'exec',
        at: 50,
      });
      // In delivery 2, old request does NOT suppress
      expect(checkTaskPairMissingExplanation(store.getPair('p', 'tsk-e2e')!, 350)).toBe(true);
      expect(store.listPendingDecisionNotifications()).toHaveLength(2);

      // Step 5: Explanation arrival causes retry/flush to retire the obsolete row without sending
      sent.length = 0;
      failDelivery = false;
      // Add blockedNote to resolve the blocker
      store.savePair('p', { ...blockedBase, blockedNote: 'Database migration in progress' });
      await taskPairService.retryDecisionNotifications(400);

      // The obsolete notification for delivery 1 was retired without sending anything!
      expect(sent).toEqual([]);
      // Delivery 1 notification is marked delivered (retired)
      const pendingAfterRetire = store.listPendingDecisionNotifications();
      expect(pendingAfterRetire.every((row) => row.decisionId.includes('missing-explanation:p:tsk-e2e:2:'))).toBe(true);

      // Step 6: Negative controls
      // Ordinary completed acceptance (passed, no blocker flags)
      store.savePair('p', { ...blockedBase, status: 'passed', flags: [] });
      expect(checkTaskPairMissingExplanation(store.getPair('p', 'tsk-e2e')!, 500)).toBe(false);

      // Capacity wait
      store.savePair('p', { ...blockedBase, flags: ['waiting_for_capacity'] as any });
      expect(checkTaskPairMissingExplanation(store.getPair('p', 'tsk-e2e')!, 510)).toBe(false);

      // Manual pause
      store.savePair('p', { ...blockedBase, flags: [], scheduling: { manual: true, note: 'Paused for maintenance' } as any });
      expect(checkTaskPairMissingExplanation(store.getPair('p', 'tsk-e2e')!, 520)).toBe(false);

      // Dependency wait
      store.savePair('p', { ...blockedBase, flags: [], scheduling: { dependsOn: ['tsk-dep-1'], note: 'Waiting' } as any });
      expect(checkTaskPairMissingExplanation(store.getPair('p', 'tsk-e2e')!, 530)).toBe(false);

      // Post-PASS unknown blocker is a positive control
      store.savePair('p', {
        ...blockedBase,
        status: 'passed',
        round: 3,
        flags: ['blocked'],
        lastVerdict: { verb: 'PASS', round: 2, counts: {}, judgement: 'pass' } as any,
      });
      expect(checkTaskPairMissingExplanation(store.getPair('p', 'tsk-e2e')!, 540)).toBe(true);

      // Step 7: Bounded-cost check over 25 cards
      const t0 = Date.now();
      for (let i = 0; i < 25; i++) {
        const cardState: TaskPairState = {
          ...blockedBase,
          taskId: `card-${i}`,
          round: 1,
          flags: i % 2 === 0 ? ['blocked'] : [],
          status: i % 3 === 0 ? 'passed' : 'working',
          blockedNote: i % 4 === 0 ? 'Has note' : undefined,
        } as unknown as TaskPairState;
        store.savePair('p', cardState);
        checkTaskPairMissingExplanation(store.getPair('p', `card-${i}`)!, 600 + i);
      }
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1000); // 25 card evaluations must be under 1s

      await taskPairService.waitForIdle();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F3-R3: a liveness-only heartbeat event must not create duplicate explanation episode, while genuine new episode triggers notification', async () => {
    const store = getTaskPairStore();
    const sent: string[] = [];
    setTaskPairDeliveryDepsForTests({ send: async (_target, text) => { sent.push(text); } });

    const pairState: TaskPairState = {
      ...state,
      taskId: 'f3-liveness',
      status: 'working',
      round: 1,
      deliveryRound: 1,
      flags: ['blocked'],
      flagSides: { blocked: 'executor' },
      createdAt: 100,
      updatedAt: 100,
    } as unknown as TaskPairState;
    store.savePair('p', pairState);

    expect(checkTaskPairMissingExplanation(store.getPair('p', 'f3-liveness')!, 100)).toBe(true);
    await taskPairService.retryDecisionNotifications(100);
    expect(sent).toHaveLength(1);

    // Record routine liveness-only NUDGE heartbeat event
    store.recordEvent({
      id: 'heartbeat:nudge:p:f3-liveness:200:idle',
      project: 'p',
      taskId: 'f3-liveness',
      writer: 'daemon',
      role: 'daemon',
      verb: 'NUDGE',
      attrs: { reason: 'idle' },
      effect: 'sent',
      unusual: false,
      source: 'heartbeat',
      fromStatus: 'working',
      toStatus: 'working',
      at: 200,
    });

    // Check on subsequent tick must not re-enqueue or duplicate
    const insertedAgain = checkTaskPairMissingExplanation(store.getPair('p', 'f3-liveness')!, 201);
    await taskPairService.retryDecisionNotifications(201);
    expect(insertedAgain).toBe(false);
    expect(sent).toHaveLength(1);

    // A genuine new episode transition (e.g. participant BLOCKED marker event) triggers a new notification
    store.recordEvent({
      id: 'marker:blocked:p:f3-liveness:300',
      project: 'p',
      taskId: 'f3-liveness',
      writer: 'exec',
      role: 'executor',
      verb: 'BLOCKED',
      attrs: {},
      effect: 'blocked',
      unusual: false,
      source: 'marker',
      fromStatus: 'working',
      toStatus: 'working',
      at: 300,
    });
    const genuineNewEpisode = checkTaskPairMissingExplanation(store.getPair('p', 'f3-liveness')!, 301);
    await taskPairService.retryDecisionNotifications(301);
    expect(genuineNewEpisode).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('F3-R3: a failed delivery-1 row must not be sent when delivery 2 is the current unknown context', async () => {
    const store = getTaskPairStore();
    let fail = true;
    const sent: string[] = [];
    setTaskPairDeliveryDepsForTests({
      send: async (_target, text) => {
        sent.push(text);
        if (fail) throw new Error('transport failure');
      },
    });

    const pairState: TaskPairState = {
      ...state,
      taskId: 'f3-cross-delivery',
      status: 'working',
      round: 1,
      deliveryRound: 1,
      flags: ['blocked'],
      flagSides: { blocked: 'executor' },
      createdAt: 100,
      updatedAt: 100,
    } as unknown as TaskPairState;
    store.savePair('p', pairState);

    expect(checkTaskPairMissingExplanation(store.getPair('p', 'f3-cross-delivery')!, 100)).toBe(true);
    await taskPairService.retryDecisionNotifications(100);
    expect(store.listPendingDecisionNotifications().filter((n) => n.taskId === 'f3-cross-delivery')).toHaveLength(1);

    // Advances to delivery 2
    store.savePair('p', { ...pairState, deliveryRound: 2, updatedAt: 200 });
    expect(checkTaskPairMissingExplanation(store.getPair('p', 'f3-cross-delivery')!, 201)).toBe(true);
    await taskPairService.retryDecisionNotifications(201);

    // Fail cleared, retry at 300: stale delivery 1 must be retired without sending, only delivery 2 sent
    sent.length = 0;
    fail = false;
    await taskPairService.retryDecisionNotifications(300);
    expect(sent).toHaveLength(1);
    expect(store.listPendingDecisionNotifications().filter((n) => n.taskId === 'f3-cross-delivery')).toHaveLength(0);
  });

  it('F3-R3: bounded manual tick drives admission, outbox, delivery, dedup over heartbeats, and note retirement into console projection', async () => {
    const prevEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    try {
      const store = getTaskPairStore();
      const sent: { target: string; text: string; id: string }[] = [];
      setTaskPairDeliveryDepsForTests({
        send: async (target, text, id) => {
          sent.push({ target, text, id });
        },
      });

      let clock = 1000;
      const automation = new TaskPairAutomation({
        now: () => clock,
        isBusy: () => false,
        importLegacy: () => undefined,
        mainCheckoutRoots: () => [{ project: 'p', root: '/tmp/p' }],
        brainMainCheckoutActive: () => false,
      });
      taskPairService.setScheduler(automation);

      const pairState: TaskPairState = {
        ...state,
        taskId: 'f3-tick-projection',
        status: 'working',
        round: 1,
        deliveryRound: 1,
        flags: ['blocked'],
        flagSides: { blocked: 'executor' },
        createdAt: 1000,
        updatedAt: 1000,
      } as unknown as TaskPairState;
      store.savePair('p', pairState);

      const explanationNotices = () => sent.filter((s) => s.id.includes('f3-tick-projection') && s.id.includes('missing-explanation-request'));

      // 1. Initial manual tick drives admission, outbox, and delivery
      await automation.tick();
      await taskPairService.waitForIdle();
      expect(explanationNotices()).toHaveLength(1);

      // 2. Subsequent manual tick with heartbeat liveness events does not duplicate
      clock += 6 * 60_000;
      await automation.tick();
      await taskPairService.waitForIdle();
      expect(explanationNotices()).toHaveLength(1);

      // 3. Blocker note arrives
      clock += 1000;
      const updatedState: TaskPairState = {
        ...pairState,
        blockedNote: 'Root cause identified: missing auth header',
        updatedAt: clock,
      };
      store.savePair('p', updatedState);

      // Next tick retires outbox row without re-sending
      clock += 6 * 60_000;
      await automation.tick();
      await taskPairService.waitForIdle();
      expect(explanationNotices()).toHaveLength(1);
      expect(store.listPendingDecisionNotifications().filter((n) => n.taskId === 'f3-tick-projection')).toHaveLength(0);

      // 4. Verify console row projection contract reflects updated blockerNote and context
      const stored = store.getPair('p', 'f3-tick-projection')!;
      const row = buildPairConsoleRow(stored, { inlineBrief: false });
      expect(row.task.pair.blockedNote).toBe('Root cause identified: missing auth header');
      expect(row.task.pair.decisionRevision).toBeDefined();
      expect(row.task.blocker).toBe('blocked');
    } finally {
      if (prevEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = prevEngine;
    }
  });
});

