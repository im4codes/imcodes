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
  taskPairBrainEndedPairNote,
  scanTaskPairMarkers,
  type TaskPairState,
} from '../../../shared/task-pair.js';
import { MEMORY_MCP_TOOL_CONTRACTS, MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import type { ContextNamespace } from '../../../shared/context-types.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import { removeSession, upsertSession, type SessionRecord } from '../../../src/store/session-store.js';
import { getTaskPairStore, setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';
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

const MCP_PROJECT = 'brain-close-rule-project';
const MCP_BRAIN = 'deck_brain_close_rule_brain';
const mcpCaller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: MCP_PROJECT } as ContextNamespace,
  sessionName: MCP_BRAIN, projectName: MCP_PROJECT, projectRoot: '/tmp/brain-close-rule', serverId: 'srv', transport: 'in_process',
};

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

describe('a reminder about an OPEN pair ends with how to close it', () => {
  const reminders: Array<[string, string]> = [
    ['decision pending: one pair', buildBrainNoticeMessage(pair({ status: 'blocked' }), 'blocked', 'stuck')],
    ['decision pending: several pairs', buildAggregatedBrainNoticeMessage([{ pair: pair(), flag: 'blocked' }, { pair: pair({ taskId: 'tsk_y' }), flag: 'needs_input' }])],
    ['decision pending: heartbeat', buildBrainHeartbeatMessage([pair({ status: 'awaiting_brain_decision' })])],
    ['decision pending: follow-up', buildBrainDecisionFollowUpMessage([pair({ status: 'awaiting_brain_decision' })])],
    ['no-auditor DONE report', buildNoAuditorDoneNotice(pair({ status: 'awaiting_brain_decision' }), 'did it')],
    ['PASS report (pair passed, still open)', buildPassDoneNoticeMessage(pair({ status: 'passed' }))],
  ];
  for (const [label, text] of reminders) {
    it(label, () => {
      expect(text).toContain(TASK_PAIR_BRAIN_CLOSE_REMINDER);
      for (const phrase of ['close it yourself', 'pair_close action=done', 'pair_close action=done integration=dismiss', 'pair_close action=cancel', 'pair_next_round']) expect(text, phrase).toContain(phrase);
      // MCP tool names, never a marker, anywhere in a reminder to Brain.
      expect(text).not.toMatch(BRAIN_MARKER_TEACHING);
    });
  }
});

describe('a notice about a pair that has ALREADY ended advises only calls that still work', () => {
  const doneKept = buildWorkspaceKeptLine(pair({ status: 'done' }), 'unpushed', { now: 8 * 24 * 3_600_000, unintegratedCommits: 2, lastCommit: 'abc1234 feature' });
  const cancelledKept = buildWorkspaceKeptLine(pair({ status: 'cancelled' }), 'unpushed', { now: 8 * 24 * 3_600_000 });
  const notices: Array<[string, string, 'done' | 'cancelled' | 'mixed']> = [
    ['workspace kept (done pair)', doneKept, 'done'],
    ['workspace kept (cancelled pair)', cancelledKept, 'cancelled'],
    ['workspace kept: summary', buildWorkspaceKeptDigestLine({ deferred: [{ taskId: 'tsk_y', reason: 'unpushed', endedDays: 8 }], announcedOpen: [{ taskId: 'tsk_x' }], maxListed: 10 }), 'mixed'],
    ['finished but not integrated (one)', buildIntegrationDriftDigest([{ taskId: 'tsk_x', head: 'abcdef1234567890', worktree: '/w', ageMs: 3_600_000, ref: 'origin/dev', missing: 2 }]), 'done'],
    ['finished but not integrated (several)', buildIntegrationDriftDigest([
      { taskId: 'tsk_x', head: 'abcdef1234567890', worktree: '/w', ageMs: 3_600_000, ref: 'origin/dev', missing: 2 },
      { taskId: 'tsk_y', head: 'fedcba0987654321', worktree: '/w2', ageMs: 7_200_000, ref: 'origin/dev', missing: 1 },
    ]), 'mixed'],
    ['DONE report (backstop, pair already done)', buildPassDoneNoticeMessage(pair({ status: 'done' })), 'done'],
  ];
  for (const [label, text, kind] of notices) {
    it(label, () => {
      expect(text).toContain(taskPairBrainEndedPairNote(kind));
      // Nothing advised that a terminal pair rejects: no cancel, no next round, no plain done, no "keeps coming".
      expect(text).not.toContain('pair_close action=cancel');
      expect(text).not.toContain('pair_next_round');
      expect(text).not.toContain(TASK_PAIR_BRAIN_CLOSE_REMINDER);
      expect(text).not.toContain('keeps coming');
      for (const match of text.matchAll(/pair_close action=done(?! integration=dismiss)/g)) expect.fail(`plain pair_close action=done advised on an ended pair at ${match.index}`);
      expect(text).not.toMatch(BRAIN_MARKER_TEACHING);
    });
  }

  it('the advised call shapes work against the real pair_close guard, and the old advice did not', async () => {
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    try {
      getTaskPairStore().savePair(MCP_PROJECT, pair({ taskId: 'ended_done', status: 'done', brain: MCP_BRAIN }));
      getTaskPairStore().savePair(MCP_PROJECT, pair({ taskId: 'ended_cancelled', status: 'cancelled', brain: MCP_BRAIN }));
      const brainSession = { name: MCP_BRAIN, projectName: MCP_PROJECT, role: 'brain', agentType: 'codex-sdk', projectDir: '/tmp/brain-close-rule', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2 } as SessionRecord;
      upsertSession(brainSession);
      const handlers = createMemoryMcpToolHandlers(mcpCaller, { sendDeps: { listSessions: () => [brainSession] } });
      const close = handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE]!;
      // Every pair_close shape any ended-pair notice advises, taken from the notice texts themselves.
      const advised = new Set<string>();
      for (const [, text] of notices) for (const match of text.matchAll(/pair_close action=(done|cancel)( integration=dismiss)?/g)) advised.add(match[0]);
      expect([...advised]).toEqual(['pair_close action=done integration=dismiss']);
      const shape = (taskId: string, dismiss: boolean) => ({ taskId, action: 'done', ...(dismiss ? { integration: 'dismiss' } : {}) });
      // Advised: accepted for a done pair.
      await expect(close(shape('ended_done', true))).resolves.toMatchObject({ status: 'ok' });
      // The advice the notices used to carry: rejected as terminal, for done and for cancelled pairs.
      await expect(close({ taskId: 'ended_done', action: 'cancel', idempotencyKey: 'old-advice-1' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
      await expect(close(shape('ended_done', false))).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
      await expect(close({ taskId: 'ended_cancelled', action: 'cancel', idempotencyKey: 'old-advice-2' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND]!({ taskId: 'ended_done' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    } finally {
      removeSession(MCP_BRAIN);
      setTaskPairStoreForTests(undefined);
    }
  });
});

describe('the other Brain-facing notices name the MCP tools too', () => {
  it('no-brief digest, queue stall, title request', () => {
    for (const text of [
      buildNoBriefLine('tsk_x'),
      buildNoBriefDigestMessage(['tsk_x', 'tsk_y']),
      buildQueueStallNoticeMessage([pair({ status: 'queued' })], 10 * 60_000),
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
