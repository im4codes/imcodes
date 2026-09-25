/**
 * Production incident (2026-09-25, auto-upgrade restart at 08:01:15Z): four
 * task-bound delegation replies from Cx8/Cx6/Cx4 -- about tasks cancelled or
 * finalized four to twelve days earlier (tsk_of4, tsk_mp0, tsk_16hu, tsk_16i6)
 * -- reached the Brain at 08:02:14Z as fresh completions. A task-bound reply
 * never expires by time and waits for its exact origin; the next startup
 * resume whose origin matched delivered them, because nothing asked whether
 * the task was still alive.
 *
 * Real delegation-reply store, real supervision registry and real pair store
 * (temp paths); only the session record, the provider runtime, the timeline
 * and the transport-queue snapshot are doubles.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  AGENT_DELEGATION_REPLY_STATUSES,
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
} from '../../shared/agent-delegation.js';
import { taskPairBindingId, type TaskPairState, type TaskPairStatus } from '../../shared/task-pair.js';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  runtime: undefined as undefined | {
    send: ReturnType<typeof vi.fn>;
    deliverDelegationNotification: ReturnType<typeof vi.fn>;
    recipientIdentity: { sessionInstanceId: string; runtimeEpoch: string };
  },
  timelineEmit: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (name: string) => mocks.sessions.get(name),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: () => mocks.runtime,
  ensureTransportRuntimeAvailable: vi.fn(async () => mocks.runtime),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: mocks.timelineEmit },
}));

vi.mock('../../src/daemon/transport-queue-store.js', () => ({
  getTransportQueueStore: () => ({
    readSnapshot: () => ({ pendingMessageEntries: [] }),
    hasDeliveryTombstone: () => false,
  }),
}));

import {
  clearDelegationReplyIngressForTests,
  resumePendingDelegationReplies,
  sweepStaleDeliveryOriginsForAutoRebind,
} from '../../src/daemon/delegation-reply-ingress.js';
import {
  getDelegationReplyStore,
  resetDelegationReplyStoreForTests,
} from '../../src/daemon/delegation-reply-store.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import {
  resolveQueuedDelegationReplyAdmission,
  resolveTransportQueueEntryAdmission,
} from '../../src/daemon/delegation-reply-task-liveness.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const PROJECT = 'stale-project';
const brain = { sessionName: 'deck_stale_brain', sessionInstanceId: 'brain-instance', runtimeEpoch: 'brain-epoch' };
const worker = { sessionName: 'deck_sub_stale_worker', sessionInstanceId: 'worker-instance', runtimeEpoch: 'worker-epoch' };

const roots: string[] = [];
const priorEnv: Record<string, string | undefined> = {};
let pairs: TaskPairStore;

beforeEach(() => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), 'imcodes-stale-redelivery-'));
  roots.push(root);
  for (const key of ['IMCODES_SUPERVISION_STATE_DB_PATH', 'IMCODES_DELEGATION_REPLY_DB_PATH']) priorEnv[key] = process.env[key];
  process.env.IMCODES_SUPERVISION_STATE_DB_PATH = join(root, 'supervision.sqlite');
  process.env.IMCODES_DELEGATION_REPLY_DB_PATH = join(root, 'delegation-replies.sqlite');
  clearDelegationReplyIngressForTests();
  resetDelegationReplyStoreForTests();
  resetSupervisionTaskRegistryForTests();
  pairs = new TaskPairStore(join(root, 'task-pairs.sqlite'));
  setTaskPairStoreForTests(pairs);
  mocks.sessions.clear();
  mocks.timelineEmit.mockClear();
  mocks.runtime = undefined;
});

afterEach(() => {
  clearDelegationReplyIngressForTests();
  resetDelegationReplyStoreForTests();
  resetSupervisionTaskRegistryForTests();
  setTaskPairStoreForTests(undefined);
  vi.useRealTimers();
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function legacyTask(taskId: string): { workerAssignmentId: string; coordinatorAssignmentId: string } {
  const registry = getSupervisionTaskRegistry();
  expect(registry.createOrGet({
    taskId,
    projectName: PROJECT,
    classification: 'independent_top_level',
    objective: 'exercise a task-bound reply across a daemon restart',
    acceptance: ['delivered only while the task is alive'],
    currentRevision: `${taskId}-r1`,
  })).toMatchObject({ ok: true });
  const coordinator = registry.createAssignment({
    assignmentId: `asg_${taskId}_brain`,
    taskId,
    role: 'coordinator',
    identity: { ...brain, agentType: 'claude-code-sdk', providerFamily: 'anthropic' },
    required: false,
  });
  const implementer = registry.createAssignment({
    assignmentId: `asg_${taskId}_worker`,
    taskId,
    role: 'implementer',
    identity: { ...worker, agentType: 'codex-sdk', providerFamily: 'openai' },
    required: true,
  });
  if (!coordinator.ok || !implementer.ok) throw new Error('fixture assignment creation failed');
  return { workerAssignmentId: `asg_${taskId}_worker`, coordinatorAssignmentId: `asg_${taskId}_brain` };
}

function pairState(taskId: string, status: TaskPairStatus): TaskPairState {
  return {
    taskId, brain: brain.sessionName, executor: worker.sessionName, auditor: 'deck_sub_stale_auditor',
    status, flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [],
    capCounts: {}, capRound: 1, createdAt: 1, updatedAt: 1,
  };
}

/**
 * End a task the way production rows look. `cancelled` goes through the
 * registry's own update; `finalized` is only reachable through the full
 * integration-finalize path, so the durable row is written as the incident's
 * tsk_16hu/tsk_16i6 rows were found.
 */
