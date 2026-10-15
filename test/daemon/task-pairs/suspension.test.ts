import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { getTaskPairStore, setTaskPairStoreForTests, TaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { pausePair, resumePair, validatePairDependencies } from '../../../src/daemon/task-pairs/suspension.js';
import { sendTaskPairMessage, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { queuedPairWakeAllowed } from '../../../src/daemon/task-pairs/wake-authority.js';
import { resolveTransportQueueEntryAdmission } from '../../../src/daemon/delegation-reply-task-liveness.js';
import { isTaskPairSuspended, TASK_PAIR_MAX_DEPENDENCIES, TASK_PAIR_RESUME_REASON } from '../../../shared/task-pair-suspension.js';
import { taskPairSideToAct, type TaskPairState } from '../../../shared/task-pair.js';
import { removeSession, upsertSession, type SessionRecord } from '../../../src/store/session-store.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';

const P = 'pair-pause-test', B = 'deck_e2e_pause_brain', E = 'deck_e2e_pause_exec', A = 'deck_e2e_pause_aud';
let now: number, busy: Set<string>, messages: Array<{ target: string; id: string; text: string }>;
let automation: TaskPairAutomation;
const state = (id: string, status: TaskPairState['status'] = 'working'): TaskPairState => ({
  taskId: id, brain: B, executor: E, auditor: A, status, title: '暂停与依赖测试', brief: '- [ ][ ] work',
  workspaceKind: 'none', flags: [], flagSides: {}, round: 2, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 2,
  material: { kind: 'report' }, createdAt: now, updatedAt: now,
} as TaskPairState);
const get = (id: string) => getTaskPairStore().getPair(P, id)!.state;
const save = (id: string, status: TaskPairState['status'] = 'working') => getTaskPairStore().savePair(P, state(id, status));
const makeAutomation = () => new TaskPairAutomation({ now: () => now, isBusy: (id) => busy.has(id), isLimited: () => false, importLegacy: () => undefined, mainCheckoutRoots: () => [], brainMainCheckoutActive: () => false });
beforeEach(() => {
  now = Date.now(); busy = new Set(); messages = [];
  process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
  setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  for (const [name, role] of [[B, 'brain'], [E, 'w1'], [A, 'w2']]) upsertSession({ name, role, projectName: P, projectDir: process.env.HOME!, agentType: 'codex-sdk', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: now, updatedAt: now } as SessionRecord);
  setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { messages.push({ target, text, id }); } });
  automation = makeAutomation(); taskPairService.setScheduler(automation);
});
afterEach(async () => {
  automation.stop(); await taskPairService.waitForIdle(); taskPairService.setScheduler(undefined);
  setTaskPairDeliveryDepsForTests(undefined); setTaskPairStoreForTests(undefined);
  for (const id of [B, E, A]) removeSession(id);
  delete process.env.IMCODES_SUPERVISION_ENGINE;
});

