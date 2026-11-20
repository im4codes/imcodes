import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService, resetTaskPairTerminalStreamRecoveryForTests } from '../../../src/daemon/task-pairs/service.js';
import { pausePair } from '../../../src/daemon/task-pairs/suspension.js';
import { TASK_PAIR_TIMELINE_EVENT } from '../../../shared/task-pair.js';
import { TASK_PAIR_CLOSE_ERROR, TASK_PAIR_CLOSE_MSG } from '../../../shared/task-pair-close.js';

const PROJECT = 'uicloseproj';
const BRAIN = 'deck_uicloseproj_brain';
const EXEC = 'deck_sub_uiclose_exec';
const AUD = 'deck_sub_uiclose_aud';

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

describe('TaskPairService.closePairFromUi', () => {
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

  it('cancels working, queued, paused, and passed pairs, releases resource claims, and emits timeline events', async () => {
    const emitted: Array<{ session: string; status: unknown; verb: unknown }> = [];
    const unsub = timelineEmitter.on((ev) => {
      if (ev.type === TASK_PAIR_TIMELINE_EVENT) {
        emitted.push({ session: ev.sessionId, status: ev.payload.toStatus, verb: ev.payload.verb });
      }
    });

    try {
      service.applyMarker({
        project: PROJECT,
        writer: BRAIN,
        marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'tsk_cancel_working', attrs: { executor: EXEC, auditor: AUD, title: 'Working pair' } },
        source: 'mcp',
        eventId: 'ev-dispatch-working',
        suppressAutomaticBrief: true,
      });
      service.claimResource({
        project: PROJECT,
        taskId: 'tsk_cancel_working',
        owner: EXEC,
        resource: 'shared-stack-1',
        mode: 'exclusive',
        ttlMs: 60_000,
      });
      expect(getTaskPairStore().getPair(PROJECT, 'tsk_cancel_working')?.state.resourceClaims?.length).toBe(1);

      const res1 = await service.closePairFromUi({
        taskId: 'tsk_cancel_working',
        action: 'cancel',
        requestId: 'req-1',
      });
      expect(res1.ok).toBe(true);
      expect(res1.status).toBe('cancelled');
      const after1 = getTaskPairStore().getPair(PROJECT, 'tsk_cancel_working')!.state;
      expect(after1.status).toBe('cancelled');
      expect(after1.resourceClaims).toEqual([]);
      expect(emitted.some((e) => e.status === 'cancelled' && e.verb === 'CANCEL')).toBe(true);

      // Queued + paused pair
      service.applyMarker({
        project: PROJECT,
        writer: BRAIN,
        marker: { verb: 'QUEUE', knownVerb: 'QUEUE', taskId: 'tsk_cancel_paused', attrs: { title: 'Paused pair' } },
        source: 'mcp',
        eventId: 'ev-queue-paused',
        suppressAutomaticBrief: true,
      });
      pausePair(PROJECT, 'tsk_cancel_paused', BRAIN, 'manual', undefined, 'hold');
      const res2 = await service.closePairFromUi({
        taskId: 'tsk_cancel_paused',
        action: 'cancel',
        requestId: 'req-2',
      });
      expect(res2.ok).toBe(true);
      expect(res2.status).toBe('cancelled');
      expect(getTaskPairStore().getPair(PROJECT, 'tsk_cancel_paused')!.state.status).toBe('cancelled');
    } finally {
      unsub();
    }
  });

  it('closes an open pair as done when action=done with force and rejects already-terminal or unknown pairs', async () => {
    service.applyMarker({
      project: PROJECT,
      writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'tsk_done_ui', attrs: { executor: EXEC, auditor: AUD, title: 'Finishable' } },
      source: 'mcp',
      eventId: 'ev-dispatch-done',
      suppressAutomaticBrief: true,
    });

    const doneRes = await service.closePairFromUi({
      taskId: 'tsk_done_ui',
      action: 'done',
      force: true,
      requestId: 'req-done-1',
    });
    expect(doneRes.ok).toBe(true);
    expect(doneRes.status).toBe('done');

    const dupRes = await service.closePairFromUi({
      taskId: 'tsk_done_ui',
      action: 'cancel',
      requestId: 'req-dup-1',
    });
    expect(dupRes).toMatchObject({
      ok: false,
      taskId: 'tsk_done_ui',
      status: 'done',
      error: TASK_PAIR_CLOSE_ERROR.ALREADY_TERMINAL,
    });

    const missingRes = await service.closePairFromUi({
      taskId: 'tsk_nonexistent',
      action: 'cancel',
      requestId: 'req-missing',
    });
    expect(missingRes).toMatchObject({
      ok: false,
      taskId: 'tsk_nonexistent',
      error: TASK_PAIR_CLOSE_ERROR.NOT_FOUND,
    });
  });

  it('defines matching wire request/response message names', () => {
    expect(TASK_PAIR_CLOSE_MSG.REQUEST).toBe('task_pair.close_request');
    expect(TASK_PAIR_CLOSE_MSG.RESPONSE).toBe('task_pair.close_response');
  });
});
