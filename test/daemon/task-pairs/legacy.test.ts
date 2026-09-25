import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import {
  answerLegacyToolInDaemon,
  handleLegacyToolOnPairs,
  severityCountsFromFindings,
  withPairsLegacyTools,
} from '../../../src/daemon/task-pairs/legacy-tools.js';
import { importLegacyTasks, mapLegacyStatus } from '../../../src/daemon/task-pairs/legacy-import.js';
import { dispatchReadyAudit, runSupervisionConvergenceTick } from '../../../src/daemon/send-tool.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { SUPERVISION_MCP_TOOLS } from '../../../shared/supervision-mcp-tools.js';
import type { SupervisionTaskSnapshot } from '../../../src/daemon/supervision-state-store.js';

const PROJECT = 'legacyproj';
const BRAIN = 'deck_legacyproj_brain';
const EXEC = 'deck_sub_legacyexec';
const AUD = 'deck_sub_legacyaud';

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

let turn = 0;
function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `legacy-turn-${turn}`);
}
function pair(taskId: string) {
  return getTaskPairStore().getPair(PROJECT, taskId)?.state;
}

describe('legacy supervision tools and migration on the pairs engine', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w1'), session(AUD, 'w2')]) upsertSession(record);
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH L1 executor=${EXEC} auditor=${AUD} -->`);
  });

  afterEach(() => {
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('regression: record_validation succeeds whatever the legacy status was', async () => {
    const result = await handleLegacyToolOnPairs(SUPERVISION_MCP_TOOLS.INTENT, EXEC, {
      intent: 'record_validation', taskId: 'L1', validationState: 'passed',
    });
    expect(result).toMatchObject({ status: 'ok', engine: 'pairs', taskId: 'L1', pairStatus: 'in_audit' });
    expect(String(result.hint)).toContain('IMCODES_TASK');
  });

  it('regression: open_audit without any exact ready revision moves to audit', async () => {
    const result = await handleLegacyToolOnPairs(SUPERVISION_MCP_TOOLS.INTENT, EXEC, { intent: 'open_audit', taskId: 'L1' });
    expect(result).toMatchObject({ status: 'ok', pairStatus: 'in_audit' });
  });

  it('regression: finish with gitignored deliverables and no revision completes after a PASS', async () => {
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT L1 -->');
    marker(AUD, '<!-- IMCODES_TASK PASS L1 blocking=P0 -->');
    const result = await handleLegacyToolOnPairs(MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH, EXEC, {
      assignmentId: 'asg_unknown', evidence: 'deliverables are gitignored',
    });
    expect(result).toMatchObject({ status: 'ok', taskId: 'L1', pairStatus: 'done' });
  });

  it('keeps DONE-without-PASS semantics for a legacy finish', async () => {
    const result = await handleLegacyToolOnPairs(MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH, EXEC, { assignmentId: 'x' });
    expect(result).toMatchObject({ status: 'ok', pairStatus: 'awaiting_audit' });
  });

  it('maps peer_audit_reply findings to severity counts judged like a marker', async () => {
    expect(severityCountsFromFindings('[P0] null deref\n[P1] naming\n[P1] docs')).toEqual({ p0: '1', p1: '2' });
    expect(severityCountsFromFindings('- [P2] wording\n1. [P3] naming')).toEqual({ p2: '1', p3: '1' });
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT L1 -->');
    const rework = await handleLegacyToolOnPairs(MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY, AUD, {
      taskId: 'L1', verdict: 'REWORK', findings: '[P0] login null deref\n[P2] wording',
    });
    expect(rework).toMatchObject({ status: 'ok', pairStatus: 'rework' });
    expect(pair('L1')?.lastVerdict?.counts).toMatchObject({ P0: 1, P2: 1 });
  });

  it('judges a realistic legacy PASS that mentions P0 in prose as consistent', async () => {
    const receipt = 'PASS: no P0 finding. Only P0 blocks.\nPASS. blocking=P0, P0=0 P1=0 P2=1\n[P2] minor wording in the README';
    expect(severityCountsFromFindings(receipt)).toEqual({ p2: '1' });
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT L1 -->');
    const pass = await handleLegacyToolOnPairs(MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY, AUD, { taskId: 'L1', verdict: 'PASS', findings: receipt });
    expect(pass).toMatchObject({ status: 'ok', pairStatus: 'passed' });
    expect(pair('L1')?.flags).not.toContain('verdict_inconsistent');
  });

  it('records status-only legacy calls from the auditor without pulling the pair out of audit', async () => {
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT L1 -->');
    for (const [tool, args] of [
      [SUPERVISION_MCP_TOOLS.INTENT, { intent: 'heartbeat', taskId: 'L1' }],
      [SUPERVISION_MCP_TOOLS.INTENT, { intent: 'claim', taskId: 'L1' }],
      [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE, { assignmentId: 'x' }],
    ] as const) {
      expect(await handleLegacyToolOnPairs(tool, AUD, args)).toMatchObject({ applied: 'recorded', pairStatus: 'in_audit' });
    }
    expect(pair('L1')?.status).toBe('in_audit');
  });

  it('never changes pair roles through a legacy tool', async () => {
    await handleLegacyToolOnPairs(MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START, AUD, {
      taskId: 'L1', role: 'implementer', objective: 'take over',
    });
    expect(pair('L1')).toMatchObject({ executor: EXEC, auditor: AUD });
  });

  it('answers list, get and administrative tools without refusing', async () => {
    expect(await handleLegacyToolOnPairs(SUPERVISION_MCP_TOOLS.LIST, BRAIN, {})).toMatchObject({
      status: 'ok', tasks: [expect.objectContaining({ taskId: 'L1', status: 'working' })],
    });
    expect(await handleLegacyToolOnPairs(SUPERVISION_MCP_TOOLS.GET, EXEC, { taskId: 'L1' })).toMatchObject({
      status: 'ok', task: expect.objectContaining({ taskId: 'L1' }),
    });
    for (const tool of [SUPERVISION_MCP_TOOLS.RECOVER, SUPERVISION_MCP_TOOLS.HOUSEKEEPING, MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT, MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_PREFLIGHT]) {
      expect(await handleLegacyToolOnPairs(tool, EXEC, {})).toMatchObject({ status: 'ok', engine: 'pairs' });
    }
  });

  it('routes wrapped handlers to pairs only for pairs projects', async () => {
    const original = vi.fn(async () => ({ status: 'error', reason: 'old_revision' }));
    const handlers = withPairsLegacyTools(EXEC, { [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]: original });
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({ assignmentId: 'x' })).toMatchObject({ status: 'ok', engine: 'pairs' });
    expect(original).not.toHaveBeenCalled();
    getTaskPairStore().setProjectEngine(PROJECT, 'legacy');
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]({ assignmentId: 'x' })).toMatchObject({ reason: 'old_revision' });
  });

  it('lets an MCP child hand calls to the daemon and fall back to the tool when declined or unreachable', async () => {
    const original = vi.fn(async () => ({ status: 'error', reason: 'old_revision' }));
    const answered = withPairsLegacyTools(EXEC, { [SUPERVISION_MCP_TOOLS.INTENT]: original }, async (tool, args) => answerLegacyToolInDaemon(tool, EXEC, args));
    expect(await answered[SUPERVISION_MCP_TOOLS.INTENT]({ intent: 'open_audit', taskId: 'L1' })).toMatchObject({ status: 'ok', pairStatus: 'in_audit' });
    expect(original).not.toHaveBeenCalled();
    const declined = withPairsLegacyTools(EXEC, { [SUPERVISION_MCP_TOOLS.INTENT]: original }, async () => ({ handled: false }));
    expect(await declined[SUPERVISION_MCP_TOOLS.INTENT]({})).toMatchObject({ reason: 'old_revision' });
    const unreachable = withPairsLegacyTools(EXEC, { [SUPERVISION_MCP_TOOLS.INTENT]: original }, async () => { throw new Error('ECONNREFUSED'); });
    expect(await unreachable[SUPERVISION_MCP_TOOLS.INTENT]({})).toMatchObject({ reason: 'old_revision' });
    expect(await answerLegacyToolInDaemon('search_memory', EXEC, {})).toEqual({ handled: false });
  });

  it('turns off automatic audit dispatch and convergence for pairs projects', async () => {
    const registry = { get: () => ({ taskId: 'tsk_1', projectName: PROJECT, status: 'ready_for_audit', assignments: [] }) };
    expect(await dispatchReadyAudit('tsk_1', { registry: registry as never })).toEqual({ status: 'ignored', reason: 'pairs_engine' });
    const convergeLifecycle = vi.fn(async () => []);
    await runSupervisionConvergenceTick({ registry: { convergeLifecycle, list: () => [] } as never });
    const options = convergeLifecycle.mock.calls[0]?.[1] as { skipProject?: (project: string) => boolean };
    expect(options.skipProject?.(PROJECT)).toBe(true);
  });
});

describe('one-time legacy import', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  });
  afterEach(() => {
    setTaskPairStoreForTests(undefined);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  function task(taskId: string, status: string, assignments: Array<[string, string, string]>, projectName = PROJECT): SupervisionTaskSnapshot {
    return {
      taskId, projectName, status, objective: `objective of ${taskId}\nmore`,
      assignments: assignments.map(([role, sessionName, assignmentStatus]) => ({
        role, status: assignmentStatus, identity: { sessionName },
      })),
    } as unknown as SupervisionTaskSnapshot;
  }

  it('maps every legacy status', () => {
    expect(mapLegacyStatus('delegated')?.status).toBe('queued');
    expect(mapLegacyStatus('retrying_external_ci')?.status).toBe('working');
    expect(mapLegacyStatus('rework')?.status).toBe('rework');
    expect(mapLegacyStatus('validated')?.status).toBe('in_audit');
    expect(mapLegacyStatus('committed')?.status).toBe('passed');
    expect(mapLegacyStatus('blocked')).toBeUndefined();
    expect(mapLegacyStatus('recovered')).toBeUndefined();
  });

  it('never imports parked blocked/recovered tasks as open or passed pairs, telling Brain once', async () => {
    const tasks = [
      task('tsk_recovered', 'recovered', [['coordinator', BRAIN, 'implementing'], ['implementer', EXEC, 'recovered']]),
      task('tsk_blocked', 'blocked', [['implementer', EXEC, 'blocked']]),
    ];
    const notices: Array<[string, string]> = [];
    const registry = { list: () => tasks };
    // An undelivered notice (Brain absent) is retried on a later pass.
    importLegacyTasks(registry, 4_000, () => false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(importLegacyTasks(registry, 5_000, (brain, text) => { notices.push([brain, text]); return true; })).toBe(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_recovered')).toBeUndefined();
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_blocked')).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.[0]).toBe(BRAIN);
    expect(notices[0]?.[1]).toContain('tsk_recovered (recovered)');
    expect(notices[0]?.[1]).toContain('tsk_blocked (blocked)');
    // A later start does not repeat the notice.
    importLegacyTasks(registry, 6_000, (brain, text) => { notices.push([brain, text]); return true; });
    expect(notices).toHaveLength(1);
  });

  it('imports in-flight tasks once, skipping terminal ones and legacy-engine projects', () => {
    const tasks = [
      task('tsk_stuck', 'validated', [['coordinator', BRAIN, 'implementing'], ['implementer', EXEC, 'ready_for_audit'], ['auditor', AUD, 'auditing']]),
      task('tsk_noaud', 'implementing', [['implementer', EXEC, 'implementing']]),
      task('tsk_done', 'finalized', [['implementer', EXEC, 'finalized']]),
      task('tsk_other', 'implementing', [['implementer', EXEC, 'implementing']], 'rolledbackproj'),
    ];
    getTaskPairStore().setProjectEngine('rolledbackproj', 'legacy');
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    const registry = { list: () => tasks };
    expect(importLegacyTasks(registry, 5_000)).toBe(2);
    expect(importLegacyTasks(registry, 6_000)).toBe(0);
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_stuck')?.state).toMatchObject({
      status: 'in_audit', executor: EXEC, auditor: AUD, brain: BRAIN, title: 'objective of tsk_stuck',
    });
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_noaud')?.state).toMatchObject({
      status: 'working', executor: EXEC, flags: ['needs_auditor'], brain: 'deck_legacyproj_brain',
    });
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_done')).toBeUndefined();
    expect(getTaskPairStore().getPair('rolledbackproj', 'tsk_other')).toBeUndefined();
    // Every imported pair is nudged on the next tick.
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_stuck')?.liveness.progressAuditorAt).toBe(0);
  });
});
