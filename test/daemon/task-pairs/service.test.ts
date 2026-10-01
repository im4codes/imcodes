import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { resetTaskPairTerminalStreamRecoveryForTests, TaskPairService, type TaskPairScheduler } from '../../../src/daemon/task-pairs/service.js';
import { timelineStore } from '../../../src/daemon/timeline-store.js';
import { resolveTaskPairEngine, resolveTaskPairEngineState, resolveTaskPairMaxConcurrency } from '../../../src/daemon/task-pairs/engine.js';
import { normalizeSessionSupervisionSnapshot } from '../../../shared/supervision-config.js';
import { dispatchSendMessage, clearSendIdempotencyCacheForTests } from '../../../src/daemon/send-tool.js';
import { TASK_PAIR_TERMINAL_FLUSH_FIELD, TASK_PAIR_TIMELINE_EVENT, taskPairBindingId } from '../../../shared/task-pair.js';
import {
  DELEGATION_AUTHORITY_MCP_SERVER,
  DELEGATION_CLAIM_METADATA_FIELD,
  projectDelegationClaim,
  readDelegationClaim,
  readDelegationDispatchFact,
} from '../../../shared/delegation-claim.js';
import { normalizeAssistantTextForDisplay } from '../../../src/shared/timeline/types.js';

const PROJECT = 'pairsproj';
const BRAIN = 'deck_pairsproj_brain';
const EXEC = 'deck_sub_pairsexec';
const AUD = 'deck_sub_pairsaud';
const AUD2 = 'deck_sub_pairsaud2';
const PROC = 'deck_pairsproj_w1';
const OTHER_PROJECT_SESSION = 'deck_otherproj_brain';

