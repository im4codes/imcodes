import { describe, expect, it } from 'vitest';
import { TASK_PAIR_NOTICE_VERB, type TaskPairState } from '../../shared/task-pair.js';
import { buildDoneReminderMessage, buildExecutorPairBrief, buildNextRoundNoticeMessage, buildPassDoneNoticeMessage, buildReworkNoticeMessage } from '../../src/daemon/task-pairs/messages.js';
import { normalizeTaskPairAuditDetails, parseTaskPairAuditDetails, parseTaskPairNotification } from '../../shared/task-pair-notification.js';

describe('task-pair notification thinking metadata', () => {
  it('extracts labelled auditor findings without reducing them to severity counts', () => {
    const parsed = parseTaskPairNotification(
      '[IM.codes task tsk_findings "Audit details"]\n'
        + 'Audited pair REWORK status=rework verdict=consistent p0=1\n'
        + '[P0] stale ownership is accepted after restart\n'
        + 'Invariant: an old owner must not be treated as live\n'
        + 'Location: src/daemon/session-resource-registry.ts:532\n'
        + 'Evidence: restart reproduced session_resource_owner_conflict on 211\n'
        + 'Proposal: include the tmux server lifetime in the handle\n'
        + 'Trade-offs: preserve rejection of a truly live foreign pane\n'
        + 'Validation: focused causal test fails on base and passes on head',
    );
    expect(parsed?.payload.auditDetails).toMatchObject({
      findings: [{ severity: 'P0', summary: 'stale ownership is accepted after restart', invariant: 'an old owner must not be treated as live', location: 'src/daemon/session-resource-registry.ts:532', evidence: expect.stringContaining('211'), proposal: expect.stringContaining('server lifetime'), tradeoffs: expect.stringContaining('foreign pane') }],
      validation: expect.stringContaining('fails on base'),
    });
  });

  it('normalizes structured and legacy aliases, while leaving missing details absent', () => {
    expect(normalizeTaskPairAuditDetails({ auditFindings: [{ severity: 'P1', evidence: 'repro' }], validationSummary: '2 tests passed' })).toEqual({ findings: [{ severity: 'P1', evidence: 'repro' }], validation: '2 tests passed' });
    expect(normalizeTaskPairAuditDetails({ auditDetails: { validationSummary: 'replayed validation' }, blockedNote: 'waiting for the exact head' })).toEqual({ validation: 'replayed validation', reason: 'waiting for the exact head' });
    expect(parseTaskPairAuditDetails('Audited pair PASS status=passed p0=0')).toBeUndefined();
  });

  it('accepts common violation, file/function, why, and markdown-bold labels', () => {
    expect(parseTaskPairAuditDetails(
      '[P1] stale audit projection\n'
      + '**Violation of invariant:** replay must retain the latest finding\n'
      + 'File/function: web/src/components/TaskPairEventChip.tsx:100\n'
      + 'Evidence / reproduction: reload history\n'
      + 'Suggested solution: keep the structured projection\n'
      + 'Why: the old payload only carried counts',
    )).toMatchObject({
      findings: [{ invariant: 'replay must retain the latest finding', location: 'web/src/components/TaskPairEventChip.tsx:100', evidence: 'reload history', proposal: 'keep the structured projection' }],
      reason: 'the old payload only carried counts',
    });
  });

  it('keeps thinking levels from marker attributes when the assistant body has no prose fields', () => {
    const parsed = parseTaskPairNotification(
      '[IM.codes task tsk_attrs "Thinking attrs"]\n'
        + '<!-- IMCODES_TASK DISPATCH tsk_attrs executor=deck_exec auditor=deck_aud executorthinking=high auditorthinking=medium -->',
    );
    expect(parsed?.payload).toMatchObject({
      executor: 'deck_exec',
      auditor: 'deck_aud',
      executorThinking: 'high',
      auditorThinking: 'medium',
    });
  });

  it('leaves missing thinking unset for old notices instead of inventing a level', () => {
    const parsed = parseTaskPairNotification(
      '[IM.codes task tsk_legacy "Legacy"]\n'
        + '<!-- IMCODES_TASK DISPATCH tsk_legacy executor=deck_exec auditor=deck_aud -->',
    );
    expect(parsed?.payload).not.toHaveProperty('executorThinking');
    expect(parsed?.payload).not.toHaveProperty('auditorThinking');
  });

  it('projects cancellation provenance for daemon notices and keeps missing reasons explicit', () => {
    const parsed = parseTaskPairNotification(
      '[IM.codes task tsk_cancel "Handoff context"] status=cancelled CANCEL reason="user stopped after review" executor=deck_exec auditor=deck_aud',
    );
    expect(parsed?.payload).toMatchObject({
      verb: 'CANCEL', toStatus: 'cancelled', cancelActor: 'daemon', cancelSource: 'daemon',
      cancelReason: 'user stopped after review', executor: 'deck_exec', auditor: 'deck_aud',
    });
    const old = parseTaskPairNotification('[IM.codes task tsk_old] CANCEL status=cancelled');
    expect(old?.payload).toMatchObject({ verb: 'CANCEL', toStatus: 'cancelled', cancelActor: 'daemon', cancelSource: 'daemon' });
    expect(old?.payload).not.toHaveProperty('cancelReason');
  });
});