function endTask(taskId: string, status: 'cancelled' | 'finalized'): void {
  if (status === 'cancelled') {
    expect(getSupervisionTaskRegistry().updateTask({ taskId, status })).toMatchObject({ ok: true });
    return;
  }
  const db = new DatabaseSync(process.env.IMCODES_SUPERVISION_STATE_DB_PATH!);
  try {
    expect(db.prepare(
      "UPDATE supervision_tasks SET status = ?, payload_json = json_set(payload_json, '$.status', ?) WHERE task_id = ?",
    ).run(status, status, taskId).changes).toBe(1);
  } finally {
    db.close();
  }
  expect(getSupervisionTaskRegistry().getTaskRecord(taskId)?.status).toBe(status);
}

/** A worker's reply the daemon received while the Brain could not take it. */
function receivedReply(input: { taskId: string; assignmentId: string; coordinatorAssignmentId?: string; result: string }) {
  const store = getDelegationReplyStore();
  const created = store.create({
    origin: brain,
    target: worker,
    dispatchId: `dispatch-${input.taskId}`,
    messageId: `message-${input.taskId}`,
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    ...(input.coordinatorAssignmentId ? { coordinatorAssignmentId: input.coordinatorAssignmentId } : {}),
  });
  const received = store.receive({ delegationId: created.record.delegationId, result: input.result, sender: worker });
  if (!received.ok) throw new Error(`fixture receive failed: ${received.reason}`);
  return received.record;
}

/** The daemon comes back: the Brain's exact origin is live again, then startup resume runs. */
async function restartAndResume(): Promise<void> {
  clearDelegationReplyIngressForTests();
  mocks.sessions.set(brain.sessionName, {
    name: brain.sessionName, projectName: PROJECT, state: 'idle',
    sessionInstanceId: brain.sessionInstanceId, runtimeEpoch: brain.runtimeEpoch,
  });
  mocks.sessions.set(worker.sessionName, {
    name: worker.sessionName, projectName: PROJECT, state: 'idle', label: 'Cx8',
    sessionInstanceId: worker.sessionInstanceId, runtimeEpoch: worker.runtimeEpoch,
  });
  mocks.runtime = {
    send: vi.fn(() => 'sent'),
    deliverDelegationNotification: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
    recipientIdentity: { sessionInstanceId: brain.sessionInstanceId, runtimeEpoch: brain.runtimeEpoch },
  };
  resumePendingDelegationReplies();
  await vi.advanceTimersByTimeAsync(1_000);
}

function replyCards(): unknown[] {
  return mocks.timelineEmit.mock.calls.filter(([, type]) => type === AGENT_DELEGATION_REPLY_TIMELINE_EVENT);
}

