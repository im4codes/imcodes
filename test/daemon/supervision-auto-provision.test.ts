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
  clearSupervisionAutoProvisionStateForTests,
  provisionSupervisionTarget,
  type SupervisionAutoProvisionDeps,
  type SupervisionAutoProvisionRequest,
} from '../../src/daemon/supervision-auto-provision.js';
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
      projectDir: sub.cwd ?? '/repo',
    }));
  });
  const deps: SupervisionAutoProvisionDeps = {
    now: () => NOW,
    listSessions: () => [...sessions],
    getSession: (name) => sessions.find((candidate) => candidate.name === name),
    startSubSession: start,
    wait: async () => {},
    readyTimeoutMs: 1,
    cooldownMs: 1,
    ...override,
  };
  return { sessions, start, deps };
}

function request(patch: Partial<SupervisionAutoProvisionRequest> = {}): SupervisionAutoProvisionRequest {
  return {
    parentSessionName: 'deck_proj_brain',
    pool: 'primary',
    idempotencyKey: 'task-1',
    ...patch,
  };
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
