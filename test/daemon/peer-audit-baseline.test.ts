import { describe, expect, it } from 'vitest';
import {
  PeerAuditBaselineTracker,
  type PeerAuditWorkState,
} from '../../src/daemon/peer-audit-baseline.js';

const NO_WORK: PeerAuditWorkState = {
  foreground: false,
  background: false,
  pendingCompletion: false,
  subagent: false,
};

function harness() {
  let nextId = 0;
  const tracker = new PeerAuditBaselineTracker({ createBaselineId: () => `baseline-${++nextId}` });
  const session = {
    sessionName: 'deck_proj_brain',
    auditedSessionInstanceId: 'instance-1',
    auditedRuntimeEpoch: 'runtime-1',
  };
  const begin = (taskCommandId: string, userText = taskCommandId, generationOrEpoch?: number) => tracker.beginTopLevelIntent({
    ...session,
    taskCommandId,
    userText,
    ...(generationOrEpoch === undefined ? {} : { generationOrEpoch }),
  });
  const terminal = (taskCommandId: string, generationOrEpoch: number, patch: Record<string, unknown> = {}) => tracker.recordTerminalTopLevelResult({
    ...session,
    taskCommandId,
    generationOrEpoch,
    assistantText: `result:${taskCommandId}`,
    completedEventId: `event:${taskCommandId}`,
    completedAt: 100 + generationOrEpoch,
    terminal: true,
    topLevel: true,
    ...patch,
  });
  const current = () => tracker.getCompletedBaseline(session);
  return { tracker, session, begin, terminal, current };
}

