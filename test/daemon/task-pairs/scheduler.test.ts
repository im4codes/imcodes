import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { listTaskPairCandidates } from '../../../src/daemon/task-pairs/pool.js';
import { getSupervisionTaskRegistry } from '../../../src/daemon/supervision-state-store.js';
import {
  defaultCountActiveSupervisionAssignments,
  defaultHasActiveSupervisionLease,
} from '../../../src/daemon/supervision-auto-provision.js';
import { getSupervisionHeartbeatProjection } from '../../../src/daemon/supervision-heartbeat-projection.js';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId, normalizeSupervisionExecutionModel } from '../../../shared/supervision-execution-pool.js';

const PROJECT = 'schedproj';
const BRAIN = 'deck_schedproj_brain';
const EXEC = 'deck_sub_schedexec';
const AUD = 'deck_sub_schedaud';
const SPARE = 'deck_sub_schedspare';
const SPARE2 = 'deck_sub_schedspare2';

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

let now = 1_000_000;
let sent: Array<{ target: string; text: string; id: string }>;
let busy: Set<string>;
let limited: Set<string>;
let candidates: string[];
let provisioned: string | undefined;
let automation: TaskPairAutomation;
let turn = 0;

function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `sched-turn-${turn}`, now);
}

function pair(taskId: string) {
  return getTaskPairStore().getPair(PROJECT, taskId)!.state;
}

async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    now += 6 * 60_000;
    await automation.tick();
  }
}

// A fixed number of event-loop turns raced the service's tracked background
// work (intents → queue run → dispatch send) on slower CI runners (Node 22),
// so a dispatch could land after the assertion. Drain until the service is
// idle and stays idle across a turn.
async function flush() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await taskPairService.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (taskPairService.pendingCount === 0) return;
  }
}

function sentTo(target: string, reasonPart?: string) {
  return sent.filter((entry) => entry.target === target && (!reasonPart || entry.id.includes(`:${reasonPart}`)));
}

