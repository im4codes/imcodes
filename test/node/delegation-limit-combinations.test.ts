import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DELEGATION_AVAILABILITY,
  DELEGATION_LIMIT_FALLBACK_TTL_MS,
  DELEGATION_LIMIT_REASONS,
  PROVIDER_LIMIT_EVIDENCE_KINDS,
  PROVIDER_LIMIT_STATES,
  delegationLimitDeadline,
  delegationLimitGroup,
  isDelegationLimitActive,
  resolveDelegationTargets,
  type DelegationLimitState,
  type ProviderLimitSignal,
} from '../../shared/delegation-availability.js';
import {
  DELEGATION_ADMISSION_REASONS,
  buildDelegationRefusal,
  evaluateDelegationAdmission,
} from '../../src/daemon/delegation-admission.js';
import {
  clearSendIdempotencyCacheForTests,
  dispatchSendMessage,
  listSendTargets,
} from '../../src/daemon/send-tool.js';
import {
  mergeProviderLimitSignal,
  resolveProviderLimitUpdate,
  type SessionRecord,
} from '../../src/store/session-store.js';

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
    userCreated: true,
    ...overrides,
  } as SessionRecord;
}

function limitSignal(overrides: Partial<ProviderLimitSignal> = {}): ProviderLimitSignal {
  return {
    providerId: 'claude-code-sdk',
    limitGroup: delegationLimitGroup('claude-code-sdk'),
    state: PROVIDER_LIMIT_STATES.LIMITED,
    observedAt: NOW,
    evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED,
    ...overrides,
  };
}

function storedLimit(overrides: Partial<DelegationLimitState> = {}): DelegationLimitState {
  return {
    limitedAt: NOW,
    reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
    agentType: 'codex',
    evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED,
    ...overrides,
  };
}

/**
 * COMBINATION cases -- the ones no single-unit suite was ever going to catch.
 *
 * Every defect below passed its own layer's tests. They only appear when two
 * correct-looking behaviours meet: a quota field and a limit field on one
 * update, a warning arriving after a rejection, a fallback window crossing an
 * explicit reset, an alternatives list crossing a project boundary. That is
 * exactly the seam a per-function suite cannot see.
 */
