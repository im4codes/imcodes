import { describe, expect, it } from 'vitest';
import { applyTaskPairMarker, scanTaskPairMarkers, type TaskPairState } from '../../../shared/task-pair.js';
import { buildAuditorProposalNudgeMessage, buildBrainLineDigestMessage, buildDoneReminderMessage, buildLegacyImportCorrectionMessage, buildExecutorPairBrief, buildExecutorResendMessage, buildDispatchTrailer, buildAuditorAssignmentMessage, buildAuditRequestMessage, buildBriefEndHint, buildExecutorHandoffMessage, buildIntegrationDriftDigest, buildNoBriefLine, buildNudgeMessage, buildPassDoneNoticeMessage, buildUntitledTaskTitleRequest } from '../../../src/daemon/task-pairs/messages.js';

function basePair(overrides: Partial<TaskPairState> = {}): TaskPairState {
  return {
    taskId: 'tsk_x', brain: 'deck_proj_brain', executor: 'deck_sub_exec', auditor: 'deck_sub_aud',
    status: 'in_audit', flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [],
    capCounts: {}, capRound: 1, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

/**
 * Regression (tsk_cd_pair_import_briefless r1 audit): a backtick-wrapped
 * marker example silently fails `MARKER_LINE_RE`/`briefEndLineRe`
 * (shared/task-pair.ts), which only accept a bare `<!-- ... -->` line. Every
 * agent-facing instruction and Brain notice is built from `marker()` /
 * `buildBriefEndHint()`; if an agent copies the shown example verbatim onto
 * its own line, it must actually parse, or the pair hangs.
 */
describe('daemon-authored marker examples parse when copied verbatim onto their own line', () => {
  it('describes title reminders as non-terminal metadata updates', () => {
    const text = buildUntitledTaskTitleRequest(['tsk_x'], 'en');
    expect(text).toContain('pair_task_update({taskId,title})');
    expect(text).toContain('title-only');
    expect(text).toContain('never reopens');
    expect(text).toContain('cancelled/done');
  });
  it('includes the auditor proposal rule in assignment and audit-request briefs', () => {
    const pair = basePair({ material: { path: '/workspace', at: 1 } });
    expect(buildAuditorAssignmentMessage(pair)).toMatch(/concrete solution/);
    expect(buildAuditRequestMessage(pair, { path: '/workspace', source: 'executor' })).toMatch(/concrete solution/);
  });

  it('gives a reassigned executor the authoritative absolute workspace, base, and latest head', () => {
    const text = buildExecutorHandoffMessage({
      ...basePair({
        status: 'working',
        workspace: {
          kind: 'worktree', path: '/Users/k/.imcodes/worktrees/pair_tsk_x/repo',
          base: 'base-sha', lastHead: 'head-sha', status: 'active', createdAt: 1,
        },
      }),
      material: { worktree: '/Users/k/.imcodes/worktrees/pair_tsk_x/repo', base: 'base-sha', head: 'head-sha', at: 2 },
    }, 'deck_sub_old_exec', 'provider limit');
    expect(text).toContain('/Users/k/.imcodes/worktrees/pair_tsk_x/repo');
    expect(text).toContain('base base-sha');
    expect(text).toContain('latest head head-sha');
    expect(text).toContain('never use cwd or the project main checkout');
  });
  it('buildNoBriefLine teaches Brain the MCP tools, not a QUEUE marker (a legacy QUEUE marker still parses)', () => {
    const text = buildNoBriefLine('tsk_x');
    expect(text).toContain('pair_task_update');
    expect(text).toContain('pair_dispatch');
    expect(text).toContain('pair_create');
    expect(text).not.toMatch(/<!--\s*IMCODES_TASK/);
    // Compatibility: the daemon still accepts the old marker from an existing Brain.
    const { markers } = scanTaskPairMarkers('<!-- IMCODES_TASK QUEUE tsk_x title="x" -->');
    expect(markers[0]).toMatchObject({ knownVerb: 'QUEUE', taskId: 'tsk_x' });
  });

  it('a copied END hint closes a QUEUE brief', () => {
    const queueLine = '<!-- IMCODES_TASK QUEUE tsk_x title="x" -->';
    const endLine = buildBriefEndHint('tsk_x');
    const text = `${queueLine}\nthe brief text\n${endLine}`;
    const { markers } = scanTaskPairMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ knownVerb: 'QUEUE', taskId: 'tsk_x', brief: 'the brief text' });
    expect(markers[0]!.briefMissing).toBeUndefined();
  });

  it('a PASS marker extracted from the auditor nudge parses to the right verb and taskId', () => {
    const text = buildNudgeMessage(basePair(), 'auditor');
    const markerLine = text.match(/<!-- IMCODES_TASK PASS.*?-->/)?.[0];
    expect(markerLine).toBeTruthy();
    const { markers } = scanTaskPairMarkers(markerLine!);
    expect(markers[0]).toMatchObject({ knownVerb: 'PASS', taskId: 'tsk_x', attrs: { blocking: 'P0' } });
  });

  it('never wraps a marker or brief-end example in backticks', () => {
    for (const text of [
      buildNoBriefLine('tsk_x'),
      buildNudgeMessage(basePair(), 'auditor'),
      buildNudgeMessage(basePair({ status: 'awaiting_audit' }), 'executor'),
      buildBriefEndHint('tsk_x'),
    ]) {
      expect(text).not.toContain('`');
    }
  });

  it('includes task titles in integration drift digests when provided', () => {
    const digest = buildIntegrationDriftDigest(
      [
        {
          taskId: 'tsk_with_title',
          title: 'Fix login retry',
          head: 'abc1234567',
          worktree: '/w/pair_tsk_with_title/repo',
          elapsedMs: 120_000,
          status: 'passed',
        },
        {
          taskId: 'tsk_untitled',
          head: 'def7654321',
          worktree: '/w/pair_tsk_untitled/repo',
          elapsedMs: 120_000,
          status: 'done',
        },
      ],
      'en',
    );
    expect(digest).toContain('- tsk_with_title "Fix login retry": head abc1234');
    expect(digest).toContain('- tsk_untitled: head def7654');
    expect(digest).toContain('proportionate Final-HEAD Pre-Push Gate on the exact combined HEAD being pushed without reusing older-worktree runs');
    expect(digest).toContain('judging combined blast radius and coupling for batched or substantial/high-risk merges without a magic n');
  });

  it('requires the Final-HEAD Pre-Push Gate in Brain PASS/DONE merge notices for worktree pairs', () => {
    const notice = buildPassDoneNoticeMessage(basePair({
      status: 'passed',
      workspaceKind: 'worktree',
      workspace: { kind: 'worktree', path: '/w/pair_tsk_x/repo', status: 'active', base: 'base-sha', lastHead: 'head-sha', createdAt: 1 },
    }));
    expect(notice).toContain('proportionate Final-HEAD Pre-Push Gate on the exact combined HEAD being pushed');
    expect(notice).toContain('never reusing an older worktree run for other merged commits');
    expect(notice).toContain('judging combined blast radius and coupling for batched or substantial/high-risk merges without a magic n');

    const noWorktreeNotice = buildPassDoneNoticeMessage(basePair({
      status: 'passed',
      workspaceKind: 'none',
      material: { report: 'validation', at: 1 },
    }));
    expect(noWorktreeNotice).toContain('nothing to merge');
    expect(noWorktreeNotice).not.toContain('Final-HEAD Pre-Push Gate');
  });

  it('formats same-reason Brain line digests with each pair header and actual notice text', () => {
    const digest = buildBrainLineDigestMessage('decision-pending', [
      {
        pair: basePair({ taskId: 'tsk_a', title: 'Alpha fix' }),
        text: 'Pair tsk_a has an unanswered request for round 1.',
      },
      {
        pair: basePair({ taskId: 'tsk_b', title: undefined }),
        text: 'Pair tsk_b has been in in_audit for over five minutes without a durable Brain decision for round 1.',
      },
    ]);
    expect(digest).toContain('[IM.codes task pairs] 2 pairs reported decision-pending:');
    expect(digest).toContain('- [IM.codes task tsk_a "Alpha fix"] Pair tsk_a has an unanswered request for round 1.');
    expect(digest).toContain('- [IM.codes task tsk_b] Pair tsk_b has been in in_audit for over five minutes without a durable Brain decision for round 1.');
    expect(digest).toContain('[Contract: task_pair_markers_v1]');
    expect(digest).not.toContain('queued without a brief');
  });
});


