import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { name: string; projectName: string }>(),
  dispatchSessionMessage: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../../../src/store/session-store.js', () => ({ getSession: (name: string) => mocks.sessions.get(name) }));
vi.mock('../../../src/agent/session-manager.js', () => ({ getTransportRuntime: () => ({ pendingEntries: [] }) }));
vi.mock('../../../src/daemon/session-dispatch.js', () => ({ dispatchSessionMessage: mocks.dispatchSessionMessage }));
vi.mock('../../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: mocks.emit } }));

import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { sendTaskPairMessage, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { brainNoticeForCard } from '../../../src/daemon/task-pairs/brain-notice.js';
import { emitTaskPairTimelineEvent } from '../../../src/daemon/task-pairs/service.js';
import { TASK_PAIR_BRAIN_NOTICE_EVENT, TASK_PAIR_TIMELINE_EVENT, type TaskPairState } from '../../../shared/task-pair.js';

const PROJECT = 'noticeproj';
const BRAIN = 'deck_noticeproj_brain';
const EXEC = 'deck_sub_noticeexec';

function pairState(taskId: string, status: TaskPairState['status'], extra: Partial<TaskPairState> = {}): TaskPairState {
  return {
    taskId, brain: BRAIN, status, flags: [], flagSides: {}, round: 0, blocking: ['P0'], previousAuditors: [],
    capCounts: {}, capRound: 0, createdAt: 1, updatedAt: 1, executor: EXEC, auditor: 'none', ...extra,
  } as TaskPairState;
}

function noticeEvents(taskId: string) {
  return getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === TASK_PAIR_BRAIN_NOTICE_EVENT);
}

describe('daemon notices to Brain: the outcome is recorded, never silent', () => {
  beforeEach(() => {
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    setTaskPairDeliveryDepsForTests(undefined);
    mocks.sessions.clear();
    mocks.sessions.set(BRAIN, { name: BRAIN, projectName: PROJECT });
    mocks.sessions.set(EXEC, { name: EXEC, projectName: PROJECT });
    mocks.dispatchSessionMessage.mockReset();
    mocks.emit.mockReset();
    getTaskPairStore().savePair(PROJECT, pairState('N1', 'awaiting_brain_decision'));
  });
  afterEach(() => { setTaskPairDeliveryDepsForTests(undefined); });

  it('records a delivered notice on the event log and the pair liveness', async () => {
    mocks.dispatchSessionMessage.mockResolvedValue('sent');
    await expect(sendTaskPairMessage(BRAIN, 'N1', 'brain-line-done-no-auditor', 'decide')).resolves.toBe('sent');
    const [event] = noticeEvents('N1');
    expect(event).toMatchObject({ effect: 'sent', attrs: { reason: 'brain-line-done-no-auditor', status: 'sent' } });
    expect(getTaskPairStore().getPair(PROJECT, 'N1')!.liveness).toMatchObject({ brainNoticeStatus: 'sent', brainNoticeReason: 'brain-line-done-no-auditor' });
  });

  it('records a notice that queued behind a busy Brain as queued', async () => {
    mocks.dispatchSessionMessage.mockResolvedValue('queued');
    await sendTaskPairMessage(BRAIN, 'N1', 'brain-line-done-no-auditor', 'decide');
    expect(getTaskPairStore().getPair(PROJECT, 'N1')!.liveness.brainNoticeStatus).toBe('queued');
  });

  it('records a failed transport instead of swallowing it', async () => {
    mocks.dispatchSessionMessage.mockRejectedValue(new Error('transport down'));
    await expect(sendTaskPairMessage(BRAIN, 'N1', 'brain-line-done-no-auditor', 'decide')).resolves.toBe('failed');
    expect(noticeEvents('N1')[0]).toMatchObject({ effect: 'failed' });
    expect(getTaskPairStore().getPair(PROJECT, 'N1')!.liveness.brainNoticeStatus).toBe('failed');
  });

  it('records a missing Brain session', async () => {
    mocks.sessions.delete(BRAIN);
    await expect(sendTaskPairMessage(BRAIN, 'N1', 'brain-line-done-no-auditor', 'decide')).resolves.toBe('no_session');
    expect(noticeEvents('N1')[0]).toMatchObject({ effect: 'no_session' });
  });

  it('does not record a duplicate that is still pending, and never records messages to participants or aggregate ids', async () => {
    mocks.dispatchSessionMessage.mockResolvedValue('sent');
    await sendTaskPairMessage(EXEC, 'N1', 'nudge-executor', 'nudge');
    await sendTaskPairMessage(BRAIN, '__aggregate__', 'brain-decision-reminder', 'aggregate');
    expect(noticeEvents('N1')).toHaveLength(0);
    expect(getTaskPairStore().getPair(PROJECT, 'N1')!.liveness.brainNoticeStatus).toBeUndefined();
  });

  it('a notice about another pair, or to another pair\'s Brain, is not attributed to this pair', async () => {
    mocks.dispatchSessionMessage.mockResolvedValue('sent');
    getTaskPairStore().savePair(PROJECT, pairState('N2', 'awaiting_brain_decision', { brain: 'deck_other_brain' }));
    await sendTaskPairMessage(BRAIN, 'N2', 'brain-line-done-no-auditor', 'decide');
    expect(noticeEvents('N1')).toHaveLength(0);
    expect(noticeEvents('N2')).toHaveLength(0);
  });
});

describe('the card says whether Brain was told', () => {
  beforeEach(() => {
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    mocks.sessions.clear();
    mocks.emit.mockReset();
  });

  function liveness(taskId: string) { return getTaskPairStore().getPair(PROJECT, taskId)!.liveness; }

  it('carries the last notice for a pair awaiting Brain, only when it belongs to the current wait', () => {
    getTaskPairStore().savePair(PROJECT, pairState('C1', 'awaiting_brain_decision'));
    getTaskPairStore().saveLiveness(PROJECT, 'C1', { ...liveness('C1'), phaseStartedAt: 1_000, brainNoticeStatus: 'queued', brainNoticeAt: 2_000, brainNoticeReason: 'brain-line-done-no-auditor' });
    expect(brainNoticeForCard(getTaskPairStore().getPair(PROJECT, 'C1'))).toEqual({ status: 'queued', at: 2_000, reason: 'brain-line-done-no-auditor' });

    // A notice from an earlier wait must not make a fresh wait look notified.
    getTaskPairStore().saveLiveness(PROJECT, 'C1', { ...liveness('C1'), phaseStartedAt: 5_000 });
    expect(brainNoticeForCard(getTaskPairStore().getPair(PROJECT, 'C1'))).toBeUndefined();
  });

  it('is absent for any other status and for a pair that never had a notice', () => {
    getTaskPairStore().savePair(PROJECT, pairState('C2', 'working'));
    getTaskPairStore().saveLiveness(PROJECT, 'C2', { ...liveness('C2'), brainNoticeStatus: 'sent', brainNoticeAt: 2_000, brainNoticeReason: 'x' });
    expect(brainNoticeForCard(getTaskPairStore().getPair(PROJECT, 'C2'))).toBeUndefined();
    getTaskPairStore().savePair(PROJECT, pairState('C3', 'awaiting_brain_decision'));
    expect(brainNoticeForCard(getTaskPairStore().getPair(PROJECT, 'C3'))).toBeUndefined();
  });

  it('puts brainNotice on the emitted timeline event, and leaves the payload untouched on a daemon that has none', () => {
    getTaskPairStore().savePair(PROJECT, pairState('C4', 'awaiting_brain_decision'));
    getTaskPairStore().saveLiveness(PROJECT, 'C4', { ...liveness('C4'), brainNoticeStatus: 'failed', brainNoticeAt: 3_000, brainNoticeReason: 'brain-line-done-no-auditor' });
    const state = getTaskPairStore().getPair(PROJECT, 'C4')!.state;
    emitTaskPairTimelineEvent({ taskId: 'C4', verb: 'DONE', writer: EXEC, role: 'executor', source: 'marker', effect: 'recorded', unusual: true }, state, 'evt-c4');
    const call = mocks.emit.mock.calls.find((c) => c[0] === BRAIN && c[1] === TASK_PAIR_TIMELINE_EVENT);
    expect(call?.[2]).toMatchObject({ brainNotice: { status: 'failed', at: 3_000, reason: 'brain-line-done-no-auditor' } });

    mocks.emit.mockReset();
    getTaskPairStore().savePair(PROJECT, pairState('C5', 'working'));
    emitTaskPairTimelineEvent({ taskId: 'C5', verb: 'WORKING', writer: EXEC, role: 'executor', source: 'marker', effect: 'applied', unusual: false }, getTaskPairStore().getPair(PROJECT, 'C5')!.state, 'evt-c5');
    expect(mocks.emit.mock.calls[0]?.[2]).not.toHaveProperty('brainNotice');
  });
});
