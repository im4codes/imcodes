/**
 * How Brain's work becomes a driven pair (2026-09-25, 215 / jdzj: "new
 * dispatches get no audit window").
 *
 *  - Auto-audit ON (`supervised_audit`) on the `pairs` engine: a plain Brain
 *    send_message of new work opens a pair itself (daemon rule, not prompt).
 *  - Auto-audit OFF: nothing is forced; user-requested audited work opens a
 *    pair explicitly, and the pair heartbeat -- not a Brain cron -- drives it
 *    until DONE. Only a legacy-engine project keeps the Brain self-heartbeat.
 *  - The legacy coordinator start hands back a task id that opens the pair.
 *  - A pool that can never yield an allowlisted auditor is named to Brain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { isSessionCoveredByPairHeartbeat } from '../../../src/daemon/task-pairs/engine.js';
import { describeAuditorPoolGap, listTaskPairCandidates } from '../../../src/daemon/task-pairs/pool.js';
import { handleLegacyToolOnPairs } from '../../../src/daemon/task-pairs/legacy-tools.js';
import {
  clearSendIdempotencyCacheForTests,
  dispatchCronSend,
  dispatchSendMessage,
  resolveProjectAuthoritativeSupervisionSnapshot,
} from '../../../src/daemon/send-tool.js';
import {
  BRAIN_MANUAL_AUDITED_WORK,
  buildBrainManualOnlyDelegationContract,
  buildBrainSupervisedWorkDelegationContract,
  buildBrainWorkDelegationContractRef,
} from '../../../src/daemon/supervision-prompts.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { SUPERVISION_MODE, normalizeSessionSupervisionSnapshot } from '../../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId, normalizeSupervisionExecutionModel } from '../../../shared/supervision-execution-pool.js';
import { TASK_PAIR_PARTICIPANT_STATUSES, TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION } from '../../../shared/task-pair.js';

const PROJECT = 'dispproj';
const BRAIN = 'deck_dispproj_brain';
const EXEC = 'deck_sub_dispexec';
const EXEC2 = 'deck_sub_dispexec2';
const AUD = 'deck_sub_dispaud';

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

function brainWithMode(mode: string, extra: Record<string, unknown> = {}): SessionRecord {
  return session(BRAIN, 'brain', {
    transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode, ...extra }) },
  } as Partial<SessionRecord>);
}

let now = 1_000_000;
let sent: Array<{ target: string; text: string; id: string }>;
let sessions: SessionRecord[];
let automation: TaskPairAutomation;
const brainCaller = { userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
const dispatchMessage = vi.fn();

function useSessions(brain: SessionRecord) {
  sessions = [brain, session(EXEC, 'w1', { parentSession: BRAIN }), session(EXEC2, 'w2', { parentSession: BRAIN }), session(AUD, 'w3', { parentSession: BRAIN })];
  for (const record of sessions) upsertSession(record);
}
const deps = () => ({ listSessions: () => sessions, getSession: (name: string) => sessions.find((entry) => entry.name === name), dispatchMessage });
function pairs() {
  return getTaskPairStore().listActivePairs(PROJECT).map((entry) => entry.state);
}
async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    now += 6 * 60_000;
    await automation.tick();
    await flush();
  }
}
function sentTo(target: string, reasonPart?: string) {
  return sent.filter((entry) => entry.target === target && (!reasonPart || entry.id.includes(`:${reasonPart}:`)));
}

/** New work is created through the structured pair path; these tests then
 * exercise ordinary send_message continuation/relay behavior on that pair. */
function openStructuredPair(taskId: string, executor = EXEC, auditor: string | undefined = AUD, brief = 'test work') {
  const transition = taskPairService.implicitDispatch({
    project: PROJECT, sender: BRAIN, target: executor, taskId, auditor,
    brief, hasObjective: true, structuredPairCreate: true,
    suppressAutomaticBrief: true, eventId: `structured-test:${taskId}`,
  });
  if (!transition?.pair) throw new Error(`structured pair was not created: ${taskId}`);
  return transition.pair;
}

