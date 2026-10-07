/**
 * No execution pool configured (owner rule, 2026-10): a pair no longer waits for the user. Its executor and auditor come from the Brain's
 * idle same-vendor secondary-tier sub-sessions (sonnet for an anthropic Brain, gpt-6-sol for openai); pair_create CREATES the missing ones
 * by one deterministic rule, capped per project (10 pairs = 20 sessions), marked for recycling, and removes what it made when anything fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../../shared/context-types.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import {
  SUPERVISION_EXECUTION_SELECTION_SOURCES,
  SUPERVISION_TIER_PAIRS,
  isDefaultSecondaryTierTarget,
  supervisionSecondaryLaunchModelOfFamily,
  supervisionSecondaryModelOfFamily,
} from '../../../shared/supervision-execution-pool.js';
import {
  TASK_PAIR_AUTO_CREATED_PAIR_MAX_PER_PROJECT,
  TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT,
  TASK_PAIR_CREATED_SESSION_REASONS,
  TASK_PAIR_CREATED_SESSION_SOURCE,
  type TaskPairCreatedSessionMetadata,
} from '../../../shared/task-pair.js';
import type { McpRuntimeCaller } from '../../../src/daemon/memory-mcp-caller.js';
import { createMemoryMcpToolHandlers } from '../../../src/daemon/memory-mcp-tools.js';
import { listSessions, removeSession, upsertSession, getSession, type SessionRecord } from '../../../src/store/session-store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import {
  describeDefaultSelection,
  describeExecutionSelection,
  isDefaultSecondarySession,
  listDefaultPoolSessions,
  listTaskPairCandidates,
} from '../../../src/daemon/task-pairs/pool.js';
import {
  ensurePairSessions,
  planDefaultCreations,
  resolveCreationConfig,
  setPairSessionCreationDepsForTests,
} from '../../../src/daemon/task-pairs/session-creation.js';
import { createPairSubSession, listPairCreatedSessions } from '../../../src/daemon/supervision-auto-provision.js';
import { runExclusive } from '../../../src/util/keyed-mutex.js';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../../shared/supervision-config.js';

const PROJECT = 'defproj';
const BRAIN = 'deck_defproj_brain';
const caller: McpRuntimeCaller = {
  userId: 'u', namespace: { scope: 'user_private', userId: 'u', projectId: PROJECT } as ContextNamespace,
  sessionName: BRAIN, projectName: PROJECT, projectRoot: '/tmp/defproj', serverId: 'srv', transport: 'in_process',
};

function session(name: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role: 'w1', agentType: 'claude-code-sdk', projectDir: '/tmp/defproj', state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}
const brainRecord = (extra: Partial<SessionRecord> = {}): SessionRecord => session(BRAIN, { role: 'brain', ...extra });
const sonnet = (name: string, extra: Partial<SessionRecord> = {}): SessionRecord => session(name, { parentSession: BRAIN, activeModel: 'claude-sonnet-5', ...extra });
const marker = (over: Partial<TaskPairCreatedSessionMetadata> = {}): TaskPairCreatedSessionMetadata => ({
  autoCreated: true, source: TASK_PAIR_CREATED_SESSION_SOURCE, createdBy: BRAIN, pairTaskId: 'tsk_old', role: 'executor',
  reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT, createdAt: 1, ...over,
});

describe('the secondary tier per provider family comes from one shared table', () => {
  it('maps anthropic -> sonnet, openai -> gpt-6-sol, deepseek -> pro, and only the secondary model counts', () => {
    expect(SUPERVISION_TIER_PAIRS.map((tier) => [tier.providerFamily, tier.auditor])).toEqual([
      ['openai', 'gpt-6-sol'], ['anthropic', 'claude-sonnet'], ['deepseek', 'deepseek-pro'],
    ]);
    expect(supervisionSecondaryModelOfFamily('anthropic')).toBe('claude-sonnet');
    expect(supervisionSecondaryLaunchModelOfFamily('anthropic')).toBe('sonnet');
    expect(supervisionSecondaryLaunchModelOfFamily('openai')).toBe('gpt-6-sol');
    expect(supervisionSecondaryLaunchModelOfFamily('deepseek')).toBeUndefined();
    const check = (brainFamily: string, targetFamily: string, targetModel: string) => isDefaultSecondaryTierTarget({ brainFamily, targetFamily, targetModel });
    expect(check('anthropic', 'anthropic', 'claude-sonnet-5')).toBe(true);
    expect(check('anthropic', 'anthropic', 'claude-opus-5-5')).toBe(false); // flagship
    expect(check('anthropic', 'anthropic', 'claude-haiku-4-5')).toBe(false); // small
    expect(check('anthropic', 'openai', 'gpt-6-sol')).toBe(false); // another vendor
    expect(check('openai', 'openai', 'gpt-6-sol')).toBe(true);
    expect(check('openai', 'openai', 'gpt-6-luna')).toBe(false);
    expect(check('unknown', 'unknown', 'claude-sonnet-5')).toBe(false); // a family without a tier row has no default
  });
});

describe('the no-pool default pick', () => {
  const sessions = [
    brainRecord(),
    sonnet('deck_sub_s1', { updatedAt: 5 }),
    sonnet('deck_sub_s2', { updatedAt: 1 }),
    sonnet('deck_sub_busy', { state: 'running' }),
    session('deck_sub_opus', { parentSession: BRAIN, activeModel: 'claude-opus-5-5' }),
    session('deck_sub_gpt', { parentSession: BRAIN, agentType: 'codex-sdk', activeModel: 'gpt-6-sol' }),
    sonnet('deck_sub_other', { parentSession: 'deck_other_brain', projectName: 'other' }),
  ];
  const deps = { listSessions: () => sessions, getSession: (name: string) => sessions.find((entry) => entry.name === name), hasPendingMessages: () => false };

  it('lists idle same-vendor secondary-tier sub-sessions, longest idle first, for either role', () => {
    for (const role of ['executor', 'auditor'] as const) {
      expect(listTaskPairCandidates({ brain: BRAIN, role, pool: 'primary', exclude: new Set() }, deps).map((entry) => entry.name)).toEqual(['deck_sub_s2', 'deck_sub_s1']);
    }
    // a busy default session still counts as an existing default (it frees up) but is not an idle candidate
    expect(listDefaultPoolSessions(BRAIN, new Set([BRAIN]), deps).map((entry) => entry.name).sort()).toEqual(['deck_sub_busy', 'deck_sub_s1', 'deck_sub_s2']);
    expect(isDefaultSecondarySession(sessions[0]!, sessions[5]!)).toBe(false);
  });

  it('an openai Brain gets its gpt-6-sol sessions, not claude sonnet', () => {
    const openaiBrain = brainRecord({ agentType: 'codex-sdk' });
    const records = [openaiBrain, sonnet('deck_sub_s1'), session('deck_sub_sol', { parentSession: BRAIN, agentType: 'codex-sdk', activeModel: 'gpt-6-sol' })];
    const picked = listTaskPairCandidates({ brain: BRAIN, role: 'executor', pool: 'primary', exclude: new Set() }, { listSessions: () => records, getSession: (name: string) => records.find((entry) => entry.name === name), hasPendingMessages: () => false });
    expect(picked.map((entry) => entry.name)).toEqual(['deck_sub_sol']);
  });

  it('says which session was chosen and why', () => {
    expect(describeDefaultSelection(BRAIN, 'deck_sub_s1', deps)).toContain('deck_sub_s1');
    expect(describeDefaultSelection(BRAIN, 'deck_sub_s1', deps)).toMatch(/idle, same vendor anthropic, secondary tier/);
    const selection = describeExecutionSelection(BRAIN, { executor: 'deck_sub_s1', auditor: 'deck_sub_s2' }, { executorNamed: false, auditorNamed: false }, deps);
    expect(selection.executor).toMatchObject({ session: 'deck_sub_s1', source: SUPERVISION_EXECUTION_SELECTION_SOURCES.DEFAULT_SAME_VENDOR_SECONDARY });
    expect(describeExecutionSelection(BRAIN, { executor: 'deck_sub_s1' }, { executorNamed: true, auditorNamed: false }, deps).executor.source).toBe(SUPERVISION_EXECUTION_SELECTION_SOURCES.EXPLICIT);
  });
});

describe('queue admission with no pool uses the default, with distinct sessions and a visible reason', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let now = 1_800_000_000_000;
  let sent: Array<{ target: string; text: string; id: string }>;
  let automation: TaskPairAutomation;
  const names = ['deck_sub_a', 'deck_sub_b', 'deck_sub_c', 'deck_sub_d'];
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    upsertSession(brainRecord());
    automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined });
    taskPairService.setScheduler(automation);
  });
  afterEach(() => {
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, ...names]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });
  const marker = async (text: string) => {
    taskPairService.ingestText(PROJECT, BRAIN, text, `defpool-${Math.random()}`, now);
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const queue = (taskId: string, attrs = '') => marker(`<!-- IMCODES_TASK QUEUE ${taskId}${attrs ? ` ${attrs}` : ''} -->\nbrief\n<!-- IMCODES_TASK_END ${taskId} -->`);
  const pairOf = (taskId: string) => getTaskPairStore().getPair(PROJECT, taskId)!.state;

  it('two default sessions: executor and auditor are different sessions, and the Brain line names the default and the reason', async () => {
    upsertSession(sonnet('deck_sub_a')); upsertSession(sonnet('deck_sub_b', { updatedAt: 2 }));
    await queue('D1');
    await automation.tick();
    const pair = pairOf('D1');
    expect(pair.status).toBe('working');
    expect(new Set([pair.executor, pair.auditor]).size).toBe(2);
    expect([pair.executor, pair.auditor].sort()).toEqual(['deck_sub_a', 'deck_sub_b']);
    const line = sent.find((entry) => entry.target === BRAIN && entry.id.includes('brain-line-dispatch'))!;
    expect(line.text).toContain('default_same_vendor_secondary');
    expect(line.text).toMatch(/idle, same vendor anthropic, secondary tier/);
  });

  it('ONE default session cannot audit itself: the pair waits and Brain is told it needs two (or a named auditor), nothing is silently cross-vendor', async () => {
    upsertSession(sonnet('deck_sub_a'));
    upsertSession(session('deck_sub_b', { parentSession: BRAIN, agentType: 'codex-sdk', activeModel: 'gpt-6-sol' }));
    await queue('D2');
    await automation.tick();
    const pair = pairOf('D2');
    expect(pair.status).toBe('queued');
    expect(pair.flags).toContain('no_pool_configured');
    const ask = sent.find((entry) => entry.id.includes('brain-no-pool-ask'))!;
    expect(ask.text).toContain('2 distinct');
    expect(ask.text).toContain('execution_pool_set');
    expect(pair.executor).toBeUndefined();
  });

  it('naming the auditor with one default session starts the pair (explicit choices still win)', async () => {
    upsertSession(sonnet('deck_sub_a'));
    upsertSession(session('deck_sub_b', { parentSession: BRAIN, agentType: 'codex-sdk', activeModel: 'gpt-5.5' }));
    await queue('D3', 'auditor=deck_sub_b');
    await automation.tick();
    expect(pairOf('D3')).toMatchObject({ status: 'working', executor: 'deck_sub_a', auditor: 'deck_sub_b' });
  });

  it('concurrent pairs never share a session: three default sessions fill one pair, the second waits for capacity', async () => {
    for (const name of names.slice(0, 3)) upsertSession(sonnet(name));
    await Promise.all([queue('C1'), queue('C2')]);
    await automation.tick();
    const [c1, c2] = [pairOf('C1'), pairOf('C2')];
    const working = [c1, c2].filter((pair) => pair.status === 'working');
    expect(working).toHaveLength(1);
    const used = [working[0]!.executor, working[0]!.auditor];
    expect(new Set(used).size).toBe(2);
    const waiting = [c1, c2].find((pair) => pair.status === 'queued')!;
    expect(waiting.executor ?? waiting.auditor).toBeUndefined();
  });
});

describe('creation: one deterministic rule', () => {
  it('plans exactly the shortfall, never negative, never above the cap room', () => {
    expect(planDefaultCreations({ unsettledRoles: 2, idleDefaultSessions: 0, capRoom: 20 })).toBe(2);
    expect(planDefaultCreations({ unsettledRoles: 2, idleDefaultSessions: 1, capRoom: 20 })).toBe(1);
    expect(planDefaultCreations({ unsettledRoles: 2, idleDefaultSessions: 2, capRoom: 20 })).toBe(0);
    expect(planDefaultCreations({ unsettledRoles: 1, idleDefaultSessions: 5, capRoom: 20 })).toBe(0);
    expect(planDefaultCreations({ unsettledRoles: 2, idleDefaultSessions: 0, capRoom: 1 })).toBe(1);
    expect(planDefaultCreations({ unsettledRoles: 2, idleDefaultSessions: 0, capRoom: 0 })).toBe(0);
  });

  /** An in-memory project: createSession adds a ready sonnet session carrying the marker, like the real launch does. */
  function world(initial: SessionRecord[], options: { failOn?: number } = {}) {
    const records = new Map<string, SessionRecord>(initial.map((entry) => [entry.name, entry]));
    const calls: Array<{ role?: string; model: string; label: string; metadata: unknown }> = [];
    const stopped: string[] = [];
    let launches = 0;
    const deps = {
      listSessions: () => [...records.values()],
      getSession: (name: string) => records.get(name),
      hasPendingMessages: () => false,
      createSession: async (request: Parameters<NonNullable<Parameters<typeof ensurePairSessions>[1]>['createSession'] & object>[0]) => {
        launches += 1;
        if (options.failOn === launches) return { ok: false as const, reason: 'launch_failed' as const, detail: 'boom' };
        const name = `deck_sub_pair_auto_${launches}_${request.metadata.pairTaskId}_${request.metadata.role}`;
        const record = sonnet(name, { activeModel: request.config.model, pairCreatedMetadata: { ...request.metadata, autoCreated: true, source: TASK_PAIR_CREATED_SESSION_SOURCE, createdAt: 1 } as TaskPairCreatedSessionMetadata, label: request.label });
        records.set(name, record);
        calls.push({ role: request.metadata.role, model: request.config.model, label: request.label, metadata: request.metadata });
        return { ok: true as const, target: record, created: true };
      },
      stopSession: async (name: string) => { stopped.push(name); records.delete(name); return true; },
    };
    return { records, calls, stopped, deps };
  }
  const base = { brain: BRAIN, project: PROJECT, taskId: 'tsk_new', title: 'Fix the login retry' };

  it('nothing idle: creates a sonnet executor and a different sonnet auditor, marked and labelled for the pair', async () => {
    const w = world([brainRecord()]);
    const result = await ensurePairSessions(base, w.deps);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.created.map((entry) => entry.role).sort()).toEqual(['auditor', 'executor']);
    expect(result.executor).not.toBe(result.auditor);
    expect(w.calls.map((call) => call.model)).toEqual(['sonnet'.length ? expect.stringMatching(/sonnet/) : '', expect.stringMatching(/sonnet/)].map(String).length ? [expect.stringMatching(/sonnet/), expect.stringMatching(/sonnet/)] : []);
    expect(w.calls[0]!.label).toContain('tsk_new');
    expect(w.calls[0]!.label).toContain('Fix the login retry');
    expect(w.calls[0]!.metadata).toMatchObject({ createdBy: BRAIN, pairTaskId: 'tsk_new', role: 'executor', reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT });
  });

  it('one idle default session: it is reused (picked later) and only the missing one is created', async () => {
    const w = world([brainRecord(), sonnet('deck_sub_idle')]);
    const result = await ensurePairSessions(base, w.deps);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.role).toBe('auditor');
    expect(result.executor).toBeUndefined(); // left to the normal pick: the idle session
    expect(result.auditor).toBe(result.created[0]!.session);
  });

  it('two idle default sessions: nothing is created', async () => {
    const w = world([brainRecord(), sonnet('deck_sub_i1'), sonnet('deck_sub_i2')]);
    const result = await ensurePairSessions(base, w.deps);
    expect(result).toMatchObject({ ok: true, created: [] });
    expect(w.calls).toHaveLength(0);
  });

  it('a named executor and a named auditor never create anything; a named executor alone creates just the auditor', async () => {
    const w = world([brainRecord(), session('deck_sub_x', { parentSession: BRAIN }), session('deck_sub_y', { parentSession: BRAIN })]);
    expect(await ensurePairSessions({ ...base, executor: 'deck_sub_x', auditor: 'deck_sub_y' }, w.deps)).toMatchObject({ ok: true, created: [] });
    const result = await ensurePairSessions({ ...base, executor: 'deck_sub_x' }, w.deps);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.created.map((entry) => entry.role)).toEqual(['auditor']);
    // a named model settles the role too
    expect(await ensurePairSessions({ ...base, executorModel: 'gpt-5.5', auditorModel: 'opus' }, w.deps)).toMatchObject({ ok: true, created: [] });
    // auditor=none needs only an executor
    const none = await ensurePairSessions({ ...base, auditor: 'none' }, world([brainRecord()]).deps);
    expect(none).toMatchObject({ ok: true });
    if (none.ok) expect(none.created.map((entry) => entry.role)).toEqual(['executor']);
  });

  it('a configured pool never auto-creates (an explicit create still does)', async () => {
    const pools = {
      state: 'configured' as const,
      economyTaskPool: { configs: [], controls: { leaseMs: 900000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
      primaryDevelopmentPool: {
        configs: [{ model: 'sonnet', agentType: 'claude-code-sdk', runtimeType: 'transport' as const, capabilityId: 'supervision-exec-v1:transport:claude-code-sdk:anthropic:sonnet', providerFamily: 'anthropic' }],
        controls: { leaseMs: 1800000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 },
      },
    };
    const configured = brainRecord({ transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, executionPools: pools }) } } as Partial<SessionRecord>);
    const w = world([configured]);
    expect(await ensurePairSessions(base, w.deps)).toMatchObject({ ok: true, created: [] });
    const explicit = await ensurePairSessions({ ...base, createExecutor: {} }, w.deps);
    expect(explicit).toMatchObject({ ok: true });
    if (explicit.ok) expect(explicit.created).toMatchObject([{ role: 'executor', reason: TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT }]);
  });

  it('explicit create: a model, a family, conflicts with a named role, and an unknown model are all handled', async () => {
    const w = world([brainRecord()]);
    const withModel = await ensurePairSessions({ ...base, auditor: 'none', createExecutor: { model: 'gpt-6-sol' } }, w.deps);
    expect(withModel).toMatchObject({ ok: true });
    expect(w.calls[0]!.model).toBe('gpt-6-sol');
    expect(await ensurePairSessions({ ...base, executor: 'deck_sub_x', createExecutor: {} }, w.deps)).toMatchObject({ ok: false, error: expect.stringContaining('createExecutor cannot be combined') });
    expect(await ensurePairSessions({ ...base, auditorModel: 'opus', createAuditor: {} }, w.deps)).toMatchObject({ ok: false, error: expect.stringContaining('createAuditor cannot be combined') });
    expect(await ensurePairSessions({ ...base, auditor: 'none', createExecutor: { model: 'no-such-model-xyz' } }, world([brainRecord()]).deps)).toMatchObject({ ok: false, error: expect.stringContaining('cannot be launched') });
    expect(resolveCreationConfig(brainRecord(), { providerFamily: 'deepseek' })).toMatchObject({ ok: false, error: expect.stringContaining('no default secondary model') });
    expect(resolveCreationConfig(brainRecord(), undefined)).toMatchObject({ ok: true, config: { providerFamily: 'anthropic' } });
  });

  describe(`the cap: ${TASK_PAIR_AUTO_CREATED_PAIR_MAX_PER_PROJECT} pairs = ${TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT} sessions`, () => {
    // Busy default sessions (they free up): at the cap pair_create creates nothing more and the pair queues for them.
    const made = (count: number): SessionRecord[] => Array.from({ length: count }, (_, i) => sonnet(`deck_sub_made_${i}`, { state: 'running', pairCreatedMetadata: marker({ pairTaskId: `tsk_${i}` }) }));
    // Pair-created sessions that are NOT default candidates (opus): at the cap nothing can ever fill the roles.
    const madeOther = (count: number): SessionRecord[] => Array.from({ length: count }, (_, i) => session(`deck_sub_other_${i}`, { parentSession: BRAIN, activeModel: 'claude-opus-5-5', pairCreatedMetadata: marker({ pairTaskId: `tsk_${i}` }) }));

    it('is defined as 10 pairs of two sessions', () => {
      expect(TASK_PAIR_AUTO_CREATED_PAIR_MAX_PER_PROJECT).toBe(10);
      expect(TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT).toBe(20);
    });

    it('exactly 10 pairs (20 sessions) exist and all are busy: nothing is created and the pair waits for them; if they could never serve, it is an error naming the 10 pairs', async () => {
      const waiting = world([brainRecord(), ...made(20)]);
      expect(await ensurePairSessions(base, waiting.deps)).toMatchObject({ ok: true, created: [] });
      expect(waiting.calls).toHaveLength(0);
      const stuck = world([brainRecord(), ...madeOther(20)]);
      const result = await ensurePairSessions(base, stuck.deps);
      expect(stuck.calls).toHaveLength(0);
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error).toContain('10 pairs'); expect(result.error).toContain('20 sessions'); }
    });

    it('the 10th pair still fits (18 exist), and an 11th pair beyond 20 does not', async () => {
      const w = world([brainRecord(), ...made(18)]);
      const tenth = await ensurePairSessions(base, w.deps);
      expect(tenth).toMatchObject({ ok: true });
      expect(w.calls).toHaveLength(2);
      expect(listPairCreatedSessions(PROJECT, w.deps.listSessions())).toHaveLength(20);
      // the 11th pair creates nothing (the new sessions are idle here, so it simply reuses them)
      const eleventh = await ensurePairSessions({ ...base, taskId: 'tsk_eleven' }, w.deps);
      expect(eleventh).toMatchObject({ ok: true, created: [] });
      expect(w.calls).toHaveLength(2);
      const stuck = world([brainRecord(), ...madeOther(20)]);
      expect((await ensurePairSessions({ ...base, taskId: 'tsk_eleven' }, stuck.deps)).ok).toBe(false);
    });

    it('one slot left: creates what fits and the other role reuses an idle session (a pair that created only one session uses one slot)', async () => {
      const w = world([brainRecord(), ...made(19), sonnet('deck_sub_idle')]);
      const result = await ensurePairSessions(base, w.deps);
      expect(result).toMatchObject({ ok: true });
      expect(w.calls).toHaveLength(1);
      expect(listPairCreatedSessions(PROJECT, w.deps.listSessions())).toHaveLength(20);
    });

    it('an explicit create over the cap is an error and creates nothing', async () => {
      const w = world([brainRecord(), ...made(19)]);
      const result = await ensurePairSessions({ ...base, auditor: 'none', createExecutor: {} }, w.deps);
      expect(result).toMatchObject({ ok: true }); // 19 + 1 fits
      const again = await ensurePairSessions({ ...base, taskId: 'tsk_b', auditor: 'none', createExecutor: {} }, w.deps);
      expect(again).toMatchObject({ ok: false, error: expect.stringContaining('10 pairs') });
    });

    it('a recycled (removed) session frees its slot', async () => {
      const w = world([brainRecord(), ...madeOther(20)]);
      expect((await ensurePairSessions(base, w.deps)).ok).toBe(false);
      w.records.delete('deck_sub_other_0'); w.records.delete('deck_sub_other_1');
      expect(await ensurePairSessions(base, w.deps)).toMatchObject({ ok: true });
      expect(w.calls).toHaveLength(2);
    });

    it('sessions of another project do not count', async () => {
      const foreign = Array.from({ length: 20 }, (_, i) => sonnet(`deck_sub_foreign_${i}`, { parentSession: 'deck_other_brain', projectName: 'otherproj', pairCreatedMetadata: marker({ pairTaskId: `tsk_f${i}` }) }));
      const w = world([brainRecord(), ...foreign]);
      expect(await ensurePairSessions(base, w.deps)).toMatchObject({ ok: true });
      expect(w.calls).toHaveLength(2);
    });
  });

  it('a failed creation removes the sessions already created in the call and creates nothing else', async () => {
    const w = world([brainRecord()], { failOn: 2 });
    const result = await ensurePairSessions(base, w.deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Nothing was created for this pair') });
    expect(w.stopped).toHaveLength(1);
    expect(listPairCreatedSessions(PROJECT, w.deps.listSessions())).toHaveLength(0);
  });

  it('simultaneous pair_creates under the per-Brain lock neither over-create nor share a session', async () => {
    const w = world([brainRecord()]);
    const results = await Promise.all([1, 2, 3].map((n) => runExclusive(`pair-create:${PROJECT}:${BRAIN}`, async () => {
      const result = await ensurePairSessions({ ...base, taskId: `tsk_c${n}` }, w.deps);
      // what pair_create does next: the pair holds its sessions, so they are no longer idle for the next caller
      if (result.ok) for (const entry of result.created) w.records.set(entry.session, { ...w.records.get(entry.session)!, state: 'running' });
      return result;
    })));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(w.calls).toHaveLength(6); // three pairs of two, no more
    const all = results.flatMap((result) => (result.ok ? result.created.map((entry) => entry.session) : []));
    expect(new Set(all).size).toBe(6);
  });
});

