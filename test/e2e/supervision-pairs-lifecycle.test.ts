/**
 * E2E: the shipped `pairs` supervision engine, end to end through the real
 * daemon modules.
 *
 * A Brain opens work with an ordinary send_message (new objective, no taskId);
 * the daemon mints the task id, names it on the accepted receipt, opens the
 * pair and picks an allowlisted auditor from the Brain's own sub-sessions.
 * From then on only markers in final assistant turns drive it: executor
 * READY_FOR_AUDIT -> auditor REWORK (blocking P0) -> executor READY_FOR_AUDIT ->
 * auditor PASS -> executor DONE. The legacy registry is never touched.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Before any daemon module resolves a ~/.imcodes path (logger, stores).
const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-pairs-e2e-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return { home, previousHome };
});

const live = vi.hoisted(() => ({ sessions: [] as Array<Record<string, unknown>> }));
vi.mock('../../src/store/session-store.js', () => ({
  listSessions: () => live.sessions,
  getSession: (name: string) => live.sessions.find((session) => session.name === name),
  upsertSession: () => undefined,
}));

import type { SessionRecord } from '../../src/store/session-store.js';
import { TASK_PAIR_ENGINE_ENV, TASK_PAIR_TIMELINE_EVENT, type TaskPairEngine } from '../../shared/task-pair.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import {
  clearSendIdempotencyCacheForTests,
  dispatchSendMessage,
  type SendMessageInput,
  type SendRuntimeCaller,
} from '../../src/daemon/send-tool.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../src/daemon/task-pairs/scheduler.js';
import { resolveTaskPairEngine } from '../../src/daemon/task-pairs/engine.js';
import { getSupervisionTaskRegistry, resetSupervisionTaskRegistryForTests } from '../../src/daemon/supervision-state-store.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';

const PROJECT = 'e2epairs';
const BRAIN = 'deck_e2epairs_brain';
const EXEC = 'deck_sub_e2e_pairs_exec';
const AUD = 'deck_sub_e2e_pairs_aud';
const PAIRS_ENGINE: TaskPairEngine = 'pairs';

function session(name: string, role: SessionRecord['role'], agentType: SessionRecord['agentType'], model: string): SessionRecord {
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    projectName: PROJECT,
    role,
    agentType,
    projectDir: join(env.home, 'repo'),
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    requestedModel: model,
    activeModel: model,
    runtimeType: 'transport',
    ...(role === 'brain' ? {} : { parentSession: BRAIN, userCreated: true, label: name }),
  } as SessionRecord;
}

function caller(name: string): SendRuntimeCaller {
  return { userId: name, sessionName: name, projectName: PROJECT, projectRoot: join(env.home, 'repo') };
}

let root: string;
let delivered: Array<{ target: string; text: string }>;
let automation: TaskPairAutomation;
let pairEvents: Array<{ session: string; payload: Record<string, unknown> }>;
let offTimeline: (() => void) | undefined;
let turn = 0;
const previousEngine = process.env[TASK_PAIR_ENGINE_ENV];

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A final assistant turn, exactly as the transport relay emits it. */
async function say(sessionName: string, text: string): Promise<void> {
  turn += 1;
  timelineEmitter.emit(sessionName, 'assistant.text', { text, streaming: false }, {
    source: 'daemon', confidence: 'high', eventId: `pairs-e2e-turn-${turn}`,
  });
  await settle();
}

function pairOf(taskId: string) {
  return getTaskPairStore().getPair(PROJECT, taskId)?.state;
}

beforeEach(() => {
  // No override: the project resolves to the shipped default engine.
  delete process.env[TASK_PAIR_ENGINE_ENV];
  root = mkdtempSync(join(tmpdir(), 'imcodes-pairs-e2e-'));
  process.env.IMCODES_SUPERVISION_STATE_DB_PATH = join(root, 'supervision-state.sqlite');
  resetSupervisionTaskRegistryForTests();
  resetTransportQueueStoreForTests();
  clearSendIdempotencyCacheForTests();
  setTaskPairStoreForTests(new TaskPairStore(join(root, 'task-pairs.sqlite')));
  delivered = [];
  setTaskPairDeliveryDepsForTests({ send: async (target, text) => { delivered.push({ target, text }); } });
  live.sessions = [
    session(BRAIN, 'brain', 'claude-code-sdk', 'claude-opus-4-7'),
    session(EXEC, 'w1', 'codex-sdk', 'gpt-6-luna'),
    session(AUD, 'w2', 'claude-code-sdk', 'claude-opus-4-7'),
  ] as Array<Record<string, unknown>>;
  automation = new TaskPairAutomation({ isBusy: () => false, isLimited: () => false, importLegacy: () => undefined });
  taskPairService.init();
  taskPairService.setScheduler(automation);
  pairEvents = [];
  offTimeline = timelineEmitter.on((event) => {
    if (event.type === TASK_PAIR_TIMELINE_EVENT) pairEvents.push({ session: event.sessionId, payload: event.payload });
  });
});

