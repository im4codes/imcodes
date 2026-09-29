/**
 * NEXT_ROUND (tsk_cd_pair_next_round_after_pass): Brain opens the next delivery
 * round on a PASSED, not-yet-DONE pair. Before this verb, every later
 * READY_FOR_AUDIT / PASS on such a pair was recorded as unusual and the state
 * never advanced.
 */
import { describe, expect, it } from 'vitest';
import {
  TASK_PAIR_NEXT_ROUND_VERB,
  TASK_PAIR_VERBS,
  applyTaskPairMarker,
  buildTaskPairMarkerContract,
  sameTaskPairCommit,
  scanTaskPairMarkers,
  taskPairDeliveryRound,
  type TaskPairApplyContext,
  type TaskPairMarker,
  type TaskPairState,
} from '../../shared/task-pair.js';

const BRAIN = 'deck_proj_brain';
const EXEC = 'deck_sub_exec';
const AUD = 'deck_sub_aud';
const OTHER = 'deck_sub_other';
const HEAD1 = 'a'.repeat(40);
const DEV_TIP = 'b'.repeat(40);
const HEAD2 = 'c'.repeat(40);

function ctx(writer: string, now: number): TaskPairApplyContext {
  return { writer, fallbackBrain: BRAIN, now, source: 'marker' };
}

function marker(line: string): TaskPairMarker {
  const scan = scanTaskPairMarkers(line);
  expect(scan.markers).toHaveLength(1);
  return scan.markers[0]!;
}

let clock = 1_000;
function apply(pair: TaskPairState | undefined, writer: string, line: string) {
  clock += 10;
  return applyTaskPairMarker(pair, marker(line), ctx(writer, clock));
}