describe('Brain work dispatch opens driven pairs', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    // The auditor grace window (suppressAutoPickAuditor) defaults to 5s in
    // production; make it instant here so `flush()` alone still observes the
    // pick, matching every pre-existing assertion in this file.
    process.env.IMCODES_IMPLICIT_AUDITOR_GRACE_MS = '0';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    clearSendIdempotencyCacheForTests();
    dispatchMessage.mockReset().mockResolvedValue('sent');
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    automation = new TaskPairAutomation({
      now: () => now,
      isBusy: () => false,
      isLimited: () => false,
      pickCandidate: ({ exclude }) => (exclude.has(AUD) ? undefined : AUD),
      provision: async () => undefined,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    taskPairService.setScheduler(automation);
  });

  afterEach(() => {
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, EXEC2, AUD]) removeSession(name);
    delete process.env.IMCODES_IMPLICIT_AUDITOR_GRACE_MS;
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  // ---- auto-audit ON: implicit pairs -------------------------------------------

  it('auto-audit on: pair_create opens work and ordinary Brain messages continue the pair', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    expect(resolveProjectAuthoritativeSupervisionSnapshot(PROJECT, sessions).mode).toBe(SUPERVISION_MODE.SUPERVISED_AUDIT);
    const result = openStructuredPair('asr-1', EXEC, AUD, 'Transcribe the three m4a files and summarize decisions.');
    const taskId = result.taskId;
    await flush();
    expect(pairs()).toEqual([expect.objectContaining({
      taskId, brain: BRAIN, executor: EXEC, auditor: AUD, status: 'working',
    })]);

    // Follow-ups to a session already working on a pair continue that pair
    // (bound to it, not a second one).
    const followUp = await dispatchSendMessage(brainCaller, { target: EXEC, message: 'Report progress.' } as never, deps());
    expect(followUp).toMatchObject({ status: 'accepted', taskId });
    // The auditor is a role slot of the SAME open pair (not freshly-dispatch-
    // flagged like the executor above, so this exercises resolveSingleParticipantOpenPair's
    // own participant match rather than the recentBrainDispatch short-circuit):
    // record onto it, never mint a second pair.
    const toAuditor = await dispatchSendMessage(brainCaller, { target: AUD, message: 'Keep auditing.' } as never, deps());
    expect((toAuditor as { taskId?: string }).taskId).toBe(taskId);
    expect(pairs()).toHaveLength(1);

    // A replay of the same send names the same pair.
    clearSendIdempotencyCacheForTests();
    const replay = await dispatchSendMessage(brainCaller, { target: EXEC, message: 'Transcribe the three m4a files and summarize decisions.' } as never, deps());
    expect(replay).toMatchObject({ status: 'accepted', taskId });
    expect(pairs()).toHaveLength(1);
  });

  it('continues every non-terminal participant state, including passed and queued, instead of minting an implicit pair', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    openStructuredPair('nonterminal-continue', EXEC, AUD, 'Initial work.');
    const stored = getTaskPairStore().getPair(PROJECT, 'nonterminal-continue')?.state;
    if (!stored) throw new Error('pair was not created');

    for (const status of TASK_PAIR_PARTICIPANT_STATUSES) {
      const state = {
        ...stored,
        status,
        auditor: status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION ? 'none' : AUD,
        flags: status === 'working' ? ['blocked', 'needs_input'] : [],
        updatedAt: now += 1,
      } as typeof stored;
      getTaskPairStore().savePair(PROJECT, state);
      const followUp = await dispatchSendMessage(brainCaller, {
        target: EXEC, message: `Continue while ${status}.`,
      } as never, deps());
      expect(followUp).toMatchObject({ status: 'accepted', taskId: 'nonterminal-continue' });
      expect(getTaskPairStore().listActivePairs(PROJECT)).toHaveLength(1);
    }

    getTaskPairStore().savePair(PROJECT, { ...stored, status: 'done', updatedAt: now += 1 });
    const fresh = await dispatchSendMessage(brainCaller, { target: EXEC, message: 'Start unrelated work.' } as never, deps());
    expect(fresh.status).toBe('accepted');
    expect((fresh as { taskId?: string }).taskId).toBeUndefined();
    expect(getTaskPairStore().listPairs(PROJECT)).toHaveLength(1);
  });

  it('command mode is not pair traffic: a Brain command neither binds nor records against a pair, and opens none', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    openStructuredPair('cmd-mode-pair', EXEC, AUD, 'Initial work.');
    // Counterexample: an ordinary follow-up to the same participant is recorded onto the pair.
    const ordinary = await dispatchSendMessage(brainCaller, { target: EXEC, message: 'Keep going.' } as never, deps());
    expect(ordinary).toMatchObject({ status: 'accepted', taskId: 'cmd-mode-pair' });
    const afterOrdinary = JSON.stringify(getTaskPairStore().getPair(PROJECT, 'cmd-mode-pair')?.state);

    // The same participant, and a fresh idle target: a command touches no pair.
    for (const target of [EXEC, EXEC2]) {
      const command = await dispatchSendMessage(brainCaller, { target, message: '/compact', command: true } as never, deps());
      expect(command.status).toBe('accepted');
      expect((command as { taskId?: string }).taskId).toBeUndefined();
      expect((command as { deliveries: Array<{ taskId?: string; delegationId?: string }> }).deliveries[0]).not.toHaveProperty('taskId');
    }
    expect(getTaskPairStore().listPairs(PROJECT)).toHaveLength(1);
    expect(JSON.stringify(getTaskPairStore().getPair(PROJECT, 'cmd-mode-pair')?.state)).toBe(afterOrdinary);
    expect(afterOrdinary).not.toBe('undefined');

    // Pair-opening metadata cannot ride a command.
    const withTask = await dispatchSendMessage(brainCaller, {
      target: EXEC2, message: '/compact', command: true, task: { objective: 'sneak a pair' },
    } as never, deps());
    expect(withTask).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(getTaskPairStore().listPairs(PROJECT)).toHaveLength(1);
  });

  it('auto-audit on: send_message cannot create a Brain pair; cron and worker sends open none', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    const withTaskId = await dispatchSendMessage(brainCaller, {
      target: EXEC, message: 'Fix the login bug.', task: { taskId: 'T-login', objective: 'Fix the login bug' },
    } as never, deps());
    expect(withTaskId).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(pairs()).toHaveLength(0);

    // A worker's plain send to an idle worker is collaboration, not a Brain dispatch.
    const execCaller = { ...brainCaller, sessionName: EXEC };
    await dispatchSendMessage(execCaller, { target: EXEC2, message: 'Could you look at this?' } as never, deps());
    expect(pairs()).toHaveLength(0);

    await dispatchCronSend({ fromSessionName: BRAIN, target: EXEC2, message: 'Hourly: report status.' }, deps());
    expect(pairs()).toHaveLength(0);
  });

  // ---- 215/jdzj: implicit_dispatch minting duplicate wrapper pairs -----------

  it('a relay to a participant whose text names an existing open pair binds to it', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    openStructuredPair('tsk_send_mention_existing', EXEC, AUD, 'Fix the login bug.');
    expect(pairs()).toHaveLength(1);

    // A relay to the pair executor remains attached to that pair.
    const notice = await dispatchSendMessage(brainCaller, {
      target: EXEC, message: 'tsk_send_mention_existing has been requeued; the audit window is pre-assigned.',
    } as never, deps());
    expect(notice).toMatchObject({ status: 'accepted', taskId: 'tsk_send_mention_existing' });
    await flush();
    expect(pairs()).toHaveLength(1);
  });

  it('a plain mention of another pair stays with the target participant\'s own pair', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    openStructuredPair('tsk_send_mention_own', EXEC, AUD, 'Work A.');
    openStructuredPair('tsk_send_mention_other', EXEC2, AUD, 'Work B.');

    const status = await dispatchSendMessage(brainCaller, {
      target: EXEC, message: 'Status update: tsk_send_mention_other is waiting on audit.',
    } as never, deps());
    expect(status).toMatchObject({ status: 'accepted', taskId: 'tsk_send_mention_own' });
    expect(pairs()).toHaveLength(2);
  });

  it('does not create a pair for a plain note to an idle target merely because the note mentions another task', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    openStructuredPair('tsk_mention_idle_source', EXEC, AUD, 'Work A.');
    const note = await dispatchSendMessage(brainCaller, {
      target: EXEC2, message: 'Status only: tsk_mention_idle_source is complete.',
    } as never, deps());
    expect(note).toMatchObject({ status: 'accepted' });
    expect(note).not.toHaveProperty('taskId');
    expect(pairs()).toHaveLength(1);
  });

  it('an explicit objective that merely mentions another open pair still opens its own pair for a fresh target (CC8 P2)', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    openStructuredPair('tsk_send_mention_other', EXEC, AUD, 'Fix the login bug.');
    expect(pairs()).toHaveLength(1);

    // Real new work for a target that is NOT part of tsk_send_mention_other: the text
    // referencing it is context, not a request to continue that pair.
    const newWork = await dispatchSendMessage(brainCaller, {
      target: EXEC2, message: 'Fix Y -- follow-up to tsk_send_mention_other.', task: { objective: 'Fix Y' },
    } as never, deps());
    expect(newWork).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(pairs()).toHaveLength(1);
  });

  it('a handover message to the reassigned executor of an existing pair binds to it, never opening a second pair', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    openStructuredPair('T-handover', EXEC, AUD, 'Fix the login bug.');
    await taskPairService.ingestText(PROJECT, BRAIN, `<!-- IMCODES_TASK DISPATCH T-handover executor=${EXEC2} -->`, 'handover-marker', now);
    await flush();
    expect(pairs()[0]).toMatchObject({ taskId: 'T-handover', executor: EXEC2 });

    // A plain handover message to the NEW executor -- already a role slot of
    // the one open pair -- continues it instead of minting a second one.
    const handover = await dispatchSendMessage(brainCaller, {
      target: EXEC2, message: 'Please continue from where the previous executor left off.',
    } as never, deps());
    expect(handover).toMatchObject({ status: 'accepted', taskId: 'T-handover' });
    await flush();
    expect(pairs()).toHaveLength(1);
  });

  it('rejects a bare implicit Brain dispatch so a late marker cannot create a pair outside pair_create', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    const taskId = 'T-race';
    const dispatched = await dispatchSendMessage(brainCaller, {
      target: EXEC, message: 'Starting work.', task: { taskId },
    } as never, deps());
    expect(dispatched).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(pairs()).toHaveLength(0);
  });

  it('auto-audit off: a plain Brain send opens no pair (the project chose no automatic audit)', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.OFF));
    const result = await dispatchSendMessage(brainCaller, { target: EXEC, message: 'Please tidy the README.' } as never, deps());
    expect(result).toMatchObject({ status: 'accepted' });
    expect((result as { taskId?: string }).taskId).toBeUndefined();
    expect(pairs()).toHaveLength(0);
  });

  // ---- auto-audit OFF + user-requested audit: the pair heartbeat drives it ---------

  it('auto-audit off: user-requested audited work runs as a pair the daemon heartbeat drives until DONE, with one heartbeat source', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.OFF));
    // Brain opens it as its contract says, leaving the auditor to the daemon.
    await taskPairService.ingestText(PROJECT, BRAIN, `<!-- IMCODES_TASK DISPATCH U1 executor=${EXEC} -->`, 'user-audit-1', now);
    await flush();
    expect(pairs()).toEqual([expect.objectContaining({ taskId: 'U1', executor: EXEC, auditor: AUD, status: 'working' })]);
    // Covered by the pair heartbeat: session-mode heartbeats and nudges stand down for both sides.
    expect(isSessionCoveredByPairHeartbeat(EXEC)).toBe(true);
    expect(isSessionCoveredByPairHeartbeat(AUD)).toBe(true);
    sent = [];
    await tick(1);
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(1);

    taskPairService.ingestText(PROJECT, EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT U1 path=/workspace -->', 'user-audit-2', now + 1);
    taskPairService.ingestText(PROJECT, AUD, '<!-- IMCODES_TASK PASS U1 blocking=P0 -->', 'user-audit-3', now + 2);
    taskPairService.ingestText(PROJECT, EXEC, '<!-- IMCODES_TASK DONE U1 -->', 'user-audit-4', now + 3);
    await flush();
    expect(getTaskPairStore().getPair(PROJECT, 'U1')?.state.status).toBe('done');
    // Stopped at done: no nudges, no coverage left.
    sent = [];
    await tick(3);
    expect(sent).toHaveLength(0);
    expect(isSessionCoveredByPairHeartbeat(EXEC)).toBe(false);
    expect(isSessionCoveredByPairHeartbeat(AUD)).toBe(false);
  });

  it('tells a Brain on a pairs project to open a pair for audited work and never to add its own heartbeat; only legacy keeps the Brain cron', () => {
    const pairsManual = JSON.parse(buildBrainManualOnlyDelegationContract()) as { manual: { auditedWork: Record<string, unknown> } };
    expect(pairsManual.manual.auditedWork).toEqual(BRAIN_MANUAL_AUDITED_WORK.pairs);
    expect(pairsManual.manual.auditedWork).toMatchObject({ route: 'task_pair', brainCronSelf: 'forbidden', auditor: 'named_or_daemon_auto_pick' });
    const legacyManual = JSON.parse(buildBrainManualOnlyDelegationContract(undefined, { taskPairEngine: 'legacy' })) as { manual: { auditedWork: Record<string, unknown> } };
    expect(legacyManual.manual.auditedWork).toEqual(BRAIN_MANUAL_AUDITED_WORK.legacy);
    expect(String(legacyManual.manual.auditedWork.heartbeat)).toContain('cron_create_self');
    expect(legacyManual.manual.auditedWork.stop).toBe('cron_cancel_self_when_finished');
    const supervised = JSON.parse(buildBrainSupervisedWorkDelegationContract()) as { heartbeat: Record<string, unknown> };
    expect(supervised.heartbeat).toEqual({ source: 'daemon_builtin', brainCronSelf: 'forbidden' });
    // A registered legacy variant is re-asserted as legacy, never as the pairs one.
    expect(buildBrainWorkDelegationContractRef(false, 'legacy')).not.toBe(buildBrainWorkDelegationContractRef(false, 'pairs'));

  });

  it('a project left in mode off with no explicit engine gets neither pairs nor legacy Brain contract, and the off variant states the project-workflow precedence', () => {
    const offManual = JSON.parse(buildBrainManualOnlyDelegationContract(undefined, { taskPairEngine: 'off' })) as { manual: { auditedWork: Record<string, unknown> } };
    expect(offManual.manual.auditedWork).toEqual(BRAIN_MANUAL_AUDITED_WORK.off);
    expect(offManual.manual.auditedWork).not.toEqual(BRAIN_MANUAL_AUDITED_WORK.pairs);
    expect(offManual.manual.auditedWork).not.toEqual(BRAIN_MANUAL_AUDITED_WORK.legacy);
    expect(offManual.manual.auditedWork.route).not.toBe('task_pair');
    expect(offManual.manual.auditedWork.heartbeat).toBe('none');
    expect(String(offManual.manual.auditedWork.precedence)).toContain('takes precedence');
    const offRef = JSON.parse(buildBrainWorkDelegationContractRef(false, 'off')) as { engine?: string };
    expect(offRef.engine).toBe('off');
  });

  it('tells Brain to ask the user before starting a pair on a not-enabled project, and to never override the project\'s own workflow without an explicit yes', () => {
    const offManual = JSON.parse(buildBrainManualOnlyDelegationContract(undefined, { taskPairEngine: 'off' })) as { manual: { auditedWork: Record<string, unknown> } };
    const authorization = String(offManual.manual.auditedWork.authorization);
    expect(authorization).toContain('never auto-start');
    expect(authorization).toContain('ask');
    expect(authorization).toContain('explicit');
    expect(authorization).toContain('yes');
    // The only real consent path: enabling it in Settings, since no tool or
    // marker can turn the engine on for an off project (that's the gap CC1's
    // P0-1 found -- there must be one real, working "yes" path, not just text).
    expect(authorization).toContain('Session/Project Settings');
    expect(authorization).toContain('Task Pairs');
    expect(authorization).toContain('no tool or marker can enable it');
    // Pairs and legacy projects (already enabled) get no such gate -- the
    // ask-first rule is specific to a project that opted out or never opted in.
    const pairsManual = JSON.parse(buildBrainManualOnlyDelegationContract()) as { manual: { auditedWork: Record<string, unknown> } };
    expect(pairsManual.manual.auditedWork.authorization).toBeUndefined();
  });

  // ---- legacy coordinator start ---------------------------------------------------

  it('rejects a legacy coordinator start; new Brain work must use pair_create', async () => {
    useSessions(brainWithMode(SUPERVISION_MODE.OFF));
    const started = await handleLegacyToolOnPairs(MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START, BRAIN, {
      role: 'coordinator', objective: 'Add tenant domain binding', idempotencyKey: 'tenant-1',
    });
    expect(started).toMatchObject({ status: 'error', engine: 'pairs', applied: 'rejected', reason: 'scope_forbidden' });
    expect(String(started.error)).toContain('pair_create');
    expect(pairs()).toHaveLength(0);
  });
});