afterEach(() => {
  offTimeline?.();
  automation.stop();
  taskPairService.setScheduler(undefined);
  taskPairService.dispose();
  setTaskPairDeliveryDepsForTests(undefined);
  setTaskPairStoreForTests(undefined);
  resetSupervisionTaskRegistryForTests();
  resetTransportQueueStoreForTests();
  delete process.env.IMCODES_SUPERVISION_STATE_DB_PATH;
  live.sessions = [];
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (previousEngine === undefined) delete process.env[TASK_PAIR_ENGINE_ENV];
  else process.env[TASK_PAIR_ENGINE_ENV] = previousEngine;
  if (env.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.previousHome;
  rmSync(env.home, { recursive: true, force: true });
});

describe('E2E: marker-driven task pairs (default engine)', () => {
  it('dispatches by send_message, runs a REWORK round and a PASS by markers, and finishes done', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue('queued');
    const send = (from: SendRuntimeCaller, input: SendMessageInput) => dispatchSendMessage(from, input, {
      listSessions: () => live.sessions as unknown as SessionRecord[],
      dispatchMessage,
    });

    expect(resolveTaskPairEngine(PROJECT)).toBe(PAIRS_ENGINE);

    // 1. The Brain opens the work the legacy way: a new objective, no taskId.
    const created = await send(caller(BRAIN), {
      target: EXEC,
      message: 'Add one meaningful README sentence and validate it.',
      reply: true,
      idempotencyKey: 'pairs-e2e-readme',
      task: {
        classification: 'independent_top_level',
        objective: 'Add one README sentence',
        acceptance: ['one audit PASS'],
        ownedFiles: ['README.md'],
      },
    });
    if (created.status !== 'accepted' || !created.taskId) throw new Error(`dispatch failed: ${JSON.stringify(created)}`);
    const taskId = created.taskId;
    expect(created).toMatchObject({ taskTitle: 'Add one README sentence', taskObjective: 'Add one README sentence' });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    await settle();

    // The pair is open with the Brain's target as executor, and the daemon
    // picked the allowlisted Opus sub-session as auditor and told it so.
    expect(pairOf(taskId)).toMatchObject({
      status: 'working', brain: BRAIN, executor: EXEC, auditor: AUD, round: 0, title: 'Add one README sentence',
    });
    expect(pairOf(taskId)?.flags).not.toContain('needs_auditor');
    expect(delivered.some((entry) => entry.target === AUD && entry.text.includes(taskId))).toBe(true);
    // Nothing reached the legacy registry.
    expect(getSupervisionTaskRegistry().get(taskId)).toBeUndefined();

    // 2. Round 1: the executor asks for audit, the auditor finds a P0.
    await say(EXEC, `README sentence added; tests pass.\n<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'in_audit', round: 1 });
    await say(AUD, `[P0] the sentence contradicts the install section.\n<!-- IMCODES_TASK REWORK ${taskId} blocking=P0 p0=1 p1=0 -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'rework', round: 1 });

    // 3. Round 2: fixed, re-audited, PASS with zero blocking findings.
    await say(EXEC, `Fixed the contradiction.\n<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'in_audit', round: 2 });
    await say(AUD, `No blocking findings.\n<!-- IMCODES_TASK PASS ${taskId} blocking=P0 p0=0 -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'passed', round: 2 });

    // 4. The executor commits/pushes itself and closes the pair.
    await say(EXEC, `Committed and pushed.\n<!-- IMCODES_TASK DONE ${taskId} -->`);
    const done = pairOf(taskId);
    expect(done?.status).toBe('done');
    expect(done?.flags ?? []).not.toContain('unaudited');
    expect(done?.flags ?? []).not.toContain('verdict_inconsistent');

    // Every marker became a timeline event on the pair's participants.
    const verbs = pairEvents
      .filter((event) => event.session === BRAIN && event.payload.taskId === taskId)
      .map((event) => event.payload.verb);
    // REASSIGN is the daemon's own auditor pick.
    expect(verbs).toEqual(['DISPATCH', 'REASSIGN', 'READY_FOR_AUDIT', 'REWORK', 'READY_FOR_AUDIT', 'PASS', 'DONE']);

    // A closed pair is out of the heartbeat: the next tick nudges nobody.
    const before = delivered.length;
    await automation.tick();
    await settle();
    expect(delivered.slice(before).filter((entry) => entry.text.includes(taskId))).toEqual([]);
    expect(getTaskPairStore().isParticipantOfOpenPair(EXEC)).toBe(false);
    expect(getTaskPairStore().isParticipantOfOpenPair(AUD)).toBe(false);
  });

  it('holds a REWORK that carries no blocking finding and asks the auditor to correct it', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue('queued');
    const created = await dispatchSendMessage(caller(BRAIN), {
      target: EXEC,
      message: 'Tidy the README.',
      idempotencyKey: 'pairs-e2e-held',
      task: { objective: 'Tidy the README' },
    }, { listSessions: () => live.sessions as unknown as SessionRecord[], dispatchMessage });
    if (created.status !== 'accepted' || !created.taskId) throw new Error(`dispatch failed: ${JSON.stringify(created)}`);
    const taskId = created.taskId;
    await settle();

    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} -->`);
    const before = delivered.length;
    await say(AUD, `Only nits.\n<!-- IMCODES_TASK REWORK ${taskId} blocking=P0 p0=0 p3=2 -->`);
    // Not a REWORK under audit_convergence_v1: the verdict is held, not applied.
    expect(pairOf(taskId)).toMatchObject({ status: 'in_audit', round: 1 });
    expect(delivered.slice(before).some((entry) => entry.target === AUD && entry.text.includes(taskId))).toBe(true);

    await say(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 p0=0 p3=2 -->`);
    expect(pairOf(taskId)?.status).toBe('passed');
  });
});