/** DISPATCH -> STARTED -> READY (head1) -> PASS: a first-round PASSed pair. */
function passedPair(): TaskPairState {
  let pair = apply(undefined, BRAIN, `<!-- IMCODES_TASK DISPATCH T1 executor=${EXEC} auditor=${AUD} -->`).pair!;
  // The daemon-provisioned workspace (a git worktree with a recorded base).
  pair = { ...pair, status: 'working', workspace: { kind: 'worktree', path: '/ws/T1', base: 'base0000', lastHead: HEAD1, createdAt: 1, status: 'active' } };
  pair = apply(pair, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD1} base=base0000 -->`).pair!;
  expect(pair.status).toBe('in_audit');
  pair = apply(pair, AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->').pair!;
  expect(pair.status).toBe('passed');
  return pair;
}

describe('NEXT_ROUND: opening the next delivery round after PASS', () => {
  it('is a registered verb, documented in the contract with who opens it and when to split rounds', () => {
    expect(TASK_PAIR_VERBS).toContain(TASK_PAIR_NEXT_ROUND_VERB);
    const contract = buildTaskPairMarkerContract();
    expect(contract).toContain('NEXT_ROUND');
    expect(contract).toContain('Only Brain opens the next round');
    expect(contract).toContain('separately auditable, mergeable deliverable');
  });

  it('baseline: without NEXT_ROUND a READY/PASS after PASS is only recorded as unusual and the pair stays passed', () => {
    const passed = passedPair();
    const ready = apply(passed, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
    expect(ready).toMatchObject({ effect: 'recorded', unusual: true, fromStatus: 'passed', toStatus: 'passed' });
    expect(ready.pair).toBeUndefined();
    const pass = apply(passed, AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
    expect(pass).toMatchObject({ effect: 'recorded', unusual: true, toStatus: 'passed' });
  });

  it('passed -> NEXT_ROUND -> working -> READY -> PASS all take effect (none unusual), keeping workspace and participants', () => {
    const passed = passedPair();
    expect(taskPairDeliveryRound(passed)).toBe(1);
    const opened = apply(passed, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 note="console sync" -->');
    expect(opened).toMatchObject({ effect: 'next_round', unusual: false, fromStatus: 'passed', toStatus: 'working' });
    expect(opened.intents).toEqual([{ kind: 'next_round_notice', note: 'console sync' }]);
    const round2 = opened.pair!;
    expect(round2).toMatchObject({
      status: 'working', deliveryRound: 2, executor: EXEC, auditor: AUD,
      workspace: expect.objectContaining({ path: '/ws/T1', base: 'base0000' }),
      roundBase: expect.objectContaining({ commit: HEAD1, source: 'passed_head', deliveryRound: 2, previousHead: HEAD1, note: 'console sync' }),
    });
    // The previous round's verdict and material do not carry over.
    expect(round2.material).toBeUndefined();
    expect(round2.passRound).toBeUndefined();
    expect(round2.lastVerdict).toBeUndefined();

    // The executor's READY is a real audit round again: base defaults to the round base.
    const ready = apply(round2, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`);
    expect(ready).toMatchObject({ effect: 'status', unusual: false, fromStatus: 'working', toStatus: 'in_audit' });
    expect(ready.pair?.round).toBe(passed.round + 1);
    expect(ready.pair?.material).toMatchObject({ worktree: '/ws/T1', head: HEAD2, base: HEAD1 });
    expect(ready.intents).toEqual([{ kind: 'audit_request', to: AUD }]);

    // The auditor's PASS is a normal verdict now.
    const pass = apply(ready.pair, AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
    expect(pass).toMatchObject({ effect: 'verdict', unusual: false, toStatus: 'passed' });
    expect(pass.pair).toMatchObject({ status: 'passed', deliveryRound: 2, passRound: ready.pair!.round });
    // ...and the executor can close it.
    expect(apply(pass.pair, EXEC, '<!-- IMCODES_TASK DONE T1 -->').pair?.status).toBe('done');
  });

  it('REWORK inside the new round works as in any round, and the delivery round survives it', () => {
    const round2 = apply(passedPair(), BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->').pair!;
    const ready = apply(round2, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`).pair!;
    const rework = apply(ready, AUD, '<!-- IMCODES_TASK REWORK T1 blocking=P0 p0=1 -->');
    expect(rework.pair).toMatchObject({ status: 'rework', deliveryRound: 2 });
    const again = apply(rework.pair, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${'d'.repeat(40)} -->`);
    expect(again.pair).toMatchObject({ status: 'in_audit', deliveryRound: 2 });
    expect(again.pair?.material?.base).toBe(HEAD1);
  });

  it('Brain\'s NEXT_ROUND resolves a participant wait still set on the passed pair, but a rejected one clears nothing', () => {
    const waiting = { ...passedPair(), flags: ['blocked' as const], flagSides: { blocked: 'executor' as const }, blockedNote: 'need creds' };
    const opened = apply(waiting, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 note="go" -->').pair!;
    expect(opened.flags).not.toContain('blocked');
    expect(opened.flagSides.blocked).toBeUndefined();
    expect(opened.blockedNote).toBeUndefined();
    expect(opened.lastWaitResolution).toMatchObject({ writer: BRAIN, note: 'go' });
    const rejected = apply(waiting, EXEC, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
    expect(rejected.pair?.flags ?? waiting.flags).toContain('blocked');
    expect(rejected.pair?.flagSides.blocked ?? waiting.flagSides.blocked).toBe('executor');
  });

  it('a third round: each NEXT_ROUND advances the delivery round by one', () => {
    let pair = apply(passedPair(), BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->').pair!;
    pair = apply(pair, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`).pair!;
    pair = apply(pair, AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->').pair!;
    const round3 = apply(pair, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->').pair!;
    expect(round3).toMatchObject({ status: 'working', deliveryRound: 3 });
    expect(round3.roundBase).toMatchObject({ commit: HEAD2, source: 'passed_head', deliveryRound: 3 });
  });

  it('Brain may name the base (the dev tip that contains the merged previous round); it is kept next to the previous PASSed head', () => {
    const named = apply(passedPair(), BRAIN, `<!-- IMCODES_TASK NEXT_ROUND T1 base=${DEV_TIP} -->`).pair!;
    expect(named.roundBase).toMatchObject({ commit: DEV_TIP, source: 'brain', previousHead: HEAD1 });
    // READY material is checked against it: default fills, a different base is rejected, an abbreviation of it is fine.
    expect(apply(named, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} -->`).pair?.material?.base).toBe(DEV_TIP);
    const abbreviated = apply(named, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} base=${DEV_TIP.slice(0, 9)} -->`);
    expect(abbreviated.pair?.status).toBe('in_audit');
    const wrong = apply(named, EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/ws/T1 head=${HEAD2} base=${HEAD1} -->`);
    expect(wrong).toMatchObject({ effect: 'recorded', unusual: true, toStatus: 'working' });
    expect(wrong.pair?.status).toBe('working');
    expect(wrong.pair?.material).toBeUndefined();
    expect(wrong.pair?.round).toBe(named.round);
    expect(wrong.intents).toEqual([expect.objectContaining({ kind: 'policy_notice', to: EXEC, text: expect.stringContaining(DEV_TIP) })]);
  });

  it('rejects a base that is not a commit id, leaving the pair passed', () => {
    const result = apply(passedPair(), BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 base=origin/dev -->');
    expect(result).toMatchObject({ effect: 'recorded', unusual: true, toStatus: 'passed' });
    expect(result.pair?.status).toBe('passed');
    expect(result.pair?.deliveryRound).toBeUndefined();
    expect(result.intents).toEqual([expect.objectContaining({ kind: 'policy_notice', text: expect.stringContaining('commit id') })]);
  });

  it('counterexample: a DONE or CANCELLED pair cannot open another round', () => {
    for (const status of ['done', 'cancelled'] as const) {
      const closed = { ...passedPair(), status };
      const result = apply(closed, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
      expect(result).toMatchObject({ effect: 'recorded', unusual: true, toStatus: status });
      expect(result.pair?.status).toBe(status);
      expect(result.pair?.deliveryRound).toBeUndefined();
      expect(result.intents).toEqual([expect.objectContaining({ kind: 'policy_notice', text: expect.stringContaining('new taskId') })]);
    }
  });

  it('counterexample: only a passed pair can start the next round (a round still in progress cannot)', () => {
    const passed = passedPair();
    for (const status of ['working', 'in_audit', 'rework', 'awaiting_audit', 'queued'] as const) {
      const result = apply({ ...passed, status }, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
      expect(result).toMatchObject({ effect: 'recorded', unusual: true, toStatus: status });
      expect(result.pair?.status).toBe(status);
      expect(result.pair?.deliveryRound).toBeUndefined();
    }
  });

  it('counterexample: NEXT_ROUND written by the executor, the auditor or anyone else is rejected and changes nothing', () => {
    const passed = passedPair();
    for (const writer of [EXEC, AUD, OTHER]) {
      const result = apply(passed, writer, '<!-- IMCODES_TASK NEXT_ROUND T1 -->');
      expect(result, writer).toMatchObject({ effect: 'recorded', unusual: true, fromStatus: 'passed', toStatus: 'passed' });
      expect(result.pair?.status).toBe('passed');
      expect(result.pair?.deliveryRound).toBeUndefined();
      expect(result.pair?.roundBase).toBeUndefined();
      expect(result.intents).toEqual([expect.objectContaining({ kind: 'policy_notice', to: writer, text: expect.stringContaining('Only Brain') })]);
    }
  });

  it('the fallback (project-authoritative) Brain may open the round on a restored pair with an older Brain name', () => {
    const passed = { ...passedPair(), brain: 'deck_proj_old_brain' };
    expect(apply(passed, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->').pair?.status).toBe('working');
  });

  it('NEXT_ROUND on a task that does not exist is only recorded', () => {
    const result = apply(undefined, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND NOPE -->');
    expect(result).toMatchObject({ effect: 'recorded', pair: undefined });
  });

  it('a no-auditor pair (awaiting Brain decision) is not "passed": NEXT_ROUND is rejected there', () => {
    let pair = apply(undefined, BRAIN, `<!-- IMCODES_TASK DISPATCH T2 executor=${EXEC} auditor=none -->`).pair!;
    pair = apply({ ...pair, status: 'working' }, EXEC, '<!-- IMCODES_TASK DONE T2 -->').pair!;
    expect(pair.status).toBe('awaiting_brain_decision');
    const result = apply(pair, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T2 -->');
    expect(result).toMatchObject({ effect: 'recorded', unusual: true });
    expect(result.pair?.status).toBe('awaiting_brain_decision');
  });

  it('a task-directory pair with no head has no round base and READY is not constrained', () => {
    const passed = { ...passedPair(), material: { path: '/works/T1', at: 5 }, workspace: { kind: 'dir' as const, path: '/works/T1', createdAt: 1, status: 'active' as const } };
    const round2 = apply(passed, BRAIN, '<!-- IMCODES_TASK NEXT_ROUND T1 -->').pair!;
    expect(round2.deliveryRound).toBe(2);
    expect(round2.roundBase).toBeUndefined();
    expect(apply(round2, EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T1 path=/works/T1 -->').pair?.status).toBe('in_audit');
  });

  it('sameTaskPairCommit treats a >=7 hex prefix as the same commit and rejects different or too-short ids', () => {
    expect(sameTaskPairCommit(DEV_TIP, DEV_TIP.slice(0, 7))).toBe(true);
    expect(sameTaskPairCommit(DEV_TIP.slice(0, 12), DEV_TIP)).toBe(true);
    expect(sameTaskPairCommit(DEV_TIP, HEAD1)).toBe(false);
    expect(sameTaskPairCommit('bbb', DEV_TIP)).toBe(false);
  });
});