describe('a pool with no auditor-role entry (jdzj)', () => {
  const jdzjPools = {
    state: 'configured',
    economyTaskPool: { configs: [], controls: { leaseMs: 900000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
    primaryDevelopmentPool: {
      // Explicit executor-only role: the owner marked this entry executor-only,
      // so it can never satisfy the auditor role, no matter how idle it is.
      configs: [{ model: 'sonnet', agentType: 'claude-code-sdk', runtimeType: 'transport', capabilityId: 'supervision-exec-v1:transport:claude-code-sdk:anthropic:sonnet', providerFamily: 'anthropic', role: 'executor' as const }],
      controls: { leaseMs: 1800000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 },
    },
  };
  const opusConfig = () => {
    const model = normalizeSupervisionExecutionModel('claude-code-sdk', 'opus');
    const config = { agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport' as const, model, role: 'auditor' as const };
    return { ...config, capabilityId: buildSupervisionExecutionCapabilityId(config) };
  };
  const opusPools = {
    ...jdzjPools,
    primaryDevelopmentPool: {
      ...jdzjPools.primaryDevelopmentPool,
      configs: [...jdzjPools.primaryDevelopmentPool.configs, opusConfig()],
    },
  };
  const brain = (executionPools: unknown) => session(BRAIN, 'brain', {
    transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, executionPools }) },
  } as Partial<SessionRecord>);
  const opusWorker = session('deck_sub_dispopus', 'w4', {
    parentSession: BRAIN, runtimeType: 'transport', activeModel: 'claude-opus-5-5', requestedModel: 'opus',
  } as Partial<SessionRecord>);

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    // The auditor grace window (suppressAutoPickAuditor) defaults to 5s in
    // production; make it instant here so `flush()` alone still observes the
    // pick, matching every pre-existing assertion in this file.
    process.env.IMCODES_IMPLICIT_AUDITOR_GRACE_MS = '0';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  });
  afterEach(() => {
    setTaskPairStoreForTests(undefined);
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    delete process.env.IMCODES_IMPLICIT_AUDITOR_GRACE_MS;
  });

  it('can never pick the idle Opus session outside an executor-only pool, and says exactly what to add', () => {
    const records = [brain(jdzjPools), opusWorker];
    const lookup = (name: string) => records.find((entry) => entry.name === name);
    expect(listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', exclude: new Set(),
    }, { listSessions: () => records, getSession: lookup, hasPendingMessages: () => false })).toEqual([]);
    const gap = describeAuditorPoolGap({ brain: BRAIN }, { getSession: lookup });
    expect(gap).toContain('claude-code-sdk/sonnet');
    expect(gap).toContain('no pool entry has the auditor role');
    expect(gap).toContain('Settings → execution pool');

    // With an Opus (auditor-role) config in the pool, a miss is now a
    // transient capacity issue, not a structural config gap.
    const fixed = [brain(opusPools), opusWorker];
    const fixedGap = describeAuditorPoolGap({ brain: BRAIN }, {
      getSession: (name) => fixed.find((entry) => entry.name === name),
    });
    expect(fixedGap).toContain('every auditor-role session in the primary pool is busy');
    expect(fixedGap).not.toContain('no pool entry has the auditor role');
  });

  it('puts the gap into the needs_auditor notice Brain receives', async () => {
    upsertSession(brain(jdzjPools));
    upsertSession(session(EXEC, 'w1', { parentSession: BRAIN }));
    const notices: string[] = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { if (target === BRAIN && id.includes(':brain-needs_auditor:')) notices.push(text); } });
    const scheduler = new TaskPairAutomation({
      now: () => now, isBusy: () => false, isLimited: () => false,
      pickCandidate: () => undefined, provision: async () => undefined, poolOf: () => 'primary', importLegacy: () => undefined,
    });
    taskPairService.setScheduler(scheduler);
    try {
      taskPairService.ingestText(PROJECT, BRAIN, `<!-- IMCODES_TASK DISPATCH G1 executor=${EXEC} -->`, 'gap-1', now);
      await flush();
      // A fresh DISPATCH now queues (capacity-gated like QUEUE): an ordinary
      // queue miss is silent by design (scheduler.ts#runQueueOnce). REASSIGN
      // still triggers an immediate pick attempt on the existing pair
      // regardless of status, which is what this gap-diagnostic is about.
      taskPairService.ingestText(PROJECT, BRAIN, '<!-- IMCODES_TASK REASSIGN G1 -->', 'gap-1b', now);
      await flush();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('Why: no pool entry has the auditor role');
    } finally {
      taskPairService.setScheduler(undefined);
      setTaskPairDeliveryDepsForTests(undefined);
      removeSession(BRAIN);
      removeSession(EXEC);
    }
  });
});