describe('task-pair heartbeat, replacement and queue', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    busy = new Set();
    limited = new Set();
    candidates = [SPARE];
    provisioned = undefined;
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2'), session(SPARE, 'w3'), session(SPARE2, 'w4')]) {
      upsertSession(record);
    }
    automation = new TaskPairAutomation({
      now: () => now,
      isBusy: (name) => busy.has(name),
      isLimited: (name) => limited.has(name),
      pickCandidate: ({ exclude }) => candidates.find((name) => !exclude.has(name)),
      provision: async () => provisioned,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    taskPairService.setScheduler(automation);
  });

  afterEach(() => {
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD, SPARE, SPARE2]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('nudges an idle executor, then escalates once and stops nudging', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    sent = [];
    await tick(5);
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(2);
    expect(pair('T1').flags).toContain('executor_silent');
    expect(sentTo(BRAIN, 'brain-executor_silent')).toHaveLength(1);
    // Progress clears the silence and nudging resumes on the next idle ticks.
    now += 1;
    marker(EXEC, '<!-- IMCODES_TASK WORKING T1 -->');
    await tick(1);
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(2);
    await tick(1);
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(3);
  });

  it('never nudges a running side or a side that made progress', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T2 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    sent = [];
    busy.add(EXEC);
    await tick(3);
    expect(sent).toHaveLength(0);
    busy.delete(EXEC);
    taskPairService.recordProgress(EXEC, now + 1);
    await tick(1);
    expect(sent).toHaveLength(0);
  });

  it('does not nudge a side that flagged itself blocked', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T3 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK BLOCKED T3 note="need DB creds" -->');
    await flush();
    sent = [];
    await tick(3);
    expect(sentTo(EXEC)).toHaveLength(0);
  });

  it('nudges an executor awaiting audit to send its materials', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T4 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK DONE T4 -->');
    await flush();
    sent = [];
    await tick(1);
    expect(sentTo(EXEC, 'nudge-executor')[0]?.text).toContain('DONE without a PASS is not complete');
  });

  it('nudges the executor when both sides are idle, but stands down when either side has activity', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH BOTH_IDLE executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT BOTH_IDLE -->');
    await flush();
    sent = [];
    await tick(1);
    expect(pair('BOTH_IDLE').status).toBe('in_audit');
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(1);
    expect(sentTo(AUD, 'nudge-auditor')).toHaveLength(0);

    sent = [];
    now += 1;
    taskPairService.recordActivity(AUD, now);
    await tick(1);
    expect(sent).toHaveLength(0);
  });

  it('escalates a repeatedly quiet pair once after the configured silence limit', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH QUIET_ESC executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    sent = [];
    await tick(3);
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(2);
    expect(sentTo(BRAIN, 'brain-executor_silent')).toHaveLength(1);
    await tick(2);
    expect(sentTo(BRAIN, 'brain-executor_silent')).toHaveLength(1);
  });

  it('judges liveness per side: a busy executor does not mask a silent auditor, which is replaced', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T5 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T5 -->');
    await flush();
    sent = [];
    busy.add(EXEC);
    await tick(3);
    await flush();
    expect(sentTo(AUD, 'nudge-auditor')).toHaveLength(2);
    expect(pair('T5')).toMatchObject({ auditor: SPARE, previousAuditors: [AUD], status: 'in_audit' });
    expect(sentTo(SPARE, 'handoff')[0]?.text).toContain('You are now the auditor');
    expect(sentTo(EXEC, 'resend')).toHaveLength(1);
    expect(sentTo(BRAIN, 'brain-line-reassign')[0]?.text).toContain(`${AUD} → ${SPARE}`);
    // The new auditor starts with a clean silence count.
    sent = [];
    await tick(1);
    expect(sentTo(SPARE, 'nudge-auditor')).toHaveLength(1);
  });

  it('replaces a usage-limited auditor at once', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T6 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T6 -->');
    await flush();
    limited.add(AUD);
    await tick(1);
    expect(pair('T6').auditor).toBe(SPARE);
  });

  it('asks Brain exactly once when no candidate exists and provisioning fails', async () => {
    candidates = [];
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T7 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T7 -->');
    await flush();
    limited.add(AUD);
    await tick(4);
    expect(sentTo(BRAIN, 'brain-needs_auditor')).toHaveLength(1);
    expect(pair('T7').flags).toContain('needs_auditor');
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN T7 auditor=${SPARE2} -->`);
    expect(pair('T7')).toMatchObject({ auditor: SPARE2 });
    expect(pair('T7').flags).not.toContain('needs_auditor');
  });

  it('uses a provisioned auditor when none is idle', async () => {
    candidates = [];
    provisioned = SPARE2;
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T8 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T8 -->');
    await flush();
    limited.add(AUD);
    await tick(1);
    expect(pair('T8').auditor).toBe(SPARE2);
  });

  it('picks an auditor immediately when a dispatch names none', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T9 executor=${EXEC} -->`);
    await flush();
    expect(pair('T9').auditor).toBe(SPARE);
  });

  it('auto-dispatches queued briefs unchanged within the limit, and refills when a slot frees', async () => {
    candidates = [SPARE, SPARE2, AUD, EXEC];
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE - max=1 -->');
    const brief = 'Implement CSV export.\n```ts\nexport const x = 1;\n```\nKeep tests green.';
    marker(BRAIN, `<!-- IMCODES_TASK QUEUE Q1 title="Export" executor=${EXEC} auditor=${AUD} -->\n${brief}\n<!-- IMCODES_TASK_END Q1 -->`);
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE Q2 title="Import" -->\nImplement import.\n<!-- IMCODES_TASK_END Q2 -->');
    await flush();
    expect(pair('Q1').status).toBe('working');
    expect(pair('Q2').status).toBe('queued');
    const dispatch = sentTo(EXEC, 'dispatch')[0]!;
    expect(dispatch.text.startsWith(brief)).toBe(true);
    expect(dispatch.text).toContain(`auditor: ${AUD}`);
    expect(sentTo(AUD, 'auditor-assigned')).toHaveLength(1);
    expect(sentTo(BRAIN, 'brain-line-dispatch')).toHaveLength(1);

    marker(BRAIN, '<!-- IMCODES_TASK DONE Q1 force=true -->');
    await flush();
    const q2 = pair('Q2');
    expect(q2.status).toBe('working');
    expect(q2.executor).toBe(SPARE);
    expect(q2.auditor).toBe(SPARE2);
    expect(q2.executor).not.toBe(q2.auditor);
  });

  it('QUEUE with executormodel=-only and auditor=none starts the pair and never picks an auditor, even though a candidate is available', async () => {
    candidates = [SPARE, SPARE2, AUD, EXEC];
    marker(BRAIN, `<!-- IMCODES_TASK QUEUE Q9 title="Bump a config value" executormodel=sonnet auditor=none -->\nbump the value\n<!-- IMCODES_TASK_END Q9 -->`);
    await flush();
    const q9 = pair('Q9');
    expect(q9.status).toBe('working');
    expect(q9.executor).toBeTruthy();
    expect(q9.auditor).toBe('none');
    expect(sentTo(q9.executor!, 'dispatch')).toHaveLength(1);
    // No auditor-assigned message went anywhere -- no auditor was picked.
    expect(sent.filter((entry) => entry.id.includes(':auditor-assigned'))).toHaveLength(0);

    // A later heartbeat tick must not retroactively pick one either.
    await tick(3);
    expect(pair('Q9').auditor).toBe('none');
    expect(sent.filter((entry) => entry.id.includes(':auditor-assigned'))).toHaveLength(0);
  });

  it('urgent=true jumps a queued pair ahead of earlier-queued normal work', async () => {
    candidates = [SPARE, SPARE2, AUD, EXEC];
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE - max=1 -->');
    marker(BRAIN, `<!-- IMCODES_TASK QUEUE Q4 title="First" executor=${EXEC} auditor=${AUD} -->\nfirst brief\n<!-- IMCODES_TASK_END Q4 -->`);
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE Q5 title="Second (normal)" -->\nsecond brief\n<!-- IMCODES_TASK_END Q5 -->');
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE Q6 title="Third (urgent)" urgent=true -->\nthird brief\n<!-- IMCODES_TASK_END Q6 -->');
    await flush();
    // max=1: Q4 dispatches immediately, Q5 and Q6 both wait.
    expect(pair('Q4').status).toBe('working');
    expect(pair('Q5').status).toBe('queued');
    expect(pair('Q6').status).toBe('queued');
    expect(pair('Q6').urgent).toBe(true);

    marker(BRAIN, '<!-- IMCODES_TASK DONE Q4 force=true -->');
    await flush();
    // Q6 (urgent, queued last) fills the freed slot before Q5 (queued first).
    expect(pair('Q6').status).toBe('working');
    expect(pair('Q5').status).toBe('queued');

    marker(BRAIN, '<!-- IMCODES_TASK DONE Q6 force=true -->');
    await flush();
    expect(pair('Q5').status).toBe('working');
  });

  it('keeps a queued task waiting for capacity quietly and retries on the heartbeat', async () => {
    candidates = [];
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE Q3 -->\nbrief\n<!-- IMCODES_TASK_END Q3 -->');
    await flush();
    await tick(2);
    expect(pair('Q3')).toMatchObject({ status: 'queued', flags: ['waiting_for_capacity'] });
    // Owner correction: an ordinary, self-resolving queue miss gets no
    // per-pair Brain notice at all -- only the combined stall notice, and
    // only once it has actually persisted (see the test below).
    expect(sentTo(BRAIN, 'brain-waiting_for_capacity')).toHaveLength(0);
    candidates = [SPARE, SPARE2];
    await tick(1);
    expect(pair('Q3')).toMatchObject({ status: 'working', executor: SPARE, auditor: SPARE2 });
    expect(pair('Q3').flags).not.toContain('waiting_for_capacity');
  });

  it('sends one combined notice for queued tasks stalled a long time, not one per pair or per tick', async () => {
    candidates = [];
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE Q3a -->\nbrief a\n<!-- IMCODES_TASK_END Q3a -->');
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE Q3b -->\nbrief b\n<!-- IMCODES_TASK_END Q3b -->');
    await flush();
    // Under 30 minutes: still quiet.
    await tick(4);
    expect(sentTo(BRAIN, 'brain-queue-stall')).toHaveLength(0);
    // Past 30 minutes: one combined notice naming both pairs.
    await tick(2);
    const stallNotices = sentTo(BRAIN, 'brain-queue-stall');
    expect(stallNotices).toHaveLength(1);
    expect(stallNotices[0]!.text).toContain('Q3a');
    expect(stallNotices[0]!.text).toContain('Q3b');
    // Rate-limited: further ticks while still stalled do not repeat it.
    await tick(3);
    expect(sentTo(BRAIN, 'brain-queue-stall')).toHaveLength(1);
  });

  it('a queued task with no brief and no available candidate stays queued silently -- an ordinary capacity miss, not a brief-specific stall', async () => {
    candidates = [];
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE Q4 -->');
    await flush();
    await tick(2);
    expect(pair('Q4').status).toBe('queued');
    expect(pair('Q4').flags).toContain('waiting_for_capacity');
    expect(sentTo(BRAIN)).toHaveLength(0);
  });

  it('auto-dispatches a queued task with no brief once candidates are available, briefing the executor instead of stalling forever', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH Q4b executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('Q4b').status).toBe('working');
    const brief = sentTo(EXEC, 'pair-brief')[0];
    expect(brief).toBeDefined();
    expect(brief!.text).not.toContain('undefined');
    expect(brief!.text).toContain('executor of this task pair');
  });

  it('DISPATCH with a brief under the limit starts right away and delivers the brief, same as QUEUE', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH DB1 title="Dispatch with a brief" executor=${EXEC} auditor=${AUD} -->\nfix the thing\n<!-- IMCODES_TASK_END DB1 -->`);
    await flush();
    expect(pair('DB1')).toMatchObject({ status: 'working', executor: EXEC, auditor: AUD, brief: 'fix the thing' });
    const dispatch = sentTo(EXEC, 'dispatch')[0]!;
    expect(dispatch.text.startsWith('fix the thing')).toBe(true);
    // Owner rule (tsk_cd_dispatch_default): ask, don't just reply -- in the auditor brief too.
    expect(sentTo(AUD, 'auditor-assigned')[0]?.text).toContain('Ask, don\'t just reply');
  });

  it('tells Brain immediately when the executor writes BLOCKED, instead of waiting for it to go silent', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH DBL executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK BLOCKED DBL note="need a decision on scope" -->');
    await flush();
    const notice = sentTo(BRAIN, 'brain-blocked');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.text).toContain('need a decision on scope');
    // A second BLOCKED from the same side, still blocked, is not re-notified.
    marker(EXEC, '<!-- IMCODES_TASK BLOCKED DBL note="still need a decision on scope" -->');
    await flush();
    expect(sentTo(BRAIN, 'brain-blocked')).toHaveLength(1);
  });

  it('DISPATCH over the concurrency limit auto-queues instead of starting, then auto-starts once a slot frees', async () => {
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE - max=1 -->');
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH D1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('D1').status).toBe('working');

    // Brain still just writes DISPATCH -- no need to pick QUEUE to defer it.
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH D2 title="Second" executor=${SPARE} auditor=${SPARE2} -->\nsecond brief\n<!-- IMCODES_TASK_END D2 -->`);
    await flush();
    expect(pair('D2')).toMatchObject({ status: 'queued', executor: SPARE, auditor: SPARE2 });
    expect(sentTo(SPARE)).toHaveLength(0);

    marker(BRAIN, '<!-- IMCODES_TASK DONE D1 force=true -->');
    await flush();
    expect(pair('D2').status).toBe('working');
    expect(sentTo(SPARE, 'dispatch')[0]?.text.startsWith('second brief')).toBe(true);
  });

  it('a DISPATCH naming a busy session queues and starts once that session frees, never silently substituting another', async () => {
    busy.add(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH D3 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('D3')).toMatchObject({ status: 'queued', executor: EXEC });
    expect(pair('D3').flags).toContain('waiting_for_capacity');

    busy.delete(EXEC);
    await tick(1);
    expect(pair('D3').status).toBe('working');
  });

  it('urgent=true on DISPATCH jumps a queued pair ahead of earlier-queued normal work, same as QUEUE', async () => {
    candidates = [SPARE, SPARE2, AUD, EXEC];
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE - max=1 -->');
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH DU1 title="First" executor=${EXEC} auditor=${AUD} -->`);
    marker(BRAIN, '<!-- IMCODES_TASK DISPATCH DU2 title="Second (normal)" -->');
    marker(BRAIN, '<!-- IMCODES_TASK DISPATCH DU3 title="Third (urgent)" urgent=true -->');
    await flush();
    expect(pair('DU1').status).toBe('working');
    expect(pair('DU2').status).toBe('queued');
    expect(pair('DU3')).toMatchObject({ status: 'queued', urgent: true });

    marker(BRAIN, '<!-- IMCODES_TASK DONE DU1 force=true -->');
    await flush();
    expect(pair('DU3').status).toBe('working');
    expect(pair('DU2').status).toBe('queued');
  });

  it('shows the pair heartbeat on the badges of open-pair participants and clears it when the pair ends', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T11 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    automation.publishBadges();
    expect(getSupervisionHeartbeatProjection(EXEC)).toMatchObject({ state: 'armed', kind: 'pair' });
    expect(getSupervisionHeartbeatProjection(AUD)).toMatchObject({ state: 'armed', kind: 'pair' });
    marker(BRAIN, '<!-- IMCODES_TASK DONE T11 force=true -->');
    await flush();
    automation.publishBadges();
    expect(getSupervisionHeartbeatProjection(EXEC)?.state ?? 'off').toBe('off');
  });

  it('imports in-flight legacy tasks of a project switched back to pairs on the next tick, without a restart', async () => {
    const registry = getSupervisionTaskRegistry();
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    getTaskPairStore().setProjectEngine(PROJECT, 'legacy');
    expect(registry.createOrGet({
      taskId: 'tsk_flip', projectName: PROJECT, classification: 'independent_top_level', objective: 'created during rollback',
    } as never).ok).toBe(true);
    const live = new TaskPairAutomation({ now: () => now, importLegacy: undefined, isBusy: () => true, isLimited: () => false });
    await live.tick();
    expect(getTaskPairStore().getPairByLegacyTaskId('tsk_flip')).toBeUndefined();
    getTaskPairStore().setProjectEngine(PROJECT, 'pairs');
    await live.tick();
    expect(getTaskPairStore().getPairByLegacyTaskId('tsk_flip')?.state).toMatchObject({ taskId: 'tsk_flip', title: 'created during rollback' });
  });

  it('answers pool leases and counts from open pairs on the pairs engine', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T10 executor=${EXEC} auditor=${AUD} pool=economy -->`);
    await flush();
    expect(await defaultHasActiveSupervisionLease(EXEC)).toBe(true);
    expect(await defaultHasActiveSupervisionLease(SPARE)).toBe(false);
    const brain = session(BRAIN, 'brain');
    expect(await defaultCountActiveSupervisionAssignments(brain, 'economy')).toBe(1);
    expect(await defaultCountActiveSupervisionAssignments(brain, 'primary')).toBe(0);
  });
});

