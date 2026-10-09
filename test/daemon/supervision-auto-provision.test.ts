import { identityContentHash } from '../../src/util/identity-prompt-hash.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSupervisionExecutionCapabilityId,
  type SupervisionExecutionConfig,
} from '../../shared/supervision-execution-pool.js';
import { SUPERVISION_TRANSPORT_CONFIG_KEY } from '../../shared/supervision-config.js';
import {
  DELEGATION_LIMIT_REASONS,
  PROVIDER_LIMIT_EVIDENCE_KINDS,
} from '../../shared/delegation-availability.js';
import {
  autoCreatedSlotsInFlightForTests,
  clearSupervisionAutoProvisionStateForTests,
  createPairSubSession,
  defaultCountActiveSupervisionAssignments,
  defaultHasActiveSupervisionLease,
  provisionSupervisionTarget,
  type SupervisionAutoProvisionDeps,
  type SupervisionAutoProvisionRequest,
} from '../../src/daemon/supervision-auto-provision.js';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';
import { TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT, TASK_PAIR_CREATED_SESSION_REASONS } from '../../shared/task-pair.js';
import type { SubSessionRecord } from '../../src/daemon/subsession-manager.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const NOW = 1_800_000_000_000;

function config(agentType: string, providerFamily: string, model: string): SupervisionExecutionConfig {
  const value = { agentType, providerFamily, runtimeType: 'transport' as const, model };
  return { ...value, capabilityId: buildSupervisionExecutionCapabilityId(value) };
}

function processConfig(agentType: string, providerFamily: string, model: string): SupervisionExecutionConfig {
  const value = { agentType, providerFamily, runtimeType: 'process' as const, model };
  return { ...value, capabilityId: buildSupervisionExecutionCapabilityId(value) };
}

function presetConfig(
  agentType: string,
  providerFamily: string,
  model: string,
  ccPresetId: string,
): SupervisionExecutionConfig {
  const value = { agentType, providerFamily, runtimeType: 'transport' as const, model, ccPresetId };
  return { ...value, capabilityId: buildSupervisionExecutionCapabilityId(value) };
}

const OPENAI = config('codex-sdk', 'openai', 'gpt-5.6-sol');
const ANTHROPIC = config('claude-code-sdk', 'anthropic', 'opus');

function session(name: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    projectName: 'proj',
    projectDir: '/repo',
    role: name.endsWith('_brain') ? 'brain' : 'w1',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    providerId: 'openai',
    activeModel: 'gpt-5.6-sol',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    userCreated: true,
    ...patch,
  };
}

function parent(configs: SupervisionExecutionConfig[]): SessionRecord {
  return session('deck_proj_brain', {
    role: 'brain',
    transportConfig: {
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: {
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs,
            controls: { maxConcurrency: 4, maxSpawned: 2, leaseMs: 1_800_000, changeBudget: 200, auditHeadroomPerProviderFamily: 1 },
          },
          economyTaskPool: {
            configs,
            controls: { maxConcurrency: 4, maxSpawned: 2, leaseMs: 900_000, changeBudget: 40, auditHeadroomPerProviderFamily: 1 },
          },
        },
      },
    },
  });
}

function harness(initial: SessionRecord[], override: Partial<SupervisionAutoProvisionDeps> = {}) {
  const sessions = [...initial];
  const start = vi.fn(async (sub: SubSessionRecord) => {
    sessions.push(session(`deck_sub_${sub.id}`, {
      parentSession: sub.parentSession ?? undefined,
      role: 'w1',
      label: sub.label ?? undefined,
      agentType: sub.type,
      runtimeType: sub.runtimeType ?? 'transport',
      providerId: sub.providerId ?? sub.type,
      activeModel: sub.requestedModel ?? undefined,
      ccPreset: sub.ccPreset ?? undefined,
      provisionedIdentityHash: sub.provisionedIdentityHash ?? undefined,
      pairCreatedMetadata: sub.pairCreatedMetadata ?? undefined,
      projectDir: sub.cwd ?? '/repo',
    }));
  });
  const stop = vi.fn(async (sessionName: string) => {
    const index = sessions.findIndex((candidate) => candidate.name === sessionName);
    if (index < 0) return false;
    sessions.splice(index, 1);
    return true;
  });
  const deps: SupervisionAutoProvisionDeps = {
    now: () => NOW,
    listSessions: () => [...sessions],
    getSession: (name) => sessions.find((candidate) => candidate.name === name),
    startSubSession: start,
    stopSubSession: stop,
    hasActiveSupervisionLease: () => false,
    countActiveSupervisionAssignments: () => 0,
    wait: async () => {},
    readyTimeoutMs: 1,
    cooldownMs: 1,
    ...override,
  };
  return { sessions, start, stop, deps };
}

function request(patch: Partial<SupervisionAutoProvisionRequest> = {}): SupervisionAutoProvisionRequest {
  return {
    parentSessionName: 'deck_proj_brain',
    pool: 'primary',
    idempotencyKey: 'task-1',
    ...patch,
  };
}

function seedPagedRegistry(input: {
  registry: SupervisionTaskRegistry;
  taskCount: number;
  leasedTaskIndexes: readonly number[];
  cancelledTaskIndexes?: readonly number[];
  sessionName: string;
  pool?: 'primary' | 'economy';
}): void {
  const pool = input.pool ?? 'primary';
  for (let index = 0; index < input.taskCount; index += 1) {
    const suffix = String(index).padStart(4, '0');
    const taskId = `tsk_page_${suffix}`;
    expect(input.registry.createOrGet({
      taskId,
      projectName: 'proj',
      classification: 'independent_top_level',
      objective: `page ${suffix}`,
      currentRevision: 'rev-page',
      now: index + 1,
    })).toMatchObject({ ok: true });
    if (!input.leasedTaskIndexes.includes(index)) continue;
    const identity = {
      sessionName: input.sessionName,
      sessionInstanceId: `instance-${input.sessionName}`,
      runtimeEpoch: `epoch-${input.sessionName}`,
      agentType: OPENAI.agentType,
      providerFamily: OPENAI.providerFamily,
    };
    expect(input.registry.createAssignment({
      assignmentId: `asg_page_${suffix}`,
      taskId,
      role: 'implementer',
      identity,
      auditRevision: 'rev-page',
      executionBinding: {
        pool,
        requested: OPENAI,
        actual: {
          sessionName: input.sessionName,
          sessionInstanceId: `instance-${input.sessionName}`,
          runtimeEpoch: `epoch-${input.sessionName}`,
          ...OPENAI,
        },
        origin: 'reused',
      },
      now: index + 1,
    })).toMatchObject({ ok: true });
    if (input.cancelledTaskIndexes?.includes(index)) {
      expect(input.registry.updateAssignment({
        assignmentId: `asg_page_${suffix}`,
        identity,
        status: 'cancelled',
        now: input.taskCount + index + 1,
      })).toMatchObject({ ok: true });
    }
  }
}

