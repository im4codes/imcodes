import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_FAMILY, CODEX_FAMILY, SESSION_AGENT_TYPES } from '../../shared/agent-types.js';
import {
  DELEGATION_AVAILABILITY,
  PROVIDER_LIMIT_EVIDENCE_KINDS,
  PROVIDER_LIMIT_STATES,
  PROVIDER_LIMIT_TEXT_MIN_CONFIDENCE,
  PROVIDER_LIMIT_MAX_RETRY_HORIZON_MS,
  PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS,
  observeProviderLimitSignal,
  type ProviderLimitSignal,
  DELEGATION_LIMIT_FALLBACK_TTL_MS,
  DELEGATION_LIMIT_GROUPS,
  DELEGATION_LIMIT_REASONS,
  delegationLimitGroup,
  delegationLimitDeadline,
  isDelegationLimitActive,
  resolveDelegationTargetAvailability,
  resolveDelegationTargets,
  selectDelegationAlternatives,
  type DelegationLimitState,
} from '../../shared/delegation-availability.js';

const NOW = 1_700_000_000_000;

function limit(overrides: Partial<DelegationLimitState> = {}): DelegationLimitState {
  return {
    limitedAt: NOW,
    reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
    agentType: 'claude-code-sdk',
    ...overrides,
  };
}

function signal(overrides: Partial<ProviderLimitSignal> = {}): ProviderLimitSignal {
  return {
    providerId: 'claude-code-sdk',
    limitGroup: DELEGATION_LIMIT_GROUPS.CLAUDE,
    state: PROVIDER_LIMIT_STATES.LIMITED,
    observedAt: NOW,
    evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED,
    ...overrides,
  };
}

describe('canonical provider limit signal', () => {
  it('limits only on an explicit limited state', () => {
    expect(observeProviderLimitSignal(signal(), NOW).kind).toBe('limited');
    // `warning` says "approaching the cap": not a refusal, so it cannot limit,
    // and not a recovery either, so it must not clear one. Only an explicit
    // RECOVERED clears.
    expect(observeProviderLimitSignal(signal({ state: PROVIDER_LIMIT_STATES.WARNING }), NOW).kind)
      .toBe('noEvidence');
    expect(observeProviderLimitSignal(signal({ state: PROVIDER_LIMIT_STATES.RECOVERED }), NOW).kind)
      .toBe('healthy');
    // `unknown` is not a verdict at all: it must neither set nor clear.
    expect(observeProviderLimitSignal(signal({ state: PROVIDER_LIMIT_STATES.UNKNOWN }), NOW).kind)
      .toBe('noEvidence');
  });

  it('requires confidence before a PARSED verdict may limit anything', () => {
    // A verdict read out of an error envelope is not the same fact as one the
    // provider stated. Below the bar it is not downgraded to "healthy" -- it is
    // not evidence at all, so it can neither limit an agent nor clear a limit
    // that a structured signal already established.
    const parsed = (confidence?: number) => signal({
      evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_ERROR_TEXT,
      ...(confidence === undefined ? {} : { confidence }),
    });
    expect(observeProviderLimitSignal(parsed(PROVIDER_LIMIT_TEXT_MIN_CONFIDENCE), NOW).kind)
      .toBe('limited');
    expect(observeProviderLimitSignal(parsed(PROVIDER_LIMIT_TEXT_MIN_CONFIDENCE - 0.01), NOW).kind)
      .toBe('noEvidence');
    // Omitted confidence is not "certain".
    expect(observeProviderLimitSignal(parsed(), NOW).kind).toBe('noEvidence');
    expect(observeProviderLimitSignal(parsed(Number.NaN), NOW).kind).toBe('noEvidence');

    // A STRUCTURED signal needs no confidence -- the provider stated it.
    expect(observeProviderLimitSignal(signal(), NOW).kind).toBe('limited');
  });

  it('carries the evidence kind through to stored state', () => {
    // So a consumer can weigh a stated verdict against a parsed one instead of
    // treating both as authority.
    const observed = observeProviderLimitSignal(
      signal({ sourceCode: 'rejected', scope: 'five_hour' }), NOW,
    );
    if (observed.kind !== 'limited') throw new Error('expected a limit');
    expect(observed.state.evidenceKind).toBe(PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED);
    expect(observed.state.source).toBe('rejected');
    expect(observed.state.window).toBe('five_hour');
  });

  it('refuses a signal with no provider identity', () => {
    expect(observeProviderLimitSignal(null, NOW).kind).toBe('noEvidence');
    expect(observeProviderLimitSignal(undefined, NOW).kind).toBe('noEvidence');
    expect(observeProviderLimitSignal(signal({ providerId: '' }), NOW).kind).toBe('noEvidence');
  });

  it('uses the adapter observation time, not the reader clock', () => {
    // The adapter saw it; a later reader must not restart the window and
    // silently extend a limit every time it is looked at.
    const observed = observeProviderLimitSignal(signal({ observedAt: NOW - 60_000 }), NOW);
    if (observed.kind !== 'limited') throw new Error('expected a limit');
    expect(observed.state.limitedAt).toBe(NOW - 60_000);
  });
});

