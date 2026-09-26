import { describe, expect, it } from 'vitest';
import {
  TASK_PAIR_BRAIN_REPORTING_RULE,
  TASK_PAIR_MESSAGE_CAP_PER_ROUND,
  TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE,
  TASK_PAIR_STATUSES,
  TASK_PAIR_VERBS,
  applyTaskPairMarker,
  buildTaskPairMarkerContract,
  judgeTaskPairVerdict,
  matchesTaskPairBuiltinDefaultRouting,
  scanTaskPairMarkers,
  stripTaskPairMarkersForDisplay,
  taskPairSideToAct,
  TASK_PAIR_NO_AUDITOR,
  parseTaskPairBindingId,
  taskPairBindingId,
  taskPairBindingOf,
  type TaskPairApplyContext,
  type TaskPairMarker,
  type TaskPairState,
  type TaskPairStatus,
} from '../../shared/task-pair.js';

const BRAIN = 'deck_proj_brain';
const EXEC = 'deck_sub_exec';
const AUD = 'deck_sub_aud';

function ctx(writer: string, extra: Partial<TaskPairApplyContext> = {}): TaskPairApplyContext {
  return { writer, fallbackBrain: BRAIN, now: 1_000, source: 'marker', ...extra };
}

function marker(line: string): TaskPairMarker {
  const scan = scanTaskPairMarkers(line);
  expect(scan.markers).toHaveLength(1);
  return scan.markers[0]!;
}

function apply(pair: TaskPairState | undefined, writer: string, line: string) {
  return applyTaskPairMarker(pair, marker(line), ctx(writer));
}

/** Drive a sequence of (writer, line) markers from an empty state. */
function run(steps: Array<[string, string]>): { pair: TaskPairState; intents: unknown[][] } {
  let pair: TaskPairState | undefined;
  const intents: unknown[][] = [];
  for (const [writer, line] of steps) {
    const result = apply(pair, writer, line);
    intents.push(result.intents);
    if (result.pair) pair = result.pair;
  }
  return { pair: pair!, intents };
}

function dispatched(extra = ''): TaskPairState {
  return run([[BRAIN, `<!-- IMCODES_TASK DISPATCH T42 executor=${EXEC} auditor=${AUD}${extra} -->`]]).pair;
}

function withStatus(status: TaskPairStatus, extra = ''): TaskPairState {
  return { ...dispatched(extra), status, round: status === 'in_audit' || status === 'rework' ? 1 : 0 };
}

describe('task-pair marker grammar', () => {
  it('parses verbs case-insensitively with bare and quoted attributes', () => {
    const scanned = marker('<!-- IMCODES_TASK rework T42 blocking=P0 p0=1 p1=2 note="null check \\"missing\\" in login.ts" -->');
    expect(scanned).toMatchObject({
      knownVerb: 'REWORK', taskId: 'T42',
      attrs: { blocking: 'P0', p0: '1', p1: '2', note: 'null check "missing" in login.ts' },
    });
  });

  it('ignores markers inside fences, inline in prose, and indented code', () => {
    const text = [
      'Example:',
      '```',
      '<!-- IMCODES_TASK PASS T42 -->',
      '```',
      'Write <!-- IMCODES_TASK PASS T42 --> when done.',
      '    <!-- IMCODES_TASK PASS T42 -->',
    ].join('\n');
    expect(scanTaskPairMarkers(text).markers).toHaveLength(0);
  });

  it('applies several markers in order and keeps their positions', () => {
    const { markers } = scanTaskPairMarkers('<!-- IMCODES_TASK STARTED T42 -->\nwork\n<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->');
    expect(markers.map((entry) => [entry.knownVerb, entry.markerIndex])).toEqual([['STARTED', 0], ['READY_FOR_AUDIT', 1]]);
  });

  it('records unknown verbs without a known verb and rejects over-length values as text', () => {
    expect(marker('<!-- IMCODES_TASK FINISHED T42 -->').knownVerb).toBeUndefined();
    expect(scanTaskPairMarkers(`<!-- IMCODES_TASK DONE T42 note="${'x'.repeat(501)}" -->`).markers).toHaveLength(0);
  });

  it('captures a QUEUE brief verbatim, fences included, without applying markers inside it', () => {
    const brief = ['Implement export.', '```ts', 'const x = 1;', '```', '<!-- IMCODES_TASK DONE T99 -->'].join('\n');
    const text = `<!-- IMCODES_TASK QUEUE T43 title="Add export" -->\n${brief}\n<!-- IMCODES_TASK_END T43 -->\nafter`;
    const scan = scanTaskPairMarkers(text);
    expect(scan.markers).toHaveLength(1);
    expect(scan.markers[0]).toMatchObject({ knownVerb: 'QUEUE', taskId: 'T43', brief });
    expect(stripTaskPairMarkersForDisplay(text)).toBe(`${brief}\nafter`);
  });

  it('flags a QUEUE whose END is missing', () => {
    expect(marker('<!-- IMCODES_TASK QUEUE T43 -->')).toMatchObject({ briefMissing: true });
  });

  it('strips only active marker lines from display', () => {
    const text = 'Done.\n<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->\n`<!-- IMCODES_TASK PASS T42 -->`';
    expect(stripTaskPairMarkersForDisplay(text)).toBe('Done.\n`<!-- IMCODES_TASK PASS T42 -->`');
  });

  it('ships a contract that names the marker and severity grammar', () => {
    const body = buildTaskPairMarkerContract();
    expect(body).toContain('[Contract: task_pair_markers_v1]');
    expect(body).toContain('audit_convergence_v1');
    expect(body).toContain('IMCODES_TASK_END');
  });

  it('ships a contract stating a project\'s own workflow takes precedence, and that Brain hears only final/terminal states', () => {
    const body = buildTaskPairMarkerContract();
    expect(body).toContain('takes precedence over');
    expect(body).toContain(TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE);
    expect(body).toContain('Report to Brain only at the end');
    expect(body).toContain(TASK_PAIR_BRAIN_REPORTING_RULE);
  });
});