describe('supervision auto provisioning', () => {
  beforeEach(() => clearSupervisionAutoProvisionStateForTests());

  it('fails closed for daemon automatic provisioning while mode is off but keeps explicit manual provisioning available', async () => {
    const brain = parent([OPENAI]);
    const h = harness([brain]);

    const automatic = await provisionSupervisionTarget(request({ provenance: 'automatic_supervision' }), h.deps);
    expect(automatic).toMatchObject({ ok: false, reason: 'no_selected_config' });
    expect(h.start).not.toHaveBeenCalled();

    const manual = await provisionSupervisionTarget(request({ provenance: 'manual_explicit', idempotencyKey: 'manual' }), h.deps);
    expect(manual).toMatchObject({ ok: true });
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('manually provisions an explicitly selected SDK without configured pools and isolates startup identities', async () => {
    const brain = session('deck_proj_brain', { role: 'brain', transportConfig: undefined });
    let clock = NOW;
    const h = harness([brain], { now: () => clock });
    const first = await provisionSupervisionTarget(request({
      provenance: 'manual_explicit',
      requestedCapabilityId: ANTHROPIC.capabilityId,
      requestedExecutionConfig: ANTHROPIC,
      identityPrompt: 'You are the release engineer.',
    }), h.deps);

    expect(first).toMatchObject({
      ok: true,
      target: {
        name: expect.stringMatching(/^deck_sub_/u),
        parentSession: brain.name,
        projectDir: brain.projectDir,
        role: 'w1',
        agentType: 'claude-code-sdk',
        provisionedIdentityHash: identityContentHash('You are the release engineer.'),
      },
      evidence: { selectedConfig: { ...ANTHROPIC, model: 'opus[1M]' }, origin: 'spawned' },
    });
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      type: 'claude-code-sdk',
      cwd: brain.projectDir,
      parentSession: brain.name,
      requestedModel: 'opus[1M]',
      identityPrompt: 'You are the release engineer.',
    }));

    clock += 2;
    const second = await provisionSupervisionTarget(request({
      provenance: 'manual_explicit',
      idempotencyKey: 'task-2',
      requestedCapabilityId: ANTHROPIC.capabilityId,
      requestedExecutionConfig: ANTHROPIC,
      identityPrompt: 'You are the security reviewer.',
    }), h.deps);
    expect(second).toMatchObject({ ok: true, evidence: { origin: 'spawned' } });
    expect(second.ok && first.ok && second.target.name).not.toBe(first.ok ? first.target.name : '');
    expect(h.start).toHaveBeenCalledTimes(2);

    clock += 2;
    const firstIdentityAgain = await provisionSupervisionTarget(request({
      provenance: 'manual_explicit',
      idempotencyKey: 'task-3',
      requestedCapabilityId: ANTHROPIC.capabilityId,
      requestedExecutionConfig: ANTHROPIC,
      identityPrompt: 'You are the release engineer.',
    }), h.deps);
    expect(firstIdentityAgain).toMatchObject({
      ok: true,
      target: { name: first.ok ? first.target.name : '' },
      evidence: { origin: 'reused' },
    });
    expect(h.start).toHaveBeenCalledTimes(2);

    const automatic = await provisionSupervisionTarget(request({
      provenance: 'automatic_supervision',
      idempotencyKey: 'automatic-must-not-bypass',
      requestedCapabilityId: ANTHROPIC.capabilityId,
      requestedExecutionConfig: ANTHROPIC,
    }), h.deps);
    expect(automatic).toMatchObject({ ok: false, reason: 'no_selected_config' });
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it('reuses an existing ready configured child without creating another session', async () => {
    const brain = parent([OPENAI]);
    const ready = session('deck_sub_ready', { parentSession: brain.name });
    const h = harness([brain, ready]);

    const result = await provisionSupervisionTarget(request(), h.deps);

    expect(result).toMatchObject({ ok: true, target: { name: ready.name } });
    expect(result).toMatchObject({ evidence: { origin: 'reused' } });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('reuses only the exact ready CC preset and keeps ordinary and different-preset sessions isolated', async () => {
    const presetA = presetConfig('claude-code-sdk', 'anthropic', 'opus[1M]', 'preset-a');
    const brain = parent([presetA]);
    const ordinary = session('deck_sub_ordinary', {
      parentSession: brain.name,
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
    });
    const presetB = session('deck_sub_preset_b', {
      parentSession: brain.name,
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      ccPreset: 'preset-b',
    });
    const exact = session('deck_sub_preset_a', {
      parentSession: brain.name,
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      ccPreset: 'preset-a',
    });
    const h = harness([brain, ordinary, presetB, exact]);

    const result = await provisionSupervisionTarget(request({ requestedCapabilityId: presetA.capabilityId }), h.deps);

    expect(result).toMatchObject({
      ok: true,
      target: { name: exact.name, ccPreset: 'preset-a' },
      evidence: { selectedConfig: presetA, origin: 'reused' },
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('does not let a preset session satisfy an ordinary same-model config', async () => {
    const ordinaryConfig = config('claude-code-sdk', 'anthropic', 'opus');
    const brain = parent([ordinaryConfig]);
    const preset = session('deck_sub_preset', {
      parentSession: brain.name,
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      ccPreset: 'preset-a',
    });
    const h = harness([brain, preset]);

    const result = await provisionSupervisionTarget(request(), h.deps);

    expect(result).toMatchObject({ ok: true, evidence: { origin: 'spawned' } });
    expect(result.ok && result.target.name).not.toBe(preset.name);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith(expect.not.objectContaining({ ccPreset: expect.anything() }));
  });

  it('creates exactly one configured child, binds it to the Brain, and waits for routable identity', async () => {
    const brain = parent([OPENAI]);
    const h = harness([brain]);

    const result = await provisionSupervisionTarget(request(), h.deps);

    expect(result).toMatchObject({
      ok: true,
      target: { role: 'w1', parentSession: brain.name, agentType: 'codex-sdk' },
      evidence: { selectedPool: 'primary', selectedConfig: OPENAI, origin: 'spawned' },
    });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      type: 'codex-sdk', requestedModel: 'gpt-5.6-sol', parentSession: brain.name, fresh: true,
    }));
    expect(result.ok && result.evidence.createdSessionName).toBe(result.ok && result.target.name);
  });

  it('reuses only the exact transport provider, agent, and model identity across vendors', async () => {
    const google = config('gemini-sdk', 'google', 'gemini-3-pro');
    const brain = parent([google]);
    const wrongProvider = session('deck_sub_wrong_provider', {
      parentSession: brain.name,
      agentType: 'gemini-sdk',
      providerId: 'openai',
      activeModel: 'gemini-3-pro',
    });
    const wrongAgent = session('deck_sub_wrong_agent', {
      parentSession: brain.name,
      agentType: 'codex-sdk',
      providerId: 'openai',
      activeModel: 'gemini-3-pro',
    });
    const wrongModel = session('deck_sub_wrong_model', {
      parentSession: brain.name,
      agentType: 'gemini-sdk',
      providerId: 'google',
      activeModel: 'gemini-2.5-pro',
    });
    const exact = session('deck_sub_google_exact', {
      parentSession: brain.name,
      agentType: 'gemini-sdk',
      providerId: 'google',
      activeModel: 'gemini-3-pro',
    });
    const h = harness([brain, wrongProvider, wrongAgent, wrongModel, exact]);

    const result = await provisionSupervisionTarget(request({ requestedCapabilityId: google.capabilityId }), h.deps);

    expect(result).toMatchObject({
      ok: true,
      target: { name: exact.name },
      evidence: { selectedConfig: google, origin: 'reused' },
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('spawns any configured transport provider with its exact adapter and model', async () => {
    const qoder = config('qoder-sdk', 'qoder', 'qoder-model');
    const brain = parent([qoder]);
    const h = harness([brain]);

    const result = await provisionSupervisionTarget(request({ requestedCapabilityId: qoder.capabilityId }), h.deps);

    expect(result).toMatchObject({
      ok: true,
      target: {
        parentSession: brain.name,
        agentType: 'qoder-sdk',
        runtimeType: 'transport',
        providerId: 'qoder-sdk',
        activeModel: 'qoder-model',
        userCreated: true,
      },
      evidence: { selectedConfig: qoder, origin: 'spawned', createdSessionName: expect.any(String) },
    });
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      type: 'qoder-sdk',
      runtimeType: 'transport',
      providerId: 'qoder-sdk',
      requestedModel: 'qoder-model',
      parentSession: brain.name,
      fresh: true,
    }));
    expect(h.start).toHaveBeenCalledWith(expect.not.objectContaining({ ccPreset: expect.anything() }));
  });

  it('fails closed for process/CLI and mismatched transport-provider configurations without launching', async () => {
    const cli = processConfig('codex', 'openai', 'gpt-5.6-sol');
    const mismatched = config('gemini-sdk', 'openai', 'gemini-3-pro');

    for (const unsupported of [cli, mismatched]) {
      const brain = parent([unsupported]);
      let clock = NOW;
      const h = harness([brain], {
        now: () => clock,
        wait: async (ms) => { clock += ms; },
        readyTimeoutMs: 1,
      });
      await expect(provisionSupervisionTarget(request({
        requestedCapabilityId: unsupported.capabilityId,
        idempotencyKey: unsupported.capabilityId,
      }), h.deps)).resolves.toMatchObject({ ok: false, reason: 'unsupported_config' });
      expect(h.start).not.toHaveBeenCalled();
    }
  });

  it('creates a visible child with the exact CC preset when no matching preset session is ready', async () => {
    const presetA = presetConfig('claude-code-sdk', 'anthropic', 'opus[1M]', 'preset-a');
    const brain = parent([presetA]);
    const ordinary = session('deck_sub_ordinary', {
      parentSession: brain.name,
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
    });
    const h = harness([brain, ordinary]);

    const result = await provisionSupervisionTarget(request({ requestedCapabilityId: presetA.capabilityId }), h.deps);

    expect(result).toMatchObject({
      ok: true,
      target: {
        parentSession: brain.name,
        userCreated: true,
        ccPreset: 'preset-a',
      },
      evidence: {
        selectedConfig: presetA,
        origin: 'spawned',
        provisionAttemptId: expect.any(String),
        createdSessionName: expect.any(String),
      },
    });
    expect(result.ok && result.evidence.createdSessionName).toBe(result.ok && result.target.name);
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      type: 'claude-code-sdk',
      requestedModel: 'opus[1M]',
      ccPreset: 'preset-a',
      parentSession: brain.name,
      fresh: true,
    }));
  });

  it('does not release the reservation until the created session becomes routable', async () => {
    const brain = parent([OPENAI]);
    const sessions = [brain];
    const wait = vi.fn(async () => {
      const worker = sessions.find((candidate) => candidate.name.startsWith('deck_sub_sup_auto_'));
      if (worker) {
        worker.state = 'idle';
        worker.sessionInstanceId = `instance-${worker.name}`;
        worker.runtimeEpoch = `epoch-${worker.name}`;
      }
    });
    const start = vi.fn(async (sub: SubSessionRecord) => {
      sessions.push(session(`deck_sub_${sub.id}`, {
        parentSession: brain.name,
        label: sub.label ?? undefined,
        agentType: sub.type,
        activeModel: sub.requestedModel ?? undefined,
        state: 'running',
        sessionInstanceId: undefined,
        runtimeEpoch: undefined,
      }));
    });

    const result = await provisionSupervisionTarget(request(), {
      now: () => NOW,
      listSessions: () => [...sessions],
      getSession: (name) => sessions.find((candidate) => candidate.name === name),
      startSubSession: start,
      wait,
      readyTimeoutMs: 1_000,
    });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, target: { state: 'idle', sessionInstanceId: expect.any(String), runtimeEpoch: expect.any(String) } });
  });

  it('uses one atomic reservation for concurrent requests for the same pool gap', async () => {
    const presetA = presetConfig('claude-code-sdk', 'anthropic', 'opus[1M]', 'preset-a');
    const brain = parent([presetA]);
    const sessions = [brain];
    let release!: () => void;
    const launched = new Promise<void>((resolve) => { release = resolve; });
    const start = vi.fn(async (sub: SubSessionRecord) => {
      await launched;
      sessions.push(session(`deck_sub_${sub.id}`, {
        parentSession: brain.name,
        label: sub.label ?? undefined,
        agentType: sub.type,
        providerId: 'anthropic',
        activeModel: sub.requestedModel ?? undefined,
        ccPreset: sub.ccPreset ?? undefined,
      }));
    });
    const deps: SupervisionAutoProvisionDeps = {
      now: () => NOW,
      listSessions: () => [...sessions],
      getSession: (name) => sessions.find((candidate) => candidate.name === name),
      startSubSession: start,
      wait: async () => {},
    };

    const first = provisionSupervisionTarget(request({ idempotencyKey: 'first' }), deps);
    const second = provisionSupervisionTarget(request({ idempotencyKey: 'second' }), deps);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.ok && a.target.name).toBe(b.ok && b.target.name);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ ccPreset: 'preset-a' }));
  });

  it('enforces the configured per-pool auto-spawn maximum and launch cooldown', async () => {
    const brain = parent([OPENAI]);
    const supervision = brain.transportConfig?.[SUPERVISION_TRANSPORT_CONFIG_KEY] as {
      executionPools: { primaryDevelopmentPool: { controls: { maxSpawned: number } } };
    };
    supervision.executionPools.primaryDevelopmentPool.controls.maxSpawned = 1;
    const full = session('deck_sub_sup_auto_existing', {
      parentSession: brain.name,
      label: 'Auto primary',
      state: 'running',
    });
    const maxed = harness([brain, full]);
    await expect(provisionSupervisionTarget(request(), maxed.deps)).resolves.toMatchObject({
      ok: false, reason: 'max_spawned',
    });
    expect(maxed.start).not.toHaveBeenCalled();

    clearSupervisionAutoProvisionStateForTests();
    const cooled = harness([brain], { startSubSession: async () => { throw new Error('launch failed'); } });
    await expect(provisionSupervisionTarget(request({ idempotencyKey: 'launch-fails' }), cooled.deps))
      .resolves.toMatchObject({ ok: false, reason: 'launch_failed' });
    await expect(provisionSupervisionTarget(request({ idempotencyKey: 'cooldown-retry' }), cooled.deps))
      .resolves.toMatchObject({ ok: false, reason: 'cooldown' });
  });

  it('counts audit-labelled automatic children against the primary pool spawn budget', async () => {
    const brain = parent([OPENAI]);
    const supervision = brain.transportConfig?.[SUPERVISION_TRANSPORT_CONFIG_KEY] as {
      executionPools: { primaryDevelopmentPool: { controls: { maxSpawned: number } } };
    };
    supervision.executionPools.primaryDevelopmentPool.controls.maxSpawned = 1;
    const existingAuditChild = session('deck_sub_sup_auto_audit_child', {
      parentSession: brain.name,
      label: 'Auto audit',
      state: 'running',
    });
    const h = harness([brain, existingAuditChild]);

    await expect(provisionSupervisionTarget(request({ idempotencyKey: 'primary-after-audit' }), h.deps))
      .resolves.toMatchObject({ ok: false, reason: 'max_spawned' });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses a new worker when the configured assignment concurrency is already full', async () => {
    const brain = parent([OPENAI]);
    const supervision = brain.transportConfig?.[SUPERVISION_TRANSPORT_CONFIG_KEY] as {
      executionPools: { primaryDevelopmentPool: { controls: { maxConcurrency: number } } };
    };
    supervision.executionPools.primaryDevelopmentPool.controls.maxConcurrency = 1;
    const h = harness([brain], { countActiveSupervisionAssignments: () => 1 });

    await expect(provisionSupervisionTarget(request({ idempotencyKey: 'concurrency-full' }), h.deps))
      .resolves.toMatchObject({ ok: false, reason: 'max_concurrency' });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('uses the default real-registry counter across the clamped 101/102 task page boundary', async () => {
    const registry = new SupervisionTaskRegistry({ dbPath: ':memory:' });
    try {
      const brain = parent([OPENAI]);
      // Three leases are visible in the first 101-row page. The fourth is on
      // row 102, so the old `page.length === 200` continuation silently
      // returned 3 and allowed a fifth concurrent worker.
      seedPagedRegistry({
        registry,
        taskCount: 102,
        leasedTaskIndexes: [98, 99, 100, 101],
        sessionName: 'deck_sub_page_active',
      });
      const listSpy = vi.spyOn(registry, 'list');
      await expect(defaultCountActiveSupervisionAssignments(brain, 'primary', registry)).resolves.toBe(4);
      expect(listSpy).not.toHaveBeenCalled();
      const h = harness([brain], {
        countActiveSupervisionAssignments: (candidate, pool) => (
          defaultCountActiveSupervisionAssignments(candidate, pool, registry)
        ),
      });

      await expect(provisionSupervisionTarget(request({ idempotencyKey: 'paged-concurrency-full' }), h.deps))
        .resolves.toMatchObject({ ok: false, reason: 'max_concurrency' });
      expect(h.start).not.toHaveBeenCalled();
    } finally {
      registry.close();
    }
  });

  it('reaps at most one stale idle automatic child, but never one with an active lease', async () => {
    const brain = parent([OPENAI]);
    const stale = session('deck_sub_sup_auto_stale', {
      parentSession: brain.name,
      label: 'Auto audit',
      state: 'idle',
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      updatedAt: NOW - 31 * 60_000,
    });
    const leased = session('deck_sub_sup_auto_leased', {
      parentSession: brain.name,
      label: 'Auto primary',
      state: 'idle',
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      updatedAt: NOW - 32 * 60_000,
    });
    const h = harness([brain, stale, leased], {
      hasActiveSupervisionLease: (sessionName) => sessionName === leased.name,
    });

    await expect(provisionSupervisionTarget(request({ idempotencyKey: 'reap-one' }), h.deps))
      .resolves.toMatchObject({ ok: true });
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledWith(stale.name);
    expect(h.sessions.some((candidate) => candidate.name === leased.name)).toBe(true);
  });

  it('reaps at most one stale unleased child per provisioning attempt', async () => {
    const brain = parent([OPENAI]);
    const staleA = session('deck_sub_sup_auto_stale_a', {
      parentSession: brain.name,
      label: 'Auto audit',
      state: 'idle',
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      updatedAt: NOW - 32 * 60_000,
    });
    const staleB = session('deck_sub_sup_auto_stale_b', {
      parentSession: brain.name,
      label: 'Auto primary',
      state: 'idle',
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      updatedAt: NOW - 31 * 60_000,
    });
    const h = harness([brain, staleA, staleB]);

    await expect(provisionSupervisionTarget(request({ idempotencyKey: 'reap-one-of-two' }), h.deps))
      .resolves.toMatchObject({ ok: true });
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledWith(staleA.name);
    expect(h.sessions.some((candidate) => candidate.name === staleB.name)).toBe(true);
  });

  it('never reaps a recently idle automatic child before the idle-age cutoff', async () => {
    const brain = parent([OPENAI]);
    const recent = session('deck_sub_sup_auto_recent', {
      parentSession: brain.name,
      label: 'Auto audit',
      state: 'idle',
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      updatedAt: NOW - 29 * 60_000,
    });
    const running = session('deck_sub_sup_auto_recent_capacity_peer', {
      parentSession: brain.name,
      label: 'Auto primary',
      state: 'running',
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
    });
    const h = harness([brain, recent, running]);

    await expect(provisionSupervisionTarget(request({ idempotencyKey: 'keep-recent-idle' }), h.deps))
      .resolves.toMatchObject({ ok: false, reason: 'max_spawned' });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.sessions.some((candidate) => candidate.name === recent.name)).toBe(true);
  });

  it('uses the default real-registry lease fence beyond the first 101 tasks before reaping', async () => {
    const registry = new SupervisionTaskRegistry({ dbPath: ':memory:' });
    try {
      const brain = parent([OPENAI]);
      const leased = session('deck_sub_sup_auto_paged_lease', {
        parentSession: brain.name,
        label: 'Auto primary',
        state: 'idle',
        agentType: 'claude-code-sdk',
        providerId: 'anthropic',
        activeModel: 'opus',
        updatedAt: NOW - 32 * 60_000,
      });
      const running = session('deck_sub_sup_auto_capacity_peer', {
        parentSession: brain.name,
        label: 'Auto audit',
        state: 'running',
        agentType: 'claude-code-sdk',
        providerId: 'anthropic',
        activeModel: 'opus',
      });
      seedPagedRegistry({
        registry,
        taskCount: 102,
        // The owner filter itself must also cross the registry page boundary:
        // 101 historical terminal assignments precede the one live lease.
        leasedTaskIndexes: Array.from({ length: 102 }, (_, index) => index),
        cancelledTaskIndexes: Array.from({ length: 101 }, (_, index) => index),
        sessionName: leased.name,
      });
      await expect(defaultHasActiveSupervisionLease(leased.name, registry)).resolves.toBe(true);
      const h = harness([brain, leased, running], {
        hasActiveSupervisionLease: (sessionName) => defaultHasActiveSupervisionLease(sessionName, registry),
      });

      await expect(provisionSupervisionTarget(request({ idempotencyKey: 'paged-lease-fence' }), h.deps))
        .resolves.toMatchObject({ ok: false, reason: 'max_spawned' });
      expect(h.stop).not.toHaveBeenCalled();
      expect(h.sessions.some((candidate) => candidate.name === leased.name)).toBe(true);
    } finally {
      registry.close();
    }
  });

  it('reuses a ready automatic child before considering idle reaping', async () => {
    const brain = parent([OPENAI]);
    const ready = session('deck_sub_sup_auto_ready', {
      parentSession: brain.name,
      label: 'Auto audit',
      state: 'idle',
      updatedAt: NOW - 31 * 60_000,
    });
    const h = harness([brain, ready]);

    await expect(provisionSupervisionTarget(request(), h.deps)).resolves.toMatchObject({
      ok: true,
      target: { name: ready.name },
      evidence: { origin: 'reused' },
    });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('reuses its deterministic session after an in-memory restart instead of spawning twice', async () => {
    const brain = parent([OPENAI]);
    const h = harness([brain]);
    const first = await provisionSupervisionTarget(request(), h.deps);
    expect(first.ok).toBe(true);
    clearSupervisionAutoProvisionStateForTests();

    const replay = await provisionSupervisionTarget(request(), h.deps);

    expect(replay).toMatchObject({ ok: true, target: { name: first.ok ? first.target.name : '' } });
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('uses only explicit configured pool entries and fails when no supported SDK config is selected', async () => {
    const unconfigured = parent([]);
    const h = harness([unconfigured, session('deck_sub_historical', { parentSession: unconfigured.name })]);

    await expect(provisionSupervisionTarget(request(), h.deps)).resolves.toMatchObject({
      ok: false, reason: 'no_selected_config', evidence: { selectedPool: 'primary' },
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([
    ['launch failure', {}, 'launch_failed'],
    ['readiness timeout', { startSubSession: async () => {} }, 'readiness_timeout'],
  ] as const)('degrades an audit to a distinct same-family session after cross-vendor %s', async (_label, override, failure) => {
    const brain = parent([ANTHROPIC, OPENAI]);
    const audited = session('deck_sub_audited', { parentSession: brain.name });
    const fallback = session('deck_sub_fallback', { parentSession: brain.name });
    let clock = NOW;
    const h = harness([brain, audited, fallback], {
      startSubSession: override.startSubSession ?? (async () => { throw new Error('launch failed'); }),
      now: () => clock,
      wait: async (ms) => { clock += ms; },
      readyTimeoutMs: 1,
    });

    const result = await provisionSupervisionTarget(request({ auditedSessionName: audited.name }), h.deps);

    expect(result).toMatchObject({
      ok: true,
      target: { name: fallback.name },
      auditRoutingReason: 'same_family_degraded',
      auditDegradedReason: failure === 'readiness_timeout' ? 'cross_vendor_provision_timeout' : 'cross_vendor_provision_failed',
      evidence: { failureReason: failure, origin: 'reused', createdSessionName: undefined },
    });
    expect(result.ok && result.target.name).not.toBe(audited.name);
  });

  it('blocks strict cross-vendor only after the configured cross-vendor launch fails', async () => {
    const brain = parent([ANTHROPIC, OPENAI]);
    const audited = session('deck_sub_audited', { parentSession: brain.name });
    const fallback = session('deck_sub_fallback', { parentSession: brain.name });
    const h = harness([brain, audited, fallback], { startSubSession: async () => { throw new Error('no quota'); } });

    const result = await provisionSupervisionTarget(request({
      auditedSessionName: audited.name,
      strictCrossVendor: true,
    }), h.deps);

    expect(result).toMatchObject({
      ok: false,
      reason: 'launch_failed',
      auditDegradedReason: 'cross_vendor_provision_failed',
    });
    expect(h.deps.getSession?.(fallback.name)).toBeDefined();
  });

  it.each([
    ['limited', {
      state: 'idle' as const,
      providerLimit: {
        limitedAt: NOW,
        reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
        agentType: 'claude-code-sdk',
        evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED,
      },
    }, 'cross_vendor_limited'],
    ['offline', { state: 'stopped' as const }, 'cross_vendor_offline'],
  ] as const)('degrades to a same-family session when the cross-vendor family is %s', async (_label, crossPatch, degradedReason) => {
    const brain = parent([ANTHROPIC, OPENAI]);
    const audited = session('deck_sub_audited', { parentSession: brain.name });
    const fallback = session('deck_sub_fallback', { parentSession: brain.name });
    const cross = session('deck_sub_cross', {
      parentSession: brain.name,
      agentType: 'claude-code-sdk',
      providerId: 'anthropic',
      activeModel: 'opus',
      ...crossPatch,
    });
    const h = harness([brain, audited, fallback, cross]);

    const result = await provisionSupervisionTarget(request({ auditedSessionName: audited.name }), h.deps);

    expect(result).toMatchObject({
      ok: true,
      target: { name: fallback.name },
      auditRoutingReason: 'same_family_degraded',
      auditDegradedReason: degradedReason,
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('uses a configured same-family session when no cross-vendor config exists, unless strict mode was requested', async () => {
    const brain = parent([OPENAI]);
    const audited = session('deck_sub_audited', { parentSession: brain.name });
    const fallback = session('deck_sub_fallback', { parentSession: brain.name });
    const h = harness([brain, audited, fallback]);

    await expect(provisionSupervisionTarget(request({ auditedSessionName: audited.name }), h.deps)).resolves.toMatchObject({
      ok: true,
      target: { name: fallback.name },
      auditRoutingReason: 'same_family_degraded',
      auditDegradedReason: 'no_cross_vendor_configured',
    });
    await expect(provisionSupervisionTarget(request({
      auditedSessionName: audited.name,
      strictCrossVendor: true,
      idempotencyKey: 'strict-no-cross',
    }), h.deps)).resolves.toMatchObject({
      ok: false,
      auditDegradedReason: 'no_cross_vendor_configured',
    });
  });

  it('blocks when no second session or creatable same-family configuration exists', async () => {
    const brain = parent([OPENAI]);
    const audited = session('deck_sub_audited', { parentSession: brain.name });
    const h = harness([brain, audited], { startSubSession: async () => { throw new Error('launch failed'); } });

    await expect(provisionSupervisionTarget(request({ auditedSessionName: audited.name }), h.deps)).resolves.toMatchObject({
      ok: false,
      auditDegradedReason: 'no_independent_session',
    });
  });
});

describe('forced creation (explicit task.autoProvision)', () => {
  beforeEach(() => clearSupervisionAutoProvisionStateForTests());

  const forced = (patch: Partial<SupervisionAutoProvisionRequest> = {}): SupervisionAutoProvisionRequest => request({
    provenance: 'manual_explicit',
    forceCreate: true,
    requestedCapabilityId: OPENAI.capabilityId,
    requestedExecutionConfig: OPENAI,
    ...patch,
  });
  const idleMatch = (name: string, patch: Partial<SessionRecord> = {}) => session(name, {
    parentSession: 'deck_proj_brain', role: 'w1', userCreated: false, label: 'Auto primary', ...patch,
  });
  const created = (h: ReturnType<typeof harness>) => h.sessions.filter((candidate) => candidate.name.startsWith('deck_sub_send_auto_'));

  it('creates a new session even when an idle one of the same configuration exists (the automatic path would reuse it)', async () => {
    const existing = idleMatch('deck_sub_sup_auto_old');
    const h = harness([parent([OPENAI]), existing]);
    const automatic = await provisionSupervisionTarget(request({ provenance: 'manual_explicit', requestedCapabilityId: OPENAI.capabilityId, requestedExecutionConfig: OPENAI }), h.deps);
    expect(automatic).toMatchObject({ ok: true, evidence: { origin: 'reused' } });
    expect(h.start).not.toHaveBeenCalled();

    const result = await provisionSupervisionTarget(forced({ idempotencyKey: 'fresh-1' }), h.deps);
    expect(result).toMatchObject({ ok: true, evidence: { origin: 'spawned' } });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect((result as { target: SessionRecord }).target.name).toMatch(/^deck_sub_send_auto_[0-9a-f]{16}$/u);
    expect((result as { target: SessionRecord }).target.name).not.toBe(existing.name);
  });

  it('returns the same session for the same idempotency key and a different one for another key', async () => {
    const h = harness([parent([OPENAI])]);
    const first = await provisionSupervisionTarget(forced({ idempotencyKey: 'k1' }), h.deps) as { ok: true; target: SessionRecord };
    const replay = await provisionSupervisionTarget(forced({ idempotencyKey: 'k1' }), h.deps) as { ok: true; target: SessionRecord };
    const other = await provisionSupervisionTarget(forced({ idempotencyKey: 'k2' }), h.deps) as { ok: true; target: SessionRecord };
    expect(replay.target.name).toBe(first.target.name);
    expect(other.target.name).not.toBe(first.target.name);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(created(h)).toHaveLength(2);
  });

  it('has no launch cooldown: a second call right after the first creates again (the automatic path answers cooldown)', async () => {
    const h = harness([parent([OPENAI])], { cooldownMs: 10 * 60_000 });
    expect(await provisionSupervisionTarget(forced({ idempotencyKey: 'a' }), h.deps)).toMatchObject({ ok: true });
    expect(await provisionSupervisionTarget(forced({ idempotencyKey: 'b' }), h.deps)).toMatchObject({ ok: true });
    expect(created(h)).toHaveLength(2);

    clearSupervisionAutoProvisionStateForTests();
    const control = harness([parent([OPENAI])], { cooldownMs: 10 * 60_000 });
    const auto = (key: string) => request({ provenance: 'manual_explicit', idempotencyKey: key, requestedCapabilityId: OPENAI.capabilityId, requestedExecutionConfig: OPENAI });
    expect(await provisionSupervisionTarget(auto('a'), control.deps)).toMatchObject({ ok: true });
    // Make the first child busy so reuse cannot hide the cooldown.
    control.sessions.forEach((candidate) => { if (candidate.name.startsWith('deck_sub_')) candidate.state = 'running'; });
    expect(await provisionSupervisionTarget(auto('b'), control.deps)).toMatchObject({ ok: false, reason: 'cooldown' });
  });

  it('creates exactly one session per distinct key under concurrency, and one for concurrent retries of one key', async () => {
    const distinct = harness([parent([OPENAI])]);
    const results = await Promise.all(['c1', 'c2', 'c3'].map((key) => provisionSupervisionTarget(forced({ idempotencyKey: key }), distinct.deps)));
    expect(results.every((entry) => entry.ok)).toBe(true);
    expect(new Set(results.map((entry) => (entry as { target: SessionRecord }).target.name)).size).toBe(3);
    expect(distinct.start).toHaveBeenCalledTimes(3);

    const same = harness([parent([OPENAI])]);
    const retried = await Promise.all([1, 2, 3].map(() => provisionSupervisionTarget(forced({ idempotencyKey: 'retry' }), same.deps)));
    expect(new Set(retried.map((entry) => (entry as { target: SessionRecord }).target.name)).size).toBe(1);
    expect(same.start).toHaveBeenCalledTimes(1);
  });

  it('never reaps another session and ignores the pool work-concurrency and spawn gates', async () => {
    const stale = idleMatch('deck_sub_sup_auto_stale', { updatedAt: 1 });
    const stale2 = idleMatch('deck_sub_sup_auto_stale2', { updatedAt: 2, activeModel: 'other' });
    const h = harness([parent([OPENAI]), stale, stale2], { idleReapMs: 1, countActiveSupervisionAssignments: () => 99 });
    const result = await provisionSupervisionTarget(forced({ idempotencyKey: 'no-gates' }), h.deps);
    expect(result).toMatchObject({ ok: true, evidence: { origin: 'spawned' } });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.sessions.map((candidate) => candidate.name)).toEqual(expect.arrayContaining([stale.name, stale2.name]));

    const control = harness([parent([OPENAI])], { countActiveSupervisionAssignments: () => 99 });
    expect(await provisionSupervisionTarget(request({ provenance: 'manual_explicit', requestedCapabilityId: OPENAI.capabilityId, requestedExecutionConfig: OPENAI }), control.deps))
      .toMatchObject({ ok: false, reason: 'max_concurrency' });
  });

  it('creates without any configured pool, since the configuration was already chosen', async () => {
    const h = harness([session('deck_proj_brain', { role: 'brain' })]);
    expect(await provisionSupervisionTarget(forced({ idempotencyKey: 'no-pool' }), h.deps)).toMatchObject({ ok: true, evidence: { origin: 'spawned' } });
  });

  it('stamps the creation marker (who created it) on the new session and on nothing the pool path makes', async () => {
    const h = harness([parent([OPENAI])]);
    await provisionSupervisionTarget(forced({ idempotencyKey: 'marked' }), h.deps);
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      pairCreatedMetadata: expect.objectContaining({ autoCreated: true, createdBy: 'deck_proj_brain', source: 'send_auto_provision', createdAt: NOW }),
    }));
    // The same configuration through the pool path (not forced) creates a session that carries no creation marker.
    const pooled = harness([parent([OPENAI])]);
    await provisionSupervisionTarget(request({ provenance: 'manual_explicit', idempotencyKey: 'pooled', requestedCapabilityId: OPENAI.capabilityId, requestedExecutionConfig: OPENAI }), pooled.deps);
    expect(pooled.start).toHaveBeenCalledTimes(1);
    expect(pooled.start.mock.calls[0]![0]).not.toHaveProperty('pairCreatedMetadata');
  });

  it('refuses beyond the per-project cap of auto-created sessions, but still answers a retry of an existing key', async () => {
    const marked = (index: number, patch: Partial<SessionRecord> = {}) => idleMatch(`deck_sub_marked_${index}`, {
      pairCreatedMetadata: { autoCreated: true, createdBy: 'deck_proj_brain', source: 'send_auto_provision', reason: TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT, createdAt: 1 }, ...patch,
    });
    const others = Array.from({ length: TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT - 1 }, (_unused, index) => marked(index));
    const h = harness([parent([OPENAI]), ...others]);
    // Another project's marked sessions do not count against this project.
    h.sessions.push(session('deck_other_brain', { role: 'brain', projectName: 'other' }), idleMatch('deck_sub_foreign', {
      parentSession: 'deck_other_brain', projectName: 'other',
      pairCreatedMetadata: { autoCreated: true, createdBy: 'deck_other_brain' },
    }));
    expect(await provisionSupervisionTarget(forced({ idempotencyKey: 'last-slot' }), h.deps)).toMatchObject({ ok: true });
    const over = await provisionSupervisionTarget(forced({ idempotencyKey: 'over-the-cap' }), h.deps);
    expect(over).toMatchObject({ ok: false, reason: 'auto_created_cap_reached' });
    expect(h.start).toHaveBeenCalledTimes(1);
    // The session of the last-slot key already exists: replaying that key is not a new creation.
    expect(await provisionSupervisionTarget(forced({ idempotencyKey: 'last-slot' }), h.deps)).toMatchObject({ ok: true });
  });

  it('removes a session whose launch threw or never became ready, and leaves no cooldown behind', async () => {
    const throwing = harness([parent([OPENAI])]);
    throwing.deps.startSubSession = vi.fn(async (sub: SubSessionRecord) => {
      throwing.sessions.push(session(`deck_sub_${sub.id}`, { parentSession: 'deck_proj_brain', role: 'w1' }));
      throw new Error('launch exploded');
    });
    expect(await provisionSupervisionTarget(forced({ idempotencyKey: 'boom' }), throwing.deps)).toMatchObject({ ok: false, reason: 'launch_failed' });
    expect(throwing.stop).toHaveBeenCalledTimes(1);
    expect(created(throwing)).toHaveLength(0);

    // A clock that moves on every read, so the readiness wait can run out.
    let clock = NOW;
    const never = harness([parent([OPENAI])], { now: () => (clock += 10), cooldownMs: 10 * 60_000 });
    never.deps.startSubSession = vi.fn(async (sub: SubSessionRecord) => {
      never.sessions.push(session(`deck_sub_${sub.id}`, { parentSession: 'deck_proj_brain', role: 'w1', state: 'running', sessionInstanceId: undefined }));
    });
    expect(await provisionSupervisionTarget(forced({ idempotencyKey: 'slow' }), never.deps)).toMatchObject({ ok: false, reason: 'readiness_timeout' });
    expect(never.stop).toHaveBeenCalledTimes(1);
    expect(created(never)).toHaveLength(0);

    // No cooldown was set: the very next create (a working launch) goes ahead at once.
    never.deps.startSubSession = vi.fn(async (sub: SubSessionRecord) => {
      never.sessions.push(session(`deck_sub_${sub.id}`, { parentSession: 'deck_proj_brain', role: 'w1' }));
    });
    never.deps.now = () => NOW;
    expect(await provisionSupervisionTarget(forced({ idempotencyKey: 'slow-2' }), never.deps)).toMatchObject({ ok: true });
    expect(created(never)).toHaveLength(1);
  });

  it('keeps the automatic pool\'s spawn budget and reaping away from forced sessions (different id prefix)', async () => {
    const forcedSession = idleMatch('deck_sub_send_auto_0123456789abcdef', { updatedAt: 1, label: 'Auto primary' });
    const h = harness([parent([OPENAI, ANTHROPIC]), forcedSession], { idleReapMs: 1 });
    // maxSpawned is 2; the automatic path must not count the forced session toward it, nor stop it to make room.
    const result = await provisionSupervisionTarget(request({
      provenance: 'manual_explicit', idempotencyKey: 'auto-other', requestedCapabilityId: ANTHROPIC.capabilityId, requestedExecutionConfig: ANTHROPIC,
    }), h.deps);
    expect(result).toMatchObject({ ok: true, evidence: { origin: 'spawned' } });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.sessions.some((candidate) => candidate.name === forcedSession.name)).toBe(true);
  });
});


// A transport launch takes seconds and writes the creation marker only when it finishes, so the cap has to count launches still in flight.
describe('the per-project cap of auto-created sessions under concurrency', () => {
  beforeEach(() => clearSupervisionAutoProvisionStateForTests());

  const MAX = TASK_PAIR_AUTO_CREATED_SESSION_MAX_PER_PROJECT;
  const marker = { autoCreated: true as const, createdBy: 'deck_proj_brain', source: 'send_auto_provision' as const, reason: TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT, createdAt: 1 };
  const forcedRequest = (key: string): SupervisionAutoProvisionRequest => request({
    provenance: 'manual_explicit', forceCreate: true, idempotencyKey: key,
    requestedCapabilityId: OPENAI.capabilityId, requestedExecutionConfig: OPENAI,
  });
  const markedSessions = (count: number) => Array.from({ length: count }, (_unused, index) => session(`deck_sub_marked_${index}`, {
    parentSession: 'deck_proj_brain', role: 'w1', userCreated: false, label: 'Auto primary', pairCreatedMetadata: marker,
  }));

  /** A launch the test finishes by hand: until `finish()` the new session is absent from the list, as during a real transport launch. */
  function slowLaunches() {
    const sessions: SessionRecord[] = [parent([OPENAI]), ...markedSessions(MAX - 1)];
    const pending: Array<{ sub: SubSessionRecord; finish: () => void; fail: (error: Error) => void }> = [];
    const start = vi.fn((sub: SubSessionRecord) => new Promise<void>((resolve, reject) => {
      pending.push({
        sub,
        finish: () => {
          // The marker lands with the record, after the launch: exactly the window the cap used to miss.
          sessions.push(session(`deck_sub_${sub.id}`, {
            parentSession: sub.parentSession ?? undefined, role: 'w1', label: sub.label ?? undefined, agentType: sub.type, runtimeType: 'transport',
            providerId: sub.providerId ?? sub.type, activeModel: sub.requestedModel ?? undefined, pairCreatedMetadata: sub.pairCreatedMetadata ?? undefined,
          }));
          resolve();
        },
        fail: (error) => reject(error),
      });
    }));
    const stop = vi.fn(async (name: string) => {
      const index = sessions.findIndex((candidate) => candidate.name === name);
      if (index >= 0) sessions.splice(index, 1);
      return index >= 0;
    });
    const deps: SupervisionAutoProvisionDeps = {
      now: () => NOW, listSessions: () => [...sessions], getSession: (name) => sessions.find((candidate) => candidate.name === name),
      startSubSession: start, stopSubSession: stop, hasActiveSupervisionLease: () => false, countActiveSupervisionAssignments: () => 0,
      wait: async () => {}, readyTimeoutMs: 1, cooldownMs: 1,
    };
    return { sessions, pending, start, stop, deps };
  }
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('lets exactly one of several parallel creations take the last slot, however slow its launch is', async () => {
    const h = slowLaunches();
    const calls = ['a', 'b', 'c', 'd'].map((key) => provisionSupervisionTarget(forcedRequest(key), h.deps));
    await tick();
    expect(h.start).toHaveBeenCalledTimes(1);
    h.pending[0]!.finish();
    const results = await Promise.all(calls);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(3);
    for (const result of results.filter((candidate) => !candidate.ok)) expect(result).toMatchObject({ reason: 'auto_created_cap_reached' });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.sessions.filter((candidate) => candidate.pairCreatedMetadata?.autoCreated === true)).toHaveLength(MAX);
    expect(autoCreatedSlotsInFlightForTests()).toBe(0);
  });

  it('never overshoots when several launches are in flight at once with more room', async () => {
    const h = slowLaunches();
    h.sessions.splice(1, 3); // three more slots free: room for exactly 4 in total
    const calls = Array.from({ length: 9 }, (_unused, index) => provisionSupervisionTarget(forcedRequest(`k${index}`), h.deps));
    await tick();
    expect(h.start).toHaveBeenCalledTimes(4);
    for (const launch of [...h.pending]) launch.finish();
    const results = await Promise.all(calls);
    expect(results.filter((result) => result.ok)).toHaveLength(4);
    expect(h.sessions.filter((candidate) => candidate.pairCreatedMetadata?.autoCreated === true)).toHaveLength(MAX);
    expect(autoCreatedSlotsInFlightForTests()).toBe(0);
  });

  it('holds the slot while a launch is in flight and frees it when that launch fails (and the half-made session is gone)', async () => {
    const h = slowLaunches();
    const first = provisionSupervisionTarget(forcedRequest('doomed'), h.deps);
    await tick();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(autoCreatedSlotsInFlightForTests()).toBe(1);
    // While it is in flight the project is full for everyone else.
    expect(await provisionSupervisionTarget(forcedRequest('blocked'), h.deps)).toMatchObject({ ok: false, reason: 'auto_created_cap_reached' });
    h.pending[0]!.fail(new Error('quota exceeded'));
    expect(await first).toMatchObject({ ok: false, reason: 'launch_failed' });
    expect(autoCreatedSlotsInFlightForTests()).toBe(0);
    // The slot is back: the next creation goes through.
    const retry = provisionSupervisionTarget(forcedRequest('after'), h.deps);
    await tick();
    h.pending[1]!.finish();
    expect(await retry).toMatchObject({ ok: true });
  });

  it('frees the slot when the launch never becomes ready and the session is discarded', async () => {
    const h = slowLaunches();
    h.deps.readyTimeoutMs = 0;
    h.deps.now = (() => { let clock = NOW; return () => (clock += 5); })();
    const attempt = provisionSupervisionTarget(forcedRequest('never-ready'), h.deps);
    await tick();
    // The record appears but is not usable yet; readiness times out; the session is stopped.
    h.pending[0]!.finish();
    h.sessions.find((candidate) => candidate.name.startsWith('deck_sub_send_auto_'))!.state = 'running';
    const result = await attempt;
    expect(result.ok).toBe(false);
    expect(autoCreatedSlotsInFlightForTests()).toBe(0);
    expect(h.sessions.filter((candidate) => candidate.pairCreatedMetadata?.autoCreated === true)).toHaveLength(MAX - 1);
  });

  it('counts the pair creator and task.autoProvision as one cap: parallel creations from both paths share the last slot', async () => {
    const h = slowLaunches();
    const pairRequest = {
      parentSessionName: 'deck_proj_brain', config: OPENAI, label: 'pair executor', idempotencyKey: 'pair-1',
      metadata: { createdBy: 'deck_proj_brain', pairTaskId: 'tsk_race', role: 'executor' as const, reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT },
    };
    const both = Promise.all([
      createPairSubSession(pairRequest, { ...h.deps, hasRuntime: () => true, announce: async () => 'announced' }),
      provisionSupervisionTarget(forcedRequest('forced-1'), h.deps),
    ]);
    await tick();
    expect(h.start).toHaveBeenCalledTimes(1);
    h.pending[0]!.finish();
    const [pairResult, forcedResult] = await both;
    expect([pairResult.ok, forcedResult.ok].filter(Boolean)).toHaveLength(1);
    const refused = pairResult.ok ? forcedResult : pairResult;
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/cap_reached/) });
    expect(autoCreatedSlotsInFlightForTests()).toBe(0);
  });

  it('answers a retry of a key whose launch is still in flight with the same creation, not a second one', async () => {
    const h = slowLaunches();
    const first = provisionSupervisionTarget(forcedRequest('same'), h.deps);
    const second = provisionSupervisionTarget(forcedRequest('same'), h.deps);
    await tick();
    expect(h.start).toHaveBeenCalledTimes(1);
    h.pending[0]!.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});