describe('completed peer-audit baseline authority', () => {
  it('commits only a correlated terminal top-level pair after every work source is idle', () => {
    const { tracker, begin, terminal, current } = harness();
    const epoch = begin('task-1', 'do one thing');

    expect(terminal('other-task', epoch)).toBeUndefined();
    expect(terminal('task-1', epoch, { topLevel: false })).toBeUndefined();
    expect(terminal('task-1', epoch)).toBeUndefined();
    expect(current()).toBeUndefined();

    const baseline = tracker.updateWorkState('deck_proj_brain', NO_WORK);
    expect(baseline).toMatchObject({
      baselineId: 'baseline-1',
      taskCommandId: 'task-1',
      generationOrEpoch: 1,
      userText: 'do one thing',
      assistantText: 'result:task-1',
      completedEventId: 'event:task-1',
    });
    expect(current()).toEqual(baseline);
  });

  it('uses a monotonic off-mode epoch and never audits an older consecutive task', () => {
    const { tracker, begin, terminal, current } = harness();
    const firstEpoch = begin('task-1');
    terminal('task-1', firstEpoch);
    tracker.updateWorkState('deck_proj_brain', NO_WORK);
    expect(current()?.taskCommandId).toBe('task-1');

    const secondEpoch = begin('task-2');
    expect(secondEpoch).toBe(firstEpoch + 1);
    expect(current()).toBeUndefined();
    terminal('task-2', secondEpoch);
    tracker.updateWorkState('deck_proj_brain', NO_WORK);
    expect(current()).toMatchObject({ taskCommandId: 'task-2', generationOrEpoch: secondEpoch });
    expect(tracker.getOffModeEpoch('deck_proj_brain')).toBe(secondEpoch);
  });

  it('ignores late assistant frames after the baseline has committed', () => {
    const { tracker, begin, terminal, current } = harness();
    const epoch = begin('task-1');
    terminal('task-1', epoch);
    tracker.updateWorkState('deck_proj_brain', NO_WORK);
    const stable = current();

    expect(terminal('task-1', epoch, {
      assistantText: 'late unrelated frame',
      completedEventId: 'late-event',
      completedAt: 999,
    })).toBeUndefined();
    expect(current()).toEqual(stable);
  });

  it('anchors the first correlated terminal result while background work drains', () => {
    const { tracker, begin, terminal, current } = harness();
    const epoch = begin('task-1');
    tracker.updateWorkState('deck_proj_brain', { ...NO_WORK, background: true });
    terminal('task-1', epoch, { assistantText: 'first terminal result', completedEventId: 'first-event' });
    terminal('task-1', epoch, { assistantText: 'late terminal frame', completedEventId: 'late-event' });

    tracker.updateWorkState('deck_proj_brain', NO_WORK);
    expect(current()).toMatchObject({ assistantText: 'first terminal result', completedEventId: 'first-event' });
  });

  it.each([
    ['queued edit', (tracker: PeerAuditBaselineTracker) => tracker.queuedEdit('deck_proj_brain'), 'queued_edit'],
    ['stop', (tracker: PeerAuditBaselineTracker) => tracker.stop('deck_proj_brain'), 'stop'],
    ['cancel', (tracker: PeerAuditBaselineTracker) => tracker.cancel('deck_proj_brain'), 'cancel'],
    ['session replacement', (tracker: PeerAuditBaselineTracker) => tracker.replaceSession('deck_proj_brain'), 'session_replaced'],
    ['runtime replacement', (tracker: PeerAuditBaselineTracker) => tracker.replaceRuntime('deck_proj_brain'), 'runtime_replaced'],
  ] as const)('invalidates on %s', (_label, invalidate, reason) => {
    const { tracker, begin, terminal, current } = harness();
    const epoch = begin('task-1');
    terminal('task-1', epoch);
    tracker.updateWorkState('deck_proj_brain', NO_WORK);
    expect(current()).toBeDefined();

    expect(invalidate(tracker)).toBe(true);
    expect(current()).toBeUndefined();
    expect(tracker.getLastInvalidationReason('deck_proj_brain')).toBe(reason);
  });

  it('does not commit stopped or partial turns', () => {
    const { tracker, begin, terminal, current } = harness();
    const epoch = begin('task-1');
    expect(terminal('task-1', epoch, { terminal: false })).toBeUndefined();
    tracker.updateWorkState('deck_proj_brain', NO_WORK);
    expect(current()).toBeUndefined();

    tracker.stop('deck_proj_brain');
    expect(terminal('task-1', epoch)).toBeUndefined();
    expect(current()).toBeUndefined();
  });

  it.each([
    ['foreground', { foreground: true, background: false, pendingCompletion: false, subagent: false }],
    ['background', { foreground: false, background: true, pendingCompletion: false, subagent: false }],
    ['pending completion', { foreground: false, background: false, pendingCompletion: true, subagent: false }],
    ['subagent', { foreground: false, background: false, pendingCompletion: false, subagent: true }],
  ] as const)('waits while %s work is active', (_label, activeWork) => {
    const { tracker, begin, terminal, current } = harness();
    const epoch = begin('task-1');
    tracker.updateWorkState('deck_proj_brain', activeWork);
    expect(terminal('task-1', epoch)).toBeUndefined();
    expect(current()).toBeUndefined();

    expect(tracker.updateWorkState('deck_proj_brain', NO_WORK)).toMatchObject({ taskCommandId: 'task-1' });
  });

  it('treats active OpenSpec Auto work as blocking and commits its terminal deliver result', () => {
    const { tracker, begin, terminal, current } = harness();
    const generation = begin('openspec-deliver', 'implement the change', 77);
    tracker.updateWorkState('deck_proj_brain', {
      foreground: false,
      background: true,
      pendingCompletion: true,
      subagent: true,
    });
    terminal('openspec-deliver', generation, { supervisorRationale: 'non-authoritative broker context' });
    expect(current()).toBeUndefined();

    const baseline = tracker.updateWorkState('deck_proj_brain', NO_WORK);
    expect(baseline).toMatchObject({
      generationOrEpoch: 77,
      supervisorRationale: 'non-authoritative broker context',
    });
  });

  it('invalidates a committed baseline if work resumes without a new intent', () => {
    const { tracker, begin, terminal, current } = harness();
    const epoch = begin('task-1');
    terminal('task-1', epoch);
    tracker.updateWorkState('deck_proj_brain', NO_WORK);
    expect(current()).toBeDefined();

    tracker.updateWorkState('deck_proj_brain', { ...NO_WORK, background: true });
    expect(current()).toBeUndefined();
    expect(tracker.getLastInvalidationReason('deck_proj_brain')).toBe('work_resumed');
  });

  it('fails closed on identity mismatch, deletion, and daemon restart', () => {
    const { tracker, session, begin, terminal, current } = harness();
    const epoch = begin('task-1');
    terminal('task-1', epoch);
    tracker.updateWorkState(session.sessionName, NO_WORK);
    expect(current()).toBeDefined();
    expect(tracker.getCompletedBaseline({ ...session, auditedRuntimeEpoch: 'replacement' })).toBeUndefined();

    expect(tracker.deleteSession(session.sessionName)).toBe(true);
    expect(current()).toBeUndefined();

    const nextEpoch = begin('task-2');
    terminal('task-2', nextEpoch);
    tracker.updateWorkState(session.sessionName, NO_WORK);
    tracker.resetForDaemonRestart();
    expect(current()).toBeUndefined();
  });
});
