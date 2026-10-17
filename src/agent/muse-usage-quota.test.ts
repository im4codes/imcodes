import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  museUsageToQuotaMeta,
  getMuseUsageQuota,
  peekMuseUsageQuotaCached,
  updateMuseUsageQuota,
  synthesizeFallbackQuotaMeta,
  registerMuseUsageReader,
  __resetMuseUsageQuotaCache,
  recordMuseQuotaActivity,
  type MuseSubscriptionUsage,
} from './muse-usage-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE_USAGE: MuseSubscriptionUsage = {
  observedAtMs: 1791943260499,
  tier: '27681631238169137',
  window: {
    windowDurationMins: 300,
    usedPercent: 2,
    resetsAtMs: 1791957491000,
  },
  weekly: {
    usedPercent: 4,
    resetsAtMs: 1792368000000,
  },
};

describe('museUsageToQuotaMeta', () => {
  it('maps 5h window and 7d weekly percent accurately', () => {
    const meta = museUsageToQuotaMeta(SAMPLE_USAGE);
    expect(meta?.primary).toEqual({
      windowDurationMins: 300,
      usedPercent: 2,
      resetsAt: 1791957491,
      percentPrecision: 0,
    });
    expect(meta?.secondary).toEqual({
      windowDurationMins: 10080,
      usedPercent: 4,
      resetsAt: 1792368000,
      percentPrecision: 0,
    });
  });

  it('renders a formatted provider quota label', () => {
    const meta = museUsageToQuotaMeta(SAMPLE_USAGE)!;
    const label = formatProviderQuotaLabel(meta, 1791943260499);
    expect(label).toMatch(/5h/);
    expect(label).toMatch(/2%/);
    expect(label).toMatch(/7d/);
    expect(label).toMatch(/4%/);
    expect(label).not.toMatch(/NaN/);
  });

  it('handles partial window or weekly payload gracefully', () => {
    const windowOnly: MuseSubscriptionUsage = {
      window: {
        windowDurationMins: 300,
        usedPercent: 10,
        resetsAtMs: 1791957491000,
      },
    };
    const meta = museUsageToQuotaMeta(windowOnly);
    expect(meta?.primary?.usedPercent).toBe(10);
    expect(meta?.secondary).toBeUndefined();
  });

  it('returns undefined when usage is null or empty', () => {
    expect(museUsageToQuotaMeta(null)).toBeUndefined();
    expect(museUsageToQuotaMeta(undefined)).toBeUndefined();
    expect(museUsageToQuotaMeta({})).toBeUndefined();
  });
});

describe('synthesizeFallbackQuotaMeta', () => {
  it('synthesizes 5h and 7d windows at 0% when credentials exist', () => {
    const meta = synthesizeFallbackQuotaMeta();
    expect(meta.primary?.windowDurationMins).toBe(300);
    expect(meta.primary?.usedPercent).toBe(0);
    expect(meta.secondary?.windowDurationMins).toBe(10080);
    expect(meta.secondary?.usedPercent).toBe(0);
  });
});

describe('getMuseUsageQuota and cache', () => {
  afterEach(() => {
    __resetMuseUsageQuotaCache();
    vi.restoreAllMocks();
  });

  it('loads and serves persisted disk cache', () => {
    const cacheDir = join(tmpdir(), '.imcodes');
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, 'muse-usage-quota.json');
    const meta = museUsageToQuotaMeta(SAMPLE_USAGE)!;
    const value = {
      quotaMeta: meta,
      quotaLabel: formatProviderQuotaLabel(meta),
      tier: SAMPLE_USAGE.tier,
    };
    writeFileSync(cachePath, JSON.stringify({ at: Date.now(), value }), 'utf8');

    const peeked = peekMuseUsageQuotaCached();
    expect(peeked?.quotaLabel).toBe(value.quotaLabel);
    expect(peeked?.quotaMeta.primary?.usedPercent).toBe(2);
    expect(peeked?.quotaMeta.secondary?.usedPercent).toBe(4);
  });

  it('updates cache dynamically via updateMuseUsageQuota', () => {
    const updated = updateMuseUsageQuota(SAMPLE_USAGE);
    expect(updated).not.toBeNull();
    expect(updated?.quotaMeta.primary?.usedPercent).toBe(2);
    expect(updated?.quotaMeta.secondary?.usedPercent).toBe(4);

    const peeked = peekMuseUsageQuotaCached();
    expect(peeked?.quotaLabel).toBe(updated?.quotaLabel);
  });

  it('queries active reader if registered', async () => {
    const unregister = registerMuseUsageReader(async () => SAMPLE_USAGE);
    try {
      const quota = await getMuseUsageQuota(true);
      expect(quota).not.toBeNull();
      expect(quota?.quotaMeta.primary?.usedPercent).toBe(2);
      expect(quota?.quotaMeta.secondary?.usedPercent).toBe(4);
    } finally {
      unregister();
    }
  });

  it('records quota activity', () => {
    const now = 1700000000000;
    recordMuseQuotaActivity(now);
    expect(peekMuseUsageQuotaCached()).toBeNull();
  });
});
