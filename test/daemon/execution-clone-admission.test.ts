/**
 * The P2P worker pool must not spawn clones against a refused provider account.
 *
 * This pool calls `createExecutionClone` DIRECTLY -- it never passes through
 * the send tool, so the provider-limit gate enforced there did not apply to it
 * at all. It is also the busiest producer of delegated work in the daemon, so
 * the one bypass covered more traffic than every gated path combined.
 *
 * Every clone inherits its template's agentType, hence the template's provider
 * account and the template's limit. Spawning one anyway does not merely waste a
 * turn: the clone is ephemeral with a hard timeout, so it spends its entire
 * lifetime waiting on a quota that was already exhausted before it started, and
 * is then reaped as though it had simply been slow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultDedicatedExecutionRoutingPreference,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';
import {
  DELEGATION_LIMIT_REASONS,
  PROVIDER_LIMIT_EVIDENCE_KINDS,
  type DelegationLimitState,
} from '../../shared/delegation-availability.js';
import { DELEGATION_ADMISSION_REASONS } from '../../src/daemon/delegation-admission.js';

const { cloneMocks, FakeExecutionCloneError } = vi.hoisted(() => {
  class FakeExecutionCloneError extends Error {
    constructor(public readonly code: string, message?: string) {
      super(message ?? code);
      this.name = 'ExecutionCloneError';
    }
  }
  return {
    cloneMocks: {
      createExecutionClone: vi.fn(),
      destroyExecutionClone: vi.fn(),
      countActiveExecutionClones: vi.fn(() => 0),
    },
    FakeExecutionCloneError,
  };
});

// Only the SIDE-EFFECTING surface is mocked. `isExecutionClone` is a pure
// predicate that the authorized-candidate resolver depends on, and stubbing it
// would make the "hidden clone is never offered" assertion test the stub rather
// than the rule.
vi.mock('../../src/daemon/execution-clone.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/daemon/execution-clone.js')>()),
  createExecutionClone: cloneMocks.createExecutionClone,
  destroyExecutionClone: cloneMocks.destroyExecutionClone,
  countActiveExecutionClones: cloneMocks.countActiveExecutionClones,
  ExecutionCloneError: FakeExecutionCloneError,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { orchestrateCloneWorkers } from '../../src/daemon/execution-clone-orchestration.js';
import { DelegationAdmissionError } from '../../src/daemon/delegation-admission.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const NOW = 1_700_000_000_000;
const TEMPLATE = 'deck_alpha_w1';
const OWNER = 'deck_alpha_brain';

function session(
  overrides: Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role'>,
): SessionRecord {
  return {
    sessionInstanceId: `instance_${overrides.name}`,
    runtimeEpoch: `epoch_${overrides.name}`,
    agentType: 'claude-code-sdk',
    projectDir: `/work/${overrides.projectName}`,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    userCreated: true,
    ...overrides,
  } as SessionRecord;
}

function storedLimit(overrides: Partial<DelegationLimitState> = {}): DelegationLimitState {
  return {
    limitedAt: NOW,
    reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
    agentType: 'claude-code-sdk',
    evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED,
    ...overrides,
  };
}

function pref(): DedicatedExecutionRoutingGlobalPreference {
  return { ...defaultDedicatedExecutionRoutingPreference(), enabled: true };
}

function run(sessions: SessionRecord[], taskCount = 3) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const collect = vi.fn().mockResolvedValue('ok');
  const promise = orchestrateCloneWorkers({
    parentRunId: 'run-1',
    parentStage: 'team_final_execution',
    templateSessionName: TEMPLATE,
    ownerSessionName: OWNER,
    owningMainSessionName: OWNER,
    pref: pref(),
    tasks: Array.from({ length: taskCount }, (_, i) => ({ id: `t${i}`, prompt: `task ${i}` })),
    dispatch,
    collect,
    now: () => NOW,
    listSessions: () => sessions,
  });
  return { promise, dispatch, collect };
}

describe('execution-clone orchestration delegation admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloneMocks.countActiveExecutionClones.mockReturnValue(0);
    // Must RESOLVE: the pool calls `.catch()` on the destroy result, so a bare
    // `vi.fn()` returning undefined throws inside cleanup and turns a healthy
    // run into a rejection -- which would look exactly like the gate refusing.
    cloneMocks.destroyExecutionClone.mockResolvedValue(undefined);
    let created = 0;
    cloneMocks.createExecutionClone.mockImplementation(async () => {
      const target = `clone-${created++}`;
      return { sessionName: target, target, metadata: {} };
    });
  });

  it('creates ZERO clones and starts ZERO workers when the template is limited', async () => {
    const { promise, dispatch, collect } = run([
      session({ name: TEMPLATE, projectName: 'alpha', role: 'w1', providerLimit: storedLimit() }),
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
    ]);

    await expect(promise).rejects.toBeInstanceOf(DelegationAdmissionError);
    // 0 create / 0 start. Not "created then cleaned up" -- nothing is spawned,
    // so there is no ephemeral worker burning its hard timeout on a dead quota
    // and no destroy path to get wrong.
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
    expect(cloneMocks.destroyExecutionClone).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it('refuses on a SIBLING account limit the template never met itself', async () => {
    // The limit belongs to the account. A template that has not personally been
    // refused yet is still backed by the exhausted quota.
    const { promise } = run([
      session({ name: TEMPLATE, projectName: 'alpha', role: 'w1', agentType: 'claude-code' }),
      session({
        name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2',
        agentType: 'claude-code-sdk', providerLimit: storedLimit(),
      }),
    ]);

    const err = await promise.catch((e: unknown) => e as DelegationAdmissionError);
    expect(err).toBeInstanceOf(DelegationAdmissionError);
    expect(err.reason).toBe(DELEGATION_ADMISSION_REASONS.TARGET_LIMITED);
    expect(err.refusal.targets[0]?.limitReason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });

  it('reports a DOWN template as unavailable, not as a quota limit', async () => {
    const { promise } = run([
      session({ name: TEMPLATE, projectName: 'alpha', role: 'w1', state: 'error' }),
    ]);

    const err = await promise.catch((e: unknown) => e as DelegationAdmissionError);
    // Literal, not the constant: aliasing the two reasons together must not be
    // able to hide behind a symmetric comparison.
    expect(err.reason).toBe('target_unavailable');
    // No invented retry clock for something that is simply broken.
    expect(err.refusal.targets[0]?.retryAt).toBeUndefined();
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });

  it('never offers the owner itself or a hidden execution clone', async () => {
    // The previous version of this test was named for non-clone filtering and
    // contained neither a clone nor the caller, so it asserted nothing about
    // either. With them present the orchestrator's own project-name-only filter
    // returned BOTH -- it told the run to delegate to itself, and exposed an
    // ephemeral internal clone as an addressable target.
    const { promise } = run([
      session({ name: TEMPLATE, projectName: 'alpha', role: 'w1', providerLimit: storedLimit() }),
      session({ name: OWNER, projectName: 'alpha', role: 'brain', agentType: 'gemini' }),
      session({
        name: 'deck_sub_secret',
        projectName: 'alpha',
        role: 'w9',
        agentType: 'gemini',
        executionCloneMetadata: { kind: 'execution_clone' },
      } as Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role'>),
      // A legacy auto-worker with no label and no userCreated flag: deliberately
      // NOT discoverable for inter-agent addressing.
      session({ name: 'deck_alpha_w7', projectName: 'alpha', role: 'w7', agentType: 'gemini', userCreated: false }),
      // Stopped: cannot take work at all.
      session({ name: 'deck_alpha_w8', projectName: 'alpha', role: 'w8', agentType: 'gemini', state: 'stopped' }),
      // Foreign project.
      session({ name: 'deck_beta_w1', projectName: 'beta', role: 'w1', agentType: 'gemini', projectDir: '/work/beta' }),
      // The one legitimate escape route.
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'gemini' }),
    ]);

    const err = await promise.catch((e: unknown) => e as DelegationAdmissionError);
    const offered = err.refusal.alternatives.map((a) => a.target);
    expect(offered).toContain('deck_alpha_w3');
    expect(offered, 'told the run to delegate to itself').not.toContain(OWNER);
    expect(offered, 'exposed a hidden execution clone').not.toContain('deck_sub_secret');
    expect(offered, 'offered a non-discoverable worker').not.toContain('deck_alpha_w7');
    expect(offered, 'offered a stopped session').not.toContain('deck_alpha_w8');
    expect(offered, 'leaked a foreign project').not.toContain('deck_beta_w1');
    // Exactly one survivor, so a broadened filter cannot hide behind a
    // still-present legitimate entry.
    expect(offered).toEqual(['deck_alpha_w3']);
  });

  it('runs normally when the template is healthy', async () => {
    // The gate must not become a blanket stop: a healthy template still spawns
    // its full task set, so a regression here shows up as work not happening.
    const { promise, dispatch } = run([
      session({ name: TEMPLATE, projectName: 'alpha', role: 'w1' }),
    ], 2);

    const result = await promise;
    expect(result.results).toHaveLength(2);
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('runs when a DIFFERENT provider family is limited', async () => {
    // Cross-family contamination would take healthy accounts out of service on
    // someone else's quota, which is worse than not grouping at all.
    const { promise } = run([
      session({ name: TEMPLATE, projectName: 'alpha', role: 'w1', agentType: 'gemini' }),
      session({
        name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2',
        agentType: 'claude-code-sdk', providerLimit: storedLimit(),
      }),
    ], 1);

    await expect(promise).resolves.toMatchObject({ results: [expect.anything()] });
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
  });
});
