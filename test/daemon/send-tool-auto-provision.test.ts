import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';
import { clearSendIdempotencyCacheForTests, dispatchSendMessage } from '../../src/daemon/send-tool.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import { resolveForcedProvisionConfig } from '../../src/daemon/forced-provision-config.js';
import type { SupervisionAutoProvisionRequest } from '../../src/daemon/supervision-auto-provision.js';
import { SUPERVISION_TRANSPORT_CONFIG_KEY } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId, type SupervisionExecutionConfig } from '../../shared/supervision-execution-pool.js';

function session(overrides: Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role'>): SessionRecord {
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
    ...overrides,
  } as SessionRecord;
}

const caller = { userId: 'user-1', sessionName: 'deck_alpha_brain', projectName: 'alpha', projectRoot: '/work/alpha' };
const anthropicBrain = () => session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain', agentType: 'claude-code-sdk', providerId: 'anthropic', runtimeType: 'transport', activeModel: 'opus' });
const openaiBrain = () => session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain', agentType: 'codex-sdk', providerId: 'openai', runtimeType: 'transport', activeModel: 'gpt-6-sol' });

function poolConfig(agentType: string, providerFamily: string, model: string): SupervisionExecutionConfig {
  const value = { agentType, providerFamily, runtimeType: 'transport' as const, model };
  return { ...value, capabilityId: buildSupervisionExecutionCapabilityId(value) };
}

function brainWithPool(base: SessionRecord, configs: SupervisionExecutionConfig[]): SessionRecord {
  const controls = { maxConcurrency: 4, maxSpawned: 2, leaseMs: 1_800_000, changeBudget: 200, auditHeadroomPerProviderFamily: 1 };
  return {
    ...base,
    transportConfig: {
      [SUPERVISION_TRANSPORT_CONFIG_KEY]: {
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: { configs, controls },
          economyTaskPool: { configs, controls },
        },
      },
    },
  } as SessionRecord;
}

/** A provisioner double that records the request it was given and "creates" a session named after the key. */
function recorder(brain: SessionRecord, live: SessionRecord[]) {
  const requests: SupervisionAutoProvisionRequest[] = [];
  const provisionSupervisionTarget = vi.fn(async (request: SupervisionAutoProvisionRequest) => {
    requests.push(request);
    const target = session({
      name: `deck_sub_send_auto_${request.idempotencyKey}`, projectName: 'alpha', role: 'w1', parentSession: brain.name,
      agentType: request.requestedExecutionConfig?.agentType ?? 'codex-sdk', runtimeType: 'transport',
      activeModel: request.requestedExecutionConfig?.model, providerId: request.requestedExecutionConfig?.agentType,
    });
    live.push(target);
    return {
      ok: true as const,
      target,
      evidence: {
        selectedPool: request.pool, selectedConfig: request.requestedExecutionConfig, origin: 'spawned' as const, createdSessionName: target.name,
      },
    };
  });
  return { requests, provisionSupervisionTarget };
}

async function send(brain: SessionRecord, live: SessionRecord[], task: Record<string, unknown>, extra: Record<string, unknown> = {}, key = 'key-1') {
  const { requests, provisionSupervisionTarget } = recorder(brain, live);
  const result = await dispatchSendMessage(caller, {
    message: 'start a worker', idempotencyKey: key, task: { autoProvision: true, ...task }, ...extra,
  } as never, {
    listSessions: () => [brain, ...live],
    provisionSupervisionTarget,
    ensureSupervisionAssignmentWorktree: vi.fn(async (worktree: { projectRoot: string; assignmentId: string }) => ({
      ok: true as const,
      worktreePath: `${worktree.projectRoot}/.imcodes-worktrees/${worktree.assignmentId}`,
      baseRevision: 'a'.repeat(40),
      created: true,
    })),
    dispatchMessage: vi.fn(async () => undefined),
  } as never);
  return { result, requests };
}

