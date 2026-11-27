import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService, resetTaskPairTerminalStreamRecoveryForTests } from '../../../src/daemon/task-pairs/service.js';
import { TASK_PAIR_BRIEF_ERROR, TASK_PAIR_BRIEF_MSG } from '../../../shared/task-pair-brief.js';

const PROJECT = 'uibriefproj';
const BRAIN = 'deck_uibriefproj_brain';
const EXEC = 'deck_sub_uibrief_exec';
const AUD = 'deck_sub_uibrief_aud';

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name,
    projectName: PROJECT,
    role,
    agentType: 'claude-code-sdk',
    projectDir: `/tmp/${PROJECT}`,
    state: 'idle',
    sessionInstanceId: `inst_${name}`,
    runtimeEpoch: `epoch_${name}`,
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
  } as SessionRecord;
}

describe('TaskPairService.getPairBriefForUi', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let service: TaskPairService;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairTerminalStreamRecoveryForTests();
    setTaskPairDeliveryDepsForTests({
      send: vi.fn(async () => ({ ok: true as const })),
    });
    for (const s of [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')]) {
      upsertSession(s);
    }
    service = new TaskPairService();
  });

  afterEach(() => {
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('returns brief text, revision, and parsed checklist counts for an existing pair', () => {
    const brief = [
      '### Goal',
      'Expose brief viewer in Task Mode.',
      '',
      '### Acceptance',
      '- [x][x] 1. Add brief endpoint',
      '- [x][ ] 2. Build floating HUD modal',
      '- [ ][ ] 3. Add tests',
    ].join('\n');

    service.applyMarker({
      project: PROJECT,
      writer: BRAIN,
      marker: {
        verb: 'DISPATCH',
        knownVerb: 'DISPATCH',
        taskId: 'tsk_brief_1',
        attrs: { executor: EXEC, auditor: AUD, title: 'Brief HUD' },
        brief,
      },
      source: 'mcp',
      eventId: 'ev-dispatch-brief-1',
      suppressAutomaticBrief: true,
    });

    const stored = getTaskPairStore().getPair(PROJECT, 'tsk_brief_1');
    expect(stored).toBeDefined();

    const res = service.getPairBriefForUi(' tsk_brief_1 ');
    expect(res.ok).toBe(true);
    expect(res.taskId).toBe('tsk_brief_1');
    expect(res.brief).toBe(brief);
    expect(res.briefRevision).toMatch(/^[0-9a-f]{16}$/);
    expect(res.checklist).toEqual({ total: 3, implemented: 2, audited: 1 });
    expect(typeof res.updatedAt).toBe('number');
  });

  it('returns invalid_request, not_found, or empty brief cleanly', () => {
    expect(service.getPairBriefForUi('   ')).toEqual({
      ok: false,
      error: TASK_PAIR_BRIEF_ERROR.INVALID_REQUEST,
    });

    expect(service.getPairBriefForUi('tsk_missing')).toEqual({
      ok: false,
      taskId: 'tsk_missing',
      error: TASK_PAIR_BRIEF_ERROR.NOT_FOUND,
    });

    service.applyMarker({
      project: PROJECT,
      writer: BRAIN,
      marker: {
        verb: 'QUEUE',
        knownVerb: 'QUEUE',
        taskId: 'tsk_empty_brief',
        attrs: { title: 'No brief' },
      },
      source: 'mcp',
      eventId: 'ev-queue-empty',
      suppressAutomaticBrief: true,
    });

    const emptyRes = service.getPairBriefForUi('tsk_empty_brief');
    expect(emptyRes).toMatchObject({
      ok: true,
      taskId: 'tsk_empty_brief',
      brief: '',
      checklist: { total: 0, implemented: 0, audited: 0 },
    });
    expect(emptyRes.briefRevision).toBeUndefined();
  });

  it('defines matching wire request/response message names', () => {
    expect(TASK_PAIR_BRIEF_MSG.REQUEST).toBe('task_pair.brief_request');
    expect(TASK_PAIR_BRIEF_MSG.RESPONSE).toBe('task_pair.brief_response');
  });

  it('persists full marker verdict beyond 4000 chars and returns untruncated numbered findings via getPairBriefForUi', () => {
    service.applyMarker({
      project: PROJECT,
      writer: BRAIN,
      marker: {
        verb: 'DISPATCH',
        knownVerb: 'DISPATCH',
        taskId: 'tsk_brief_audit',
        attrs: { executor: EXEC, auditor: AUD, title: 'Long Audit Sentinel Test' },
        brief: '- [x][ ] 1. Implement feature',
      },
      source: 'mcp',
      eventId: 'ev-dispatch-audit-1',
      suppressAutomaticBrief: true,
    });

    service.applyMarker({
      project: PROJECT,
      writer: EXEC,
      marker: {
        verb: 'READY_FOR_AUDIT',
        knownVerb: 'READY_FOR_AUDIT',
        taskId: 'tsk_brief_audit',
        attrs: { path: '/tmp/dir' },
      },
      source: 'timeline',
      eventId: 'ev-ready-audit-1',
    });

    const longBody = 'Z'.repeat(4200);
    const tailSentinel = 'TAIL_SENTINEL_FINDING_2_AFTER_4200';
    const tailProposal = 'TAIL_SENTINEL_PROPOSAL_FIX_99';
    const reworkTurn = [
      'Summary: Rework required after deep review.',
      `[P0] First item (${longBody})`,
      'Location: src/first.ts:10',
      'Proposal: Fix first item',
      `[P0] Second item at very end ${tailSentinel}`,
      'Location: src/second.ts:99',
      `Proposal: Apply full solution ${tailProposal}`,
      '',
      '<!-- IMCODES_TASK REWORK tsk_brief_audit blocking=P0 p0=2 p1=0 -->',
    ].join('\n');

    service.applyMarker({
      project: PROJECT,
      writer: AUD,
      marker: {
        verb: 'REWORK',
        knownVerb: 'REWORK',
        taskId: 'tsk_brief_audit',
        attrs: { blocking: 'P0', p0: '2', p1: '0' },
      },
      source: 'timeline',
      turnText: reworkTurn,
      eventId: 'ev-rework-audit-1',
    });

    const persisted = getTaskPairStore().getPair(PROJECT, 'tsk_brief_audit');
    expect(persisted?.state.lastVerdict?.noticeText?.length).toBe(4000);
    expect(persisted?.state.lastVerdict?.fullNoticeText).toContain(tailProposal);

    const briefRes = service.getPairBriefForUi('tsk_brief_audit');
    expect(briefRes.ok).toBe(true);
    expect(briefRes.lastAudit).toBeDefined();
    expect(briefRes.lastAudit!.verb).toBe('REWORK');
    expect(briefRes.lastAudit!.blockingCount).toBe(2);
    expect(briefRes.lastAudit!.findings).toHaveLength(2);
    expect(briefRes.lastAudit!.findings[1]).toMatchObject({
      index: 2,
      severity: 'P0',
      blocking: true,
      location: 'src/second.ts:99',
    });
    expect(briefRes.lastAudit!.findings[1]!.summary).toContain(tailSentinel);
    expect(briefRes.lastAudit!.findings[1]!.proposal).toContain(tailProposal);
  });

  it('does not project unapplied/held verdicts to brief or timeline events, and clears lastAudit on applied NEXT_ROUND', async () => {
    const { timelineEmitter } = await import('../../../src/daemon/timeline-emitter.js');
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const off = timelineEmitter.on((ev) => {
      if (ev.sessionId === BRAIN && ev.type === 'task_pair.event') {
        emitted.push({ type: ev.type, payload: ev.payload });
      }
    });
    try {
      service.applyMarker({
        project: PROJECT,
        writer: BRAIN,
        marker: {
          verb: 'DISPATCH',
          knownVerb: 'DISPATCH',
          taskId: 'tsk_held_flow',
          attrs: { executor: EXEC, auditor: AUD, title: 'Held Verdict Lifecycle' },
          brief: '- [x][ ] 1. Task',
        },
        source: 'mcp',
        eventId: 'ev-held-dispatch',
        suppressAutomaticBrief: true,
      });

      service.applyMarker({
        project: PROJECT,
        writer: EXEC,
        marker: {
          verb: 'READY_FOR_AUDIT',
          knownVerb: 'READY_FOR_AUDIT',
          taskId: 'tsk_held_flow',
          attrs: { path: '/tmp/dir' },
        },
        source: 'timeline',
        eventId: 'ev-held-ready',
      });

      // Inconsistent PASS (with p0=1) is held -> brief.lastAudit must be undefined & event must NOT emit lastAudit
      const heldTransition = service.applyMarker({
        project: PROJECT,
        writer: AUD,
        marker: {
          verb: 'PASS',
          knownVerb: 'PASS',
          taskId: 'tsk_held_flow',
          attrs: { p0: '1' },
        },
        source: 'timeline',
        turnText: '[P0] Still failing check\n<!-- IMCODES_TASK PASS tsk_held_flow p0=1 -->',
        eventId: 'ev-held-pass',
      });
      expect(heldTransition.effect).toBe('verdict_held');
      expect(service.getPairBriefForUi('tsk_held_flow').lastAudit).toBeUndefined();
      expect(emitted.at(-1)?.payload.effect).toBe('verdict_held');
      expect(emitted.at(-1)?.payload.lastAudit).toBeUndefined();

      // Rejected NEXT_ROUND while in_audit (effect=recorded) must NOT clear audit state
      const rejectedNext = service.applyMarker({
        project: PROJECT,
        writer: BRAIN,
        marker: {
          verb: 'NEXT_ROUND',
          knownVerb: 'NEXT_ROUND',
          taskId: 'tsk_held_flow',
          attrs: {},
        },
        source: 'mcp',
        eventId: 'ev-rejected-next-round',
      });
      expect(rejectedNext.effect).toBe('recorded');
      expect(emitted.at(-1)?.payload.lastAudit).toBeUndefined();

      // Applied PASS emits consistent lastAudit
      const passTransition = service.applyMarker({
        project: PROJECT,
        writer: AUD,
        marker: {
          verb: 'PASS',
          knownVerb: 'PASS',
          taskId: 'tsk_held_flow',
          attrs: { p0: '0' },
        },
        source: 'timeline',
        turnText: 'Summary: Clean pass.\n<!-- IMCODES_TASK PASS tsk_held_flow p0=0 -->',
        eventId: 'ev-applied-pass',
      });
      expect(passTransition.effect).toBe('verdict');
      expect(service.getPairBriefForUi('tsk_held_flow').lastAudit?.verb).toBe('PASS');
      expect(emitted.at(-1)?.payload.lastAudit).toMatchObject({ verb: 'PASS', round: 1, blockingCount: 0 });

      // Applied NEXT_ROUND emits explicit lastAudit: null and clears getPairBriefForUi().lastAudit
      const nextRound = service.applyMarker({
        project: PROJECT,
        writer: BRAIN,
        marker: {
          verb: 'NEXT_ROUND',
          knownVerb: 'NEXT_ROUND',
          taskId: 'tsk_held_flow',
          attrs: {},
        },
        source: 'mcp',
        eventId: 'ev-applied-next-round',
      });
      expect(nextRound.effect).toBe('next_round');
      expect(service.getPairBriefForUi('tsk_held_flow').lastAudit).toBeUndefined();
      expect(emitted.at(-1)?.payload.effect).toBe('next_round');
      expect(emitted.at(-1)?.payload.lastAudit).toBeNull();
    } finally {
      off();
    }
  });
});
