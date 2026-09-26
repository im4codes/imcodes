import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService, type TaskPairScheduler } from '../../../src/daemon/task-pairs/service.js';
import { resolveTaskPairEngine, resolveTaskPairEngineState, resolveTaskPairMaxConcurrency } from '../../../src/daemon/task-pairs/engine.js';
import { normalizeSessionSupervisionSnapshot } from '../../../shared/supervision-config.js';
import { dispatchSendMessage, clearSendIdempotencyCacheForTests } from '../../../src/daemon/send-tool.js';
import { TASK_PAIR_TIMELINE_EVENT, taskPairBindingId } from '../../../shared/task-pair.js';
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
      session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3'), session(PROC, 'w1', 'claude-code'),
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
    for (const name of [BRAIN, EXEC, AUD, PROC, OTHER_PROJECT_SESSION]) removeSession(name);
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
    expect(pair('T8')?.status).toBe('working');
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
    expect(sent.at(-1)).toMatchObject({ target: EXEC });
    expect(sent.at(-1)?.text).toContain('whole class');
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

  it('delivers the stored brief again when Brain re-dispatches a cancelled pair', async () => {
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE T14 title="Retry after cancel" -->\nRedo the thing that got cancelled.\n<!-- IMCODES_TASK_END T14 -->');
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T14 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sent.filter((entry) => entry.target === EXEC)).toHaveLength(1));
    await say(BRAIN, '<!-- IMCODES_TASK CANCEL T14 -->');
    await flush();
    expect(pair('T14')?.status).toBe('cancelled');
    sent = [];
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T14 executor=${EXEC} auditor=${AUD} -->`);
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
      status: 'accepted', taskId: 'T11', taskTitle: 'fix login', taskObjective: 'fix login',
    });
    expect(pair('T11')).toMatchObject({ status: 'working', brain: BRAIN, executor: EXEC, title: 'fix login' });

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
    expect(created).toMatchObject({ taskTitle: 'Add one README sentence', taskObjective: 'Add one README sentence' });
    // The executor slot's pair binding id is the receipt's assignmentId.
    expect(created.assignmentId).toBe(taskPairBindingId(created.taskId, 'executor'));
    expect(created.deliveries).toEqual([expect.objectContaining({
      target: EXEC, taskId: created.taskId, assignmentId: created.assignmentId, taskTitle: 'Add one README sentence',
    })]);
    // So the Brain turn's delegation claim is substantiated, live and after reload.
    const fact = readDelegationDispatchFact(DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', input, created);
    expect(fact).toMatchObject({ taskId: created.taskId, assignmentId: created.assignmentId });
    const claim = projectDelegationClaim([fact!]);
    expect(claim).toMatchObject({ status: 'substantiated', dispatches: [{ taskId: created.taskId, assignmentId: created.assignmentId }] });
    expect(readDelegationClaim({ [DELEGATION_CLAIM_METADATA_FIELD]: JSON.parse(JSON.stringify(claim)) })?.status).toBe('substantiated');
    expect(pair(created.taskId)).toMatchObject({ status: 'working', brain: BRAIN, executor: EXEC, title: 'Add one README sentence' });
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