describe('createPairSubSession shares the launch path and cleans up after itself', () => {
  const parent = brainRecord();
  function harness(overrides: Partial<Parameters<typeof createPairSubSession>[1]> = {}) {
    const records = new Map<string, SessionRecord>([[BRAIN, parent]]);
    let clock = 1_000;
    const started: Array<Record<string, unknown>> = [];
    const stopped: string[] = [];
    const deps = {
      now: () => clock,
      wait: async () => { clock += 10; },
      readyTimeoutMs: 50,
      listSessions: () => [...records.values()],
      getSession: (name: string) => records.get(name),
      startSubSession: async (sub: { id: string; label?: string | null; pairCreatedMetadata?: TaskPairCreatedSessionMetadata | null; requestedModel?: string | null }) => {
        started.push(sub as unknown as Record<string, unknown>);
        records.set(`deck_sub_${sub.id}`, sonnet(`deck_sub_${sub.id}`, { label: sub.label ?? undefined, pairCreatedMetadata: sub.pairCreatedMetadata ?? undefined }));
      },
      stopSubSession: async (name: string) => { stopped.push(name); records.delete(name); return true; },
      ...overrides,
    };
    return { records, started, stopped, deps };
  }
  const request = {
    parentSessionName: BRAIN,
    config: resolveCreationConfig(parent, undefined).ok ? (resolveCreationConfig(parent, undefined) as { ok: true; config: never }).config : (undefined as never),
    label: 'Pair tsk_new executor: x',
    idempotencyKey: 'tsk_new:executor',
    metadata: { createdBy: BRAIN, pairTaskId: 'tsk_new', role: 'executor' as const, reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT },
  };

  it('launches through startSubSession with the marker, the label, the secondary model and the Brain as parent; a retry reuses the same session', async () => {
    const h = harness();
    const first = await createPairSubSession(request, h.deps);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ parentSession: BRAIN, fresh: true, label: 'Pair tsk_new executor: x', pairCreatedMetadata: { autoCreated: true, source: 'pair_create', createdBy: BRAIN, pairTaskId: 'tsk_new', role: 'executor' } });
    expect(String(h.started[0]!.requestedModel)).toMatch(/sonnet/);
    const again = await createPairSubSession(request, h.deps);
    expect(again).toMatchObject({ ok: true, created: false });
    expect(h.started).toHaveLength(1);
    expect(first.ok && again.ok && first.target.name === again.target.name).toBe(true);
  });

  it('a launch that throws is stopped and removed', async () => {
    const throwing = harness({ startSubSession: async () => { throw new Error('quota exceeded'); } });
    expect(await createPairSubSession(request, throwing.deps)).toMatchObject({ ok: false, reason: 'launch_failed', detail: 'quota exceeded' });
    expect(throwing.stopped).toHaveLength(1);
  });

  it('a session that never becomes ready is stopped and removed: no half-made session is left', async () => {
    const neverReady = harness({ startSubSession: async (sub: { id: string }) => { neverReady.records.set(`deck_sub_${sub.id}`, sonnet(`deck_sub_${sub.id}`, { state: 'starting' as never })); } });
    expect(await createPairSubSession(request, neverReady.deps)).toMatchObject({ ok: false, reason: 'readiness_timeout' });
    expect(neverReady.stopped).toHaveLength(1);
    expect(neverReady.records.size).toBe(1); // only the Brain is left
  });

  it('the cap is checked before anything is launched', async () => {
    const h = harness({ maxPerProject: 1 });
    h.records.set('deck_sub_existing', sonnet('deck_sub_existing', { pairCreatedMetadata: marker() }));
    expect(await createPairSubSession(request, h.deps)).toMatchObject({ ok: false, reason: 'cap_reached' });
    expect(h.started).toHaveLength(0);
  });

  it('the session without a pair (task.autoProvision) is accepted: pairTaskId and role are optional, the source is explicit', async () => {
    const h = harness();
    const result = await createPairSubSession({ ...request, idempotencyKey: 'auto:1', metadata: { createdBy: BRAIN, reason: TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT, source: 'send_auto_provision' } }, h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.started[0]).toMatchObject({ pairCreatedMetadata: { source: 'send_auto_provision', createdBy: BRAIN } });
  });
});

