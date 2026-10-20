import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { buildHeldWaitReason } from '../../../src/daemon/task-pairs/messages.js';
import { clearSupervisionHeartbeatProjectionsForTests } from '../../../src/daemon/supervision-heartbeat-projection.js';

const PROJECT = 'qaproj';
const BRAIN = 'deck_qaproj_brain';
const EXEC = 'deck_sub_qaexec';
const EXEC2 = 'deck_sub_qaexec2';
const AUD = 'deck_sub_qaaud';
let now = 1_000_000;
let busy: Set<string>;
let sent: Array<{ target: string; text: string; id: string }>;
let automation: TaskPairAutomation;
let turn = 0;

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
const marker = (writer: string, line: string) => { turn += 1; return taskPairService.ingestText(PROJECT, writer, line, `qa-turn-${turn}`, now); };
const pair = (taskId: string) => getTaskPairStore().getPair(PROJECT, taskId)!.state;
async function flush() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await taskPairService.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (taskPairService.pendingCount === 0) return;
  }
}

describe('queued pair admission', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    clearSupervisionHeartbeatProjectionsForTests();
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = []; busy = new Set(); now = 1_000_000;
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(EXEC2, 'w2'), session(AUD, 'w3')]) upsertSession(record);
    automation = new TaskPairAutomation({ now: () => now, isBusy: (name) => busy.has(name), importLegacy: () => undefined, poolOf: () => 'primary' });
    taskPairService.setScheduler(automation);
  });
  afterEach(async () => {
    await flush();
    clearSupervisionHeartbeatProjectionsForTests();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, EXEC2, AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('REPRO: a no-auditor pair the executor DONE and Brain force-DONEd releases the executor for the next DISPATCH', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T0 executor=${EXEC} auditor=none -->`);
    await flush();
    marker(EXEC, '<!-- IMCODES_TASK STARTED T0 -->');
    marker(EXEC, '<!-- IMCODES_TASK DONE T0 -->');
    await flush();
    expect(pair('T0').status).toBe('awaiting_brain_decision');
    marker(BRAIN, '<!-- IMCODES_TASK DONE T0 force=true -->');
    await flush();
    expect(pair('T0').status).toBe('done');
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('T1').status).toBe('working');
    expect(pair('T1').flags).not.toContain('waiting_for_capacity');
  });

  it('a genuinely busy named executor still makes the pair wait, with the reason naming it; it starts once it is idle', async () => {
    busy.add(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH B1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('B1').status).toBe('queued');
    expect(pair('B1').flags).toContain('waiting_for_capacity');
    expect(pair('B1').capacityWaitReason).toBe(`waiting for ${EXEC} (session busy)`);
    now += 30_000;
    await automation.runQueue(PROJECT, BRAIN);
    expect(pair('B1').status).toBe('queued');
    busy.delete(EXEC);
    now += 30_000;
    await automation.runQueue(PROJECT, BRAIN);
    await flush();
    expect(pair('B1').status).toBe('working');
    expect(pair('B1').capacityWaitReason).toBeUndefined();
    expect(pair('B1').flags).not.toContain('waiting_for_capacity');
  });

  it('an auditor-only wait: the reason names the auditor, not the idle executor', async () => {
    busy.add(AUD);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH A1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('A1').status).toBe('queued');
    expect(pair('A1').capacityWaitReason).toBe(`waiting for ${AUD} (session busy)`);
    busy.delete(AUD);
    await automation.runQueue(PROJECT, BRAIN);
    await flush();
    expect(pair('A1').status).toBe('working');
  });

  it('REASSIGN of a queued pair to an idle session admits it at once (no 30 s sweep) and drops the stale wait reason', async () => {
    busy.add(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH R1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('R1').capacityWaitReason).toContain(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN R1 executor=${EXEC2} -->`);
    await flush();
    expect(pair('R1')).toMatchObject({ status: 'working', executor: EXEC2 });
    expect(pair('R1').capacityWaitReason).toBeUndefined();
    expect(pair('R1').flags).not.toContain('waiting_for_capacity');
  });

  it('REASSIGN of a queued pair to another busy session recomputes the wait reason to name the NEW session', async () => {
    busy.add(EXEC);
    busy.add(EXEC2);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH R2 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('R2').capacityWaitReason).toContain(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN R2 executor=${EXEC2} -->`);
    await flush();
    expect(pair('R2').status).toBe('queued');
    expect(pair('R2').capacityWaitReason).toBe(`waiting for ${EXEC2} (session busy)`);
    expect(pair('R2').capacityWaitReason).not.toContain(EXEC + ' ');
  });

  it('QUEUE max re-runs admission at once: raising the cap starts the pair that waited for capacity', async () => {
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE - max=1 -->');
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH C1 executor=${EXEC} auditor=none -->`);
    await flush();
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH C2 executor=${EXEC2} auditor=none -->`);
    await flush();
    expect(pair('C1').status).toBe('working');
    expect(pair('C2').status).toBe('queued');
    expect(pair('C2').capacityWaitReason).toBe('waiting for concurrency capacity (1/1 open pairs)');
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE - max=2 -->');
    await flush();
    expect(pair('C2').status).toBe('working');
    expect(pair('C2').capacityWaitReason).toBeUndefined();
    expect(pair('C2').flags).not.toContain('waiting_for_capacity');
  });

  it('a queued pair naming a session another open pair holds shows the holder as its wait reason from the moment it queues, and starts when that pair closes', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH H1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH H2 executor=${EXEC2} auditor=${AUD} -->`);
    await flush();
    expect(pair('H2').status).toBe('queued');
    expect(pair('H2').capacityWaitReason).toMatch(new RegExp(`^waiting for ${AUD} \\(busy in H1, status working, age \\d+[smh]\\)$`));
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL H1 -->');
    await flush();
    expect(pair('H2').status).toBe('working');
    expect(pair('H2').capacityWaitReason).toBeUndefined();
  });

  it('closing a pair frees the slot for the next queued one immediately, urgent first', async () => {
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE - max=1 -->');
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH U0 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH U1 executor=${EXEC2} auditor=${AUD} -->`);
    await flush();
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH U2 executor=${EXEC2} auditor=${AUD} urgent=true -->`);
    await flush();
    expect([pair('U1').status, pair('U2').status]).toEqual(['queued', 'queued']);
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL U0 -->');
    await flush();
    expect(pair('U2').status).toBe('working'); // urgent jumps the FIFO
    expect(pair('U1').status).toBe('queued');
  });

  it('a session going idle admits the queued pair naming it without waiting for a sweep', async () => {
    busy.add(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH I1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('I1').status).toBe('queued');
    busy.delete(EXEC);
    automation.observeTimelineEvent({ sessionId: EXEC, type: 'session.state', payload: { state: 'idle' } });
    await flush();
    expect(pair('I1').status).toBe('working');
  });

  it('restart: a queued pair persisted in the store is admitted by the first sweep of a fresh scheduler, before any interval elapses', async () => {
    busy.add(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH S1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('S1').status).toBe('queued');
    busy.clear();
    const restarted = new TaskPairAutomation({ now: () => now, isBusy: (name) => busy.has(name), importLegacy: () => undefined, poolOf: () => 'primary' });
    taskPairService.setScheduler(restarted);
    restarted.start(60 * 60_000);
    try {
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await flush();
      expect(pair('S1').status).toBe('working');
    } finally {
      restarted.stop();
    }
  });

  // ---- P0-1 class: a REASSIGN/arrival that parks a queued pair behind a session ANOTHER OPEN PAIR holds ----
  const heldReason = (session: string, holder: string) => new RegExp(`^waiting for ${session} \\(busy in ${holder}, status working, age \\d+[smh]\\)$`);

  it('REASSIGN of a queued pair (waiting on a runtime-busy session) onto a session another open pair holds names the NEW holder at once, without a sweep', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH HP executor=${EXEC2} auditor=none -->`);
    await flush();
    busy.add(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH R3 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('R3').capacityWaitReason).toBe(`waiting for ${EXEC} (session busy)`);
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN R3 executor=${EXEC2} -->`);
    await flush();
    expect(pair('R3').status).toBe('queued');
    expect(pair('R3').capacityWaitReason).toMatch(heldReason(EXEC2, 'HP'));
    expect(pair('R3').capacityWaitReason).not.toContain(EXEC + ' ');
    expect(pair('R3').flags).toContain('waiting_for_capacity');
  });

  it('REASSIGN of the AUDITOR of a queued pair onto a held session names that auditor at once', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH HA executor=${EXEC2} auditor=none -->`);
    await flush();
    busy.add(EXEC);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH R4 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('R4').capacityWaitReason).toBe(`waiting for ${EXEC} (session busy)`);
    // The auditor (idle) is swapped for a session that is held by HA; the executor is still runtime-busy.
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN R4 auditor=${EXEC2} -->`);
    await flush();
    expect(pair('R4').capacityWaitReason).toMatch(heldReason(EXEC2, 'HA'));
  });

  it('REASSIGN from one held session to another held session replaces the holder, and to an idle session admits and clears', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH HX executor=${EXEC} auditor=none -->`);
    await flush();
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH HY executor=${EXEC2} auditor=none -->`);
    await flush();
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH R5 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('R5').capacityWaitReason).toMatch(heldReason(EXEC, 'HX'));
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN R5 executor=${EXEC2} -->`);
    await flush();
    expect(pair('R5').capacityWaitReason).toMatch(heldReason(EXEC2, 'HY'));
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL HY -->');
    await flush();
    expect(pair('R5').status).toBe('working');
    expect(pair('R5').capacityWaitReason).toBeUndefined();
  });

  it('the held-session wording is one helper shared by the arrival note and the queue run (a sweep rewrites the same text)', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH HW executor=${EXEC} auditor=none -->`);
    await flush();
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH W1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    const atArrival = pair('W1').capacityWaitReason!;
    expect(atArrival).toMatch(heldReason(EXEC, 'HW'));
    await automation.runQueue(PROJECT, BRAIN);
    const afterSweep = pair('W1').capacityWaitReason!;
    expect(afterSweep.replace(/age \d+[smh]/, 'age X')).toBe(atArrival.replace(/age \d+[smh]/, 'age X'));
    expect(buildHeldWaitReason(EXEC, { taskId: 'T', status: 'working', updatedAt: 0 }, 5_000)).toBe(`waiting for ${EXEC} (busy in T, status working, age 5s)`);
    expect(buildHeldWaitReason(EXEC, { taskId: 'T', status: 'working', updatedAt: 0 }, 3 * 3_600_000)).toContain('age 3h');
    expect(buildHeldWaitReason(EXEC, { taskId: 'T', status: 'working', updatedAt: 0 }, 90_000)).toContain('age 1m');
    expect(buildHeldWaitReason(EXEC, undefined, 0)).toBe(`waiting for ${EXEC} (busy in another open pair)`);
  });
});
