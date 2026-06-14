import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXECUTION_CLONE_ERROR_CODES, EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import type { ExecutionCloneMetadata } from '../../shared/execution-clone.js';

// Transport/runtime deps are mocked so the pure-helper and projection tests run
// without pulling the heavy `buildSessionList` hydration machinery.
vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn(() => undefined),
}));

function baseRecord(over: Partial<SessionRecord>): SessionRecord {
  return {
    name: 'deck_demo_w1',
    projectName: 'demo',
    role: 'w1',
    agentType: 'claude-code',
    projectDir: '/tmp/demo',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function cloneMetadata(): ExecutionCloneMetadata {
  return {
    kind: EXECUTION_CLONE_KIND,
    ephemeral: true,
    cloneOfSessionName: 'deck_demo_w1',
    parentRunId: 'run-1',
    parentStage: 'generic_execution',
    createdBySessionName: 'deck_demo_brain',
    createdAt: 1,
    hardTimeoutAt: 2,
    retentionExpiresAt: null,
    cleanupState: 'active',
    autoDestroy: true,
  };
}

// Representative records: a main/brain, a stopped sub, an execution-clone sub,
// and a normal eligible sub. Only the normal eligible sub is a valid template.
const mainBrain = baseRecord({ name: 'deck_demo_brain', role: 'brain', state: 'running' });
const stoppedSub = baseRecord({ name: 'deck_demo_w2', role: 'w1', state: 'stopped' });
const executionCloneSub = baseRecord({
  name: 'deck_sub_execclone_eligibility',
  role: 'w1',
  state: 'idle',
  executionCloneMetadata: cloneMetadata(),
});
const eligibleSub = baseRecord({ name: 'deck_demo_w3', role: 'w1', state: 'idle' });

describe('computeExecutionTemplateEligibility', () => {
  it('marks a normal non-main, non-stopped, non-clone sub as eligible', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    expect(computeExecutionTemplateEligibility(eligibleSub)).toEqual({ eligible: true });
  });

  it('rejects a main/brain session with template_ineligible', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    expect(computeExecutionTemplateEligibility(mainBrain)).toEqual({
      eligible: false,
      reason: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects a stopped session with template_ineligible', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    expect(computeExecutionTemplateEligibility(stoppedSub)).toEqual({
      eligible: false,
      reason: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects an execution clone with clone_of_clone_forbidden', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    expect(computeExecutionTemplateEligibility(executionCloneSub)).toEqual({
      eligible: false,
      reason: EXECUTION_CLONE_ERROR_CODES.CLONE_OF_CLONE_FORBIDDEN,
    });
  });

  it('rejects a record without a cloneable launch configuration', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    // Missing projectDir → no launchable clone config.
    const noProjectDir = baseRecord({ name: 'deck_demo_w4', projectDir: '' });
    expect(computeExecutionTemplateEligibility(noProjectDir)).toEqual({
      eligible: false,
      reason: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects an error-state session with template_ineligible (matches create-time validation)', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    expect(computeExecutionTemplateEligibility(baseRecord({ name: 'deck_demo_w5', state: 'error' }))).toEqual({
      eligible: false,
      reason: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('rejects an unknown/unsupported agentType with template_ineligible (matches create-time validation)', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    expect(computeExecutionTemplateEligibility(baseRecord({ name: 'deck_demo_w6', agentType: 'totally-not-an-agent' }))).toEqual({
      eligible: false,
      reason: EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE,
    });
  });

  it('agrees with validateExecutionTemplateCandidate for the candidate cases', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    const { validateExecutionTemplateCandidate } = await import('../../src/daemon/execution-clone.js');
    const cases: SessionRecord[] = [
      eligibleSub,
      mainBrain,
      stoppedSub,
      executionCloneSub,
      baseRecord({ name: 'deck_demo_w7', state: 'error' }),
      baseRecord({ name: 'deck_demo_w8', projectDir: '' }),
      baseRecord({ name: 'deck_demo_w9', agentType: 'totally-not-an-agent' }),
    ];
    for (const record of cases) {
      const projection = computeExecutionTemplateEligibility(record);
      const candidate = validateExecutionTemplateCandidate(record);
      // The projection is exactly the candidate predicate (caller-independent).
      expect(projection.eligible).toBe(candidate.ok);
      if (!projection.eligible && !candidate.ok) {
        expect(projection.reason).toBe(candidate.code);
      }
    }
  });

  it('does NOT apply the caller "clone yourself" exclusion (base eligibility is caller-independent)', async () => {
    const { computeExecutionTemplateEligibility } = await import('../../src/daemon/session-list.js');
    // Even when this record would be the caller, base eligibility stays true —
    // the self exclusion is the UI's concern, layered on top.
    expect(computeExecutionTemplateEligibility(eligibleSub)).toEqual({ eligible: true });
  });
});

describe('buildSessionList projects execution template eligibility', () => {
  beforeEach(async () => {
    vi.resetModules();
    const store = await import('../../src/store/session-store.js');
    for (const s of store.listSessions()) store.removeSession(s.name);
  });

  afterEach(async () => {
    const store = await import('../../src/store/session-store.js');
    for (const s of store.listSessions()) store.removeSession(s.name);
  });

  it('exposes executionTemplateEligible + reason per session', async () => {
    const store = await import('../../src/store/session-store.js');
    // deck_sub_* sub-sessions are filtered out of buildSessionList, so the
    // clone-of-clone case is asserted via the pure helper above. Here we cover
    // the main/brain, stopped, and eligible projections that survive the filter.
    store.upsertSession(mainBrain);
    store.upsertSession(stoppedSub);
    store.upsertSession(eligibleSub);

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const sessions = await buildSessionList();
    const byName = new Map(sessions.map((s) => [s.name, s] as const));

    const brain = byName.get('deck_demo_brain');
    expect(brain?.executionTemplateEligible).toBe(false);
    expect(brain?.executionTemplateIneligibleReason).toBe(EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE);

    const stopped = byName.get('deck_demo_w2');
    expect(stopped?.executionTemplateEligible).toBe(false);
    expect(stopped?.executionTemplateIneligibleReason).toBe(EXECUTION_CLONE_ERROR_CODES.TEMPLATE_INELIGIBLE);

    const eligible = byName.get('deck_demo_w3');
    expect(eligible?.executionTemplateEligible).toBe(true);
    expect(eligible?.executionTemplateIneligibleReason).toBeUndefined();
  });
});