describe('task-pair severity judgement', () => {
  it.each([
    ['REWORK', { blocking: 'P0', p0: '1', p1: '2' }, 'consistent'],
    ['REWORK', { blocking: 'P0', p0: '0', p1: '3' }, 'inconsistent'],
    ['REWORK', {}, 'missing_severity'],
    ['PASS', { blocking: 'P0', p2: '1', p4: '2' }, 'consistent'],
    ['PASS', { blocking: 'P0', p0: '1' }, 'inconsistent'],
    ['PASS', {}, 'implicit_zero'],
  ] as const)('%s %o is %s under P0', (verb, attrs, expected) => {
    expect(judgeTaskPairVerdict(verb, attrs, ['P0']).judgement).toBe(expected);
  });

  it('judges by the pair set and tags a stated mismatch', () => {
    const result = judgeTaskPairVerdict('REWORK', { blocking: 'P0', p1: '1' }, ['P0', 'P1']);
    expect(result).toMatchObject({ judgement: 'consistent', blockingMismatch: true });
  });
});

describe('task-pair state machine', () => {
  it('has a defined, non-throwing effect for every verb from every status', () => {
    for (const status of TASK_PAIR_STATUSES) {
      for (const verb of TASK_PAIR_VERBS) {
        for (const writer of [BRAIN, EXEC, AUD, 'deck_sub_other']) {
          const result = applyTaskPairMarker(withStatus(status), { knownVerb: verb, taskId: 'T42', attrs: {} }, ctx(writer));
          expect(result.effect).toEqual(expect.any(String));
        }
      }
    }
  });

  it('runs the normal audit loop with severity-tagged verdicts and counts rounds', () => {
    const { pair } = run([
      [BRAIN, `<!-- IMCODES_TASK DISPATCH T42 executor=${EXEC} auditor=${AUD} -->`],
      [EXEC, '<!-- IMCODES_TASK STARTED T42 -->'],
      [EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->'],
      [AUD, '<!-- IMCODES_TASK REWORK T42 blocking=P0 p0=1 -->'],
      [EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->'],
      [AUD, '<!-- IMCODES_TASK PASS T42 blocking=P0 -->'],
      [EXEC, '<!-- IMCODES_TASK DONE T42 -->'],
    ]);
    expect(pair).toMatchObject({ status: 'done', round: 2, passRound: 2 });
    expect(pair.flags).not.toContain('unaudited');
  });

  it('never notices Brain during a normal round: a REWORK, its fix, and the PASS are all settled between executor and auditor', () => {
    const { intents } = run([
      [BRAIN, `<!-- IMCODES_TASK DISPATCH T42 executor=${EXEC} auditor=${AUD} -->`],
      [EXEC, '<!-- IMCODES_TASK STARTED T42 -->'],
      [EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->'],
      [AUD, '<!-- IMCODES_TASK REWORK T42 blocking=P0 p0=1 p1=2 -->'],
      [EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->'],
      [AUD, '<!-- IMCODES_TASK PASS T42 blocking=P0 -->'],
      [EXEC, '<!-- IMCODES_TASK DONE T42 -->'],
    ]);
    const brainNotices = intents.flat().filter((intent) => (intent as { kind: string }).kind === 'brain_notice');
    expect(brainNotices).toEqual([]);
    // The REWORK notice itself goes to the executor, never to Brain.
    expect(intents.flat()).toContainEqual(expect.objectContaining({ kind: 'rework_notice', to: EXEC }));
  });

  it('tells the executor on a consistent REWORK', () => {
    const result = apply(withStatus('in_audit'), AUD, '<!-- IMCODES_TASK REWORK T42 blocking=P0 p0=1 p1=2 -->');
    expect(result.pair?.status).toBe('rework');
    expect(result.intents).toContainEqual(expect.objectContaining({ kind: 'rework_notice', to: EXEC }));
  });

  it('holds an inconsistent or severity-less REWORK and a PASS carrying a blocking finding', () => {
    for (const line of [
      '<!-- IMCODES_TASK REWORK T42 blocking=P0 p0=0 p1=3 -->',
      '<!-- IMCODES_TASK REWORK T42 -->',
      '<!-- IMCODES_TASK PASS T42 blocking=P0 p0=1 -->',
    ]) {
      const result = apply(withStatus('in_audit'), AUD, line);
      expect(result.pair?.status).toBe('in_audit');
      expect(result.intents).toContainEqual(expect.objectContaining({ kind: 'correction', to: AUD }));
    }
  });

  it('accepts a PASS with follow-ups only and a custom blocking set', () => {
    expect(apply(withStatus('in_audit'), AUD, '<!-- IMCODES_TASK PASS T42 blocking=P0 p2=1 p4=2 -->').pair?.status).toBe('passed');
    const custom = withStatus('in_audit', ' blocking=P0,P1');
    expect(custom.blocking).toEqual(['P0', 'P1']);
    expect(apply(custom, AUD, '<!-- IMCODES_TASK REWORK T42 blocking=P0,P1 p1=1 -->').pair?.status).toBe('rework');
  });

  it('bounds the correction loop at the per-round cap and then tells Brain once', () => {
    let pair = withStatus('in_audit');
    const corrections: unknown[] = [];
    const notices: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = apply(pair, AUD, '<!-- IMCODES_TASK REWORK T42 blocking=P0 p0=0 p1=3 -->');
      pair = result.pair!;
      corrections.push(...result.intents.filter((intent) => intent.kind === 'correction'));
      notices.push(...result.intents.filter((intent) => intent.kind === 'brain_notice'));
    }
    expect(corrections).toHaveLength(TASK_PAIR_MESSAGE_CAP_PER_ROUND);
    expect(notices).toEqual([{ kind: 'brain_notice', flag: 'verdict_inconsistent' }]);
    expect(pair.flags).toContain('verdict_inconsistent');
    // A new round clears the cap.
    pair = apply({ ...pair, status: 'rework' }, EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->').pair!;
    expect(pair.flags).not.toContain('verdict_inconsistent');
  });

  it('treats DONE without PASS as awaiting_audit with a capped reminder', () => {
    let pair = withStatus('working');
    const reminders: unknown[] = [];
    const notices: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = apply(pair, EXEC, '<!-- IMCODES_TASK DONE T42 -->');
      pair = result.pair!;
      reminders.push(...result.intents.filter((intent) => intent.kind === 'done_reminder'));
      notices.push(...result.intents.filter((intent) => intent.kind === 'brain_notice'));
    }
    expect(pair.status).toBe('awaiting_audit');
    expect(reminders).toHaveLength(TASK_PAIR_MESSAGE_CAP_PER_ROUND);
    expect(notices).toEqual([{ kind: 'brain_notice', flag: 'awaiting_audit_ignored' }]);
    expect(taskPairSideToAct(pair)).toBe('executor');
  });

  it('keeps DONE from in_audit waiting for the verdict', () => {
    expect(apply(withStatus('in_audit'), EXEC, '<!-- IMCODES_TASK DONE T42 -->')).toMatchObject({ effect: 'recorded' });
  });

  it('lets Brain force completion, flagged unaudited', () => {
    const result = apply(withStatus('rework'), BRAIN, '<!-- IMCODES_TASK DONE T42 force=true -->');
    expect(result.pair).toMatchObject({ status: 'done', flags: expect.arrayContaining(['unaudited']) });
    // force from anyone else is an ordinary DONE
    expect(apply(withStatus('rework'), EXEC, '<!-- IMCODES_TASK DONE T42 force=true -->').pair?.status).toBe('awaiting_audit');
  });

  it('completes auditor=none tasks on DONE and ignores audit markers for them', () => {
    const none = run([[BRAIN, `<!-- IMCODES_TASK DISPATCH T42 executor=${EXEC} auditor=none -->`]]).pair;
    expect(apply(none, EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->')).toMatchObject({ effect: 'recorded' });
    expect(apply(none, AUD, '<!-- IMCODES_TASK PASS T42 -->')).toMatchObject({ effect: 'recorded' });
    const finished = apply(none, EXEC, '<!-- IMCODES_TASK DONE T42 -->').pair!;
    expect(finished.status).toBe('done');
    expect(finished.flags).not.toContain('unaudited');
  });

  it('returns an in_audit pair to working on REASSIGN auditor=none', () => {
    expect(apply(withStatus('in_audit'), BRAIN, '<!-- IMCODES_TASK REASSIGN T42 auditor=none -->').pair?.status).toBe('working');
  });

  it('changes roles only through the pair Brain', () => {
    expect(apply(withStatus('in_audit'), AUD, '<!-- IMCODES_TASK DISPATCH T42 executor=deck_sub_b -->')).toMatchObject({ effect: 'recorded', unusual: true, pair: undefined });
    expect(apply(withStatus('in_audit'), EXEC, '<!-- IMCODES_TASK REASSIGN T42 auditor=deck_sub_c -->').pair).toBeUndefined();
    const reassigned = apply(withStatus('in_audit'), BRAIN, '<!-- IMCODES_TASK REASSIGN T42 auditor=deck_sub_c -->').pair!;
    expect(reassigned).toMatchObject({ auditor: 'deck_sub_c', previousAuditors: [AUD] });
  });

  it('applies a non-participant status marker as unusual without changing roles', () => {
    const result = apply(withStatus('working'), 'deck_sub_other', '<!-- IMCODES_TASK WORKING T42 -->');
    expect(result).toMatchObject({ unusual: true });
    expect(result.pair).toMatchObject({ executor: EXEC, auditor: AUD });
  });

  it('reopens a finished pair on REWORK and records PASS/DONE on terminal pairs', () => {
    expect(apply(withStatus('done'), AUD, '<!-- IMCODES_TASK REWORK T42 blocking=P0 p0=1 -->').pair).toMatchObject({ status: 'rework' });
    expect(apply(withStatus('done'), EXEC, '<!-- IMCODES_TASK DONE T42 -->')).toMatchObject({ effect: 'recorded' });
  });

  it('never lets a participant revive a cancelled pair; only the Brain or daemon can', () => {
    const cancelled = withStatus('cancelled');
    for (const [writer, line] of [
      [EXEC, '<!-- IMCODES_TASK STARTED T42 -->'],
      [EXEC, '<!-- IMCODES_TASK WORKING T42 -->'],
      [EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T42 -->'],
      [AUD, '<!-- IMCODES_TASK REWORK T42 blocking=P0 p0=1 -->'],
    ] as const) {
      const result = apply(cancelled, writer, line);
      expect(result.pair?.status ?? cancelled.status, `${writer} ${line}`).toBe('cancelled');
      expect(result.effect).toBe('recorded');
    }
    // The Brain (and the daemon, its equivalent) can still revive it explicitly.
    expect(apply(cancelled, BRAIN, `<!-- IMCODES_TASK DISPATCH T42 executor=${EXEC} auditor=${AUD} -->`).pair?.status).toBe('working');
    expect(apply(cancelled, BRAIN, '<!-- IMCODES_TASK QUEUE T42 title="retry" -->').pair?.status).toBe('queued');
  });

  it('sets and clears side flags on progress', () => {
    const blocked = apply(withStatus('working'), EXEC, '<!-- IMCODES_TASK BLOCKED T42 note="need DB creds" -->').pair!;
    expect(blocked.flags).toContain('blocked');
    const resumed = apply(blocked, EXEC, '<!-- IMCODES_TASK WORKING T42 -->').pair!;
    expect(resumed.flags).not.toContain('blocked');
    expect(resumed.status).toBe('working');
  });

  it('asks for an auditor replacement when the executor is blocked on the auditor, capped per round', () => {
    let pair = withStatus('in_audit');
    const replacements: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = apply(pair, EXEC, '<!-- IMCODES_TASK BLOCKED T42 note="auditor silent" -->');
      pair = result.pair!;
      replacements.push(...result.intents.filter((intent) => intent.kind === 'replace_auditor'));
    }
    expect(replacements).toHaveLength(TASK_PAIR_MESSAGE_CAP_PER_ROUND);
    expect(pair.flags).toContain('replacement_churn');
  });

  it('asks the daemon to pick an auditor when a dispatch names none', () => {
    const result = apply(undefined, BRAIN, `<!-- IMCODES_TASK DISPATCH T50 executor=${EXEC} -->`);
    expect(result.pair?.flags).toContain('needs_auditor');
    expect(result.intents).toContainEqual({ kind: 'pick_auditor' });
  });

  it('owner rule: keeps an explicit executormodel=/auditormodel= on the pair and still asks the daemon to pick by it', () => {
    const result = apply(undefined, BRAIN, '<!-- IMCODES_TASK DISPATCH T52 executormodel=gpt-6-luna auditormodel=claude-sonnet-5 -->');
    expect(result.pair).toMatchObject({ executorModel: 'gpt-6-luna', auditorModel: 'claude-sonnet-5' });
    expect(result.pair?.executor).toBeUndefined();
    expect(result.pair?.auditor).toBeUndefined();
    expect(result.intents).toContainEqual({ kind: 'pick_executor' });
    expect(result.intents).toContainEqual({ kind: 'pick_auditor' });
  });

  it('owner rule: an explicit executor=/auditor= session still wins over an unrelated model attr and needs no pick', () => {
    const result = apply(undefined, BRAIN, `<!-- IMCODES_TASK DISPATCH T53 executor=${EXEC} auditor=${AUD} auditormodel=claude-sonnet-5 -->`);
    expect(result.pair).toMatchObject({ executor: EXEC, auditor: AUD, auditorModel: 'claude-sonnet-5' });
    expect(result.intents).not.toContainEqual({ kind: 'pick_auditor' });
  });

  it('owner rule: REASSIGN with only auditormodel= re-triggers the pick for a pair that still has no auditor', () => {
    const noAuditor = apply(undefined, BRAIN, `<!-- IMCODES_TASK DISPATCH T54 executor=${EXEC} -->`).pair!;
    const result = apply(noAuditor, BRAIN, '<!-- IMCODES_TASK REASSIGN T54 auditormodel=claude-sonnet-5 -->');
    expect(result.pair).toMatchObject({ auditorModel: 'claude-sonnet-5' });
    expect(result.intents).toContainEqual({ kind: 'pick_auditor' });
  });

  it('owner rule: REASSIGN with only auditormodel= on a pair that already has an auditor records the model but does not replace the current auditor', () => {
    const withAuditor = apply(undefined, BRAIN, `<!-- IMCODES_TASK DISPATCH T55 executor=${EXEC} auditor=${AUD} -->`).pair!;
    const result = apply(withAuditor, BRAIN, '<!-- IMCODES_TASK REASSIGN T55 auditormodel=claude-sonnet-5 -->');
    expect(result.pair).toMatchObject({ auditor: AUD, auditorModel: 'claude-sonnet-5' });
    expect(result.intents).not.toContainEqual({ kind: 'pick_auditor' });
  });

  it('gives an executor-created pair the fallback Brain', () => {
    const result = apply(undefined, EXEC, '<!-- IMCODES_TASK STARTED T51 auditor=deck_sub_aud -->');
    expect(result.pair).toMatchObject({ brain: BRAIN, executor: EXEC, status: 'working' });
  });

  it('keeps a queued pair without an executor queued when someone else reports progress', () => {
    const queued = run([[BRAIN, '<!-- IMCODES_TASK QUEUE T43 title="Export" -->']]).pair;
    for (const verb of ['STARTED', 'WORKING', 'READY_FOR_AUDIT', 'DONE']) {
      expect(apply(queued, 'deck_sub_x', `<!-- IMCODES_TASK ${verb} T43 -->`)).toMatchObject({ effect: 'recorded', pair: undefined });
    }
  });

  it('never creates or changes a pair for an unresolved task id', () => {
    expect(apply(undefined, EXEC, '<!-- IMCODES_TASK STARTED - -->')).toMatchObject({ effect: 'unresolved', pair: undefined });
    expect(apply(withStatus('working'), EXEC, '<!-- IMCODES_TASK DONE - -->').pair).toBeUndefined();
  });

  it('stores a queued brief and treats QUEUE - max= as queue settings', () => {
    const scan = scanTaskPairMarkers('<!-- IMCODES_TASK QUEUE T43 title="Export" -->\nbrief body\n<!-- IMCODES_TASK_END T43 -->');
    const queued = applyTaskPairMarker(undefined, scan.markers[0]!, ctx(BRAIN)).pair!;
    expect(queued).toMatchObject({ status: 'queued', brief: 'brief body', title: 'Export', brain: BRAIN });
    expect(apply(undefined, BRAIN, '<!-- IMCODES_TASK QUEUE - max=8 -->').intents)
      .toEqual([{ kind: 'queue_settings', brain: BRAIN, maxConcurrency: 8 }]);
  });
});

describe('task-pair built-in default routing', () => {
  it('defaults to Codex gpt-6-luna executors and Claude Opus auditors when no pool is configured', () => {
    expect(matchesTaskPairBuiltinDefaultRouting('executor', 'codex-sdk', 'gpt-6-luna')).toBe(true);
    expect(matchesTaskPairBuiltinDefaultRouting('auditor', 'claude-code-sdk', 'claude-opus-5-5')).toBe(true);
    expect(matchesTaskPairBuiltinDefaultRouting('executor', 'claude-code-sdk', 'claude-opus-5-5')).toBe(false);
    expect(matchesTaskPairBuiltinDefaultRouting('auditor', 'claude-code-sdk', 'claude-sonnet-5')).toBe(false);
    expect(matchesTaskPairBuiltinDefaultRouting('auditor', 'codex-sdk', 'gpt-6-luna')).toBe(false);
  });
});

describe('pair binding ids', () => {
  it('formats and parses the documented pair:<taskId>:<role> shape', () => {
    expect(taskPairBindingId('tsk_0a1b2c3d4e', 'executor')).toBe('pair:tsk_0a1b2c3d4e:executor');
    expect(parseTaskPairBindingId('pair:tsk_0a1b2c3d4e:auditor')).toEqual({ taskId: 'tsk_0a1b2c3d4e', role: 'auditor' });
    // A task id may itself contain ':'; the role is always the last segment.
    expect(parseTaskPairBindingId(taskPairBindingId('a:b', 'executor'))).toEqual({ taskId: 'a:b', role: 'executor' });
  });

  it('rejects legacy assignment ids and malformed bindings', () => {
    for (const value of ['asg_5gl', 'pair:', 'pair:executor', 'pair::executor', 'pair:T1:brain', 'pair:T1', undefined, 7]) {
      expect(parseTaskPairBindingId(value)).toBeUndefined();
    }
  });

  it('binds only the executor and a real auditor of the pair', () => {
    const pair = { taskId: 'T1', executor: 'exec', auditor: 'aud' } as never;
    expect(taskPairBindingOf(pair, 'exec')).toBe('pair:T1:executor');
    expect(taskPairBindingOf(pair, 'aud')).toBe('pair:T1:auditor');
    expect(taskPairBindingOf(pair, 'brain')).toBeUndefined();
    expect(taskPairBindingOf({ taskId: 'T1', executor: 'exec', auditor: TASK_PAIR_NO_AUDITOR } as never, TASK_PAIR_NO_AUDITOR)).toBeUndefined();
    expect(taskPairBindingOf(undefined, 'exec')).toBeUndefined();
  });
});
