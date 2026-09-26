import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService } from '../../../src/daemon/task-pairs/service.js';
import { resolveTaskPairAllowlist, resolveTaskPairEngine, resolveTaskPairEngineState, resolveTaskPairMaxConcurrency } from '../../../src/daemon/task-pairs/engine.js';
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

/** Emit a final assistant turn and wait for the deferred ingestion to run. */
async function say(sessionName: string, text: string, extra: Record<string, unknown> = {}, eventId?: string) {
  turn += 1;
  timelineEmitter.emit(sessionName, 'assistant.text', { text, streaming: false, ...extra }, {
    source: 'daemon', confidence: 'high', eventId: eventId ?? `turn-${turn}`,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function pair(taskId: string) {
  return getTaskPairStore().getPair(PROJECT, taskId)?.state;
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
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
    expect(seen[0]?.payload).toMatchObject({ taskId: 'T1', verb: 'DISPATCH', toStatus: 'working', role: 'brain', source: 'marker' });
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
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T3 -->', {}, 'fixed-turn');
    await say(AUD, '<!-- IMCODES_TASK REWORK T3 blocking=P0 p0=1 -->');
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T3 -->', {}, 'fixed-turn');
    expect(pair('T3')).toMatchObject({ status: 'rework', round: 1 });
    expect(getTaskPairStore().listEvents(PROJECT, 'T3')).toHaveLength(3);
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
    await say(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T9 -->');
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

  it('reminds the executor once per DONE without PASS', async () => {
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T10 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sent.filter((entry) => /:(pair-brief|auditor-assigned):/.test(entry.id))).toHaveLength(2));
    sent = [];
    await say(EXEC, '<!-- IMCODES_TASK DONE T10 -->');
    await flush();
    expect(pair('T10')?.status).toBe('awaiting_audit');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ target: EXEC });
    expect(sent[0]?.text).toContain('DONE without a PASS is not complete');
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

  it('reads engine, allowlist and limit from the Brain supervision settings first', () => {
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    upsertSession({
      ...session(BRAIN, 'brain'),
      transportConfig: {
        supervision: normalizeSessionSupervisionSnapshot({
          pairEngine: 'legacy',
          pairAllowlist: [{ role: 'auditor', agentType: 'codex-sdk', modelPattern: 'gpt-5' }],
          pairMaxConcurrency: 3,
        }),
      },
    } as SessionRecord);
    expect(resolveTaskPairEngine(PROJECT)).toBe('legacy');
    expect(resolveTaskPairAllowlist(PROJECT)).toEqual([{ role: 'auditor', agentType: 'codex-sdk', modelPattern: 'gpt-5' }]);
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
    expect(pair('BLK2')?.blocking).toEqual(['P0', 'P2']);
  });

  it('hides marker lines from displayed assistant text', async () => {
    expect(normalizeAssistantTextForDisplay('Done.\n<!-- IMCODES_TASK READY_FOR_AUDIT T1 -->')).toBe('Done.');
  });
});
