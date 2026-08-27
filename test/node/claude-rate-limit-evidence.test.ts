import { describe, expect, it } from 'vitest';

import {
  CLAUDE_RATE_LIMIT_STATUS,
  claudeRateLimitSignal,
} from '../../src/agent/claude-rate-limit.js';
import {
  DELEGATION_LIMIT_GROUPS,
  DELEGATION_LIMIT_REASONS,
  PROVIDER_LIMIT_EVIDENCE_KINDS,
  PROVIDER_LIMIT_STATES,
  observeProviderLimitSignal,
} from '../../shared/delegation-availability.js';

const NOW = 1_700_000_000_000;

describe('claude structured rate-limit evidence', () => {
  it('treats only an explicit rejection as a limit', () => {
    // `status` is Claude's own verdict and the only authority for "we are
    // being refused". Everything else on the event is a display number.
    const rejected = claudeRateLimitSignal({
      status: CLAUDE_RATE_LIMIT_STATUS.REJECTED,
      resetsAt: NOW / 1000 + 600,
      rateLimitType: 'five_hour',
    }, 'claude-code-sdk', NOW);
    expect(rejected?.state).toBe(PROVIDER_LIMIT_STATES.LIMITED);
    expect(rejected?.limitGroup).toBe(DELEGATION_LIMIT_GROUPS.CLAUDE);
    expect(rejected?.evidenceKind).toBe(PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED);
    expect(observeProviderLimitSignal(rejected, NOW).kind).toBe('limited');
  });

  it('does NOT limit on allowed_warning, and does NOT clear on it either', () => {
    // A provider saying "you are approaching the cap" is still serving
    // requests, so it must not limit. But it is equally NOT a statement that an
    // earlier refusal is over, so it must not clear one.
    //
    // Only `allowed` -- an explicit "we are serving you" -- clears. Claude
    // emits `allowed_warning` routinely as usage climbs, so treating a warning
    // as healthy meant the FIRST warning after a real `rejected` wiped the
    // limit and put the account straight back into rotation while it was still
    // being refused.
    const warned = claudeRateLimitSignal(
      { status: CLAUDE_RATE_LIMIT_STATUS.ALLOWED_WARNING, rateLimitType: 'five_hour' },
      'claude-code-sdk', NOW,
    );
    expect(warned, 'allowed_warning produced no signal').not.toBeNull();
    expect(observeProviderLimitSignal(warned, NOW).kind,
      'a warning must neither set nor clear').toBe('noEvidence');

    const allowed = claudeRateLimitSignal(
      { status: CLAUDE_RATE_LIMIT_STATUS.ALLOWED, rateLimitType: 'five_hour' },
      'claude-code-sdk', NOW,
    );
    expect(observeProviderLimitSignal(allowed, NOW).kind,
      'an explicit allowed is the only clear').toBe('healthy');
  });

  it('converts resetsAt from epoch seconds to the protocol milliseconds', () => {
    // The event carries SECONDS; the shared protocol stores MILLISECONDS.
    // Getting this wrong by 1000x would put every reset in 1970 and make every
    // limit look instantly expired.
    const resetSeconds = NOW / 1000 + 3_600;
    const evidence = claudeRateLimitSignal({
      status: CLAUDE_RATE_LIMIT_STATUS.REJECTED,
      resetsAt: resetSeconds,
    }, 'claude-code-sdk', NOW);
    expect(evidence?.retryAt).toBe(resetSeconds * 1000);
    const observed = observeProviderLimitSignal(evidence, NOW);
    expect(observed.kind).toBe('limited');
    if (observed.kind !== 'limited') throw new Error('unreachable');
    expect(observed.state.retryAt).toBe(resetSeconds * 1000);
    // Comfortably in the future, i.e. not mistaken for an already-expired limit.
    expect(observed.state.retryAt! - NOW).toBeGreaterThan(3_000_000);
  });

  it('falls back to the bounded window when the provider gives no reset time', () => {
    const evidence = claudeRateLimitSignal({ status: CLAUDE_RATE_LIMIT_STATUS.REJECTED }, 'claude-code-sdk', NOW);
    expect(evidence?.retryAt).toBeUndefined();
    const observed = observeProviderLimitSignal(evidence, NOW);
    if (observed.kind !== 'limited') throw new Error('expected a limit');
    // No invented reset time: the protocol's bounded TTL governs instead.
    expect(observed.state.retryAt).toBeUndefined();
  });

  it('refuses to conclude anything from an unrecognised status', () => {
    // NOT the same as healthy. If Claude adds a status value we have never
    // seen, folding it into "healthy" would silently CLEAR a real limit on an
    // account that is still being refused.
    for (const status of ['throttled', 'REJECTED', '', 'unknown_future_value']) {
      expect(claudeRateLimitSignal({ status }, 'claude-code-sdk', NOW), `${status} was interpreted`).toBeNull();
    }
    expect(claudeRateLimitSignal(undefined, 'claude-code-sdk', NOW)).toBeNull();
    expect(claudeRateLimitSignal({}, 'claude-code-sdk', NOW)).toBeNull();
    // And the observation layer agrees: no evidence neither sets nor clears.
    expect(observeProviderLimitSignal(null, NOW).kind).toBe('noEvidence');
  });

  it('never derives a limit from a message or an exception string', () => {
    // The two providers that already emit RATE_LIMITED do it by regexing
    // /rate|429|quota/i over an exception message. Nothing shaped like that can
    // reach this function: it reads a status enum and nothing else.
    const prose = {
      status: 'Error: 429 rate limit exceeded, quota exhausted',
    } as { status: string };
    expect(claudeRateLimitSignal(prose, 'claude-code-sdk', NOW)).toBeNull();
  });

  it('records the provider-native field a limit came from', () => {
    // So an operator can tell a limit that came from Claude's own status apart
    // from one that came from somewhere it should not have.
    const observed = observeProviderLimitSignal(
      claudeRateLimitSignal(
        { status: CLAUDE_RATE_LIMIT_STATUS.REJECTED, rateLimitType: 'seven_day' },
        'claude-code-sdk',
        NOW,
      ),
      NOW,
    );
    if (observed.kind !== 'limited') throw new Error('expected a limit');
    expect(observed.state.source).toBe(CLAUDE_RATE_LIMIT_STATUS.REJECTED);
    expect(observed.state.evidenceKind).toBe(PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED);
    expect(observed.state.window).toBe('seven_day');
    expect(observed.state.agentType).toBe('claude-code-sdk');
    expect(observed.state.reason).toBe(DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED);
  });

  it('ignores a reset time that is already in the past', () => {
    // A stale or bogus timestamp must not produce a limit that is expired the
    // instant it is written -- the bounded fallback covers it instead.
    const observed = observeProviderLimitSignal(
      claudeRateLimitSignal(
        { status: CLAUDE_RATE_LIMIT_STATUS.REJECTED, resetsAt: (NOW - 60_000) / 1000 },
        'claude-code-sdk',
        NOW,
      ),
      NOW,
    );
    if (observed.kind !== 'limited') throw new Error('expected a limit');
    expect(observed.state.retryAt).toBeUndefined();
  });
});