describe('durable cooperative suspension', () => {
  it.each(['working', 'in_audit', 'awaiting_audit', 'rework', 'passed', 'queued'] as const)('preserves lifecycle/material and suppresses all nudges (%s)', async (status) => {
    save('task', status); const before = get('task');
    pausePair(P, 'task', B, 'manual', [], 'waiting for owner');
    for (let i = 0; i < 4; i++) { now += 6 * 60_000; await automation.tick(); await automation.checkBothIdlePairs(); automation.publishBadges(); }
    expect(messages).toEqual([]);
    expect(get('task')).toMatchObject({ status, round: before.round, material: before.material, brief: before.brief, scheduling: { manual: true } });
    expect(taskPairSideToAct(get('task'))).toBeUndefined();
  });
  it('pauses idempotently and ordinary stale saves cannot clear it', () => {
    save('task'); const stale = get('task'); pausePair(P, 'task', B, 'manual'); const epoch = get('task').scheduling!.epoch;
    pausePair(P, 'task', B, 'manual'); expect(get('task').scheduling!.epoch).toBe(epoch);
    getTaskPairStore().savePair(P, { ...stale, status: 'in_audit', round: 3 });
    expect(get('task')).toMatchObject({ status: 'in_audit', round: 3, scheduling: { epoch, manual: true } });
  });
  it('waits for a running turn to settle and sends one resume to the preserved audit side', async () => {
    save('task', 'in_audit'); pausePair(P, 'task', B, 'manual'); busy.add(A); resumePair(P, 'task', B);
    await automation.reconcileSuspensions(); expect(messages).toEqual([]); expect(isTaskPairSuspended(get('task'))).toBe(true);
    busy.clear(); await automation.reconcileSuspensions(); await automation.reconcileSuspensions();
    expect(messages).toHaveLength(1); expect(messages[0]!.target).toBe(A); expect(messages[0]!.id).toContain(TASK_PAIR_RESUME_REASON);
    expect(get('task')).toMatchObject({ status: 'in_audit', round: 2, scheduling: { resumePending: false } });
    expect(taskPairSideToAct(get('task'))).toBe('auditor');
  });
  it('persists pause across a real SQLite reopen and rejects stale scheduling CAS writes', () => {
    const path = join(process.env.HOME!, 'pause-state.sqlite'); setTaskPairStoreForTests(new TaskPairStore(path));
    save('task'); pausePair(P, 'task', B, 'manual'); const paused = get('task').scheduling!;
    setTaskPairStoreForTests(undefined); setTaskPairStoreForTests(new TaskPairStore(path));
    expect(get('task').scheduling).toEqual(paused);
    resumePair(P, 'task', B);
    expect(getTaskPairStore().patchScheduling(P, 'task', paused, { ...paused, manual: true }, now)).toBeUndefined();
    expect(get('task').scheduling?.manual).toBe(false);
  });
  it.each(['done', 'cancelled'] as const)('cannot revive a terminal pair (%s)', (status) => {
    save('task', status); expect(() => pausePair(P, 'task', B, 'manual')).toThrow(); expect(() => resumePair(P, 'task', B)).toThrow(); expect(get('task').status).toBe(status);
  });
  it('retains resource claims and refuses non-Brain changes', () => {
    save('task'); const claim = getTaskPairStore().tryClaimResource({ project: P, taskId: 'task', owner: E, resource: 'pause-test-owned-resource', mode: 'exclusive', ttlMs: 60_000, now });
    pausePair(P, 'task', B, 'manual'); expect(getTaskPairStore().listResourceClaimsForPair(P, 'task', now)).toEqual(claim.ok ? [claim.claim] : []);
    expect(() => resumePair(P, 'task', E)).toThrow();
  });
});

describe('event/state-driven dependencies', () => {
  it('waits through PASS; accepted DONE wakes once, not on every check', async () => {
    save('upstream', 'passed'); save('child'); pausePair(P, 'child', B, 'dependencies', ['upstream']);
    await automation.reconcileSuspensions(); expect(messages).toEqual([]);
    getTaskPairStore().savePair(P, { ...get('upstream'), status: 'done' });
    await automation.reconcileSuspensions(); await automation.reconcileSuspensions();
    expect(messages).toHaveLength(1); expect(isTaskPairSuspended(get('child'))).toBe(false);
  });
  it('requires all dependencies and never cancels a manual pause automatically', async () => {
    save('a'); save('b'); save('child'); pausePair(P, 'child', B, 'dependencies', ['a', 'b']); pausePair(P, 'child', B, 'manual');
    getTaskPairStore().savePair(P, { ...get('a'), status: 'done' }); await automation.reconcileSuspensions(); expect(messages).toEqual([]);
    getTaskPairStore().savePair(P, { ...get('b'), status: 'done' }); await automation.reconcileSuspensions();
    expect(get('child').scheduling).toMatchObject({ manual: true, dependsOn: [] }); expect(messages).toEqual([]);
    resumePair(P, 'child', B); await automation.reconcileSuspensions(); expect(messages).toHaveLength(1);
  });
  it('does not bypass dependencies on resume and reports cancellation only once', async () => {
    save('a', 'cancelled'); save('child'); pausePair(P, 'child', B, 'dependencies', ['a']);
    const epoch = get('child').scheduling!.epoch; resumePair(P, 'child', B); expect(get('child').scheduling!.epoch).toBe(epoch);
    for (let i = 0; i < 4; i++) await automation.reconcileSuspensions();
    expect(messages).toHaveLength(1); expect(messages[0]!.target).toBe(B); expect(isTaskPairSuspended(get('child'))).toBe(true);
  });
  it('rejects self/cycles, missing/cross-project ids, too many dependencies; accepts all supported id punctuation', () => {
    for (const id of ['a.b', 'a_b', 'a-b', 'a:b', 'a.b_c-d:e']) save(id);
    save('child'); expect(() => pausePair(P, 'child', B, 'dependencies')).toThrow(); expect(validatePairDependencies(P, 'child', ['a.b_c-d:e'])).toEqual(['a.b_c-d:e']);
    for (const deps of [['child'], ['absent'], Array(TASK_PAIR_MAX_DEPENDENCIES + 1).fill('a.b')]) expect(() => pausePair(P, 'child', B, 'dependencies', deps)).toThrow();
    pausePair(P, 'child', B, 'dependencies', ['a.b']); expect(() => pausePair(P, 'a.b', B, 'dependencies', ['child'])).toThrow();
  });
  it('recovers dependency completion after scheduler/DB restart without another model check', async () => {
    const path = join(process.env.HOME!, 'pause-deps.sqlite'); setTaskPairStoreForTests(new TaskPairStore(path));
    save('a'); save('child'); pausePair(P, 'child', B, 'dependencies', ['a']); getTaskPairStore().savePair(P, { ...get('a'), status: 'done' });
    setTaskPairStoreForTests(undefined); setTaskPairStoreForTests(new TaskPairStore(path)); automation = makeAutomation();
    await automation.reconcileSuspensions(); expect(messages).toHaveLength(1); expect(isTaskPairSuspended(get('child'))).toBe(false);
  });
  it('waits for capacity on resume', async () => {
    save('active'); save('paused'); getTaskPairStore().setMaxConcurrency(B, 1); pausePair(P, 'paused', B, 'manual'); resumePair(P, 'paused', B);
    await automation.reconcileSuspensions(); expect(messages).toEqual([]);
    getTaskPairStore().savePair(P, { ...get('active'), status: 'done' }); await automation.reconcileSuspensions(); expect(messages).toHaveLength(1);
  });
});