describe('task-pair pool candidates', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  });
  afterEach(() => {
    setTaskPairStoreForTests(undefined);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('picks nothing for an automatic (unnamed) role when no execution pool is configured -- no built-in default', () => {
    const sessions = [
      session(BRAIN, 'brain'),
      session('deck_sub_codex', 'w1', { parentSession: BRAIN, agentType: 'codex-sdk', activeModel: 'gpt-5.5', updatedAt: 1 }),
      session('deck_sub_opus_new', 'w2', { parentSession: BRAIN, activeModel: 'claude-opus-5-5', updatedAt: 50 }),
      session('deck_sub_opus_old', 'w3', { parentSession: BRAIN, activeModel: 'claude-opus-4-8', updatedAt: 10 }),
      session('deck_sub_sonnet', 'w7', { parentSession: BRAIN, activeModel: 'claude-sonnet-5', updatedAt: 1 }),
      session('deck_sub_haiku', 'w4', { parentSession: BRAIN, activeModel: 'claude-haiku-4-5', updatedAt: 5 }),
      session('deck_sub_busy', 'w5', { parentSession: BRAIN, activeModel: 'claude-opus-5-5', state: 'running', updatedAt: 2 }),
      session('deck_sub_foreign', 'w6', { parentSession: 'deck_other_brain', projectName: 'otherproj', activeModel: 'claude-opus-5-5', updatedAt: 3 }),
      session('deck_schedproj_w9', 'w9', { activeModel: 'claude-opus-5-5', updatedAt: 4 }),
      session('deck_sub_nomodel', 'w8', { parentSession: BRAIN, updatedAt: 0 }),
    ];
    const picked = listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', exclude: new Set(),
    }, { listSessions: () => sessions, hasPendingMessages: () => false });
    // Owner rule: with no execution pool configured, an automatic (unnamed)
    // pick returns nothing at all -- there is no built-in default anymore.
    expect(picked).toEqual([]);
    // A named model still wins regardless (unaffected by this owner rule).
    const namedPick = listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', exclude: new Set(), requestedModel: 'claude-opus-4-8',
    }, { listSessions: () => sessions, hasPendingMessages: () => false });
    expect(namedPick.map((entry) => entry.name)).toEqual(['deck_sub_opus_old']);
  });
});

