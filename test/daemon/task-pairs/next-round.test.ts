/**
 * NEXT_ROUND through the real marker ingestion (tsk_cd_pair_next_round_after_pass):
 * passed -> NEXT_ROUND -> working -> READY -> PASS all take effect, the
 * participants are told, the panel event carries the delivery round, and the
 * round's material is checked against its base.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { setTaskPairMaterialDepsForTests } from '../../../src/daemon/task-pairs/material.js';
import { TaskPairService, type TaskPairScheduler } from '../../../src/daemon/task-pairs/service.js';
import { TASK_PAIR_MATERIAL_EVENT_VERB, TASK_PAIR_TIMELINE_EVENT } from '../../../shared/task-pair.js';

const PROJECT = 'nrproj';
const BRAIN = 'deck_nrproj_brain';
const EXEC = 'deck_sub_nrexec';
const AUD = 'deck_sub_nraud';
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const HEAD3 = '3'.repeat(40);
const DEV_TIP = '9'.repeat(40);

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

let service: TaskPairService;
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;
let ancestry: (worktree: string, ancestor: string, descendant: string) => Promise<boolean | undefined>;
const ancestryCalls: Array<{ ancestor: string; descendant: string }> = [];

// A pair naming both roles starts the moment its slot frees (no pool logic here).
const testScheduler: TaskPairScheduler = {
  async onIntent(project, pairState, intent) {
    if (intent.kind !== 'slot_changed') return;
    if (pairState.status !== 'queued' || !pairState.executor || pairState.auditor === undefined) return;
    service.applyMarker({
      project, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: pairState.taskId, attrs: { executor: pairState.executor, auditor: pairState.auditor } },
      source: 'queue', now: Date.now(), eventId: `nr-queue-drain:${pairState.taskId}:${Date.now()}:${Math.random()}`,
    });
    await service.briefParticipants(project, pairState.taskId);
  },
};

async function flush() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (service.pendingCount === 0) return;
  }
}

async function say(sessionName: string, text: string) {
  turn += 1;
  timelineEmitter.emit(sessionName, 'assistant.text', { text, streaming: false }, {
    source: 'daemon', confidence: 'high', eventId: `nr-turn-${turn}`,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
}

const pair = (taskId: string) => getTaskPairStore().getPair(PROJECT, taskId)?.state;
const liveness = (taskId: string) => getTaskPairStore().getPair(PROJECT, taskId)!.liveness;
const sentTo = (target: string, reason: string) => sent.filter((entry) => entry.target === target && entry.id.includes(`:${reason}:`));

/** Round 1 through PASS with a named worktree/head, leaving the pair passed and not done. */
async function passRoundOne(taskId = 'T1') {
  await say(BRAIN, `<!-- IMCODES_TASK DISPATCH ${taskId} executor=${EXEC} auditor=${AUD} -->`);
  await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} worktree=/ws/${taskId} head=${HEAD1} base=basebase0 -->`);
  await say(AUD, `Findings: none.\n<!-- IMCODES_TASK PASS ${taskId} blocking=P0 -->`);
  expect(pair(taskId)?.status).toBe('passed');
}

describe('NEXT_ROUND through marker ingestion', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    ancestryCalls.length = 0;
    ancestry = async (_worktree, ancestor, descendant) => { ancestryCalls.push({ ancestor, descendant }); return true; };
    setTaskPairMaterialDepsForTests({ gitIsAncestor: (worktree, ancestor, descendant) => ancestry(worktree, ancestor, descendant) });
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3')]) upsertSession(record);
    service = new TaskPairService();
    service.init();
    service.setScheduler(testScheduler);
  });

  afterEach(async () => {
    await service.dispose();
    setTaskPairMaterialDepsForTests(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('runs passed -> NEXT_ROUND -> working -> READY -> PASS -> DONE, telling both sides and re-notifying Brain of the second PASS', async () => {
    await passRoundOne();
    expect(sentTo(BRAIN, 'brain-line-pass-done')).toHaveLength(1);
    expect(sentTo(BRAIN, 'brain-line-pass-done')[0]!.text).toContain('pair_next_round (taskId=T1');

    const events: Array<Record<string, unknown>> = [];
    const off = timelineEmitter.on((event) => {
      if (event.type === TASK_PAIR_TIMELINE_EVENT && event.sessionId === BRAIN) events.push(event.payload as Record<string, unknown>);
    });
    sent = [];
    await say(BRAIN, `Round 1 is merged.\n<!-- IMCODES_TASK NEXT_ROUND T1 base=${DEV_TIP} note="round 2: console sync" -->`);
    expect(pair('T1')).toMatchObject({ status: 'working', deliveryRound: 2, executor: EXEC, auditor: AUD });
    // Both participants are told what round 2 builds on.
    for (const target of [EXEC, AUD]) {
      const notice = sentTo(target, 'next-round');
      expect(notice, target).toHaveLength(1);
      expect(notice[0]!.text).toContain('delivery round 2');
      expect(notice[0]!.text).toContain(DEV_TIP);
      expect(notice[0]!.text).toContain('round 2: console sync');
    }
    // The panel event carries the delivery round and the new status.
    const opened = events.find((payload) => payload.verb === 'NEXT_ROUND');
    expect(opened).toMatchObject({ taskId: 'T1', toStatus: 'working', deliveryRound: 2, effect: 'next_round', unusual: false });

    sent = [];
    await say(EXEC, `Done with round 2.\n<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
    expect(pair('T1')).toMatchObject({ status: 'in_audit', deliveryRound: 2 });
    expect(pair('T1')?.material).toMatchObject({ head: HEAD2, base: DEV_TIP });
    const audit = sentTo(AUD, 'audit-request');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.text).toContain(`descends from the round base ${DEV_TIP}`);
    expect(ancestryCalls).toEqual([{ ancestor: DEV_TIP, descendant: HEAD2 }]);

    await say(AUD, 'Findings: none.\n<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
    expect(pair('T1')).toMatchObject({ status: 'passed', deliveryRound: 2 });
    // The pass/done notice is once per audit round, so the second PASS reaches Brain too.
    expect(sentTo(BRAIN, 'brain-line-pass-done')).toHaveLength(1);
    off();

    await say(EXEC, '<!-- IMCODES_TASK DONE T1 -->');
    expect(pair('T1')?.status).toBe('done');
  });

  it('defaults the base to the previous round\'s PASSed head and verifies the new head against it', async () => {
    await passRoundOne();
    await say(BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
    expect(pair('T1')?.roundBase).toMatchObject({ commit: HEAD1, source: 'passed_head', deliveryRound: 2 });
    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
    expect(ancestryCalls).toEqual([{ ancestor: HEAD1, descendant: HEAD2 }]);
  });

  it('sends a head that does not descend from the round base back to the executor instead of auditing it, and audits the resend', async () => {
    await passRoundOne();
    await say(BRAIN, `<!-- IMCODES_TASK NEXT_ROUND T1 base=${DEV_TIP} -->`);
    ancestry = async (_w, ancestor, descendant) => { ancestryCalls.push({ ancestor, descendant }); return descendant !== HEAD2; };
    sent = [];
    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
    const mismatch = sentTo(EXEC, 'material-base-mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.text).toContain(HEAD2);
    expect(mismatch[0]!.text).toContain(DEV_TIP);
    const wait = sentTo(AUD, 'audit-request');
    expect(wait).toHaveLength(1);
    expect(wait[0]!.text).toContain('does not descend from the round base');
    expect(wait[0]!.text).not.toContain('Judge by');

    sent = [];
    await say(EXEC, `Rebased.\n<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD3} -->`);
    expect(sentTo(EXEC, 'material-base-mismatch')).toHaveLength(0);
    const resent = sentTo(AUD, 'audit-request');
    expect(resent).toHaveLength(1);
    expect(resent[0]!.text).toContain('Judge by');
    expect(resent[0]!.text).toContain(`descends from the round base ${DEV_TIP}`);
  });

  it('tells the auditor the base is unverified (not blocked) when git cannot tell', async () => {
    await passRoundOne();
    await say(BRAIN, `<!-- IMCODES_TASK NEXT_ROUND T1 base=${DEV_TIP} -->`);
    ancestry = async () => undefined;
    sent = [];
    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
    expect(sentTo(EXEC, 'material-base-mismatch')).toHaveLength(0);
    const audit = sentTo(AUD, 'audit-request');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.text).toContain('could not be verified');
  });

  it('rejects a READY that names a different base and applies nothing', async () => {
    await passRoundOne();
    await say(BRAIN, `<!-- IMCODES_TASK NEXT_ROUND T1 base=${DEV_TIP} -->`);
    sent = [];
    await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} base=${HEAD1} -->`);
    expect(pair('T1')?.status).toBe('working');
    expect(pair('T1')?.material).toBeUndefined();
    expect(sentTo(EXEC, 'policy-rejection')[0]?.text).toContain(DEV_TIP);
    expect(sentTo(AUD, 'audit-request')).toHaveLength(0);
  });

  it('counterexample: NEXT_ROUND from the executor is rejected with a notice and the pair stays passed', async () => {
    await passRoundOne();
    sent = [];
    await say(EXEC, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
    expect(pair('T1')?.status).toBe('passed');
    expect(pair('T1')?.deliveryRound).toBeUndefined();
    expect(sentTo(EXEC, 'policy-rejection')[0]?.text).toContain('Only Brain');
    expect(sentTo(EXEC, 'next-round')).toHaveLength(0);
    expect(sentTo(AUD, 'next-round')).toHaveLength(0);
  });

  it('counterexample: a DONE pair cannot open another round', async () => {
    await passRoundOne();
    await say(EXEC, '<!-- IMCODES_TASK DONE T1 -->');
    expect(pair('T1')?.status).toBe('done');
    sent = [];
    await say(BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
    expect(pair('T1')?.status).toBe('done');
    expect(pair('T1')?.deliveryRound).toBeUndefined();
    expect(sentTo(BRAIN, 'policy-rejection')[0]?.text).toContain('new taskId');
  });

  it('counterexample: a CANCELLED pair cannot open another round', async () => {
    await passRoundOne();
    await say(BRAIN, '<!-- IMCODES_TASK CANCEL T1 -->');
    expect(pair('T1')?.status).toBe('cancelled');
    sent = [];
    await say(BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
    expect(pair('T1')?.status).toBe('cancelled');
    expect(sentTo(BRAIN, 'policy-rejection')).toHaveLength(1);
  });

  it('restarts both sides\' silence bookkeeping: the passed-and-idle period does not count against the new round', async () => {
    await passRoundOne();
    const stored = getTaskPairStore().getPair(PROJECT, 'T1')!;
    getTaskPairStore().saveLiveness(PROJECT, 'T1', {
      ...stored.liveness, silenceExecutor: 2, silenceAuditor: 1, bothIdleNudgedAt: 5,
      progressExecutorAt: 1, activityExecutorAt: 1, progressAuditorAt: 1, activityAuditorAt: 1,
    });
    await say(BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
    const after = liveness('T1');
    expect(after).toMatchObject({ silenceExecutor: 0, silenceAuditor: 0 });
    expect(after.bothIdleNudgedAt).toBeUndefined();
    expect(after.activityExecutorAt).toBeGreaterThan(1);
    expect(after.activityAuditorAt).toBeGreaterThan(1);
    expect(pair('T1')?.flags).not.toContain('executor_silent');
  });
  describe('a definite not-ancestor result also holds PASS (tsk_cd_next_round_ancestry_hold)', () => {
    async function openRoundTwoAndSendBadHead(): Promise<void> {
      await passRoundOne();
      await say(BRAIN, `<!-- IMCODES_TASK NEXT_ROUND T1 base=${DEV_TIP} -->`);
      ancestry = async (_w, ancestor, descendant) => { ancestryCalls.push({ ancestor, descendant }); return descendant !== HEAD2; };
      sent = [];
      await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
    }

    it('persists the hold, records a daemon event, and a PASS written anyway is held: status stays in_audit and the executor is told to send a new READY', async () => {
      const events: Array<Record<string, unknown>> = [];
      const off = timelineEmitter.on((event) => {
        if (event.type === TASK_PAIR_TIMELINE_EVENT && event.sessionId === BRAIN) events.push(event.payload as Record<string, unknown>);
      });
      await openRoundTwoAndSendBadHead();
      expect(pair('T1')).toMatchObject({ status: 'in_audit', materialHold: { reason: 'round_base_not_ancestor', head: HEAD2, base: DEV_TIP } });
      expect(events.find((payload) => payload.verb === TASK_PAIR_MATERIAL_EVENT_VERB)).toMatchObject({ effect: 'material_held', unusual: true, taskId: 'T1' });
      off();
      expect(sentTo(EXEC, 'material-base-mismatch')[0]!.text).toContain('PASS is held');

      sent = [];
      await say(AUD, 'Looks fine.\n<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
      expect(pair('T1')?.status).toBe('in_audit');
      expect(pair('T1')?.passRound).toBeUndefined();
      expect(getTaskPairStore().listEvents(PROJECT, 'T1').some((event) => event.verb === 'PASS' && event.unusual && event.effect === 'recorded' && event.fromStatus === 'in_audit')).toBe(true);
      expect(sentTo(AUD, 'policy-rejection')[0]?.text).toContain('was held');
      expect(sentTo(EXEC, 'policy-rejection')[0]?.text).toContain('new READY_FOR_AUDIT');
      expect(sentTo(BRAIN, 'brain-line-pass-done')).toHaveLength(0);
    });

    it('a new READY with a descending head clears the hold, is audited, and PASS then applies normally', async () => {
      await openRoundTwoAndSendBadHead();
      sent = [];
      await say(EXEC, `Rebased.\n<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD3} -->`);
      expect(pair('T1')?.materialHold).toBeUndefined();
      expect(pair('T1')?.material?.head).toBe(HEAD3);
      expect(sentTo(AUD, 'audit-request')[0]!.text).toContain('Judge by');
      await say(AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
      expect(pair('T1')).toMatchObject({ status: 'passed', deliveryRound: 2 });
      expect(sentTo(BRAIN, 'brain-line-pass-done')).toHaveLength(1);
    });

    it('a resent READY that leaves the head out is still re-verified: it cannot bypass the hold', async () => {
      await openRoundTwoAndSendBadHead();
      sent = [];
      // The daemon resolves the head again; the same bad head is held again.
      getTaskPairStore().savePair(PROJECT, { ...pair('T1')!, workspace: { kind: 'worktree', path: '/ws/T1', lastHead: HEAD2, createdAt: 1, status: 'active' } });
      await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T1 -->');
      await say(AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
      expect(pair('T1')?.status).toBe('in_audit');
    });

    it('REWORK during the hold still works', async () => {
      await openRoundTwoAndSendBadHead();
      await say(AUD, 'Head is not on the base.\n<!-- IMCODES_TASK REWORK T1 blocking=P0 p0=1 -->');
      expect(pair('T1')).toMatchObject({ status: 'rework', deliveryRound: 2 });
      expect(pair('T1')?.materialHold).toBeUndefined();
    });

    it('an unknown ancestry result (git unavailable) keeps its behaviour: audited with an "unverified" note, no hold, PASS applies', async () => {
      await passRoundOne();
      await say(BRAIN, `<!-- IMCODES_TASK NEXT_ROUND T1 base=${DEV_TIP} -->`);
      ancestry = async () => undefined;
      sent = [];
      await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
      expect(pair('T1')?.materialHold).toBeUndefined();
      expect(sentTo(AUD, 'audit-request')[0]!.text).toContain('could not be verified');
      await say(AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
      expect(pair('T1')?.status).toBe('passed');
    });

    it('a first-round pair is never held: the ancestry check is not consulted', async () => {
      await passRoundOne('T7');
      expect(ancestryCalls).toEqual([]);
      expect(pair('T7')).toMatchObject({ status: 'passed' });
      expect(pair('T7')?.materialHold).toBeUndefined();
    });

    it('a newer READY that lands while git is still running is not held by the older result', async () => {
      await passRoundOne();
      await say(BRAIN, `<!-- IMCODES_TASK NEXT_ROUND T1 base=${DEV_TIP} -->`);
      let release!: (value: boolean) => void;
      ancestry = () => new Promise<boolean>((resolve) => { release = resolve; });
      // `say` would wait for the service to go idle, which it cannot while the slow git check is pending.
      const sayWithoutWaiting = async (sessionName: string, text: string) => {
        turn += 1;
        timelineEmitter.emit(sessionName, 'assistant.text', { text, streaming: false }, { source: 'daemon', confidence: 'high', eventId: `nr-turn-${turn}` });
        for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      };
      await sayWithoutWaiting(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
      // A fresh READY replaces the material before the slow check answers "not an ancestor" for the old head.
      ancestry = async () => true;
      await sayWithoutWaiting(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD3} -->`);
      release(false);
      await flush();
      expect(pair('T1')?.material?.head).toBe(HEAD3);
      expect(pair('T1')?.materialHold).toBeUndefined();
    });

    it('a daemon restart during the hold keeps it (persisted state): the reloaded pair still holds PASS', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'imcodes-next-round-hold-'));
      const dbPath = join(dir, 'task-pairs.sqlite');
      try {
        setTaskPairStoreForTests(new TaskPairStore(dbPath));
        await openRoundTwoAndSendBadHead();
        expect(pair('T1')?.materialHold).toBeDefined();
        await service.dispose();
        setTaskPairStoreForTests(new TaskPairStore(dbPath));
        service = new TaskPairService();
        service.init();
        service.setScheduler(testScheduler);
        expect(pair('T1')).toMatchObject({ status: 'in_audit', materialHold: { head: HEAD2, base: DEV_TIP } });
        await say(AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
        expect(pair('T1')?.status).toBe('in_audit');
        await say(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD3} -->`);
        await say(AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
        expect(pair('T1')?.status).toBe('passed');
      } finally {
        setTaskPairStoreForTests(new TaskPairStore(':memory:'));
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
