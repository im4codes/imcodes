import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRecord } from '../../src/store/session-store.js';
import {
  CronSendTargetLimitedError,
  clearSendIdempotencyCacheForTests,
  dispatchCronSend,
  dispatchHookSend,
  dispatchSendMessage,
  dispatchSendStop,
  listSendTargets,
} from '../../src/daemon/send-tool.js';
import { resolvePeerAuditCandidateList } from '../../src/daemon/peer-audit-candidates.js';
import {
  clearSupervisionAutoProvisionStateForTests,
  provisionSupervisionTarget,
} from '../../src/daemon/supervision-auto-provision.js';
import type { SubSessionRecord } from '../../src/daemon/subsession-manager.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';
import {
  getDelegationReplyStore,
  resetDelegationReplyStoreForTests,
} from '../../src/daemon/delegation-reply-store.js';
import {
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_STATUSES,
} from '../../shared/agent-delegation.js';
import { resolveSupervisionAssignmentWorktree } from '../../src/daemon/supervision-worktree-inspector.js';
import { buildSupervisionExecutionCapabilityId } from '../../shared/supervision-execution-pool.js';
import { resolvePeerAuditProviderFamily } from '../../shared/peer-audit.js';
import {
  DELEGATION_AVAILABILITY,
  DELEGATION_LIMIT_FALLBACK_TTL_MS,
  DELEGATION_LIMIT_REASONS,
  DELEGATION_TARGET_LIMITED,
  PROVIDER_LIMIT_EVIDENCE_KINDS,
  type DelegationLimitState,
} from '../../shared/delegation-availability.js';

const NOW = 1_700_000_000_000;

const caller = {
  userId: 'user-1',
  sessionName: 'deck_alpha_brain',
  projectName: 'alpha',
  projectRoot: '/work/alpha',
};

function session(
  overrides: Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role'>,
): SessionRecord {
  return {
    sessionInstanceId: `instance_${overrides.name}`,
    runtimeEpoch: `epoch_${overrides.name}`,
    agentType: 'codex',
    projectDir: `/work/${overrides.projectName}`,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    // `deck_<project>_w<n>` with role `w<n>` is the legacy auto-worker shape,
    // which `isDiscoverableInterAgentSession` hides unless it was user-created
    // or labelled. Without this these fixtures resolve to nothing and every
    // assertion below passes or fails for a reason that has nothing to do with
    // provider limits.
    userCreated: true,
    ...overrides,
  } as SessionRecord;
}

function limit(overrides: Partial<DelegationLimitState> = {}): DelegationLimitState {
  return {
    limitedAt: NOW,
    reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
    agentType: 'codex',
    evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED,
    ...overrides,
  };
}

const deps = (sessions: SessionRecord[], dispatchMessage = vi.fn(async () => {})) => ({
  now: () => NOW,
  listSessions: () => sessions,
  dispatchMessage,
  ensureSupervisionAssignmentWorktree: async (input: { assignmentId: string }) => ({
    ok: true as const,
    worktreePath: `/worktrees/${input.assignmentId}/repo`,
    baseRevision: 'a'.repeat(40),
    created: true,
  }),
});

function executionConfig(
  agentType: string,
  providerFamily: string,
  model: string,
  ccPresetId?: string,
) {
  const config = {
    agentType,
    providerFamily,
    runtimeType: 'transport' as const,
    model,
    ...(ccPresetId === undefined ? {} : { ccPresetId }),
  };
  return { ...config, capabilityId: buildSupervisionExecutionCapabilityId(config) };
}

function executionConfigFor(agentType: string, model: string) {
  return executionConfig(
    agentType,
    resolvePeerAuditProviderFamily({ agentType }),
    model,
  );
}

function supervisedBrain(
  primaryConfigs: ReturnType<typeof executionConfig>[],
  economyConfigs: ReturnType<typeof executionConfig>[] = [],
): SessionRecord {
  return session({
    name: 'deck_alpha_brain',
    projectName: 'alpha',
    role: 'brain',
    agentType: 'codex-sdk',
    activeModel: 'gpt-5.6-sol',
    runtimeType: 'transport',
    transportConfig: {
      supervision: {
        mode: 'off',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: { configs: primaryConfigs },
          economyTaskPool: { configs: economyConfigs },
        },
      },
    },
  });
}

function supervisedChild(input: {
  name: string;
  role: SessionRecord['role'];
  agentType: string;
  model: string;
  ccPreset?: string;
}): SessionRecord {
  return session({
    ...input,
    projectName: 'alpha',
    parentSession: 'deck_alpha_brain',
    label: input.name,
    activeModel: input.model,
    requestedModel: input.model,
    runtimeType: 'transport',
    ...(input.ccPreset === undefined ? {} : { ccPreset: input.ccPreset }),
  });
}

/**
 * The CONSUMERS of the provider-limit chain.
 *
 * Detection was wired end to end -- Claude, Codex and DeepSeek all persist a
 * canonical signal -- and nothing read it. `send_list_targets` still advertised
 * a refused account as selectable and `send_message` still queued into it, so
 * the whole feature was observable only by reading sessions.json by hand. These
 * tests exist so "detected" can never again be mistaken for "acted on".
 */