describe('provider-limit combinations', () => {
  beforeEach(() => {
    clearSendIdempotencyCacheForTests();
  });

  it('keeps the limit when the SAME update also carries quota telemetry', () => {
    // THE ORIGINAL DATA-LOSS BUG. Claude puts `quotaMeta` and `limitSignal` on
    // one `SessionInfoUpdate`. The wiring snapshotted the record, applied the
    // limit to the store separately, then wrote the snapshot back whole -- so
    // the quota field (which guarantees the record "changed") made the very
    // event that reported a refusal the event that erased it.
    //
    // Reproduced at the merge boundary: a record being prepared for a
    // whole-record write must come out of it still limited.
    const record: SessionRecord = session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' });
    const next: SessionRecord = { ...record, quotaLabel: '92% used' } as SessionRecord;

    const changed = mergeProviderLimitSignal(next, limitSignal(), NOW);

    expect(changed).toBe(true);
    // Both survive the same write. Neither field may cost the other.
    expect(next.quotaLabel).toBe('92% used');
    expect(next.providerLimit).toBeDefined();
    expect(isDelegationLimitActive(next.providerLimit, NOW)).toBe(true);
  });

  it('carries a merged limit through store -> list -> send as one consistent answer', () => {
    // The full combination the audit asked for: apply a real signal to a real
    // record, then ask both consumers about it. A limit that survives the merge
    // but is invisible to `send_list_targets`, or visible there but ignored by
    // `send_message`, is still a broken feature.
    const w1 = session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', agentType: 'claude-code-sdk' });
    mergeProviderLimitSignal(w1, limitSignal({ retryAt: NOW + 3 * 60 * 60_000 }), NOW);

    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      w1,
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2', agentType: 'claude-code' }),
    ];
    const deps = { now: () => NOW, listSessions: () => sessions, dispatchMessage: vi.fn(async () => {}) };

    const listed = listSendTargets(caller, {}, deps);
    const byName = new Map(listed.items.map((i) => [i.sessionName, i]));
    expect(byName.get('deck_alpha_w1')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    // The sibling on the same account inherits it, from evidence it never saw.
    expect(byName.get('deck_alpha_w2')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    expect(byName.get('deck_alpha_w2')?.limitReason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);

    return dispatchSendMessage(caller, { target: 'deck_alpha_w2', message: 'x' }, deps).then((sent) => {
      expect(sent.status).toBe('error');
      if (sent.status !== 'error') throw new Error('unreachable');
      expect(sent.reason).toBe(DELEGATION_ADMISSION_REASONS.TARGET_LIMITED);
      // Same deadline from both surfaces: a caller must not be told two
      // different times to come back.
      expect(sent.limited?.targets[0]?.retryAt).toBe(byName.get('deck_alpha_w2')?.retryAt);
      expect(deps.dispatchMessage).not.toHaveBeenCalled();
    });
  });

  it('a WARNING after a REJECTION leaves the limit standing', () => {
    // Claude emits `allowed_warning` routinely as usage climbs, so if a warning
    // cleared, the first one after a real rejection would put a still-refused
    // account straight back into rotation. Constant, not rare.
    const record: SessionRecord = session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' });
    expect(mergeProviderLimitSignal(record, limitSignal(), NOW)).toBe(true);
    const afterLimit = record.providerLimit;

    const warned = mergeProviderLimitSignal(
      record, limitSignal({ state: PROVIDER_LIMIT_STATES.WARNING, observedAt: NOW + 1_000 }), NOW + 1_000,
    );

    expect(warned, 'a warning must not count as a change').toBe(false);
    expect(record.providerLimit).toBe(afterLimit);
    expect(isDelegationLimitActive(record.providerLimit, NOW + 1_000)).toBe(true);

    // Only an explicit recovery clears it.
    expect(mergeProviderLimitSignal(
      record, limitSignal({ state: PROVIDER_LIMIT_STATES.RECOVERED, observedAt: NOW + 2_000 }), NOW + 2_000,
    )).toBe(true);
    expect(record.providerLimit).toBeUndefined();
  });

  it('an UNKNOWN state neither sets nor clears', () => {
    const record: SessionRecord = session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' });
    expect(resolveProviderLimitUpdate(undefined, limitSignal({ state: PROVIDER_LIMIT_STATES.UNKNOWN }), NOW).changed)
      .toBe(false);
    mergeProviderLimitSignal(record, limitSignal(), NOW);
    expect(mergeProviderLimitSignal(
      record, limitSignal({ state: PROVIDER_LIMIT_STATES.UNKNOWN, observedAt: NOW + 1 }), NOW + 1,
    )).toBe(false);
    expect(record.providerLimit).toBeDefined();
  });

  it('picks the truly later deadline when a short reset crosses the fallback', () => {
    // Two sessions on one account: an early limit whose explicit reset is
    // SHORTER than the bounded fallback, and a later one whose reset is longer.
    // Both the "is it active" check and the group-selection must agree, and
    // both must report the same retryAt -- two functions disagreeing here is
    // how a target gets called limited by one path and usable by another at the
    // very same instant.
    const shortExplicit = storedLimit({ agentType: 'claude-code', limitedAt: NOW, retryAt: NOW + 60_000 });
    const longExplicit = storedLimit({
      agentType: 'claude-code-sdk', limitedAt: NOW, retryAt: NOW + 4 * 60 * 60_000,
    });

    // The fallback FLOORS the short one: a provider advertising a one-minute
    // reset must not be able to erase the back-off.
    expect(delegationLimitDeadline(shortExplicit)).toBe(NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS);
    expect(delegationLimitDeadline(longExplicit)).toBe(NOW + 4 * 60 * 60_000);

    const resolved = resolveDelegationTargets([
      { key: 'short', agentType: 'claude-code', sessionState: 'ready', ownLimit: shortExplicit },
      { key: 'long', agentType: 'claude-code-sdk', sessionState: 'ready', ownLimit: longExplicit },
      { key: 'sibling', agentType: 'claude-code', sessionState: 'ready', ownLimit: null },
    ], NOW);

    // The sibling inherits the LONGER of the two, not the most recent.
    expect(resolved.get('sibling')?.retryAt).toBe(NOW + 4 * 60 * 60_000);
    // And each first-hand holder reports its own effective deadline, which for
    // the short one is the floor rather than the raw provider value.
    expect(resolved.get('short')?.retryAt).toBe(NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS);
    expect(resolved.get('long')?.retryAt).toBe(NOW + 4 * 60 * 60_000);

    // Consistency: whatever retryAt was reported, the target is still limited
    // one ms before it and no longer limited at it.
    for (const [key, state] of [['short', shortExplicit], ['long', longExplicit]] as const) {
      const deadline = resolved.get(key)!.retryAt!;
      expect(isDelegationLimitActive(state, deadline - 1), `${key} before deadline`).toBe(true);
      expect(isDelegationLimitActive(state, deadline), `${key} at deadline`).toBe(false);
    }
  });

  it('never offers an alternative from another project or a hidden clone', () => {
    // Quota EVIDENCE is account-wide and must cross projects -- one Claude
    // account backs sessions everywhere on this daemon. The SUGGESTION list is
    // not: handing back a target the caller cannot address leaks the existence
    // of other projects' sessions and of execution clones that are deliberately
    // undiscoverable, and the caller cannot act on it anyway.
    const sessions = [
      // The caller is deliberately a DIFFERENT family from the limited target.
      // Sharing its family would get it excluded by the group rule, so the
      // caller filter would never be the thing under test and this assertion
      // would pass even with that filter deleted -- which is exactly how it
      // passed before a mutation exposed it.
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain', agentType: 'gemini' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: storedLimit() }),
      // Different project, healthy, different family -- tempting and forbidden.
      session({ name: 'deck_beta_w1', projectName: 'beta', role: 'w1', agentType: 'gemini', projectDir: '/work/beta' }),
      // A hidden execution clone in the caller's own project.
      session({
        name: 'deck_alpha_clone1',
        projectName: 'alpha',
        role: 'w9',
        agentType: 'gemini',
        executionCloneMetadata: { kind: 'execution_clone' },
      } as Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role'>),
      // The legitimate escape route.
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ];

    return dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w1', message: 'x' },
      { now: () => NOW, listSessions: () => sessions, dispatchMessage: vi.fn(async () => {}) },
    ).then((result) => {
      if (result.status !== 'error') throw new Error('expected a refusal');
      const offered = result.limited?.alternatives.map((a) => a.target) ?? [];
      expect(offered).toContain('deck_alpha_w3');
      expect(offered, 'leaked a foreign project session').not.toContain('deck_beta_w1');
      expect(offered, 'leaked a hidden execution clone').not.toContain('deck_alpha_clone1');
      expect(offered, 'leaked the caller itself').not.toContain('deck_alpha_brain');
    });
  });

  it('reports a missing / errored / offline target as UNAVAILABLE, never as limited', () => {
    // A crashed agent and an exhausted account both mean "not this target" and
    // mean opposite things about when to return. Reporting the first as the
    // second tells the caller to wait for a reset clock that does not exist,
    // and reads to an operator as a quota problem that was never there.
    const errored = session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', state: 'error' });
    const missing = session({ name: 'deck_alpha_ghost', projectName: 'alpha', role: 'w8' });
    const healthy = session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' });
    const known = [healthy, errored];

    // The two reasons must be DISTINCT VALUES, pinned literally.
    //
    // Asserting only `toBe(DELEGATION_ADMISSION_REASONS.TARGET_UNAVAILABLE)`
    // is vacuous: alias that constant to TARGET_LIMITED and both sides of the
    // comparison move together, so the test stays green while every crashed
    // agent is reported as an exhausted account. Verified by mutation -- that
    // exact alias survived the suite until these two lines existed.
    expect(DELEGATION_ADMISSION_REASONS.TARGET_UNAVAILABLE).toBe('target_unavailable');
    expect(DELEGATION_ADMISSION_REASONS.TARGET_LIMITED).toBe('target_limited');

    const admission = evaluateDelegationAdmission(known, [errored, missing], NOW, { newWorkload: true });

    expect(admission.blocked).toHaveLength(2);
    for (const blocked of admission.blocked) {
      expect(blocked.reason, `${blocked.target} was mislabelled`).toBe('target_unavailable');
      // No invented retry clock.
      expect(blocked.retryAt).toBeUndefined();
      expect(blocked.limitReason).toBeUndefined();
    }
    const refusal = buildDelegationRefusal(admission.blocked, known, admission.availability);
    expect(refusal.reason).toBe('target_unavailable');

    // And an ordinary (non-spawning) send is still allowed through: messaging
    // a struggling session is often how it gets woken.
    const ordinary = evaluateDelegationAdmission(known, [errored], NOW);
    expect(ordinary.blocked).toHaveLength(0);
    expect(ordinary.dispatchable.map((s) => s.name)).toEqual(['deck_alpha_w1']);
  });

  it('does not disqualify a healthy family because one member is offline', () => {
    // Claude is out of quota; Gemini A crashed; Gemini B is fine.
    //
    // `target_unavailable` is a property of ONE session -- it fell over.
    // `target_limited` is a property of an ACCOUNT. Folding the first into the
    // group-exclusion set removed Gemini B, the only usable target left, purely
    // because its neighbour crashed. The caller is then told there is nowhere
    // to go while a perfectly healthy agent sits idle.
    const claude = session({
      name: 'deck_alpha_c1', projectName: 'alpha', role: 'w1',
      agentType: 'claude-code-sdk',
      providerLimit: storedLimit({ agentType: 'claude-code-sdk' }),
    });
    const geminiDown = session({
      name: 'deck_alpha_g1', projectName: 'alpha', role: 'w2', agentType: 'gemini', state: 'error',
    });
    const geminiReady = session({
      name: 'deck_alpha_g2', projectName: 'alpha', role: 'w3', agentType: 'gemini',
    });
    const known = [claude, geminiDown, geminiReady];

    const admission = evaluateDelegationAdmission(known, [claude, geminiDown], NOW, { newWorkload: true });
    const refusal = buildDelegationRefusal(admission.blocked, known, admission.availability);

    const offered = refusal.alternatives.map((a) => a.target);
    expect(offered, 'a crashed sibling disqualified a healthy one').toContain('deck_alpha_g2');
    // The crashed one is still not offered -- availability already excludes it.
    expect(offered).not.toContain('deck_alpha_g1');
    // And the genuinely exhausted family stays excluded.
    expect(offered).not.toContain('deck_alpha_c1');
  });

  it('keeps LIMITED as the summary reason when both refusals occur together', () => {
    // Mixed batch: one out of quota, one simply down. The summary must be
    // `target_limited`, because that is the one carrying a retry schedule --
    // collapsing to `unavailable` would discard the only actionable timing the
    // caller has.
    const limited = session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: storedLimit() });
    const down = session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2', agentType: 'gemini', state: 'error' });
    const known = [limited, down];

    const admission = evaluateDelegationAdmission(known, [limited, down], NOW, { newWorkload: true });
    const refusal = buildDelegationRefusal(admission.blocked, known, admission.availability);

    expect(refusal.reason).toBe(DELEGATION_ADMISSION_REASONS.TARGET_LIMITED);
    // Each target still carries its OWN reason; the summary does not overwrite
    // the per-target truth.
    const byTarget = new Map(refusal.targets.map((t) => [t.target, t.reason]));
    expect(byTarget.get('deck_alpha_w1')).toBe('target_limited');
    expect(byTarget.get('deck_alpha_w2')).toBe('target_unavailable');
  });
});
