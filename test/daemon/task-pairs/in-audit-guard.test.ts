/**
 * An executor's STARTED/WORKING while its pair is in audit must not take the
 * pair out of audit (it voided the auditor's pending PASS/REWORK), and the same
 * READY_FOR_AUDIT again must be a no-op (tsk_cd_in_audit_working_guard). The
 * daemon enforces both; contract text alone did not stop them.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService } from '../../../src/daemon/task-pairs/service.js';
import {
  TASK_PAIR_DUPLICATE_READY_EFFECT,
  TASK_PAIR_IDEMPOTENT_STARTED_EFFECT,
  TASK_PAIR_IN_AUDIT_GUARDED_EFFECT,
  applyTaskPairMarker,
  type TaskPairMaterial,
  type TaskPairState,
  type TaskPairStatus,
} from '../../../shared/task-pair.js';

const PROJECT = 'iagproj';
const BRAIN = 'deck_iagproj_brain';
const EXEC = 'deck_sub_iagexec';
const AUD = 'deck_sub_iagaud';
const TASK = 'tsk_iag';
const HEAD_A = 'aaaaaaa1111111111111111111111111aaaaaaaa';
const HEAD_B = 'bbbbbbb2222222222222222222222222bbbbbbbb';
const BASE = 'cccccccc3333333333333333333333333cccccccc';

let root: string;
let sent: Array<{ target: string; text: string; id: string }>;
let seq = 0;
const service = new TaskPairService();

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: '/tmp/iagproj', state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

function pairState(status: TaskPairStatus, over: Partial<TaskPairState> = {}): TaskPairState {
  const now = Date.now();
  return {
    taskId: TASK, brain: BRAIN, executor: EXEC, auditor: AUD, status, round: 1, blocking: ['P0'],
    flags: [], flagSides: {}, previousAuditors: [], capCounts: {}, capRound: 1, createdAt: now, updatedAt: now, title: 'guard',
    ...over,
  } as TaskPairState;
}

const savePair = (status: TaskPairStatus, over: Partial<TaskPairState> = {}) => getTaskPairStore().savePair(PROJECT, pairState(status, over));
const pair = () => getTaskPairStore().getPair(PROJECT, TASK)!.state;
const events = () => getTaskPairStore().listEvents(PROJECT, TASK, 200);
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const toAuditor = () => sent.filter((entry) => entry.target === AUD && entry.id.includes(':audit-request:'));
const toExecutor = () => sent.filter((entry) => entry.target === EXEC && entry.id.includes(':policy-rejection:'));

function marker(verb: string, writer: string, attrs: Record<string, string> = {}, now = Date.now()) {
  seq += 1;
  return service.applyMarker({
    project: PROJECT, writer, source: 'marker', eventId: `iag-${seq}`, now,
    marker: { verb, knownVerb: verb as never, taskId: TASK, attrs },
  });
}

describe('an executor cannot take its pair out of audit, and a repeated READY is a no-op', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let worktree: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imc-iag-'));
    worktree = join(root, 'wt');
    mkdirSync(worktree, { recursive: true });
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    seq = 0;
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    upsertSession(session(BRAIN, 'brain'));
    upsertSession(session(EXEC, 'w1'));
    upsertSession(session(AUD, 'w2'));
  });
  afterEach(() => {
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    rmSync(root, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  const inAudit = (head = HEAD_A, extra: Partial<TaskPairMaterial> = {}) => savePair('in_audit', {
    round: 1, material: { worktree, head, base: BASE, at: 1, ...extra },
    workspace: { kind: 'worktree', path: worktree, createdAt: 1, status: 'active' } as never,
  });

  describe('executor STARTED/WORKING in audit', () => {
    it.each(['WORKING', 'STARTED'])('%s is recorded as unusual, the status stays in_audit, one notice per round', async (verb) => {
      inAudit();
      const first = marker(verb, EXEC);
      expect(first.effect).toBe(TASK_PAIR_IN_AUDIT_GUARDED_EFFECT);
      expect(first.unusual).toBe(true);
      expect(pair().status).toBe('in_audit');
      await flush();
      expect(toExecutor()).toHaveLength(1);
      expect(toExecutor()[0]!.text).toContain('new READY_FOR_AUDIT');
      expect(toExecutor()[0]!.text).toContain('plain reply');
      // The executor keeps writing it: recorded each time, told only once in this round.
      marker(verb, EXEC);
      marker('WORKING', EXEC);
      await flush();
      expect(toExecutor()).toHaveLength(1);
      expect(pair().status).toBe('in_audit');
      const guarded = events().filter((event) => event.effect === TASK_PAIR_IN_AUDIT_GUARDED_EFFECT);
      expect(guarded).toHaveLength(3);
      expect(guarded.every((event) => event.unusual && event.toStatus === 'in_audit')).toBe(true);
    });

    it('the auditor\'s PASS afterwards applies normally (it was voided before)', () => {
      inAudit();
      marker('WORKING', EXEC);
      const verdict = marker('PASS', AUD, { blocking: 'P0' });
      expect(verdict.effect).toBe('verdict');
      expect(verdict.unusual).toBe(false);
      expect(pair().status).toBe('passed');
    });

    it('the auditor\'s REWORK afterwards applies normally', () => {
      inAudit();
      marker('WORKING', EXEC);
      const verdict = marker('REWORK', AUD, { blocking: 'P0', p0: '1' });
      expect(verdict.effect).toBe('verdict');
      expect(verdict.unusual).toBe(false);
      expect(pair().status).toBe('rework');
    });

    it('a new round (new READY) is told again', async () => {
      inAudit();
      marker('WORKING', EXEC);
      marker('REWORK', AUD, { blocking: 'P0', p0: '1' });
      marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_B });
      expect(pair().status).toBe('in_audit');
      marker('WORKING', EXEC);
      await flush();
      expect(toExecutor()).toHaveLength(2);
    });

    it('awaiting_audit (the executor wrote DONE, no PASS yet) is guarded the same way', async () => {
      savePair('awaiting_audit', { material: { worktree, head: HEAD_A, at: 1 } });
      expect(marker('WORKING', EXEC).effect).toBe(TASK_PAIR_IN_AUDIT_GUARDED_EFFECT);
      expect(pair().status).toBe('awaiting_audit');
    });

    it('is unchanged outside audit: working and rework pairs still accept the executor\'s WORKING/STARTED', () => {
      savePair('rework');
      expect(marker('WORKING', EXEC).effect).toBe('status');
      expect(pair().status).toBe('working');
      savePair('working');
      expect(marker('STARTED', EXEC).effect).toBe(TASK_PAIR_IDEMPOTENT_STARTED_EFFECT);
      expect(pair().status).toBe('working');
    });

    it('Brain\'s WORKING/STARTED still takes the pair out of audit (manual override, unchanged)', () => {
      inAudit();
      const transition = marker('WORKING', BRAIN);
      expect(transition.effect).toBe('status');
      expect(pair().status).toBe('working');
      inAudit();
      expect(marker('STARTED', BRAIN).effect).toBe('status');
      expect(pair().status).toBe('working');
    });

    it('a different writer (neither executor nor Brain) is not covered: behaviour unchanged', () => {
      inAudit();
      expect(marker('WORKING', AUD).effect).toBe('status');
    });
  });

  describe('READY_FOR_AUDIT in audit', () => {
    it('the same head and base again is a no-op: no event row, no status effect, no relay, same material and round', async () => {
      inAudit();
      const before = pair();
      const rows = events().length;
      const transition = marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A, base: BASE });
      await flush();
      expect(transition.effect).toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      expect(transition.unusual).toBe(false);
      expect(events()).toHaveLength(rows);
      expect(pair()).toEqual(before);
      expect(toAuditor()).toHaveLength(0);
      // Twice in a row, and with base= left out, and long after the marker dedup window.
      marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A });
      marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A, base: BASE }, Date.now() + 60 * 60_000);
      await flush();
      expect(events()).toHaveLength(rows);
      expect(toAuditor()).toHaveLength(0);
      expect(pair().round).toBe(1);
    });

    it('an abbreviated commit id names the same head', () => {
      inAudit();
      expect(marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A.slice(0, 9) }).effect).toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
    });

    it('a DIFFERENT head replaces the material and re-notifies the auditor', async () => {
      inAudit();
      const transition = marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_B, base: BASE });
      await flush();
      expect(transition.effect).not.toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      expect(pair().status).toBe('in_audit');
      expect(pair().material?.head).toBe(HEAD_B);
      expect(toAuditor()).toHaveLength(1);
      expect(toAuditor()[0]!.text).toContain(HEAD_B);
    });

    it('a different base, a different worktree or a stated note is new material', () => {
      inAudit();
      expect(marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A, base: HEAD_B }).effect).not.toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      inAudit();
      expect(marker('READY_FOR_AUDIT', EXEC, { worktree: join(root, 'other'), head: HEAD_A }).effect).not.toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      inAudit();
      expect(marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A, note: 'deleting old.ts on purpose' }).effect).not.toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
    });

    it('a repeated bare READY (no attributes) with the same workspace head is a no-op, a moved head is not', () => {
      savePair('in_audit', {
        round: 1, material: { path: worktree, head: HEAD_A, at: 1 },
        workspace: { kind: 'worktree', path: worktree, lastHead: HEAD_A, createdAt: 1, status: 'active' } as never,
      });
      expect(marker('READY_FOR_AUDIT', EXEC).effect).toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      savePair('in_audit', {
        round: 1, material: { path: worktree, head: HEAD_A, at: 1 },
        workspace: { kind: 'worktree', path: worktree, lastHead: HEAD_B, createdAt: 1, status: 'active' } as never,
      });
      expect(marker('READY_FOR_AUDIT', EXEC).effect).not.toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
    });

    it('a READY outside audit is unchanged: it opens a round', () => {
      savePair('working');
      const transition = marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A });
      expect(transition.effect).toBe('status');
      expect(pair().status).toBe('in_audit');
      expect(pair().round).toBe(2);
    });

    it('after a REWORK the same head again opens the next round (it is not a duplicate of a closed round)', () => {
      inAudit();
      marker('REWORK', AUD, { blocking: 'P0', p0: '1' });
      expect(pair().status).toBe('rework');
      const again = marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A });
      expect(again.effect).toBe('status');
      expect(pair().status).toBe('in_audit');
    });
  });

  describe('boundaries', () => {
    const ctx = (writer: string) => ({ writer, fallbackBrain: BRAIN, now: Date.now(), source: 'marker' as const });
    const ready = (existing: TaskPairState, attrs: Record<string, string>) => applyTaskPairMarker(existing, { knownVerb: 'READY_FOR_AUDIT', taskId: TASK, attrs }, ctx(EXEC));

    it('NEXT_ROUND: a resent READY on the round base is a duplicate, a new head in the round is accepted', () => {
      const roundState = pairState('in_audit', {
        round: 3, deliveryRound: 2, roundBase: { commit: BASE, source: 'brain', deliveryRound: 2, at: 1 },
        material: { worktree, head: HEAD_A, base: BASE, at: 1 },
      });
      expect(ready(roundState, { worktree, head: HEAD_A }).effect).toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      expect(ready(roundState, { worktree, head: HEAD_A, base: BASE }).effect).toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      const next = ready(roundState, { worktree, head: HEAD_B });
      expect(next.effect).toBe('status');
      expect(next.pair?.material?.head).toBe(HEAD_B);
      expect(next.intents.some((intent) => intent.kind === 'audit_request')).toBe(true);
    });

    it('a held round (materialHold) is never deduplicated: the daemon must re-verify the resend', () => {
      const held = pairState('in_audit', {
        material: { worktree, head: HEAD_A, base: BASE, at: 1 },
        materialHold: { reason: 'round_base_not_ancestor', head: HEAD_A, base: BASE, at: 1 },
      });
      const resent = ready(held, { worktree, head: HEAD_A, base: BASE });
      expect(resent.effect).toBe('status');
      expect(resent.pair?.materialHold).toBeUndefined();
      expect(resent.intents.some((intent) => intent.kind === 'audit_request')).toBe(true);
    });

    it('no-auditor pairs (auditor=none) have no audit: STARTED/WORKING and READY behave as before', () => {
      const solo = pairState('working', { auditor: 'none' });
      const working = applyTaskPairMarker(solo, { knownVerb: 'WORKING', taskId: TASK, attrs: {} }, ctx(EXEC));
      expect(working.effect).toBe('status');
      const readyTransition = ready(solo, { worktree, head: HEAD_A });
      expect(readyTransition.effect).toBe('recorded');
      expect(readyTransition.pair).toBeUndefined();
    });

    it('non-git in-place READY: the same path and the same file list (in any order) is a duplicate, another list is not', () => {
      const inPlace = pairState('in_audit', { material: { path: '/proj', files: 'src/a.ts,src/b.ts', at: 1 } });
      expect(ready(inPlace, { path: '/proj', files: 'src/a.ts,src/b.ts' }).effect).toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      expect(ready(inPlace, { path: '/proj', files: 'src/b.ts, src/a.ts' }).effect).toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
      expect(ready(inPlace, { path: '/proj', files: 'src/a.ts,src/b.ts,src/c.ts' }).effect).toBe('status');
      expect(ready(inPlace, { path: '/proj', files: 'src/a.ts' }).effect).toBe('status');
      expect(ready(inPlace, { path: '/proj2', files: 'src/a.ts,src/b.ts' }).effect).toBe('status');
    });

    it('a daemon restart mid-audit: the guard and the duplicate check read the persisted pair, not memory', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'imc-iag-db-'));
      const file = join(dir, 'task-pairs.sqlite');
      try {
        const first = new TaskPairStore(file);
        setTaskPairStoreForTests(first);
        inAudit();
        const reopened = new TaskPairStore(file);
        setTaskPairStoreForTests(reopened);
        expect(marker('WORKING', EXEC).effect).toBe(TASK_PAIR_IN_AUDIT_GUARDED_EFFECT);
        expect(marker('READY_FOR_AUDIT', EXEC, { worktree, head: HEAD_A, base: BASE }).effect).toBe(TASK_PAIR_DUPLICATE_READY_EFFECT);
        expect(marker('PASS', AUD, { blocking: 'P0' }).effect).toBe('verdict');
        await flush();
      } finally {
        setTaskPairStoreForTests(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
