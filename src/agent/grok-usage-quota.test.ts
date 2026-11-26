import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  grokBillingToQuotaMeta,
  getGrokUsageQuota,
  peekGrokUsageQuotaCached,
  __resetGrokUsageQuotaCache,
  recordGrokQuotaActivity,
} from './grok-usage-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_BILLING = {
  config: {
    monthlyLimit: { val: 100 },
    used: { val: 25.5 },
    onDemandCap: { val: 0 },
    billingPeriodStart: '2026-10-01T00:00:00+00:00',
    billingPeriodEnd: '2026-11-01T00:00:00+00:00',
  },
};

const INCLUDED_BILLING = {
  config: {
    monthlyLimit: { val: 0 },
    used: { val: 0 },
    onDemandCap: { val: 0 },
    billingPeriodStart: '2026-10-01T00:00:00+00:00',
    billingPeriodEnd: '2026-11-01T00:00:00+00:00',
  },
};

describe('grokBillingToQuotaMeta', () => {
  it('maps monthlyLimit and used percent accurately', () => {
    const meta = grokBillingToQuotaMeta(REAL_BILLING);
    expect(meta?.primary).toEqual({
      windowDurationMins: 44640, // 31 days
      usedPercent: 25.5,
      resetsAt: Math.floor(Date.parse('2026-11-01T00:00:00+00:00') / 1000),
      percentPrecision: 1,
    });
  });

  it('maps flat included subscription (0 limit, 0 used) to 0%', () => {
    const meta = grokBillingToQuotaMeta(INCLUDED_BILLING);
    expect(meta?.primary?.usedPercent).toBe(0);
    expect(meta?.primary?.windowDurationMins).toBe(44640);
    expect(meta?.primary?.resetsAt).toBe(Math.floor(Date.parse('2026-11-01T00:00:00+00:00') / 1000));
  });

  it('renders a formatted provider quota label', () => {
    const meta = grokBillingToQuotaMeta(REAL_BILLING);
    const label = formatProviderQuotaLabel(meta, Date.parse('2026-10-13T08:00:00Z'));
    expect(label).toMatch(/31d/);
    expect(label).toMatch(/25\.5%/);
    expect(label).not.toMatch(/NaN/);
  });

  it('returns undefined when billing config is missing or invalid', () => {
    expect(grokBillingToQuotaMeta({})).toBeUndefined();
    expect(grokBillingToQuotaMeta(null)).toBeUndefined();
  });
});

describe('getGrokUsageQuota and cache', () => {
  afterEach(() => {
    __resetGrokUsageQuotaCache();
    vi.restoreAllMocks();
  });

  it('loads and serves persisted disk cache', () => {
    const cacheDir = join(tmpdir(), '.imcodes');
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, 'grok-usage-quota.json');
    const value = {
      quotaMeta: grokBillingToQuotaMeta(REAL_BILLING)!,
      quotaLabel: '31d 25.5% 18d16h',
    };
    writeFileSync(cachePath, JSON.stringify({ at: Date.now(), value }), 'utf8');

    const peeked = peekGrokUsageQuotaCached();
    expect(peeked?.quotaLabel).toBe('31d 25.5% 18d16h');
    expect(peeked?.quotaMeta.primary?.usedPercent).toBe(25.5);
  });

  it('records quota activity correctly', () => {
    const now = 1700000000000;
    recordGrokQuotaActivity(now);
    expect(peekGrokUsageQuotaCached()).toBeNull();
  });
});