describe('send_message task.autoProvision: what gets created', () => {
  beforeEach(() => {
    clearSendIdempotencyCacheForTests();
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  });
  afterEach(() => setTaskPairStoreForTests(undefined));

  it('creates, with no pool and no model named, the Brain\'s own provider family\'s secondary model', async () => {
    const anthropic = await send(anthropicBrain(), [], {});
    expect(anthropic.requests).toHaveLength(1);
    expect(anthropic.requests[0]).toMatchObject({
      forceCreate: true,
      provenance: 'manual_explicit',
      pool: 'primary',
      requestedExecutionConfig: { agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport', model: 'sonnet' },
    });
    expect(anthropic.requests[0]!.requestedCapabilityId).toBe(anthropic.requests[0]!.requestedExecutionConfig!.capabilityId);
    expect(anthropic.result).toMatchObject({ status: 'accepted', provisioning: { origin: 'spawned' } });

    clearSendIdempotencyCacheForTests();
    const openai = await send(openaiBrain(), [], {});
    expect(openai.requests[0]).toMatchObject({ forceCreate: true, requestedExecutionConfig: { providerFamily: 'openai' } });
    expect(openai.requests[0]!.requestedExecutionConfig!.model).toMatch(/sol/u);
  });

  it('uses the first executor entry of a configured pool, whatever family the Brain is', async () => {
    const pooled = poolConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    const { requests } = await send(brainWithPool(anthropicBrain(), [pooled]), [], {});
    expect(requests[0]).toMatchObject({ forceCreate: true, requestedCapabilityId: pooled.capabilityId, requestedExecutionConfig: pooled });
  });

  it('passes an explicitly requested execution type through untouched', async () => {
    const wanted = poolConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    const { requests } = await send(anthropicBrain(), [], { requestedExecutionType: wanted });
    expect(requests[0]).toMatchObject({ forceCreate: true, requestedCapabilityId: wanted.capabilityId, requestedExecutionConfig: wanted });
  });

  it('gives the same configuration for the same input, whatever else happens to be idle', async () => {
    const first = await send(anthropicBrain(), [], {}, {}, 'same-1');
    clearSendIdempotencyCacheForTests();
    const idleNoise = [
      session({ name: 'deck_sub_idle_a', projectName: 'alpha', role: 'w1', parentSession: 'deck_alpha_brain', agentType: 'claude-code-sdk', runtimeType: 'transport', activeModel: 'sonnet' }),
      session({ name: 'deck_sub_idle_b', projectName: 'alpha', role: 'w1', parentSession: 'deck_alpha_brain', agentType: 'codex-sdk', runtimeType: 'transport', activeModel: 'gpt-6-sol' }),
    ];
    const second = await send(anthropicBrain(), idleNoise, {}, {}, 'same-2');
    expect(second.requests[0]!.requestedExecutionConfig).toEqual(first.requests[0]!.requestedExecutionConfig);
    expect(second.requests[0]!.forceCreate).toBe(true);
  });

  it('refuses, naming the fix, when the family has no default model to create', async () => {
    const odd = session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain', agentType: 'gemini', providerId: 'google' });
    const { result, requests } = await send(odd, [], {});
    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('requestedExecutionType') });
  });

  it('leaves the daemon\'s automatic supervision on its own pool rules (no forced creation, no default picked)', async () => {
    const { requests } = await send(anthropicBrain(), [], {}, { automaticSupervision: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('forceCreate');
    expect(requests[0]!.requestedExecutionConfig).toBeUndefined();
    expect(requests[0]!.provenance).toBe('automatic_supervision');
  });
});

describe('resolveForcedProvisionConfig', () => {
  it('reports its source, so the rule is visible', () => {
    expect(resolveForcedProvisionConfig(anthropicBrain(), 'primary')).toMatchObject({ ok: true, source: 'default_same_family_secondary' });
    const pooled = poolConfig('codex-sdk', 'openai', 'gpt-5.6-sol');
    expect(resolveForcedProvisionConfig(brainWithPool(anthropicBrain(), [pooled]), 'primary')).toMatchObject({ ok: true, source: 'configured_pool', config: pooled });
  });
});