describe('delegation send gate', () => {
  beforeEach(() => {
    clearSendIdempotencyCacheForTests();
    clearSupervisionAutoProvisionStateForTests();
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
  });

  it('rejects a peer-audit-eligible CC target outside the caller primary pool before every side effect', async () => {
    const brain = supervisedBrain([
      executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol'),
    ]);
    const audited = supervisedChild({
      name: 'deck_alpha_impl',
      role: 'w1',
      agentType: 'codex-sdk',
      model: 'gpt-5.6-sol',
    });
    const outsideAuditor = supervisedChild({
      name: 'deck_alpha_cc_auditor',
      role: 'w2',
      agentType: 'claude-code-sdk',
      model: 'opus[1M]',
    });
    const sessions = [brain, audited, outsideAuditor];
    const listed = listSendTargets(caller, {}, deps(sessions));
    expect(listed.items.map((item) => item.sessionName)).toContain(outsideAuditor.name);
    expect(listSendTargets(caller, { executionPool: 'primary' }, deps(sessions))
      .items.map((item) => item.sessionName)).not.toContain(outsideAuditor.name);
    const candidates = resolvePeerAuditCandidateList({
      auditedSessionName: audited.name,
      allSessions: sessions,
    });
    expect(candidates).toMatchObject({
      ok: true,
      list: {
        candidates: expect.arrayContaining([
          expect.objectContaining({ name: outsideAuditor.name, eligible: true }),
        ]),
      },
    });

    const registry = getSupervisionTaskRegistry();
    const createTask = vi.spyOn(registry, 'createOrGet');
    const createAssignment = vi.spyOn(registry, 'createAssignment');
    const createReplyAuthority = vi.spyOn(getDelegationReplyStore(), 'create');
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(caller, {
      target: outsideAuditor.name,
      message: 'audit the implementation',
      reply: true,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId: 'pool_outside_audit_attempt_1',
        auditedSessionName: audited.name,
      },
      task: {
        classification: 'integration_task',
        objective: 'audit the implementation',
        executionPool: 'primary',
        ownedFiles: ['src/owned.ts'],
      },
    }, deps(sessions, dispatchMessage));

    expect(result).toMatchObject({
      status: 'error',
      reason: 'identity_rejected',
      error: expect.stringContaining('task execution pool rejected target: unselected_config'),
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
    expect(createReplyAuthority).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('keeps default discovery complete and filters only when a configured pool is explicitly requested', () => {
    const selected = supervisedChild({
      name: 'deck_alpha_selected',
      role: 'w1',
      agentType: 'codex-sdk',
      model: 'gpt-5.6-sol',
    });
    const foreign = [
      supervisedChild({
        name: 'deck_alpha_foreign_1',
        role: 'w2',
        agentType: 'deepseek-harness',
        model: 'deepseek-v4',
      }),
      supervisedChild({
        name: 'deck_alpha_foreign_2',
        role: 'w3',
        agentType: 'cursor-headless',
        model: 'cursor-default',
      }),
      supervisedChild({
        name: 'deck_alpha_foreign_3',
        role: 'w4',
        agentType: 'claude-code-sdk',
        model: 'opus[1M]',
      }),
    ];
    const configured = supervisedBrain([
      executionConfigFor('codex-sdk', 'gpt-5.6-sol'),
    ]);
    const sessions = [configured, selected, ...foreign];

    const all = listSendTargets(caller, {}, deps(sessions));
    expect(all.items.map((item) => item.sessionName)).toEqual([
      selected.name,
      ...foreign.map((target) => target.name),
    ]);
    expect(all.items.find((item) => item.sessionName === selected.name)).toMatchObject({
      eligiblePools: ['primary'],
      dispatchMode: 'new_work',
      availability: DELEGATION_AVAILABILITY.READY,
      limitGroup: expect.any(String),
      replyCapable: true,
    });
    expect(all.items.find((item) => item.sessionName === foreign[0]!.name)).toMatchObject({
      eligiblePools: [],
      dispatchMode: 'unavailable',
    });

    const primary = listSendTargets(caller, { executionPool: 'primary' }, deps(sessions));
    expect(primary).toMatchObject({
      status: 'ok',
      executionPoolsState: 'configured',
      appliedExecutionPool: 'primary',
      items: [expect.objectContaining({ sessionName: selected.name, eligiblePools: ['primary'] })],
    });

    const removed = listSendTargets(caller, {}, deps([
      supervisedBrain([]),
      selected,
      ...foreign,
    ]));
    expect(removed.items).toHaveLength(4);
    expect(removed.items.every((item) => item.eligiblePools?.length === 0)).toBe(true);
    expect(listSendTargets(caller, { executionPool: 'primary' }, deps([
      supervisedBrain([]), selected, ...foreign,
    ])).items).toEqual([]);
  });

  it('filters primary and economy independently, composes query after pool membership, and retains availability evidence', () => {
    const codexConfig = executionConfigFor('codex-sdk', 'gpt-5.6-sol');
    const qwenConfig = executionConfigFor('qwen', 'qwen3-coder-plus');
    const brain = supervisedBrain([codexConfig, codexConfig], [qwenConfig]);
    const primaryA = supervisedChild({ name: 'deck_alpha_primary_a', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol' });
    const primaryB = supervisedChild({ name: 'deck_alpha_primary_b', role: 'w2', agentType: 'codex-sdk', model: 'gpt-5.6-sol' });
    primaryB.state = 'running';
    const economy = supervisedChild({ name: 'deck_alpha_economy', role: 'w3', agentType: 'qwen', model: 'qwen3-coder-plus' });
    const outside = supervisedChild({ name: 'deck_alpha_outside', role: 'w4', agentType: 'cursor-headless', model: 'cursor-default' });
    const sessions = [brain, primaryA, primaryB, economy, outside];

    const primary = listSendTargets(caller, { executionPool: 'primary' }, deps(sessions));
    expect(primary.items.map((item) => item.sessionName)).toEqual([primaryA.name, primaryB.name]);
    expect(primary.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionName: primaryA.name,
        eligiblePools: ['primary'],
        availability: DELEGATION_AVAILABILITY.READY,
        dispatchMode: 'new_work',
        limitGroup: expect.any(String),
        replyCapable: true,
      }),
      expect.objectContaining({
        sessionName: primaryB.name,
        eligiblePools: ['primary'],
        availability: DELEGATION_AVAILABILITY.BUSY,
        dispatchMode: 'queue_only',
      }),
    ]));

    const economyOnly = listSendTargets(caller, { executionPool: 'economy' }, deps(sessions));
    expect(economyOnly.items.map((item) => item.sessionName)).toEqual([economy.name]);
    expect(economyOnly.items[0]).toMatchObject({ eligiblePools: ['economy'] });

    expect(listSendTargets(caller, {
      executionPool: 'primary',
      query: 'primary_b',
    }, deps(sessions)).items.map((item) => item.sessionName)).toEqual([primaryB.name]);
    expect(listSendTargets(caller, {
      executionPool: 'economy',
      query: 'primary',
    }, deps(sessions)).items).toEqual([]);
  });

  it('uses canonical ccPresetId membership for list and audit-with-task admission while legacy configs remain ordinary', async () => {
    const presetA = executionConfig('claude-code-sdk', 'anthropic', 'opus[1M]', 'preset-a');
    const brain = supervisedBrain([presetA]);
    const audited = supervisedChild({
      name: 'deck_alpha_impl', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const matching = supervisedChild({
      name: 'deck_alpha_preset_a', role: 'w2', agentType: 'claude-code-sdk', model: 'opus[1M]', ccPreset: 'preset-a',
    });
    const mismatched = supervisedChild({
      name: 'deck_alpha_preset_b', role: 'w3', agentType: 'claude-code-sdk', model: 'opus[1M]', ccPreset: 'preset-b',
    });
    const missingPreset = supervisedChild({
      name: 'deck_alpha_legacy_cc', role: 'w4', agentType: 'claude-code-sdk', model: 'opus[1M]',
    });
    const sessions = [brain, audited, matching, mismatched, missingPreset];

    expect(listSendTargets(caller, { executionPool: 'primary' }, deps(sessions))
      .items.map((item) => item.sessionName)).toEqual([matching.name]);
    const defaultByName = new Map(listSendTargets(caller, {}, deps(sessions))
      .items.map((item) => [item.sessionName, item]));
    expect(defaultByName.get(matching.name)?.eligiblePools).toEqual(['primary']);
    expect(defaultByName.get(mismatched.name)?.eligiblePools).toEqual([]);
    expect(defaultByName.get(missingPreset.name)?.eligiblePools).toEqual([]);

    const registry = getSupervisionTaskRegistry();
    const createTask = vi.spyOn(registry, 'createOrGet');
    const createAssignment = vi.spyOn(registry, 'createAssignment');
    const createReplyAuthority = vi.spyOn(getDelegationReplyStore(), 'create');
    const dispatchMessage = vi.fn(async () => {});
    await expect(dispatchSendMessage(caller, {
      target: mismatched.name,
      message: 'audit with the wrong preset',
      reply: true,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId: 'preset_mismatch_audit_attempt_1',
        auditedSessionName: audited.name,
      },
      task: { objective: 'preset mismatch audit', executionPool: 'primary' },
    }, deps(sessions, dispatchMessage))).resolves.toMatchObject({
      status: 'error',
      reason: 'identity_rejected',
      error: expect.stringContaining('task execution pool rejected target'),
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
    expect(createReplyAuthority).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();

    const legacyConfig = executionConfig('claude-code-sdk', 'anthropic', 'opus[1M]');
    const legacyBrain = supervisedBrain([legacyConfig]);
    const legacySessions = [legacyBrain, matching, missingPreset];
    expect(listSendTargets(caller, { executionPool: 'primary' }, deps(legacySessions))
      .items.map((item) => item.sessionName)).toEqual([missingPreset.name]);
  });

  it('auto-provisions and dispatches to one visible child carrying the exact configured CC preset', async () => {
    const presetA = executionConfig('claude-code-sdk', 'anthropic', 'opus[1M]', 'preset-a');
    const brain = supervisedBrain([presetA]);
    const ordinary = supervisedChild({
      name: 'deck_alpha_ordinary_cc',
      role: 'w1',
      agentType: 'claude-code-sdk',
      model: 'opus[1M]',
    });
    const sessions = [brain, ordinary];
    const startSubSession = vi.fn(async (sub: SubSessionRecord) => {
      sessions.push(session({
        name: `deck_sub_${sub.id}`,
        projectName: 'alpha',
        projectDir: sub.cwd ?? '/work/alpha',
        role: 'w2',
        parentSession: sub.parentSession ?? undefined,
        label: sub.label ?? undefined,
        agentType: sub.type,
        runtimeType: sub.runtimeType ?? 'transport',
        activeModel: sub.requestedModel ?? undefined,
        requestedModel: sub.requestedModel ?? undefined,
        ccPreset: sub.ccPreset ?? undefined,
        executionCloneMetadata: undefined,
        userCreated: true,
      }));
    });
    const autoProvision = (request: Parameters<typeof provisionSupervisionTarget>[0]) => (
      provisionSupervisionTarget(request, {
        now: () => NOW,
        listSessions: () => sessions,
        getSession: (name) => sessions.find((candidate) => candidate.name === name),
        startSubSession,
        wait: async () => {},
        readyTimeoutMs: 1,
      })
    );
    const dispatchMessage = vi.fn(async () => {});

    const result = await dispatchSendMessage(caller, {
      message: 'run with preset-a',
      idempotencyKey: 'preset-auto-provision-1',
      task: {
        objective: 'run with preset-a',
        autoProvision: true,
        executionPool: 'primary',
        requestedExecutionType: presetA,
      },
    }, {
      ...deps(sessions, dispatchMessage),
      provisionSupervisionTarget: autoProvision,
    });

    expect(result).toMatchObject({
      status: 'accepted',
      provisioning: {
        selectedConfig: presetA,
        origin: 'spawned',
        createdSessionName: expect.any(String),
      },
      taskId: expect.any(String),
      assignmentId: expect.any(String),
    });
    expect(startSubSession).toHaveBeenCalledTimes(1);
    expect(startSubSession).toHaveBeenCalledWith(expect.objectContaining({
      type: 'claude-code-sdk',
      ccPreset: 'preset-a',
      parentSession: brain.name,
    }));
    const createdName = result.status === 'accepted' ? result.provisioning?.createdSessionName : undefined;
    const created = sessions.find((candidate) => candidate.name === createdName);
    expect(created).toMatchObject({
      userCreated: true,
      parentSession: brain.name,
      ccPreset: 'preset-a',
      executionCloneMetadata: undefined,
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0]?.[0]).toMatchObject({ name: createdName, ccPreset: 'preset-a' });
    const assignment = result.status === 'accepted' && result.assignmentId
      ? getSupervisionTaskRegistry().getAssignment(result.assignmentId)
      : undefined;
    expect(assignment?.executionBinding).toMatchObject({
      origin: 'spawned',
      requested: presetA,
      actual: { sessionName: createdName, ccPresetId: 'preset-a' },
    });
  });

  it('marks pool members as new-work, queue-only, or unavailable from authoritative availability', () => {
    const target = supervisedChild({
      name: 'deck_alpha_selected',
      role: 'w1',
      agentType: 'codex-sdk',
      model: 'gpt-5.6-sol',
    });
    const brain = supervisedBrain([
      executionConfigFor('codex-sdk', 'gpt-5.6-sol'),
    ]);
    const listed = (overrides: Partial<SessionRecord>, now = NOW) => listSendTargets(
      caller,
      { executionPool: 'primary' },
      {
        ...deps([brain, { ...target, ...overrides } as SessionRecord]),
        now: () => now,
      },
    ).items[0];

    expect(listed({ state: 'idle' })).toMatchObject({
      availability: DELEGATION_AVAILABILITY.READY,
      dispatchMode: 'new_work',
    });
    expect(listed({ state: 'running' })).toMatchObject({
      availability: DELEGATION_AVAILABILITY.BUSY,
      dispatchMode: 'queue_only',
    });
    expect(listed({ providerLimit: limit({ agentType: 'codex-sdk' }) })).toMatchObject({
      availability: DELEGATION_AVAILABILITY.LIMITED,
      dispatchMode: 'unavailable',
    });
    expect(listed({ state: 'error' })).toMatchObject({
      availability: DELEGATION_AVAILABILITY.OFFLINE,
      dispatchMode: 'unavailable',
    });
    expect(listed(
      { providerLimit: limit({ agentType: 'codex-sdk', retryAt: NOW - 1 }) },
      NOW + 24 * 60 * 60_000,
    )).toMatchObject({
      availability: DELEGATION_AVAILABILITY.UNKNOWN,
      dispatchMode: 'unavailable',
    });
  });

  it('keeps legacy-unconfigured default discovery compatible but fails closed for explicit pool filtering', () => {
    const legacyBrain = session({
      name: 'deck_alpha_brain',
      projectName: 'alpha',
      role: 'brain',
    });
    const target = session({
      name: 'deck_alpha_w1',
      projectName: 'alpha',
      role: 'w1',
    });

    expect(listSendTargets(caller, {}, deps([legacyBrain, target]))).toMatchObject({
      status: 'ok',
      executionPoolsState: 'legacy_unconfigured',
      items: [expect.objectContaining({ sessionName: target.name })],
    });
    expect(listSendTargets(caller, { executionPool: 'primary' }, deps([legacyBrain, target]))).toMatchObject({
      status: 'ok',
      executionPoolsState: 'legacy_unconfigured',
      appliedExecutionPool: 'primary',
      items: [],
    });
  });

  it('accepts a different-session auditor selected by the caller primary pool and keeps audit eligibility gates', async () => {
    const claude = executionConfig('claude-code-sdk', 'anthropic', 'opus[1M]');
    const brain = supervisedBrain([claude]);
    const audited = supervisedChild({
      name: 'deck_alpha_impl',
      role: 'w1',
      agentType: 'codex-sdk',
      model: 'gpt-5.6-sol',
    });
    const auditor = supervisedChild({
      name: 'deck_alpha_cc_auditor',
      role: 'w2',
      agentType: 'claude-code-sdk',
      model: 'opus[1M]',
    });
    const sessions = [brain, audited, auditor];
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(caller, {
      target: auditor.name,
      message: 'audit the implementation',
      reply: true,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId: 'pool_member_audit_attempt_1',
        auditedSessionName: audited.name,
      },
      task: {
        classification: 'integration_task',
        objective: 'audit the implementation',
        executionPool: 'primary',
        currentRevision: 'revision-under-audit',
        ownedFiles: ['src/owned.ts'],
      },
    }, deps(sessions, dispatchMessage));

    expect(result).toMatchObject({
      status: 'accepted',
      taskId: expect.any(String),
      assignmentId: expect.any(String),
      deliveries: [expect.objectContaining({ target: auditor.name, status: 'delivered' })],
    });
    if (result.status !== 'accepted' || !result.assignmentId) throw new Error('expected accepted audit');
    expect(getSupervisionTaskRegistry().getAssignment(result.assignmentId)).toMatchObject({
      role: 'auditor',
      identity: { sessionName: auditor.name },
      executionBinding: {
        pool: 'primary',
        requested: claude,
        actual: {
          sessionName: auditor.name,
          agentType: 'claude-code-sdk',
          providerFamily: 'anthropic',
          model: 'opus[1M]',
        },
      },
    });
    expect(getSupervisionTaskRegistry().get(result.taskId!)).toMatchObject({
      classification: 'integration_task',
      currentRevision: 'revision-under-audit',
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('redelivers one exact pending auditor with stable identity and never scans or creates another assignment', async () => {
    const auditorConfig = executionConfig('claude-code-sdk', 'anthropic', 'opus[1M]');
    const brain = supervisedBrain([auditorConfig]);
    const audited = supervisedChild({
      name: 'deck_alpha_impl', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const auditor = supervisedChild({
      name: 'deck_alpha_auditor', role: 'w2', agentType: 'claude-code-sdk', model: 'opus[1M]',
    });
    const sessions = [brain, audited, auditor];
    const registry = getSupervisionTaskRegistry();
    const taskId = 'tsk_3f4';
    const assignmentId = 'asg_3g0';
    const attemptId = 'tsk_3f4-r1-manual-audit-cx1-v1';
    const revision = 'supervision-reply-continuation-recovery-cx7-r1-d4406e3f';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'integration_task', objective: 'exact fallback audit', currentRevision: revision,
    }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId, role: 'coordinator', required: false,
      identity: {
        sessionName: brain.name,
        sessionInstanceId: brain.sessionInstanceId,
        runtimeEpoch: brain.runtimeEpoch,
        agentType: brain.agentType,
        providerFamily: 'openai',
      },
    }).ok).toBe(true);
    expect(registry.createAssignment({
      taskId, assignmentId, role: 'auditor',
      identity: {
        sessionName: auditor.name,
        sessionInstanceId: auditor.sessionInstanceId,
        runtimeEpoch: auditor.runtimeEpoch,
        agentType: auditor.agentType,
        providerFamily: 'anthropic',
      },
      auditAttemptId: attemptId,
      auditRevision: revision,
    }).ok).toBe(true);
    for (const suffix of ['missing-one', 'missing-two']) {
      expect(registry.createOrGet({
        taskId: `interferer-${suffix}`, projectName: 'alpha', objective: suffix,
      }).ok).toBe(true);
      expect(registry.createAssignment({
        taskId: `interferer-${suffix}`, role: 'implementer',
        identity: {
          sessionName: auditor.name,
          sessionInstanceId: auditor.sessionInstanceId,
          runtimeEpoch: auditor.runtimeEpoch,
          agentType: auditor.agentType,
          providerFamily: 'anthropic',
        },
      }).ok).toBe(true);
    }

    const ensured = vi.fn(async (input: { assignmentId: string }) => ({
      ok: true as const,
      worktreePath: `/worktrees/${input.assignmentId}/repo`,
      baseRevision: 'a'.repeat(40),
      created: true,
    }));
    const messageIds: string[] = [];
    const dispatchMessage = vi.fn(async (_target: SessionRecord, _message: string, options: { messageId: string; supervision?: { taskId: string; assignmentId: string } }) => {
      messageIds.push(options.messageId);
      expect(options.supervision).toEqual({ taskId, assignmentId });
      if (messageIds.length === 1) throw new Error('simulated pre-delivery bridge failure');
    });
    const request = {
      target: auditor.name,
      message: 'redeliver the original exact audit',
      reply: true,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId,
        auditedSessionName: audited.name,
      },
      task: {
        taskId,
        assignmentId,
        executionPool: 'primary' as const,
        currentRevision: revision,
        auditRevision: revision,
        auditAttemptId: attemptId,
      },
    };
    const injected = {
      ...deps(sessions, dispatchMessage),
      ensureSupervisionAssignmentWorktree: ensured,
      hasDeliveryEvidence: () => false,
    };

    await expect(dispatchSendMessage(caller, request, injected)).resolves.toMatchObject({
      status: 'error', error: 'simulated pre-delivery bridge failure',
    });
    await expect(dispatchSendMessage(caller, request, injected)).resolves.toMatchObject({
      status: 'accepted', taskId, assignmentId,
    });
    expect(messageIds).toHaveLength(2);
    expect(messageIds[0]).toBe(messageIds[1]);
    expect(ensured.mock.calls.map(([input]) => input.assignmentId)).toEqual([assignmentId, assignmentId]);
    expect(registry.get(taskId)?.assignments.filter((assignment) => assignment.role === 'auditor'))
      .toEqual([expect.objectContaining({ assignmentId, auditAttemptId: attemptId, auditRevision: revision })]);

    ensured.mockClear();
    dispatchMessage.mockClear();
    await expect(dispatchSendMessage(caller, {
      ...request,
      task: { ...request.task, auditRevision: 'different-revision' },
    }, injected)).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('exact non-terminal assignment'),
    });
    expect(ensured).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();

    await expect(dispatchSendMessage(caller, request, {
      ...injected,
      hasDeliveryEvidence: () => true,
    })).resolves.toMatchObject({
      status: 'error',
      error: 'audit redelivery rejected because durable delivery evidence already exists',
    });
    expect(ensured).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();

    // CONTRACT CHANGE (tsk_4d0, Brain-directed): `auditing` is NON-TERMINAL, so
    // an auditor that has already started and recorded progress MUST stay
    // exactly reachable — that was the tsk_4d0 deadlock, where the assignment
    // sat in `implementing` with an idle session and no continue/cancel path.
    // The previous expectation here ("no audit progress" refusal) encoded the
    // superseded contract. The fail-closed guarantee is NOT dropped: it moves
    // to a TERMINAL status below, which must still refuse.
    expect(registry.updateAssignment({
      assignmentId,
      identity: registry.getAssignment(assignmentId)!.identity,
      status: 'auditing',
    }).ok).toBe(true);
    await expect(dispatchSendMessage(caller, request, injected)).resolves.toMatchObject({
      status: 'accepted',
    });

    expect(registry.applyTaskIntent({
      taskId: registry.getAssignment(assignmentId)!.taskId,
      assignmentId, intent: 'cancel', toStatus: 'cancelled',
    })).toMatchObject({ ok: true });
    ensured.mockClear();
    dispatchMessage.mockClear();
    await expect(dispatchSendMessage(caller, request, injected)).resolves.toMatchObject({
      status: 'error',
    });
    expect(ensured).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('rejects integration_slice audit registration before registry, reply, or dispatch side effects', async () => {
    const auditorConfig = executionConfig('claude-code-sdk', 'anthropic', 'opus[1M]');
    const brain = supervisedBrain([auditorConfig]);
    const audited = supervisedChild({
      name: 'deck_alpha_slice_worker', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const auditor = supervisedChild({
      name: 'deck_alpha_slice_auditor', role: 'w2', agentType: 'claude-code-sdk', model: 'opus[1M]',
    });
    const sessions = [brain, audited, auditor];
    const registry = getSupervisionTaskRegistry();
    const createTask = vi.spyOn(registry, 'createOrGet');
    const createAssignment = vi.spyOn(registry, 'createAssignment');
    const createReplyAuthority = vi.spyOn(getDelegationReplyStore(), 'create');
    const dispatchMessage = vi.fn(async () => {});

    const result = await dispatchSendMessage(caller, {
      target: auditor.name,
      message: 'must not audit a slice',
      reply: true,
      audit: {
        kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        attemptId: 'forbidden_slice_audit_attempt',
        auditedSessionName: audited.name,
      },
      task: {
        classification: 'integration_slice',
        objective: 'slice is validated but not merged',
        executionPool: 'primary',
        currentRevision: 'slice-r1',
        ownedFiles: ['src/slice.ts'],
      },
    }, deps(sessions, dispatchMessage));

    expect(result).toMatchObject({
      status: 'error', reason: 'validation_failed',
      error: expect.stringContaining('integration_task or independent_top_level'),
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
    expect(createReplyAuthority).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });

  it('appends a busy-task addendum to the exact existing assignment without minting another task or assignment', async () => {
    const config = executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    const brain = supervisedBrain([config]);
    const worker = supervisedChild({
      name: 'deck_alpha_append_worker', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const sessions = [brain, worker];
    const dispatchMessage = vi.fn(async () => 'queued' as const);
    const created = await dispatchSendMessage(caller, {
      target: worker.name,
      message: 'start one logical task',
      idempotencyKey: 'append-one-logical-task',
      task: {
        classification: 'integration_slice', objective: 'one task', executionPool: 'primary',
        ownedFiles: ['src/one.ts'],
      },
    }, deps(sessions, dispatchMessage));
    expect(created).toMatchObject({ status: 'accepted', taskId: expect.any(String), assignmentId: expect.any(String) });
    if (created.status !== 'accepted' || !created.taskId || !created.assignmentId) throw new Error('expected task');

    worker.state = 'running';
    const registry = getSupervisionTaskRegistry();
    const taskCount = registry.list().length;
    const assignmentCount = registry.get(created.taskId)!.assignments.length;
    const createTask = vi.spyOn(registry, 'createOrGet');
    const createAssignment = vi.spyOn(registry, 'createAssignment');
    dispatchMessage.mockClear();

    const appended = await dispatchSendMessage(caller, {
      target: worker.name,
      message: 'clarification for the same active work',
      deliveryMode: 'append',
      task: {
        taskId: created.taskId, executionPool: 'primary', ownedFiles: ['stale/metadata-only.ts'],
      },
    }, deps(sessions, dispatchMessage));

    expect(appended).toMatchObject({
      status: 'accepted', taskId: created.taskId, assignmentId: created.assignmentId,
      deliveries: [expect.objectContaining({ target: worker.name, status: 'queued' })],
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(taskCount);
    expect(registry.get(created.taskId)!.assignments).toHaveLength(assignmentCount);
    expect(registry.get(created.taskId)!.assignments.filter((item) => item.role === 'implementer'))
      .toEqual([expect.objectContaining({ assignmentId: created.assignmentId })]);
    expect(registry.getAssignment(created.assignmentId)?.scopeFiles).toEqual(['src/one.ts']);
    expect(dispatchMessage).toHaveBeenCalledWith(worker, expect.any(String), expect.objectContaining({
      deliveryMode: 'append',
    }));

    const otherWorker = supervisedChild({
      name: 'deck_alpha_wrong_append_worker', role: 'w2', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const wrongTarget = await dispatchSendMessage(caller, {
      target: otherWorker.name,
      message: 'must not fork the existing implementation assignment',
      deliveryMode: 'append',
      task: { taskId: created.taskId, executionPool: 'primary' },
    }, deps([...sessions, otherWorker], dispatchMessage));
    expect(wrongTarget).toMatchObject({
      status: 'error', reason: 'identity_rejected',
      error: expect.stringContaining('authoritative active implementer assignment'),
    });
    expect(registry.list()).toHaveLength(taskCount);
    expect(registry.get(created.taskId)!.assignments).toHaveLength(assignmentCount);
  });

  it('renews an expired reply authority on an exact dirty continuation without reprovisioning its worktree', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'imcodes-continuation-reply-'));
    const previousRoot = process.env.IMCODES_WORKTREES_ROOT;
    process.env.IMCODES_WORKTREES_ROOT = temp;
    const config = executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    const brain = supervisedBrain([config]);
    const worker = supervisedChild({
      name: 'deck_alpha_reply_renewal_worker', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const sessions = [brain, worker];
    const dispatchMessage = vi.fn(async () => 'queued' as const);
    const ensureWorktree = vi.fn(async (input: { assignmentId: string; sessionName: string }) => {
      const worktreePath = resolveSupervisionAssignmentWorktree(input);
      mkdirSync(worktreePath, { recursive: true });
      return { ok: true as const, worktreePath, baseRevision: 'a'.repeat(40), created: true };
    });
    const testDeps = {
      ...deps(sessions, dispatchMessage),
      ensureSupervisionAssignmentWorktree: ensureWorktree,
    };

    try {
      const created = await dispatchSendMessage(caller, {
        target: worker.name,
        message: 'start implementation',
        task: { classification: 'integration_slice', objective: 'reply renewal', executionPool: 'primary' },
      }, testDeps);
      if (created.status !== 'accepted' || !created.taskId || !created.assignmentId) throw new Error('expected task');
      const oldDelegationId = created.deliveries[0]?.delegationId;
      if (!oldDelegationId) throw new Error('expected initial reply authority');
      const worktreePath = resolveSupervisionAssignmentWorktree({
        sessionName: worker.name,
        assignmentId: created.assignmentId,
      });
      writeFileSync(join(worktreePath, 'implementation-in-progress.ts'), 'dirty bytes\n');
      ensureWorktree.mockClear();
      dispatchMessage.mockClear();

      const appendWithReply = (message: string) => dispatchSendMessage(caller, {
        target: worker.name,
        message,
        deliveryMode: 'append',
        reply: true,
        task: {
          taskId: created.taskId,
          assignmentId: created.assignmentId,
          executionPool: 'primary',
        },
      }, testDeps);

      const livePending = await appendWithReply('reuse the live reply path');
      const repeatedLivePending = await appendWithReply('reuse it again');
      for (const result of [livePending, repeatedLivePending]) {
        expect(result).toMatchObject({
          status: 'accepted',
          deliveries: [expect.objectContaining({ delegationId: oldDelegationId })],
        });
      }
      expect(ensureWorktree).not.toHaveBeenCalled();

      getDelegationReplyStore().expire(oldDelegationId, NOW + 1);

      const continued = await appendWithReply('continue with a fresh reply path');

      expect(continued).toMatchObject({
        status: 'accepted',
        taskId: created.taskId,
        assignmentId: created.assignmentId,
        deliveries: [expect.objectContaining({
          target: worker.name,
          status: 'queued',
          delegationId: expect.any(String),
        })],
      });
      if (continued.status !== 'accepted') throw new Error('expected continuation');
      const renewedDelegationId = continued.deliveries[0]?.delegationId;
      expect(renewedDelegationId).not.toBe(oldDelegationId);
      expect(ensureWorktree).not.toHaveBeenCalled();
      expect(getDelegationReplyStore().get(oldDelegationId)).toMatchObject({
        status: AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
      });
      expect(getDelegationReplyStore().get(renewedDelegationId!)).toMatchObject({
        taskId: created.taskId,
        assignmentId: created.assignmentId,
        target: {
          sessionName: worker.name,
          sessionInstanceId: worker.sessionInstanceId,
          runtimeEpoch: worker.runtimeEpoch,
        },
        status: AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      });
      const repeatedRenewal = await appendWithReply('reuse the renewed reply path');
      expect(repeatedRenewal).toMatchObject({
        status: 'accepted',
        deliveries: [expect.objectContaining({ delegationId: renewedDelegationId })],
      });
      const sender = {
        sessionName: worker.name,
        sessionInstanceId: worker.sessionInstanceId!,
        runtimeEpoch: worker.runtimeEpoch!,
      };
      expect(getDelegationReplyStore().receive({
        delegationId: renewedDelegationId!,
        result: 'fresh bound reply',
        sender,
        now: NOW + 2,
      })).toMatchObject({
        ok: true,
        record: {
          taskId: created.taskId,
          assignmentId: created.assignmentId,
          result: 'fresh bound reply',
        },
      });

      rmSync(worktreePath, { recursive: true, force: true });
      await expect(dispatchSendMessage(caller, {
        target: worker.name,
        message: 'recover the now-missing exact worktree',
        deliveryMode: 'append',
        task: {
          taskId: created.taskId,
          assignmentId: created.assignmentId,
          executionPool: 'primary',
        },
      }, testDeps)).resolves.toMatchObject({ status: 'accepted' });
      expect(ensureWorktree).toHaveBeenCalledTimes(1);
    } finally {
      if (previousRoot === undefined) delete process.env.IMCODES_WORKTREES_ROOT;
      else process.env.IMCODES_WORKTREES_ROOT = previousRoot;
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each([
    ['blocked', 'blocked', false],
    ['FINISHED with reply:true', 'ready_for_audit', true],
  ] as const)('keeps blocked fail-closed but reuses the exact historical implementer after %s', async (_label, terminalStatus, explicitReply) => {
    const config = executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    const brain = supervisedBrain([config]);
    const worker = supervisedChild({
      name: `deck_alpha_terminal_${terminalStatus}`, role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const sessions = [brain, worker];
    const registry = getSupervisionTaskRegistry();
    const dispatched = vi.fn(async () => {});
    const created = await dispatchSendMessage(caller, {
      target: worker.name, message: 'create one implementation assignment',
      task: {
        classification: 'independent_top_level', objective: 'terminal continuation boundary',
        executionPool: 'primary', ownedFiles: ['src/terminal.ts'],
      },
    }, deps(sessions, dispatched));
    if (created.status !== 'accepted' || !created.taskId || !created.assignmentId) throw new Error('expected task');
    const initialDelegationId = created.deliveries[0]?.delegationId;
    const assignment = registry.getAssignment(created.assignmentId)!;
    if (terminalStatus === 'blocked') {
      expect(registry.updateAssignment({
        assignmentId: assignment.assignmentId, identity: assignment.identity, status: 'blocked', blocker: 'human input required',
      }).ok).toBe(true);
    } else {
      for (const status of ['implementing', 'validated'] as const) {
        expect(registry.updateAssignment({
          assignmentId: assignment.assignmentId, identity: assignment.identity, status,
        }).ok).toBe(true);
        expect(registry.updateTask({ taskId: created.taskId, status }).ok).toBe(true);
      }
      expect(registry.applyTaskIntent({
        taskId: created.taskId, assignmentId: assignment.assignmentId,
        intent: 'open_audit', toStatus: 'ready_for_audit',
      })).toMatchObject({ ok: true });
      expect(registry.listEvents(created.taskId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          assignmentId: assignment.assignmentId, eventType: 'implementation_finished',
          payload: expect.objectContaining({ implementationHandoff: 'FINISHED' }),
        }),
      ]));
    }

    const taskCount = registry.list().length;
    const assignmentCount = registry.get(created.taskId)!.assignments.length;
    const createTask = vi.spyOn(registry, 'createOrGet');
    const createAssignment = vi.spyOn(registry, 'createAssignment');
    const createReplyAuthority = vi.spyOn(getDelegationReplyStore(), 'create');
    dispatched.mockClear();
    const result = await dispatchSendMessage(caller, {
      target: worker.name, message: 'append without replacing the historical implementer', deliveryMode: 'append',
      reply: explicitReply,
      task: { taskId: created.taskId, executionPool: 'primary' },
    }, deps(sessions, dispatched));
    if (terminalStatus === 'blocked') {
      expect(result).toMatchObject({
        status: 'error', reason: 'identity_rejected',
        error: expect.stringContaining('no unique reusable implementer assignment'),
      });
      expect(dispatched).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({
        status: 'accepted', taskId: created.taskId, assignmentId: created.assignmentId,
        deliveries: [expect.objectContaining({ target: worker.name, status: 'delivered' })],
      });
      expect(dispatched).toHaveBeenCalledWith(worker, expect.any(String), expect.objectContaining({
        deliveryMode: 'append',
      }));
      if (result.status !== 'accepted') throw new Error('expected accepted continuation');
      if (explicitReply) {
        expect(result.deliveries[0]).toMatchObject({ delegationId: initialDelegationId });
      } else {
        expect(result.deliveries[0]).not.toHaveProperty('delegationId');
      }
      expect(registry.getAssignment(created.assignmentId)).toMatchObject({
        assignmentId: created.assignmentId, status: 'ready_for_audit',
      });
    }
    expect(createTask).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
    expect(createReplyAuthority).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(taskCount);
    expect(registry.get(created.taskId)!.assignments).toHaveLength(assignmentCount);
  });

  it('reuses one explicit active replacement beside cancelled history, but rejects ambiguous active implementers', async () => {
    const config = executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    const brain = supervisedBrain([config]);
    const worker = supervisedChild({
      name: 'deck_alpha_replacement_worker', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const sessions = [brain, worker];
    const dispatched = vi.fn(async () => 'queued' as const);
    const created = await dispatchSendMessage(caller, {
      target: worker.name, message: 'initial assignment',
      task: { classification: 'independent_top_level', objective: 'replacement', executionPool: 'primary' },
    }, deps(sessions, dispatched));
    if (created.status !== 'accepted' || !created.taskId || !created.assignmentId) throw new Error('expected task');
    const registry = getSupervisionTaskRegistry();
    const original = registry.getAssignment(created.assignmentId)!;
    expect(registry.applyTaskIntent({
      taskId: created.taskId, assignmentId: original.assignmentId, intent: 'cancel', toStatus: 'cancelled',
    })).toMatchObject({ ok: true });
    const replacement = registry.createAssignment({
      taskId: created.taskId, role: 'implementer', identity: original.identity, scopeFiles: original.scopeFiles,
    });
    if (!replacement.ok) throw new Error(replacement.reason);

    dispatched.mockClear();
    const appended = await dispatchSendMessage(caller, {
      target: worker.name, message: 'append to explicit replacement', deliveryMode: 'append',
      task: { taskId: created.taskId, executionPool: 'primary' },
    }, deps(sessions, dispatched));
    expect(appended).toMatchObject({
      status: 'accepted', taskId: created.taskId, assignmentId: replacement.value.assignmentId,
    });
    expect(registry.get(created.taskId)!.assignments.filter((item) => item.role === 'implementer')).toHaveLength(2);

    const ambiguous = registry.createAssignment({
      taskId: created.taskId, role: 'implementer',
      identity: { ...original.identity, sessionName: 'deck_alpha_other_active_worker' },
      scopeFiles: original.scopeFiles,
    });
    if (!ambiguous.ok) throw new Error(ambiguous.reason);
    const beforeCount = registry.get(created.taskId)!.assignments.length;
    dispatched.mockClear();
    const rejected = await dispatchSendMessage(caller, {
      target: worker.name, message: 'must not choose among active implementers', deliveryMode: 'append',
      task: { taskId: created.taskId, executionPool: 'primary' },
    }, deps(sessions, dispatched));
    expect(rejected).toMatchObject({
      status: 'error', reason: 'identity_rejected',
      error: expect.stringContaining('no unique reusable implementer assignment'),
    });
    expect(registry.get(created.taskId)!.assignments).toHaveLength(beforeCount);
    expect(dispatched).not.toHaveBeenCalled();
  });

  // R4 blocking P1, at the PUBLIC send_message boundary (not hook /send).
  // send-tool.ts resolved every non-audit assignmentId ONLY from reusable
  // implementers and rejected before the OWNER_CONTINUATION_ROLES logic could
  // run, so an exact coordinator or integration_owner continuation was
  // unreachable through the public tool even though the hook layer allowed it.
  for (const role of ['coordinator', 'integration_owner'] as const) {
    it(`continues an exact ${role} assignment through the public send_message boundary`, async () => {
      const config = executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
      const brain = supervisedBrain([config]);
      const worker = supervisedChild({
        name: `deck_alpha_${role}_worker`, role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
      });
      const sessions = [brain, worker];
      const dispatched = vi.fn(async () => 'queued' as const);
      const created = await dispatchSendMessage(caller, {
        target: worker.name, message: 'initial assignment',
        task: { classification: 'independent_top_level', objective: `${role} continuation`, executionPool: 'primary' },
      }, deps(sessions, dispatched));
      if (created.status !== 'accepted' || !created.taskId || !created.assignmentId) throw new Error('expected task');
      const registry = getSupervisionTaskRegistry();
      const implementer = registry.getAssignment(created.assignmentId)!;
      const owner = registry.createAssignment({
        taskId: created.taskId, role, identity: implementer.identity, scopeFiles: [],
      });
      if (!owner.ok) throw new Error(owner.reason);

      dispatched.mockClear();
      const continued = await dispatchSendMessage(caller, {
        target: worker.name, message: `continue the exact ${role}`, deliveryMode: 'append',
        task: { taskId: created.taskId, assignmentId: owner.value.assignmentId, executionPool: 'primary' },
      }, deps(sessions, dispatched));
      expect(continued).toMatchObject({
        status: 'accepted', taskId: created.taskId, assignmentId: owner.value.assignmentId,
      });
      expect(dispatched).toHaveBeenCalled();
    });
  }

  it('fails closed for a terminal exact non-implementer continuation at the public boundary', async () => {
    const config = executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    const brain = supervisedBrain([config]);
    const worker = supervisedChild({
      name: 'deck_alpha_terminal_owner_worker', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const sessions = [brain, worker];
    const dispatched = vi.fn(async () => 'queued' as const);
    const created = await dispatchSendMessage(caller, {
      target: worker.name, message: 'initial assignment',
      task: { classification: 'independent_top_level', objective: 'terminal owner', executionPool: 'primary' },
    }, deps(sessions, dispatched));
    if (created.status !== 'accepted' || !created.taskId || !created.assignmentId) throw new Error('expected task');
    const registry = getSupervisionTaskRegistry();
    const implementer = registry.getAssignment(created.assignmentId)!;
    const owner = registry.createAssignment({
      taskId: created.taskId, role: 'integration_owner', identity: implementer.identity, scopeFiles: [],
    });
    if (!owner.ok) throw new Error(owner.reason);
    expect(registry.applyTaskIntent({
      taskId: created.taskId, assignmentId: owner.value.assignmentId, intent: 'cancel', toStatus: 'cancelled',
    })).toMatchObject({ ok: true });

    dispatched.mockClear();
    const rejected = await dispatchSendMessage(caller, {
      target: worker.name, message: 'must not resurrect a cancelled owner', deliveryMode: 'append',
      task: { taskId: created.taskId, assignmentId: owner.value.assignmentId, executionPool: 'primary' },
    }, deps(sessions, dispatched));
    expect(rejected).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(dispatched).not.toHaveBeenCalled();
  });

  it('rejects queue for an existing task continuation before side effects while allowing queued independent work', async () => {
    const config = executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    const brain = supervisedBrain([config]);
    const worker = supervisedChild({
      name: 'deck_alpha_queue_boundary', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const sessions = [brain, worker];
    const dispatchMessage = vi.fn(async () => 'queued' as const);
    const created = await dispatchSendMessage(caller, {
      target: worker.name, message: 'independent work', deliveryMode: 'queue',
      idempotencyKey: 'independent-queue-work',
      task: { classification: 'independent_top_level', objective: 'independent', executionPool: 'primary' },
    }, deps(sessions, dispatchMessage));
    expect(created).toMatchObject({ status: 'accepted', taskId: expect.any(String) });
    if (created.status !== 'accepted' || !created.taskId) throw new Error('expected independent task');

    const registry = getSupervisionTaskRegistry();
    const beforeTasks = registry.list().length;
    const beforeAssignments = registry.get(created.taskId)!.assignments.length;
    dispatchMessage.mockClear();
    const rejected = await dispatchSendMessage(caller, {
      target: worker.name, message: 'must remain same task', deliveryMode: 'queue',
      task: { taskId: created.taskId, executionPool: 'primary' },
    }, deps(sessions, dispatchMessage));
    expect(rejected).toMatchObject({
      status: 'error', reason: 'validation_failed', error: expect.stringContaining('must use deliveryMode=append'),
    });
    expect(registry.list()).toHaveLength(beforeTasks);
    expect(registry.get(created.taskId)!.assignments).toHaveLength(beforeAssignments);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('rejects an ordinary supervised task target outside the caller primary pool', async () => {
    const brain = supervisedBrain([
      executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol'),
    ]);
    const outsideWorker = supervisedChild({
      name: 'deck_alpha_cc_worker',
      role: 'w1',
      agentType: 'claude-code-sdk',
      model: 'opus[1M]',
    });
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(caller, {
      target: outsideWorker.name,
      message: 'implement the task',
      task: {
        objective: 'implement the task',
        executionPool: 'primary',
        ownedFiles: ['src/owned.ts'],
      },
    }, deps([brain, outsideWorker], dispatchMessage));

    expect(result).toMatchObject({
      status: 'error',
      reason: 'identity_rejected',
      error: expect.stringContaining('task execution pool rejected target: unselected_config'),
    });
    expect(getSupervisionTaskRegistry().list()).toEqual([]);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('lets only the authoritative same-project Brain continue an auto-provisioned task by returned taskId', async () => {
    const selectedConfig = executionConfigFor('codex-sdk', 'gpt-5.6-sol');
    const brain = supervisedBrain([selectedConfig]);
    const worker = supervisedChild({
      name: 'deck_alpha_worker', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const unassignedParticipant = supervisedChild({
      name: 'deck_alpha_peer', role: 'w2', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    unassignedParticipant.transportConfig = brain.transportConfig;
    const sessions = [brain, worker, unassignedParticipant];
    const dispatchMessage = vi.fn(async () => {});
    const provisionSupervisionTarget = vi.fn(async () => ({
      ok: true as const,
      target: worker,
      evidence: { selectedPool: 'primary' as const, selectedConfig },
    }));

    const created = await dispatchSendMessage(caller, {
      message: 'start provisioned work',
      idempotencyKey: 'provisioned-work-visibility-1',
      task: { objective: 'provisioned work', autoProvision: true, executionPool: 'primary' },
    }, { ...deps(sessions, dispatchMessage), provisionSupervisionTarget });
    if (created.status !== 'accepted') throw new Error(`auto-provision failed: ${JSON.stringify(created)}`);
    expect(created).toMatchObject({ status: 'accepted', taskId: expect.any(String) });
    if (!created.taskId) throw new Error('expected auto-provisioned task');
    expect(provisionSupervisionTarget).toHaveBeenCalledTimes(1);

    const registry = getSupervisionTaskRegistry();
    expect(registry.get(created.taskId)?.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'coordinator',
        required: false,
        identity: expect.objectContaining({ sessionName: brain.name }),
      }),
    ]));

    const continued = await dispatchSendMessage(caller, {
      target: worker.name,
      message: 'continue the same task',
      task: { taskId: created.taskId, objective: 'provisioned work', executionPool: 'primary' },
    }, deps(sessions, dispatchMessage));
    expect(continued).toMatchObject({ status: 'accepted', taskId: created.taskId });

    const assignmentCount = registry.get(created.taskId)?.assignments.length;
    const participantCaller = {
      ...caller,
      sessionName: unassignedParticipant.name,
    };
    await expect(dispatchSendMessage(participantCaller, {
      target: worker.name,
      message: 'participant must not adopt the task',
      task: { taskId: created.taskId, objective: 'provisioned work', executionPool: 'primary' },
    }, deps(sessions, dispatchMessage))).resolves.toMatchObject({
      status: 'error', reason: 'identity_rejected', error: 'task is not visible to this caller',
    });

    const betaBrain = {
      ...supervisedBrain([selectedConfig]),
      name: 'deck_beta_brain', projectName: 'beta', projectDir: '/work/beta',
    } as SessionRecord;
    const betaWorker = {
      ...supervisedChild({ name: 'deck_beta_worker', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol' }),
      projectName: 'beta', projectDir: '/work/beta', parentSession: betaBrain.name,
    } as SessionRecord;
    await expect(dispatchSendMessage({
      userId: caller.userId,
      sessionName: betaBrain.name,
      projectName: 'beta',
      projectRoot: '/work/beta',
    }, {
      target: betaWorker.name,
      message: 'cross-project Brain must not adopt the task',
      task: { taskId: created.taskId, objective: 'provisioned work', executionPool: 'primary' },
    }, deps([betaBrain, betaWorker], dispatchMessage))).resolves.toMatchObject({
      status: 'error', reason: 'identity_rejected', error: 'task is not visible to this caller',
    });
    expect(registry.get(created.taskId)?.assignments).toHaveLength(assignmentCount ?? 0);
  });

  it('does not let a same-project Brain adopt another coordinator task by opaque id', async () => {
    const selectedConfig = executionConfigFor('codex-sdk', 'gpt-5.6-sol');
    const brain = supervisedBrain([selectedConfig]);
    const worker = supervisedChild({
      name: 'deck_alpha_worker', role: 'w1', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const otherCoordinator = supervisedChild({
      name: 'deck_alpha_other', role: 'w2', agentType: 'codex-sdk', model: 'gpt-5.6-sol',
    });
    const registry = getSupervisionTaskRegistry();
    const task = registry.createOrGet({
      projectName: 'alpha', taskId: 'other-owner-task', objective: 'private task',
    });
    expect(task.ok).toBe(true);
    expect(registry.createAssignment({
      taskId: 'other-owner-task',
      role: 'coordinator',
      identity: {
        sessionName: otherCoordinator.name,
        sessionInstanceId: otherCoordinator.sessionInstanceId!,
        runtimeEpoch: otherCoordinator.runtimeEpoch!,
        agentType: otherCoordinator.agentType,
        providerFamily: 'openai',
      },
      scopeFiles: [],
      required: false,
    }).ok).toBe(true);

    const createAssignment = vi.spyOn(registry, 'createAssignment');
    const createReplyAuthority = vi.spyOn(getDelegationReplyStore(), 'create');
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(caller, {
      target: worker.name,
      message: 'must not adopt another owner task',
      reply: true,
      task: { taskId: 'other-owner-task', objective: 'private task', executionPool: 'primary' },
    }, deps([brain, worker, otherCoordinator], dispatchMessage));

    expect(result).toEqual({
      status: 'error', reason: 'identity_rejected', error: 'task is not visible to this caller',
    });
    expect(createAssignment).not.toHaveBeenCalled();
    expect(createReplyAuthority).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(registry.get('other-owner-task')?.assignments).toHaveLength(1);
  });

  it('does not apply supervision pool membership to an ordinary exact-target message', async () => {
    const brain = supervisedBrain([
      executionConfig('codex-sdk', 'openai', 'gpt-5.6-sol'),
    ]);
    const outsidePeer = supervisedChild({
      name: 'deck_alpha_cc_discussion',
      role: 'w1',
      agentType: 'claude-code-sdk',
      model: 'opus[1M]',
    });
    const dispatchMessage = vi.fn(async () => {});

    const result = await dispatchSendMessage(caller, {
      target: outsidePeer.name,
      message: 'discuss this without creating supervised work',
    }, deps([brain, outsidePeer], dispatchMessage));

    expect(result).toMatchObject({
      status: 'accepted',
      deliveries: [expect.objectContaining({ target: outsidePeer.name, status: 'delivered' })],
    });
    expect(getSupervisionTaskRegistry().list()).toEqual([]);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses unknown pool-member task availability before registry, reply authority, or dispatch', async () => {
    const brain = supervisedBrain([
      executionConfigFor('codex-sdk', 'gpt-5.6-sol'),
    ]);
    const unknownWorker = supervisedChild({
      name: 'deck_alpha_unknown_worker',
      role: 'w1',
      agentType: 'codex-sdk',
      model: 'gpt-5.6-sol',
    });
    unknownWorker.providerLimit = limit({ agentType: 'codex-sdk', retryAt: NOW - 1 });
    const sessions = [brain, unknownWorker];
    const registry = getSupervisionTaskRegistry();
    const createTask = vi.spyOn(registry, 'createOrGet');
    const createAssignment = vi.spyOn(registry, 'createAssignment');
    const createReplyAuthority = vi.spyOn(getDelegationReplyStore(), 'create');
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(caller, {
      target: unknownWorker.name,
      message: 'implement new work',
      task: { objective: 'new work', executionPool: 'primary' },
    }, {
      ...deps(sessions, dispatchMessage),
      now: () => NOW + 24 * 60 * 60_000,
    });

    expect(result).toMatchObject({
      status: 'error',
      reason: 'target_unavailable',
      error: 'task target availability is unknown',
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(createAssignment).not.toHaveBeenCalled();
    expect(createReplyAuthority).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('refuses a send to a limited target instead of queueing it', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w1', message: 'do the thing' },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
      ], dispatchMessage),
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.reason).toBe(DELEGATION_TARGET_LIMITED);
    // Fail CLOSED. A queued message looks accepted and then sits unread, so the
    // orchestrator waits on a turn that will never start.
    expect(dispatchMessage).not.toHaveBeenCalled();
    // `reason` is the machine ADMISSION reason the caller branches on;
    // `limitReason` is the provider verdict behind it. Two fields because a
    // caller re-routing needs the first and an operator diagnosing needs the
    // second.
    expect(result.limited?.targets[0]).toMatchObject({
      target: 'deck_alpha_w1',
      reason: DELEGATION_TARGET_LIMITED,
      limitReason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
    });
  });

  it('refuses a SIBLING that never met the provider itself', async () => {
    // The limit belongs to the account, not the session that happened to hit
    // it. Routing to an untouched sibling on the same account is the exact
    // retry-into-a-wall this feature exists to stop.
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w2', message: 'do the thing' },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
        session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
      ], dispatchMessage),
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.reason).toBe(DELEGATION_TARGET_LIMITED);
    expect(result.limited?.targets[0]?.limitReason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('offers alternatives only from a DIFFERENT provider family', async () => {
    const result = await dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w1', message: 'do the thing' },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
        session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
        session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
      ]),
    );

    if (result.status !== 'error') throw new Error('expected a refusal');
    const alternatives = result.limited?.alternatives.map((a) => a.target) ?? [];
    // w3 is a different account. w2 shares the refused one, so offering it
    // would just be the same wall with another name.
    expect(alternatives).toContain('deck_alpha_w3');
    expect(alternatives).not.toContain('deck_alpha_w2');
  });

  it('does not offer a second limited family as the escape from the first', async () => {
    const result = await dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w1', message: 'do the thing' },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
        session({
          name: 'deck_alpha_w3',
          projectName: 'alpha',
          role: 'w3',
          agentType: 'claude-code',
          providerLimit: limit({ agentType: 'claude-code' }),
        }),
        session({ name: 'deck_alpha_w4', projectName: 'alpha', role: 'w4', agentType: 'gemini' }),
      ]),
    );

    if (result.status !== 'error') throw new Error('expected a refusal');
    const alternatives = result.limited?.alternatives.map((a) => a.target) ?? [];
    expect(alternatives).toEqual(['deck_alpha_w4']);
  });

  it('still delivers to healthy recipients on a broadcast, and reports the limited ones', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(
      caller,
      { message: 'all hands', broadcast: true },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
        session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
      ], dispatchMessage),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('unreachable');
    // Reported, never silently dropped: a caller reading "accepted" must not
    // believe every sibling received it.
    expect(result.deliveries).toContainEqual(expect.objectContaining({
      target: 'deck_alpha_w1',
      status: 'failed',
      error: expect.stringContaining(DELEGATION_TARGET_LIMITED),
    }));
    expect(result.deliveries).toContainEqual(expect.objectContaining({
      target: 'deck_alpha_w3',
      status: 'delivered',
    }));
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('marks the whole family limited in send_list_targets', () => {
    const listed = listSendTargets(caller, {}, deps([
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit({ retryAt: NOW + 60_000 }) }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ]));

    const byName = new Map(listed.items.map((item) => [item.sessionName, item]));
    expect(byName.get('deck_alpha_w1')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    // Effective deadline: the bounded fallback floors a shorter provider reset,
    // so a caller that waits until this instant is not refused a second time.
    expect(byName.get('deck_alpha_w1')?.retryAt).toBe(NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS);
    expect(byName.get('deck_alpha_w2')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    expect(byName.get('deck_alpha_w2')?.limitReason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);
    // A different account is untouched.
    expect(byName.get('deck_alpha_w3')?.availability).toBe(DELEGATION_AVAILABILITY.READY);
    expect(byName.get('deck_alpha_w3')?.limitGroup)
      .not.toBe(byName.get('deck_alpha_w1')?.limitGroup);
  });

  it('does not let a query filter hide the sibling holding the evidence', () => {
    // Resolution runs over every session BEFORE the filter. Resolving after it
    // would report the family healthy exactly when the caller narrowed its
    // search -- the case where it is least likely to be double-checked.
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
    ];
    const listed = listSendTargets(caller, { query: 'w2' }, deps(sessions));

    expect(listed.items.map((i) => i.sessionName)).toEqual(['deck_alpha_w2']);
    expect(listed.items[0]?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
  });

  it('uses ONE decision source, so the list never offers what the send refuses', async () => {
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ];
    const listed = listSendTargets(caller, {}, deps(sessions));

    // Guard against a VACUOUS pass. An empty list makes the loop below assert
    // nothing while reporting green -- and an earlier run of this suite did
    // exactly that, because the fixtures were undiscoverable.
    expect(listed.items.length).toBe(3);
    expect(listed.items.some((i) => i.availability === DELEGATION_AVAILABILITY.LIMITED)).toBe(true);
    expect(listed.items.some((i) => i.availability === DELEGATION_AVAILABILITY.READY)).toBe(true);

    for (const item of listed.items) {
      const sent = await dispatchSendMessage(
        caller,
        { target: item.sessionName, message: 'probe' },
        deps(sessions),
      );
      const listSaysLimited = item.availability === DELEGATION_AVAILABILITY.LIMITED;
      const sendSaysLimited = sent.status === 'error' && sent.reason === DELEGATION_TARGET_LIMITED;
      expect(sendSaysLimited, `${item.sessionName}: list and send disagree`).toBe(listSaysLimited);
    }
  });

  it('reopens the target once the limit expires, as unknown rather than ready', async () => {
    // `limited` is not terminal. An expired window proves the WAIT is over, not
    // that the quota came back, so the target is re-probed instead of trusted.
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit({ retryAt: NOW - 1 }) }),
    ];
    const expired = {
      now: () => NOW + 24 * 60 * 60_000,
      listSessions: () => sessions,
      dispatchMessage: vi.fn(async () => {}),
    };

    const listed = listSendTargets(caller, {}, expired);
    expect(listed.items[0]?.availability).toBe(DELEGATION_AVAILABILITY.UNKNOWN);

    const sent = await dispatchSendMessage(caller, { target: 'deck_alpha_w1', message: 'probe' }, expired);
    expect(sent.status).toBe('accepted');
    expect(expired.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('never lists or targets a STOPPED session', async () => {
    // Discovered by mutation: deleting the `state !== 'stopped'` clause from
    // the authorized-candidate resolver broke no test at all. It is invisible
    // in the alternatives path (availability already drops offline candidates),
    // so the only place it is load-bearing is target resolution -- which
    // nothing was checking. A stopped session would have become a listable,
    // sendable target whose message goes nowhere.
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', state: 'stopped' }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
    ];
    const dispatchMessage = vi.fn(async () => {});

    const listed = listSendTargets(caller, {}, deps(sessions, dispatchMessage));
    expect(listed.items.map((i) => i.sessionName)).toEqual(['deck_alpha_w2']);

    const sent = await dispatchSendMessage(
      caller, { target: 'deck_alpha_w1', message: 'x' }, deps(sessions, dispatchMessage),
    );
    expect(sent.status).toBe('error');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('leaves an ordinary provider error alone', async () => {
    // Only a canonical limit signal may gate a send. A session in `error` is
    // unhealthy for its own reasons and must not be reported as rate limited,
    // or every crash would look like an exhausted account.
    const listed = listSendTargets(caller, {}, deps([
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', state: 'error' }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
    ]));

    const byName = new Map(listed.items.map((item) => [item.sessionName, item]));
    expect(byName.get('deck_alpha_w1')?.availability).toBe(DELEGATION_AVAILABILITY.OFFLINE);
    expect(byName.get('deck_alpha_w1')?.limitReason).toBeUndefined();
    // And it does not contaminate its family.
    expect(byName.get('deck_alpha_w2')?.availability).toBe(DELEGATION_AVAILABILITY.READY);
  });
});

/**
 * Every entry point that creates new work runs the SAME gate.
 *
 * `send_message` was gated first and the others were not, which meant the
 * refusal could be walked around three ways: a `/send` hook passes its target
 * records in directly, a cron tick fires on a schedule nobody watches, and a
 * clone spawns a fresh worker that inherits the template's exhausted account.
 * A gate with three bypasses is not a gate.
 */
describe('delegation gate covers every work-creating entry point', () => {
  beforeEach(() => {
    clearSendIdempotencyCacheForTests();
  });

  it('hook /send refuses a limited target and still delivers to the rest', async () => {
    const dispatchMessage = vi.fn(async () => 'delivered' as const);
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ];
    const result = await dispatchHookSend(
      {
        from: 'deck_alpha_brain',
        targetRecords: [sessions[1]!, sessions[2]!],
        message: 'hello',
      },
      { now: () => NOW, listSessions: () => sessions, getSession: (n) => sessions.find((s) => s.name === n), dispatchMessage },
    );

    expect(result.errors.join(' ')).toContain(DELEGATION_TARGET_LIMITED);
    // Named alternative, not just a refusal: a caller told only "no" retries.
    expect(result.errors.join(' ')).toContain('deck_alpha_w3');
    expect(result.delivered).toEqual(['deck_alpha_w3']);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('hook /send is unchanged when nothing is limited', async () => {
    const dispatchMessage = vi.fn(async () => 'delivered' as const);
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2', state: 'running' }),
    ];
    const result = await dispatchHookSend(
      { from: 'deck_alpha_brain', targetRecords: [sessions[1]!, sessions[2]!], message: 'hello' },
      { now: () => NOW, listSessions: () => sessions, getSession: (n) => sessions.find((s) => s.name === n), dispatchMessage },
    );

    // ready AND busy both still dispatch. `busy` is "ask later", not "refused".
    expect(result.errors).toEqual([]);
    expect(result.delivered).toEqual(['deck_alpha_w1', 'deck_alpha_w2']);
    expect(dispatchMessage).toHaveBeenCalledTimes(2);
  });

  it('cron raises a TYPED limited refusal rather than a bare error', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit({ retryAt: NOW + 60_000 }) }),
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ];
    const cronDeps = {
      now: () => NOW,
      listSessions: () => sessions,
      getSession: (n: string) => sessions.find((s) => s.name === n),
      dispatchMessage,
    };

    await expect(dispatchCronSend(
      { fromSessionName: 'deck_alpha_brain', target: 'deck_alpha_w1', message: 'tick' },
      cronDeps,
    )).rejects.toBeInstanceOf(CronSendTargetLimitedError);

    // The scheduler must be able to read WHEN, not parse a sentence.
    const raised = await dispatchCronSend(
      { fromSessionName: 'deck_alpha_brain', target: 'deck_alpha_w1', message: 'tick' },
      cronDeps,
    ).catch((err: unknown) => err as CronSendTargetLimitedError);
    expect(raised.reason).toBe(DELEGATION_TARGET_LIMITED);
    expect(raised.limited?.targets[0]?.retryAt).toBe(NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS);
    expect(raised.limited?.alternatives.map((a) => a.target)).toContain('deck_alpha_w3');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('cron still dispatches normally to a healthy target', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' }),
    ];
    const result = await dispatchCronSend(
      { fromSessionName: 'deck_alpha_brain', target: 'deck_alpha_w1', message: 'tick' },
      { now: () => NOW, listSessions: () => sessions, getSession: (n) => sessions.find((s) => s.name === n), dispatchMessage },
    );
    expect(result.status).toBe('dispatched');
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('never creates a clone whose template family is already limited', async () => {
    const createExecutionClone = vi.fn();
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
    ];
    const result = await dispatchSendMessage(
      caller,
      {
        target: 'deck_alpha_w1',
        message: 'do work',
        clone: { kind: 'execution_clone', ephemeral: true, parentRunId: 'run-1', parentStage: 'generic_execution' },
      },
      { now: () => NOW, listSessions: () => sessions, dispatchMessage: vi.fn(async () => {}), createExecutionClone },
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.reason).toBe(DELEGATION_TARGET_LIMITED);
    // The point of gating BEFORE create: an ephemeral clone with a hard timeout
    // would otherwise spend its entire lifetime waiting on a quota that was
    // already exhausted, then be reaped as if it had merely been slow.
    expect(createExecutionClone).not.toHaveBeenCalled();
  });

  it('keeps send_stop working against a limited target', async () => {
    // Control plane, not delegation. Stopping a session that is stuck behind a
    // provider limit is exactly when an operator most needs the button to work.
    const cancelSession = vi.fn(async () => true);
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit(), state: 'running' }),
    ];
    const result = await dispatchSendStop(
      caller,
      { target: 'deck_alpha_w1' },
      { now: () => NOW, listSessions: () => sessions, cancelSession },
    );

    expect(result.status).toBe('accepted');
    expect(cancelSession).toHaveBeenCalledTimes(1);
  });

  it('widens the refusal for spawned work without changing ordinary sends', async () => {
    // An unhealthy session can still be MESSAGED -- that is often how it gets
    // woken. But a scheduler firing into one just grows a backlog nobody is
    // draining, so the work-creating paths refuse where an ordinary send does not.
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', state: 'error' }),
    ];
    const shared = {
      now: () => NOW,
      listSessions: () => sessions,
      getSession: (n: string) => sessions.find((s) => s.name === n),
      dispatchMessage: vi.fn(async () => {}),
    };

    const ordinary = await dispatchSendMessage(caller, { target: 'deck_alpha_w1', message: 'wake up' }, shared);
    expect(ordinary.status).toBe('accepted');

    await expect(dispatchCronSend(
      { fromSessionName: 'deck_alpha_brain', target: 'deck_alpha_w1', message: 'tick' },
      shared,
    )).rejects.toBeInstanceOf(CronSendTargetLimitedError);
  });
});