describe('durable late-wakeup admission', () => {
  it.each(['task', 'task.with-colon:and_dashes-x'])('rejects pre-pause queued wakeups after pause/resume/restart (%s)', async (id) => {
    save(id); await sendTaskPairMessage(E, id, 'nudge-executor', 'wake'); const oldId = messages[0]!.id;
    expect(queuedPairWakeAllowed(E, oldId)).toBe(true);
    pausePair(P, id, B, 'manual'); expect(queuedPairWakeAllowed(E, oldId)).toBe(false);
    resumePair(P, id, B); await automation.reconcileSuspensions(); expect(queuedPairWakeAllowed(E, oldId)).toBe(false);
    expect(resolveTransportQueueEntryAdmission(E, { clientMessageId: oldId, text: 'wake' })).toBe('stale');
    expect(resolveTransportQueueEntryAdmission(E, { clientMessageId: 'ordinary-human', text: 'hello' })).toBe('authorized');
  });
  it('invalidates queued Brain aggregates and excludes paused pairs from newly built wakes', async () => {
    save('task'); await sendTaskPairMessage(B, '__aggregate__', 'brain-heartbeat', 'task needs action'); const id = messages[0]!.id;
    pausePair(P, 'task', B, 'manual'); expect(queuedPairWakeAllowed(B, id)).toBe(false);
    expect(await sendTaskPairMessage(B, '__aggregate__', 'brain-heartbeat', 'do not wake')).toBe('suspended'); expect(messages).toHaveLength(1);
  });
});