describe('the marker is sticky on the session record', () => {
  it('an incidental rebuild that omits pairCreatedMetadata does not erase it', () => {
    const record = sonnet('deck_sub_sticky', { pairCreatedMetadata: marker({ pairTaskId: 'tsk_sticky' }) });
    upsertSession(record);
    try {
      upsertSession({ ...record, pairCreatedMetadata: undefined, updatedAt: 99 });
      expect(getSession('deck_sub_sticky')?.pairCreatedMetadata).toMatchObject({ autoCreated: true, createdBy: BRAIN, pairTaskId: 'tsk_sticky' });
      expect(listPairCreatedSessions(PROJECT, listSessions()).map((entry) => entry.name)).toContain('deck_sub_sticky');
    } finally { removeSession('deck_sub_sticky'); }
  });
});

describe('pair_create end to end with no pool', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  const createdNames: string[] = [];
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    upsertSession(brainRecord());
    let launches = 0;
    setPairSessionCreationDepsForTests({
      createSession: async (request) => {
        launches += 1;
        const name = `deck_sub_pair_auto_e2e_${launches}`;
        const record = sonnet(name, { pairCreatedMetadata: { ...request.metadata, autoCreated: true, source: TASK_PAIR_CREATED_SESSION_SOURCE, createdAt: 1 } as TaskPairCreatedSessionMetadata, label: request.label });
        upsertSession(record);
        createdNames.push(name);
        return { ok: true, target: record, created: true };
      },
      stopSession: async (name) => { removeSession(name); return true; },
    });
  });
  afterEach(() => {
    setPairSessionCreationDepsForTests(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, ...createdNames.splice(0)]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('pair_create with only a brief creates a sonnet executor and a different sonnet auditor and reports who and why', async () => {
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => listSessions() } });
    const result = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({ brief: '# do it', title: 'Do it', idempotencyKey: 'e2e-1' });
    expect(result).toMatchObject({ status: 'ok', created: true });
    const taskId = String(result.taskId);
    const pair = getTaskPairStore().getPair(PROJECT, taskId)!.state;
    expect(pair.executor).toBeTruthy();
    expect(pair.auditor).toBeTruthy();
    expect(pair.executor).not.toBe(pair.auditor);
    const selection = result.executionSelection as { executor: { session: string; source: string; reason: string }; auditor: { session: string; source: string } };
    expect(selection.executor.source).toBe(SUPERVISION_EXECUTION_SELECTION_SOURCES.DEFAULT_SAME_VENDOR_SECONDARY);
    expect(selection.executor.reason).toContain('created for this pair');
    expect(selection.executor.reason).toContain(BRAIN);
    expect(getSession(pair.executor!)?.pairCreatedMetadata).toMatchObject({ autoCreated: true, createdBy: BRAIN, pairTaskId: taskId, role: 'executor' });
    expect(getSession(pair.auditor!)?.pairCreatedMetadata).toMatchObject({ autoCreated: true, pairTaskId: taskId, role: 'auditor' });
  });

  it('an explicit executor with the default auditor creates just the auditor', async () => {
    upsertSession(sonnet('deck_sub_mine'));
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => listSessions() } });
    const result = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({ brief: 'b', executor: 'deck_sub_mine', idempotencyKey: 'e2e-2' });
    try {
      expect(result).toMatchObject({ status: 'ok' });
      expect(createdNames).toHaveLength(1);
      expect((result.executionSelection as { executor: { source: string } }).executor.source).toBe(SUPERVISION_EXECUTION_SELECTION_SOURCES.EXPLICIT);
    } finally { removeSession('deck_sub_mine'); }
  });

  it('createExecutor / createAuditor create explicitly, and a bad combination persists nothing', async () => {
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => listSessions() } });
    const ok = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({ brief: 'b', createExecutor: {}, createAuditor: { model: 'sonnet' }, idempotencyKey: 'e2e-3' });
    expect(ok).toMatchObject({ status: 'ok' });
    const bad = await handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({ brief: 'b', executor: 'deck_sub_x', createExecutor: {}, idempotencyKey: 'e2e-4' });
    expect(bad).toMatchObject({ status: 'error', message: expect.stringContaining('pair_create did nothing') });
    expect(getTaskPairStore().listActivePairs().filter((entry) => entry.state.title !== 'x')).toHaveLength(1);
  });

  it('simultaneous pair_creates do not exceed what the rule needs and share no session', async () => {
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => listSessions() } });
    const results = await Promise.all([1, 2, 3].map((n) => handlers[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE]({ brief: `b${n}`, idempotencyKey: `e2e-par-${n}` })));
    expect(results.every((result) => result.status === 'ok')).toBe(true);
    const pairs = getTaskPairStore().listActivePairs().map((entry) => entry.state);
    const used = pairs.flatMap((entry) => [entry.executor, entry.auditor]).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
    expect(createdNames.length).toBeLessThanOrEqual(6);
    expect(createdNames.length).toBeGreaterThanOrEqual(used.length);
  });
});

