import { describe, expect, it } from 'vitest';
import {
  TASK_PAIR_MESSAGE_CAP_PER_ROUND,
  TASK_PAIR_STATUSES,
  TASK_PAIR_VERBS,
  applyTaskPairMarker,
  buildTaskPairMarkerContract,
  judgeTaskPairVerdict,
  matchesTaskPairAllowlist,
  normalizeTaskPairAllowlist,
  scanTaskPairMarkers,
  stripTaskPairMarkersForDisplay,
  taskPairSideToAct,
  TASK_PAIR_DEFAULT_ALLOWLIST,
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

describe('task-pair allowlist', () => {
  it('matches Claude Code SDK Opus/Sonnet by default and skips others', () => {
    const allowlist = normalizeTaskPairAllowlist(undefined);
    expect(allowlist).toEqual(TASK_PAIR_DEFAULT_ALLOWLIST);
    expect(matchesTaskPairAllowlist(allowlist, 'auditor', 'claude-code-sdk', 'claude-sonnet-5')).toBe(true);
    expect(matchesTaskPairAllowlist(allowlist, 'auditor', 'claude-code-sdk', 'claude-haiku-4-5')).toBe(false);
    expect(matchesTaskPairAllowlist(allowlist, 'executor', 'codex-sdk', 'gpt-5.5')).toBe(false);
  });

  it('honours a configured entry and role', () => {
    const allowlist = normalizeTaskPairAllowlist([{ role: 'auditor', agentType: 'codex-sdk', modelPattern: 'gpt-5' }]);
    expect(matchesTaskPairAllowlist(allowlist, 'auditor', 'codex-sdk', 'gpt-5.5')).toBe(true);
    expect(matchesTaskPairAllowlist(allowlist, 'executor', 'codex-sdk', 'gpt-5.5')).toBe(false);
  });
});