describe('task-bound delegation replies across a daemon restart', () => {
  it('delivers a received reply once its task is alive after the restart (positive control)', async () => {
    const task = legacyTask('tsk_live');
    const reply = receivedReply({ taskId: 'tsk_live', assignmentId: task.workerAssignmentId, coordinatorAssignmentId: task.coordinatorAssignmentId, result: 'live task update' });

    await restartAndResume();

    expect(mocks.runtime!.send).toHaveBeenCalledTimes(1);
    expect(getDelegationReplyStore().getMessage(reply.delegationId, reply.notificationId)?.status)
      .toBe(AGENT_DELEGATION_REPLY_STATUSES.DELIVERED);
  });

  for (const endedStatus of ['cancelled', 'finalized'] as const) {
    it(`never delivers a reply whose legacy task became ${endedStatus} while it waited`, async () => {
      const task = legacyTask(`tsk_${endedStatus}`);
      const reply = receivedReply({ taskId: `tsk_${endedStatus}`, assignmentId: task.workerAssignmentId, coordinatorAssignmentId: task.coordinatorAssignmentId, result: `stale update for a ${endedStatus} task` });
      endTask(`tsk_${endedStatus}`, endedStatus);

      await restartAndResume();
      // And a later restart cannot re-arm it either.
      await restartAndResume();
      sweepStaleDeliveryOriginsForAutoRebind();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(mocks.runtime!.send).not.toHaveBeenCalled();
      expect(mocks.runtime!.deliverDelegationNotification).not.toHaveBeenCalled();
      expect(replyCards(), 'no fresh completion card for an ended task').toEqual([]);
      expect(getDelegationReplyStore().getMessage(reply.delegationId, reply.notificationId)?.status)
        .toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
      expect(getDelegationReplyStore().listReceived().map((record) => record.delegationId)).not.toContain(reply.delegationId);
    });
  }

  it('keeps a blocked task\'s reply (blocked can be recovered; only ended tasks retire)', async () => {
    const task = legacyTask('tsk_blocked');
    receivedReply({ taskId: 'tsk_blocked', assignmentId: task.workerAssignmentId, coordinatorAssignmentId: task.coordinatorAssignmentId, result: 'blocked task update' });
    expect(getSupervisionTaskRegistry().updateTask({ taskId: 'tsk_blocked', status: 'blocked' })).toMatchObject({ ok: true });

    await restartAndResume();

    expect(mocks.runtime!.send).toHaveBeenCalledTimes(1);
  });

  it('retires a pairs-engine reply once its pair is done, and delivers it while the pair is open', async () => {
    pairs.savePair(PROJECT, pairState('tsk_pair_done', 'done'));
    pairs.savePair(PROJECT, pairState('tsk_pair_open', 'working'));
    const done = receivedReply({ taskId: 'tsk_pair_done', assignmentId: taskPairBindingId('tsk_pair_done', 'executor'), result: 'pair done update' });
    const open = receivedReply({ taskId: 'tsk_pair_open', assignmentId: taskPairBindingId('tsk_pair_open', 'executor'), result: 'pair open update' });

    await restartAndResume();

    expect(mocks.runtime!.send).toHaveBeenCalledTimes(1);
    expect(getDelegationReplyStore().getMessage(done.delegationId, done.notificationId)?.status)
      .toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
    expect(getDelegationReplyStore().getMessage(open.delegationId, open.notificationId)?.status)
      .toBe(AGENT_DELEGATION_REPLY_STATUSES.DELIVERED);
  });

  it('treats a legacy task imported into a finished pair as ended', async () => {
    const task = legacyTask('tsk_imported');
    pairs.savePair(PROJECT, pairState('tsk_imported', 'cancelled'), { legacyTaskId: 'tsk_imported' });
    const reply = receivedReply({ taskId: 'tsk_imported', assignmentId: task.workerAssignmentId, coordinatorAssignmentId: task.coordinatorAssignmentId, result: 'imported legacy update' });

    await restartAndResume();

    expect(mocks.runtime!.send).not.toHaveBeenCalled();
    expect(getDelegationReplyStore().getMessage(reply.delegationId, reply.notificationId)?.status)
      .toBe(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED);
  });

  it('drops an already-queued reply at the transport queue edge once its task ended, and admits a live one', () => {
    const endedTask = legacyTask('tsk_queue_ended');
    const liveTask = legacyTask('tsk_queue_live');
    const ended = receivedReply({ taskId: 'tsk_queue_ended', assignmentId: endedTask.workerAssignmentId, result: 'queued before cancel' });
    const live = receivedReply({ taskId: 'tsk_queue_live', assignmentId: liveTask.workerAssignmentId, result: 'queued live' });
    // The durable FIFO owned both before the restart (delegation outbox closed).
    getDelegationReplyStore().markDelivered(ended.delegationId, ended.notificationId);
    getDelegationReplyStore().markDelivered(live.delegationId, live.notificationId);
    endTask('tsk_queue_ended', 'cancelled');

    expect(resolveQueuedDelegationReplyAdmission(ended.delegationId)).toBe('stale');
    expect(resolveQueuedDelegationReplyAdmission(live.delegationId)).toBe('authorized');
    expect(resolveQueuedDelegationReplyAdmission('unknown-delegation-id')).toBe('authorized');

    // The composed admission both drain edges use (restart resend + runtime FIFO).
    const queued = (delegationId: string) => ({
      clientMessageId: `client-${delegationId}`, text: 'queued reply', delegationReply: { delegationId },
    });
    expect(resolveTransportQueueEntryAdmission(brain.sessionName, queued(ended.delegationId))).toBe('stale');
    expect(resolveTransportQueueEntryAdmission(brain.sessionName, queued(live.delegationId))).toBe('authorized');
    expect(resolveTransportQueueEntryAdmission(brain.sessionName, { clientMessageId: 'plain', text: 'user text' }))
      .toBe('authorized');
  });
});