describe('delegation target availability', () => {
  it('groups the two provider families that actually share an account', () => {
    // A limit is a property of the upstream ACCOUNT, not of the session that
    // happened to meet it, so the SDK and process forms of one provider must
    // land in one group.
    for (const agentType of CLAUDE_CODE_FAMILY) {
      expect(delegationLimitGroup(agentType)).toBe(DELEGATION_LIMIT_GROUPS.CLAUDE);
    }
    for (const agentType of CODEX_FAMILY) {
      expect(delegationLimitGroup(agentType)).toBe(DELEGATION_LIMIT_GROUPS.CODEX);
    }
    // The two are NOT the same group -- that is the whole point of the feature.
    expect(DELEGATION_LIMIT_GROUPS.CLAUDE).not.toBe(DELEGATION_LIMIT_GROUPS.CODEX);
  });

  it('gives every other agent type its own stable group', () => {
    // Stable: the same input always yields the same group.
    // Its own: grouping types that do NOT share an account would take a healthy
    // agent out of service on someone else's limit, which is worse than not
    // grouping at all.
    const grouped = new Set<string>([...CLAUDE_CODE_FAMILY, ...CODEX_FAMILY]);
    for (const agentType of SESSION_AGENT_TYPES) {
      if (grouped.has(agentType)) continue;
      expect(delegationLimitGroup(agentType), `${agentType} leaked into a shared group`)
        .toBe(agentType);
      expect(delegationLimitGroup(agentType)).toBe(delegationLimitGroup(agentType));
    }
    // opencode is multi-provider, so its two forms must NOT share a group.
    expect(delegationLimitGroup('opencode-sdk')).not.toBe(delegationLimitGroup('opencode'));
  });

  it('expires a limit rather than poisoning a target for ever', () => {
    // With a provider-supplied reset time, that time governs.
    // A provider reset time can only EXTEND the window, never shorten it: the
    // bounded fallback is a floor. A provider advertising a reset one minute
    // out would otherwise erase the back-off and turn a refusal into a hot
    // retry loop.
    const shortReset = limit({ retryAt: NOW + 60_000 });
    expect(isDelegationLimitActive(shortReset, NOW + 60_000)).toBe(true);
    expect(isDelegationLimitActive(shortReset, NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS - 1)).toBe(true);
    expect(isDelegationLimitActive(shortReset, NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS)).toBe(false);

    const longReset = limit({ retryAt: NOW + 4 * 60 * 60_000 });
    expect(isDelegationLimitActive(longReset, NOW + 60 * 60_000)).toBe(true);
    expect(isDelegationLimitActive(longReset, NOW + 4 * 60 * 60_000)).toBe(false);

    // One function answers both "still in force?" and "when does it end?".
    expect(delegationLimitDeadline(shortReset)).toBe(NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS);
    expect(delegationLimitDeadline(longReset)).toBe(NOW + 4 * 60 * 60_000);
    expect(delegationLimitDeadline(null)).toBeNull();

    // Without one, a bounded fallback applies: a provider that never says "you
    // may retry" must not disable an agent for the life of the daemon.
    const noReset = limit();
    expect(isDelegationLimitActive(noReset, NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS - 1)).toBe(true);
    expect(isDelegationLimitActive(noReset, NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS)).toBe(false);

    // A retryAt in the past, or before the observation, cannot shorten the
    // window below the fallback -- otherwise a bogus timestamp would clear a
    // real limit instantly.
    expect(isDelegationLimitActive(limit({ retryAt: NOW - 1 }), NOW + 1_000)).toBe(true);

    expect(isDelegationLimitActive(null, NOW)).toBe(false);
    expect(isDelegationLimitActive(undefined, NOW)).toBe(false);
    expect(isDelegationLimitActive({ ...limit(), limitedAt: Number.NaN }, NOW)).toBe(false);
  });

  it('marks a whole family limited from one first-hand observation', () => {
    const observed = limit({ agentType: 'claude-code-sdk', retryAt: NOW + 60_000 });

    // The session that met the provider reports first-hand evidence.
    const source = resolveDelegationTargetAvailability({
      agentType: 'claude-code-sdk',
      sessionState: 'ready',
      ownLimit: observed,
      groupLimit: observed,
      nowMs: NOW,
    });
    expect(source.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    expect(source.reason).toBe(DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED);
    // The EFFECTIVE deadline, not the raw provider field: the fallback floor
    // applies, so a caller told to retry then will not be refused again.
    expect(source.retryAt).toBe(NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS);

    // The sibling on the same account is limited too, and says so second hand
    // -- so a report names where the evidence came from instead of claiming
    // this session saw it.
    const sibling = resolveDelegationTargetAvailability({
      agentType: 'claude-code',
      sessionState: 'ready',
      ownLimit: null,
      groupLimit: observed,
      nowMs: NOW,
    });
    expect(sibling.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    expect(sibling.reason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);
    expect(sibling.limitGroup).toBe(DELEGATION_LIMIT_GROUPS.CLAUDE);
  });

  it('does not let one family poison another', () => {
    const claudeLimited = limit({ agentType: 'claude-code-sdk' });
    for (const agentType of CODEX_FAMILY) {
      const codex = resolveDelegationTargetAvailability({
        agentType,
        sessionState: 'ready',
        ownLimit: null,
        // A Codex session is never handed the Claude group's limit, because the
        // caller keys group state by limitGroup -- asserted here at the
        // contract so a caller that got it wrong is visible.
        groupLimit: null,
        nowMs: NOW,
      });
      expect(codex.availability).toBe(DELEGATION_AVAILABILITY.READY);
      expect(codex.limitGroup).toBe(DELEGATION_LIMIT_GROUPS.CODEX);
    }
    expect(delegationLimitGroup(claudeLimited.agentType))
      .not.toBe(delegationLimitGroup('codex-sdk'));
  });

  it('returns an expired limit to unknown, never straight to ready', () => {
    // The expiry proves the WAIT is over. Whether the quota came back is
    // unproven until the provider says so, and reporting `ready` would be
    // asserting a recovery nobody observed.
    const stale = limit({ retryAt: NOW - 1_000 });
    const after = resolveDelegationTargetAvailability({
      agentType: 'claude-code-sdk',
      sessionState: 'ready',
      ownLimit: stale,
      groupLimit: stale,
      nowMs: NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS + 1,
    });
    expect(after.availability).toBe(DELEGATION_AVAILABILITY.UNKNOWN);
    expect(after.availability).not.toBe(DELEGATION_AVAILABILITY.LIMITED);
    expect(after.availability).not.toBe(DELEGATION_AVAILABILITY.READY);

    // A target that never had a limit at all IS ready -- so the rule above is
    // about recovery, not a blanket refusal to ever say ready.
    expect(resolveDelegationTargetAvailability({
      agentType: 'claude-code-sdk',
      sessionState: 'ready',
      ownLimit: null,
      groupLimit: null,
      nowMs: NOW,
    }).availability).toBe(DELEGATION_AVAILABILITY.READY);
  });

  it('keeps busy and limited as different answers', () => {
    // busy = "occupied, ask later". limited = "the account is out; asking later
    // on this family will not help". Collapsing them makes an orchestrator
    // retry into a wall.
    expect(resolveDelegationTargetAvailability({
      agentType: 'codex-sdk', sessionState: 'busy', nowMs: NOW,
    }).availability).toBe(DELEGATION_AVAILABILITY.BUSY);
    expect(resolveDelegationTargetAvailability({
      agentType: 'codex-sdk', sessionState: 'offline', nowMs: NOW,
    }).availability).toBe(DELEGATION_AVAILABILITY.OFFLINE);
    expect(resolveDelegationTargetAvailability({
      agentType: 'codex-sdk', sessionState: 'unknown', nowMs: NOW,
    }).availability).toBe(DELEGATION_AVAILABILITY.UNKNOWN);

    // A limit outranks busy: an occupied session on an exhausted account is
    // still on an exhausted account.
    expect(resolveDelegationTargetAvailability({
      agentType: 'codex-sdk',
      sessionState: 'busy',
      ownLimit: limit({ agentType: 'codex-sdk' }),
      nowMs: NOW,
    }).availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
  });

  it('offers alternatives only from a different quota group', () => {
    const candidates = [
      { target: 'a', agentType: 'claude-code', limitGroup: DELEGATION_LIMIT_GROUPS.CLAUDE, availability: DELEGATION_AVAILABILITY.READY },
      { target: 'b', agentType: 'codex-sdk', limitGroup: DELEGATION_LIMIT_GROUPS.CODEX, availability: DELEGATION_AVAILABILITY.READY },
      { target: 'c', agentType: 'gemini-sdk', limitGroup: 'gemini-sdk', availability: DELEGATION_AVAILABILITY.UNKNOWN },
      { target: 'd', agentType: 'qwen', limitGroup: 'qwen', availability: DELEGATION_AVAILABILITY.OFFLINE },
      { target: 'e', agentType: 'grok-sdk', limitGroup: 'grok-sdk', availability: DELEGATION_AVAILABILITY.LIMITED },
    ] as const;

    const alternatives = selectDelegationAlternatives(
      DELEGATION_LIMIT_GROUPS.CLAUDE, candidates,
    );
    const targets = alternatives.map((a) => a.target);
    // `a` shares the exhausted account -- offering it is offering the same wall,
    // even though it looks healthy.
    expect(targets).not.toContain('a');
    // Offline and already-limited alternatives are no help either.
    expect(targets).not.toContain('d');
    expect(targets).not.toContain('e');
    expect(targets).toEqual(['b', 'c']);

    expect(selectDelegationAlternatives(DELEGATION_LIMIT_GROUPS.CLAUDE, candidates, 1))
      .toHaveLength(1);
    expect(selectDelegationAlternatives(DELEGATION_LIMIT_GROUPS.CLAUDE, candidates, 0))
      .toHaveLength(0);
  });
});

describe('resolveDelegationTargets (the single decision source)', () => {
  const target = (
    key: string,
    agentType: string,
    ownLimit: DelegationLimitState | null = null,
    sessionState: 'ready' | 'busy' | 'offline' | 'unknown' = 'ready',
  ) => ({ key, agentType, sessionState, ownLimit });

  it('spreads one session\'s evidence across its whole quota group', () => {
    // Resolving targets one at a time would miss this entirely: the only
    // session holding evidence may not be the one being asked about.
    const resolved = resolveDelegationTargets([
      target('met-it', 'claude-code', limit({ agentType: 'claude-code' })),
      target('sibling', 'claude-code-sdk'),
      target('other-account', 'codex'),
    ], NOW);

    expect(resolved.get('met-it')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    expect(resolved.get('met-it')?.reason).toBe(DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED);
    expect(resolved.get('sibling')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    // Second hand, and reported as such so a reader can tell who actually saw it.
    expect(resolved.get('sibling')?.reason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);
    expect(resolved.get('other-account')?.availability).toBe(DELEGATION_AVAILABILITY.READY);
  });

  it('keeps the group limit that lasts LONGEST, not the most recently observed', () => {
    // Two sessions on one account met the provider: an early limit with a long
    // window, and a later one with a short window. A third sibling has no
    // first-hand evidence of its own and can only inherit the group's.
    //
    // Picking "most recent" would hand that sibling the SHORT limit, which has
    // already lapsed at the read time below -- so the account would be reported
    // usable while the long limit still refuses it.
    const group = () => [
      target('long', 'claude-code', limit({ agentType: 'claude-code', limitedAt: NOW, retryAt: NOW + 4 * 60 * 60_000 })),
      target('short', 'claude-code-sdk', limit({ agentType: 'claude-code-sdk', limitedAt: NOW + 60_000, retryAt: NOW + 61_000 })),
      target('sibling', 'claude-code'),
    ];

    const now = resolveDelegationTargets(group(), NOW);
    // First-hand evidence outranks the group's, so each session that met the
    // provider reports its OWN window rather than the family's.
    // Its own short reset is floored by the bounded fallback, measured from
    // ITS observation time (NOW + 60s), so it ends later than the raw 61s.
    expect(now.get('short')?.retryAt).toBe(NOW + 60_000 + DELEGATION_LIMIT_FALLBACK_TTL_MS);
    expect(now.get('short')?.reason).toBe(DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED);
    // The sibling has none, so it inherits -- and must inherit the longer one.
    expect(now.get('sibling')?.retryAt).toBe(NOW + 4 * 60 * 60_000);
    expect(now.get('sibling')?.reason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);

    // Read after the short window lapsed but while the long one still runs.
    const later = resolveDelegationTargets(group(), NOW + 2 * 60 * 60_000);
    expect(later.get('sibling')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    // And the session whose own short limit expired falls back to the family's.
    expect(later.get('short')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    expect(later.get('short')?.reason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);
  });

  it('never invents a group limit from an absent one', () => {
    const resolved = resolveDelegationTargets([
      target('a', 'claude-code', null),
      target('b', 'claude-code-sdk', undefined as unknown as null),
      target('c', 'claude-code', { ...limit(), limitedAt: Number.NaN }),
    ], NOW);

    for (const key of ['a', 'b', 'c']) {
      expect(resolved.get(key)?.availability, `${key} was limited without evidence`)
        .toBe(DELEGATION_AVAILABILITY.READY);
    }
  });

  it('does not resurrect an expired limit as ready', () => {
    const resolved = resolveDelegationTargets([
      target('a', 'claude-code', limit({ agentType: 'claude-code' })),
    ], NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS + 1);
    // The wait is provably over; the quota coming back is not proven.
    expect(resolved.get('a')?.availability).toBe(DELEGATION_AVAILABILITY.UNKNOWN);
  });

  it('reports a busy-but-unlimited target as busy, not limited', () => {
    const resolved = resolveDelegationTargets([
      target('busy', 'codex', null, 'busy'),
      target('gone', 'codex', null, 'offline'),
    ], NOW);
    expect(resolved.get('busy')?.availability).toBe(DELEGATION_AVAILABILITY.BUSY);
    expect(resolved.get('gone')?.availability).toBe(DELEGATION_AVAILABILITY.OFFLINE);
  });
});

describe('hostile provider-limit frames', () => {
  const base = signal;

  it('refuses an unrecognised state instead of falling through', () => {
    for (const state of ['throttled', 'LIMITED', ' limited', '', 'undefined']) {
      expect(observeProviderLimitSignal(base({ state: state as never }), NOW).kind, state).toBe('noEvidence');
    }
  });

  it('refuses an unrecognised evidenceKind — it must not bypass the confidence bar', () => {
    // Before the fix, any evidenceKind other than provider_error_text skipped the
    // confidence check entirely, so a made-up kind could create a limit outright.
    for (const kind of ['guess', 'provider_error_TEXT', '', 'heuristic']) {
      expect(observeProviderLimitSignal(base({ evidenceKind: kind as never }), NOW).kind, kind).toBe('noEvidence');
    }
  });

  it('refuses a non-probability confidence, including Infinity and MAX_VALUE', () => {
    for (const c of [Infinity, -Infinity, Number.MAX_VALUE, Number.NaN, -1, 1.5, 2]) {
      expect(observeProviderLimitSignal(base({
        evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_ERROR_TEXT, confidence: c as never,
      }), NOW).kind, String(c)).toBe('noEvidence');
    }
    // A real probability at/above the bar still limits, so this is not vacuous.
    expect(observeProviderLimitSignal(base({
      evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_ERROR_TEXT,
      confidence: PROVIDER_LIMIT_TEXT_MIN_CONFIDENCE,
    }), NOW).kind).toBe('limited');
  });

  it('refuses a malformed confidence on a STRUCTURED frame too', () => {
    // The confidence bar only guards parsed text, so without a kind-independent
    // check a structured frame carrying confidence:Infinity would still limit.
    // A malformed number anywhere in the frame means the frame is malformed.
    for (const c of [Infinity, Number.MAX_VALUE, Number.NaN, -1, 42]) {
      expect(observeProviderLimitSignal(base({
        evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED, confidence: c as never,
      }), NOW).kind, String(c)).toBe('noEvidence');
    }
    // A structured frame with a sane confidence, or none at all, still limits.
    expect(observeProviderLimitSignal(base({ confidence: 0.5 }), NOW).kind).toBe('limited');
    expect(observeProviderLimitSignal(base(), NOW).kind).toBe('limited');
  });

  it('will not CLEAR a limit on weak recovered evidence', () => {
    expect(observeProviderLimitSignal(base({
      state: PROVIDER_LIMIT_STATES.RECOVERED,
      evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_ERROR_TEXT,
      confidence: 0.2,
    }), NOW).kind).toBe('noEvidence');
    expect(observeProviderLimitSignal(base({
      state: PROVIDER_LIMIT_STATES.RECOVERED,
      evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_ERROR_TEXT,
      confidence: undefined,
    }), NOW).kind).toBe('noEvidence');
    // Structured recovery still clears.
    expect(observeProviderLimitSignal(base({ state: PROVIDER_LIMIT_STATES.RECOVERED }), NOW).kind).toBe('healthy');
  });

  it('will not CLEAR on a recovered frame with an out-of-horizon observedAt', () => {
    // Cx5 blocker: observedAt was bounded only on the LIMITED path, so the
    // dangerous direction was unguarded — a recovered frame stamped Infinity,
    // MAX_VALUE, far-future or far-past still erased a live limit.
    for (const observedAt of [
      Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, Number.NaN,
      NOW + PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS + 1,
      NOW - PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS - 1,
    ]) {
      expect(observeProviderLimitSignal(base({
        state: PROVIDER_LIMIT_STATES.RECOVERED, observedAt: observedAt as never,
      }), NOW).kind, String(observedAt)).toBe('noEvidence');
    }
    // An in-horizon structured recovery still clears, so the gate is not vacuous.
    expect(observeProviderLimitSignal(base({
      state: PROVIDER_LIMIT_STATES.RECOVERED, observedAt: NOW - 1000,
    }), NOW).kind).toBe('healthy');
    expect(observeProviderLimitSignal(base({
      state: PROVIDER_LIMIT_STATES.RECOVERED, observedAt: NOW,
    }), NOW).kind).toBe('healthy');
  });

  it('cannot pin an agent out of rotation with an unbounded retryAt', () => {
    for (const retryAt of [Number.MAX_VALUE, Infinity, NOW + PROVIDER_LIMIT_MAX_RETRY_HORIZON_MS + 1]) {
      const out = observeProviderLimitSignal(base({ retryAt: retryAt as never }), NOW);
      expect(out.kind, String(retryAt)).toBe('limited');
      // Limited, but with NO retryAt, so the bounded fallback TTL governs expiry.
      if (out.kind === 'limited') expect(out.state.retryAt, String(retryAt)).toBeUndefined();
    }
    const honest = observeProviderLimitSignal(base({ retryAt: NOW + 60_000 }), NOW);
    if (honest.kind === 'limited') expect(honest.state.retryAt).toBe(NOW + 60_000);
  });

  it('clamps a wildly skewed observedAt back to now', () => {
    for (const observedAt of [Number.MAX_VALUE, -Number.MAX_VALUE, Infinity, NOW + PROVIDER_LIMIT_MAX_OBSERVED_SKEW_MS + 1]) {
      const out = observeProviderLimitSignal(base({ observedAt: observedAt as never }), NOW);
      expect(out.kind, String(observedAt)).toBe('limited');
      if (out.kind === 'limited') expect(out.state.limitedAt, String(observedAt)).toBe(NOW);
    }
    const honest = observeProviderLimitSignal(base({ observedAt: NOW - 1000 }), NOW);
    if (honest.kind === 'limited') expect(honest.state.limitedAt).toBe(NOW - 1000);
  });

  it('refuses everything when now itself is not finite', () => {
    expect(observeProviderLimitSignal(base(), Number.NaN).kind).toBe('noEvidence');
    expect(observeProviderLimitSignal(base(), Infinity).kind).toBe('noEvidence');
  });
});