describe('terminology is locked into the contract', () => {
  it('the Brain marker contract and the MCP descriptions say a sub-session/sub-agent is an IM.codes sub-session, never a built-in agent', async () => {
    const { buildTaskPairMarkerContract, TASK_PAIR_SUBSESSION_TERMINOLOGY, TASK_PAIR_SUBSESSION_TERM_SHORT, TASK_PAIR_NATIVE_COLLABORATION_RULE } = await import('../../../shared/task-pair.js');
    const { MEMORY_MCP_TOOL_CONTRACTS } = await import('../../../shared/memory-mcp-contracts.js');
    const contract = buildTaskPairMarkerContract();
    expect(contract).toContain(TASK_PAIR_SUBSESSION_TERMINOLOGY);
    expect(TASK_PAIR_SUBSESSION_TERMINOLOGY).toMatch(/create a sub-session/);
    expect(TASK_PAIR_SUBSESSION_TERMINOLOGY).toMatch(/create a sub-agent/);
    expect(TASK_PAIR_SUBSESSION_TERMINOLOGY).toMatch(/NEVER a provider built-in agent/);
    expect(TASK_PAIR_NATIVE_COLLABORATION_RULE).toContain('read-only research and analysis');
    expect(MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE].description).toContain(TASK_PAIR_SUBSESSION_TERM_SHORT);
    expect(MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE].description).toContain(TASK_PAIR_SUBSESSION_TERM_SHORT);
    expect(contract).toContain('With an empty or unconfigured pool');
    expect(contract).not.toContain('never invent a default');
  });
});
