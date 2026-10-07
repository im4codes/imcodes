/**
 * Owner rule: "when Brain has dealt with a task it closes the task itself -- the contract must say so, or there is
 * always a pile of stale reminders." The contract states the rule and the way to close for each outcome; every
 * reminder to Brain about an open pair ends with the short form; the Brain-facing pair tools say it too.
 */
import { describe, expect, it } from 'vitest';
import {
  TASK_PAIR_ANALYZE_BEFORE_DISPATCH_RULE,
  TASK_PAIR_BRAIN_CLOSE_REMINDER,
  TASK_PAIR_BRAIN_CLOSE_RULE,
  TASK_PAIR_BRAIN_CLOSE_TOOL_NOTE,
  TASK_PAIR_BRAIN_CLOSE_TOOL_SHORT_NOTE,
  TASK_PAIR_BRAIN_MCP_ONLY_RULE,
  TASK_PAIR_BRIEF_STRUCTURE_RULE,
  TASK_PAIR_NATIVE_COLLABORATION_RULE,
  TASK_PAIR_NEXT_ROUND_RULE,
  TASK_PAIR_TITLE_MARKER_RULE,
  TASK_PAIR_TITLE_RULE,
  buildTaskPairMarkerContract,
  scanTaskPairMarkers,
  type TaskPairState,
} from '../../../shared/task-pair.js';
import { MEMORY_MCP_TOOL_CONTRACTS, MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import {
  buildAggregatedBrainNoticeMessage,
  buildBrainDecisionFollowUpMessage,
  buildBrainHeartbeatMessage,
  buildBrainNoticeMessage,
  buildIntegrationDriftDigest,
  buildNoAuditorDoneNotice,
  buildNoBriefDigestMessage,
  buildNoBriefLine,
  buildQueueStallNoticeMessage,
  buildUntitledTaskTitleRequest,
  buildPassDoneNoticeMessage,
  buildWorkspaceKeptDigestLine,
  buildWorkspaceKeptLine,
} from '../../../src/daemon/task-pairs/messages.js';

function pair(overrides: Partial<TaskPairState> = {}): TaskPairState {
  return {
    taskId: 'tsk_x', brain: 'deck_proj_brain', executor: 'deck_sub_exec', auditor: 'deck_sub_aud',
    status: 'passed', flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [],
    capCounts: {}, capRound: 1, createdAt: 1, updatedAt: 1,
    workspace: { kind: 'worktree', path: '/w/pair_tsk_x/repo', base: 'b', status: 'kept', createdAt: 1, endedAt: 1 },
    ...overrides,
  };
}

/** A marker example, or a marker verb taught to Brain as the way to act. */
const BRAIN_MARKER_TEACHING = /<!--\s*IMCODES_TASK|\b(?:DONE|CANCEL|REASSIGN|NEXT_ROUND|DISPATCH|QUEUE)\s+(?:<taskId>|tsk_\w+|\$\{)|\bNEXT_ROUND\b|\bREASSIGN\b|existing-pair DISPATCH|QUEUE - max=|urgent=true/;

describe('the Brain contract: Brain closes what it has dealt with, with the MCP tools only', () => {
  it('states the rule and the exact MCP call for each outcome', () => {
    const contract = buildTaskPairMarkerContract();
    expect(contract).toContain(TASK_PAIR_BRAIN_CLOSE_RULE);
    expect(contract).toContain(TASK_PAIR_BRAIN_MCP_ONLY_RULE);
    for (const phrase of [
      'you MUST close it yourself',
      'whatever the outcome',
      'keeps reminding you about every pair you leave open',
      'stale reminders',
      'merged or result accepted -> pair_close action=done',
      'not going to merge -> pair_close action=done integration=dismiss',
      'abandoned -> pair_close action=cancel',
      'more work wanted -> pair_next_round',
      'close and advance pairs ONLY with the MCP tools; do not write IMCODES_TASK markers yourself',
      'pair_create', 'pair_dispatch', 'pair_reassign', 'pair_close', 'pair_next_round', 'pair_task_update', 'pair_task_check', 'pair_set_max_concurrency', 'pair_resource_claim',
    ]) expect(contract, phrase).toContain(phrase);
  });

  it('teaches Brain no marker: the Brain-only rules carry none', () => {
    for (const [name, text] of Object.entries({
      TASK_PAIR_BRAIN_CLOSE_RULE, TASK_PAIR_BRAIN_CLOSE_REMINDER, TASK_PAIR_BRAIN_CLOSE_TOOL_NOTE,
      TASK_PAIR_BRAIN_MCP_ONLY_RULE: TASK_PAIR_BRAIN_MCP_ONLY_RULE.replace('do not write IMCODES_TASK markers yourself', '').replace('Do not add any IMCODES_TASK marker to a reply', ''),
      TASK_PAIR_TITLE_RULE, TASK_PAIR_TITLE_MARKER_RULE, TASK_PAIR_NATIVE_COLLABORATION_RULE, TASK_PAIR_BRIEF_STRUCTURE_RULE,
      TASK_PAIR_ANALYZE_BEFORE_DISPATCH_RULE, TASK_PAIR_NEXT_ROUND_RULE,
    })) expect(text, name).not.toMatch(BRAIN_MARKER_TEACHING);
    // The executor/auditor parts of the contract keep their markers (STARTED / READY_FOR_AUDIT / PASS / REWORK / DONE).
    expect(buildTaskPairMarkerContract()).toContain('READY_FOR_AUDIT');
  });

  it('says it in every Brain-facing pair tool description', () => {
    // pair_close carries the full rule; the others (tight catalog byte budget) point at it.
    expect(MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE].description).toContain(TASK_PAIR_BRAIN_CLOSE_TOOL_NOTE);
    for (const name of [MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT, MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]) {
      expect(MEMORY_MCP_TOOL_CONTRACTS[name].description, name).toContain(TASK_PAIR_BRAIN_CLOSE_TOOL_SHORT_NOTE);
    }
    expect(TASK_PAIR_BRAIN_CLOSE_TOOL_NOTE).toContain('integration=dismiss');
  });

  it('the daemon still accepts the legacy Brain markers (compatibility), they are only no longer taught', () => {
    const text = [
      '<!-- IMCODES_TASK DONE tsk_a integration=dismiss -->',
      '<!-- IMCODES_TASK CANCEL tsk_b -->',
      '<!-- IMCODES_TASK NEXT_ROUND tsk_c base=abc1234 -->',
      '<!-- IMCODES_TASK REASSIGN tsk_d auditor=deck_sub_x -->',
      '<!-- IMCODES_TASK DISPATCH tsk_e executor=deck_sub_y -->',
    ].join('\n');
    const verbs = scanTaskPairMarkers(text).markers.map((entry) => [entry.knownVerb, entry.taskId]);
    expect(verbs).toEqual([['DONE', 'tsk_a'], ['CANCEL', 'tsk_b'], ['NEXT_ROUND', 'tsk_c'], ['REASSIGN', 'tsk_d'], ['DISPATCH', 'tsk_e']]);
  });
});

describe('every reminder to Brain about an open pair ends with how to close it', () => {
  const reminders: Array<[string, string]> = [
    ['decision pending: one pair', buildBrainNoticeMessage(pair({ status: 'blocked' }), 'blocked', 'stuck')],
    ['decision pending: several pairs', buildAggregatedBrainNoticeMessage([{ pair: pair(), flag: 'blocked' }, { pair: pair({ taskId: 'tsk_y' }), flag: 'needs_input' }])],
    ['decision pending: heartbeat', buildBrainHeartbeatMessage([pair({ status: 'awaiting_brain_decision' })])],
    ['no-auditor DONE report', buildNoAuditorDoneNotice(pair({ status: 'awaiting_brain_decision' }), 'did it')],
    ['PASS / DONE report', buildPassDoneNoticeMessage(pair())],
    ['finished but not integrated', buildIntegrationDriftDigest([{ taskId: 'tsk_x', head: 'abcdef1234567890', worktree: '/w', ageMs: 3_600_000, ref: 'origin/dev', missing: 2 }])],
    ['workspace kept', buildWorkspaceKeptLine(pair({ status: 'done' }), 'unpushed', { now: 8 * 24 * 3_600_000, unintegratedCommits: 2, lastCommit: 'abc1234 feature' })],
    ['workspace kept: summary', buildWorkspaceKeptDigestLine({ deferred: [{ taskId: 'tsk_y', reason: 'unpushed', endedDays: 8 }], announcedOpen: [{ taskId: 'tsk_x' }], maxListed: 10 })],
  ];
  for (const [label, text] of reminders) {
    it(label, () => {
      expect(text).toContain(TASK_PAIR_BRAIN_CLOSE_REMINDER);
      for (const phrase of ['close it yourself', 'pair_close action=done', 'pair_close action=done integration=dismiss', 'pair_close action=cancel', 'pair_next_round']) expect(text, phrase).toContain(phrase);
      // MCP tool names, never a marker, anywhere in a reminder to Brain.
      expect(text).not.toMatch(BRAIN_MARKER_TEACHING);
    });
  }

  it('the other Brain-facing notices name the MCP tools too (no-brief digest, queue stall, legacy import, title request)', () => {
    for (const text of [
      buildNoBriefLine('tsk_x'),
      buildNoBriefDigestMessage(['tsk_x', 'tsk_y']),
      buildQueueStallNoticeMessage([pair({ status: 'queued' })], 10 * 60_000),
      buildBrainDecisionFollowUpMessage([pair({ status: 'awaiting_brain_decision' })]),
      buildUntitledTaskTitleRequest(['tsk_x'], 'en'),
    ]) expect(text).not.toMatch(BRAIN_MARKER_TEACHING);
  });
});

describe('no "nothing to do" marker is taught to Brain, and one written anyway does nothing', () => {
  // Brain 215/158 ended replies with <!-- IMCODES_TASK_NOOP -->: not a marker the daemon knows, learned from our own reminder text.
  const NOOP = 'IMCODES_TASK_NOOP';

  it('the contract says not to add markers to replies and never names a no-op marker', () => {
    const contract = buildTaskPairMarkerContract();
    expect(contract).toContain('Do not add any IMCODES_TASK marker to a reply -- not even an empty or "no-op" one');
    expect(contract).toContain('With nothing to handle, just answer.');
    expect(contract).not.toContain(NOOP);
  });

  it('no reminder, follow-up or tool description carries it', () => {
    const texts = [
      buildBrainDecisionFollowUpMessage([pair({ status: 'awaiting_brain_decision' }), pair({ taskId: 'tsk_y', status: 'awaiting_brain_decision' })]),
      buildBrainHeartbeatMessage([pair({ status: 'awaiting_brain_decision' })]),
      buildBrainNoticeMessage(pair({ status: 'blocked' }), 'blocked', 'stuck'),
      buildWorkspaceKeptLine(pair({ status: 'done' }), 'unpushed'),
      ...Object.values(MEMORY_MCP_TOOL_CONTRACTS).map((tool) => tool.description),
    ];
    for (const text of texts) expect(text).not.toContain(NOOP);
    expect(buildBrainDecisionFollowUpMessage([pair({ status: 'awaiting_brain_decision' })])).toContain('A plain text reply is NOT an answer');
  });

  it('the daemon does not treat it as a marker or an action', () => {
    const { markers } = scanTaskPairMarkers(`ok <!-- ${NOOP} -->\n<!-- ${NOOP} tsk_x -->\n<!--IMCODES_TASK_EMPTY-->`);
    expect(markers).toEqual([]);
  });
});
