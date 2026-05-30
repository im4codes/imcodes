import { describe, it, expect } from 'vitest';
import { claudeRateLimitsToQuotaMeta, CLAUDE_FIVE_HOUR_MINS, CLAUDE_SEVEN_DAY_MINS } from './claude-rate-limit.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';

// The exact `rate_limit_info` captured from the live SDK (healthy account):
// only `five_hour`, no `utilization`, resetsAt in epoch SECONDS.
const REAL_FIVE_HOUR = {
  status: 'allowed',
  resetsAt: 1780123200, // 2026-05-30T06:40:00Z
  rateLimitType: 'five_hour',
  overageStatus: 'allowed',
  overageResetsAt: 1780272000,
  isUsingOverage: false,
} as const;

describe('claudeRateLimitsToQuotaMeta', () => {
  it('maps the real five_hour event → primary (300m, resetsAt passthrough, no percent)', () => {
    const meta = claudeRateLimitsToQuotaMeta({ five_hour: REAL_FIVE_HOUR });
    expect(meta).toEqual({
      primary: { windowDurationMins: CLAUDE_FIVE_HOUR_MINS, resetsAt: 1780123200 },
    });
    // resetsAt is seconds → renders a real reset clock, no NaN.
    const label = formatProviderQuotaLabel(meta, Date.UTC(2026, 4, 30, 3, 0, 0));
    expect(label).toMatch(/5h/);
    expect(label).not.toMatch(/NaN/);
  });

  it('maps seven_day → secondary (weekly, 10080m) and converts a 0–1 utilization to percent', () => {
    const meta = claudeRateLimitsToQuotaMeta({
      five_hour: REAL_FIVE_HOUR,
      seven_day: { status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: 1780272000, utilization: 0.34 },
    });
    expect(meta?.primary).toEqual({ windowDurationMins: CLAUDE_FIVE_HOUR_MINS, resetsAt: 1780123200 });
    expect(meta?.secondary).toEqual({ windowDurationMins: CLAUDE_SEVEN_DAY_MINS, resetsAt: 1780272000, usedPercent: 34 });
  });

  it('falls back to seven_day_opus / seven_day_sonnet for the weekly window', () => {
    const opus = claudeRateLimitsToQuotaMeta({ seven_day_opus: { rateLimitType: 'seven_day_opus', resetsAt: 1, utilization: 0.5 } });
    expect(opus?.secondary).toEqual({ windowDurationMins: CLAUDE_SEVEN_DAY_MINS, resetsAt: 1, usedPercent: 50 });
    const sonnet = claudeRateLimitsToQuotaMeta({ seven_day_sonnet: { rateLimitType: 'seven_day_sonnet', resetsAt: 2 } });
    expect(sonnet?.secondary).toEqual({ windowDurationMins: CLAUDE_SEVEN_DAY_MINS, resetsAt: 2 });
  });

  it('tolerates an already-percent utilization (>1) without double-scaling', () => {
    const meta = claudeRateLimitsToQuotaMeta({ five_hour: { rateLimitType: 'five_hour', utilization: 72 } });
    expect(meta?.primary?.usedPercent).toBe(72);
  });

  it('returns undefined when no known window is present (never emit an empty snapshot)', () => {
    expect(claudeRateLimitsToQuotaMeta({})).toBeUndefined();
    expect(claudeRateLimitsToQuotaMeta({ overage: { rateLimitType: 'overage', resetsAt: 9 } })).toBeUndefined();
  });
});
