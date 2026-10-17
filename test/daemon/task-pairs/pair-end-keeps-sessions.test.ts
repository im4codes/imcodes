import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Nothing may close a session on its own: a session carries its memory, and reusing it is faster than starting another. Only an explicit
// session_close does. So the end of a pair (DONE or CANCEL) must leave its auto-created executor and auditor exactly where they were.
const stopSubSession = vi.hoisted(() => vi.fn(async () => ({ ok: true, closed: [], failed: [] })));
const closeSubSession = vi.hoisted(() => vi.fn(async () => ({ ok: true, alreadyClosed: false, serverNotified: true })));

vi.mock('../../../src/daemon/subsession-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/daemon/subsession-manager.js')>()),
  stopSubSession,
}));
vi.mock('../../../src/daemon/session-close.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/daemon/session-close.js')>()),
  closeSubSession,
}));

import type { SessionRecord } from '../../../src/store/session-store.js';
import { getSession, removeSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService, type TaskPairScheduler } from '../../../src/daemon/task-pairs/service.js';
import { runIntegrationDriftPass } from '../../../src/daemon/task-pairs/integration-drift.js';

const PROJECT = 'keepproj';
const BRAIN = 'deck_keepproj_brain';
const EXEC = 'deck_sub_pair_auto_keepexec';
const AUD = 'deck_sub_pair_auto_keepaud';
const SESSIONS = [BRAIN, EXEC, AUD];

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    ...extra,
  } as SessionRecord;
}
const autoCreated = (createdBy: string) => ({
  parentSession: BRAIN,
  pairCreatedMetadata: { autoCreated: true, source: 'pair_create', createdBy, pairTaskId: 'T1', role: 'executor', createdAt: 1 },
}) as Partial<SessionRecord>;

let service: TaskPairService;
let turn = 0;

const testScheduler: TaskPairScheduler = {
  async onIntent(project, pairState, intent) {
    if (intent.kind !== 'slot_changed') return;
    if (pairState.status !== 'queued' || !pairState.executor || pairState.auditor === undefined) return;
    service.applyMarker({
      project,
      writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: pairState.taskId, attrs: { executor: pairState.executor, auditor: pairState.auditor } },
      source: 'queue',
      now: Date.now(),
      eventId: `test-queue-drain:${pairState.taskId}:${Date.now()}:${Math.random()}`,
    });
    await service.briefParticipants(project, pairState.taskId);
  },
};

async function flush() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (service.pendingCount === 0) return;
  }
}

async function say(sessionName: string, text: string) {
  turn += 1;
  timelineEmitter.emit(sessionName, 'assistant.text', { text, streaming: false }, { source: 'daemon', confidence: 'high', eventId: `keep-turn-${turn}` });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
}

const status = (taskId: string) => getTaskPairStore().getPair(PROJECT, taskId)?.state.status;

describe('ending a pair never closes the sessions it used', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    stopSubSession.mockClear();
    closeSubSession.mockClear();
    upsertSession(session(BRAIN, 'brain'));
    upsertSession(session(EXEC, 'w2', autoCreated(BRAIN)));
    upsertSession(session(AUD, 'w3', autoCreated(BRAIN)));
    service = new TaskPairService();
    service.init();
    service.setScheduler(testScheduler);
  });

  afterEach(async () => {
    await service.dispose();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of SESSIONS) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  function expectUntouched() {
    expect(stopSubSession).not.toHaveBeenCalled();
    expect(closeSubSession).not.toHaveBeenCalled();
    for (const name of [EXEC, AUD]) {
      expect(getSession(name)).toMatchObject({ name, state: 'idle', pairCreatedMetadata: { autoCreated: true, createdBy: BRAIN } });
    }
  }

  it('keeps an auto-created executor and auditor after an audited pair reaches DONE, even after the grace a recycler would have used', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T1 executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, 'Done.\n<!-- IMCODES_TASK READY_FOR_AUDIT T1 worktree=/w head=1234567 -->');
    await say(AUD, '<!-- IMCODES_TASK PASS T1 blocking=P0 -->');
    await say(EXEC, 'Merged.\n<!-- IMCODES_TASK DONE T1 -->');
    expect(status('T1')).toBe('done');
    // Run the periodic sweeps with a clock a day ahead: no sweep closes a session.
    await runIntegrationDriftPass(Date.now() + 24 * 60 * 60_000);
    await flush();
    expectUntouched();
  });

  it('keeps them after a CANCEL as well', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T2 executor=${EXEC} auditor=${AUD} -->`);
    await say(BRAIN, '<!-- IMCODES_TASK CANCEL T2 -->');
    expect(status('T2')).toBe('cancelled');
    await runIntegrationDriftPass(Date.now() + 24 * 60 * 60_000);
    await flush();
    expectUntouched();
  });

  it('keeps an idle auto-created session reusable: the next pair may name it again', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T3 executor=${EXEC} auditor=none -->`);
    await say(BRAIN, '<!-- IMCODES_TASK DONE T3 force=true -->');
    expect(status('T3')).toBe('done');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T4 executor=${EXEC} auditor=${AUD} -->`);
    expect(status('T4')).toBe('working');
    expectUntouched();
  });
});
