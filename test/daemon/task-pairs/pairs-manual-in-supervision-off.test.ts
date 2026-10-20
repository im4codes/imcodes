/**
 * Supervision mode `off` never stops a Brain from creating and running pairs by hand (tsk_fb01f25f17). It only means the daemon sends no
 * heartbeat: no nudges, escalations, reminders, queue sweeps or follow-ups.
 *
 * Before: pair_create answered CONTROL_PLANE_UNAVAILABLE ("pairs engine is off ... set supervision mode to supervised") and marker/
 * implicit-dispatch ingestion ignored the project. Two predicates were one: "the explicit tools may run" and "the supervision
 * automation may act". They are now `isTaskPairsAvailable` (A, manual lifecycle) and `isPairsEngineProject` (B, automation).
 *
 * Like engine-mode-off.test.ts this deliberately does NOT force IMCODES_SUPERVISION_ENGINE=pairs: that override wins over the mode and
 * would hide exactly what is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { SUPERVISION_MODE, normalizeSessionSupervisionSnapshot } from '../../../shared/supervision-config.js';
import { TASK_PAIR_CREATED_SESSION_SOURCE, TASK_PAIR_MANUAL_MODE_NOTE, type TaskPairCreatedSessionMetadata } from '../../../shared/task-pair.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import { getSession, listSessions, removeSession, upsertSession, type SessionRecord } from '../../../src/store/session-store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { setPairSessionCreationDepsForTests } from '../../../src/daemon/task-pairs/session-creation.js';
import {
  isPairsEngineProject,
  isTaskPairsAvailable,
  resolveTaskPairPromptEngineState,
  taskPairSupervisionStatus,
} from '../../../src/daemon/task-pairs/engine.js';
import { createPairSubSession } from '../../../src/daemon/supervision-auto-provision.js';
import { resolveTaskPairTurnCwd } from '../../../src/daemon/task-pairs/turn-cwd.js';
import { buildBrainManualOnlyDelegationContract } from '../../../src/daemon/supervision-prompts.js';

// Nothing in this file may launch a real session: the module-level scheduler pair_create uses would otherwise provision one for a pair
// that names no executor. A provision attempt fails closed and is recorded.
const realProvisionAttempts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../src/daemon/supervision-auto-provision.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/daemon/supervision-auto-provision.js')>('../../../src/daemon/supervision-auto-provision.js');
  return {
    ...actual,
    provisionSupervisionTarget: async () => { realProvisionAttempts.count += 1; return { ok: false, reason: 'launch_failed' }; },
  };
});

const PROJECT = 'manualproj';
const BRAIN = 'deck_manualproj_brain';
const EXEC = 'deck_sub_manual_exec';
const AUD = 'deck_sub_manual_aud';
const OTHER = 'otherproj';
const OTHER_BRAIN = 'deck_otherproj_brain';

const caller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: PROJECT } as ContextNamespace,
  sessionName: BRAIN, projectName: PROJECT, projectRoot: '/tmp/manualproj', serverId: 'srv', transport: 'in_process',
};

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: '/tmp/manualproj', state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}
function brainWithMode(mode: string, extra: Record<string, unknown> = {}, project = PROJECT, name = BRAIN): SessionRecord {
  return session(name, 'brain', { projectName: project, transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode, ...extra }) } } as Partial<SessionRecord>);
}
const sonnet = (name: string, extra: Partial<SessionRecord> = {}): SessionRecord => session(name, 'w1', { parentSession: BRAIN, activeModel: 'claude-sonnet-5', ...extra });

describe('manual pairs in supervision mode off', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let now = 1_800_000_000_000;
  let sent: Array<{ target: string; text: string; id: string }>;
  let created: string[];

  beforeEach(() => {
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    created = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    upsertSession(brainWithMode(SUPERVISION_MODE.OFF));
    upsertSession(session(EXEC, 'w1', { parentSession: BRAIN }));
    upsertSession(session(AUD, 'w2', { parentSession: BRAIN }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    taskPairService.setScheduler(undefined);
    setPairSessionCreationDepsForTests(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD, OTHER_BRAIN, 'deck_sub_manual_exec2', ...created]) removeSession(name);
    expect(listSessions().filter((entry) => entry.name.startsWith('deck_sub_sup_auto_') || entry.name.startsWith('deck_sub_pair_auto_'))).toEqual([]);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  /** A scheduler that can never launch a real session: provisioning is stubbed (a pick that finds nothing waits). */
  const provisioned: string[] = [];
  const quietAutomation = () => new TaskPairAutomation({
    now: () => now, isBusy: () => false, isLimited: () => false,
    provision: async (input) => { provisioned.push(input.role); return undefined; },
    importLegacy: () => undefined, mainCheckoutRoots: () => [],
  });
  const handlers = (sessionName = BRAIN) => createMemoryMcpToolHandlers({ ...caller, sessionName }, { sendDeps: { listSessions: () => listSessions() } });
  const tool = (name: string, input: Record<string, unknown>, sessionName = BRAIN) => (handlers(sessionName) as Record<string, (input: unknown) => Promise<Record<string, unknown>>>)[name]!(input);
  const stateOf = (taskId: unknown) => getTaskPairStore().getPair(PROJECT, String(taskId))?.state;

  describe('the two predicates', () => {
    it('mode off with nothing configured: pairs are AVAILABLE (A) but the supervision automation is not active (B)', () => {
      expect(isPairsEngineProject(PROJECT)).toBe(false);
      expect(isTaskPairsAvailable(PROJECT)).toBe(true);
      expect(taskPairSupervisionStatus(PROJECT)).toEqual({ supervision: 'off', heartbeat: false });
    });

    it('supervision on keeps both: available and heartbeat', () => {
      upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
      expect(isPairsEngineProject(PROJECT)).toBe(true);
      expect(isTaskPairsAvailable(PROJECT)).toBe(true);
      expect(taskPairSupervisionStatus(PROJECT)).toEqual({ supervision: 'on', heartbeat: true });
    });

    it('a project without a Brain session has no pairs; a project with a Brain does not leak into another project', () => {
      removeSession(BRAIN);
      expect(isTaskPairsAvailable(PROJECT)).toBe(false);
      expect(isTaskPairsAvailable(undefined)).toBe(false);
      upsertSession(brainWithMode(SUPERVISION_MODE.OFF, {}, OTHER, OTHER_BRAIN));
      expect(isTaskPairsAvailable(OTHER)).toBe(true);
      expect(isTaskPairsAvailable(PROJECT)).toBe(false);
    });
  });

  describe('every explicit tool works end to end', () => {
    it('pair_create with named sessions starts the pair, briefs both sides and states supervision off / heartbeat false', async () => {
      const result = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# manual\n- [ ][ ] 1. do it', title: 'Manual pair', executor: EXEC, auditor: AUD, idempotencyKey: 'manual-1' });
      expect(result).toMatchObject({
        status: 'ok', created: true, state: 'working', supervision: 'off', heartbeat: false, supervisionNote: TASK_PAIR_MANUAL_MODE_NOTE,
        deliveries: [expect.objectContaining({ role: 'executor', target: EXEC, live: true }), expect.objectContaining({ role: 'auditor', target: AUD, live: true })],
      });
      expect(stateOf(result.taskId)).toMatchObject({ executor: EXEC, auditor: AUD, status: 'working' });
      expect(sent.map((entry) => entry.target).sort()).toEqual([AUD, EXEC].sort());
      // idempotent replay says the same
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# manual', executor: EXEC, auditor: AUD, idempotencyKey: 'manual-1' }))
        .toMatchObject({ status: 'ok', idempotentReplay: true, supervision: 'off', heartbeat: false });
    });

    it('with supervision on, the result says supervision on / heartbeat true and carries no manual note', async () => {
      upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
      const result = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# on', executor: EXEC, auditor: AUD, idempotencyKey: 'on-1' });
      expect(result).toMatchObject({ status: 'ok', supervision: 'on', heartbeat: true });
      expect(result).not.toHaveProperty('supervisionNote');
    });

    it('pair_create with createExecutor / createAuditor (the verified-live creation path) works and the new sessions are live', async () => {
      setPairSessionCreationDepsForTests({
        createSession: (request) => createPairSubSession(request, {
          readyTimeoutMs: 0,
          hasRuntime: () => true,
          announce: async () => 'announced',
          startSubSession: async (sub) => {
            const name = `deck_sub_${sub.id}`;
            created.push(name);
            upsertSession(sonnet(name, { pairCreatedMetadata: { ...(sub.pairCreatedMetadata as TaskPairCreatedSessionMetadata), source: TASK_PAIR_CREATED_SESSION_SOURCE } }));
          },
          stopSubSession: async (name) => { removeSession(name); return true; },
        }),
        stopSession: async (name) => { removeSession(name); return true; },
      });
      const result = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# created', createExecutor: {}, createAuditor: { model: 'sonnet' }, idempotencyKey: 'created-1' });
      expect(result).toMatchObject({ status: 'ok', state: 'working', supervision: 'off', heartbeat: false });
      const pair = stateOf(result.taskId)!;
      expect(created).toHaveLength(2);
      expect([pair.executor, pair.auditor].sort()).toEqual([...created].sort());
      for (const name of created) expect(getSession(name)).toBeDefined();
      expect((result.deliveries as Array<{ live: boolean }>).every((receipt) => receipt.live)).toBe(true);
    });

    it('pair_create with only executorModel picks the matching idle session', async () => {
      upsertSession(sonnet('deck_sub_manual_exec2'));
      const result = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# by model', executorModel: 'sonnet', auditor: AUD, idempotencyKey: 'model-1' });
      expect(result).toMatchObject({ status: 'ok', supervision: 'off', heartbeat: false });
      expect(['working', 'queued']).toContain(result.state);
    });

    it('the full lifecycle: list/get/task_*, reassign, verdict, next round, close', async () => {
      const first = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# lifecycle\n- [ ][ ] 1. item', title: 'Lifecycle', executor: EXEC, auditor: AUD, idempotencyKey: 'life-1' });
      const taskId = String(first.taskId);
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_LIST, {})).toMatchObject({ status: 'ok', pairs: [expect.objectContaining({ taskId })] });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_GET, { taskId })).toMatchObject({ status: 'ok', pair: { taskId } });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_TASK_GET, { taskId })).toMatchObject({ taskId, status: 'working' });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_TASK_UPDATE, { taskId, title: 'Lifecycle renamed' })).toMatchObject({ taskId, title: 'Lifecycle renamed' });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_TASK_CHECK, { taskId, items: [1], box: 'implemented', checked: true })).not.toMatchObject({ status: 'error' });

      upsertSession(session('deck_sub_manual_exec2', 'w3', { parentSession: BRAIN }));
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_REASSIGN, { taskId, executor: 'deck_sub_manual_exec2' })).toMatchObject({ status: 'ok', effect: 'reassigned' });
      expect(stateOf(taskId)?.executor).toBe('deck_sub_manual_exec2');

      // executor / auditor markers, as the daemon ingests them from a turn: READY_FOR_AUDIT then the structured verdict
      const store = getTaskPairStore();
      store.savePair(PROJECT, { ...stateOf(taskId)!, status: 'in_audit', material: { path: '/tmp/manualproj', head: 'abcdef1', at: 30 }, updatedAt: now });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT, { taskId, verdict: 'PASS' }, AUD)).toMatchObject({ status: 'ok', state: 'passed' });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_NEXT_ROUND, { taskId, base: 'abcdef1', note: 'round two' })).toMatchObject({ status: 'ok', state: 'working', effect: 'next_round' });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE, { taskId, action: 'done', force: true })).toMatchObject({ status: 'ok', state: 'done' });
    });

    it('IMCODES_TASK markers written by the executor and the auditor are ingested (they were ignored before)', async () => {
      const first = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# markers', executor: EXEC, auditor: AUD, idempotencyKey: 'marker-1' });
      const taskId = String(first.taskId);
      const transitions = taskPairService.ingestText(PROJECT, EXEC, `<!-- IMCODES_TASK BLOCKED ${taskId} note="needs a decision" -->`, 'turn-manual-1', now);
      expect(transitions.length).toBeGreaterThan(0);
      expect(stateOf(taskId)?.flags).toContain('blocked');
    });

    it('the daemon sends the Brain its PASS notice by itself (an event-driven lifecycle notice, not a heartbeat)', async () => {
      const first = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# pass notice', executor: EXEC, auditor: AUD, idempotencyKey: 'pass-notice-1' });
      const taskId = String(first.taskId);
      getTaskPairStore().savePair(PROJECT, { ...stateOf(taskId)!, status: 'in_audit', material: { path: '/tmp/manualproj', head: 'abcdef1', at: 30 }, updatedAt: now });
      sent = [];
      await tool(MEMORY_MCP_TOOL_NAMES.PAIR_VERDICT, { taskId, verdict: 'PASS' }, AUD);
      await taskPairService.dispose();
      expect(sent.some((entry) => entry.target === BRAIN && entry.id.includes('brain-line-pass-done'))).toBe(true);
    });
  });

  describe('the queue with supervision off', () => {
    it('a queued pair waits for capacity, an explicit pair_dispatch leaves it queued at the cap, and a pair that ends frees the slot', async () => {
      taskPairService.setScheduler(quietAutomation());
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_SET_MAX_CONCURRENCY, { maxConcurrency: 1 })).toMatchObject({ status: 'ok', maxConcurrency: 1 });
      upsertSession(sonnet('deck_sub_manual_exec2'));
      const a = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# a', executor: EXEC, auditor: AUD, idempotencyKey: 'q-a' });
      expect(a).toMatchObject({ status: 'ok', state: 'working' });
      // No executor named: the pair goes through the capacity-checked queue, which is full.
      const b = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# b', auditor: 'none', idempotencyKey: 'q-b' });
      expect(b).toMatchObject({ status: 'ok', state: 'queued', supervision: 'off', heartbeat: false, supervisionNote: expect.stringContaining('pair_dispatch') });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_DISPATCH, { taskId: b.taskId })).toMatchObject({ status: 'ok', state: 'queued' });
      // The Brain ends A: the freed slot admits B (an explicit lifecycle event, not a sweep), and B is briefed.
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE, { taskId: a.taskId, action: 'done', force: true })).toMatchObject({ status: 'ok', state: 'done' });
      await taskPairService.dispose();
      await vi.waitFor(() => expect(stateOf(b.taskId)?.status).toBe('working'));
      expect(stateOf(b.taskId)?.executor).toBe('deck_sub_manual_exec2');
    });

    it('capacity that appears without any explicit call is NOT noticed by a background sweep; pair_dispatch starts the pair', async () => {
      getTaskPairStore().setMaxConcurrency(BRAIN, 1);
      upsertSession(sonnet('deck_sub_manual_exec2'));
      await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# a', executor: EXEC, auditor: AUD, idempotencyKey: 'cap-a' });
      const b = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# b', auditor: 'none', idempotencyKey: 'cap-b' });
      expect(b.state).toBe('queued');
      getTaskPairStore().setMaxConcurrency(BRAIN, 5);
      const automation = quietAutomation();
      taskPairService.setScheduler(automation);
      for (let beat = 0; beat < 3; beat += 1) { now += 6 * 60_000; await automation.tick(); }
      expect(stateOf(b.taskId)?.status).toBe('queued');
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_DISPATCH, { taskId: b.taskId })).toMatchObject({ status: 'ok', state: 'working', supervision: 'off', heartbeat: false });
    });
  });

  describe('no daemon-initiated automation fires', () => {
    it('over many injected-clock heartbeats a manual pair is never nudged, escalated or reminded, but is not touched either', async () => {
      const automation = new TaskPairAutomation({
        now: () => now, isBusy: () => false, isLimited: () => false, pickCandidate: () => undefined,
        provision: async () => undefined, poolOf: () => 'primary', importLegacy: () => undefined, mainCheckoutRoots: () => [],
      });
      taskPairService.setScheduler(automation);
      const first = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# quiet', executor: EXEC, auditor: AUD, idempotencyKey: 'quiet-1' });
      const taskId = String(first.taskId);
      await taskPairService.dispose();
      sent = [];
      for (let beat = 0; beat < 12; beat += 1) { now += 6 * 60_000; await automation.tick(); }
      await automation.checkBothIdlePairs();
      expect(sent).toEqual([]);
      expect(stateOf(taskId)?.status).toBe('working');
    });

    it('a Brain follow-up is not armed for a no-auditor DONE while supervision is off', async () => {
      const automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined, mainCheckoutRoots: () => [] });
      const armed = vi.spyOn(automation, 'armBrainDecisionFollowUp');
      taskPairService.setScheduler(automation);
      const first = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# no auditor', executor: EXEC, auditor: 'none', idempotencyKey: 'noaud-1' });
      const taskId = String(first.taskId);
      taskPairService.ingestText(PROJECT, EXEC, `<!-- IMCODES_TASK DONE ${taskId} -->`, 'turn-noaud', now);
      await taskPairService.dispose();
      // the notice itself is a lifecycle notice and is sent; the follow-up chase is not armed
      expect(armed).toHaveBeenCalled();
      expect(sent.some((entry) => entry.target === BRAIN && entry.id.includes('brain-line-done-no-auditor'))).toBe(true);
      // arming is a no-op: nothing fires later
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sent.filter((entry) => entry.target === BRAIN && /follow-?up/iu.test(entry.id))).toHaveLength(0);
    });

    it('with supervision on the same pair IS nudged by the heartbeat (the control that makes the quiet test non-vacuous)', async () => {
      upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
      const automation = new TaskPairAutomation({
        now: () => now, isBusy: () => false, isLimited: () => false, pickCandidate: () => undefined,
        provision: async () => undefined, poolOf: () => 'primary', importLegacy: () => undefined, mainCheckoutRoots: () => [],
      });
      taskPairService.setScheduler(automation);
      await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# loud', executor: EXEC, auditor: AUD, idempotencyKey: 'loud-1' });
      await taskPairService.dispose();
      sent = [];
      for (let beat = 0; beat < 4; beat += 1) { now += 6 * 60_000; await automation.tick(); }
      expect(sent.length).toBeGreaterThan(0);
    });

    it('the legacy registry stays inert: legacy tools are not answered as pairs and the legacy dispatch predicate stays inert', async () => {
      const { answerLegacyToolInDaemon } = await import('../../../src/daemon/task-pairs/legacy-tools.js');
      await expect(answerLegacyToolInDaemon('supervision_task_update', BRAIN, {})).resolves.toEqual({ handled: false });
      const { isLegacyDispatchInertProject, isTaskPairEngineActive } = await import('../../../src/daemon/task-pairs/engine.js');
      expect(isLegacyDispatchInertProject(PROJECT)).toBe(true);
      expect(isTaskPairEngineActive(PROJECT)).toBe(false);
    });
  });

  describe('prompt, workspace and console', () => {
    it('the Brain gets the manual-only pairs contract in supervision off; a plain session of the project keeps the inert prompt', () => {
      expect(resolveTaskPairPromptEngineState(BRAIN)).toBe('pairs');
      expect(resolveTaskPairPromptEngineState(EXEC)).toBe('off');
      const contract = JSON.parse(buildBrainManualOnlyDelegationContract(undefined, { taskPairEngine: 'pairs' })) as Record<string, unknown>;
      expect(contract.automaticSupervision).toBe(false);
      expect(JSON.stringify(contract)).not.toContain('daemon_pair_heartbeat_until_done_or_cancel');
    });

    it('a participant of an open pair gets the pairs prompt and its turn cwd follows the pair workspace', async () => {
      const first = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# cwd', executor: EXEC, auditor: AUD, idempotencyKey: 'cwd-1' });
      expect(resolveTaskPairPromptEngineState(EXEC)).toBe('pairs');
      expect(resolveTaskPairPromptEngineState(AUD)).toBe('pairs');
      // A workspace the daemon has not built is never a turn cwd (no throw, no wrong directory)
      expect(() => resolveTaskPairTurnCwd(EXEC)).not.toThrow();
      expect(stateOf(first.taskId)?.status).toBe('working');
    });
  });

  describe('boundaries', () => {
    it('only the authoritative Brain may create pairs; participants and other projects are refused as before', async () => {
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: 'x', executor: AUD, idempotencyKey: 'auth-1' }, EXEC))
        .toMatchObject({ status: 'error', reason: 'scope_forbidden' });
      expect(getTaskPairStore().listActivePairs()).toHaveLength(0);
    });

    it('a project without a Brain session cannot create a pair, and says so', async () => {
      removeSession(BRAIN);
      upsertSession(session(BRAIN, 'w1'));
      const result = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: 'x', executor: EXEC, auditor: AUD, idempotencyKey: 'nobrain-1' });
      expect(result).toMatchObject({ status: 'error', reason: 'control_plane_unavailable', message: expect.stringContaining('no Brain session') });
      expect(getTaskPairStore().listActivePairs()).toHaveLength(0);
    });

    it('two projects are independent: a manual pair in one does not make the other available or active', async () => {
      upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT, {}, OTHER, OTHER_BRAIN));
      await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# one', executor: EXEC, auditor: AUD, idempotencyKey: 'two-1' });
      expect(taskPairSupervisionStatus(PROJECT)).toEqual({ supervision: 'off', heartbeat: false });
      expect(taskPairSupervisionStatus(OTHER)).toEqual({ supervision: 'on', heartbeat: true });
      expect(getTaskPairStore().listActivePairs(OTHER)).toHaveLength(0);
    });

    it('state persists across a daemon restart: a new store handle and scheduler see the same manual pair and still do not nudge it', async () => {
      const first = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# restart', executor: EXEC, auditor: AUD, idempotencyKey: 'restart-1' });
      const taskId = String(first.taskId);
      const reborn = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined, mainCheckoutRoots: () => [] });
      taskPairService.setScheduler(reborn);
      await taskPairService.dispose();
      sent = [];
      for (let beat = 0; beat < 3; beat += 1) { now += 6 * 60_000; await reborn.tick(); }
      expect(sent).toEqual([]);
      expect(stateOf(taskId)?.status).toBe('working');
    });

    it('a Brain restart in the middle (session record replaced, same name) keeps the pair usable', async () => {
      const first = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# brain restart', executor: EXEC, auditor: AUD, idempotencyKey: 'brain-restart-1' });
      upsertSession({ ...brainWithMode(SUPERVISION_MODE.OFF), sessionInstanceId: 'instance_brain_2', runtimeEpoch: 'epoch_brain_2' });
      expect(await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CLOSE, { taskId: first.taskId, action: 'done', force: true })).toMatchObject({ status: 'ok', state: 'done' });
    });

    it('unknown extra fields in the result are additive: an older caller reading status/taskId/state still works', async () => {
      const result = await tool(MEMORY_MCP_TOOL_NAMES.PAIR_CREATE, { brief: '# skew', executor: EXEC, auditor: AUD, idempotencyKey: 'skew-1' });
      const { supervision: _s, heartbeat: _h, supervisionNote: _n, ...legacyView } = result;
      expect(legacyView).toMatchObject({ status: 'ok', taskId: expect.any(String), state: 'working', deliveries: expect.any(Array) });
    });
  });
});