function session(name: string, role: SessionRecord['role'], agentType = 'claude-code-sdk', projectName = PROJECT): SessionRecord {
  return {
    name, projectName, role, agentType, projectDir: `/tmp/${projectName}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

let service: TaskPairService;
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;

/**
 * A DISPATCH marker now queues before it starts (owner rule, tsk_cd_dispatch_default:
 * DISPATCH is capacity-gated exactly like QUEUE). This suite tests the service
 * layer in isolation from the real pool/capacity machinery in scheduler.ts, so
 * it wires the minimal stand-in a `TaskPairScheduler` needs here: a pair
 * already naming both roles starts the moment its slot frees, with no pool,
 * pick or capacity logic of its own to test.
 */
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
    // `source: 'queue'` deliberately suppresses service.ts's own auto-brief
    // (the real queue runner briefs participants itself right after
    // starting a pair; see scheduler.ts#runQueueOnce) -- this stand-in does
    // the same, so a starting pair is briefed exactly once either way.
    await service.briefParticipants(project, pairState.taskId);
  },
};

/** Drains every tracked background operation (intents, briefs, queue starts), transitively. */
async function flush() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (service.pendingCount === 0) return;
  }
}

/** Emit a final assistant turn and wait for the deferred ingestion (and any queue start it triggers) to run. */
async function say(sessionName: string, text: string, extra: Record<string, unknown> = {}, eventId?: string) {
  turn += 1;
  timelineEmitter.emit(sessionName, 'assistant.text', { text, streaming: false, ...extra }, {
    source: 'daemon', confidence: 'high', eventId: eventId ?? `turn-${turn}`,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
}

function pair(taskId: string) {
  return getTaskPairStore().getPair(PROJECT, taskId)?.state;
}

describe('task-pair marker ingestion', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    for (const record of [
      session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3'), session(AUD2, 'w4'), session(PROC, 'w1', 'claude-code'),
      session(OTHER_PROJECT_SESSION, 'brain', 'claude-code-sdk', 'otherproj'),
    ]) upsertSession(record);
    service = new TaskPairService();
    service.init();
    service.setScheduler(testScheduler);
  });

  afterEach(async () => {
    await service.dispose();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD, AUD2, PROC, OTHER_PROJECT_SESSION]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('applies markers from a transport session and mirrors the event to every participant', async () => {
    const seen: Array<{ session: string; payload: Record<string, unknown> }> = [];
    const off = timelineEmitter.on((event) => {
      if (event.type === TASK_PAIR_TIMELINE_EVENT) seen.push({ session: event.sessionId, payload: event.payload });
    });
    await say(BRAIN, `Dispatching.\n<!-- IMCODES_TASK DISPATCH T1 executor=${EXEC} auditor=${AUD} title="Fix login" -->`);
    off();
    expect(pair('T1')).toMatchObject({ status: 'working', brain: BRAIN, executor: EXEC, auditor: AUD, title: 'Fix login' });
    expect(new Set(seen.map((entry) => entry.session))).toEqual(new Set([BRAIN, EXEC, AUD]));
    // DISPATCH is capacity-gated like QUEUE: the Brain's own marker queues the
    // pair first (this is that event), then the daemon's own queue-drain
    // starts it (a second, separately-recorded event) once a slot is free.
    expect(seen[0]?.payload).toMatchObject({ taskId: 'T1', verb: 'DISPATCH', toStatus: 'queued', role: 'brain', source: 'marker' });
  });

  it('returns one delivery receipt per participant and does not auto-send before the structured caller awaits it', async () => {
    const transition = service.implicitDispatch({
      project: PROJECT,
      sender: BRAIN,
      target: EXEC,
      taskId: 'structured-receipts',
      auditor: AUD,
      brief: 'A structured pair brief.',
      hasObjective: true,
      eventId: 'structured-receipts-create',
      suppressAutomaticBrief: true,
    });
    expect(transition?.effect).toBe('created');
    expect(sent).toHaveLength(0);
    const deliveries = await service.briefParticipantsWithReceipts(PROJECT, 'structured-receipts');
    expect(deliveries).toEqual([
      { role: 'executor', target: EXEC, status: 'sent' },
      { role: 'auditor', target: AUD, status: 'sent' },
    ]);
    expect(sent.map((item) => item.target)).toEqual([EXEC, AUD]);
  });

  it('keeps named DISPATCH, REASSIGN, and implicit dispatch participants queued when another pair holds them', () => {
    // Keep this test at the service boundary: the real scheduler is covered
    // separately, while this proves every role-binding entry path supplies
    // the same cross-pair reservation guard.
    service.setScheduler({ onIntent: () => undefined });
    const apply = (writer: string, taskId: string, verb: 'DISPATCH' | 'REASSIGN', attrs: Record<string, string>, source: 'marker' | 'queue' = 'marker') => service.applyMarker({
      project: PROJECT,
      writer,
      marker: { verb, knownVerb: verb, taskId, attrs },
      source,
      eventId: `busy-${taskId}-${verb}-${source}`,
    });
    apply(BRAIN, 'holding', 'DISPATCH', { executor: EXEC, auditor: AUD });
    apply('daemon', 'holding', 'DISPATCH', { executor: EXEC, auditor: AUD }, 'queue');
    expect(pair('holding')).toMatchObject({ status: 'working', executor: EXEC, auditor: AUD });

    apply(BRAIN, 'named-new', 'DISPATCH', { executor: EXEC, auditor: AUD });
    expect(pair('named-new')).toMatchObject({ status: 'queued', executor: EXEC, auditor: AUD, flags: ['waiting_for_capacity'] });
    expect(sent.some((entry) => entry.target === BRAIN && entry.text.includes('holding'))).toBe(true);

    apply(BRAIN, 'reassigned', 'DISPATCH', { executor: PROC, auditor: 'none' });
    apply('daemon', 'reassigned', 'DISPATCH', { executor: PROC, auditor: 'none' }, 'queue');
    apply(BRAIN, 'reassigned', 'REASSIGN', { executor: EXEC });
    expect(pair('reassigned')).toMatchObject({ status: 'queued', executor: EXEC, flags: ['waiting_for_capacity'] });

    const implicit = service.implicitDispatch({
      project: PROJECT, sender: BRAIN, target: EXEC, taskId: 'implicit-new', hasObjective: true,
      brief: 'new work', eventId: 'busy-implicit-new',
    });
    expect(implicit?.pair).toMatchObject({ status: 'queued', executor: EXEC });
    expect(pair('implicit-new')).toMatchObject({ status: 'queued', executor: EXEC, flags: ['waiting_for_capacity'] });
  });

  it('resolves executor and auditor waits from a Brain task-bound reply', () => {
    service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'brain-resolve-exec', attrs: { executor: EXEC, auditor: AUD } }, source: 'marker', eventId: 'resolve-dispatch-exec' });
    service.applyMarker({ project: PROJECT, writer: EXEC, marker: { verb: 'BLOCKED', knownVerb: 'BLOCKED', taskId: 'brain-resolve-exec', attrs: { note: 'waiting for a decision' } }, source: 'marker', eventId: 'resolve-blocked-exec' });
    getTaskPairStore().saveLiveness(PROJECT, 'brain-resolve-exec', {
      ...getTaskPairStore().getPair(PROJECT, 'brain-resolve-exec')!.liveness,
      brainWaitKey: 'brain-resolve-exec:blocked', brainReminderDue: true, brainReminderCount: 2,
      brainReminderLastDecisionReason: 'brain_busy',
    });
    const resolvedExec = service.implicitDispatch({ project: PROJECT, sender: BRAIN, target: EXEC, taskId: 'brain-resolve-exec', eventId: 'resolve-brain-exec' });
    expect(resolvedExec?.effect).toBe('brain_resolved');
    expect(pair('brain-resolve-exec')).toMatchObject({ status: 'working', flags: [] });
    expect(pair('brain-resolve-exec')?.blockedNote).toBeUndefined();
    const resolvedLiveness = getTaskPairStore().getPair(PROJECT, 'brain-resolve-exec')?.liveness;
    expect(resolvedLiveness?.brainReminderCount).toBe(0);
    expect(resolvedLiveness?.brainReminderDue).toBeUndefined();
    expect(resolvedLiveness?.brainWaitKey).toBeUndefined();
    expect(resolvedLiveness?.brainReminderLastDecisionReason).toBeUndefined();
    expect(getTaskPairStore().listEvents(PROJECT, 'brain-resolve-exec').some((event) => event.verb === 'BRAIN_RESOLVED' && event.attrs.messageId === 'resolve-brain-exec')).toBe(true);

    service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'brain-resolve-aud', attrs: { executor: PROC, auditor: AUD2 } }, source: 'marker', eventId: 'resolve-dispatch-aud' });
    service.applyMarker({ project: PROJECT, writer: AUD2, marker: { verb: 'NEEDS_INPUT', knownVerb: 'NEEDS_INPUT', taskId: 'brain-resolve-aud', attrs: { note: 'need scope' } }, source: 'marker', eventId: 'resolve-needs-aud' });
    const resolvedAud = service.implicitDispatch({ project: PROJECT, sender: BRAIN, target: AUD2, taskId: 'brain-resolve-aud', eventId: 'resolve-brain-aud' });
    expect(resolvedAud?.effect).toBe('brain_resolved');
    expect(pair('brain-resolve-aud')).toMatchObject({ status: 'working', flags: [] });
    expect(pair('brain-resolve-aud')?.blockedNote).toBeUndefined();
  });

  it('resumes awaiting-brain-decision and rejects non-Brain replies', () => {
    service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'brain-awaiting', attrs: { executor: EXEC, auditor: 'none' } }, source: 'marker', eventId: 'awaiting-dispatch' });
    service.applyMarker({ project: PROJECT, writer: EXEC, marker: { verb: 'DONE', knownVerb: 'DONE', taskId: 'brain-awaiting', attrs: {} }, source: 'marker', eventId: 'awaiting-done' });
    expect(pair('brain-awaiting')?.status).toBe('awaiting_brain_decision');
    const resumed = service.implicitDispatch({ project: PROJECT, sender: BRAIN, target: EXEC, taskId: 'brain-awaiting', eventId: 'awaiting-brain-reply' });
    expect(resumed?.effect).toBe('brain_resolved');
    expect(pair('brain-awaiting')?.status).toBe('working');

    service.applyMarker({ project: PROJECT, writer: EXEC, marker: { verb: 'BLOCKED', knownVerb: 'BLOCKED', taskId: 'brain-awaiting', attrs: { note: 'new wait' } }, source: 'marker', eventId: 'awaiting-reraise' });
    const ignored = service.implicitDispatch({ project: PROJECT, sender: AUD, target: EXEC, taskId: 'brain-awaiting', eventId: 'non-brain-reply' });
    expect(ignored?.effect).toBe('recorded');
    expect(pair('brain-awaiting')).toMatchObject({ flags: ['blocked'], blockedNote: 'new wait' });
  });

  it('Brain WORKING reopens a passed pair, invalidates the head, and rejects old-head DONE', async () => {
    service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'brain-reopen', attrs: { executor: EXEC, auditor: AUD } }, source: 'marker', eventId: 'reopen-dispatch' });
    service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'brain-reopen', attrs: { worktree: '/tmp/reopen', head: 'head-1', base: 'base-1' } }, source: 'marker', eventId: 'reopen-ready-1' });
    service.applyMarker({ project: PROJECT, writer: AUD, marker: { verb: 'PASS', knownVerb: 'PASS', taskId: 'brain-reopen', attrs: { blocking: 'P0' } }, source: 'marker', eventId: 'reopen-pass-1' });
    expect(pair('brain-reopen')).toMatchObject({ status: 'passed', passRound: 1, material: { head: 'head-1' } });

    const reopened = service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'WORKING', knownVerb: 'WORKING', taskId: 'brain-reopen', attrs: { note: 'merge review rejected this head' } },
      source: 'marker', eventId: 'reopen-working',
    });
    expect(reopened).toMatchObject({ effect: 'reopened', fromStatus: 'passed', toStatus: 'working' });
    expect(pair('brain-reopen')).toMatchObject({ status: 'working' });
    expect(pair('brain-reopen')?.passRound).toBeUndefined();
    expect(pair('brain-reopen')?.material).toBeUndefined();
    expect(pair('brain-reopen')?.lastVerdict).toBeUndefined();
    const reopenTargets = sent.filter((entry) => entry.id.includes(':brain-reopen:')).map((entry) => entry.target);
    expect(reopenTargets).toContain(EXEC);
    expect(reopenTargets).toContain(AUD);
    expect(getTaskPairStore().listEvents(PROJECT, 'brain-reopen').some((event) => (
      event.effect === 'reopened' && event.attrs.note === 'merge review rejected this head'
    ))).toBe(true);

    const oldDone = service.applyMarker({ project: PROJECT, writer: EXEC, marker: { verb: 'DONE', knownVerb: 'DONE', taskId: 'brain-reopen', attrs: {} }, source: 'marker', eventId: 'reopen-old-done' });
    expect(oldDone.effect).toBe('recorded');
    expect(oldDone.unusual).toBe(true);
    expect(pair('brain-reopen')?.status).toBe('working');

    service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'brain-reopen', attrs: { worktree: '/tmp/reopen', head: 'head-2', base: 'base-1' } }, source: 'marker', eventId: 'reopen-ready-2' });
    service.applyMarker({ project: PROJECT, writer: AUD, marker: { verb: 'PASS', knownVerb: 'PASS', taskId: 'brain-reopen', attrs: { blocking: 'P0' } }, source: 'marker', eventId: 'reopen-pass-2' });
    expect(pair('brain-reopen')).toMatchObject({ status: 'passed', passRound: 2, material: { head: 'head-2' } });
    await flush();
  });

  it('only Brain can reopen a passed pair; Brain REWORK reopens without material', () => {
    service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'brain-rework-reopen', attrs: { executor: EXEC, auditor: AUD } }, source: 'marker', eventId: 'rework-reopen-dispatch' });
    service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'brain-rework-reopen', attrs: { worktree: '/tmp/reopen', head: 'head-1', base: 'base-1' } }, source: 'marker', eventId: 'rework-reopen-ready' });
    service.applyMarker({ project: PROJECT, writer: AUD, marker: { verb: 'PASS', knownVerb: 'PASS', taskId: 'brain-rework-reopen', attrs: { blocking: 'P0' } }, source: 'marker', eventId: 'rework-reopen-pass' });
    const participant = service.applyMarker({ project: PROJECT, writer: EXEC, marker: { verb: 'WORKING', knownVerb: 'WORKING', taskId: 'brain-rework-reopen', attrs: {} }, source: 'marker', eventId: 'rework-reopen-participant' });
    expect(participant.effect).toBe('recorded');
    expect(pair('brain-rework-reopen')?.status).toBe('passed');
    const reopened = service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'REWORK', knownVerb: 'REWORK', taskId: 'brain-rework-reopen', attrs: { note: 'rework required after merge review', blocking: 'P0', p0: '1' } }, source: 'marker', eventId: 'rework-reopen-brain' });
    expect(reopened).toMatchObject({ effect: 'reopened', toStatus: 'rework' });
    expect(pair('brain-rework-reopen')?.status).toBe('rework');
    expect(pair('brain-rework-reopen')?.material).toBeUndefined();
    expect(pair('brain-rework-reopen')?.passRound).toBeUndefined();
  });

  it('keeps DISPATCH deduplication independent per executor target', () => {
    for (const [taskId, target] of [['D1', EXEC], ['D2', PROC]] as const) {
      service.applyMarker({ project: PROJECT, writer: BRAIN, marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId, attrs: { executor: target, auditor: AUD } }, source: 'marker', now: Date.now(), eventId: `dedup-${taskId}` });
    }
    expect(service.recentBrainDispatch(PROJECT, BRAIN, EXEC)).toBe('D1');
    expect(service.recentBrainDispatch(PROJECT, BRAIN, PROC)).toBe('D2');
    expect(service.recentBrainDispatch(PROJECT, BRAIN, EXEC)).toBeUndefined();
  });

  it('ingests after the emit returns, off the relay call stack', async () => {
    timelineEmitter.emit(BRAIN, 'assistant.text', {
      text: `<!-- IMCODES_TASK DISPATCH T12 executor=${EXEC} auditor=${AUD} -->`, streaming: false,
    }, { source: 'daemon', confidence: 'high', eventId: 'deferred-turn' });
    expect(pair('T12')).toBeUndefined();
    await flush();
    expect(pair('T12')?.status).toBe('working');
  });

  it('applies markers from a process session exactly like a transport one', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T2 executor=${PROC} auditor=${AUD} -->`);
    await say(PROC, 'Implemented.\n<!-- IMCODES_TASK READY_FOR_AUDIT T2 -->');
    expect(pair('T2')).toMatchObject({ status: 'in_audit', round: 1 });
  });

  it('auto-ticks implemented items on READY and both boxes on PASS, recording each tick', async () => {
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE T-check title="Checklist" auditor=' + AUD + ' -->\n- [ ][ ] first\n- [ ][ ] second\n<!-- IMCODES_TASK_END T-check -->');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T-check executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T-check path=/workspace -->');
    expect(pair('T-check')?.brief).toContain('- [x][ ] first');
    expect(pair('T-check')?.brief).toContain('- [x][ ] second');
    expect(getTaskPairStore().listEvents(PROJECT, 'T-check').filter((event) => event.verb === 'CHECKLIST_AUTO_TICK')).toHaveLength(1);
    await say(AUD, '<!-- IMCODES_TASK PASS T-check -->');
    expect(pair('T-check')?.brief).toBe('- [x][x] first\n- [x][x] second');
    expect(getTaskPairStore().listEvents(PROJECT, 'T-check').filter((event) => event.verb === 'CHECKLIST_AUTO_TICK')).toHaveLength(2);
  });

  it('fills remaining implemented boxes when READY receives a partially checked brief', async () => {
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE T-partial title="Checklist" auditor=' + AUD + ' -->\n- [x][ ] first\n- [ ][ ] second\n<!-- IMCODES_TASK_END T-partial -->');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T-partial executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T-partial path=/workspace -->');
    expect(pair('T-partial')?.brief).toBe('- [x][ ] first\n- [x][ ] second');
    const ticks = getTaskPairStore().listEvents(PROJECT, 'T-partial').filter((event) => event.verb === 'CHECKLIST_AUTO_TICK');
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.attrs).toMatchObject({ box: 'implemented', items: '2', checked: 'true' });
  });

  it('auto-ticks implemented items when an auditor=none executor reports DONE', async () => {
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE T-no-audit title="Checklist" auditor=none -->\n- [ ][ ] first\n<!-- IMCODES_TASK_END T-no-audit -->');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T-no-audit executor=${EXEC} auditor=none -->`);
    await say(EXEC, '<!-- IMCODES_TASK DONE T-no-audit -->');
    expect(pair('T-no-audit')?.status).toBe('awaiting_brain_decision');
    expect(pair('T-no-audit')?.brief).toBe('- [x][ ] first');
    expect(getTaskPairStore().listEvents(PROJECT, 'T-no-audit').some((event) => event.verb === 'CHECKLIST_AUTO_TICK')).toBe(true);
  });

  it('never applies the same turn twice', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T3 executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T3 path=/workspace -->', {}, 'fixed-turn');
    await say(AUD, '<!-- IMCODES_TASK REWORK T3 blocking=P0 p0=1 -->');
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T3 path=/workspace -->', {}, 'fixed-turn');
    expect(pair('T3')).toMatchObject({ status: 'rework', round: 1 });
    // DISPATCH now records two events (queued, then the queue-drain's own
    // start), plus READY_FOR_AUDIT and REWORK -- the repeated 'fixed-turn'
    // READY_FOR_AUDIT is still deduplicated, so it is not a fifth.
    expect(getTaskPairStore().listEvents(PROJECT, 'T3')).toHaveLength(4);
  });

  it('does not let a queued pair reserve its named participants', () => {
    service.setScheduler({ onIntent: () => undefined });
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'QUEUE', knownVerb: 'QUEUE', taskId: 'queued-free', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', eventId: 'queued-free-create',
    });
    expect(pair('queued-free')?.status).toBe('queued');
    expect(getTaskPairStore().isParticipantOfOpenPair(EXEC)).toBe(false);
  });

  it('deduplicates identical verdict markers with different event ids in one round', () => {
    service.setScheduler({ onIntent: () => undefined });
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'verdict-dedup', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', eventId: 'verdict-dispatch',
    });
    service.applyMarker({
      project: PROJECT, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'verdict-dedup', attrs: { executor: EXEC, auditor: AUD } },
      source: 'queue', eventId: 'verdict-queue',
    });
    service.applyMarker({
      project: PROJECT, writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'verdict-dedup', attrs: { worktree: '/w', head: 'h1', base: 'b1' } },
      source: 'marker', now: 1_000, eventId: 'verdict-ready',
    });
    service.applyMarker({
      project: PROJECT, writer: AUD,
      marker: { verb: 'REWORK', knownVerb: 'REWORK', taskId: 'verdict-dedup', attrs: { blocking: 'P0', p0: '1' } },
      source: 'marker', now: 2_000, eventId: 'verdict-rework-1',
    });
    service.applyMarker({
      project: PROJECT, writer: AUD,
      marker: { verb: 'REWORK', knownVerb: 'REWORK', taskId: 'verdict-dedup', attrs: { blocking: 'P0', p0: '1' } },
      source: 'marker', now: 2_001, eventId: 'verdict-rework-2',
    });
    expect(getTaskPairStore().listEvents(PROJECT, 'verdict-dedup').filter((event) => event.verb === 'REWORK')).toHaveLength(1);
  });

  it('does not deduplicate an identical READY that follows a REWORK in the same window', () => {
    service.setScheduler({ onIntent: () => undefined });
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'ready-after-rework', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', eventId: 'rar-dispatch',
    });
    service.applyMarker({ // the queue's admission: the only way a queued pair starts
      project: PROJECT, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'ready-after-rework', attrs: { executor: EXEC, auditor: AUD } },
      source: 'queue', eventId: 'rar-admit',
    });
    const ready = (eventId: string, now: number) => service.applyMarker({
      project: PROJECT, writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'ready-after-rework', attrs: { path: '/workspace' } },
      source: 'marker', now, eventId,
    });
    ready('rar-ready-1', 1_000);
    service.applyMarker({
      project: PROJECT, writer: AUD,
      marker: { verb: 'REWORK', knownVerb: 'REWORK', taskId: 'ready-after-rework', attrs: { blocking: 'P0', p0: '1' } },
      source: 'marker', now: 1_500, eventId: 'rar-rework',
    });
    ready('rar-ready-2', 2_000);
    expect(getTaskPairStore().getPair(PROJECT, 'ready-after-rework')?.state).toMatchObject({ status: 'in_audit', round: 2 });
  });

  it('nudges the executor once when READY lacks an auditor validation report', async () => {
    service.setScheduler({ onIntent: () => undefined });
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'ready-gate', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', eventId: 'ready-gate-dispatch',
    });
    service.applyMarker({
      project: PROJECT, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'ready-gate', attrs: { executor: EXEC, auditor: AUD } },
      source: 'queue', eventId: 'ready-gate-queue',
    });
    service.applyMarker({
      project: PROJECT, writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'ready-gate', attrs: { worktree: '/w', head: 'h1', base: 'b1' } },
      source: 'marker', now: 3_000, eventId: 'ready-gate-ready',
    });
    await flush();
    const reminders = sent.filter((entry) => entry.id.includes(':validation-report:'));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.target).toBe(EXEC);
  });

  it('recognizes a taskId-bound validation report even without task.objective', async () => {
    service.setScheduler({ onIntent: () => undefined });
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'ready-report', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', eventId: 'ready-report-dispatch',
    });
    service.applyMarker({
      project: PROJECT, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'ready-report', attrs: { executor: EXEC, auditor: AUD } },
      source: 'queue', eventId: 'ready-report-queue',
    });
    service.applyMarker({
      project: PROJECT, writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'ready-report', attrs: { worktree: '/w', head: 'h1', base: 'b1' } },
      source: 'marker', now: 4_000, eventId: 'ready-report-ready',
    });
    service.implicitDispatch({
      project: PROJECT, sender: EXEC, target: AUD, taskId: 'ready-report',
      message: 'Validation result: task-pair suite passed 263/263; tsc passed; no failures.',
      eventId: 'ready-report-send',
    });
    await flush();
    expect(sent.filter((entry) => entry.id.includes(':validation-report:'))).toHaveLength(1);
    expect(sent.filter((entry) => entry.id.includes(':ready-marker-reminder:'))).toHaveLength(0);
  });

  it('reminds both sides when a validation report arrives before READY_FOR_AUDIT', async () => {
    service.setScheduler({ onIntent: () => undefined });
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'report-before-ready', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', eventId: 'report-before-ready-dispatch',
    });
    service.applyMarker({
      project: PROJECT, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'report-before-ready', attrs: { executor: EXEC, auditor: AUD } },
      source: 'queue', eventId: 'report-before-ready-queue',
    });
    service.implicitDispatch({
      project: PROJECT, sender: EXEC, target: AUD, taskId: 'report-before-ready',
      message: 'Validation result: focused tests passed 12/12; typecheck passed; no failures.',
      eventId: 'report-before-ready-send',
    });
    await flush();
    const executorReminder = sent.find((entry) => entry.id.includes(':ready-marker-reminder:'));
    const auditorReminder = sent.find((entry) => entry.id.includes(':ready-marker-wait:'));
    expect(executorReminder?.target).toBe(EXEC);
    expect(executorReminder?.text).toContain('READY_FOR_AUDIT report-before-ready');
    expect(auditorReminder?.target).toBe(AUD);
    expect(auditorReminder?.text).toContain("do not ask Brain");
    expect(sent.filter((entry) => entry.id.includes(':ready-marker-reminder:'))).toHaveLength(1);
    service.implicitDispatch({
      project: PROJECT, sender: EXEC, target: AUD, taskId: 'report-before-ready',
      message: 'Validation result: focused tests passed 12/12; typecheck passed; no failures.',
      eventId: 'report-before-ready-send-duplicate',
    });
    await flush();
    expect(sent.filter((entry) => entry.id.includes(':ready-marker-reminder:'))).toHaveLength(1);
  });

  it('suppresses a participant relay that exactly repeats the partner report to Brain', () => {
    service.setScheduler({ onIntent: () => undefined });
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'relay-dedup', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', eventId: 'relay-dedup-dispatch',
    });
    service.applyMarker({
      project: PROJECT, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'relay-dedup', attrs: { executor: EXEC, auditor: AUD } },
      source: 'queue', eventId: 'relay-dedup-start',
    });
    const report = 'Validation passed: focused task-pair tests 45/45; no failures.';
    service.implicitDispatch({
      project: PROJECT, sender: EXEC, target: BRAIN, taskId: 'relay-dedup', message: report, eventId: 'relay-dedup-original',
    });
    service.implicitDispatch({
      project: PROJECT, sender: AUD, target: BRAIN, taskId: 'relay-dedup', message: report, eventId: 'relay-dedup-relay',
    });
    const sends = getTaskPairStore().listEvents(PROJECT, 'relay-dedup')
      .filter((event) => event.verb === 'SEND')
      .sort((a, b) => a.at - b.at);
    expect(sends).toHaveLength(2);
    expect(sends.map((event) => event.effect).sort()).toEqual(['recorded', 'relay_suppressed']);
    expect(sends.find((event) => event.effect === 'relay_suppressed')?.unusual).toBe(false);
  });

  it.each([
    ['PASS → DONE → SEND', true],
    ['PASS → SEND → DONE', false],
  ] as const)('records a late executor validation SEND after %s without reopening or executing the pair', async (_order, sendAfterDone) => {
    const taskId = sendAfterDone ? 'late-send-after-done' : 'late-send-before-done';
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH ${taskId} executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, `Validation report for ${taskId}.\n<!-- IMCODES_TASK READY_FOR_AUDIT ${taskId} worktree=/tmp/${taskId} head=head-${taskId} base=base-${taskId} -->`);
    await say(AUD, `<!-- IMCODES_TASK PASS ${taskId} blocking=P0 -->`);

    const report = `Validation passed for ${taskId}: focused suite 4/4; no failures.`;
    if (sendAfterDone) {
      await say(EXEC, `Committed exact head.\n<!-- IMCODES_TASK DONE ${taskId} -->`);
      expect(pair(taskId)?.status).toBe('done');
    }

    const first = service.implicitDispatch({
      project: PROJECT,
      sender: EXEC,
      target: BRAIN,
      taskId,
      message: report,
      eventId: `${taskId}-send-1`,
    });
    expect(first).toMatchObject({ effect: 'recorded', unusual: true });
    expect(pair(taskId)?.status).toBe(sendAfterDone ? 'done' : 'passed');

    if (!sendAfterDone) {
      await say(EXEC, `Committed exact head.\n<!-- IMCODES_TASK DONE ${taskId} -->`);
      expect(pair(taskId)?.status).toBe('done');
    }

    // Replaying the same SEND event id is idempotent: the event ledger keeps
    // one trace and the terminal pair remains terminal.
    const duplicate = service.implicitDispatch({
      project: PROJECT,
      sender: EXEC,
      target: BRAIN,
      taskId,
      message: report,
      eventId: `${taskId}-send-1`,
    });
    expect(duplicate).toMatchObject({ effect: 'recorded', unusual: true });
    expect(pair(taskId)?.status).toBe('done');
    const sends = getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === 'SEND');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      id: `${taskId}-send-1`,
      writer: EXEC,
      unusual: true,
      fromStatus: sendAfterDone ? 'done' : 'passed',
      toStatus: sendAfterDone ? 'done' : 'passed',
      attrs: { target: BRAIN, report: 'true' },
    });

    // An unknown/non-participant writer is still recorded for auditability,
    // but cannot wake or reopen a terminal pair.
    const unknown = service.implicitDispatch({
      project: PROJECT,
      sender: PROC,
      target: BRAIN,
      taskId,
      message: 'Validation result copied from an unrelated session.',
      eventId: `${taskId}-send-unknown`,
    });
    expect(unknown).toMatchObject({ effect: 'recorded', unusual: true });
    expect(pair(taskId)?.status).toBe('done');
    expect(getTaskPairStore().listEvents(PROJECT, taskId).find((event) => event.id === `${taskId}-send-unknown`)).toMatchObject({
      role: 'other', unusual: true, fromStatus: 'done', toStatus: 'done',
    });
  });

  it('tells Brain once when an audited pair PASSes, with the verdict and material, and does not repeat it on DONE', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T63 executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, 'Ready.\n<!-- IMCODES_TASK READY_FOR_AUDIT T63 worktree=/tmp/wt63 head=abc1234 base=def5678 -->');
    sent.length = 0;
    await say(AUD, '<!-- IMCODES_TASK PASS T63 blocking=P0 -->');
    const passNotices = sent.filter((entry) => entry.id.includes(':brain-line-pass-done:'));
    expect(passNotices).toHaveLength(1);
    expect(passNotices[0]!.target).toBe(BRAIN);
    expect(passNotices[0]!.text).toContain('T63');
    expect(passNotices[0]!.text).toContain(`Auditor ${AUD} verdict: PASS`);
    expect(passNotices[0]!.text).toContain('worktree /tmp/wt63');
    expect(passNotices[0]!.text).toContain('head abc1234');
    expect(passNotices[0]!.text).toContain('base def5678');

    // DONE is a backstop for the same notice, not a second one -- the PASS
    // notice already caught it this round.
    await say(EXEC, 'Committed and pushed.\n<!-- IMCODES_TASK DONE T63 -->');
    expect(sent.filter((entry) => entry.id.includes(':brain-line-pass-done:'))).toHaveLength(1);
  });

  it('relays the executor\'s own closing summary to Brain when a no-auditor pair reaches DONE, so Brain never has to poll', async () => {
    await say(BRAIN, `Dispatching.\n<!-- IMCODES_TASK DISPATCH T60 executor=${EXEC} auditor=none title="Bump a config value" -->`);
    sent.length = 0; // clear the DISPATCH brief so only the DONE relay is asserted below
    await say(
      EXEC,
      'Changed the timeout to 30s in config.yaml and pushed.\nRan the full suite locally: all green.\n'
      + '<!-- IMCODES_TASK DONE T60 -->',
    );
    expect(pair('T60')?.status).toBe('awaiting_brain_decision');
    const notice = sent.find((entry) => entry.target === BRAIN);
    expect(notice).toBeDefined();
    expect(notice!.text).toContain('reported DONE');
    expect(notice!.text).toContain(EXEC);
    expect(notice!.text).toContain('no auditor was assigned');
    expect(notice!.text).toContain('Changed the timeout to 30s in config.yaml and pushed.');
    expect(notice!.text).toContain('Ran the full suite locally: all green.');
    expect(notice!.text).not.toContain('IMCODES_TASK DONE');
  });

  it('does not send the no-auditor DONE relay for an audited pair, or for a Brain-forced DONE', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T61 executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, 'Done.\n<!-- IMCODES_TASK READY_FOR_AUDIT T61 worktree=/w head=1234567 -->');
    await say(AUD, '<!-- IMCODES_TASK PASS T61 blocking=P0 -->');
    sent.length = 0;
    await say(EXEC, 'Merged.\n<!-- IMCODES_TASK DONE T61 -->');
    expect(pair('T61')?.status).toBe('done');
    expect(sent.some((entry) => entry.target === BRAIN)).toBe(false);

    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T62 executor=${EXEC} auditor=none -->`);
    sent.length = 0;
    await say(BRAIN, '<!-- IMCODES_TASK DONE T62 force=true -->');
    expect(pair('T62')?.status).toBe('done');
    expect(sent.some((entry) => entry.target === BRAIN)).toBe(false);
  });

  it('ignores streaming, automation and memory-excluded payloads and legacy-engine projects', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T4 executor=${EXEC} auditor=${AUD} -->`, { streaming: true });
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T4 executor=${EXEC} auditor=${AUD} -->`, { automation: true });
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T4 executor=${EXEC} auditor=${AUD} -->`, { memoryExcluded: true });
    expect(pair('T4')).toBeUndefined();
    getTaskPairStore().setProjectEngine(PROJECT, 'legacy');
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T4 executor=${EXEC} auditor=${AUD} -->`);
    expect(pair('T4')).toBeUndefined();
  });

  it('flushes a complete marker from an interrupted terminal stream, but not live chunks', async () => {
    const marker = `<!-- IMCODES_TASK DISPATCH TSTREAM executor=${EXEC} auditor=${AUD} -->`;
    const streamEventId = 'transport:pairsproj:stopped-stream';

    // Live chunks are display-only and must never create a pair on their own.
    timelineEmitter.emit(BRAIN, 'assistant.text', { text: marker, streaming: true }, {
      source: 'daemon', confidence: 'high', eventId: streamEventId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pair('TSTREAM')).toBeUndefined();

    // A stop/retry terminal replacement carries the last streamed text with an
    // explicit flush flag. memoryExcluded still protects memory ingestion, but
    // the pair protocol may safely inspect this one complete terminal snapshot.
    await say(BRAIN, `${marker}\n\n⚠️ Turn cancelled`, {
      memoryExcluded: true,
      [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true,
    }, streamEventId);
    expect(pair('TSTREAM')).toMatchObject({ executor: EXEC, auditor: AUD });
    const eventCountAfterFlush = getTaskPairStore().listEvents(PROJECT, 'TSTREAM').length;
    expect(eventCountAfterFlush).toBeGreaterThan(0);

    // Replaying the same terminal event is idempotent.
    await say(BRAIN, `${marker}\n\n⚠️ Turn cancelled`, {
      memoryExcluded: true,
      [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true,
    }, streamEventId);
    expect(getTaskPairStore().listEvents(PROJECT, 'TSTREAM')).toHaveLength(eventCountAfterFlush);
  });

  it('does not flush fenced or partial markers from an interrupted stream', async () => {
    const fenced = ['```', `<!-- IMCODES_TASK DISPATCH TFENCED executor=${EXEC} auditor=${AUD} -->`, '```'].join('\n');
    await say(BRAIN, fenced, { memoryExcluded: true, [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true }, 'fenced-stop');
    await say(BRAIN, '<!-- IMCODES_TASK DISPATCH TPARTIAL executor=', { memoryExcluded: true, [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true }, 'partial-stop');
    expect(pair('TFENCED')).toBeUndefined();
    expect(pair('TPARTIAL')).toBeUndefined();
  });

  it('recovers a terminal marker from the prior daemon epoch exactly once after restart', async () => {
    await service.dispose();
    const marker = `<!-- IMCODES_TASK DISPATCH TRECOVER executor=${EXEC} auditor=${AUD} -->`;
    const readTail = vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([{
      eventId: 'transport:restarted:recover', sessionId: BRAIN, ts: Date.now(), seq: 1,
      epoch: timelineEmitter.epoch - 1, source: 'daemon', confidence: 'high', type: 'assistant.text',
      payload: { text: marker, streaming: false, memoryExcluded: true, [TASK_PAIR_TERMINAL_FLUSH_FIELD]: true },
    }]);
    resetTaskPairTerminalStreamRecoveryForTests();
    service = new TaskPairService();
    service.init();
    await service.waitForIdle();
    expect(pair('TRECOVER')).toMatchObject({ executor: EXEC, auditor: AUD });
    const eventCount = getTaskPairStore().listEvents(PROJECT, 'TRECOVER').length;

    // A second tick/re-init in the same daemon epoch does not replay it.
    await service.dispose();
    resetTaskPairTerminalStreamRecoveryForTests();
    service = new TaskPairService();
    service.init();
    await service.waitForIdle();
    expect(getTaskPairStore().listEvents(PROJECT, 'TRECOVER')).toHaveLength(eventCount);
    readTail.mockRestore();
  });

  it('keeps the turn flowing when the store fails', async () => {
    setTaskPairStoreForTests({
      hasEvent: () => { throw new Error('disk full'); },
      pairsForSession: () => { throw new Error('disk full'); },
      getProjectSettings: () => ({ allowlist: [] }),
      close: () => undefined,
    } as unknown as TaskPairStore);
    const delivered: string[] = [];
    const off = timelineEmitter.on((event) => { if (event.type === 'assistant.text') delivered.push(String(event.payload.text)); });
    await expect(say(BRAIN, `<!-- IMCODES_TASK DISPATCH T5 executor=${EXEC} auditor=${AUD} -->`)).resolves.toBeUndefined();
    off();
    expect(delivered).toHaveLength(1);
  });

  it('records a non-participant status marker as unusual without changing roles', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T6 executor=${EXEC} auditor=${AUD} -->`);
    await say(PROC, '<!-- IMCODES_TASK WORKING T6 -->');
    expect(pair('T6')).toMatchObject({ executor: EXEC, auditor: AUD, status: 'working' });
    const [latest] = getTaskPairStore().listEvents(PROJECT, 'T6', 1);
    expect(latest).toMatchObject({ writer: PROC, role: 'other', unusual: true });
  });

  it('resolves "-" to the writer\'s single open pair and records it otherwise', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T7 executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT - -->');
    expect(pair('T7')?.status).toBe('in_audit');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T8 executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, '<!-- IMCODES_TASK DONE - -->');
    expect(pair('T7')?.status).toBe('in_audit');
    // The executor is already reserved by T7, so the explicitly named T8
    // remains queued instead of double-booking the same session.
    expect(pair('T8')?.status).toBe('queued');
  });

  it('never falls back to the project checkout when material is unresolved: asks the executor, tells the auditor it is pending', async () => {
    // The executor's project directory (/tmp/pairsproj) does not exist in
    // this harness, so workspace provisioning fails and READY_FOR_AUDIT
    // carries no worktree=/head= -- material.source is genuinely 'pending'.
    // The relay must never substitute the project checkout in that case.
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T10p executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T10p -->');
    await vi.waitFor(() => expect(sent.filter((entry) => entry.id.includes(':material-pending:'))).toHaveLength(1));
    const pendingToExecutor = sent.find((entry) => entry.id.includes(':material-pending:'))!;
    expect(pendingToExecutor.target).toBe(EXEC);
    expect(pendingToExecutor.text).toContain('resend READY_FOR_AUDIT with worktree=');

    await vi.waitFor(() => expect(sent.filter((entry) => entry.id.includes(':audit-request:'))).toHaveLength(1));
    const auditRequest = sent.find((entry) => entry.id.includes(':audit-request:'))!;
    expect(auditRequest.target).toBe(AUD);
    expect(auditRequest.text).toContain('Material pending');
    // The one thing this finding was about: never the executor's project checkout.
    expect(auditRequest.text).not.toContain('/tmp/pairsproj');
  });

  it('sends a verdict correction to the auditor and a rework notice to the executor', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T9 executor=${EXEC} auditor=${AUD} -->`);
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T9 path=/workspace -->');
    // Pair briefs and the audit request are covered elsewhere.
    await vi.waitFor(() => expect(sent.filter((entry) => /:(pair-brief|auditor-assigned|audit-request):/.test(entry.id))).toHaveLength(3));
    sent = [];
    await say(AUD, '<!-- IMCODES_TASK REWORK T9 blocking=P0 p0=0 p1=2 -->');
    await flush();
    expect(sent.map((entry) => entry.target)).toEqual([AUD]);
    expect(sent[0]?.text).toContain('REWORK needs at least one finding at a blocking severity');
    expect(sent[0]?.id.startsWith('task-pair-nudge:T9:correction:')).toBe(true);
    await say(AUD, '<!-- IMCODES_TASK REWORK T9 blocking=P0 p0=1 p1=2 -->');
    await flush();
    expect(sent.find((entry) => entry.target === EXEC)?.text).toContain('whole class');
    expect(sent.find((entry) => entry.target === AUD && entry.text.includes('Your REWORK did not'))?.text).toContain('concrete proposal');
  });

  it('records audited DONE without PASS and sends a bounded policy notice', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T10 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sent.filter((entry) => /:(pair-brief|auditor-assigned):/.test(entry.id))).toHaveLength(2));
    sent = [];
    await say(EXEC, '<!-- IMCODES_TASK DONE T10 -->');
    await flush();
    expect(pair('T10')?.status).toBe('working');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ target: EXEC });
    expect(sent[0]?.text).toContain('material-backed audit round');
  });

  it('tells the writer their marker was recorded, not applied, when the pair is closed (tsk_83375afb5a)', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T11 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sent.filter((entry) => /:(pair-brief|auditor-assigned):/.test(entry.id))).toHaveLength(2));
    await say(BRAIN, '<!-- IMCODES_TASK CANCEL T11 -->');
    await flush();
    expect(pair('T11')?.status).toBe('cancelled');
    sent = [];
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T11 -->');
    await flush();
    expect(pair('T11')?.status).toBe('cancelled');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ target: EXEC });
    expect(sent[0]?.text).toContain('only Brain can reopen it');
  });

  it('delivers the stored brief to the executor on a Brain DISPATCH naming roles for an already-queued pair, not just the title (tsk_cd_upgrade_starvation)', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK QUEUE T12 title="Upgrade starvation fix" -->\nAdd a bounded max-wait, then an orderly drain.\n<!-- IMCODES_TASK_END T12 -->`);
    await flush();
    expect(pair('T12')).toMatchObject({ status: 'queued', brief: 'Add a bounded max-wait, then an orderly drain.' });
    sent = [];
    // Brain's own sequence: QUEUE with a brief, then REASSIGN models, then
    // DISPATCH naming the actual sessions -- the executor must see the
    // brief, not only the title and boilerplate.
    await say(BRAIN, '<!-- IMCODES_TASK REASSIGN T12 executormodel=gpt-6-luna -->');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T12 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sent.some((entry) => entry.target === EXEC)).toBe(true));
    const brief = sent.find((entry) => entry.target === EXEC);
    expect(brief?.text).toContain('Add a bounded max-wait, then an orderly drain.');
  });

  it('briefs a newly-reassigned executor with the pair\'s stored brief, not silence', async () => {
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE T13 title="Handover test" -->\nOriginal brief text.\n<!-- IMCODES_TASK_END T13 -->');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T13 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sent.filter((entry) => entry.target === EXEC)).toHaveLength(1));
    sent = [];
    // Pre-fix: REASSIGN never briefed the new executor at all -- no title,
    // no brief, no workspace instructions, nothing.
    await say(BRAIN, `<!-- IMCODES_TASK REASSIGN T13 executor=${PROC} -->`);
    await vi.waitFor(() => expect(sent.some((entry) => entry.target === PROC)).toBe(true));
    expect(pair('T13')?.executor).toBe(PROC);
    const brief = sent.find((entry) => entry.target === PROC);
    expect(brief).toBeTruthy();
    expect(brief?.text).toContain('T13');
    expect(brief?.text).toContain('Original brief text.');
    expect(brief?.text).toContain('executor of this task pair');
    // Owner rule (tsk_cd_dispatch_default): ask, don't just reply.
    expect(brief?.text).toContain('Ask, don\'t just reply');
  });

  it('delivers the stored brief again when Brain explicitly requeues a cancelled pair', async () => {
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE T14 title="Retry after cancel" -->\nRedo the thing that got cancelled.\n<!-- IMCODES_TASK_END T14 -->');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T14 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sent.filter((entry) => entry.target === EXEC)).toHaveLength(1));
    await say(BRAIN, '<!-- IMCODES_TASK CANCEL T14 -->');
    await flush();
    expect(pair('T14')?.status).toBe('cancelled');
    sent = [];
    await say(BRAIN, `<!-- IMCODES_TASK QUEUE T14 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sent.some((entry) => entry.target === EXEC)).toBe(true));
    expect(pair('T14')?.status).toBe('working');
    const brief = sent.find((entry) => entry.target === EXEC);
    expect(brief?.text).toContain('Redo the thing that got cancelled.');
  });

  it('stores QUEUE - max= as the writer queue limit', async () => {
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE - max=8 -->');
    expect(getTaskPairStore().getMaxConcurrency(BRAIN)).toBe(8);
  });

  it('creates a pair from send_message task metadata only when none exists, and never rewrites roles', async () => {
    clearSendIdempotencyCacheForTests();
    const dispatchMessage = vi.fn().mockResolvedValue('sent');
    const listSessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3')];
    const brainCaller = { userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const created = await dispatchSendMessage(brainCaller, {
      target: EXEC, message: 'Please fix login.', task: { taskId: 'T11', objective: 'fix login' },
    } as never, { listSessions, dispatchMessage });
    expect(created, JSON.stringify(created)).toMatchObject({
      status: 'accepted', taskId: 'T11', taskTitle: '(untitled task)',
    });
    expect(pair('T11')).toMatchObject({ status: 'working', brain: BRAIN, executor: EXEC, title: '(untitled task)' });

    // The executor sends its materials to the auditor with task and audit metadata.
    await say(BRAIN, `<!-- IMCODES_TASK REASSIGN T11 auditor=${AUD} -->`);
    const execCaller = { userId: 'u', sessionName: EXEC, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const materials = await dispatchSendMessage(execCaller, {
      target: AUD, message: 'Materials for T11.', reply: true,
      task: { taskId: 'T11', assignmentId: 'asg_x' },
      audit: { kind: 'supervision_audit', attemptId: 'att_x', auditedSessionName: EXEC },
    } as never, { listSessions, dispatchMessage });
    expect(materials, JSON.stringify(materials)).toMatchObject({ status: "accepted" });
    expect(pair('T11')).toMatchObject({ executor: EXEC, auditor: AUD, status: 'working' });
    expect(dispatchMessage).toHaveBeenCalledTimes(2);
  });

  it('mints the taskId of a new objective sent without one and names it on the accepted receipt', async () => {
    clearSendIdempotencyCacheForTests();
    const dispatchMessage = vi.fn().mockResolvedValue('sent');
    const listSessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3')];
    const brainCaller = { userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const input = {
      target: EXEC, message: 'Please add a README sentence.', idempotencyKey: 'readme-1', reply: true,
      task: { classification: 'independent_top_level', objective: 'Add one README sentence', ownedFiles: ['README.md'] },
    };
    const created = await dispatchSendMessage(brainCaller, input as never, { listSessions, dispatchMessage });
    if (created.status !== 'accepted' || !created.taskId) throw new Error(JSON.stringify(created));
    expect(created.taskId).toMatch(/^tsk_[0-9a-f]{10}$/);
    expect(created).toMatchObject({ taskTitle: '(untitled task)' });
    // The executor slot's pair binding id is the receipt's assignmentId.
    expect(created.assignmentId).toBe(taskPairBindingId(created.taskId, 'executor'));
    expect(created.deliveries).toEqual([expect.objectContaining({
      target: EXEC, taskId: created.taskId, assignmentId: created.assignmentId, taskTitle: '(untitled task)',
    })]);
    // So the Brain turn's delegation claim is substantiated, live and after reload.
    const fact = readDelegationDispatchFact(DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', input, created);
    expect(fact).toMatchObject({ taskId: created.taskId, assignmentId: created.assignmentId });
    const claim = projectDelegationClaim([fact!]);
    expect(claim).toMatchObject({ status: 'substantiated', dispatches: [{ taskId: created.taskId, assignmentId: created.assignmentId }] });
    expect(readDelegationClaim({ [DELEGATION_CLAIM_METADATA_FIELD]: JSON.parse(JSON.stringify(claim)) })?.status).toBe('substantiated');
    expect(pair(created.taskId)).toMatchObject({ status: 'working', brain: BRAIN, executor: EXEC, title: '(untitled task)' });
    // The send's own objective is stored as the pair's brief -- not left
    // empty -- so pair_task_get and a later REASSIGN/re-dispatch still have
    // the actual brief, not just the title (tsk_cd_pair_implicit_duplicates).
    expect(pair(created.taskId)?.brief).toBe('Add one README sentence');

    // A replay of the same send resolves to the same pair; a new key opens a new one.
    const replay = await dispatchSendMessage(brainCaller, input as never, { listSessions, dispatchMessage });
    expect(replay).toMatchObject({ status: 'accepted', taskId: created.taskId });
    const other = await dispatchSendMessage(brainCaller, { ...input, idempotencyKey: 'readme-2' } as never, { listSessions, dispatchMessage });
    if (other.status !== 'accepted' || !other.taskId) throw new Error(JSON.stringify(other));
    expect(other.taskId).not.toBe(created.taskId);
    expect(getTaskPairStore().listActivePairs(PROJECT).map((entry) => entry.state.taskId).sort())
      .toEqual([created.taskId, other.taskId].sort());
  });

  it('gives each recipient the binding of its own slot, and none to a non-participant', async () => {
    clearSendIdempotencyCacheForTests();
    const dispatchMessage = vi.fn().mockResolvedValue('sent');
    const outsider = 'deck_sub_pairsoutsider';
    const listSessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3'), session(outsider, 'w4')];
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T21 executor=${EXEC} auditor=${AUD} -->`);
    const execCaller = { userId: 'u', sessionName: EXEC, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const toAuditor = await dispatchSendMessage(execCaller, {
      target: AUD, message: 'Materials for T21.', task: { taskId: 'T21' },
    } as never, { listSessions, dispatchMessage });
    expect(toAuditor).toMatchObject({ status: 'accepted', taskId: 'T21', assignmentId: taskPairBindingId('T21', 'auditor') });
    const brainCaller = { userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const toOutsider = await dispatchSendMessage(brainCaller, {
      target: outsider, message: 'FYI about T21.', task: { taskId: 'T21' },
    } as never, { listSessions, dispatchMessage });
    if (toOutsider.status !== 'accepted') throw new Error(JSON.stringify(toOutsider));
    expect(toOutsider.taskId).toBe('T21');
    expect(toOutsider.assignmentId).toBeUndefined();
    expect(pair('T21')).toMatchObject({ executor: EXEC, auditor: AUD });
  });

  it('binds a named task only to a delivery that reached its target', async () => {
    clearSendIdempotencyCacheForTests();
    const dispatchMessage = vi.fn(async (target: SessionRecord) => {
      if (target.name === EXEC) throw new Error('target gone');
      return 'sent';
    });
    const listSessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3')];
    const brainCaller = { userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const result = await dispatchSendMessage(brainCaller, {
      broadcast: true, message: 'Whoever is free: fix login.', task: { taskId: 'T20', objective: 'fix login' },
    } as never, { listSessions, dispatchMessage });
    if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
    expect(result.deliveries.find((delivery) => delivery.target === EXEC)).toMatchObject({ status: 'failed' });
    expect(result.deliveries.find((delivery) => delivery.target === EXEC)?.taskId).toBeUndefined();
    expect(pair('T20')).toMatchObject({ executor: AUD });
  });

  it('opens no pair for task metadata that names neither a taskId nor an objective', async () => {
    clearSendIdempotencyCacheForTests();
    const dispatchMessage = vi.fn().mockResolvedValue('sent');
    const listSessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3')];
    const brainCaller = { userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const sentPlain = await dispatchSendMessage(brainCaller, {
      target: EXEC, message: 'FYI.', task: { ownedFiles: ['README.md'], acceptance: ['none'] },
    } as never, { listSessions, dispatchMessage });
    expect(sentPlain).toMatchObject({ status: 'accepted' });
    expect(sentPlain.status === 'accepted' ? sentPlain.taskId : 'error').toBeUndefined();
    expect(getTaskPairStore().listActivePairs(PROJECT)).toEqual([]);
  });

  it('a project with no saved config or no Brain is inert; an explicit engine choice still wins', () => {
    // No Brain session for 'anyproject' anywhere in this suite: no saved
    // config means inert (owner decision, 2026-09-26) -- see
    // engine-mode-off.test.ts for the full causal coverage.
    expect(resolveTaskPairEngineState('anyproject', {})).toBe('off');
    expect(resolveTaskPairEngine('anyproject', {})).toBe('legacy');
    expect(resolveTaskPairEngine('anyproject', { IMCODES_SUPERVISION_ENGINE: 'pairs' })).toBe('pairs');
    expect(resolveTaskPairEngine('anyproject', { IMCODES_SUPERVISION_ENGINE: 'legacy' })).toBe('legacy');
    getTaskPairStore().setProjectEngine('rolledback', 'legacy');
    expect(resolveTaskPairEngine('rolledback', {})).toBe('legacy');
  });

  it('reads engine and limit from the Brain supervision settings first', () => {
    // Pair routing (executor/auditor picks) is exactly the execution pool's
    // per-entry role now -- see shared/supervision-execution-pool.test.ts
    // for foldLegacyPairAllowlistIntoExecutionPools and pool.test.ts /
    // owner-rule.test.ts for role-based picking. This test covers only the
    // remaining pair settings (engine, max concurrency).
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    upsertSession({
      ...session(BRAIN, 'brain'),
      transportConfig: {
        supervision: normalizeSessionSupervisionSnapshot({
          pairEngine: 'legacy',
          pairMaxConcurrency: 3,
        }),
      },
    } as SessionRecord);
    expect(resolveTaskPairEngine(PROJECT)).toBe('legacy');
    getTaskPairStore().setMaxConcurrency(BRAIN, 8);
    expect(resolveTaskPairMaxConcurrency(BRAIN)).toBe(3);
  });

  it('a new pair falls back to the Brain-configured blocking set, but an explicit DISPATCH attr wins', () => {
    upsertSession({
      ...session(BRAIN, 'brain'),
      transportConfig: {
        supervision: normalizeSessionSupervisionSnapshot({ auditBlockingSeverities: ['P0', 'P1'] }),
      },
    } as SessionRecord);

    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'BLK1', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', now: Date.now(), eventId: 'blk-1',
    });
    expect(pair('BLK1')?.blocking).toEqual(['P0', 'P1']);

    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'BLK2', attrs: { executor: EXEC, auditor: AUD, blocking: 'P0,P2' } },
      source: 'marker', now: Date.now(), eventId: 'blk-2',
    });
    expect(pair('BLK2')).toMatchObject({ blocking: ['P0', 'P2'], blockingSource: 'explicit' });
  });

  it('falls back to P0 when nothing is configured and no explicit blocking is given', () => {
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'BLK4', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', now: Date.now(), eventId: 'blk4-1',
    });
    expect(pair('BLK4')).toMatchObject({ blocking: ['P0'], blockingSource: 'config' });
  });

  it('an explicit blocking=P0,P1,P2 on DISPATCH overrides a Brain config of just P0', () => {
    upsertSession({
      ...session(BRAIN, 'brain'),
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ auditBlockingSeverities: ['P0'] }) },
    } as SessionRecord);
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'BLK3', attrs: { executor: EXEC, auditor: AUD, blocking: 'P0,P1,P2' } },
      source: 'marker', now: Date.now(), eventId: 'blk3-1',
    });
    expect(pair('BLK3')).toMatchObject({ blocking: ['P0', 'P1', 'P2'], blockingSource: 'explicit' });
  });

  it('the QUEUE creation path also carries the Brain-configured blocking set', () => {
    upsertSession({
      ...session(BRAIN, 'brain'),
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ auditBlockingSeverities: ['P1'] }) },
    } as SessionRecord);
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'QUEUE', knownVerb: 'QUEUE', taskId: 'BLKQ', attrs: { title: 'queued task' } },
      source: 'marker', now: Date.now(), eventId: 'blkq-1',
    });
    expect(pair('BLKQ')).toMatchObject({ status: 'queued', blocking: ['P1'], blockingSource: 'config' });
  });

  it('rejects a PASS carrying a finding at a Brain-configured (non-P0) blocking level', () => {
    upsertSession({
      ...session(BRAIN, 'brain'),
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ auditBlockingSeverities: ['P0', 'P1'] }) },
    } as SessionRecord);
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'BLKPASS', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', now: Date.now(), eventId: 'blkpass-1',
    });
    service.applyMarker({
      project: PROJECT, writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'BLKPASS', attrs: { worktree: '/w', head: 'h1', base: 'b1' } },
      source: 'marker', now: Date.now(), eventId: 'blkpass-2',
    });
    expect(pair('BLKPASS')?.status).toBe('in_audit');
    const transition = service.applyMarker({
      project: PROJECT, writer: AUD,
      marker: { verb: 'PASS', knownVerb: 'PASS', taskId: 'BLKPASS', attrs: { blocking: 'P0,P1', p1: '1' } },
      source: 'marker', now: Date.now(), eventId: 'blkpass-3',
    });
    expect(transition.verdict?.judgement).toBe('inconsistent');
    expect(pair('BLKPASS')?.status).toBe('in_audit');
  });

  it('a Brain config change updates a config-derived open pair at its next round, but never an explicit one', () => {
    upsertSession({
      ...session(BRAIN, 'brain'),
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ auditBlockingSeverities: ['P0'] }) },
    } as SessionRecord);
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'BLKCFG', attrs: { executor: EXEC, auditor: AUD } },
      source: 'marker', now: Date.now(), eventId: 'blkcfg-1',
    });
    service.applyMarker({
      project: PROJECT, writer: BRAIN,
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: 'BLKEXP', attrs: { executor: EXEC, auditor: AUD, blocking: 'P2' } },
      source: 'marker', now: Date.now(), eventId: 'blkexp-1',
    });
    expect(pair('BLKCFG')).toMatchObject({ blocking: ['P0'], blockingSource: 'config' });
    expect(pair('BLKEXP')).toMatchObject({ blocking: ['P2'], blockingSource: 'explicit' });

    // The Brain raises its configured blocking set.
    upsertSession({
      ...session(BRAIN, 'brain'),
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ auditBlockingSeverities: ['P0', 'P1'] }) },
    } as SessionRecord);

    // Both pairs start a new round.
    service.applyMarker({
      project: PROJECT, writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'BLKCFG', attrs: { worktree: '/w', head: 'h1', base: 'b1' } },
      source: 'marker', now: Date.now(), eventId: 'blkcfg-2',
    });
    service.applyMarker({
      project: PROJECT, writer: EXEC,
      marker: { verb: 'READY_FOR_AUDIT', knownVerb: 'READY_FOR_AUDIT', taskId: 'BLKEXP', attrs: { worktree: '/w', head: 'h1', base: 'b1' } },
      source: 'marker', now: Date.now(), eventId: 'blkexp-2',
    });

    expect(pair('BLKCFG')).toMatchObject({ blocking: ['P0', 'P1'], blockingSource: 'config' });
    expect(pair('BLKEXP')).toMatchObject({ blocking: ['P2'], blockingSource: 'explicit' });
  });

  it('hides marker lines from displayed assistant text', async () => {
    expect(normalizeAssistantTextForDisplay('Done.\n<!-- IMCODES_TASK READY_FOR_AUDIT T1 -->')).toBe('Done.');
  });
});
