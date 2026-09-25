/**
 * Causal tests for the 2026-09-25 incident on 215 / jdzj: pairs that stopped
 * driving themselves after the legacy import.
 *
 *  1. The import scanned only the first 101 legacy tasks (registry page cap).
 *  2. Receipt-less integration slices were imported as `passed`.
 *  3. Liveness was per session, so a session in many pairs kept all alive.
 *  4. A usage-limited executor escalated at once, with advice that closes a
 *     passed pair uncommitted.
 *  5. The one-time correction of the pairs already mis-imported.
 */
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import {
  hasLegacyPassReceipt,
  importLegacyTasks,
  legacyTaskToPair,
  mapLegacyStatus,
  type LegacyImportRegistry,
} from '../../../src/daemon/task-pairs/legacy-import.js';
import { SupervisionTaskRegistry, type SupervisionTaskSnapshot } from '../../../src/daemon/supervision-state-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { suppressSqliteExperimentalWarning } from '../../../src/util/suppress-sqlite-warning.js';
import {
  TASK_PAIR_DEFAULT_MAX_CONCURRENCY,
  TASK_PAIR_TIMELINE_EVENT,
  type TaskPairState,
} from '../../../shared/task-pair.js';

suppressSqliteExperimentalWarning();
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const PROJECT = 'stuckproj';
const BRAIN = 'deck_stuckproj_brain';
const EXEC = 'deck_sub_stuckexec';
const AUD = 'deck_sub_stuckaud';
const SPARES = Array.from({ length: 10 }, (_, index) => `deck_sub_stuckspare${index}`);

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

let now = 1_000_000;
let turn = 0;
let sent: Array<{ target: string; text: string; id: string }>;
let busy: Set<string>;
/** Sessions that received a message this tick: queued work makes them busy (production: pending entries). */
let pendingThisTick: Set<string>;
let limited: Set<string>;
let spares: string[];
let automation: TaskPairAutomation;

function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `stuck-turn-${turn}`, now);
}
function pair(taskId: string): TaskPairState {
  return getTaskPairStore().getPair(PROJECT, taskId)!.state;
}
function sentTo(target: string, reasonPart?: string) {
  return sent.filter((entry) => entry.target === target && (!reasonPart || entry.id.includes(`:${reasonPart}:`)));
}
async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    now += 6 * 60_000;
    await automation.tick();
    await flush();
    // Between heartbeats every session works through what it was sent.
    pendingThisTick.clear();
  }
}

function snapshot(
  taskId: string,
  status: string,
  assignments: Array<[string, string, string]>,
  receipts: Array<'PASS' | 'REWORK'> = [],
): SupervisionTaskSnapshot {
  return {
    taskId, projectName: PROJECT, status, objective: `objective of ${taskId}`,
    assignments: assignments.map(([role, sessionName, assignmentStatus]) => ({ role, status: assignmentStatus, identity: { sessionName } })),
    auditReceipts: receipts.map((verdict, index) => ({
      receiptId: `r_${taskId}_${index}`, taskId, assignmentId: `asg_${taskId}`, attemptId: `att_${index}`, revision: 'rev',
      sequence: index, receiptKind: 'final', verdict, findings: '', validations: [],
      senderIdentity: { sessionName: AUD }, createdAt: 100 + index,
    })),
  } as unknown as SupervisionTaskSnapshot;
}

