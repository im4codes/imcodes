/**
 * E2E: the shipped `pairs` supervision engine, end to end through the real
 * daemon modules.
 *
 * A Brain opens work with structured pair_create; the daemon mints the task
 * id, names it on the accepted receipt, opens the pair and picks an allowlisted
 * auditor from the Brain's own sub-sessions.
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
import {
  TASK_PAIR_ENGINE_ENV,
  TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS,
  TASK_PAIR_TIMELINE_EVENT,
  type TaskPairEngine,
} from '../../shared/task-pair.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';

const UNTITLED_TASK_TITLE = TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS[1];
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import {
  clearSendIdempotencyCacheForTests,
} from '../../src/daemon/send-tool.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../src/daemon/task-pairs/scheduler.js';
import { resolveTaskPairEngine } from '../../src/daemon/task-pairs/engine.js';
import { getSupervisionTaskRegistry, resetSupervisionTaskRegistryForTests } from '../../src/daemon/supervision-state-store.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';

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

// Pair routing comes from the Brain's execution pool (tsk_cd_pairs_use_exec_pool):
// with no pool there is no built-in default any more (tsk_cd_pairs_no_pool_ask),
// so the Brain names the pool roles this E2E relies on — luna executes, the
// Opus sub-session audits.
// The auditor entry pins the exact live model id ("claude-opus-4-7", not the
// generic "opus[1M]" bucket) with a capabilityId built from that same literal
// model -- exactly how this pool entry silently vanished before
// tsk_cd_model_list_unified fixed normalizeSupervisionExecutionConfig's
// round-trip. Keeping it this way here is the regression coverage.
const PAIR_POOLS = {
  state: 'configured' as const,
  economyTaskPool: { configs: [], controls: { leaseMs: 900000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
  primaryDevelopmentPool: {
    configs: [
      { model: 'gpt-6-luna', agentType: 'codex-sdk', runtimeType: 'transport' as const, capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-6-luna', providerFamily: 'openai', role: 'executor' as const },
      { model: 'claude-opus-4-7', agentType: 'claude-code-sdk', runtimeType: 'transport' as const, capabilityId: 'supervision-exec-v1:transport:claude-code-sdk:anthropic:claude-opus-4-7', providerFamily: 'anthropic', role: 'auditor' as const },
    ],
    controls: { leaseMs: 1800000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 },
  },
};

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

async function createPair(input: { brief: string; idempotencyKey: string; title?: string }) {
  const handlers = createMemoryMcpToolHandlers({
    userId: BRAIN,
    sessionName: BRAIN,
    projectName: PROJECT,
    projectRoot: join(env.home, 'repo'),
  }, {
    sendDeps: { listSessions: () => live.sessions as unknown as SessionRecord[] },
  });
  return handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({
    brief: input.brief,
    executor: EXEC,
    auditor: AUD,
    idempotencyKey: input.idempotencyKey,
    ...(input.title ? { title: input.title } : {}),
  });
}

beforeEach(() => {
  // Pairs is no longer a zero-config default (owner decision, 2026-09-26,
  // tsk_cd_pairs_optin): a project must opt in, so this E2E explicitly
  // requests the engine via the override rather than relying on a default.
  process.env[TASK_PAIR_ENGINE_ENV] = 'pairs';
  root = mkdtempSync(join(tmpdir(), 'imcodes-pairs-e2e-'));
  process.env.IMCODES_SUPERVISION_STATE_DB_PATH = join(root, 'supervision-state.sqlite');
  resetSupervisionTaskRegistryForTests();
  resetTransportQueueStoreForTests();
  clearSendIdempotencyCacheForTests();
  setTaskPairStoreForTests(new TaskPairStore(join(root, 'task-pairs.sqlite')));
  delivered = [];
  setTaskPairDeliveryDepsForTests({ send: async (target, text) => { delivered.push({ target, text }); } });
  live.sessions = [
    {
      ...session(BRAIN, 'brain', 'claude-code-sdk', 'claude-opus-4-7'),
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, executionPools: PAIR_POOLS }) },
    },
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

afterEach(async () => {
  offTimeline?.();
  automation.stop();
  taskPairService.setScheduler(undefined);
  await taskPairService.dispose();
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

describe('E2E: marker-driven task pairs (explicit pairs engine)', () => {
  it('dispatches by pair_create, runs a REWORK round and a PASS by markers, and finishes done', async () => {

    expect(resolveTaskPairEngine(PROJECT)).toBe(PAIRS_ENGINE);

    // 1. The Brain opens the work through the structured pair MCP surface.
    const created = await createPair({
      idempotencyKey: 'pairs-e2e-readme',
      brief: 'Implement a cross-file README update, add tests, and validate the integration.',
    });
    if (created.status !== 'ok' || !created.taskId) throw new Error(`dispatch failed: ${JSON.stringify(created)}`);
    const taskId = created.taskId;
    // No explicit title was given, so the pair starts under the neutral
    // placeholder (no UI locale in this test) until the Brain names it; the
    // objective alone is never promoted to a title.
    expect(created).toMatchObject({
      taskId,
    });
    await settle();

    // The pair is open with the Brain's target as executor, and the daemon
    // picked the Opus sub-session (the pool's auditor role) as auditor and told it so.
    expect(pairOf(taskId)).toMatchObject({
      status: 'working', brain: BRAIN, executor: EXEC, auditor: AUD, round: 0, title: UNTITLED_TASK_TITLE,
    });
    expect(pairOf(taskId)?.flags).not.toContain('needs_auditor');
    expect(delivered.some((entry) => entry.target === AUD && entry.text.includes(taskId))).toBe(true);
    // Nothing reached the legacy registry.
    expect(getSupervisionTaskRegistry().get(taskId)).toBeUndefined();

    // 2. Round 1: the executor asks for audit, the auditor finds a P0.
    // Owner rule: an auditor verdict is lawful only for a material-backed
    // audit round, so the executor names its result path explicitly.
    await say(EXEC, `README sentence added; tests pass.\n<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} path=/workspace -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'in_audit', round: 1 });
    await say(AUD, `[P0] the sentence contradicts the install section.\n<!-- IMCODES_TASK REWORK ${taskId} blocking=P0 p0=1 p1=0 -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'rework', round: 1 });

    // 3. Round 2: fixed, re-audited, PASS with zero blocking findings.
    await say(EXEC, `Fixed the contradiction.\n<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} path=/workspace -->`);
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
    expect(verbs).toEqual(['DISPATCH', 'READY_FOR_AUDIT', 'REWORK', 'READY_FOR_AUDIT', 'PASS', 'DONE']);

    // A closed pair is out of the heartbeat: the next tick nudges nobody.
    const before = delivered.length;
    await automation.tick();
    await settle();
    expect(delivered.slice(before).filter((entry) => entry.text.includes(taskId))).toEqual([]);
    expect(getTaskPairStore().isParticipantOfOpenPair(EXEC)).toBe(false);
    expect(getTaskPairStore().isParticipantOfOpenPair(AUD)).toBe(false);
  });

  it('delivers in rounds: PASS, Brain NEXT_ROUND x2, each round audited and PASSed by markers, then DONE (only the two deliberate negative markers are unusual)', async () => {
    const created = await createPair({
      idempotencyKey: 'pairs-e2e-rounds',
      brief: 'Deliver the staged change: spinner, console sync, watchdog.',
    });
    if (created.status !== 'ok' || !created.taskId) throw new Error(`dispatch failed: ${JSON.stringify(created)}`);
    const taskId = created.taskId;
    await settle();

    const HEAD1 = '1'.repeat(40);
    const HEAD2 = '2'.repeat(40);
    const HEAD3 = '3'.repeat(40);
    const DEV_TIP = '9'.repeat(40);

    // Round 1 ends in PASS, and Brain merges it (the pair stays passed, not done).
    await say(EXEC, `Spinner done.\n<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} worktree=/workspace head=${HEAD1} -->`);
    await say(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 p0=0 -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'passed', round: 1 });

    // Baseline: without NEXT_ROUND a further READY is only recorded as unusual.
    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} worktree=/workspace head=${HEAD2} -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'passed', round: 1 });
    expect(getTaskPairStore().listEvents(PROJECT, taskId).some((event) => event.verb === 'READY_FOR_AUDIT' && event.unusual)).toBe(true);

    // Round 2: Brain opens it on the merged dev tip.
    await say(BRAIN, `Round 1 is in dev.\n<!-- IMCODES_TASK NEXT_ROUND ${taskId} base=${DEV_TIP} note="console sync" -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'working', deliveryRound: 2, executor: EXEC, auditor: AUD });
    expect(getTaskPairStore().isParticipantOfOpenPair(EXEC)).toBe(true);
    await say(EXEC, `Console sync done.\n<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} worktree=/workspace head=${HEAD2} -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'in_audit', round: 2, deliveryRound: 2 });
    expect(pairOf(taskId)?.material).toMatchObject({ head: HEAD2, base: DEV_TIP });
    await say(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 p0=0 -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'passed', round: 2, deliveryRound: 2 });

    // Round 3 (default base: round 2's PASSed head), with a REWORK inside it.
    await say(BRAIN, `<!-- IMCODES_TASK NEXT_ROUND ${taskId} note="watchdog" -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'working', deliveryRound: 3 });
    expect(pairOf(taskId)?.roundBase).toMatchObject({ commit: HEAD2, source: 'passed_head' });
    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} worktree=/workspace head=${HEAD3} -->`);
    await say(AUD, `[P0] missing attribution.\n<!-- IMCODES_TASK REWORK ${taskId} blocking=P0 p0=1 -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'rework', deliveryRound: 3 });
    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} worktree=/workspace head=${'4'.repeat(40)} -->`);
    await say(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 p0=0 -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'passed', deliveryRound: 3 });

    // The panel event stream carries the delivery round from the second round on.
    const rounds = pairEvents
      .filter((event) => event.session === BRAIN && event.payload.taskId === taskId && event.payload.toStatus === 'working' && event.payload.verb === 'NEXT_ROUND')
      .map((event) => event.payload.deliveryRound);
    expect(rounds).toEqual([2, 3]);

    await say(EXEC, `Committed locally.\n<!-- IMCODES_TASK DONE ${taskId} -->`);
    expect(pairOf(taskId)?.status).toBe('done');
    // A DONE pair cannot start another round.
    await say(BRAIN, `<!-- IMCODES_TASK NEXT_ROUND ${taskId} -->`);
    expect(pairOf(taskId)).toMatchObject({ status: 'done', deliveryRound: 3 });
    // No unusual event other than the deliberate baseline READY and the closed-pair NEXT_ROUND.
    const unusual = getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.unusual).map((event) => `${event.verb}:${event.fromStatus}`);
    expect([...unusual].sort()).toEqual(['NEXT_ROUND:done', 'READY_FOR_AUDIT:passed']);
  });

  it('holds a REWORK that carries no blocking finding and asks the auditor to correct it', async () => {
    const created = await createPair({
      idempotencyKey: 'pairs-e2e-held',
      brief: 'Tidy the README.',
    });
    if (created.status !== 'ok' || !created.taskId) throw new Error(`dispatch failed: ${JSON.stringify(created)}`);
    const taskId = created.taskId;
    await settle();

    // Owner rule: the PASS below must close a material-backed audit round.
    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} path=/workspace -->`);
    const before = delivered.length;
    await say(AUD, `Only nits.\n<!-- IMCODES_TASK REWORK ${taskId} blocking=P0 p0=0 p3=2 -->`);
    // Not a REWORK under audit_convergence_v1: the verdict is held, not applied.
    expect(pairOf(taskId)).toMatchObject({ status: 'in_audit', round: 1 });
    expect(delivered.slice(before).some((entry) => entry.target === AUD && entry.text.includes(taskId))).toBe(true);

    await say(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 p0=0 p3=2 -->`);
    expect(pairOf(taskId)?.status).toBe('passed');
  });
});
