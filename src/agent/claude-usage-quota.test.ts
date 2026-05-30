import { describe, it, expect } from 'vitest';
import { usageEndpointToQuotaMeta } from './claude-usage-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';

// The exact /api/oauth/usage payload captured from the live endpoint:
// utilization is 0–100 PERCENT, resets_at is an ISO-8601 string.
const REAL = {
  five_hour: { utilization: 26.0, resets_at: '2026-05-30T06:40:00.613600+00:00' },
  seven_day: { utilization: 30.0, resets_at: '2026-06-02T08:00:00.613623+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 11.0, resets_at: '2026-06-02T08:00:00.613632+00:00' },
};

describe('usageEndpointToQuotaMeta', () => {
  it('maps the real payload: five_hour→primary, seven_day→secondary', () => {
    const meta = usageEndpointToQuotaMeta(REAL);
    expect(meta?.primary).toEqual({
      windowDurationMins: 300,
      usedPercent: 26,
      resetsAt: Math.floor(Date.parse('2026-05-30T06:40:00.613600+00:00') / 1000),
    });
    expect(meta?.secondary).toEqual({
      windowDurationMins: 10080,
      usedPercent: 30,
      resetsAt: Math.floor(Date.parse('2026-06-02T08:00:00.613623+00:00') / 1000),
    });
  });

  it('keeps utilization as a 0–100 percent (no ×100 scaling)', () => {
    const meta = usageEndpointToQuotaMeta({ five_hour: { utilization: 40, resets_at: '2026-05-30T06:40:00Z' } });
    expect(meta?.primary?.usedPercent).toBe(40);
  });

  it('parses resets_at ISO → epoch seconds (cross-checks the SDK rate_limit_event value)', () => {
    const meta = usageEndpointToQuotaMeta({ five_hour: { utilization: 1, resets_at: '2026-05-30T06:40:00.613600+00:00' } });
    expect(meta?.primary?.resetsAt).toBe(1780123200); // identical to the SDK event's five_hour resetsAt
  });

  it('falls back to per-model weekly buckets when aggregate seven_day is null', () => {
    const meta = usageEndpointToQuotaMeta({ seven_day: null, seven_day_sonnet: { utilization: 12, resets_at: '2026-06-02T08:00:00Z' } });
    expect(meta?.secondary?.usedPercent).toBe(12);
    expect(meta?.secondary?.windowDurationMins).toBe(10080);
  });

  it('renders a Codex-style "5h … · 7d …" label with no NaN', () => {
    const label = formatProviderQuotaLabel(usageEndpointToQuotaMeta(REAL), Date.UTC(2026, 4, 30, 3, 0, 0));
    expect(label).toMatch(/5h/);
    expect(label).toMatch(/7d/);
    expect(label).not.toMatch(/NaN/);
  });

  it('returns undefined when no window is present', () => {
    expect(usageEndpointToQuotaMeta({})).toBeUndefined();
    expect(usageEndpointToQuotaMeta(null)).toBeUndefined();
    expect(usageEndpointToQuotaMeta({ seven_day_opus: null })).toBeUndefined();
  });
});