describe('pairs that stopped driving themselves (215 / jdzj)', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    sent = [];
    busy = new Set();
    pendingThisTick = new Set();
    limited = new Set();
    spares = [...SPARES];
    setTaskPairDeliveryDepsForTests({
      send: async (target, text, id) => { sent.push({ target, text, id }); pendingThisTick.add(target); },
    });
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2'), ...SPARES.map((name) => session(name, 'w3'))]) {
      upsertSession(record);
    }
    automation = new TaskPairAutomation({
      now: () => now,
      isBusy: (name) => busy.has(name) || pendingThisTick.has(name),
      isLimited: (name) => limited.has(name),
      // Like the real pool: an idle spare, used by one pair at a time.
      pickCandidate: ({ exclude }) => {
        const index = spares.findIndex((name) => !exclude.has(name));
        return index >= 0 ? spares.splice(index, 1)[0] : undefined;
      },
      provision: async () => undefined,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    taskPairService.setScheduler(automation);
  });

  afterEach(() => {
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, AUD, ...SPARES]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  // ---- 1. paging -----------------------------------------------------------

  it('imports every legacy task past the registry page cap of 101 rows (real registry)', () => {
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const total = 150;
    for (let index = 0; index < total; index += 1) {
      const taskId = `tsk_page_${String(index).padStart(3, '0')}`;
      expect(registry.createOrGet({
        taskId, projectName: PROJECT, classification: 'independent_top_level', objective: `page ${index}`, now: index + 1,
      })).toMatchObject({ ok: true });
    }
    // The registry really caps a page below what the importer used to ask for.
    expect(registry.list({ limit: 200 }).length).toBeLessThan(total);
    expect(importLegacyTasks(registry, 5_000, () => true)).toBe(total);
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_page_149')?.state.status).toBe('queued');
    expect(getTaskPairStore().getPairByLegacyTaskId('tsk_page_101')).toBeDefined();
    // Idempotent on the next pass.
    expect(importLegacyTasks(registry, 6_000, () => true)).toBe(0);
    registry.close();
  });

  it('keeps paging past a page that the registry filtered short, and stops on a cursor that does not advance', () => {
    const tasks = Array.from({ length: 5 }, (_, index) => snapshot(`tsk_short_${index}`, 'implementing', [['implementer', EXEC, 'implementing']]));
    const pages: Array<string | undefined> = [];
    // Pages of two, the first one filtered down to a single row.
    const registry: LegacyImportRegistry = {
      list: ({ cursor } = {}) => {
        pages.push(cursor);
        const rest = tasks.filter((task) => cursor === undefined || task.taskId > cursor);
        return cursor === undefined ? rest.slice(1, 2) : rest.slice(0, 2);
      },
    };
    expect(importLegacyTasks(registry, 5_000, () => true)).toBe(4);
    expect(pages).toEqual([undefined, 'tsk_short_1', 'tsk_short_3', 'tsk_short_4']);
    // A registry that ignores the cursor cannot make the import spin.
    const stuck: LegacyImportRegistry = { list: () => tasks };
    expect(importLegacyTasks(stuck, 6_000, () => true)).toBe(1);
  });

  // ---- 2. receipt-less passed mapping ---------------------------------------

  it('maps finished-but-unaudited legacy work to in_audit and only evidenced PASS to passed', () => {
    const slice = snapshot('tsk_slice', 'ready_for_integration', [['coordinator', BRAIN, 'delegated'], ['implementer', EXEC, 'ready_for_integration']]);
    expect(hasLegacyPassReceipt(slice)).toBe(false);
    expect(legacyTaskToPair(slice, 1)).toMatchObject({ status: 'in_audit', round: 1, flags: ['needs_auditor'], executor: EXEC });
    expect(legacyTaskToPair(slice, 1)?.passRound).toBeUndefined();

    const audited = snapshot('tsk_audited', 'ready_for_integration', [['implementer', EXEC, 'ready_for_integration'], ['auditor', AUD, 'finalized']], ['REWORK', 'PASS']);
    expect(hasLegacyPassReceipt(audited)).toBe(true);
    expect(legacyTaskToPair(audited, 1)).toMatchObject({ status: 'passed', passRound: 1, flags: [] });

    const reworked = snapshot('tsk_reworked', 'integrating', [['implementer', EXEC, 'integrating']], ['PASS', 'REWORK']);
    expect(legacyTaskToPair(reworked, 1)?.status).toBe('in_audit');

    expect(mapLegacyStatus('final_audit', true)?.status).toBe('in_audit');
    expect(mapLegacyStatus('committed')?.status).toBe('passed');
    expect(mapLegacyStatus('passed')?.status).toBe('passed');
  });

  it('gives imported unaudited slices auditors within the concurrency limit, in queue order', async () => {
    const count = TASK_PAIR_DEFAULT_MAX_CONCURRENCY + 2;
    const tasks = Array.from({ length: count }, (_, index) => snapshot(
      `tsk_s${index}`, 'ready_for_integration', [['coordinator', BRAIN, 'delegated'], ['implementer', EXEC, 'ready_for_integration']],
    ));
    expect(importLegacyTasks({ list: () => tasks }, now, () => true)).toBe(count);
    await tick(1);
    const audited = tasks.filter((task) => pair(task.taskId).auditor);
    const waiting = tasks.filter((task) => !pair(task.taskId).auditor);
    expect(audited.map((task) => task.taskId)).toEqual(tasks.slice(0, TASK_PAIR_DEFAULT_MAX_CONCURRENCY).map((task) => task.taskId));
    expect(waiting).toHaveLength(2);
    for (const task of waiting) expect(pair(task.taskId).flags).toContain('waiting_for_capacity');
    // Nothing is sent about waiting pairs: they are queued, not escalated.
    expect(sentTo(BRAIN, 'brain-needs_auditor')).toHaveLength(0);
    // A finished audit frees a slot for the next one on the following heartbeat.
    const first = pair('tsk_s0');
    marker(first.auditor!, '<!-- IMCODES_TASK PASS tsk_s0 blocking=P0 -->');
    await tick(1);
    expect(pair(`tsk_s${TASK_PAIR_DEFAULT_MAX_CONCURRENCY}`).auditor).toBeDefined();
    expect(pair(`tsk_s${TASK_PAIR_DEFAULT_MAX_CONCURRENCY}`).flags).not.toContain('waiting_for_capacity');
    expect(pair(`tsk_s${TASK_PAIR_DEFAULT_MAX_CONCURRENCY + 1}`).auditor).toBeUndefined();
  });

  // ---- 3. per-pair liveness --------------------------------------------------

  async function sevenPassedPairs(): Promise<string[]> {
    const ids = Array.from({ length: 7 }, (_, index) => `P${index + 1}`);
    for (const id of ids) {
      marker(BRAIN, `<!-- IMCODES_TASK DISPATCH ${id} executor=${EXEC} auditor=${AUD} -->`);
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${id} -->`);
      marker(AUD, `<!-- IMCODES_TASK PASS ${id} blocking=P0 -->`);
    }
    await flush();
    sent = [];
    return ids;
  }

  it('nudges every idle pair of a session in 7 pairs, and its work on one keeps only that one alive', async () => {
    const ids = await sevenPassedPairs();
    await tick(1);
    // Every due pair of the idle session is nudged in the same heartbeat.
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(7);
    expect(new Set(sentTo(EXEC, 'nudge-executor').map((entry) => entry.id.split(':')[1]))).toEqual(new Set(ids));
    expect(sentTo(EXEC, 'nudge-executor')[0]?.text).toContain('commit/push');

    // The executor finishes P3 (and says so); its other pairs stay silent.
    now += 1;
    taskPairService.handleTimelineEvent({
      eventId: 'exec-output-1', sessionId: EXEC, ts: now, seq: 1, epoch: 1, source: 'daemon', confidence: 'high',
      type: 'assistant.text', payload: { text: 'Committed and pushed P3; P30 is not a task of mine.' },
    } as never);
    expect(getTaskPairStore().getPair(PROJECT, 'P3')!.liveness.progressExecutorAt).toBe(now);
    expect(getTaskPairStore().getPair(PROJECT, 'P1')!.liveness.progressExecutorAt).toBeLessThan(now);

    sent = [];
    await tick(2);
    // Six pairs escalate after three silent heartbeats; P3 is only nudged.
    const escalated = sentTo(BRAIN, 'brain-executor_silent').map((entry) => entry.id.split(':')[1]);
    expect(new Set(escalated)).toEqual(new Set(ids.filter((id) => id !== 'P3')));
    expect(pair('P3').flags).not.toContain('executor_silent');
    // Passed pairs escalate with advice that keeps the work: no uncommitted DONE force.
    const notice = sentTo(BRAIN, 'brain-executor_silent')[0]!.text;
    expect(notice).toContain('REASSIGN');
    expect(notice).toContain('executor=<session>');
    expect(notice).toContain('only once the work is committed');
  });

  it('credits plain output to the only open pair, else to the pair the session was last messaged about', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH Q1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    now += 1;
    taskPairService.recordProgress(EXEC, now, 'still working');
    expect(getTaskPairStore().getPair(PROJECT, 'Q1')!.liveness.progressExecutorAt).toBe(now);

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH Q2 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    const before = getTaskPairStore().getPair(PROJECT, 'Q1')!.liveness.progressExecutorAt;
    // Two open pairs and no focus yet: plain output is nobody's progress.
    resetTaskPairFocusForTests();
    now += 1;
    taskPairService.recordProgress(EXEC, now, 'still working');
    expect(getTaskPairStore().getPair(PROJECT, 'Q1')!.liveness.progressExecutorAt).toBe(before);
    // After a message about Q2 the session's plain answer is progress on Q2 only.
    await tick(3);
    const lastAbout = sentTo(EXEC).at(-1)!.id.split(':')[1]!;
    now += 1;
    taskPairService.recordProgress(EXEC, now, 'on it');
    const other = lastAbout === 'Q1' ? 'Q2' : 'Q1';
    expect(getTaskPairStore().getPair(PROJECT, lastAbout)!.liveness.progressExecutorAt).toBe(now);
    expect(getTaskPairStore().getPair(PROJECT, other)!.liveness.progressExecutorAt).toBeLessThan(now);
  });

  // ---- 4. usage-limited executor ---------------------------------------------

  it('holds a usage-limited executor without nudging, escalates only after the silence limit, and resumes after the limit clears', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH L1 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT L1 -->');
    marker(AUD, '<!-- IMCODES_TASK PASS L1 blocking=P0 -->');
    await flush();
    sent = [];
    limited.add(EXEC);
    await tick(2);
    expect(sent).toHaveLength(0);
    expect(pair('L1').flags).not.toContain('executor_silent');
    await tick(1);
    expect(sentTo(BRAIN, 'brain-executor_silent')).toHaveLength(1);
    await tick(2);
    expect(sentTo(BRAIN, 'brain-executor_silent')).toHaveLength(1);
    expect(sentTo(EXEC)).toHaveLength(0);
    // The limit clears: the executor is nudged again, and after working on the
    // pair it can be escalated again if it later goes silent.
    limited.delete(EXEC);
    await tick(1);
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(1);
    now += 1;
    taskPairService.recordProgress(EXEC, now, 'committing L1');
    await tick(1);
    expect(pair('L1').flags).not.toContain('executor_silent');
    await tick(3);
    expect(sentTo(BRAIN, 'brain-executor_silent')).toHaveLength(2);
  });

  it('still replaces a usage-limited auditor at once', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH L2 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT L2 -->');
    await flush();
    limited.add(AUD);
    await tick(1);
    expect(pair('L2').auditor).toBe(SPARES[0]);
  });

  // ---- 5. one-time correction of pairs already imported as passed -------------

  function oldReleaseImport(taskId: string, legacyStatus: string, extra: Partial<TaskPairState> = {}): void {
    // What the previous release wrote: passed, round 1, no auditor, needs_auditor.
    const state: TaskPairState = {
      taskId, brain: BRAIN, executor: EXEC, title: `objective of ${taskId}`, status: 'passed', flags: ['needs_auditor'],
      flagSides: {}, round: 1, passRound: 1, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 1,
      createdAt: 10, updatedAt: 10, ...extra,
    };
    getTaskPairStore().savePair(PROJECT, state, {
      legacyTaskId: taskId,
      liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 0, progressAuditorAt: 0, lastTickAt: 10, notified: [] },
    });
    getTaskPairStore().recordEvent({
      id: `legacy_import:${taskId}`, project: PROJECT, taskId, writer: 'daemon', role: 'daemon', verb: 'IMPORT',
      attrs: { legacyStatus }, effect: 'imported', unusual: false, source: 'legacy_import', toStatus: 'passed', at: 10,
    });
  }

  it('corrects mis-passed imports once, skips pairs with real progress, and records every correction', async () => {
    const slice = (id: string, receipts: Array<'PASS' | 'REWORK'> = [], status = 'ready_for_integration') => snapshot(
      id, status, [['coordinator', BRAIN, 'delegated'], ['implementer', EXEC, 'ready_for_integration']], receipts,
    );
    oldReleaseImport('tsk_plain', 'ready_for_integration');
    oldReleaseImport('tsk_reassigned', 'ready_for_integration');
    oldReleaseImport('tsk_reworked', 'ready_for_integration');
    oldReleaseImport('tsk_repassed', 'ready_for_integration');
    oldReleaseImport('tsk_forced', 'ready_for_integration');
    oldReleaseImport('tsk_realpass', 'ready_for_integration');
    oldReleaseImport('tsk_committed', 'committed');
    now = 20;
    // Brain named an auditor for one after the import (no verdict yet, still passed).
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN tsk_reassigned auditor=${AUD} -->`);
    // Real verdicts after the import (tsk_1fvt / tsk_1pr3), and a force close (tsk_1f7y).
    marker(AUD, '<!-- IMCODES_TASK REWORK tsk_reworked blocking=P0 p0=1 -->');
    marker(AUD, '<!-- IMCODES_TASK PASS tsk_repassed blocking=P0 -->');
    marker(BRAIN, '<!-- IMCODES_TASK DONE tsk_forced force=true -->');
    await flush();
    sent = [];
    const timeline: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = timelineEmitter.on((event) => {
      if (event.type === TASK_PAIR_TIMELINE_EVENT) timeline.push({ sessionId: event.sessionId, payload: event.payload as Record<string, unknown> });
    });
    const legacy = [
      slice('tsk_plain'), slice('tsk_reassigned'), slice('tsk_reworked'), slice('tsk_repassed'), slice('tsk_forced'),
      slice('tsk_realpass', ['PASS']), slice('tsk_committed', [], 'committed'),
    ];
    try {
      importLegacyTasks({ list: () => legacy }, 30, () => true);
      await flush();
    } finally {
      unsubscribe();
    }

    expect(pair('tsk_plain')).toMatchObject({ status: 'in_audit', round: 1, flags: ['needs_auditor'] });
    expect(pair('tsk_plain').passRound).toBeUndefined();
    expect(pair('tsk_reassigned')).toMatchObject({ status: 'in_audit', auditor: AUD, flags: [] });
    expect(pair('tsk_reworked').status).toBe('rework');
    expect(pair('tsk_repassed').status).toBe('passed');
    expect(pair('tsk_forced').status).toBe('done');
    expect(pair('tsk_realpass').status).toBe('passed');
    expect(pair('tsk_committed').status).toBe('passed');

    const corrections = (taskId: string) => getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === 'CORRECT');
    expect(corrections('tsk_plain')).toMatchObject([{ fromStatus: 'passed', toStatus: 'in_audit', effect: 'import_corrected', writer: 'daemon' }]);
    expect(corrections('tsk_reassigned')).toHaveLength(1);
    for (const skipped of ['tsk_reworked', 'tsk_repassed', 'tsk_forced', 'tsk_realpass', 'tsk_committed']) {
      expect(corrections(skipped)).toHaveLength(0);
    }
    // Visible on the timelines of the participants.
    expect(timeline.filter((entry) => entry.payload.verb === 'CORRECT' && entry.payload.taskId === 'tsk_plain').map((entry) => entry.sessionId).sort())
      .toEqual([BRAIN, EXEC].sort());
    // The stale "PASS received: commit/push" expectation is withdrawn; Brain gets one line.
    const correctionMessages = sentTo(EXEC, 'import-correction');
    expect(correctionMessages.map((entry) => entry.id.split(':')[1]).sort()).toEqual(['tsk_plain', 'tsk_reassigned']);
    expect(correctionMessages[0]!.text).toContain('do not commit/push it yet');
    expect(sentTo(BRAIN, 'brain-legacy-import-correction')).toHaveLength(1);
    expect(sentTo(BRAIN, 'brain-legacy-import-correction')[0]!.text).toContain('tsk_plain, tsk_reassigned');

    // Idempotent: a later start or tick changes nothing and sends nothing.
    sent = [];
    importLegacyTasks({ list: () => legacy }, 40, () => true);
    await flush();
    expect(sent).toHaveLength(0);
    expect(corrections('tsk_plain')).toHaveLength(1);
    expect(pair('tsk_plain').status).toBe('in_audit');

    // The corrected pair is then driven like any audit: its auditor side acts.
    await tick(1);
    expect(pair('tsk_plain').auditor).toBeDefined();
    expect(sentTo(pair('tsk_plain').auditor!, 'handoff')).toHaveLength(1);

    // Its real PASS is final: later passes never correct it back into audit.
    now += 1;
    marker(pair('tsk_plain').auditor!, '<!-- IMCODES_TASK PASS tsk_plain blocking=P0 -->');
    expect(pair('tsk_plain').status).toBe('passed');
    sent = [];
    importLegacyTasks({ list: () => legacy }, now + 1, () => true);
    await flush();
    expect(pair('tsk_plain').status).toBe('passed');
    expect(corrections('tsk_plain')).toHaveLength(1);
    expect(sentTo(EXEC, 'import-correction')).toHaveLength(0);
  });
});