describe('task-pair text notices never guess a lifecycle status from body words', () => {
  function pairOf(extra: Partial<TaskPairState>): TaskPairState {
    return {
      taskId: 'tsk_none', title: 'Urgent fix', brain: 'deck_p_brain', executor: 'deck_sub_x', auditor: 'none',
      status: 'working', round: 0, flags: [], flagSides: {}, blocking: ['P0'], brief: 'Fix the bug.\nAcceptance: tests PASS.',
      ...extra,
    } as unknown as TaskPairState;
  }

  it('shows the dispatched brief of an auditor=none pair as a neutral notice, not "passed"', () => {
    const parsed = parseTaskPairNotification(buildExecutorPairBrief(pairOf({})));
    expect(parsed?.payload.verb).toBe(TASK_PAIR_NOTICE_VERB);
    expect(parsed?.payload.toStatus).toBeUndefined();
    // The brief quotes the whole PASS/REWORK/DONE/QUEUE contract; none of it is a status.
  });

  it('shows briefs and reminders of an audited pair as neutral notices too', () => {
    const audited = pairOf({ auditor: 'deck_sub_aud' });
    for (const text of [buildExecutorPairBrief(audited), buildDoneReminderMessage(audited), buildReworkNoticeMessage(audited, { P0: 1, P1: 0, P2: 0, P3: 0, P4: 0 }), buildNextRoundNoticeMessage(audited)]) {
      const parsed = parseTaskPairNotification(text);
      expect(parsed?.payload.toStatus).toBeUndefined();
    }
  });

  it('keeps the explicit lifecycle statements: status field, leading verb, Audited-pair summary, queue dispatch', () => {
    expect(parseTaskPairNotification('[IM.codes task tsk_a "A"]\nPASS recorded, status passed.')?.payload).toMatchObject({ verb: 'PASS', toStatus: 'passed' });
    expect(parseTaskPairNotification('[IM.codes task tsk_a "A"]\nDISPATCH executor=deck_exec')?.payload).toMatchObject({ verb: 'DISPATCH', toStatus: 'working' });
    expect(parseTaskPairNotification('[IM.codes task tsk_a "A"]\nQUEUE status queued.')?.payload).toMatchObject({ verb: 'QUEUE', toStatus: 'queued' });
    expect(parseTaskPairNotification('[IM.codes task tsk_a "A"]\nAudited pair done: executor deck_exec.')?.payload).toMatchObject({ verb: 'DONE', toStatus: 'done' });
    expect(parseTaskPairNotification(buildPassDoneNoticeMessage(pairOf({ auditor: 'deck_sub_aud', status: 'passed', passRound: 0 })))?.payload).toMatchObject({ verb: 'PASS', toStatus: 'passed' });
    expect(parseTaskPairNotification('[IM.codes task tsk_a "A"] dispatched from the queue: executor deck_exec.')?.payload).toMatchObject({ verb: 'DISPATCH', toStatus: 'working' });
  });

  it('does not treat prose that merely starts with a lifecycle word as a status', () => {
    expect(parseTaskPairNotification('[IM.codes task tsk_a "A"]\nDONE without a PASS is not complete. executor deck_x.')?.payload.toStatus).toBeUndefined();
    expect(parseTaskPairNotification('[IM.codes task tsk_a "A"]\nPASS is required before DONE. auditor deck_y.')?.payload.toStatus).toBeUndefined();
  });
});
