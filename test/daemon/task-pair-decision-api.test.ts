import { putTaskPairFixture } from '../helpers/task-pair-fixture.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { taskPairService } from '../../src/daemon/task-pairs/service.js';
import { setTaskPairDeliveryDepsForTests } from '../../src/daemon/task-pairs/delivery.js';
import { taskPairDecisionApi } from '../../src/daemon/task-pairs/decision-api.js';
import { taskPairDecisionRevision } from '../../src/daemon/task-pairs/decision-context.js';
import { TASK_PAIR_DECISION_BRAIN_NOTICE_REASON, TASK_PAIR_DECISION_MSG } from '../../shared/task-pair-decision.js';
import { encodePairWake, pairWakeBindings, queuedPairWakeAllowed } from '../../src/daemon/task-pairs/wake-authority.js';
import { TASK_PAIR_NUDGE_ID_PREFIX } from '../../shared/task-pair.js';
import type { TaskPairState } from '../../shared/task-pair.js';
const scope = { projectName: 'decision-project', coordinatorSessionName: 'deck_decision_brain' };
const state = { taskId: 'blocked-task', title: 'Blocked task', brain: scope.coordinatorSessionName,
  executor: 'deck_sub_decision_exec', auditor: 'none', status: 'working', round: 1,
  flags: ['needs_input'], flagSides: { needs_input: 'executor' }, blocking: ['P0'], blockedNote: 'Which data source?',
  scheduling: { epoch: 1, manual: true, dependsOn: ['dependency'], since: 1, writer: scope.coordinatorSessionName, note: 'Need an approved source' },
  previousAuditors: [], createdAt: 1, updatedAt: 1 } as TaskPairState;