describe('pair prompt consistency regressions', () => {
  it('keeps an applied REWORK closed while requesting missing proposals from the executor', () => {
    const pair = basePair({ material: { path: '/workspace', at: 1 } });
    const verdict = scanTaskPairMarkers('<!-- IMCODES_TASK REWORK tsk_x blocking=P0 p0=1 -->').markers[0]!;
    const applied = applyTaskPairMarker(pair, verdict, {
      writer: pair.auditor!, fallbackBrain: pair.brain, now: 2, source: 'marker', turnText: '[P0] Broken invariant.',
    });
    expect(applied.pair?.status).toBe('rework');
    expect(applied.intents.some((intent) => intent.kind === 'auditor_proposal_nudge')).toBe(true);
    const text = buildAuditorProposalNudgeMessage(applied.pair!);
    expect(text).toContain('ALREADY been applied (status: rework)');
    expect(text).toContain('directly to deck_sub_exec');
    expect(text).toContain('Do not resend PASS or REWORK');
    expect(text).toContain('commits fixes and emits a new READY_FOR_AUDIT');
    expect(text).toContain('this reminder is capped to once for round 1.');
    expect(text).not.toContain('resend the verdict');
    expect(text).not.toContain('`');
    expect(applyTaskPairMarker(applied.pair, verdict, {
      writer: pair.auditor!, fallbackBrain: pair.brain, now: 3, source: 'marker',
    }).unusual).toBe(true);
  });

  it('degrades the proposal nudge gracefully when the executor is not assigned', () => {
    const text = buildAuditorProposalNudgeMessage(basePair({ executor: undefined, status: 'rework' }));
    expect(text).toContain('directly to the executor');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('`');
  });

  it('names the MCP namespace and argument shape in every participant delivery path', () => {
    const pair = basePair();
    const reportPair = basePair({ workspaceKind: 'none', material: { report: 'validation', at: 1 } });
    const texts = [
      buildAuditorProposalNudgeMessage(pair), buildDoneReminderMessage(pair),
      buildLegacyImportCorrectionMessage(pair), buildExecutorPairBrief(pair),
      buildExecutorPairBrief(reportPair), buildDispatchTrailer(pair),
      buildExecutorResendMessage(pair, 'deck_previous_auditor'),
      ...(['working', 'rework', 'in_audit'] as const).map((status) => buildExecutorHandoffMessage({ ...pair, status }, 'deck_previous_executor', 'handoff')),
      buildAuditorAssignmentMessage(pair), buildAuditorAssignmentMessage(reportPair),
      buildAuditRequestMessage(pair, { path: '/workspace', source: 'executor' }),
      buildAuditRequestMessage(reportPair, { report: 'validation', source: 'executor' }),
    ];
    for (const text of texts) {
      expect(text).toContain('IM.codes imcodes-memory MCP send_im_message');
      expect(text).toContain('{target: "<deck_* sessionName>", message: "..."}');
      expect(text).toContain('provider built-in subagent send_message ({Recipient, Message})');
      expect(text).toContain('stale delegation_reply from an earlier daemon epoch');
      expect(text).not.toContain('`');
    }
  });

  it.each(['worktree', 'dir'] as const)('gives per-call shell and absolute file guidance for a %s workspace', (kind) => {
    const path = '/workspace with spaces/pair_tsk_x';
    const pair = basePair({ workspace: { kind, path, status: 'active', base: 'base-sha', createdAt: 1 } });
    for (const text of [buildExecutorPairBrief(pair), buildExecutorHandoffMessage(pair, undefined, 'handoff'), buildDispatchTrailer(pair)]) {
      expect(text).toContain(`cd "${path}" &&`);
      expect(text).toContain(`git -C "${path}"`);
      expect(text).toContain(`file tools must use absolute paths under ${path}`);
      expect(text).toContain('resets to the main checkout');
    }
  });
});