it('releases only quiescent execution slots, without reusing paused sessions', async () => {
  const e2 = 'deck_e2e_pause_spare_exec', a2 = 'deck_e2e_pause_spare_aud';
  for (const [name, role] of [[e2, 'w3'], [a2, 'w4']]) upsertSession({ name, role, projectName: P, projectDir: process.env.HOME!, agentType: 'codex-sdk', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: now, updatedAt: now } as SessionRecord);
  try {
    save('paused'); pausePair(P, 'paused', B, 'manual'); getTaskPairStore().setMaxConcurrency(B, 1);
    getTaskPairStore().savePair(P, { ...state('next', 'queued'), executor: e2, auditor: a2 });
    busy.add(E); await automation.runQueue(P, B); expect(get('next').status).toBe('queued');
    busy.clear(); await automation.runQueue(P, B); await taskPairService.waitForIdle();
    expect(get('next').status).toBe('working'); expect(get('paused').executor).toBe(E); expect(isTaskPairSuspended(get('paused'))).toBe(true);
  } finally { removeSession(e2); removeSession(a2); }
});
it('accepts the maximum dependency count and permits an explicit wait correction', async () => {
  const ids = Array.from({ length: TASK_PAIR_MAX_DEPENDENCIES }, (_, i) => `upstream-${i}`); ids.forEach((id) => save(id, 'done')); save('child');
  pausePair(P, 'child', B, 'dependencies', ids); await automation.reconcileSuspensions(); expect(messages).toHaveLength(1);
  save('bad-upstream', 'cancelled'); pausePair(P, 'child', B, 'dependencies', ['bad-upstream']); await automation.reconcileSuspensions();
  pausePair(P, 'child', B, 'dependencies', []); await automation.reconcileSuspensions(); expect(isTaskPairSuspended(get('child'))).toBe(false);
});
it('legacy colon-id nudges and legacy aggregates cannot return after pause/resume', async () => {
  const id = 'a:b_c-d.e'; save(id); pausePair(P, id, B, 'manual'); resumePair(P, id, B); await automation.reconcileSuspensions();
  for (const old of [`task-pair-nudge:${id}:nudge-executor:old`, 'task-pair-nudge:__aggregate__:brain-heartbeat:old']) expect(resolveTransportQueueEntryAdmission(E === B ? E : (old.includes('__aggregate__') ? B : E), { clientMessageId: old, text: 'old' })).toBe('stale');
});
it('event-triggered dependency completion wakes once without waiting for heartbeat ticks', async () => {
  save('upstream'); save('child'); pausePair(P, 'child', B, 'dependencies', ['upstream']);
  automation.start(60 * 60_000); await automation.waitForSuspensionIdle();
  getTaskPairStore().savePair(P, { ...get('upstream'), status: 'done' }); await automation.waitForSuspensionIdle();
  expect(messages.filter((m) => m.id.includes(TASK_PAIR_RESUME_REASON))).toHaveLength(1);
  await automation.reconcileSuspensions(); expect(messages.filter((m) => m.id.includes(TASK_PAIR_RESUME_REASON))).toHaveLength(1);
});
it('normal legacy lifecycle saves do not introduce a scheduling field', () => {
  save('legacy'); getTaskPairStore().savePair(P, { ...get('legacy'), status: 'in_audit' });
  expect(get('legacy')).not.toHaveProperty('scheduling');
});
it('pause/resume invalidates an already armed Brain follow-up', async () => {
  const { BrainDecisionFollowUps } = await import('../../../src/daemon/task-pairs/brain-decision-followup.js');
  save('decision', 'awaiting_brain_decision');
  const followUps: string[] = [];
  const follow = new BrainDecisionFollowUps({ now: () => now, send: async (_brain, _reason, text) => { followUps.push(text); return 'sent'; } });
  follow.arm({ brain: B, taskIds: ['decision'], messageIdPrefix: 'notice', result: 'sent' });
  follow.observe({ sessionId: B, type: 'session.state', payload: { state: 'running' } });
  pausePair(P, 'decision', B, 'manual'); resumePair(P, 'decision', B); await automation.reconcileSuspensions();
  follow.observe({ sessionId: B, type: 'session.state', payload: { state: 'idle' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(followUps).toEqual([]); expect(messages).toEqual([]);
});


describe('asynchronous scheduling epochs', () => {
  it('cannot reassign from a provisioning operation started before pause/resume', async () => {
    save('task', 'in_audit');
    let release!: (name: string) => void;
    const provisioned = new Promise<string>((resolve) => { release = resolve; });
    const replacement = new TaskPairAutomation({ now: () => now, isBusy: () => false,
      pickCandidate: () => undefined, provision: () => provisioned });
    const pending = replacement.replaceAuditor(P, 'task', 'test stale provisioning', { dueToLimit: true });
    pausePair(P, 'task', B, 'manual'); resumePair(P, 'task', B);
    await automation.reconcileSuspensions(); messages.length = 0;
    release('new-auditor');
    expect(await pending).toBe(false);
    expect(get('task').auditor).toBe(A); expect(messages).toEqual([]);
    replacement.stop();
  });
  it('uses a stable resume delivery id on retry after an uncertain send outcome', async () => {
    save('task'); pausePair(P, 'task', B, 'manual'); resumePair(P, 'task', B);
    const ids: string[] = [];
    setTaskPairDeliveryDepsForTests({ send: async (_target, _text, id) => { ids.push(id); if (ids.length === 1) throw new Error('uncertain send'); } });
    await expect(automation.reconcileSuspensions()).rejects.toThrow('uncertain send');
    await automation.reconcileSuspensions();
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
    expect(isTaskPairSuspended(get('task'))).toBe(false);
  });
});


describe('bounded reconciliation cost', () => {
  it('does not deserialize full unrelated briefs or call models when checking a large active list', async () => {
    for (let i = 0; i < 500; i++) getTaskPairStore().savePair(P, { ...state(`ordinary-${i}`), brief: 'x'.repeat(20_000) });
    save('upstream'); save('child'); pausePair(P, 'child', B, 'dependencies', ['upstream']);
    const started = performance.now();
    for (let i = 0; i < 10; i++) await automation.reconcileSuspensions();
    const elapsed = performance.now() - started;
    console.info(`pause-reconcile: 502 active pairs, 20KB unrelated briefs, 10 passes = ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(5_000); expect(messages).toEqual([]);
  });
});