const notifications: string[] = [];
beforeEach(() => {
  const store = new TaskPairStore(':memory:'); setTaskPairStoreForTests(store); putTaskPairFixture(store, scope.projectName, state);
  notifications.length = 0;
  setTaskPairDeliveryDepsForTests({ send: async (_target, text) => { notifications.push(String(text)); } });
});
afterEach(async () => { await taskPairService.waitForIdle(); setTaskPairDeliveryDepsForTests(undefined); setTaskPairStoreForTests(undefined); });
function ask() {
  return taskPairService.recordDecision({ project: scope.projectName, taskId: state.taskId, round: 1, kind: 'request',
    conclusion: 'Choose source', summary: 'Need a data-source ruling', question: 'Use test data or wait for production approval?',
    options: [{ id: 'test', label: 'Use test data' }, { id: 'wait', label: 'Wait for approval' }], recommendation: 'Use test data',
    author: state.executor!, at: Date.now(), idempotencyKey: 'question-1' }).record;
}
function reply(over: Record<string, unknown> = {}) {
  const question = getTaskPairStore().listDecisions(scope.projectName, [state.taskId]).find((row) => row.kind === 'request');
  return { type: TASK_PAIR_DECISION_MSG.FEEDBACK, taskId: state.taskId, requestId: 'reply-1', round: 1,
    revision: taskPairDecisionRevision(state), questionId: question?.id ?? null, optionId: 'test', feedback: 'Keep production untouched', ...over };
}
describe('durable task decisions and human feedback', () => {
  it('binds the selected option and original question, notifies Brain, and never resumes or clears dependencies', async () => {
    const question = ask();
    const before = getTaskPairStore().getPair(scope.projectName, state.taskId)!.state;
    const answer = taskPairDecisionApi(scope, reply());
    const feedback = answer.decisions[0]!;
    expect(feedback).toMatchObject({ kind: 'feedback', requestId: question.id, selectedOptionId: 'test', author: 'human',
      question: question.question, summary: 'Keep production untouched' });
    expect(getTaskPairStore().getPair(scope.projectName, state.taskId)!.state).toEqual(before);
    await taskPairService.waitForIdle();
    expect(getTaskPairStore().listPendingDecisionNotifications()).toEqual([]);
    expect(notifications.some((text) => text.includes('Human feedback') && text.includes('Use test data or wait for production approval?'))).toBe(true);
  });
  it('deduplicates a retry even if the task changed after the persisted feedback', () => {
    ask(); const input = reply();
    taskPairDecisionApi(scope, input);
    putTaskPairFixture(getTaskPairStore(), scope.projectName, { ...state, status: 'done' });
    expect(taskPairDecisionApi(scope, input).decisions.filter((row) => row.kind === 'feedback')).toHaveLength(1);
  });
  it.each([{ optionId: 'unknown' }, { questionId: 'another-task-question' }, { round: 2 }, { revision: 'stale' }])('rejects stale/cross-question feedback %j', (over) => {
    ask(); expect(() => taskPairDecisionApi(scope, reply(over))).toThrow();
    expect(getTaskPairStore().listDecisions(scope.projectName, [state.taskId]).filter((row) => row.kind === 'feedback')).toEqual([]);
  });
  it('rejects another Brain scope without exposing its history', () => {
    ask(); expect(() => taskPairDecisionApi({ ...scope, coordinatorSessionName: 'other' }, { ...reply(), type: TASK_PAIR_DECISION_MSG.HISTORY })).toThrow();
  });
  it('stores a free-text reply for legacy paused tasks that have only a blocker note', () => {
    const result = taskPairDecisionApi(scope, reply({ optionId: undefined }));
    expect(result.decisions[0]).toMatchObject({ kind: 'feedback', question: state.blockedNote });
  });
  it('lets explicit decision notices reach paused Brain, never workers or stale wake bindings', () => {
    const bindings = pairWakeBindings(state.brain, state.taskId);
    const id = TASK_PAIR_NUDGE_ID_PREFIX + encodePairWake(bindings, TASK_PAIR_DECISION_BRAIN_NOTICE_REASON);
    expect(queuedPairWakeAllowed(state.brain, id)).toBe(true);
    expect(queuedPairWakeAllowed(state.executor!, id)).toBe(false);
    const heartbeat = TASK_PAIR_NUDGE_ID_PREFIX + encodePairWake(bindings, 'heartbeat');
    expect(queuedPairWakeAllowed(state.brain, heartbeat)).toBe(false);
    getTaskPairStore().patchScheduling(scope.projectName, state.taskId, state.scheduling, { ...state.scheduling!, epoch: 2 }, 20);
    expect(queuedPairWakeAllowed(state.brain, id)).toBe(false);
  });
  it('rejects new feedback after the Brain recorded a ruling for the question', () => {
    const question = ask();
    taskPairService.recordDecision({ project: scope.projectName, taskId: state.taskId, round: 1, kind: 'decision', requestId: question.id,
      conclusion: 'Approved', summary: 'Test data only', author: state.brain, at: question.at + 1 });
    expect(() => taskPairDecisionApi(scope, reply())).toThrow(/resolved/);
  });
  it('keeps the context stable under heartbeat-only updates but changes it with the blocker', () => {
    expect(taskPairDecisionRevision({ ...state, updatedAt: 999 })).toBe(taskPairDecisionRevision(state));
    expect(taskPairDecisionRevision({ ...state, blockedNote: 'New question' })).not.toBe(taskPairDecisionRevision(state));
  });
  it('keeps the question actionable after more feedback rows than the history page size', () => {
    const question = ask();
    for (let i = 0; i < 25; i++) getTaskPairStore().recordDecision({ project: scope.projectName, taskId: state.taskId,
      round: 1, kind: 'feedback', conclusion: 'Info', summary: 'More context', author: 'human', at: question.at + i + 1 });
    expect(() => taskPairDecisionApi(scope, reply({ questionId: question.id }))).not.toThrow();
  });
  it('upgrades an old database without losing existing decisions and survives another restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-test-decisions-'));
    const path = join(dir, 'pairs.sqlite');
    try {
      const old = new TaskPairStore(path);
      old.recordDecision({ project: 'old-project', taskId: 'old-task', round: 1, kind: 'decision',
        conclusion: 'Preserved', summary: 'Existing data', author: 'old-brain', at: 1 }); old.close();
      const legacy = new DatabaseSync(path); legacy.exec('ALTER TABLE task_pair_decisions DROP COLUMN details_json'); legacy.close();
      const upgraded = new TaskPairStore(path);
      const anotherWriter = new TaskPairStore(path);
      expect(upgraded.listDecisions('old-project', ['old-task'])[0]).toMatchObject({ conclusion: 'Preserved' });
      upgraded.recordDecision({ project: 'old-project', taskId: 'new-task', round: 1, kind: 'request',
        conclusion: 'Choose', summary: 'New question', author: 'worker', at: 2,
        question: 'Source?', options: [{ id: 'test', label: 'Fixture' }] });
      upgraded.close(); anotherWriter.close();
      const restarted = new TaskPairStore(path);
      expect(restarted.latestDecisionRequest('old-project', 'new-task', 1)).toMatchObject({ question: 'Source?', options: [{ id: 'test', label: 'Fixture' }] });
      restarted.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not reuse an old delivery round question when audit numbering restarts', () => {
    const oldQuestion = ask();
    const next = { ...state, deliveryRound: 2 };
    putTaskPairFixture(getTaskPairStore(), scope.projectName, next);
    expect(() => taskPairDecisionApi(scope, reply({ revision: taskPairDecisionRevision(next), questionId: oldQuestion.id }))).toThrow(/changed/);
    expect(getTaskPairStore().latestDecisionRequest(scope.projectName, state.taskId, 1, 2)).toBeUndefined();
    const nextQuestion = taskPairService.recordDecision({ project: scope.projectName, taskId: state.taskId, round: 1, kind: 'request',
      conclusion: 'New question', summary: 'Round two', question: 'New source?', author: state.executor! }).record;
    const result = taskPairDecisionApi(scope, reply({ revision: taskPairDecisionRevision(next), questionId: nextQuestion.id, optionId: undefined }));
    expect(result.decisions[0]).toMatchObject({ kind: 'feedback', deliveryRound: 2, requestId: nextQuestion.id });
  });
  it('validates duplicate, excessive and oversized options', () => {
    expect(() => taskPairService.recordDecision({ ...ask(), idempotencyKey: 'invalid', options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] })).toThrow();
  });
});
