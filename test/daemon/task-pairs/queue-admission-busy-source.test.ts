/**
 * What "busy" means for queue admission (tsk_cd_queue_admission_stale_busy).
 * Incident: a queued pair naming an idle session (state idle, nothing queued)
 * logged "waiting for <session> (session busy)" every 30 s for 30+ minutes,
 * because the shared live-work predicate also counted leftover provider
 * background/tool counters, which can stay above zero long after the session
 * went quiet. Turn-level busy signals must still block; fresh background work
 * still counts; only counters that have been quiet for
 * TASK_PAIR_STALE_RESIDUAL_WORK_MS stop holding a pair back, and the wait
 * reason now says WHY the session is busy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord } from '../../../src/store/session-store.js';
import type { TransportRuntimeDiagnosticSnapshot } from '../../../src/agent/transport-session-runtime.js';
import { getSession, removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { describeSessionBusy, isSessionBusy, type TaskPairPoolDeps } from '../../../src/daemon/task-pairs/pool.js';
import { describeSessionWork } from '../../../src/daemon/session-working.js';
import { clearSupervisionHeartbeatProjectionsForTests } from '../../../src/daemon/supervision-heartbeat-projection.js';
import { TASK_PAIR_STALE_RESIDUAL_WORK_MS } from '../../../shared/task-pair.js';

const PROJECT = 'qbproj';
const BRAIN = 'deck_qbproj_brain';
const EXEC = 'deck_sub_qbexec';
const AUD = 'deck_sub_qbaud';
const QUIET = TASK_PAIR_STALE_RESIDUAL_WORK_MS + 60_000;
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;

function snapshot(over: Record<string, unknown> = {}) {
  return {
    status: 'idle', sending: false, pendingCount: 0, pendingVersion: 0, activeDispatchCount: 0, stalePendingRecoveryActive: false,
    providerSessionBound: true, lastActivityAt: 1, lastActivityAgeMs: QUIET, lastProviderOutputAt: 1, lastProviderOutputAgeMs: QUIET,
    activityGeneration: { scope: 'session', sessionName: EXEC, generation: 1 },
    blockingWorkCount: 0, backgroundWorkCount: 0, activeToolCount: 0, busyReasons: [], ...over,
  };
}
// The real busy predicate, fed a per-session transport snapshot (the seam session-working already has).
const runtimes = new Map<string, TransportRuntimeDiagnosticSnapshot>();
const probe: TaskPairPoolDeps = {
  getSession,
  getDiagnosticSnapshot: (name) => runtimes.get(name),
  hasPendingMessages: (name) => (runtimes.get(name)?.pendingCount ?? 0) > 0,
};
const setRuntime = (name: string, over: Record<string, unknown> = {}, pending = 0) => {
  runtimes.set(name, snapshot({ pendingCount: pending, ...over }) as unknown as TransportRuntimeDiagnosticSnapshot);
};
function session(name: string, role: SessionRecord['role'], state: SessionRecord['state'] = 'idle'): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state,
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
const pair = (taskId: string) => getTaskPairStore().getPair(PROJECT, taskId)!.state;
const marker = (writer: string, line: string) => { turn += 1; return taskPairService.ingestText(PROJECT, writer, line, `qb-turn-${turn}`, Date.now()); };
async function flush() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await taskPairService.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (taskPairService.pendingCount === 0) return;
  }
}

describe('busy source for queue admission', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let automation: TaskPairAutomation;
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    clearSupervisionHeartbeatProjectionsForTests();
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    runtimes.clear();
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')]) upsertSession(record);
    setRuntime(EXEC);
    setRuntime(AUD);
    // No isBusy override: the real predicate over the (mocked) transport runtimes.
    automation = new TaskPairAutomation({ importLegacy: () => undefined, poolOf: () => 'primary', busyProbe: probe });
    taskPairService.setScheduler(automation);
  });
  afterEach(async () => {
    await flush();
    clearSupervisionHeartbeatProjectionsForTests();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    runtimes.clear();
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('INCIDENT: an idle session whose provider background counter never drained (quiet for minutes) no longer holds a queued pair', async () => {
    setRuntime(EXEC, { backgroundWorkCount: 1, activeToolCount: 1, busyReasons: ['provider_background'] });
    expect(describeSessionBusy(EXEC, probe)).toEqual([]);
    expect(isSessionBusy(EXEC, probe)).toBe(false);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH Q1 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('Q1').status).toBe('working');
  });

  it('fresh background work still counts as working, and the wait reason says which counter', async () => {
    setRuntime(EXEC, { backgroundWorkCount: 2, lastActivityAgeMs: 30_000, lastProviderOutputAgeMs: 30_000 });
    expect(isSessionBusy(EXEC, probe)).toBe(true);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH Q2 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    expect(pair('Q2').status).toBe('queued');
    expect(pair('Q2').capacityWaitReason).toBe(`waiting for ${EXEC} (session busy: background_work(2))`);
    // The counter drains (or goes stale): the next admission pass starts it.
    setRuntime(EXEC);
    await automation.runQueue(PROJECT, BRAIN);
    await flush();
    expect(pair('Q2').status).toBe('working');
  });

  it('either quiet clock is enough to be "recent": recent provider output OR recent activity keeps background work counted', () => {
    setRuntime(EXEC, { backgroundWorkCount: 1, lastActivityAgeMs: QUIET, lastProviderOutputAgeMs: 1_000 });
    expect(isSessionBusy(EXEC, probe)).toBe(true);
    setRuntime(EXEC, { backgroundWorkCount: 1, lastActivityAgeMs: 1_000, lastProviderOutputAgeMs: null });
    expect(isSessionBusy(EXEC, probe)).toBe(true);
    setRuntime(EXEC, { backgroundWorkCount: 1, lastActivityAgeMs: QUIET, lastProviderOutputAgeMs: null });
    expect(isSessionBusy(EXEC, probe)).toBe(false);
  });

  it('turn-level signals block no matter how quiet the session is: blocking work, a send in flight, active dispatch, queued messages, thinking status, running state', () => {
    const cases: Array<[string, Record<string, unknown>, number, SessionRecord['state'], string]> = [
      ['blocking work', { blockingWorkCount: 1 }, 0, 'idle', 'blocking_work(1)'],
      ['sending', { sending: true }, 0, 'idle', 'sending'],
      ['active dispatch', { activeDispatchCount: 1 }, 0, 'idle', 'active_dispatch(1)'],
      ['queued messages', {}, 2, 'idle', 'pending_messages(2)'],
      ['thinking', { status: 'thinking' }, 0, 'idle', 'status_thinking'],
      ['running state', {}, 0, 'running', 'state_running'],
    ];
    for (const [name, over, pending, state, reason] of cases) {
      upsertSession(session(EXEC, 'w1', state));
      setRuntime(EXEC, { backgroundWorkCount: 1, ...over }, pending);
      expect(isSessionBusy(EXEC, probe), name).toBe(true);
      expect(describeSessionBusy(EXEC, probe), name).toContain(reason);
    }
  });

  it('describeSessionWork: stale residual counters are reported but ignored only when a threshold is given; plain isSessionWorking keeps its meaning', () => {
    setRuntime(EXEC, { backgroundWorkCount: 1 });
    const strict = describeSessionWork(EXEC, { getSession, getDiagnosticSnapshot: (n) => runtimes.get(n) });
    expect(strict).toEqual({ working: true, reasons: ['background_work(1)'], staleResidualIgnored: false });
    const lenient = describeSessionWork(EXEC, { getSession, getDiagnosticSnapshot: (n) => runtimes.get(n) }, { staleResidualAfterMs: TASK_PAIR_STALE_RESIDUAL_WORK_MS });
    expect(lenient).toEqual({ working: false, reasons: ['background_work(1)'], staleResidualIgnored: true });
    expect(describeSessionWork('deck_sub_unknown')).toEqual({ working: false, reasons: [], staleResidualIgnored: false });
  });

  it('a session with no runtime at all (not a transport session) is idle unless its state says running', () => {
    runtimes.delete(EXEC);
    expect(isSessionBusy(EXEC, probe)).toBe(false);
    upsertSession(session(EXEC, 'w1', 'running'));
    expect(isSessionBusy(EXEC, probe)).toBe(true);
  });
});
