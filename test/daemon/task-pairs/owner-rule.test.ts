/**
 * Owner rule (design D-pool-sync, 2026-09-25): when the user or Brain
 * explicitly names the model or session for a task pair's executor or
 * auditor, the pairs engine must not apply the execution pool's per-entry
 * role (or, with no pool configured, the built-in default routing). Pool
 * roles govern only an automatic pick, when neither is named.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { roleEligibleProvisionConfig, listTaskPairCandidates } from '../../../src/daemon/task-pairs/pool.js';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../../shared/supervision-config.js';

const PROJECT = 'ownerproj';
const BRAIN = 'deck_ownerproj_brain';

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

describe('owner rule: pool-role bypass by requested model', () => {
  it('lists a non-default-routed session as an auditor candidate once its exact model is requested', () => {
    const records = [
      session(BRAIN, 'brain'),
      // No pool is configured, so the built-in default (Opus auditors) applies; Sonnet is not.
      session('deck_sub_sonnet', 'w1', { parentSession: BRAIN, activeModel: 'claude-sonnet-5', updatedAt: 1 }),
    ];
    const deps = { listSessions: () => records, hasPendingMessages: () => false };
    // Unchanged baseline: the built-in default alone still governs an automatic pick.
    expect(listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', exclude: new Set(),
    }, deps)).toEqual([]);
    // Owner rule: an explicit requested model bypasses the default entirely.
    const picked = listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', exclude: new Set(),
      requestedModel: 'claude-sonnet-5',
    }, deps);
    expect(picked.map((entry) => entry.name)).toEqual(['deck_sub_sonnet']);
    // Exact-id matching is case-insensitive: a Brain typo in casing should
    // not miss a session that is otherwise an exact match.
    const pickedCaseInsensitive = listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', exclude: new Set(),
      requestedModel: 'Claude-Sonnet-5',
    }, deps);
    expect(pickedCaseInsensitive.map((entry) => entry.name)).toEqual(['deck_sub_sonnet']);
  });

  it('provisions a pool config outside its role once its exact model is requested', () => {
    const sonnetPools = {
      state: 'configured' as const,
      economyTaskPool: { configs: [], controls: { leaseMs: 900000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
      primaryDevelopmentPool: {
        // Sonnet is explicitly executor-only: it can never satisfy an
        // automatic auditor pick, only a requested-model bypass.
        configs: [{ model: 'sonnet', agentType: 'claude-code-sdk', runtimeType: 'transport' as const, capabilityId: 'supervision-exec-v1:transport:claude-code-sdk:anthropic:sonnet', providerFamily: 'anthropic', role: 'executor' as const }],
        controls: { leaseMs: 1800000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 },
      },
    };
    const parent = session(BRAIN, 'brain', {
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, executionPools: sonnetPools }) },
    } as Partial<SessionRecord>);
    const deps = { getSession: (name: string) => (name === BRAIN ? parent : undefined) };
    // Unchanged baseline: no auditor-role config exists in this pool.
    expect(roleEligibleProvisionConfig({
      brain: BRAIN, role: 'auditor', pool: 'primary',
    }, deps)).toBeUndefined();
    // Owner rule: the requested model matches the pool's own config directly.
    const config = roleEligibleProvisionConfig({
      brain: BRAIN, role: 'auditor', pool: 'primary', requestedModel: 'sonnet',
    }, deps);
    expect(config).toMatchObject({ model: 'sonnet' });
  });
});

describe('owner rule: a named model is never confined to the pool, only an automatic pick is', () => {
  const poolWithUnrelatedModel = {
    state: 'configured' as const,
    economyTaskPool: { configs: [], controls: { leaseMs: 900000, maxSpawned: 2, changeBudget: 40, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 } },
    primaryDevelopmentPool: {
      configs: [{ model: 'gpt-6-luna', agentType: 'codex-sdk', runtimeType: 'transport' as const, capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-6-luna', providerFamily: 'openai', role: 'executor' as const }],
      controls: { leaseMs: 1800000, maxSpawned: 2, changeBudget: 200, maxConcurrency: 4, auditHeadroomPerProviderFamily: 1 },
    },
  };

  it('(a) picks an idle out-of-pool session once its exact model is requested, even with a pool configured', () => {
    const parent = session(BRAIN, 'brain', {
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, executionPools: poolWithUnrelatedModel }) },
    } as Partial<SessionRecord>);
    // Not a member of any pool entry (agentType and model both differ).
    const outOfPool = session('deck_sub_outofpool', 'w1', { parentSession: BRAIN, agentType: 'claude-code-sdk', activeModel: 'gpt-5.6', updatedAt: 1 });
    const deps = { listSessions: () => [parent, outOfPool], getSession: (name: string) => [parent, outOfPool].find((s) => s.name === name), hasPendingMessages: () => false };

    const picked = listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', exclude: new Set(), requestedModel: 'gpt-5.6',
    }, deps);
    expect(picked.map((entry) => entry.name)).toEqual(['deck_sub_outofpool']);
  });

  it('(c) an unnamed (automatic) pick still ignores the same out-of-pool session', () => {
    const parent = session(BRAIN, 'brain', {
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, executionPools: poolWithUnrelatedModel }) },
    } as Partial<SessionRecord>);
    const outOfPool = session('deck_sub_outofpool', 'w1', { parentSession: BRAIN, agentType: 'claude-code-sdk', activeModel: 'gpt-5.6', updatedAt: 1 });
    const deps = { listSessions: () => [parent, outOfPool], getSession: (name: string) => [parent, outOfPool].find((s) => s.name === name), hasPendingMessages: () => false };

    const picked = listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', exclude: new Set(),
    }, deps);
    expect(picked).toEqual([]);
  });

  it('(b) provisions the named model outside the pool when no session runs it yet', () => {
    const parent = session(BRAIN, 'brain', {
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: SUPERVISION_MODE.OFF, executionPools: poolWithUnrelatedModel }) },
    } as Partial<SessionRecord>);
    const deps = { getSession: (name: string) => (name === BRAIN ? parent : undefined) };

    const config = roleEligibleProvisionConfig({
      brain: BRAIN, role: 'auditor', pool: 'primary', requestedModel: 'gpt-5.6',
    }, deps);
    expect(config).toMatchObject({ agentType: 'codex-sdk', providerFamily: 'openai', model: 'gpt-5.6' });

    // An unrecognized model still reports "no session/config", not a crash.
    expect(roleEligibleProvisionConfig({
      brain: BRAIN, role: 'auditor', pool: 'primary', requestedModel: 'nonexistent-fictional-model',
    }, deps)).toBeUndefined();
  });
});

describe('owner rule: scheduler wires an explicit executormodel=/auditormodel= through to the pick, ignoring the allowlist', () => {
  const EXEC = 'deck_sub_ownerexec';
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let now = 1_000_000;
  let sent: Array<{ target: string; text: string }>;
  let automation: TaskPairAutomation;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text) => { sent.push({ target, text }); } });
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w1')]) upsertSession(record);
  });
  afterEach(() => {
    setTaskPairStoreForTests(undefined);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('picks the auditor purely by the requested model, never consulting the allowlist mock', () => {
    let seenRequestedModel: string | undefined;
    automation = new TaskPairAutomation({
      now: () => now,
      pickCandidate: ({ role, requestedModel }) => {
        if (role !== 'auditor') return undefined;
        seenRequestedModel = requestedModel;
        // Would never match the built-in default (auditor wants Opus); the
        // scheduler must still hand it a session because the model was named.
        return requestedModel === 'claude-sonnet-5' ? 'deck_sub_ownersonnet' : undefined;
      },
      provision: async () => undefined,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    taskPairService.setScheduler(automation);

    taskPairService.ingestText(
      PROJECT, BRAIN,
      `<!-- IMCODES_TASK DISPATCH T60 executor=${EXEC} auditormodel=claude-sonnet-5 -->`,
      'owner-rule-turn-1', now,
    );

    expect(seenRequestedModel).toBe('claude-sonnet-5');
    const pair = getTaskPairStore().getPair(PROJECT, 'T60')!.state;
    expect(pair.auditor).toBe('deck_sub_ownersonnet');
    expect(pair.auditorModel).toBe('claude-sonnet-5');
  });

  it('names the exact requested model, not the generic allowlist gap, when nothing can serve it', async () => {
    automation = new TaskPairAutomation({
      now: () => now,
      pickCandidate: () => undefined,
      provision: async () => undefined,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    taskPairService.setScheduler(automation);

    taskPairService.ingestText(
      PROJECT, BRAIN,
      `<!-- IMCODES_TASK DISPATCH T61 executor=${EXEC} auditormodel=nonexistent-fictional-model -->`,
      'owner-rule-turn-2', now,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const pair = getTaskPairStore().getPair(PROJECT, 'T61')!.state;
    expect(pair.flags).toContain('needs_auditor');
    const notice = sent.find((entry) => entry.target === BRAIN);
    expect(notice?.text).toContain('no session/config for requested model nonexistent-fictional-model');
  });

  it('keeps a send_message-bound requestedExecutionType.model on the pair as executorModel, surviving the attrs bridge to the marker parser', () => {
    automation = new TaskPairAutomation({
      now: () => now,
      pickCandidate: () => undefined,
      provision: async () => undefined,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    taskPairService.setScheduler(automation);

    taskPairService.implicitDispatch({
      project: PROJECT, sender: BRAIN, target: EXEC, taskId: 'T62', eventId: 'owner-rule-implicit-1',
      executorModel: 'gpt-6-luna',
    });

    const pair = getTaskPairStore().getPair(PROJECT, 'T62')!.state;
    expect(pair.executor).toBe(EXEC);
    expect(pair.executorModel).toBe('gpt-6-luna');
  });
});
