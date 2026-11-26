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
});