describe('no execution pool configured: ask the user instead of guessing (owner rule)', () => {
  const NP_EXEC = 'deck_sub_noolexec';
  const NP_AUD = 'deck_sub_noolaud';
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let npNow = 2_000_000;
  let npSent: Array<{ target: string; text: string; id: string }>;
  let npAutomation: TaskPairAutomation;

  function brainSession(executionPools?: unknown): SessionRecord {
    return session(BRAIN, 'brain', executionPools ? {
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, executionPools }) },
    } as Partial<SessionRecord> : {});
  }
  function npMarker(writer: string, line: string) {
    return taskPairService.ingestText(PROJECT, writer, line, `noolturn-${Math.random()}`, npNow);
  }
  function npPair(taskId: string) {
    return getTaskPairStore().getPair(PROJECT, taskId)!.state;
  }
  async function npTick(times = 1) {
    for (let i = 0; i < times; i += 1) { npNow += 6 * 60_000; await npAutomation.tick(); }
  }
  async function npFlush() {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  function npSentTo(target: string, reasonPart?: string) {
    return npSent.filter((entry) => entry.target === target && (!reasonPart || entry.id.includes(`:${reasonPart}`)));
  }

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    npSent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { npSent.push({ target, text, id }); } });
    upsertSession(brainSession());
    upsertSession(session(NP_EXEC, 'w1', { parentSession: BRAIN, agentType: 'codex-sdk', activeModel: 'gpt-5.6' }));
    upsertSession(session(NP_AUD, 'w2', { parentSession: BRAIN, agentType: 'claude-code-sdk', activeModel: 'opus' }));
    // No pickCandidate/provision deps injected: the real pool.ts logic (and
    // therefore the real no-pool-configured gate) runs for these tests.
    npAutomation = new TaskPairAutomation({ now: () => npNow, importLegacy: () => undefined });
    taskPairService.setScheduler(npAutomation);
  });
  afterEach(() => {
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, NP_EXEC, NP_AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('picks nothing for a no-pool project and sends one batched ask-the-user notice, not repeated every tick', async () => {
    npMarker(BRAIN, '<!-- IMCODES_TASK QUEUE NP1 -->\nbrief\n<!-- IMCODES_TASK_END NP1 -->');
    await npFlush();
    await npTick(1);
    expect(npPair('NP1')).toMatchObject({ status: 'queued', flags: ['no_pool_configured'] });
    expect(npSentTo(BRAIN, 'brain-no-pool-ask')).toHaveLength(1);
    expect(npSentTo(BRAIN, 'brain-no-pool-ask')[0]!.text).toContain('NP1');
    await npTick(1);
    expect(npSentTo(BRAIN, 'brain-no-pool-ask')).toHaveLength(1);
  });

  it('naming executormodel=/auditormodel= on QUEUE starts the pair even with no pool configured', async () => {
    npMarker(BRAIN, '<!-- IMCODES_TASK QUEUE NP2 executormodel=gpt-5.6 auditormodel=opus -->\nbrief\n<!-- IMCODES_TASK_END NP2 -->');
    await npFlush();
    await npTick(1);
    expect(npPair('NP2')).toMatchObject({ status: 'working', executor: NP_EXEC, auditor: NP_AUD });
  });

  it('configuring a pool starts a previously-waiting pair automatically', async () => {
    npMarker(BRAIN, '<!-- IMCODES_TASK QUEUE NP3 -->\nbrief\n<!-- IMCODES_TASK_END NP3 -->');
    await npFlush();
    await npTick(1);
    expect(npPair('NP3').flags).toContain('no_pool_configured');

    const auditorModel = normalizeSupervisionExecutionModel('claude-code-sdk', 'opus');
    const auditorConfig = { agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'process' as const, model: auditorModel };
    const pools = {
      state: 'configured' as const,
      economyTaskPool: { configs: [], controls: { leaseMs: 900000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
      primaryDevelopmentPool: {
        configs: [
          { agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'process' as const, model: 'gpt-5.6', capabilityId: 'supervision-exec-v1:process:codex-sdk:openai:gpt-5.6', role: 'executor' as const },
          { ...auditorConfig, capabilityId: buildSupervisionExecutionCapabilityId(auditorConfig), role: 'auditor' as const },
        ],
        controls: { leaseMs: 1800000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 },
      },
    };
    upsertSession(brainSession(pools));
    await npTick(1);
    expect(npPair('NP3')).toMatchObject({ status: 'working' });
  });

  it('auditor=none still needs an executor model when no pool is configured', async () => {
    npMarker(BRAIN, '<!-- IMCODES_TASK QUEUE NP4 auditor=none -->\nbrief\n<!-- IMCODES_TASK_END NP4 -->');
    await npFlush();
    await npTick(1);
    expect(npPair('NP4')).toMatchObject({ status: 'queued', flags: ['no_pool_configured'] });

    // Naming the executor model alone is enough (no auditor model needed for auditor=none).
    npMarker(BRAIN, '<!-- IMCODES_TASK QUEUE NP4 executormodel=gpt-5.6 -->');
    await npFlush();
    await npTick(1);
    expect(npPair('NP4')).toMatchObject({ status: 'working', executor: NP_EXEC, auditor: 'none' });
  });
});
